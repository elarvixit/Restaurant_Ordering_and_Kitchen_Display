'use strict';
// Business-rule tests against an in-memory database. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { createStore } = require('../src/store');

function setup() {
  let clock = new Date(2026, 8, 29, 12, 0, 0).getTime(); // 29 Sep 2026, 12:00 local
  const db = open(':memory:');
  const store = createStore(db, { now: () => clock });
  const item = (name) => db.q('SELECT * FROM menu_items WHERE name = ?').get(name);
  return { db, store, item, advance: (ms) => { clock += ms; }, now: () => clock };
}

const MIN = 60_000;

test('new items join the open New order, but a Preparing order is locked', () => {
  const { store, item } = setup();
  const naan = item('Butter Naan'), dal = item('Dal Makhani');

  const a = store.placeOrder(1, { items: [{ item_id: dal.id, qty: 1, note: 'less spicy' }] });
  const b = store.placeOrder(1, { items: [{ item_id: naan.id, qty: 2 }] });
  assert.equal(b.order_id, a.order_id);
  assert.equal(b.appended, true);

  store.advanceOrder(a.order_id, { from: 'New' });
  const line = store.getTableBill(1).orders[0].items[0];
  assert.throws(() => store.updateOrderLine(1, line.id, { qty: 3 }), { status: 409 });

  const c = store.placeOrder(1, { items: [{ item_id: naan.id, qty: 1 }] });
  assert.notEqual(c.order_id, a.order_id, 'a fresh order is created once the first is Preparing');
  assert.equal(store.getTableBill(1).orders.length, 2);
});

test('unavailable items cannot be ordered, and existing orders survive the toggle', () => {
  const { store, item } = setup();
  const pt = item('Paneer Tikka');
  const { order_id } = store.placeOrder(2, { items: [{ item_id: pt.id, qty: 2 }] });

  store.saveItem(pt.id, { is_available: false, price_paise: 99_900 }); // also a price change
  assert.throws(() => store.placeOrder(3, { items: [{ item_id: pt.id, qty: 1 }] }), { status: 409 });

  const k = store.kitchenOrders().find((o) => o.id === order_id);
  assert.equal(k.items[0].item_name, 'Paneer Tikka');
  assert.equal(k.items[0].unit_price_at_order, 28_000, 'price is the snapshot, not the new menu price');
  store.advanceOrder(order_id, { from: 'New' });
  store.advanceOrder(order_id, { from: 'Preparing' });
  store.advanceOrder(order_id, { from: 'Ready' });
  assert.equal(store.closeTable(2).subtotal_paise, 56_000);
});

test('lifecycle advances one step at a time and double taps are rejected', () => {
  const { store, item } = setup();
  const { order_id } = store.placeOrder(1, { items: [{ item_id: item('Masala Chai').id, qty: 1 }] });
  assert.equal(store.advanceOrder(order_id, { from: 'New' }).status, 'Preparing');
  assert.throws(() => store.advanceOrder(order_id, { from: 'New' }), { status: 409 });
  assert.equal(store.advanceOrder(order_id, { from: 'Preparing' }).status, 'Ready');
  assert.equal(store.advanceOrder(order_id, { from: 'Ready' }).status, 'Served');
  assert.throws(() => store.advanceOrder(order_id, { from: 'Served' }), { status: 409 });
  assert.equal(store.kitchenOrders().length, 0, 'served orders leave the kitchen screen');
});

test('bill applies 5% GST and closing frees the table', () => {
  const { store, item, db } = setup();
  const { order_id } = store.placeOrder(4, { items: [
    { item_id: item('Butter Chicken').id, qty: 1 },   // 420
    { item_id: item('Garlic Naan').id, qty: 3 },      // 240
  ] });
  assert.throws(() => store.closeTable(4), { status: 409 }, 'cannot close with unserved orders');
  for (const from of ['New', 'Preparing', 'Ready']) store.advanceOrder(order_id, { from });

  const bill = store.getTableBill(4);
  assert.deepEqual([bill.subtotal_paise, bill.gst_paise, bill.total_paise], [66_000, 3_300, 69_300]);
  store.closeTable(4);
  assert.equal(store.getTableBill(4).orders.length, 0);
  assert.equal(store.listTables().find((t) => t.id === 4).open_orders, 0);
  assert.ok(db.q('SELECT paid_at FROM orders WHERE id = ?').get(order_id).paid_at);
});

