import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { claimEmail } from '../auth/identities.js';
import { consumeChallenge, createChallenge } from '../auth/otp.js';
import { issueSession, revokeFamily, rotateRefreshToken } from '../auth/session.js';
import type { Deps } from '../context.js';
import type { Tx } from '../db/client.js';
import { authIdentities, devices, users } from '../db/schema.js';
import { ApiError, phoneSignInUnavailable } from '../errors.js';
import { emailSchema, intentSchema, languageFrom, otpCodeSchema, parse, phoneSchema } from '../lib/validation.js';
import { nextStep, userView } from '../lib/views.js';

// `{ email }` signs in by e-mail. With `phone` it is the older phone flow, where `email` is the inbox.
const otpRequestBody = z
  .object({ phone: phoneSchema.optional(), email: emailSchema, intent: intentSchema })
  .strict()
  .refine((b) => b.phone !== undefined || b.email !== undefined);
const otpVerifyBody = z
  .object({ phone: phoneSchema.optional(), email: emailSchema, code: otpCodeSchema, intent: intentSchema })
  .strict()
  .refine((b) => (b.phone === undefined) !== (b.email === undefined));
const googleBody = z.object({ idToken: z.string().min(1).max(4096), intent: intentSchema }).strict();
const refreshBody = z.object({ refreshToken: z.string().min(1).max(256) }).strict();

type Identity = {
  provider: 'phone' | 'google' | 'email';
  subject: string;
  email: string | null;
  emailVerified: boolean;
  givenName?: string | null;
  familyName?: string | null;
};

/** Finds or creates the account behind a verified identity, then signs it in.
 * Never links accounts by email: a Google sign-in whose address is another account's verified e-mail
 * gets (or keeps) its own account, that e-mail identity stays where it is, and nothing is disclosed. */
async function signIn(
  deps: Deps,
  tx: Tx,
  identity: Identity,
  intent: 'login' | 'register' | undefined,
  language: string,
) {
  const [existing] = await tx
    .select({ user: users })
    .from(authIdentities)
    .innerJoin(users, eq(users.id, authIdentities.userId))
    .where(
      and(
        eq(authIdentities.provider, identity.provider),
        eq(authIdentities.providerUserId, identity.subject),
      ),
    );
  if (intent === 'login' && !existing) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'No account');
  if (intent === 'register' && existing) throw new ApiError(409, 'ACCOUNT_EXISTS', 'Account exists');

  // An e-mailed phone code signs into an existing account only from that account's own inbox. Checked
  // again here: the account may have appeared, or changed its e-mail, after the code was sent.
  if (identity.provider === 'phone' && identity.email && existing && existing.user.email !== identity.email)
    throw phoneSignInUnavailable();

  let user = existing?.user;
  if (user && !user.email && identity.email)
    [user] = await tx.update(users).set({ email: identity.email }).where(eq(users.id, user.id)).returning();
  // An account's own address is proven by this sign-in. Google's address for an account that
  // saved a different one does not become a new way to sign in to it.
  const provesOwnEmail = !existing || existing.user.email === identity.email;
  if (!user) {
    const now = deps.now();
    [user] = await tx
      .insert(users)
      .values({
        phone: identity.provider === 'phone' ? identity.subject : null,
        phoneVerifiedAt: identity.provider === 'phone' ? now : null,
        email: identity.email,
        language,
      })
      .returning();
    await tx.insert(authIdentities).values({
      userId: user!.id,
      provider: identity.provider,
      providerUserId: identity.subject,
      email: identity.email,
      emailVerified: identity.emailVerified,
    });
  }
  if (identity.provider !== 'email' && identity.email && identity.emailVerified && provesOwnEmail)
    await claimEmail(tx, user!.id, identity.email);
  // Google names fill blanks only; what the user typed always wins.
  const names = {
    ...(!user!.firstName && identity.givenName ? { firstName: identity.givenName } : {}),
    ...(!user!.lastName && identity.familyName ? { lastName: identity.familyName } : {}),
  };
  if (Object.keys(names).length)
    [user] = await tx.update(users).set(names).where(eq(users.id, user!.id)).returning();
  const session = await issueSession(deps, tx, user!.id);
  return {
    session,
    user: await userView(tx, user!),
    isNewUser: !existing,
    nextStep: nextStep(user!),
  };
}

export async function authRoutes(app: FastifyInstance, deps: Deps) {
  // Per-IP limit on top of the per-phone limits in otp.ts.
  const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/auth/otp/request', limited, async (request) => {
    const body = parse(otpRequestBody, request.body);
    const { phone, email } = body;
    const common = { purpose: body.intent ?? 'signin', language: languageFrom(request.headers['accept-language']), ip: request.ip } as const;
    return deps.db.transaction((tx) =>
      createChallenge(deps, tx, phone ? { ...common, phone, email } : { ...common, email: email! }),
    );
  });

  app.post('/auth/otp/verify', limited, async (request) => {
    const body = parse(otpVerifyBody, request.body);
    const { phone } = body;
    const common = { code: body.code, purpose: body.intent ?? 'signin' } as const;
    const { email } = await consumeChallenge(deps, phone ? { ...common, phone } : { ...common, email: body.email! });
    // The code reached this inbox, so the e-mail is proven too.
    const identity: Identity = phone
      ? { provider: 'phone', subject: phone, email, emailVerified: email !== null }
      : { provider: 'email', subject: body.email!, email: body.email!, emailVerified: true };
    return deps.db.transaction((tx) =>
      signIn(deps, tx, identity, body.intent, languageFrom(request.headers['accept-language'])),
    );
  });

  app.post('/auth/google', limited, async (request) => {
    const body = parse(googleBody, request.body);
    const google = await deps.google(body.idToken);
    return deps.db.transaction((tx) =>
      signIn(
        deps,
        tx,
        { ...google, provider: 'google', subject: google.sub },
        body.intent,
        languageFrom(request.headers['accept-language']),
      ),
    );
  });

  app.post('/auth/refresh', limited, async (request) => {
    const body = parse(refreshBody, request.body);
    return rotateRefreshToken(deps, body.refreshToken);
  });

  app.post('/auth/logout', { config: { auth: true } }, async (request, reply) => {
    const auth = request.auth!;
    await deps.db.transaction(async (tx) => {
      await revokeFamily(deps, tx, auth.familyId);
      // shortcut: devices are per user, not per session; logout unlinks all of them.
      await tx.delete(devices).where(eq(devices.userId, auth.userId));
    });
    return reply.code(204).send();
  });
}
