import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useData } from '../api/hooks';
import { dishDetailSchema } from '../api/schemas';
import { TimeChart } from '../components/charts';
import { Boundary } from '../components/data';
import { KpiMap, PageHead } from '../components/page';
import { ReviewFeed } from '../components/reviews';
import { Dimensions, Distribution, Panel } from '../components/ui';

export function Component() {
  const { t } = useTranslation();
  const { key = '' } = useParams();
  const q = useData(`/dishes/${encodeURIComponent(key)}`, dishDetailSchema, {}, { range: true });
  return (
    <Boundary q={q}>
      {(d) => (
        <div className="stack">
          <PageHead back={{ to: '/dishes', label: t('nav.dishes') }} title={d.dish.name} sub={[d.dish.restaurant, d.dish.branch].filter(Boolean).join(' · ')} />
          <KpiMap data={d.kpis} />
          <div className="grid-3">
            <Panel className="span-2">
              <TimeChart
                title={t('restaurants.trend')}
                data={d.trend}
                kind="area"
                series={[
                  { key: 'ratings', label: t('common.ratings'), color: 'var(--c1)' },
                  { key: 'avgRating', label: t('common.avgRating'), color: 'var(--c3)', dashed: true, right: true },
                ]}
              />
            </Panel>
            <Panel title={t('common.ratingDistribution')} metric="ratings">
              <Distribution counts={d.distribution} />
            </Panel>
          </div>
          <Panel title={t('restaurants.dimensions')} metric="dimensions">
            <Dimensions data={d.dimensions} />
          </Panel>
          <Panel title={t('nav.reviews')}>
            <ReviewFeed items={d.reviews} />
          </Panel>
        </div>
      )}
    </Boundary>
  );
}
