import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { branches, devices, notificationPreferences, purchases, restaurants } from '../src/db/schema.js';
import { fixtureProvider } from '../src/fiscal/provider.js';
import { sha256 } from '../src/lib/crypto.js';
import { announcePartner } from '../src/notifications/partner.js';
import { sendMealReminders } from '../src/notifications/reminders.js';
import { CAFE, NON_PARTNER_RESTAURANT, qr } from './fiscal-fixtures.js';
import { setup } from './helpers.js';

type T = Awaited<ReturnType<typeof setup>>;
const HOUR = 3_600_000;
const KEY = 'test-partner-key-0123456789abcdefghijklmnop';
const VOEN = '3333333333';
const TOKEN = 'ExponentPushToken[abc]';
const line = (lineNo: number, name: string, unitPriceMinor: number) => ({
  lineNo, originalName: name, normalizedName: name, quantityMilli: 1000, unit: 'porsiya', unitPriceMinor, lineTotalMinor: unitPriceMinor, discountMinor: null, vatRatePercent: null, vatMinor: null,
});
const posReceipt = (fiscalId: string) => ({
  merchant: { displayName: 'DOLMA HOUSE', legalName: null, voen: VOEN, objectName: null, objectCode: null, address: null, city: null },
  receipt: {
    fiscalId, number: '1', documentId: null, type: 'sale', issuedAt: '2026-11-12T20:00:00+04:00', currency: 'AZN', totalMinor: 500,
    subtotalMinor: null, discountMinor: null, vatMinor: null, vatBreakdown: [],
    payment: { method: 'cashless', cashMinor: null, cashlessMinor: 500, bonusMinor: null, changeMinor: null },
  },
  items: [line(1, 'YARPAQ DOLMASI', 500)],
  device: { model: null, serialNumber: null, nmqRegistrationNumber: null },
  additionalFields: {},
});
const settings = (t: T, token: string, body: object) => t.call('PUT', '/me/notification-settings', { token, body });
const withDevice = (t: T, token: string) => t.call('POST', '/devices', { token, body: { token: TOKEN } });

async function partnerSetup() {
  const t = await setup();
  const [r] = await t.db.insert(restaurants).values({ name: 'Dolma House', cashbackBps: 250, voen: VOEN, posKeyHash: sha256(KEY) }).returning();
  await t.db.insert(branches).values({ restaurantId: r!.id, name: 'Nizami' });
  const token = (await t.signInPhone('+994501112233')).session.accessToken as string;
  const rate = async (fiscalId: string, key?: string) => {
    await t.app.inject({ method: 'POST', url: '/v1/partner/receipts', headers: { 'x-partner-key': KEY }, payload: posReceipt(fiscalId) });
    const scan = await t.call('POST', '/receipts/resolve', { token, body: { kind: 'qr', value: qr(fiscalId) } });
    return t.call('POST', '/feedback', { token, key, body: { receiptItemId: scan.body.items[0].id, rating: 5 } });
  };
  return { t, token, rate };
}

describe('cashback notifications', () => {
  it('one inbox row and one push per reward, even when the rating is replayed', async () => {
    const { t, token, rate } = await partnerSetup();
    await settings(t, token, { cashbackUpdates: true, partnerUpdates: false, reminders: true });
    await withDevice(t, token);
    const first = await rate('TESTFISC0701', 'rate-key-0001');
    expect(first.body.reward.status).toBe('confirmed');
    const inbox = (await t.call('GET', '/notifications', { token })).body;
    expect(inbox.items).toHaveLength(1);
    expect(inbox.unreadCount).toBe(1);
    expect(inbox.items[0]).toMatchObject({ kind: 'cashback', title: 'Keşbek təsdiqləndi', body: '0.12 ₼ hesabınıza əlavə olundu.', readAt: null });
    expect(t.pushed).toHaveLength(1);
    expect(t.pushed[0]).toMatchObject({ to: TOKEN, channelId: 'cashback' });
  });

  it('an exact idempotent replay does not notify again; a non-partner rating notifies nobody', async () => {
    const { t, token } = await partnerSetup();
    await settings(t, token, { cashbackUpdates: true, partnerUpdates: false, reminders: true });
    await withDevice(t, token);
    await t.app.inject({ method: 'POST', url: '/v1/partner/receipts', headers: { 'x-partner-key': KEY }, payload: posReceipt('TESTFISC0702') });
    const scan = await t.call('POST', '/receipts/resolve', { token, body: { kind: 'qr', value: qr('TESTFISC0702') } });
    const body = { receiptItemId: scan.body.items[0].id, rating: 5 };
    expect((await t.call('POST', '/feedback', { token, key: 'same-key-0001', body })).status).toBe(200);
    expect((await t.call('POST', '/feedback', { token, key: 'same-key-0001', body })).status).toBe(200);
    expect(t.pushed).toHaveLength(1);

    const plain = await setup({}, { fiscal: fixtureProvider(new Map([[NON_PARTNER_RESTAURANT.receipt.fiscalId, NON_PARTNER_RESTAURANT]])) });
    const b = (await plain.signInPhone('+994507778899')).session.accessToken as string;
    await settings(plain, b, { cashbackUpdates: true, partnerUpdates: true, reminders: true });
    await withDevice(plain, b);
    const receipt = (await plain.call('POST', '/receipts/resolve', { token: b, body: { kind: 'qr', value: qr(NON_PARTNER_RESTAURANT.receipt.fiscalId) } })).body;
    await plain.call('POST', '/feedback', { token: b, body: { receiptItemId: receipt.items[0].id, rating: 4 } });
    expect((await plain.call('GET', '/notifications', { token: b })).body.items).toHaveLength(0);
    expect(plain.pushed).toHaveLength(0);
  });

  it('with the preference off the inbox still gets it but nothing is pushed', async () => {
    const { t, token, rate } = await partnerSetup();
    await withDevice(t, token); // default: cashbackUpdates off
    await rate('TESTFISC0703');
    expect((await t.call('GET', '/notifications', { token })).body.items).toHaveLength(1);
    expect(t.pushed).toHaveLength(0);
  });

  it('a push rejected as unregistered removes that device', async () => {
    const { t, token, rate } = await partnerSetup();
    await settings(t, token, { cashbackUpdates: true, partnerUpdates: false, reminders: true });
    await withDevice(t, token);
    t.deadTokens.add(TOKEN);
    await rate('TESTFISC0704');
    expect(await t.db.select().from(devices)).toHaveLength(0);
  });
});

