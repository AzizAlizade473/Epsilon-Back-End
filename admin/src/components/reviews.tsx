import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { EyeOff, Eye } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../api/auth';
import { useData } from '../api/hooks';
import { isHidden, reviewDetailSchema, type Review } from '../api/schemas';
import { fmtDateTime } from '../lib/format';
import { useRangeLink } from '../lib/range';
import { Boundary } from './data';
import { ConfirmDialog } from './dialogs';
import { Badge, Dialog, Empty, Skeleton, Stars } from './ui';

export function QuickComments({ items }: { items?: string[] | null }) {
  const { t } = useTranslation();
  if (!items?.length) return null;
  return (
    <ul className="chips">
      {items.map((c) => (
        <li key={c} className="chip">
          {t(`quick.${c}`, { defaultValue: c })}
        </li>
      ))}
    </ul>
  );
}

export function ReviewCard({ review: r }: { review: Review }) {
  const { t } = useTranslation();
  const link = useRangeLink();
  return (
    <article className="review">
      <header>
        <Stars value={r.rating} />
        <span className="review-meta">
          {[r.restaurant, r.dish].filter(Boolean).join(' · ')}
        </span>
        <time className="muted num" dateTime={r.createdAt}>
          {fmtDateTime(r.createdAt)}
        </time>
      </header>
      <QuickComments items={r.quickComments} />
      {r.comment && <p className="review-text">{r.comment}</p>}
      <footer>
        <span className="muted">{r.reviewer ?? t('users.unnamed')}</span>
        {r.edited && <Badge>{t('reviews.edited')}</Badge>}
        {isHidden(r.moderation) && <Badge tone="warn">{t('reviews.hidden')}</Badge>}
        <Link to={link(`/reviews?review=${encodeURIComponent(r.id)}`)} className="link">
          {t('common.details')}
        </Link>
      </footer>
    </article>
  );
}

export function ReviewFeed({ items }: { items: Review[] }) {
  const { t } = useTranslation();
  if (!items.length) return <Empty title={t('reviews.none')} />;
  return (
    <div className="feed">
      {items.map((r) => (
        <ReviewCard key={r.id} review={r} />
      ))}
    </div>
  );
}

type Reply = NonNullable<z.infer<typeof reviewDetailSchema>['reply']>;

/** The restaurant's reply and the author's reports. Hiding follows the review moderation rules. */
function ReplyPanel({ id, reply }: { id: string; reply: Reply }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const hidden = reply.status === 'hidden';
  const moderate = useMutation({
    mutationFn: (reason: string) => api('POST', `/reviews/${id}/reply/moderate`, z.unknown(), { body: { hidden: !hidden, reason } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api'] }),
  });
  return (
    <section className="review" aria-label={t('reply.title')}>
      <header>
        <strong>{t('reply.title')}</strong>
        <span className="review-meta">{reply.restaurant}</span>
        <time className="muted num" dateTime={reply.updatedAt}>
          {fmtDateTime(reply.updatedAt)}
        </time>
      </header>
      <p className="review-text">{reply.body}</p>
      {reply.reports.length > 0 && (
        <>
          <p className="muted">{t('reply.reportCount', { count: reply.reports.length })}</p>
          <ul>
            {reply.reports.map((x) => (
              <li key={x.createdAt}>
                {x.reason} <span className="muted num">{fmtDateTime(x.createdAt)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <footer>
        <Badge tone={hidden ? 'warn' : 'muted'}>{t(`reply.status.${reply.status}`)}</Badge>
      </footer>
      {can('reviews:moderate') && reply.status !== 'deleted' && (
        <>
          <button type="button" className={hidden ? 'btn' : 'btn btn-danger'} onClick={() => setConfirm(true)}>
            {hidden ? <Eye size={16} aria-hidden="true" /> : <EyeOff size={16} aria-hidden="true" />}
            {hidden ? t('reply.unhide') : t('reply.hide')}
          </button>
          <ConfirmDialog
            open={confirm}
            onClose={() => setConfirm(false)}
            title={hidden ? t('reply.unhideTitle') : t('reply.hideTitle')}
            body={t('reply.moderateBody')}
            confirmLabel={hidden ? t('reply.unhide') : t('reply.hide')}
            needReason
            danger={!hidden}
            onConfirm={async (reason) => {
              await moderate.mutateAsync(reason);
            }}
          />
        </>
      )}
    </section>
  );
}

/** Review detail drawer. Moderation is permission-gated, needs a reason, and never edits text. */
export function ReviewDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const q = useData(`/reviews/${id ?? ''}`, reviewDetailSchema, {}, { enabled: !!id });
  const moderate = useMutation({
    mutationFn: ({ hidden, reason }: { hidden: boolean; reason: string }) => api('POST', `/reviews/${id}/moderate`, z.unknown(), { body: { hidden, reason } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api'] }),
  });
  return (
    <Dialog open={!!id} onClose={onClose} title={t('reviews.detail')} side>
      <div className="dialog-content">
        <Boundary q={q} skeleton={<Skeleton h={160} />}>
          {(r) => {
            const hidden = isHidden(r.moderation);
            return (
              <>
                <ReviewCard review={r} />
                <dl className="kv">
                  <dt>{t('common.updated')}</dt>
                  <dd>{fmtDateTime(r.updatedAt)}</dd>
                  {r.receipt?.id && (
                    <>
                      <dt>{t('nav.receipts')}</dt>
                      <dd>
                        <Link className="link" to={`/receipts/${encodeURIComponent(String(r.receipt.id))}`}>
                          {String(r.receipt.id)}
                        </Link>
                      </dd>
                    </>
                  )}
                </dl>
                {r.reply && <ReplyPanel id={r.id} reply={r.reply} />}
                {can('reviews:moderate') && (
                  <>
                    <button type="button" className={hidden ? 'btn' : 'btn btn-danger'} onClick={() => setConfirm(true)}>
                      {hidden ? <Eye size={16} aria-hidden="true" /> : <EyeOff size={16} aria-hidden="true" />}
                      {hidden ? t('reviews.unhide') : t('reviews.hide')}
                    </button>
                    <ConfirmDialog
                      open={confirm}
                      onClose={() => setConfirm(false)}
                      title={hidden ? t('reviews.unhideTitle') : t('reviews.hideTitle')}
                      body={t('reviews.moderateBody')}
                      confirmLabel={hidden ? t('reviews.unhide') : t('reviews.hide')}
                      needReason
                      danger={!hidden}
                      onConfirm={async (reason) => {
                        await moderate.mutateAsync({ hidden: !hidden, reason });
                      }}
                    />
                  </>
                )}
              </>
            );
          }}
        </Boundary>
      </div>
    </Dialog>
  );
}
