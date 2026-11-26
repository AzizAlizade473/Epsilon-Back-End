import { describe, expect, it } from 'vitest';

import { branches, fiscalReceipts, restaurantStaff, restaurants, reviewReplies, scanAttempts } from '../src/db/schema.js';
import { fixtureProvider } from '../src/fiscal/provider.js';
import { setStaff } from '../src/lib/staff.js';
import { ALL, PARTNER_RESTAURANT, qr } from './fiscal-fixtures.js';
import { setup } from './helpers.js';

const FISCAL = PARTNER_RESTAURANT.receipt.fiscalId;
const fixtures = () => fixtureProvider(new Map(ALL.map((d) => [d.receipt.fiscalId, d])));
const code = (res: { status: number; body: any }) => [res.status, res.body?.error?.code];

async function partner(t: Awaited<ReturnType<typeof setup>>) {
  const [r] = await t.db.insert(restaurants).values({ name: 'Dolma House', cashbackBps: 250, voen: '3333333333' }).returning();
  await t.db.insert(branches).values({ restaurantId: r!.id, name: 'Nizami', objectCode: '3333333333-20001' });
  return r!;
}
const signIn = async (t: Awaited<ReturnType<typeof setup>>, phone: string) =>
  (await t.signInPhone(phone)).session.accessToken as string;

describe('scan activity and manual entry', () => {
  it('a typed Fiscal ID resolves like its QR; a retry updates the same row without a second receipt', async () => {
    let up = false;
    const source = fixtures();
    const t = await setup({}, { fiscal: { name: 'fixture', lookup: (r, s) => (up ? source.lookup(r, s) : Promise.resolve({ status: 'unavailable' })) } });
    await partner(t);
    const token = await signIn(t, '+994501112233');
    const typed = () => t.call('POST', '/receipts/resolve', { token, body: { kind: 'code', value: ` ${FISCAL} ` } });
    expect(code(await typed())).toEqual([503, 'RECEIPT_SOURCE_UNAVAILABLE']);
    const activity = async () => (await t.call('GET', '/activity/scans', { token })).body;
    expect((await activity()).items).toEqual([
      {
        id: expect.any(String), at: expect.any(String), status: 'failed', reason: 'RECEIPT_SOURCE_UNAVAILABLE', retryable: true,
        restaurantName: null, receiptId: null, retryQr: qr(FISCAL),
      },
    ]);

    up = true;
    t.advance(1000);
    const ok = await typed();
    expect(ok.status).toBe(200);
    const scanned = await t.call('POST', '/receipts/resolve', { token, body: { kind: 'qr', value: qr(FISCAL) } });
    expect(scanned.body.id).toBe(ok.body.id);
    expect((await activity()).items).toEqual([
      expect.objectContaining({ status: 'success', reason: null, retryable: false, restaurantName: 'Dolma House', receiptId: ok.body.id, retryQr: null }),
    ]);
    expect(await t.db.select().from(fiscalReceipts)).toHaveLength(1);
    expect((await t.call('GET', '/receipts', { token })).body.items).toHaveLength(1);
  });

  it('records failures without a retry for other codes, pages them, keeps them private and deletes them with the account', async () => {
    const t = await setup();
    const token = await signIn(t, '+994501112233');
    const send = (kind: string, value: string) => t.call('POST', '/receipts/resolve', { token, body: { kind, value } });
    expect(code(await send('code', 'DEMO-9999'))).toEqual([404, 'RECEIPT_NOT_FOUND']);
    t.advance(1000);
    expect(code(await send('qr', 'https://evil.example/?doc=TESTFISC0001'))).toEqual([422, 'RECEIPT_UNSUPPORTED']);
    t.advance(1000);
    // An image import is recorded too: a bad image, no image data kept.
    const bad = await t.call('POST', '/receipts/fiscal/import', {
      token, body: { qr: qr(FISCAL), source: 'official_page', images: [{ mime: 'image/png', data: 'A'.repeat(200) }] },
    });
    expect(bad.status).toBe(422);
    const first = (await t.call('GET', '/activity/scans?limit=2', { token })).body;
    expect(first.items.map((i: any) => [i.reason, i.retryable])).toEqual([['VALIDATION_FAILED', true], ['RECEIPT_UNSUPPORTED', false]]);
    const second = (await t.call('GET', `/activity/scans?limit=2&cursor=${first.nextCursor}`, { token })).body;
    expect(second).toMatchObject({ items: [{ reason: 'RECEIPT_NOT_FOUND', retryable: false, retryQr: null }], nextCursor: null });
    expect(JSON.stringify(await t.db.select().from(scanAttempts))).not.toMatch(/DEMO-9999|evil|AAAAAAAA/);

    const other = await signIn(t, '+994552223344');
    expect((await t.call('GET', '/activity/scans', { token: other })).body.items).toEqual([]);
    expect((await t.call('DELETE', '/me', { token })).status).toBe(204);
    expect(await t.db.select().from(scanAttempts)).toHaveLength(0);
  });
});

