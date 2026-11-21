import { describe, expect, it } from 'vitest';

import { classifyByName, foldUpper } from '../src/fiscal/classify.js';
import { fiscalDocumentSchema, integrityProblems, withoutPersonal } from '../src/fiscal/document.js';
import { advisorInput, geminiAdvisor, type GenerateFn } from '../src/fiscal/gemini.js';
import { MAX_QR_LENGTH, parseFiscalQr, QrError } from '../src/fiscal/qr.js';
import { CAFE, NON_PARTNER_RESTAURANT, PHARMACY, TAM_STORE, UNKNOWN_BUSINESS, WEIGHED } from './fiscal-fixtures.js';
import { setup } from './helpers.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof QrError ? e.code : 'OTHER';
  }
  return 'NONE';
};

describe('fiscal QR (untrusted input, parsed never fetched)', () => {
  it('reads the 12-char Fiscal ID from the doc parameter inside the URL fragment', () => {
    expect(parseFiscalQr('https://monitoring.e-kassa.gov.az/#/index?doc=TESTFISC0001')).toEqual({ issuer: 'e-kassa', fiscalId: 'TESTFISC0001' });
  });

  it('accepts the 44-char long form with NUL padding (as printed by some registers)', () => {
    const long = 'TESTFISC0001' + 'a1B2c3D4e5F6g7H8j9K1m2N3p4Q5r6S7';
    expect(parseFiscalQr(`https://monitoring.e-kassa.gov.az/#/index?doc=${long}\u0000`)?.fiscalId).toBe('TESTFISC0001');
  });

  it('treats non-link text as an Epsilon purchase code', () => expect(parseFiscalQr('DEMO-0001')).toBeNull());

  it.each([
    ['', 'QR_EMPTY'],
    ['x'.repeat(MAX_QR_LENGTH + 1), 'QR_TOO_LONG'],
    ['https://monitoring.e-kassa.gov.az/?doc=TEST\u0000FISC0001', 'QR_MALFORMED'],
    ['http://monitoring.e-kassa.gov.az/#/index?doc=TESTFISC0001', 'QR_HOST_NOT_ALLOWED'],
    ['https://evil.example/#/index?doc=TESTFISC0001', 'QR_HOST_NOT_ALLOWED'],
    ['https://monitoring.e-kassa.gov.az.evil.example/#/index?doc=TESTFISC0001', 'QR_HOST_NOT_ALLOWED'],
    ['https://user:pw@monitoring.e-kassa.gov.az/#/index?doc=TESTFISC0001', 'QR_HOST_NOT_ALLOWED'],
    ['https://monitoring.e-kassa.gov.az:8443/#/index?doc=TESTFISC0001', 'QR_HOST_NOT_ALLOWED'],
    ['https://169.254.169.254/latest/meta-data/', 'QR_HOST_NOT_ALLOWED'],
    ['https://127.0.0.1/#/index?doc=TESTFISC0001', 'QR_HOST_NOT_ALLOWED'],
    ['file:///etc/passwd', 'QR_HOST_NOT_ALLOWED'],
    ['https://monitoring.e-kassa.gov.az/#/index', 'QR_NO_FISCAL_ID'],
    ['https://monitoring.e-kassa.gov.az/#/index?doc=short', 'QR_NO_FISCAL_ID'],
    ['https://monitoring.e-kassa.gov.az/#/index?doc=../../etc/passwd', 'QR_NO_FISCAL_ID'],
  ])('rejects %j as %s', (input, expected) => expect(code(() => parseFiscalQr(input))).toBe(expected));
});

describe('normalized receipt document', () => {
  it('validates every fixture and keeps missing fields as null', () => {
    for (const doc of [TAM_STORE, NON_PARTNER_RESTAURANT, WEIGHED]) expect(fiscalDocumentSchema.safeParse(doc).success).toBe(true);
    expect(TAM_STORE.merchant.objectName).toBeNull();
    expect(TAM_STORE.items[0]!.vatRatePercent).toBeNull();
  });

  it('accepts consistent receipts (incl. weighed lines and a printed discount) and flags inconsistent ones', () => {
    expect(integrityProblems(TAM_STORE)).toEqual([]);
    expect(integrityProblems(WEIGHED)).toEqual([]);
    const badTotal = { ...TAM_STORE, receipt: { ...TAM_STORE.receipt, totalMinor: 999 } };
    expect(integrityProblems(badTotal)).toContain('receipt total');
    const badLine = { ...TAM_STORE, items: [{ ...TAM_STORE.items[0]!, lineTotalMinor: 500 }, TAM_STORE.items[1]!] };
    expect(integrityProblems(badLine)).toContain('line 1 total');
  });

  it('removes personal fields such as the cashier from provider extras', () => {
    expect(withoutPersonal({ cashierName: 'X', kassir: 'Y', zNumber: 2, shift: 'A' })).toEqual({ zNumber: 2, shift: 'A' });
  });
});

