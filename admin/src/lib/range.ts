import { addDays, endOfMonth, startOfMonth, subMonths } from 'date-fns';
import { useSearchParams } from 'react-router';
import { bakuDay } from './format';

export const PRESETS = ['today', 'yesterday', '7d', '30d', '90d', 'month', 'prevMonth', 'all', 'custom'] as const;
export type Preset = (typeof PRESETS)[number];

/** Reporting window as Asia/Baku calendar days; `all` means no bounds. */
export function resolveRange(preset: Preset, customFrom?: string | null, customTo?: string | null, now = new Date()) {
  const today = bakuDay(now);
  // Baku has no DST (UTC+4), so working on a noon-anchored date is safe.
  const base = new Date(`${today}T12:00:00+04:00`);
  const day = (d: Date) => bakuDay(d);
  switch (preset) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: day(addDays(base, -1)), to: day(addDays(base, -1)) };
    case '7d': return { from: day(addDays(base, -6)), to: today };
    case '30d': return { from: day(addDays(base, -29)), to: today };
    case '90d': return { from: day(addDays(base, -89)), to: today };
    case 'month': return { from: day(startOfMonth(base)), to: today };
    case 'prevMonth': {
      const p = subMonths(base, 1);
      return { from: day(startOfMonth(p)), to: day(endOfMonth(p)) };
    }
    case 'custom': return { from: customFrom ?? undefined, to: customTo ?? undefined };
    default: return { from: undefined, to: undefined };
  }
}

/** The range lives in the URL (?range=7d or ?range=custom&from=&to=) so links keep filters. */
export function useRange() {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('range');
  const preset: Preset = (PRESETS as readonly string[]).includes(raw ?? '') ? (raw as Preset) : '30d';
  const { from, to } = resolveRange(preset, sp.get('from'), sp.get('to'));
  const setRange = (p: Preset, f?: string, t?: string) =>
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      next.set('range', p);
      if (p === 'custom' && f && t) {
        next.set('from', f);
        next.set('to', t);
      } else {
        next.delete('from');
        next.delete('to');
      }
      return next;
    });
  return { preset, from, to, setRange };
}

/** Keep the global range on in-app links so filters survive navigation. */
export function useRangeLink() {
  const [sp] = useSearchParams();
  const keep = new URLSearchParams();
  for (const k of ['range', 'from', 'to']) if (sp.get(k)) keep.set(k, sp.get(k)!);
  const s = keep.toString();
  return (to: string) => (s ? `${to}${to.includes('?') ? '&' : '?'}${s}` : to);
}
