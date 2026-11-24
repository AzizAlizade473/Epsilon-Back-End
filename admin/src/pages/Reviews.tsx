import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { usePaged } from '../api/hooks';
import { isHidden, reviewsSchema } from '../api/schemas';
import { Boundary, DataTable, Pager } from '../components/data';
import { SelectField, Toolbar } from '../components/page';
import { QuickComments, ReviewDrawer } from '../components/reviews';
import { Badge, Panel, Stars } from '../components/ui';
import { fmtDateTime } from '../lib/format';

const DIMENSIONS = ['food', 'service', 'speed', 'price', 'ambience'];
const yn = (t: (k: string) => string): [string, string][] => [['', t('common.any')], ['true', t('common.yes')], ['false', t('common.no')]];

export function Component() {
  const { t } = useTranslation();
  const [sp, setSp] = useSearchParams();
  const [f, setF] = useState({ stars: '', hasComment: '', edited: '', moderated: '', dimension: '', sentiment: '' });
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const p = usePaged('/reviews', reviewsSchema, f, { range: true });
  const open = sp.get('review');
  const select = (id: string | null) =>
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set('review', id);
      else next.delete('review');
      return next;
    });
  return (
    <div className="stack">
      <Toolbar>
        <SelectField label={t('reviews.stars')} value={f.stars} onChange={set('stars')} options={[['', t('common.any')], ...[5, 4, 3, 2, 1].map((n): [string, string] => [String(n), `${n}★`])]} />
        <SelectField label={t('reviews.hasComment')} value={f.hasComment} onChange={set('hasComment')} options={yn(t)} />
        <SelectField label={t('reviews.edited')} value={f.edited} onChange={set('edited')} options={yn(t)} />
        <SelectField label={t('reviews.moderated')} value={f.moderated} onChange={set('moderated')} options={yn(t)} />
        <SelectField label={t('reviews.dimension')} value={f.dimension} onChange={set('dimension')} options={[['', t('common.any')], ...DIMENSIONS.map((d): [string, string] => [d, t(`dimension.${d}`)])]} />
        <SelectField label={t('reviews.sentiment')} value={f.sentiment} onChange={set('sentiment')} options={[['', t('common.any')], ['positive', t('common.positive')], ['neutral', t('common.neutral')], ['negative', t('common.negative')]]} />
      </Toolbar>
      <Panel>
        <Boundary q={p.q}>
          {(d) => (
            <>
              <DataTable
                caption={t('nav.reviews')}
                data={d.items}
                loading={p.q.isFetching}
                rowKey={(r) => r.id}
                href={(r) => {
                  const next = new URLSearchParams(sp);
                  next.set('review', r.id);
                  return `?${next.toString()}`;
                }}
                cols={[
                  { id: 'stars', header: t('reviews.stars'), cell: (r) => <Stars value={r.rating} /> },
                  { id: 'restaurant', header: t('nav.restaurants'), cell: (r) => r.restaurant ?? '—' },
                  { id: 'dish', header: t('dishes.dish'), hideSm: true, cell: (r) => r.dish ?? '—' },
                  {
                    id: 'comment',
                    header: t('reviews.comment'),
                    cell: (r) => (
                      <span className="comment-cell">
                        <QuickComments items={r.quickComments} />
                        {r.comment && <span className="clamp">{r.comment}</span>}
                      </span>
                    ),
                  },
                  {
                    id: 'flags',
                    header: t('common.status'),
                    hideSm: true,
                    cell: (r) => (
                      <span className="chips-inline">
                        {r.edited && <Badge>{t('reviews.edited')}</Badge>}
                        {isHidden(r.moderation) && <Badge tone="warn">{t('reviews.hidden')}</Badge>}
                      </span>
                    ),
                  },
                  { id: 'date', header: t('common.date'), cell: (r) => fmtDateTime(r.createdAt) },
                ]}
              />
              <Pager page={p.page} hasPrev={p.hasPrev} hasNext={p.hasNext} onPrev={p.onPrev} onNext={p.onNext} />
            </>
          )}
        </Boundary>
      </Panel>
      <ReviewDrawer id={open} onClose={() => select(null)} />
    </div>
  );
}
