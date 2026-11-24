import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePaged } from '../api/hooks';
import { dishesSchema } from '../api/schemas';
import { Boundary, Pager } from '../components/data';
import { InfoTip, Panel } from '../components/ui';
import { SearchField, SelectField, Toolbar, useDebounced } from '../components/page';
import { DishesTable } from '../components/tables';
import { DISH_SORTS } from '../lib/filters';

export function Component() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [sort, setSort] = useState<string>('avgRating');
  const [min, setMin] = useState('1');
  const q = useDebounced(text.trim());
  // The sample size is always shown in the table; raise the minimum for a fairer ranking.
  const minRatings = Math.max(1, Math.floor(Number(min) || 1));
  const p = usePaged('/dishes', dishesSchema, { q, sort, minRatings });
  return (
    <div className="stack">
      <Toolbar>
        <SearchField value={text} onChange={setText} label={t('dishes.search')} />
        <SelectField
          label={t('dishes.sort')}
          value={sort}
          onChange={setSort}
          options={DISH_SORTS.map((s): [string, string] => [s, t(`dishes.sorts.${s}`)])}
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
