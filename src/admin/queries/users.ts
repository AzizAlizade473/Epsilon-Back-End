import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../../db/client.js';
import { notFound } from '../../errors.js';
import { maskEmail, maskPhone } from '../mask.js';
import { all, BASE, between, like, listQuery, offsetOf, one, orderBy, paged, rangeQuery, resolveRange } from './facts.js';
import { reviewRows, reviewView } from './reviews.js';

const round = (n: number | null, d = 2) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);
const fullName = (u: { first_name: string | null; last_name: string | null }) => [u.first_name, u.last_name].filter(Boolean).join(' ') || null;

export const usersQuery = listQuery.merge(rangeQuery).extend({ sort: z.enum(['newest', 'active', 'receipts', 'ratings', 'cashback']).optional() });
const SORT = {
  newest: 'created_at desc, id',
  active: 'last_active desc nulls last, id',
  receipts: 'receipts desc, id',
  ratings: 'ratings desc, id',
  cashback: 'cashback desc, id',
};

type URow = {
  id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; created_at: Date; deleted_at: Date | null;
  last_active: Date | null; receipts: number; ratings: number; cashback: number;
  reminders: boolean; cashback_updates: boolean; partner_updates: boolean; push_devices: number;
};

function userRows(ro: Db, where: SQL, order: SQL, limit: number, offset: number) {
  return all<URow>(
    ro,
    sql`${BASE}, ua as (select user_id, max(ts) as last_active from act group by user_id),
      rc as (select user_id, count(*)::int as n from r group by user_id),
      fc as (select user_id, count(*)::int as n from f where hidden_at is null group by user_id),
      lc as (select user_id, sum(amount_minor)::float8 as n from led where type = 'earned' and status = 'confirmed' group by user_id),
      dv as (select user_id, count(*)::int as n from devices group by user_id)
      select u.id, u.first_name, u.last_name, u.email, u.phone, u.created_at, u.deleted_at, ua.last_active,
        coalesce(rc.n, 0) as receipts, coalesce(fc.n, 0) as ratings, coalesce(lc.n, 0) as cashback,
        coalesce(np.reminders, true) as reminders, coalesce(np.cashback_updates, false) as cashback_updates,
        coalesce(np.partner_updates, false) as partner_updates, coalesce(dv.n, 0) as push_devices
      from users u left join ua on ua.user_id = u.id left join rc on rc.user_id = u.id left join fc on fc.user_id = u.id
        left join lc on lc.user_id = u.id left join dv on dv.user_id = u.id left join notification_preferences np on np.user_id = u.id
      where ${where} order by ${order} limit ${limit + 1} offset ${offset}`,
  );
}

const userItem = (u: URow) => ({
  id: u.id,
  name: fullName(u),
  emailMasked: maskEmail(u.email),
  phoneMasked: maskPhone(u.phone),
  createdAt: u.created_at,
  lastActiveAt: u.last_active,
  receipts: u.receipts,
  ratings: u.ratings,
  cashbackMinor: u.cashback,
  notifications: { reminders: u.reminders, cashbackUpdates: u.cashback_updates, partnerUpdates: u.partner_updates, pushDevices: u.push_devices },
  status: u.deleted_at ? 'deleted' : 'active',
});

export async function listUsers(ro: Db, q: z.infer<typeof usersQuery>, now: Date) {
  const c: SQL[] = [sql`true`];
  if (q.from || q.to) c.push(between('u.created_at', resolveRange(q, now)));
  // Contact data is matched exactly, never by prefix, so search cannot be used to guess a masked number.
  if (q.q)
    c.push(sql`(concat_ws(' ', u.first_name, u.last_name) ilike ${like(q.q)} or lower(u.email) = ${q.q.toLowerCase()} or u.phone = ${q.q.replace(/[\s()-]/g, '')})`);
  const offset = offsetOf(q.cursor);
  const rows = await userRows(ro, sql.join(c, sql` and `), orderBy(SORT, q.sort, 'newest'), q.limit, offset);
  const page = paged(rows, q.limit, offset);
  return { ...page, items: page.items.map(userItem) };
}

