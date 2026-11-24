import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePaged } from '../api/hooks';
import { restaurantsSchema } from '../api/schemas';
import { Boundary, DataTable, Pager } from '../components/data';
import { SearchField, SelectField, Toolbar, useDebounced } from '../components/page';
import { Panel, RestaurantCell, Stars } from '../components/ui';
import { fmtDateTime, fmtNum, fmtRating } from '../lib/format';

export function Component() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [partner, setPartner] = useState('');
  const q = useDebounced(text.trim());
  const p = usePaged('/restaurants', restaurantsSchema, { q, partner });
  return (
    <div className="stack">
      <p className="muted">{t('restaurants.intro')}</p>
      <Toolbar>
        <SearchField value={text} onChange={setText} label={t('restaurants.search')} />
        <SelectField
          label={t('restaurants.partnership')}
          value={partner}
          onChange={setPartner}
          options={[
            ['', t('common.all')],
            ['true', t('restaurants.partnersOnly')],
            ['false', t('restaurants.nonPartners')],
          ]}
        />
      </Toolbar>
      <Panel>
        <Boundary q={p.q}>
          {(d) => (
            <>
              <DataTable
                caption={t('nav.restaurants')}
                data={d.items}
                loading={p.q.isFetching}
                rowKey={(r) => r.key}
                href={(r) => `/restaurants/${encodeURIComponent(r.key)}`}
                cols={[
                  { id: 'name', header: t('nav.restaurants'), cell: (r) => <RestaurantCell name={r.name} branch={r.branch} partner={r.isPartner} /> },
                  { id: 'category', header: t('common.category'), hideSm: true, cell: (r) => r.category ?? '—' },
                  { id: 'receipts', header: t('common.receipts'), num: true, cell: (r) => fmtNum(r.receipts) },
                  { id: 'reviewers', header: t('restaurants.reviewers'), num: true, hideSm: true, cell: (r) => fmtNum(r.reviewers) },
                  { id: 'ratings', header: t('common.ratings'), num: true, cell: (r) => fmtNum(r.ratings) },
                  { id: 'avg', header: t('common.avgRating'), num: true, cell: (r) => <span className="stars-cell"><Stars value={r.avgRating} /> {fmtRating(r.avgRating)}</span> },
                  { id: 'last', header: t('restaurants.lastActivity'), hideSm: true, cell: (r) => fmtDateTime(r.lastActivityAt) },
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
