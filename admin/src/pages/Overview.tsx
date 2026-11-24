import { useTranslation } from 'react-i18next';
import { useData } from '../api/hooks';
import { overviewSchema } from '../api/schemas';
import { TimeChart } from '../components/charts';
import { Boundary, DataTable } from '../components/data';
import { Delta, Distribution, Kpi, Panel, RestaurantCell, Stars, Empty, RatingCell } from '../components/ui';
import { fmtDateTime, fmtMoney, fmtNum, fmtPct, fmtRate, fmtRating } from '../lib/format';

export function Component() {
  const { t } = useTranslation();
  // Cheap query: refreshes every 60 s while the tab is visible.
  const q = useData('/overview', overviewSchema, {}, { range: true, live: true });
  return (
    <Boundary q={q}>
      {(d) => {
        const k = d.kpis;
        const p = d.previous;
        const nt = (key: string) => d.tracking?.[key] === 'not_tracked';
        const days = d.series.days;
        const base = (k.totalUsers ?? 0) - days.reduce((a, x) => a + x.newUsers, 0);
        let run = base;
        const growth = days.map((x) => ({ date: x.date, newUsers: x.newUsers, activeUsers: x.activeUsers, total: (run += x.newUsers) }));
        return (
          <div className="stack">
            <div className="kpis kpis-hero">
              <Kpi hero label={t('metricNames.totalUsers')} metric="totalUsers" value={fmtNum(k.totalUsers)} notTracked={nt('totalUsers')} delta={<Delta cur={k.totalUsers} prev={p?.totalUsers} />} />
              <Kpi hero label={t('metricNames.ratings')} metric="ratings" value={fmtNum(k.ratings)} notTracked={nt('ratings')} delta={<Delta cur={k.ratings} prev={p?.ratings} />} />
              <Kpi hero label={t('metricNames.avgRating')} metric="avgRating" value={<span className="kpi-rating">{fmtRating(k.avgRating)} <Stars value={k.avgRating} size={16} /></span>} notTracked={nt('avgRating')} delta={<Delta abs cur={k.avgRating} prev={p?.avgRating} />} />
              <Kpi hero label={t('metricNames.receiptsImported')} metric="receiptsImported" value={fmtNum(k.receiptsImported)} notTracked={nt('receiptsImported')} delta={<Delta cur={k.receiptsImported} prev={p?.receiptsImported} />} />
            </div>
            <div className="kpis">
              <Kpi label={t('metricNames.newUsers')} metric="newUsers" value={fmtNum(k.newUsers)} notTracked={nt('newUsers')} delta={<Delta cur={k.newUsers} prev={p?.newUsers} />} />
              <Kpi label={t('overview.activeUsers')} metric="activeUser" value={`${fmtNum(k.dau)} / ${fmtNum(k.wau)} / ${fmtNum(k.mau)}`} notTracked={nt('dau')} />
              <Kpi label={t('metricNames.uniqueRestaurants')} metric="uniqueRestaurants" value={fmtNum(k.uniqueRestaurants)} notTracked={nt('uniqueRestaurants')} delta={<Delta cur={k.uniqueRestaurants} prev={p?.uniqueRestaurants} />} />
              <Kpi label={t('metricNames.cashbackConfirmedMinor')} metric="cashbackConfirmedMinor" value={fmtMoney(k.cashbackConfirmedMinor)} notTracked={nt('cashbackConfirmedMinor')} delta={<Delta cur={k.cashbackConfirmedMinor} prev={p?.cashbackConfirmedMinor} />} />
              <Kpi label={t('metricNames.receiptToRatingRate')} metric="receiptToRatingRate" value={fmtRate(k.receiptToRatingRate)} notTracked={nt('receiptToRatingRate')} />
              <Kpi label={t('metricNames.returningUserPct')} metric="returningUserPct" value={fmtPct(k.returningUserPct)} notTracked={nt('returningUserPct')} />
              <Kpi label={t('metricNames.avgRatingsPerReceipt')} metric="avgRatingsPerReceipt" value={fmtNum(k.avgRatingsPerReceipt, 2)} notTracked={nt('avgRatingsPerReceipt')} />
              <Kpi label={t('metricNames.activePartners')} metric="activePartners" value={fmtNum(k.activePartners)} notTracked={nt('activePartners')} />
            </div>
            <div className="grid-3">
              <Panel className="span-2">
                <TimeChart
                  title={t('overview.userGrowth')}
                  data={growth}
                  kind="area"
                  series={[
                    { key: 'newUsers', label: t('metricNames.newUsers'), color: 'var(--c1)' },
                    { key: 'activeUsers', label: t('overview.active'), color: 'var(--c3)' },
                    { key: 'total', label: t('overview.cumulative'), color: 'var(--c2)', dashed: true, right: true },
                  ]}
                />
              </Panel>
              <Panel title={t('common.ratingDistribution')} metric="ratings">
                <Distribution counts={d.ratingDistribution} />
              </Panel>
            </div>
            <div className="grid-3">
              <Panel className="span-2">
                <TimeChart
                  title={t('overview.activity')}
                  data={days}
                  kind="bar"
                  series={[
                    { key: 'receipts', label: t('metricNames.receiptsImported'), color: 'var(--c1)' },
                    { key: 'ratings', label: t('metricNames.ratings'), color: 'var(--c3)' },
                  ]}
                />
              </Panel>
              <Panel title={t('overview.recent')}>
                {d.activity.length ? (
                  <ol className="activity">
                    {d.activity.slice(0, 5).map((a, i) => (
                      <li key={i}>
                        <span className="activity-text">{a.text}</span>
                        <span className="activity-meta muted num">
                          {t(`activity.${a.type}`, { defaultValue: a.type })} · {fmtDateTime(a.at)}
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <Empty title={t('common.noData')} />
                )}
              </Panel>
            </div>
            <Panel title={t('overview.topRestaurants')} metric="observed">
              <DataTable
                caption={t('overview.topRestaurants')}
                data={d.topRestaurants}
                rowKey={(r) => r.key}
                href={(r) => `/restaurants/${encodeURIComponent(r.key)}`}
                cols={[
                  { id: 'name', header: t('nav.restaurants'), cell: (r) => <RestaurantCell name={r.name} logoBrand={r.logoBrand} /> },
                  { id: 'receipts', header: t('common.receipts'), num: true, cell: (r) => fmtNum(r.receipts) },
                  { id: 'ratings', header: t('common.ratings'), num: true, cell: (r) => fmtNum(r.ratings) },
                  { id: 'avg', header: t('common.avgRating'), num: true, cell: (r) => <RatingCell value={r.avgRating} /> },
                ]}
              />
            </Panel>
          </div>
        );
      }}
    </Boundary>
  );
}
