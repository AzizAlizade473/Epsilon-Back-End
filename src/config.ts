import { z } from 'zod';

const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'postgres:// URL required'),
    /** HS256 secret for access tokens (>= 32 chars). */
    JWT_SECRET: z.string().min(32),
    /** HMAC key for OTP code hashes (>= 32 chars). */
    OTP_SECRET: z.string().min(32),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    /** Comma-separated Google OAuth client IDs accepted as ID-token audience. */
    GOOGLE_CLIENT_IDS: z.string().default(''),
    /** Comma-separated browser origins allowed to call the API (web build). Empty = none. */
    CORS_ORIGINS: z.string().default(''),
    /** `console` prints OTP codes to the server log (development only). */
    SMS_PROVIDER: z.enum(['console', 'none']).default('console'),
    MIN_APP_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/).default('1.0.0'),
    MIN_AGE: z.coerce.number().int().positive().default(16),
    REQUIRE_PHONE_VERIFICATION: flag.default(true),
    /** Fiscal receipt source. `none` until an authorised e-kassa integration exists; `fixture` = test data, never production. */
    FISCAL_PROVIDER: z.enum(['none', 'fixture']).default('none'),
    /** Gemini business-sector advisor. Off by default: no call is made unless this is `true`. */
    GEMINI_ENABLED: flag.default(false),
    GEMINI_API_KEY: z.string().min(10).optional(),
    GEMINI_MODEL: z.string().min(3).default('gemini-3.5-flash-lite'),
    /** Application cap protecting the free-tier quota (Google's own limits apply separately). */
    GEMINI_MAX_CALLS_PER_DAY: z.coerce.number().int().min(0).max(1000).default(5),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.FISCAL_PROVIDER === 'fixture')
      ctx.addIssue({ code: 'custom', path: ['FISCAL_PROVIDER'], message: 'fixture receipts are not allowed in production' });
    if (env.GEMINI_ENABLED && !env.GEMINI_API_KEY)
      ctx.addIssue({ code: 'custom', path: ['GEMINI_API_KEY'], message: 'GEMINI_ENABLED needs GEMINI_API_KEY' });
    if (env.NODE_ENV === 'production' && env.SMS_PROVIDER === 'console')
      ctx.addIssue({
        code: 'custom',
        path: ['SMS_PROVIDER'],
        message: 'console SMS provider is not allowed in production',
      });
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const result = schema.safeParse(source);
  if (!result.success) {
    // Report field names only; never echo secret values.
    const fields = [...new Set(result.error.issues.map((i) => i.path.join('.')))];
    throw new Error(`Invalid environment fields: ${fields.join(', ')}`);
  }
  return result.data;
}
