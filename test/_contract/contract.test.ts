import { expect, it } from 'vitest';
import * as c from 'epsilon-app/services/contracts/index.ts';
import { branches, restaurants } from '../../src/db/schema.js';
import { fixtureProvider } from '../../src/fiscal/provider.js';
import { ALL, PARTNER_RESTAURANT, TAM_STORE, qr } from '../fiscal-fixtures.js';
import { seed } from '../../src/db/seed-data.js';
import { setup } from '../helpers.js';

it('responses parse with the app schemas', { timeout: 120_000 }, async () => {
  const t = await setup();
  await seed(t.db, t.clock.now);
  const auth = await t.signInPhone();
  c.authResultSchema.parse(auth);
  const token = auth.session.accessToken;
  const g = (p: string) => t.call('GET', p, { token }).then((r) => r.body);
  c.configSchema.parse(await g('/config'));
  c.userSchema.parse(await g('/me'));
  const page = c.restaurantPageSchema.parse(await g('/restaurants?search=bistro'));
  expect(page.items).toHaveLength(1);
  c.restaurantSchema.parse(await g(`/restaurants/${page.items[0]!.id}`));
  c.profileUpdateResultSchema.parse((await t.call('PATCH', '/me', { token, body: { firstName: 'A' } })).body);
  const receipt = c.receiptSchema.parse((await t.call('POST', '/receipts/resolve', { token, body: { kind: 'qr', value: 'DEMO-0003' } })).body);
  c.receiptSchema.parse(await g(`/receipts/${receipt.id}`));
  c.feedbackResultSchema.parse((await t.call('POST', '/feedback', { token, body: { receiptItemId: receipt.items[0]!.id, rating: 5 } })).body);
  c.paginatedSchema(c.feedbackReviewSchema).parse(await g('/feedback'));
  c.walletSchema.parse(await g('/wallet'));
  const txs = c.paginatedSchema(c.walletTransactionSchema).parse(await g('/wallet/transactions'));
  c.walletTransactionSchema.parse(await g(`/wallet/transactions/${txs.items[0]!.id}`));
  c.notificationPreferencesSchema.parse(await g('/me/notification-settings'));
  c.notificationPreferencesSchema.parse((await t.call('PUT', '/me/notification-settings', { token, body: { cashbackUpdates: true, partnerUpdates: false } })).body);
  expect((await t.call('POST', '/devices', { token, body: { token: 'ExponentPushToken[x]' } })).status).toBe(204);
  c.sessionSchema.parse((await t.call('POST', '/auth/refresh', { body: { refreshToken: auth.session.refreshToken } })).body);
  t.advance(61_000);
  c.otpChallengeSchema.parse((await t.call('POST', '/auth/otp/request', { body: { phone: '+994551234567' } })).body);
});

it('fiscal receipt responses parse with the app schemas', { timeout: 120_000 }, async () => {
  const t = await setup({}, { fiscal: fixtureProvider(new Map(ALL.map((d) => [d.receipt.fiscalId, d]))) });
  const [r] = await t.db.insert(restaurants).values({ name: 'Dolma House', cashbackBps: 250, voen: '3333333333' }).returning();
  await t.db.insert(branches).values({ restaurantId: r!.id, name: 'Nizami', objectCode: '3333333333-20001' });
  const token = (await t.signInPhone()).session.accessToken;
  const scan = async (fiscalId: string) =>
    c.receiptSchema.parse((await t.call('POST', '/receipts/resolve', { token, body: { kind: 'qr', value: qr(fiscalId) } })).body);

  const supermarket = await scan(TAM_STORE.receipt.fiscalId);
  expect(supermarket.fiscal?.classification.businessType).toBe('supermarket');
  expect(supermarket.fiscal?.eligibility.ratingAllowed).toBe(false);

  const partner = await scan(PARTNER_RESTAURANT.receipt.fiscalId);
  expect(partner.fiscal?.eligibility.cashbackAllowed).toBe(true);
  const reward = c.feedbackResultSchema.parse(
    (await t.call('POST', '/feedback', { token, body: { receiptItemId: partner.items[0]!.id, rating: 5 } })).body,
  );
  expect(reward.reward.status).toBe('confirmed');
  const after = c.receiptSchema.parse((await t.call('GET', `/receipts/${partner.id}`, { token })).body);
  expect(after.items[0]!.line?.cashbackClaimed).toBe(true);

  const list = c.receiptListSchema.parse((await t.call('GET', '/receipts', { token })).body);
  expect(list.items.map((i) => i.id).sort()).toEqual([supermarket.id, partner.id].sort());
});
