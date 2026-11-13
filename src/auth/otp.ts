import { and, count, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';

import type { Deps } from '../context.js';
import type { Db, Tx } from '../db/client.js';
import { otpChallenges } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { hmac, randomOtp, safeEqualHex } from '../lib/crypto.js';

export const OTP_TTL_SECONDS = 120;
export const OTP_RESEND_SECONDS = 60;
export const OTP_MAX_PER_HOUR = 5;
export const OTP_MAX_ATTEMPTS = 5;

type Purpose = (typeof otpChallenges.$inferInsert)['purpose'];

const codeHash = (deps: Deps, phone: string, code: string) =>
  hmac(deps.config.OTP_SECRET, `${phone}:${code}`);

/** Creates a challenge and sends the code. The response is the same whether or
 * not the phone has an account (no enumeration). Rate-limited per phone. */
export async function createChallenge(
  deps: Deps,
  tx: Db | Tx,
  input: { phone: string; purpose: Purpose; userId?: string },
): Promise<{ expiresAt: string; retryAfterSeconds: number }> {
  const now = deps.now();
  // Serialise challenge creation per phone so concurrent requests cannot skip the limits.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.phone}))`);
  const [last] = await tx
    .select({ createdAt: otpChallenges.createdAt })
    .from(otpChallenges)
    .where(eq(otpChallenges.phone, input.phone))
    .orderBy(desc(otpChallenges.createdAt))
    .limit(1);
  if (last) {
    const wait = OTP_RESEND_SECONDS - Math.floor((now.getTime() - last.createdAt.getTime()) / 1000);
    if (wait > 0) throw new ApiError(429, 'RATE_LIMITED', 'Wait before requesting another code', wait);
  }
  const [recent] = await tx
    .select({ n: count() })
    .from(otpChallenges)
    .where(
      and(
        eq(otpChallenges.phone, input.phone),
        gt(otpChallenges.createdAt, new Date(now.getTime() - 3_600_000)),
      ),
    );
  if ((recent?.n ?? 0) >= OTP_MAX_PER_HOUR)
    throw new ApiError(429, 'RATE_LIMITED', 'Too many codes requested', 3600);

  const code = randomOtp();
  const expiresAt = new Date(now.getTime() + OTP_TTL_SECONDS * 1000);
  await tx.insert(otpChallenges).values({
    phone: input.phone,
    purpose: input.purpose,
    userId: input.userId,
    codeHash: codeHash(deps, input.phone, code),
    expiresAt,
    createdAt: now,
  });
  await deps.sms(input.phone, code);
  return { expiresAt: expiresAt.toISOString(), retryAfterSeconds: OTP_RESEND_SECONDS };
}

/** Checks a code against the latest open challenge and consumes it on success.
 * Single atomic statements, no surrounding transaction, so a failed attempt is
 * counted even though this function throws. */
export async function consumeChallenge(
  deps: Deps,
  input: { phone: string; code: string; purpose: Purpose; userId?: string },
): Promise<void> {
  const now = deps.now();
  const [challenge] = await deps.db
    .select()
    .from(otpChallenges)
    .where(
      and(
        eq(otpChallenges.phone, input.phone),
        eq(otpChallenges.purpose, input.purpose),
        input.userId ? eq(otpChallenges.userId, input.userId) : isNull(otpChallenges.userId),
        isNull(otpChallenges.consumedAt),
      ),
    )
    .orderBy(desc(otpChallenges.createdAt))
    .limit(1);
  if (!challenge || challenge.expiresAt <= now)
    throw new ApiError(400, 'OTP_EXPIRED', 'Code expired');

  const [counted] = await deps.db
    .update(otpChallenges)
    .set({ attempts: sql`${otpChallenges.attempts} + 1` })
    .where(and(eq(otpChallenges.id, challenge.id), lt(otpChallenges.attempts, OTP_MAX_ATTEMPTS)))
    .returning({ id: otpChallenges.id });
  if (!counted) throw new ApiError(429, 'OTP_TOO_MANY', 'Too many attempts');

  if (!safeEqualHex(challenge.codeHash, codeHash(deps, input.phone, input.code)))
    throw new ApiError(400, 'OTP_INVALID', 'Wrong code');

  const [consumed] = await deps.db
    .update(otpChallenges)
    .set({ consumedAt: now })
    .where(and(eq(otpChallenges.id, challenge.id), isNull(otpChallenges.consumedAt)))
    .returning({ id: otpChallenges.id });
  if (!consumed) throw new ApiError(400, 'OTP_EXPIRED', 'Code already used');
}
