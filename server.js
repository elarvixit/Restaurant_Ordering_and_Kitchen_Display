'use strict';
// Zero-dependency HTTP server: JSON API + Server-Sent Events + static files.
// Run with `npm start` (Node 22.13+ for the built-in node:sqlite module).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { open } = require('./src/db');
const { createStore, HttpError } = require('./src/store');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'restaurant.db');
const PINS = {
  kitchen: process.env.KITCHEN_PIN || '1234',
  manager: process.env.MANAGER_PIN || '4321',
};
const PUBLIC_DIR = path.join(__dirname, 'public');

function createApp({ dbFile = DB_FILE, now } = {}) {
  const db = open(dbFile);
  const store = createStore(db, { now });

  // ---------- live sync ----------
  // Every successful write bumps `version` and pushes it to every open screen.
  // Events carry no data, only "something changed": clients refetch through the
  // normal API, so there is exactly one read path and the database stays the only
  // source of truth. Clients fall back to polling /api/version if the stream drops.
  let version = Date.now();
  const streams = new Set();

  function broadcast(topics) {
    version += 1;
    const msg = `event: change\ndata: ${JSON.stringify({ version, topics })}\n\n`;
    for (const res of streams) res.write(msg);
  }

  const heartbeat = setInterval(() => {
    for (const res of streams) res.write(': ping\n\n');
  }, 15000);
  heartbeat.unref();

  function openStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ version })}\n\n`);
    streams.add(res);
    req.on('close', () => streams.delete(res));
  }

  // ---------- PIN auth ----------
  const sessions = new Map(); // token -> { role, expires }
  const failures = new Map(); // ip -> { count, until }
  const SESSION_MS = 12 * 60 * 60 * 1000;

  function login(req, body) {
    const ip = req.socket.remoteAddress;
    const f = failures.get(ip);
    if (f && f.until > Date.now()) throw new HttpError(429, 'Too many wrong PINs. Try again in a minute.');
    const role = body.role;
    if (!Object.hasOwn(PINS, role)) throw new HttpError(400, 'Unknown role');
    const given = Buffer.from(String(body.pin ?? ''));
    const expected = Buffer.from(PINS[role]);
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) {
      const count = (f?.count ?? 0) + 1;
      failures.set(ip, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
      throw new HttpError(401, 'Wrong PIN');
    }
    failures.delete(ip);
    const token = crypto.randomBytes(24).toString('base64url');
    sessions.set(token, { role, expires: Date.now() + SESSION_MS });
    return { token, role };
  }

  function roleOf(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const s = m && sessions.get(m[1]);
    if (!s) return null;
    if (s.expires < Date.now()) { sessions.delete(m[1]); return null; }
    return s.role;
  }

  // Manager can do anything the kitchen can.
  const KITCHEN = ['kitchen', 'manager'];
  const MANAGER = ['manager'];

  // ---------- routes ----------
  // [method, pattern, allowed roles (null = public), handler, topics broadcast on success]
  const routes = [
    ['GET', /^\/api\/version$/, null, () => ({ version })],
    ['POST', /^\/api\/login$/, null, ({ req, body }) => login(req, body)],
    ['GET', /^\/api\/session$/, null, ({ role }) => ({ role })],

    // Customer (no login)
    ['GET', /^\/api\/menu$/, null, () => store.getMenu()],
    ['GET', /^\/api\/tables$/, null, () => store.listTables()],
    ['GET', /^\/api\/tables\/(\d+)\/bill$/, null, ({ p }) => store.getTableBill(+p[1])],
    ['POST', /^\/api\/tables\/(\d+)\/orders$/, null, ({ p, body }) => store.placeOrder(+p[1], body), ['orders']],
    ['PATCH', /^\/api\/tables\/(\d+)\/lines\/(\d+)$/, null, ({ p, body }) => store.updateOrderLine(+p[1], +p[2], body), ['orders']],

    // Kitchen
    ['GET', /^\/api\/kitchen\/orders$/, KITCHEN, () => store.kitchenOrders()],
    ['POST', /^\/api\/orders\/(\d+)\/advance$/, KITCHEN, ({ p, body }) => store.advanceOrder(+p[1], body), ['orders']],

    // Manager
    ['GET', /^\/api\/admin\/dashboard$/, MANAGER, ({ url }) => store.dashboard(url.searchParams.get('date'))],
    ['POST', /^\/api\/admin\/tables$/, MANAGER, ({ body }) => store.addTable(body), ['tables']],
    ['POST', /^\/api\/admin\/tables\/(\d+)\/close$/, MANAGER, ({ p }) => store.closeTable(+p[1]), ['orders', 'tables']],
    ['POST', /^\/api\/admin\/categories$/, MANAGER, ({ body }) => store.saveCategory(null, body), ['menu']],
    ['PUT', /^\/api\/admin\/categories\/(\d+)$/, MANAGER, ({ p, body }) => store.saveCategory(+p[1], body), ['menu']],
    ['DELETE', /^\/api\/admin\/categories\/(\d+)$/, MANAGER, ({ p }) => store.archiveCategory(+p[1]), ['menu']],
    ['POST', /^\/api\/admin\/items$/, MANAGER, ({ body }) => store.saveItem(null, body), ['menu']],
    ['PUT', /^\/api\/admin\/items\/(\d+)$/, MANAGER, ({ p, body }) => store.saveItem(+p[1], body), ['menu']],
    ['DELETE', /^\/api\/admin\/items\/(\d+)$/, MANAGER, ({ p }) => store.archiveItem(+p[1]), ['menu']],
  ];

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 64 * 1024) { reject(new HttpError(413, 'Request body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(v && typeof v === 'object' ? v : {});
        } catch { reject(new HttpError(400, 'Body must be valid JSON')); }
      });
      req.on('error', reject);
    });
  }

  function sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Server-Now': String(Date.now()),
    });
    res.end(body);
  }

  async function handleApi(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/events') return openStream(req, res);
    let pathMatched = false;
    for (const [method, pattern, roles, handler, topics] of routes) {
      const p = pattern.exec(url.pathname);
      if (!p) continue;
      pathMatched = true;
      if (method !== req.method) continue;
      try {
        const role = roleOf(req);
        if (roles && !roles.includes(role)) {
          throw new HttpError(role ? 403 : 401, role ? 'Not allowed for this role' : 'PIN required');
        }
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
        const result = handler({ req, url, p, body, role });
        if (topics) broadcast(topics);
        return sendJson(res, 200, result);
      } catch (err) {
        if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...(err.details || {}) });
        console.error(err);
        return sendJson(res, 500, { error: 'Something went wrong on the server' });
      }
    }
    return sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? 'Method not allowed' : 'Not found' });
  }

  const TYPES = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.png': 'image/png', '.json': 'application/json',
  };
  const PAGES = { '/': 'index.html', '/customer': 'customer.html', '/kitchen': 'kitchen.html', '/manager': 'manager.html' };

  function serveStatic(req, res, url) {
    let rel = PAGES[url.pathname] ?? decodeURIComponent(url.pathname).replace(/^\/+/, '');
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
    if (url.pathname.startsWith('/api/')) return void handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, url);
  });

  server.on('close', () => { clearInterval(heartbeat); for (const r of streams) r.end(); db.close(); });
  return { server, store, db, broadcast };
}

if (require.main === module) {
  const { server } = createApp();
  server.listen(PORT, () => {
    const lan = Object.values(os.networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log(`\nRestaurant app running:`);
    console.log(`  http://localhost:${PORT}`);
    for (const ip of lan) console.log(`  http://${ip}:${PORT}   (tablets/phones on the same Wi-Fi)`);
    console.log(`\n  Kitchen PIN: ${PINS.kitchen === '1234' ? '1234 (default, set KITCHEN_PIN)' : 'from KITCHEN_PIN'}`);
    console.log(`  Manager PIN: ${PINS.manager === '4321' ? '4321 (default, set MANAGER_PIN)' : 'from MANAGER_PIN'}\n`);
  });
}

module.exports = { createApp };
