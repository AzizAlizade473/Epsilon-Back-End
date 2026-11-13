import { buildApp } from './app.js';
import { googleVerifier } from './auth/google.js';
import { consoleSms, disabledSms } from './auth/sms.js';
import { loadConfig } from './config.js';
import { connect } from './db/client.js';

const config = loadConfig();
const { db, close } = connect(config.DATABASE_URL);
const app = await buildApp(
  {
    db,
    config,
    google: googleVerifier(config.GOOGLE_CLIENT_IDS.split(',').map((s) => s.trim()).filter(Boolean)),
    sms: config.SMS_PROVIDER === 'console' ? consoleSms : disabledSms,
    now: () => new Date(),
  },
  { logger: true },
);

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
