import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Table2, ChartColumn } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtCompact, fmtDay, fmtNum } from '../lib/format';
import { Empty, InfoTip } from './ui';

export type Series = { key: string; label: string; color: string; dashed?: boolean; right?: boolean };
type Row = { date: string; [k: string]: unknown };

const axisProps = { tick: { fill: 'var(--muted)', fontSize: 13 }, tickLine: false, axisLine: false } as const;
const tooltipStyle = { background: 'var(--surface)', border: '1px solid var(--hairline)', borderRadius: 8, fontSize: 13, color: 'var(--ink)' };

/**
 * Time-series chart. Colour only encodes the series; every chart has a screen-reader summary
 * and a "table" toggle that shows the exact numbers.
 */
export function TimeChart({ title, metric, data, series, kind, stacked, height = 260, valueFormat = fmtNum }: {
  title: string;
  metric?: string;
  data: Row[];
  series: Series[];
  kind: 'area' | 'bar' | 'line';
  stacked?: boolean;
  height?: number;
  valueFormat?: (v: number) => string;
}) {
  const { t } = useTranslation();
  const [asTable, setAsTable] = useState(false);
  const num = (r: Row, k: string) => Number(r[k] ?? 0);
  const summary = data.length
    ? `${title}: ${data.length} ${t('common.days')}, ${fmtDay(data[0]!.date)} – ${fmtDay(data[data.length - 1]!.date)}. ` +
      series.map((s) => `${s.label}: ${t('common.total')} ${valueFormat(data.reduce((a, r) => a + num(r, s.key), 0))}`).join('; ')
    : title;
  const hasRight = series.some((s) => s.right);
  const common = { data, margin: { top: 8, right: 8, left: 0, bottom: 0 } };
  const axes = (
    <>
      <CartesianGrid stroke="var(--hairline)" vertical={false} />
      <XAxis dataKey="date" tickFormatter={fmtDay} minTickGap={24} {...axisProps} />
      <YAxis yAxisId="l" allowDecimals={false} tickFormatter={(v: number) => fmtCompact(v)} width={44} {...axisProps} />
      {hasRight && <YAxis yAxisId="r" orientation="right" tickFormatter={(v: number) => fmtCompact(v)} width={44} {...axisProps} />}
      <Tooltip contentStyle={tooltipStyle} labelFormatter={(l) => fmtDay(String(l))} formatter={(v) => valueFormat(Number(v))} cursor={{ stroke: 'var(--hairline)' }} />
    </>
  );
  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <span className="chart-title">
          {title}
          {metric && <InfoTip metric={metric} />}
        </span>
        <ul className="legend">
          {series.map((s) => (
            <li key={s.key}>
              <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
              {s.label}
            </li>
          ))}
        </ul>
        {data.length > 0 && (
          <button type="button" className="btn btn-quiet" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>
            {asTable ? <ChartColumn size={16} aria-hidden="true" /> : <Table2 size={16} aria-hidden="true" />}
            {asTable ? t('common.viewChart') : t('common.viewTable')}
          </button>
        )}
      </figcaption>
      <p className="sr-only">{summary}</p>
      {!data.length ? (
        <Empty title={t('common.noData')} />
      ) : asTable ? (
        <div className="table-wrap" style={{ maxHeight: height }}>
          <table className="table">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col">{t('common.date')}</th>
                {series.map((s) => (
                  <th key={s.key} scope="col" className="num-col">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.date}>
                  <th scope="row">{fmtDay(r.date)}</th>
                  {series.map((s) => (
                    <td key={s.key} className="num-col num">
                      {valueFormat(num(r, s.key))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ height }} aria-hidden="true">
          <ResponsiveContainer width="100%" height="100%">
            {kind === 'area' ? (
              <AreaChart {...common}>
                {axes}
                {series.map((s) => (
                  <Area key={s.key} yAxisId={s.right ? 'r' : 'l'} dataKey={s.key} name={s.label} stroke={s.color} fill={s.color} fillOpacity={s.right ? 0 : 0.14} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} dot={false} type="monotone" isAnimationActive={false} />
                ))}
              </AreaChart>
            ) : kind === 'line' ? (
              <LineChart {...common}>
                {axes}
                {series.map((s) => (
                  <Line key={s.key} yAxisId={s.right ? 'r' : 'l'} dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} dot={false} type="monotone" isAnimationActive={false} />
                ))}
              </LineChart>
            ) : (
              <BarChart {...common} barCategoryGap="22%">
                {axes}
                {series.map((s) => (
                  <Bar key={s.key} yAxisId="l" dataKey={s.key} name={s.label} fill={s.color} stackId={stacked ? 'a' : undefined} radius={stacked ? 0 : [2, 2, 0, 0]} isAnimationActive={false} />
                ))}
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </figure>
  );
}
