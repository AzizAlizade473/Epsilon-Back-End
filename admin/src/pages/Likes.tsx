import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useData, usePaged } from '../api/hooks';
import { likeStatsSchema, likesSchema } from '../api/schemas';
import { Boundary, DataTable, Pager } from '../components/data';
import { SelectField, Toolbar } from '../components/page';
import { Kpi, Panel } from '../components/ui';
import { LIKE_KINDS } from '../lib/filters';
import { fmtDateTime, fmtNum } from '../lib/format';
import { useRangeLink } from '../lib/range';

const Item = ({ title, subtitle }: { title: string; subtitle?: string | null }) => (
  <span>
    {title}
    {subtitle && <span className="muted"> · {subtitle}</span>}
  </span>
);

export function Component() {
  const { t } = useTranslation();
  const link = useRangeLink();
  const [kind, setKind] = useState('');
  const stats = useData('/likes/stats', likeStatsSchema, {}, { range: true });
  const history = usePaged('/likes', likesSchema, { kind }, { range: true });
  return (
    <div className="stack">
      <Boundary q={stats}>
        {(s) => (
          <>
            <div className="kpis">
              {LIKE_KINDS.map((k) => (
                <Kpi key={k} label={t(`likes.kind.${k}`)} value={fmtNum(s.counts[k])} />
              ))}
            </div>
            <div className="grid-2">
              {LIKE_KINDS.map((k) => (
                <Panel key={k} title={`${t('likes.top')}: ${t(`likes.kind.${k}`)}`}>
                  <DataTable
                    caption={`${t('likes.top')}: ${t(`likes.kind.${k}`)}`}
                    data={s.top[k]}
                    rowKey={(r) => r.targetId}
                    cols={[
                      { id: 'item', header: t('likes.liked'), cell: (r) => <Item title={r.title} subtitle={r.subtitle} /> },
                      { id: 'count', header: t('likes.count'), num: true, cell: (r) => fmtNum(r.count) },
                    ]}
                  />
                </Panel>
              ))}
            </div>
          </>
        )}
      </Boundary>
      <Toolbar>
        <SelectField label={t('common.type')} value={kind} onChange={setKind} options={[['', t('common.all')], ...LIKE_KINDS.map((k): [string, string] => [k, t(`likes.kind.${k}`)])]} />
      </Toolbar>
      <Panel title={t('likes.history')}>
        <Boundary q={history.q}>
          {(d) => (
            <>
              <DataTable
                caption={t('likes.history')}
                data={d.items}
                loading={history.q.isFetching}
                rowKey={(r) => r.id}
                cols={[
                  { id: 'date', header: t('common.date'), cell: (r) => fmtDateTime(r.createdAt) },
                  { id: 'kind', header: t('common.type'), hideSm: true, cell: (r) => t(`likes.kind.${r.kind}`, { defaultValue: r.kind }) },
                  { id: 'item', header: t('likes.liked'), cell: (r) => <Item title={r.title} subtitle={r.subtitle} /> },
                  {
                    id: 'user',
                    header: t('users.user'),
                    cell: (r) => (
                      <Link to={link(`/users/${encodeURIComponent(r.user.id)}`)} className="cell-link">
                        {r.user.name ?? t('users.unnamed')}
                        <span className="muted mono"> {r.user.phoneMasked ?? r.user.emailMasked}</span>
                      </Link>
                    ),
                  },
                ]}
              />
              <Pager page={history.page} hasPrev={history.hasPrev} hasNext={history.hasNext} onPrev={history.onPrev} onNext={history.onNext} />
            </>
          )}
        </Boundary>
      </Panel>
    </div>
  );
}
