/** Database rows → the exact JSON shapes the app validates (src/services/contracts there). */
import { and, asc, count, eq } from 'drizzle-orm';

import type { Config } from '../config.js';
import type { Db, Tx } from '../db/client.js';
import {
  authIdentities,
  branches,
  feedback,
  ledgerEntries,
  purchaseItems,
  purchases,
  restaurants,
  users,
} from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { rewardMinor } from './money.js';

type Conn = Db | Tx;
type UserRow = typeof users.$inferSelect;
type RestaurantRow = typeof restaurants.$inferSelect;

export function nextStep(user: UserRow, config: Config): 'profile' | 'phone' | 'home' {
  if (!user.firstName || !user.lastName || !user.birthDate) return 'profile';
  return config.REQUIRE_PHONE_VERIFICATION && !user.phoneVerifiedAt ? 'phone' : 'home';
}

export async function loadUser(conn: Conn, userId: string): Promise<UserRow> {
  const [user] = await conn.select().from(users).where(eq(users.id, userId));
  if (!user || user.deletedAt) throw notFound();
  return user;
}

export async function userView(conn: Conn, user: UserRow) {
  const identities = await conn
    .select()
    .from(authIdentities)
    .where(eq(authIdentities.userId, user.id))
    .orderBy(asc(authIdentities.createdAt));
  return {
    id: user.id,
    phone: user.phone,
    phoneVerified: user.phoneVerifiedAt !== null,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    birthDate: user.birthDate,
    language: user.language,
    // Provider user IDs are never sent to the app.
    identities: identities.map((i) => ({
      provider: i.provider,
      email: i.email,
      emailVerified: i.emailVerified,
      createdAt: i.createdAt.toISOString(),
    })),
    createdAt: user.createdAt.toISOString(),
  };
}


export function restaurantView(r: Pick<RestaurantRow, 'id' | 'name' | 'logoUrl'>, branchTotal: number) {
  return { id: r.id, name: r.name, logoUrl: r.logoUrl, branchCount: branchTotal };
}

export function rewardEligible(user: UserRow, config: Config): boolean {
  return !config.REQUIRE_PHONE_VERIFICATION || user.phoneVerifiedAt !== null;
}

/** Receipt projection for its owner. Throws NOT_FOUND unless `userId` claimed it. */
export async function receiptView(conn: Conn, purchaseId: string, user: UserRow, config: Config, now: Date) {
  const [row] = await conn
    .select({ purchase: purchases, branch: branches, restaurant: restaurants })
    .from(purchases)
    .innerJoin(branches, eq(branches.id, purchases.branchId))
    .innerJoin(restaurants, eq(restaurants.id, branches.restaurantId))
    .where(and(eq(purchases.id, purchaseId), eq(purchases.claimedBy, user.id)));
  if (!row) throw new ApiError(404, 'RECEIPT_NOT_FOUND', 'Receipt not found');
  const [branchTotal] = await conn
    .select({ n: count() })
    .from(branches)
    .where(eq(branches.restaurantId, row.restaurant.id));
  const items = await conn
    .select({ item: purchaseItems, rating: feedback.rating })
    .from(purchaseItems)
    .leftJoin(feedback, eq(feedback.purchaseItemId, purchaseItems.id))
    .where(eq(purchaseItems.purchaseId, purchaseId))
    .orderBy(asc(purchaseItems.name), asc(purchaseItems.id));

  const expired = row.purchase.expiresAt <= now || row.purchase.status !== 'open';
  const eligible = rewardEligible(user, config);
  let hint = 0;
  const itemViews = items.map(({ item, rating }) => {
    const canRate = !expired && rating === null;
    if (canRate && eligible)
      hint += rewardMinor(item.unitPriceMinor, item.quantity, row.restaurant.cashbackBps);
    return {
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      canRate,
      rating,
    };
  });
  return {
    id: row.purchase.id,
    restaurant: restaurantView(row.restaurant, branchTotal?.n ?? 0),
    branch: { id: row.branch.id, name: row.branch.name },
    issuedAt: row.purchase.issuedAt.toISOString(),
    totalMinor: row.purchase.totalMinor,
    currency: 'AZN' as const,
    status: expired ? ('expired' as const) : ('verified' as const),
    items: itemViews,
    ...(hint > 0 ? { rewardHint: { amountMinor: hint, currency: 'AZN' as const } } : {}),
  };
}

/** Select shape shared by the transaction list and detail endpoints. */
export const transactionColumns = {
  entry: ledgerEntries,
  restaurantName: restaurants.name,
  branchName: branches.name,
  itemName: purchaseItems.name,
  purchaseId: purchaseItems.purchaseId,
};

export function transactionView(row: {
  entry: typeof ledgerEntries.$inferSelect;
  restaurantName: string;
  branchName: string | null;
  itemName: string | null;
  purchaseId: string | null;
}) {
  return {
    id: row.entry.id,
    type: row.entry.type,
    status: row.entry.status,
    amountMinor: row.entry.amountMinor,
    createdAt: row.entry.createdAt.toISOString(),
    source: {
      restaurantId: row.entry.restaurantId,
      restaurantName: row.restaurantName,
      branchName: row.branchName,
    },
    receiptId: row.purchaseId,
    itemName: row.itemName,
  };
}
