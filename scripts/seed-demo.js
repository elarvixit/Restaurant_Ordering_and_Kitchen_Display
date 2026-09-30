'use strict';
// Fills today with realistic, already-finished orders so the dashboard has data.
// Goes through the same store functions as the live app. Run: npm run demo
// Local SQLite by default; with DATABASE_URL set it fills that Postgres (e.g. your Supabase DB):
//   PowerShell:  $env:DATABASE_URL="postgresql://..."; npm run demo

const path = require('node:path');
const { sqliteDb, postgresDb } = require('../src/sql');
const { setup } = require('../src/schema');
const { createStore } = require('../src/store');

(async () => {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  const db = url ? postgresDb(url) : sqliteDb(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'restaurant.db'));
  await setup(db);

  const realNow = Date.now();
  let clock = 0;
  const store = createStore(db, { now: () => clock });

  const MIN = 60_000;
  const items = (await store.getMenu()).items.filter((i) => i.is_available);
  const tables = (await store.listTables()).filter((t) => Number(t.open_orders) === 0);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  const from = realNow - 6 * 60 * MIN;
  const until = realNow - 45 * MIN;
  if (!tables.length) { console.log('No free tables to seed.'); return db.close(); }

  let created = 0;
  for (let t = from; t < until; t += (6 + Math.random() * 14) * MIN) {
    const table = pick(tables);
    clock = Math.round(t);
    const lines = Array.from({ length: 1 + Math.floor(Math.random() * 4) }, () => ({
      item_id: pick(items).id,
      qty: 1 + Math.floor(Math.random() * 2),
      note: Math.random() < 0.15 ? pick(['less spicy', 'no onion', 'extra butter', 'jain']) : '',
    }));
    const { order_id } = await store.placeOrder(table.id, { items: lines });
    clock += Math.round((1 + Math.random() * 3) * MIN);  await store.advanceOrder(order_id, { from: 'New' });
    clock += Math.round((6 + Math.random() * 16) * MIN); await store.advanceOrder(order_id, { from: 'Preparing' });
    clock += Math.round((1 + Math.random() * 3) * MIN);  await store.advanceOrder(order_id, { from: 'Ready' });
    clock += Math.round((15 + Math.random() * 20) * MIN);
    await store.closeTable(table.id);
    created++;
  }
  console.log(`Seeded ${created} paid orders for today (${url ? 'Postgres' : 'SQLite'}).`);
  await db.close();
})().catch((err) => { console.error(err); process.exit(1); });
