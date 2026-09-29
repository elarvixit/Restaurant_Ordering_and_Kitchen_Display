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
