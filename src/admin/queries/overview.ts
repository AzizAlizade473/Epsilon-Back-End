import { sql } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { all, between, one, previousRange, type Range, BASE } from './facts.js';

const iso = (d: Date) => d.toISOString();
const round = (n: number | null, digits = 2) => (n === null ? null : Math.round(n * 10 ** digits) / 10 ** digits);

type KpiRow = {
  total_users: number; new_users: number; dau: number; wau: number; mau: number; active: number; returning: number;
  receipts: number; unique_restaurants: number; partners: number; rated_receipts: number; ratings: number; avg: number | null; cashback: number;
};

/** Window of `n` Baku days ending with the range's last day. */
const lastDays = (rg: Range, n: number) => sql`ts >= ${iso(new Date(rg.toAt.getTime() - n * 86_400_000))}::timestamptz and ts < ${iso(rg.toAt)}::timestamptz`;

export async function kpis(ro: Db, rg: Range) {
  const row = (await one<KpiRow>(
    ro,
    sql`${BASE} select
      (select count(*)::int from users where deleted_at is null and created_at < ${iso(rg.toAt)}::timestamptz) as total_users,
      (select count(*)::int from users where deleted_at is null and ${between('created_at', rg)}) as new_users,
      (select count(distinct user_id)::int from act where ${lastDays(rg, 1)}) as dau,
      (select count(distinct user_id)::int from act where ${lastDays(rg, 7)}) as wau,
      (select count(distinct user_id)::int from act where ${lastDays(rg, 30)}) as mau,
      (select count(distinct user_id)::int from act where ${between('ts', rg)}) as active,
      (select count(*)::int from (select user_id from act where ${between('ts', rg)} group by user_id having count(distinct d) >= 2) x) as returning,
      (select count(distinct rkey)::int from r where ${between('claimed_at', rg)}) as receipts,
      (select count(distinct mkey)::int from r where ${between('claimed_at', rg)}) as unique_restaurants,
      (select count(distinct rid)::int from r where ${between('claimed_at', rg)}) as partners,
      (select count(distinct rkey)::int from r where ${between('claimed_at', rg)}
         and exists (select 1 from f where f.rkey = r.rkey and f.hidden_at is null)) as rated_receipts,
      (select count(*)::int from f where hidden_at is null and ${between('created_at', rg)}) as ratings,
      (select avg(rating)::float8 from f where hidden_at is null and ${between('created_at', rg)}) as avg,
      (select coalesce(sum(amount_minor), 0)::float8 from led where type = 'earned' and status = 'confirmed' and ${between('created_at', rg)}) as cashback`,
  ))!;
  return {
    totalUsers: row.total_users,
    newUsers: row.new_users,
    dau: row.dau,
    wau: row.wau,
    mau: row.mau,
    receiptsImported: row.receipts,
    uniqueRestaurants: row.unique_restaurants,
    ratings: row.ratings,
    avgRating: round(row.avg),
    cashbackConfirmedMinor: row.cashback,
    activePartners: row.partners,
    receiptToRatingRate: row.receipts ? round(row.rated_receipts / row.receipts, 4) : null,
    returningUserPct: row.active ? round((row.returning / row.active) * 100, 1) : null,
    avgRatingsPerReceipt: row.receipts ? round(row.ratings / row.receipts) : null,
  };
}

export async function overview(ro: Db, rg: Range) {
  const [current, previous, days, distribution, top, activity] = await Promise.all([
    kpis(ro, rg),
    kpis(ro, previousRange(rg)),
    all<{ date: string; new_users: number; active_users: number; receipts: number; ratings: number }>(
      ro,
      sql`${BASE} select to_char(g.d, 'YYYY-MM-DD') as date,
        (select count(*)::int from users u where u.deleted_at is null and (u.created_at at time zone 'Asia/Baku')::date = g.d) as new_users,
        (select count(distinct user_id)::int from act where act.d = g.d) as active_users,
        (select count(distinct rkey)::int from r where (r.claimed_at at time zone 'Asia/Baku')::date = g.d) as receipts,
        (select count(*)::int from f where f.hidden_at is null and (f.created_at at time zone 'Asia/Baku')::date = g.d) as ratings
        from generate_series(${rg.from}::date, ${rg.to}::date, interval '1 day') as g(d) order by g.d`,
    ),
    all<{ rating: number; n: number }>(ro, sql`${BASE} select rating::int, count(*)::int as n from f where hidden_at is null and ${between('created_at', rg)} group by rating`),
    all<{ mkey: string; name: string; logo: string | null; receipts: number; ratings: number; avg: number | null }>(
      ro,
      sql`${BASE} select r.mkey, max(r.mname) as name, max(r.logo) as logo, count(distinct r.rkey)::int as receipts,
        (select count(*)::int from f where f.mkey = r.mkey and f.hidden_at is null and ${between('f.created_at', rg)}) as ratings,
        (select avg(rating)::float8 from f where f.mkey = r.mkey and f.hidden_at is null and ${between('f.created_at', rg)}) as avg
        from r where ${between('r.claimed_at', rg)} group by r.mkey order by receipts desc, r.mkey limit 5`,
    ),
    all<{ type: string; at: Date; text: string }>(
      ro,
      // PII-free: no names, phones or comments.
      sql`${BASE} select * from (
        select 'user' as type, created_at as at, 'New user registered' as text from users where deleted_at is null
        union all select 'receipt', claimed_at, 'Receipt imported: ' || mname from r
        union all select 'review', created_at, rating::text || ' star review: ' || dshow || ' at ' || mname from f where hidden_at is null
        union all select 'cashback', created_at, 'Cashback confirmed: ' || to_char(amount_minor / 100.0, 'FM990.00') || ' AZN' from led where type = 'earned' and status = 'confirmed'
      ) a order by at desc limit 15`,
    ),
  ]);
  const dist = [1, 2, 3, 4, 5].map((s) => distribution.find((d) => d.rating === s)?.n ?? 0);
  return {
    kpis: current,
    previous,
    series: { days: days.map((d) => ({ date: d.date, newUsers: d.new_users, activeUsers: d.active_users, receipts: d.receipts, ratings: d.ratings })) },
    ratingDistribution: dist,
    topRestaurants: top.map((t) => ({ key: t.mkey, name: t.name, logoBrand: t.logo, receipts: t.receipts, ratings: t.ratings, avgRating: round(t.avg) })),
    activity: activity.map((a) => ({ type: a.type, at: a.at, text: a.text })),
  };
}
