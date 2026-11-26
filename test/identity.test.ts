import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nameClaim } from '../src/auth/google.js';
import { loadConfig } from '../src/config.js';
import { authIdentities, otpChallenges, users } from '../src/db/schema.js';
import { mailer } from '../src/mail/mailer.js';
import { renderMail } from '../src/mail/template.js';
import { setup } from './helpers.js';

type T = Awaited<ReturnType<typeof setup>>;
let t: T;
beforeEach(async () => {
  t = await setup();
});

const PHONE = '+994501112233';
const lastCode = (s: T = t) => s.sent.at(-1)!.code;
const wrongCode = (code: string) => (code === '000000' ? '111111' : '000000');

async function signInEmail(email: string, s: T = t) {
  const req = await s.call('POST', '/auth/otp/request', { body: { email } });
  if (req.status !== 200) throw new Error(`otp request ${req.status} ${JSON.stringify(req.body)}`);
  const res = await s.call('POST', '/auth/otp/verify', { body: { email, code: lastCode(s) } });
  if (res.status !== 200) throw new Error(`otp verify ${res.status} ${JSON.stringify(res.body)}`);
  s.advance(61_000);
  return { ...res.body, token: res.body.session.accessToken as string };
}

async function google(sub: string, email: string, extra: { givenName?: string; familyName?: string } = {}) {
  t.googleAccounts.set(sub, { sub, email, emailVerified: true, ...extra });
  const res = await t.call('POST', '/auth/google', { body: { idToken: sub } });
  expect(res.status).toBe(200);
  return { ...res.body, token: res.body.session.accessToken as string };
}

const emails = async (token: string) => (await t.call('GET', '/me/emails', { token })).body;

async function addEmail(token: string, email: string, makePrimary = false) {
  await t.call('POST', '/me/emails/request', { token, body: { email, makePrimary } });
  const res = await t.call('POST', '/me/emails/verify', { token, body: { email, code: lastCode() } });
  t.advance(61_000);
  return res;
}

