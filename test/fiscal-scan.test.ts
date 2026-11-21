import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { branches, fiscalReceipts, ledgerEntries, purchases, restaurants } from '../src/db/schema.js';
import type { SectorAdvisor } from '../src/fiscal/classify.js';
import { fixtureProvider, type FiscalProvider } from '../src/fiscal/provider.js';
import { ALL, CAFE, NON_PARTNER_RESTAURANT, PARTNER_RESTAURANT, PHARMACY, TAM_STORE, UNKNOWN_BUSINESS, WEIGHED, qr } from './fiscal-fixtures.js';
import { setup } from './helpers.js';

const provider = () => fixtureProvider(new Map(ALL.map((d) => [d.receipt.fiscalId, d])));
type T = Awaited<ReturnType<typeof setup>>;

async function partner(t: T, bps = 250) {
  const [r] = await t.db.insert(restaurants).values({ name: 'Dolma House', cashbackBps: bps, voen: '3333333333' }).returning();
  await t.db.insert(branches).values({ restaurantId: r!.id, name: 'Nizami', objectCode: '3333333333-20001' });
}

/** Phone sign-in leaves the phone verified, so partner cashback is reachable. */
const signIn = async (t: T, phone: string) => (await t.signInPhone(phone)).session.accessToken as string;
const scan = (t: T, token: string, fiscalId: string, key?: string) =>
  t.call('POST', '/receipts/resolve', { token, key, body: { kind: 'qr', value: qr(fiscalId) } });
const rate = (t: T, token: string, receiptItemId: string, rating = 5) =>
  t.call('POST', '/feedback', { token, body: { receiptItemId, rating } });

describe('supermarket receipt (TAM STORE)', () => {
  it('returns the full receipt with sector, but ratings and cashback disabled', async () => {
    const t = await setup({}, { fiscal: provider() });
    const a = await signIn(t, '+994501112233');
    const res = await scan(t, a, 'TESTFISC0001');
    expect(res.status).toBe(200);
    const f = res.body.fiscal;
    expect(f.verification.status).toBe('test_data'); // fixtures are never shown as government-verified
    expect(f.classification).toMatchObject({ sector: 'retail', businessType: 'supermarket', method: 'name_rule' });
    expect(f.eligibility).toEqual({ ratingAllowed: false, cashbackAllowed: false, reason: 'UNSUPPORTED_MERCHANT_CATEGORY' });
    expect(f.merchant).toMatchObject({ displayName: 'TAM STORE', legalName: 'TAM STORE MMC', voen: '1506475881', objectCode: '1506475881-20001' });
    expect(f.receipt).toMatchObject({ number: '1421', totalMinor: 237, vatMinor: 36, currency: 'AZN', issuedAt: '2026-11-16T17:16:02+04:00' });
    expect(res.body.restaurant.name).toBe('TAM STORE');
    // Product names and prices exactly as printed.
    expect(res.body.items.map((i: { name: string; unitPriceMinor: number; canRate: boolean }) => [i.name, i.unitPriceMinor, i.canRate])).toEqual([
      ['COCA COLA ZERO 2LT PET', 230, false],
      ['TS MARKET TORBASI ORTA 3 1X60 SM', 7, false],
    ]);
    expect(res.body.rewardHint).toBeUndefined();
    const refused = await rate(t, a, res.body.items[0].id);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('RECEIPT_UNSUPPORTED');
  });

  it('classifies a pharmacy as unsupported and an unknown business as unverified, without guessing', async () => {
    const t = await setup({}, { fiscal: provider() });
    const a = await signIn(t, '+994501112233');
    expect((await scan(t, a, PHARMACY.receipt.fiscalId)).body.fiscal.classification.businessType).toBe('pharmacy');
    const unknown = (await scan(t, a, UNKNOWN_BUSINESS.receipt.fiscalId)).body.fiscal;
    expect(unknown.classification).toMatchObject({ sector: 'unknown', businessType: 'unknown', status: 'unverified' });
    expect(unknown.eligibility.reason).toBe('MERCHANT_CATEGORY_UNKNOWN');
  });
});

