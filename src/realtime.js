'use strict';
// WebSocket push through Supabase Realtime (Broadcast). Vercel functions cannot keep a WebSocket open
// per screen, so after every write the server sends one small "something changed" message to
// Supabase, and Supabase pushes it over WebSocket to every open screen. The message carries only the
// live-sync version number, never order data: screens then refetch through the normal API.
//
// Needs the project's publishable (or legacy anon) key, which is designed to be public:
//   SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY)
// and the project URL, which is read from SUPABASE_URL or worked out from DATABASE_URL.
// Without a key the app keeps polling every 2 seconds, exactly as before.

const TOPIC = 'babji_RestaurantKitchen_live';

function projectUrl(env) {
  const direct = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  if (direct) {
    try {
      const u = new URL(direct);
      return `${u.protocol}//${u.host}`; // drops a pasted /rest/v1/ path
    } catch { return null; }
  }
  // postgresql://postgres.<ref>:pw@aws-0-...pooler.supabase.com  or  ...@db.<ref>.supabase.co
  const db = (env.DATABASE_URL || env.POSTGRES_URL || '').trim();
  try {
    const u = new URL(db);
    const ref = decodeURIComponent(u.username).match(/^postgres\.([a-z0-9]+)$/)?.[1]
      || u.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1];
    return ref ? `https://${ref}.supabase.co` : null;
  } catch { return null; }
}

function realtimeConfig(env = process.env) {
  const key = (env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '').trim();
  const url = projectUrl(env);
  if (!key || !url) return null;
  return { url, key, topic: TOPIC };
}

// What the browser needs to open the WebSocket (all of it is public by design).
function clientConfig(cfg) {
  if (!cfg) return null;
  const ws = cfg.url.replace(/^http/, 'ws');
  return { url: `${ws}/realtime/v1/websocket?apikey=${encodeURIComponent(cfg.key)}&vsn=2.0.0`, topic: cfg.topic };
}

// Sends one broadcast. Never throws: if Supabase is slow or down, screens still catch up by polling.
async function broadcast(cfg, payload, { fetchImpl = globalThis.fetch, timeoutMs = 2000 } = {}) {
  if (!cfg) return false;
  const headers = { apikey: cfg.key, 'Content-Type': 'application/json' };
  if (cfg.key.split('.').length === 3) headers.Authorization = `Bearer ${cfg.key}`; // legacy JWT anon key
  try {
    const res = await fetchImpl(`${cfg.url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages: [{ topic: cfg.topic, event: 'change', payload, private: false }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = { realtimeConfig, clientConfig, broadcast, TOPIC };
