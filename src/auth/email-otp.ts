import { createTransport } from 'nodemailer';
import type { SmsSender } from './sms.js';

/**
 * Demo only (config refuses it in production): instead of an SMS, each login code is
 * e-mailed through a Gmail account (App Password, SMTP) to the account owner's own
 * address, which otp.ts resolves. The code is also printed like the console provider,
 * so a mail outage never locks the demo out. Only the last two phone digits appear.
 */
export function gmailOtp(config: { GMAIL_USER: string; GMAIL_APP_PASSWORD: string }): SmsSender {
  const transport = createTransport({
    service: 'gmail',
    // Google shows App Passwords as "abcd efgh ijkl mnop"; the spaces are not part of it.
    auth: { user: config.GMAIL_USER, pass: config.GMAIL_APP_PASSWORD.replace(/\s/g, '') },
  });
  return async (phone, code, email) => {
    console.info(`[dev-sms] OTP for ${phone}: ${code}`);
    if (!email) return;
    try {
      await transport.sendMail({
        from: `Epsilon <${config.GMAIL_USER}>`,
        to: email,
        subject: `Epsilon kodu: ${code}`,
        text: `Epsilon giriş kodunuz: ${code}\n\nTelefon: ••${phone.slice(-2)}\n\nKodu heç kimə deməyin. Bu girişi siz etməmisinizsə, məktubu nəzərə almayın.`,
      });
    } catch (error) {
      // Never fail the login request over the demo mail: the code is in the log above.
      console.warn(`[demo-otp-mail] not sent: ${(error as Error).message}`);
    }
  };
}
