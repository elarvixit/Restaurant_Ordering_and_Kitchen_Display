'use strict';
// Shared helpers for all three screens: API calls, money, server clock, live sync, PIN gate.

const App = (() => {
  let clockOffset = 0; // serverNow - clientNow, so timers agree across devices

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const money = (paise) => '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const moneyShort = (paise) => '₹' + Math.round(paise / 100).toLocaleString('en-IN');

  const now = () => Date.now() + clockOffset;
  const minutesSince = (ts) => Math.max(0, Math.floor((now() - ts) / 60000));
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const duration = (ms) => {
    if (ms == null) return '—';
    const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
    return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
  };

  const tokenKey = (role) => `pin-token:${role}`;
  const getToken = (role) => { try { return sessionStorage.getItem(tokenKey(role)); } catch { return null; } };
  const setToken = (role, t) => { try { t ? sessionStorage.setItem(tokenKey(role), t) : sessionStorage.removeItem(tokenKey(role)); } catch {} };
  let authRole = null;

  class ApiError extends Error {
    constructor(status, data) { super(data.error || `Request failed (${status})`); this.status = status; this.data = data; }
  }

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = authRole && getToken(authRole);
    if (token) headers.Authorization = `Bearer ${token}`;
    const t0 = Date.now();
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const t1 = Date.now();
    const serverNow = Number(res.headers.get('X-Server-Now'));
    if (serverNow) clockOffset = serverNow - (t0 + t1) / 2;
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && authRole) { setToken(authRole, null); document.dispatchEvent(new CustomEvent('auth-expired')); }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  // Live sync. Every write bumps a version number in the database.
  // - Local server (push: true): Server-Sent Events announce each new version instantly;
  //   if the stream drops, poll /api/version every 3 s until it comes back.
  // - Vercel (push: false): serverless functions can't hold a push connection per screen,
  //   so poll /api/version every 2 s. Well inside the 5-second requirement.
  // Either way the screen only refetches when the version actually moved.
  const ALL = ['orders', 'menu', 'tables'];
  async function live(onChange, onStatus = () => {}) {
    let version = null, pollTimer = null, es = null;

    const seen = (v, topics) => {
      if (version !== null && v === version) return;
      const first = version === null;
      version = v;
      if (!first) onChange(topics || ALL);
    };
    const startPolling = (ms, state) => {
      if (pollTimer) return;
      onStatus(state);
      pollTimer = setInterval(async () => {
        try { const r = await api('/api/version'); seen(r.version); onStatus(state); } catch { onStatus('offline'); }
      }, ms);
    };
    const stopPolling = () => { clearInterval(pollTimer); pollTimer = null; };

    // A tab that was asleep (phone screen off) catches up on wake.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) onChange(ALL); });

    let push = true, realtime = null;
    try { const r = await api('/api/version'); version = r.version; push = r.push !== false; realtime = r.realtime; } catch {}
    if (realtime && 'WebSocket' in window) return realtimeSocket(realtime, { seen, startPolling, stopPolling, onStatus, onChange });
    if (!push || !('EventSource' in window)) return startPolling(2000, 'live-poll');

    {
      es = new EventSource('/api/events');
      es.addEventListener('hello', (e) => {
        stopPolling();
        onStatus('live');
        const v = JSON.parse(e.data).version;
        // Reconnected after a gap: we may have missed writes, so refresh everything.
        if (version !== null && v !== version) { version = v; onChange(ALL); } else version = v;
      });
      es.addEventListener('change', (e) => { const d = JSON.parse(e.data); seen(d.version, d.topics); });
      es.onerror = () => startPolling(3000, 'polling');
    }
  }

  // WebSocket push through Supabase Realtime (Phoenix protocol v2, no library). The server broadcasts
  // { version } on every write; this joins the channel and refetches when the version moves. While the
  // socket is down it polls every 2 s and reconnects with back-off. A slow 20 s check also runs while
  // connected, because a broadcast can be lost and nothing else would notice.
  function realtimeSocket(cfg, { seen, startPolling, stopPolling, onStatus, onChange }) {
    const topic = `realtime:${cfg.topic}`;
    let ws = null, ref = 0, joinRef = null, beat = null, retry = 1000, joined = false;
    const send = (m) => { try { ws.send(JSON.stringify(m)); } catch {} };
    const next = () => String(++ref);
    setInterval(async () => {
      if (!joined || document.hidden) return;
      try { seen((await api('/api/version')).version); } catch {}
    }, 20000);

    function down() {
      joined = false;
      clearInterval(beat);
      startPolling(2000, 'polling');
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30000);
    }

    function connect() {
      try { ws = new WebSocket(cfg.url); } catch { return down(); }
      ws.onopen = () => {
        joinRef = next();
        send([joinRef, joinRef, topic, 'phx_join', {
          config: { broadcast: { ack: false, self: false }, presence: { enabled: false }, postgres_changes: [], private: false },
          access_token: null,
        }]);
        beat = setInterval(() => send([null, next(), 'phoenix', 'heartbeat', {}]), 25000);
      };
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        const [, msgRef, msgTopic, event, payload] = m;
        if (event === 'phx_reply' && msgRef === joinRef) {
          if (payload?.status !== 'ok') { try { ws.close(); } catch {} return; }
          joined = true;
          retry = 1000;
          stopPolling();
          onStatus('live-ws');
          onChange(ALL); // catch up on anything written while we were connecting
        } else if (msgTopic === topic && event === 'broadcast' && payload?.event === 'change') {
          seen(payload.payload?.version, payload.payload?.topics);
        } else if (msgTopic === topic && (event === 'phx_error' || event === 'phx_close')) {
          try { ws.close(); } catch {}
        }
      };
      ws.onclose = down;
      ws.onerror = () => { try { ws.close(); } catch {} };
    }

    startPolling(2000, 'live-poll'); // until the socket has joined
    connect();
  }

  function toast(message, kind = 'info') {
    let host = document.getElementById('toasts');
    if (!host) { host = document.createElement('div'); host.id = 'toasts'; host.setAttribute('aria-live', 'polite'); document.body.append(host); }
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = message;
    host.append(el);
    setTimeout(() => el.classList.add('out'), 3200);
    setTimeout(() => el.remove(), 3600);
  }

  // Full-screen PIN keypad. Resolves once a valid session exists for `role`.
  function pinGate(role, title) {
    authRole = role;
    return new Promise(async (resolve) => {
      if (getToken(role)) {
        try { const s = await api('/api/session'); if (s.role === role) return resolve(); } catch {}
        setToken(role, null);
      }
      const overlay = document.createElement('div');
      overlay.className = 'pin-overlay';
      overlay.innerHTML = `
        <form class="pin-card" autocomplete="off">
          <div class="pin-top">
            <a class="pin-back" href="/">← All screens</a>
            <button class="btn small ghost theme-btn" type="button" data-theme-toggle></button>
          </div>
          <h1>${esc(title)}</h1>
          <p class="muted">Enter the ${esc(role)} PIN</p>
          <input class="pin-input" type="password" inputmode="numeric" maxlength="8" aria-label="PIN" autofocus>
          <p class="pin-error" role="alert"></p>
          <div class="keypad">
            ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-k="${n}">${n}</button>`).join('')}
            <button type="button" data-k="clear" aria-label="Clear">C</button>
            <button type="button" data-k="0">0</button>
            <button type="submit" class="primary" aria-label="Unlock">→</button>
          </div>
        </form>`;
      document.body.append(overlay);
      overlay.querySelectorAll('[data-theme-toggle]').forEach((b) => window.Theme?.bind(b));
      const form = overlay.querySelector('form');
      const input = overlay.querySelector('input');
      const error = overlay.querySelector('.pin-error');
      input.focus();
      overlay.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => {
        input.value = b.dataset.k === 'clear' ? '' : (input.value + b.dataset.k).slice(0, 8);
        input.focus();
      }));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const r = await api('/api/login', { method: 'POST', body: { role, pin: input.value } });
          setToken(role, r.token);
          overlay.remove();
          resolve();
        } catch (err) {
          error.textContent = err.message;
          input.value = '';
          form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
        }
      });
    });
  }

  const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // Mini picture for a dish: its photo (public/img/menu/) when it has one, otherwise its emoji on a
  // soft gradient tinted by category (5 tones). The emoji stays underneath the photo, so a photo that
  // fails to load still leaves the emoji showing.
  const PHOTO = /^[a-z0-9-]+\.(jpg|jpeg|png|webp)$/;
  function dishPic(item, size = 'md') {
    const tone = ((item?.category_id ?? 0) % 5 + 5) % 5;
    const photo = PHOTO.test(item?.photo || '') ? item.photo : '';
    return `<span class="dish-pic ${size}${photo ? ' has-photo' : ''}" data-tone="${tone}" aria-hidden="true"><span>${esc(item?.emoji || '🍽️')}</span>${
      photo ? `<img src="/img/menu/${photo}" alt="" loading="lazy" decoding="async">` : ''}</span>`;
  }

  // Animates a number from 0 up to its value (formatted by fmt). Skipped for reduced motion.
  function countUp(el, value, fmt, ms = 700) {
    if (!el) return;
    if (reducedMotion() || !value) { el.textContent = fmt(value); return; }
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      el.textContent = fmt(value * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Replays a CSS animation class on an element.
  function replay(el, cls) {
    if (!el || reducedMotion()) return;
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
    el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
  }

  function logout(role) { setToken(role, null); location.reload(); }

  function syncBadge(el) {
    return (state) => {
      const labels = {
        live: ['Live', 'live', 'Receiving instant updates from the server'],
        'live-ws': ['Live', 'live', 'Instant updates over WebSocket (Supabase Realtime)'],
        'live-poll': ['Live', 'live', 'Checking for new orders every 2 seconds'],
        polling: ['Reconnecting…', 'polling', 'Live connection lost: checking every few seconds and reconnecting'],
        offline: ['Offline', 'polling', 'Cannot reach the server, retrying'],
      };
      const [text, look, title] = labels[state] || labels.polling;
      el.dataset.state = look;
      el.textContent = text;
      el.title = title;
    };
  }

  return { api, ApiError, esc, money, moneyShort, now, minutesSince, clock, duration, live, toast, pinGate, logout, syncBadge,
    dishPic, countUp, replay, reducedMotion };
})();