describe('business sector from merchant identity (deterministic)', () => {
  it('classifies by business name, never by products', () => {
    expect(classifyByName(TAM_STORE)?.type).toBe('supermarket');
    expect(classifyByName(NON_PARTNER_RESTAURANT)?.type).toBe('restaurant');
    expect(classifyByName(CAFE)?.type).toBe('cafe');
    expect(classifyByName(PHARMACY)?.type).toBe('pharmacy');
    expect(classifyByName(UNKNOWN_BUSINESS)).toBeNull();
    // Coffee sold at a supermarket does not make it a coffee shop.
    const withCoffee = { ...TAM_STORE, items: [{ ...TAM_STORE.items[0]!, originalName: 'COFFEE LATTE' }] };
    expect(classifyByName(withCoffee)?.type).toBe('supermarket');
  });

  it('refuses to guess when the business names disagree', () => {
    const mixed = { ...TAM_STORE, merchant: { ...TAM_STORE.merchant, displayName: 'TAM STORE', legalName: 'NUR RESTORAN MMC' } };
    expect(classifyByName(mixed)).toBeNull();
  });

  it('folds Azerbaijani letters for matching', () => expect(foldUpper('Şəhər Kafesi')).toBe('SEHER KAFESI'));
});

describe('Gemini advisor (mocked: no live calls in tests)', () => {
  const answer = (type: string) => JSON.stringify({ businessType: type, evidence: ['name says so'] });
  const counted = (impl: () => Promise<string>) => {
    const calls: Parameters<GenerateFn>[0][] = [];
    const fn: GenerateFn = async (args) => {
      calls.push(args);
      return impl();
    };
    return { fn, calls };
  };
  const cfg = { GEMINI_ENABLED: true, GEMINI_API_KEY: 'test-key-not-real', GEMINI_MODEL: 'test-model', GEMINI_MAX_CALLS_PER_DAY: 2 };

  it('makes no call when disabled or without a key', async () => {
    const t = await setup();
    const g = counted(async () => answer('cafe'));
    expect(await geminiAdvisor(t.db, { ...cfg, GEMINI_ENABLED: false }, () => t.clock.now, g.fn).suggest(UNKNOWN_BUSINESS)).toBeNull();
    expect(await geminiAdvisor(t.db, { ...cfg, GEMINI_API_KEY: undefined }, () => t.clock.now, g.fn).suggest(UNKNOWN_BUSINESS)).toBeNull();
    expect(g.calls).toHaveLength(0);
  });

  it('returns a validated suggestion, sends no personal data, and stops at the daily cap', async () => {
    const t = await setup();
    const g = counted(async () => answer('coffee_shop'));
    const advisor = geminiAdvisor(t.db, cfg, () => t.clock.now, g.fn);
    expect(await advisor.suggest(UNKNOWN_BUSINESS)).toEqual({ type: 'coffee_shop', evidence: ['name says so'] });
    expect(g.calls[0]!.prompt).not.toMatch(/fiscalId|TESTFISC|cashier/i);
    expect(Object.keys(advisorInput(UNKNOWN_BUSINESS))).toEqual(['merchantName', 'legalName', 'establishmentName', 'city', 'sampleProducts']);
    await advisor.suggest(UNKNOWN_BUSINESS);
    expect(await advisor.suggest(UNKNOWN_BUSINESS)).toBeNull(); // third call today: capped, not sent
    expect(g.calls).toHaveLength(2);
    t.advance(24 * 3600 * 1000);
    await advisor.suggest(UNKNOWN_BUSINESS);
    expect(g.calls).toHaveLength(3); // new day, new budget
  });

  it('falls back to unknown on quota errors, outages, invalid or "unknown" answers', async () => {
    const t = await setup({}, {});
    const quota = Object.assign(new Error('quota'), { status: 429 });
    for (const impl of [
      async () => Promise.reject(quota),
      async () => Promise.reject(new Error('down')),
      async () => 'not json',
      async () => JSON.stringify({ businessType: 'casino', evidence: ['x'] }),
      async () => answer('unknown'),
    ]) {
      const advisor = geminiAdvisor(t.db, { ...cfg, GEMINI_MAX_CALLS_PER_DAY: 100 }, () => t.clock.now, impl);
      expect(await advisor.suggest(UNKNOWN_BUSINESS)).toBeNull();
    }
  });
});
