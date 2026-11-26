import rateLimit from '@fastify/rate-limit';
import { and, eq, isNull, sql } from 'drizzle-orm';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { createRemoteJWKSet } from 'jose';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';

import { adminSessions, adminUsers, feedback, restaurants, reviewReplies } from '../db/schema.js';
import { ApiError, apiErrorHandler, notFound } from '../errors.js';
import { sha256 } from '../lib/crypto.js';
import { parse } from '../lib/validation.js';
import { audit } from './audit.js';
import {
  accessIdentity, adminView, allowed, clearCookieHeader, clientIp, cookieHeader, csrfFor, csrfValid, deny, login, requestMeta, requireSession,
  resolveAdmin, sessionToken, type AdminDeps, type RoutePerm,
} from './auth.js';
import { csvCell } from './mask.js';
import { BASE, one, rangeQuery, resolveRange } from './queries/facts.js';
import { detailQuery, dishDetail, dishesQuery, dishParam, keyParam, listDishes, listRestaurants, restaurantDetail, restaurantsQuery } from './queries/merchants.js';
import {
  auditQuery, costs, health, listAudit, listNotifications, notificationStats, notificationsQuery, search, searchQuery,
} from './queries/misc.js';
import { likesQuery, likeStats, listLikes } from './queries/likes.js';
import { cashbackSummary, idParam, ledgerQuery, listLedger, listReceipts, receiptDetail, receiptHealth, receiptsQuery } from './queries/receipts.js';
import { listReviews, replyDetail, reviewRows, reviewsQuery, reviewView } from './queries/reviews.js';
import { overview } from './queries/overview.js';
import { listUsers, userContact, userDetail, usersAnalytics, usersQuery } from './queries/users.js';
import { staticHandler } from './static.js';

const REASON = z.string().trim().min(3).max(300);
const EXPORT_MAX = 50_000;
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const flatten = (value: unknown, prefix = '', out: Record<string, unknown> = {}) => {
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
};

