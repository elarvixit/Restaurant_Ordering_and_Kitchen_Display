'use strict';
// Domain logic. Every screen goes through these functions, and every business
// rule is enforced here on the server, never only in the browser.

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

function billTotals(subtotal) {
  const gst = Math.round((subtotal * GST_RATE_PERCENT) / 100);
  return { subtotal_paise: subtotal, gst_paise: gst, total_paise: subtotal + gst, gst_rate_percent: GST_RATE_PERCENT };
}

function createStore(db, { now = () => Date.now() } = {}) {
  // ---------- menu ----------

  function getMenu() {
    const categories = db.q(`
      SELECT id, name, sort_order FROM menu_categories
      WHERE archived_at IS NULL ORDER BY sort_order, name`).all();
    const items = db.q(`
      SELECT id, category_id, name, price_paise, is_veg, prep_minutes, is_available
      FROM menu_items WHERE archived_at IS NULL ORDER BY name`).all();
    return { categories, items };
  }

  function saveCategory(id, body) {
    const name = text(body.name, 'Category name', { max: 40 });
    const sort = body.sort_order === undefined ? null : int(body.sort_order, 'Sort order', { min: 0, max: 999 });
    if (id == null) {
      const nextSort = sort ?? db.q('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM menu_categories').get().n;
      return { id: Number(db.q('INSERT INTO menu_categories (name, sort_order) VALUES (?, ?)').run(name, nextSort).lastInsertRowid) };
    }
    const r = db.q(`UPDATE menu_categories SET name = ?, sort_order = COALESCE(?, sort_order)
                    WHERE id = ? AND archived_at IS NULL`).run(name, sort, id);
    if (!r.changes) throw notFound('Category not found');
    return { id };
  }

  function archiveCategory(id) {
    const live = db.q('SELECT COUNT(*) AS n FROM menu_items WHERE category_id = ? AND archived_at IS NULL').get(id).n;
    if (live > 0) throw conflict(`Move or delete the ${live} item(s) in this category first`);
    const r = db.q('UPDATE menu_categories SET archived_at = ? WHERE id = ? AND archived_at IS NULL').run(now(), id);
    if (!r.changes) throw notFound('Category not found');
    return { id };
  }

  function readItemBody(body, existing = {}) {
    const merged = { ...existing, ...body };
    const categoryId = int(merged.category_id, 'Category', { min: 1 });
    const cat = db.q('SELECT id FROM menu_categories WHERE id = ? AND archived_at IS NULL').get(categoryId);
    if (!cat) throw bad('Category does not exist');
    return {
      category_id: categoryId,
      name: text(merged.name, 'Item name', { max: 60 }),
      price_paise: int(merged.price_paise, 'Price (paise)', { min: 0, max: 10_000_000 }),
      is_veg: bool(merged.is_veg),
      prep_minutes: int(merged.prep_minutes, 'Prep time', { min: 0, max: 240 }),
      is_available: merged.is_available === undefined ? 1 : bool(merged.is_available),
    };
  }

  function saveItem(id, body) {
    if (id == null) {
      const v = readItemBody(body);
      const r = db.q(`INSERT INTO menu_items (category_id, name, price_paise, is_veg, prep_minutes, is_available)
                      VALUES (?, ?, ?, ?, ?, ?)`)
        .run(v.category_id, v.name, v.price_paise, v.is_veg, v.prep_minutes, v.is_available);
      return { id: Number(r.lastInsertRowid) };
    }
    const existing = db.q('SELECT * FROM menu_items WHERE id = ? AND archived_at IS NULL').get(id);
    if (!existing) throw notFound('Item not found');
    const v = readItemBody(body, existing);
    // Only the menu row changes. Placed orders keep their own name/price snapshot.
    db.q(`UPDATE menu_items SET category_id = ?, name = ?, price_paise = ?, is_veg = ?, prep_minutes = ?, is_available = ?
          WHERE id = ?`).run(v.category_id, v.name, v.price_paise, v.is_veg, v.prep_minutes, v.is_available, id);
    return { id };
  }

  function archiveItem(id) {
    const r = db.q('UPDATE menu_items SET archived_at = ?, is_available = 0 WHERE id = ? AND archived_at IS NULL').run(now(), id);
    if (!r.changes) throw notFound('Item not found');
    return { id };
  }

  // ---------- tables & orders ----------

  function requireTable(tableId) {
    const t = db.q('SELECT id, number, seats FROM tables WHERE id = ?').get(tableId);
    if (!t) throw notFound('Table not found');
    return t;
  }

  function listTables() {
    return db.q(`
      SELECT t.id, t.number, t.seats,
             COUNT(DISTINCT o.id)                                   AS open_orders,
             COALESCE(SUM(oi.qty * oi.unit_price_at_order), 0)      AS open_subtotal_paise,
             MIN(o.placed_at)                                       AS first_order_at,
             COUNT(DISTINCT CASE WHEN o.status <> 'Served' THEN o.id END) AS unserved_orders
      FROM tables t
      LEFT JOIN orders o       ON o.table_id = t.id AND o.paid_at IS NULL
      LEFT JOIN order_items oi ON oi.order_id = o.id
      GROUP BY t.id
      ORDER BY t.number`).all();
  }

  function addTable(body) {
    const number = int(body.number, 'Table number', { min: 1, max: 999 });
    const seats = body.seats === undefined ? 4 : int(body.seats, 'Seats', { min: 1, max: 30 });
    if (db.q('SELECT 1 FROM tables WHERE number = ?').get(number)) throw conflict(`Table ${number} already exists`);
    return { id: Number(db.q('INSERT INTO tables (number, seats) VALUES (?, ?)').run(number, seats).lastInsertRowid) };
  }

  // Loads orders plus their lines in two queries (no N+1).
  function hydrate(orders) {
    if (!orders.length) return [];
    const ids = orders.map((o) => o.id);
    const lines = db.prepare(`
      SELECT id, order_id, item_id, item_name, qty, note, unit_price_at_order, added_at
      FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')})
      ORDER BY added_at, id`).all(...ids);
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

  function getTableBill(tableId) {
    const table = requireTable(tableId);
    const orders = hydrate(db.q(`
      SELECT ${ORDER_COLS} FROM orders o JOIN tables t ON t.id = o.table_id
      WHERE o.table_id = ? AND o.paid_at IS NULL ORDER BY o.placed_at, o.id`).all(tableId));
    const subtotal = orders.reduce((s, o) => s + o.subtotal_paise, 0);
    return {
      table,
      orders,
      ...billTotals(subtotal),
      can_close: orders.length > 0 && orders.every((o) => o.status === 'Served'),
    };
  }

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
  function placeOrder(tableId, body) {
    requireTable(tableId);
    const lines = readCartLines(body.items);

    return db.tx(() => {
      const ids = [...new Set(lines.map((l) => l.item_id))];
      const menuRows = db.prepare(`
        SELECT id, name, price_paise, is_available FROM menu_items
        WHERE archived_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      const menu = new Map(menuRows.map((m) => [m.id, m]));
      const missing = ids.filter((id) => !menu.has(id));
      if (missing.length) throw conflict('Some items are no longer on the menu', { item_ids: missing });
      const unavailable = menuRows.filter((m) => !m.is_available);
      if (unavailable.length) {
        throw conflict(`Currently unavailable: ${unavailable.map((m) => m.name).join(', ')}`, {
          item_ids: unavailable.map((m) => m.id),
        });
      }

      const t = now();
      let order = db.q(`SELECT id FROM orders WHERE table_id = ? AND paid_at IS NULL AND status = 'New'
                        ORDER BY placed_at DESC LIMIT 1`).get(tableId);
      const appended = !!order;
      if (!order) {
        order = { id: Number(db.q('INSERT INTO orders (table_id, status, placed_at) VALUES (?, \'New\', ?)').run(tableId, t).lastInsertRowid) };
      }

      for (const l of lines) {
        const m = menu.get(l.item_id);
        // Same item + same note already on this New order: bump qty instead of a duplicate line.
        // The snapshot price must match too, otherwise a mid-day price change would be merged away.
        const same = db.q(`SELECT id FROM order_items
                           WHERE order_id = ? AND item_id = ? AND note = ? AND unit_price_at_order = ?`)
          .get(order.id, m.id, l.note, m.price_paise);
        if (same) {
          db.q('UPDATE order_items SET qty = MIN(qty + ?, 99) WHERE id = ?').run(l.qty, same.id);
        } else {
          db.q(`INSERT INTO order_items (order_id, item_id, item_name, qty, note, unit_price_at_order, added_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(order.id, m.id, m.name, l.qty, l.note, m.price_paise, t);
        }
      }
      return { order_id: order.id, appended };
    });
  }

  // Customers may change quantity or remove a line only while the order is New.
  function updateOrderLine(tableId, lineId, body) {
    return db.tx(() => {
      const line = db.q(`
        SELECT oi.id, oi.order_id, o.status, o.table_id, o.paid_at
        FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id = ?`).get(lineId);
      if (!line || line.table_id !== tableId || line.paid_at != null) throw notFound('Order line not found');
      if (line.status !== 'New') {
        throw conflict(`This order is already ${line.status.toLowerCase()} and can no longer be changed`);
      }
      const qty = int(body.qty, 'Quantity', { min: 0, max: 99 });
      if (qty === 0) {
        db.q('DELETE FROM order_items WHERE id = ?').run(lineId);
        const left = db.q('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?').get(line.order_id).n;
        if (left === 0) db.q('DELETE FROM orders WHERE id = ?').run(line.order_id);
      } else {
        const note = body.note === undefined ? null : text(body.note, 'Note', { max: 140, required: false });
        db.q('UPDATE order_items SET qty = ?, note = COALESCE(?, note) WHERE id = ?').run(qty, note, lineId);
      }
      return { ok: true };
    });
  }

  function kitchenOrders() {
    return hydrate(db.q(`
      SELECT ${ORDER_COLS} FROM orders o JOIN tables t ON t.id = o.table_id
      WHERE o.status <> 'Served'
      ORDER BY o.placed_at, o.id`).all());
  }

  // `from` makes the tap idempotent: two kitchen screens tapping the same card
  // (or one double tap) advance it once, the second gets a 409.
  function advanceOrder(orderId, body) {
    const from = body.from;
    if (!STATUSES.includes(from)) throw bad('from must be the status shown on the card');
    return db.tx(() => {
      const o = db.q('SELECT id, status FROM orders WHERE id = ?').get(orderId);
      if (!o) throw notFound('Order not found');
      if (o.status !== from) throw conflict(`Order is already ${o.status}`, { status: o.status });
      const next = NEXT_STATUS[o.status];
      if (!next) throw conflict('Order is already served');
      db.prepare(`UPDATE orders SET status = ?, ${STAMP_COLUMN[next]} = ? WHERE id = ?`).run(next, now(), orderId);
      return { id: orderId, status: next };
    });
  }

  function closeTable(tableId) {
    return db.tx(() => {
      const bill = getTableBill(tableId);
      if (!bill.orders.length) throw conflict('This table has no open orders');
      const pending = bill.orders.filter((o) => o.status !== 'Served');
      if (pending.length) {
        throw conflict(`Serve all orders before closing (${pending.map((o) => `#${o.id} ${o.status}`).join(', ')})`);
      }
      const t = now();
      const billId = Number(db.q(`INSERT INTO bills (table_id, subtotal_paise, gst_paise, total_paise, closed_at)
                                  VALUES (?, ?, ?, ?, ?)`)
        .run(tableId, bill.subtotal_paise, bill.gst_paise, bill.total_paise, t).lastInsertRowid);
      db.q('UPDATE orders SET paid_at = ?, bill_id = ? WHERE table_id = ? AND paid_at IS NULL').run(t, billId, tableId);
      return { bill_id: billId, ...bill, paid_at: t };
    });
  }

  // ---------- dashboard ----------

  function dayRange(dateStr) {
    let d;
    if (dateStr) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
      if (!m) throw bad('date must be YYYY-MM-DD');
      d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    } else {
      d = new Date(now());
      d.setHours(0, 0, 0, 0);
    }
    const start = d.getTime();
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); // DST-safe
    const pad = (n) => String(n).padStart(2, '0');
    return { start, end, date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` };
  }

  // Revenue = net sales (excl. GST) of orders placed that day, at the snapshot price.
  // Hour buckets use SQLite 'localtime', the same clock as dayRange().
  function dashboard(dateStr) {
    const { start, end, date } = dayRange(dateStr);

    const sales = db.q(`
      SELECT COUNT(DISTINCT o.id)                              AS orders,
             COALESCE(SUM(oi.qty * oi.unit_price_at_order), 0) AS revenue_paise,
             COALESCE(SUM(oi.qty), 0)                          AS items_sold
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.placed_at >= ? AND o.placed_at < ?`).get(start, end);

    // Prep time is New -> Ready, counted on the day the order became ready.
    const prep = db.q(`
      SELECT COUNT(*)                   AS orders,
             AVG(ready_at - placed_at)  AS avg_ms,
             MAX(ready_at - placed_at)  AS max_ms
      FROM orders
      WHERE ready_at IS NOT NULL AND ready_at >= ? AND ready_at < ?`).get(start, end);

    const collected = db.q(`
      SELECT COUNT(*)                        AS bills,
             COALESCE(SUM(total_paise), 0)   AS total_paise,
             COALESCE(SUM(gst_paise), 0)     AS gst_paise
      FROM bills WHERE closed_at >= ? AND closed_at < ?`).get(start, end);

    // Grouped by item_id, not name, so a rename mid-day does not split an item in two.
    const topItems = db.q(`
      SELECT oi.item_id,
             COALESCE(m.name, MAX(oi.item_name))       AS name,
             m.is_veg                                  AS is_veg,
             SUM(oi.qty)                               AS qty,
             SUM(oi.qty * oi.unit_price_at_order)      AS revenue_paise
      FROM order_items oi
      JOIN orders o          ON o.id = oi.order_id
      LEFT JOIN menu_items m ON m.id = oi.item_id
      WHERE o.placed_at >= ? AND o.placed_at < ?
      GROUP BY oi.item_id
      ORDER BY qty DESC, revenue_paise DESC, name
      LIMIT 5`).all(start, end);

    const hourRows = db.q(`
      SELECT CAST(strftime('%H', o.placed_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
             COUNT(DISTINCT o.id)                   AS orders,
             SUM(oi.qty * oi.unit_price_at_order)   AS revenue_paise
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.placed_at >= ? AND o.placed_at < ?
      GROUP BY hour
      ORDER BY hour`).all(start, end);
    const byHourMap = new Map(hourRows.map((r) => [r.hour, r]));
    const byHour = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      orders: byHourMap.get(h)?.orders ?? 0,
      revenue_paise: byHourMap.get(h)?.revenue_paise ?? 0,
    }));

    const live = db.q(`
      SELECT status, COUNT(*) AS n FROM orders WHERE status <> 'Served' GROUP BY status`).all();
    const openTables = db.q('SELECT COUNT(DISTINCT table_id) AS n FROM orders WHERE paid_at IS NULL').get().n;

    return {
      date,
      revenue_paise: sales.revenue_paise,
      orders: sales.orders,
      items_sold: sales.items_sold,
      avg_order_paise: sales.orders ? Math.round(sales.revenue_paise / sales.orders) : 0,
      avg_prep_ms: prep.avg_ms == null ? null : Math.round(prep.avg_ms),
      max_prep_ms: prep.max_ms,
      prepped_orders: prep.orders,
      collected,
      top_items: topItems,
      by_hour: byHour,
      live: Object.fromEntries(['New', 'Preparing', 'Ready'].map((s) => [s, live.find((r) => r.status === s)?.n ?? 0])),
      open_tables: openTables,
    };
  }

  return {
    getMenu, saveCategory, archiveCategory, saveItem, archiveItem,
    listTables, addTable, getTableBill, placeOrder, updateOrderLine,
    kitchenOrders, advanceOrder, closeTable, dashboard,
  };
}

module.exports = { createStore, HttpError, billTotals, GST_RATE_PERCENT };