describe('inbox', () => {
  it('pages, marks read, and never exposes or touches another user\'s rows', async () => {
    const { t, token, rate } = await partnerSetup();
    await rate('TESTFISC0705');
    const other = (await t.signInPhone('+994507778899')).session.accessToken as string;
    expect((await t.call('GET', '/notifications', { token: other })).body).toEqual({ items: [], nextCursor: null, unreadCount: 0 });
    const [mine] = (await t.call('GET', '/notifications', { token })).body.items;

    expect((await t.call('POST', `/notifications/${mine.id}/read`, { token: other })).status).toBe(404);
    expect((await t.call('POST', `/notifications/${mine.id}/read`, { token: other })).body.error.code).toBe('NOTIFICATION_NOT_FOUND');
    expect((await t.call('POST', '/notifications/read-all', { token: other })).status).toBe(204);
    expect((await t.call('GET', '/notifications', { token })).body.unreadCount).toBe(1);

    expect((await t.call('POST', `/notifications/${mine.id}/read`, { token })).status).toBe(204);
    expect((await t.call('POST', `/notifications/${mine.id}/read`, { token })).status).toBe(204);
    const after = (await t.call('GET', '/notifications', { token })).body;
    expect(after.unreadCount).toBe(0);
    expect(after.items[0].readAt).toBe(t.clock.now.toISOString());
  });

  it('read-all marks every unread notification', async () => {
    const { t, token, rate } = await partnerSetup();
    await rate('TESTFISC0706');
    await rate('TESTFISC0707');
    expect((await t.call('GET', '/notifications?limit=1', { token })).body.nextCursor).not.toBeNull();
    expect((await t.call('GET', '/notifications', { token })).body.unreadCount).toBe(2);
    expect((await t.call('POST', '/notifications/read-all', { token })).status).toBe(204);
    expect((await t.call('GET', '/notifications', { token })).body.unreadCount).toBe(0);
  });

  it('exposes reminders in the settings, default on, and requires all three booleans', async () => {
    const t = await setup();
    const token = (await t.signInPhone()).session.accessToken as string;
    expect((await t.call('GET', '/me/notification-settings', { token })).body).toEqual({ cashbackUpdates: false, partnerUpdates: false, reminders: true });
    expect((await settings(t, token, { cashbackUpdates: true, partnerUpdates: true })).status).toBe(422);
    expect((await settings(t, token, { cashbackUpdates: true, partnerUpdates: false, reminders: false })).body).toEqual({ cashbackUpdates: true, partnerUpdates: false, reminders: false });
  });
});

const setReminders = (t: T, reminders: boolean) =>
  t.db.insert(notificationPreferences).values({ userId: sql`(select id from users limit 1)` as never, reminders }).onConflictDoUpdate({ target: notificationPreferences.userId, set: { reminders } });

