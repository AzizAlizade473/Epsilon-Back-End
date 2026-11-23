import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { Deps } from '../context.js';
import { branches, ledgerEntries, purchaseItems, restaurants } from '../db/schema.js';
import { notFound } from '../errors.js';
import { decodeTimeCursor, encodeCursor, idParam, pageQuery, parse } from '../lib/validation.js';
import { transactionColumns, transactionView } from '../lib/views.js';

/** Balance is always derived from the ledger, never stored separately. */
export async function walletBalance(deps: Deps, userId: string) {
  const [row] = await deps.db
    .select({
      confirmed: sql<string>`coalesce(sum(${ledgerEntries.amountMinor}) filter (where ${ledgerEntries.status} = 'confirmed'), 0)`,
      pending: sql<string>`coalesce(sum(${ledgerEntries.amountMinor}) filter (where ${ledgerEntries.status} = 'pending'), 0)`,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.userId, userId));
  // sum() of int is bigint; Number() is exact below 2^53 qəpik.
  return { balanceMinor: Number(row?.confirmed ?? 0), pendingMinor: Number(row?.pending ?? 0), currency: 'AZN' as const };
}

function transactionsQuery(deps: Deps) {
  return deps.db
    .select(transactionColumns)
    .from(ledgerEntries)
    .innerJoin(restaurants, eq(restaurants.id, ledgerEntries.restaurantId))
    .leftJoin(branches, eq(branches.id, ledgerEntries.branchId))
    .leftJoin(purchaseItems, eq(purchaseItems.id, ledgerEntries.purchaseItemId));
}

export async function walletRoutes(app: FastifyInstance, deps: Deps) {
  const authed = { config: { auth: true } };

  app.get('/wallet', authed, async (request) => walletBalance(deps, request.auth!.userId));

  app.get('/wallet/transactions', authed, async (request) => {
    const query = parse(pageQuery, request.query);
    const after = decodeTimeCursor(query.cursor);
    const rows = await transactionsQuery(deps)
      .where(
        and(
          eq(ledgerEntries.userId, request.auth!.userId),
          after
            ? or(
                lt(ledgerEntries.createdAt, after[0]),
                and(eq(ledgerEntries.createdAt, after[0]), lt(ledgerEntries.id, after[1])),
              )
            : undefined,
        ),
      )
      .orderBy(desc(ledgerEntries.createdAt), desc(ledgerEntries.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(transactionView),
      nextCursor:
        rows.length > query.limit && last ? encodeCursor(last.entry.createdAt.toISOString(), last.entry.id) : null,
    };
  });

  app.get('/wallet/transactions/:id', authed, async (request) => {
    const { id } = parse(idParam, request.params);
    const [row] = await transactionsQuery(deps).where(
      and(eq(ledgerEntries.id, id), eq(ledgerEntries.userId, request.auth!.userId)),
    );
    if (!row) throw notFound();
    return transactionView(row);
  });
}
