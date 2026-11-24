import type { Db, Tx } from '../db/client.js';
import { adminAudit } from '../db/schema.js';

export type AuditEntry = {
  adminId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  reason?: string;
  /** Never PII. */
  before?: unknown;
  after?: unknown;
  outcome: 'ok' | 'denied' | 'error';
  ip?: string | null;
  userAgent?: string | null;
};

/** Append-only: this is the only writer, and nothing updates or deletes audit rows. */
export async function audit(conn: Db | Tx, entry: AuditEntry): Promise<void> {
  await conn.insert(adminAudit).values({
    ...entry,
    userAgent: entry.userAgent?.slice(0, 300),
    reason: entry.reason?.slice(0, 300),
    entityId: entry.entityId?.slice(0, 200),
  });
}
