import { buildApp } from './app.js';
import type { Deps } from './context.js';
import { googleVerifier } from './auth/google.js';
import { consoleSms, disabledSms } from './auth/sms.js';
import { gmailOtp } from './auth/email-otp.js';
import { buildAdminApp, defaultStaticDir } from './admin/routes.js';
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

let adminApp: Awaited<ReturnType<typeof buildAdminApp>> | undefined;
const shutdown = async () => {
  await adminApp?.close();
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

// Admin API: a separate listener on loopback only (reached through cloudflared or an SSH tunnel).
if (config.ADMIN_ENABLED) {
  let ro = db;
  if (config.ADMIN_DATABASE_URL) {
    const conn = connect(config.ADMIN_DATABASE_URL);
    ro = conn.db;
    process.on('exit', () => void conn.close());
  } else app.log.warn('ADMIN_DATABASE_URL is not set: admin analytics use the read-write pool (allowed outside production only)');
  if (config.ADMIN_LOCAL_EMAIL) app.log.warn('admin local-tunnel mode is active: loopback requests without an Access JWT are trusted as ADMIN_LOCAL_EMAIL');
  adminApp = await buildAdminApp(
    { db, ro, config, now: () => new Date(), version: process.env.npm_package_version ?? '1.0.0' },
    { logger: true, staticDir: defaultStaticDir() },
  );
  await adminApp.listen({ port: config.ADMIN_PORT, host: '127.0.0.1' });
}
