import { timingSafeEqual } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { Deps } from '../context.js';
import { branches, fiscalReceipts, restaurants } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { sha256 } from '../lib/crypto.js';
import { fiscalDocumentSchema, integrityProblems, withoutPersonal } from '../fiscal/document.js';
import { FISCAL_ID_LENGTH } from '../fiscal/qr.js';

/**
 * Partner POS ingestion. A partner restaurant's POS (or its e-kassa operator, under an
 * agreement) sends each sale here at the moment it is printed, keyed by the receipt's
 * Fiscal ID. When a customer later scans that receipt's QR, Epsilon already holds the
 * exact items: no photo is needed, the receipt counts as verified and partner cashback
 * rules apply. Authenticated with a per-restaurant key (only its SHA-256 is stored).
 */
export async function partnerRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/partner/receipts', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const key = request.headers['x-partner-key'];
    if (typeof key !== 'string' || key.length < 32) throw new ApiError(401, 'UNAUTHORIZED', 'Partner key required');
    const hash = sha256(key);
    const [partner] = await deps.db.select().from(restaurants).where(eq(restaurants.posKeyHash, hash));
    // Constant-time confirm (the lookup above is by hash, never by the raw key).
    if (!partner?.posKeyHash || !timingSafeEqual(Buffer.from(partner.posKeyHash), Buffer.from(hash)))
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid partner key');

    const parsed = fiscalDocumentSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_FAILED', 'Invalid receipt document');
    const doc = { ...parsed.data, additionalFields: withoutPersonal(parsed.data.additionalFields) };
    const fiscalId = doc.receipt.fiscalId.slice(0, FISCAL_ID_LENGTH);
    if (!/^[A-Za-z0-9]{12}$/.test(fiscalId)) throw new ApiError(422, 'VALIDATION_FAILED', 'Invalid fields: fiscalId');
    const problems = integrityProblems(doc);
    if (problems.length) throw new ApiError(422, 'RECEIPT_VERIFICATION_FAILED', 'Receipt does not add up', undefined, problems);
    // A partner may only send its own receipts: its VOEN must be on file and printed on the receipt.
    if (!partner.voen || doc.merchant.voen !== partner.voen)
      throw new ApiError(403, 'FORBIDDEN', 'Receipt belongs to another taxpayer');

    const [branch] = doc.merchant.objectCode
      ? await deps.db
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.restaurantId, partner.id), eq(branches.objectCode, doc.merchant.objectCode)))
      : [];
    const inserted = await deps.db
      .insert(fiscalReceipts)
      .values({
        issuer: 'e-kassa',
        fiscalId,
        provider: 'partner_pos',
        extractionEngine: 'structured',
        document: { ...doc, receipt: { ...doc.receipt, fiscalId } },
        raw: null,
        merchantVoen: doc.merchant.voen,
        objectCode: doc.merchant.objectCode,
        sector: 'horeca',
        businessType: 'restaurant',
        classificationMethod: 'epsilon_partner',
        classificationEvidence: {
          status: 'verified',
          evidence: [`Sent by Epsilon partner "${partner.name}" POS`],
          cashbackBps: partner.cashbackBps,
        },
        restaurantId: partner.id,
        branchId: branch?.id ?? null,
        retrievedAt: deps.now(),
      })
      // Idempotent: the same receipt sent twice is stored once.
      .onConflictDoNothing()
      .returning({ id: fiscalReceipts.id });
    if (inserted[0]) return reply.code(201).send({ fiscalId, status: 'stored' });
    const [existing] = await deps.db
      .select({ provider: fiscalReceipts.provider, restaurantId: fiscalReceipts.restaurantId })
      .from(fiscalReceipts)
      .where(and(eq(fiscalReceipts.issuer, 'e-kassa'), eq(fiscalReceipts.fiscalId, fiscalId)));
    if (existing?.provider === 'partner_pos' && existing.restaurantId === partner.id)
      return reply.code(200).send({ fiscalId, status: 'already_stored' });
    throw new ApiError(409, 'CONFLICT', 'This receipt is already recorded from another source');
  });
}
