import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({ resolve: { alias: { '@': path.resolve(import.meta.dirname, '../../../Epsilon-Front-End/src') } }, test: { root: path.resolve(import.meta.dirname, '../..'), include: ['test/_contract/*.test.ts'] } });
