import { and, eq, isNull, ne } from 'drizzle-orm';

import type { Config } from '../config.js';
import type { Db, Tx } from '../db/client.js';
import { authIdentities, users } from '../db/schema.js';
import { ApiError } from '../errors.js';

/** Records an address the account has just proven (Google, or a delivered phone code) as its e-mail
 * identity, unless any other account also holds it: a shared address is never assigned automatically
 * (same rule as the backfill in migration 0008). */
export async function claimEmail(tx: Db | Tx, userId: string, email: string) {
  const [account] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, email), ne(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  const [identity] = await tx
    .select({ id: authIdentities.id })
    .from(authIdentities)
    .where(and(eq(authIdentities.email, email), ne(authIdentities.userId, userId)))
    .limit(1);
  if (account || identity) return;
  await tx
    .insert(authIdentities)
    .values({ userId, provider: 'email', providerUserId: email, email, emailVerified: true })
    .onConflictDoNothing();
}

/** Refuses to remove an identity unless the user can still sign in with another one.
 * Hold the user row lock, so two removals cannot each rely on the other's identity. */
export async function requireAnotherSignInMethod(tx: Tx, config: Config, userId: string, removedId: string) {
  const others = await tx
    .select({ provider: authIdentities.provider })
    .from(authIdentities)
    .where(and(eq(authIdentities.userId, userId), ne(authIdentities.id, removedId)));
  // A phone cannot sign in while no code can be delivered to it.
  if (!others.some((i) => i.provider !== 'phone' || config.SMS_PROVIDER !== 'none'))
    throw new ApiError(409, 'LAST_SIGN_IN_METHOD', 'Add another sign-in method first');
}

export async function lockUser(tx: Tx, userId: string) {
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
  return user!;
}
