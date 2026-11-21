import { fiscalDocumentSchema, type FiscalDocument } from './document.js';
import type { FiscalRef } from './qr.js';

/**
 * Source of real fiscal receipt data. Only an AUTHORISED integration (State Tax
 * Service / approved e-kassa operator agreement) may implement this for production.
 *
 * Status (verified 2026-11-17 and 2026-11-21): monitoring.e-kassa.gov.az serves each
 * receipt only as a JPEG image from an undocumented endpoint protected by reCAPTCHA
 * Enterprise. There is no published API, so live retrieval is NOT implemented and the
 * default provider reports "unavailable". Nothing here fetches the QR's URL.
 */
export type FiscalLookup =
  | { status: 'found'; document: FiscalDocument; raw: unknown }
  | { status: 'not_found' }
  | { status: 'unavailable' };

export interface FiscalProvider {
  readonly name: string;
  lookup(ref: FiscalRef, signal: AbortSignal): Promise<FiscalLookup>;
}

/** Production default until an authorised integration exists. */
export const unavailableProvider: FiscalProvider = {
  name: 'none',
  lookup: async () => ({ status: 'unavailable' }),
};

/**
 * Pre-recorded receipts for automated tests and local UI work. Clearly not live data:
 * documents carry provider "fixture" and config refuses it in production.
 */
export function fixtureProvider(documents: Map<string, FiscalDocument>): FiscalProvider {
  return {
    name: 'fixture',
    lookup: async (ref) => {
      const document = documents.get(ref.fiscalId);
      return document ? { status: 'found', document: fiscalDocumentSchema.parse(document), raw: null } : { status: 'not_found' };
    },
  };
}