describe('restaurant replies', () => {
  it('only granted staff reply; the author sees and reports the reply; hidden things stay closed', async () => {
    const t = await setup({}, { fiscal: fixtures() });
    const restaurant = await partner(t);
    const customer = await signIn(t, '+994501112233');
    const receipt = (await t.call('POST', '/receipts/resolve', { token: customer, body: { kind: 'qr', value: qr(FISCAL) } })).body;
    const fb = (await t.call('POST', '/feedback', { token: customer, body: { receiptItemId: receipt.items[0].id, rating: 2, comment: 'cold' } })).body.feedbackId;
    await t.call('PATCH', '/me', { token: customer, body: { firstName: 'Leyla', lastName: 'Private' } });

    await t.call('POST', '/auth/otp/request', { body: { email: 'chef@x.com' } });
    const login = await t.call('POST', '/auth/otp/verify', { body: { email: 'chef@x.com', code: t.sent.at(-1)!.code } });
    const staff = login.body.session.accessToken as string;
    const list = `/staff/restaurants/${restaurant.id}/reviews`;
    const url = `/staff/reviews/${fb}/reply`;
    const put = (token: string, body = 'Sorry!') => t.call('PUT', url, { token, body: { body } });

    expect((await t.call('GET', '/staff/restaurants', { token: staff })).body).toEqual({ items: [] });
    expect((await t.call('GET', list, { token: staff })).status).toBe(404);
    expect(code(await put(staff))).toEqual([404, 'FEEDBACK_NOT_FOUND']);

    await expect(setStaff(t.db, 'add', 'nobody@x.com', restaurant.id)).rejects.toThrow(/verified/);
    expect(await setStaff(t.db, 'add', ' Chef@X.com ', restaurant.id)).toMatchObject({ changed: true });
    expect((await t.call('GET', '/staff/restaurants', { token: staff })).body).toEqual({ items: [{ id: restaurant.id, name: 'Dolma House' }] });
    const reviews = await t.call('GET', list, { token: staff });
    expect(reviews.body).toEqual({
      items: [{ feedbackId: fb, dishName: receipt.items[0].name, rating: 2, comment: 'cold', createdAt: expect.any(String), reviewer: 'Leyla', reply: null }],
      nextCursor: null,
    });

    expect((await put(staff, '   ')).status).toBe(422);
    expect((await put(staff, 'x'.repeat(1001))).status).toBe(422);
    expect((await put(staff)).body.reply).toMatchObject({ body: 'Sorry!', status: 'published' });
    expect((await put(staff, 'Very sorry')).body.reply.body).toBe('Very sorry');

    // Opt-in only: the old shape is unchanged.
    expect((await t.call('GET', `/feedback/${fb}`, { token: customer })).body).not.toHaveProperty('reply');
    const expected = { restaurantName: 'Dolma House', body: 'Very sorry', updatedAt: expect.any(String) };
    expect((await t.call('GET', `/feedback/${fb}?include=reply`, { token: customer })).body.reply).toEqual(expected);
    expect((await t.call('GET', '/feedback?include=reply', { token: customer })).body.items[0].reply).toEqual(expected);

    const report = (token: string, reason = 'rude') => t.call('POST', `/feedback/${fb}/reply/report`, { token, body: { reason } });
    expect(code(await report(staff))).toEqual([404, 'FEEDBACK_NOT_FOUND']);
    expect((await report(customer, '')).status).toBe(422);
    expect((await report(customer)).status).toBe(204);
    expect((await report(customer, 'again')).status).toBe(204);

    await t.db.update(reviewReplies).set({ hiddenAt: t.clock.now });
    expect((await t.call('GET', `/feedback/${fb}?include=reply`, { token: customer })).body.reply).toBeNull();
    expect((await t.call('GET', list, { token: staff })).body.items[0].reply.status).toBe('hidden');
    expect(code(await put(staff))).toEqual([409, 'REPLY_HIDDEN']);
    // Deleting does not launder a hidden reply.
    expect((await t.call('DELETE', url, { token: staff })).status).toBe(204);
    expect((await t.call('GET', list, { token: staff })).body.items[0].reply).toBeNull();
    expect(code(await put(staff))).toEqual([409, 'REPLY_HIDDEN']);
    expect(code(await report(customer))).toEqual([404, 'REPLY_NOT_FOUND']);

    await t.db.update(reviewReplies).set({ hiddenAt: null });
    expect((await put(staff, 'Back again')).status).toBe(200);
    await t.db.execute(`update feedback set hidden_at = now()`);
    expect(code(await put(staff))).toEqual([409, 'REVIEW_HIDDEN']);
    expect((await t.call('GET', list, { token: staff })).body.items).toEqual([]);

    // Another restaurant's staff learn nothing; removed staff lose access at once, replays included.
    const [elsewhere] = await t.db.insert(restaurants).values({ name: 'Other' }).returning();
    await setStaff(t.db, 'remove', 'chef@x.com', restaurant.id);
    await setStaff(t.db, 'add', 'chef@x.com', elsewhere!.id);
    expect(code(await put(staff))).toEqual([404, 'FEEDBACK_NOT_FOUND']);
    expect((await t.call('DELETE', url, { token: staff })).status).toBe(404);
    expect((await t.call('GET', list, { token: staff })).status).toBe(404);
    expect((await t.call('DELETE', '/me', { token: staff })).status).toBe(204);
    expect(await t.db.select().from(restaurantStaff)).toHaveLength(0);
  });
});
