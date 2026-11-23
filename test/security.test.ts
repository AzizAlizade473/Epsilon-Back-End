/** Regression tests for the security audit (docs/SECURITY_AUDIT.md in the app repo). */
import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { branches, ledgerEntries, otpChallenges, restaurants } from '../src/db/schema.js';
import { sha256 } from '../src/lib/crypto.js';
import { qr } from './fiscal-fixtures.js';
import { setup } from './helpers.js';

const KEY = 'test-partner-key-0123456789abcdefghijklmnop';
const VOEN = '3333333333';
const line = (lineNo: number, name: string, quantityMilli: number, unitPriceMinor: number, lineTotalMinor: number, discountMinor: number | null = null) => ({
  lineNo, originalName: name, normalizedName: name, quantityMilli, unit: 'porsiya', unitPriceMinor, lineTotalMinor, discountMinor, vatRatePercent: null, vatMinor: null,
});
const posReceipt = (fiscalId: string, voen: string | null = VOEN, items = [line(1, 'YARPAQ DOLMASI', 1000, 1200, 1200), line(2, 'ŞORBA', 1000, 600, 600)]) => {
  const total = items.reduce((sum, i) => sum + i.lineTotalMinor, 0);
  return {
    merchant: { displayName: 'DOLMA HOUSE', legalName: null, voen, objectName: null, objectCode: null, address: null, city: null },
    receipt: {
      fiscalId, number: '1', documentId: null, type: 'sale', issuedAt: '2026-11-12T20:00:00+04:00', currency: 'AZN', totalMinor: total,
      subtotalMinor: null, discountMinor: null, vatMinor: null, vatBreakdown: [],
      payment: { method: 'cashless', cashMinor: null, cashlessMinor: total, bonusMinor: null, changeMinor: null },
    },
    items,
    device: { model: null, serialNumber: null, nmqRegistrationNumber: null },
    additionalFields: {},
  };
};

async function withPartner(overrides: Record<string, string> = {}, voen: string | null = VOEN) {
  const t = await setup(overrides);
  const [r] = await t.db.insert(restaurants).values({ name: 'Dolma House', cashbackBps: 250, voen, posKeyHash: sha256(KEY) }).returning();
  await t.db.insert(branches).values({ restaurantId: r!.id, name: 'Nizami' });
  const send = (body: unknown) =>
    t.app.inject({ method: 'POST', url: '/v1/partner/receipts', headers: { 'x-partner-key': KEY }, payload: body as object });
  return { t, send };
}

const phone = (i: number) => `+99450${1_000_000 + i}`;

describe('A. rate limits behind the reverse proxy', () => {
  const otp = (t: Awaited<ReturnType<typeof setup>>, i: number, forwardedFor: string) =>
    t.app.inject({ method: 'POST', url: '/v1/auth/otp/request', headers: { 'x-forwarded-for': forwardedFor }, payload: { phone: phone(i) } });

  it('with TRUST_PROXY each client has its own per-IP budget', async () => {
    const t = await setup({ TRUST_PROXY: '127.0.0.1' });
    for (let i = 0; i < 10; i++) expect((await otp(t, i, '203.0.113.1')).statusCode).toBe(200);
    expect((await otp(t, 10, '203.0.113.1')).statusCode).toBe(429);
    // Another customer behind the same proxy is not locked out.
    expect((await otp(t, 11, '203.0.113.2')).statusCode).toBe(200);
  });

  it('without TRUST_PROXY a forged X-Forwarded-For does not buy a fresh budget', async () => {
    const t = await setup();
    for (let i = 0; i < 10; i++) expect((await otp(t, i, `198.51.100.${i}`)).statusCode).toBe(200);
    expect((await otp(t, 10, '198.51.100.99')).statusCode).toBe(429);
  });
});

describe('F. e-mailed login codes are capped (demo provider)', () => {
  const gmail = { SMS_PROVIDER: 'gmail', GMAIL_USER: 'demo@example.com', GMAIL_APP_PASSWORD: 'abcdefghijklmnop' };

  it('one inbox gets at most 5 codes an hour, whatever phones are typed', async () => {
    const t = await setup(gmail);
    for (let i = 0; i < 5; i++)
      expect((await t.call('POST', '/auth/otp/request', { body: { phone: phone(i), email: 'victim@example.com' } })).status).toBe(200);
    const sixth = await t.call('POST', '/auth/otp/request', { body: { phone: phone(5), email: 'Victim@Example.com' } });
    expect(sixth.status).toBe(429);
    expect(t.sent).toHaveLength(5);
    // Other inboxes still work.
    expect((await t.call('POST', '/auth/otp/request', { body: { phone: phone(6), email: 'other@example.com' } })).status).toBe(200);
  });

  it('a daily cap protects the sending account', async () => {
    const t = await setup({ ...gmail, OTP_EMAIL_MAX_PER_DAY: '3' });
    for (let i = 0; i < 3; i++)
      expect((await t.call('POST', '/auth/otp/request', { body: { phone: phone(i), email: `u${i}@example.com` } })).status).toBe(200);
    expect((await t.call('POST', '/auth/otp/request', { body: { phone: phone(3), email: 'u3@example.com' } })).status).toBe(429);
    t.advance(86_400_000 + 1000);
    expect((await t.call('POST', '/auth/otp/request', { body: { phone: phone(4), email: 'u4@example.com' } })).status).toBe(200);
  });
});

