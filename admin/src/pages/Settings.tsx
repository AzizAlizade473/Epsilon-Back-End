import { useTranslation } from 'react-i18next';
import { LogOut } from 'lucide-react';
import { useAuth } from '../api/auth';
import { LANGS, setLanguage } from '../i18n';
import { useTheme, type ThemePref } from '../lib/theme';
import { Panel } from '../components/ui';

export function Component() {
  const { t, i18n } = useTranslation();
  const { admin, signOut } = useAuth();
  const theme = useTheme();
  return (
    <div className="stack narrow-page">
      <Panel title={t('settings.appearance')}>
        <fieldset className="choice">
          <legend>{t('settings.theme')}</legend>
          {(['system', 'light', 'dark'] as ThemePref[]).map((p) => (
            <label key={p}>
              <input type="radio" name="theme" checked={theme.pref === p} onChange={() => theme.set(p)} /> {t(`settings.${p}`)}
            </label>
          ))}
        </fieldset>
        <fieldset className="choice">
          <legend>{t('settings.language')}</legend>
          {LANGS.map((l) => (
            <label key={l}>
              <input type="radio" name="lang" checked={i18n.language === l} onChange={() => void setLanguage(l)} /> {t(`settings.lang.${l}`)}
            </label>
          ))}
        </fieldset>
      </Panel>
      <Panel title={t('settings.session')}>
        <dl className="kv">
          <dt>{t('settings.name')}</dt>
          <dd>{admin.name ?? '—'}</dd>
          <dt>{t('settings.email')}</dt>
          <dd>{admin.email}</dd>
          <dt>{t('settings.role')}</dt>
          <dd>{t(`role.${admin.role}`, { defaultValue: admin.role })}</dd>
          <dt>{t('settings.permissions')}</dt>
          <dd className="mono">{admin.permissions.join(', ') || '—'}</dd>
        </dl>
        <p className="muted">{t('settings.sessionNote')}</p>
        <button type="button" className="btn" onClick={() => void signOut()}>
          <LogOut size={16} aria-hidden="true" /> {t('menu.signOut')}
        </button>
      </Panel>
    </div>
  );
}
