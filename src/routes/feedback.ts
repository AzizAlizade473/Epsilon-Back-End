import { and, desc, eq, inArray, lt, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Deps } from '../context.js';
import {
  branches,
  feedback,
  feedbackReasons,
  fiscalReceipts,
  ledgerEntries,
  purchaseItems,
  purchases,
  restaurants,
  users,
} from '../db/schema.js';
import { ApiError } from '../errors.js';
import { idempotent } from '../lib/idempotency.js';
import { rewardMinor } from '../lib/money.js';
import { decodeTimeCursor, encodeCursor, pageQuery, parse } from '../lib/validation.js';
import { loadUser, rewardEligible } from '../lib/views.js';
import { claimLine, eligibility } from '../fiscal/service.js';
import type { FiscalDocument } from '../fiscal/document.js';
import { validReason } from '../lib/quick-comments.js';
import type { Db, Tx } from '../db/client.js';
import { cashbackCopy } from '../notifications/copy.js';
import { notify } from '../notifications/notify.js';

const opinion = {
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
  // Quick comments belong to one star rating (checked below); legacy codes fit any.
  reasonCodes: z
    .array(z.string().max(40))
    .max(6)
    .refine((codes) => new Set(codes).size === codes.length, 'duplicate reason')
    .optional(),
};
const matchingReasons = (body: { rating: number; reasonCodes?: string[] | undefined }, ctx: z.RefinementCtx) => {
  for (const code of body.reasonCodes ?? [])
    if (!validReason(code, body.rating))
      ctx.addIssue({ code: 'custom', path: ['reasonCodes'], message: `reason ${code} does not fit rating ${body.rating}` });
};
const submitBody = z
  .object({ receiptItemId: z.uuid(), ...opinion })
  .strict()
  .superRefine(matchingReasons);
const editBody = z.object(opinion).strict().superRefine(matchingReasons);
const idParam = z.object({ id: z.uuid() }).strict();

/** The author's reviews with where they ate: partner restaurant, or the merchant on the fiscal receipt. */
async function reviews(conn: Db | Tx, where: SQL | undefined, limit: number) {
  const rows = await conn
    .select({
      id: feedback.id,
      rating: feedback.rating,
      comment: feedback.comment,
      createdAt: feedback.createdAt,
      updatedAt: feedback.updatedAt,
      receiptItemId: purchaseItems.id,
      receiptId: purchases.id,
      dishName: purchaseItems.name,
      restaurantName: restaurants.name,
      restaurantLogoUrl: restaurants.logoUrl,
      document: fiscalReceipts.document,
    })
    .from(feedback)
    .innerJoin(purchaseItems, eq(purchaseItems.id, feedback.purchaseItemId))
    .innerJoin(purchases, eq(purchases.id, purchaseItems.purchaseId))
    // Non-partner fiscal receipts have no branch or restaurant: keep them.
    .leftJoin(branches, eq(branches.id, purchases.branchId))
    .leftJoin(restaurants, eq(restaurants.id, branches.restaurantId))
    .leftJoin(fiscalReceipts, eq(fiscalReceipts.id, purchases.fiscalReceiptId))
    .where(where)
    .orderBy(desc(feedback.createdAt), desc(feedback.id))
    .limit(limit);
  const codes = rows.length
    ? await conn
        .select({ feedbackId: feedbackReasons.feedbackId, code: feedbackReasons.code })
        .from(feedbackReasons)
        .where(inArray(feedbackReasons.feedbackId, rows.map((r) => r.id)))
    : [];
  return rows.map((r) => {
    const merchant = (r.document as FiscalDocument | null)?.merchant;
    return {
      row: r,
      view: {
        feedbackId: r.id,
        receiptId: r.receiptId,
        receiptItemId: r.receiptItemId,
        dishName: r.dishName,
        restaurantName: r.restaurantName ?? merchant?.objectName ?? merchant?.displayName ?? 'Restaurant',
        restaurantLogoUrl: r.restaurantLogoUrl ?? null,
        rating: r.rating,
        comment: r.comment,
        reasonCodes: codes.filter((c) => c.feedbackId === r.id).map((c) => c.code),
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt?.toISOString() ?? null,
      },
    };
  });
}

