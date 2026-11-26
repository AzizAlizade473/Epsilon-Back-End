import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { lockUser, requireAnotherSignInMethod } from '../auth/identities.js';
import { consumeChallenge, createChallenge, maskEmail } from '../auth/otp.js';
import { requireRecentAuth } from '../auth/session.js';
import type { Deps } from '../context.js';
import type { Db, Tx } from '../db/client.js';
import {
  authIdentities,
  devices,
  likes,
  notificationPreferences,
  notifications,
  otpChallenges,
  replyReports,
  restaurantStaff,
  scanAttempts,
  sessions,
  users,
} from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { sha256 } from '../lib/crypto.js';
import { idempotent } from '../lib/idempotency.js';
import { emailAddress, emailSchema, otpCodeSchema, parse, phoneSchema } from '../lib/validation.js';
import { loadUser, nextStep, userView } from '../lib/views.js';

const name = z.string().trim().min(1).max(50);
const birthDate = z.iso.date();
const profileBody = z
  .object({
    firstName: name.optional(),
    lastName: name.optional(),
    birthDate: birthDate.optional(),
    language: z.enum(['az', 'en', 'ru']).optional(),
  })
  .strict();
const phoneBody = z.object({ phone: phoneSchema, email: emailSchema }).strict();
const phoneVerifyBody = z.object({ phone: phoneSchema, code: otpCodeSchema }).strict();
const emailRequestBody = z.object({ email: emailAddress, makePrimary: z.boolean() }).strict();
const emailVerifyBody = z.object({ email: emailAddress, code: otpCodeSchema }).strict();
const emailParams = z.object({ email: emailAddress }).strict();
const preferencesBody = z
  .object({ cashbackUpdates: z.boolean(), partnerUpdates: z.boolean(), reminders: z.boolean() })
  .strict();
const deviceBody = z.object({ token: z.string().trim().min(1).max(512) }).strict();

/** Whole years between an ISO date and `now` (UTC). */
export function ageOn(isoDate: string, now: Date): number {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age--;
  return age;
}

/** Challenges for adding an e-mail to this account that can still be verified. */
const openEmailChanges = (userId: string) =>
  and(
    eq(otpChallenges.userId, userId),
    eq(otpChallenges.purpose, 'link'),
    isNull(otpChallenges.phone),
    isNull(otpChallenges.consumedAt),
  );

async function emailsView(deps: Deps, conn: Db | Tx, userId: string) {
  const user = await loadUser(conn, userId);
  const identities = await conn
    .select()
    .from(authIdentities)
    .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, 'email')))
    .orderBy(asc(authIdentities.createdAt), asc(authIdentities.providerUserId));
  const [open] = await conn
    .select()
    .from(otpChallenges)
    .where(openEmailChanges(userId))
    .orderBy(desc(otpChallenges.createdAt))
    .limit(1);
  return {
    items: identities
      .map((i) => ({ email: i.providerUserId, primary: i.providerUserId === user.email, verifiedAt: i.createdAt.toISOString() }))
      .sort((a, b) => Number(b.primary) - Number(a.primary)),
    pending:
      open && open.expiresAt > deps.now()
        ? { email: open.email!, expiresAt: open.expiresAt.toISOString(), makePrimary: open.makePrimary }
        : null,
  };
}

