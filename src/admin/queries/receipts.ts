import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../../db/client.js';
import { notFound } from '../../errors.js';
import type { FiscalDocument } from '../../fiscal/document.js';
import { maskId } from '../mask.js';
import { all, BASE, between, listQuery, merchantKey, offsetOf, one, optionalRange, paged, rangeQuery, uuid, type Range } from './facts.js';
import { reviewRows, reviewView } from './reviews.js';

// ---------------------------------------------------------------- receipts

export const receiptsQuery = listQuery.merge(rangeQuery).extend({
  status: z.enum(['open', 'cancelled', 'refunded']).optional(),
  category: z.string().regex(/^[\w-]{1,40}$/).optional(),
});

type GRow = {
  id: string; fiscal_id: string | null; mkey: string; mname: string; category: string | null; imported_at: Date; total_minor: number; status: string;
  provider: string | null; engine: string | null; bps: number; items: number; ratings: number;
};

/** One row per physical receipt (a receipt scanned by two users is one). */
export async function listReceipts(ro: Db, q: z.infer<typeof receiptsQuery>, now: Date, limit = q.limit) {
  const c: SQL[] = [sql`true`];
  if (q.status) c.push(sql`g.status = ${q.status}`);
  if (q.category) c.push(sql`g.category = ${q.category}`);
  const offset = offsetOf(q.cursor);
  const rows = await all<GRow>(
    ro,
    sql`${BASE}, g as (select r.rkey, (array_agg(r.id order by (u.deleted_at is null) desc, r.claimed_at))[1] as id, max(r.fiscal_id) as fiscal_id,
          max(r.mkey) as mkey, max(r.mname) as mname, max(r.business_type) as category, min(r.claimed_at) as imported_at, max(r.total_minor) as total_minor,
          max(r.status) as status, max(r.provider) as provider, max(r.engine) as engine, max(r.bps) as bps
        from r left join users u on u.id = r.user_id where ${between('r.claimed_at', optionalRange(q, now))} group by r.rkey)
      select g.id, g.fiscal_id, g.mkey, g.mname, g.category, g.imported_at, g.total_minor, g.status, g.provider, g.engine, g.bps,
        (select count(*)::int from purchase_items pi where pi.purchase_id = g.id) as items,
        (select count(*)::int from f where f.rkey = g.rkey and f.hidden_at is null) as ratings
      from g where ${sql.join(c, sql` and `)} order by g.imported_at desc, g.id limit ${limit + 1} offset ${offset}`,
  );
  const page = paged(rows, limit, offset);
  return {
    ...page,
    items: page.items.map((r) => ({
      id: r.id,
      fiscalIdMasked: maskId(r.fiscal_id),
      restaurant: { key: r.mkey, name: r.mname },
      category: r.category,
      importedAt: r.imported_at,
      totalMinor: r.total_minor,
      items: r.items,
      status: r.status,
      ratings: r.ratings,
      cashbackEligible: r.bps > 0,
      provider: r.provider,
      engine: r.engine,
    })),
  };
}

export const idParam = z.object({ id: uuid }).strict();

export async function receiptDetail(ro: Db, id: string) {
  const r = await one<{
    id: string; user_id: string; claimed_at: Date; total_minor: number; status: string; fiscal_id: string | null; provider: string | null; engine: string | null;
    mkey: string; mname: string; chain: string; branch: string | null; voen: string | null; object_code: string | null; document: FiscalDocument | null;
  }>(
    ro,
    // `raw` (the provider's original payload) is never selected.
    sql`${BASE} select r.id, r.user_id, r.claimed_at, r.total_minor, r.status, r.fiscal_id, r.provider, r.engine, r.mkey, r.mname, r.chain, r.branch, r.voen, r.object_code, fr.document
      from r left join fiscal_receipts fr on fr.id = r.fid where r.id = ${id}::uuid`,
  );
  if (!r) throw notFound();
  const [items, reviews, ledger] = await Promise.all([
    all<{ name: string; quantity: number; unit_price_minor: number }>(ro, sql`select name, quantity, unit_price_minor from purchase_items where purchase_id = ${id}::uuid order by line_no, name`),
    reviewRows(ro, sql`f.rkey = (select rkey from r where id = ${id}::uuid)`, 100),
    all<{ id: string; type: string; status: string; amount_minor: number; created_at: Date }>(
      ro,
      sql`${BASE} select id, type::text, status::text, amount_minor, created_at from led where purchase_item_id in (select id from it where rkey = (select rkey from r where id = ${id}::uuid)) order by created_at`,
    ),
  ]);
  return {
    id: r.id,
    importedAt: r.claimed_at,
    totalMinor: r.total_minor,
    status: r.status,
    fiscalIdMasked: maskId(r.fiscal_id),
    provider: r.provider,
    engine: r.engine,
    merchant: { key: r.mkey, name: r.mname, chain: r.chain, branch: r.branch, voenMasked: maskId(r.voen), objectCode: r.object_code },
    lines: r.document
      ? r.document.items.map((i) => ({ lineNo: i.lineNo, originalName: i.originalName, quantityMilli: i.quantityMilli, unitPriceMinor: i.unitPriceMinor, lineTotalMinor: i.lineTotalMinor }))
      : items.map((i, n) => ({ lineNo: n + 1, originalName: i.name, quantityMilli: i.quantity * 1000, unitPriceMinor: i.unit_price_minor, lineTotalMinor: i.quantity * i.unit_price_minor })),
    reviews: reviews.slice(0, 100).map(reviewView),
    ledger: ledger.map((l) => ({ id: l.id, type: l.type, status: l.status, amountMinor: l.amount_minor, createdAt: l.created_at })),
  };
}

