import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';

import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { adminSessions, adminUsers } from '../db/schema.js';
import { ApiError, unauthorized } from '../errors.js';
import { hmac, randomToken, safeEqualHex, sha256 } from '../lib/crypto.js';
import { audit } from './audit.js';
import { can, PERMISSIONS, type Permission, type Role } from './roles.js';

export type AdminDeps = {
  /** Main pool: sessions, audit, moderation, admin users. */
  db: Db;
  /** Read-only pool (epsilon_admin_ro) for analytics. */
  ro: Db;
  config: Config;
  now: () => Date;
  /** Access signing keys; defaults to the team's remote JWKS. Injected in tests. */
  jwks?: JWTVerifyGetKey;
  version?: string;
  /** Overrides for tests; production uses 120/min per admin and 10/min per IP for /session. */
  limits?: { perAdmin?: number; login?: number };
};

export type AdminCtx = { id: string; email: string; name: string; role: Role };
export type RoutePerm = Permission | 'any' | 'login';

declare module 'fastify' {
  interface FastifyRequest {
    admin: AdminCtx | null;
    adminSub: string | null;
    adminVia: 'access' | 'local_tunnel';
  }
  interface FastifyContextConfig {
    /** Every admin route must name what it needs; a route without it is refused. */
    perm?: RoutePerm;
  }
}

export const COOKIE = '__Host-epsilon_admin';
const IDLE_MS = 30 * 60_000;
const ABSOLUTE_MS = 8 * 3_600_000;
const TOKEN = /^[\w-]{43}$/;
const forbidden = () => new ApiError(403, 'FORBIDDEN', 'Forbidden');

const isLoopback = (addr?: string) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

/** Only cloudflared (loopback) can reach this listener, so its Cf-Connecting-Ip header is trustworthy. */
export function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers['cf-connecting-ip'];
  return isLoopback(request.socket.remoteAddress) && typeof forwarded === 'string' && forwarded.length <= 45 ? forwarded : request.ip;
}

export const requestMeta = (request: FastifyRequest) => ({ ip: clientIp(request), userAgent: request.headers['user-agent']?.slice(0, 300) ?? null });

export function sessionToken(request: FastifyRequest): string | null {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) {
      const value = part.slice(i + 1).trim();
      return TOKEN.test(value) ? value : null;
    }
  }
  return null;
}

/** Derived from the session token, so /me can return it again without storing the secret. */
export const csrfFor = (token: string) => hmac(token, 'epsilon-admin-csrf');

export const cookieHeader = (token: string) => `${COOKIE}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ABSOLUTE_MS / 1000}`;
export const clearCookieHeader = `${COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

export const adminView = (a: AdminCtx) => ({ id: a.id, email: a.email, name: a.name, role: a.role, permissions: PERMISSIONS[a.role] });

/**
 * Who is calling. A present Access JWT is always fully validated (never falls back). Without one,
 * a loopback socket (the SSH tunnel; X-Forwarded-For is never consulted) gets the configured
 * local identity, which must still be an active admin_users row.
 */
export async function accessIdentity(deps: AdminDeps, request: FastifyRequest, keys: JWTVerifyGetKey | null) {
  const { config } = deps;
  const token = request.headers['cf-access-jwt-assertion'];
  const local = config.ADMIN_LOCAL_EMAIL ?? (config.NODE_ENV !== 'production' ? config.ADMIN_DEV_EMAIL : undefined);
  if (token === undefined && local && isLoopback(request.socket.remoteAddress))
    return { email: local, sub: null, via: 'local_tunnel' as const };
  if (!keys || typeof token !== 'string' || token.length > 8192) throw unauthorized();
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: `https://${config.ADMIN_CF_TEAM_DOMAIN}`,
      audience: config.ADMIN_CF_AUD,
      algorithms: ['RS256'],
    });
    if (typeof payload.email !== 'string' || typeof payload.sub !== 'string' || !payload.email || !payload.sub) throw new Error('claims');
    return { email: payload.email.toLowerCase(), sub: payload.sub, via: 'access' as const };
  } catch {
    throw unauthorized();
  }
}

