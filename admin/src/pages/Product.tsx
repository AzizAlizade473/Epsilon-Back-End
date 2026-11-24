import { useTranslation } from 'react-i18next';
import { useData } from '../api/hooks';
import { overviewSchema, userAnalyticsSchema } from '../api/schemas';
import { TimeChart } from '../components/charts';
import { Boundary, DataTable } from '../components/data';
import { NotTrackedPanel } from '../components/page';
import { Kpi, Panel } from '../components/ui';
import { fmtMetric, fmtNum } from '../lib/format';

export function Component() {
  const { t } = useTranslation();
  const ov = useData('/overview', overviewSchema, {}, { range: true });
  const ua = useData('/users/analytics', userAnalyticsSchema, {}, { range: true });
  return (
    <div className="stack">
      <Boundary q={ua}>
        {(a) => {
          const nt = (k: string) => a.tracking?.[k] === 'not_tracked';
          const tile = (k: 'returningUserPct' | 'avgReceiptsPerUser' | 'avgRatingsPerUser' | 'neverScanned' | 'scannedNeverRated' | 'ratedNonPartner' | 'notificationOptInRate') => (
            <Kpi label={t(`metricNames.${k}`)} metric={k} value={fmtMetric(k, a[k])} notTracked={nt(k)} />
          );
          // Series arrive as { date, count } (or value); the chart reads a single `count` key.
          const norm = (s: typeof a.registrations) => s.map((x) => ({ date: x.date, count: x.count ?? x.value ?? 0 }));
          return (
            <>
              <div className="grid-4">
                {tile('returningUserPct')}
                {tile('avgReceiptsPerUser')}
                {tile('avgRatingsPerUser')}
                {tile('notificationOptInRate')}
                {tile('neverScanned')}
                {tile('scannedNeverRated')}
                {tile('ratedNonPartner')}
                <Boundary q={ov} skeleton={<Kpi label={t('metricNames.activeUser')} value="…" />}>
                  {(o) => <Kpi label={t('overview.activeUsers')} metric="activeUser" value={`${fmtNum(o.kpis.dau)} / ${fmtNum(o.kpis.wau)} / ${fmtNum(o.kpis.mau)}`} />}
                </Boundary>
              </div>
              <div className="grid-2">
                <Panel>
                  <TimeChart title={t('product.registrations')} data={norm(a.registrations)} kind="bar" series={[{ key: 'count', label: t('product.registrations'), color: 'var(--c1)' }]} />
                </Panel>
                <Panel>
                  <TimeChart title={t('product.active')} data={norm(a.active)} kind="area" series={[{ key: 'count', label: t('product.active'), color: 'var(--c3)' }]} />
                </Panel>
              </div>
              <Panel title={t('product.cohorts')}>
                {Array.isArray(a.cohorts) && a.cohorts.length ? (
                  <DataTable
                    caption={t('product.cohorts')}
                    data={a.cohorts as Record<string, unknown>[]}
                    rowKey={(r) => JSON.stringify(r)}
                    cols={Object.keys(a.cohorts[0]!).map((k) => ({
                      id: k,
                      header: k,
                      num: typeof (a.cohorts as Record<string, unknown>[])[0]![k] === 'number',
                      cell: (r: Record<string, unknown>) => String(r[k] ?? '—'),
                    }))}
                  />
                ) : (
                  <NotTrackedPanel />
                )}
              </Panel>
              <div className="grid-2">
                <Panel title={t('product.funnels')}>
                  <NotTrackedPanel message={t('product.eventsNotStarted')} />
                </Panel>
                <Panel title={t('product.retention')}>
                  <NotTrackedPanel message={t('product.eventsNotStarted')} />
                </Panel>
              </div>
            </>
          );
        }}
      </Boundary>
    </div>
  );
}
