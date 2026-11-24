import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownRight, ArrowUpRight, Info, Minus, Star, Store, X } from 'lucide-react';
import { contourPaths } from '../lib/contour';
import { logoFor } from '../lib/brands';
import { fmtNum } from '../lib/format';

export const Skeleton = ({ h = 16, w = '100%' }: { h?: number; w?: number | string }) => (
  <span className="skeleton" style={{ height: h, width: w }} aria-hidden="true" />
);

/** Definition tooltip: text comes from `metrics.<key>` (docs/ADMIN.md metric definitions). */
export function InfoTip({ metric }: { metric: string }) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const text = t(`metrics.${metric}`, { defaultValue: '' });
  if (!text) return null;
  return (
    <span className="infotip" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="infotip-btn"
        aria-label={`${t('common.definition')}: ${t(`metricNames.${metric}`, { defaultValue: metric })}`}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      >
        <Info size={14} aria-hidden="true" />
      </button>
      {open && (
        <span role="tooltip" id={id} className="infotip-pop">
          {text}
        </span>
      )}
    </span>
  );
}

export const NotTracked = () => {
  const { t } = useTranslation();
  return <span className="badge badge-muted">{t('common.notTracked')}</span>;
};

/** Change vs the previous period; direction is shown by icon and sign, never colour alone. */
export function Delta({ cur, prev, abs }: { cur?: number | null; prev?: number | null; abs?: boolean }) {
  const { t } = useTranslation();
  if (cur == null || prev == null || (!abs && prev === 0)) return null;
  const diff = abs ? cur - prev : ((cur - prev) / Math.abs(prev)) * 100;
  const dir = Math.abs(diff) < 0.05 ? 'flat' : diff > 0 ? 'up' : 'down';
  const Icon = dir === 'up' ? ArrowUpRight : dir === 'down' ? ArrowDownRight : Minus;
  const text = `${diff > 0 ? '+' : ''}${diff.toFixed(abs ? 2 : 1)}${abs ? '' : '%'}`;
  return (
    <span className={`delta delta-${dir}`} aria-label={`${t(`common.${dir}`)} ${text.replace('+', '')} ${t('common.vsPrevious')}`}>
      <Icon size={14} aria-hidden="true" />
      <span aria-hidden="true">{text}</span>
    </span>
  );
}

export function Kpi({ label, metric, value, delta, notTracked, hero, sub }: {
  label: string;
  metric?: string;
  value: ReactNode;
  delta?: ReactNode;
  notTracked?: boolean;
  hero?: boolean;
  sub?: ReactNode;
}) {
  return (
    <div className={hero ? 'kpi kpi-hero' : 'kpi'}>
      <div className="kpi-label">
        {label}
        {metric && <InfoTip metric={metric} />}
      </div>
      <div className="kpi-value num">{notTracked ? <NotTracked /> : value}</div>
      {!notTracked && (delta || sub) && (
        <div className="kpi-foot">
          {delta}
          {sub && <span className="muted">{sub}</span>}
        </div>
      )}
    </div>
  );
}

