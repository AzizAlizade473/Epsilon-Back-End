import { and, eq } from 'drizzle-orm';

import type { Db, Tx } from '../db/client.js';
import { fiscalCashbackClaims, fiscalReceipts, purchaseItems, purchases } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { sha256 } from '../lib/crypto.js';
import { classifyMerchant, type Classification, type SectorAdvisor } from './classify.js';
import { fiscalDocumentSchema, integrityProblems, withoutPersonal, type FiscalDocument, type FiscalItem } from './document.js';
import type { FiscalProvider } from './provider.js';
import { ImageReadError, type ReceiptImageReader } from './gemini.js';
import type { ReceiptImage } from './image.js';
import { readOcr, type OcrPage } from './ocr.js';
import type { FiscalRef } from './qr.js';

type Conn = Db | Tx;
export type FiscalRow = typeof fiscalReceipts.$inferSelect;

/** Receipts stay ratable this long after the scan (same as partner purchases). */
const RATING_WINDOW_MS = 30 * 24 * 3600 * 1000;
const SOURCE_TIMEOUT_MS = 10_000;
const READER_TIMEOUT_MS = 90_000;

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
  return storeFiscal(db, ref, provider.name, document, lookup.raw ?? null, c, now);
}

/** Customer-supplied image sources. Never presented as government-verified. */
export type ImageSource = 'official_page' | 'paper_photo';
export const IMAGE_PROVIDERS: Record<ImageSource, string> = {
  official_page: 'customer_official_image',
  paper_photo: 'customer_paper_photo',
};

/** OCR may confuse look-alike characters (O/0, I/l): allow two, never a different length. */
export function sameFiscalId(printed: string, known: string): boolean {
  const a = printed.trim().toLowerCase();
  const b = known.toLowerCase();
  if (a.length < b.length) return false;
  let diff = 0;
  // A printed long-form ID starts with the 12-char Fiscal ID.
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) diff++;
  return diff <= 2;
}

/**
 * Receipt contents from a customer-supplied image (official e-kassa image or paper
 * photo), read by the image reader. Used only when no authorised provider has the
 * receipt; a receipt already stored is never re-read.
 */
/** One product line confirmed by the customer (amounts in qəpik, quantity in thousandths). */
export type CorrectedLine = { name: string; quantityMilli: number; unitPriceMinor: number; lineTotalMinor: number };

