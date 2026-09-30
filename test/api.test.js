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

// ---------- WebSocket push (Supabase Realtime) ----------

test('realtime settings come from the Supabase key and the database address', () => {
  const { realtimeConfig, clientConfig } = require('../src/realtime');
  const pooler = 'postgresql://postgres.ikqlabc123:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres';
  assert.equal(realtimeConfig({ DATABASE_URL: pooler }), null, 'no key: keep polling');
  const cfg = realtimeConfig({ DATABASE_URL: pooler, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x' });
  assert.deepEqual(cfg, { url: 'https://ikqlabc123.supabase.co', key: 'sb_publishable_x', topic: 'babji_RestaurantKitchen_live' });
  assert.equal(realtimeConfig({ SUPABASE_URL: 'https://abc.supabase.co/rest/v1/', SUPABASE_ANON_KEY: 'k' }).url, 'https://abc.supabase.co');
  assert.equal(realtimeConfig({ DATABASE_URL: 'postgresql://postgres:pw@db.zzz9.supabase.co:5432/postgres', SUPABASE_ANON_KEY: 'k' }).url, 'https://zzz9.supabase.co');
  assert.equal(clientConfig(cfg).url, 'wss://ikqlabc123.supabase.co/realtime/v1/websocket?apikey=sb_publishable_x&vsn=2.0.0');
});

test('broadcast sends one small Supabase Realtime message and never throws', async () => {
  const { broadcast } = require('../src/realtime');
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
  const cfg = { url: 'https://abc.supabase.co', key: 'sb_publishable_x', topic: 'babji_RestaurantKitchen_live' };
  assert.equal(await broadcast(cfg, { version: 7 }, { fetchImpl: fakeFetch }), true);
  assert.equal(calls[0].url, 'https://abc.supabase.co/realtime/v1/api/broadcast');
  assert.equal(calls[0].opts.headers.apikey, 'sb_publishable_x');
  assert.equal(calls[0].opts.headers.Authorization, undefined, 'new keys are not JWTs');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { messages: [{ topic: 'babji_RestaurantKitchen_live', event: 'change', payload: { version: 7 }, private: false }] });
  await broadcast({ ...cfg, key: 'aaa.bbb.ccc' }, { version: 8 }, { fetchImpl: fakeFetch });
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer aaa.bbb.ccc', 'legacy anon JWT also sent as bearer');
  assert.equal(await broadcast(cfg, {}, { fetchImpl: async () => { throw new Error('offline'); } }), false);
});

test('[postgres] every write is announced over WebSocket before the reply, and a failure never breaks the write', async () => {
  const sent = [];
  const realtime = { url: 'https://abc.supabase.co', key: 'k', topic: 't' };
  const { call, close } = await serve(await pgliteDb(), { push: false, realtime, broadcastImpl: async (cfg, payload) => { sent.push(payload); return true; } });
  const v = (await call('/api/version')).body;
  assert.equal(v.realtime.url, 'wss://abc.supabase.co/realtime/v1/websocket?apikey=k&vsn=2.0.0');
  assert.equal(v.realtime.topic, 't');
  const menu = (await call('/api/menu')).body;
  assert.equal(sent.length, 0, 'reads are not announced');
  const r = await call('/api/tables/2/orders', { method: 'POST', body: { items: [{ item_id: menu.items[0].id, qty: 1 }] } });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].version, (await call('/api/version')).body.version, 'announces the new version');
  await close();

  const broken = await serve(await pgliteDb(), { push: false, realtime, broadcastImpl: async () => { throw new Error('supabase down'); } });
  const m2 = (await broken.call('/api/menu')).body;
  assert.equal((await broken.call('/api/tables/2/orders', { method: 'POST', body: { items: [{ item_id: m2.items[0].id, qty: 1 }] } })).status, 200);
  await broken.close();
});