export function Panel({ title, metric, actions, children, className = '' }: {
  title?: string;
  metric?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-head">
          <h2>
            {title}
            {metric && <InfoTip metric={metric} />}
          </h2>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Badge({ tone = 'muted', children }: { tone?: 'muted' | 'brand' | 'good' | 'bad' | 'warn'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** Epsilon rating stars: filled brand blue, neutral empty; partial values clip the filled layer. */
export function Stars({ value, size = 14 }: { value: number | null | undefined; size?: number }) {
  const { t } = useTranslation();
  if (value == null) return <span className="muted">—</span>;
  const pct = Math.max(0, Math.min(5, value)) * 20;
  const row = (cls: string) => (
    <span className={`stars-row ${cls}`} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <Star key={i} size={size} fill="currentColor" strokeWidth={0} />
      ))}
    </span>
  );
  return (
    <span className="stars" role="img" aria-label={t('common.starsOf', { value: value.toFixed(1) })}>
      {row('stars-empty')}
      <span className="stars-fill" style={{ width: `${pct}%` }}>
        {row('stars-on')}
      </span>
    </span>
  );
}

/** Restaurant logo when the chain is recognised, neutral mark otherwise. */
export function RestaurantCell({ name, branch, logoBrand, partner, sub }: {
  name: string;
  branch?: string | null;
  logoBrand?: string | null;
  partner?: boolean;
  sub?: ReactNode;
}) {
  const { t } = useTranslation();
  const logo = logoFor(name, logoBrand);
  return (
    <span className="rcell">
      <span className="rlogo">
        {logo ? <img src={logo} alt="" loading="lazy" /> : <Store size={16} aria-hidden="true" />}
      </span>
      <span className="rtext">
        <span className="rname">
          {name}
          {partner && <Badge tone="brand">{t('common.partner')}</Badge>}
        </span>
        {(branch || sub) && <span className="muted rsub">{sub ?? branch}</span>}
      </span>
    </span>
  );
}

/** Horizontal bars for the 1-5 star distribution; counts are printed, so colour is never the signal. */
export function Distribution({ counts }: { counts: number[] }) {
  const { t } = useTranslation();
  const total = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...counts);
  return (
    <ul className="dist" aria-label={t('common.ratingDistribution')}>
      {[5, 4, 3, 2, 1].map((s) => {
        const n = counts[s - 1] ?? 0;
        return (
          <li key={s}>
            <span className="dist-star num">{s}★</span>
            <span className="dist-track">
              <span className="dist-bar" style={{ width: `${(n / max) * 100}%` }} />
            </span>
            <span className="dist-n num">
              {fmtNum(n)} <span className="muted">{total ? `${Math.round((n / total) * 100)}%` : ''}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Stacked positive / neutral / negative bar per feedback dimension, with printed shares. */
export function Dimensions({ data }: { data: Record<string, { positive: number; neutral: number; negative: number }> }) {
  const { t } = useTranslation();
  const rows = Object.entries(data);
  if (!rows.length) return <Empty title={t('common.noData')} />;
  return (
    <ul className="dims">
      {rows.map(([name, v]) => {
        const total = v.positive + v.neutral + v.negative || 1;
        const pct = (n: number) => Math.round((n / total) * 100);
        return (
          <li key={name}>
            <span className="dims-name">{t(`dimension.${name}`, { defaultValue: name })}</span>
            <span className="dims-bar" role="img" aria-label={`${t('common.positive')} ${pct(v.positive)}%, ${t('common.neutral')} ${pct(v.neutral)}%, ${t('common.negative')} ${pct(v.negative)}%`}>
              <span className="seg seg-pos" style={{ width: `${pct(v.positive)}%` }} />
              <span className="seg seg-neu" style={{ width: `${pct(v.neutral)}%` }} />
              <span className="seg seg-neg" style={{ width: `${pct(v.negative)}%` }} />
            </span>
            <span className="dims-n num" aria-hidden="true">
              <span className="pos">+{pct(v.positive)}%</span> <span className="muted">{pct(v.neutral)}%</span> <span className="neg">−{pct(v.negative)}%</span>
            </span>
          </li>
        );
      })}
      <li className="dims-legend">
        <span className="pos">■ {t('common.positive')}</span>
        <span className="muted">■ {t('common.neutral')}</span>
        <span className="neg">■ {t('common.negative')}</span>
      </li>
    </ul>
  );
}

/** The one place the contour artwork is used: empty and status states, at very low opacity. */
export function Contour() {
  const w = 640;
  const h = 240;
  return (
    <svg className="contour" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      {contourPaths(w, h).map((d, i) => (
        <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth="1" />
      ))}
    </svg>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <Contour />
      <p className="empty-title">{title}</p>
      {hint && <p className="muted">{hint}</p>}
      {action}
    </div>
  );
}

/** Native <dialog>: focus trap, Escape and backdrop come from the platform. */
export function Dialog({ open, onClose, title, children, side }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  side?: boolean;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close?.();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={side ? 'drawer' : 'dialog'}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      {open && (
        <div className="dialog-body">
          <header className="dialog-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
              <X size={18} aria-hidden="true" />
            </button>
          </header>
          {children}
        </div>
      )}
    </dialog>
  );
}

export const VisuallyHidden = ({ children }: { children: ReactNode }) => <span className="sr-only">{children}</span>;
