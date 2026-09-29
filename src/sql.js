'use strict';
// One small async database interface, three engines:
//   sqlite   - local file via Node's built-in node:sqlite (npm start)
//   postgres - any Postgres via DATABASE_URL / POSTGRES_URL: Neon (its serverless driver)
//              or Supabase / self-hosted (the standard pg driver), chosen from the address
//   pglite   - in-process Postgres, used by the tests to prove the Postgres SQL
//
// Every engine exposes:
//   query(sql, params) -> rows       SQL uses $1, $2 ... placeholders in all engines
//   exec(sql)                        run a multi-statement script (schema)
//   tx(async (t) => ...)             transaction; t has t.query and t.forUpdate
//   dialect, forUpdate, close()
// forUpdate is ' FOR UPDATE' on Postgres (row lock inside a transaction) and ''
// on SQLite, where transactions are already serialized.

const fs = require('node:fs');
const path = require('node:path');

const clean = (params = []) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));

function sqliteDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');

  const cache = new Map();
  const run = (sql, params) => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = raw.prepare(sql.replace(/\$(\d+)/g, '?$1')); // SQLite numbered params: ?1, ?2
      cache.set(sql, stmt);
    }
    return stmt.all(...clean(params));
  };

  // node:sqlite is synchronous, but the store is async: without this queue another
  // request could slip a statement into an open transaction between two awaits.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };

  const t = { dialect: 'sqlite', forUpdate: '', query: async (sql, params) => run(sql, params) };
  return {
    dialect: 'sqlite',
    forUpdate: '',
    query: (sql, params) => serial(() => run(sql, params)),
    exec: (sql) => serial(() => raw.exec(sql)),
    tx: (fn) => serial(async () => {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(t);
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    }),
    close: async () => raw.close(),
  };
}

// Neon's driver speaks to Neon's WebSocket proxy only; everything else gets node-postgres.
function makePool(connectionString) {
  const host = (() => { try { return new URL(connectionString).hostname; } catch { return ''; } })();
  if (/\.neon\.tech$/.test(host)) {
    const { Pool, neonConfig, types } = require('@neondatabase/serverless');
    if (globalThis.WebSocket) neonConfig.webSocketConstructor = globalThis.WebSocket;
    // BIGINT (timestamps in ms, COUNT, SUM) and NUMERIC (AVG) arrive as strings by default.
    types.setTypeParser(20, Number);
    types.setTypeParser(1700, Number);
    return new Pool({ connectionString, max: 5 });
  }
  const { Pool, types } = require('pg');
  types.setTypeParser(20, Number);
  types.setTypeParser(1700, Number);
  const local = ['localhost', '127.0.0.1', '::1', ''].includes(host);
  // Hosted Postgres (Supabase) needs TLS. Its certificates are signed by the provider's own CA,
  // which Node doesn't ship, so the connection is encrypted without CA verification. sslmode is
  // removed from the URL because pg would otherwise insist on full verification.
  const url = connectionString.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
  return new Pool({ connectionString: url, max: 3, ssl: local ? false : { rejectUnauthorized: false } });
}

function postgresDb(connectionString) {
  const pool = makePool(connectionString);

  const wrap = (client) => ({
    dialect: 'postgres',
    forUpdate: ' FOR UPDATE',
    query: async (sql, params) => (await client.query(sql, clean(params))).rows,
  });
  return {
    ...wrap(pool),
    exec: async (sql) => { await pool.query(sql); },
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function pgliteDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite({ parsers: { 20: Number, 1700: Number } });
  const wrap = (client) => ({
    dialect: 'postgres',
    forUpdate: ' FOR UPDATE',
    query: async (sql, params) => (await client.query(sql, clean(params))).rows,
  });
  return {
    ...wrap(pg),
    exec: async (sql) => { await pg.exec(sql); },
    tx: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    close: () => pg.close(),
  };
}

module.exports = { sqliteDb, postgresDb, pgliteDb };
