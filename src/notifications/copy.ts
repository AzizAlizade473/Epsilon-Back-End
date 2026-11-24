/** Lock-screen safe copy: only the credited amount, never dish prices, fiscal ids or item names. */
type Lang = 'az' | 'en' | 'ru';
const pick = <T>(lang: string, v: Record<Lang, T>): T => v[lang as Lang] ?? v.az;

export const cashbackCopy = (lang: string, amountMinor: number) => {
  const a = `${(amountMinor / 100).toFixed(2)} ₼`;
  return {
    title: pick(lang, { az: 'Keşbek təsdiqləndi', en: 'Cashback confirmed', ru: 'Кешбэк подтверждён' }),
    body: pick(lang, {
      az: `${a} hesabınıza əlavə olundu.`,
      en: `${a} added to your wallet.`,
      ru: `${a} зачислено на ваш счёт.`,
    }),
  };
};

export const mealCopy = (lang: string, n: number) => ({
  title: pick(lang, { az: 'Yeməyiniz necə idi?', en: 'How was your meal?', ru: 'Как прошла трапеза?' }),
  body: pick(lang, {
    az: `${n} yeməyinizi qiymətləndirə bilərsiniz.`,
    en: `You still have ${n} ${n === 1 ? 'dish' : 'dishes'} you can rate.`,
    ru: `Вы ещё можете оценить блюда: ${n}.`,
  }),
});

export const partnerCopy = (lang: string, name: string) => ({
  title: pick(lang, { az: `${name} Epsilon-a qoşuldu`, en: `${name} has joined Epsilon`, ru: `${name} теперь в Epsilon` }),
  body: pick(lang, {
    az: 'Fikrinizi bölüşün və mövcud keşbeki kəşf edin.',
    en: 'Share your thoughts and discover available cashback.',
    ru: 'Делитесь мнением и узнайте о доступном кешбэке.',
  }),
});
