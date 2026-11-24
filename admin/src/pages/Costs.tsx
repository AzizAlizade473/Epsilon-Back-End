import { useTranslation } from 'react-i18next';
import { useData } from '../api/hooks';
import { costsSchema } from '../api/schemas';
import { TimeChart } from '../components/charts';
import { Boundary } from '../components/data';
import { Badge, Kpi, NotTracked, Panel } from '../components/ui';
import { fmtMoney, fmtNum } from '../lib/format';

export function Component() {
  const { t } = useTranslation();
  const q = useData('/costs', costsSchema, {}, { range: true });
  return (
    <Boundary q={q}>
      {(c) => (
        <div className="stack">
          <p className="muted">{t('costs.estimates')}</p>
          <div className="grid-4">
            <Kpi label={t('costs.geminiCalls')} metric="geminiCalls" value={fmtNum(c.gemini.calls)} />
            <Kpi label={t('costs.geminiEstimate')} metric="geminiEstimate" value={<>{fmtMoney(c.gemini.estimate.minor)} <Badge tone="warn">{t('costs.estimate')}</Badge></>} sub={c.gemini.estimate.basis} />
            <div className="kpi">
              <div className="kpi-label">{t('costs.email')}</div>
              <div className="kpi-value">{c.email === 'not_tracked' || c.email == null ? <NotTracked /> : '—'}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">{t('costs.push')}</div>
              <div className="kpi-value">{c.push === 'not_tracked' || c.push == null ? <NotTracked /> : '—'}</div>
            </div>
          </div>
          <Panel>
            <TimeChart title={t('costs.geminiByDay')} data={c.gemini.byDay} kind="bar" series={[{ key: 'calls', label: t('costs.geminiCalls'), color: 'var(--c1)' }]} />
          </Panel>
        </div>
      )}
    </Boundary>
  );
}
