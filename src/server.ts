import { buildApp } from './app.js';
import { googleVerifier } from './auth/google.js';
import { consoleSms, disabledSms } from './auth/sms.js';
import { loadConfig } from './config.js';
import { connect } from './db/client.js';
import { loadFixtureDir } from './fiscal/fixtures.js';
import { geminiAdvisor } from './fiscal/gemini.js';
import { fixtureProvider, unavailableProvider } from './fiscal/provider.js';

const config = loadConfig();
const { db, close } = connect(config.DATABASE_URL);
const app = await buildApp(
  {
    db,
    config,
    google: googleVerifier(config.GOOGLE_CLIENT_IDS.split(',').map((s) => s.trim()).filter(Boolean)),
    sms: config.SMS_PROVIDER === 'console' ? consoleSms : disabledSms,
    now: () => new Date(),
    // No authorised e-kassa integration exists yet. `fixture` serves local test receipts only.
    fiscal: config.FISCAL_PROVIDER === 'fixture' ? fixtureProvider(loadFixtureDir('private-fixtures/fiscal')) : unavailableProvider,
    advisor: geminiAdvisor(db, config, () => new Date(), undefined, (event) => console.warn(`[gemini] ${event}`)),
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
