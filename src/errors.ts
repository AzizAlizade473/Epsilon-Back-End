import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/** Machine error codes understood by the app (src/services/http/errors.ts there).
 * Codes outside that list (NOT_FOUND, FORBIDDEN, ...) are opaque to the app and
 * fall back to HTTP-status handling, as the contract allows. */
export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'SOCIAL_TOKEN_INVALID'
  | 'SOCIAL_EMAIL_UNVERIFIED'
  | 'OTP_INVALID'
  | 'EMAIL_REQUIRED'
  | 'PHONE_SIGNIN_UNAVAILABLE'
  | 'REPLY_NOT_FOUND'
  | 'REPLY_HIDDEN'
  | 'REVIEW_HIDDEN'
  | 'FEEDBACK_NOT_FOUND'
  | 'NOTIFICATION_NOT_FOUND'
  | 'LIKE_TARGET_NOT_FOUND'
  | 'OTP_EXPIRED'
  | 'OTP_TOO_MANY'
  | 'PHONE_IN_USE'
  | 'EMAIL_IN_USE'
  | 'EMAIL_IS_PRIMARY'
  | 'LAST_SIGN_IN_METHOD'
  | 'EMAIL_DELIVERY_FAILED'
  | 'IDENTITY_ALREADY_LINKED'
  | 'RECEIPT_UNSUPPORTED'
  | 'RECEIPT_NOT_FOUND'
  | 'RECEIPT_ALREADY_CLAIMED'
  | 'RECEIPT_EXPIRED'
  | 'RECEIPT_SOURCE_UNAVAILABLE'
  | 'RECEIPT_VERIFICATION_FAILED'
  | 'RECEIPT_READER_UNAVAILABLE'
  | 'RECEIPT_READER_QUOTA'
  | 'RECEIPT_READER_BUSY'
  | 'RECEIPT_IMAGE_INCOMPLETE'
  | 'RECEIPT_IMAGE_MISMATCH'
  | 'FEEDBACK_ALREADY_SUBMITTED'
  | 'AGE_RESTRICTED'
  | 'VALIDATION_FAILED'
  | 'RATE_LIMITED'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_EXISTS'
  | 'REAUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string = code,
    readonly retryAfterSeconds?: number,
    /** Machine-readable field names, e.g. which parts of a receipt image could not be read. */
    readonly fields?: string[],
    /** Extra machine-readable payload, e.g. the partly read receipt for the customer to complete. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** E-mailed codes only: a phone account without a saved e-mail has no inbox that proves its owner. */
export const phoneSignInUnavailable = () =>
  new ApiError(409, 'PHONE_SIGNIN_UNAVAILABLE', 'This number cannot sign in with a code. Use another sign-in method or contact support');

export const unauthorized = () => new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
export const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found');

/** Postgres unique violation → API error, keyed by constraint name. */
const uniqueViolations: Record<string, () => ApiError> = {
  users_phone_key: () => new ApiError(409, 'PHONE_IN_USE', 'Phone already in use'),
  auth_identities_provider_subject_key: () =>
    new ApiError(409, 'PHONE_IN_USE', 'Identity already in use'),
  auth_identities_user_provider_key: () =>
    new ApiError(409, 'IDENTITY_ALREADY_LINKED', 'Identity already linked'),
  feedback_purchase_item_key: () =>
    new ApiError(409, 'FEEDBACK_ALREADY_SUBMITTED', 'Feedback already submitted'),
  ledger_earned_feedback_key: () =>
    new ApiError(409, 'FEEDBACK_ALREADY_SUBMITTED', 'Feedback already submitted'),
};

type PgLikeError = { code?: string; constraint?: string; cause?: PgLikeError };

/** Returns the violated unique constraint name, or null. Drizzle wraps driver errors in `cause`. */
export function uniqueViolation(error: unknown): string | null {
  for (let e = error as PgLikeError | undefined, depth = 0; e && depth < 4; e = e.cause, depth++)
    if (e.code === '23505') return e.constraint ?? '';
  return null;
}

export function mapDbError(error: unknown): ApiError | null {
  const constraint = uniqueViolation(error);
  if (constraint === null) return null;
  return uniqueViolations[constraint]?.() ?? new ApiError(409, 'CONFLICT', 'Conflict');
}

/** One error → JSON mapping for every Fastify instance (public API and admin API). */
export function apiErrorHandler(error: FastifyError | ApiError, request: FastifyRequest, reply: FastifyReply) {
  let apiError: ApiError;
  if (error instanceof ApiError) apiError = error;
  else if (mapDbError(error)) apiError = mapDbError(error)!;
  else if (error.statusCode === 429) apiError = new ApiError(429, 'RATE_LIMITED', 'Too many requests');
  else if (error.statusCode && error.statusCode < 500)
    // Malformed JSON, wrong content type, body too large, ...
    apiError = new ApiError(error.statusCode === 413 ? 413 : 422, 'VALIDATION_FAILED', 'Malformed request');
  else {
    request.log.error({ err: error }, 'unhandled error');
    apiError = new ApiError(500, 'INTERNAL', 'Internal error');
  }
  if (apiError.retryAfterSeconds !== undefined) reply.header('Retry-After', String(apiError.retryAfterSeconds));
  return reply.code(apiError.status).send({
    error: {
      code: apiError.code,
      message: apiError.message,
      requestId: request.id,
      ...(apiError.retryAfterSeconds !== undefined ? { retryAfterSeconds: apiError.retryAfterSeconds } : {}),
      ...(apiError.fields?.length ? { fields: apiError.fields } : {}),
      ...(apiError.details ? apiError.details : {}),
    },
  });
}
