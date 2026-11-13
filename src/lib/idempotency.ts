import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

import type { Deps } from '../context.js';
import type { Tx } from '../db/client.js';
import { idempotencyKeys } from '../db/schema.js';
import { ApiError, uniqueViolation } from '../errors.js';
import { sha256 } from './crypto.js';

export type Outcome = { status: number; body: unknown };

const KEY = /^[\w-]{8,128}$/;

/** Runs a mutation once per (user, Idempotency-Key).
 * - The stored response is committed in the same transaction as the mutation.
 * - Same key + same operation/payload → the stored response is replayed.
 * - Same key + different payload → 422, no side effects.
 * - Errors are not stored; a retry re-evaluates and fails the same way.
 * shortcut: rows are kept forever; add a purge job (>= 8 days) before launch. */
export async function idempotent(
  deps: Deps,
  request: FastifyRequest,
  userId: string,
  operation: string,
  run: (tx: Tx) => Promise<Outcome>,
): Promise<Outcome> {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !KEY.test(key))
    throw new ApiError(422, 'VALIDATION_FAILED', 'Idempotency-Key header required');
  const requestHash = sha256(`${operation}\n${JSON.stringify(request.body ?? null)}`);

  const replay = async (): Promise<Outcome | null> => {
    const [stored] = await deps.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
    if (!stored) return null;
    if (stored.operation !== operation || stored.requestHash !== requestHash)
      throw new ApiError(422, 'VALIDATION_FAILED', 'Idempotency-Key reused with a different request');
    return { status: stored.responseStatus, body: stored.responseBody };
  };

  const previous = await replay();
  if (previous) return previous;
  try {
    return await deps.db.transaction(async (tx) => {
      const outcome = await run(tx);
      await tx.insert(idempotencyKeys).values({
        userId,
        key,
        operation,
        requestHash,
        responseStatus: outcome.status,
        responseBody: outcome.body ?? null,
      });
      return outcome;
    });
  } catch (error) {
    // A concurrent request with the same key committed first: replay its result.
    if (uniqueViolation(error) === 'idempotency_keys_user_id_key_pk') {
      const winner = await replay();
      if (winner) return winner;
    }
    throw error;
  }
}
