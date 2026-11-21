import { defineConfig } from 'vitest/config';
import path from 'node:path';

// The app repo (github.com/AzizAlizade473/Epsilon-Front-End) owns the API contract.
// Default: cloned next to this repo; override with EPSILON_APP_DIR.
const app = path.resolve(process.env.EPSILON_APP_DIR ?? path.resolve(import.meta.dirname, '../../../Epsilon-Front-End'));

export default defineConfig({
  resolve: { alias: { '@': path.join(app, 'src'), 'epsilon-app': path.join(app, 'src') } },
  test: { root: path.resolve(import.meta.dirname, '../..'), include: ['test/_contract/*.test.ts'] },
});
