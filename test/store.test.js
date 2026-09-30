'use strict';
// Business-rule tests. The whole suite runs twice: on SQLite (local mode) and on
// Postgres via PGlite (the SQL that runs on Vercel/Supabase). Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { sqliteDb, pgliteDb, postgresDb } = require('../src/sql');
const { setup: setupSchema } = require('../src/schema');
const { createStore } = require('../src/store');
const { T } = require('../src/tables');

const MIN = 60_000;

// The standard pg driver (used for Supabase) talking TCP to a real Postgres wire server.
let nextPort = 55400 + Math.floor(Math.random() * 400);
async function pgDriverDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const port = nextPort++;
  const server = new PGLiteSocketServer({ db: await PGlite.create(), port, host: '127.0.0.1' });
  await server.start();
  // max: 1 because the test server accepts one connection at a time.
  const db = postgresDb(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1 });
  return { ...db, close: async () => { await db.close(); await server.stop(); } };
}

// Postgres whose tables were created by supabase/schema.sql (what you run in Supabase's SQL editor).
const SUPABASE_SQL = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
async function supabaseScriptDb() {
  const db = await pgliteDb();
  await db.exec(SUPABASE_SQL);
  return db;
}

const ENGINES = [
  ['sqlite', async () => sqliteDb(':memory:')],
  ['postgres', () => pgliteDb()],
  ['postgres/pg-driver', pgDriverDb],
  ['postgres/supabase.sql', supabaseScriptDb],
];

