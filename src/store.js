'use strict';
// Domain logic. Every screen goes through these functions, and every business
// rule is enforced here on the server, never only in the browser.
// Runs unchanged on SQLite (local) and Postgres (Vercel): see src/sql.js.

const { DEFAULT_TZ, dayRange } = require('./time');
const { T } = require('./tables');

// The database stores money in rupees (NUMERIC, e.g. 480.00). The code and the API work in whole
// paise so GST and totals are exact integer maths: amounts are converted only at the SQL boundary.
const paise = (expr) => `CAST(ROUND((${expr}) * 100) AS BIGINT)`;
const rupees = (p) => p / 100;

const GST_RATE_PERCENT = 5;
const STATUSES = ['New', 'Preparing', 'Ready', 'Served'];
const NEXT_STATUS = { New: 'Preparing', Preparing: 'Ready', Ready: 'Served' };
const STAMP_COLUMN = { Preparing: 'preparing_at', Ready: 'ready_at', Served: 'served_at' };

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const bad = (msg, details) => new HttpError(400, msg, details);
const notFound = (msg) => new HttpError(404, msg);
const conflict = (msg, details) => new HttpError(409, msg, details);

function int(value, name, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw bad(`${name} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

function text(value, name, { max = 80, required = true } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (required && !s) throw bad(`${name} is required`);
  if (s.length > max) throw bad(`${name} must be at most ${max} characters`);
  return s;
}

function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

// "$1, $2, ..." for an IN (...) list, starting at placeholder number `from`.
const list = (n, from = 1) => Array.from({ length: n }, (_, i) => `$${from + i}`).join(', ');

function billTotals(subtotal) {
  const gst = Math.round((subtotal * GST_RATE_PERCENT) / 100);
  return { subtotal_paise: subtotal, gst_paise: gst, total_paise: subtotal + gst, gst_rate_percent: GST_RATE_PERCENT };
}

function createStore(db, { now = () => Date.now(), tz = DEFAULT_TZ } = {}) {
  // Every write runs through here: one transaction that also bumps the live-sync counter,
  // so a screen never sees the new version before the data behind it is committed.
  const write = (fn) => db.tx(async (t) => {
    const result = await fn(t);
    await t.query(`UPDATE ${T.app_state} SET num = num + 1 WHERE name = 'version'`);
    return result;
  });

  async function version() {
    const [row] = await db.query(`SELECT num FROM ${T.app_state} WHERE name = 'version'`);
    return row ? Number(row.num) : 0;
  }

  // ---------- menu ----------

  async function getMenu() {
    const categories = await db.query(`
      SELECT id, name, sort_order FROM ${T.menu_categories}
      WHERE archived_at IS NULL ORDER BY sort_order, name`);
    const items = await db.query(`
      SELECT id, category_id, name, ${paise('price')} AS price_paise, is_veg, prep_minutes, is_available, emoji, photo
      FROM ${T.menu_items} WHERE archived_at IS NULL ORDER BY name`);
    return { categories, items };
  }

  async function saveCategory(id, body) {
    const name = text(body.name, 'Category name', { max: 40 });
    const sort = body.sort_order === undefined ? null : int(body.sort_order, 'Sort order', { min: 0, max: 999 });
    return write(async (t) => {
      if (id == null) {
        const [{ n }] = await t.query(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM ${T.menu_categories}`);
        const [row] = await t.query(`INSERT INTO ${T.menu_categories} (name, sort_order) VALUES ($1, $2) RETURNING id`, [name, sort ?? Number(n)]);
        return { id: row.id };
      }
      const rows = await t.query(`UPDATE ${T.menu_categories} SET name = $1, sort_order = COALESCE($2, sort_order)
                                  WHERE id = $3 AND archived_at IS NULL RETURNING id`, [name, sort, id]);
      if (!rows.length) throw notFound('Category not found');
      return { id };
    });
  }

  function archiveCategory(id) {
    return write(async (t) => {
      const [{ n }] = await t.query(`SELECT COUNT(*) AS n FROM ${T.menu_items} WHERE category_id = $1 AND archived_at IS NULL`, [id]);
      if (Number(n) > 0) throw conflict(`Move or delete the ${n} item(s) in this category first`);
      const rows = await t.query(`UPDATE ${T.menu_categories} SET archived_at = $1 WHERE id = $2 AND archived_at IS NULL RETURNING id`, [now(), id]);
      if (!rows.length) throw notFound('Category not found');
      return { id };
    });
  }

  async function readItemBody(t, body, existing = {}) {
    const merged = { ...existing, ...body };
    const categoryId = int(merged.category_id, 'Category', { min: 1 });
    const [cat] = await t.query(`SELECT id FROM ${T.menu_categories} WHERE id = $1 AND archived_at IS NULL`, [categoryId]);
    if (!cat) throw bad('Category does not exist');
    return {
      category_id: categoryId,
      name: text(merged.name, 'Item name', { max: 60 }),
      price_paise: int(merged.price_paise, 'Price (paise)', { min: 0, max: 10_000_000 }),
      is_veg: bool(merged.is_veg),
      prep_minutes: int(merged.prep_minutes, 'Prep time', { min: 0, max: 240 }),
      is_available: merged.is_available === undefined ? 1 : bool(merged.is_available),
      emoji: text(merged.emoji, 'Picture', { max: 16, required: false }),
    };
  }

  function saveItem(id, body) {
    return write(async (t) => {
      if (id == null) {
        const v = await readItemBody(t, body);
        const [row] = await t.query(`
          INSERT INTO ${T.menu_items} (category_id, name, price, is_veg, prep_minutes, is_available, emoji)
          VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [v.category_id, v.name, rupees(v.price_paise), v.is_veg, v.prep_minutes, v.is_available, v.emoji]);
        return { id: row.id };
      }
      const [existing] = await t.query(`SELECT *, ${paise('price')} AS price_paise FROM ${T.menu_items} WHERE id = $1 AND archived_at IS NULL${t.forUpdate}`, [id]);
      if (!existing) throw notFound('Item not found');
      const v = await readItemBody(t, body, existing);
      // Only the menu row changes. Placed orders keep their own name/price snapshot.
      await t.query(`
        UPDATE ${T.menu_items} SET category_id = $1, name = $2, price = $3, is_veg = $4,
               prep_minutes = $5, is_available = $6, emoji = $7
        WHERE id = $8`, [v.category_id, v.name, rupees(v.price_paise), v.is_veg, v.prep_minutes, v.is_available, v.emoji, id]);
      return { id };
    });
  }

  function archiveItem(id) {
    return write(async (t) => {
      const rows = await t.query(`UPDATE ${T.menu_items} SET archived_at = $1, is_available = 0
                                  WHERE id = $2 AND archived_at IS NULL RETURNING id`, [now(), id]);
      if (!rows.length) throw notFound('Item not found');
      return { id };
    });
  }

  // ---------- tables & orders ----------

  async function requireTable(q, tableId, lock = '') {
    const [t] = await q.query(`SELECT id, number, seats FROM ${T.tables} WHERE id = $1${lock}`, [tableId]);
    if (!t) throw notFound('Table not found');
    return t;
  }

  async function listTables() {
    return db.query(`
      SELECT t.id, t.number, t.seats,
             COUNT(DISTINCT o.id)                                          AS open_orders,
             ${paise('COALESCE(SUM(oi.qty * oi.unit_price_at_order), 0)')} AS open_subtotal_paise,
             MIN(o.placed_at)                                              AS first_order_at,
             COUNT(DISTINCT CASE WHEN o.status <> 'Served' THEN o.id END)  AS unserved_orders
      FROM ${T.tables} t
      LEFT JOIN ${T.orders} o       ON o.table_id = t.id AND o.paid_at IS NULL
      LEFT JOIN ${T.order_items} oi ON oi.order_id = o.id
      GROUP BY t.id, t.number, t.seats
      ORDER BY t.number`);
  }

  async function addTable(body) {
    const number = int(body.number, 'Table number', { min: 1, max: 999 });
    const seats = body.seats === undefined ? 4 : int(body.seats, 'Seats', { min: 1, max: 30 });
    return write(async (t) => {
      const [dupe] = await t.query(`SELECT 1 AS x FROM ${T.tables} WHERE number = $1`, [number]);
      if (dupe) throw conflict(`Table ${number} already exists`);
      const [row] = await t.query(`INSERT INTO ${T.tables} (number, seats) VALUES ($1, $2) RETURNING id`, [number, seats]);
      return { id: row.id };
    });
  }

  // Loads orders plus their lines in two queries (no N+1).
  async function hydrate(q, orders) {
    if (!orders.length) return [];
    const ids = orders.map((o) => o.id);
    const lines = await q.query(`
      SELECT id, order_id, item_id, item_name, qty, note, ${paise('unit_price_at_order')} AS unit_price_at_order, added_at
      FROM ${T.order_items} WHERE order_id IN (${list(ids.length)})
      ORDER BY added_at, id`, ids);
    const byOrder = new Map(ids.map((id) => [id, []]));
    for (const l of lines) byOrder.get(l.order_id).push(l);
    return orders.map((o) => {
      const items = byOrder.get(o.id);
      const subtotal = items.reduce((s, l) => s + l.qty * l.unit_price_at_order, 0);
      return {
        ...o,
        items,
        subtotal_paise: subtotal,
        editable: o.status === 'New' && o.paid_at == null,
        prep_ms: o.ready_at != null ? o.ready_at - o.placed_at : null,
      };
    });
  }

  const ORDER_COLS = `o.id, o.table_id, t.number AS table_number, o.status, o.placed_at,
                      o.preparing_at, o.ready_at, o.served_at, o.paid_at`;

  async function billFor(q, tableId) {
    const table = await requireTable(q, tableId);
    const orders = await hydrate(q, await q.query(`
      SELECT ${ORDER_COLS} FROM ${T.orders} o JOIN ${T.tables} t ON t.id = o.table_id
      WHERE o.table_id = $1 AND o.paid_at IS NULL ORDER BY o.placed_at, o.id`, [tableId]));
    const subtotal = orders.reduce((s, o) => s + o.subtotal_paise, 0);
    return {
      table,
      orders,
      ...billTotals(subtotal),
      can_close: orders.length > 0 && orders.every((o) => o.status === 'Served'),
    };
  }

  const getTableBill = (tableId) => billFor(db, tableId);

  function readCartLines(items) {
    if (!Array.isArray(items) || items.length === 0) throw bad('Cart is empty');
    if (items.length > 50) throw bad('Too many lines in one order');
    return items.map((l, i) => ({
      item_id: int(l.item_id, `Line ${i + 1} item`, { min: 1 }),
      qty: int(l.qty, `Line ${i + 1} quantity`, { min: 1, max: 50 }),
      note: text(l.note, 'Note', { max: 140, required: false }),
    }));
  }

  // Business rule: new items join the table's open order while it is still "New".
  // Once the kitchen has started it (Preparing or later), it is locked and the
  // items go on a fresh order for the same table (same bill).
  async function placeOrder(tableId, body) {
    const lines = readCartLines(body.items);
    return write(async (t) => {
      // Locking the table row serializes two phones ordering for the same table at once.
      await requireTable(t, tableId, t.forUpdate);
      const ids = [...new Set(lines.map((l) => l.item_id))];
      const menuRows = await t.query(`
        SELECT id, name, ${paise('price')} AS price_paise, is_available FROM ${T.menu_items}
        WHERE archived_at IS NULL AND id IN (${list(ids.length)})`, ids);
      const menu = new Map(menuRows.map((m) => [m.id, m]));
      const missing = ids.filter((id) => !menu.has(id));
      if (missing.length) throw conflict('Some items are no longer on the menu', { item_ids: missing });
      const unavailable = menuRows.filter((m) => !m.is_available);
      if (unavailable.length) {
        throw conflict(`Currently unavailable: ${unavailable.map((m) => m.name).join(', ')}`, {
          item_ids: unavailable.map((m) => m.id),
        });
      }

      const stamp = now();
      let [order] = await t.query(`SELECT id FROM ${T.orders} WHERE table_id = $1 AND paid_at IS NULL AND status = 'New'
                                   ORDER BY placed_at DESC LIMIT 1`, [tableId]);
      const appended = !!order;
      if (!order) {
        [order] = await t.query(`INSERT INTO ${T.orders} (table_id, status, placed_at) VALUES ($1, 'New', $2) RETURNING id`, [tableId, stamp]);
      }

      for (const l of lines) {
        const m = menu.get(l.item_id);
        // Same item + same note already on this New order: bump qty instead of a duplicate line.
        // The snapshot price must match too, otherwise a mid-day price change would be merged away.
        const [same] = await t.query(`SELECT id, qty FROM ${T.order_items}
                                      WHERE order_id = $1 AND item_id = $2 AND note = $3 AND ${paise('unit_price_at_order')} = $4`,
          [order.id, m.id, l.note, m.price_paise]);
        if (same) {
          await t.query(`UPDATE ${T.order_items} SET qty = $1 WHERE id = $2`, [Math.min(same.qty + l.qty, 99), same.id]);
        } else {
          await t.query(`INSERT INTO ${T.order_items} (order_id, item_id, item_name, qty, note, unit_price_at_order, added_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)`, [order.id, m.id, m.name, l.qty, l.note, rupees(m.price_paise), stamp]);
        }
      }
      return { order_id: order.id, appended };
    });
  }

  // Customers may change quantity or remove a line only while the order is New.
  async function updateOrderLine(tableId, lineId, body) {
    const qty = int(body.qty, 'Quantity', { min: 0, max: 99 });
    const note = body.note === undefined ? null : text(body.note, 'Note', { max: 140, required: false });
    return write(async (t) => {
      // Lock the order so the kitchen can't start it halfway through this edit.
      const [line] = await t.query(`
        SELECT oi.id, oi.order_id, o.status, o.table_id, o.paid_at
        FROM ${T.order_items} oi JOIN ${T.orders} o ON o.id = oi.order_id WHERE oi.id = $1${t.forUpdate}`, [lineId]);
      if (!line || line.table_id !== tableId || line.paid_at != null) throw notFound('Order line not found');
      if (line.status !== 'New') {
        throw conflict(`This order is already ${line.status.toLowerCase()} and can no longer be changed`);
      }
      if (qty === 0) {
        await t.query(`DELETE FROM ${T.order_items} WHERE id = $1`, [lineId]);
        const [{ n }] = await t.query(`SELECT COUNT(*) AS n FROM ${T.order_items} WHERE order_id = $1`, [line.order_id]);
        if (Number(n) === 0) await t.query(`DELETE FROM ${T.orders} WHERE id = $1`, [line.order_id]);
      } else {
        await t.query(`UPDATE ${T.order_items} SET qty = $1, note = COALESCE($2, note) WHERE id = $3`, [qty, note, lineId]);
      }
      return { ok: true };
    });
  }

  async function kitchenOrders() {
    return hydrate(db, await db.query(`
      SELECT ${ORDER_COLS} FROM ${T.orders} o JOIN ${T.tables} t ON t.id = o.table_id
      WHERE o.status <> 'Served'
      ORDER BY o.placed_at, o.id`));
  }

  // `from` makes the tap idempotent: two kitchen screens tapping the same card
  // (or one double tap) advance it once, the second gets a 409. The check and the
  // change are one UPDATE, so it holds even with many servers.
  async function advanceOrder(orderId, body) {
    const from = body.from;
    if (!STATUSES.includes(from)) throw bad('from must be the status shown on the card');
    const next = NEXT_STATUS[from];
    if (!next) throw conflict('Order is already served');
    return write(async (t) => {
      const rows = await t.query(`UPDATE ${T.orders} SET status = $1, ${STAMP_COLUMN[next]} = $2
                                  WHERE id = $3 AND status = $4 RETURNING id`, [next, now(), orderId, from]);
      if (rows.length) return { id: orderId, status: next };
      const [o] = await t.query(`SELECT status FROM ${T.orders} WHERE id = $1`, [orderId]);
      if (!o) throw notFound('Order not found');
      throw conflict(`Order is already ${o.status}`, { status: o.status });
    });
  }

  function closeTable(tableId) {
    return write(async (t) => {
      await requireTable(t, tableId, t.forUpdate);
      const bill = await billFor(t, tableId);
      if (!bill.orders.length) throw conflict('This table has no open orders');
      const pending = bill.orders.filter((o) => o.status !== 'Served');
      if (pending.length) {
        throw conflict(`Serve all orders before closing (${pending.map((o) => `#${o.id} ${o.status}`).join(', ')})`);
      }
      const stamp = now();
      const [{ id: billId }] = await t.query(`
        INSERT INTO ${T.bills} (table_id, subtotal, gst, total, closed_at)
        VALUES ($1, $2, $3, $4, $5) RETURNING id`, [tableId, rupees(bill.subtotal_paise), rupees(bill.gst_paise), rupees(bill.total_paise), stamp]);
      await t.query(`UPDATE ${T.orders} SET paid_at = $1, bill_id = $2 WHERE table_id = $3 AND paid_at IS NULL`, [stamp, billId, tableId]);
      return { bill_id: billId, ...bill, paid_at: stamp };
    });
  }

  // ---------- dashboard ----------

  // Revenue = net sales (excl. GST) of orders placed that day, at the snapshot price.
  // "That day" and the hour buckets follow the restaurant's time zone (tz), not the server's.
  async function dashboard(dateStr) {
    const range = dayRange(tz, dateStr || null, now());
    if (!range) throw bad('date must be YYYY-MM-DD');
    const { start, end, date, offset } = range;

    const [sales] = await db.query(`
      SELECT COUNT(DISTINCT o.id)                              AS orders,
             ${paise('COALESCE(SUM(oi.qty * oi.unit_price_at_order), 0)')} AS revenue_paise,
             COALESCE(SUM(oi.qty), 0)                          AS items_sold
      FROM ${T.orders} o JOIN ${T.order_items} oi ON oi.order_id = o.id
      WHERE o.placed_at >= $1 AND o.placed_at < $2`, [start, end]);

    // Prep time is New -> Ready, counted on the day the order became ready.
    const [prep] = await db.query(`
      SELECT COUNT(*)                   AS orders,
             AVG(ready_at - placed_at)  AS avg_ms,
             MAX(ready_at - placed_at)  AS max_ms
      FROM ${T.orders}
      WHERE ready_at IS NOT NULL AND ready_at >= $1 AND ready_at < $2`, [start, end]);

    const [collected] = await db.query(`
      SELECT COUNT(*)                        AS bills,
             ${paise('COALESCE(SUM(total), 0)')} AS total_paise,
             ${paise('COALESCE(SUM(gst), 0)')} AS gst_paise
      FROM ${T.bills} WHERE closed_at >= $1 AND closed_at < $2`, [start, end]);

    // Grouped by item_id, not name, so a rename mid-day does not split an item in two.
    const topItems = await db.query(`
      SELECT oi.item_id,
             COALESCE(m.name, MAX(oi.item_name))       AS name,
             m.is_veg                                  AS is_veg,
             m.emoji                                   AS emoji,
             m.photo                                   AS photo,
             m.category_id                             AS category_id,
             SUM(oi.qty)                               AS qty,
             ${paise('SUM(oi.qty * oi.unit_price_at_order)')} AS revenue_paise
      FROM ${T.order_items} oi
      JOIN ${T.orders} o          ON o.id = oi.order_id
      LEFT JOIN ${T.menu_items} m ON m.id = oi.item_id
      WHERE o.placed_at >= $1 AND o.placed_at < $2
      GROUP BY oi.item_id, m.name, m.is_veg, m.emoji, m.photo, m.category_id
      ORDER BY qty DESC, revenue_paise DESC, name
      LIMIT 5`, [start, end]);

    // Local hour = floor((utc ms + zone offset) / 1 h) mod 24; integer maths, same SQL on both engines.
    const hourRows = await db.query(`
      SELECT ((o.placed_at + $3) / 3600000) % 24     AS hour,
             COUNT(DISTINCT o.id)                   AS orders,
             ${paise('SUM(oi.qty * oi.unit_price_at_order)')} AS revenue_paise
      FROM ${T.orders} o JOIN ${T.order_items} oi ON oi.order_id = o.id
      WHERE o.placed_at >= $1 AND o.placed_at < $2
      GROUP BY 1
      ORDER BY 1`, [start, end, offset]);
    const byHourMap = new Map(hourRows.map((r) => [Number(r.hour), r]));
    const byHour = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      orders: Number(byHourMap.get(h)?.orders ?? 0),
      revenue_paise: Number(byHourMap.get(h)?.revenue_paise ?? 0),
    }));

    const live = await db.query(`SELECT status, COUNT(*) AS n FROM ${T.orders} WHERE status <> 'Served' GROUP BY status`);
    const [{ n: openTables }] = await db.query(`SELECT COUNT(DISTINCT table_id) AS n FROM ${T.orders} WHERE paid_at IS NULL`);

    const orders = Number(sales.orders), revenue = Number(sales.revenue_paise);
    return {
      date,
      revenue_paise: revenue,
      orders,
      items_sold: Number(sales.items_sold),
      avg_order_paise: orders ? Math.round(revenue / orders) : 0,
      avg_prep_ms: prep.avg_ms == null ? null : Math.round(Number(prep.avg_ms)),
      max_prep_ms: prep.max_ms == null ? null : Number(prep.max_ms),
      prepped_orders: Number(prep.orders),
      collected: {
        bills: Number(collected.bills),
        total_paise: Number(collected.total_paise),
        gst_paise: Number(collected.gst_paise),
      },
      top_items: topItems.map((i) => ({ ...i, qty: Number(i.qty), revenue_paise: Number(i.revenue_paise) })),
      by_hour: byHour,
      live: Object.fromEntries(['New', 'Preparing', 'Ready'].map((s) => [s, Number(live.find((r) => r.status === s)?.n ?? 0)])),
      open_tables: Number(openTables),
    };
  }

  // ---------- PIN lockout (shared by every server instance) ----------

  async function loginBlocked(ip) {
    const [row] = await db.query(`SELECT until_at FROM ${T.login_failures} WHERE ip = $1`, [ip]);
    return !!row && Number(row.until_at) > now();
  }

  async function recordLogin(ip, ok) {
    if (ok) {
      await db.query(`DELETE FROM ${T.login_failures} WHERE ip = $1`, [ip]);
      return;
    }
    // 5 wrong PINs in a row -> locked for a minute. A failure recorded while until_at is set
    // means the lock has expired (locked attempts are refused before they get here): start over.
    await db.query(`
      INSERT INTO ${T.login_failures} (ip, failures, until_at) VALUES ($1, 1, 0)
      ON CONFLICT (ip) DO UPDATE SET
        failures = CASE WHEN ${T.login_failures}.until_at > 0 THEN 1 ELSE ${T.login_failures}.failures + 1 END,
        until_at = CASE WHEN ${T.login_failures}.until_at > 0 THEN 0
                        WHEN ${T.login_failures}.failures + 1 >= 5 THEN CAST($2 AS BIGINT)
                        ELSE 0 END`, [ip, now() + 60_000]);
  }

  return {
    version, getMenu, saveCategory, archiveCategory, saveItem, archiveItem,
    listTables, addTable, getTableBill, placeOrder, updateOrderLine,
    kitchenOrders, advanceOrder, closeTable, dashboard, loginBlocked, recordLogin,
  };
}

module.exports = { createStore, HttpError, billTotals, GST_RATE_PERCENT };
