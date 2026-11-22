import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://unused', JWT_SECRET: 'x'.repeat(40), OTP_SECRET: 'y'.repeat(40) };

describe('demo login codes by e-mail (SMS_PROVIDER=gmail)', () => {
  it('needs a Gmail account and an App Password', () => {
    expect(() => loadConfig({ ...base, SMS_PROVIDER: 'gmail' })).toThrow(/GMAIL_APP_PASSWORD/);
    const config = loadConfig({ ...base, SMS_PROVIDER: 'gmail', GMAIL_USER: 'demo@example.com', GMAIL_APP_PASSWORD: 'abcdabcdabcdabcd' });
    expect(config.SMS_PROVIDER).toBe('gmail');
  });

  it('is refused in production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', SMS_PROVIDER: 'gmail', GMAIL_USER: 'demo@example.com', GMAIL_APP_PASSWORD: 'abcdabcdabcdabcd' }),
    ).toThrow(/SMS_PROVIDER/);
  });
});