export async function importFiscalFromImage(
  db: Db,
  ref: FiscalRef,
  source: ImageSource,
  images: ReceiptImage[],
  reader: ReceiptImageReader,
  now: Date,
  ocr: OcrPage[] = [],
  /** Diagnostics without receipt content: counts and which parts could not be read. */
  trace: (event: string) => void = () => undefined,
  /** Product lines the customer confirmed after a partial read (needs the same OCR). */
  corrections?: CorrectedLine[],
): Promise<FiscalRow> {
  const [known] = await db.select().from(fiscalReceipts).where(identity(ref));
  if (known) return known;

  // 0. Customer-completed product lines: merchant, date, total and Fiscal ID still come
  // from the image itself, and the lines must add up to the printed total.
  if (corrections) {
    if (!ocr.length) throw new ApiError(422, 'RECEIPT_IMAGE_INCOMPLETE', 'Corrections need the receipt text', undefined, ['items']);
    const items: FiscalItem[] = corrections.map((line, i) => ({
      lineNo: i + 1,
      originalName: line.name.trim(),
      normalizedName: line.name.trim().replace(/\s+/g, ' '),
      quantityMilli: line.quantityMilli,
      unit: null,
      unitPriceMinor: line.unitPriceMinor,
      lineTotalMinor: line.lineTotalMinor,
      discountMinor: null,
      vatRatePercent: null,
      vatMinor: null,
    }));
    const checked = readOcr(ocr, ref.fiscalId, items);
    trace(`corrections lines=${items.length} result=${checked.document ? 'complete' : checked.uncertain.join('|')}`);
    if (!checked.document)
      throw new ApiError(422, 'RECEIPT_IMAGE_INCOMPLETE', 'The corrected receipt is not consistent', undefined, checked.uncertain, {
        draft: checked.draft,
      });
    if (!checked.printedFiscalId || !sameFiscalId(checked.printedFiscalId, ref.fiscalId))
      throw new ApiError(422, 'RECEIPT_IMAGE_MISMATCH', 'The image shows a different receipt');
    const c = await classifyMerchant(db, checked.document, { suggest: async () => null });
    return storeFiscal(db, ref, IMAGE_PROVIDERS[source], checked.document, null, c, now, 'customer_corrected');
  }

  // 1. On-device OCR text (no cloud call): used only when complete and consistent.
  const local = ocr.length ? readOcr(ocr, ref.fiscalId) : null;
  trace(
    `ocr pages=${ocr.length} lines=${ocr.reduce((n, p) => n + p.lines.length, 0)} result=${
      !local ? 'none' : local.document ? 'complete' : `incomplete:${local.uncertain.join('|')}`
    }`,
  );
  if (local?.document) {
    if (!local.printedFiscalId || !sameFiscalId(local.printedFiscalId, ref.fiscalId))
      throw new ApiError(422, 'RECEIPT_IMAGE_MISMATCH', 'The image shows a different receipt');
    const c = await classifyMerchant(db, local.document, { suggest: async () => null });
    return storeFiscal(db, ref, IMAGE_PROVIDERS[source], local.document, null, c, now, 'on_device_ocr');
  }

  // 2. Gemini vision, only when on-device reading was not enough.
  let reading;
  try {
    reading = await reader.read(images, ref.fiscalId, AbortSignal.timeout(READER_TIMEOUT_MS));
  } catch (error) {
    if (!(error instanceof ImageReadError)) throw error;
    // AI off or out of quota: report what on-device OCR could not read, never guess.
    if ((error.kind === 'disabled' || error.kind === 'quota' || error.kind === 'busy') && local)
      throw new ApiError(422, 'RECEIPT_IMAGE_INCOMPLETE', 'Some parts of the receipt could not be read', undefined, local.uncertain, {
        draft: local.draft,
      });
    if (error.kind === 'disabled') throw new ApiError(503, 'RECEIPT_READER_UNAVAILABLE', 'Receipt image reading is turned off');
    if (error.kind === 'quota') throw new ApiError(503, 'RECEIPT_READER_QUOTA', 'Receipt reading limit reached for today');
    if (error.kind === 'busy') throw new ApiError(503, 'RECEIPT_READER_BUSY', 'The receipt reader is busy, try again shortly', 30);
    if (error.kind === 'incomplete')
      throw new ApiError(422, 'RECEIPT_IMAGE_INCOMPLETE', 'Some parts of the receipt could not be read', undefined, error.fields, local ? { draft: local.draft } : undefined);
    throw new ApiError(503, 'RECEIPT_READER_UNAVAILABLE', 'Receipt could not be read, try again', 10);
  }
  // The printed Fiscal ID is the only link between the image and the scanned QR: required.
  if (!reading.printedFiscalId) throw new ApiError(422, 'RECEIPT_IMAGE_INCOMPLETE', 'Fiscal ID not visible', undefined, ['fiscalId']);
  if (!sameFiscalId(reading.printedFiscalId, ref.fiscalId))
    throw new ApiError(422, 'RECEIPT_IMAGE_MISMATCH', 'The image shows a different receipt');
  // Partner record, cache and name rules first; the reader's suggestion only as the last resort (no extra AI call).
  const fromReading = { suggest: async () => reading.suggestion };
  const c = await classifyMerchant(db, reading.document, fromReading);
  return storeFiscal(db, ref, IMAGE_PROVIDERS[source], reading.document, null, c, now, 'gemini');
}

async function storeFiscal(
  db: Db,
  ref: FiscalRef,
  providerName: string,
  document: FiscalDocument,
  raw: unknown,
  c: Classification,
  now: Date,
  engine: 'structured' | 'on_device_ocr' | 'gemini' | 'customer_corrected' = 'structured',
): Promise<FiscalRow> {
  await db
    .insert(fiscalReceipts)
    .values({
      issuer: ref.issuer,
      fiscalId: ref.fiscalId,
      provider: providerName,
      extractionEngine: engine,
      document,
      raw: raw ?? null,
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
        // Exact only when quantity × price is what was charged (no line discount, no rounding).
        const whole = i.quantityMilli % 1000 === 0 && (i.quantityMilli / 1000) * i.unitPriceMinor === i.lineTotalMinor;
        return {
          purchaseId: created.id,
          lineNo: i.lineNo,
          name: i.normalizedName,
          // Weighed or discounted lines are stored as 1 × line total, so cashback follows what was paid.
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
  reason:
    | null
    | 'UNSUPPORTED_MERCHANT_CATEGORY'
    | 'MERCHANT_CATEGORY_UNKNOWN'
    | 'NOT_EPSILON_PARTNER'
    | 'VERIFICATION_REQUIRED';
};

/** Backend-only decision: only HoReCa may be rated; only active partners pay cashback. */
export function eligibility(fiscal: FiscalRow): Eligibility {
  if (fiscal.sector === 'unknown') return { ratingAllowed: false, cashbackAllowed: false, reason: 'MERCHANT_CATEGORY_UNKNOWN' };
  if (fiscal.sector !== 'horeca') return { ratingAllowed: false, cashbackAllowed: false, reason: 'UNSUPPORTED_MERCHANT_CATEGORY' };
  const bps = (fiscal.classificationEvidence as { cashbackBps?: number }).cashbackBps ?? 0;
  if (!fiscal.restaurantId || bps <= 0) return { ratingAllowed: true, cashbackAllowed: false, reason: 'NOT_EPSILON_PARTNER' };
  // Trust policy: a customer's image is enough to rate, never enough to pay money.
  if (Object.values(IMAGE_PROVIDERS).includes(fiscal.provider))
    return { ratingAllowed: true, cashbackAllowed: false, reason: 'VERIFICATION_REQUIRED' };
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
