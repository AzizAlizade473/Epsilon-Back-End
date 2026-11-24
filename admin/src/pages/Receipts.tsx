import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useData, usePaged } from '../api/hooks';
import { receiptHealthSchema, receiptsSchema } from '../api/schemas';
import { Boundary, Pager } from '../components/data';
import { TextField, Toolbar, useDebounced } from '../components/page';
import { ReceiptsTable } from '../components/tables';
import { Kpi, NotTracked, Panel } from '../components/ui';
import { fmtNum } from '../lib/format';

/** Counts-by-name map or array, normalised to [label, count] rows. */
const pairs = (v: unknown): [string, number][] =>
  Array.isArray(v)
    ? v.map((x: { name?: string; key?: string; provider?: string; engine?: string; count?: number; receipts?: number }) => [x.name ?? x.key ?? x.provider ?? x.engine ?? '—', x.count ?? x.receipts ?? 0])
    : Object.entries((v ?? {}) as Record<string, number>);

function CountList({ title, data, ns }: { title: string; data: unknown; ns: 'provider' | 'engine' }) {
  const { t } = useTranslation();
  const rows = pairs(data);
  return (
    <div className="kpi">
      <div className="kpi-label">{title}</div>
      <ul className="counts">
        {rows.map(([k, n]) => (
          <li key={k}>
            <span>{t(`${ns}.${k}`, { defaultValue: k })}</span>
            <span className="num">{fmtNum(n)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Health() {
  const { t } = useTranslation();
  const q = useData('/receipts/health', receiptHealthSchema, {}, { range: true });
  return (
    <section className="section">
      <h2 className="section-title">{t('receipts.health')}</h2>
      <Boundary q={q}>
        {(h) => (
          <div className="kpis">
            <Kpi label={t('receipts.imported')} metric="receiptsImported" value={fmtNum(h.imported)} />
            <Kpi label={t('receipts.unsupported')} value={fmtNum(h.unsupported)} notTracked={h.tracking?.unsupported === 'not_tracked'} />
            <Kpi label={t('receipts.unknownMerchant')} value={fmtNum(h.unknownMerchant)} notTracked={h.tracking?.unknownMerchant === 'not_tracked'} />
            <div className="kpi">
              <div className="kpi-label">{t('receipts.failures')}</div>
              <div className="kpi-value">{h.failures === 'not_tracked' || h.failures == null ? <NotTracked /> : <span className="num">{JSON.stringify(h.failures)}</span>}</div>
            </div>
            <CountList title={t('receipts.byProvider')} data={h.byProvider} ns="provider" />
            <CountList title={t('receipts.byEngine')} data={h.byEngine} ns="engine" />
          </div>
        )}
      </Boundary>
    </section>
  );
}

export function Component() {
  const { t } = useTranslation();
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const p = usePaged('/receipts', receiptsSchema, { status: useDebounced(status.trim()), category: useDebounced(category.trim()) }, { range: true });
  return (
    <div className="stack">
      <Health />
      <Toolbar>
        <TextField label={t('common.status')} value={status} onChange={setStatus} />
        <TextField label={t('common.category')} value={category} onChange={setCategory} />
      </Toolbar>
      <Panel title={t('nav.receipts')}>
        <Boundary q={p.q}>
          {(d) => (
            <>
              <ReceiptsTable items={d.items} loading={p.q.isFetching} />
              <Pager page={p.page} hasPrev={p.hasPrev} hasNext={p.hasNext} onPrev={p.onPrev} onNext={p.onNext} />
            </>
          )}
        </Boundary>
      </Panel>
    </div>
  );
}
