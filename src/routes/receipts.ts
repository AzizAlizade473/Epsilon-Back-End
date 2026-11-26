import { and, desc, eq, isNotNull, lt, not, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Deps } from '../context.js';
import { branches, fiscalReceipts, ledgerEntries, purchaseItems, purchases, restaurants } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { sha256 } from '../lib/crypto.js';
import { idempotent } from '../lib/idempotency.js';
import { decodeTimeCursor, encodeCursor, idParam, likePattern, pageQuery, parse } from '../lib/validation.js';
import { loadUser, receiptView, rewardEligible } from '../lib/views.js';
import { noAdvisor } from '../fiscal/classify.js';
import { unavailableProvider } from '../fiscal/provider.js';
import { maskFiscalId, parseFiscalQr, QrError } from '../fiscal/qr.js';
import { saveFailedImport } from '../fiscal/debug.js';
import { IMAGE_PROVIDERS, importFiscalFromImage, obtainFiscalReceipt, userCopy } from '../fiscal/service.js';
import { ImageReadError, type ReceiptImageReader } from '../fiscal/gemini.js';
import { validateImage } from '../fiscal/image.js';
import { ocrPageSchema } from '../fiscal/ocr.js';

const resolveBody = z
  .object({
    kind: z.enum(['qr', 'code']),
    value: z.string().min(1).max(2048).refine((v) => v.trim().length > 0),
  })
  .strict();

