import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../api/auth';
import { usePaged } from '../api/hooks';
import { auditSchema } from '../api/schemas';
import { Boundary, DataTable, Pager } from '../components/data';
import { TextField, Toolbar, useDebounced } from '../components/page';
import { StatusBadge } from '../components/tables';
import { Empty, Panel } from '../components/ui';
import { fmtDateTime } from '../lib/format';

export function Component() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const allowed = can('audit:read');
  const [admin, setAdmin] = useState('');
  const [action, setAction] = useState('');
  const p = usePaged('/audit', auditSchema, { admin: useDebounced(admin.trim()), action: useDebounced(action.trim()) }, { range: true, enabled: allowed });
  if (!allowed) return <Empty title={t('status.forbidden.title')} hint={t('status.forbidden.body')} />;
  return (
    <div className="stack">
      <Toolbar>
        <TextField label={t('audit.admin')} value={admin} onChange={setAdmin} />
        <TextField label={t('audit.action')} value={action} onChange={setAction} />
      </Toolbar>
      <Panel>
        <Boundary q={p.q}>
          {(d) => (
            <>
              <DataTable
                caption={t('nav.audit')}
                data={d.items}
                loading={p.q.isFetching}
                rowKey={(r) => r.id}
                cols={[
                  { id: 'time', header: t('common.date'), cell: (r) => fmtDateTime(r.createdAt) },
                  { id: 'admin', header: t('audit.admin'), cell: (r) => r.admin ?? '—' },
                  { id: 'action', header: t('audit.action'), cell: (r) => <span className="mono">{r.action}</span> },
                  { id: 'entity', header: t('audit.entity'), hideSm: true, cell: (r) => [r.entityType, r.entityId].filter(Boolean).join(' · ') || '—' },
                  { id: 'reason', header: t('common.reason'), hideSm: true, cell: (r) => r.reason ?? '—' },
                  { id: 'outcome', header: t('audit.outcome'), cell: (r) => <StatusBadge status={r.outcome} ns="outcome" /> },
                  { id: 'ip', header: 'IP', hideSm: true, cell: (r) => <span className="mono">{r.ip ?? '—'}</span> },
                ]}
              />
              <Pager page={p.page} hasPrev={p.hasPrev} hasNext={p.hasNext} onPrev={p.onPrev} onNext={p.onNext} />
            </>
          )}
        </Boundary>
      </Panel>
    </div>
  );
}
