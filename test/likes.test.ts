import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { feedback, likes, purchaseItems, purchases, users } from '../src/db/schema.js';
import { sha256 } from '../src/lib/crypto.js';
import { setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
let alice: { token: string; id: string };
let bob: { token: string; id: string };
beforeEach(async () => {
  t = await setup();
  const sign = async (phone: string) => {
    const auth = await t.signInPhone(phone);
    return { token: auth.session.accessToken as string, id: auth.user.id as string };
  };
  alice = await sign('+994501110001');
  bob = await sign('+994501110002');
});

const dish = { restaurantId: 'demo-r1', dishId: 'demo-d1', title: 'Dolma', subtitle: 'Demo House', imageUrl: 'https://example.com/d.jpg' };
const URL = '/likes/dish/demo-r1:demo-d1';
const place = (restaurantId: string) => ({ restaurantId, dishId: null, title: restaurantId, subtitle: '', imageUrl: null });
const rows = async () => (await t.db.select().from(likes)).length;

describe('likes', () => {
  it('persists, is idempotent, counts accounts and unlikes', async () => {
    const put = () => t.call('PUT', URL, { token: alice.token, body: dish, key: false });
    expect((await put()).body).toEqual({ liked: true, count: 1 });
    expect((await put()).body).toEqual({ liked: true, count: 1 });
    expect((await t.call('PUT', URL, { token: bob.token, body: dish })).body).toEqual({ liked: true, count: 2 });
    expect(await rows()).toBe(2);

    const list = await t.call('GET', '/likes', { token: alice.token });
    expect(list.body).toEqual({
      items: [{ kind: 'dish', targetId: 'demo-r1:demo-d1', ...dish, createdAt: expect.any(String), count: 2 }],
      nextCursor: null,
    });

    const unlike = () => t.call('DELETE', URL, { token: alice.token, key: false });
    expect((await unlike()).body).toEqual({ liked: false, count: 1 });
    expect((await unlike()).body).toEqual({ liked: false, count: 1 });
    expect((await t.call('GET', '/likes', { token: alice.token })).body.items).toEqual([]);
    expect((await t.call('GET', '/likes', { token: bob.token })).body.items).toHaveLength(1);
  });

  it('keeps one row under concurrent duplicates', async () => {
    const all = await Promise.all(Array.from({ length: 8 }, () => t.call('PUT', URL, { token: alice.token, body: dish })));
    expect(all.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(await rows()).toBe(1);
  });

  it('answers state in the order asked and paginates newest first, filtered by kind', async () => {
    const long = 'x'.repeat(64);
    for (const id of ['r1', 'r2', long]) {
      expect((await t.call('PUT', `/likes/restaurant/${id}`, { token: alice.token, body: place(id) })).status).toBe(200);
      t.advance(1000);
    }
    await t.call('PUT', URL, { token: bob.token, body: dish });
    const state = await t.call('POST', '/likes/state', { token: bob.token, body: { kind: 'restaurant', targetIds: ['r2', 'none', 'r1'] } });
    expect(state.body.items).toEqual([
      { targetId: 'r2', liked: false, count: 1 },
      { targetId: 'none', liked: false, count: 0 },
      { targetId: 'r1', liked: false, count: 1 },
    ]);

    const first = await t.call('GET', '/likes?kind=restaurant&limit=2', { token: alice.token });
    expect(first.body.items.map((i: { targetId: string }) => i.targetId)).toEqual([long, 'r2']);
    const second = await t.call('GET', `/likes?kind=restaurant&limit=2&cursor=${first.body.nextCursor}`, { token: alice.token });
    expect(second.body.items.map((i: { targetId: string }) => i.targetId)).toEqual(['r1']);
    expect(second.body.nextCursor).toBeNull();
  });

  it('accepts the longest target id and a full state request', async () => {
    const id = `${'r'.repeat(64)}:${'d'.repeat(64)}`;
    const body = { ...dish, restaurantId: 'r'.repeat(64), dishId: 'd'.repeat(64) };
    expect((await t.call('PUT', `/likes/dish/${id}`, { token: alice.token, body })).status).toBe(200);
    expect((await t.call('PUT', `/likes/review/${'a'.repeat(160)}`, { token: alice.token, body: place('r1') })).status).toBe(200);
    const targetIds = Array.from({ length: 100 }, (_, i) => `${i}`.padStart(160, 'a'));
    expect((await t.call('POST', '/likes/state', { token: alice.token, body: { kind: 'restaurant', targetIds } })).status).toBe(200);
  });

  it('validates strictly and needs a signed-in account', async () => {
    const put = (url: string, body: unknown) => t.call('PUT', url, { token: alice.token, body });
    for (const body of [
      { ...dish, extra: 1 },
      { ...dish, title: '' },
      { ...dish, title: 'a\u0000b' },
      { ...dish, subtitle: 'x'.repeat(201) },
      { ...dish, imageUrl: 'http://example.com/d.jpg' },
      { ...dish, imageUrl: 'javascript:alert(1)' },
      { ...dish, restaurantId: 'a:b' },
      { ...dish, dishId: null },
      { ...dish, dishId: 'other' },
    ])
      expect((await put(URL, body)).status, JSON.stringify(body)).toBe(422);
    expect((await put('/likes/user/r1', place('r1'))).status).toBe(422);
    expect((await put(`/likes/review/${'a'.repeat(161)}`, place('r1'))).status).toBe(422);
    expect((await put('/likes/restaurant/r2', place('r1'))).status).toBe(422);
    expect((await t.call('POST', '/likes/state', { token: alice.token, body: { kind: 'dish', targetIds: [] } })).status).toBe(422);
    expect((await t.call('GET', '/likes?limit=101', { token: alice.token })).status).toBe(422);
    for (const [method, url] of [['PUT', URL], ['DELETE', URL], ['GET', '/likes'], ['POST', '/likes/state']] as const)
      expect((await t.call(method, url, { body: method === 'GET' ? undefined : dish })).status, `${method} ${url}`).toBe(401);
    expect(await rows()).toBe(0);
  });

  it('likes only existing, visible database reviews, once whatever the letter case', async () => {
    const [p] = await t.db
      .insert(purchases)
      .values({ referenceHash: sha256('x'), issuedAt: t.clock.now, totalMinor: 100, expiresAt: t.clock.now, claimedBy: bob.id, claimedAt: t.clock.now })
      .returning();
    const [item] = await t.db.insert(purchaseItems).values({ purchaseId: p!.id, name: 'Dolma', quantity: 1, unitPriceMinor: 100 }).returning();
    const [review] = await t.db.insert(feedback).values({ purchaseItemId: item!.id, userId: bob.id, rating: 5 }).returning();
    const url = `/likes/review/${review!.id}`;

    expect((await t.call('PUT', url, { token: alice.token, body: place('r1') })).body).toEqual({ liked: true, count: 1 });
    expect((await t.call('PUT', `/likes/review/${review!.id.toUpperCase()}`, { token: alice.token, body: place('r1') })).body.count).toBe(1);
    const missing = await t.call('PUT', '/likes/review/00000000-0000-0000-0000-000000000000', { token: alice.token, body: place('r1') });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('LIKE_TARGET_NOT_FOUND');

    await t.db.update(feedback).set({ hiddenAt: t.clock.now }).where(eq(feedback.id, review!.id));
    const hidden = await t.call('PUT', url, { token: bob.token, body: place('r1') });
    expect(hidden.body.error.code).toBe('LIKE_TARGET_NOT_FOUND');
    expect((await t.call('GET', '/likes', { token: alice.token })).body.items).toEqual([]);
    expect((await t.call('DELETE', url, { token: alice.token })).body).toEqual({ liked: false, count: 0 });
    // Demo-catalogue review ids are not checked against the database.
    expect((await t.call('PUT', '/likes/review/demo-review-1', { token: alice.token, body: place('r1') })).status).toBe(200);
  });

  it('account deletion removes the likes; deleted accounts never count', async () => {
    await t.call('PUT', URL, { token: alice.token, body: dish });
    await t.call('PUT', URL, { token: bob.token, body: dish });
    expect((await t.call('DELETE', '/me', { token: alice.token })).status).toBe(204);
    expect(await rows()).toBe(1);
    await t.db.update(users).set({ deletedAt: t.clock.now }).where(eq(users.id, bob.id));
    const carol = (await t.signInPhone('+994501110003')).session.accessToken;
    expect((await t.call('POST', '/likes/state', { token: carol, body: { kind: 'dish', targetIds: ['demo-r1:demo-d1'] } })).body.items[0].count).toBe(0);
  });

  it('rate-limits writes', async () => {
    for (let i = 0; i < 60; i++) expect((await t.call('PUT', URL, { token: alice.token, body: dish })).status).toBe(200);
    expect((await t.call('PUT', URL, { token: alice.token, body: dish })).status).toBe(429);
  });
});
