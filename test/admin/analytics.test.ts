import { describe, expect, it } from 'vitest';

import { adminAudit, authIdentities } from '../../src/db/schema.js';
import { csvCell, maskEmail, maskId, maskPhone } from '../../src/admin/mask.js';
import { adminSetup, seed } from './helpers.js';

const OPS = 'ops@epsilon.test';
const ANALYST = 'analyst@epsilon.test';

describe('masking helpers', () => {
  it('masks phones, emails and fiscal ids', () => {
    expect(maskPhone('+994551234555')).toBe('+994 55 ••• •• 55');
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone('12')).toBe('•••');
    expect(maskEmail('aziz@gmail.com')).toBe('a•••@gmail.com');
    expect(maskEmail('nope')).toBe('•••');
    expect(maskId('1506475881')).toBe('1506••5881');
    expect(maskId('FISC000000001')).toBe('FISC•••••0001');
    expect(maskId('abc')).toBe('•••');
  });

  it('csv cells are quoted and neutralise formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    for (const evil of ['=cmd', '+1', '-1', '@sum', '\tx', '\rx']) expect(csvCell(evil)).toBe(`"'${evil}"`);
    expect(csvCell(null)).toBe('');
    expect(csvCell(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('admin analytics', async () => {
  const t = await adminSetup();
  await t.addAdmin(OPS, 'operations');
  await t.addAdmin(ANALYST, 'analyst');
  const data = await seed(t);
  const analyst = t.as(ANALYST, await t.login(ANALYST));
  const ops = t.as(OPS, await t.login(OPS));

  it('overview counts match the inserted data (fixture receipts and test ledger excluded)', async () => {
    const res = await analyst('GET', '/overview');
    expect(res.status).toBe(200);
    const { kpis, previous, series, ratingDistribution, topRestaurants } = res.body;
    expect(kpis).toMatchObject({
      totalUsers: 2,
      newUsers: 2,
      receiptsImported: 2, // the shared fiscal receipt counts once
      ratings: 3, // ...but twice as a rating; the edited review counts once; the fixture rating is not counted
      avgRating: 3,
      cashbackConfirmedMinor: 75, // equals the real ledger rows, not the 999 test row
      uniqueRestaurants: 2,
      activePartners: 1,
      receiptToRatingRate: 1,
      avgRatingsPerReceipt: 1.5,
      dau: 2,
    });
    expect(previous).toMatchObject({ ratings: 0, avgRating: null, receiptsImported: 0, receiptToRatingRate: null });
    expect(ratingDistribution).toEqual([1, 0, 1, 0, 1]);
    expect(series.days).toHaveLength(30);
    expect(series.days.at(-1)).toMatchObject({ date: '2026-11-13', receipts: 2, ratings: 3, activeUsers: 2 });
    expect(topRestaurants.map((r: { key: string }) => r.key)).toContain(`r:${data.r1.id}`);
    expect(typeof res.body.generatedAt).toBe('string');
  });

  it('every analytics endpoint answers with valid SQL', async () => {
    for (const url of [
      '/users', '/users/analytics', `/users/${data.u1.id}`, '/restaurants', `/restaurants/r:${data.r1.id}`, '/restaurants/m:OBJ-1', '/dishes?minRatings=0',
      '/reviews', `/reviews/${data.fb1.id}`, '/receipts', `/receipts/${data.p1.id}`, '/receipts/health', '/cashback', '/cashback/ledger',
      '/notifications/stats', '/notifications', '/costs', '/health', '/search?q=lavash',
    ]) {
      const res = await analyst('GET', url);
      expect(res.status, `${url} ${res.text.slice(0, 300)}`).toBe(200);
    }
    const health = (await analyst('GET', '/receipts/health')).body;
    expect(health).toMatchObject({ imported: 2, failures: 'not_tracked', unsupported: 0 });
    expect((await analyst('GET', '/costs')).body).toMatchObject({ email: 'not_tracked', push: 'not_tracked' });
    expect((await analyst('GET', '/notifications/stats')).body.delivery).toBe('not_tracked');
  });

  it('dishes merge the VAT marker and case; dimensions come from the quick-comment catalogue', async () => {
    const dishes = (await analyst('GET', '/dishes?minRatings=0&restaurant=m:OBJ-1')).body.items;
    expect(dishes).toHaveLength(1);
    expect(dishes[0]).toMatchObject({ ratings: 2, purchases: 2, avgRating: 4, positivePct: 50, restaurant: { key: 'm:OBJ-1' } });
    expect((await analyst('GET', '/dishes')).body.items).toHaveLength(0); // default minRatings is 3
    const detail = (await analyst('GET', `/dishes/${dishes[0].key}`)).body;
    expect(detail.dimensions.taste).toEqual({ positive: 1, neutral: 0, negative: 0, unknown: 0 });
    expect(detail.distribution).toEqual([0, 0, 1, 0, 1]);

    const cold = (await analyst('GET', '/reviews?dimension=temperature&sentiment=negative')).body.items;
    expect(cold.map((r: { id: string }) => r.id)).toEqual([data.fb3.id]);
    const legacy = (await analyst('GET', '/reviews?dimension=price&sentiment=unknown')).body.items;
    expect(legacy.map((r: { id: string }) => r.id)).toEqual([data.fb3.id]);
    expect((await analyst('GET', '/reviews?edited=true')).body.items.map((r: { id: string }) => r.id)).toEqual([data.fb1.id]);
  });

  it('users and search never leak phone or email; reveal is the only way', async () => {
    const list = await analyst('GET', '/users');
    const search = await analyst('GET', '/search?q=Aziz');
    const detail = await analyst('GET', `/users/${data.u1.id}`);
    for (const res of [list, search, detail]) {
      expect(res.text).not.toContain('aziz.secret');
      expect(res.text).not.toContain('551234555');
      expect(res.text).not.toContain('501112233');
    }
    const aziz = list.body.items.find((u: { id: string }) => u.id === data.u1.id);
    expect(aziz).toMatchObject({ emailMasked: 'a•••@gmail.com', phoneMasked: '+994 55 ••• •• 55', receipts: 2, ratings: 2, cashbackMinor: 75 });
    expect(search.body.users).toHaveLength(1);
    // Exact contact lookup finds the user, a prefix does not (no brute-forcing the masked digits).
    expect((await analyst('GET', '/users?q=%2B994551234555')).body.items).toHaveLength(1);
    expect((await analyst('GET', '/users?q=%2B9945512')).body.items).toHaveLength(0);
  });

  it('lists are paginated and validated', async () => {
    const first = (await analyst('GET', '/users?limit=1')).body;
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = (await analyst('GET', `/users?limit=1&cursor=${first.nextCursor}`)).body;
    expect(second.items[0].id).not.toBe(first.items[0].id);
    expect(second.nextCursor).toBeNull();
    expect((await analyst('GET', '/users?limit=101')).status).toBe(422);
    expect((await analyst('GET', '/users?cursor=zzzz')).status).toBe(422);
    expect((await analyst('GET', '/overview?from=2026-01-01&to=2027-12-31')).status).toBe(422);
    expect((await analyst('GET', '/overview?from=nope')).status).toBe(422);
    expect((await analyst('GET', '/restaurants/x:y')).status).toBe(422);
  });

  it('cashback summary equals the ledger', async () => {
    const summary = (await analyst('GET', '/cashback')).body;
    const ledger = (await analyst('GET', '/cashback/ledger?type=earned&status=confirmed')).body.items;
    expect(ledger).toHaveLength(2);
    expect(ledger.reduce((n: number, l: { amountMinor: number }) => n + l.amountMinor, 0)).toBe(75);
    expect(summary).toMatchObject({ confirmedMinor: 75, liabilityMinor: 75, pendingMinor: 0 });
    expect(summary.byRestaurant).toEqual([{ key: `r:${data.r1.id}`, name: 'Dolma House', earnedMinor: 75 }]);
  });

  it('restaurant metadata edits are audited; non-partners cannot be edited', async () => {
    const res = await ops('PATCH', `/restaurants/r:${data.r1.id}`, { body: { name: 'Dolma House 2' } });
    expect(res.status).toBe(200);
    expect((await ops('PATCH', '/restaurants/m:OBJ-1', { body: { name: 'X' } })).status).toBe(422);
    expect((await ops('PATCH', `/restaurants/r:${data.r1.id}`, { body: { logoUrl: 'javascript:alert(1)' } })).status).toBe(422);
    const entry = (await t.db.select().from(adminAudit)).find((a) => a.action === 'restaurant.update')!;
    expect(entry.before).toMatchObject({ name: 'Dolma House' });
    expect(entry.after).toMatchObject({ name: 'Dolma House 2' });
  });

  it('CSV export escapes formulas, hides PII, and is audited', async () => {
    const res = await analyst('GET', '/export/reviews.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain(`"'=cmd|calc"`);
    expect(res.text).not.toMatch(/(^|,)=cmd/m);
    const users = await analyst('GET', '/export/users.csv');
    expect(users.text).not.toContain('aziz.secret');
    expect((await analyst('GET', '/export/secrets.csv')).status).toBe(404);
    expect((await t.db.select().from(adminAudit)).filter((a) => a.action === 'export')).toHaveLength(2);
  });

  it('moderation needs a reason, is audited, reversible, and hidden reviews leave aggregates (the author still sees theirs)', async () => {
    await t.db.insert(authIdentities).values({ userId: data.u1.id, provider: 'phone', providerUserId: '+994551234555' });
    const consumer = await t.signInPhone('+994551234555');
    const mine = async () => (await t.consumerCall('GET', '/feedback', { token: consumer.session.accessToken })).body.items.map((r: { feedbackId: string }) => r.feedbackId);
    expect(await mine()).toContain(data.fb3.id);

    const url = `/reviews/${data.fb3.id}/moderate`;
    expect((await ops('POST', url, { body: { hidden: true } })).status).toBe(422);
    expect((await ops('POST', url, { body: { hidden: true, reason: 'ab' } })).status).toBe(422);
    const hide = await ops('POST', url, { body: { hidden: true, reason: 'abusive language' } });
    expect(hide.status).toBe(200);

    const o = (await analyst('GET', '/overview')).body;
    expect(o.kpis.ratings).toBe(2);
    expect(o.kpis.avgRating).toBe(4);
    expect(o.ratingDistribution).toEqual([0, 0, 1, 0, 1]);
    // The author still sees their own review; public aggregates drop it.
    expect(await mine()).toContain(data.fb3.id);
    expect((await t.consumerCall('GET', `/feedback/${data.fb3.id}`, { token: consumer.session.accessToken })).status).toBe(200);
    const flagged = (await analyst('GET', '/reviews?moderated=true')).body.items;
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ id: data.fb3.id, comment: 'cold', moderation: { hidden: true, reason: 'abusive language' } }); // text untouched
    expect((await analyst('GET', `/users/${data.u1.id}`)).body.user.ratings).toBe(1);

    const unhide = await ops('POST', url, { body: { hidden: false, reason: 'reviewed again, fine' } });
    expect(unhide.status).toBe(200);
    expect((await analyst('GET', '/overview')).body.kpis.ratings).toBe(3);
    expect(await mine()).toContain(data.fb3.id);

    const entries = (await t.db.select().from(adminAudit)).filter((a) => a.entityType === 'review');
    expect(entries.map((e) => [e.action, e.reason, e.before, e.after])).toEqual([
      ['review.hide', 'abusive language', { hidden: false }, { hidden: true }],
      ['review.unhide', 'reviewed again, fine', { hidden: true }, { hidden: false }],
    ]);
    expect((await ops('POST', `/reviews/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/moderate`, { body: { hidden: true, reason: 'abcd' } })).status).toBe(404);
  });
});