describe('e-mail OTP sign-in', () => {
  it('creates a phone-less account, normalises the address and signs into it again', async () => {
    const req = await t.call('POST', '/auth/otp/request', { body: { email: '  Aysel@Example.COM ' } });
    expect(req.body).toMatchObject({ delivery: 'email', sentTo: 'a***@example.com', retryAfterSeconds: 60 });
    expect(t.mails.at(-1)).toMatchObject({ kind: 'otp', purpose: 'signin', to: 'aysel@example.com', minutes: 2 });
    const first = await t.call('POST', '/auth/otp/verify', { body: { email: 'AYSEL@example.com', code: lastCode() } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ isNewUser: true, nextStep: 'profile' });
    expect(first.body.user).toMatchObject({ phone: null, phoneVerified: false, email: 'aysel@example.com' });
    expect(first.body.user.identities).toEqual([]); // installed apps reject provider "email"
    const token = first.body.session.accessToken;
    expect((await emails(token)).items).toEqual([expect.objectContaining({ email: 'aysel@example.com', primary: true })]);

    t.advance(61_000);
    const again = await signInEmail('aysel@example.com');
    expect(again).toMatchObject({ isNewUser: false });
    expect(again.user.id).toBe(first.body.user.id);
    const done = await t.call('PATCH', '/me', { token, body: { firstName: 'A', lastName: 'B', birthDate: '2000-01-01' } });
    expect(done.body.nextStep).toBe('home'); // never "phone"
    expect((await t.call('GET', '/config')).body.requirePhoneVerification).toBe(false);
  });

  it('honours the intent without sending anything', async () => {
    const unknown = await t.call('POST', '/auth/otp/request', { body: { email: 'a@x.com', intent: 'login' } });
    expect([unknown.status, unknown.body.error.code]).toEqual([404, 'ACCOUNT_NOT_FOUND']);
    expect(t.mails).toHaveLength(0);
    await signInEmail('a@x.com');
    const known = await t.call('POST', '/auth/otp/request', { body: { email: 'a@x.com', intent: 'register' } });
    expect([known.status, known.body.error.code]).toEqual([409, 'ACCOUNT_EXISTS']);
    expect(t.mails).toHaveLength(1);
  });

  it('codes are single use, expire and are superseded', async () => {
    const request = () => t.call('POST', '/auth/otp/request', { body: { email: 'a@x.com' } });
    const verify = (code: string) => t.call('POST', '/auth/otp/verify', { body: { email: 'a@x.com', code } });
    await request();
    const old = lastCode();
    t.advance(61_000);
    await request();
    const fresh = lastCode();
    if (old !== fresh) expect((await verify(old)).body.error.code).toBe('OTP_INVALID');
    expect((await verify(fresh)).status).toBe(200);
    // Neither the used code nor the older, still unexpired one works.
    for (const code of [fresh, old]) expect((await verify(code)).body.error.code).toBe('OTP_EXPIRED');

    t.advance(61_000);
    await request();
    t.advance(121_000);
    expect((await verify(lastCode())).body.error.code).toBe('OTP_EXPIRED');
  });

  it('locks a code after 5 wrong attempts', async () => {
    const verify = (code: string) => t.call('POST', '/auth/otp/verify', { body: { email: 'a@x.com', code } });
    await t.call('POST', '/auth/otp/request', { body: { email: 'a@x.com' } });
    for (let i = 0; i < 5; i++) expect((await verify(wrongCode(lastCode()))).body.error.code).toBe('OTP_INVALID');
    expect((await verify(lastCode())).body.error.code).toBe('OTP_TOO_MANY');
  });

  it('limits resends per address, and per hour', async () => {
    const request = () => t.call('POST', '/auth/otp/request', { body: { email: 'a@x.com' } });
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
    for (let i = 0; i < 4; i++) {
      t.advance(61_000);
      expect((await request()).status).toBe(200);
    }
    t.advance(61_000);
    expect((await request()).body.error.code).toBe('RATE_LIMITED');
    expect(t.mails).toHaveLength(5);
  });

  it('limits calls per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++)
      statuses.push((await t.call('POST', '/auth/otp/request', { body: { email: `u${i}@x.com` } })).status);
    expect(statuses.at(-1)).toBe(429);
  });

  it('stores nothing when the mail cannot be sent', async () => {
    t.mailDown.value = true;
    const res = await t.call('POST', '/auth/otp/request', { body: { email: 'a@x.com' } });
    expect([res.status, res.body.error.code]).toEqual([503, 'EMAIL_DELIVERY_FAILED']);
    expect(await t.db.select().from(otpChallenges)).toHaveLength(0);
    t.mailDown.value = false;
    expect((await t.call('POST', '/auth/otp/request', { body: { email: 'a@x.com' } })).status).toBe(200);
  });

  it('rejects malformed bodies without echoing them', async () => {
    for (const body of [{}, { email: 'nope-value' }, { email: 'a@x.com', admin: true }]) {
      const res = await t.call('POST', '/auth/otp/request', { body });
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).not.toContain('nope-value');
    }
    const both = await t.call('POST', '/auth/otp/verify', { body: { phone: PHONE, email: 'a@x.com', code: '123456' } });
    expect(both.status).toBe(422);
  });

  it('keeps sign-in codes and account codes apart', async () => {
    const me = await signInEmail('me@x.com');
    await t.call('POST', '/me/emails/request', { token: me.token, body: { email: 'two@x.com', makePrimary: false } });
    const res = await t.call('POST', '/auth/otp/verify', { body: { email: 'two@x.com', code: lastCode() } });
    expect(res.body.error.code).toBe('OTP_EXPIRED');
  });
});

