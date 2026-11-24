import { z } from 'zod';

/**
 * Response schemas for docs/ADMIN.md. Shapes the contract leaves open (nested rows,
 * counts-by-name maps) are kept lenient: optional fields, unknown keys tolerated.
 */
const id = z.union([z.string(), z.number()]).transform(String);
const num = z.number().nullish();
const str = z.string().nullish();
/** A name that the API may send as a string or as `{ name }`. */
const label = z
  .union([z.string(), z.looseObject({ name: z.string() })])
  .transform((v) => (typeof v === 'string' ? v : v.name))
  .nullish();
const dist = z.array(z.number()).length(5);
const NOT_TRACKED = z.literal('not_tracked');
export const trackingSchema = z
  .record(z.string(), z.union([NOT_TRACKED, z.looseObject({ since: z.string() })]))
  .optional();
const meta = { generatedAt: z.string().optional(), tracking: trackingSchema };
const obj = <T extends z.core.$ZodLooseShape>(shape: T) => z.looseObject({ ...meta, ...shape });
const list = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullish() });
const flag = z.union([z.boolean(), z.number()]);

export const adminSchema = z.object({
  admin: z.object({
    id,
    email: z.string(),
    name: z.string().nullish(),
    role: z.string(),
    permissions: z.array(z.string()),
  }),
  csrfToken: z.string(),
});
export type Session = z.infer<typeof adminSchema>;

const kpis = z.looseObject({
  totalUsers: num, newUsers: num, dau: num, wau: num, mau: num, receiptsImported: num,
  uniqueRestaurants: num, ratings: num, avgRating: num, cashbackConfirmedMinor: num,
  activePartners: num, receiptToRatingRate: num, returningUserPct: num, avgRatingsPerReceipt: num,
});
export type Kpis = z.infer<typeof kpis>;

export const overviewSchema = obj({
  kpis,
  previous: kpis.nullish(),
  series: z.object({
    days: z.array(z.object({ date: z.string(), newUsers: z.number(), activeUsers: z.number(), receipts: z.number(), ratings: z.number() })),
  }),
  ratingDistribution: dist,
  topRestaurants: z.array(z.looseObject({ key: id, name: z.string(), logoBrand: str, receipts: z.number(), ratings: z.number(), avgRating: num })),
  activity: z.array(z.looseObject({ type: z.string(), at: z.string(), text: z.string() })),
});

const moderation = z
  .union([z.string(), z.looseObject({ hidden: z.boolean().optional(), reason: str })])
  .nullish();
export const isHidden = (m: z.infer<typeof moderation>) =>
  typeof m === 'string' ? m === 'hidden' : !!m?.hidden;

export const reviewSchema = z.looseObject({
  id,
  restaurant: label,
  dish: label,
  reviewer: label,
  rating: z.number(),
  /** Codes; the API sends `{ code, dimension, sentiment }` (older rows: plain strings). */
  quickComments: z.array(z.union([z.string(), z.looseObject({ code: z.string() }).transform((q) => q.code)])).nullish(),
  comment: str,
  createdAt: z.string(),
  updatedAt: str,
  edited: z.boolean().nullish(),
  moderation,
});
export type Review = z.infer<typeof reviewSchema>;
export const reviewsSchema = list(reviewSchema);
export const reviewDetailSchema = reviewSchema.extend({
  receipt: z.looseObject({ id: id.optional() }).nullish(),
  dishContext: z.looseObject({}).nullish(),
});

const ledgerEntry = z.looseObject({
  id,
  type: str,
  status: str,
  amountMinor: num,
  restaurant: label,
  user: label,
  createdAt: str,
});
export type LedgerEntry = z.infer<typeof ledgerEntry>;
export const ledgerSchema = list(ledgerEntry);

const notification = z.looseObject({ id, kind: str, title: str, user: label, createdAt: str, read: z.boolean().nullish(), readAt: str });
export type NotificationRow = z.infer<typeof notification>;
export const notificationsSchema = list(notification);

const receiptItem = z.looseObject({
  id,
  fiscalIdMasked: str,
  restaurant: label,
  category: str,
  importedAt: str,
  totalMinor: num,
  items: num,
  status: str,
  ratings: num,
  cashbackEligible: z.boolean().nullish(),
  provider: str,
  engine: str,
});
export type ReceiptRow = z.infer<typeof receiptItem>;
export const receiptsSchema = list(receiptItem);
export const receiptDetailSchema = receiptItem.extend({
  merchant: label,
  lines: z.array(z.looseObject({ lineNo: z.number(), originalName: z.string(), quantityMilli: z.number(), unitPriceMinor: z.number(), lineTotalMinor: z.number() })).nullish(),
  reviews: z.array(reviewSchema).nullish(),
  ledger: z.array(ledgerEntry).nullish(),
});
const counts = z.union([
  z.record(z.string(), z.number()),
  z.array(z.looseObject({ name: str, key: str, provider: str, engine: str, count: num, receipts: num })),
]);
export const receiptHealthSchema = obj({
  imported: z.number(),
  byProvider: counts.nullish(),
  byEngine: counts.nullish(),
  unsupported: num,
  unknownMerchant: num,
  failures: z.union([NOT_TRACKED, z.looseObject({})]).nullish(),
});

