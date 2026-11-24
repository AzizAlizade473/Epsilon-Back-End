/** Database rows → the exact JSON shapes the app validates (src/services/contracts there). */
import { and, asc, count, eq } from 'drizzle-orm';

import type { Config } from '../config.js';
import type { Db, Tx } from '../db/client.js';
import { IMAGE_PROVIDERS, claimedLines, eligibility } from '../fiscal/service.js';
import type { FiscalDocument } from '../fiscal/document.js';
import {
  authIdentities,
  branches,
  feedback,
  fiscalReceipts,
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

/** How each source obtained the receipt (names as used in reports and the app). */
const ACQUISITION: Record<string, 'partner_pos_verified' | 'printed_receipt_ocr' | 'customer_supplied_official_image' | 'test_fixture'> = {
  partner_pos: 'partner_pos_verified',
  [IMAGE_PROVIDERS.paper_photo]: 'printed_receipt_ocr',
  [IMAGE_PROVIDERS.official_page]: 'customer_supplied_official_image',
  fixture: 'test_fixture',
};

/** Receipt projection for its owner. Throws NOT_FOUND unless `userId` claimed it. */
export async function receiptView(conn: Conn, purchaseId: string, user: UserRow, config: Config, now: Date) {
  const [row] = await conn
    .select({ purchase: purchases, branch: branches, restaurant: restaurants, fiscal: fiscalReceipts })
    .from(purchases)
    // Fiscal receipts from non-partner businesses have no branch or restaurant.
    .leftJoin(branches, eq(branches.id, purchases.branchId))
    .leftJoin(restaurants, eq(restaurants.id, branches.restaurantId))
    .leftJoin(fiscalReceipts, eq(fiscalReceipts.id, purchases.fiscalReceiptId))
    .where(and(eq(purchases.id, purchaseId), eq(purchases.claimedBy, user.id)));
  if (!row) throw new ApiError(404, 'RECEIPT_NOT_FOUND', 'Receipt not found');
  const items = await conn
    .select({ item: purchaseItems, rating: feedback.rating, feedbackId: feedback.id })
    .from(purchaseItems)
    .leftJoin(feedback, eq(feedback.purchaseItemId, purchaseItems.id))
    .where(eq(purchaseItems.purchaseId, purchaseId))
    .orderBy(asc(purchaseItems.lineNo), asc(purchaseItems.name), asc(purchaseItems.id));

  const expired = row.purchase.expiresAt <= now || row.purchase.status !== 'open';
  const fiscal = row.fiscal;
  const doc = fiscal ? (fiscal.document as FiscalDocument) : null;
  const rules = fiscal ? eligibility(fiscal, user, config) : null;
  const claimed = fiscal ? await claimedLines(conn, fiscal.id) : new Set<number>();
  const bps = fiscal
    ? ((fiscal.classificationEvidence as { cashbackBps?: number }).cashbackBps ?? 0)
    : (row.restaurant?.cashbackBps ?? 0);
  const rewardsOn = fiscal ? rules!.cashbackAllowed : rewardEligible(user, config);
  let hint = 0;
  const itemViews = items.map(({ item, rating, feedbackId }) => {
    const canRate = !expired && rating === null && (rules?.ratingAllowed ?? true);
    const line = doc && item.lineNo !== null ? doc.items.find((i) => i.lineNo === item.lineNo) : undefined;
    const lineClaimed = line ? claimed.has(line.lineNo) : false;
    if (canRate && rewardsOn && !lineClaimed) hint += rewardMinor(item.unitPriceMinor, item.quantity, bps);
    return {
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      canRate,
      rating,
      ...(feedbackId ? { feedbackId } : {}),
      ...(line
        ? {
            line: {
              lineNo: line.lineNo,
              originalName: line.originalName,
              quantityMilli: line.quantityMilli,
              unit: line.unit,
              unitPriceMinor: line.unitPriceMinor,
              lineTotalMinor: line.lineTotalMinor,
              cashbackClaimed: lineClaimed,
            },
          }
        : {}),
    };
  });
  const [branchTotal] = row.restaurant
    ? await conn.select({ n: count() }).from(branches).where(eq(branches.restaurantId, row.restaurant.id))
    : [undefined];
  const merchantName = doc?.merchant.displayName ?? 'Receipt';
  const evidence = fiscal ? (fiscal.classificationEvidence as { status: string; evidence: string[] }) : null;
  return {
    id: row.purchase.id,
    restaurant: row.restaurant
      ? restaurantView(row.restaurant, branchTotal?.n ?? 0)
      : { id: `m-${row.purchase.id}`, name: merchantName, logoUrl: null, branchCount: 0 },
    branch: row.branch
      ? { id: row.branch.id, name: row.branch.name }
      : { id: `b-${row.purchase.id}`, name: doc?.merchant.objectName ?? doc?.merchant.address ?? merchantName },
    issuedAt: row.purchase.issuedAt.toISOString(),
    totalMinor: row.purchase.totalMinor,
    currency: 'AZN' as const,
    status: expired ? ('expired' as const) : ('verified' as const),
    items: itemViews,
    ...(hint > 0 ? { rewardHint: { amountMinor: hint, currency: 'AZN' as const } } : {}),
    ...(fiscal && doc && rules && evidence
      ? {
          fiscal: {
            verification: {
              // Only an authorised provider is "verified"; customer images and test fixtures say what they are.
              status:
                fiscal.provider === 'fixture'
                  ? ('test_data' as const)
                  : fiscal.provider === IMAGE_PROVIDERS.official_page
                    ? ('official_image' as const)
                    : fiscal.provider === IMAGE_PROVIDERS.paper_photo
                      ? ('paper_photo' as const)
                      : ('verified' as const),
              provider: fiscal.provider,
              acquisition: ACQUISITION[fiscal.provider] ?? ('authorized_fiscal_api' as const),
              engine: fiscal.extractionEngine,
              retrievedAt: fiscal.retrievedAt.toISOString(),
            },
            classification: {
              sector: fiscal.sector,
              businessType: fiscal.businessType,
              method: fiscal.classificationMethod,
              status: evidence.status,
              evidence: evidence.evidence,
            },
            partner: { isPartner: fiscal.restaurantId !== null, restaurantId: fiscal.restaurantId, branchId: fiscal.branchId },
            eligibility: rules,
            merchant: doc.merchant,
            receipt: doc.receipt,
            device: doc.device,
            additionalFields: doc.additionalFields,
          },
        }
      : {}),
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
