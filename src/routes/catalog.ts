import { and, asc, count, eq, gt, ilike, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Deps } from '../context.js';
import { branches, restaurants } from '../db/schema.js';
import { notFound } from '../errors.js';
import { decodeCursor, encodeCursor, idParam, pageQuery, parse } from '../lib/validation.js';
import { restaurantView } from '../lib/views.js';

const listQuery = pageQuery.extend({ search: z.string().trim().max(100).optional() });

const branchTotal = sql<number>`(select count(*)::int from ${branches} where ${branches.restaurantId} = ${restaurants.id})`;

export async function catalogRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/config', async () => ({
    minAppVersion: deps.config.MIN_APP_VERSION,
    minAge: deps.config.MIN_AGE,
    requirePhoneVerification: deps.config.REQUIRE_PHONE_VERIFICATION,
  }));

  app.get('/restaurants', { config: { auth: true } }, async (request) => {
    const query = parse(listQuery, request.query);
    const after = decodeCursor(query.cursor);
    const search = query.search ? `%${query.search.replace(/[\\%_]/g, '\\$&')}%` : null;
    const rows = await deps.db
      .select({ id: restaurants.id, name: restaurants.name, logoUrl: restaurants.logoUrl, branches: branchTotal })
      .from(restaurants)
      .where(
        and(
          search ? ilike(restaurants.name, search) : undefined,
          after
            ? or(gt(restaurants.name, after[0]), and(eq(restaurants.name, after[0]), gt(restaurants.id, after[1])))
            : undefined,
        ),
      )
      .orderBy(asc(restaurants.name), asc(restaurants.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => restaurantView(r, r.branches)),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.name, last.id) : null,
    };
  });

  app.get('/restaurants/:id', { config: { auth: true } }, async (request) => {
    const { id } = parse(idParam, request.params);
    const [row] = await deps.db.select().from(restaurants).where(eq(restaurants.id, id));
    if (!row) throw notFound();
    const [total] = await deps.db.select({ n: count() }).from(branches).where(eq(branches.restaurantId, id));
    return restaurantView(row, total?.n ?? 0);
  });
}
