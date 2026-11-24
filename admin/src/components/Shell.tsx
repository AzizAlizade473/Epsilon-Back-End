import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, Sun } from 'lucide-react';
import { useAuth } from '../api/auth';
import { useData, useLastUpdated } from '../api/hooks';
import { searchSchema, type SearchHit } from '../api/schemas';
import { PRESETS, useRange, useRangeLink } from '../lib/range';
import { useTheme } from '../lib/theme';
import markWhite from '../assets/mark-white.png';
import mark from '../assets/mark.png';
import wordmark from '../assets/wordmark.png';
import wordmarkWhite from '../assets/wordmark-white.png';
import { NAV } from './nav';

const mq = (q: string) => (cb: () => void) => {
  const m = window.matchMedia(q);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
};
const useMedia = (q: string) => useSyncExternalStore(mq(q), () => window.matchMedia(q).matches);

function Sidebar({ collapsed, onToggle, mobile, open, onClose }: { collapsed: boolean; onToggle: () => void; mobile: boolean; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { resolved } = useTheme();
  const link = useRangeLink();
  const slim = collapsed && !mobile;
  return (
    <aside className="sidebar" id="sidebar" aria-label={t('nav.label')} inert={mobile && !open} data-open={open}>
      <div className="brand">
        <Link to="/" aria-label={t('nav.overview')} onClick={onClose}>
          {slim ? <img src={resolved === 'dark' ? markWhite : mark} alt="Epsilon" className="brand-mark" /> : <img src={resolved === 'dark' ? wordmarkWhite : wordmark} alt="Epsilon" className="brand-word" />}
        </Link>
        {!mobile && (
          <button type="button" className="icon-btn" onClick={onToggle} aria-label={collapsed ? t('nav.expand') : t('nav.collapse')} aria-expanded={!collapsed}>
            {collapsed ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}
          </button>
        )}
      </div>
      <nav>
        {NAV.map((s) => {
          const items = s.items.filter((i) => !i.perm || can(i.perm));
          if (!items.length) return null;
          return (
            <div key={s.key} className="nav-section">
              <p className="nav-label">{t(`nav.section.${s.key}`)}</p>
              <ul>
                {items.map((i) => (
                  <li key={i.to}>
                    <NavLink to={link(i.to)} end={i.to === '/'} onClick={onClose} title={slim ? t(`nav.${i.key}`) : undefined} aria-label={slim ? t(`nav.${i.key}`) : undefined}>
                      <i.icon size={18} aria-hidden="true" />
                      <span className="nav-text">{t(`nav.${i.key}`)}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);

function hitLink(kind: string, h: SearchHit): { to: string; title: string; sub?: string } {
  const key = encodeURIComponent(h.key ?? String(h.id ?? ''));
  switch (kind) {
    case 'users': return { to: `/users/${key}`, title: h.name ?? h.emailMasked ?? String(h.id), sub: h.emailMasked ?? undefined };
    case 'restaurants': return { to: `/restaurants/${key}`, title: h.name ?? key };
    case 'dishes': return { to: `/dishes/${key}`, title: h.name ?? key, sub: h.restaurant ?? undefined };
    case 'reviews': return { to: `/reviews?review=${key}`, title: h.comment ?? `${h.rating ?? ''}★ ${h.restaurant ?? ''}`, sub: h.restaurant ?? undefined };
    default: return { to: `/receipts/${key}`, title: h.title ?? h.restaurant ?? String(h.id) };
  }
}

function GlobalSearch() {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const link = useRangeLink();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setTerm(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === '/' && !isTyping(e.target) && !e.ctrlKey && !e.metaKey) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const q = useData('/search', searchSchema, { q: term }, { enabled: term.length >= 2 });
  const groups = q.data ? (['users', 'restaurants', 'dishes', 'reviews', 'receipts'] as const).filter((k) => q.data[k]?.length) : [];
  const close = () => {
    setOpen(false);
    setText('');
    setTerm('');
  };
  return (
    <div className="search" role="search" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <Search size={16} aria-hidden="true" />
      <input
        ref={ref}
        type="search"
        value={text}
        placeholder={t('search.placeholder')}
        aria-label={t('search.label')}
        aria-keyshortcuts="/ Control+K"
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => e.key === 'Escape' && (close(), ref.current?.blur())}
      />
      <kbd aria-hidden="true">/</kbd>
      {open && term.length >= 2 && (
        <div className="search-pop">
          {q.isFetching && !q.data ? <p className="muted pad">{t('common.loading')}</p> : null}
          {q.data && !groups.length && <p className="muted pad">{t('search.none')}</p>}
          {groups.map((k) => (
            <div key={k} className="search-group">
              <p className="nav-label">{t(`nav.${k}`)}</p>
              {q.data![k]!.map((h, i) => {
                const l = hitLink(k, h);
                return (
                  <Link key={`${k}${i}`} to={link(l.to)} onClick={close} className="search-hit">
                    <span>{l.title}</span>
                    {l.sub && <span className="muted">{l.sub}</span>}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RangePicker() {
  const { t } = useTranslation();
  const { preset, from, to, setRange } = useRange();
  return (
    <div className="range">
      <label className="sr-only" htmlFor="range">
        {t('range.label')}
      </label>
      <select id="range" value={preset} onChange={(e) => setRange(e.target.value as (typeof PRESETS)[number], from, to)}>
        {PRESETS.map((p) => (
          <option key={p} value={p}>
            {t(`range.${p}`)}
          </option>
        ))}
      </select>
      {preset === 'custom' && (
        <>
          <input type="date" aria-label={t('range.from')} value={from ?? ''} max={to} onChange={(e) => e.target.value && setRange('custom', e.target.value, to ?? e.target.value)} />
          <input type="date" aria-label={t('range.to')} value={to ?? ''} min={from} onChange={(e) => e.target.value && setRange('custom', from ?? e.target.value, e.target.value)} />
        </>
      )}
    </div>
  );
}

function UserMenu() {
  const { t } = useTranslation();
  const { admin, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', click);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  const initials = (admin.name ?? admin.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join('');
  return (
    <div className="usermenu" ref={ref}>
      <button type="button" className="avatar" aria-haspopup="true" aria-expanded={open} aria-label={t('menu.account')} onClick={() => setOpen(!open)}>
        {initials}
      </button>
      {open && (
        <div className="popover" role="menu">
          <p className="popover-name">{admin.name ?? admin.email}</p>
          <p className="muted">{admin.email}</p>
          <p className="muted">{t(`role.${admin.role}`, { defaultValue: admin.role })}</p>
          <Link to="/settings" role="menuitem" className="popover-item" onClick={() => setOpen(false)}>
            {t('nav.settings')}
          </Link>
          <button type="button" role="menuitem" className="popover-item" onClick={() => void signOut()}>
            <LogOut size={16} aria-hidden="true" /> {t('menu.signOut')}
          </button>
        </div>
      )}
    </div>
  );
}

function Header({ onMenu, mobile }: { onMenu: () => void; mobile: boolean }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const qc = useQueryClient();
  const theme = useTheme();
  const ago = useLastUpdated();
  const seg = pathname.split('/')[1] || 'overview';
  const [spin, setSpin] = useState(false);
  const refresh = async () => {
    setSpin(true);
    await qc.invalidateQueries({ queryKey: ['api'] });
    setSpin(false);
  };
  return (
    <header className="topbar">
      {mobile && (
        <button type="button" className="icon-btn" onClick={onMenu} aria-label={t('nav.open')} aria-controls="sidebar">
          <Menu size={20} aria-hidden="true" />
        </button>
      )}
      <h1>{t(`nav.${seg}`, { defaultValue: t('nav.overview') })}</h1>
      <GlobalSearch />
      {!['settings', 'health'].includes(seg) && <RangePicker />}
      <div className="topbar-end">
        <span className="muted updated num" aria-live="polite">
          {ago == null ? '' : t('header.updated', { s: ago })}
        </span>
        <button type="button" className="icon-btn" onClick={() => void refresh()} aria-label={t('header.refresh')}>
          <RefreshCw size={18} className={spin ? 'spin' : ''} aria-hidden="true" />
        </button>
        <button type="button" className="icon-btn" onClick={() => theme.set(theme.resolved === 'dark' ? 'light' : 'dark')} aria-label={t('header.theme')}>
          {theme.resolved === 'dark' ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
        </button>
        <UserMenu />
      </div>
    </header>
  );
}

export function Shell() {
  const { t } = useTranslation();
  const mobile = useMedia('(max-width: 900px)');
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('epsilon-admin-sidebar') === '1';
    } catch {
      return false;
    }
  });
  const [open, setOpen] = useState(false);
  const toggle = () => {
    try {
      localStorage.setItem('epsilon-admin-sidebar', collapsed ? '0' : '1');
    } catch {
      /* private mode: the choice just isn't remembered */
    }
    setCollapsed(!collapsed);
  };
  return (
    <div className={`app${collapsed && !mobile ? ' is-collapsed' : ''}${open ? ' is-open' : ''}`}>
      <a href="#main" className="skip" onClick={() => setTimeout(() => document.getElementById('main')?.focus())}>
        {t('common.skip')}
      </a>
      <Sidebar collapsed={collapsed} onToggle={toggle} mobile={mobile} open={open} onClose={() => setOpen(false)} />
      {mobile && open && <button type="button" className="scrim" aria-label={t('common.close')} onClick={() => setOpen(false)} />}
      <div className="main">
        <Header mobile={mobile} onMenu={() => setOpen(true)} />
        <main id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
