# Restaurant Ordering & Kitchen Display

Three screens on one SQLite database:

| Screen | URL | Access |
|---|---|---|
| Customer (per table) | `/customer` | no login |
| Kitchen Display | `/kitchen` | Kitchen PIN (default `1234`) |
| Manager | `/manager` | Manager PIN (default `4321`) |

## Run

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`). There are **no npm dependencies**, so there's nothing to install.

```bash
npm start              # http://localhost:3000
npm run demo           # optional: fill today with ~25 finished orders for the dashboard
npm test               # business-rule tests (in-memory DB)
```

Environment variables: `PORT`, `KITCHEN_PIN`, `MANAGER_PIN`, `DB_FILE` (default `data/restaurant.db`).
The server prints its LAN address so tablets and phones on the same Wi-Fi can open the screens.

## Project layout

```
server.js           HTTP server: JSON API, PIN auth, Server-Sent Events, static files
src/db.js           schema, indexes, seed menu, transaction helper
src/store.js        all business rules and dashboard queries
public/             customer / kitchen / manager pages (vanilla JS, one stylesheet)
scripts/seed-demo.js
test/store.test.js
```

## How the evaluation points are handled

### One source of truth
Every screen reads and writes the same SQLite file through the same `store.js` functions. There is no
client-side state the server trusts: carts live in the browser only until *Place order*, and every rule
(availability, locking, status order, closing) is enforced server-side.
Derived state is never stored twice. For example, a table is "occupied" exactly when it has orders with
`paid_at IS NULL`. There's no separate flag to drift out of sync.

### Live sync
* Every successful write bumps a version counter and pushes `event: change` over **Server-Sent Events**
  (`/api/events`) to every open screen. The event carries only the version and topics (`orders`, `menu`, `tables`),
  never data, so clients refetch through the normal API. That leaves one read path, and the stream needs no auth.
* If the stream drops, the client **falls back to polling** `/api/version` every 3 s and switches back when the
  stream reconnects. After a reconnect or when a tab wakes up, the client refreshes everything in case it missed
  a change. The badge in each header shows `Live` or `polling`.
* Measured locally: order placed → kitchen notified in about **15 ms** (requirement: under 5 s).
* Kitchen timers tick locally every second, using a server-clock offset read from the `X-Server-Now` header,
  so a tablet with a wrong clock still shows the correct minutes.
* Kitchen taps send `{ from: "<status on the card>" }`. If two screens tap the same card, the second one gets a
  `409` instead of skipping a status.

### Price snapshotting
`order_items` stores `unit_price_at_order` **and** `item_name` when a line is added. Bills, the kitchen and the
dashboard read only these snapshot columns, so changing a price, renaming a dish, marking it unavailable or
removing it from the menu (soft delete, `archived_at`) never changes an existing order. Money is integer paise,
and GST is `round(subtotal × 5 / 100)`.

### Business rules
* **Add to an open order:** new items join the table's latest order while it is still `New`. Once the kitchen
  moves it to `Preparing`, it is locked (`409` on edit), and further items start a new order on the same bill.
* **Unavailable items** are rejected server-side with a `409` listing the items. The customer cart flags them
  live. Orders already placed with them are unaffected.
* **Prep time** = `ready_at − placed_at` (New → Ready). It is shown on the ticket and feeds the dashboard average.
* **Close table** is allowed only when every open order is `Served`. It writes a `bills` row and stamps
  `paid_at` + `bill_id` on the orders in one transaction, which frees the table.

### Dashboard queries (`store.dashboard`)
All queries filter on indexed timestamps for the chosen local day (`[start, end)`, DST-safe):
* **Revenue / orders:** `SUM(qty × unit_price_at_order)` and `COUNT(DISTINCT order)` for orders placed that day
  (net of GST). **Collected** comes from `bills` (incl. GST).
* **Average prep time:** `AVG(ready_at − placed_at)` over orders that became ready that day.
* **Top 5:** grouped by `item_id` (a rename doesn't split an item in two), ordered by quantity, then revenue.
* **Revenue by hour:** `strftime('%H', placed_at/1000, 'unixepoch', 'localtime')` buckets, zero-filled to 24 hours.
* Order lines are loaded for many orders in one `IN (…)` query, so there are no N+1 queries.

### Stretch goals
* ✅ Server push (SSE, one-way push, which is all this app needs) instead of polling, with polling as fallback
* ✅ Kitchen sound alert on a new order or on items added to a New order (Web Audio, toggle in the header)
* ⬜ Split bill by item: not built

## API summary

```
GET  /api/events                     SSE stream (change notifications)
GET  /api/version
POST /api/login {role, pin}          -> {token}
GET  /api/menu | /api/tables | /api/tables/:id/bill
POST /api/tables/:id/orders {items:[{item_id, qty, note}]}
PATCH /api/tables/:id/lines/:lineId {qty}           (only while order is New)
GET  /api/kitchen/orders                            [kitchen]
POST /api/orders/:id/advance {from}                 [kitchen]
GET  /api/admin/dashboard?date=YYYY-MM-DD           [manager]
POST /api/admin/tables/:id/close                    [manager]
POST|PUT|DELETE /api/admin/categories[/:id]         [manager]
POST|PUT|DELETE /api/admin/items[/:id]              [manager]
POST /api/admin/tables {number, seats}              [manager]
```