test('dashboard: revenue, prep time New→Ready, top items, hourly buckets', () => {
  const { store, item, advance } = setup();
  const bc = item('Butter Chicken'), naan = item('Butter Naan'), chai = item('Masala Chai');

  const o1 = store.placeOrder(1, { items: [{ item_id: bc.id, qty: 1 }, { item_id: naan.id, qty: 4 }] }).order_id;
  advance(2 * MIN); store.advanceOrder(o1, { from: 'New' });
  advance(8 * MIN); store.advanceOrder(o1, { from: 'Preparing' }); // ready after 10 min

  advance(60 * MIN); // 13:10
  const o2 = store.placeOrder(2, { items: [{ item_id: chai.id, qty: 2 }] }).order_id;
  advance(1 * MIN); store.advanceOrder(o2, { from: 'New' });
  advance(3 * MIN); store.advanceOrder(o2, { from: 'Preparing' }); // ready after 4 min

  const d = store.dashboard('2026-09-29');
  assert.equal(d.orders, 2);
  assert.equal(d.revenue_paise, 42_000 + 4 * 6_000 + 2 * 6_000);
  assert.equal(d.avg_prep_ms, 7 * MIN);
  assert.equal(d.top_items[0].name, 'Butter Naan');
  assert.equal(d.by_hour[12].revenue_paise, 66_000);
  assert.equal(d.by_hour[13].revenue_paise, 12_000);
  assert.equal(store.dashboard('2026-09-28').orders, 0);
});

test('every seeded dish has a picture, and the manager can change it', () => {
  const { store, item } = setup();
  assert.ok(store.getMenu().items.every((i) => i.emoji), 'all dishes have a picture');
  const chai = item('Masala Chai');
  store.saveItem(chai.id, { emoji: '🍵' });
  assert.equal(store.getMenu().items.find((i) => i.id === chai.id).emoji, '🍵');
  assert.throws(() => store.saveItem(chai.id, { emoji: 'x'.repeat(40) }), { status: 400 });
});

test('a database from before pictures existed is upgraded in place', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kds-')), 'old.db');
  const db1 = open(file);
  db1.exec("UPDATE menu_items SET emoji = ''");
  // Recreate the old table shape (no emoji column) with the same rows.
  db1.exec(`PRAGMA foreign_keys = OFF;
    CREATE TABLE old_items AS SELECT id, category_id, name, price_paise, is_veg, prep_minutes, is_available, archived_at FROM menu_items;
    DROP TABLE menu_items; ALTER TABLE old_items RENAME TO menu_items;`);
  db1.close();

  const db2 = open(file);
  const rows = db2.prepare('SELECT name, emoji FROM menu_items').all();
  assert.equal(rows.length, 18, 'no rows lost');
  assert.equal(rows.find((r) => r.name === 'Masala Chai').emoji, '☕');
  db2.close();
});

test('customer can edit and remove lines on a New order', () => {
  const { store, item } = setup();
  const { order_id } = store.placeOrder(5, { items: [{ item_id: item('Rasmalai').id, qty: 1 }] });
  const line = store.getTableBill(5).orders[0].items[0];
  store.updateOrderLine(5, line.id, { qty: 3 });
  assert.equal(store.getTableBill(5).orders[0].items[0].qty, 3);
  assert.throws(() => store.updateOrderLine(6, line.id, { qty: 1 }), { status: 404 }, 'other tables cannot edit it');
  store.updateOrderLine(5, line.id, { qty: 0 });
  assert.equal(store.getTableBill(5).orders.length, 0, 'empty order is removed');
  assert.equal(store.kitchenOrders().some((o) => o.id === order_id), false);
});
