import type { z } from 'zod';

const BASE = '/admin/api';
/** Dev-only sample data; the whole branch is dead code (and tree-shaken) in production. */

/** CSRF secret lives in memory only: never in storage, never in the URL. */
let csrfToken: string | null = null;
export const setCsrfToken = (token: string | null) => {
  csrfToken = token;
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly kind: 'http' | 'schema' | 'network',
    message: string,
  ) {
    super(message);
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export function toQuery(query?: Query): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function send(method: string, path: string, query?: Query, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
  }
  try {
    return await fetch(BASE + path + toQuery(query), {
      method,
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Network error');
  }
}

export async function api<S extends z.ZodType>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  schema: S,
  opts: { query?: Query; body?: unknown } = {},
): Promise<z.output<S>> {
  const res = await send(method, path, opts.query, opts.body);
  if (!res.ok) throw new ApiError(res.status, 'http', `HTTP ${res.status}`);
  const json: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError(res.status, 'schema', parsed.error.message);
  return parsed.data;
}

/** CSV exports: returns the raw text so the caller can offer it as a download. */
export async function exportCsv(report: string, query?: Query): Promise<string> {
  const res = await send('GET', `/export/${report}.csv`, query);
  if (!res.ok) throw new ApiError(res.status, 'http', `HTTP ${res.status}`);
  return res.text();
}
