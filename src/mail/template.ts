export type Language = 'az' | 'en' | 'ru';

export type Mail = { to: string; language: string } & (
  | { kind: 'otp'; code: string; purpose: 'signin' | 'email' | 'phone'; minutes: number; phone?: string }
  | { kind: 'primary_changed'; newEmail: string /* already masked */ }
);

export const LOGO_CID = 'epsilon-logo';
const BRAND = '#282973';

const COPY = {
  az: {
    otp: {
      signin: ['Epsilon giriş kodu', 'Epsilon hesabınıza daxil olmaq üçün bu kodu tətbiqə yazın.'],
      email: ['E-poçt ünvanını təsdiqləyin', 'Bu e-poçt ünvanını Epsilon hesabına əlavə etmək üçün bu kodu tətbiqə yazın.'],
      phone: ['Telefon nömrəsini təsdiqləyin', 'Telefon nömrəsini Epsilon hesabınızda təsdiqləmək üçün bu kodu tətbiqə yazın.'],
    },
    phone: (tail: string) => `Telefon: ••${tail}`,
    expires: (m: number) => `Kod ${m} dəqiqə ərzində etibarlıdır. Onu heç kimə deməyin.`,
    ignore: 'Bu sorğunu siz göndərməmisinizsə, məktubu nəzərə almayın.',
    changed: [
      'Əsas e-poçt ünvanınız dəyişdirildi',
      (to: string) => `Epsilon hesabınızın əsas e-poçt ünvanı indi budur: ${to}`,
      'Bunu siz etməmisinizsə, dərhal Epsilon dəstək xidməti ilə əlaqə saxlayın.',
    ],
    footer: 'Bu, Epsilon-un avtomatik göndərdiyi xidməti məktubdur.',
  },
  en: {
    otp: {
      signin: ['Your Epsilon sign-in code', 'Enter this code in the app to sign in to your Epsilon account.'],
      email: ['Confirm your e-mail address', 'Enter this code in the app to add this e-mail address to an Epsilon account.'],
      phone: ['Confirm your phone number', 'Enter this code in the app to confirm a phone number on your Epsilon account.'],
    },
    phone: (tail: string) => `Phone: ••${tail}`,
    expires: (m: number) => `The code is valid for ${m} minutes. Do not share it with anyone.`,
    ignore: 'If you did not ask for this, you can ignore this e-mail.',
    changed: [
      'Your primary e-mail was changed',
      (to: string) => `The primary e-mail address of your Epsilon account is now ${to}`,
      'If you did not do this, contact Epsilon support now.',
    ],
    footer: 'This is an automatic service message from Epsilon.',
  },
  ru: {
    otp: {
      signin: ['Код входа в Epsilon', 'Введите этот код в приложении, чтобы войти в аккаунт Epsilon.'],
      email: ['Подтвердите адрес электронной почты', 'Введите этот код в приложении, чтобы добавить этот адрес в аккаунт Epsilon.'],
      phone: ['Подтвердите номер телефона', 'Введите этот код в приложении, чтобы подтвердить номер телефона в аккаунте Epsilon.'],
    },
    phone: (tail: string) => `Телефон: ••${tail}`,
    expires: (m: number) => `Срок действия кода в минутах: ${m}. Никому его не сообщайте.`,
    ignore: 'Если вы не запрашивали код, просто проигнорируйте это письмо.',
    changed: [
      'Основной адрес почты изменён',
      (to: string) => `Теперь основной адрес почты вашего аккаунта Epsilon: ${to}`,
      'Если это сделали не вы, немедленно свяжитесь с поддержкой Epsilon.',
    ],
    footer: 'Это автоматическое служебное письмо Epsilon.',
  },
} as const;

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Subject, plain text and responsive HTML. The code stays out of the subject (mail servers log it). */
export function renderMail(mail: Mail) {
  const language: Language = mail.language === 'en' || mail.language === 'ru' ? mail.language : 'az';
  const t = COPY[language];
  const [subject, purpose] = mail.kind === 'otp' ? t.otp[mail.purpose] : [t.changed[0], t.changed[1](mail.newEmail)];
  const code = mail.kind === 'otp' ? mail.code : null;
  const notes: string[] =
    mail.kind === 'otp'
      ? [...(mail.phone ? [t.phone(mail.phone.slice(-2))] : []), t.expires(mail.minutes), t.ignore]
      : [t.changed[2]];
  const text = [subject, '', purpose, ...(code ? ['', code] : []), '', ...notes, '', `Epsilon. ${t.footer}`].join('\n');
  const p = (s: string, color = '#1c1c28') =>
    `<p style="margin:0 0 12px;font-size:15px;line-height:22px;color:${color}">${escape(s)}</p>`;
  const codeBlock = code
    ? `<p style="margin:20px 0;padding:18px 8px;background:#f0f0f8;border-radius:12px;text-align:center;font-family:'Courier New',monospace;font-size:36px;line-height:44px;font-weight:700;letter-spacing:8px;color:${BRAND};-webkit-user-select:all;user-select:all">${escape(code)}</p>`
    : '';
  const html = `<!doctype html>
<html lang="${language}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;border-top:6px solid ${BRAND}"><tr><td style="padding:28px 24px">
<img src="cid:${LOGO_CID}" width="64" height="50" alt="Epsilon" style="display:block;margin:0 0 20px;border:0">
<h1 style="margin:0 0 12px;font-size:22px;line-height:28px;color:${BRAND}">${escape(subject)}</h1>
${p(purpose)}${codeBlock}${notes.map((n) => p(n, '#55556a')).join('')}
<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e4e4ee;font-size:12px;line-height:18px;color:#6b6b80">Epsilon. ${escape(t.footer)}</p>
</td></tr></table>
</td></tr></table>
</body>
</html>`;
  return { subject, text, html };
}
