import { count } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { branches, ledgerEntries, restaurants } from '../src/db/schema.js';
import { geminiImageReader, parseDecimal, parseIssuedAt, type GenerateFn, type WireReceipt } from '../src/fiscal/gemini.js';
import { qr } from './fiscal-fixtures.js';
import { setup } from './helpers.js';

/** What a correct Gemini transcription of the TAM STORE receipt looks like (mocked: no live calls). */
const tamWire = (over: Partial<WireReceipt> = {}): WireReceipt => ({
  fiscalId: 'TESTFISC0201',
  merchantName: 'TAM STORE',
  legalName: 'TAM STORE MMC',
  voen: '1506475881',
  objectName: null,
  objectCode: '1506475881-20001',
  address: 'AZ1025, Bakı şəhəri, Xətai rayonu, Həsən Salmanı, ev 1, 1-ci mərtəbə, qapı 11',
  receiptNumber: '1421',
  date: '16.11.2026',
  time: '17:16:02',
  currency: 'AZN',
  total: '2.37',
  subtotal: null,
  discount: '0.00',
  vat: '0.36',
  cash: '0.00',
  cashless: '2.37',
  bonus: '0.00',
  change: null,
  deviceModel: 'POS CLASS TX-1700M Simple',
  deviceSerial: null,
  nmqNumber: null,
  productSectionComplete: true,
  lines: [
    { printedName: 'COCA COLA ZERO 2LT PET', unit: 'ədəd', quantity: '1', unitPrice: '2.30', lineTotal: '2.30', readable: true },
    { printedName: 'TS MARKET TORBASI ORTA 3 1X60 SM', unit: 'ədəd', quantity: '1', unitPrice: '0.07', lineTotal: '0.07', readable: true },
  ],
  businessType: 'supermarket',
  businessEvidence: ['name TAM STORE'],
  ...over,
});
const restaurantWire = (fiscalId: string, over: Partial<WireReceipt> = {}): WireReceipt =>
  tamWire({
    fiscalId,
    merchantName: 'DOLMA HOUSE',
    legalName: 'DOLMA HOUSE MMC',
    voen: '3333333333',
    objectCode: '3333333333-20001',
    total: '18.00',
    vat: null,
    cashless: '18.00',
    lines: [
      { printedName: 'YARPAQ DOLMASI', unit: 'porsiya', quantity: '1', unitPrice: '12.00', lineTotal: '12.00', readable: true },
      { printedName: 'ŞORBA', unit: 'porsiya', quantity: '1', unitPrice: '6.00', lineTotal: '6.00', readable: true },
    ],
    businessType: 'restaurant',
    ...over,
  });

const LONG_ID = 'TESTFISC0201a1B2c3D4e5F6g7H8j9K1m2N3p4Q5r6S7'; // synthetic long-form code (same shape as real ones)
const webp = () => {
  const b = Buffer.alloc(100);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUIntLE(799, 24, 3);
  b.writeUIntLE(1199, 27, 3);
  return { mime: 'image/webp', data: b.toString('base64') };
};

