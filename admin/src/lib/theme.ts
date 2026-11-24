import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'epsilon-admin-theme';
const dark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let pref: ThemePref = read();
let resolved: 'light' | 'dark' = 'light';
const listeners = new Set<() => void>();

function apply() {
  resolved = pref === 'dark' || (pref === 'system' && dark()) ? 'dark' : 'light';
  document.documentElement.dataset.theme = resolved;
  listeners.forEach((l) => l());
}

export function setTheme(next: ThemePref) {
  pref = next;
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    /* storage unavailable: the choice just won't persist */
  }
  apply();
}

/** Call once before first render so there is no light flash. */
export function initTheme() {
  apply();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => pref === 'system' && apply());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

export function useTheme() {
  const p = useSyncExternalStore(subscribe, () => pref);
  const r = useSyncExternalStore(subscribe, () => resolved);
  return { pref: p, resolved: r, set: setTheme };
}
