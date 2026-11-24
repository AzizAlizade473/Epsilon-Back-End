import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/admin/api': { target: 'http://127.0.0.1:3100', changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    // Strict CSP (default-src 'self') blocks data: URIs, so never inline assets.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  test: { environment: 'jsdom', css: false, globals: false },
});
