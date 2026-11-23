import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { consumeChallenge, createChallenge } from '../auth/otp.js';
import { issueSession, revokeFamily, rotateRefreshToken } from '../auth/session.js';
import type { Deps } from '../context.js';
import type { Tx } from '../db/client.js';
import { authIdentities, devices, users } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { emailSchema, intentSchema, otpCodeSchema, parse, phoneSchema } from '../lib/validation.js';
import { nextStep, userView } from '../lib/views.js';

const otpRequestBody = z.object({ phone: phoneSchema, intent: intentSchema, email: emailSchema }).strict();
const otpVerifyBody = z
  .object({ phone: phoneSchema, code: otpCodeSchema, intent: intentSchema })
  .strict();
const googleBody = z.object({ idToken: z.string().min(1).max(4096), intent: intentSchema }).strict();
const refreshBody = z.object({ refreshToken: z.string().min(1).max(256) }).strict();

type Identity = { provider: 'phone' | 'google'; subject: string; email: string | null; emailVerified: boolean };

function languageFrom(request: FastifyRequest): string {
  const tag = request.headers['accept-language']?.slice(0, 2).toLowerCase();
  return tag === 'en' || tag === 'ru' ? tag : 'az';
}

/** Finds or creates the account behind a verified identity, then signs it in.
 * Never links by email: a Google account and a phone account with the same
 * email stay separate until the user links a phone from inside the app. */
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

  let user = existing?.user;
  if (user && !user.email && identity.email)
    [user] = await tx.update(users).set({ email: identity.email }).where(eq(users.id, user.id)).returning();
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
  const session = await issueSession(deps, tx, user!.id);
  return {
    session,
    user: await userView(tx, user!),
    isNewUser: !existing,
    nextStep: nextStep(user!, deps.config),
  };
}

export async function authRoutes(app: FastifyInstance, deps: Deps) {
  // Per-IP limit on top of the per-phone limits in otp.ts.
  const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/auth/otp/request', limited, async (request) => {
    const body = parse(otpRequestBody, request.body);
    return deps.db.transaction((tx) =>
      createChallenge(deps, tx, { phone: body.phone, purpose: body.intent ?? 'signin', email: body.email }),
    );
  });

  app.post('/auth/otp/verify', limited, async (request) => {
    const body = parse(otpVerifyBody, request.body);
    const { email } = await consumeChallenge(deps, {
      phone: body.phone,
      code: body.code,
      purpose: body.intent ?? 'signin',
    });
    return deps.db.transaction((tx) =>
      signIn(
        deps,
        tx,
        // The code reached this inbox, so the e-mail is proven too.
        { provider: 'phone', subject: body.phone, email, emailVerified: email !== null },
        body.intent,
        languageFrom(request),
      ),
    );
  });

  app.post('/auth/google', limited, async (request) => {
    const body = parse(googleBody, request.body);
    const google = await deps.google(body.idToken);
    return deps.db.transaction((tx) =>
      signIn(
        deps,
        tx,
        { provider: 'google', subject: google.sub, email: google.email, emailVerified: google.emailVerified },
        body.intent,
        languageFrom(request),
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
