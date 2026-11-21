import { and, eq } from 'drizzle-orm';

import type { Config } from '../config.js';
import type { Db, Tx } from '../db/client.js';
import { fiscalCashbackClaims, fiscalReceipts, purchaseItems, purchases, users } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { sha256 } from '../lib/crypto.js';
import { classifyMerchant, type Classification, type SectorAdvisor } from './classify.js';
import { fiscalDocumentSchema, integrityProblems, withoutPersonal, type FiscalDocument } from './document.js';
import type { FiscalProvider } from './provider.js';
import type { FiscalRef } from './qr.js';

type Conn = Db | Tx;
export type FiscalRow = typeof fiscalReceipts.$inferSelect;

/** Receipts stay ratable this long after the scan (same as partner purchases). */
const RATING_WINDOW_MS = 30 * 24 * 3600 * 1000;
const SOURCE_TIMEOUT_MS = 10_000;

const identity = (ref: FiscalRef) => and(eq(fiscalReceipts.issuer, ref.issuer), eq(fiscalReceipts.fiscalId, ref.fiscalId));

/**
 * The shared fiscal record: from the database when already retrieved, otherwise from
 * the provider (validated, classified, stored once even under concurrent scans).
 */
export async function obtainFiscalReceipt(
  db: Db,
  ref: FiscalRef,
  provider: FiscalProvider,
  advisor: SectorAdvisor,
  now: Date,
): Promise<FiscalRow> {
  const [known] = await db.select().from(fiscalReceipts).where(identity(ref));
  if (known) return known;

  let lookup: Awaited<ReturnType<FiscalProvider['lookup']>>;
  try {
    lookup = await provider.lookup(ref, AbortSignal.timeout(SOURCE_TIMEOUT_MS));
  } catch {
    throw new ApiError(503, 'RECEIPT_SOURCE_UNAVAILABLE', 'Fiscal receipt service unavailable', 10);
  }
  if (lookup.status === 'unavailable') throw new ApiError(503, 'RECEIPT_SOURCE_UNAVAILABLE', 'Fiscal receipt service unavailable');
  if (lookup.status === 'not_found') throw new ApiError(404, 'RECEIPT_NOT_FOUND', 'Receipt not found');

  // Provider data is validated, never repaired: inconsistent receipts are refused.
  const parsed = fiscalDocumentSchema.safeParse(lookup.document);
  if (!parsed.success || parsed.data.receipt.fiscalId !== ref.fiscalId || integrityProblems(parsed.data).length > 0)
    throw new ApiError(502, 'RECEIPT_VERIFICATION_FAILED', 'Fiscal receipt data could not be verified');
  const document: FiscalDocument = { ...parsed.data, additionalFields: withoutPersonal(parsed.data.additionalFields) };

  // Classification may ask the AI advisor: done before the write, outside any transaction.
  const c: Classification = await classifyMerchant(db, document, advisor);
  await db
    .insert(fiscalReceipts)
    .values({
      issuer: ref.issuer,
      fiscalId: ref.fiscalId,
      provider: provider.name,
      document,
      raw: lookup.raw ?? null,
      merchantVoen: document.merchant.voen,
      objectCode: document.merchant.objectCode,
      sector: c.sector,
      businessType: c.businessType,
      classificationMethod: c.method,
      classificationEvidence: { status: c.status, evidence: c.evidence, cashbackBps: c.cashbackBps },
      restaurantId: c.restaurantId,
      branchId: c.branchId,
      retrievedAt: now,
    })
    .onConflictDoNothing();
  const [stored] = await db.select().from(fiscalReceipts).where(identity(ref));
  return stored!;
}

/**
 * This user's copy of the receipt: one purchase per (user, fiscal receipt), created
 * once. Rescans return the same purchase with its ratings intact. Other users get
 * their own copy, so several people can rate the same receipt.
 */
