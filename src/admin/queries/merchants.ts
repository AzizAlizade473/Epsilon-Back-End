import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../../db/client.js';
import { notFound } from '../../errors.js';
import { maskId } from '../mask.js';
import { all, BASE, between, dishKey, like, listQuery, merchantKey, offsetOf, one, optionalRange, orderBy, paged, rangeQuery, type Range } from './facts.js';
import { dimensionCounts, reviewRows, reviewView } from './reviews.js';

const round = (n: number | null, d = 2) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);
const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

// ---------------------------------------------------------------- restaurants

export const restaurantsQuery = listQuery.extend({ partner: flag.optional(), sort: z.enum(['receipts', 'ratings', 'avgRating', 'recent', 'name']).optional() });
const R_SORT = {
  receipts: 'receipts desc, mkey',
  ratings: 'ratings desc, mkey',
  avgRating: 'avg_rating desc nulls last, ratings desc, mkey',
  recent: 'last_activity desc nulls last, mkey',
  name: 'name, mkey',
};

type MRow = {
  mkey: string; name: string; chain: string | null; branch: string | null; category: string | null; voen: string | null; object_code: string | null;
  is_partner: boolean; logo: string | null; receipts: number; reviewers: number; ratings: number; avg_rating: number | null; last_activity: Date | null;
};

/** Every merchant seen on receipts plus every partner (even with no receipt yet). */
function merchantRows(ro: Db, where: SQL, order: SQL, limit: number, offset: number) {
  return all<MRow>(
    ro,
    sql`${BASE}, m as (
        select mkey, max(mname) as name, max(chain) as chain, case when count(distinct branch) = 1 then max(branch) end as branch,
          max(business_type) as category, max(voen) as voen, max(object_code) as object_code, bool_or(rid is not null) as is_partner,
          max(logo) as logo, count(distinct rkey)::int as receipts, max(claimed_at) as last_receipt
        from r group by mkey
        union all
        select 'r:' || rs.id::text, rs.name, rs.name, null, null, rs.voen, null, true, rs.logo_url, 0, null
        from restaurants rs where not exists (select 1 from r where r.rid = rs.id)),
      fa as (select mkey, count(*)::int as ratings, count(distinct user_id)::int as reviewers, avg(rating)::float8 as avg, max(created_at) as last
        from f where hidden_at is null group by mkey)
      select m.mkey, m.name, m.chain, m.branch, m.category, m.voen, m.object_code, m.is_partner, m.logo, m.receipts,
        coalesce(fa.reviewers, 0) as reviewers, coalesce(fa.ratings, 0) as ratings, fa.avg as avg_rating, greatest(m.last_receipt, fa.last) as last_activity
      from m left join fa on fa.mkey = m.mkey where ${where}
      order by ${order} limit ${limit + 1} offset ${offset}`,
  );
}

const restaurantItem = (r: MRow) => ({
  key: r.mkey,
  name: r.name,
  chain: r.chain,
  branch: r.branch,
  category: r.category,
  voenMasked: maskId(r.voen),
  objectCode: r.object_code,
  isPartner: r.is_partner,
  logoBrand: r.logo,
  receipts: r.receipts,
  reviewers: r.reviewers,
  ratings: r.ratings,
  avgRating: round(r.avg_rating),
  lastActivityAt: r.last_activity,
});

export async function listRestaurants(ro: Db, q: z.infer<typeof restaurantsQuery>) {
  const c: SQL[] = [sql`true`];
  if (q.q) c.push(sql`(m.name ilike ${like(q.q)} or m.chain ilike ${like(q.q)} or m.object_code ilike ${like(q.q)})`);
  if (q.partner !== undefined) c.push(q.partner ? sql`m.is_partner` : sql`not m.is_partner`);
  const offset = offsetOf(q.cursor);
  const rows = await merchantRows(ro, sql.join(c, sql` and `), orderBy(R_SORT, q.sort, 'receipts'), q.limit, offset);
  const page = paged(rows, q.limit, offset);
  return { ...page, items: page.items.map(restaurantItem) };
}

export const detailQuery = rangeQuery;
export const keyParam = z.object({ key: merchantKey }).strict();

const trendRows = (ro: Db, filter: SQL, rg: Range | null, table: 'f' | 'r', at: string) =>
  all<{ date: string; n: number; avg: number | null }>(
    ro,
    sql`${BASE} select to_char((${sql.raw(at)} at time zone 'Asia/Baku')::date, 'YYYY-MM-DD') as date,
      ${table === 'f' ? sql`count(*)::int as n, avg(rating)::float8 as avg` : sql`count(distinct rkey)::int as n, null::float8 as avg`}
      from ${sql.raw(table)} where ${filter} and ${between(at, rg)} ${table === 'f' ? sql`and hidden_at is null` : sql``}
      group by 1 order by 1 desc limit 366`,
  );

