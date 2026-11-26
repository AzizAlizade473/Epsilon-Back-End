/**
 * Restaurant staff access (the only way it is granted; no API).
 *   npm run staff:add -- <email> <restaurantId>
 *   npm run staff:remove -- <email> <restaurantId>
 */
import { loadConfig } from '../config.js';
import { setStaff } from '../lib/staff.js';
import { connect } from './client.js';

const [command, email, restaurantId] = process.argv.slice(2);
if ((command !== 'add' && command !== 'remove') || !email || !restaurantId) {
  console.error('Usage: staff:add|staff:remove -- <email> <restaurantId>');
  process.exit(1);
}

const { db, close } = connect(loadConfig().DATABASE_URL);
try {
  const result = await setStaff(db, command, email, restaurantId);
  console.log(`${result.restaurant}: ${result.changed ? (command === 'add' ? 'access granted' : 'access removed') : 'nothing to change'}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Failed');
  process.exitCode = 1;
} finally {
  await close();
}