describe('meal reminders', () => {
  async function eaten() {
    const t = await setup({}, { fiscal: fixtureProvider(new Map([NON_PARTNER_RESTAURANT, CAFE].map((d) => [d.receipt.fiscalId, d]))) });
    const token = (await t.signInPhone()).session.accessToken as string;
    await withDevice(t, token);
    const receipt = (await t.call('POST', '/receipts/resolve', { token, body: { kind: 'qr', value: qr(NON_PARTNER_RESTAURANT.receipt.fiscalId) } })).body;
    // The clock is fake; place the purchase 4 h before it.
    await t.db.update(purchases).set({ createdAt: new Date(t.clock.now.getTime() - 4 * HOUR), expiresAt: new Date(t.clock.now.getTime() + 5 * 24 * HOUR) });
    const run = () => sendMealReminders({ db: t.db, config: t.config, now: () => new Date(t.clock.now), push: t.push }, new Date(t.clock.now));
    return { t, token, receipt, run };
  }

  it('sends once, in daytime, with the unrated count and the receipt link', async () => {
    const { t, receipt, run } = await eaten();
    t.clock.now = new Date('2026-11-13T16:30:00Z'); // 20:30 Baku, last allowed slot
    await t.db.update(purchases).set({ createdAt: new Date(t.clock.now.getTime() - 4 * HOUR), expiresAt: new Date(t.clock.now.getTime() + 5 * 24 * HOUR) });
    expect(await run()).toBe(1);
    expect(t.pushed[0]).toMatchObject({ title: 'Yeməyiniz necə idi?', body: '2 yeməyinizi qiymətləndirə bilərsiniz.', data: { path: `/receipt/${receipt.id}` }, channelId: 'meal_reminder' });
    // Same purchase never twice, even after the 20 h cap lapses.
    t.advance(21 * HOUR);
    await t.db.update(purchases).set({ createdAt: new Date(t.clock.now.getTime() - 4 * HOUR), expiresAt: new Date(t.clock.now.getTime() + 5 * 24 * HOUR) });
    expect(await run()).toBe(0);
    expect(t.pushed).toHaveLength(1);
  });

  it('stays quiet at night and until the purchase is 3 hours old', async () => {
    const { t, run } = await eaten();
    t.clock.now = new Date('2026-11-13T17:00:00Z'); // 21:00 Baku
    expect(await run()).toBe(0);
    t.clock.now = new Date('2026-11-13T06:30:00Z'); // 10:30 Baku
    expect(await run()).toBe(0);
    t.clock.now = new Date('2026-11-13T08:00:00Z'); // 12:00 Baku, purchase 2 h old
    await t.db.update(purchases).set({ createdAt: new Date(t.clock.now.getTime() - 2 * HOUR), expiresAt: new Date(t.clock.now.getTime() + 5 * 24 * HOUR) });
    expect(await run()).toBe(0);
    expect(t.pushed).toHaveLength(0);
  });

  it('respects the 20 h cap across purchases and the reminders preference', async () => {
    const { t, token, run } = await eaten();
    expect(await run()).toBe(1);
    // A second meal is held back by the cap, then reminded once the cap lapses.
    await t.call('POST', '/receipts/resolve', { token, body: { kind: 'qr', value: qr(CAFE.receipt.fiscalId) } });
    await t.db.update(purchases).set({ createdAt: new Date(t.clock.now.getTime() - 4 * HOUR) });
    t.advance(HOUR);
    expect(await run()).toBe(0);
    t.advance(20 * HOUR); // 11:00 Baku next day
    await t.db.update(purchases).set({ createdAt: new Date(t.clock.now.getTime() - 4 * HOUR), expiresAt: new Date(t.clock.now.getTime() + 5 * 24 * HOUR) });
    await setReminders(t, false);
    expect(await run()).toBe(0);
    await setReminders(t, true); // direct: the access token has expired by now
    expect(await run()).toBe(1);
    expect(t.pushed).toHaveLength(2);
  });

  it('stops once every dish is rated', async () => {
    const { t, token, receipt, run } = await eaten();
    for (const item of receipt.items) await t.call('POST', '/feedback', { token, body: { receiptItemId: item.id, rating: 5 } });
    expect(await run()).toBe(0);
    expect(t.pushed).toHaveLength(0);
  });
});

describe('partner announcements', () => {
  it('reach only opted-in users, once, in their language', async () => {
    const t = await setup();
    const [r] = await t.db.insert(restaurants).values({ name: 'Dolma House' }).returning();
    const a = (await t.signInPhone('+994501112233')).session.accessToken as string;
    const b = (await t.signInPhone('+994507778899')).session.accessToken as string;
    await settings(t, a, { cashbackUpdates: false, partnerUpdates: true, reminders: true });
    await t.call('PATCH', '/me', { token: a, body: { language: 'en' } });
    await settings(t, b, { cashbackUpdates: false, partnerUpdates: false, reminders: true });
    await withDevice(t, a);
    expect(await announcePartner({ db: t.db, now: () => new Date(t.clock.now), push: t.push }, r!.id)).toBe(1);
    expect(await announcePartner({ db: t.db, now: () => new Date(t.clock.now), push: t.push }, r!.id)).toBe(0);
    const [n] = (await t.call('GET', '/notifications', { token: a })).body.items;
    expect(n).toMatchObject({ kind: 'partner', title: 'Dolma House has joined Epsilon', path: `/restaurant/${r!.id}` });
    expect((await t.call('GET', '/notifications', { token: b })).body.items).toHaveLength(0);
    expect(t.pushed).toHaveLength(1);
    await expect(announcePartner({ db: t.db, now: () => new Date(), push: t.push }, crypto.randomUUID())).rejects.toThrow('Unknown restaurant');
  });
});
