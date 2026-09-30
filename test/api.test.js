'use strict';
// HTTP-level tests: PIN login, signed tokens, roles, lockout, and the Vercel-style
// stateless mode (push: false, Postgres). Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { sqliteDb, pgliteDb } = require('../src/sql');
const { createApi } = require('../src/app');

const PINS = { kitchen: '1111', manager: '2222' };

async function serve(db, opts = {}) {
  const api = createApi(db, { pins: PINS, secret: 'test-secret', ...opts });
  const server = http.createServer((req, res) => api.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, close: async () => { server.closeAllConnections(); server.close(); await db.close(); } };
}

for (const [engine, makeDb, push] of [['sqlite', async () => sqliteDb(':memory:'), true], ['postgres', () => pgliteDb(), false]]) {
  test(`[${engine}] PIN login issues a token that unlocks only its own screens`, async () => {
    const { call, close } = await serve(await makeDb(), { push });
    assert.equal((await call('/api/kitchen/orders')).status, 401);
    assert.equal((await call('/api/login', { method: 'POST', body: { role: 'kitchen', pin: '0000' } })).status, 401);

    const { body: { token } } = await call('/api/login', { method: 'POST', body: { role: 'kitchen', pin: '1111' } });
    assert.equal((await call('/api/kitchen/orders', { token })).status, 200);
    assert.equal((await call('/api/admin/dashboard', { token })).status, 403, 'kitchen cannot open the manager dashboard');
    assert.equal((await call('/api/session', { token })).body.role, 'kitchen');

    const forged = token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    assert.equal((await call('/api/kitchen/orders', { token: forged })).status, 401, 'tampered token rejected');
    await close();
  });

  test(`[${engine}] five wrong PINs lock logins for a minute`, async () => {
    const { call, close } = await serve(await makeDb(), { push });
    for (let i = 0; i < 5; i++) {
      assert.equal((await call('/api/login', { method: 'POST', body: { role: 'manager', pin: '9999' } })).status, 401);
    }
    const locked = await call('/api/login', { method: 'POST', body: { role: 'manager', pin: '2222' } });
    assert.equal(locked.status, 429, 'even the right PIN is refused while locked');
    await close();
  });

  test(`[${engine}] /api/version tells screens whether to expect push or poll`, async () => {
    const { call, close } = await serve(await makeDb(), { push });
    const v1 = await call('/api/version');
    assert.equal(v1.body.push, push);
    const menu = (await call('/api/menu')).body;
    await call('/api/tables/1/orders', { method: 'POST', body: { items: [{ item_id: menu.items[0].id, qty: 1 }] } });
    assert.equal((await call('/api/version')).body.version, v1.body.version + 1);
    await close();
  });
}

test('a token signed by one server instance is accepted by another (Vercel scale-out)', async () => {
  const db = await pgliteDb();
  const a = createApi(db, { pins: PINS, secret: 's' });
  const b = createApi(db, { pins: PINS, secret: 's' });
  const run = (api, req) => new Promise((resolve) => {
    const res = { writeHead(status) { this.status = status; }, end(s) { resolve({ status: this.status, body: JSON.parse(s) }); } };
    api.handle(req, res);
  });
  const login = await run(a, { method: 'POST', url: '/api/login', headers: {}, body: { role: 'kitchen', pin: '1111' }, socket: {} });
  const res = await run(b, { method: 'GET', url: '/api/kitchen/orders', headers: { authorization: `Bearer ${login.body.token}` }, socket: {} });
  assert.equal(res.status, 200);
  await db.close();
});

test('database connection problems get a clear message that never repeats the secret', () => {
  const { connectionHint } = require('../src/app');
  const secret = 'S3cretPass';
  const cases = [
    [{ code: '28P01', message: `password authentication failed for user "postgres" (${secret})` }, /password rejected/],
    [{ code: 'XX000', message: 'Tenant or user not found' }, /user not found/],
    [{ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND db.example' }, /host not found/],
    [{ code: 'ENETUNREACH', message: 'connect ENETUNREACH' }, /Transaction pooler/],
    [{ code: '3D000', message: 'database "x" does not exist' }, /\/postgres/],
  ];
  for (const [err, re] of cases) {
    const hint = connectionHint(err);
    assert.match(hint, re);
    assert.ok(!hint.includes(secret));
  }
  assert.equal(connectionHint(new Error('some bug')), null, 'other errors stay a plain 500');
});

test('[postgres] /api/admin/status needs the manager PIN and never shows a secret', async () => {
  const saved = { ...process.env };
  process.env.DATABASE_URL = 'postgresql://postgres.projref:TopSecretPw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres';
  process.env.SESSION_SECRET = 'a-very-long-session-secret-value-1234567890';
  try {
    const { call, close } = await serve(await pgliteDb(), { push: false });
    assert.equal((await call('/api/admin/status')).status, 401);
    const { body: { token: kitchen } } = await call('/api/login', { method: 'POST', body: { role: 'kitchen', pin: '1111' } });
    assert.equal((await call('/api/admin/status', { token: kitchen })).status, 403, 'kitchen PIN is not enough');

    const { body: { token } } = await call('/api/login', { method: 'POST', body: { role: 'manager', pin: '2222' } });
    const { status, body } = await call('/api/admin/status', { token });
    assert.equal(status, 200);
    assert.equal(body.database.connected, true);
    assert.equal(body.tables.length, 8);
    assert.ok(body.tables.every((t) => t.name.startsWith('babji_RestaurantKitchen_') && t.rls === true));
    assert.equal(body.tables.find((t) => t.name.endsWith('_menu_items')).rows, 18);
    const byName = Object.fromEntries(body.settings.map((s) => [s.name, s]));
    assert.equal(byName.DATABASE_URL.ok, true);
    assert.match(byName.DATABASE_URL.detail, /pooler\.supabase\.com:6543/);
    assert.equal(byName.KITCHEN_PIN.ok, true);
    assert.equal(byName.SESSION_SECRET.ok, true);
    const text = JSON.stringify(body);
    for (const secret of ['TopSecretPw', 'projref', 'a-very-long-session-secret', '1111', '2222', 'test-secret']) {
      assert.ok(!text.includes(secret), `status must not contain ${secret}`);
    }
    await close();
  } finally {
    process.env = saved;
  }
});

test('status flags the usual Supabase mistakes in DATABASE_URL', () => {
  const { settings } = require('../src/status');
  const saved = { ...process.env };
  const db = (url) => { process.env.DATABASE_URL = url; return settings({ kitchen: '7', manager: '8' }).find((s) => s.name === 'DATABASE_URL'); };
  try {
    process.env.VERCEL = '1';
    assert.match(db('https://ikql.supabase.co/rest/v1/').detail, /must be postgresql/);
    assert.equal(db('postgresql://postgres:pw@db.ikql.supabase.co:5432/postgres').ok, false, 'direct connection on Vercel');
    assert.equal(db('postgresql://postgres.ikql:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres').ok, true);
    delete process.env.DATABASE_URL;
    assert.equal(settings({ kitchen: '7', manager: '8' }).find((s) => s.name === 'DATABASE_URL').ok, false, 'missing on Vercel');
  } finally {
    process.env = saved;
  }
});

test('the status report is switched off on Vercel (the live site)', async () => {
  const { call, close } = await serve(await pgliteDb(), { push: false, statusPage: false });
  const { body: { token } } = await call('/api/login', { method: 'POST', body: { role: 'manager', pin: '2222' } });
  assert.equal((await call('/api/admin/status', { token })).status, 404);
  await close();
});
