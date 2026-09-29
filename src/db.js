'use strict';
// One SQLite file is the single source of truth for all three screens.
// Money is stored as integer paise so totals never suffer float rounding.

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS menu_categories (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS menu_items (
  id           INTEGER PRIMARY KEY,
  category_id  INTEGER NOT NULL REFERENCES menu_categories(id),
  name         TEXT    NOT NULL,
  price_paise  INTEGER NOT NULL CHECK (price_paise >= 0),
  is_veg       INTEGER NOT NULL DEFAULT 1 CHECK (is_veg IN (0, 1)),
  prep_minutes INTEGER NOT NULL DEFAULT 10 CHECK (prep_minutes >= 0),
  is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
  -- Items are archived, never deleted, so historical order_items keep a valid FK.
  archived_at  INTEGER
);

CREATE TABLE IF NOT EXISTS tables (
  id     INTEGER PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  seats  INTEGER NOT NULL DEFAULT 4
);

CREATE TABLE IF NOT EXISTS bills (
  id             INTEGER PRIMARY KEY,
  table_id       INTEGER NOT NULL REFERENCES tables(id),
  subtotal_paise INTEGER NOT NULL,
  gst_paise      INTEGER NOT NULL,
  total_paise    INTEGER NOT NULL,
  closed_at      INTEGER NOT NULL
);

-- A table is "occupied" while it has orders with paid_at IS NULL.
-- There is deliberately no separate occupied flag that could drift out of sync.
CREATE TABLE IF NOT EXISTS orders (
  id           INTEGER PRIMARY KEY,
  table_id     INTEGER NOT NULL REFERENCES tables(id),
  status       TEXT    NOT NULL DEFAULT 'New'
               CHECK (status IN ('New', 'Preparing', 'Ready', 'Served')),
  placed_at    INTEGER NOT NULL,
  preparing_at INTEGER,
  ready_at     INTEGER,
  served_at    INTEGER,
  paid_at      INTEGER,
  bill_id      INTEGER REFERENCES bills(id)
);

-- item_name and unit_price_at_order are snapshots taken when the line is added.
-- Later menu edits (price change, rename, marked unavailable) never touch them.
CREATE TABLE IF NOT EXISTS order_items (
  id                  INTEGER PRIMARY KEY,
  order_id            INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id             INTEGER NOT NULL REFERENCES menu_items(id),
  item_name           TEXT    NOT NULL,
  qty                 INTEGER NOT NULL CHECK (qty > 0),
  note                TEXT    NOT NULL DEFAULT '',
  unit_price_at_order INTEGER NOT NULL CHECK (unit_price_at_order >= 0),
  added_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_open      ON orders(table_id) WHERE paid_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_active    ON orders(status, placed_at) WHERE status <> 'Served';
CREATE INDEX IF NOT EXISTS idx_orders_placed    ON orders(placed_at);
CREATE INDEX IF NOT EXISTS idx_orders_ready     ON orders(ready_at);
CREATE INDEX IF NOT EXISTS idx_order_items_ord  ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_item ON order_items(item_id);
CREATE INDEX IF NOT EXISTS idx_bills_closed     ON bills(closed_at);
CREATE INDEX IF NOT EXISTS idx_items_category   ON menu_items(category_id);
`;

const SEED_MENU = [
  ['Starters', [
    ['Paneer Tikka', 280, 1, 15],
    ['Chicken 65', 320, 0, 15],
    ['Veg Spring Rolls', 220, 1, 10],
    ['Amritsari Fish', 380, 0, 15],
  ]],
  ['Mains', [
    ['Butter Chicken', 420, 0, 20],
    ['Paneer Butter Masala', 340, 1, 18],
    ['Dal Makhani', 280, 1, 15],
    ['Mutton Rogan Josh', 480, 0, 25],
    ['Veg Biryani', 300, 1, 20],
    ['Chicken Biryani', 380, 0, 22],
  ]],
  ['Breads', [
    ['Butter Naan', 60, 1, 5],
    ['Garlic Naan', 80, 1, 5],
    ['Tandoori Roti', 40, 1, 4],
  ]],
  ['Desserts', [
    ['Gulab Jamun', 120, 1, 3],
    ['Rasmalai', 150, 1, 3],
  ]],
  ['Beverages', [
    ['Masala Chai', 60, 1, 4],
    ['Sweet Lassi', 110, 1, 3],
    ['Fresh Lime Soda', 90, 1, 3],
  ]],
];

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  const cache = new Map();
  db.q = (sql) => {
    let stmt = cache.get(sql);
    if (!stmt) { stmt = db.prepare(sql); cache.set(sql, stmt); }
    return stmt;
  };

  // node:sqlite is synchronous and Node is single-threaded, so a transaction
  // can never interleave with another request inside this process.
  // BEGIN IMMEDIATE also guards against a second process on the same file.
  db.tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  seed(db);
  return db;
}

function seed(db) {
  if (db.q('SELECT COUNT(*) AS n FROM menu_categories').get().n > 0) return;
  db.tx(() => {
    SEED_MENU.forEach(([category, items], i) => {
      const { lastInsertRowid: catId } = db
        .q('INSERT INTO menu_categories (name, sort_order) VALUES (?, ?)')
        .run(category, i + 1);
      for (const [name, rupees, veg, prep] of items) {
        db.q(`INSERT INTO menu_items (category_id, name, price_paise, is_veg, prep_minutes)
              VALUES (?, ?, ?, ?, ?)`).run(catId, name, rupees * 100, veg, prep);
      }
    });
    for (let n = 1; n <= 12; n++) {
      db.q('INSERT INTO tables (number, seats) VALUES (?, ?)').run(n, n <= 8 ? 4 : 6);
    }
  });
}

module.exports = { open };
