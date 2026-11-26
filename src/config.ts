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
    /** Comma-separated reverse-proxy addresses whose X-Forwarded-For is trusted (e.g. `127.0.0.1` behind Caddy).
     * Empty = the socket address is the client. Without it every client behind the proxy shares one rate-limit budget. */
    TRUST_PROXY: z.string().default(''),
    /** Phone codes. `console` prints them to the server log (development only).
     * `gmail`: demo only, they are e-mailed (SMTP_* or Gmail) instead of sent by SMS. */
    SMS_PROVIDER: z.enum(['console', 'gmail', 'none']).default('console'),
    GMAIL_USER: z.string().email().optional(),
    /** A Google App Password (16 letters), never the account password. */
    GMAIL_APP_PASSWORD: z.string().min(16).optional(),
    /** Outgoing mail. Used when SMTP_HOST is set; otherwise GMAIL_USER/GMAIL_APP_PASSWORD.
     * With neither, development prints e-mail codes to the log and production cannot send them. */
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),
    /** Sender for SMTP, e.g. `Epsilon <info@epsilonup.com>`. The account must be allowed to send as it. */
    MAIL_FROM: z.string().min(3).optional(),
    /** Cap on e-mailed codes per 24 h, below the mail account's own limit (Gmail: about 500 a day). */
    OTP_EMAIL_MAX_PER_DAY: z.coerce.number().int().min(1).max(2000).default(400),
    // Must not exceed the app's current version (app.json), or every install is told to update.
    MIN_APP_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/).default('0.1.0'),
    MIN_AGE: z.coerce.number().int().positive().default(16),
    /** Fiscal receipt source. `none` until an authorised e-kassa integration exists; `fixture` = test data, never production. */
    FISCAL_PROVIDER: z.enum(['none', 'fixture']).default('none'),
    /** Gemini business-sector advisor. Off by default: no call is made unless this is `true`. */
    GEMINI_ENABLED: flag.default(false),
    GEMINI_API_KEY: z.string().min(10).optional(),
    GEMINI_MODEL: z.string().min(3).default('gemini-3.8-flash'),
    /** Max Gemini requests while importing one receipt (reading includes the sector suggestion). */
    GEMINI_MAX_CALLS_PER_RECEIPT: z.coerce.number().int().min(0).max(3).default(1),
    MAX_RECEIPT_IMAGE_BYTES: z.coerce.number().int().positive().max(12_000_000).default(6_000_000),
    /** Application cap protecting the free-tier quota (Google's own limits apply separately). */
    GEMINI_MAX_CALLS_PER_DAY: z.coerce.number().int().min(0).max(1000).default(5),
    /** Development only: folder (git-ignored) where failed receipt imports are saved to improve the parser. */
    FISCAL_DEBUG_DIR: z.string().min(1).optional(),
    /** Admin API (src/admin) on its own loopback listener. Off unless true. */
    ADMIN_ENABLED: flag.default(false),
    ADMIN_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    /** Read-only Postgres role (src/db/admin-readonly-role.sql). Required in production. */
    ADMIN_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'postgres:// URL required').optional(),
    /** Cloudflare Zero Trust team domain, e.g. epsilon.cloudflareaccess.com. */
    ADMIN_CF_TEAM_DOMAIN: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'host name required').optional(),
    ADMIN_CF_AUD: z.string().min(8).optional(),
    /** Local-tunnel mode (SSH tunnel to the loopback listener, no Cloudflare): this identity is used for loopback requests without an Access JWT. Allowed in production. */
    ADMIN_LOCAL_EMAIL: z.string().trim().toLowerCase().email().optional(),
    /** Development only: same as ADMIN_LOCAL_EMAIL but refused in production. */
    ADMIN_DEV_EMAIL: z.string().trim().toLowerCase().email().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.FISCAL_DEBUG_DIR)
      ctx.addIssue({ code: 'custom', path: ['FISCAL_DEBUG_DIR'], message: 'Receipt debug dumps are development only' });
    if (env.NODE_ENV === 'production' && env.FISCAL_PROVIDER === 'fixture')
      ctx.addIssue({ code: 'custom', path: ['FISCAL_PROVIDER'], message: 'fixture receipts are not allowed in production' });
    if (env.NODE_ENV === 'production' && env.ADMIN_DEV_EMAIL)
      ctx.addIssue({ code: 'custom', path: ['ADMIN_DEV_EMAIL'], message: 'admin development login is not allowed in production' });
    if (env.ADMIN_ENABLED) {
      if (env.NODE_ENV === 'production' && !env.ADMIN_DATABASE_URL)
        ctx.addIssue({ code: 'custom', path: ['ADMIN_DATABASE_URL'], message: 'ADMIN_ENABLED needs ADMIN_DATABASE_URL in production' });
      const access = (env.ADMIN_CF_TEAM_DOMAIN && env.ADMIN_CF_AUD) || env.ADMIN_LOCAL_EMAIL || env.ADMIN_DEV_EMAIL;
      if (!access)
        ctx.addIssue({ code: 'custom', path: ['ADMIN_CF_AUD'], message: 'ADMIN_ENABLED needs ADMIN_CF_TEAM_DOMAIN + ADMIN_CF_AUD, or ADMIN_LOCAL_EMAIL' });
    }
    if (env.GEMINI_ENABLED && !env.GEMINI_API_KEY)
      ctx.addIssue({ code: 'custom', path: ['GEMINI_API_KEY'], message: 'GEMINI_ENABLED needs GEMINI_API_KEY' });
    if (env.SMTP_HOST)
      for (const key of ['SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'] as const)
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'SMTP_HOST needs SMTP_USER, SMTP_PASS and MAIL_FROM' });
    if (env.SMS_PROVIDER === 'gmail' && !env.SMTP_HOST && (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD))
      ctx.addIssue({ code: 'custom', path: ['GMAIL_APP_PASSWORD'], message: 'SMS_PROVIDER=gmail needs SMTP_* or GMAIL_USER and GMAIL_APP_PASSWORD' });
    if (env.NODE_ENV === 'production' && env.SMS_PROVIDER === 'gmail')
      ctx.addIssue({ code: 'custom', path: ['SMS_PROVIDER'], message: 'e-mailed login codes are a demo, not allowed in production' });
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
