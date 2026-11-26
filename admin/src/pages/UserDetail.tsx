import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../api/auth';
import { useData } from '../api/hooks';
import { revealSchema, userDetailSchema } from '../api/schemas';
import { Boundary } from '../components/data';
import { ConfirmDialog } from '../components/dialogs';
import { PageHead } from '../components/page';
import { ReviewFeed } from '../components/reviews';
import { LedgerTable, NotificationsTable, ReceiptsTable, StatusBadge } from '../components/tables';
import { Empty, Kpi, Panel } from '../components/ui';
import { LIKE_KINDS } from '../lib/filters';
import { fmtDateTime, fmtMoney, fmtNum } from '../lib/format';

type Revealed = { email?: string | null; phone?: string | null };

/** Shows the unmasked contact once; it lives only in component state and clears itself. */
export function RevealContact({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<Revealed | null>(null);
  useEffect(() => {
    if (!value) return;
    const id = setTimeout(() => setValue(null), 30_000);
    return () => clearTimeout(id);
  }, [value]);
  if (!can('pii:reveal')) return null;
  return (
    <>
      {value ? (
        <div className="revealed" role="status">
          <span className="mono">{value.email ?? '—'}</span>
          <span className="mono">{value.phone ?? '—'}</span>
          <button type="button" className="btn btn-quiet" onClick={() => setValue(null)}>
            <EyeOff size={16} aria-hidden="true" /> {t('users.hideContact')}
          </button>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          <Eye size={16} aria-hidden="true" /> {t('users.reveal')}
        </button>
      )}
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('users.revealTitle')}
        body={t('users.revealBody')}
        confirmLabel={t('users.reveal')}
        needReason
        onConfirm={async (reason) => setValue(await api('POST', `/users/${encodeURIComponent(userId)}/reveal`, revealSchema, { body: { reason } }))}
      />
    </>
  );
}

export function Component() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const q = useData(`/users/${encodeURIComponent(id)}`, userDetailSchema);
  return (
    <Boundary q={q}>
      {(d) => {
        const u = d.user;
        return (
          <div className="stack">
            <PageHead
              back={{ to: '/users', label: t('nav.users') }}
              title={u.name ?? t('users.unnamed')}
              sub={
                <span className="head-meta">
                  {(u.emailMasked || u.phoneMasked) && <span className="mono">{[u.emailMasked, u.phoneMasked].filter(Boolean).join(' · ')}</span>}
                  <span>
                    {t('users.joined')} {fmtDateTime(u.createdAt)} · {t('users.lastActive')} {fmtDateTime(u.lastActiveAt)}
                  </span>
                </span>
              }
              actions={<RevealContact userId={u.id} />}
            />
            <div className="kpis">
              <Kpi label={t('common.status')} value={<StatusBadge status={u.status} ns="userStatus" />} />
              <Kpi label={t('common.receipts')} value={fmtNum(u.receipts)} />
              <Kpi label={t('common.ratings')} value={fmtNum(u.ratings)} />
              <Kpi label={t('nav.cashback')} value={fmtMoney(u.cashbackMinor)} />
            </div>
            <Panel title={t('nav.likes')}>
              <dl className="kv">
                {LIKE_KINDS.map((k) => (
                  <div key={k}>
                    <dt>{t(`likes.kind.${k}`)}</dt>
                    <dd className="num">{fmtNum(d.likes[k])}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
            <Panel title={t('nav.receipts')}>
              <ReceiptsTable items={d.receipts} />
            </Panel>
            <Panel title={t('nav.reviews')}>
              <ReviewFeed items={d.reviews} />
            </Panel>
            <Panel title={t('cashback.ledger')}>
              {d.ledger.length ? <LedgerTable items={d.ledger} /> : <Empty title={t('common.noData')} />}
            </Panel>
            <Panel title={t('users.preferences')}>
              {d.preferences && Object.keys(d.preferences).length ? (
                <dl className="kv">
                  {Object.entries(d.preferences).map(([k, v]) => (
                    <div key={k}>
                      <dt>{t(`users.pref.${k}`, { defaultValue: k })}</dt>
                      <dd>{typeof v === 'boolean' ? (v ? t('common.on') : t('common.off')) : String(v ?? '—')}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <Empty title={t('common.noData')} />
              )}
            </Panel>
            <Panel title={t('nav.notifications')}>
              {d.notifications.length ? <NotificationsTable items={d.notifications} /> : <Empty title={t('common.noData')} />}
            </Panel>
          </div>
        );
      }}
    </Boundary>
  );
}