export async function receiptHealth(ro: Db, rg: Range) {
  const [totals, byProvider, byEngine] = await Promise.all([
    one<{ imported: number; unsupported: number; unknown_merchant: number }>(
      ro,
      sql`${BASE} select count(distinct rkey)::int as imported,
        count(distinct rkey) filter (where fid is not null and sector is distinct from 'horeca')::int as unsupported,
        count(distinct rkey) filter (where rid is null and object_code is null)::int as unknown_merchant
        from r where ${between('claimed_at', rg)}`,
    ),
    all<{ provider: string; n: number }>(ro, sql`${BASE} select coalesce(provider, 'partner_code') as provider, count(distinct rkey)::int as n from r where ${between('claimed_at', rg)} group by 1 order by 2 desc, 1`),
    all<{ engine: string; n: number }>(ro, sql`${BASE} select coalesce(engine, 'none') as engine, count(distinct rkey)::int as n from r where ${between('claimed_at', rg)} group by 1 order by 2 desc, 1`),
  ]);
  return {
    imported: totals?.imported ?? 0,
    byProvider: byProvider.map((p) => ({ provider: p.provider, receipts: p.n })),
    byEngine: byEngine.map((p) => ({ engine: p.engine, receipts: p.n })),
    unsupported: totals?.unsupported ?? 0,
    unknownMerchant: totals?.unknown_merchant ?? 0,
    // Failed imports are not stored, so there is nothing to count.
    failures: 'not_tracked' as const,
  };
}

// ---------------------------------------------------------------- cashback

export async function cashbackSummary(ro: Db, rg: Range) {
  const [s, byRestaurant, byDay] = await Promise.all([
    one<{ confirmed: number; pending: number; reversed: number; expired: number; liability: number }>(
      ro,
      sql`${BASE} select
        coalesce(sum(amount_minor) filter (where type = 'earned' and status = 'confirmed' and ${between('created_at', rg)}), 0)::float8 as confirmed,
        coalesce(sum(amount_minor) filter (where status = 'pending' and ${between('created_at', rg)}), 0)::float8 as pending,
        coalesce(-sum(amount_minor) filter (where type = 'reversed' and ${between('created_at', rg)}), 0)::float8 as reversed,
        coalesce(-sum(amount_minor) filter (where type = 'expired' and ${between('created_at', rg)}), 0)::float8 as expired,
        coalesce(sum(amount_minor) filter (where status = 'confirmed'), 0)::float8 as liability
        from led`,
    ),
    all<{ mkey: string; name: string; n: number }>(
      ro,
      sql`${BASE} select 'r:' || l.restaurant_id::text as mkey, rs.name, sum(l.amount_minor)::float8 as n from led l join restaurants rs on rs.id = l.restaurant_id
        where l.type = 'earned' and l.status = 'confirmed' and ${between('l.created_at', rg)} group by l.restaurant_id, rs.name order by n desc, rs.name limit 100`,
    ),
    all<{ date: string; n: number }>(
      ro,
      sql`${BASE} select to_char((created_at at time zone 'Asia/Baku')::date, 'YYYY-MM-DD') as date, sum(amount_minor)::float8 as n from led
        where type = 'earned' and status = 'confirmed' and ${between('created_at', rg)} group by 1 order by 1`,
    ),
  ]);
  const x = s!;
  return {
    confirmedMinor: x.confirmed,
    pendingMinor: x.pending,
    reversedMinor: x.reversed,
    expiredMinor: x.expired,
    // Outstanding confirmed balance owed to users right now (all time), not limited to the range.
    liabilityMinor: x.liability,
    byRestaurant: byRestaurant.map((r) => ({ key: r.mkey, name: r.name, earnedMinor: r.n })),
    byDay: byDay.map((d) => ({ date: d.date, earnedMinor: d.n })),
  };
}

export const ledgerQuery = listQuery.merge(rangeQuery).extend({
  type: z.enum(['earned', 'redeemed', 'reversed', 'expired']).optional(),
  status: z.enum(['pending', 'confirmed', 'cancelled']).optional(),
  user: uuid.optional(),
  restaurant: merchantKey.optional(),
});

export async function listLedger(ro: Db, q: z.infer<typeof ledgerQuery>, now: Date, limit = q.limit) {
  const c: SQL[] = [between('l.created_at', optionalRange(q, now))];
  if (q.type) c.push(sql`l.type::text = ${q.type}`);
  if (q.status) c.push(sql`l.status::text = ${q.status}`);
  if (q.user) c.push(sql`l.user_id = ${q.user}::uuid`);
  if (q.restaurant) c.push(sql`'r:' || l.restaurant_id::text = ${q.restaurant}`);
  const offset = offsetOf(q.cursor);
  const rows = await all<{ id: string; type: string; status: string; amount_minor: number; created_at: Date; user_id: string; mkey: string; name: string; receipt_id: string | null; feedback_id: string | null }>(
    ro,
    sql`${BASE} select l.id, l.type::text, l.status::text, l.amount_minor, l.created_at, l.user_id, 'r:' || l.restaurant_id::text as mkey, rs.name,
        (select purchase_id from it where it.id = l.purchase_item_id) as receipt_id, l.feedback_id
      from led l join restaurants rs on rs.id = l.restaurant_id where ${sql.join(c, sql` and `)}
      order by l.created_at desc, l.id limit ${limit + 1} offset ${offset}`,
  );
  const page = paged(rows, limit, offset);
  return {
    ...page,
    items: page.items.map((l) => ({
      id: l.id, type: l.type, status: l.status, amountMinor: l.amount_minor, createdAt: l.created_at, userId: l.user_id,
      restaurant: { key: l.mkey, name: l.name }, receiptId: l.receipt_id, feedbackId: l.feedback_id,
    })),
  };
}
