import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError } from 'fastify';
import { randomUUID } from 'node:crypto';

import { authenticate } from './auth/session.js';
import type { Deps } from './context.js';
import { ApiError, mapDbError } from './errors.js';
import { authRoutes } from './routes/auth.js';
import { catalogRoutes } from './routes/catalog.js';
import { feedbackRoutes } from './routes/feedback.js';
import { meRoutes } from './routes/me.js';
import { receiptRoutes } from './routes/receipts.js';
import { walletRoutes } from './routes/wallet.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Route requires a valid bearer access token. */
    auth?: boolean;
  }
}

const REQUEST_ID = /^[\w-]{1,128}$/;

export async function buildApp(deps: Deps, options: { logger?: boolean } = {}) {
  const app = Fastify({
    bodyLimit: 16 * 1024,
    // Never log bodies (phones, OTPs, comments) or auth headers.
    logger: options.logger
      ? { redact: ['req.headers.authorization'], serializers: { req: (r) => ({ method: r.method, url: r.routeOptions?.url ?? 'unknown' }) } }
      : false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  });

  app.decorateRequest('auth', null);

  // Only browsers need CORS; the Android app is not affected by it.
  const origins = deps.config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (origins.length)
    await app.register(cors, {
      origin: origins,
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id', 'Accept-Language'],
      exposedHeaders: ['X-Request-Id', 'Retry-After'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) =>
      new ApiError(429, 'RATE_LIMITED', 'Too many requests', Math.ceil(ctx.ttl / 1000)),
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
  });
  app.addHook('preHandler', async (request) => {
    if (request.routeOptions.config.auth) request.auth = await authenticate(deps, request);
  });

  app.setErrorHandler((error: FastifyError | ApiError, request, reply) => {
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
      },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found', requestId: request.id } }),
  );

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(
    async (v1) => {
      await authRoutes(v1, deps);
      await meRoutes(v1, deps);
      await catalogRoutes(v1, deps);
      await receiptRoutes(v1, deps);
      await feedbackRoutes(v1, deps);
      await walletRoutes(v1, deps);
    },
    { prefix: '/v1' },
  );

  return app;
}
