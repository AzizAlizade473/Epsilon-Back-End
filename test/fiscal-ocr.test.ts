import { count } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { branches, ledgerEntries, restaurants } from '../src/db/schema.js';
import { geminiImageReader, type GenerateFn } from '../src/fiscal/gemini.js';
import { mergeParts, readOcr, rowsOf, type OcrPage } from '../src/fiscal/ocr.js';
import { sha256 } from '../src/lib/crypto.js';
import { qr } from './fiscal-fixtures.js';
import { setup } from './helpers.js';

/** Build an ML Kit-like page: each row is a list of column texts, laid out left to right. */
const page = (rows: string[][]): OcrPage => ({
  lines: rows.flatMap((cols, r) =>
    cols.map((text, c) => ({ text, box: [20 + c * 260, 40 + r * 34, 20 + c * 260 + 240, 40 + r * 34 + 24] as [number, number, number, number] })),
  ),
});

// Synthetic receipts with real e-kassa layouts. Fiscal IDs and device numbers are made up.
const TAM_ROWS = [
  ['TAM STORE'],
  ['Vergi ödəyicisinin adı: TAM STORE MMC'],
  ['VÖEN: 1506475881'],
  ['Obyektin adı: TAM STORE'],
  ['Obyektin kodu: 1506475881-20001'],
  ['Obyektin ünvanı: AZ1025, Bakı şəhəri, Xətai rayonu'],
  ['Satış çeki № 1421'],
  ['Tarix: 16.11.2026', 'Vaxt: 17:16:02'],
  ['Malın adı', 'Miqdar', 'Qiymət', 'Cəmi'],
  ['COCA COLA ZERO 2LT PET', 'ədəd 1', '2.30', '2.30'],
  ['*ƏDV 18%: 0.35'],
  ['TS MARKET TORBASI ORTA 3 1X60 SM', 'ədəd 1', '0.07', '0.07'],
  ['YEKUN MƏBLƏĞ', '2.37'],
  ['Nağdsız: 2.37'],
  ['NKA-nın modeli: POS CLASS TX-1700M Simple'],
  ['Fiscal ID: TESTFISC0301'],
];

const RESTAURANT_ROWS = [
  ['NARGIZ RESTORAN'],
  ['Vergi ödəyicisinin adı: NARGIZ MMC'],
  ['VÖEN: 1111111111'],
  ['Satış çeki № 77'],
  ['Tarix: 20.11.2026', 'Vaxt: 19:40'],
  ['Məhsulun adı', 'Miqdar', 'Qiymət', 'Toplam'],
  ['#1 TOYUQ ŞİŞ KABAB'],
  ['porsiya', '1', '8,50', '8,50'],
  ['#2 AYRAN 0.5L', '2', '1,50', '3,00'],
  ['#3 PAXLAVA', '1', '2.00', '2.00'],
  ['EV ÜSULU'],
  ['Cəmi', '13.50'],
  ['Fiskal İD: TESTFISC0302'],
];