describe('linking safety', () => {
  it('a Google account with another account’s e-mail stays separate and takes nothing', async () => {
    const mine = await signInEmail('same@x.com');
    const other = await google('g1', 'same@x.com');
    expect(other.isNewUser).toBe(true);
    expect(other.user.id).not.toBe(mine.user.id);
    expect((await emails(other.token)).items).toEqual([]);
    expect((await signInEmail('same@x.com')).user.id).toBe(mine.user.id);
  });

  it('a Google sign-up gets an e-mail identity, so e-mail login reaches the same account', async () => {
    const g = await google('g1', 'solo@x.com');
    expect(g.user.identities.map((i: { provider: string }) => i.provider)).toEqual(['google']);
    expect((await signInEmail('solo@x.com')).user.id).toBe(g.user.id);
  });

  it('the legacy phone shape records the proven inbox; an old account without e-mail cannot be opened with a typed one', async () => {
    const demo = await setup({ SMS_PROVIDER: 'gmail', GMAIL_USER: 'demo@example.com', GMAIL_APP_PASSWORD: 'abcdabcdabcdabcd' });
    const login = async (phone: string, email: string) => {
      await demo.call('POST', '/auth/otp/request', { body: { phone, email } });
      const res = await demo.call('POST', '/auth/otp/verify', { body: { phone, code: lastCode(demo) } });
      expect(res.status).toBe(200);
      demo.advance(61_000);
      return res.body;
    };
    const created = await login(PHONE, 'new@x.com');
    expect((await signInEmail('new@x.com', demo)).user.id).toBe(created.user.id);

    const [old] = await demo.db.insert(users).values({ phone: '+994552223344' }).returning();
    await demo.db.insert(authIdentities).values({ userId: old!.id, provider: 'phone', providerUserId: '+994552223344' });
    const sentBefore = demo.sent.length;
    const refused = await demo.call('POST', '/auth/otp/request', { body: { phone: '+994552223344', email: 'typed@x.com', intent: 'login' } });
    expect([refused.status, refused.body.error.code]).toEqual([409, 'PHONE_SIGNIN_UNAVAILABLE']);
    // Without an intent the answer looks like any other, and still nothing is sent.
    const quiet = await demo.call('POST', '/auth/otp/request', { body: { phone: '+994552223344', email: 'typed@x.com' } });
    expect([quiet.status, quiet.body.delivery]).toEqual([200, 'email']);
    const noEmail = await demo.call('POST', '/auth/otp/request', { body: { phone: '+994552223344' } });
    expect(noEmail.body.error.code).toBe('PHONE_SIGNIN_UNAVAILABLE');
    const register = await demo.call('POST', '/auth/otp/request', { body: { phone: '+994552223344', email: 'typed@x.com', intent: 'register' } });
    expect(register.body.error.code).toBe('ACCOUNT_EXISTS');
    expect(demo.sent).toHaveLength(sentBefore);
  });

  it('one network address asking for codes cannot lock the owner out of an e-mail', async () => {
    const t = await setup();
    const ask = (remoteAddress: string) =>
      t.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { email: 'owner@x.com' }, remoteAddress });
    expect((await ask('10.0.0.1')).statusCode).toBe(200);
    expect((await ask('10.0.0.1')).statusCode).toBe(429);
    expect((await ask('10.0.0.2')).statusCode).toBe(200);
  });

  it('a code sent before the number had an account cannot open that account', async () => {
    const demo = await setup({ SMS_PROVIDER: 'gmail', GMAIL_USER: 'demo@example.com', GMAIL_APP_PASSWORD: 'abcdabcdabcdabcd' });
    for (const [phone, email] of [[PHONE, null], ['+994552223344', 'owner@x.com']] as const) {
      await demo.call('POST', '/auth/otp/request', { body: { phone, email: 'attacker@x.com' } });
      const [user] = await demo.db.insert(users).values({ phone, email }).returning();
      await demo.db.insert(authIdentities).values({ userId: user!.id, provider: 'phone', providerUserId: phone });
      const res = await demo.call('POST', '/auth/otp/verify', { body: { phone, code: lastCode(demo) } });
      expect([res.status, res.body.error.code]).toEqual([409, 'PHONE_SIGNIN_UNAVAILABLE']);
    }
  });

  it('a signed-in user without e-mail can still link a number; with one, the code goes to the saved address', async () => {
    const demo = await setup({ SMS_PROVIDER: 'gmail', GMAIL_USER: 'demo@example.com', GMAIL_APP_PASSWORD: 'abcdabcdabcdabcd' });
    const me = await signInEmail('me@x.com', demo);
    const req = await demo.call('POST', '/me/phone/otp/request', { token: me.token, body: { phone: PHONE, email: 'other@x.com' } });
    expect(req.body).toMatchObject({ sentTo: 'm***@x.com' });
    // Someone else's number that has no saved e-mail stays refused as already used.
    const [old] = await demo.db.insert(users).values({ phone: '+994552223344' }).returning();
    await demo.db.insert(authIdentities).values({ userId: old!.id, provider: 'phone', providerUserId: '+994552223344' });
    const taken = await demo.call('POST', '/me/phone/otp/request', { token: me.token, body: { phone: '+994552223344', email: 'other@x.com' } });
    expect(taken.body.error.code).toBe('PHONE_IN_USE');
  });

  it('copies Google names into empty fields only', async () => {
    const g = await google('g1', 'n@x.com', { givenName: 'Aysel', familyName: 'Aliyeva' });
    expect(g.user).toMatchObject({ firstName: 'Aysel', lastName: 'Aliyeva' });
    await t.call('PATCH', '/me', { token: g.token, body: { firstName: 'Own' } });
    const again = await google('g1', 'n@x.com', { givenName: 'Other', familyName: 'Other' });
    expect(again.user).toMatchObject({ firstName: 'Own', lastName: 'Aliyeva' });
    expect(again.nextStep).toBe('profile'); // birth date still missing
    expect([nameClaim('  '), nameClaim(5), nameClaim(` ${'a'.repeat(60)} `)]).toEqual([null, null, 'a'.repeat(50)]);
  });
});

