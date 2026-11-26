/**
 * Every filter and sort value the admin pages can send. They must match the server's query schemas
 * (src/admin/queries/*); test/admin/analytics.test.ts sends each one to the API, so a mismatch fails CI.
 */
export const DISH_SORTS = ['avgRating', 'worst', 'ratings', 'purchases', 'recent'] as const;
export const REVIEW_DIMENSIONS = ['taste', 'freshness', 'temperature', 'preparation', 'portion', 'price', 'presentation', 'texture', 'overall'] as const;
export const REVIEW_SENTIMENTS = ['positive', 'neutral', 'negative'] as const;
export const NOTIFICATION_KINDS = ['meal_reminder', 'cashback', 'partner'] as const;
export const LIKE_KINDS = ['dish', 'restaurant', 'review'] as const;
export const RECEIPT_STATUSES = ['open', 'cancelled', 'refunded'] as const;
export const RECEIPT_CATEGORIES = ['restaurant', 'cafe', 'coffee_shop', 'fast_food', 'bakery_cafe', 'other_food_service'] as const;
export const LEDGER_TYPES = ['earned', 'redeemed', 'reversed', 'expired'] as const;
export const LEDGER_STATUSES = ['pending', 'confirmed', 'cancelled'] as const;

/** Query string per page filter, for the API contract test. */
export const FILTER_CASES: [string, string, readonly string[]][] = [
  ['/dishes', 'sort', DISH_SORTS],
  ['/reviews', 'dimension', REVIEW_DIMENSIONS],
  ['/reviews', 'sentiment', REVIEW_SENTIMENTS],
  ['/reviews', 'stars', ['1', '2', '3', '4', '5']],
  ['/reviews', 'hasComment', ['true', 'false']],
  ['/reviews', 'edited', ['true', 'false']],
  ['/reviews', 'moderated', ['true', 'false']],
  ['/restaurants', 'partner', ['true', 'false']],
  ['/notifications', 'kind', NOTIFICATION_KINDS],
  ['/likes', 'kind', LIKE_KINDS],
  ['/receipts', 'status', RECEIPT_STATUSES],
  ['/receipts', 'category', RECEIPT_CATEGORIES],
  ['/cashback/ledger', 'type', LEDGER_TYPES],
  ['/cashback/ledger', 'status', LEDGER_STATUSES],
];