describe('on-device OCR → receipt (deterministic, no AI)', () => {
  it('rebuilds rows from line positions and reads the TAM STORE layout exactly', () => {
    const rows = rowsOf(page(TAM_ROWS));
    expect(rows[9]).toBe('COCA COLA ZERO 2LT PET  ədəd 1  2.30  2.30');
    const r = readOcr([page(TAM_ROWS)], 'TESTFISC0301');
    expect(r.uncertain).toEqual([]);
    expect(r.printedFiscalId).toBe('TESTFISC0301');
    expect(r.document!.merchant).toMatchObject({ displayName: 'TAM STORE', legalName: 'TAM STORE MMC', voen: '1506475881', objectCode: '1506475881-20001' });
    expect(r.document!.receipt).toMatchObject({ number: '1421', totalMinor: 237, issuedAt: '2026-11-16T17:16:02+04:00' });
    expect(r.document!.receipt.payment.cashlessMinor).toBe(237);
    expect(r.document!.items.map((i) => [i.originalName, i.quantityMilli, i.unitPriceMinor, i.lineTotalMinor, i.unit])).toEqual([
      ['COCA COLA ZERO 2LT PET', 1000, 230, 230, 'ədəd'],
      ['TS MARKET TORBASI ORTA 3 1X60 SM', 1000, 7, 7, 'ədəd'],
    ]);
    expect(r.document!.device.model).toBe('POS CLASS TX-1700M Simple');
  });

  it('handles names above their numbers, wrapped names, comma decimals and multiples', () => {
    const r = readOcr([page(RESTAURANT_ROWS)], 'TESTFISC0302');
    expect(r.uncertain).toEqual([]);
    expect(r.document!.items.map((i) => [i.originalName, i.quantityMilli, i.unitPriceMinor, i.lineTotalMinor])).toEqual([
      ['TOYUQ ŞİŞ KABAB', 1000, 850, 850],
      ['AYRAN 0.5L', 2000, 150, 300],
      ['PAXLAVA EV ÜSULU', 1000, 200, 200],
    ]);
    expect(r.document!.items[0]!.unit).toBe('porsiya');
  });

  it('merges a long receipt photographed in two overlapping parts without double counting', () => {
    const first = TAM_ROWS.slice(0, 11);
    const second = TAM_ROWS.slice(9); // repeats the COCA COLA row and the VAT row
    expect(mergeParts([rowsOf(page(first)), rowsOf(page(second))])).toHaveLength(TAM_ROWS.length);
    const r = readOcr([page(first), page(second)], 'TESTFISC0301');
    expect(r.document!.items).toHaveLength(2);
  });

  it('reports what is missing or inconsistent instead of guessing', () => {
    const noTotal = TAM_ROWS.filter((row) => !row[0]!.startsWith('YEKUN'));
    expect(readOcr([page(noTotal)], 'TESTFISC0301').uncertain).toContain('total');
    const wrongTotal = TAM_ROWS.map((row) => (row[0] === 'YEKUN MƏBLƏĞ' ? ['YEKUN MƏBLƏĞ', '9.99'] : row));
    expect(readOcr([page(wrongTotal)], 'TESTFISC0301').uncertain).toContain('receipt total');
    const splitQuantity = TAM_ROWS.map((row) => (row[0] === 'COCA COLA ZERO 2LT PET' ? ['COCA COLA ZERO 2LT PET', 'ədəd 0.1', '2.30', '2.30'] : row));
    expect(readOcr([page(splitQuantity)], 'TESTFISC0301').uncertain).toContain('line 1 total');
    const noId = TAM_ROWS.filter((row) => !row[0]!.startsWith('Fiscal'));
    expect(readOcr([page(noId)], 'TESTFISC0301').uncertain).toContain('fiscalId');
    expect(readOcr([{ lines: [] }], 'TESTFISC0301').document).toBeNull();
  });
});

const webp = () => {
  const b = Buffer.alloc(100);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUIntLE(799, 24, 3);
  b.writeUIntLE(1199, 27, 3);
  return { mime: 'image/webp', data: b.toString('base64') };
};

async function withReader(enabled: boolean, answer: () => unknown = () => ({})) {
  const base = await setup();
  const calls: number[] = [];
  const generate: GenerateFn = async ({ images }) => (calls.push(images?.length ?? 0), JSON.stringify(answer()));
  const reader = geminiImageReader(
    base.db,
    { GEMINI_ENABLED: enabled, GEMINI_API_KEY: 'test-key-not-real', GEMINI_MODEL: 'mock', GEMINI_MAX_CALLS_PER_DAY: 50, GEMINI_MAX_CALLS_PER_RECEIPT: 1 },
    () => base.clock.now,
    generate,
  );
  const t = await setup({}, { reader });
  const token = (await t.signInPhone('+994501112233')).session.accessToken as string;
  return { t, token, calls };
}

