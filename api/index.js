'use strict';
// Vercel Function: every /api/* request is rewritten here (see vercel.json).
// Same API as the local server, backed by Supabase Postgres: DATABASE_URL (set by hand) or
// POSTGRES_URL (set by Vercel's Supabase integration). Pages are served by Vercel from public/.
// Tables are babji_RestaurantKitchen_*, see supabase/schema.sql.
//
// Live sync on Vercel: functions can't hold one push connection per screen, so each write is
// announced over Supabase Realtime (WebSocket, src/realtime.js), with 2-second polling as the fallback.

const { postgresDb } = require('../src/sql');
const { createApi } = require('../src/app');
const { realtimeConfig } = require('../src/realtime');

// Builds the function handler around an API (exported so tests can run it on PGlite).
const makeHandler = (api) => async (req, res) => {
  if (!api) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      error: 'Database not connected. In Vercel set DATABASE_URL to your Supabase connection string (Transaction pooler), then redeploy.',
    }));
  }
  // The rewrite passes the original path as ?__path=...; fall back to req.url itself.
  const u = new URL(req.url, 'http://localhost');
  const rewritten = u.searchParams.get('__path');
  const pathname = rewritten != null ? `/api/${rewritten}` : u.pathname;
  return api.handle(req, res, pathname);
};

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
// Supabase shows several addresses; only the postgresql:// one is a database connection.
const notPostgres = url && !/^postgres(ql)?:\/\//i.test(url.trim());
const wrongUrl = (req, res) => {
  res.statusCode = 503;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    error: 'DATABASE_URL must start with postgresql:// (Supabase > Connect > Transaction pooler). '
      + 'An https://...supabase.co address is the Project URL for the REST API, not the database.',
  }));
};
// Created once per function instance and reused across requests.
module.exports = notPostgres ? wrongUrl : makeHandler(url ? createApi(postgresDb(url.trim()), { push: false, realtime: realtimeConfig() }) : null);
module.exports.makeHandler = makeHandler;
