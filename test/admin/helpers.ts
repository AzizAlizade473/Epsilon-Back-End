import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';

import { buildAdminApp } from '../../src/admin/routes.js';
import type { Role } from '../../src/admin/roles.js';
import { adminUsers, branches, feedback, feedbackReasons, fiscalReceipts, ledgerEntries, purchaseItems, purchases, restaurants, users } from '../../src/db/schema.js';
import { sha256 } from '../../src/lib/crypto.js';
import { setup } from '../helpers.js';

export const TEAM = 'team.cloudflareaccess.com';
export const AUD = 'test-audience-0123456789';

/** Public test app + admin app on the same in-memory database, with a local Access key pair. */
export async function adminSetup(overrides: Record<string, string> = {}, staticDir?: string) {
  const t = await setup({ ADMIN_ENABLED: 'true', ADMIN_CF_TEAM_DOMAIN: TEAM, ADMIN_CF_AUD: AUD, ...overrides });
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwks: JWTVerifyGetKey = async () => publicKey;
  const app = await buildAdminApp(
    { db: t.db, ro: t.db, config: t.config, now: () => new Date(t.clock.now), jwks, limits: { perAdmin: 100_000, login: 100_000 } },
    { staticDir },
  );

  const jwt = (email: string, o: { sub?: string; aud?: string; iss?: string; exp?: string | number; key?: CryptoKey } = {}) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject(o.sub ?? `sub-${email}`)
      .setIssuer(o.iss ?? `https://${TEAM}`)
      .setAudience(o.aud ?? AUD)
      .setIssuedAt()
      .setExpirationTime(o.exp ?? '1h')
      .sign(o.key ?? privateKey);

  const addAdmin = async (email: string, role: Role, status: 'active' | 'disabled' = 'active') => {
    const [row] = await t.db.insert(adminUsers).values({ email, role, status, name: email.split('@')[0]! }).returning();
    return row!;
  };

  type Session = { cookie: string; csrf: string };
  type Opts = { as?: string; session?: Session; body?: unknown; csrf?: string | false; headers?: Record<string, string>; token?: string };
  async function call(method: string, url: string, o: Opts = {}) {
    const headers: Record<string, string> = { ...o.headers };
    const token = o.token ?? (o.as ? await jwt(o.as) : undefined);
    if (token) headers['cf-access-jwt-assertion'] = token;
    if (o.session) {
      headers.cookie = o.session.cookie;
      if (method !== 'GET' && o.csrf !== false) headers['x-csrf-token'] = o.csrf ?? o.session.csrf;
    }
    const res = await app.inject({ method: method as 'GET', url: `/admin/api${url}`, headers, payload: o.body as object });
    const text = res.body;
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.statusCode, body, text, headers: res.headers };
  }

  /** Logs in as `email` (must exist in admin_users) and returns the session credentials. */
  async function login(email: string): Promise<Session> {
    const res = await call('POST', '/session', { as: email });
    if (res.status !== 200) throw new Error(`login ${res.status} ${res.text}`);
    return { cookie: String(res.headers['set-cookie']).split(';')[0]!, csrf: res.body.csrfToken as string };
  }

  /** Authenticated request as an already-logged-in admin. */
  const as = (email: string, session: Session) => (method: string, url: string, o: Opts = {}) => call(method, url, { as: email, session, ...o });

  return { ...t, consumerCall: t.call, admin: app, jwt, addAdmin, call, login, as, otherKey: other.privateKey };
}

export type A = Awaited<ReturnType<typeof adminSetup>>;

const day = (s: string) => new Date(s);
const doc = (name: string, objectName: string) => ({
  merchant: { displayName: name, legalName: null, voen: '1506475881', objectName, objectCode: 'OBJ-1', address: null, city: null },
  receipt: { fiscalId: 'FISC000000001', totalMinor: 1000 },
  items: [{ lineNo: 1, originalName: 'LAVASH *18%', normalizedName: 'LAVASH', quantityMilli: 1000, unit: null, unitPriceMinor: 500, lineTotalMinor: 500 }],
  device: {},
  additionalFields: {},
});

