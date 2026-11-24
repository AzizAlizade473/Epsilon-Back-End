import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useData } from '../api/hooks';
import { restaurantDetailSchema } from '../api/schemas';
import { TimeChart } from '../components/charts';
import { Boundary } from '../components/data';
import { KpiMap, PageHead } from '../components/page';
import { ReviewFeed } from '../components/reviews';
import { DishesTable } from '../components/tables';
import { Badge, Dimensions, Distribution, Empty, Panel, RestaurantCell } from '../components/ui';

export function Component() {
  const { t } = useTranslation();
  const { key = '' } = useParams();
  const q = useData(`/restaurants/${encodeURIComponent(key)}`, restaurantDetailSchema, {}, { range: true });
  return (
    <Boundary q={q}>
      {(d) => {
        const r = d.restaurant;
        return (
          <div className="stack">
            <PageHead
              back={{ to: '/restaurants', label: t('nav.restaurants') }}
              lead={<RestaurantCell name={r.name} branch={r.branch} partner={r.isPartner} logoBrand={null} />}
              sub={
                <>
                  {[r.category, r.chain].filter(Boolean).join(' · ')} {!r.isPartner && <Badge>{t('restaurants.nonPartner')}</Badge>}
                  <br />
                  {t('restaurants.observed')}
                </>
              }
            />
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
            <Panel title={t('restaurants.dishes')}>
              <DishesTable items={d.dishes} showRestaurant={false} />
            </Panel>
            <div className="grid-2">
              <Panel title={t('restaurants.best')} metric="minSample">
                {d.best.length ? <DishesTable items={d.best} showRestaurant={false} /> : <Empty title={t('common.noData')} />}
              </Panel>
              <Panel title={t('restaurants.attention')} metric="minSample">
                {d.needsAttention.length ? <DishesTable items={d.needsAttention} showRestaurant={false} /> : <Empty title={t('restaurants.noAttention')} />}
              </Panel>
            </div>
            <Panel title={t('restaurants.dimensions')} metric="dimensions">
              <Dimensions data={d.dimensions} />
            </Panel>
            <Panel title={t('nav.reviews')}>
              <ReviewFeed items={d.reviews} />
            </Panel>
          </div>
        );
      }}
    </Boundary>
  );
}