describe('scan pipeline: on-device OCR first, Gemini only as fallback (mocked)', () => {
  it('a clean OCR read needs no AI call and opens the supermarket receipt', async () => {
    const { t, token, calls } = await withReader(true);
    const res = await t.call('POST', '/receipts/fiscal/import', {
      token,
      body: { qr: qr('TESTFISC0301'), source: 'paper_photo', images: [webp()], ocr: [page(TAM_ROWS)] },
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
    expect(res.body.fiscal.verification).toMatchObject({ acquisition: 'printed_receipt_ocr', engine: 'on_device_ocr', status: 'paper_photo' });
    expect(res.body.fiscal.classification.businessType).toBe('supermarket');
    expect(res.body.fiscal.eligibility.ratingAllowed).toBe(false);
  });

  it('a restaurant read by OCR can be rated; the rating is saved; no cashback from a photo', async () => {
    const { t, token } = await withReader(false);
    const res = await t.call('POST', '/receipts/fiscal/import', {
      token,
      body: { qr: qr('TESTFISC0302'), source: 'paper_photo', images: [webp()], ocr: [page(RESTAURANT_ROWS)] },
    });
    expect(res.body.fiscal.classification).toMatchObject({ sector: 'horeca', businessType: 'restaurant' });
    const rated = await t.call('POST', '/feedback', { token, body: { receiptItemId: res.body.items[0].id, rating: 4 } });
    expect(rated.body.reward).toEqual({ status: 'none', amountMinor: null });
    expect((await t.call('GET', `/receipts/${res.body.id}`, { token })).body.items[0].rating).toBe(4);
  });

  it('OCR from a different receipt is rejected', async () => {
    const { t, token } = await withReader(false);
    const res = await t.call('POST', '/receipts/fiscal/import', {
      token,
      body: { qr: qr('ZZZZZZZZ0399'), source: 'paper_photo', images: [webp()], ocr: [page(TAM_ROWS)] },
    });
    expect(res.body.error.code).toBe('RECEIPT_IMAGE_MISMATCH');
  });

  it('incomplete OCR with Gemini off: lists the unreadable parts, stores nothing', async () => {
    const { t, token, calls } = await withReader(false);
    const noTotal = TAM_ROWS.filter((row) => !row[0]!.startsWith('YEKUN'));
    const res = await t.call('POST', '/receipts/fiscal/import', {
      token,
      body: { qr: qr('TESTFISC0301'), source: 'paper_photo', images: [webp()], ocr: [page(noTotal)] },
    });
    expect(res.body.error).toMatchObject({ code: 'RECEIPT_IMAGE_INCOMPLETE', fields: ['total'] });
    expect(calls).toHaveLength(0);
  });

  it('incomplete OCR with Gemini on: one Gemini request completes the receipt', async () => {
    const wire = {
      fiscalId: 'TESTFISC0301', merchantName: 'TAM STORE', legalName: null, voen: '1506475881', objectName: null, objectCode: null, address: null,
      receiptNumber: '1421', date: '16.11.2026', time: '17:16:02', currency: 'AZN', total: '2.37', subtotal: null, discount: null, vat: null,
      cash: null, cashless: null, bonus: null, change: null, deviceModel: null, deviceSerial: null, nmqNumber: null, productSectionComplete: true,
      lines: [
        { printedName: 'COCA COLA ZERO 2LT PET', unit: 'ədəd', quantity: '1', unitPrice: '2.30', lineTotal: '2.30', readable: true },
        { printedName: 'TS MARKET TORBASI ORTA 3 1X60 SM', unit: 'ədəd', quantity: '1', unitPrice: '0.07', lineTotal: '0.07', readable: true },
      ],
      businessType: 'supermarket', businessEvidence: ['name'],
    };
    const { t, token, calls } = await withReader(true, () => wire);
    const noTotal = TAM_ROWS.filter((row) => !row[0]!.startsWith('YEKUN'));
    const res = await t.call('POST', '/receipts/fiscal/import', {
      token,
      body: { qr: qr('TESTFISC0301'), source: 'paper_photo', images: [webp()], ocr: [page(noTotal)] },
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([1]);
    expect(res.body.fiscal.verification.engine).toBe('gemini');
  });
});

describe('partner POS: QR-only receipts with verified status', () => {
  const posReceipt = (fiscalId: string, voen = '3333333333') => ({
    merchant: { displayName: 'DOLMA HOUSE', legalName: 'DOLMA HOUSE MMC', voen, objectName: null, objectCode: '3333333333-20001', address: null, city: null },
    receipt: {
      fiscalId, number: '501', documentId: null, type: 'sale', issuedAt: '2026-11-20T20:00:00+04:00', currency: 'AZN', totalMinor: 1800,
      subtotalMinor: null, discountMinor: null, vatMinor: null, vatBreakdown: [],
      payment: { method: 'cashless', cashMinor: null, cashlessMinor: 1800, bonusMinor: null, changeMinor: null },
    },
    items: [
      { lineNo: 1, originalName: 'YARPAQ DOLMASI', normalizedName: 'YARPAQ DOLMASI', quantityMilli: 1000, unit: 'porsiya', unitPriceMinor: 1200, lineTotalMinor: 1200, discountMinor: null, vatRatePercent: null, vatMinor: null },
      { lineNo: 2, originalName: 'ŞORBA', normalizedName: 'ŞORBA', quantityMilli: 1000, unit: 'porsiya', unitPriceMinor: 600, lineTotalMinor: 600, discountMinor: null, vatRatePercent: null, vatMinor: null },
    ],
    device: { model: null, serialNumber: null, nmqRegistrationNumber: null },
    additionalFields: { cashierName: 'must be dropped', table: '12' },
  });
  const KEY = 'test-partner-key-0123456789abcdefghijklmnop';

  it('stores partner receipts idempotently and lets customers open them from the QR alone, with cashback', async () => {
    const t = await setup();
    const [r] = await t.db.insert(restaurants).values({ name: 'Dolma House', cashbackBps: 250, voen: '3333333333', posKeyHash: sha256(KEY) }).returning();
    await t.db.insert(branches).values({ restaurantId: r!.id, name: 'Nizami', objectCode: '3333333333-20001' });
    const send = (body: unknown, key = KEY) =>
      t.app.inject({ method: 'POST', url: '/v1/partner/receipts', headers: { 'x-partner-key': key }, payload: body as object });

    expect((await send(posReceipt('TESTFISC0401'), 'wrong-key-0123456789abcdefghijklmnopq')).statusCode).toBe(401);
    expect((await send(posReceipt('TESTFISC0401'))).statusCode).toBe(201);
    expect((await send(posReceipt('TESTFISC0401'))).statusCode).toBe(200); // retry: stored once
    expect((await send(posReceipt('TESTFISC0402', '9999999999'))).statusCode).toBe(403); // another taxpayer

    const token = (await t.signInPhone('+994501112233')).session.accessToken as string;
    const scan = await t.call('POST', '/receipts/resolve', { token, body: { kind: 'qr', value: qr('TESTFISC0401') } });
    expect(scan.status).toBe(200);
    expect(scan.body.fiscal.verification).toMatchObject({ status: 'verified', acquisition: 'partner_pos_verified', engine: 'structured' });
    expect(scan.body.fiscal.eligibility).toEqual({ ratingAllowed: true, cashbackAllowed: true, reason: null });
    expect(scan.body.fiscal.additionalFields).toEqual({ table: '12' });
    const rated = await t.call('POST', '/feedback', { token, body: { receiptItemId: scan.body.items[0].id, rating: 5 } });
    expect(rated.body.reward).toEqual({ status: 'confirmed', amountMinor: 30 });
    expect((await t.db.select({ n: count() }).from(ledgerEntries))[0]!.n).toBe(1);
  });
});
