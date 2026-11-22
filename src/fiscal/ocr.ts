import { z } from 'zod';

import { fiscalDocumentSchema, integrityProblems, type FiscalDocument, type FiscalItem } from './document.js';
import { parseDecimal, parseIssuedAt } from './gemini.js';

/**
 * Deterministic reader for on-device OCR output (Google ML Kit text lines with their
 * positions). It rebuilds printed rows, finds the e-kassa labels and the item table,
 * and accepts the result only when every value is present and the arithmetic agrees.
 * Anything doubtful is reported, never filled in: the caller then falls back to Gemini
 * (if enabled) or asks for a better photo.
 */

export const ocrLineSchema = z
  .object({
    text: z.string().min(1).max(500),
    /** [left, top, right, bottom] in image pixels. */
    box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  })
  .strict();
/** One captured image: its recognised lines. */
export const ocrPageSchema = z.object({ lines: z.array(ocrLineSchema).max(2000) }).strict();
export type OcrPage = z.infer<typeof ocrPageSchema>;

/** Group OCR lines into printed rows (same vertical band), left to right. */
export function rowsOf(page: OcrPage): string[] {
  const lines = page.lines
    .map((l) => ({ text: l.text.trim(), left: l.box[0], top: l.box[1], bottom: l.box[3] }))
    .filter((l) => l.text && l.bottom > l.top)
    .sort((a, b) => (a.top + a.bottom) / 2 - (b.top + b.bottom) / 2 || a.left - b.left);
  const heights = lines.map((l) => l.bottom - l.top).sort((a, b) => a - b);
  const tolerance = (heights[Math.floor(heights.length / 2)] ?? 10) * 0.55;
  const rows: { center: number; parts: typeof lines }[] = [];
  for (const line of lines) {
    const center = (line.top + line.bottom) / 2;
    const row = rows.at(-1);
    if (row && Math.abs(center - row.center) <= tolerance) row.parts.push(line);
    else rows.push({ center, parts: [line] });
  }
  return rows.map((r) =>
    r.parts
      .sort((a, b) => a.left - b.left)
      .map((p) => p.text)
      .join('  ')
      .replace(/\s{3,}/g, '  '),
  );
}

const norm = (s: string) => s.toLocaleUpperCase('az').replace(/\s+/g, ' ').trim();

/** Join consecutive parts of one long receipt, dropping the rows two photos share. */
export function mergeParts(parts: string[][]): string[] {
  const out: string[] = [...(parts[0] ?? [])];
  for (const next of parts.slice(1)) {
    let overlap = 0;
    for (let k = Math.min(20, out.length, next.length); k > 0; k--) {
      const tail = out.slice(-k).map(norm);
      const head = next.slice(0, k).map(norm);
      if (tail.every((t, i) => t === head[i])) {
        overlap = k;
        break;
      }
    }
    out.push(...next.slice(overlap));
  }
  return out;
}

const MONEY = String.raw`-?\d{1,7}[.,]\d{2}`;
const QTY = String.raw`\d{1,6}(?:[.,]\d{1,3})?`;
const UNITS = String.raw`ədəd|əd|ad|ed|kq|kg|qr|gr|lt|l|porsiya|pors|ədəd\.`;
/**
 * "<name> [unit|(unit)] [qty] <price> <total>" at the end of a row. The official e-kassa
 * image prints the unit in brackets ("(ədəd)") and its lone quantity digit is the token
 * OCR most often drops, so the quantity is optional here and derived exactly below.
 */
const ITEM_ROW = new RegExp(
  String.raw`^(.*?)\s+(?:(${UNITS})\.?\s+|\(([^\s()]{1,10})\)\s*)?(?:(${QTY})\s+)?(${MONEY})\s+(${MONEY})\s*$`,
  'iu',
);
/** OCR variants of the printed unit "ədəd" ("ədad", "edəd", …). */
const unitOf = (raw: string | undefined) =>
  !raw ? null : /^[əea]d[əea]d\.?$/iu.test(raw) ? 'ədəd' : raw.toLocaleLowerCase('az');