export async function feedbackRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/feedback', { config: { auth: true } }, async (request, reply) => {
    const auth = request.auth!;
    const body = parse(submitBody, request.body);
    const out = await idempotent(deps, request, auth.userId, 'feedback.submit', async (tx) => {
      const now = deps.now();
      const [row] = await tx
        .select({
          item: purchaseItems,
          purchase: purchases,
          restaurantId: branches.restaurantId,
          cashbackBps: restaurants.cashbackBps,
          fiscal: fiscalReceipts,
        })
        .from(purchaseItems)
        .innerJoin(purchases, eq(purchases.id, purchaseItems.purchaseId))
        .leftJoin(branches, eq(branches.id, purchases.branchId))
        .leftJoin(restaurants, eq(restaurants.id, branches.restaurantId))
        .leftJoin(fiscalReceipts, eq(fiscalReceipts.id, purchases.fiscalReceiptId))
        .where(and(eq(purchaseItems.id, body.receiptItemId), eq(purchases.claimedBy, auth.userId)))
        .for('update', { of: purchaseItems });
      // Not owned or unknown → terminal validation error (the app's outbox drops it).
      if (!row) throw new ApiError(422, 'VALIDATION_FAILED', 'Invalid fields: receiptItemId');
      if (row.purchase.status !== 'open' || row.purchase.expiresAt <= now)
        throw new ApiError(410, 'RECEIPT_EXPIRED', 'Receipt expired');
      const user = await loadUser(tx, auth.userId);
      // Fiscal receipts: only HoReCa can be rated (decided here, never by the app).
      const rules = row.fiscal ? eligibility(row.fiscal, user, deps.config) : null;
      if (rules && !rules.ratingAllowed) throw new ApiError(422, 'RECEIPT_UNSUPPORTED', 'This business cannot be rated');
      const [existing] = await tx
        .select({ id: feedback.id })
        .from(feedback)
        .where(eq(feedback.purchaseItemId, row.item.id));
      if (existing) throw new ApiError(409, 'FEEDBACK_ALREADY_SUBMITTED', 'Feedback already submitted');

      const comment = body.comment?.trim() || null;
      const [created] = await tx
        .insert(feedback)
        .values({ purchaseItemId: row.item.id, userId: auth.userId, rating: body.rating, comment, createdAt: now })
        .returning({ id: feedback.id });
      const feedbackId = created!.id;
      if (body.reasonCodes?.length)
        await tx.insert(feedbackReasons).values(body.reasonCodes.map((code) => ({ feedbackId, code })));

      // Reward is computed here only; the app never sends or computes an amount.
      let amount = 0;
      let restaurantId = row.restaurantId;
      if (row.fiscal) {
        // Partner fiscal receipt: each printed line pays once, to whoever rates it first.
        const bps = (row.fiscal.classificationEvidence as { cashbackBps?: number }).cashbackBps ?? 0;
        restaurantId = row.fiscal.restaurantId;
        if (rules!.cashbackAllowed && row.item.lineNo !== null && (await claimLine(tx, row.fiscal.id, row.item.lineNo, auth.userId)))
          amount = rewardMinor(row.item.unitPriceMinor, row.item.quantity, bps);
      } else if (rewardEligible(user, deps.config) && row.cashbackBps !== null)
        amount = rewardMinor(row.item.unitPriceMinor, row.item.quantity, row.cashbackBps);
      if (amount > 0 && restaurantId) {
        await tx.insert(ledgerEntries).values({
          userId: auth.userId,
          type: 'earned',
          status: 'confirmed',
          amountMinor: amount,
          restaurantId,
          branchId: row.purchase.branchId,
          purchaseItemId: row.item.id,
          feedbackId,
          createdAt: now,
        });
      }
      return {
        status: 200,
        body: {
          feedbackId,
          reward: amount > 0 ? { status: 'confirmed', amountMinor: amount } : { status: 'none', amountMinor: null },
        },
      };
    });
    // After commit; replays hit the same dedupeKey, so they never notify twice.
    const result = out.body as { feedbackId: string; reward: { status: string; amountMinor: number | null } };
    if (out.status === 200 && result.reward.status === 'confirmed' && result.reward.amountMinor)
      try {
        const [me] = await deps.db.select({ language: users.language }).from(users).where(eq(users.id, auth.userId));
        await notify(deps, auth.userId, {
          kind: 'cashback',
          ...cashbackCopy(me?.language ?? 'az', result.reward.amountMinor),
          path: '/home',
          dedupeKey: `cashback:${result.feedbackId}`,
        });
      } catch (error) {
        request.log.warn({ err: error }, 'cashback notification failed');
      }
    return reply.code(out.status).send(out.body);
  });

  app.get('/feedback', { config: { auth: true } }, async (request) => {
    const query = parse(pageQuery, request.query);
    const after = decodeTimeCursor(query.cursor);
    const userId = request.auth!.userId;
    const rows = await reviews(
      deps.db,
      and(
        // The author keeps seeing their own review even when moderation hides it from public views.
        eq(feedback.userId, userId),
        after
          ? or(lt(feedback.createdAt, after[0]), and(eq(feedback.createdAt, after[0]), lt(feedback.id, after[1])))
          : undefined,
      ),
      query.limit + 1,
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1)?.row;
    return {
      items: page.map((r) => r.view),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdAt.toISOString(), last.id) : null,
    };
  });

  app.get('/feedback/:id', { config: { auth: true } }, async (request) => {
    const { id } = parse(idParam, request.params);
    const [found] = await reviews(deps.db, and(eq(feedback.id, id), eq(feedback.userId, request.auth!.userId)), 1);
    if (!found) throw new ApiError(404, 'FEEDBACK_NOT_FOUND', 'Review not found');
    return found.view;
  });

  // Editing changes the opinion only: same review, same purchased item, no new reward.
  app.patch('/feedback/:id', { config: { auth: true } }, async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(editBody, request.body);
    const userId = request.auth!.userId;
    return deps.db.transaction(async (tx) => {
      const [own] = await tx
        .select({ id: feedback.id })
        .from(feedback)
        .where(and(eq(feedback.id, id), eq(feedback.userId, userId)))
        .for('update');
      if (!own) throw new ApiError(404, 'FEEDBACK_NOT_FOUND', 'Review not found');
      await tx
        .update(feedback)
        .set({ rating: body.rating, comment: body.comment?.trim() || null, updatedAt: deps.now() })
        .where(eq(feedback.id, id));
      await tx.delete(feedbackReasons).where(eq(feedbackReasons.feedbackId, id));
      if (body.reasonCodes?.length)
        await tx.insert(feedbackReasons).values(body.reasonCodes.map((code) => ({ feedbackId: id, code })));
      const [updated] = await reviews(tx, eq(feedback.id, id), 1);
      return updated!.view;
    });
  });
}
