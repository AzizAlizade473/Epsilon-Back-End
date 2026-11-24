import { eq } from 'drizzle-orm';

import type { Deps } from '../context.js';
import { notificationPreferences, restaurants, users } from '../db/schema.js';
import { partnerCopy } from './copy.js';
import { notify } from './notify.js';

/** Tells every opted-in user a restaurant joined. Safe to re-run: one notification per user. */
export async function announcePartner(deps: Pick<Deps, 'db' | 'now' | 'push'>, restaurantId: string): Promise<number> {
  const [restaurant] = await deps.db.select({ name: restaurants.name }).from(restaurants).where(eq(restaurants.id, restaurantId));
  if (!restaurant) throw new Error(`Unknown restaurant ${restaurantId}`);
  const targets = await deps.db
    .select({ id: users.id, language: users.language })
    .from(notificationPreferences)
    .innerJoin(users, eq(users.id, notificationPreferences.userId))
    .where(eq(notificationPreferences.partnerUpdates, true));
  let sent = 0;
  for (const u of targets)
    if (await notify(deps, u.id, { kind: 'partner', ...partnerCopy(u.language, restaurant.name), path: `/restaurant/${restaurantId}`, dedupeKey: `partner:${restaurantId}` })) sent++;
  return sent;
}
