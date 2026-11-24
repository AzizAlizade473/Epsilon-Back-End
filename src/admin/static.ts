import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

import type { FastifyReply, FastifyRequest } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

/** Serves the built admin web app from `root`: GET/HEAD only, known extensions only, never outside `root`. */
export function staticHandler(root: string) {
  const base = resolve(root);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const notFound = () => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found', requestId: request.id } });
    if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();
    let path: string;
    try {
      path = decodeURIComponent(request.url.split('?')[0]!);
    } catch {
      return notFound();
    }
    if (!path.startsWith('/') || path.includes('\0') || path.split(/[\\/]/).includes('..')) return notFound();
    const ext = extname(path).toLowerCase();
    // No extension = a client-side route: the app shell.
    const file = ext ? resolve(base, `.${path}`) : join(base, 'index.html');
    const type = ext ? TYPES[ext] : TYPES['.html'];
    if (!type || (file !== base && !file.startsWith(base + sep))) return notFound();
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return notFound();
    // Hashed build assets never change; everything else (index.html) must be revalidated.
    reply.header('Content-Type', type).header('Cache-Control', path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store');
    return reply.send(createReadStream(file));
  };
}
