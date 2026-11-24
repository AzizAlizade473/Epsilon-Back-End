import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useData, usePaged } from '../api/hooks';
import { cashbackSchema, ledgerSchema } from '../api/schemas';
import { TimeChart } from '../components/charts';
import { Boundary, DataTable, Pager } from '../components/data';
import { SelectField } from '../components/page';
import { LedgerTable } from '../components/tables';
import { Kpi, Panel } from '../components/ui';
import { fmtMoney } from '../lib/format';

const STATUSES = ['confirmed', 'pending', 'reversed', 'expired'];

export function Component() {
  const { t } = useTranslation();
  const [status, setStatus] = useState('');
  const q = useData('/cashback', cashbackSchema, {}, { range: true });
  const ledger = usePaged('/cashback/ledger', ledgerSchema, { status }, { range: true });
  return (
    <div className="stack">
      <Boundary q={q}>
        {(d) => (
          <>
            <div className="kpis">
              <Kpi label={t('cashback.confirmed')} metric="cashbackConfirmed" value={fmtMoney(d.confirmedMinor)} />
              <Kpi label={t('cashback.pending')} metric="cashbackPending" value={fmtMoney(d.pendingMinor)} />
              <Kpi label={t('cashback.reversed')} metric="cashbackReversed" value={fmtMoney(d.reversedMinor)} />
              <Kpi label={t('cashback.expired')} metric="cashbackExpired" value={fmtMoney(d.expiredMinor)} />
              <Kpi label={t('cashback.liability')} metric="cashbackLiability" value={fmtMoney(d.liabilityMinor)} />
            </div>
            <Panel>
              <TimeChart
                title={t('cashback.byDay')}
                data={d.byDay.flatMap((r) => (r.date ? [{ ...r, date: r.date }] : []))}
                kind="bar"
                stacked
                valueFormat={(v) => fmtMoney(v)}
                series={[
                  { key: 'confirmedMinor', label: t('cashback.confirmed'), color: 'var(--c1)' },
                  { key: 'pendingMinor', label: t('cashback.pending'), color: 'var(--c3)' },
                  { key: 'reversedMinor', label: t('cashback.reversed'), color: 'var(--c4)' },
                  { key: 'expiredMinor', label: t('cashback.expired'), color: 'var(--c5)' },
                ]}
              />
            </Panel>
            <Panel title={t('cashback.byRestaurant')}>
              <DataTable
                caption={t('cashback.byRestaurant')}
                data={d.byRestaurant}
                rowKey={(r) => r.key ?? r.name ?? ''}
                cols={[
                  { id: 'name', header: t('nav.restaurants'), cell: (r) => r.name ?? '—' },
                  { id: 'c', header: t('cashback.confirmed'), num: true, cell: (r) => fmtMoney(r.confirmedMinor) },
                  { id: 'p', header: t('cashback.pending'), num: true, cell: (r) => fmtMoney(r.pendingMinor) },
                  { id: 'r', header: t('cashback.reversed'), num: true, cell: (r) => fmtMoney(r.reversedMinor) },
                  { id: 'e', header: t('cashback.expired'), num: true, cell: (r) => fmtMoney(r.expiredMinor) },
                ]}
              />
            </Panel>
          </>
        )}
      </Boundary>
      <Panel
        title={t('cashback.ledger')}
        actions={<SelectField label={t('common.status')} value={status} onChange={setStatus} options={[['', t('common.all')], ...STATUSES.map((s): [string, string] => [s, t(`ledger.${s}`)])]} />}
      >
        <Boundary q={ledger.q}>
          {(d) => (
            <>
              <LedgerTable items={d.items} />
              <Pager page={ledger.page} hasPrev={ledger.hasPrev} hasNext={ledger.hasNext} onPrev={ledger.onPrev} onNext={ledger.onNext} />
            </>
          )}
        </Boundary>
      </Panel>
    </div>
  );
}
