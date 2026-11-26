import { and, count, desc, eq, gt, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';

import type { Deps } from '../context.js';
import type { Db, Tx } from '../db/client.js';
import { authIdentities, otpChallenges, users } from '../db/schema.js';
import { ApiError, phoneSignInUnavailable } from '../errors.js';
import { hmac, randomOtp, safeEqualHex } from '../lib/crypto.js';

export const OTP_TTL_SECONDS = 120;
export const OTP_RESEND_SECONDS = 60;
export const OTP_MAX_PER_HOUR = 5;
export const OTP_MAX_ATTEMPTS = 5;
/** Codes one inbox can receive per hour across all requesters: above the per-requester cap, so
 * one caller cannot use up the owner's allowance. */
export const OTP_INBOX_MAX_PER_HOUR = 15;
export const OTP_IP_MAX_PER_DAY = 100;

type Purpose = (typeof otpChallenges.$inferInsert)['purpose'];

const codeHash = (deps: Deps, subject: string, code: string) =>
  hmac(deps.config.OTP_SECRET, `${subject}:${code}`);

/** The inbox for an e-mailed code. An account's saved e-mail always wins, so typing
 * someone else's phone number never redirects their code. Only a new number, or a signed-in
 * user's own request, uses the typed e-mail: an existing phone account without one is refused. */
async function deliveryEmail(tx: Db | Tx, input: { phone: string; userId?: string; email?: string }) {
  const [owner] = input.userId
    ? await tx.select({ email: users.email }).from(users).where(eq(users.id, input.userId))
    : await tx
        .select({ email: users.email })
        .from(authIdentities)
        .innerJoin(users, eq(users.id, authIdentities.userId))
        .where(and(eq(authIdentities.provider, 'phone'), eq(authIdentities.providerUserId, input.phone)));
  if (!input.userId && owner && !owner.email) return null;
  const email = owner?.email ?? input.email;
  if (!email) throw new ApiError(400, 'EMAIL_REQUIRED', 'An e-mail address is required to receive the code');
  return email;
}

/** "a***@gmail.com": enough to recognise the inbox, not to read the address. */
export function maskEmail(email: string) {
  const at = email.lastIndexOf('@');
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

const tooMany = () => new ApiError(429, 'RATE_LIMITED', 'Too many codes requested', 3600);
const within = (now: Date, ms: number) => gt(otpChallenges.createdAt, new Date(now.getTime() - ms));
async function countWhere(tx: Db | Tx, ...where: (SQL | undefined)[]) {
  const [row] = await tx.select({ n: count() }).from(otpChallenges).where(and(...where));
  return row?.n ?? 0;
}

/** E-mailed codes: caps per inbox and requester, per inbox overall, and (Gmail demo only, whose
 * account has a provider quota) per day. shortcut: the advisory lock is per subject, so parallel
 * requests may overshoot by a few. */
async function checkEmailQuota(deps: Deps, tx: Db | Tx, email: string, requester: SQL | undefined, now: Date) {
  const inbox = eq(otpChallenges.email, email);
  const hour = within(now, 3_600_000);
  if (requester && (await countWhere(tx, inbox, requester, hour)) >= OTP_MAX_PER_HOUR) throw tooMany();
  if ((await countWhere(tx, inbox, hour)) >= OTP_INBOX_MAX_PER_HOUR) throw tooMany();
  if (!deps.config.SMTP_HOST && (await countWhere(tx, isNotNull(otpChallenges.email), within(now, 86_400_000))) >= deps.config.OTP_EMAIL_MAX_PER_DAY)
    throw tooMany();
}

/** What a code proves: a phone number, or (no phone) an e-mail address. Both already normalised.
 * With a phone, `email` is the inbox typed for an e-mailed code. */
type Subject = { phone: string; email?: string } | { phone?: undefined; email: string };

const subjectKey = (s: Subject) => s.phone ?? s.email!;
const subjectRows = (s: Subject) =>
  s.phone ? eq(otpChallenges.phone, s.phone) : and(isNull(otpChallenges.phone), eq(otpChallenges.email, s.email!));

/** Refuses a login for an unknown phone or e-mail, or a registration for a known one, before any code exists.
 * This tells the caller whether it has an account (product decision); the route's per-IP limit bounds probing. */
async function checkIntent(tx: Db | Tx, subject: Subject, purpose: Purpose) {
  if (purpose !== 'login' && purpose !== 'register') return;
  const [account] = await tx
    .select({ id: authIdentities.id })
    .from(authIdentities)
    .where(
      and(
        eq(authIdentities.provider, subject.phone ? 'phone' : 'email'),
        eq(authIdentities.providerUserId, subjectKey(subject)),
      ),
    );
  if (purpose === 'login' && !account) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'No account');
  if (purpose === 'register' && account) throw new ApiError(409, 'ACCOUNT_EXISTS', 'Account exists');
}

/** Creates a challenge and sends the code. Without a login/register intent the response is the
 * same whether or not the account exists. Rate-limited per phone or e-mail, inbox and signed-in user.
 * Call inside a transaction: a failed delivery then leaves no challenge and no cooldown. */
export async function createChallenge(
  deps: Deps,
  tx: Db | Tx,
  input: Subject & { purpose: Purpose; userId?: string; makePrimary?: boolean; language: string; ip: string },
): Promise<{ expiresAt: string; retryAfterSeconds: number; delivery?: 'email'; sentTo?: string }> {
  const now = deps.now();
  const subject = subjectKey(input);
  await checkIntent(tx, input, input.purpose);
  const expiresAt = new Date(now.getTime() + OTP_TTL_SECONDS * 1000);
  // Where an e-mailed code goes: the address being proven, or the inbox standing in for SMS.
  const email = !input.phone
    ? input.email!
    : deps.config.SMS_PROVIDER === 'gmail'
      ? await deliveryEmail(tx, { phone: input.phone, userId: input.userId, email: input.email })
      : null;
  if (deps.config.SMS_PROVIDER === 'gmail' && input.phone && !email) {
    // A phone account with no saved e-mail: nothing may go to a typed inbox. Without an intent
    // the answer looks like any other, so it does not reveal that the account exists.
    if (input.purpose !== 'signin' || !input.email) throw phoneSignInUnavailable();
    return { expiresAt: expiresAt.toISOString(), retryAfterSeconds: OTP_RESEND_SECONDS, delivery: 'email', sentTo: maskEmail(input.email) };
  }
  // Serialise challenge creation per subject so concurrent requests cannot skip the limits.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${subject}))`);
  // Limits follow the requester (account, else network address), so a stranger asking for
  // someone's codes cannot lock the owner out.
  const ipHash = hmac(deps.config.OTP_SECRET, `ip:${input.ip}`);
  const requester = input.userId ? eq(otpChallenges.userId, input.userId) : eq(otpChallenges.ipHash, ipHash);
  const [last] = await tx
    .select({ createdAt: otpChallenges.createdAt })
    .from(otpChallenges)
    .where(and(subjectRows(input), requester))
    .orderBy(desc(otpChallenges.createdAt))
    .limit(1);
  if (last) {
    const wait = OTP_RESEND_SECONDS - Math.floor((now.getTime() - last.createdAt.getTime()) / 1000);
    if (wait > 0) throw new ApiError(429, 'RATE_LIMITED', 'Wait before requesting another code', wait);
  }
  const hour = within(now, 3_600_000);
  if ((await countWhere(tx, subjectRows(input), requester, hour)) >= OTP_MAX_PER_HOUR) throw tooMany();
  // A signed-in user is capped too, so one account cannot send codes to many different people.
  if (input.userId && (await countWhere(tx, requester, hour)) >= OTP_MAX_PER_HOUR) throw tooMany();
  if ((await countWhere(tx, eq(otpChallenges.ipHash, ipHash), within(now, 86_400_000))) >= OTP_IP_MAX_PER_DAY) throw tooMany();
  if (email) await checkEmailQuota(deps, tx, email, requester, now);

  const code = randomOtp();
  await tx.insert(otpChallenges).values({
    phone: input.phone ?? null,
    purpose: input.purpose,
    userId: input.userId,
    codeHash: codeHash(deps, subject, code),
    email,
    ipHash,
    makePrimary: input.makePrimary ?? false,
    expiresAt,
    createdAt: now,
  });
  if (email)
    await deps.mail({
      kind: 'otp',
      to: email,
      language: input.language,
      code,
      minutes: OTP_TTL_SECONDS / 60,
      purpose: !input.userId ? 'signin' : input.phone ? 'phone' : 'email',
      phone: input.phone,
    });
  else await deps.sms(input.phone!, code);
  return {
    expiresAt: expiresAt.toISOString(),
    retryAfterSeconds: OTP_RESEND_SECONDS,
    // Tells the app where to look.
    ...(email ? { delivery: 'email' as const, sentTo: maskEmail(email) } : {}),
  };
}

/** Checks a code against the newest challenge and consumes it on success. Only the newest counts:
 * a newer code supersedes older ones, even after it has been used or cancelled.
 * Single atomic statements, no surrounding transaction, so a failed attempt is
 * counted even though this function throws. */
export async function consumeChallenge(
  deps: Deps,
  input: Subject & { code: string; purpose: Purpose; userId?: string },
): Promise<{ email: string | null; makePrimary: boolean }> {
  const now = deps.now();
  const [challenge] = await deps.db
    .select()
    .from(otpChallenges)
    .where(
      and(
        subjectRows(input),
        eq(otpChallenges.purpose, input.purpose),
        input.userId ? eq(otpChallenges.userId, input.userId) : isNull(otpChallenges.userId),
      ),
    )
    .orderBy(desc(otpChallenges.createdAt))
    .limit(1);
  if (!challenge || challenge.consumedAt || challenge.expiresAt <= now)
    throw new ApiError(400, 'OTP_EXPIRED', 'Code expired');

  const [counted] = await deps.db
    .update(otpChallenges)
    .set({ attempts: sql`${otpChallenges.attempts} + 1` })
    .where(and(eq(otpChallenges.id, challenge.id), lt(otpChallenges.attempts, OTP_MAX_ATTEMPTS)))
    .returning({ id: otpChallenges.id });
  if (!counted) throw new ApiError(429, 'OTP_TOO_MANY', 'Too many attempts');

  if (!safeEqualHex(challenge.codeHash, codeHash(deps, subjectKey(input), input.code)))
    throw new ApiError(400, 'OTP_INVALID', 'Wrong code');

  const [consumed] = await deps.db
    .update(otpChallenges)
    .set({ consumedAt: now })
    .where(and(eq(otpChallenges.id, challenge.id), isNull(otpChallenges.consumedAt)))
    .returning({ id: otpChallenges.id });
  if (!consumed) throw new ApiError(400, 'OTP_EXPIRED', 'Code already used');
  return { email: challenge.email, makePrimary: challenge.makePrimary };
}
