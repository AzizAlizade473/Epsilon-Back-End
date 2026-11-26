import { createTransport } from 'nodemailer';
import { fileURLToPath } from 'node:url';

import type { Config } from '../config.js';
import { ApiError } from '../errors.js';
import { LOGO_CID, renderMail, type Mail } from './template.js';

/** Resolves when the mail server accepted the message; otherwise EMAIL_DELIVERY_FAILED. */
export type Mailer = (mail: Mail) => Promise<void>;

const LOGO = fileURLToPath(new URL('./epsilon-logo.png', import.meta.url));
const TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 };
const failed = () => new ApiError(503, 'EMAIL_DELIVERY_FAILED', 'The e-mail could not be sent');

/** SMTP_* when SMTP_HOST is set, else the Gmail account. The From address is one that account may use. */
function sender(config: Config, create: typeof createTransport) {
  if (config.SMTP_HOST) {
    const tls = config.SMTP_PORT === 465;
    return {
      from: config.MAIL_FROM!,
      transport: create({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: tls,
        requireTLS: !tls, // never send the password or a code in clear text
        auth: { user: config.SMTP_USER!, pass: config.SMTP_PASS! },
        ...TIMEOUTS,
      }),
    };
  }
  if (config.GMAIL_USER && config.GMAIL_APP_PASSWORD)
    return {
      from: `Epsilon <${config.GMAIL_USER}>`,
      // Google shows App Passwords as "abcd efgh ijkl mnop"; the spaces are not part of it.
      transport: create({
        service: 'gmail',
        auth: { user: config.GMAIL_USER, pass: config.GMAIL_APP_PASSWORD.replace(/\s/g, '') },
        ...TIMEOUTS,
      }),
    };
  return null;
}

export function mailer(config: Config, create: typeof createTransport = createTransport): Mailer {
  const out = sender(config, create);
  return async (mail) => {
    if (!out) {
      if (config.NODE_ENV === 'production') {
        console.warn('[mail] not sent: no mail account configured');
        throw failed();
      }
      // Development without a mail account, like consoleSms.
      if (mail.kind === 'otp') console.info(`[dev-mail] code for ${mail.to}: ${mail.code}`);
      return;
    }
    try {
      await out.transport.sendMail({
        from: out.from,
        to: mail.to,
        ...renderMail(mail),
        attachments: [{ filename: 'epsilon-logo.png', path: LOGO, cid: LOGO_CID }],
      });
    } catch (error) {
      // Only the error class: SMTP messages can quote the recipient or the body.
      console.warn(`[mail] not sent: ${(error as { code?: string }).code ?? 'unknown error'}`);
      throw failed();
    }
  };
}
