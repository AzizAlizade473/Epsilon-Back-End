import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../../db/client.js';
import { maskEmail, maskPhone } from '../mask.js';
import { all, between, listQuery, offsetOf, optionalRange, paged, rangeQuery, type Range } from './facts.js';

type Kind = 'dish' | 'review' | 'restaurant';
const TOP = 10;

/** Likes of non-deleted accounts only. */
const LIVE = sql`likes l join users u on u.id = l.user_id and u.deleted_at is null`;

export async function likeCounts(ro: Db, where: SQL) {
  const rows = await all<{ kind: Kind; n: number }>(ro, sql`select l.kind::text as kind, count(*)::int as n from ${LIVE} where ${where} group by 1`);
  const counts = { dish: 0, review: 0, restaurant: 0 };
  for (const r of rows) counts[r.kind] = r.n;
  return counts;
}

type Target = { kind: Kind; target_id: string; restaurant_id: string; dish_id: string | null; title: string; subtitle: string };
const target = (r: Target) => ({
  kind: r.kind, targetId: r.target_id, restaurantId: r.restaurant_id, dishId: r.dish_id, title: r.title, subtitle: r.subtitle,
});

export async function likeStats(ro: Db, rg: Range) {
  const where = between('l.created_at', rg);
  const [counts, rows] = await Promise.all([
    likeCounts(ro, where),
    // Snapshots are client-supplied: show the most common one, so a single account cannot rename a target.
    all<Target & { n: number }>(
      ro,
      sql`select * from (
          select l.kind::text as kind, l.target_id, mode() within group (order by l.restaurant_id) as restaurant_id,
            mode() within group (order by l.dish_id) as dish_id, mode() within group (order by l.title) as title,
            mode() within group (order by l.subtitle) as subtitle, count(*)::int as n,
            row_number() over (partition by l.kind order by count(*) desc, l.target_id) as pos
          from ${LIVE} where ${where} group by l.kind, l.target_id
        ) x where pos <= ${TOP} order by kind, pos`,
    ),
  ]);
  const top = (kind: Kind) => rows.filter((r) => r.kind === kind).map((r) => ({ ...target(r), count: r.n }));
  return { counts, top: { dish: top('dish'), review: top('review'), restaurant: top('restaurant') } };
}

export const likesQuery = listQuery.merge(rangeQuery).extend({ kind: z.enum(['dish', 'review', 'restaurant']).optional() });

export async function listLikes(ro: Db, q: z.infer<typeof likesQuery>, now: Date) {
  const c: SQL[] = [between('l.created_at', optionalRange(q, now))];
  if (q.kind) c.push(sql`l.kind::text = ${q.kind}`);
  const offset = offsetOf(q.cursor);
  const rows = await all<Target & { id: string; created_at: Date; user_id: string; first_name: string | null; email: string | null; phone: string | null }>(
    ro,
    sql`select l.id, l.kind::text as kind, l.target_id, l.restaurant_id, l.dish_id, l.title, l.subtitle, l.created_at, l.user_id, u.first_name, u.email, u.phone
      from ${LIVE} where ${sql.join(c, sql` and `)} order by l.created_at desc, l.id limit ${q.limit + 1} offset ${offset}`,
  );
  const page = paged(rows, q.limit, offset);
  return {
    ...page,
    items: page.items.map((r) => ({
      id: r.id,
      ...target(r),
      createdAt: r.created_at,
      user: { id: r.user_id, name: r.first_name, emailMasked: maskEmail(r.email), phoneMasked: maskPhone(r.phone) },
    })),
  };
}
