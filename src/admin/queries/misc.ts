import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../../db/client.js';
import { maskId } from '../mask.js';
import { all, BASE, between, listQuery, offsetOf, one, optionalRange, paged, rangeQuery, uuid, type Range } from './facts.js';
import { listDishes, listRestaurants } from './merchants.js';
import { reviewRows, reviewView } from './reviews.js';
import { listUsers } from './users.js';

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------- notifications

export async function notificationStats(ro: Db, rg: Range) {
  const [byKind, optIn, devices] = await Promise.all([
    all<{ kind: string; sent: number; read: number }>(
      ro,
      sql`select kind::text, count(*)::int as sent, count(read_at)::int as read from notifications where ${between('created_at', rg)} group by kind order by kind`,
    ),
    one<{ users: number; reminders: number; cashback: number; partner: number }>(
      ro,
      sql`select count(*)::int as users, count(*) filter (where coalesce(np.reminders, true))::int as reminders,
        count(*) filter (where coalesce(np.cashback_updates, false))::int as cashback, count(*) filter (where coalesce(np.partner_updates, false))::int as partner
        from users u left join notification_preferences np on np.user_id = u.id where u.deleted_at is null`,
    ),
    one<{ devices: number; users: number }>(ro, sql`select count(*)::int as devices, count(distinct user_id)::int as users from devices`),
  ]);
  const o = optIn!;
  const rate = (n: number) => (o.users ? round(n / o.users) : null);
  return {
    sent: byKind.reduce((n, k) => n + k.sent, 0),
    read: byKind.reduce((n, k) => n + k.read, 0),
    byKind,
    optIn: { reminders: rate(o.reminders), cashbackUpdates: rate(o.cashback), partnerUpdates: rate(o.partner) },
    devices: { tokens: devices!.devices, users: devices!.users },
    delivery: 'not_tracked' as const,
  };
}

export const notificationsQuery = listQuery.merge(rangeQuery).extend({ kind: z.enum(['cashback', 'meal_reminder', 'partner']).optional() });

export async function listNotifications(ro: Db, q: z.infer<typeof notificationsQuery>, now: Date) {
  const c: SQL[] = [between('created_at', optionalRange(q, now))];
  if (q.kind) c.push(sql`kind::text = ${q.kind}`);
  const offset = offsetOf(q.cursor);
  // Titles only: no body, no push token.
  const rows = await all<{ id: string; kind: string; title: string; created_at: Date; read_at: Date | null; user_id: string }>(
    ro,
    sql`select id, kind::text, title, created_at, read_at, user_id from notifications where ${sql.join(c, sql` and `)} order by created_at desc, id limit ${q.limit + 1} offset ${offset}`,
  );
  const page = paged(rows, q.limit, offset);
  return { ...page, items: page.items.map((n) => ({ id: n.id, kind: n.kind, title: n.title, createdAt: n.created_at, read: n.read_at !== null, userId: n.user_id })) };
}

// ---------------------------------------------------------------- costs, health

export async function costs(ro: Db, rg: Range) {
  const byDay = await all<{ day: string; calls: number }>(ro, sql`select day, calls from gemini_usage where day >= ${rg.from} and day <= ${rg.to} order by day`);
  return {
    gemini: {
      calls: byDay.reduce((n, d) => n + d.calls, 0),
      byDay: byDay.map((d) => ({ date: d.day, calls: d.calls })),
      estimate: { minor: 0, basis: 'Estimate: free tier assumed, no per-call price is configured. Days are UTC.' },
    },
    email: 'not_tracked' as const,
    push: 'not_tracked' as const,
  };
}

export async function health(ro: Db, version: string) {
  const started = performance.now();
  let ok = true;
  try {
    await ro.execute(sql`select 1`);
  } catch {
    ok = false;
  }
  const latencyMs = Math.round(performance.now() - started);
  const last = ok ? await one<{ at: Date | null }>(ro, sql`select max(created_at) as at from notifications where kind = 'meal_reminder'`) : undefined;
  return {
    api: { uptimeS: Math.round(process.uptime()), version },
    db: { ok, latencyMs },
    // Last time a reminder was sent; the job itself keeps no run log.
    jobs: { mealReminders: { lastRunAt: last?.at ?? null } },
  };
}

// ---------------------------------------------------------------- audit

export const auditQuery = listQuery.merge(rangeQuery).extend({ admin: uuid.optional(), action: z.string().regex(/^[\w.:-]{1,60}$/).optional() });

export async function listAudit(ro: Db, q: z.infer<typeof auditQuery>, now: Date) {
  const c: SQL[] = [between('a.created_at', optionalRange(q, now))];
  if (q.admin) c.push(sql`a.admin_id = ${q.admin}::uuid`);
  if (q.action) c.push(sql`a.action = ${q.action}`);
  const offset = offsetOf(q.cursor);
  const rows = await all<{
    id: string; created_at: Date; admin_id: string | null; email: string | null; name: string | null; action: string; entity_type: string | null; entity_id: string | null;
    reason: string | null; outcome: string; ip: string | null; user_agent: string | null; before: unknown; after: unknown;
  }>(
    ro,
    sql`select a.id, a.created_at, a.admin_id, u.email, u.name, a.action, a.entity_type, a.entity_id, a.reason, a.outcome, a.ip, a.user_agent, a.before, a.after
      from admin_audit a left join admin_users u on u.id = a.admin_id where ${sql.join(c, sql` and `)}
      order by a.created_at desc, a.id limit ${q.limit + 1} offset ${offset}`,
  );
  const page = paged(rows, q.limit, offset);
  return {
    ...page,
    items: page.items.map((a) => ({
      id: a.id, at: a.created_at, admin: a.admin_id ? { id: a.admin_id, email: a.email, name: a.name } : null, action: a.action,
      entityType: a.entity_type, entityId: a.entity_id, reason: a.reason, outcome: a.outcome, ip: a.ip, userAgent: a.user_agent, before: a.before, after: a.after,
    })),
  };
}

// ---------------------------------------------------------------- search

export const searchQuery = z.object({ q: z.string().trim().min(2).max(100) });

export async function search(ro: Db, q: string, now: Date) {
  const base = { limit: 5, q } as const;
  const [users, restaurants, dishes, reviews, receipts] = await Promise.all([
    listUsers(ro, { ...base }, now),
    listRestaurants(ro, { ...base }),
    listDishes(ro, { ...base, minRatings: 0 }),
    reviewRows(ro, sql`f.comment ilike ${`%${q.replace(/[\\%_]/g, '\\$&')}%`}`, 5),
    all<{ id: string; fiscal_id: string | null; mkey: string; mname: string; claimed_at: Date }>(
      ro,
      sql`${BASE} select id, fiscal_id, mkey, mname, claimed_at from r where fiscal_id = ${q} or mname ilike ${`%${q.replace(/[\\%_]/g, '\\$&')}%`} order by claimed_at desc limit 5`,
    ),
  ]);
  return {
    users: users.items,
    restaurants: restaurants.items,
    dishes: dishes.items,
    reviews: reviews.slice(0, 5).map(reviewView),
    receipts: receipts.map((r) => ({ id: r.id, fiscalIdMasked: maskId(r.fiscal_id), restaurant: { key: r.mkey, name: r.mname }, importedAt: r.claimed_at })),
  };
}
