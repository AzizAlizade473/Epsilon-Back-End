import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import { exportCsv } from '../api/client';
import { useAuth } from '../api/auth';
import { ConfirmDialog } from '../components/dialogs';
import { Empty, Panel } from '../components/ui';
import { useRange } from '../lib/range';

export const REPORTS = ['users', 'restaurants', 'dishes', 'reviews', 'receipts', 'cashback', 'notifications'];

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function Component() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { from, to } = useRange();
  const [pending, setPending] = useState<string | null>(null);
  if (!can('export')) return <Empty title={t('status.forbidden.title')} hint={t('status.forbidden.body')} />;
  return (
    <div className="stack">
      <p className="muted">{t('reports.note')}</p>
      <Panel>
        <ul className="reports">
          {REPORTS.map((r) => (
            <li key={r}>
              <div>
                <p className="strong">{t(`reports.names.${r}`)}</p>
                <p className="muted">{t(`reports.desc.${r}`)}</p>
              </div>
              <button type="button" className="btn" onClick={() => setPending(r)}>
                <Download size={16} aria-hidden="true" /> {t('reports.exportCsv')}
              </button>
            </li>
          ))}
        </ul>
      </Panel>
      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        title={t('reports.confirmTitle')}
        body={t('reports.confirmBody', { report: pending ? t(`reports.names.${pending}`) : '', range: [from ?? '…', to ?? '…'].join(' → ') })}
        confirmLabel={t('reports.exportCsv')}
        onConfirm={async () => {
          if (pending) download(`epsilon-${pending}.csv`, await exportCsv(pending, { from, to }));
        }}
      />
    </div>
  );
}
