import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../../db/client.js';
import { ApiError } from '../../errors.js';
import { likePattern } from '../../lib/validation.js';

/** Every analytics query is parameterised `sql`; the only `sql.raw` inputs are constants in this module. */
export async function all<T>(db: Db, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as T[] | { rows: T[] };
  return Array.isArray(result) ? result : result.rows;
}
export const one = async <T>(db: Db, query: SQL) => (await all<T>(db, query))[0];

// ---------------------------------------------------------------- ranges (Asia/Baku days, UTC+4 all year)

const day = z.iso.date();
export const rangeQuery = z.object({ from: day.optional(), to: day.optional() });
export type Range = { from: string; to: string; fromAt: Date; toAt: Date; days: number };

const DAY = 86_400_000;
const bakuStart = (d: string) => new Date(`${d}T00:00:00+04:00`);
const shift = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
export const bakuToday = (now: Date) => new Date(now.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);

export function makeRange(from: string, to: string): Range {
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY + 1;
  if (days < 1 || days > 366) throw new ApiError(422, 'VALIDATION_FAILED', 'Invalid fields: from, to');
  return { from, to, fromAt: bakuStart(from), toAt: bakuStart(shift(to, 1)), days };
}

/** `from`/`to` default to the last `defaultDays` Baku days. */
export function resolveRange(query: { from?: string | undefined; to?: string | undefined }, now: Date, defaultDays = 30): Range {
  const to = query.to ?? bakuToday(now);
  return makeRange(query.from ?? shift(to, 1 - defaultDays), to);
}

/** All time unless the caller passed a bound. */
export const optionalRange = (query: { from?: string | undefined; to?: string | undefined }, now: Date) =>
  query.from || query.to ? resolveRange(query, now) : null;

export const previousRange = (r: Range) => makeRange(shift(r.from, -r.days), shift(r.from, -1));

/** `col` is a constant column name from this codebase, never user input. */
export const between = (col: string, r: Range | null): SQL =>
  r ? sql`(${sql.raw(col)} >= ${r.fromAt.toISOString()}::timestamptz and ${sql.raw(col)} < ${r.toAt.toISOString()}::timestamptz)` : sql`true`;

export const baku = (col: string) => sql`(${sql.raw(col)} at time zone 'Asia/Baku')::date`;

// ---------------------------------------------------------------- pagination (offset cursor, bounded)

export const listQuery = z.object({
  cursor: z.string().max(16).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
});

export function offsetOf(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d{1,5}$/.test(n)) throw new ApiError(422, 'VALIDATION_FAILED', 'Invalid cursor');
  return Number(n);
}

/** Fetch `limit + 1` rows from `offset`; returns the page and the cursor for the next one. */
export function paged<T>(rows: T[], limit: number, offset: number) {
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? Buffer.from(String(offset + limit)).toString('base64url') : null };
}

export { likePattern as like };

/** Sort keys map to fixed SQL; the client only picks a key. */
export function orderBy(map: Record<string, string>, key: string | undefined, fallback: string): SQL {
  return sql.raw(map[key ?? ''] ?? map[fallback]!);
}

export const merchantKey = z.string().regex(/^(r:[0-9a-f-]{36}|m:[\w.-]{1,64})$/);
export const dishKey = z.string().regex(/^[0-9a-f]{32}$/);
export const uuid = z.uuid();

// ---------------------------------------------------------------- shared fact tables

/** Trailing VAT marker on fiscal item names ("LAVASH *18%"). */
const VAT = '\\s*\\*\\s*(\\d{1,2}\\s*%)?\\s*$';

/**
 * Claimed purchases with their merchant. Merchant key: `r:<restaurantId>` for partners,
 * `m:<establishment code>` otherwise (VÖEN, then 'unknown', when no code). Fixture receipts are
 * test data and never counted. `rkey` identifies the physical receipt: two users scanning the
 * same fiscal receipt are two purchases but one receipt.
 */
const RECEIPTS = sql`select p.id, p.claimed_by as user_id, p.claimed_at, p.issued_at, p.total_minor, p.status::text as status,
    coalesce(p.fiscal_receipt_id::text, p.id::text) as rkey, p.fiscal_receipt_id as fid,
    fr.provider, fr.extraction_engine as engine, fr.fiscal_id, fr.sector, fr.business_type, fr.merchant_voen as voen, fr.object_code,
    rs.id as rid, rs.logo_url as logo,
    case when rs.id is not null then 'r:' || rs.id::text else 'm:' || coalesce(fr.object_code, fr.merchant_voen, 'unknown') end as mkey,
    coalesce(rs.name, fr.document->'merchant'->>'objectName', fr.document->'merchant'->>'displayName', 'Unknown') as mname,
    coalesce(rs.name, fr.document->'merchant'->>'displayName', 'Unknown') as chain,
    coalesce(b.name, fr.document->'merchant'->>'objectName') as branch,
    coalesce((fr.classification_evidence->>'cashbackBps')::int, rs.cashback_bps, 0) as bps
  from purchases p
  left join fiscal_receipts fr on fr.id = p.fiscal_receipt_id
  left join branches b on b.id = p.branch_id
  left join restaurants rs on rs.id = coalesce(b.restaurant_id, fr.restaurant_id)
  where p.claimed_by is not null and coalesce(fr.provider, '') <> 'fixture'`;

/**
 * r = receipts, it = purchased lines (dish key = merchant key + lower-cased name without VAT marker),
 * f = reviews (hidden ones included: aggregates add `hidden_at is null`), led = ledger without
 * test data, act = one row per user activity (sign-in/refresh, receipt claim, review create/edit).
 */
export const BASE = sql`with r as (${RECEIPTS}),
  it as (select pi.id, pi.purchase_id, pi.quantity, pi.unit_price_minor, pi.name, r.mkey, r.mname, r.branch, r.user_id, r.rkey,
      btrim(regexp_replace(pi.name, ${VAT}, '')) as dshow,
      md5(r.mkey || '|' || lower(btrim(regexp_replace(pi.name, ${VAT}, '')))) as dkey
    from purchase_items pi join r on r.id = pi.purchase_id),
  f as (select fb.id, fb.user_id, fb.rating, fb.comment, fb.created_at, fb.updated_at, fb.hidden_at, fb.hidden_reason, fb.purchase_item_id,
      it.name as item_name, it.dshow, it.dkey, it.mkey, it.mname, it.branch, it.rkey, it.purchase_id
    from feedback fb join it on it.id = fb.purchase_item_id),
  led as (select l.* from ledger_entries l where l.purchase_item_id is null or l.purchase_item_id in (select id from it)),
  act as (select user_id, ts, (ts at time zone 'Asia/Baku')::date as d from (
      select user_id, created_at as ts from sessions
      union all select user_id, claimed_at from r
      union all select user_id, created_at from f
      union all select user_id, updated_at from f where updated_at is not null) a
    -- Deleted accounts are not active users (and are not counted in total users either).
    where ts is not null and user_id in (select id from users where deleted_at is null))`;
