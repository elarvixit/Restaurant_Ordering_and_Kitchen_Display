'use strict';
// The JSON API, shared by the local server (server.js) and the Vercel function (api/index.js).
// Stateless on purpose: logins are signed tokens and the live-sync counter lives in the
// database, so any number of server instances can answer any request.

const crypto = require('node:crypto');
const { setup } = require('./schema');
const { createStore, HttpError } = require('./store');
const { systemStatus } = require('./status');

// Database connection problems, explained without echoing the connection string or password.
// Covers the usual Supabase mistakes, so a broken DATABASE_URL is fixable without digging in logs.
function connectionHint(err) {
  const code = err && (err.code || (err.cause && err.cause.code));
  const msg = String((err && err.message) || '');
  if (code === '28P01' || /password authentication failed/i.test(msg)) {
    return 'Database password rejected: check the password in DATABASE_URL (no [ ] around it).';
  }
  if (/tenant or user not found/i.test(msg)) {
    return 'Database user not found: in DATABASE_URL the user must be postgres.<project-ref>, as in the Transaction pooler string.';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Database host not found: check the host name in DATABASE_URL.';
  if (['ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNREFUSED'].includes(code) || /timeout/i.test(msg)) {
    return 'Cannot reach the database: use the Transaction pooler string (port 6543), not the direct db.*.supabase.co one.';
  }
  if (code === '3D000') return 'Database name not found: DATABASE_URL should end in /postgres.';
  if (/invalid url|searchParams|Invalid URL/i.test(msg) || code === 'ERR_INVALID_URL') {
    return 'DATABASE_URL is not a valid postgresql:// address (a password with @ # / ? characters must be URL-encoded).';
  }
  return null;
}

function createApi(db, { pins, push = false, onWrite = () => {}, now, tz, secret } = {}) {
  const store = createStore(db, { now, tz });
  pins = pins || {
    kitchen: process.env.KITCHEN_PIN || '1234',
    manager: process.env.MANAGER_PIN || '4321',
  };

  // Schema + seed once per process (per cold start on Vercel); retried if it fails.
  let ready = null;
  const ensureReady = () => (ready ??= setup(db).catch((err) => { ready = null; throw err; }));

  // ---------- PIN sessions: signed, expiring tokens (no server memory needed) ----------
  const SESSION_MS = 12 * 60 * 60 * 1000;
  // Derived from the PINs when SESSION_SECRET is unset, so changing a PIN logs everyone out.
  const key = secret || process.env.SESSION_SECRET
    || crypto.createHash('sha256').update(`kds|${pins.kitchen}|${pins.manager}|${process.env.DATABASE_URL || ''}`).digest();
  const sign = (payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');

  function issueToken(role) {
    const payload = Buffer.from(`${role}.${Date.now() + SESSION_MS}`).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }

  function roleOf(req) {
    const m = /^Bearer ([\w-]+)\.([\w-]+)$/.exec(req.headers.authorization || '');
    if (!m) return null;
    const expected = Buffer.from(sign(m[1]));
    const given = Buffer.from(m[2]);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    const [role, exp] = Buffer.from(m[1], 'base64url').toString().split('.');
    return Object.hasOwn(pins, role) && Number(exp) > Date.now() ? role : null;
  }

  const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

  async function login(req, body) {
    const ip = clientIp(req);
    if (await store.loginBlocked(ip)) throw new HttpError(429, 'Too many wrong PINs. Try again in a minute.');
    const role = body.role;
    if (!Object.hasOwn(pins, role)) throw new HttpError(400, 'Unknown role');
    const given = Buffer.from(String(body.pin ?? ''));
    const expected = Buffer.from(pins[role]);
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    await store.recordLogin(ip, ok);
    if (!ok) throw new HttpError(401, 'Wrong PIN');
    return { token: issueToken(role), role };
  }

  // Manager can do anything the kitchen can.
  const KITCHEN = ['kitchen', 'manager'];
  const MANAGER = ['manager'];

  // [method, pattern, allowed roles (null = public), handler, is a write]
  const W = true;
  const routes = [
    ['GET', /^\/api\/version$/, null, async () => ({ version: await store.version(), push })],
    ['POST', /^\/api\/login$/, null, ({ req, body }) => login(req, body)],
    ['GET', /^\/api\/session$/, null, ({ role }) => ({ role })],

    // Customer (no login)
    ['GET', /^\/api\/menu$/, null, () => store.getMenu()],
    ['GET', /^\/api\/tables$/, null, () => store.listTables()],
    ['GET', /^\/api\/tables\/(\d+)\/bill$/, null, ({ p }) => store.getTableBill(+p[1])],
    ['POST', /^\/api\/tables\/(\d+)\/orders$/, null, ({ p, body }) => store.placeOrder(+p[1], body), W],
    ['PATCH', /^\/api\/tables\/(\d+)\/lines\/(\d+)$/, null, ({ p, body }) => store.updateOrderLine(+p[1], +p[2], body), W],

    // Kitchen
    ['GET', /^\/api\/kitchen\/orders$/, KITCHEN, () => store.kitchenOrders()],
    ['POST', /^\/api\/orders\/(\d+)\/advance$/, KITCHEN, ({ p, body }) => store.advanceOrder(+p[1], body), W],

    // Manager
    ['GET', /^\/api\/admin\/dashboard$/, MANAGER, ({ url }) => store.dashboard(url.searchParams.get('date'))],
    ['GET', /^\/api\/admin\/status$/, MANAGER, () => systemStatus(db, { pins, push })],
    ['POST', /^\/api\/admin\/tables$/, MANAGER, ({ body }) => store.addTable(body), W],
    ['POST', /^\/api\/admin\/tables\/(\d+)\/close$/, MANAGER, ({ p }) => store.closeTable(+p[1]), W],
    ['POST', /^\/api\/admin\/categories$/, MANAGER, ({ body }) => store.saveCategory(null, body), W],
    ['PUT', /^\/api\/admin\/categories\/(\d+)$/, MANAGER, ({ p, body }) => store.saveCategory(+p[1], body), W],
    ['DELETE', /^\/api\/admin\/categories\/(\d+)$/, MANAGER, ({ p }) => store.archiveCategory(+p[1]), W],
    ['POST', /^\/api\/admin\/items$/, MANAGER, ({ body }) => store.saveItem(null, body), W],
    ['PUT', /^\/api\/admin\/items\/(\d+)$/, MANAGER, ({ p, body }) => store.saveItem(+p[1], body), W],
    ['DELETE', /^\/api\/admin\/items\/(\d+)$/, MANAGER, ({ p }) => store.archiveItem(+p[1]), W],
  ];

  async function readBody(req) {
    // Vercel's Node runtime may have parsed the body already.
    if (req.body !== undefined) {
      if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
      const s = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
      try { return s ? JSON.parse(s) : {}; } catch { throw new HttpError(400, 'Body must be valid JSON'); }
    }
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) throw new HttpError(413, 'Request body too large');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return v && typeof v === 'object' ? v : {};
    } catch { throw new HttpError(400, 'Body must be valid JSON'); }
  }

  function sendJson(res, status, data) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Server-Now': String(Date.now()),
    });
    res.end(JSON.stringify(data));
  }

  // Handles one /api request. `pathname` lets a caller pass the real path when a
  // platform rewrite changed req.url.
  async function handle(req, res, pathname) {
    const url = new URL(req.url, 'http://localhost');
    const path = pathname || url.pathname;
    let pathMatched = false;
    for (const [method, pattern, roles, handler, isWrite] of routes) {
      const p = pattern.exec(path);
      if (!p) continue;
      pathMatched = true;
      if (method !== req.method) continue;
      try {
        await ensureReady();
        const role = roleOf(req);
        if (roles && !roles.includes(role)) {
          throw new HttpError(role ? 403 : 401, role ? 'Not allowed for this role' : 'PIN required');
        }
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
        const result = await handler({ req, url, p, body, role });
        sendJson(res, 200, result);
        if (isWrite) onWrite();
        return;
      } catch (err) {
        if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...(err.details || {}) });
        console.error(err);
        const hint = connectionHint(err);
        if (hint) return sendJson(res, 503, { error: hint });
        return sendJson(res, 500, { error: 'Something went wrong on the server' });
      }
    }
    sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? 'Method not allowed' : 'Not found' });
  }

  return { handle, store, ensureReady, pins };
}

module.exports = { createApi, connectionHint };