describe('/me/emails', () => {
  it('adds an e-mail, switches the primary after verification and notifies the old one', async () => {
    const me = await signInEmail('old@x.com');
    const req = await t.call('POST', '/me/emails/request', { token: me.token, body: { email: ' New@X.com', makePrimary: true } });
    expect(req.body).toMatchObject({ delivery: 'email', sentTo: 'n***@x.com' });
    expect(t.mails.at(-1)).toMatchObject({ purpose: 'email', to: 'new@x.com' });
    const before = await emails(me.token);
    expect(before.pending).toMatchObject({ email: 'new@x.com', makePrimary: true });
    expect(before.items).toHaveLength(1);
    expect((await t.call('GET', '/me', { token: me.token })).body.email).toBe('old@x.com');

    const code = lastCode();
    const res = await t.call('POST', '/me/emails/verify', { token: me.token, body: { email: 'new@x.com', code } });
    expect(res.status).toBe(200);
    expect(res.body.pending).toBeNull();
    expect(res.body.items.map((i: { email: string; primary: boolean }) => [i.email, i.primary])).toEqual([
      ['new@x.com', true],
      ['old@x.com', false],
    ]);
    expect(t.mails.at(-1)).toMatchObject({ kind: 'primary_changed', to: 'old@x.com', newEmail: 'n***@x.com' });
    const reuse = await t.call('POST', '/me/emails/verify', { token: me.token, body: { email: 'new@x.com', code } });
    expect(reuse.body.error.code).toBe('OTP_EXPIRED');
    t.advance(61_000);
    expect((await signInEmail('old@x.com')).user.id).toBe(me.user.id);
  });

  it('refuses an address owned by someone else, at request and at verify', async () => {
    await signInEmail('taken@x.com');
    const me = await signInEmail('me@x.com');
    const taken = await t.call('POST', '/me/emails/request', { token: me.token, body: { email: 'Taken@x.com', makePrimary: false } });
    expect([taken.status, taken.body.error.code]).toEqual([409, 'EMAIL_IN_USE']);

    await t.call('POST', '/me/emails/request', { token: me.token, body: { email: 'race@x.com', makePrimary: true } });
    const code = lastCode();
    const [other] = await t.db.insert(users).values({ email: 'race@x.com' }).returning();
    await t.db.insert(authIdentities).values({ userId: other!.id, provider: 'email', providerUserId: 'race@x.com' });
    const late = await t.call('POST', '/me/emails/verify', { token: me.token, body: { email: 'race@x.com', code } });
    expect(late.body.error.code).toBe('EMAIL_IN_USE');
    expect((await t.call('GET', '/me', { token: me.token })).body.email).toBe('me@x.com');
  });

  it('replaces and cancels a pending change; the earlier code stops working', async () => {
    const me = await signInEmail('me@x.com');
    const request = (email: string) =>
      t.call('POST', '/me/emails/request', { token: me.token, body: { email, makePrimary: false } });
    const verify = (email: string, code: string) =>
      t.call('POST', '/me/emails/verify', { token: me.token, body: { email, code } });
    await request('one@x.com');
    const one = lastCode();
    await request('two@x.com');
    expect((await emails(me.token)).pending.email).toBe('two@x.com');
    expect((await verify('one@x.com', one)).body.error.code).toBe('OTP_EXPIRED');
    expect((await t.call('DELETE', '/me/emails/pending', { token: me.token })).status).toBe(204);
    expect((await emails(me.token)).pending).toBeNull();
    expect((await verify('two@x.com', lastCode())).body.error.code).toBe('OTP_EXPIRED');
  });

  it('another user cannot verify my code, and one user cannot mail endlessly', async () => {
    const me = await signInEmail('me@x.com');
    const other = await signInEmail('other@x.com');
    await t.call('POST', '/me/emails/request', { token: me.token, body: { email: 'a@x.com', makePrimary: false } });
    const stolen = await t.call('POST', '/me/emails/verify', { token: other.token, body: { email: 'a@x.com', code: lastCode() } });
    expect(stolen.body.error.code).toBe('OTP_EXPIRED');
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      t.advance(1_000);
      statuses.push(
        (await t.call('POST', '/me/emails/request', { token: me.token, body: { email: `v${i}@x.com`, makePrimary: false } })).status,
      );
    }
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
  });

  it('needs a recent sign-in to add or remove', async () => {
    const me = await signInEmail('me@x.com');
    t.advance(11 * 60_000);
    const fresh = (await t.call('POST', '/auth/refresh', { body: { refreshToken: me.session.refreshToken } })).body;
    for (const res of [
      await t.call('POST', '/me/emails/request', { token: fresh.accessToken, body: { email: 'a@x.com', makePrimary: false } }),
      await t.call('DELETE', '/me/emails/me%40x.com', { token: fresh.accessToken }),
    ])
      expect([res.status, res.body.error.code]).toEqual([403, 'REAUTH_REQUIRED']);
  });

  it('removes a secondary e-mail, never the primary or the last sign-in method', async () => {
    const me = await signInEmail('me@x.com');
    await addEmail(me.token, 'second@x.com');
    const remove = (email: string, key?: string) =>
      t.call('DELETE', `/me/emails/${encodeURIComponent(email)}`, { token: me.token, ...(key ? { key } : {}) });
    expect((await remove('me@x.com')).body.error.code).toBe('EMAIL_IS_PRIMARY');
    expect((await remove('nobody@x.com')).status).toBe(404);
    expect((await remove('Second@x.com', 'remove-key-1')).status).toBe(204);
    expect((await remove('me@x.com', 'remove-key-1')).status).toBe(422); // a key never answers for another address
    expect((await emails(me.token)).items).toHaveLength(1);

    // An account whose only identity is a non-primary e-mail keeps it.
    await t.db.update(users).set({ email: null });
    expect((await remove('me@x.com')).body.error.code).toBe('LAST_SIGN_IN_METHOD');
  });

  it('requires a sign-in', async () => {
    expect((await t.call('GET', '/me/emails')).status).toBe(401);
    expect((await t.call('DELETE', '/me/phone')).status).toBe(401);
  });

  it('account deletion frees the addresses and erases their codes', async () => {
    const me = await signInEmail('me@x.com');
    await addEmail(me.token, 'second@x.com');
    expect((await t.call('DELETE', '/me', { token: me.token })).status).toBe(204);
    expect(await t.db.select().from(otpChallenges)).toHaveLength(0);
    expect((await signInEmail('second@x.com')).isNewUser).toBe(true);
  });
});

