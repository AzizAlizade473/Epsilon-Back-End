import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { rewardMinor } from '../src/lib/money.js';
import { seed } from '../src/db/seed-data.js';
import { setup } from './helpers.js';

describe('rewardMinor', () => {
  it('computes basis points of the line price, rounded down to whole qəpik', () => {
    expect(rewardMinor(1450, 2, 500)).toBe(145); // 29.00 AZN × 5 %
    expect(rewardMinor(999, 1, 250)).toBe(24); // 24.975 → 24
    expect(rewardMinor(1000, 1, 0)).toBe(0);
    expect(rewardMinor(2_000_000_000, 1000, 10_000)).toBe(2_000_000_000_000); // exact, no float drift
  });

  it('rejects non-integer or out-of-range input', () => {
    expect(() => rewardMinor(10.5, 1, 100)).toThrow(RangeError);
    expect(() => rewardMinor(-1, 1, 100)).toThrow(RangeError);
    expect(() => rewardMinor(100, 0, 100)).toThrow(RangeError);
    expect(() => rewardMinor(100, 1, 10_001)).toThrow(RangeError);
  });
});

let t: Awaited<ReturnType<typeof setup>>;
let token: string;

async function resolve(code: string, accessToken = token) {
  return t.call('POST', '/receipts/resolve', { token: accessToken, body: { kind: 'code', value: code } });
}

beforeEach(async () => {
  t = await setup();
  await seed(t.db, t.clock.now);
  token = (await t.signInPhone('+994501112233')).session.accessToken;
});

describe('receipts', () => {
  it('claims a receipt once, globally', async () => {
    const mine = await resolve('demo-0001'); // case-insensitive code entry
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ status: 'verified', currency: 'AZN', restaurant: { name: 'Bulvar Bistro', branchCount: 2 } });
    expect(mine.body.items).toHaveLength(3);
    // Bulvar Bistro 5 %: pasta 1450×2, salmon 2400, cake 750 → 145 + 120 + 37
    expect(mine.body.rewardHint).toEqual({ amountMinor: 302, currency: 'AZN' });
    expect((await resolve('DEMO-0001')).status).toBe(200); // owner may re-open

    const other = (await t.signInPhone('+994552223344')).session.accessToken;
    const stolen = await resolve('DEMO-0001', other);
    expect(stolen.status).toBe(409);
    expect(stolen.body.error.code).toBe('RECEIPT_ALREADY_CLAIMED');
    const read = await t.call('GET', `/receipts/${mine.body.id}`, { token: other });
    expect(read.body.error.code).toBe('RECEIPT_NOT_FOUND');
  });

  it('rejects unknown and expired references', async () => {
    expect((await resolve('NOPE-1234')).body.error.code).toBe('RECEIPT_NOT_FOUND');
    expect((await resolve('DEMO-EXPIRED')).body.error.code).toBe('RECEIPT_EXPIRED');
  });
});

