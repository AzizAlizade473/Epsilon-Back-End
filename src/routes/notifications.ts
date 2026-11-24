import { and, count, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Deps } from '../context.js';
import { notifications } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { decodeTimeCursor, encodeCursor, pageQuery, parse } from '../lib/validation.js';

const idParam = z.object({ id: z.uuid() }).strict();

export async function notificationRoutes(app: FastifyInstance, deps: Deps) {
  const authed = { config: { auth: true } };

  app.get('/notifications', authed, async (request) => {
    const query = parse(pageQuery, request.query);
    const after = decodeTimeCursor(query.cursor);
    const userId = request.auth!.userId;
    const rows = await deps.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          after
            ? or(lt(notifications.createdAt, after[0]), and(eq(notifications.createdAt, after[0]), lt(notifications.id, after[1])))
            : undefined,
        ),
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const [unread] = await deps.db
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return {
      items: page.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        path: n.path,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdAt.toISOString(), last.id) : null,
      unreadCount: unread?.n ?? 0,
    };
  });

  app.post('/notifications/read-all', authed, async (request, reply) => {
    await deps.db
      .update(notifications)
      .set({ readAt: deps.now() })
      .where(and(eq(notifications.userId, request.auth!.userId), isNull(notifications.readAt)));
    return reply.code(204).send();
  });

  app.post('/notifications/:id/read', authed, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    // Re-reading keeps the first read time and still succeeds.
    const rows = await deps.db
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, ${deps.now().toISOString()}::timestamptz)` })
      .where(and(eq(notifications.id, id), eq(notifications.userId, request.auth!.userId)))
      .returning({ id: notifications.id });
    if (!rows.length) throw new ApiError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found');
    return reply.code(204).send();
  });
}
