import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Timestamps use millisecond precision so they round-trip through JS Dates and cursors.
const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () =>
  timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

// ---------------------------------------------------------------- identity

export const users = pgTable(
  'users',
  {
    id: id(),
    phone: text('phone'), // E.164, e.g. +994501234567
    phoneVerifiedAt: ts('phone_verified_at'),
    email: text('email'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    birthDate: date('birth_date'),
    language: text('language').notNull().default('az'),
    createdAt: createdAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [uniqueIndex('users_phone_key').on(t.phone)],
);

export const identityProvider = pgEnum('identity_provider', [
  'phone',
  'google',
  'apple',
]);

export const authIdentities = pgTable(
  'auth_identities',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: identityProvider('provider').notNull(),
    providerUserId: text('provider_user_id').notNull(), // phone number or Google `sub`
    email: text('email'),
    emailVerified: boolean('email_verified').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('auth_identities_provider_subject_key').on(
      t.provider,
      t.providerUserId,
    ),
    uniqueIndex('auth_identities_user_provider_key').on(t.userId, t.provider),
  ],
);

export const otpPurpose = pgEnum('otp_purpose', [
  'signin',
  'login',
  'register',
  'link',
]);

export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: id(),
    phone: text('phone').notNull(),
    purpose: otpPurpose('purpose').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(), // HMAC-SHA256, never the code
    attempts: smallint('attempts').notNull().default(0),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('otp_challenges_phone_created_idx').on(t.phone, t.createdAt)],
);

/** One row per refresh token. Rotation revokes the old row and inserts a new
 * one in the same family; presenting a revoked token revokes the family. */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull(), // SHA-256
    authenticatedAt: ts('authenticated_at').notNull(), // last real sign-in (recentAuth)
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('sessions_refresh_token_hash_key').on(t.refreshTokenHash),
    index('sessions_family_idx').on(t.familyId),
    index('sessions_user_idx').on(t.userId),
  ],
);

// ---------------------------------------------------------------- catalog

export const restaurants = pgTable('restaurants', {
  id: id(),
  name: text('name').notNull(),
  logoUrl: text('logo_url'),
  cuisine: text('cuisine'),
  /** Cashback in basis points of the rated item's line price (250 = 2.5 %). */
  cashbackBps: integer('cashback_bps').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  index('restaurants_name_idx').on(t.name, t.id),
  check('restaurants_cashback_bps_check', sql`${t.cashbackBps} between 0 and 10000`),
]);

export const branches = pgTable(
  'branches',
  {
    id: id(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('branches_restaurant_idx').on(t.restaurantId)],
);

export const dishes = pgTable(
  'dishes',
  {
    id: id(),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id),
    section: text('section').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    priceMinor: integer('price_minor').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('dishes_restaurant_idx').on(t.restaurantId),
    check('dishes_price_check', sql`${t.priceMinor} >= 0`),
  ],
);

// ---------------------------------------------------------------- purchases

export const purchaseStatus = pgEnum('purchase_status', [
  'open',
  'cancelled',
  'refunded',
]);

export const purchases = pgTable(
  'purchases',
  {
    id: id(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    /** SHA-256 of the opaque purchase reference printed as QR / code. */
    referenceHash: text('reference_hash').notNull(),
    issuedAt: ts('issued_at').notNull(),
    totalMinor: integer('total_minor').notNull(),
    currency: text('currency').notNull().default('AZN'),
    status: purchaseStatus('status').notNull().default('open'),
    expiresAt: ts('expires_at').notNull(),
    claimedBy: uuid('claimed_by').references(() => users.id),
    claimedAt: ts('claimed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('purchases_reference_hash_key').on(t.referenceHash),
    index('purchases_claimed_by_idx').on(t.claimedBy),
    check('purchases_total_check', sql`${t.totalMinor} >= 0`),
  ],
);

export const purchaseItems = pgTable(
  'purchase_items',
  {
    id: id(),
    purchaseId: uuid('purchase_id')
      .notNull()
      .references(() => purchases.id),
    dishId: uuid('dish_id').references(() => dishes.id),
    name: text('name').notNull(), // snapshot at sale time
    quantity: integer('quantity').notNull(),
    unitPriceMinor: integer('unit_price_minor').notNull(),
  },
  (t) => [
    index('purchase_items_purchase_idx').on(t.purchaseId),
    check('purchase_items_quantity_check', sql`${t.quantity} > 0`),
    check('purchase_items_price_check', sql`${t.unitPriceMinor} >= 0`),
  ],
);

// ---------------------------------------------------------------- feedback

export const feedback = pgTable(
  'feedback',
  {
    id: id(),
    purchaseItemId: uuid('purchase_item_id')
      .notNull()
      .references(() => purchaseItems.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    rating: smallint('rating').notNull(),
    comment: text('comment'),
    createdAt: createdAt(),
  },
  (t) => [
    // One feedback per purchased item, globally.
    uniqueIndex('feedback_purchase_item_key').on(t.purchaseItemId),
    index('feedback_user_created_idx').on(t.userId, t.createdAt),
    check('feedback_rating_check', sql`${t.rating} between 1 and 5`),
    check('feedback_comment_check', sql`char_length(${t.comment}) <= 500`),
  ],
);

export const feedbackReasons = pgTable(
  'feedback_reasons',
  {
    feedbackId: uuid('feedback_id')
      .notNull()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
  },
  (t) => [primaryKey({ columns: [t.feedbackId, t.code] })],
);

// ---------------------------------------------------------------- wallet

export const ledgerType = pgEnum('ledger_type', [
  'earned',
  'redeemed',
  'reversed',
  'expired',
]);
export const ledgerStatus = pgEnum('ledger_status', [
  'pending',
  'confirmed',
  'cancelled',
]);

/** Append-only. Reversals and expiry are new rows, never edits. */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    type: ledgerType('type').notNull(),
    status: ledgerStatus('status').notNull(),
    amountMinor: integer('amount_minor').notNull(), // signed qəpik
    currency: text('currency').notNull().default('AZN'),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id), // settlement attribution, always set
    branchId: uuid('branch_id').references(() => branches.id),
    purchaseItemId: uuid('purchase_item_id').references(() => purchaseItems.id),
    feedbackId: uuid('feedback_id').references(() => feedback.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('ledger_user_created_idx').on(t.userId, t.createdAt),
    // At most one reward per feedback, even across different idempotency keys.
    uniqueIndex('ledger_earned_feedback_key')
      .on(t.feedbackId)
      .where(sql`${t.type} = 'earned'`),
    check(
      'ledger_sign_check',
      sql`(${t.type} = 'earned' and ${t.amountMinor} > 0) or (${t.type} <> 'earned' and ${t.amountMinor} < 0)`,
    ),
  ],
);

// ---------------------------------------------------------------- platform

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    operation: text('operation').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: smallint('response_status').notNull(),
    responseBody: jsonb('response_body'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export const notificationPreferences = pgTable('notification_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  cashbackUpdates: boolean('cashback_updates').notNull().default(false),
  partnerUpdates: boolean('partner_updates').notNull().default(false),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const devices = pgTable(
  'devices',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('devices_token_key').on(t.token)],
);
