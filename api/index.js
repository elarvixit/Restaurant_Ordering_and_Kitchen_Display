'use strict';
// Vercel Function: every /api/* request is rewritten here (see vercel.json).
// Same API as the local server, backed by Supabase Postgres: DATABASE_URL (set by hand) or
// POSTGRES_URL (set by Vercel's Supabase integration). Pages are served by Vercel from public/.
// Tables are babji_RestaurantKitchen_*, see supabase/schema.sql.
//
// Live sync on Vercel: functions can't hold one push connection per screen, so
// /api/version reports push:false and screens poll it every 2 seconds instead.

const { postgresDb } = require('../src/sql');
const { createApi } = require('../src/app');

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
// Created once per function instance and reused across requests.
module.exports = makeHandler(url ? createApi(postgresDb(url), { push: false }) : null);
module.exports.makeHandler = makeHandler;
