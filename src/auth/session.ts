import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';

import type { AuthContext, Deps } from '../context.js';
import type { Db, Tx } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { ApiError, unauthorized } from '../errors.js';
import { randomToken, sha256 } from '../lib/crypto.js';

const ISSUER = 'epsilon-api';
const AUDIENCE = 'epsilon-app';
const secs = (d: Date) => Math.floor(d.getTime() / 1000);
const jwtKey = (deps: Deps) => new TextEncoder().encode(deps.config.JWT_SECRET);

/** Account deletion and e-mail changes need a sign-in (OTP or Google) within this window. */
const RECENT_AUTH_MS = 10 * 60_000;

export function requireRecentAuth(deps: Deps, auth: AuthContext) {
  if (deps.now().getTime() - auth.authenticatedAt.getTime() > RECENT_AUTH_MS)
    throw new ApiError(403, 'REAUTH_REQUIRED', 'Sign in again to continue');
}

export type SessionJson = { accessToken: string; refreshToken: string; expiresAt: string };

/** Creates a refresh-token row and returns the session the app stores.
 * New sign-in: new family, authenticatedAt = now. Rotation: same family and authenticatedAt. */
export async function issueSession(
  deps: Deps,
  tx: Db | Tx,
  userId: string,
  family?: { familyId: string; authenticatedAt: Date },
): Promise<SessionJson> {
  const now = deps.now();
  const familyId = family?.familyId ?? randomUUID();
  const refreshToken = randomToken();
  await tx.insert(sessions).values({
    userId,
    familyId,
    refreshTokenHash: sha256(refreshToken),
    authenticatedAt: family?.authenticatedAt ?? now,
    expiresAt: new Date(now.getTime() + deps.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
  });
  const expiresAt = new Date(now.getTime() + deps.config.ACCESS_TOKEN_TTL_SECONDS * 1000);
  const accessToken = await new SignJWT({ sid: familyId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(secs(now))
    .setExpirationTime(secs(expiresAt))
    .sign(jwtKey(deps));
  return { accessToken, refreshToken, expiresAt: expiresAt.toISOString() };
}

/** Rotates a refresh token. Reuse of a rotated/revoked token revokes the whole family. */
export async function rotateRefreshToken(deps: Deps, refreshToken: string): Promise<SessionJson> {
  const now = deps.now();
  // The transaction returns an outcome instead of throwing, so the reuse revocation commits.
  const outcome = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, sha256(refreshToken)))
      .for('update');
    if (!row) return null;
    if (row.revokedAt) {
      await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.familyId, row.familyId), isNull(sessions.revokedAt)));
      return null;
    }
    if (row.expiresAt <= now) return null;
    const [user] = await tx
      .select({ deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, row.userId));
    if (!user || user.deletedAt) return null;
    await tx.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, row.id));
    return issueSession(deps, tx, row.userId, {
      familyId: row.familyId,
      authenticatedAt: row.authenticatedAt,
    });
  });
  if (!outcome) throw unauthorized();
  return outcome;
}

export async function revokeFamily(deps: Deps, tx: Db | Tx, familyId: string): Promise<void> {
  await tx
    .update(sessions)
    .set({ revokedAt: deps.now() })
    .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)));
}

/** Bearer access token → AuthContext. The session family must still be live,
 * so logout/deletion/reuse detection take effect before the JWT expires. */
export async function authenticate(deps: Deps, request: FastifyRequest): Promise<AuthContext> {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized();
  let userId: string;
  let familyId: string;
  try {
    const { payload } = await jwtVerify(token, jwtKey(deps), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      currentDate: deps.now(),
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') throw unauthorized();
    userId = payload.sub;
    familyId = payload.sid;
  } catch {
    throw unauthorized();
  }
  const [live] = await deps.db
    .select({ authenticatedAt: sessions.authenticatedAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.familyId, familyId),
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, deps.now()),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  if (!live) throw unauthorized();
  return { userId, familyId, authenticatedAt: live.authenticatedAt };
}
