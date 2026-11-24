import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePaged } from '../api/hooks';
import { dishesSchema } from '../api/schemas';
import { Boundary, Pager } from '../components/data';
import { InfoTip, Panel } from '../components/ui';
import { SearchField, SelectField, Toolbar, useDebounced } from '../components/page';
import { DishesTable } from '../components/tables';

export function Component() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [sort, setSort] = useState('best');
  const [min, setMin] = useState('3');
  const q = useDebounced(text.trim());
  // Rankings need a minimum sample (default 3); the sample size is always shown in the table.
  const minRatings = Math.max(1, Math.floor(Number(min) || 3));
  const p = usePaged('/dishes', dishesSchema, { q, sort, minRatings });
  return (
    <div className="stack">
      <Toolbar>
        <SearchField value={text} onChange={setText} label={t('dishes.search')} />
        <SelectField
          label={t('dishes.sort')}
          value={sort}
          onChange={setSort}
          options={[
            ['best', t('dishes.sortBest')],
            ['worst', t('dishes.sortWorst')],
            ['reviewed', t('dishes.sortReviewed')],
            ['observed', t('dishes.sortObserved')],
          ]}
        />
        <label className="field">
          <span className="field-label">
            {t('dishes.minRatings')}
            <InfoTip metric="minSample" />
          </span>
          <input type="number" min={1} max={1000} value={min} onChange={(e) => setMin(e.target.value)} className="narrow" />
        </label>
      </Toolbar>
      <Panel>
        <Boundary q={p.q}>
          {(d) => (
            <>
              <DishesTable items={d.items} loading={p.q.isFetching} />
              <Pager page={p.page} hasPrev={p.hasPrev} hasNext={p.hasNext} onPrev={p.onPrev} onNext={p.onNext} />
            </>
          )}
        </Boundary>
      </Panel>
    </div>
  );
}
