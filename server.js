'use strict';
// Local / single-server mode: `npm start`.
// Serves the pages, the JSON API (src/app.js) and Server-Sent Events for instant push.
// Uses the SQLite file in data/ unless DATABASE_URL points at Postgres.
// (On Vercel the same API runs as a function instead: see api/index.js.)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { sqliteDb, postgresDb } = require('./src/sql');
const { createApi } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'restaurant.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

function createApp({ db, now, tz, pins } = {}) {
  db = db || (process.env.DATABASE_URL ? postgresDb(process.env.DATABASE_URL) : sqliteDb(DB_FILE));

  // ---------- live sync (push) ----------
  // Every successful write pushes the new version to every open screen at once.
  // Events carry no data, only "something changed": clients refetch through the
  // normal API, so there is exactly one read path and the database stays the only
  // source of truth. Clients fall back to polling /api/version if the stream drops.
  const streams = new Set();
  const api = createApi(db, {
    push: true, now, tz, pins,
    onWrite: async () => {
      const version = await api.store.version();
      const msg = `event: change\ndata: ${JSON.stringify({ version })}\n\n`;
      for (const res of streams) res.write(msg);
    },
  });

  const heartbeat = setInterval(() => {
    for (const res of streams) res.write(': ping\n\n');
  }, 15000);
  heartbeat.unref();

  async function openStream(req, res) {
    await api.ensureReady();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ version: await api.store.version() })}\n\n`);
    streams.add(res);
    req.on('close', () => streams.delete(res));
  }

  // ---------- static files ----------
  const TYPES = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.png': 'image/png', '.json': 'application/json',
  };

  function serveStatic(req, res, url) {
    // Clean URLs, same as vercel.json: /customer -> customer.html
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    if (!path.extname(rel)) rel += '.html';
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  }

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/events') {
      return void openStream(req, res).catch(() => { res.writeHead(500); res.end(); });
    }
    if (url.pathname.startsWith('/api/')) return void api.handle(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, url);
  });

  server.on('close', () => { clearInterval(heartbeat); for (const r of streams) r.end(); db.close(); });
  return { server, api, db };
}

if (require.main === module) {
  const { server, api } = createApp();
  api.ensureReady().then(() => server.listen(PORT, () => {
    const lan = Object.values(os.networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log(`\nRestaurant app running (${process.env.DATABASE_URL ? 'Postgres' : 'SQLite ' + DB_FILE}):`);
    console.log(`  http://localhost:${PORT}`);
    for (const ip of lan) console.log(`  http://${ip}:${PORT}   (tablets/phones on the same Wi-Fi)`);
    console.log(`\n  Kitchen PIN: ${api.pins.kitchen === '1234' ? '1234 (default, set KITCHEN_PIN)' : 'from KITCHEN_PIN'}`);
    console.log(`  Manager PIN: ${api.pins.manager === '4321' ? '4321 (default, set MANAGER_PIN)' : 'from MANAGER_PIN'}\n`);
  })).catch((err) => { console.error('Could not open the database:', err); process.exit(1); });
}

module.exports = { createApp };
