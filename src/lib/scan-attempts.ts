import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

import type { Deps } from '../context.js';
import { scanAttempts } from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { FiscalRef } from '../fiscal/qr.js';
import { sha256 } from './crypto.js';
import type { Outcome } from './idempotency.js';

/** What was scanned. `ref` is filled in by the route once the text is recognised as a fiscal receipt. */
export type Scan = { value: string; ref: FiscalRef | null };

type Result = { status: 'success'; receiptId: string; restaurantName: string } | { status: 'failed'; reason: string };

async function record(deps: Deps, userId: string, { value, ref }: Scan, result: Result) {
  const row = {
    at: deps.now(),
    status: result.status,
    reason: result.status === 'failed' ? result.reason : null,
    // Only a fiscal receipt can be retried later: nothing else is kept that could be sent again.
    retryable: result.status === 'failed' && ref !== null,
    fiscalDocument: ref?.document ?? null,
    receiptId: result.status === 'success' ? result.receiptId : null,
    restaurantName: result.status === 'success' ? result.restaurantName : null,
  };
  await deps.db
    .insert(scanAttempts)
    .values({ userId, subject: ref ? `fiscal:${ref.fiscalId}` : `code:${sha256(value.trim().toUpperCase())}`, ...row })
    .onConflictDoUpdate({
      target: [scanAttempts.userId, scanAttempts.subject],
      set: row,
      // A later failure never erases a receipt the customer already has.
      setWhere: sql`${scanAttempts.status} <> 'success' or excluded.status = 'success'`,
    });
}

/** Runs a receipt resolve or import and records its outcome. Recording never changes the response. */
export async function trackScan(deps: Deps, request: FastifyRequest, scan: Scan, run: () => Promise<Outcome>): Promise<Outcome> {
  const save = (result: Result) =>
    record(deps, request.auth!.userId, scan, result).catch(() => request.log.warn('scan attempt not recorded'));
  try {
    const out = await run();
    const receipt = out.body as { id: string; restaurant: { name: string } };
    await save({ status: 'success', receiptId: receipt.id, restaurantName: receipt.restaurant.name });
    return out;
  } catch (error) {
    await save({ status: 'failed', reason: error instanceof ApiError ? error.code : 'INTERNAL' });
    throw error;
  }
}
