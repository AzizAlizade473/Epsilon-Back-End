import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client';
import { Dialog } from './ui';

/**
 * Confirmation dialog for audited actions. With `needReason` the confirm button stays disabled
 * until a reason of 3+ characters is typed (the server also requires it).
 */
export function ConfirmDialog({ open, onClose, title, body, confirmLabel, needReason, danger, onConfirm }: {
  open: boolean;
  onClose: () => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  needReason?: boolean;
  danger?: boolean;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = !needReason || reason.trim().length >= 3;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      setReason('');
      onClose();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? t('status.forbidden.title') : t('status.generic.title'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="dialog-content">
        <div className="muted">{body}</div>
        {needReason && (
          <label className="field">
            <span>{t('common.reason')}</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} required aria-required="true" />
          </label>
        )}
        {error && (
          <p role="alert" className="neg">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className={danger ? 'btn btn-danger' : 'btn btn-primary'} disabled={!valid || busy} onClick={() => void submit()}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
