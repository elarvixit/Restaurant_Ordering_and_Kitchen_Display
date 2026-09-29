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

  // Live sync: Server-Sent Events push a "changed" signal the moment any screen
  // writes. If the stream drops, poll /api/version every 3 s until it comes back.
  function live(onChange, onStatus = () => {}) {
    let version = null, pollTimer = null, es = null;

    const seen = (v, topics) => {
      if (version !== null && v === version) return;
      const first = version === null;
      version = v;
      if (!first) onChange(topics || ['orders', 'menu', 'tables']);
    };
    const startPolling = () => {
      if (pollTimer) return;
      onStatus('polling');
      pollTimer = setInterval(async () => {
        try { const r = await api('/api/version'); seen(r.version); } catch {}
      }, 3000);
    };
    const stopPolling = () => { clearInterval(pollTimer); pollTimer = null; };

    if ('EventSource' in window) {
      es = new EventSource('/api/events');
      es.addEventListener('hello', (e) => {
        stopPolling();
        onStatus('live');
        const v = JSON.parse(e.data).version;
        // Reconnected after a gap: we may have missed writes, so refresh everything.
        if (version !== null && v !== version) { version = v; onChange(['orders', 'menu', 'tables']); } else version = v;
      });
      es.addEventListener('change', (e) => { const d = JSON.parse(e.data); seen(d.version, d.topics); });
      es.onerror = () => startPolling();
    } else {
      startPolling();
    }
    // A tab that was asleep (phone screen off) catches up on wake.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) onChange(['orders', 'menu', 'tables']); });
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
          <a class="pin-back" href="/">← All screens</a>
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

  function logout(role) { setToken(role, null); location.reload(); }

  function syncBadge(el) {
    return (state) => {
      el.dataset.state = state;
      el.textContent = state === 'live' ? 'Live' : 'Reconnecting… (polling)';
      el.title = state === 'live' ? 'Receiving live updates from the server' : 'Live stream lost, checking every 3 seconds';
    };
  }

  return { api, ApiError, esc, money, moneyShort, now, minutesSince, clock, duration, live, toast, pinGate, logout, syncBadge };
})();
