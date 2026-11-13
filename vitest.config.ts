import { configDefaults, defineConfig } from 'vitest/config';

// test/_contract needs the app repo next to this one; run it with npm run test:contract.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, 'test/_contract/**'], testTimeout: 60_000 } });
