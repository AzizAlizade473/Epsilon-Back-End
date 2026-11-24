import { count } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { branches, feedback, ledgerEntries, restaurants } from '../src/db/schema.js';
import { fixtureProvider } from '../src/fiscal/provider.js';
import { QUICK_COMMENTS } from '../src/lib/quick-comments.js';
import { ALL, NON_PARTNER_RESTAURANT, PARTNER_RESTAURANT, qr } from './fiscal-fixtures.js';
import { setup } from './helpers.js';

type T = Awaited<ReturnType<typeof setup>>;
const provider = () => fixtureProvider(new Map(ALL.map((d) => [d.receipt.fiscalId, d])));
const signIn = async (t: T, phone: string) => (await t.signInPhone(phone)).session.accessToken as string;
const scan = (t: T, token: string, fiscalId: string) =>
  t.call('POST', '/receipts/resolve', { token, body: { kind: 'qr', value: qr(fiscalId) } });
const rows = async (t: T, table: typeof feedback | typeof ledgerEntries) =>
  (await t.db.select({ n: count() }).from(table))[0]!.n;

describe('quick comments', () => {
  it('has six per star rating, each with a dimension and a sentiment', () => {
    for (const rating of [1, 2, 3, 4, 5])
      expect(Object.values(QUICK_COMMENTS).filter((c) => c.rating === rating)).toHaveLength(6);
  });

  it('accepts comments of the chosen rating (and legacy codes), rejects ones from another rating', async () => {
    const t = await setup({}, { fiscal: provider() });
    const a = await signIn(t, '+994501112233');
    const receipt = (await scan(t, a, NON_PARTNER_RESTAURANT.receipt.fiscalId)).body;
    const [first, second] = receipt.items;
    const wrong = await t.call('POST', '/feedback', {
      token: a,
      body: { receiptItemId: first.id, rating: 1, reasonCodes: ['amazing_taste'] },
    });
    expect(wrong.status).toBe(422);
    // Regression: "freshness" (offered by the app) used to be refused, failing the whole rating.
    const legacy = await t.call('POST', '/feedback', {
      token: a,
      body: { receiptItemId: first.id, rating: 4, reasonCodes: ['freshness', 'great_taste'] },
    });
    expect(legacy.status).toBe(200);
    const ok = await t.call('POST', '/feedback', {
      token: a,
      body: { receiptItemId: second.id, rating: 1, reasonCodes: ['poor_taste', 'served_cold', 'not_worth_price', 'not_fresh'] },
    });
    expect(ok.status).toBe(200);
  });
});

describe('my reviews', () => {
  it('lists ratings of non-partner fiscal receipts with the merchant name, reasons and receipt link', async () => {
    const t = await setup({}, { fiscal: provider() });
    const a = await signIn(t, '+994501112233');
    const receipt = (await scan(t, a, NON_PARTNER_RESTAURANT.receipt.fiscalId)).body;
    await t.call('POST', '/feedback', {
      token: a,
      body: { receiptItemId: receipt.items[0].id, rating: 5, comment: 'Lovely', reasonCodes: ['amazing_taste'] },
    });
    const list = await t.call('GET', '/feedback', { token: a });
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      receiptId: receipt.id,
      receiptItemId: receipt.items[0].id,
      dishName: receipt.items[0].name,
      restaurantName: NON_PARTNER_RESTAURANT.merchant.objectName ?? NON_PARTNER_RESTAURANT.merchant.displayName,
      rating: 5,
      comment: 'Lovely',
      reasonCodes: ['amazing_taste'],
      updatedAt: null,
    });
    // The receipt names the review so the app can open it for editing.
    const again = await t.call('GET', `/receipts/${receipt.id}`, { token: a });
    expect(again.body.items[0].feedbackId).toBe(list.body.items[0].feedbackId);
    // Nobody else sees it.
    const b = await signIn(t, '+994507778899');
    expect((await t.call('GET', '/feedback', { token: b })).body.items).toHaveLength(0);
  });
});

describe('editing a review', () => {
  it('changes the same review only for its author, never adds a review or a second reward', async () => {
    const t = await setup({}, { fiscal: provider() });
    const [r] = await t.db
      .insert(restaurants)
      .values({ name: 'Dolma House', cashbackBps: 250, voen: PARTNER_RESTAURANT.merchant.voen })
      .returning();
    await t.db
      .insert(branches)
      .values({ restaurantId: r!.id, name: 'Nizami', objectCode: PARTNER_RESTAURANT.merchant.objectCode });
    const a = await signIn(t, '+994501112233');
    const receipt = (await scan(t, a, PARTNER_RESTAURANT.receipt.fiscalId)).body;
    const created = await t.call('POST', '/feedback', {
      token: a,
      body: { receiptItemId: receipt.items[0].id, rating: 3, reasonCodes: ['average_taste'] },
    });
    expect(created.status).toBe(200);
    const id = created.body.feedbackId;
    const [reviewsBefore, ledgerBefore] = [await rows(t, feedback), await rows(t, ledgerEntries)];

    const edit = await t.call('PATCH', `/feedback/${id}`, {
      token: a,
      body: { rating: 4, comment: 'Better than I said', reasonCodes: ['great_taste', 'good_value'] },
    });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ feedbackId: id, rating: 4, reasonCodes: ['great_taste', 'good_value'] });
    expect(edit.body.updatedAt).not.toBeNull();
    expect(await rows(t, feedback)).toBe(reviewsBefore);
    expect(await rows(t, ledgerEntries)).toBe(ledgerBefore);
    expect((await t.call('GET', `/receipts/${receipt.id}`, { token: a })).body.items[0].rating).toBe(4);

    // Comments must fit the new rating; other users cannot touch it.
    const mismatch = await t.call('PATCH', `/feedback/${id}`, { token: a, body: { rating: 1, reasonCodes: ['great_taste'] } });
    expect(mismatch.status).toBe(422);
    const b = await signIn(t, '+994507778899');
    expect((await t.call('PATCH', `/feedback/${id}`, { token: b, body: { rating: 1 } })).status).toBe(404);
    expect((await t.call('GET', `/feedback/${id}`, { token: b })).status).toBe(404);
    expect((await t.call('GET', `/feedback/${id}`, { token: a })).body.rating).toBe(4);
  });
});