function mocked(answers: (() => unknown)[]) {
  const calls: number[] = [];
  const generate: GenerateFn = async ({ images }) => {
    calls.push(images?.length ?? 0);
    const next = answers.shift();
    const value = next ? next() : tamWire();
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
  return { generate, calls };
}

async function env(answers: (() => unknown)[], cfg: Partial<{ enabled: boolean; perDay: number }> = {}) {
  const t = await setup();
  const m = mocked(answers);
  const reader = geminiImageReader(
    t.db,
    { GEMINI_ENABLED: cfg.enabled ?? true, GEMINI_API_KEY: 'test-key-not-real', GEMINI_MODEL: 'mock', GEMINI_MAX_CALLS_PER_DAY: cfg.perDay ?? 50, GEMINI_MAX_CALLS_PER_RECEIPT: 1 },
    () => t.clock.now,
    m.generate,
  );
  const t2 = await setup({}, { reader });
  return { t: t2, calls: m.calls };
}

const imp = (t: Awaited<ReturnType<typeof setup>>, token: string, fiscalId: string, source = 'official_page', images = [webp()]) =>
  t.call('POST', '/receipts/fiscal/import', { token, body: { qr: qr(fiscalId), source, images } });

describe('importing a receipt image (customer-assisted, mocked Gemini)', () => {
  it('reads the TAM STORE image into the full receipt: supermarket, ratings off, labelled as customer image', async () => {
    const { t, calls } = await env([() => tamWire()]);
    const a = (await t.signInPhone('+994501112233')).session.accessToken as string;
    const res = await imp(t, a, LONG_ID); // long QR form maps to the 12-char Fiscal ID
    expect(res.status).toBe(200);
    const f = res.body.fiscal;
    expect(f.verification.status).toBe('official_image');
    expect(f.classification).toMatchObject({ sector: 'retail', businessType: 'supermarket', method: 'name_rule' });
    expect(f.eligibility).toEqual({ ratingAllowed: false, cashbackAllowed: false, reason: 'UNSUPPORTED_MERCHANT_CATEGORY' });
    expect(f.merchant).toMatchObject({ displayName: 'TAM STORE', voen: '1506475881', objectCode: '1506475881-20001' });
    expect(f.receipt).toMatchObject({ fiscalId: 'TESTFISC0201', number: '1421', totalMinor: 237, vatMinor: 36, issuedAt: '2026-11-16T17:16:02+04:00' });
    expect(res.body.items.map((i: { name: string; unitPriceMinor: number }) => [i.name, i.unitPriceMinor])).toEqual([
      ['COCA COLA ZERO 2LT PET', 230],
      ['TS MARKET TORBASI ORTA 3 1X60 SM', 7],
    ]);
    expect(calls).toEqual([1]);

    // A second customer scanning the same receipt reuses it: no new AI call.
    const b = (await t.signInPhone('+994507776655')).session.accessToken as string;
    expect((await imp(t, b, 'TESTFISC0201')).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('restaurant photo: dishes can be rated, cashback stays off without official verification', async () => {
    const { t } = await env([() => restaurantWire('TESTFISC0104')]);
    const [r] = await t.db.insert(restaurants).values({ name: 'Dolma House', cashbackBps: 250, voen: '3333333333' }).returning();
    await t.db.insert(branches).values({ restaurantId: r!.id, name: 'Nizami', objectCode: '3333333333-20001' });
    const a = (await t.signInPhone('+994501112233')).session.accessToken as string;
    const res = await imp(t, a, 'TESTFISC0104', 'paper_photo');
    expect(res.body.fiscal.verification.status).toBe('paper_photo');
    expect(res.body.fiscal.classification.method).toBe('epsilon_partner');
    expect(res.body.fiscal.eligibility).toEqual({ ratingAllowed: true, cashbackAllowed: false, reason: 'VERIFICATION_REQUIRED' });
    expect(res.body.rewardHint).toBeUndefined();
    const rated = await t.call('POST', '/feedback', { token: a, body: { receiptItemId: res.body.items[0].id, rating: 5 } });
    expect(rated.status).toBe(200);
    expect(rated.body.reward).toEqual({ status: 'none', amountMinor: null });
    expect((await t.db.select({ n: count() }).from(ledgerEntries))[0]!.n).toBe(0);
  });

  it('uses the reader\'s sector suggestion only when no partner, cache or name rule applies (no extra call)', async () => {
    const { t, calls } = await env([() => restaurantWire('TESTFISC0105', { merchantName: 'XYZ MMC', legalName: null, voen: '7777777777', objectCode: null, businessType: 'cafe' })]);
    const a = (await t.signInPhone('+994501112233')).session.accessToken as string;
    const f = (await imp(t, a, 'TESTFISC0105')).body.fiscal;
    expect(f.classification).toMatchObject({ businessType: 'cafe', method: 'ai_assisted', status: 'ai' });
    expect(f.eligibility.reason).toBe('NOT_EPSILON_PARTNER');
    expect(calls).toHaveLength(1);
  });
});

describe('never inventing data', () => {
  it('rejects an image of a different receipt, or one without a visible Fiscal ID', async () => {
    const { t } = await env([() => tamWire({ fiscalId: 'ZZZZZZZZZZZZ' }), () => tamWire({ fiscalId: null })]);
    const a = (await t.signInPhone('+994501112233')).session.accessToken as string;
    expect((await imp(t, a, 'TESTFISC0201')).body.error.code).toBe('RECEIPT_IMAGE_MISMATCH');
    const missing = await imp(t, a, 'TESTFISC0201');
    expect(missing.body.error).toMatchObject({ code: 'RECEIPT_IMAGE_INCOMPLETE', fields: ['fiscalId'] });
  });

  it('reports exactly which parts could not be read and stores nothing', async () => {
    const lines = tamWire().lines;
    const { t } = await env([
      () => tamWire({ lines: [lines[0]!, { ...lines[1]!, readable: false }] }),
      () => tamWire({ total: null, date: null }),
      () => tamWire({ total: '9.99' }),
    ]);
    const a = (await t.signInPhone('+994501112233')).session.accessToken as string;
    expect((await imp(t, a, 'TESTFISC0201')).body.error.fields).toEqual(['line 2']);
    expect((await imp(t, a, 'TESTFISC0201')).body.error.fields).toEqual(['total', 'date']);
    expect((await imp(t, a, 'TESTFISC0201')).body.error.fields).toEqual(['receipt total']);
    expect((await t.call('GET', '/receipts', { token: a })).body.items).toEqual([]);
  });
});

describe('quota protection and failures (mocked)', () => {
  it('makes no call when reading is disabled', async () => {
    const { t, calls } = await env([], { enabled: false });
    const a = (await t.signInPhone('+994501112233')).session.accessToken as string;
    expect((await imp(t, a, 'TESTFISC0201')).body.error.code).toBe('RECEIPT_READER_UNAVAILABLE');
    expect(calls).toHaveLength(0);
  });

  it('stops at the daily cap, maps Google quota errors, and survives malformed output', async () => {
    const quota = Object.assign(new Error('quota'), { status: 429 });
    const { t, calls } = await env([() => 'not json', () => { throw quota; }], { perDay: 2 });
    const a = (await t.signInPhone('+994501112233')).session.accessToken as string;
    expect((await imp(t, a, 'TESTFISC0201')).body.error.code).toBe('RECEIPT_READER_UNAVAILABLE'); // bad JSON
    expect((await imp(t, a, 'TESTFISC0201')).status).toBe(503); // generic failure path for thrown non-API error
    expect((await imp(t, a, 'TESTFISC0201')).body.error.code).toBe('RECEIPT_READER_QUOTA'); // app cap reached
    expect(calls).toHaveLength(2);
  });

  it('validates the uploaded image and the QR before any AI call', async () => {
    const { t, calls } = await env([]);
    const a = (await t.signInPhone('+994501112233')).session.accessToken as string;
    expect((await imp(t, a, 'TESTFISC0201', 'official_page', [{ mime: 'image/png', data: 'A'.repeat(200) }])).status).toBe(422);
    const notFiscal = await t.call('POST', '/receipts/fiscal/import', { token: a, body: { qr: 'DEMO-0001', source: 'paper_photo', images: [webp()] } });
    expect(notFiscal.body.error.code).toBe('RECEIPT_UNSUPPORTED');
    expect(calls).toHaveLength(0);
  });
});

describe('decimal-safe parsing', () => {
  it.each([
    ['2.30', 2, 230],
    ['0,07', 2, 7],
    ['0.175', 3, 175],
    ['-0.20', 2, -20],
  ])('%j → %i', (raw, scale, out) => expect(parseDecimal(raw, scale)).toBe(out));
  it.each([['2 00'], ['1.234'], ['abc'], [null]])('refuses %j', (raw) => expect(parseDecimal(raw, 2)).toBeNull());
  it('reads printed dates as UTC+4', () => expect(parseIssuedAt('16.11.2026', '17:16:02')).toBe('2026-11-16T17:16:02+04:00'));
});