const distributionOf = (ro: Db, filter: SQL, rg: Range | null) =>
  all<{ rating: number; n: number }>(ro, sql`${BASE} select rating::int, count(*)::int as n from f where ${filter} and hidden_at is null and ${between('created_at', rg)} group by rating`).then(
    (rows) => [1, 2, 3, 4, 5].map((s) => rows.find((r) => r.rating === s)?.n ?? 0),
  );

const dimensionsOf = (ro: Db, filter: SQL, rg: Range | null) =>
  all<{ code: string; n: number }>(
    ro,
    sql`${BASE} select fr.code, count(*)::int as n from feedback_reasons fr join f on f.id = fr.feedback_id
      where ${filter} and f.hidden_at is null and ${between('f.created_at', rg)} group by fr.code`,
  ).then(dimensionCounts);

export async function restaurantDetail(ro: Db, key: string, q: z.infer<typeof detailQuery>, now: Date) {
  const rg = optionalRange(q, now);
  const [row] = await merchantRows(ro, sql`m.mkey = ${key}`, sql`m.mkey`, 1, 0);
  if (!row) throw notFound();
  const f = sql`mkey = ${key}`;
  const [stats, distribution, ratingTrend, receiptTrend, dishes, best, attention, dimensions, reviews] = await Promise.all([
    one<{ receipts: number; rated: number; ratings: number; reviewers: number; avg: number | null; value: number; cashback: number }>(
      ro,
      sql`${BASE} select
        (select count(distinct rkey)::int from r where mkey = ${key} and ${between('claimed_at', rg)}) as receipts,
        (select count(distinct rkey)::int from r where mkey = ${key} and ${between('claimed_at', rg)}
           and exists (select 1 from f where f.rkey = r.rkey and f.hidden_at is null)) as rated,
        (select count(*)::int from f where mkey = ${key} and hidden_at is null and ${between('created_at', rg)}) as ratings,
        (select count(distinct user_id)::int from f where mkey = ${key} and hidden_at is null and ${between('created_at', rg)}) as reviewers,
        (select avg(rating)::float8 from f where mkey = ${key} and hidden_at is null and ${between('created_at', rg)}) as avg,
        (select coalesce(sum(t), 0)::float8 from (select distinct on (rkey) total_minor as t from r where mkey = ${key} and ${between('claimed_at', rg)} order by rkey, claimed_at) x) as value,
        (select coalesce(sum(amount_minor), 0)::float8 from led where type = 'earned' and status = 'confirmed' and 'r:' || restaurant_id::text = ${key} and ${between('created_at', rg)}) as cashback`,
    ),
    distributionOf(ro, f, rg),
    trendRows(ro, f, rg, 'f', 'created_at'),
    trendRows(ro, f, rg, 'r', 'claimed_at'),
    dishRows(ro, { mkey: key, rg, minRatings: 0, order: 'ratings', limit: 20 }),
    dishRows(ro, { mkey: key, rg, minRatings: 3, order: 'avgRating', limit: 5 }),
    dishRows(ro, { mkey: key, rg, minRatings: 3, order: 'worst', limit: 5, maxAvg: 3 }),
    dimensionsOf(ro, f, rg),
    reviewRows(ro, sql`f.mkey = ${key}`, 10),
  ]);
  const s = stats!;
  const dates = [...new Set([...ratingTrend.map((t) => t.date), ...receiptTrend.map((t) => t.date)])].sort();
  return {
    restaurant: restaurantItem(row),
    kpis: {
      receipts: s.receipts,
      ratings: s.ratings,
      reviewers: s.reviewers,
      avgRating: round(s.avg),
      receiptToRatingRate: s.receipts ? round(s.rated / s.receipts, 4) : null,
      observedPurchaseValueMinor: s.value,
      cashbackConfirmedMinor: s.cashback,
    },
    distribution,
    trend: dates.map((date) => ({
      date,
      receipts: receiptTrend.find((t) => t.date === date)?.n ?? 0,
      ratings: ratingTrend.find((t) => t.date === date)?.n ?? 0,
      avgRating: round(ratingTrend.find((t) => t.date === date)?.avg ?? null),
    })),
    dishes: dishes.slice(0, 20).map(dishItem),
    best: best.slice(0, 5).map(dishItem),
    needsAttention: attention.slice(0, 5).map(dishItem),
    dimensions,
    reviews: reviews.slice(0, 10).map(reviewView),
  };
}

// ---------------------------------------------------------------- dishes

export const dishesQuery = listQuery.extend({
  restaurant: merchantKey.optional(),
  minRatings: z.coerce.number().int().min(0).max(1000).default(3),
  sort: z.enum(['ratings', 'avgRating', 'worst', 'purchases', 'recent']).optional(),
});
const D_SORT = {
  ratings: 'ratings desc, dkey',
  avgRating: 'avg_rating desc nulls last, ratings desc, dkey',
  worst: 'avg_rating asc nulls last, ratings desc, dkey',
  purchases: 'purchases desc, dkey',
  recent: 'last_rated desc nulls last, dkey',
};

