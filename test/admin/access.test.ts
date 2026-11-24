import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { adminAudit, adminSessions, adminUsers } from '../../src/db/schema.js';
import { adminSetup, AUD, seed, TEAM, type A } from './helpers.js';

const OPS = 'ops@epsilon.test';
const ANALYST = 'analyst@epsilon.test';
const SUPER = 'root@epsilon.test';
const auditRows = (t: A) => t.db.select().from(adminAudit);

describe('admin access control', async () => {
  const t = await adminSetup();
  await t.addAdmin(OPS, 'operations');
  await t.addAdmin(ANALYST, 'analyst');
  await t.addAdmin(SUPER, 'super_admin');
  await t.addAdmin('off@epsilon.test', 'analyst', 'disabled');
  await t.addAdmin('partner@epsilon.test', 'partner');
  const data = await seed(t);

  it('no Access JWT is 401', async () => {
    expect((await t.call('GET', '/me')).status).toBe(401);
    expect((await t.call('POST', '/session')).status).toBe(401);
  });

  it('bad signature, audience, issuer or expiry is 401', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    for (const token of [
      await t.jwt(OPS, { key: t.otherKey }),
      await t.jwt(OPS, { aud: 'someone-else-0123456789' }),
      await t.jwt(OPS, { iss: 'https://evil.example.com' }),
      await t.jwt(OPS, { exp: past }),
      'not.a.jwt',
    ])
      expect((await t.call('POST', '/session', { token })).status).toBe(401);
  });

  it('a valid JWT for an unknown email is 403 and audited; disabled and reserved roles are 403', async () => {
    expect((await t.call('POST', '/session', { as: 'stranger@epsilon.test' })).status).toBe(403);
    expect((await t.call('POST', '/session', { as: 'off@epsilon.test' })).status).toBe(403);
    expect((await t.call('POST', '/session', { as: 'partner@epsilon.test' })).status).toBe(403);
    const denied = (await auditRows(t)).filter((a) => a.outcome === 'denied').map((a) => `${a.action}:${a.entityId}`);
    expect(denied).toContain('access.unknown_admin:stranger@epsilon.test');
    expect(denied).toContain('access.disabled:off@epsilon.test');
    expect(denied).toContain('access.role_reserved:partner@epsilon.test');
  });

  it('login sets a hardened cookie, pins the Access identity, and /me works', async () => {
    const res = await t.call('POST', '/session', { as: OPS });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^__Host-epsilon_admin=[\w-]{43};/);
    for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) expect(cookie).toContain(flag);
    expect(cookie).not.toContain('Domain');
    expect(res.body.admin.permissions).toContain('reviews:moderate');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-frame-options']).toBe('DENY');
    const [row] = await t.db.select().from(adminUsers).where(eq(adminUsers.email, OPS));
    expect(row!.accessSub).toBe(`sub-${OPS}`);
    const session = { cookie: cookie.split(';')[0]!, csrf: res.body.csrfToken };
    const me = await t.call('GET', '/me', { as: OPS, session });
    expect(me.body.csrfToken).toBe(session.csrf);
    // A later login with a different Access identity for the same email is refused.
    expect((await t.call('POST', '/session', { token: await t.jwt(OPS, { sub: 'someone-else' }) })).status).toBe(403);
  });

  it('every route needs a session; a consumer token grants nothing', async () => {
    expect((await t.call('GET', '/overview', { as: OPS })).status).toBe(401); // Access JWT but no session
    const consumer = await t.signInPhone('+994509998877');
    const res = await t.app.inject({ method: 'GET', url: '/admin/api/overview', headers: { authorization: `Bearer ${consumer.session.accessToken}` } });
    expect(res.statusCode).toBe(404); // public listener
    const direct = await t.admin.inject({ method: 'GET', url: '/admin/api/overview', headers: { authorization: `Bearer ${consumer.session.accessToken}` } });
    expect(direct.statusCode).toBe(401);
  });

  it('a session of admin A with the Access JWT of admin B is 401', async () => {
    const a = await t.login(OPS);
    expect((await t.call('GET', '/overview', { as: ANALYST, session: a })).status).toBe(401);
  });

  it('non-GET needs the CSRF token', async () => {
    const s = await t.login(OPS);
    const body = { hidden: true, reason: 'spam review' };
    const url = `/reviews/${data.fb2.id}/moderate`;
    expect((await t.call('POST', url, { as: OPS, session: s, body, csrf: false })).status).toBe(403);
    expect((await t.call('POST', url, { as: OPS, session: s, body, csrf: 'wrong' })).status).toBe(403);
    expect((await auditRows(t)).some((a) => a.action === 'csrf.invalid' && a.outcome === 'denied')).toBe(true);
  });

  it('roles: analyst cannot moderate, edit or reveal; operations cannot reveal or read audit; super_admin can', async () => {
    const analyst = t.as(ANALYST, await t.login(ANALYST));
    expect((await analyst('POST', `/reviews/${data.fb2.id}/moderate`, { body: { hidden: true, reason: 'nope nope' } })).status).toBe(403);
    expect((await analyst('PATCH', `/restaurants/r:${data.r1.id}`, { body: { name: 'X' } })).status).toBe(403);
    expect((await analyst('POST', `/users/${data.u1.id}/reveal`, { body: { reason: 'support ticket' } })).status).toBe(403);
    expect((await analyst('GET', '/overview')).status).toBe(200);

    const ops = t.as(OPS, await t.login(OPS));
    expect((await ops('POST', `/users/${data.u1.id}/reveal`, { body: { reason: 'support ticket' } })).status).toBe(403);
    expect((await ops('GET', '/audit')).status).toBe(403);

    const root = t.as(SUPER, await t.login(SUPER));
    expect((await root('POST', `/users/${data.u1.id}/reveal`, { body: { reason: 'x' } })).status).toBe(422); // reason too short
    const reveal = await root('POST', `/users/${data.u1.id}/reveal`, { body: { reason: 'support ticket 42' } });
    expect(reveal.status).toBe(200);
    expect(reveal.body).toEqual({ email: 'aziz.secret@gmail.com', phone: '+994551234555' });
    const entry = (await auditRows(t)).find((a) => a.action === 'user.reveal')!;
    expect(entry).toMatchObject({ entityId: data.u1.id, reason: 'support ticket 42', outcome: 'ok' });
    expect(JSON.stringify(entry)).not.toContain('aziz.secret');
    expect((await root('GET', '/audit')).body.items.length).toBeGreaterThan(0);
    expect((await auditRows(t)).some((a) => a.action === 'permission.denied' && a.outcome === 'denied')).toBe(true);
  });

  it('idle timeout, absolute timeout and logout end the session', async () => {
    const s = await t.login(OPS);
    t.advance(31 * 60_000);
    expect((await t.call('GET', '/me', { as: OPS, session: s })).status).toBe(401);

    const kept = await t.login(OPS);
    for (let i = 0; i < 17; i++) {
      t.advance(29 * 60_000); // active, so never idle
      expect((await t.call('GET', '/me', { as: OPS, session: kept })).status).toBe(i < 16 ? 200 : 401); // 8 h absolute cap
    }

    const out = await t.login(OPS);
    const res = await t.call('POST', '/logout', { as: OPS, session: out });
    expect(res.status).toBe(204);
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await t.call('GET', '/me', { as: OPS, session: out })).status).toBe(401);
  });

  it('a new login rotates the token and revokes the one it replaces', async () => {
    const first = await t.login(OPS);
    const res = await t.call('POST', '/session', { as: OPS, headers: { cookie: first.cookie } });
    const second = { cookie: String(res.headers['set-cookie']).split(';')[0]!, csrf: res.body.csrfToken };
    expect(second.cookie).not.toBe(first.cookie);
    expect((await t.call('GET', '/me', { as: OPS, session: first })).status).toBe(401);
    expect((await t.call('GET', '/me', { as: OPS, session: second })).status).toBe(200);
  });

  it('disabling an admin or revoking sessions blocks existing sessions', async () => {
    await t.addAdmin('temp@epsilon.test', 'analyst');
    const s = await t.login('temp@epsilon.test');
    await t.db.update(adminSessions).set({ revokedAt: new Date(t.clock.now) });
    expect((await t.call('GET', '/me', { as: 'temp@epsilon.test', session: s })).status).toBe(401);
    await t.db.update(adminUsers).set({ status: 'disabled' }).where(eq(adminUsers.email, 'temp@epsilon.test'));
    expect((await t.call('POST', '/session', { as: 'temp@epsilon.test' })).status).toBe(403);
  });

  it('the public app never serves /admin', async () => {
    for (const [method, url] of [['GET', '/admin/api/overview'], ['POST', '/admin/api/session'], ['GET', '/admin'], ['GET', '/ADMIN/api/me'], ['GET', '/admin/']] as const)
      expect((await t.app.inject({ method, url })).statusCode).toBe(404);
  });
});

