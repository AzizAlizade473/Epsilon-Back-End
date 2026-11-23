import { and, count, desc, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import type { Deps } from '../context.js';
import type { Db, Tx } from '../db/client.js';
import { authIdentities, otpChallenges, users } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { hmac, randomOtp, safeEqualHex } from '../lib/crypto.js';

export const OTP_TTL_SECONDS = 120;
export const OTP_RESEND_SECONDS = 60;
export const OTP_MAX_PER_HOUR = 5;
export const OTP_MAX_ATTEMPTS = 5;

type Purpose = (typeof otpChallenges.$inferInsert)['purpose'];

const codeHash = (deps: Deps, phone: string, code: string) =>
  hmac(deps.config.OTP_SECRET, `${phone}:${code}`);

/** The inbox for an e-mailed code. An account's saved e-mail always wins, so typing
 * someone else's phone number never redirects their code; a new number (or an old
 * account without an e-mail) uses the e-mail typed with it. */
async function deliveryEmail(tx: Db | Tx, input: { phone: string; userId?: string; email?: string }) {
  const [owner] = input.userId
    ? await tx.select({ email: users.email }).from(users).where(eq(users.id, input.userId))
    : await tx
        .select({ email: users.email })
        .from(authIdentities)
        .innerJoin(users, eq(users.id, authIdentities.userId))
        .where(and(eq(authIdentities.provider, 'phone'), eq(authIdentities.providerUserId, input.phone)));
  const email = owner?.email ?? input.email;
  if (!email) throw new ApiError(400, 'EMAIL_REQUIRED', 'An e-mail address is required to receive the code');
  return email;
}

/** "a***@gmail.com": enough to recognise the inbox, not to read the address. */
export function maskEmail(email: string) {
  const at = email.lastIndexOf('@');
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/** E-mailed codes: an inbox gets no more than a phone does, and the sending account has a
 * daily cap, so typing new phone numbers can neither spam one address nor burn the quota.
 * shortcut: the advisory lock is per phone, so parallel requests may overshoot by a few. */
async function checkEmailQuota(deps: Deps, tx: Db | Tx, email: string, now: Date) {
  const since = (ms: number) => gt(otpChallenges.createdAt, new Date(now.getTime() - ms));
  const [inbox] = await tx.select({ n: count() }).from(otpChallenges).where(and(eq(otpChallenges.email, email), since(3_600_000)));
  if ((inbox?.n ?? 0) >= OTP_MAX_PER_HOUR) throw new ApiError(429, 'RATE_LIMITED', 'Too many codes requested', 3600);
  const [day] = await tx.select({ n: count() }).from(otpChallenges).where(and(isNotNull(otpChallenges.email), since(86_400_000)));
  if ((day?.n ?? 0) >= deps.config.OTP_EMAIL_MAX_PER_DAY) throw new ApiError(429, 'RATE_LIMITED', 'Too many codes requested', 3600);
}

/** Creates a challenge and sends the code. The response is the same whether or
 * not the phone has an account (no enumeration). Rate-limited per phone. */
export async function createChallenge(
  deps: Deps,
  tx: Db | Tx,
  input: { phone: string; purpose: Purpose; userId?: string; email?: string },
): Promise<{ expiresAt: string; retryAfterSeconds: number; delivery?: 'email'; sentTo?: string }> {
  const now = deps.now();
  const email = deps.config.SMS_PROVIDER === 'gmail' ? await deliveryEmail(tx, input) : null;
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
  if (email) await checkEmailQuota(deps, tx, email, now);

  const code = randomOtp();
  const expiresAt = new Date(now.getTime() + OTP_TTL_SECONDS * 1000);
  await tx.insert(otpChallenges).values({
    phone: input.phone,
    purpose: input.purpose,
    userId: input.userId,
    codeHash: codeHash(deps, input.phone, code),
    email,
    expiresAt,
    createdAt: now,
  });
  await deps.sms(input.phone, code, email ?? undefined);
  return {
    expiresAt: expiresAt.toISOString(),
    retryAfterSeconds: OTP_RESEND_SECONDS,
    // Tells the app where to look: the demo provider e-mails codes instead of texting them.
    ...(email ? { delivery: 'email' as const, sentTo: maskEmail(email) } : {}),
  };
}

/** Checks a code against the latest open challenge and consumes it on success.
 * Single atomic statements, no surrounding transaction, so a failed attempt is
 * counted even though this function throws. */
export async function consumeChallenge(
  deps: Deps,
  input: { phone: string; code: string; purpose: Purpose; userId?: string },
): Promise<{ email: string | null }> {
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
  return { email: challenge.email };
}
