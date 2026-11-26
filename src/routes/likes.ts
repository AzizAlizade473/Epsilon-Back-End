import { and, count, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Deps } from '../context.js';
import type { Db } from '../db/client.js';
import { feedback, likeKind, likes, users } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { decodeTimeCursor, encodeCursor, pageQuery, parse } from '../lib/validation.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const kind = z.enum(likeKind.enumValues);
type Kind = z.infer<typeof kind>;
const targetId = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
const catalogId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const params = z.object({ kind, targetId }).strict();
// Postgres text cannot hold NUL: refuse it here instead of failing with a 500.
const noNul = (v: string) => !v.includes('\0');
const likeBody = z
  .object({
    restaurantId: catalogId,
    dishId: catalogId.nullable(),
    title: z.string().trim().min(1).max(200).refine(noNul),
    subtitle: z.string().max(200).refine(noNul),
    imageUrl: z.url({ protocol: /^https$/ }).max(500).nullable(),
  })
  .strict();
const listQuery = pageQuery.extend({ kind: kind.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
const stateBody = z.object({ kind, targetIds: z.array(targetId).min(1).max(100) }).strict();

/** One spelling per review, so the same database review cannot be liked twice with another letter case. */
const canonical = (k: Kind, id: string) => (k === 'review' && UUID.test(id) ? id.toLowerCase() : id);
const key = (k: Kind, id: string) => `${k}|${id}`;

/** Likes by non-deleted accounts per target, and whether `userId` is among them. */
async function tally(db: Db, ids: string[], userId: string) {
  const rows = ids.length
    ? await db
        .select({ kind: likes.kind, targetId: likes.targetId, count: count(), liked: sql<boolean>`bool_or(${likes.userId} = ${userId})` })
        .from(likes)
        .innerJoin(users, eq(users.id, likes.userId))
        .where(and(inArray(likes.targetId, ids), isNull(users.deletedAt)))
        .groupBy(likes.kind, likes.targetId)
    : [];
  const map = new Map(rows.map((r) => [key(r.kind, r.targetId), r]));
  return (k: Kind, id: string) => ({ liked: map.get(key(k, id))?.liked ?? false, count: map.get(key(k, id))?.count ?? 0 });
}

export async function likeRoutes(app: FastifyInstance, deps: Deps) {
  const authed = { config: { auth: true } };
  const write = { config: { auth: true, rateLimit: { max: 60, timeWindow: '1 minute' } } };
  const own = (userId: string, k: Kind, id: string) => and(eq(likes.userId, userId), eq(likes.kind, k), eq(likes.targetId, id));

  app.put('/likes/:kind/:targetId', write, async (request) => {
    const p = parse(params, request.params);
    const body = parse(likeBody, request.body);
    const id = canonical(p.kind, p.targetId);
    // The snapshot must describe the target it is stored under.
    if (
      (p.kind === 'dish' && (body.dishId === null || id !== `${body.restaurantId}:${body.dishId}`)) ||
      (p.kind === 'restaurant' && id !== body.restaurantId)
    )
      throw new ApiError(422, 'VALIDATION_FAILED', 'Invalid fields: targetId');
    // UUIDs are database reviews; anything else is a demo-catalogue id.
    if (p.kind === 'review' && UUID.test(id)) {
      const [review] = await deps.db
        .select({ id: feedback.id })
        .from(feedback)
        .where(and(eq(feedback.id, id), isNull(feedback.hiddenAt)));
      if (!review) throw new ApiError(404, 'LIKE_TARGET_NOT_FOUND', 'Review not found');
    }
    const userId = request.auth!.userId;
    await deps.db
      .insert(likes)
      .values({ ...body, userId, kind: p.kind, targetId: id, createdAt: deps.now() })
      .onConflictDoNothing({ target: [likes.userId, likes.kind, likes.targetId] });
    return { liked: true, count: (await tally(deps.db, [id], userId))(p.kind, id).count };
  });

  app.delete('/likes/:kind/:targetId', write, async (request) => {
    const p = parse(params, request.params);
    const id = canonical(p.kind, p.targetId);
    const userId = request.auth!.userId;
    await deps.db.delete(likes).where(own(userId, p.kind, id));
    return { liked: false, count: (await tally(deps.db, [id], userId))(p.kind, id).count };
  });

  app.get('/likes', authed, async (request) => {
    const query = parse(listQuery, request.query);
    const userId = request.auth!.userId;
    const filters: (SQL | undefined)[] = [
      eq(likes.userId, userId),
      // A review hidden by moderation leaves every list, including the snapshot kept here.
      sql`not (${likes.kind} = 'review' and exists (select 1 from ${feedback} where ${feedback.id}::text = ${likes.targetId} and ${feedback.hiddenAt} is not null))`,
    ];
    if (query.kind) filters.push(eq(likes.kind, query.kind));
    const after = decodeTimeCursor(query.cursor);
    if (after) filters.push(or(lt(likes.createdAt, after[0]), and(eq(likes.createdAt, after[0]), lt(likes.id, after[1]))));
    const rows = await deps.db
      .select()
      .from(likes)
      .where(and(...filters))
      .orderBy(desc(likes.createdAt), desc(likes.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const of = await tally(deps.db, page.map((r) => r.targetId), userId);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        kind: r.kind,
        targetId: r.targetId,
        restaurantId: r.restaurantId,
        dishId: r.dishId,
        title: r.title,
        subtitle: r.subtitle,
        imageUrl: r.imageUrl,
        createdAt: r.createdAt.toISOString(),
        count: of(r.kind, r.targetId).count,
      })),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdAt.toISOString(), last.id) : null,
    };
  });

  /** Liked flags and counts for the targets on one screen, in the order asked. */
  app.post('/likes/state', authed, async (request) => {
    const body = parse(stateBody, request.body);
    const of = await tally(deps.db, body.targetIds.map((id) => canonical(body.kind, id)), request.auth!.userId);
    return { items: body.targetIds.map((id) => ({ targetId: id, ...of(body.kind, canonical(body.kind, id)) })) };
  });
}
