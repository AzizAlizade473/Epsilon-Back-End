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
  'email',
]);

export const authIdentities = pgTable(
  'auth_identities',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: identityProvider('provider').notNull(),
    providerUserId: text('provider_user_id').notNull(), // phone number, Google `sub` or normalised e-mail
    email: text('email'),
    emailVerified: boolean('email_verified').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('auth_identities_provider_subject_key').on(
      t.provider,
      t.providerUserId,
    ),
    // One phone and one Google account per user; any number of verified e-mails.
    uniqueIndex('auth_identities_user_provider_key').on(t.userId, t.provider).where(sql`${t.provider} <> 'email'`),
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
    phone: text('phone'), // null: an e-mail code, `email` is then what it proves
    purpose: otpPurpose('purpose').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(), // HMAC-SHA256, never the code
    email: text('email'), // where an e-mailed code went
    ipHash: text('ip_hash'), // HMAC of the requester's address, for per-requester limits
    makePrimary: boolean('make_primary').notNull().default(false), // adding an e-mail (purpose link)
    attempts: smallint('attempts').notNull().default(0),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('otp_challenges_phone_created_idx').on(t.phone, t.createdAt),
    index('otp_challenges_email_created_idx').on(t.email, t.createdAt),
  ],
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
  /** Taxpayer ID printed on fiscal receipts; links scanned receipts to this partner. */
  voen: text('voen'),
  /** SHA-256 of the partner's POS integration key (POST /partner/receipts). */
  posKeyHash: text('pos_key_hash'),
  createdAt: createdAt(),
}, (t) => [
  index('restaurants_name_idx').on(t.name, t.id),
  index('restaurants_voen_idx').on(t.voen),
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
    /** e-kassa establishment code ("Obyektin kodu", e.g. 1506475881-20001). */
    objectCode: text('object_code'),
    createdAt: createdAt(),
  },
  (t) => [
    index('branches_restaurant_idx').on(t.restaurantId),
    uniqueIndex('branches_object_code_key').on(t.objectCode).where(sql`${t.objectCode} is not null`),
  ],
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

// ---------------------------------------------------------------- fiscal receipts

/**
 * One row per real fiscal receipt (e-kassa Fiscal ID), shared by every user who scans
 * it. `document` is the normalized receipt; `raw` the provider's original response,
 * kept for audit (cashier identity is removed before storage).
 */
export const fiscalReceipts = pgTable(
  'fiscal_receipts',
  {
    id: id(),
    issuer: text('issuer').notNull(),
    fiscalId: text('fiscal_id').notNull(),
    provider: text('provider').notNull(),
    /** How the contents were read: structured (provider/POS data), on_device_ocr or gemini. */
    extractionEngine: text('extraction_engine').notNull().default('structured'),
    document: jsonb('document').notNull(),
    raw: jsonb('raw'),
    merchantVoen: text('merchant_voen'),
    objectCode: text('object_code'),
    sector: text('sector').notNull(),
    businessType: text('business_type').notNull(),
    classificationMethod: text('classification_method').notNull(),
    classificationEvidence: jsonb('classification_evidence').notNull(),
    restaurantId: uuid('restaurant_id').references(() => restaurants.id),
    branchId: uuid('branch_id').references(() => branches.id),
    retrievedAt: ts('retrieved_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('fiscal_receipts_identity_key').on(t.issuer, t.fiscalId)],
);

/** A fiscal receipt line pays cashback at most once, whoever rates it first. */
export const fiscalCashbackClaims = pgTable(
  'fiscal_cashback_claims',
  {
    id: id(),
    fiscalReceiptId: uuid('fiscal_receipt_id')
      .notNull()
      .references(() => fiscalReceipts.id),
    lineNo: smallint('line_no').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('fiscal_cashback_claims_line_key').on(t.fiscalReceiptId, t.lineNo)],
);

/** Classification cache per establishment (VÖEN + establishment code). */
export const merchantClassifications = pgTable(
  'merchant_classifications',
  {
    id: id(),
    voen: text('voen').notNull(),
    /** '' when the receipt carried no establishment code. */
    objectCode: text('object_code').notNull(),
    sector: text('sector').notNull(),
    businessType: text('business_type').notNull(),
    method: text('method').notNull(),
    evidence: jsonb('evidence').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('merchant_classifications_key').on(t.voen, t.objectCode)],
);

/** Application-level Gemini call counter (protects the free-tier daily quota). */
export const geminiUsage = pgTable('gemini_usage', {
  day: text('day').primaryKey(),
  calls: integer('calls').notNull().default(0),
});

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
    /** Null for fiscal receipts from businesses that are not Epsilon partners. */
    branchId: uuid('branch_id').references(() => branches.id),
    /** Set when this purchase is one user's copy of a scanned fiscal receipt. */
    fiscalReceiptId: uuid('fiscal_receipt_id').references(() => fiscalReceipts.id),
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
    /** Line number on the fiscal receipt (stable line identity); null for partner codes. */
    lineNo: smallint('line_no'),
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
    /** Set when the author edits the review; createdAt keeps the original time. */
    updatedAt: ts('updated_at'),
    /** Reversible admin moderation: hidden reviews leave every aggregate and public list; the text is never altered. */
    hiddenAt: ts('hidden_at'),
    hiddenReason: text('hidden_reason'),
    hiddenBy: uuid('hidden_by').references(() => adminUsers.id),
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

/** Restaurant accounts: ordinary users granted access by Epsilon only (npm run staff:add). */
export const restaurantStaff = pgTable(
  'restaurant_staff',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.restaurantId] })],
);

