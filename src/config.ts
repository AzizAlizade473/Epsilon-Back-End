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
    /** `console` prints OTP codes to the server log (development only). */
    SMS_PROVIDER: z.enum(['console', 'none']).default('console'),
    MIN_APP_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/).default('1.0.0'),
    MIN_AGE: z.coerce.number().int().positive().default(16),
    REQUIRE_PHONE_VERIFICATION: flag.default(true),
  })
  .superRefine((env, ctx) => {
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
