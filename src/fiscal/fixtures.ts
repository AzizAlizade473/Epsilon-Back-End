import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fiscalDocumentSchema, type FiscalDocument } from './document.js';

/** Local test receipts (*.json, git-ignored dir), keyed by Fiscal ID. Development only. */
export function loadFixtureDir(dir: string): Map<string, FiscalDocument> {
  const map = new Map<string, FiscalDocument>();
  if (!existsSync(dir)) return map;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const doc = fiscalDocumentSchema.parse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    map.set(doc.receipt.fiscalId, doc);
  }
  return map;
}
