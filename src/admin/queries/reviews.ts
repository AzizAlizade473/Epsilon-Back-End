import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../../db/client.js';
import { LEGACY_REASON_CODES, QUICK_COMMENTS } from '../../lib/quick-comments.js';
import { all, BASE, between, dishKey, listQuery, merchantKey, offsetOf, optionalRange, paged, rangeQuery, uuid } from './facts.js';

export type Sentiment = 'positive' | 'neutral' | 'negative' | 'unknown';

/** Quick comments carry dimension and sentiment; legacy codes map to their own dimension, sentiment unknown. */
export function tag(code: string): { dimension: string; sentiment: Sentiment } {
  const q = QUICK_COMMENTS[code];
  return q ? { dimension: q.dimension, sentiment: q.sentiment } : { dimension: code, sentiment: 'unknown' };
}

/** `rows`: how often each reason code was chosen. */
export function dimensionCounts(rows: { code: string; n: number }[]) {
  const out: Record<string, Record<Sentiment, number>> = {};
  for (const { code, n } of rows) {
    const t = tag(code);
    (out[t.dimension] ??= { positive: 0, neutral: 0, negative: 0, unknown: 0 })[t.sentiment] += n;
  }
  return out;
}

function codesFor(dimension?: string, sentiment?: string): string[] {
  const codes = Object.keys(QUICK_COMMENTS).filter((c) => (!dimension || tag(c).dimension === dimension) && (!sentiment || tag(c).sentiment === sentiment));
  if (!sentiment || sentiment === 'unknown') codes.push(...LEGACY_REASON_CODES.filter((c) => !dimension || c === dimension));
  return codes;
}

const flag = z.enum(['true', 'false']).transform((v) => v === 'true');
export const reviewsQuery = listQuery.merge(rangeQuery).extend({
  restaurant: merchantKey.optional(),
  dish: dishKey.optional(),
  user: uuid.optional(),
  stars: z.coerce.number().int().min(1).max(5).optional(),
  dimension: z.string().regex(/^\w{1,30}$/).optional(),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'unknown']).optional(),
  hasComment: flag.optional(),
  edited: flag.optional(),
  moderated: flag.optional(),
});

type Row = {
  id: string; user_id: string; first_name: string | null; rating: number; comment: string | null; created_at: Date; updated_at: Date | null;
  hidden_at: Date | null; hidden_reason: string | null; mkey: string; mname: string; branch: string | null; dkey: string; dshow: string; codes: string[];
};

export const reviewView = (r: Row) => ({
  id: r.id,
  restaurant: { key: r.mkey, name: r.mname, branch: r.branch },
  dish: { key: r.dkey, name: r.dshow },
  reviewer: { id: r.user_id, name: r.first_name },
  rating: r.rating,
  quickComments: r.codes.map((code) => ({ code, ...tag(code) })),
  comment: r.comment,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  edited: r.updated_at !== null,
  moderation: { hidden: r.hidden_at !== null, reason: r.hidden_reason, at: r.hidden_at },
});

/** Reviews (hidden included, flagged) matching `where`, newest first. */
export function reviewRows(ro: Db, where: SQL, limit: number, offset = 0) {
  return all<Row>(
    ro,
    sql`${BASE} select f.id, f.user_id, u.first_name, f.rating::int as rating, f.comment, f.created_at, f.updated_at, f.hidden_at, f.hidden_reason,
      f.mkey, f.mname, f.branch, f.dkey, f.dshow,
      coalesce((select array_agg(fr.code order by fr.code) from feedback_reasons fr where fr.feedback_id = f.id), '{}')::text[] as codes
      from f join users u on u.id = f.user_id where ${where}
      order by f.created_at desc, f.id limit ${limit + 1} offset ${offset}`,
  );
}

export async function listReviews(ro: Db, q: z.infer<typeof reviewsQuery>, now: Date) {
  const rg = optionalRange(q, now);
  const c: SQL[] = [between('f.created_at', rg)];
  if (q.restaurant) c.push(sql`f.mkey = ${q.restaurant}`);
  if (q.dish) c.push(sql`f.dkey = ${q.dish}`);
  if (q.user) c.push(sql`f.user_id = ${q.user}::uuid`);
  if (q.stars) c.push(sql`f.rating = ${q.stars}`);
  if (q.hasComment !== undefined) c.push(q.hasComment ? sql`coalesce(btrim(f.comment), '') <> ''` : sql`coalesce(btrim(f.comment), '') = ''`);
  if (q.edited !== undefined) c.push(q.edited ? sql`f.updated_at is not null` : sql`f.updated_at is null`);
  if (q.moderated !== undefined) c.push(q.moderated ? sql`f.hidden_at is not null` : sql`f.hidden_at is null`);
  if (q.dimension || q.sentiment) {
    const codes = codesFor(q.dimension, q.sentiment);
    c.push(codes.length ? sql`exists (select 1 from feedback_reasons x where x.feedback_id = f.id and x.code in (${sql.join(codes.map((k) => sql`${k}`), sql`, `)}))` : sql`false`);
  }
  const offset = offsetOf(q.cursor);
  const rows = await reviewRows(ro, sql.join(c, sql` and `), q.limit, offset);
  const page = paged(rows, q.limit, offset);
  return { ...page, items: page.items.map(reviewView) };
}