describe('HoReCa receipts', () => {
  it('non-partner restaurant: ratings saved, no cashback', async () => {
    const t = await setup({}, { fiscal: provider() });
    const a = await signIn(t, '+994501112233');
    const res = await scan(t, a, NON_PARTNER_RESTAURANT.receipt.fiscalId);
    expect(res.body.fiscal.eligibility).toEqual({ ratingAllowed: true, cashbackAllowed: false, reason: 'NOT_EPSILON_PARTNER' });
    expect(res.body.items.every((i: { canRate: boolean }) => i.canRate)).toBe(true);
    const r = await rate(t, a, res.body.items[0].id, 4);
    expect(r.status).toBe(200);
    expect(r.body.reward).toEqual({ status: 'none', amountMinor: null });
    const again = await t.call('GET', `/receipts/${res.body.id}`, { token: a });
    expect(again.body.items[0].rating).toBe(4);
    expect((await t.db.select({ n: count() }).from(ledgerEntries))[0]!.n).toBe(0);
  });

  it('café is HoReCa and can be rated', async () => {
    const t = await setup({}, { fiscal: provider() });
    const a = await signIn(t, '+994501112233');
    const f = (await scan(t, a, CAFE.receipt.fiscalId)).body.fiscal;
    expect(f.classification).toMatchObject({ sector: 'horeca', businessType: 'cafe' });
    expect(f.eligibility.ratingAllowed).toBe(true);
  });

  it('partner restaurant: cashback once per line, several users may rate the same receipt', async () => {
    const t = await setup({}, { fiscal: provider() });
    await partner(t, 250);
    const a = await signIn(t, '+994501112233');
    const b = await signIn(t, '+994507776655');
    const ra = await scan(t, a, PARTNER_RESTAURANT.receipt.fiscalId);
    expect(ra.body.fiscal.classification.method).toBe('epsilon_partner');
    expect(ra.body.fiscal.partner.isPartner).toBe(true);
    expect(ra.body.fiscal.eligibility).toEqual({ ratingAllowed: true, cashbackAllowed: true, reason: null });
    expect(ra.body.restaurant.name).toBe('Dolma House');
    expect(ra.body.rewardHint).toEqual({ amountMinor: 30 + 15, currency: 'AZN' }); // 2.5 % of 12.00 + 6.00

    const rb = await scan(t, b, PARTNER_RESTAURANT.receipt.fiscalId);
    expect(rb.body.id).not.toBe(ra.body.id); // each user has their own copy

    // Both users rate line 1 at the same time: exactly one cashback.
    const [x, y] = await Promise.all([rate(t, a, ra.body.items[0].id), rate(t, b, rb.body.items[0].id)]);
    expect([x.status, y.status]).toEqual([200, 200]);
    const amounts = [x.body.reward.amountMinor, y.body.reward.amountMinor].sort();
    expect(amounts).toEqual([30, null].sort());
    expect((await t.db.select({ n: count() }).from(ledgerEntries))[0]!.n).toBe(1);

    // The line now shows as claimed for the other user; line 2 still pays.
    const view = await t.call('GET', `/receipts/${rb.body.id}`, { token: b });
    expect(view.body.items[0].line.cashbackClaimed).toBe(true);
    const second = await rate(t, b, rb.body.items[1].id);
    expect(second.body.reward.amountMinor).toBe(15);
    // Same user cannot rate the same line twice.
    expect((await rate(t, b, rb.body.items[1].id)).status).toBe(409);
    // The cashback shows in the existing wallet.
    const winner = x.body.reward.amountMinor ? a : b;
    const wallet = await t.call('GET', '/wallet/transactions', { token: winner });
    expect(wallet.status).toBe(200);
    expect(wallet.body.items[0].source.restaurantName).toBe('Dolma House');
  });

  it('keeps weighed quantities and printed discounts exact', async () => {
    const t = await setup({}, { fiscal: provider() });
    const a = await signIn(t, '+994501112233');
    const res = await scan(t, a, WEIGHED.receipt.fiscalId);
    expect(res.body.items[0].line).toMatchObject({ quantityMilli: 370, unit: 'kq', unitPriceMinor: 219, lineTotalMinor: 81 });
    expect(res.body.items[0]).toMatchObject({ quantity: 1, unitPriceMinor: 81 });
    expect(res.body.fiscal.receipt).toMatchObject({ totalMinor: 171, discountMinor: 10 });
  });
});

