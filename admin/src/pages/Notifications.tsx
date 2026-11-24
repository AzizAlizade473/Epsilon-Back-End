import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useData, usePaged } from '../api/hooks';
import { notificationStatsSchema, notificationsSchema } from '../api/schemas';
import { Boundary, DataTable, Pager } from '../components/data';
import { SelectField, Toolbar } from '../components/page';
import { NotificationsTable } from '../components/tables';
import { Kpi, NotTracked, Panel } from '../components/ui';
import { fmtNum, fmtRate } from '../lib/format';
import { NOTIFICATION_KINDS } from '../lib/filters';


export function Component() {
  const { t } = useTranslation();
  const [kind, setKind] = useState('');
  const stats = useData('/notifications/stats', notificationStatsSchema, {}, { range: true });
  const history = usePaged('/notifications', notificationsSchema, { kind }, { range: true });
  return (
    <div className="stack">
      <Boundary q={stats}>
        {(s) => (
          <>
            <div className="kpis">
              <Kpi label={t('notifications.sent')} metric="notifSent" value={fmtNum(s.sent)} />
              <Kpi label={t('notifications.readCount')} metric="notifRead" value={fmtNum(s.read)} sub={s.sent ? `${((s.read / s.sent) * 100).toFixed(1)}%` : undefined} />
              <Kpi label={t('notifications.devices')} metric="pushDevices" value={fmtNum(s.devices.tokens)} sub={t('notifications.deviceUsers', { count: s.devices.users ?? 0 })} />
              <div className="kpi">
                <div className="kpi-label">{t('notifications.delivery')}</div>
                <div className="kpi-value">{s.delivery === 'not_tracked' || s.delivery == null ? <NotTracked /> : '—'}</div>
              </div>
            </div>
            <div className="grid-2">
              <Panel title={t('notifications.optIns')} metric="optIn">
                <dl className="kv">
                  <dt>{t('users.reminders')}</dt>
                  <dd className="num">{fmtRate(s.optIn.reminders)}</dd>
                  <dt>{t('users.cashbackUpdates')}</dt>
                  <dd className="num">{fmtRate(s.optIn.cashbackUpdates)}</dd>
                  <dt>{t('users.partnerUpdates')}</dt>
                  <dd className="num">{fmtRate(s.optIn.partnerUpdates)}</dd>
                </dl>
              </Panel>
              <Panel title={t('notifications.byKind')}>
                <DataTable
                  caption={t('notifications.byKind')}
                  data={s.byKind}
                  rowKey={(r) => r.kind}
                  cols={[
                    { id: 'kind', header: t('common.type'), cell: (r) => t(`kind.${r.kind}`, { defaultValue: r.kind }) },
                    { id: 'sent', header: t('notifications.sent'), num: true, cell: (r) => fmtNum(r.sent) },
                    { id: 'read', header: t('notifications.readCount'), num: true, cell: (r) => fmtNum(r.read) },
                  ]}
                />
              </Panel>
            </div>
          </>
        )}
      </Boundary>
      <Toolbar>
        <SelectField label={t('common.type')} value={kind} onChange={setKind} options={[['', t('common.all')], ...NOTIFICATION_KINDS.map((k): [string, string] => [k, t(`kind.${k}`)])]} />
      </Toolbar>
      <Panel title={t('notifications.history')}>
        <Boundary q={history.q}>
          {(d) => (
            <>
              <NotificationsTable items={d.items} />
              <Pager page={history.page} hasPrev={history.hasPrev} hasNext={history.hasNext} onPrev={history.onPrev} onNext={history.onNext} />
            </>
          )}
        </Boundary>
      </Panel>
    </div>
  );
}
