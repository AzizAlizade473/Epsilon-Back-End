import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useData } from '../api/hooks';
import { receiptDetailSchema } from '../api/schemas';
import { Boundary, DataTable } from '../components/data';
import { PageHead } from '../components/page';
import { ReviewFeed } from '../components/reviews';
import { LedgerTable, StatusBadge } from '../components/tables';
import { Empty, Kpi, Panel } from '../components/ui';
import { fmtDateTime, fmtMoney, fmtNum } from '../lib/format';

export function Component() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const q = useData(`/receipts/${encodeURIComponent(id)}`, receiptDetailSchema);
  return (
    <Boundary q={q}>
      {(r) => (
        <div className="stack">
          <PageHead
            back={{ to: '/receipts', label: t('nav.receipts') }}
            title={r.merchant ?? r.restaurant ?? r.id}
            sub={<span className="mono">{r.fiscalIdMasked ?? r.id}</span>}
          />
          <div className="grid-4">
            <Kpi label={t('receipts.total')} metric="observed" value={fmtMoney(r.totalMinor)} />
            <Kpi label={t('receipts.imported')} value={fmtDateTime(r.importedAt)} />
            <Kpi label={t('receipts.engine')} value={[r.provider, r.engine].filter(Boolean).join(' / ') || '—'} />
            <Kpi label={t('common.status')} value={<StatusBadge status={r.status} ns="receiptStatus" />} />
          </div>
          <Panel title={t('receipts.lines')}>
            <p className="muted">{t('receipts.originalNames')}</p>
            {r.lines?.length ? (
              <DataTable
                caption={t('receipts.lines')}
                data={r.lines}
                rowKey={(l) => `${l.name}${l.qty}${l.priceMinor}`}
                cols={[
                  { id: 'name', header: t('receipts.lineName'), cell: (l) => l.name },
                  { id: 'qty', header: t('receipts.qty'), num: true, cell: (l) => fmtNum(l.qty, 2) },
                  { id: 'price', header: t('receipts.price'), num: true, cell: (l) => fmtMoney(l.priceMinor) },
                  { id: 'total', header: t('receipts.total'), num: true, cell: (l) => fmtMoney(l.totalMinor) },
                ]}
              />
            ) : (
              <Empty title={t('common.noData')} />
            )}
          </Panel>
          <Panel title={t('receipts.relatedReviews')}>
            <ReviewFeed items={r.reviews ?? []} />
          </Panel>
          <Panel title={t('cashback.ledger')}>
            {r.ledger?.length ? <LedgerTable items={r.ledger} /> : <Empty title={t('common.noData')} />}
          </Panel>
        </div>
      )}
    </Boundary>
  );
}
