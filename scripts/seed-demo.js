'use strict';
// Fills today with realistic, already-finished orders so the dashboard has data.
// Goes through the same store functions as the live app. Run: npm run demo
// (stop the server first, or it will not see the new version counter until the next write)

const path = require('node:path');
const { open } = require('../src/db');
const { createStore } = require('../src/store');

const db = open(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'restaurant.db'));
const realNow = Date.now();
let clock = 0;
const store = createStore(db, { now: () => clock });

const MIN = 60_000;
const items = store.getMenu().items.filter((i) => i.is_available);
const tables = store.listTables().filter((t) => t.open_orders === 0);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const start = new Date(realNow); start.setHours(11, 0, 0, 0);
const from = Math.min(start.getTime(), realNow - 6 * 60 * MIN);
const until = realNow - 45 * MIN;
if (until <= from || !tables.length) { console.log('Nothing to seed right now.'); process.exit(0); }

let created = 0;
for (let t = from; t < until; t += (6 + Math.random() * 14) * MIN) {
  const table = pick(tables);
  clock = t;
  const lines = Array.from({ length: 1 + Math.floor(Math.random() * 4) }, () => ({
    item_id: pick(items).id,
    qty: 1 + Math.floor(Math.random() * 2),
    note: Math.random() < 0.15 ? pick(['less spicy', 'no onion', 'extra butter', 'jain']) : '',
  }));
  const { order_id } = store.placeOrder(table.id, { items: lines });
  clock += (1 + Math.random() * 3) * MIN;  store.advanceOrder(order_id, { from: 'New' });
  clock += (6 + Math.random() * 16) * MIN; store.advanceOrder(order_id, { from: 'Preparing' });
  clock += (1 + Math.random() * 3) * MIN;  store.advanceOrder(order_id, { from: 'Ready' });
  clock += (15 + Math.random() * 20) * MIN;
  store.closeTable(table.id);
  created++;
}
console.log(`Seeded ${created} paid orders for today.`);