type DRow = {
  dkey: string; name: string; mkey: string; restaurant: string; branch: string | null; purchases: number; ratings: number; avg_rating: number | null;
  n1: number; n2: number; n3: number; n4: number; n5: number; last_rated: Date | null;
};

function dishRows(ro: Db, o: { mkey?: string | undefined; dkey?: string | undefined; q?: string | undefined; rg: Range | null; minRatings: number; order: string; limit: number; offset?: number; maxAvg?: number }) {
  const c: SQL[] = [sql`coalesce(dr.ratings, 0) >= ${o.minRatings}`];
  if (o.mkey) c.push(sql`d.mkey = ${o.mkey}`);
  if (o.dkey) c.push(sql`d.dkey = ${o.dkey}`);
  if (o.q) c.push(sql`d.name ilike ${like(o.q)}`);
  if (o.maxAvg !== undefined) c.push(sql`dr.avg <= ${o.maxAvg}`);
  return all<DRow>(
    ro,
    sql`${BASE}, d as (select dkey, max(dshow) as name, max(mkey) as mkey, max(mname) as restaurant,
          case when count(distinct branch) = 1 then max(branch) end as branch, count(*)::int as purchases from it group by dkey),
      dr as (select dkey, count(*)::int as ratings, avg(rating)::float8 as avg,
          count(*) filter (where rating = 1)::int as n1, count(*) filter (where rating = 2)::int as n2, count(*) filter (where rating = 3)::int as n3,
          count(*) filter (where rating = 4)::int as n4, count(*) filter (where rating = 5)::int as n5, max(created_at) as last
        from f where hidden_at is null and ${between('created_at', o.rg)} group by dkey)
      select d.dkey, d.name, d.mkey, d.restaurant, d.branch, d.purchases, coalesce(dr.ratings, 0) as ratings, dr.avg as avg_rating,
        coalesce(dr.n1, 0) as n1, coalesce(dr.n2, 0) as n2, coalesce(dr.n3, 0) as n3, coalesce(dr.n4, 0) as n4, coalesce(dr.n5, 0) as n5, dr.last as last_rated
      from d left join dr on dr.dkey = d.dkey where ${sql.join(c, sql` and `)}
      order by ${orderBy(D_SORT, o.order, 'ratings')} limit ${o.limit + 1} offset ${o.offset ?? 0}`,
  );
}

const dishItem = (r: DRow) => ({
  key: r.dkey,
  name: r.name,
  restaurant: { key: r.mkey, name: r.restaurant },
  branch: r.branch,
  purchases: r.purchases,
  ratings: r.ratings,
  avgRating: round(r.avg_rating),
  distribution: [r.n1, r.n2, r.n3, r.n4, r.n5],
  positivePct: r.ratings ? round(((r.n4 + r.n5) / r.ratings) * 100, 1) : null,
  negativePct: r.ratings ? round(((r.n1 + r.n2) / r.ratings) * 100, 1) : null,
  lastRatedAt: r.last_rated,
});

export async function listDishes(ro: Db, q: z.infer<typeof dishesQuery>) {
  const offset = offsetOf(q.cursor);
  const rows = await dishRows(ro, { mkey: q.restaurant, q: q.q, rg: null, minRatings: q.minRatings, order: q.sort ?? 'ratings', limit: q.limit, offset });
  const page = paged(rows, q.limit, offset);
  return { ...page, items: page.items.map(dishItem) };
}

export const dishParam = z.object({ key: dishKey }).strict();

export async function dishDetail(ro: Db, key: string, q: z.infer<typeof detailQuery>, now: Date) {
  const rg = optionalRange(q, now);
  const [row] = await dishRows(ro, { dkey: key, rg, minRatings: 0, order: 'ratings', limit: 1 });
  if (!row) throw notFound();
  const f = sql`dkey = ${key}`;
  const [distribution, trend, dimensions, reviews, reviewers] = await Promise.all([
    distributionOf(ro, f, rg),
    trendRows(ro, f, rg, 'f', 'created_at'),
    dimensionsOf(ro, f, rg),
    reviewRows(ro, sql`f.dkey = ${key}`, 25),
    one<{ n: number }>(ro, sql`${BASE} select count(distinct user_id)::int as n from f where dkey = ${key} and hidden_at is null and ${between('created_at', rg)}`),
  ]);
  const item = dishItem(row);
  return {
    dish: { key: item.key, name: item.name, restaurant: item.restaurant, branch: item.branch, purchases: item.purchases },
    kpis: { ratings: item.ratings, reviewers: reviewers?.n ?? 0, avgRating: item.avgRating, positivePct: item.positivePct, negativePct: item.negativePct },
    distribution,
    trend: trend.reverse().map((t) => ({ date: t.date, ratings: t.n, avgRating: round(t.avg) })),
    dimensions,
    reviews: reviews.slice(0, 25).map(reviewView),
  };
}