describe('DELETE /me/phone', () => {
  it('removes the phone only while another way to sign in remains', async () => {
    const phone = await t.signInPhone(PHONE);
    const token = phone.session.accessToken;
    const only = await t.call('DELETE', '/me/phone', { token });
    expect([only.status, only.body.error.code]).toEqual([409, 'LAST_SIGN_IN_METHOD']);
    await addEmail(token, 'me@x.com');
    expect((await t.call('DELETE', '/me/phone', { token })).status).toBe(204);
    const me = (await t.call('GET', '/me', { token })).body;
    expect(me).toMatchObject({ phone: null, phoneVerified: false, email: 'me@x.com', identities: [] });
    expect((await t.call('DELETE', '/me/phone', { token })).status).toBe(204); // already gone
    expect((await t.signInPhone(PHONE)).user.id).not.toBe(me.id);
  });
});

describe('mailer', () => {
  const base = { DATABASE_URL: 'postgres://unused', JWT_SECRET: 'x'.repeat(40), OTP_SECRET: 'y'.repeat(40) };
  const smtp = { SMTP_HOST: 'mail.example.com', SMTP_USER: 'info@example.com', SMTP_PASS: 'p', MAIL_FROM: 'Epsilon <info@example.com>' };
  const gmail = { GMAIL_USER: 'demo@gmail.com', GMAIL_APP_PASSWORD: 'abcd abcd abcd abcd' };
  const otpMail = { kind: 'otp', to: 'a@x.com', language: 'en', code: '123456', minutes: 2, purpose: 'signin' } as const;

  function fake(env: Record<string, string>, error?: Error) {
    const messages: any[] = [];
    const options: any[] = [];
    const send = mailer(loadConfig({ ...base, ...env }), ((o: unknown) => {
      options.push(o);
      return { sendMail: async (m: unknown) => (error ? Promise.reject(error) : void messages.push(m)) };
    }) as never);
    return { send, messages, options };
  }

  it('uses SMTP with MAIL_FROM when configured, else the Gmail account as itself', async () => {
    expect(() => loadConfig({ ...base, SMTP_HOST: 'mail.example.com' })).toThrow(/MAIL_FROM/);
    const own = fake({ ...smtp, ...gmail });
    await own.send(otpMail);
    expect(own.options[0]).toMatchObject({ host: 'mail.example.com', port: 587, secure: false, requireTLS: true });
    expect(own.messages[0]).toMatchObject({ from: smtp.MAIL_FROM, to: 'a@x.com' });
    expect(own.messages[0].attachments[0].cid).toBe('epsilon-logo');
    expect(readFileSync(own.messages[0].attachments[0].path).subarray(1, 4).toString()).toBe('PNG');

    const fallback = fake({ ...gmail, MAIL_FROM: 'Epsilon <info@example.com>' });
    await fallback.send(otpMail);
    expect(fallback.messages[0].from).toBe('Epsilon <demo@gmail.com>');
  });

  it('reports a failed or missing transport without logging the code or address', async () => {
    const logs = [vi.spyOn(console, 'info'), vi.spyOn(console, 'warn')].map((s) => s.mockImplementation(() => {}));
    await expect(fake(smtp, new Error('550 a@x.com 123456')).send(otpMail)).rejects.toMatchObject({ code: 'EMAIL_DELIVERY_FAILED' });
    await expect(fake({ NODE_ENV: 'production', SMS_PROVIDER: 'none' }).send(otpMail)).rejects.toMatchObject({ status: 503 });
    await fake(smtp).send(otpMail);
    expect(JSON.stringify(logs.flatMap((s) => s.mock.calls))).not.toMatch(/123456|a@x\.com/);
    vi.restoreAllMocks();
  });

  it('renders az, en and ru with the code in the body, not the subject', () => {
    for (const language of ['az', 'en', 'ru']) {
      const out = renderMail({ ...otpMail, language });
      expect(out.html).toContain(`lang="${language}"`);
      expect(out.html).toContain('cid:epsilon-logo');
      expect(out.html).toContain('#282973');
      expect(out.html).toContain('123456');
      expect(out.text).toContain('123456');
      expect(out.subject).not.toContain('123456');
    }
    const notice = renderMail({ kind: 'primary_changed', to: 'a@x.com', language: 'en', newEmail: '<b>***@x.com' });
    expect(notice.html).not.toContain('<b>');
  });
});

