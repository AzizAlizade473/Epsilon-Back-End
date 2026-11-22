import { createTransport } from 'nodemailer';
import type { SmsSender } from './sms.js';

/**
 * Demo only (config refuses it in production): delivers each login code by e-mail
 * through a Gmail account (App Password, SMTP), to one demo inbox, instead of SMS.
 * The code is also printed like the console provider, so a mail outage never locks
 * the demo out. Only the last two phone digits appear in the mail.
 */
export function gmailOtp(config: { GMAIL_USER: string; GMAIL_APP_PASSWORD: string; DEMO_OTP_TO: string }): SmsSender {
  const transport = createTransport({
    service: 'gmail',
    auth: { user: config.GMAIL_USER, pass: config.GMAIL_APP_PASSWORD },
  });
  return async (phone, code) => {
    console.info(`[dev-sms] OTP for ${phone}: ${code}`);
    try {
      await transport.sendMail({
        from: `Epsilon <${config.GMAIL_USER}>`,
        to: config.DEMO_OTP_TO,
        subject: `Epsilon kodu: ${code}`,
        text: `Epsilon giriş kodunuz: ${code}\n\nTelefon: ••${phone.slice(-2)}\n\nBu demo e-poçtudur; real istifadədə kod SMS ilə gəlir.`,
      });
    } catch (error) {
      // Never fail the login request over the demo mail: the code is in the log above.
      console.warn(`[demo-otp-mail] not sent: ${(error as Error).message}`);
    }
  };
}
