import { and, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Deps } from '../context.js';
import type { Db, Tx } from '../db/client.js';
import {
  branches,
  feedback,
  fiscalReceipts,
  purchaseItems,
  purchases,
  restaurantStaff,
  restaurants,
  reviewReplies,
  users,
} from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { idempotent } from '../lib/idempotency.js';
import { decodeTimeCursor, encodeCursor, idParam, pageQuery, parse } from '../lib/validation.js';

const feedbackParam = z.object({ feedbackId: z.uuid() }).strict();
const replyBody = z
  .object({ body: z.string().trim().min(1).max(1000).refine((v) => !v.includes('\0')) })
  .strict();

/** Where the reviewed item was bought: the branch's restaurant, or the partner on the fiscal receipt. */
const restaurantOf = sql<string | null>`coalesce(${branches.restaurantId}, ${fiscalReceipts.restaurantId})`;

/** What staff may see of a review: no contacts, no receipt or user ids. */
async function staffReviews(conn: Db | Tx, where: SQL | undefined, limit: number) {
  const rows = await conn
    .select({
      feedbackId: feedback.id,
      restaurantId: restaurantOf,
      hiddenAt: feedback.hiddenAt,
      dishName: purchaseItems.name,
      rating: feedback.rating,
      comment: feedback.comment,
      createdAt: feedback.createdAt,
      reviewer: users.firstName,
      reply: reviewReplies,
    })
    .from(feedback)
    .innerJoin(users, eq(users.id, feedback.userId))
    .innerJoin(purchaseItems, eq(purchaseItems.id, feedback.purchaseItemId))
    .innerJoin(purchases, eq(purchases.id, purchaseItems.purchaseId))
    .leftJoin(branches, eq(branches.id, purchases.branchId))
    .leftJoin(fiscalReceipts, eq(fiscalReceipts.id, purchases.fiscalReceiptId))
    .leftJoin(reviewReplies, eq(reviewReplies.feedbackId, feedback.id))
    .where(where)
    .orderBy(desc(feedback.createdAt), desc(feedback.id))
    .limit(limit);
  return rows.map(({ restaurantId, hiddenAt, reply, createdAt, ...r }) => ({
    restaurantId,
    hidden: hiddenAt !== null,
    reply,
    createdAt,
    view: {
      ...r,
      createdAt: createdAt.toISOString(),
      reply:
        reply && !reply.deletedAt
          ? {
              body: reply.body,
              updatedAt: reply.updatedAt.toISOString(),
              status: reply.hiddenAt ? ('hidden' as const) : ('published' as const),
            }
          : null,
    },
  }));
}

export async function staffRoutes(app: FastifyInstance, deps: Deps) {
  const authed = { config: { auth: true } };
  const writes = { config: { auth: true, rateLimit: { max: 20, timeWindow: '1 minute' } } };

  const isStaff = async (conn: Db | Tx, userId: string, restaurantId: string) =>
    (
      await conn
        .select({ id: restaurantStaff.restaurantId })
        .from(restaurantStaff)
        .where(and(eq(restaurantStaff.userId, userId), eq(restaurantStaff.restaurantId, restaurantId)))
    ).length > 0;

  /** The review, only for staff of its restaurant: anyone else cannot tell it exists. */
  async function ownReview(conn: Db | Tx, userId: string, feedbackId: string) {
    const [review] = await staffReviews(conn, eq(feedback.id, feedbackId), 1);
    if (!review?.restaurantId || !(await isStaff(conn, userId, review.restaurantId)))
      throw new ApiError(404, 'FEEDBACK_NOT_FOUND', 'Review not found');
    return { ...review, restaurantId: review.restaurantId };
  }

  app.get('/staff/restaurants', authed, async (request) => ({
    items: await deps.db
      .select({ id: restaurants.id, name: restaurants.name })
      .from(restaurantStaff)
      .innerJoin(restaurants, eq(restaurants.id, restaurantStaff.restaurantId))
      .where(eq(restaurantStaff.userId, request.auth!.userId))
      .orderBy(restaurants.name, restaurants.id),
  }));

  app.get('/staff/restaurants/:id/reviews', authed, async (request) => {
    const { id } = parse(idParam, request.params);
    const query = parse(pageQuery, request.query);
    if (!(await isStaff(deps.db, request.auth!.userId, id))) throw notFound();
    const after = decodeTimeCursor(query.cursor);
    const rows = await staffReviews(
      deps.db,
      and(
        sql`${restaurantOf} = ${id}::uuid`,
        // Moderated reviews are not shown to anyone but their author.
        isNull(feedback.hiddenAt),
        after
          ? or(lt(feedback.createdAt, after[0]), and(eq(feedback.createdAt, after[0]), lt(feedback.id, after[1])))
          : undefined,
      ),
      query.limit + 1,
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => r.view),
      nextCursor:
        rows.length > query.limit && last ? encodeCursor(last.createdAt.toISOString(), last.view.feedbackId) : null,
    };
  });

  app.put('/staff/reviews/:feedbackId/reply', writes, async (request, reply) => {
    const auth = request.auth!;
    const { feedbackId } = parse(feedbackParam, request.params);
    const { body } = parse(replyBody, request.body);
    // Checked before a stored response can be replayed, and again inside the write.
    await ownReview(deps.db, auth.userId, feedbackId);
    const out = await idempotent(deps, request, auth.userId, `reply.put:${feedbackId}`, async (tx) => {
      const review = await ownReview(tx, auth.userId, feedbackId);
      if (review.hidden) throw new ApiError(409, 'REVIEW_HIDDEN', 'A hidden review cannot be replied to');
      if (review.reply?.hiddenAt) throw new ApiError(409, 'REPLY_HIDDEN', 'This reply was hidden by Epsilon');
      const now = deps.now();
      const values = { restaurantId: review.restaurantId, authorUserId: auth.userId, body, updatedAt: now, deletedAt: null };
      await tx
        .insert(reviewReplies)
        .values({ feedbackId, createdAt: now, ...values })
        .onConflictDoUpdate({ target: reviewReplies.feedbackId, set: values });
      return { status: 200, body: (await ownReview(tx, auth.userId, feedbackId)).view };
    });
    return reply.code(out.status).send(out.body);
  });

  app.delete('/staff/reviews/:feedbackId/reply', writes, async (request, reply) => {
    const auth = request.auth!;
    const { feedbackId } = parse(feedbackParam, request.params);
    await ownReview(deps.db, auth.userId, feedbackId);
    const out = await idempotent(deps, request, auth.userId, `reply.delete:${feedbackId}`, async (tx) => {
      await ownReview(tx, auth.userId, feedbackId);
      await tx
        .update(reviewReplies)
        .set({ deletedAt: deps.now() })
        .where(and(eq(reviewReplies.feedbackId, feedbackId), isNull(reviewReplies.deletedAt)));
      return { status: 204, body: null };
    });
    return reply.code(out.status).send();
  });
}