const imageBody = z.object({ mime: z.enum(['image/jpeg', 'image/png', 'image/webp']), data: z.string().min(100) }).strict();
const importBody = z
  .object({
    /** The scanned fiscal QR text. */
    qr: z.string().min(1).max(2048),
    source: z.enum(['official_page', 'paper_photo']),
    /** One image, or up to 4 consecutive parts of a long receipt. */
    images: z.array(imageBody).min(1).max(4),
    /** On-device OCR lines per image (same order), when the app could run ML Kit. */
    ocr: z.array(ocrPageSchema).max(4).optional(),
    /** Product lines the customer completed after a partial read (needs `ocr`). */
    corrections: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            quantityMilli: z.number().int().min(1).max(100_000_000),
            unitPriceMinor: z.number().int().min(0).max(1_000_000_000),
            lineTotalMinor: z.number().int().min(0).max(1_000_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .optional(),
  })
  .strict();

const visitDay = z.iso.date().refine((d) => d >= '2000-01-01');
const listQuery = pageQuery
  .extend({
    limit: z.coerce.number().int().min(1).max(50).default(50),
    q: z.string().trim().min(1).max(80).refine((v) => !v.includes('\0')).optional(),
    /** Visit (issue) days in Asia/Baku, both inclusive. */
    from: visitDay.optional(),
    to: visitDay.optional(),
    partner: z.enum(['true', 'false']).optional(),
    cashback: z.enum(['eligible', 'none']).optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ['to'] });

/** Restaurant, branch, fiscal number / id or dish name contains `q`. */
function matchesText(q: string): SQL {
  const p = likePattern(q);
  return sql`(${restaurants.name} ilike ${p} or ${branches.name} ilike ${p} or ${fiscalReceipts.fiscalId} ilike ${p}
    or ${fiscalReceipts.document}->'merchant'->>'displayName' ilike ${p} or ${fiscalReceipts.document}->'merchant'->>'objectName' ilike ${p}
    or ${fiscalReceipts.document}->'receipt'->>'number' ilike ${p} or ${fiscalReceipts.document}->'receipt'->>'documentId' ilike ${p}
    or exists (select 1 from ${purchaseItems} where ${purchaseItems.purchaseId} = ${purchases.id} and ${purchaseItems.name} ilike ${p}))`;
}

/** SQL form of the receipt view's cashback rule (fiscal/service.ts `eligibility`; partner codes: rate above zero).
 * The phone-verification half depends only on the user and is applied by the caller. */
const paysCashback = sql`(case when ${fiscalReceipts.id} is null then coalesce(${restaurants.cashbackBps}, 0) > 0
  else ${fiscalReceipts.sector} = 'horeca' and ${fiscalReceipts.restaurantId} is not null
    and coalesce((${fiscalReceipts.classificationEvidence}->>'cashbackBps')::int, 0) > 0
    and ${fiscalReceipts.provider} not in (${sql.join(Object.values(IMAGE_PROVIDERS).map((v) => sql`${v}`), sql`, `)}) end)`;

const disabledReader: ReceiptImageReader = {
  read: async () => {
    throw new ImageReadError('disabled');
  },
};

/** The opaque reference printed on the bill. Only its SHA-256 is stored, and the
 * QR carries nothing else the server trusts (no amount, no restaurant). */
export const referenceHash = (value: string) => sha256(value.trim().toUpperCase());

export async function receiptRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/receipts/resolve', { config: { auth: true, rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const auth = request.auth!;
    const body = parse(resolveBody, request.body);

    // An e-kassa QR is parsed, never fetched; other text is Epsilon's own purchase code.
    let ref: ReturnType<typeof parseFiscalQr>;
    try {
      ref = parseFiscalQr(body.value);
    } catch (error) {
      if (error instanceof QrError) throw new ApiError(422, 'RECEIPT_UNSUPPORTED', 'Unsupported receipt code');
      throw error;
    }
    if (ref) {
      const fiscal = await obtainFiscalReceipt(deps.db, ref, deps.fiscal ?? unavailableProvider, deps.advisor ?? noAdvisor, deps.now());
      const out = await idempotent(deps, request, auth.userId, 'receipt.resolve', async (tx) => {
        const now = deps.now();
        const purchaseId = await userCopy(tx, auth.userId, fiscal, now);
        const user = await loadUser(tx, auth.userId);
        return { status: 200, body: await receiptView(tx, purchaseId, user, deps.config, now) };
      });
      return reply.code(out.status).send(out.body);
    }

    const out = await idempotent(deps, request, auth.userId, 'receipt.resolve', async (tx) => {
      const now = deps.now();
      const [purchase] = await tx
        .select()
        .from(purchases)
        .where(eq(purchases.referenceHash, referenceHash(body.value)))
        .for('update');
      if (!purchase) throw new ApiError(404, 'RECEIPT_NOT_FOUND', 'Receipt not found');
      if (purchase.status !== 'open') throw new ApiError(422, 'RECEIPT_UNSUPPORTED', 'Receipt not eligible');
      if (purchase.claimedBy && purchase.claimedBy !== auth.userId)
        throw new ApiError(409, 'RECEIPT_ALREADY_CLAIMED', 'Receipt already claimed');
      if (!purchase.claimedBy) {
        if (purchase.expiresAt <= now) throw new ApiError(410, 'RECEIPT_EXPIRED', 'Receipt expired');
        await tx.update(purchases).set({ claimedBy: auth.userId, claimedAt: now }).where(eq(purchases.id, purchase.id));
      }
      const user = await loadUser(tx, auth.userId);
      return { status: 200, body: await receiptView(tx, purchase.id, user, deps.config, now) };
    });
    return reply.code(out.status).send(out.body);
  });

  /**
   * Customer-assisted import when no authorised provider has the receipt: the
   * customer supplies the official e-kassa receipt image (saved from the official
   * page) or a photo of the paper receipt. Always starts from the scanned QR.
   */
  app.post(
    '/receipts/fiscal/import',
    { bodyLimit: 24 * 1024 * 1024, config: { auth: true, rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = request.auth!;
      const body = parse(importBody, request.body);
      let ref: ReturnType<typeof parseFiscalQr>;
      try {
        ref = parseFiscalQr(body.qr);
      } catch (error) {
        if (error instanceof QrError) throw new ApiError(422, 'RECEIPT_UNSUPPORTED', 'Unsupported receipt code');
        throw error;
      }
      if (!ref) throw new ApiError(422, 'RECEIPT_UNSUPPORTED', 'Not an e-kassa receipt code');
      const images = body.images.map((i) => validateImage(i.data, i.mime, deps.config.MAX_RECEIPT_IMAGE_BYTES));
      const trace = (event: string) => request.log.info({ fiscal: maskFiscalId(ref.fiscalId) }, `receipt_import ${event}`);
      let fiscal;
      try {
        fiscal = await importFiscalFromImage(deps.db, ref, body.source, images, deps.reader ?? disabledReader, deps.now(), body.ocr ?? [], trace, body.corrections);
      } catch (error) {
        if (deps.config.FISCAL_DEBUG_DIR && deps.config.NODE_ENV !== 'production')
          saveFailedImport(deps.config.FISCAL_DEBUG_DIR, ref.fiscalId, body, error);
        throw error;
      }
      const out = await idempotent(deps, request, auth.userId, 'receipt.import', async (tx) => {
        const now = deps.now();
        const purchaseId = await userCopy(tx, auth.userId, fiscal, now);
        const user = await loadUser(tx, auth.userId);
        return { status: 200, body: await receiptView(tx, purchaseId, user, deps.config, now) };
      });
      return reply.code(out.status).send(out.body);
    },
  );

  /** This account's receipts, newest first (includes scanned fiscal receipts without cashback). */
  app.get('/receipts', { config: { auth: true } }, async (request) => {
    const query = parse(listQuery, request.query);
    const userId = request.auth!.userId;
    const filters: (SQL | undefined)[] = [eq(purchases.claimedBy, userId), isNotNull(purchases.claimedAt)];
    const after = decodeTimeCursor(query.cursor);
    if (after)
      filters.push(or(lt(purchases.claimedAt, after[0]), and(eq(purchases.claimedAt, after[0]), lt(purchases.id, after[1]))));
    if (query.q) filters.push(matchesText(query.q));
    const day = sql`(${purchases.issuedAt} at time zone 'Asia/Baku')::date`;
    if (query.from) filters.push(sql`${day} >= ${query.from}::date`);
    if (query.to) filters.push(sql`${day} <= ${query.to}::date`);
    if (query.partner) {
      const isPartner = sql`(${restaurants.id} is not null or ${fiscalReceipts.restaurantId} is not null)`;
      filters.push(query.partner === 'true' ? isPartner : not(isPartner));
    }
    if (query.cashback) {
      const eligible = rewardEligible(await loadUser(deps.db, userId), deps.config) ? paysCashback : sql`false`;
      filters.push(query.cashback === 'eligible' ? eligible : not(eligible));
    }
    const rows = await deps.db
      .select({ id: purchases.id, claimedAt: purchases.claimedAt })
      .from(purchases)
      .leftJoin(branches, eq(branches.id, purchases.branchId))
      .leftJoin(restaurants, eq(restaurants.id, branches.restaurantId))
      .leftJoin(fiscalReceipts, eq(fiscalReceipts.id, purchases.fiscalReceiptId))
      .where(and(...filters))
      .orderBy(desc(purchases.claimedAt), desc(purchases.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({ id: r.id })),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.claimedAt!.toISOString(), last.id) : null,
    };
  });

  app.get('/receipts/:id', { config: { auth: true } }, async (request) => {
    const { id } = parse(idParam, request.params);
    const user = await loadUser(deps.db, request.auth!.userId);
    const view = await receiptView(deps.db, id, user, deps.config, deps.now());
    // Opt-in so that installed apps with a strict response schema keep working.
    if ((request.query as { include?: unknown }).include !== 'cashback') return view;
    const [sum] = await deps.db
      .select({
        earned: sql<string>`coalesce(sum(${ledgerEntries.amountMinor}) filter (where ${ledgerEntries.status} = 'confirmed' and ${ledgerEntries.type} in ('earned', 'reversed')), 0)`,
        pending: sql<string>`coalesce(sum(${ledgerEntries.amountMinor}) filter (where ${ledgerEntries.status} = 'pending'), 0)`,
      })
      .from(ledgerEntries)
      .innerJoin(purchaseItems, eq(purchaseItems.id, ledgerEntries.purchaseItemId))
      .where(and(eq(purchaseItems.purchaseId, id), eq(ledgerEntries.userId, user.id)));
    return { ...view, cashback: { earnedMinor: Math.max(0, Number(sum?.earned ?? 0)), pendingMinor: Math.max(0, Number(sum?.pending ?? 0)) } };
  });
}
