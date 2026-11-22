import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '../errors.js';

type FailedImport = {
  source: string;
  images: { mime: string; data: string }[];
  ocr?: unknown[];
};

/**
 * Development only (config refuses FISCAL_DEBUG_DIR in production): keeps a failed
 * receipt import (images + on-device OCR) in a git-ignored folder, so the parser can be
 * improved against real receipts. Never throws: diagnostics must not change the response.
 */
export function saveFailedImport(dir: string, fiscalId: string, body: FailedImport, error: unknown) {
  try {
    mkdirSync(dir, { recursive: true });
    const base = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${fiscalId}`);
    body.images.forEach((image, i) =>
      writeFileSync(`${base}-${i + 1}.${image.mime.split('/')[1] ?? 'bin'}`, Buffer.from(image.data, 'base64')),
    );
    const reason = error instanceof ApiError ? { code: error.code, fields: error.fields ?? [] } : { code: 'INTERNAL' };
    writeFileSync(`${base}.json`, JSON.stringify({ source: body.source, reason, ocr: body.ocr ?? [] }, null, 2));
  } catch {
    // ignore
  }
}