export async function meRoutes(app: FastifyInstance, deps: Deps) {
  const authed = { config: { auth: true } };

  const limited = { config: { auth: true, rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.get('/me', authed, async (request) => {
    const user = await loadUser(deps.db, request.auth!.userId);
    return userView(deps.db, user);
  });

  app.patch('/me', authed, async (request, reply) => {
    const auth = request.auth!;
    const body = parse(profileBody, request.body);
    if (body.birthDate) {
      const age = ageOn(body.birthDate, deps.now());
      if (age < 0 || age > 120) throw new ApiError(422, 'VALIDATION_FAILED', 'Invalid fields: birthDate');
      if (age < deps.config.MIN_AGE) throw new ApiError(422, 'AGE_RESTRICTED', 'Below minimum age');
    }
    const out = await idempotent(deps, request, auth.userId, 'profile.update', async (tx) => {
      const [user] = await tx.update(users).set(body).where(eq(users.id, auth.userId)).returning();
      return { status: 200, body: { user: await userView(tx, user!), nextStep: nextStep(user!) } };
    });
    return reply.code(out.status).send(out.body);
  });

  app.delete('/me', authed, async (request, reply) => {
    const auth = request.auth!;
    requireRecentAuth(deps, auth);
    const out = await idempotent(deps, request, auth.userId, 'account.delete', async (tx) => {
      const now = deps.now();
      const me = await lockUser(tx, auth.userId);
      const identities = await tx
        .select({ id: authIdentities.providerUserId })
        .from(authIdentities)
        .where(and(eq(authIdentities.userId, auth.userId), eq(authIdentities.provider, 'email')));
      // Only addresses this account signs in with: other copies of an address may belong to someone else.
      const emails = identities.map((i) => i.id);
      await tx.update(sessions).set({ revokedAt: now }).where(eq(sessions.userId, auth.userId));
      await tx.delete(authIdentities).where(eq(authIdentities.userId, auth.userId));
      await tx.delete(devices).where(eq(devices.userId, auth.userId));
      await tx.delete(likes).where(eq(likes.userId, auth.userId));
      await tx.delete(scanAttempts).where(eq(scanAttempts.userId, auth.userId));
      // Restaurant access ends with the account; published replies are the restaurant's and stay.
      await tx.delete(restaurantStaff).where(eq(restaurantStaff.userId, auth.userId));
      await tx.delete(replyReports).where(eq(replyReports.reporterUserId, auth.userId));
      await tx.delete(notifications).where(eq(notifications.userId, auth.userId));
      await tx.delete(notificationPreferences).where(eq(notificationPreferences.userId, auth.userId));
      // Sign-in challenges carry the phone and/or e-mail but no user id.
      await tx
        .delete(otpChallenges)
        .where(
          or(
            eq(otpChallenges.userId, auth.userId),
            // Anonymous sign-in rows only for what this account itself signs in with: another
            // account may share an unverified address.
            me.phone ? and(isNull(otpChallenges.userId), eq(otpChallenges.phone, me.phone)) : undefined,
            emails.length ? and(isNull(otpChallenges.userId), inArray(otpChallenges.email, emails)) : undefined,
          ),
        );
      // Personal data is erased; feedback and ledger rows stay (financial records)
      // attached to the anonymised user. shortcut: retention policy is an owner decision.
      await tx
        .update(users)
        .set({
          phone: null,
          phoneVerifiedAt: null,
          email: null,
          firstName: null,
          lastName: null,
          birthDate: null,
          deletedAt: now,
        })
        .where(eq(users.id, auth.userId));
      return { status: 204, body: null };
    });
    return reply.code(out.status).send();
  });

  app.post('/me/phone/otp/request', { config: { auth: true, rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const auth = request.auth!;
    const body = parse(phoneBody, request.body);
    const out = await idempotent(deps, request, auth.userId, 'phone.link.request', async (tx) => {
      const [owner] = await tx
        .select({ userId: authIdentities.userId })
        .from(authIdentities)
        .where(and(eq(authIdentities.provider, 'phone'), eq(authIdentities.providerUserId, body.phone)));
      if (owner && owner.userId !== auth.userId) throw new ApiError(409, 'PHONE_IN_USE', 'Phone in use');
      const [own] = await tx
        .select({ id: authIdentities.id })
        .from(authIdentities)
        .where(and(eq(authIdentities.userId, auth.userId), eq(authIdentities.provider, 'phone')));
      if (own) throw new ApiError(409, 'IDENTITY_ALREADY_LINKED', 'Phone already linked');
      const challenge = await createChallenge(deps, tx, {
        ip: request.ip,
        phone: body.phone,
        purpose: 'link',
        userId: auth.userId,
        email: body.email,
        language: (await loadUser(tx, auth.userId)).language,
      });
      return { status: 200, body: challenge };
    });
    return reply.code(out.status).send(out.body);
  });

  // Not idempotency-keyed: the one-time code already makes it single-use, and the
  // attempt counter must commit outside the linking transaction.
  app.post('/me/phone/otp/verify', { config: { auth: true, rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const auth = request.auth!;
    const body = parse(phoneVerifyBody, request.body);
    await consumeChallenge(deps, { phone: body.phone, code: body.code, purpose: 'link', userId: auth.userId });
    return deps.db.transaction(async (tx) => {
      // Unique constraints turn a concurrent claim of the same phone into PHONE_IN_USE.
      await tx.insert(authIdentities).values({
        userId: auth.userId,
        provider: 'phone',
        providerUserId: body.phone,
      });
      const [user] = await tx
        .update(users)
        .set({ phone: body.phone, phoneVerifiedAt: deps.now() })
        .where(eq(users.id, auth.userId))
        .returning();
      return userView(tx, user!);
    });
  });

  app.delete('/me/phone', limited, async (request, reply) => {
    const auth = request.auth!;
    requireRecentAuth(deps, auth);
    const out = await idempotent(deps, request, auth.userId, 'phone.remove', async (tx) => {
      await lockUser(tx, auth.userId);
      const [own] = await tx
        .select()
        .from(authIdentities)
        .where(and(eq(authIdentities.userId, auth.userId), eq(authIdentities.provider, 'phone')));
      if (own) {
        await requireAnotherSignInMethod(tx, deps.config, auth.userId, own.id);
        await tx.delete(authIdentities).where(eq(authIdentities.id, own.id));
        await tx.delete(otpChallenges).where(eq(otpChallenges.phone, own.providerUserId));
        await tx.update(users).set({ phone: null, phoneVerifiedAt: null }).where(eq(users.id, auth.userId));
      }
      return { status: 204, body: null };
    });
    return reply.code(out.status).send();
  });

  app.get('/me/emails', authed, async (request) => emailsView(deps, deps.db, request.auth!.userId));

  app.post('/me/emails/request', limited, async (request, reply) => {
    const auth = request.auth!;
    requireRecentAuth(deps, auth);
    const body = parse(emailRequestBody, request.body);
    const out = await idempotent(deps, request, auth.userId, 'email.add.request', async (tx) => {
      const [owner] = await tx
        .select({ userId: authIdentities.userId })
        .from(authIdentities)
        .where(and(eq(authIdentities.provider, 'email'), eq(authIdentities.providerUserId, body.email)));
      if (owner && owner.userId !== auth.userId) throw new ApiError(409, 'EMAIL_IN_USE', 'E-mail in use');
      const { language } = await loadUser(tx, auth.userId);
      // One pending change at a time: the earlier code stops working (rolled back if sending fails).
      await tx.update(otpChallenges).set({ consumedAt: deps.now() }).where(openEmailChanges(auth.userId));
      const challenge = await createChallenge(deps, tx, {
        ip: request.ip,
        email: body.email,
        purpose: 'link',
        userId: auth.userId,
        makePrimary: body.makePrimary,
        language,
      });
      return { status: 200, body: challenge };
    });
    return reply.code(out.status).send(out.body);
  });

  // Not idempotency-keyed, like phone verification.
  app.post('/me/emails/verify', limited, async (request) => {
    const auth = request.auth!;
    const body = parse(emailVerifyBody, request.body);
    const { makePrimary } = await consumeChallenge(deps, {
      email: body.email,
      code: body.code,
      purpose: 'link',
      userId: auth.userId,
    });
    const { replaced, view, language } = await deps.db.transaction(async (tx) => {
      const user = await lockUser(tx, auth.userId);
      await tx
        .insert(authIdentities)
        .values({
          userId: auth.userId,
          provider: 'email',
          providerUserId: body.email,
          email: body.email,
          emailVerified: true,
          createdAt: deps.now(),
        })
        .onConflictDoNothing();
      const [owner] = await tx
        .select({ userId: authIdentities.userId })
        .from(authIdentities)
        .where(and(eq(authIdentities.provider, 'email'), eq(authIdentities.providerUserId, body.email)));
      if (owner?.userId !== auth.userId) throw new ApiError(409, 'EMAIL_IN_USE', 'E-mail in use');
      // An account without any e-mail takes the first verified one as primary.
      const switched = (makePrimary || !user.email) && user.email !== body.email;
      if (switched) await tx.update(users).set({ email: body.email }).where(eq(users.id, auth.userId));
      return {
        replaced: switched ? user.email : null,
        view: await emailsView(deps, tx, auth.userId),
        language: user.language,
      };
    });
    // After commit: the change stands even if the notice cannot be sent.
    if (replaced)
      await deps
        .mail({ kind: 'primary_changed', to: replaced, language, newEmail: maskEmail(body.email) })
        .catch(() => request.log.warn('primary e-mail change notice not sent'));
    return view;
  });

  app.delete('/me/emails/pending', limited, async (request, reply) => {
    const auth = request.auth!;
    const out = await idempotent(deps, request, auth.userId, 'email.add.cancel', async (tx) => {
      await tx.update(otpChallenges).set({ consumedAt: deps.now() }).where(openEmailChanges(auth.userId));
      return { status: 204, body: null };
    });
    return reply.code(out.status).send();
  });

  app.delete('/me/emails/:email', limited, async (request, reply) => {
    const auth = request.auth!;
    requireRecentAuth(deps, auth);
    const { email } = parse(emailParams, request.params);
    // The address is part of the operation (a reused key cannot answer for another one), hashed to store no PII.
    const out = await idempotent(deps, request, auth.userId, `email.remove:${sha256(email)}`, async (tx) => {
      const user = await lockUser(tx, auth.userId);
      const [own] = await tx
        .select({ id: authIdentities.id })
        .from(authIdentities)
        .where(
          and(
            eq(authIdentities.userId, auth.userId),
            eq(authIdentities.provider, 'email'),
            eq(authIdentities.providerUserId, email),
          ),
        );
      if (!own) throw notFound();
      if (user.email === email) throw new ApiError(409, 'EMAIL_IS_PRIMARY', 'Make another e-mail primary first');
      await requireAnotherSignInMethod(tx, deps.config, auth.userId, own.id);
      await tx.delete(authIdentities).where(eq(authIdentities.id, own.id));
      return { status: 204, body: null };
    });
    return reply.code(out.status).send();
  });

  app.get('/me/notification-settings', authed, async (request) => {
    const [row] = await deps.db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, request.auth!.userId));
    return { cashbackUpdates: row?.cashbackUpdates ?? false, partnerUpdates: row?.partnerUpdates ?? false, reminders: row?.reminders ?? true };
  });

  app.put('/me/notification-settings', authed, async (request, reply) => {
    const auth = request.auth!;
    const body = parse(preferencesBody, request.body);
    const out = await idempotent(deps, request, auth.userId, 'notifications.update', async (tx) => {
      await tx
        .insert(notificationPreferences)
        .values({ userId: auth.userId, ...body })
        .onConflictDoUpdate({
          target: notificationPreferences.userId,
          set: { ...body, updatedAt: deps.now() },
        });
      return { status: 200, body };
    });
    return reply.code(out.status).send(out.body);
  });

  app.post('/devices', authed, async (request, reply) => {
    const auth = request.auth!;
    const body = parse(deviceBody, request.body);
    const out = await idempotent(deps, request, auth.userId, 'device.register', async (tx) => {
      // A push token belongs to one device; re-registering moves it to the current user.
      await tx
        .insert(devices)
        .values({ userId: auth.userId, token: body.token })
        .onConflictDoUpdate({ target: devices.token, set: { userId: auth.userId } });
      return { status: 204, body: null };
    });
    return reply.code(out.status).send();
  });
}
