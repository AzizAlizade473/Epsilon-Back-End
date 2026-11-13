export type SmsSender = (phone: string, code: string) => Promise<void>;

/** Development only: prints the code so you can type it into the app.
 * config.ts refuses SMS_PROVIDER=console in production. */
export const consoleSms: SmsSender = async (phone, code) => {
  console.info(`[dev-sms] OTP for ${phone}: ${code}`);
};

export const disabledSms: SmsSender = async () => {
  throw new Error('No SMS provider configured');
};
