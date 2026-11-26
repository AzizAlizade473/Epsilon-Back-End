import { beforeAll, describe, expect, it } from 'vitest';

import { branches, restaurants } from '../src/db/schema.js';
import { fixtureProvider } from '../src/fiscal/provider.js';
import { seed } from '../src/db/seed-data.js';
import { ALL, CAFE, NON_PARTNER_RESTAURANT, PARTNER_RESTAURANT, qr, TAM_STORE } from './fiscal-fixtures.js';
import { setup } from './helpers.js';

describe('GET /receipts search and filters', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let token: string;
  /** Receipt ids by name. */
  const id: Record<string, string> = {};

  beforeAll(async () => {
    // Same receipts, one visit just after Baku midnight (still the previous day in UTC).
    const late = { ...CAFE, receipt: { ...CAFE.receipt, issuedAt: '2026-11-20T00:30:00+04:00', number: '77_1%' } };
    const docs = [...ALL.filter((d) => d !== CAFE), late];
    t = await setup({}, { fiscal: fixtureProvider(new Map(docs.map((d) => [d.receipt.fiscalId, d]))) });
    await seed(t.db, t.clock.now);
    const [r] = await t.db.insert(restaurants).values({ name: 'Dolma House', cashbackBps: 250, voen: '3333333333' }).returning();
    await t.db.insert(branches).values({ restaurantId: r!.id, name: 'Sahil filialı', objectCode: '3333333333-20001' });
    token = (await t.signInPhone()).session.accessToken;
    const scan = async (name: string, value: string) => {
      const res = await t.call('POST', '/receipts/resolve', { token, body: { kind: 'qr', value } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      id[name] = res.body.id;
      t.advance(1000);
    };
    await scan('store', qr(TAM_STORE.receipt.fiscalId)); // 11-16, retail, not partner
    await scan('nargiz', qr(NON_PARTNER_RESTAURANT.receipt.fiscalId)); // 11-16, not partner
    await scan('cafe', qr(late.receipt.fiscalId)); // 11-20 Baku, not partner
    await scan('dolma', qr(PARTNER_RESTAURANT.receipt.fiscalId)); // 11-16, partner, pays cashback
    await scan('bistro', 'DEMO-0001'); // partner code, 11-12, pays cashback
  });

  const names = async (query: string) => {
    const res = await t.call('GET', `/receipts?${query}`, { token });
    expect(res.status, `${query} ${JSON.stringify(res.body)}`).toBe(200);
    return (res.body.items as { id: string }[]).map((i) => Object.keys(id).find((k) => id[k] === i.id)!);
  };

  it('lists everything newest first without parameters', async () => {
    expect(await names('')).toEqual(['bistro', 'dolma', 'cafe', 'nargiz', 'store']);
  });

  it('searches restaurant, branch, fiscal id, receipt number and dish names, ignoring case', async () => {
    expect(await names('q=bulvar+BISTRO')).toEqual(['bistro']);
    expect(await names('q=nargiz')).toEqual(['nargiz']);
    expect(await names('q=sahil')).toEqual(['dolma']);
    expect(await names(`q=${TAM_STORE.receipt.fiscalId.toLowerCase()}`)).toEqual(['store']);
    expect(await names('q=1421')).toEqual(['store']);
    expect(await names('q=latte')).toEqual(['cafe']);
    expect(await names(`q=${encodeURIComponent('şorba')}`)).toEqual(['dolma']);
    expect(await names('q=mushroom')).toEqual(['bistro']);
    expect(await names('q=no-such-thing')).toEqual([]);
  });

  it('treats wildcard and quote characters literally', async () => {
    expect(await names(`q=${encodeURIComponent('_1%')}`)).toEqual(['cafe']);
    expect(await names(`q=${encodeURIComponent('%')}`)).toEqual(['cafe']);
    expect(await names(`q=${encodeURIComponent("' or 1=1 --")}`)).toEqual([]);
    expect(await names(`q=${encodeURIComponent('\\')}`)).toEqual([]);
  });

  it('filters by Baku visit day, inclusive', async () => {
    expect(await names('from=2026-11-20&to=2026-11-20')).toEqual(['cafe']);
    expect(await names('to=2026-11-19&from=2026-11-16')).toEqual(['dolma', 'nargiz', 'store']);
    expect(await names('to=2026-11-15')).toEqual(['bistro']);
    expect(await names('from=2026-11-21')).toEqual([]);
  });

  it('filters by partner and cashback, matching what each receipt shows', async () => {
    expect(await names('partner=true')).toEqual(['bistro', 'dolma']);
    expect(await names('partner=false')).toEqual(['cafe', 'nargiz', 'store']);
    expect(await names('cashback=eligible')).toEqual(['bistro', 'dolma']);
    expect(await names('cashback=none')).toEqual(['cafe', 'nargiz', 'store']);
    for (const name of Object.keys(id)) {
      const receipt = (await t.call('GET', `/receipts/${id[name]}`, { token })).body;
      const shown = receipt.fiscal ? receipt.fiscal.eligibility.cashbackAllowed : receipt.rewardHint !== undefined;
      expect((await names('cashback=eligible')).includes(name), name).toBe(shown);
    }
  });

  it('combines filters and keeps the cursor correct across pages', async () => {
    expect(await names('partner=false&from=2026-11-16&to=2026-11-16')).toEqual(['nargiz', 'store']);
    expect(await names('q=dolma&partner=true&cashback=eligible&from=2026-11-16')).toEqual(['dolma']);
    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 5; page++) {
      const res = await t.call('GET', `/receipts?partner=false&limit=1${cursor}`, { token });
      seen.push(...res.body.items.map((i: { id: string }) => i.id));
      if (!res.body.nextCursor) break;
      cursor = `&cursor=${res.body.nextCursor}`;
    }
    expect(seen).toEqual([id.cafe, id.nargiz, id.store]);
  });

  it('rejects bad parameters', async () => {
    for (const query of [
      'q=', `q=${'a'.repeat(81)}`, 'q=a%00b', 'from=16-11-2026', 'from=2026-02-30', 'from=0000-01-01', 'from=2026-11-20&to=2026-11-19',
      'partner=yes', 'cashback=all', 'limit=0', 'limit=51', 'cursor=garbage', 'userId=1', 'restaurant=x',
    ])
      expect((await t.call('GET', `/receipts?${query}`, { token })).status, query).toBe(422);
  });

  it('never shows another account its receipts', async () => {
    const other = (await t.signInPhone('+994502223344')).session.accessToken;
    for (const query of ['', '?q=dolma', '?partner=false', '?cashback=none'])
      expect((await t.call('GET', `/receipts${query}`, { token: other })).body.items).toEqual([]);
  });
});
