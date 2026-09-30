# Restaurant Ordering & Kitchen Display

Three screens on one database: SQLite on your own machine, Postgres (Supabase) when deployed on Vercel.

| Screen | URL | Access |
|---|---|---|
| Customer (per table) | `/customer` | no login |
| Kitchen Display | `/kitchen` | Kitchen PIN (default `1234`) |
| Manager | `/manager` | Manager PIN (default `4321`) |
| System status | `/status` | Manager PIN: database connection, environment variables (never their values), every table with row counts and row level security, deployment and screen checks |

## Run

Requires **Node.js 22.13+** (uses the built-in `node:sqlite` locally).

```bash
npm install            # pg driver (Supabase on Vercel) + PGlite (tests only)
npm start              # http://localhost:3000, SQLite file in data/
npm run demo           # optional: fill today with ~25 finished orders for the dashboard
npm test               # 30 tests; the business rules run on both SQLite and Postgres (PGlite)
```

**Screen options:**
* **Veg / Non-veg filter** on the customer menu (All · Veg · Non-veg, with item counts). Category tabs show only
  the categories that have matching dishes, and the device remembers the choice.
* **Dish pictures:** every menu item has a mini picture (an emoji on a gradient tile tinted by category), shown on
  the menu, in the add dialog, cart, orders, best sellers and the menu editor. The manager picks or types it in the
  item dialog (`menu_items.emoji`; older databases are upgraded automatically on start).
* **Hover effects and animations:** cards lift on hover, pictures tilt, a dish flies into the cart when added,
  menu cards slide in, kitchen tickets slide into their new column, and dashboard numbers count up with growing bars.
  Everything is switched off for users whose system asks for reduced motion.
* **Light / dark theme** button on every screen, including the PIN screens. Each screen remembers its own choice.
  The kitchen starts dark, and the others follow the device's system setting until you pick one.

Environment variables: `PORT`, `KITCHEN_PIN`, `MANAGER_PIN`, `DB_FILE` (default `data/restaurant.db`),
`DATABASE_URL` (use Postgres instead of SQLite), `RESTAURANT_TZ` (default `Asia/Kolkata`: sets what "today" and each
hour mean on the dashboard), `SESSION_SECRET` (signs PIN logins; derived from the PINs if unset).
The server prints its LAN address so tablets and phones on the same Wi-Fi can open the screens.

## Deploy on Vercel

The pages are served from `public/` and every `/api/*` request runs the Vercel Function `api/index.js`
(the rewrite is in `vercel.json`; `.vercelignore` keeps the local `server.js` out). The database is **Supabase**.
Every table starts with `babji_RestaurantKitchen_` (names in `src/tables.js`), so the app can share a Supabase
project with other apps.

