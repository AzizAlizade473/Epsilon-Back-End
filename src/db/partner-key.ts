/**
 * Issue (or rotate) a partner restaurant's POS integration key.
 * Usage: npm run partner:key -- <restaurantId>
 * Prints the key once; only its SHA-256 is stored. Give it to the partner's POS integrator.
 */
import { randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { loadConfig } from '../config.js';
import { sha256 } from '../lib/crypto.js';
import { connect } from './client.js';
import { restaurants } from './schema.js';

const restaurantId = process.argv[2];
if (!restaurantId) {
  console.error('Usage: npm run partner:key -- <restaurantId>');
  process.exit(1);
}
const { db, close } = connect(loadConfig().DATABASE_URL);
const key = randomBytes(32).toString('base64url');
const updated = await db
  .update(restaurants)
  .set({ posKeyHash: sha256(key) })
  .where(eq(restaurants.id, restaurantId))
  .returning({ name: restaurants.name });
await close();
if (!updated[0]) {
  console.error('No restaurant with that id');
  process.exit(1);
}
console.log(`POS key for ${updated[0].name} (shown once, store it securely):\n${key}`);
