import { count } from 'drizzle-orm';

import { loadConfig } from '../config.js';
import { connect } from './client.js';
import { restaurants } from './schema.js';
import { DEMO_REFERENCES, seed } from './seed-data.js';

const config = loadConfig();
if (config.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');
const { db, close } = connect(config.DATABASE_URL);
const [existing] = await db.select({ n: count() }).from(restaurants);
if ((existing?.n ?? 0) > 0) {
  console.log('Database already has restaurants; seed skipped.');
} else {
  await seed(db);
  console.log(`Seeded demo data. Purchase codes: ${DEMO_REFERENCES.join(', ')}`);
}
await close();