/** Two users; a non-partner fiscal receipt scanned by both; a partner purchase; a test-fixture receipt that must never count. */
export async function seed(t: A) {
  const [u1, u2] = await t.db
    .insert(users)
    .values([
      { phone: '+994551234555', email: 'aziz.secret@gmail.com', firstName: 'Aziz', lastName: 'Aliyev', createdAt: day('2026-11-01T08:00:00Z') },
      { phone: '+994501112233', firstName: 'Leyla', lastName: 'Mammadova', createdAt: day('2026-11-02T08:00:00Z') },
    ])
    .returning();
  const [r1] = await t.db.insert(restaurants).values({ name: 'Dolma House', cashbackBps: 250, voen: '3333333333' }).returning();
  const [b1] = await t.db.insert(branches).values({ restaurantId: r1!.id, name: 'Nizami', objectCode: '3333333333-20001' }).returning();
  const fiscal = (fiscalId: string, provider: string) => ({
    issuer: 'ekassa', fiscalId, provider, extractionEngine: 'structured', document: doc('KFC AZ', 'KFC Nizami'), merchantVoen: '1506475881', objectCode: 'OBJ-1',
    sector: 'horeca', businessType: 'restaurant', classificationMethod: 'test', classificationEvidence: { status: 'ok', evidence: [] }, retrievedAt: day('2026-11-13T05:00:00Z'),
  });
  const [f1, f2] = await t.db.insert(fiscalReceipts).values([fiscal('FISC000000001', 'official_page'), fiscal('FIXT000000001', 'fixture')]).returning();
  const claimed = day('2026-11-13T05:00:00Z');
  const buy = (n: string, userId: string, extra: object) => ({
    referenceHash: sha256(n), issuedAt: claimed, totalMinor: 1000, expiresAt: day('2026-12-13T00:00:00Z'), claimedBy: userId, claimedAt: claimed, ...extra,
  });
  const [p1, p2, p3, pf] = await t.db
    .insert(purchases)
    .values([
      buy('p1', u1!.id, { fiscalReceiptId: f1!.id }),
      buy('p2', u2!.id, { fiscalReceiptId: f1!.id }),
      buy('p3', u1!.id, { branchId: b1!.id }),
      buy('pf', u1!.id, { fiscalReceiptId: f2!.id }),
    ])
    .returning();
  const [i1, i2, i3, i4] = await t.db
    .insert(purchaseItems)
    .values([
      { purchaseId: p1!.id, name: 'LAVASH *18%', lineNo: 1, quantity: 1, unitPriceMinor: 500 },
      { purchaseId: p2!.id, name: 'Lavash', lineNo: 1, quantity: 1, unitPriceMinor: 500 },
      { purchaseId: p3!.id, name: 'Dolma', quantity: 1, unitPriceMinor: 1000 },
      { purchaseId: pf!.id, name: 'Fixture dish', lineNo: 1, quantity: 1, unitPriceMinor: 500 },
    ])
    .returning();
  const at = day('2026-11-13T06:00:00Z');
  const [fb1, fb2, fb3, fb4] = await t.db
    .insert(feedback)
    .values([
      // fb1 was edited: still one rating.
      { purchaseItemId: i1!.id, userId: u1!.id, rating: 5, comment: '=cmd|calc', createdAt: at, updatedAt: day('2026-11-13T07:00:00Z') },
      { purchaseItemId: i2!.id, userId: u2!.id, rating: 3, comment: 'ok', createdAt: at },
      { purchaseItemId: i3!.id, userId: u1!.id, rating: 1, comment: 'cold', createdAt: at },
      { purchaseItemId: i4!.id, userId: u1!.id, rating: 5, createdAt: at },
    ])
    .returning();
  await t.db.insert(feedbackReasons).values([
    { feedbackId: fb1!.id, code: 'amazing_taste' },
    { feedbackId: fb3!.id, code: 'served_cold' },
    { feedbackId: fb3!.id, code: 'price' },
  ]);
  await t.db.insert(ledgerEntries).values([
    { userId: u1!.id, type: 'earned', status: 'confirmed', amountMinor: 50, restaurantId: r1!.id, purchaseItemId: i1!.id, feedbackId: fb1!.id, createdAt: at },
    { userId: u1!.id, type: 'earned', status: 'confirmed', amountMinor: 25, restaurantId: r1!.id, purchaseItemId: i3!.id, feedbackId: fb3!.id, createdAt: at },
    // Test data: excluded.
    { userId: u1!.id, type: 'earned', status: 'confirmed', amountMinor: 999, restaurantId: r1!.id, purchaseItemId: i4!.id, feedbackId: fb4!.id, createdAt: at },
  ]);
  return { u1: u1!, u2: u2!, r1: r1!, fb1: fb1!, fb2: fb2!, fb3: fb3!, p1: p1!, p3: p3! };
}
