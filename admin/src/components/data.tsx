import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { UseQueryResult } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ApiError } from '../api/client';
import { useRangeLink } from '../lib/range';
import { Contour, Empty, Skeleton } from './ui';

export function PageSkeleton({ screen }: { screen?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={screen ? 'screen' : 'skel-page'} role="status" aria-busy="true" aria-label={t('common.loading')}>
      <div className="grid-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="kpi">
            <Skeleton h={14} w="60%" />
            <Skeleton h={32} w="45%" />
          </div>
        ))}
      </div>
      <Skeleton h={260} />
      <Skeleton h={160} />
    </div>
  );
}

/** Maps an API failure to a human state; never throws, so a bad response can't crash the page. */
export function StatusPanel({ error, onRetry, bootstrap }: { error: unknown; onRetry?: () => void; bootstrap?: boolean }) {
  const { t } = useTranslation();
  const e = error instanceof ApiError ? error : null;
  let key = 'generic';
  if (e?.kind === 'schema') key = 'schema';
  else if (e?.status === 401) key = 'expired';
  else if (e?.status === 403) key = 'forbidden';
  else if (e?.status === 404) key = bootstrap ? 'disabled' : 'notFound';
  else if (e?.kind === 'network') key = 'network';
  return (
    <div className="status" role="alert">
      <Contour />
      <h2>{t(`status.${key}.title`)}</h2>
      <p className="muted">{t(`status.${key}.body`)}</p>
      {key === 'expired' ? (
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          {t('status.reload')}
        </button>
      ) : (
        key !== 'forbidden' && key !== 'disabled' && key !== 'notFound' && onRetry && (
          <button type="button" className="btn" onClick={onRetry}>
            {t('common.retry')}
          </button>
        )
      )}
    </div>
  );
}

export const StatusScreen = ({ error, bootstrap }: { error: unknown; bootstrap?: boolean }) => (
  <div className="screen">
    <StatusPanel error={error} bootstrap={bootstrap} onRetry={() => window.location.reload()} />
  </div>
);

export function Boundary<T>({ q, children, skeleton }: { q: UseQueryResult<T, Error>; children: (data: T) => ReactNode; skeleton?: ReactNode }) {
  if (q.isPending) return <>{skeleton ?? <PageSkeleton />}</>;
  if (q.isError) return <StatusPanel error={q.error} onRetry={() => void q.refetch()} />;
  return <>{children(q.data)}</>;
}

export type Col<T> = { id: string; header: string; cell: (row: T) => ReactNode; num?: boolean; hideSm?: boolean };

export function DataTable<T>({ data, cols, rowKey, href, empty, loading, caption }: {
  data: T[];
  cols: Col<T>[];
  rowKey: (row: T) => string;
  /** Row link target; the first cell becomes a real link so keyboard users can follow it. */
  href?: (row: T) => string;
  empty?: string;
  loading?: boolean;
  caption: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const link = useRangeLink();
  if (!data.length && !loading) return <Empty title={empty ?? t('common.noData')} />;
  // Plain rendering: sorting and paging happen on the server.
  return (
    <div className={loading ? 'table-wrap is-loading' : 'table-wrap'}>
      <table className="table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.id} scope="col" className={`${c.num ? 'num-col' : ''} ${c.hideSm ? 'hide-sm' : ''}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={rowKey(row)} className={href ? 'row-link' : undefined} onClick={href ? () => void navigate(link(href(row))) : undefined}>
              {cols.map((c, i) => (
                <td key={c.id} className={`${c.num ? 'num-col num' : ''} ${c.hideSm ? 'hide-sm' : ''}`}>
                  {href && i === 0 ? (
                    <Link to={link(href(row))} className="cell-link" onClick={(e) => e.stopPropagation()}>
                      {c.cell(row)}
                    </Link>
                  ) : (
                    c.cell(row)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ page, hasPrev, hasNext, onPrev, onNext }: { page: number; hasPrev: boolean; hasNext: boolean; onPrev: () => void; onNext: () => void }) {
  const { t } = useTranslation();
  if (!hasPrev && !hasNext) return null;
  return (
    <nav className="pager" aria-label={t('common.pagination')}>
      <button type="button" className="btn btn-quiet" disabled={!hasPrev} onClick={onPrev}>
        <ChevronLeft size={16} aria-hidden="true" /> {t('common.previous')}
      </button>
      <span className="muted num">{t('common.page', { n: page })}</span>
      <button type="button" className="btn btn-quiet" disabled={!hasNext} onClick={onNext}>
        {t('common.next')} <ChevronRight size={16} aria-hidden="true" />
      </button>
    </nav>
  );
}
