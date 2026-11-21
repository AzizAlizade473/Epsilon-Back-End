import { and, desc, eq, lt, or } from 'drizzle-orm';
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
} from '../db/schema.js';
import { ApiError } from '../errors.js';
import { idempotent } from '../lib/idempotency.js';
import { rewardMinor } from '../lib/money.js';
import { decodeCursor, encodeCursor, pageQuery, parse } from '../lib/validation.js';
import { loadUser, rewardEligible } from '../lib/views.js';
import { claimLine, eligibility } from '../fiscal/service.js';

/** Same list as the app's RatingForm reasonCodes. */
export const REASON_CODES = ['taste', 'temperature', 'portion', 'price', 'presentation', 'wait_time'] as const;

const submitBody = z
  .object({
    receiptItemId: z.uuid(),
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(500).optional(),
    reasonCodes: z
      .array(z.enum(REASON_CODES))
      .max(3)
      .refine((codes) => new Set(codes).size === codes.length, 'duplicate reason')
      .optional(),
  })
  .strict();

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
    return reply.code(out.status).send(out.body);
  });

  app.get('/feedback', { config: { auth: true } }, async (request) => {
    const query = parse(pageQuery, request.query);
    const after = decodeCursor(query.cursor);
    const userId = request.auth!.userId;
    const rows = await deps.db
      .select({
        id: feedback.id,
        rating: feedback.rating,
        comment: feedback.comment,
        createdAt: feedback.createdAt,
        dishName: purchaseItems.name,
        restaurantName: restaurants.name,
      })
      .from(feedback)
      .innerJoin(purchaseItems, eq(purchaseItems.id, feedback.purchaseItemId))
      .innerJoin(purchases, eq(purchases.id, purchaseItems.purchaseId))
      .innerJoin(branches, eq(branches.id, purchases.branchId))
      .innerJoin(restaurants, eq(restaurants.id, branches.restaurantId))
      .where(
        and(
          eq(feedback.userId, userId),
          after
            ? or(
                lt(feedback.createdAt, new Date(after[0])),
                and(eq(feedback.createdAt, new Date(after[0])), lt(feedback.id, after[1])),
              )
            : undefined,
        ),
      )
      .orderBy(desc(feedback.createdAt), desc(feedback.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        feedbackId: r.id,
        dishName: r.dishName,
        restaurantName: r.restaurantName,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdAt.toISOString(), last.id) : null,
    };
  });
}
