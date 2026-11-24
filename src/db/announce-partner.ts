import { loadConfig } from '../config.js';
import { announcePartner } from '../notifications/partner.js';
import { expoPush } from '../notifications/push.js';
import { connect } from './client.js';

const restaurantId = process.argv[2];
if (!restaurantId) throw new Error('Usage: npm run notify:partner -- <restaurantId>');
const config = loadConfig();
const { db, close } = connect(config.DATABASE_URL);
try {
  const sent = await announcePartner({ db, push: expoPush, now: () => new Date() }, restaurantId);
  console.log(`Announced to ${sent} user(s).`);
} finally {
  await close();
}
