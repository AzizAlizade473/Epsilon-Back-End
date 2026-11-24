/**
 * Admin provisioning (the only way admins are created or removed; no API, no default password).
 *   npm run admin:add -- <email> <role> [name]
 *   npm run admin:disable -- <email>      disables the admin and revokes their sessions
 *   npm run admin:revoke -- <email>|--all revokes sessions only
 */
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { loadConfig } from '../config.js';
import { connect } from '../db/client.js';
import { adminSessions, adminUsers } from '../db/schema.js';
import { audit } from './audit.js';

const [command, ...args] = process.argv.slice(2);
const usage = () => {
  console.error('Usage: admin:add <email> <role> [name] | admin:disable <email> | admin:revoke <email>|--all');
  process.exit(1);
};
const email = z.string().trim().toLowerCase().email().max(254);
const role = z.enum(['super_admin', 'operations', 'analyst', 'partner']);

const { db, close } = connect(loadConfig().DATABASE_URL);
const revoke = (where: ReturnType<typeof eq> | undefined) =>
  db.update(adminSessions).set({ revokedAt: new Date() }).where(and(isNull(adminSessions.revokedAt), where)).returning({ id: adminSessions.id });
const find = async (raw: string | undefined) => {
  const parsed = email.safeParse(raw);
  if (!parsed.success) return usage();
  const [row] = await db.select().from(adminUsers).where(eq(adminUsers.email, parsed.data));
  if (!row) {
    console.error('No such admin');
    process.exit(1);
  }
  return row;
};

try {
  if (command === 'add') {
    const parsedEmail = email.safeParse(args[0]);
    const parsedRole = role.safeParse(args[1]);
    if (!parsedEmail.success || !parsedRole.success) usage();
    const name = args.slice(2).join(' ').trim() || parsedEmail.data!.split('@')[0]!;
    const [row] = await db
      .insert(adminUsers)
      .values({ email: parsedEmail.data!, role: parsedRole.data!, name })
      .onConflictDoNothing()
      .returning({ id: adminUsers.id });
    if (!row) {
      console.error('That email is already an admin');
      process.exit(1);
    }
    await audit(db, { adminId: null, action: 'admin.add', entityType: 'admin', entityId: row.id, after: { role: parsedRole.data }, outcome: 'ok' });
    console.log(`Added ${parsedEmail.data} as ${parsedRole.data}`);
  } else if (command === 'disable') {
    const row = await find(args[0]);
    await db.update(adminUsers).set({ status: 'disabled' }).where(eq(adminUsers.id, row.id));
    const n = (await revoke(eq(adminSessions.adminId, row.id))).length;
    await audit(db, { adminId: null, action: 'admin.disable', entityType: 'admin', entityId: row.id, outcome: 'ok' });
    console.log(`Disabled ${row.email}; revoked ${n} session(s)`);
  } else if (command === 'revoke') {
    const all = args[0] === '--all';
    const row = all ? null : await find(args[0]);
    const n = (await revoke(row ? eq(adminSessions.adminId, row.id) : undefined)).length;
    await audit(db, { adminId: null, action: 'admin.revoke', entityType: 'admin', entityId: row?.id ?? 'all', outcome: 'ok' });
    console.log(`Revoked ${n} session(s)`);
  } else usage();
} finally {
  await close();
}
