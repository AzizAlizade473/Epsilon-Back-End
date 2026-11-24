import { formatInTimeZone } from 'date-fns-tz';

export const TZ = 'Asia/Baku';
export const DASH = '—';
const loc = () => (document.documentElement.lang === 'az' ? 'az' : 'en');
const nf = (o?: Intl.NumberFormatOptions) => new Intl.NumberFormat(loc(), o);

export const fmtNum = (v: number | null | undefined, digits = 0) =>
  v == null ? DASH : nf({ maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v);
export const fmtCompact = (v: number) => nf({ notation: 'compact', maximumFractionDigits: 1 }).format(v);
export const fmtRating = (v: number | null | undefined) => (v == null ? DASH : v.toFixed(2));
/** Ratio 0..1 -> "42.5%". */
export const fmtRate = (v: number | null | undefined) => (v == null ? DASH : `${(v * 100).toFixed(1)}%`);
/** Already a percentage 0..100. */
export const fmtPct = (v: number | null | undefined) => (v == null ? DASH : `${v.toFixed(1)}%`);

/** Integer qəpik -> "1 234.56 ₼" (space grouping, dot decimals). */
export function fmtMoney(minor: number | null | undefined): string {
  if (minor == null) return DASH;
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${whole}.${String(abs % 100).padStart(2, '0')} ₼`;
}

const date = (v: string | null | undefined, pattern: string) => {
  if (!v) return DASH;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? DASH : formatInTimeZone(d, TZ, pattern);
};
export const fmtDateTime = (v: string | null | undefined) => date(v, 'dd MMM yyyy, HH:mm');
export const fmtDate = (v: string | null | undefined) => date(v, 'dd MMM yyyy');
/** "2026-11-24" (a Baku calendar day) -> "24 Nov". */
export const fmtDay = (v: string) => date(v.length === 10 ? `${v}T12:00:00+04:00` : v, 'dd MMM');
export const bakuDay = (d: Date) => formatInTimeZone(d, TZ, 'yyyy-MM-dd');

/** Format a metric by its key convention: *Minor money, avgRating, *Rate ratio, *Pct percent. */
export function fmtMetric(key: string, v: number | null | undefined): string {
  if (v == null) return DASH;
  if (key.endsWith('Minor')) return fmtMoney(v);
  if (key === 'avgRating') return fmtRating(v);
  if (key.endsWith('Rate')) return fmtRate(v);
  if (key.endsWith('Pct')) return fmtPct(v);
  return fmtNum(v, Number.isInteger(v) ? 0 : 2);
}

export function fmtDuration(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

/** Server business types are snake_case ids: show them as words (fast_food → Fast food). */
export const categoryLabel = (id: string) => {
  const words = id.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};
