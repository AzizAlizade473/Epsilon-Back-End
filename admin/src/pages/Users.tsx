import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePaged } from '../api/hooks';
import { usersSchema, type UserRow } from '../api/schemas';
import { Boundary, DataTable, Pager } from '../components/data';
import { SearchField, Toolbar, useDebounced } from '../components/page';
import { StatusBadge } from '../components/tables';
import { Badge, Panel } from '../components/ui';
import { fmtDateTime, fmtMoney, fmtNum } from '../lib/format';

/** Contact is masked by the server (+994 55 ••• •• 55, a•••@gmail.com) and rendered verbatim. */
export function UsersTable({ items, loading }: { items: UserRow[]; loading?: boolean }) {
  const { t } = useTranslation();
  return (
    <DataTable
      caption={t('nav.users')}
      data={items}
      loading={loading}
      rowKey={(u) => u.id}
      href={(u) => `/users/${encodeURIComponent(u.id)}`}
      cols={[
        { id: 'user', header: t('users.user'), cell: (u) => <span className="strong">{u.name ?? t('users.unnamed')}</span> },
        { id: 'contact', header: t('users.contact'), cell: (u) => <span className="mono stack-sm"><span>{u.emailMasked ?? '—'}</span><span>{u.phoneMasked ?? '—'}</span></span> },
        { id: 'joined', header: t('users.joined'), hideSm: true, cell: (u) => fmtDateTime(u.createdAt) },
        { id: 'last', header: t('users.lastActive'), hideSm: true, cell: (u) => fmtDateTime(u.lastActiveAt) },
        { id: 'receipts', header: t('common.receipts'), num: true, cell: (u) => fmtNum(u.receipts) },
        { id: 'ratings', header: t('common.ratings'), num: true, cell: (u) => fmtNum(u.ratings) },
        { id: 'cashback', header: t('nav.cashback'), num: true, hideSm: true, cell: (u) => fmtMoney(u.cashbackMinor) },
        {
          id: 'notif',
          header: t('users.notifications'),
          hideSm: true,
          cell: (u) => (
            <span className="chips-inline">
              {u.notifications?.reminders ? <Badge>{t('users.reminders')}</Badge> : null}
              {u.notifications?.cashbackUpdates ? <Badge>{t('users.cashbackUpdates')}</Badge> : null}
              {u.notifications?.partnerUpdates ? <Badge>{t('users.partnerUpdates')}</Badge> : null}
              <span className="muted num">{t('users.devices', { n: u.notifications?.pushDevices ?? 0 })}</span>
            </span>
          ),
        },
        { id: 'status', header: t('common.status'), cell: (u) => <StatusBadge status={u.status} ns="userStatus" /> },
      ]}
    />
  );
}

export function Component() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const q = useDebounced(text.trim());
  const p = usePaged('/users', usersSchema, { q }, { range: true });
  return (
    <div className="stack">
      <Toolbar>
        <SearchField value={text} onChange={setText} label={t('users.search')} />
      </Toolbar>
      <Panel>
        <Boundary q={p.q}>
          {(d) => (
            <>
              <UsersTable items={d.items} loading={p.q.isFetching} />
              <Pager page={p.page} hasPrev={p.hasPrev} hasNext={p.hasNext} onPrev={p.onPrev} onNext={p.onNext} />
            </>
          )}
        </Boundary>
      </Panel>
    </div>
  );
}