describe('duplicates, retries and failures', () => {
  it('rescans return the same receipt; concurrent scans create one copy; idempotent retry replays', async () => {
    const t = await setup({}, { fiscal: provider() });
    const a = await signIn(t, '+994501112233');
    const all = await Promise.all(Array.from({ length: 8 }, () => scan(t, a, NON_PARTNER_RESTAURANT.receipt.fiscalId)));
    expect(new Set(all.map((r) => r.body.id)).size).toBe(1);
    expect((await t.db.select({ n: count() }).from(purchases))[0]!.n).toBe(1);
    expect((await t.db.select({ n: count() }).from(fiscalReceipts))[0]!.n).toBe(1);
    const one = await scan(t, a, CAFE.receipt.fiscalId, 'same-key');
    const two = await scan(t, a, CAFE.receipt.fiscalId, 'same-key');
    expect(two.body).toEqual(one.body);
    const list = await t.call('GET', '/receipts', { token: a });
    expect(list.body.items).toHaveLength(2);
  });

  it('retrieves a fiscal receipt from the provider only once', async () => {
    let lookups = 0;
    const inner = provider();
    const counting: FiscalProvider = { name: 'fixture', lookup: (ref, s) => (lookups++, inner.lookup(ref, s)) };
    const t = await setup({}, { fiscal: counting });
    const a = await signIn(t, '+994501112233');
    const b = await signIn(t, '+994507776655');
    await scan(t, a, TAM_STORE.receipt.fiscalId);
    await scan(t, b, TAM_STORE.receipt.fiscalId);
    expect(lookups).toBe(1);
  });

  it('typed errors: invalid QR, not found, service unavailable (no data invented), inconsistent data', async () => {
    const down: FiscalProvider = { name: 'live', lookup: async () => ({ status: 'unavailable' }) };
    const t = await setup({}, { fiscal: down });
    const a = await signIn(t, '+994501112233');
    const bad = await t.call('POST', '/receipts/resolve', { token: a, body: { kind: 'qr', value: 'https://evil.example/#/index?doc=TESTFISC0001' } });
    expect(bad.body.error.code).toBe('RECEIPT_UNSUPPORTED');
    const unavailable = await scan(t, a, 'TESTFISC0001');
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error.code).toBe('RECEIPT_SOURCE_UNAVAILABLE');
    expect((await t.db.select({ n: count() }).from(fiscalReceipts))[0]!.n).toBe(0);

    const broken = { ...TAM_STORE, receipt: { ...TAM_STORE.receipt, totalMinor: 999 } };
    const t2 = await setup({}, { fiscal: fixtureProvider(new Map([['TESTFISC0001', broken]])) });
    const a2 = await signIn(t2, '+994501112233');
    expect((await scan(t2, a2, 'TESTFISC0001')).body.error.code).toBe('RECEIPT_VERIFICATION_FAILED');
    expect((await scan(t2, a2, 'TESTFISC0099')).body.error.code).toBe('RECEIPT_NOT_FOUND');
  });

  it('defaults to "unavailable" when no provider is configured (production today)', async () => {
    const t = await setup();
    const a = await signIn(t, '+994501112233');
    expect((await scan(t, a, 'TESTFISC0001')).body.error.code).toBe('RECEIPT_SOURCE_UNAVAILABLE');
  });
});

describe('AI-assisted classification and caching', () => {
  it('asks the advisor only for unknown merchants, caches per establishment, never for partners or rule hits', async () => {
    const asked: string[] = [];
    const advisor: SectorAdvisor = {
      suggest: async (doc) => (asked.push(doc.merchant.displayName), { type: 'coffee_shop', evidence: ['mock answer'] }),
    };
    const t = await setup({}, { fiscal: provider(), advisor });
    await partner(t);
    const a = await signIn(t, '+994501112233');
    await scan(t, a, TAM_STORE.receipt.fiscalId); // name rule
    await scan(t, a, PARTNER_RESTAURANT.receipt.fiscalId); // partner
    const unknown = (await scan(t, a, UNKNOWN_BUSINESS.receipt.fiscalId)).body.fiscal.classification;
    expect(unknown).toMatchObject({ businessType: 'coffee_shop', method: 'ai_assisted', status: 'ai' });
    expect(asked).toEqual(['XYZ MMC']);
    // A second receipt from the same establishment reuses the cached decision.
    const again = { ...UNKNOWN_BUSINESS, receipt: { ...UNKNOWN_BUSINESS.receipt, fiscalId: 'TESTFISC0008' } };
    const t2 = await setup({}, { fiscal: fixtureProvider(new Map([['TESTFISC0005', UNKNOWN_BUSINESS], ['TESTFISC0008', again]])), advisor });
    asked.length = 0;
    const a2 = await signIn(t2, '+994501112233');
    await scan(t2, a2, 'TESTFISC0005');
    expect((await scan(t2, a2, 'TESTFISC0008')).body.fiscal.classification.method).toBe('cache');
    expect(asked).toHaveLength(1);
  });

  it('partner identity beats AI and name rules', async () => {
    const t = await setup({}, { fiscal: provider() });
    await partner(t);
    const a = await signIn(t, '+994501112233');
    const f = (await scan(t, a, PARTNER_RESTAURANT.receipt.fiscalId)).body.fiscal;
    const [row] = await t.db.select().from(fiscalReceipts).where(eq(fiscalReceipts.fiscalId, 'TESTFISC0004'));
    expect(row!.restaurantId).not.toBeNull();
    expect(f.partner.branchId).not.toBeNull();
  });
});