/** Quantity = total ÷ unit price, only when that division is exact to 3 decimals. */
function exactQuantityMilli(unitPriceMinor: number, lineTotalMinor: number): number | null {
  if (unitPriceMinor <= 0) return null;
  const milli = (lineTotalMinor * 1000) / unitPriceMinor;
  return Number.isInteger(milli) && milli > 0 ? milli : null;
}
const UNIT_ONLY = new RegExp(String.raw`^(?:${UNITS})\.?$`, 'iu');
const SUB_ROW = /^\*?\s*(ƏDV|EDV|Ticarət əlavəsi|Ticaret elavesi|Endirim|Barkod|\d{8,14}$)|^\*\s*[ƏE]?D?V\s*[:\d]/iu;
const HEADER = /(Mal[ıi]n ad[ıi]|M[əe]hsulun ad[ıi]|Miqdar.*Qiym[əe]t)/iu;
const TOTAL = new RegExp(String.raw`^(?:YEKUN\s+M[ƏE]BL[ƏE][ĞG]|C[ƏE]M[İI]|YEKUN)\b.*?(${MONEY})\s*(?:AZN|₼)?\s*$`, 'iu');

const find = (rows: string[], re: RegExp) => {
  for (const row of rows) {
    const m = re.exec(row);
    if (m) return m[1]!.trim();
  }
  return null;
};

/** A labelled value plus the rows it wraps onto (at most two), while `continues` accepts them. */
function withContinuation(rows: string[], re: RegExp, continues: (row: string) => boolean): string | null {
  const index = rows.findIndex((r) => re.test(r));
  if (index < 0) return null;
  const parts = [re.exec(rows[index]!)![1]!.trim()];
  for (const next of rows.slice(index + 1, index + 3)) {
    if (!next.trim() || !continues(next)) break;
    parts.push(next.trim());
  }
  return parts.join(' ');
}

export type OcrResult = { document: FiscalDocument | null; printedFiscalId: string | null; uncertain: string[] };