describe('admin switches and config', () => {
  it('ADMIN_ENABLED=false answers 404 everywhere', async () => {
    const t = await adminSetup({ ADMIN_ENABLED: 'false' });
    await t.addAdmin(OPS, 'operations');
    expect((await t.call('POST', '/session', { as: OPS })).status).toBe(404);
    expect((await t.call('GET', '/me', { as: OPS })).status).toBe(404);
  });

  it('config refuses unsafe combinations', () => {
    const base = { NODE_ENV: 'production', DATABASE_URL: 'postgres://x', JWT_SECRET: 'j'.repeat(32), OTP_SECRET: 'o'.repeat(32), SMS_PROVIDER: 'none' };
    const cf = { ADMIN_CF_TEAM_DOMAIN: TEAM, ADMIN_CF_AUD: AUD, ADMIN_DATABASE_URL: 'postgres://ro' };
    expect(() => loadConfig({ ...base, ADMIN_DEV_EMAIL: 'dev@epsilon.test' })).toThrow(/ADMIN_DEV_EMAIL/);
    expect(() => loadConfig({ ...base, ADMIN_ENABLED: 'true' })).toThrow();
    expect(() => loadConfig({ ...base, ADMIN_ENABLED: 'true', ADMIN_DATABASE_URL: 'postgres://ro' })).toThrow(/ADMIN_CF_AUD/); // neither Access nor local
    expect(() => loadConfig({ ...base, ADMIN_ENABLED: 'true', ADMIN_CF_TEAM_DOMAIN: TEAM, ADMIN_CF_AUD: AUD })).toThrow(/ADMIN_DATABASE_URL/);
    expect(loadConfig({ ...base, ADMIN_ENABLED: 'true', ...cf }).ADMIN_ENABLED).toBe(true);
    expect(loadConfig({ ...base, ADMIN_ENABLED: 'true', ADMIN_DATABASE_URL: 'postgres://ro', ADMIN_LOCAL_EMAIL: 'Me@Epsilon.test' }).ADMIN_LOCAL_EMAIL).toBe('me@epsilon.test');
    expect(loadConfig({ ...base, NODE_ENV: 'development', SMS_PROVIDER: 'console', ADMIN_DEV_EMAIL: 'dev@epsilon.test' }).ADMIN_DEV_EMAIL).toBe('dev@epsilon.test');
  });

  it('local tunnel mode: loopback without a JWT is the configured admin, nothing else is', async () => {
    const t = await adminSetup({ ADMIN_LOCAL_EMAIL: OPS });
    // Not an active admin yet.
    expect((await t.call('POST', '/session')).status).toBe(403);
    await t.addAdmin(OPS, 'operations');
    const res = await t.call('POST', '/session');
    expect(res.status).toBe(200);
    expect(res.body.admin).toMatchObject({ email: OPS, role: 'operations' });
    const login = (await auditRows(t)).find((a) => a.action === 'login')!;
    expect(login.after).toEqual({ via: 'local_tunnel' });
    const session = { cookie: String(res.headers['set-cookie']).split(';')[0]!, csrf: res.body.csrfToken };
    expect((await t.call('GET', '/overview', { session })).status).toBe(200);
    // X-Forwarded-For is never consulted, and a present JWT is validated, not bypassed.
    expect((await t.call('GET', '/me', { session, headers: { 'x-forwarded-for': '10.0.0.1' } })).status).toBe(200);
    expect((await t.call('POST', '/session', { token: 'garbage' })).status).toBe(401);
    expect((await t.call('POST', '/session', { token: await t.jwt(OPS, { key: t.otherKey }) })).status).toBe(401);
    // Role still comes from admin_users.
    expect((await t.call('POST', `/users/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/reveal`, { session, body: { reason: 'abcd' } })).status).toBe(403);
  });

  it('without ADMIN_LOCAL_EMAIL a JWT-less loopback request is 401', async () => {
    const t = await adminSetup();
    await t.addAdmin(OPS, 'operations');
    expect((await t.call('POST', '/session')).status).toBe(401);
  });
});

describe('static admin app', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-dist-'));
  const dist = join(dir, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>shell</title>');
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(dir, 'secret.txt'), 'top secret');
  const t = await adminSetup({}, dist);
  const get = (url: string, method = 'GET') => t.admin.inject({ method: method as 'GET', url });

  it('serves the shell for client routes and hashed assets with long cache', async () => {
    for (const url of ['/', '/restaurants/r:abc', '/users']) {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('shell');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    }
    const asset = await get('/assets/app-abc123.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.headers['cache-control']).toContain('immutable');
  });

  it('refuses path traversal, unknown types, other methods, and never shadows the API', async () => {
    for (const url of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/..%5csecret.txt', '/assets/../../secret.txt', '/%00.js', '/assets/missing.js', '/x.exe'])
      expect((await get(url)).statusCode).toBe(404);
    expect((await get('/', 'POST')).statusCode).toBe(404);
    const api = await get('/admin/api/nope');
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toContain('application/json');
  });
});