/** The active admin this Access identity maps to, else an audited 403. */
export async function resolveAdmin(deps: AdminDeps, request: FastifyRequest, who: { email: string; sub: string | null }) {
  const [row] = await deps.db.select().from(adminUsers).where(eq(adminUsers.email, who.email));
  const deny = async (action: string): Promise<never> => {
    await audit(deps.db, { adminId: row?.id ?? null, action, entityType: 'identity', entityId: who.email, outcome: 'denied', ...requestMeta(request) });
    throw forbidden();
  };
  if (!row) return deny('access.unknown_admin');
  if (row.status !== 'active') return deny('access.disabled');
  if (row.role === 'partner') return deny('access.role_reserved');
  if (who.sub && row.accessSub && row.accessSub !== who.sub) return deny('access.identity_mismatch');
  return { row, ctx: { id: row.id, email: row.email, name: row.name, role: row.role } satisfies AdminCtx };
}

/** Creates a fresh session (new token every login), pinning the Access identity on first use. */
export async function login(deps: AdminDeps, request: FastifyRequest, row: typeof adminUsers.$inferSelect, sub: string | null, via: 'access' | 'local_tunnel') {
  const now = deps.now();
  const token = randomToken();
  const previous = sessionToken(request);
  await deps.db.transaction(async (tx) => {
    if (sub && !row.accessSub) {
      const pinned = await tx
        .update(adminUsers)
        .set({ accessSub: sub })
        .where(and(eq(adminUsers.id, row.id), isNull(adminUsers.accessSub)))
        .returning({ id: adminUsers.id });
      if (!pinned[0]) throw forbidden();
    }
    await tx.update(adminUsers).set({ lastLoginAt: now }).where(eq(adminUsers.id, row.id));
    if (previous)
      await tx
        .update(adminSessions)
        .set({ revokedAt: now })
        .where(and(eq(adminSessions.tokenHash, sha256(previous)), isNull(adminSessions.revokedAt)));
    await tx.insert(adminSessions).values({
      adminId: row.id,
      tokenHash: sha256(token),
      csrfHash: sha256(csrfFor(token)),
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + ABSOLUTE_MS),
      ...requestMeta(request),
    });
    await audit(tx, { adminId: row.id, action: 'login', after: { via }, outcome: 'ok', ...requestMeta(request) });
  });
  return { token, csrf: csrfFor(token) };
}

/** The live session for this request, owned by `adminId`; otherwise 401. Touches lastSeenAt. */
export async function requireSession(deps: AdminDeps, request: FastifyRequest, adminId: string) {
  const token = sessionToken(request);
  if (!token) throw unauthorized();
  const [s] = await deps.db.select().from(adminSessions).where(eq(adminSessions.tokenHash, sha256(token)));
  const now = deps.now();
  if (!s || s.revokedAt || s.expiresAt <= now || s.lastSeenAt.getTime() + IDLE_MS <= now.getTime() || s.adminId !== adminId) throw unauthorized();
  if (now.getTime() - s.lastSeenAt.getTime() > 60_000) await deps.db.update(adminSessions).set({ lastSeenAt: now }).where(eq(adminSessions.id, s.id));
  return { session: s, token };
}

export function csrfValid(request: FastifyRequest, storedHash: string): boolean {
  const header = request.headers['x-csrf-token'];
  return typeof header === 'string' && header.length <= 128 && safeEqualHex(sha256(header), storedHash);
}

/** Records the refusal, then 403. */
export async function deny(deps: AdminDeps, request: FastifyRequest, admin: AdminCtx, action: string, reason?: string): Promise<never> {
  await audit(deps.db, {
    adminId: admin.id,
    action,
    entityType: 'route',
    entityId: `${request.method} ${request.routeOptions.url ?? ''}`,
    reason,
    outcome: 'denied',
    ...requestMeta(request),
  });
  throw forbidden();
}

export const allowed = (admin: AdminCtx, perm: RoutePerm) => perm === 'any' || perm === 'login' || can(admin.role, perm);
