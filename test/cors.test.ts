import { expect, it } from 'vitest';

import { setup } from './helpers.js';

const preflight = (origin: string) => ({
  method: 'OPTIONS' as const,
  url: '/v1/auth/otp/request',
  headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'idempotency-key,content-type' },
});

it('allows only configured browser origins', async () => {
  const t = await setup({ CORS_ORIGINS: 'http://localhost:8081' });
  const ok = await t.app.inject(preflight('http://localhost:8081'));
  expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:8081');
  expect(String(ok.headers['access-control-allow-headers'])).toMatch(/Idempotency-Key/i);
  const other = await t.app.inject(preflight('https://evil.example'));
  expect(other.headers['access-control-allow-origin']).toBeUndefined();
});

it('sends no CORS headers when CORS_ORIGINS is empty', async () => {
  const t = await setup();
  const res = await t.app.inject(preflight('http://localhost:8081'));
  expect(res.headers['access-control-allow-origin']).toBeUndefined();
});
