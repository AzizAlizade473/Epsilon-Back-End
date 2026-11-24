import { useTranslation } from 'react-i18next';
import { useData } from '../api/hooks';
import { healthSchema } from '../api/schemas';
import { Boundary } from '../components/data';
import { Badge, Kpi } from '../components/ui';
import { fmtDateTime, fmtDuration, fmtNum } from '../lib/format';

export function Component() {
  const { t } = useTranslation();
  const q = useData('/health', healthSchema, {}, { live: true });
  return (
    <Boundary q={q}>
      {(h) => (
        <div className="kpis">
          <Kpi label={t('health.api')} value={<Badge tone="good">{t('health.up')}</Badge>} sub={`v${h.api.version} · ${t('health.uptime')} ${fmtDuration(h.api.uptimeS)}`} />
          <Kpi label={t('health.db')} value={<Badge tone={h.db.ok ? 'good' : 'bad'}>{h.db.ok ? t('health.ok') : t('health.down')}</Badge>} sub={h.db.latencyMs == null ? undefined : `${fmtNum(h.db.latencyMs)} ms`} />
          <Kpi label={t('health.mealReminders')} value={fmtDateTime(h.jobs.mealReminders.lastRunAt)} sub={t('health.lastRun')} />
        </div>
      )}
    </Boundary>
  );
}
