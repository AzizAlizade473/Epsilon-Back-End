import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { GoogleVerifier } from './auth/google.js';
import type { SmsSender } from './auth/sms.js';

export type Deps = {
  db: Db;
  config: Config;
  google: GoogleVerifier;
  sms: SmsSender;
  /** Injectable clock for tests. */
  now: () => Date;
};

export type AuthContext = { userId: string; familyId: string; authenticatedAt: Date };

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}