describe('migration 0008 backfill', () => {
  it('adds identities only for proven, unshared addresses of live accounts', async () => {
    // A database at 0007, with data, then the real migration.
    const dir = mkdtempSync(join(tmpdir(), 'epsilon-mig-'));
    cpSync('drizzle', dir, { recursive: true });
    const journalPath = join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((e: { idx: number }) => e.idx < 8) }));
    const db = drizzle(new PGlite());
    await migrate(db, { migrationsFolder: dir });

    const user = async (name: string, email: string | null, phone: string | null = null, deleted = false) =>
      (
        await db.execute<{ id: string }>(
          sql`insert into users (first_name, email, phone, deleted_at) values (${name}, ${email}, ${phone}, ${deleted ? sql`now()` : null}) returning id`,
        )
      ).rows[0]!.id;
    const identity = (id: string, provider: string, subject: string, email: string | null, verified: boolean) =>
      db.execute(
        sql`insert into auth_identities (user_id, provider, provider_user_id, email, email_verified) values (${id}, ${provider}, ${subject}, ${email}, ${verified})`,
      );
    const challenge = (phone: string, email: string, consumed: boolean) =>
      db.execute(
        sql`insert into otp_challenges (phone, purpose, code_hash, email, expires_at, consumed_at) values (${phone}, 'signin', 'h', ${email}, now(), ${consumed ? sql`now()` : null})`,
      );

    await identity(await user('google', 'g@x.com'), 'google', 'g1', 'g@x.com', true);
    await identity(await user('phoneNew', 'p@x.com', '+1'), 'phone', '+1', 'p@x.com', true);
    await identity(await user('phoneLater', 'later@x.com', '+2'), 'phone', '+2', null, false);
    await challenge('+2', 'later@x.com', true);
    await identity(await user('unproven', 'u@x.com', '+3'), 'phone', '+3', null, false);
    await challenge('+3', 'u@x.com', false);
    await challenge('+9', 'u@x.com', true); // someone else's proof
    await identity(await user('sharedA', 'dup@x.com'), 'google', 'g2', 'dup@x.com', true);
    await identity(await user('sharedB', 'Dup@x.com ', '+4'), 'phone', '+4', null, false);
    await user('gone', 'del@x.com', null, true);

    await migrate(db, { migrationsFolder: 'drizzle' });
    const rows = await db.execute<{ first_name: string; provider_user_id: string; email_verified: boolean }>(
      sql`select u.first_name, i.provider_user_id, i.email_verified from auth_identities i join users u on u.id = i.user_id where i.provider = 'email' order by 2`,
    );
    expect(rows.rows.map((r) => [r.first_name, r.provider_user_id, r.email_verified])).toEqual([
      ['google', 'g@x.com', true],
      ['phoneLater', 'later@x.com', true],
      ['phoneNew', 'p@x.com', true],
    ]);
    const normalised = await db.execute<{ email: string }>(sql`select email from users where first_name = 'sharedB'`);
    expect(normalised.rows[0]!.email).toBe('dup@x.com');
    rmSync(dir, { recursive: true, force: true });
  });
});
