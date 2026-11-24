import { useTranslation } from 'react-i18next';
import type { DishRow, LedgerEntry, NotificationRow, ReceiptRow } from '../api/schemas';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, fmtPct } from '../lib/format';
import { DataTable } from './data';
import { Badge, RatingCell } from './ui';

const tone = (s?: string | null) => (s === 'confirmed' || s === 'ok' || s === 'success' ? 'good' : s === 'pending' ? 'warn' : s === 'reversed' || s === 'failed' || s === 'denied' ? 'bad' : 'muted');
export const StatusBadge = ({ status, ns = 'ledger' }: { status?: string | null; ns?: string }) => {
  const { t } = useTranslation();
  return status ? <Badge tone={tone(status)}>{t(`${ns}.${status}`, { defaultValue: status })}</Badge> : <span className="muted">—</span>;
};

export function LedgerTable({ items }: { items: LedgerEntry[] }) {
  const { t } = useTranslation();
  return (
    <DataTable
      caption={t('cashback.ledger')}
      data={items}
      rowKey={(r) => r.id}
      cols={[
        { id: 'date', header: t('common.date'), cell: (r) => fmtDateTime(r.createdAt) },
        { id: 'type', header: t('common.type'), cell: (r) => t(`ledger.${r.type}`, { defaultValue: r.type ?? '—' }) },
        { id: 'status', header: t('common.status'), cell: (r) => <StatusBadge status={r.status} /> },
        { id: 'restaurant', header: t('nav.restaurants'), cell: (r) => r.restaurant ?? '—' },
        { id: 'amount', header: t('common.amount'), num: true, cell: (r) => fmtMoney(r.amountMinor) },
      ]}
    />
  );
}

export function NotificationsTable({ items }: { items: NotificationRow[] }) {
  const { t } = useTranslation();
  return (
    <DataTable
      caption={t('nav.notifications')}
      data={items}
      rowKey={(r) => r.id}
      cols={[
        { id: 'date', header: t('common.date'), cell: (r) => fmtDateTime(r.createdAt) },
        { id: 'kind', header: t('common.type'), cell: (r) => <Badge>{t(`kind.${r.kind}`, { defaultValue: r.kind ?? '—' })}</Badge> },
        { id: 'title', header: t('common.title'), cell: (r) => r.title ?? '—' },
        { id: 'read', header: t('common.status'), cell: (r) => (r.read || r.readAt ? t('notifications.read') : t('notifications.unread')) },
      ]}
    />
  );
}

export function ReceiptsTable({ items, loading, href = true }: { items: ReceiptRow[]; loading?: boolean; href?: boolean }) {
  const { t } = useTranslation();
  return (
    <DataTable
      caption={t('nav.receipts')}
      data={items}
      loading={loading}
      rowKey={(r) => r.id}
      href={href ? (r) => `/receipts/${encodeURIComponent(r.id)}` : undefined}
      cols={[
        { id: 'id', header: t('receipts.fiscalId'), cell: (r) => <span className="mono">{r.fiscalIdMasked ?? r.id}</span> },
        { id: 'restaurant', header: t('nav.restaurants'), cell: (r) => r.restaurant ?? '—' },
        { id: 'date', header: t('receipts.imported'), cell: (r) => fmtDateTime(r.importedAt) },
        { id: 'total', header: t('receipts.total'), num: true, cell: (r) => fmtMoney(r.totalMinor) },
        { id: 'items', header: t('receipts.items'), num: true, hideSm: true, cell: (r) => fmtNum(r.items) },
        { id: 'ratings', header: t('common.ratings'), num: true, hideSm: true, cell: (r) => fmtNum(r.ratings) },
        { id: 'engine', header: t('receipts.engine'), hideSm: true, cell: (r) => r.provider || r.engine ? <span className="cell-stack"><span>{r.provider ? t(`provider.${r.provider}`, { defaultValue: r.provider }) : '—'}</span>{r.engine && <span className="muted">{t(`engine.${r.engine}`, { defaultValue: r.engine })}</span>}</span> : '—' },
        { id: 'status', header: t('common.status'), cell: (r) => <StatusBadge status={r.status} ns="receiptStatus" /> },
      ]}
    />
  );
}

/** Dish ranking rows; `ratings` is the sample size and is always shown. */
export function DishesTable({ items, showRestaurant = true, loading }: { items: DishRow[]; showRestaurant?: boolean; loading?: boolean }) {
  const { t } = useTranslation();
  return (
    <DataTable
      caption={t('nav.dishes')}
      data={items}
      loading={loading}
      rowKey={(r) => r.key}
      href={(r) => `/dishes/${encodeURIComponent(r.key)}`}
      cols={[
        { id: 'name', header: t('dishes.dish'), cell: (r) => r.name },
        ...(showRestaurant ? [{ id: 'restaurant', header: t('nav.restaurants'), cell: (r: DishRow) => [r.restaurant, r.branch].filter(Boolean).join(' · ') || '—' }] : []),
        { id: 'purchases', header: t('dishes.purchases'), num: true, hideSm: true, cell: (r) => fmtNum(r.purchases) },
        { id: 'ratings', header: t('dishes.sample'), num: true, cell: (r) => fmtNum(r.ratings) },
        { id: 'avg', header: t('common.avgRating'), num: true, cell: (r) => <RatingCell value={r.avgRating} /> },
        { id: 'pos', header: t('common.positive'), num: true, hideSm: true, cell: (r) => <span className="pos">{fmtPct(r.positivePct)}</span> },
        { id: 'neg', header: t('common.negative'), num: true, hideSm: true, cell: (r) => <span className="neg">{fmtPct(r.negativePct)}</span> },
        { id: 'last', header: t('dishes.lastRated'), hideSm: true, cell: (r) => fmtDate(r.lastRatedAt) },
      ]}
    />
  );
}