for (const [engine, makeDb] of ENGINES) {
  async function setup() {
    let clock = Date.UTC(2026, 8, 29, 12, 0, 0); // 29 Sep 2026, 12:00 in the store's zone (UTC here)
    const db = await makeDb();
    await setupSchema(db);
    const store = createStore(db, { now: () => clock, tz: 'UTC' });
    const item = async (name) => (await db.query(`SELECT * FROM ${T.menu_items} WHERE name = $1`, [name]))[0];
    return { db, store, item, advance: (ms) => { clock += ms; } };
  }

  test(`[${engine}] new items join the open New order, but a Preparing order is locked`, async () => {
    const { db, store, item } = await setup();
    const naan = await item('Butter Naan'), dal = await item('Dal Makhani');

    const a = await store.placeOrder(1, { items: [{ item_id: dal.id, qty: 1, note: 'less spicy' }] });
    const b = await store.placeOrder(1, { items: [{ item_id: naan.id, qty: 2 }] });
    assert.equal(b.order_id, a.order_id);
    assert.equal(b.appended, true);

    await store.advanceOrder(a.order_id, { from: 'New' });
    const line = (await store.getTableBill(1)).orders[0].items[0];
    await assert.rejects(store.updateOrderLine(1, line.id, { qty: 3 }), { status: 409 });

    const c = await store.placeOrder(1, { items: [{ item_id: naan.id, qty: 1 }] });
    assert.notEqual(c.order_id, a.order_id, 'a fresh order is created once the first is Preparing');
    assert.equal((await store.getTableBill(1)).orders.length, 2);
    await db.close();
  });

  test(`[${engine}] unavailable items cannot be ordered, and existing orders survive the toggle`, async () => {
    const { db, store, item } = await setup();
    const pt = await item('Paneer Tikka');
    const { order_id } = await store.placeOrder(2, { items: [{ item_id: pt.id, qty: 2 }] });

    await store.saveItem(pt.id, { is_available: false, price_paise: 99_900 }); // also a price change
    await assert.rejects(store.placeOrder(3, { items: [{ item_id: pt.id, qty: 1 }] }), { status: 409 });

    const k = (await store.kitchenOrders()).find((o) => o.id === order_id);
    assert.equal(k.items[0].item_name, 'Paneer Tikka');
    assert.equal(k.items[0].unit_price_at_order, 28_000, 'price is the snapshot, not the new menu price');
    for (const from of ['New', 'Preparing', 'Ready']) await store.advanceOrder(order_id, { from });
    assert.equal((await store.closeTable(2)).subtotal_paise, 56_000);
    await db.close();
  });

  test(`[${engine}] lifecycle advances one step at a time and double taps are rejected`, async () => {
    const { db, store, item } = await setup();
    const { order_id } = await store.placeOrder(1, { items: [{ item_id: (await item('Masala Chai')).id, qty: 1 }] });
    assert.equal((await store.advanceOrder(order_id, { from: 'New' })).status, 'Preparing');
    await assert.rejects(store.advanceOrder(order_id, { from: 'New' }), { status: 409 });
    assert.equal((await store.advanceOrder(order_id, { from: 'Preparing' })).status, 'Ready');
    assert.equal((await store.advanceOrder(order_id, { from: 'Ready' })).status, 'Served');
    await assert.rejects(store.advanceOrder(order_id, { from: 'Served' }), { status: 409 });
    assert.equal((await store.kitchenOrders()).length, 0, 'served orders leave the kitchen screen');
    await db.close();
  });

  test(`[${engine}] two kitchen screens tapping the same card at once advance it only once`, async () => {
    const { db, store, item } = await setup();
    const { order_id } = await store.placeOrder(1, { items: [{ item_id: (await item('Masala Chai')).id, qty: 1 }] });
    const results = await Promise.allSettled([
      store.advanceOrder(order_id, { from: 'New' }),
      store.advanceOrder(order_id, { from: 'New' }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    await db.close();
  });

  test(`[${engine}] bill applies 5% GST and closing frees the table`, async () => {
    const { db, store, item } = await setup();
    const { order_id } = await store.placeOrder(4, { items: [
      { item_id: (await item('Butter Chicken')).id, qty: 1 },   // 420
      { item_id: (await item('Garlic Naan')).id, qty: 3 },      // 240
    ] });
    await assert.rejects(store.closeTable(4), { status: 409 }, 'cannot close with unserved orders');
    for (const from of ['New', 'Preparing', 'Ready']) await store.advanceOrder(order_id, { from });

    const bill = await store.getTableBill(4);
    assert.deepEqual([bill.subtotal_paise, bill.gst_paise, bill.total_paise], [66_000, 3_300, 69_300]);
    await store.closeTable(4);
    assert.equal((await store.getTableBill(4)).orders.length, 0);
    assert.equal(Number((await store.listTables()).find((t) => t.id === 4).open_orders), 0);
    const [o] = await db.query(`SELECT paid_at FROM ${T.orders} WHERE id = $1`, [order_id]);
    assert.ok(o.paid_at);
    await db.close();
  });

  test(`[${engine}] dashboard: revenue, prep time New→Ready, top items, hourly buckets`, async () => {
    const { db, store, item, advance } = await setup();
    const bc = await item('Butter Chicken'), naan = await item('Butter Naan'), chai = await item('Masala Chai');

    const o1 = (await store.placeOrder(1, { items: [{ item_id: bc.id, qty: 1 }, { item_id: naan.id, qty: 4 }] })).order_id;
    advance(2 * MIN); await store.advanceOrder(o1, { from: 'New' });
    advance(8 * MIN); await store.advanceOrder(o1, { from: 'Preparing' }); // ready after 10 min

    advance(60 * MIN); // 13:10
    const o2 = (await store.placeOrder(2, { items: [{ item_id: chai.id, qty: 2 }] })).order_id;
    advance(1 * MIN); await store.advanceOrder(o2, { from: 'New' });
    advance(3 * MIN); await store.advanceOrder(o2, { from: 'Preparing' }); // ready after 4 min

    const d = await store.dashboard('2026-09-29');
    assert.equal(d.orders, 2);
    assert.equal(d.revenue_paise, 42_000 + 4 * 6_000 + 2 * 6_000);
    assert.equal(d.avg_prep_ms, 7 * MIN);
    assert.equal(d.top_items[0].name, 'Butter Naan');
    assert.equal(d.top_items[0].emoji, '🫓');
    assert.equal(d.by_hour[12].revenue_paise, 66_000);
    assert.equal(d.by_hour[13].revenue_paise, 12_000);
    assert.equal((await store.dashboard('2026-09-28')).orders, 0);
    await db.close();
  });

  test(`[${engine}] "today" and hours follow the restaurant time zone, not the server`, async () => {
    const db = await makeDb();
    await setupSchema(db);
    // 20:00 UTC on 29 Sep = 01:30 on 30 Sep in India.
    const store = createStore(db, { now: () => Date.UTC(2026, 8, 29, 20, 0), tz: 'Asia/Kolkata' });
    const [chai] = await db.query(`SELECT id FROM ${T.menu_items} WHERE name = 'Masala Chai'`);
    await store.placeOrder(1, { items: [{ item_id: chai.id, qty: 1 }] });
    const d = await store.dashboard();
    assert.equal(d.date, '2026-09-30');
    assert.equal(d.orders, 1);
    assert.equal(d.by_hour[1].orders, 1, 'counted in the 1 am hour, local time');
    await db.close();
  });

  test(`[${engine}] every seeded dish has a picture, and the manager can change it`, async () => {
    const { db, store, item } = await setup();
    assert.ok((await store.getMenu()).items.every((i) => i.emoji), 'all dishes have a picture');
    const chai = await item('Masala Chai');
    await store.saveItem(chai.id, { emoji: '🍵' });
    assert.equal((await store.getMenu()).items.find((i) => i.id === chai.id).emoji, '🍵');
    await assert.rejects(store.saveItem(chai.id, { emoji: 'x'.repeat(40) }), { status: 400 });
    await db.close();
  });

  test(`[${engine}] customer can edit and remove lines on a New order`, async () => {
    const { db, store, item } = await setup();
    const { order_id } = await store.placeOrder(5, { items: [{ item_id: (await item('Rasmalai')).id, qty: 1 }] });
    const line = (await store.getTableBill(5)).orders[0].items[0];
    await store.updateOrderLine(5, line.id, { qty: 3 });
    assert.equal((await store.getTableBill(5)).orders[0].items[0].qty, 3);
    await assert.rejects(store.updateOrderLine(6, line.id, { qty: 1 }), { status: 404 }, 'other tables cannot edit it');
    await store.updateOrderLine(5, line.id, { qty: 0 });
    assert.equal((await store.getTableBill(5)).orders.length, 0, 'empty order is removed');
    assert.equal((await store.kitchenOrders()).some((o) => o.id === order_id), false);
    await db.close();
  });

  test(`[${engine}] every write moves the live-sync version; reads don't`, async () => {
    const { db, store, item } = await setup();
    const v0 = await store.version();
    await store.getMenu();
    assert.equal(await store.version(), v0);
    await store.placeOrder(1, { items: [{ item_id: (await item('Rasmalai')).id, qty: 1 }] });
    assert.equal(await store.version(), v0 + 1);
    await assert.rejects(store.placeOrder(1, { items: [] }), { status: 400 });
    assert.equal(await store.version(), v0 + 1, 'a rejected write changes nothing');
    await db.close();
  });

  test(`[${engine}] setup is safe to run again on an existing database`, async () => {
    const db = await makeDb();
    await setupSchema(db);
    await setupSchema(db);
    const [{ n }] = await db.query(`SELECT COUNT(*) AS n FROM ${T.menu_items}`);
    assert.equal(Number(n), 18, 'menu not seeded twice');
    await db.close();
  });
}

test('[sqlite] a database from before pictures existed is upgraded in place', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kds-')), 'old.db');
  // The original schema: no emoji column, no app_state / login_failures tables.
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE menu_categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, archived_at INTEGER);
    CREATE TABLE menu_items (id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL, name TEXT NOT NULL, price_paise INTEGER NOT NULL,
      is_veg INTEGER NOT NULL DEFAULT 1, prep_minutes INTEGER NOT NULL DEFAULT 10, is_available INTEGER NOT NULL DEFAULT 1, archived_at INTEGER);
    INSERT INTO menu_categories (name, sort_order) VALUES ('Beverages', 1);
    INSERT INTO menu_items (category_id, name, price_paise) VALUES (1, 'Masala Chai', 6000), (1, 'House Special', 9000);`);
  old.close();

  const db = sqliteDb(file);
  await setupSchema(db);
  const rows = await db.query(`SELECT name, emoji, price FROM ${T.menu_items} ORDER BY id`);
  assert.equal(rows.length, 2, 'no rows lost, and no seed added on top');
  assert.deepEqual(rows.map((r) => r.price), [60, 90], 'paise converted to rupees');
  assert.equal(rows[0].emoji, '☕', 'known dish gets its picture');
  assert.equal(rows[1].emoji, '', 'unknown dish keeps the default');
  assert.ok((await db.query(`SELECT num FROM ${T.app_state} WHERE name = 'version'`))[0]);
  const left = await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('menu_items', 'menu_categories')");
  assert.deepEqual(left, [], 'old unprefixed tables are renamed, not copied');
  await db.close();
});

test('[sqlite] a local database with the old unprefixed table names keeps its orders', async () => {
  const { BASE, NAMES } = require('../src/tables');
  const db = sqliteDb(':memory:');
  await setupSchema(db);
  const store = createStore(db, { tz: 'UTC' });
  const [naan] = await db.query(`SELECT id FROM ${T.menu_items} WHERE name = 'Butter Naan'`);
  const { order_id } = await store.placeOrder(3, { items: [{ item_id: naan.id, qty: 2 }] });
  // Turn it back into a database from before the prefix: old table names, old index names.
  for (const b of BASE) await db.exec(`ALTER TABLE ${T[b]} RENAME TO "${b}"`);
  for (const { name } of await db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'babji%'")) {
    await db.exec(`DROP INDEX "${name}"`);
  }
  await db.exec('CREATE INDEX idx_orders_placed ON orders(placed_at)');

  await setupSchema(db);
  const names = (await db.query("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name).sort();
  assert.deepEqual(names, Object.values(NAMES).sort());
  const bill = await store.getTableBill(3);
  assert.equal(bill.orders[0].id, order_id);
  assert.equal(bill.subtotal_paise, 12000);
  assert.deepEqual(await db.query('PRAGMA foreign_key_check'), [], 'foreign keys point at the renamed tables');
  const idx = (await db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")).map((r) => r.name);
  assert.ok(!idx.includes('idx_orders_placed') && idx.every((n) => n.startsWith('babji_RestaurantKitchen_')));
  await db.close();
});

test('[postgres] supabase/schema.sql creates exactly the schema the app creates', async () => {
  const shape = async (db) => ({
    columns: await db.query(`
      SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity
      FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`),
    indexes: await db.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`),
    rls: await db.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace ORDER BY relname`),
    menu: await db.query(`SELECT c.name AS category, c.sort_order, i.name, i.price, i.is_veg, i.prep_minutes, i.emoji, i.photo
                          FROM ${T.menu_items} i JOIN ${T.menu_categories} c ON c.id = i.category_id ORDER BY i.name`),
    tables: await db.query(`SELECT number, seats FROM ${T.tables} ORDER BY number`),
  });
  const byApp = await pgliteDb();
  await setupSchema(byApp);
  const byScript = await supabaseScriptDb();
  await byScript.exec(SUPABASE_SQL); // running it twice is harmless
  const a = await shape(byApp), b = await shape(byScript);
  assert.ok(a.columns.every((c) => c.table_name.startsWith('babji_RestaurantKitchen_')));
  assert.ok(a.indexes.every((i) => i.indexname.startsWith('babji_RestaurantKitchen_')));
  assert.ok(a.rls.length === 8 && a.rls.every((r) => r.relrowsecurity), 'row level security is on for every table');
  assert.deepEqual(b, a);
  await byApp.close();
  await byScript.close();
});

// ---------- money: paise (schema 2) -> rupees (schema 3) ----------

// A Postgres database as it was before the change: money in integer *_paise columns, schema 2.
// Built from a current one with one closed bill and one open order, then turned back into paise.
async function paiseEraPostgres() {
  const db = await pgliteDb();
  await setupSchema(db);
  const store = createStore(db, { tz: 'UTC' });
  const id = async (n) => (await db.query(`SELECT id FROM ${T.menu_items} WHERE name = $1`, [n]))[0].id;
  const bc = await id('Butter Chicken'), naan = await id('Butter Naan'), chai = await id('Masala Chai');
  // 2 x 420 + 60 + 60 = Rs 960, GST Rs 48, total Rs 1008
  const { order_id } = await store.placeOrder(4, { items: [{ item_id: bc, qty: 2 }, { item_id: naan, qty: 1 }, { item_id: chai, qty: 1 }] });
  for (const from of ['New', 'Preparing', 'Ready']) await store.advanceOrder(order_id, { from });
  await store.closeTable(4);
  await store.placeOrder(7, { items: [{ item_id: chai, qty: 3 }] });
  const back = (tbl, from, to) => [
    `ALTER TABLE ${T[tbl]} ALTER COLUMN ${from} TYPE INTEGER USING ROUND(${from} * 100)::INTEGER`,
    ...(from === to ? [] : [`ALTER TABLE ${T[tbl]} RENAME COLUMN ${from} TO ${to}`]),
  ];
  for (const stmt of [
    ...back('menu_items', 'price', 'price_paise'),
    ...back('order_items', 'unit_price_at_order', 'unit_price_at_order'),
    ...back('bills', 'subtotal', 'subtotal_paise'), ...back('bills', 'gst', 'gst_paise'), ...back('bills', 'total', 'total_paise'),
    `UPDATE ${T.app_state} SET num = 2 WHERE name = 'schema'`,
  ]) await db.exec(stmt);
  const [old] = await db.query(`SELECT price_paise FROM ${T.menu_items} WHERE name = 'Butter Chicken'`);
  assert.equal(old.price_paise, 42000, 'test database really is in paise');
  return db;
}

async function assertRupees(db) {
  const cols = await db.query(`SELECT table_name, column_name, data_type FROM information_schema.columns
                               WHERE table_name IN ($1, $2, $3)`,
  ['babji_RestaurantKitchen_menu_items', 'babji_RestaurantKitchen_bills', 'babji_RestaurantKitchen_order_items']);
  assert.ok(!cols.some((c) => c.column_name.endsWith('_paise')), 'no *_paise columns left');
  for (const [t, c] of [['menu_items', 'price'], ['bills', 'total'], ['order_items', 'unit_price_at_order']]) {
    assert.equal(cols.find((x) => x.table_name.endsWith(t) && x.column_name === c).data_type, 'numeric');
  }
  const [bc] = await db.query(`SELECT price FROM ${T.menu_items} WHERE name = 'Butter Chicken'`);
  assert.equal(bc.price, 420);
  const [bill] = await db.query(`SELECT subtotal, gst, total FROM ${T.bills}`);
  assert.deepEqual([bill.subtotal, bill.gst, bill.total], [960, 48, 1008]);
  // The app reads the same amounts as before, and keeps working on the converted data.
  const store = createStore(db, { tz: 'UTC' });
  assert.equal((await store.getTableBill(7)).subtotal_paise, 18000, 'open order: 3 chai at Rs 60');
  const d = await store.dashboard();
  assert.equal(d.collected.total_paise, 100800);
  assert.equal(d.revenue_paise, 96000 + 18000);
  const [chai] = await db.query(`SELECT id FROM ${T.menu_items} WHERE name = 'Masala Chai'`);
  await store.placeOrder(7, { items: [{ item_id: chai.id, qty: 1 }] });
  const open = await store.getTableBill(7);
  assert.equal(open.subtotal_paise, 24000);
  assert.equal(open.orders[0].items.length, 1, 'new chai merges into the converted line');
}

test('[postgres] the app converts an existing paise database (like the live Supabase one) to rupees', async () => {
  const db = await paiseEraPostgres();
  await setupSchema(db);
  await assertRupees(db);
  await setupSchema(db); // again: must not divide twice
  const [bc] = await db.query(`SELECT price FROM ${T.menu_items} WHERE name = 'Butter Chicken'`);
  assert.equal(bc.price, 420);
  await db.close();
});

test('[postgres] supabase/schema.sql converts an existing paise database to rupees', async () => {
  const db = await paiseEraPostgres();
  await db.exec(SUPABASE_SQL);
  await db.exec(SUPABASE_SQL); // twice is harmless
  await assertRupees(db);
  await setupSchema(db); // the app then sees schema 3 and changes nothing
  const [bc] = await db.query(`SELECT price FROM ${T.menu_items} WHERE name = 'Butter Chicken'`);
  assert.equal(bc.price, 420);
  await db.close();
});

test('[sqlite] a local paise database (schema 2) is converted to rupees once', async () => {
  const db = sqliteDb(':memory:');
  await db.exec(`
    CREATE TABLE ${T.menu_categories} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, archived_at INTEGER);
    CREATE TABLE ${T.menu_items} (id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES ${T.menu_categories}(id), name TEXT NOT NULL,
      price_paise INTEGER NOT NULL CHECK (price_paise >= 0), is_veg INTEGER NOT NULL DEFAULT 1, prep_minutes INTEGER NOT NULL DEFAULT 10,
      is_available INTEGER NOT NULL DEFAULT 1, emoji TEXT NOT NULL DEFAULT '', archived_at INTEGER);
    CREATE TABLE ${T.tables} (id INTEGER PRIMARY KEY, number INTEGER NOT NULL UNIQUE, seats INTEGER NOT NULL DEFAULT 4);
    CREATE TABLE ${T.bills} (id INTEGER PRIMARY KEY, table_id INTEGER NOT NULL REFERENCES ${T.tables}(id),
      subtotal_paise INTEGER NOT NULL, gst_paise INTEGER NOT NULL, total_paise INTEGER NOT NULL, closed_at INTEGER NOT NULL);
    CREATE TABLE ${T.orders} (id INTEGER PRIMARY KEY, table_id INTEGER NOT NULL REFERENCES ${T.tables}(id), status TEXT NOT NULL DEFAULT 'New',
      placed_at INTEGER NOT NULL, preparing_at INTEGER, ready_at INTEGER, served_at INTEGER, paid_at INTEGER, bill_id INTEGER REFERENCES ${T.bills}(id));
    CREATE TABLE ${T.order_items} (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES ${T.orders}(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES ${T.menu_items}(id), item_name TEXT NOT NULL, qty INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '',
      unit_price_at_order INTEGER NOT NULL CHECK (unit_price_at_order >= 0), added_at INTEGER NOT NULL);
    CREATE TABLE ${T.app_state} (name TEXT PRIMARY KEY, num INTEGER NOT NULL);
    INSERT INTO ${T.app_state} VALUES ('schema', 2), ('version', 1);
    INSERT INTO ${T.menu_categories} (name, sort_order) VALUES ('Mains', 1);
    INSERT INTO ${T.menu_items} (category_id, name, price_paise) VALUES (1, 'Dal Makhani', 28050);
    INSERT INTO ${T.tables} (number, seats) VALUES (1, 4);
    INSERT INTO ${T.bills} (table_id, subtotal_paise, gst_paise, total_paise, closed_at) VALUES (1, 56100, 2805, 58905, 1);
    INSERT INTO ${T.orders} (table_id, status, placed_at, paid_at, bill_id) VALUES (1, 'Served', 1, 1, 1);
    INSERT INTO ${T.order_items} (order_id, item_id, item_name, qty, unit_price_at_order, added_at) VALUES (1, 1, 'Dal Makhani', 2, 28050, 1);`);
  await setupSchema(db);
  await setupSchema(db); // again: must not divide twice
  const [item] = await db.query(`SELECT price FROM ${T.menu_items}`);
  const [bill] = await db.query(`SELECT subtotal, gst, total FROM ${T.bills}`);
  const [line] = await db.query(`SELECT unit_price_at_order FROM ${T.order_items}`);
  assert.equal(item.price, 280.5);
  assert.deepEqual([bill.subtotal, bill.gst, bill.total], [561, 28.05, 589.05]);
  assert.equal(line.unit_price_at_order, 280.5);
  assert.equal((await createStore(db, { tz: 'UTC' }).getMenu()).items[0].price_paise, 28050, 'the app still reads exact paise');
  assert.equal((await db.query(`SELECT num FROM ${T.app_state} WHERE name = 'schema'`))[0].num, 4);
  await db.close();
});

// ---------- dish photos ----------

const PHOTO_DIR = require('node:path').join(__dirname, '..', 'public', 'img', 'menu');

for (const [engine, makeDb] of ENGINES.filter(([e]) => e !== 'postgres/pg-driver')) {
  test(`[${engine}] every starting dish has a real photo, and its file exists`, async () => {
    const db = await makeDb();
    await setupSchema(db);
    const { items } = await createStore(db).getMenu();
    assert.equal(items.length, 18);
    for (const i of items) {
      assert.match(i.photo, /^[a-z0-9-]+\.jpg$/, `${i.name} has a photo`);
      assert.ok(require('node:fs').existsSync(require('node:path').join(PHOTO_DIR, i.photo)), `${i.photo} exists`);
    }
    assert.equal(items.find((i) => i.name === 'Paneer Tikka').photo, 'paneer-tikka.jpg');
    await db.close();
  });
}

test('[postgres] dishes keep their photo when edited; new dishes show their emoji', async () => {
  const db = await pgliteDb();
  await setupSchema(db);
  const store = createStore(db);
  const byName = async (n) => (await store.getMenu()).items.find((i) => i.name === n);
  const chai = await byName('Masala Chai');
  await store.saveItem(chai.id, { price_paise: 7000, name: 'Masala Chai (large)' });
  assert.equal((await byName('Masala Chai (large)')).photo, 'masala-chai.jpg', 'rename and price change keep the photo');
  const { id } = await store.saveItem(null, { category_id: chai.category_id, name: 'Filter Coffee', price_paise: 5000, prep_minutes: 3, emoji: '☕' });
  const coffee = (await store.getMenu()).items.find((i) => i.id === id);
  assert.equal(coffee.photo, '');
  assert.equal(coffee.emoji, '☕');
  await db.close();
});

test('[postgres] a database from before photos gets them (app and supabase/schema.sql)', async () => {
  for (const how of ['app', 'script']) {
    const db = await pgliteDb();
    await setupSchema(db);
    await db.exec(`ALTER TABLE ${T.menu_items} DROP COLUMN photo`);
    await db.exec(`UPDATE ${T.app_state} SET num = 3 WHERE name = 'schema'`);
    await db.exec(`INSERT INTO ${T.menu_items} (category_id, name, price, emoji) VALUES (1, 'Chef Special', 250, '⭐')`);
    if (how === 'app') await setupSchema(db); else { await db.exec(SUPABASE_SQL); await setupSchema(db); }
    const rows = await db.query(`SELECT name, photo FROM ${T.menu_items} ORDER BY id`);
    assert.equal(rows.filter((r) => r.photo).length, 18, `${how}: all starting dishes get a photo`);
    assert.equal(rows.find((r) => r.name === 'Chef Special').photo, '', `${how}: a dish the manager added keeps its emoji`);
    assert.equal(rows.find((r) => r.name === 'Dal Makhani').photo, 'dal-makhani.jpg');
    await db.close();
  }
});

// ---------- split bill by item ----------

test('splitGst shares the GST so it always adds up to the bill total', () => {
  const { splitGst } = require('../src/store');
  assert.deepEqual(splitGst([12000, 12000], 1200), [600, 600]);
  assert.deepEqual(splitGst([6000, 4000, 1000], 550), [300, 200, 50]);
  // 3 x Rs 3.33 style shares: 5% of 999 paise = 49.95 each, bill GST round(2997 * 5%) = 150
  const s = splitGst([999, 999, 999], 150);
  assert.equal(s.reduce((a, b) => a + b, 0), 150);
  assert.ok(s.every((g) => g === 49 || g === 50));
  for (let i = 0; i < 200; i++) {
    const subs = Array.from({ length: 2 + (i % 5) }, (_, k) => 100 + ((i * 37 + k * 91) % 5000));
    const gst = Math.round((subs.reduce((a, b) => a + b, 0) * 5) / 100);
    assert.equal(splitGst(subs, gst).reduce((a, b) => a + b, 0), gst);
  }
});
