import { and, desc, eq, gt, gte, isNull, lte, sql } from 'drizzle-orm';

import type { Deps } from '../context.js';
import { feedback, fiscalReceipts, notifications, purchaseItems, purchases, users } from '../db/schema.js';
import { eligibility } from '../fiscal/service.js';
import { mealCopy } from './copy.js';
import { notify, prefersPush } from './notify.js';

const HOUR = 3_600_000;

/** One "rate your meal" nudge per user per run, daytime in Baku (UTC+4, no DST). Returns how many were sent. */
export async function sendMealReminders(deps: Pick<Deps, 'db' | 'config' | 'now' | 'push'>, now: Date): Promise<number> {
  const bakuHour = (now.getUTCHours() + 4) % 24;
  if (bakuHour < 11 || bakuHour > 20) return 0;

  const candidates = await deps.db
    .select({ purchase: purchases, fiscal: fiscalReceipts, user: users })
    .from(purchases)
    .innerJoin(users, eq(users.id, purchases.claimedBy))
    .leftJoin(fiscalReceipts, eq(fiscalReceipts.id, purchases.fiscalReceiptId))
    .where(
      and(
        eq(purchases.status, 'open'),
        gt(purchases.expiresAt, now),
        lte(purchases.createdAt, new Date(now.getTime() - 3 * HOUR)),
        gte(purchases.createdAt, new Date(now.getTime() - 7 * 24 * HOUR)),
      ),
    )
    .orderBy(desc(purchases.createdAt));

  const done = new Set<string>();
  let sent = 0;
  for (const { purchase, fiscal, user } of candidates) {
    if (done.has(user.id)) continue;
    if (fiscal && !eligibility(fiscal).ratingAllowed) continue;
    const [unrated] = await deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(purchaseItems)
      .leftJoin(feedback, eq(feedback.purchaseItemId, purchaseItems.id))
      .where(and(eq(purchaseItems.purchaseId, purchase.id), isNull(feedback.id)));
    const n = unrated?.n ?? 0;
    if (!n) continue;
    const [recent] = await deps.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, user.id), eq(notifications.kind, 'meal_reminder'), gt(notifications.createdAt, new Date(now.getTime() - 20 * HOUR))))
      .limit(1);
    if (recent || !(await prefersPush(deps.db, user.id, 'meal_reminder'))) {
      done.add(user.id);
      continue;
    }
    // false = this purchase was already reminded; try the user's next one.
    if (await notify(deps, user.id, { kind: 'meal_reminder', ...mealCopy(user.language, n), path: `/receipt/${purchase.id}`, dedupeKey: `meal:${purchase.id}` })) {
      done.add(user.id);
      sent++;
    }
  }
  return sent;
}