describe('feedback rewards and wallet ledger', () => {
  async function itemOf(code = 'DEMO-0001') {
    const receipt = (await resolve(code)).body;
    return { receipt, item: receipt.items.find((i: { name: string }) => i.name === 'Creamy mushroom pasta') };
  }

  it('credits the server-computed reward and derives the balance from the ledger', async () => {
    const { receipt, item } = await itemOf();
    const res = await t.call('POST', '/feedback', {
      token,
      body: { receiptItemId: item.id, rating: 5, comment: '  Great  ', reasonCodes: ['taste'] },
    });
    expect(res.status).toBe(200);
    expect(res.body.reward).toEqual({ status: 'confirmed', amountMinor: 145 });

    expect((await t.call('GET', '/wallet', { token })).body).toEqual({ balanceMinor: 145, pendingMinor: 0, currency: 'AZN' });
    const txs = (await t.call('GET', '/wallet/transactions', { token })).body;
    expect(txs.nextCursor).toBeNull();
    expect(txs.items).toEqual([
      expect.objectContaining({
        type: 'earned',
        status: 'confirmed',
        amountMinor: 145,
        receiptId: receipt.id,
        itemName: 'Creamy mushroom pasta',
        source: expect.objectContaining({ restaurantName: 'Bulvar Bistro', branchName: 'Bulvar' }),
      }),
    ]);
    const detail = await t.call('GET', `/wallet/transactions/${txs.items[0].id}`, { token });
    expect(detail.body.id).toBe(txs.items[0].id);

    const after = (await t.call('GET', `/receipts/${receipt.id}`, { token })).body;
    expect(after.items.find((i: { id: string }) => i.id === item.id)).toMatchObject({ canRate: false, rating: 5 });
    expect(after.rewardHint.amountMinor).toBe(302 - 145);
    // Cashback per receipt is opt-in: absent by default, summed from the ledger when asked.
    expect(after.cashback).toBeUndefined();
    const withCashback = (await t.call('GET', `/receipts/${receipt.id}?include=cashback`, { token })).body;
    expect(withCashback.cashback).toEqual({ earnedMinor: 145, pendingMinor: 0 });

    const reviews = (await t.call('GET', '/feedback', { token })).body;
    expect(reviews.items[0]).toMatchObject({ dishName: 'Creamy mushroom pasta', restaurantName: 'Bulvar Bistro', rating: 5, comment: 'Great' });
  });

  it('replays the same idempotency key without paying twice', async () => {
    const { item } = await itemOf();
    const body = { receiptItemId: item.id, rating: 4 };
    const a = await t.call('POST', '/feedback', { token, body, key: 'feedback-key-1' });
    const b = await t.call('POST', '/feedback', { token, body, key: 'feedback-key-1' });
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);

    const changed = await t.call('POST', '/feedback', { token, body: { ...body, rating: 1 }, key: 'feedback-key-1' });
    expect(changed.status).toBe(422);
    expect((await t.call('GET', '/wallet', { token })).body.balanceMinor).toBe(145);
  });

  it('pays at most once per item, even with different keys or concurrent requests', async () => {
    const { item } = await itemOf();
    const body = { receiptItemId: item.id, rating: 3 };
    const results = await Promise.all([
      t.call('POST', '/feedback', { token, body }),
      t.call('POST', '/feedback', { token, body }),
      t.call('POST', '/feedback', { token, body }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const dup = await t.call('POST', '/feedback', { token, body });
    expect(dup.body.error.code).toBe('FEEDBACK_ALREADY_SUBMITTED');
    const rows = await t.db.execute(sql`select count(*)::int as n from ledger_entries`);
    expect(JSON.stringify(rows)).toContain('"n":1');
    expect((await t.call('GET', '/wallet', { token })).body.balanceMinor).toBe(145);
  });

  it('refuses feedback on items the user does not own', async () => {
    const { item } = await itemOf();
    const other = (await t.signInPhone('+994552223344')).session.accessToken;
    const res = await t.call('POST', '/feedback', { token: other, body: { receiptItemId: item.id, rating: 5 } });
    expect(res.status).toBe(422);
    expect((await t.call('GET', '/wallet', { token: other })).body.balanceMinor).toBe(0);
  });

  it('pays an account that has a verified e-mail identity and no phone', async () => {
    t.googleAccounts.set('tok', { sub: 'g-9', email: 'g@example.com', emailVerified: true });
    const google = (await t.call('POST', '/auth/google', { body: { idToken: 'tok' } })).body.session.accessToken;
    const receipt = (await resolve('DEMO-0002', google)).body;
    expect(receipt.rewardHint?.amountMinor).toBeGreaterThan(0);
    const res = await t.call('POST', '/feedback', { token: google, body: { receiptItemId: receipt.items[0].id, rating: 4 } });
    expect(res.body.reward.status).toBe('confirmed');
    expect((await t.call('GET', '/wallet', { token: google })).body.balanceMinor).toBe(res.body.reward.amountMinor);
  });

  it('rejects invalid ratings and unknown reason codes', async () => {
    const { item } = await itemOf();
    for (const body of [
      { receiptItemId: item.id, rating: 6 },
      { receiptItemId: item.id, rating: 4.5 },
      { receiptItemId: item.id, rating: 4, reasonCodes: ['free_food'] },
      { receiptItemId: item.id, rating: 4, comment: 'x'.repeat(501) },
    ]) {
      const res = await t.call('POST', '/feedback', { token, body });
      expect(res.status).toBe(422);
    }
  });

  it('pages transactions with an opaque cursor and hides other users rows', async () => {
    const receipt = (await resolve('DEMO-0001')).body;
    for (const item of receipt.items) {
      await t.call('POST', '/feedback', { token, body: { receiptItemId: item.id, rating: 5 } });
      t.advance(1000);
    }
    const page1 = (await t.call('GET', '/wallet/transactions?limit=2', { token })).body;
    expect(page1.items).toHaveLength(2);
    const page2 = (await t.call('GET', `/wallet/transactions?limit=2&cursor=${page1.nextCursor}`, { token })).body;
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const total = [...page1.items, ...page2.items].reduce((s, i) => s + i.amountMinor, 0);
    expect((await t.call('GET', '/wallet', { token })).body.balanceMinor).toBe(total);

    const other = (await t.signInPhone('+994552223344')).session.accessToken;
    expect((await t.call('GET', `/wallet/transactions/${page1.items[0].id}`, { token: other })).status).toBe(404);
  });
});
