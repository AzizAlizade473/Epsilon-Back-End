import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../src/app.js';
import type { Deps } from '../src/context.js';
import type { GoogleIdentity } from '../src/auth/google.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { ApiError } from '../src/errors.js';

/** Fresh in-memory Postgres + app per test file. Clock and SMS are controllable. */
export async function setup(
  overrides: Record<string, string> = {},
  extra: { fiscal?: Deps['fiscal']; advisor?: Deps['advisor']; reader?: Deps['reader'] } = {},
) {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: 'drizzle' });

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused',
    JWT_SECRET: 'test-jwt-secret-test-jwt-secret-0000',
    OTP_SECRET: 'test-otp-secret-test-otp-secret-0000',
    ...overrides,
  });
  const clock = { now: new Date('2026-11-13T10:00:00.000Z') };
  const sent: { phone: string; code: string }[] = [];
  const googleAccounts = new Map<string, GoogleIdentity>();

  const app = await buildApp({
    db,
    config,
    now: () => new Date(clock.now),
    ...extra,
    sms: async (phone, code) => void sent.push({ phone, code }),
    google: async (idToken) => {
      const identity = googleAccounts.get(idToken);
      if (!identity) throw new ApiError(400, 'SOCIAL_TOKEN_INVALID');
      return identity;
    },
  });

  const advance = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));

  async function call(method: string, url: string, opts: { token?: string; body?: unknown; key?: string | false } = {}) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (method !== 'GET' && opts.key !== false) headers['idempotency-key'] = opts.key ?? `test-${randomUUID()}`;
    const res = await app.inject({ method: method as 'GET', url: `/v1${url}`, headers, payload: opts.body as object });
    return { status: res.statusCode, body: res.body ? res.json() : null, headers: res.headers };
  }

  /** Full phone sign-in; returns the AuthResult body. */
  async function signInPhone(phone = '+994501112233') {
    const req = await call('POST', '/auth/otp/request', { body: { phone } });
    if (req.status !== 200) throw new Error(`otp request ${req.status} ${JSON.stringify(req.body)}`);
    const code = sent.at(-1)!.code;
    const res = await call('POST', '/auth/otp/verify', { body: { phone, code } });
    if (res.status !== 200) throw new Error(`otp verify ${res.status} ${JSON.stringify(res.body)}`);
    advance(61_000); // clear the per-phone resend cooldown for later requests
    return res.body;
  }

  return { app, db, client, config, clock, advance, sent, googleAccounts, call, signInPhone };
}