export async function userCopy(tx: Tx, userId: string, fiscal: FiscalRow, now: Date): Promise<string> {
  const document = fiscal.document as FiscalDocument;
  const [created] = await tx
    .insert(purchases)
    .values({
      branchId: fiscal.branchId,
      fiscalReceiptId: fiscal.id,
      referenceHash: sha256(`fiscal:${fiscal.id}:${userId}`),
      issuedAt: new Date(document.receipt.issuedAt),
      totalMinor: document.receipt.totalMinor,
      expiresAt: new Date(now.getTime() + RATING_WINDOW_MS),
      claimedBy: userId,
      claimedAt: now,
    })
    .onConflictDoNothing({ target: purchases.referenceHash })
    .returning({ id: purchases.id });
  if (!created) {
    const [existing] = await tx
      .select({ id: purchases.id })
      .from(purchases)
      .where(eq(purchases.referenceHash, sha256(`fiscal:${fiscal.id}:${userId}`)));
    return existing!.id;
  }
  // Goods lines only (printed discount rows have no price of their own to rate).
  const lines = document.items.filter((i) => i.lineTotalMinor > 0);
  if (lines.length)
    await tx.insert(purchaseItems).values(
      lines.map((i) => {
        const whole = i.quantityMilli % 1000 === 0;
        return {
          purchaseId: created.id,
          lineNo: i.lineNo,
          name: i.normalizedName,
          // Weighed lines (0.37 kq) are stored as 1 × line total so price × quantity stays exact.
          quantity: whole ? i.quantityMilli / 1000 : 1,
          unitPriceMinor: whole ? i.unitPriceMinor : i.lineTotalMinor,
        };
      }),
    );
  return created.id;
}

export type Eligibility = {
  ratingAllowed: boolean;
  cashbackAllowed: boolean;
  reason: null | 'UNSUPPORTED_MERCHANT_CATEGORY' | 'MERCHANT_CATEGORY_UNKNOWN' | 'NOT_EPSILON_PARTNER' | 'PHONE_NOT_VERIFIED';
};

/** Backend-only decision: only HoReCa may be rated; only active partners pay cashback. */
export function eligibility(fiscal: FiscalRow, user: typeof users.$inferSelect, config: Config): Eligibility {
  if (fiscal.sector === 'unknown') return { ratingAllowed: false, cashbackAllowed: false, reason: 'MERCHANT_CATEGORY_UNKNOWN' };
  if (fiscal.sector !== 'horeca') return { ratingAllowed: false, cashbackAllowed: false, reason: 'UNSUPPORTED_MERCHANT_CATEGORY' };
  const bps = (fiscal.classificationEvidence as { cashbackBps?: number }).cashbackBps ?? 0;
  if (!fiscal.restaurantId || bps <= 0) return { ratingAllowed: true, cashbackAllowed: false, reason: 'NOT_EPSILON_PARTNER' };
  if (config.REQUIRE_PHONE_VERIFICATION && !user.phoneVerifiedAt)
    return { ratingAllowed: true, cashbackAllowed: false, reason: 'PHONE_NOT_VERIFIED' };
  return { ratingAllowed: true, cashbackAllowed: true, reason: null };
}

/** Lines of this fiscal receipt whose one-time cashback is already taken. */
export async function claimedLines(conn: Conn, fiscalReceiptId: string): Promise<Set<number>> {
  const rows = await conn
    .select({ lineNo: fiscalCashbackClaims.lineNo })
    .from(fiscalCashbackClaims)
    .where(eq(fiscalCashbackClaims.fiscalReceiptId, fiscalReceiptId));
  return new Set(rows.map((r) => r.lineNo));
}

/** Take the line's one-time cashback. True only for the first rater, even under races. */
export async function claimLine(tx: Tx, fiscalReceiptId: string, lineNo: number, userId: string): Promise<boolean> {
  const rows = await tx
    .insert(fiscalCashbackClaims)
    .values({ fiscalReceiptId, lineNo, userId })
    .onConflictDoNothing()
    .returning({ id: fiscalCashbackClaims.id });
  return rows.length > 0;
}
