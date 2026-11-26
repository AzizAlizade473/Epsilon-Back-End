/**
 * Fiscal receipt QR parsing. A QR is untrusted input: this module only ever
 * EXTRACTS an identity. It never fetches, follows or executes anything.
 *
 * OBSERVED FORMAT (3 real receipts, 2 register models, decoded 2026-11-17):
 *   https://monitoring.e-kassa.gov.az/#/index?doc=<doc>
 * - <doc> is either the 12-character printed "Fiscal ID" (PAX A930), or a
 *   44-character token whose first 12 characters ARE the printed Fiscal ID
 *   (POS CLASS TX-1700M). Both map to the same identity: the 12-char Fiscal ID.
 * - Some registers append a NUL byte after the URL; it is padding and is dropped.
 * Only this observed shape is accepted. Widen it only from real decoded samples.
 */

/**
 * `fiscalId` is the 12-char receipt identity (dedup key). `document` is the complete
 * `doc` value exactly as encoded (12 or 44 chars): use it, never `fiscalId`, to build
 * the official verification URL.
 */
export type FiscalRef = { issuer: 'e-kassa'; fiscalId: string; document: string };

export type QrErrorCode =
  | 'QR_EMPTY'
  | 'QR_TOO_LONG'
  | 'QR_MALFORMED'
  | 'QR_HOST_NOT_ALLOWED'
  | 'QR_NO_FISCAL_ID';

export class QrError extends Error {
  constructor(readonly code: QrErrorCode) {
    super(code);
  }
}

export const MAX_QR_LENGTH = 2048;
const ALLOWED_HOSTS = new Set(['monitoring.e-kassa.gov.az']);
const ID_PARAMS = ['doc'];
/** 12-char Fiscal ID, optionally followed by 32 more characters (long form). */
const DOC = /^[A-Za-z0-9]{12}(?:[A-Za-z0-9]{32})?$/;
export const FISCAL_ID_LENGTH = 12;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function findId(params: URLSearchParams): string | null {
  for (const [key, value] of params) if (ID_PARAMS.includes(key.toLowerCase())) return value;
  return null;
}

/**
 * Returns the fiscal identity, or `null` when the text is not a link at all
 * (so the caller can treat it as Epsilon's own opaque purchase code).
 * Anything that looks like a link but is not an allowed e-kassa one is rejected.
 */
export function parseFiscalQr(raw: string): FiscalRef | null {
  // Trailing NUL padding seen on real POS CLASS receipts; NUL anywhere else stays malformed.
  const text = raw.replace(/\u0000+$/, '').trim();
  if (!text) throw new QrError('QR_EMPTY');
  if (text.length > MAX_QR_LENGTH) throw new QrError('QR_TOO_LONG');
  if (CONTROL.test(text)) throw new QrError('QR_MALFORMED');
  if (!HAS_SCHEME.test(text)) return null;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new QrError('QR_MALFORMED');
  }
  // https only, default port, no credentials, exact allow-listed host (URL() has
  // already normalised case, IDNA and percent-encoded or numeric hosts).
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password)
    throw new QrError('QR_HOST_NOT_ALLOWED');
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new QrError('QR_HOST_NOT_ALLOWED');

  const hashQuery = url.hash.includes('?') ? url.hash.slice(url.hash.indexOf('?') + 1) : '';
  const id = findId(url.searchParams) ?? findId(new URLSearchParams(hashQuery));
  if (!id || !DOC.test(id)) throw new QrError('QR_NO_FISCAL_ID');
  return { issuer: 'e-kassa', fiscalId: id.slice(0, FISCAL_ID_LENGTH), document: id };
}

/** A Fiscal ID typed by hand (spaces ignored). Case is kept: real IDs are mixed-case. */
export function typedFiscalRef(raw: string): FiscalRef | null {
  const text = raw.replace(/\s/g, '');
  return DOC.test(text) ? { issuer: 'e-kassa', fiscalId: text.slice(0, FISCAL_ID_LENGTH), document: text } : null;
}

/** The official e-kassa verification page for a parsed QR (full document identifier). */
export const officialVerificationUrl = (ref: Pick<FiscalRef, 'document'>) =>
  `https://monitoring.e-kassa.gov.az/#/index?doc=${encodeURIComponent(ref.document)}`;

/** For logs and responses: never print a whole fiscal ID. */
export const maskFiscalId = (id: string) => `${id.slice(0, 2)}…${id.slice(-2)}`;