/** The admin API on its own Fastify instance (bound to loopback by server.ts, never mounted on the public app). */
export async function buildAdminApp(deps: AdminDeps, options: { logger?: boolean; staticDir?: string } = {}) {
  const { config, db, ro } = deps;
  const app = Fastify({
    bodyLimit: 8 * 1024,
    trustProxy: false,
    exposeHeadRoutes: false,
    logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie'], serializers: { req: (r) => ({ method: r.method, url: r.routeOptions?.url ?? 'unknown' }) } } : false,
    genReqId: () => randomUUID(),
  });
  const send404 = (request: FastifyRequest, reply: FastifyReply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found', requestId: request.id } });
  app.setErrorHandler(apiErrorHandler);

  const cf = config.ADMIN_CF_TEAM_DOMAIN && config.ADMIN_CF_AUD;
  const enabled = config.ADMIN_ENABLED && Boolean(cf || config.ADMIN_LOCAL_EMAIL || (config.NODE_ENV !== 'production' && config.ADMIN_DEV_EMAIL));
  // Kill switch: nothing is registered, every path is a 404.
  if (!enabled) {
    app.setNotFoundHandler(send404);
    return app;
  }

  const keys = deps.jwks ?? (cf ? createRemoteJWKSet(new URL(`https://${config.ADMIN_CF_TEAM_DOMAIN}/cdn-cgi/access/certs`)) : null);
  const serveStatic = options.staticDir ? staticHandler(options.staticDir) : null;
  app.decorateRequest('admin', null);
  app.decorateRequest('adminSub', null);
  app.decorateRequest('adminVia', 'access');

  // Bodies are optional JSON (the app posts /session and /logout without one).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body === '' ? {} : JSON.parse(body as string));
    } catch {
      done(new ApiError(422, 'VALIDATION_FAILED', 'Malformed request'));
    }
  });

  app.addHook('onSend', async (request, reply) => {
    reply
      .header('X-Request-Id', request.id)
      .header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', CSP);
    if (!reply.hasHeader('cache-control')) reply.header('Cache-Control', 'no-store');
  });

  // Order matters: identity (401) -> admin row (403) -> session (401) -> CSRF (403) -> permission (403).
  app.addHook('onRequest', async (request) => {
    if (request.is404) return;
    const perm = request.routeOptions.config.perm;
    if (!perm) throw new ApiError(403, 'FORBIDDEN', 'Forbidden'); // deny by default
    const who = await accessIdentity(deps, request, keys);
    const { ctx } = await resolveAdmin(deps, request, who);
    request.admin = ctx;
    request.adminSub = who.sub;
    request.adminVia = who.via;
    if (perm === 'login') return;
    const { session } = await requireSession(deps, request, ctx.id);
    if (request.method !== 'GET' && !csrfValid(request, session.csrfHash)) await deny(deps, request, ctx, 'csrf.invalid');
    if (!allowed(ctx, perm)) await deny(deps, request, ctx, 'permission.denied', perm);
  });

  await app.register(rateLimit, {
    global: true,
    hook: 'preHandler',
    max: deps.limits?.perAdmin ?? 120,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.admin?.id ?? clientIp(request),
    errorResponseBuilder: (_req, ctx) => new ApiError(429, 'RATE_LIMITED', 'Too many requests', Math.ceil(ctx.ttl / 1000)),
  });

  app.setNotFoundHandler((request, reply) =>
    serveStatic && !/^\/admin(\/|$)/.test(request.url) ? serveStatic(request, reply) : send404(request, reply),
  );

  const P = '/admin/api';
  const now = () => deps.now();
  const admin = (request: FastifyRequest) => request.admin!;
  const get = (path: string, perm: RoutePerm, handler: (request: FastifyRequest) => unknown) => app.get(`${P}${path}`, { config: { perm } }, async (request) => handler(request));
  const analytic = <T extends object>(body: T, tracking?: Record<string, 'not_tracked'>) => ({ generatedAt: now().toISOString(), ...(tracking ? { tracking } : {}), ...body });

  // ------------------------------------------------------------ session
  app.post(`${P}/session`, { config: { perm: 'login', rateLimit: { max: deps.limits?.login ?? 10, timeWindow: '1 minute', keyGenerator: clientIp } } }, async (request, reply) => {
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, admin(request).id));
    if (!row) throw new ApiError(403, 'FORBIDDEN', 'Forbidden');
    const { token, csrf } = await login(deps, request, row, request.adminSub, request.adminVia);
    return reply.header('Set-Cookie', cookieHeader(token)).send({ admin: adminView(admin(request)), csrfToken: csrf });
  });
  get('/me', 'any', (request) => ({ admin: adminView(admin(request)), csrfToken: csrfFor(sessionToken(request)!) }));
  app.post(`${P}/logout`, { config: { perm: 'any' } }, async (request, reply) => {
    await db.update(adminSessions).set({ revokedAt: now() }).where(and(eq(adminSessions.tokenHash, sha256(sessionToken(request)!)), isNull(adminSessions.revokedAt)));
    await audit(db, { adminId: admin(request).id, action: 'logout', outcome: 'ok', ...requestMeta(request) });
    return reply.header('Set-Cookie', clearCookieHeader).code(204).send();
  });

  // ------------------------------------------------------------ analytics
  get('/overview', 'analytics:read', async (r) => analytic(await overview(ro, resolveRange(parse(rangeQuery, r.query), now()))));

  get('/users/analytics', 'analytics:read', async (r) => analytic(await usersAnalytics(ro, resolveRange(parse(rangeQuery, r.query), now()))));
  get('/users', 'analytics:read', async (r) => listUsers(ro, parse(usersQuery, r.query), now()));
  get('/users/:id', 'analytics:read', async (r) => userDetail(ro, parse(idParam, r.params).id));
  app.post(`${P}/users/:id/reveal`, { config: { perm: 'pii:reveal' } }, async (request) => {
    const { id } = parse(idParam, request.params);
    const { reason } = parse(z.object({ reason: REASON }).strict(), request.body);
    const contact = await userContact(ro, id);
    if (!contact) throw notFound();
    // Audited before anything is returned; the entry holds no contact data.
    await audit(db, { adminId: admin(request).id, action: 'user.reveal', entityType: 'user', entityId: id, reason, outcome: 'ok', ...requestMeta(request) });
    return contact;
  });

  get('/restaurants', 'analytics:read', async (r) => listRestaurants(ro, parse(restaurantsQuery, r.query)));
  get('/restaurants/:key', 'analytics:read', async (r) => analytic(await restaurantDetail(ro, parse(keyParam, r.params).key, parse(detailQuery, r.query), now())));
  app.patch(`${P}/restaurants/:key`, { config: { perm: 'restaurants:write' } }, async (request) => {
    const { key } = parse(keyParam, request.params);
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(120).optional(), logoUrl: z.string().max(500).regex(/^https:\/\/[^\s]+$/).nullable().optional() }).strict()
        .refine((b) => b.name !== undefined || b.logoUrl !== undefined, 'nothing to change'),
      request.body,
    );
    const id = key.startsWith('r:') ? key.slice(2) : null;
    if (!id || !z.uuid().safeParse(id).success) throw new ApiError(422, 'VALIDATION_FAILED', 'Only partner restaurants have editable metadata');
    const updated = await db.transaction(async (tx) => {
      const [before] = await tx.select({ name: restaurants.name, logoUrl: restaurants.logoUrl }).from(restaurants).where(eq(restaurants.id, id)).for('update');
      if (!before) throw notFound();
      const [after] = await tx.update(restaurants).set(body).where(eq(restaurants.id, id)).returning({ name: restaurants.name, logoUrl: restaurants.logoUrl });
      await audit(tx, { adminId: admin(request).id, action: 'restaurant.update', entityType: 'restaurant', entityId: key, before, after, outcome: 'ok', ...requestMeta(request) });
      return after!;
    });
    return { key, ...updated };
  });

  get('/dishes', 'analytics:read', async (r) => listDishes(ro, parse(dishesQuery, r.query)));
  get('/dishes/:key', 'analytics:read', async (r) => analytic(await dishDetail(ro, parse(dishParam, r.params).key, parse(detailQuery, r.query), now())));

  get('/reviews', 'analytics:read', async (r) => listReviews(ro, parse(reviewsQuery, r.query), now()));
  get('/reviews/:id', 'analytics:read', async (r) => {
    const { id } = parse(idParam, r.params);
    const [review] = await reviewRows(ro, sql`f.id = ${id}::uuid`, 1);
    if (!review) throw notFound();
    const item = await one<{ purchase_id: string; name: string; quantity: number; unit_price_minor: number }>(
      ro,
      sql`${BASE} select it.purchase_id, it.name, it.quantity, it.unit_price_minor from f join it on it.id = f.purchase_item_id where f.id = ${id}::uuid`,
    );
    const receipt = item ? await receiptDetail(ro, item.purchase_id) : null;
    return {
      ...reviewView(review),
      reply: await replyDetail(ro, id),
      item: item ? { name: item.name, quantity: item.quantity, unitPriceMinor: item.unit_price_minor } : null,
      receipt: receipt && { id: receipt.id, importedAt: receipt.importedAt, fiscalIdMasked: receipt.fiscalIdMasked, totalMinor: receipt.totalMinor, merchant: receipt.merchant },
    };
  });
  app.post(`${P}/reviews/:id/moderate`, { config: { perm: 'reviews:moderate' } }, async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(z.object({ hidden: z.boolean(), reason: REASON }).strict(), request.body);
    const at = now();
    return db.transaction(async (tx) => {
      const [before] = await tx.select({ hiddenAt: feedback.hiddenAt }).from(feedback).where(eq(feedback.id, id)).for('update');
      if (!before) throw notFound();
      // The review text is never touched; hiding only flags the row.
      await tx
        .update(feedback)
        .set({ hiddenAt: body.hidden ? at : null, hiddenReason: body.hidden ? body.reason : null, hiddenBy: body.hidden ? admin(request).id : null })
        .where(eq(feedback.id, id));
      await audit(tx, {
        adminId: admin(request).id, action: body.hidden ? 'review.hide' : 'review.unhide', entityType: 'review', entityId: id, reason: body.reason,
        before: { hidden: before.hiddenAt !== null }, after: { hidden: body.hidden }, outcome: 'ok', ...requestMeta(request),
      });
      return { id, moderation: { hidden: body.hidden, reason: body.hidden ? body.reason : null, at: body.hidden ? at : null } };
    });
  });

  // Hide or restore a restaurant's reply; its text is never altered.
  app.post(`${P}/reviews/:id/reply/moderate`, { config: { perm: 'reviews:moderate' } }, async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(z.object({ hidden: z.boolean(), reason: REASON }).strict(), request.body);
    const at = now();
    return db.transaction(async (tx) => {
      const [before] = await tx.select({ hiddenAt: reviewReplies.hiddenAt }).from(reviewReplies).where(eq(reviewReplies.feedbackId, id)).for('update');
      if (!before) throw notFound();
      await tx.update(reviewReplies).set({ hiddenAt: body.hidden ? at : null }).where(eq(reviewReplies.feedbackId, id));
      await audit(tx, {
        adminId: admin(request).id, action: body.hidden ? 'reply.hide' : 'reply.unhide', entityType: 'review_reply', entityId: id, reason: body.reason,
        before: { hidden: before.hiddenAt !== null }, after: { hidden: body.hidden }, outcome: 'ok', ...requestMeta(request),
      });
      return { id, reply: { hidden: body.hidden, at: body.hidden ? at : null } };
    });
  });

  get('/receipts/health', 'analytics:read', async (r) => analytic(await receiptHealth(ro, resolveRange(parse(rangeQuery, r.query), now())), { failures: 'not_tracked' }));
  get('/receipts', 'analytics:read', async (r) => listReceipts(ro, parse(receiptsQuery, r.query), now()));
  get('/receipts/:id', 'analytics:read', async (r) => receiptDetail(ro, parse(idParam, r.params).id));

  get('/cashback/ledger', 'analytics:read', async (r) => listLedger(ro, parse(ledgerQuery, r.query), now()));
  get('/cashback', 'analytics:read', async (r) => analytic(await cashbackSummary(ro, resolveRange(parse(rangeQuery, r.query), now()))));

  get('/notifications/stats', 'analytics:read', async (r) => analytic(await notificationStats(ro, resolveRange(parse(rangeQuery, r.query), now())), { delivery: 'not_tracked' }));
  get('/notifications', 'analytics:read', async (r) => listNotifications(ro, parse(notificationsQuery, r.query), now()));

  get('/likes/stats', 'analytics:read', async (r) => analytic(await likeStats(ro, resolveRange(parse(rangeQuery, r.query), now()))));
  get('/likes', 'analytics:read', async (r) => listLikes(ro, parse(likesQuery, r.query), now()));

  get('/costs', 'analytics:read', async (r) => analytic(await costs(ro, resolveRange(parse(rangeQuery, r.query), now())), { email: 'not_tracked', push: 'not_tracked' }));
  get('/health', 'analytics:read', async () => analytic(await health(ro, deps.version ?? 'unknown')));
  get('/audit', 'audit:read', async (r) => listAudit(ro, parse(auditQuery, r.query), now()));
  get('/search', 'analytics:read', async (r) => analytic(await search(ro, parse(searchQuery, r.query).q, now())));

  // ------------------------------------------------------------ export
  const reports: Record<string, { schema: z.ZodType<{ cursor?: string | undefined; limit: number }>; run: (q: never) => Promise<{ items: unknown[]; nextCursor: string | null }> }> = {
    users: { schema: usersQuery, run: (q) => listUsers(ro, q, now()) },
    restaurants: { schema: restaurantsQuery, run: (q) => listRestaurants(ro, q) },
    dishes: { schema: dishesQuery, run: (q) => listDishes(ro, q) },
    reviews: { schema: reviewsQuery, run: (q) => listReviews(ro, q, now()) },
    receipts: { schema: receiptsQuery, run: (q) => listReceipts(ro, q, now()) },
    ledger: { schema: ledgerQuery, run: (q) => listLedger(ro, q, now()) },
    notifications: { schema: notificationsQuery, run: (q) => listNotifications(ro, q, now()) },
  };
  app.get(`${P}/export/:file`, { config: { perm: 'export' } }, async (request, reply) => {
    const name = /^(\w{1,20})\.csv$/.exec(parse(z.object({ file: z.string().max(40) }), request.params).file)?.[1];
    const report = name ? reports[name] : undefined;
    if (!name || !report) throw notFound();
    const query = parse(report.schema, request.query);
    const rows: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    let truncated = false;
    for (;;) {
      const page = await report.run({ ...query, limit: 1000, cursor } as never);
      rows.push(...page.items.map((i) => flatten(i)));
      if (!page.nextCursor) break;
      if (rows.length >= EXPORT_MAX) {
        truncated = true;
        break;
      }
      cursor = page.nextCursor;
    }
    const out = rows.slice(0, EXPORT_MAX);
    await audit(db, { adminId: admin(request).id, action: 'export', entityType: name, after: { rows: out.length, truncated, filters: Object.keys(request.query as object) }, outcome: 'ok', ...requestMeta(request) });
    const header = [...new Set(out.flatMap((r) => Object.keys(r)))];
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${name}.csv"`)
      .header('X-Export-Truncated', String(truncated))
      .send([header.map(csvCell).join(','), ...out.map((r) => header.map((h) => csvCell(r[h])).join(','))].join('\r\n'));
  });

  return app;
}

export const defaultStaticDir = () => resolve('admin/dist');