describe('A. account deletion', () => {
  it('erases the login challenges that carry the phone and e-mail', async () => {
    const t = await setup();
    const auth = await t.signInPhone(phone(1));
    expect((await t.db.select({ n: count() }).from(otpChallenges).where(eq(otpChallenges.phone, phone(1))))[0]!.n).toBe(1);
    expect((await t.call('DELETE', '/me', { token: auth.session.accessToken })).status).toBe(204);
    expect((await t.db.select({ n: count() }).from(otpChallenges).where(eq(otpChallenges.phone, phone(1))))[0]!.n).toBe(0);
  });
});

describe('B. no access to another account', () => {
  it('receipts, items and transactions of another user are invisible and unratable', async () => {
    const { t, send } = await withPartner();
    expect((await send(posReceipt('TESTFISC0501'))).statusCode).toBe(201);
    const alice = (await t.signInPhone(phone(1))).session.accessToken as string;
    const bob = (await t.signInPhone(phone(2))).session.accessToken as string;
    const scan = await t.call('POST', '/receipts/resolve', { token: alice, body: { kind: 'qr', value: qr('TESTFISC0501') } });
    expect(scan.status).toBe(200);
    const rated = await t.call('POST', '/feedback', { token: alice, body: { receiptItemId: scan.body.items[0].id, rating: 5 } });
    expect(rated.body.reward.status).toBe('confirmed');
    const [entry] = await t.db.select({ id: ledgerEntries.id }).from(ledgerEntries);

    expect((await t.call('GET', `/receipts/${scan.body.id}`, { token: bob })).status).toBe(404);
    expect((await t.call('GET', `/wallet/transactions/${entry!.id}`, { token: bob })).status).toBe(404);
    expect((await t.call('GET', '/receipts', { token: bob })).body.items).toEqual([]);
    const steal = await t.call('POST', '/feedback', { token: bob, body: { receiptItemId: scan.body.items[1].id, rating: 5 } });
    expect(steal.status).toBe(422);
    expect((await t.call('GET', '/wallet', { token: bob })).body.balanceMinor).toBe(0);
  });

  it('a forged account field in the profile update is refused', async () => {
    const t = await setup();
    const token = (await t.signInPhone(phone(1))).session.accessToken as string;
    const res = await t.call('PATCH', '/me', { token, body: { firstName: 'A', phoneVerifiedAt: null, id: crypto.randomUUID() } });
    expect(res.status).toBe(422);
  });
});

describe('C. cashback is paid on what was charged', () => {
  it('a discounted partner line pays on its line total, not the list price', async () => {
    const { t, send } = await withPartner();
    // 2 × 10.00 with a 15.00 discount: the customer paid 5.00 for the line.
    const items = [line(1, 'KABAB', 2000, 1000, 500, 1500), line(2, 'ŞORBA', 1000, 600, 600)];
    expect((await send(posReceipt('TESTFISC0502', VOEN, items))).statusCode).toBe(201);
    const token = (await t.signInPhone(phone(1))).session.accessToken as string;
    const scan = await t.call('POST', '/receipts/resolve', { token, body: { kind: 'qr', value: qr('TESTFISC0502') } });
    expect(scan.body.rewardHint.amountMinor).toBe(12 + 15);
    const rated = await t.call('POST', '/feedback', { token, body: { receiptItemId: scan.body.items[0].id, rating: 4 } });
    expect(rated.body.reward).toEqual({ status: 'confirmed', amountMinor: 12 });
  });
});

describe('C. partner receipts belong to the partner', () => {
  it('a receipt without the partner VOEN is refused', async () => {
    const { send } = await withPartner();
    expect((await send(posReceipt('TESTFISC0503', null))).statusCode).toBe(403);
    expect((await send(posReceipt('TESTFISC0504', '9999999999'))).statusCode).toBe(403);
    expect((await send(posReceipt('TESTFISC0505'))).statusCode).toBe(201);
  });

  it('a partner with no VOEN on file cannot ingest receipts', async () => {
    const { send } = await withPartner({}, null);
    expect((await send(posReceipt('TESTFISC0506'))).statusCode).toBe(403);
  });
});

describe('E. forged pagination cursors', () => {
  it('a cursor with a non-date sort value is a validation error, not a 500', async () => {
    const t = await setup();
    const token = (await t.signInPhone(phone(1))).session.accessToken as string;
    const cursor = Buffer.from(JSON.stringify(['not-a-date', crypto.randomUUID()])).toString('base64url');
    for (const path of ['/wallet/transactions', '/feedback'])
      expect((await t.call('GET', `${path}?cursor=${cursor}`, { token })).status).toBe(422);
  });
});
