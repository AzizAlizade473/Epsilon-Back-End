import { buildApp } from './app.js';
import type { Deps } from './context.js';
import { googleVerifier } from './auth/google.js';
import { consoleSms, disabledSms } from './auth/sms.js';
import { gmailOtp } from './auth/email-otp.js';
import { loadConfig } from './config.js';
import { connect } from './db/client.js';
import { loadFixtureDir } from './fiscal/fixtures.js';
import { geminiAdvisor, geminiImageReader } from './fiscal/gemini.js';
import { sendMealReminders } from './notifications/reminders.js';
import { expoPush } from './notifications/push.js';
import { fixtureProvider, unavailableProvider } from './fiscal/provider.js';

const config = loadConfig();
const { db, close } = connect(config.DATABASE_URL);
const deps: Deps = {
    db,
    config,
    push: expoPush,
    google: googleVerifier(config.GOOGLE_CLIENT_IDS.split(',').map((s) => s.trim()).filter(Boolean)),
    sms:
      config.SMS_PROVIDER === 'gmail'
        ? gmailOtp({ GMAIL_USER: config.GMAIL_USER!, GMAIL_APP_PASSWORD: config.GMAIL_APP_PASSWORD! })
        : config.SMS_PROVIDER === 'console'
          ? consoleSms
          : disabledSms,
    now: () => new Date(),
    // No authorised e-kassa integration exists yet. `fixture` serves local test receipts only.
    fiscal: config.FISCAL_PROVIDER === 'fixture' ? fixtureProvider(loadFixtureDir('private-fixtures/fiscal')) : unavailableProvider,
    advisor: geminiAdvisor(db, config, () => new Date(), undefined, (event) => console.warn(`[gemini] ${event}`)),
    reader: geminiImageReader(db, config, () => new Date(), undefined, (event) => console.warn(`[gemini] ${event}`)),
};
const app = await buildApp(deps, { logger: true });

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// shortcut: in-process timer; with several API instances the 20 h cap and dedupe keys still prevent duplicates.
setInterval(() => {
  sendMealReminders(deps, new Date()).catch((error) => app.log.warn({ err: error }, 'meal reminders failed'));
}, 30 * 60_000).unref();

await app.listen({ port: config.PORT, host: config.HOST });