/** Rows → normalized receipt (or the list of what could not be read). */
export function parseReceiptRows(rows: string[], fiscalId: string): OcrResult {
  const uncertain: string[] = [];
  const printedFiscalId = find(rows, /Fis(?:c|k)al\s*[İIı]D\s*[:.]?\s*([A-Za-z0-9]{12})/iu);
  const objectName = find(rows, /Obyektin ad[ıi]\s*[:.]?\s*(.+)$/iu);
  const legalName = withContinuation(rows, /Vergi ödəyicisinin ad[ıi]\s*[:.]?\s*(.+)$/iu, (next) =>
    /(MƏHDUD|MƏSULİYYƏT|CƏMİYYƏT|MMC|ASC|QSC)/iu.test(next),
  )?.replace(/^"(.*)"(\s|$)/u, '$1$2').trim() ?? null;
  const voen = find(rows, /V[ÖO]EN\s*[:.]?\s*(\d{10})\b/iu);
  // The label can wrap or be misread ("Obyektin kod." + "kodu: …"); the value shape is distinctive.
  const objectCode = find(rows, /kodu\s*[:.]?\s*([0-9]{10}-[0-9]+)/iu);
  // Wrapped address lines follow until the next labelled row.
  const address = withContinuation(rows, /Obyektin ünvan[ıi]\s*[:.]?\s*(.+)$/iu, (next) => !/[:№]|Obyektin|Vergi/iu.test(next));
  // "№" is often read as "Ne", "No" or "N°".
  const number = find(rows, /(?:Satış çeki|Satis ceki|Çek)\s*(?:№|N[eo°º]\.?)\s*(\d+)/iu);
  const date = find(rows, /\b(\d{2}[./]\d{2}[./]\d{4})\b/u);
  const time = find(rows, /\b(\d{2}:\d{2}(?::\d{2})?)\b/u);
  const cashless = find(rows, new RegExp(String.raw`Nağdsız\s*[:.]?\s*(${MONEY})`, 'iu'));
  const cash = find(rows, new RegExp(String.raw`^Nağd\s*[:.]?\s*(${MONEY})`, 'iu'));
  const model = find(rows, /(?:Kassa aparat[ıi]n[ıi]n modeli|NKA-n[ıi]n modeli)\s*[:.]?\s*(.+)$/iu);
  const serial = find(rows, /zavod nömrəsi\s*[:.]?\s*(\d+)/iu);
  const nmq = find(rows, /NMQ-nun qeydiyy[ae]t nömrəsi\s*[:.]?\s*(\d+)/iu);

  const totalIndex = rows.findIndex((r) => TOTAL.test(r));
  const totalMinor = totalIndex >= 0 ? parseDecimal(TOTAL.exec(rows[totalIndex]!)![1]!, 2) : null;
  const headerIndex = rows.findIndex((r) => HEADER.test(r));

  // Item table: between the column header and the grand total.
  const items: FiscalItem[] = [];
  let pendingName: string[] = [];
  // The table ends at the grand total; if that is unreadable, at the payment/fiscal section.
  const endIndex =
    totalIndex > headerIndex
      ? totalIndex
      : rows.findIndex((r, i) => i > headerIndex && /^(Nağd|Nagd|Ödəniş|Odenis|Fis(c|k)al|\*{3,}|Bonus)/iu.test(r.trim()));
  if (headerIndex >= 0 && endIndex > headerIndex) {
    for (const row of rows.slice(headerIndex + 1, endIndex)) {
      if (/^[*\s=-]+$/.test(row) || SUB_ROW.test(row.trim())) continue;
      const m = ITEM_ROW.exec(row);
      if (m) {
        let tail = m[1]!.replace(/^#\d+\s*/, '').trim();
        let unit = unitOf(m[2] ?? m[3]);
        // "<unit> <qty> <price> <total>" under a name printed on the row above.
        if (!unit && UNIT_ONLY.test(tail)) [unit, tail] = [tail, ''];
        const name = [...pendingName, tail].join(' ').replace(/\s+/g, ' ').trim();
        pendingName = [];
        const unitPriceMinor = parseDecimal(m[5]!, 2);
        const lineTotalMinor = parseDecimal(m[6]!, 2);
        // A printed quantity is kept; a dropped one is derived only when total ÷ price is exact.
        const quantityMilli = m[4]
          ? parseDecimal(m[4], 3)
          : unitPriceMinor !== null && lineTotalMinor !== null
            ? exactQuantityMilli(unitPriceMinor, lineTotalMinor)
            : null;
        if (!name || quantityMilli === null || quantityMilli <= 0 || unitPriceMinor === null || lineTotalMinor === null) {
          uncertain.push(`line ${items.length + 1}`);
          continue;
        }
        items.push({
          lineNo: items.length + 1,
          originalName: name,
          normalizedName: name,
          quantityMilli,
          unit,
          unitPriceMinor,
          lineTotalMinor,
          discountMinor: null,
          vatRatePercent: null,
          vatMinor: null,
        });
      } else if (/^#\d+/.test(row.trim()) || items.length === 0) {
        pendingName.push(row.trim().replace(/^#\d+\s*/, '')); // a product name printed above its numbers
      } else {
        // A wrapped tail of the previous product name ("... 620" + "QR").
        const last = items.at(-1)!;
        last.originalName = last.normalizedName = `${last.originalName} ${row.trim()}`;
      }
    }
    if (pendingName.length) uncertain.push(`line ${items.length + 1}`);
  }

  if (!printedFiscalId) uncertain.push('fiscalId');
  if (headerIndex < 0 || items.length === 0) uncertain.push('items');
  if (totalMinor === null) uncertain.push('total');
  const issuedAt = parseIssuedAt(date, time);
  if (!issuedAt) uncertain.push('date');
  // The business name printed at the top, unless it is a label row or a number.
  const header = rows.find((r) => r.trim() && !/[:№]/.test(r) && !/^[\d\s.,*-]+$/.test(r));
  const displayName = objectName ?? header?.trim() ?? legalName;
  if (!displayName) uncertain.push('merchant');
  if (uncertain.length) return { document: null, printedFiscalId, uncertain: [...new Set(uncertain)] };

  const doc: FiscalDocument = {
    merchant: {
      displayName: displayName!,
      legalName,
      voen,
      objectName,
      objectCode,
      address,
      city: null,
    },
    receipt: {
      fiscalId,
      number,
      documentId: null,
      type: 'sale',
      issuedAt: issuedAt!,
      currency: 'AZN',
      totalMinor: totalMinor!,
      subtotalMinor: null,
      discountMinor: null,
      vatMinor: null,
      vatBreakdown: [],
      payment: {
        method: null,
        cashMinor: parseDecimal(cash, 2),
        cashlessMinor: parseDecimal(cashless, 2),
        bonusMinor: null,
        changeMinor: null,
      },
    },
    items,
    device: { model, serialNumber: serial, nmqRegistrationNumber: nmq },
    additionalFields: {},
  };
  const valid = fiscalDocumentSchema.safeParse(doc);
  if (!valid.success) return { document: null, printedFiscalId, uncertain: ['format'] };
  const problems = integrityProblems(valid.data);
  return problems.length ? { document: null, printedFiscalId, uncertain: problems } : { document: valid.data, printedFiscalId, uncertain: [] };
}

/** OCR pages (one per photo, in capture order) → receipt or what is missing. */
export function readOcr(pages: OcrPage[], fiscalId: string): OcrResult {
  return parseReceiptRows(mergeParts(pages.map(rowsOf)), fiscalId);
}
