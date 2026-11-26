import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { audit } from '../admin/audit.js';
import type { Db } from '../db/client.js';
import { authIdentities, restaurantStaff, restaurants, users } from '../db/schema.js';
import { emailAddress } from './validation.js';

/** Grants or removes restaurant access for the account that has verified `email`. Operator CLI only. */
export async function setStaff(db: Db, command: 'add' | 'remove', email: string, restaurantId: string) {
  const address = emailAddress.safeParse(email);
  if (!address.success || !z.uuid().safeParse(restaurantId).success) throw new Error('Invalid e-mail or restaurant id');
  // A verified e-mail identity, never an unverified address typed on a profile.
  const [user] = await db
    .select({ id: users.id })
    .from(authIdentities)
    .innerJoin(users, eq(users.id, authIdentities.userId))
    .where(and(eq(authIdentities.provider, 'email'), eq(authIdentities.providerUserId, address.data), isNull(users.deletedAt)));
  if (!user) throw new Error('No account has verified that e-mail. The person must sign in to the app first.');
  const [restaurant] = await db.select({ name: restaurants.name }).from(restaurants).where(eq(restaurants.id, restaurantId));
  if (!restaurant) throw new Error('No such restaurant');
  return db.transaction(async (tx) => {
    const changed =
      command === 'add'
        ? await tx.insert(restaurantStaff).values({ userId: user.id, restaurantId }).onConflictDoNothing().returning()
        : await tx
            .delete(restaurantStaff)
            .where(and(eq(restaurantStaff.userId, user.id), eq(restaurantStaff.restaurantId, restaurantId)))
            .returning();
    if (changed.length)
      await audit(tx, { adminId: null, action: `staff.${command}`, entityType: 'restaurant', entityId: restaurantId, after: { userId: user.id }, outcome: 'ok' });
    return { changed: changed.length > 0, restaurant: restaurant.name };
  });
}
