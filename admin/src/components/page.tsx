import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Search } from 'lucide-react';
import { useRangeLink } from '../lib/range';
import { fmtMetric } from '../lib/format';
import { Kpi } from './ui';

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function PageHead({ title, sub, back, actions, lead }: { title?: ReactNode; sub?: ReactNode; back?: { to: string; label: string }; actions?: ReactNode; lead?: ReactNode }) {
  const link = useRangeLink();
  return (
    <div className="page-head">
      {back && (
        <Link to={link(back.to)} className="back">
          <ArrowLeft size={16} aria-hidden="true" /> {back.label}
        </Link>
      )}
      <div className="page-head-row">
        <div className="page-head-main">
          {lead}
          <div>
            {title && <h2 className="page-title">{title}</h2>}
            {sub && <p className="muted">{sub}</p>}
          </div>
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
    </div>
  );
}

export const Toolbar = ({ children }: { children: ReactNode }) => <div className="toolbar">{children}</div>;

export function SearchField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="field field-search">
      <span className="sr-only">{label}</span>
      <Search size={16} aria-hidden="true" />
      <input type="search" value={value} placeholder={label} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** Renders a `{ key: number }` map as KPI tiles; labels and definitions come from i18n by key. */
export function KpiMap({ data }: { data: Record<string, number | null> }) {
  const { t } = useTranslation();
  return (
    <div className="kpis">
      {Object.entries(data).map(([k, v]) => (
        <Kpi key={k} label={t(`metricNames.${k}`, { defaultValue: k })} metric={k} value={fmtMetric(k, v)} />
      ))}
    </div>
  );
}

export const NotTrackedPanel = ({ message }: { message?: string }) => {
  const { t } = useTranslation();
  return <p className="muted not-tracked">{message ?? t('common.notTrackedLong')}</p>;
};
