import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { consumeChallenge, createChallenge } from '../auth/otp.js';
import type { Deps } from '../context.js';
import {
  authIdentities,
  devices,
  notificationPreferences,
  otpChallenges,
  sessions,
  users,
} from '../db/schema.js';
import { ApiError } from '../errors.js';
import { idempotent } from '../lib/idempotency.js';
import { otpCodeSchema, parse, phoneSchema } from '../lib/validation.js';
import { loadUser, nextStep, userView } from '../lib/views.js';

/** Deletion needs a sign-in (OTP or Google) within this window. */
const RECENT_AUTH_MS = 10 * 60_000;

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
const phoneBody = z.object({ phone: phoneSchema }).strict();
const phoneVerifyBody = z.object({ phone: phoneSchema, code: otpCodeSchema }).strict();
const preferencesBody = z
  .object({ cashbackUpdates: z.boolean(), partnerUpdates: z.boolean() })
  .strict();
const deviceBody = z.object({ token: z.string().trim().min(1).max(512) }).strict();

/** Whole years between an ISO date and `now` (UTC). */
export function ageOn(isoDate: string, now: Date): number {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age--;
  return age;
}

export async function meRoutes(app: FastifyInstance, deps: Deps) {
  const authed = { config: { auth: true } };

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
      return { status: 200, body: { user: await userView(tx, user!), nextStep: nextStep(user!, deps.config) } };
    });
    return reply.code(out.status).send(out.body);
  });

  app.delete('/me', authed, async (request, reply) => {
    const auth = request.auth!;
    if (deps.now().getTime() - auth.authenticatedAt.getTime() > RECENT_AUTH_MS)
      throw new ApiError(403, 'REAUTH_REQUIRED', 'Sign in again to delete the account');
    const out = await idempotent(deps, request, auth.userId, 'account.delete', async (tx) => {
      const now = deps.now();
      await tx.update(sessions).set({ revokedAt: now }).where(eq(sessions.userId, auth.userId));
      await tx.delete(authIdentities).where(eq(authIdentities.userId, auth.userId));
      await tx.delete(devices).where(eq(devices.userId, auth.userId));
      await tx.delete(notificationPreferences).where(eq(notificationPreferences.userId, auth.userId));
      await tx.delete(otpChallenges).where(eq(otpChallenges.userId, auth.userId));
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
      const challenge = await createChallenge(deps, tx, { phone: body.phone, purpose: 'link', userId: auth.userId });
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

  app.get('/me/notification-settings', authed, async (request) => {
    const [row] = await deps.db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, request.auth!.userId));
    return { cashbackUpdates: row?.cashbackUpdates ?? false, partnerUpdates: row?.partnerUpdates ?? false };
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