export async function userDetail(ro: Db, id: string) {
  const [u] = await userRows(ro, sql`u.id = ${id}::uuid`, sql`u.id`, 1, 0);
  if (!u) throw notFound();
  const [receipts, reviews, ledger, notifications, prefs] = await Promise.all([
    all<{ id: string; claimed_at: Date; total_minor: number; status: string; mkey: string; mname: string; provider: string | null }>(
      ro,
      sql`${BASE} select id, claimed_at, total_minor, status, mkey, mname, provider from r where user_id = ${id}::uuid order by claimed_at desc limit 50`,
    ),
    reviewRows(ro, sql`f.user_id = ${id}::uuid`, 50),
    all<{ id: string; type: string; status: string; amount_minor: number; created_at: Date; mkey: string }>(
      ro,
      sql`${BASE} select id, type::text, status::text, amount_minor, created_at, 'r:' || restaurant_id::text as mkey from led where user_id = ${id}::uuid order by created_at desc limit 50`,
    ),
    all<{ id: string; kind: string; title: string; created_at: Date; read_at: Date | null }>(
      ro,
      sql`select id, kind::text, title, created_at, read_at from notifications where user_id = ${id}::uuid order by created_at desc limit 50`,
    ),
    one<{ reminders: boolean; cashback_updates: boolean; partner_updates: boolean }>(ro, sql`select reminders, cashback_updates, partner_updates from notification_preferences where user_id = ${id}::uuid`),
  ]);
  const item = userItem(u);
  return {
    user: item,
    receipts: receipts.map((r) => ({ id: r.id, importedAt: r.claimed_at, totalMinor: r.total_minor, status: r.status, restaurant: { key: r.mkey, name: r.mname }, provider: r.provider })),
    reviews: reviews.slice(0, 50).map(reviewView),
    ledger: ledger.map((l) => ({ id: l.id, type: l.type, status: l.status, amountMinor: l.amount_minor, createdAt: l.created_at, restaurantKey: l.mkey })),
    notifications: notifications.map((n) => ({ id: n.id, kind: n.kind, title: n.title, createdAt: n.created_at, read: n.read_at !== null })),
    preferences: { reminders: prefs?.reminders ?? true, cashbackUpdates: prefs?.cashback_updates ?? false, partnerUpdates: prefs?.partner_updates ?? false },
  };
}

/** Full contact data. Only called after the permission check and the audit entry. */
export const userContact = (ro: Db, id: string) =>
  one<{ email: string | null; phone: string | null }>(ro, sql`select email, phone from users where id = ${id}::uuid and deleted_at is null`);

export async function usersAnalytics(ro: Db, rg: ReturnType<typeof resolveRange>) {
  const [reg, active, s, cohorts] = await Promise.all([
    all<{ date: string; n: number }>(ro, sql`select to_char((created_at at time zone 'Asia/Baku')::date, 'YYYY-MM-DD') as date, count(*)::int as n from users where deleted_at is null and ${between('created_at', rg)} group by 1 order by 1`),
    all<{ date: string; n: number }>(ro, sql`${BASE} select to_char(d, 'YYYY-MM-DD') as date, count(distinct user_id)::int as n from act where ${between('ts', rg)} group by d order by d`),
    one<{ active: number; returning: number; users: number; receipts: number; ratings: number; never: number; unrated: number; non_partner: number; reminders: number; cashback: number; partner: number }>(
      ro,
      sql`${BASE} select
        (select count(distinct user_id)::int from act where ${between('ts', rg)}) as active,
        (select count(*)::int from (select user_id from act where ${between('ts', rg)} group by user_id having count(distinct d) >= 2) x) as returning,
        (select count(*)::int from users where deleted_at is null and created_at < ${rg.toAt.toISOString()}::timestamptz) as users,
        (select count(*)::int from r where ${between('claimed_at', rg)}) as receipts,
        (select count(*)::int from f where hidden_at is null and ${between('created_at', rg)}) as ratings,
        (select count(*)::int from users u where u.deleted_at is null and not exists (select 1 from r where r.user_id = u.id)) as never,
        (select count(*)::int from users u where u.deleted_at is null and exists (select 1 from r where r.user_id = u.id) and not exists (select 1 from f where f.user_id = u.id and f.hidden_at is null)) as unrated,
        (select count(distinct f.user_id)::int from f join r on r.id = f.purchase_id where r.rid is null and f.hidden_at is null) as non_partner,
        (select count(*)::int from users u left join notification_preferences np on np.user_id = u.id where u.deleted_at is null and coalesce(np.reminders, true)) as reminders,
        (select count(*)::int from users u join notification_preferences np on np.user_id = u.id where u.deleted_at is null and np.cashback_updates) as cashback,
        (select count(*)::int from users u join notification_preferences np on np.user_id = u.id where u.deleted_at is null and np.partner_updates) as partner`,
    ),
    all<{ week: string; size: number; returned: number }>(
      ro,
      // "Returned" = active on any Baku day after the sign-up day.
      sql`${BASE} select to_char(date_trunc('week', u.created_at at time zone 'Asia/Baku'), 'YYYY-MM-DD') as week, count(*)::int as size,
        count(*) filter (where exists (select 1 from act where act.user_id = u.id and act.d > (u.created_at at time zone 'Asia/Baku')::date))::int as returned
        from users u where u.deleted_at is null and ${between('u.created_at', rg)} group by 1 order by 1`,
    ),
  ]);
  const x = s!;
  const rate = (n: number) => (x.users ? round(n / x.users, 4) : null);
  return {
    registrations: reg,
    active,
    returningUserPct: x.active ? round((x.returning / x.active) * 100, 1) : null,
    avgReceiptsPerUser: x.users ? round(x.receipts / x.users) : null,
    avgRatingsPerUser: x.users ? round(x.ratings / x.users) : null,
    neverScanned: x.never,
    scannedNeverRated: x.unrated,
    ratedNonPartner: x.non_partner,
    notificationOptInRate: { reminders: rate(x.reminders), cashbackUpdates: rate(x.cashback), partnerUpdates: rate(x.partner) },
    cohorts: cohorts.map((c) => ({ week: c.week, size: c.size, returned: c.returned })),
  };
}