1. **Create the tables:** in Supabase open **SQL Editor → New query**, paste all of
   [`supabase/schema.sql`](supabase/schema.sql) and click **Run**. It creates the 8 tables, their indexes, row level
   security (blocks Supabase's public REST API from these tables) and the starting menu and 12 tables. It is safe to run
   again. (The app would also create them on its first request, but running the script lets you check them first.)
2. **Get the connection string:** in Supabase click **Connect → Transaction pooler** (port **6543**) and copy the
   URI, replacing `[YOUR-PASSWORD]` with the database password.
3. In Vercel **Settings → Environment Variables** add `DATABASE_URL` (that URI), `KITCHEN_PIN` and `MANAGER_PIN`
   (your own PINs) and `SESSION_SECRET` (any long random text), for all environments.
4. **Deployments → ⋯ → Redeploy** (or push any commit).
5. Optional demo data: locally run `$env:DATABASE_URL="postgresql://..."; npm run demo` (PowerShell).

Querying the tables yourself: the names contain capital letters, so quote them:
`SELECT * FROM "babji_RestaurantKitchen_orders";`

Differences from running locally: live sync polls `/api/version` every 2 s instead of instant push (orders reach
the kitchen in about 2 s; the requirement is 5 s). Everything else is identical, because both use the same code.

## Automatic push to GitHub

Every code change is committed and pushed to `origin/main` without anyone running git:

| Trigger | What runs |
|---|---|
| Any file saved in the project (by anyone, in any editor) | `scripts/watch-and-push.ps1` waits until nothing has changed for 15 s, then runs `scripts/auto-push.ps1` |
| End of each Claude Code turn | Stop hook in `.claude/settings.json` runs `scripts/auto-push.ps1` |
| A manual `git commit` | `.git/hooks/post-commit` pushes it |

The watcher starts at Windows login via the Startup-folder shortcut `Restaurant KDS auto-push.lnk`, runs hidden
and logs to `.git/auto-push.log`. It ignores `.git/`, `data/` and `node_modules/`, and retries a failed push every
5 minutes. To stop it, end the hidden `powershell` process running `watch-and-push.ps1` in Task Manager and delete
the shortcut from `shell:startup`.

## Project layout

```
server.js           local server: static pages, the API, Server-Sent Events push (npm start)
api/index.js        Vercel Function: the same API, on Supabase Postgres
supabase/schema.sql the SQL to run once in Supabase's SQL editor
vercel.json         clean URLs (/customer) and the /api/* -> function rewrite
src/app.js          the JSON API: routes, roles, signed PIN tokens, lockout
src/store.js        all business rules and dashboard queries (same SQL on SQLite and Postgres)
src/sql.js          database adapters: SQLite (local), Supabase Postgres (Vercel), PGlite (tests)
src/tables.js       every table name (babji_RestaurantKitchen_ prefix)
src/schema.js       tables, indexes, upgrades of older databases, seed menu
src/status.js       the /status report (no secret values ever leave the server)
src/time.js         restaurant time zone: "today" and hour buckets
public/             customer / kitchen / manager pages (vanilla JS, one stylesheet)
scripts/            demo data, auto-push to GitHub
test/               business rules on both engines + HTTP/auth tests
```

## How the evaluation points are handled

### One source of truth
Every screen reads and writes the same database (one SQLite file locally, one Postgres database on Vercel) through
the same `store.js` functions. There is no
client-side state the server trusts: carts live in the browser only until *Place order*, and every rule
(availability, locking, status order, closing) is enforced server-side.
Derived state is never stored twice. For example, a table is "occupied" exactly when it has orders with
`paid_at IS NULL`. There's no separate flag to drift out of sync.

### Live sync
* Every write runs in one transaction that also bumps a **version counter stored in the database**, so no screen
  can see the new version before the data behind it is committed. Screens refetch only when the version moves.
* **Locally** the server pushes each new version over **Server-Sent Events** (`/api/events`). The event carries no
  data, so clients refetch through the normal API: one read path, and the stream needs no auth. If the stream drops,
  the client polls `/api/version` every 3 s until it reconnects. Measured: order → kitchen in about **15 ms**.
* **On Vercel** each request may hit a different short-lived function, so none can hold a push connection per
  screen. `/api/version` reports `push: false` and screens poll it every 2 s (a single tiny query).
  Measured on a Postgres simulation of the deployment: order → kitchen in **1.75 s**.
* After a reconnect, or when a sleeping tab wakes up, the client refreshes everything in case it missed a change.
  The badge in each header shows `Live`, `Reconnecting…` or `Offline`.
* Kitchen timers tick locally every second, using a server-clock offset read from the `X-Server-Now` header,
  so a tablet with a wrong clock still shows the correct minutes.
* Kitchen taps send `{ from: "<status on the card>" }` and run as one atomic
  `UPDATE … WHERE id = ? AND status = from`. If two screens tap the same card, even on different servers, the
  second gets a `409` instead of skipping a status. Concurrent orders for one table lock that table's row.
* PIN logins are **signed, expiring tokens** (HMAC), not server memory, so any server instance can check them.
  Five wrong PINs lock logins for a minute, and that counter is in the database too.

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
All queries filter on indexed timestamps for the chosen day in the restaurant's time zone (`[start, end)`,
DST-safe, `src/time.js`). Vercel runs in UTC, so this matters:
* **Revenue / orders:** `SUM(qty × unit_price_at_order)` and `COUNT(DISTINCT order)` for orders placed that day
  (net of GST). **Collected** comes from `bills` (incl. GST).
* **Average prep time:** `AVG(ready_at − placed_at)` over orders that became ready that day.
* **Top 5:** grouped by `item_id` (a rename doesn't split an item in two), ordered by quantity, then revenue.
* **Revenue by hour:** `((placed_at + zone offset) / 3600000) % 24` buckets, integer maths that runs unchanged on
  SQLite and Postgres, zero-filled to 24 hours.
* Order lines are loaded for many orders in one `IN (…)` query, so there are no N+1 queries.

### Stretch goals
* ✅ Server push (SSE, one-way push, which is all this app needs) when self-hosted, with polling as fallback;
  2-second polling on Vercel, where serverless functions can't hold push connections
* ✅ Kitchen sound alert on a new order or on items added to a New order (Web Audio, toggle in the header)
* ⬜ Split bill by item: not built

## API summary

```
GET  /api/events                     SSE stream (change notifications; local server only)
GET  /api/version                    {version, push}
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
