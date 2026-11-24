import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useSyncExternalStore, useEffect } from 'react';
import type { z } from 'zod';
import { api, ApiError, type Query } from './client';
import { useRange } from '../lib/range';

export const queryRetry = (count: number, error: unknown) => !(error instanceof ApiError && error.kind !== 'network') && count < 1;

type Opts = {
  /** Add the global date range (from/to) to the request. */
  range?: boolean;
  /** Cheap pages auto-refresh every 60 s while the tab is visible; expensive ones refetch on focus/manual only. */
  live?: boolean;
  enabled?: boolean;
};

export function useData<S extends z.ZodType>(path: string, schema: S, params: Query = {}, opts: Opts = {}) {
  const { from, to } = useRange();
  const query: Query = opts.range ? { from, to, ...params } : params;
  return useQuery({
    queryKey: ['api', path, query],
    queryFn: () => api('GET', path, schema, { query }),
    enabled: opts.enabled,
    placeholderData: keepPreviousData,
    refetchInterval: opts.live ? () => (document.visibilityState === 'visible' ? 60_000 : false) : false,
    refetchIntervalInBackground: false,
  });
}

/** Cursor pagination with a back stack; resets when the filters change. */
export function usePaged<S extends z.ZodType>(path: string, schema: S, params: Query = {}, opts: Opts = {}) {
  const sig = JSON.stringify(params);
  const [state, setState] = useState<{ sig: string; stack: string[] }>({ sig, stack: [] });
  const stack = state.sig === sig ? state.stack : [];
  const q = useData(path, schema, { ...params, cursor: stack.at(-1) }, opts);
  const next = (q.data as { nextCursor?: string | null } | undefined)?.nextCursor;
  return {
    q,
    page: stack.length + 1,
    hasPrev: stack.length > 0,
    hasNext: !!next,
    onNext: () => next && setState({ sig, stack: [...stack, next] }),
    onPrev: () => setState({ sig, stack: stack.slice(0, -1) }),
  };
}

/** Most recent successful fetch across all admin API queries, for "Updated 12 s ago". */
export function useLastUpdated() {
  const qc = useQueryClient();
  const cache = qc.getQueryCache();
  const latest = useSyncExternalStore(
    (cb) => cache.subscribe(cb),
    () => cache.findAll({ queryKey: ['api'] }).reduce((m, q) => Math.max(m, q.state.dataUpdatedAt), 0),
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  return latest ? Math.max(0, Math.round((now - latest) / 1000)) : null;
}