const user = z.looseObject({
  id,
  name: str,
  emailMasked: str,
  phoneMasked: str,
  createdAt: str,
  lastActiveAt: str,
  receipts: num,
  ratings: num,
  cashbackMinor: num,
  notifications: z.looseObject({ reminders: flag.nullish(), cashbackUpdates: flag.nullish(), partnerUpdates: flag.nullish(), pushDevices: num }).nullish(),
  status: str,
});
export type UserRow = z.infer<typeof user>;
export const usersSchema = list(user);
export const userDetailSchema = obj({
  user,
  receipts: z.array(receiptItem),
  reviews: z.array(reviewSchema),
  ledger: z.array(ledgerEntry),
  notifications: z.array(notification),
  preferences: z.record(z.string(), z.unknown()).nullish(),
});
export const revealSchema = z.object({ email: str, phone: str });
const series = z.array(z.looseObject({ date: z.string(), count: num, value: num }));
export const userAnalyticsSchema = obj({
  registrations: series,
  active: series,
  returningUserPct: num,
  avgReceiptsPerUser: num,
  avgRatingsPerUser: num,
  neverScanned: num,
  scannedNeverRated: num,
  ratedNonPartner: num,
  /** Share (0..1) of users with each category on. */
  notificationOptInRate: z.looseObject({ reminders: num, cashbackUpdates: num, partnerUpdates: num }).nullish(),
  cohorts: z.union([NOT_TRACKED, z.array(z.looseObject({}))]).nullish(),
});

const restaurant = z.looseObject({
  key: id,
  name: z.string(),
  chain: str,
  branch: str,
  category: str,
  voenMasked: str,
  objectCode: str,
  isPartner: z.boolean(),
  receipts: num,
  reviewers: num,
  ratings: num,
  avgRating: num,
  lastActivityAt: str,
});
export type RestaurantRow = z.infer<typeof restaurant>;
export const restaurantsSchema = list(restaurant);

const dish = z.looseObject({
  key: id,
  name: z.string(),
  restaurant: label,
  branch: str,
  purchases: num,
  ratings: num,
  avgRating: num,
  distribution: dist.nullish(),
  positivePct: num,
  negativePct: num,
  lastRatedAt: str,
});
export type DishRow = z.infer<typeof dish>;
export const dishesSchema = list(dish);
const kpiMap = z.record(z.string(), z.number().nullable());
const trend = z.array(z.looseObject({ date: z.string(), ratings: num, avgRating: num, receipts: num }));
const dimensions = z.record(z.string(), z.object({ positive: z.number(), neutral: z.number(), negative: z.number() }));
export const restaurantDetailSchema = obj({
  restaurant,
  kpis: kpiMap,
  distribution: dist,
  trend,
  dishes: z.array(dish),
  best: z.array(dish),
  needsAttention: z.array(dish),
  dimensions,
  reviews: z.array(reviewSchema),
});
export const dishDetailSchema = obj({ dish, kpis: kpiMap, distribution: dist, trend, dimensions, reviews: z.array(reviewSchema) });

const money = (extra: z.core.$ZodLooseShape = {}) => z.looseObject({ date: z.string().optional(), name: str, key: str, confirmedMinor: num, pendingMinor: num, reversedMinor: num, expiredMinor: num, ...extra });
export const cashbackSchema = obj({
  confirmedMinor: z.number(),
  pendingMinor: z.number(),
  reversedMinor: z.number(),
  expiredMinor: z.number(),
  liabilityMinor: z.number(),
  byRestaurant: z.array(money()),
  byDay: z.array(money()),
});

export const notificationStatsSchema = obj({
  sent: z.number(),
  read: z.number(),
  byKind: z.array(z.looseObject({ kind: z.string(), sent: num, read: num })),
  optIn: z.looseObject({ reminders: num, cashbackUpdates: num, partnerUpdates: num }),
  devices: z.looseObject({ tokens: num, users: num }),
  delivery: z.union([NOT_TRACKED, z.looseObject({})]).nullish(),
});

export const costsSchema = obj({
  gemini: z.object({
    calls: z.number(),
    byDay: z.array(z.looseObject({ date: z.string(), calls: z.number() })),
    estimate: z.object({ minor: z.number(), basis: z.string() }),
  }),
  email: z.union([NOT_TRACKED, z.looseObject({})]).nullish(),
  push: z.union([NOT_TRACKED, z.looseObject({})]).nullish(),
});

export const healthSchema = z.looseObject({
  api: z.object({ uptimeS: z.number(), version: z.string() }),
  db: z.object({ ok: z.boolean(), latencyMs: num }),
  jobs: z.object({ mealReminders: z.object({ lastRunAt: str }) }),
});

export const auditSchema = list(
  z.looseObject({
    id,
    admin: z.union([z.string(), z.looseObject({ email: str, name: str })]).transform((a) => (typeof a === 'string' ? a : (a.name ?? a.email ?? null))).nullish(),
    action: z.string(),
    entityType: str,
    entityId: str,
    reason: str,
    outcome: str,
    ip: str,
    at: z.string(),
  }),
);

const hit = z.looseObject({ id: id.optional(), key: z.string().optional(), name: str, title: str, restaurant: label, dish: label, emailMasked: str, comment: str, rating: num });
export type SearchHit = z.infer<typeof hit>;
export const searchSchema = z.object({
  users: z.array(hit).optional(),
  restaurants: z.array(hit).optional(),
  dishes: z.array(hit).optional(),
  reviews: z.array(hit).optional(),
  receipts: z.array(hit).optional(),
});
