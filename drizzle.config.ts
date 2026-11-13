import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// `drizzle-kit studio` needs DATABASE_URL; load it from .env when present.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
