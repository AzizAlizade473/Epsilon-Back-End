import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  t = await setup();
});

const PHONE = '+994501112233';

describe('phone OTP sign-in', () => {
  it('creates an account on first verify and signs in the same account later', async () => {
    const first = await t.signInPhone(PHONE);
    expect(first.isNewUser).toBe(true);
    expect(first.nextStep).toBe('profile');
    expect(first.user).toMatchObject({ phone: PHONE, phoneVerified: true, firstName: null });
    expect(first.user.identities).toEqual([
      expect.objectContaining({ provider: 'phone', email: null, emailVerified: false }),
    ]);
    expect(first.session.accessToken).toBeTruthy();

    const second = await t.signInPhone(PHONE);
    expect(second.isNewUser).toBe(false);
    expect(second.user.id).toBe(first.user.id);
  });

  it('normalises local formats to the same account', async () => {
    const a = await t.signInPhone('050 111 22 33');
    const b = await t.signInPhone('+994 50 111 22 33');
    expect(b.user.id).toBe(a.user.id);
  });

  it('stores only a hash of the code', async () => {
    await t.call('POST', '/auth/otp/request', { body: { phone: PHONE } });
    const code = t.sent.at(-1)!.code;
    const rows = await t.db.execute(sql`select code_hash from otp_challenges`);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(`"${code}"`);
    expect(stored).toMatch(/[0-9a-f]{64}/);
  });

  it('rejects a wrong code and locks the challenge after 5 attempts', async () => {
    await t.call('POST', '/auth/otp/request', { body: { phone: PHONE } });
    const code = t.sent.at(-1)!.code;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const res = await t.call('POST', '/auth/otp/verify', { body: { phone: PHONE, code: wrong } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('OTP_INVALID');
    }
    const locked = await t.call('POST', '/auth/otp/verify', { body: { phone: PHONE, code } });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('OTP_TOO_MANY');
  });

  it('rejects an expired code and a reused code', async () => {
    await t.call('POST', '/auth/otp/request', { body: { phone: PHONE } });
    const code = t.sent.at(-1)!.code;
    t.advance(121_000);
    const expired = await t.call('POST', '/auth/otp/verify', { body: { phone: PHONE, code } });
    expect(expired.body.error.code).toBe('OTP_EXPIRED');

    await t.signInPhone(PHONE);
    const reuse = await t.call('POST', '/auth/otp/verify', { body: { phone: PHONE, code: t.sent.at(-1)!.code } });
    expect(reuse.body.error.code).toBe('OTP_EXPIRED');
  });

  it('rate-limits resends per phone with Retry-After', async () => {
    await t.call('POST', '/auth/otp/request', { body: { phone: PHONE } });
    const again = await t.call('POST', '/auth/otp/request', { body: { phone: PHONE } });
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('RATE_LIMITED');
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('validates input and never echoes it', async () => {
    const bad = await t.call('POST', '/auth/otp/request', { body: { phone: '12345' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(bad.body)).not.toContain('12345');

    const extra = await t.call('POST', '/auth/otp/request', { body: { phone: PHONE, admin: true } });
    expect(extra.status).toBe(422);
  });

  it('honours login / register intent without side effects', async () => {
    await t.call('POST', '/auth/otp/request', { body: { phone: PHONE, intent: 'login' } });
    const res = await t.call('POST', '/auth/otp/verify', {
      body: { phone: PHONE, code: t.sent.at(-1)!.code, intent: 'login' },
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_FOUND');
    const users = await t.db.execute(sql`select count(*)::int as n from users`);
    expect(JSON.stringify(users)).toContain('"n":0');
  });
});

describe('sessions', () => {
  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const { session } = await t.signInPhone(PHONE);
    const rotated = await t.call('POST', '/auth/refresh', { body: { refreshToken: session.refreshToken } });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(session.refreshToken);

    // Old token presented again → reuse detected.
    const reuse = await t.call('POST', '/auth/refresh', { body: { refreshToken: session.refreshToken } });
    expect(reuse.status).toBe(401);
    // The legitimately rotated token is revoked too, and so is its access token.
    const after = await t.call('POST', '/auth/refresh', { body: { refreshToken: rotated.body.refreshToken } });
    expect(after.status).toBe(401);
    expect((await t.call('GET', '/me', { token: rotated.body.accessToken })).status).toBe(401);
  });

  it('rejects expired access tokens and accepts refreshed ones', async () => {
    const { session } = await t.signInPhone(PHONE);
    expect((await t.call('GET', '/me', { token: session.accessToken })).status).toBe(200);
    t.advance(16 * 60_000);
    const expired = await t.call('GET', '/me', { token: session.accessToken });
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('UNAUTHORIZED');
    const refreshed = await t.call('POST', '/auth/refresh', { body: { refreshToken: session.refreshToken } });
    expect((await t.call('GET', '/me', { token: refreshed.body.accessToken })).status).toBe(200);
  });

  it('logout revokes access and refresh tokens', async () => {
    const { session } = await t.signInPhone(PHONE);
    expect((await t.call('POST', '/auth/logout', { token: session.accessToken })).status).toBe(204);
    expect((await t.call('GET', '/me', { token: session.accessToken })).status).toBe(401);
    expect((await t.call('POST', '/auth/refresh', { body: { refreshToken: session.refreshToken } })).status).toBe(401);
  });

  it('rejects forged tokens', async () => {
    expect((await t.call('GET', '/me', { token: 'not-a-jwt' })).status).toBe(401);
    expect((await t.call('GET', '/me')).status).toBe(401);
  });
});

describe('Google, linking, profile, deletion', () => {
  it('never links a Google account to a phone account by email', async () => {
    t.googleAccounts.set('tok-1', { sub: 'g-1', email: 'demo@example.com', emailVerified: true });
    const phone = await t.signInPhone(PHONE);
    const google = await t.call('POST', '/auth/google', { body: { idToken: 'tok-1' } });
    expect(google.status).toBe(200);
    expect(google.body.isNewUser).toBe(true);
    expect(google.body.user.id).not.toBe(phone.user.id);
    expect(google.body.user.identities[0]).toMatchObject({ provider: 'google', email: 'demo@example.com' });
    expect(JSON.stringify(google.body)).not.toContain('g-1'); // provider subject never leaves the server

    const bad = await t.call('POST', '/auth/google', { body: { idToken: 'unknown' } });
    expect(bad.body.error.code).toBe('SOCIAL_TOKEN_INVALID');
  });

  it('links a phone with OTP and refuses a phone owned by someone else', async () => {
    await t.signInPhone(PHONE); // phone owner
    t.googleAccounts.set('tok-2', { sub: 'g-2', email: 'x@example.com', emailVerified: true });
    const { session } = (await t.call('POST', '/auth/google', { body: { idToken: 'tok-2' } })).body;

    const taken = await t.call('POST', '/me/phone/otp/request', { token: session.accessToken, body: { phone: PHONE } });
    expect(taken.body.error.code).toBe('PHONE_IN_USE');

    const other = '+994552223344';
    await t.call('POST', '/me/phone/otp/request', { token: session.accessToken, body: { phone: other } });
    const linked = await t.call('POST', '/me/phone/otp/verify', {
      token: session.accessToken,
      body: { phone: other, code: t.sent.at(-1)!.code },
    });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ phone: other, phoneVerified: true });
    expect(linked.body.identities.map((i: { provider: string }) => i.provider).sort()).toEqual(['google', 'phone']);
  });

  it('updates the profile, enforces the age gate and returns nextStep', async () => {
    const { session } = await t.signInPhone(PHONE);
    const young = await t.call('PATCH', '/me', { token: session.accessToken, body: { birthDate: '2015-01-01' } });
    expect(young.body.error.code).toBe('AGE_RESTRICTED');
    const ok = await t.call('PATCH', '/me', {
      token: session.accessToken,
      body: { firstName: 'Aysel', lastName: 'Demo', birthDate: '2000-05-20', language: 'en' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.nextStep).toBe('home');
    expect(ok.body.user).toMatchObject({ firstName: 'Aysel', birthDate: '2000-05-20', language: 'en' });
  });

  it('deletes only after recent sign-in, erases personal data and frees the phone', async () => {
    const first = await t.signInPhone(PHONE);
    t.advance(11 * 60_000);
    const refreshed = await t.call('POST', '/auth/refresh', { body: { refreshToken: first.session.refreshToken } });
    const stale = await t.call('DELETE', '/me', { token: refreshed.body.accessToken });
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe('REAUTH_REQUIRED');

    const fresh = await t.signInPhone(PHONE);
    expect((await t.call('DELETE', '/me', { token: fresh.session.accessToken })).status).toBe(204);
    expect((await t.call('GET', '/me', { token: fresh.session.accessToken })).status).toBe(401);

    const again = await t.signInPhone(PHONE);
    expect(again.isNewUser).toBe(true);
    expect(again.user.id).not.toBe(first.user.id);
  });
});
