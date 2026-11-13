import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import { loadConfig } from '../config.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
await migrate(drizzle(pool), { migrationsFolder: 'drizzle' });
await pool.end();
console.log('Migrations applied');