/** One reply per review. Deleting and hiding only flag the row, so a hidden reply cannot be re-published by its author. */
export const reviewReplies = pgTable(
  'review_replies',
  {
    id: id(),
    feedbackId: uuid('feedback_id')
      .notNull()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    restaurantId: uuid('restaurant_id')
      .notNull()
      .references(() => restaurants.id),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull(),
    deletedAt: ts('deleted_at'),
    hiddenAt: ts('hidden_at'),
  },
  (t) => [
    uniqueIndex('review_replies_feedback_key').on(t.feedbackId),
    check('review_replies_body_check', sql`char_length(${t.body}) between 1 and 1000`),
  ],
);

/** The review's author reporting the reply to it. */
export const replyReports = pgTable(
  'reply_reports',
  {
    id: id(),
    replyId: uuid('reply_id')
      .notNull()
      .references(() => reviewReplies.id, { onDelete: 'cascade' }),
    reporterUserId: uuid('reporter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('reply_reports_reply_reporter_key').on(t.replyId, t.reporterUserId),
    check('reply_reports_reason_check', sql`char_length(${t.reason}) between 1 and 300`),
  ],
);

// ---------------------------------------------------------------- scan activity

/** The latest outcome per scanned receipt (or code) and user. Never images or raw errors. */
export const scanAttempts = pgTable(
  'scan_attempts',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `fiscal:<Fiscal ID>`, or `code:<SHA-256>` for anything else: a retry updates its own row. */
    subject: text('subject').notNull(),
    at: ts('at').notNull(),
    status: text('status', { enum: ['success', 'failed'] }).notNull(),
    reason: text('reason'),
    retryable: boolean('retryable').notNull(),
    /** The QR's full `doc` value, so its owner can retry. */
    fiscalDocument: text('fiscal_document'),
    receiptId: uuid('receipt_id').references(() => purchases.id),
    restaurantName: text('restaurant_name'),
  },
  (t) => [
    uniqueIndex('scan_attempts_user_subject_key').on(t.userId, t.subject),
    index('scan_attempts_user_at_idx').on(t.userId, t.at),
  ],
);

// ---------------------------------------------------------------- likes

export const likeKind = pgEnum('like_kind', ['dish', 'review', 'restaurant']);

/** The backend does not know every liked thing (demo catalogue), so each like keeps a display snapshot. */
export const likes = pgTable(
  'likes',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: likeKind('kind').notNull(),
    targetId: text('target_id').notNull(),
    restaurantId: text('restaurant_id').notNull(),
    dishId: text('dish_id'),
    title: text('title').notNull(),
    subtitle: text('subtitle').notNull(),
    imageUrl: text('image_url'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('likes_user_target_key').on(t.userId, t.kind, t.targetId),
    index('likes_target_idx').on(t.targetId, t.kind),
    index('likes_user_created_idx').on(t.userId, t.createdAt),
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
  reminders: boolean('reminders').notNull().default(true),
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

/** In-app inbox; a row exists whether or not the push was sent. */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['cashback', 'meal_reminder', 'partner'] }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** In-app deep link, e.g. /receipt/<id>. */
    path: text('path'),
    readAt: ts('read_at'),
    createdAt: createdAt(),
    /** One notification per event per user, e.g. cashback:<feedbackId>. */
    dedupeKey: text('dedupe_key').notNull(),
  },
  (t) => [
    uniqueIndex('notifications_user_dedupe_key').on(t.userId, t.dedupeKey),
    index('notifications_user_created_idx').on(t.userId, t.createdAt),
  ],
);

// ---------------------------------------------------------------- admin (separate identity from consumers)

export const adminRole = pgEnum('admin_role', ['super_admin', 'operations', 'analyst', 'partner']);
export const adminStatus = pgEnum('admin_status', ['active', 'disabled']);

/** Provisioned only by the CLI (npm run admin:add). Never created through the API. */
export const adminUsers = pgTable(
  'admin_users',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: adminRole('role').notNull(),
    status: adminStatus('status').notNull().default('active'),
    /** Cloudflare Access identity id, pinned on first login. */
    accessSub: text('access_sub'),
    createdAt: createdAt(),
    lastLoginAt: ts('last_login_at'),
  },
  (t) => [
    uniqueIndex('admin_users_email_key').on(t.email),
    uniqueIndex('admin_users_access_sub_key').on(t.accessSub),
    check('admin_users_email_lower_check', sql`${t.email} = lower(${t.email})`),
  ],
);

export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: id(),
    adminId: uuid('admin_id')
      .notNull()
      .references(() => adminUsers.id),
    tokenHash: text('token_hash').notNull(), // SHA-256
    csrfHash: text('csrf_hash').notNull(), // SHA-256 of the CSRF secret
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [uniqueIndex('admin_sessions_token_hash_key').on(t.tokenHash), index('admin_sessions_admin_idx').on(t.adminId)],
);

/** Append-only: no code path updates or deletes rows. before/after never hold PII. */
export const adminAudit = pgTable(
  'admin_audit',
  {
    id: id(),
    adminId: uuid('admin_id').references(() => adminUsers.id),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    reason: text('reason'),
    before: jsonb('before'),
    after: jsonb('after'),
    outcome: text('outcome', { enum: ['ok', 'denied', 'error'] }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('admin_audit_created_idx').on(t.createdAt), index('admin_audit_admin_idx').on(t.adminId, t.createdAt)],
);
