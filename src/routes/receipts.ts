import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Deps } from '../context.js';
import { purchases } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { sha256 } from '../lib/crypto.js';
import { idempotent } from '../lib/idempotency.js';
import { idParam, parse } from '../lib/validation.js';
import { loadUser, receiptView } from '../lib/views.js';

const resolveBody = z
  .object({
    kind: z.enum(['qr', 'code']),
    value: z.string().min(1).max(2048).refine((v) => v.trim().length > 0),
  })
  .strict();

/** The opaque reference printed on the bill. Only its SHA-256 is stored, and the
 * QR carries nothing else the server trusts (no amount, no restaurant). */
export const referenceHash = (value: string) => sha256(value.trim().toUpperCase());

export async function receiptRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/receipts/resolve', { config: { auth: true, rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const auth = request.auth!;
    const body = parse(resolveBody, request.body);
    const out = await idempotent(deps, request, auth.userId, 'receipt.resolve', async (tx) => {
      const now = deps.now();
      const [purchase] = await tx
        .select()
        .from(purchases)
        .where(eq(purchases.referenceHash, referenceHash(body.value)))
        .for('update');
      if (!purchase) throw new ApiError(404, 'RECEIPT_NOT_FOUND', 'Receipt not found');
      if (purchase.status !== 'open') throw new ApiError(422, 'RECEIPT_UNSUPPORTED', 'Receipt not eligible');
      if (purchase.claimedBy && purchase.claimedBy !== auth.userId)
        throw new ApiError(409, 'RECEIPT_ALREADY_CLAIMED', 'Receipt already claimed');
      if (!purchase.claimedBy) {
        if (purchase.expiresAt <= now) throw new ApiError(410, 'RECEIPT_EXPIRED', 'Receipt expired');
        await tx.update(purchases).set({ claimedBy: auth.userId, claimedAt: now }).where(eq(purchases.id, purchase.id));
      }
      const user = await loadUser(tx, auth.userId);
      return { status: 200, body: await receiptView(tx, purchase.id, user, deps.config, now) };
    });
    return reply.code(out.status).send(out.body);
  });

  app.get('/receipts/:id', { config: { auth: true } }, async (request) => {
    const { id } = parse(idParam, request.params);
    const user = await loadUser(deps.db, request.auth!.userId);
    return receiptView(deps.db, id, user, deps.config, deps.now());
  });
}
