import { and, eq, inArray } from 'drizzle-orm';

import type { Deps } from '../context.js';
import type { Db } from '../db/client.js';
import { devices, notificationPreferences, notifications } from '../db/schema.js';
import { EXPO_TOKEN } from './push.js';

export type Kind = typeof notifications.$inferSelect.kind;
export type NotifyInput = { kind: Kind; title: string; body: string; path: string | null; dedupeKey: string };

const FIELD = { cashback: 'cashbackUpdates', partner: 'partnerUpdates', meal_reminder: 'reminders' } as const;
// Same defaults as the notification_preferences columns (no row = defaults).
const DEFAULT = { cashbackUpdates: false, partnerUpdates: false, reminders: true };

export async function prefersPush(db: Db, userId: string, kind: Kind): Promise<boolean> {
  const [row] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
  return (row ?? DEFAULT)[FIELD[kind]];
}

/** Stores the inbox row once per dedupeKey, then pushes it if the user opted in. True if newly stored. */
export async function notify(deps: Pick<Deps, 'db' | 'now' | 'push'>, userId: string, input: NotifyInput): Promise<boolean> {
  const { db } = deps;
  const [row] = await db
    .insert(notifications)
    .values({ ...input, userId, createdAt: deps.now() })
    .onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey] })
    .returning({ id: notifications.id });
  if (!row) return false;
  if (!(await prefersPush(db, userId, input.kind))) return true;

  const tokens = (await db.select({ token: devices.token }).from(devices).where(eq(devices.userId, userId)))
    .map((d) => d.token)
    .filter((t) => EXPO_TOKEN.test(t));
  if (!tokens.length) return true;
  const results = await deps.push(
    tokens.map((to) => ({ to, title: input.title, body: input.body, data: input.path ? { path: input.path } : {}, channelId: input.kind })),
  );
  const dead = results.filter((r) => r.unregistered).map((r) => r.to);
  if (dead.length) await db.delete(devices).where(and(eq(devices.userId, userId), inArray(devices.token, dead)));
  return true;
}
