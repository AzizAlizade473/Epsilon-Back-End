import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { GoogleVerifier } from './auth/google.js';
import type { SmsSender } from './auth/sms.js';
import type { Mailer } from './mail/mailer.js';
import type { SectorAdvisor } from './fiscal/classify.js';
import type { FiscalProvider } from './fiscal/provider.js';
import type { ReceiptImageReader } from './fiscal/gemini.js';
import type { PushSender } from './notifications/push.js';

export type Deps = {
  db: Db;
  config: Config;
  google: GoogleVerifier;
  sms: SmsSender;
  mail: Mailer;
  push: PushSender;
  /** Injectable clock for tests. */
  now: () => Date;
  /** Fiscal receipt source and optional AI sector advisor; safe "unavailable"/"off" defaults. */
  fiscal?: FiscalProvider;
  advisor?: SectorAdvisor;
  /** Reads customer-supplied receipt images (Gemini); off unless configured. */
  reader?: ReceiptImageReader;
};

export type AuthContext = { userId: string; familyId: string; authenticatedAt: Date };

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}
