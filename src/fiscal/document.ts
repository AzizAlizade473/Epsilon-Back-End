import { z } from 'zod';

/**
 * Normalized fiscal receipt: everything a fiscal provider returned, in one shape.
 * Money is integer qəpik, quantities integer thousandths. Anything the provider did
 * not supply is null: never guessed. Values come only from the provider, never from AI.
 */
const minor = z.number().int().min(-100_000_000).max(100_000_000);
const text = (max = 300) => z.string().trim().min(1).max(max);

export const fiscalItemSchema = z
  .object({
    /** 1-based position on the receipt: the stable line identity. */
    lineNo: z.number().int().min(1).max(500),
    originalName: text(),
    /** Display form (whitespace cleaned). The original is always kept above. */
    normalizedName: text(),
    quantityMilli: z.number().int().min(1).max(100_000_000),
    unit: text(16).nullable(),
    unitPriceMinor: minor.min(0),
    lineTotalMinor: minor,
    discountMinor: minor.nullable(),
    vatRatePercent: z.number().min(0).max(100).nullable(),
    vatMinor: minor.nullable(),
  })
  .strict();

export const fiscalDocumentSchema = z
  .object({
    merchant: z
      .object({
        displayName: text(),
        legalName: text().nullable(),
        voen: z.string().regex(/^\d{10}$/).nullable(),
        objectName: text().nullable(),
        objectCode: text(64).nullable(),
        address: text(500).nullable(),
        city: text(100).nullable(),
      })
      .strict(),
    receipt: z
      .object({
        fiscalId: text(64),
        number: text(64).nullable(),
        documentId: text(128).nullable(),
        type: z.enum(['sale', 'return', 'prepayment', 'credit', 'other']).nullable(),
        /** ISO-8601 with offset (Azerbaijan is UTC+4). */
        issuedAt: z.iso.datetime({ offset: true }),
        currency: z.literal('AZN'),
        totalMinor: minor.min(0),
        subtotalMinor: minor.nullable(),
        discountMinor: minor.nullable(),
        vatMinor: minor.nullable(),
        vatBreakdown: z.array(z.object({ ratePercent: z.number().min(0).max(100), amountMinor: minor }).strict()).max(10),
        payment: z
          .object({
            method: z.enum(['cash', 'cashless', 'mixed', 'bonus', 'other']).nullable(),
            cashMinor: minor.nullable(),
            cashlessMinor: minor.nullable(),
            bonusMinor: minor.nullable(),
            changeMinor: minor.nullable(),
          })
          .strict(),
      })
      .strict(),
    items: z.array(fiscalItemSchema).min(1).max(500),
    device: z
      .object({
        model: text().nullable(),
        serialNumber: text(64).nullable(),
        nmqRegistrationNumber: text(64).nullable(),
      })
      .strict(),
    /** Other provider fields, kept rather than silently dropped (scalars only). */
    additionalFields: z.record(z.string().max(100), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])),
  })
  .strict();
export type FiscalDocument = z.infer<typeof fiscalDocumentSchema>;
export type FiscalItem = z.infer<typeof fiscalItemSchema>;

/** Keys a provider may send that identify people: removed before storage or display. */
export const PERSONAL_KEYS = /cashier|kassir|operator|employee|işçi|customer|müştəri|phone|telefon|card|kart/i;

/** Drop personal fields from provider extras. */
export function withoutPersonal(fields: FiscalDocument['additionalFields']): FiscalDocument['additionalFields'] {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !PERSONAL_KEYS.test(key)));
}

/** Integrity checks on provider data. Returns problems; an empty list means consistent. */
export function integrityProblems(doc: FiscalDocument): string[] {
  const problems: string[] = [];
  const lines = new Set<number>();
  for (const item of doc.items) {
    if (lines.has(item.lineNo)) problems.push(`duplicate line ${item.lineNo}`);
    lines.add(item.lineNo);
    // qty × price may differ from the printed total by rounding only (≤ 1 qəpik per line + printed discount).
    const expected = Math.round((item.quantityMilli * item.unitPriceMinor) / 1000) - (item.discountMinor ?? 0);
    if (Math.abs(expected - item.lineTotalMinor) > 1) problems.push(`line ${item.lineNo} total`);
  }
  const sum = doc.items.reduce((total, i) => total + i.lineTotalMinor, 0) - (doc.receipt.discountMinor ?? 0);
  if (Math.abs(sum - doc.receipt.totalMinor) > doc.items.length) problems.push('receipt total');
  return problems;
}
