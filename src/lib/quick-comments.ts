/**
 * Rating-specific quick comments: stable ids with the dimension and sentiment
 * they express, so analytics can tell "poor taste" from "amazing taste" without
 * parsing display text. Each id belongs to exactly one star rating; the app
 * shows the six for the chosen rating and the server enforces the match.
 */
export type Sentiment = 'negative' | 'neutral' | 'positive';
export type Dimension =
  | 'taste'
  | 'freshness'
  | 'temperature'
  | 'preparation'
  | 'portion'
  | 'texture'
  | 'presentation'
  | 'price'
  | 'overall';

type Entry = { rating: 1 | 2 | 3 | 4 | 5; dimension: Dimension; sentiment: Sentiment };

export const QUICK_COMMENTS: Record<string, Entry> = {
  // 1 star: what went seriously wrong
  poor_taste: { rating: 1, dimension: 'taste', sentiment: 'negative' },
  not_fresh: { rating: 1, dimension: 'freshness', sentiment: 'negative' },
  served_cold: { rating: 1, dimension: 'temperature', sentiment: 'negative' },
  poor_preparation: { rating: 1, dimension: 'preparation', sentiment: 'negative' },
  disappointing_portion: { rating: 1, dimension: 'portion', sentiment: 'negative' },
  not_worth_price: { rating: 1, dimension: 'price', sentiment: 'negative' },
  // 2 stars: what could have been better
  needed_more_flavor: { rating: 2, dimension: 'taste', sentiment: 'negative' },
  temperature_could_improve: { rating: 2, dimension: 'temperature', sentiment: 'negative' },
  portion_too_small: { rating: 2, dimension: 'portion', sentiment: 'negative' },
  texture_not_right: { rating: 2, dimension: 'texture', sentiment: 'negative' },
  presentation_could_improve: { rating: 2, dimension: 'presentation', sentiment: 'negative' },
  too_expensive_for_quality: { rating: 2, dimension: 'price', sentiment: 'negative' },
  // 3 stars: a neutral or mixed experience
  average_taste: { rating: 3, dimension: 'taste', sentiment: 'neutral' },
  acceptable_portion: { rating: 3, dimension: 'portion', sentiment: 'neutral' },
  fair_price: { rating: 3, dimension: 'price', sentiment: 'neutral' },
  nothing_special: { rating: 3, dimension: 'overall', sentiment: 'neutral' },
  could_be_fresher: { rating: 3, dimension: 'freshness', sentiment: 'negative' },
  room_for_improvement: { rating: 3, dimension: 'overall', sentiment: 'neutral' },
  // 4 stars: what they enjoyed
  great_taste: { rating: 4, dimension: 'taste', sentiment: 'positive' },
  fresh_ingredients: { rating: 4, dimension: 'freshness', sentiment: 'positive' },
  good_portion: { rating: 4, dimension: 'portion', sentiment: 'positive' },
  nicely_prepared: { rating: 4, dimension: 'preparation', sentiment: 'positive' },
  good_presentation: { rating: 4, dimension: 'presentation', sentiment: 'positive' },
  good_value: { rating: 4, dimension: 'price', sentiment: 'positive' },
  // 5 stars: what made it special
  amazing_taste: { rating: 5, dimension: 'taste', sentiment: 'positive' },
  exceptionally_fresh: { rating: 5, dimension: 'freshness', sentiment: 'positive' },
  perfectly_prepared: { rating: 5, dimension: 'preparation', sentiment: 'positive' },
  perfect_portion: { rating: 5, dimension: 'portion', sentiment: 'positive' },
  beautiful_presentation: { rating: 5, dimension: 'presentation', sentiment: 'positive' },
  would_order_again: { rating: 5, dimension: 'overall', sentiment: 'positive' },
};

/** Codes stored by earlier app versions (no rating attached): still accepted and returned. */
export const LEGACY_REASON_CODES = [
  'taste',
  'temperature',
  'portion',
  'price',
  'presentation',
  'wait_time',
  'freshness',
  'service',
  'other',
] as const;

/** A code is valid when it is legacy, or a quick comment of the same star rating. */
export function validReason(code: string, rating: number) {
  return (
    (LEGACY_REASON_CODES as readonly string[]).includes(code) || QUICK_COMMENTS[code]?.rating === rating
  );
}
