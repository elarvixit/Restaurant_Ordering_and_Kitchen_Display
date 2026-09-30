'use strict';
// System status for the manager's /status page: deployment, database, settings and tables.
// Never returns a secret: settings report only whether they are set (and look right), and the
// database address is shown as host and port only, without the user name or password.

const { NAMES, T } = require('./tables');
const { DEFAULT_TZ } = require('./time');

const DEFAULT_PINS = { kitchen: '1234', manager: '4321' };

function databaseAddress() {
  const raw = (process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return { scheme: u.protocol.replace(':', ''), host: u.hostname, port: u.port || '5432', database: u.pathname.replace('/', '') };
  } catch {
    return { scheme: raw.split(':')[0], host: '(not a valid address)', port: '', database: '' };
  }
}

// One entry per setting: ok = true (good), false (problem), null (optional, using the default).
function settings(pins) {
  const addr = databaseAddress();
  const which = process.env.DATABASE_URL ? 'DATABASE_URL' : process.env.POSTGRES_URL ? 'POSTGRES_URL' : null;
  const db = !addr
    ? { ok: process.env.VERCEL ? false : null, detail: process.env.VERCEL ? 'Not set: the API cannot reach Supabase' : 'Not set: using the local SQLite file' }
    : !/^postgres(ql)?$/.test(addr.scheme)
      ? { ok: false, detail: `Starts with ${addr.scheme}:// but must be postgresql://` }
      : process.env.VERCEL && addr.port !== '6543'
        ? { ok: false, detail: `Port ${addr.port}: use the Transaction pooler (port 6543) on Vercel` }
        : { ok: true, detail: `Set${which === 'POSTGRES_URL' ? ' (as POSTGRES_URL)' : ''}: ${addr.host}:${addr.port}` };
  const pin = (role) => pins[role] === DEFAULT_PINS[role]
    ? { ok: false, detail: `Not set: using the default PIN ${DEFAULT_PINS[role]}, which anyone can guess` }
    : { ok: true, detail: `Set (${pins[role].length} digits, value hidden)` };
  const secret = process.env.SESSION_SECRET;
  return [
    { name: 'DATABASE_URL', required: true, ...db },
    { name: 'KITCHEN_PIN', required: true, ...pin('kitchen') },
    { name: 'MANAGER_PIN', required: true, ...pin('manager') },
    {
      name: 'SESSION_SECRET', required: false,
      ...(!secret ? { ok: null, detail: 'Not set: logins are signed with a key made from the PINs' }
        : secret.length < 24 ? { ok: false, detail: `Set but short (${secret.length} characters): use 32 or more` }
          : { ok: true, detail: `Set (${secret.length} characters, value hidden)` }),
    },
    {
      name: 'RESTAURANT_TZ', required: false,
      ...(process.env.RESTAURANT_TZ ? { ok: true, detail: process.env.RESTAURANT_TZ } : { ok: null, detail: `Not set: using ${DEFAULT_TZ}` }),
    },
  ];
}

async function timed(fn) {
  const t0 = process.hrtime.bigint();
  const value = await fn();
  return { value, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

async function systemStatus(db, { pins, push }) {
  const pg = db.dialect === 'postgres';
  const addr = databaseAddress();

  const ping = await timed(() => db.query('SELECT 1 AS ok'));
  const [ver] = await db.query(pg ? 'SELECT version() AS v' : 'SELECT sqlite_version() AS v');
  const state = Object.fromEntries((await db.query(`SELECT name, num FROM ${T.app_state}`)).map((r) => [r.name, Number(r.num)]));

  const rls = pg
    ? new Map((await db.query(`SELECT relname, relrowsecurity FROM pg_class
                                WHERE relkind = 'r' AND relname = ANY($1)
                                  AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`,
      [Object.values(NAMES)])).map((r) => [r.relname, r.relrowsecurity]))
    : null;
  const tables = [];
  for (const [base, name] of Object.entries(NAMES)) {
    const [{ n }] = await db.query(`SELECT COUNT(*) AS n FROM ${T[base]}`);
    tables.push({ name, rows: Number(n), rls: rls ? !!rls.get(name) : null });
  }

  const [open] = await db.query(`SELECT COUNT(*) AS orders, COUNT(DISTINCT table_id) AS tables
                                 FROM ${T.orders} WHERE paid_at IS NULL`);
  const [kitchen] = await db.query(`SELECT COUNT(*) AS n FROM ${T.orders} WHERE status <> 'Served'`);
  const [menu] = await db.query(`SELECT COUNT(*) AS items, COALESCE(SUM(is_available), 0) AS available
                                 FROM ${T.menu_items} WHERE archived_at IS NULL`);

  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  return {
    checked_at: Date.now(),
    deployment: {
      platform: process.env.VERCEL ? 'Vercel' : 'Local server',
      environment: process.env.VERCEL_ENV || (process.env.VERCEL ? 'unknown' : 'development'),
      region: process.env.VERCEL_REGION || null,
      url: process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || null,
      commit: sha ? { sha: sha.slice(0, 7), message: (process.env.VERCEL_GIT_COMMIT_MESSAGE || '').split('\n')[0], branch: process.env.VERCEL_GIT_COMMIT_REF || null } : null,
      node: process.version,
      live_sync: push ? 'Instant push (Server-Sent Events)' : 'Polling every 2 seconds',
    },
    database: {
      connected: true,
      engine: pg ? (addr && /supabase\.com$/.test(addr.host) ? 'Supabase Postgres' : 'Postgres') : 'SQLite (local file)',
      server_version: pg ? String(ver.v).split(' on ')[0] : `SQLite ${ver.v}`,
      host: addr && pg ? `${addr.host}:${addr.port}` : null,
      pooler: addr ? (addr.port === '6543' ? 'Transaction pooler' : addr.port === '5432' && /pooler/.test(addr.host) ? 'Session pooler' : 'Direct') : null,
      latency_ms: Math.round(ping.ms * 10) / 10,
      schema_version: state.schema ?? null,
      live_version: state.version ?? null,
    },
    settings: settings(pins),
    tables,
    activity: {
      open_orders: Number(open.orders),
      occupied_tables: Number(open.tables),
      kitchen_queue: Number(kitchen.n),
      menu_items: Number(menu.items),
      menu_available: Number(menu.available),
    },
  };
}

module.exports = { systemStatus, settings };
