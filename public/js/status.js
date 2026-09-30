'use strict';
// System status page (manager PIN): is the app deployed, configured and talking to Supabase?
(() => {
  const { api, esc, clock, pinGate, logout } = App;
  const $ = (id) => document.getElementById(id);
  const REFRESH_MS = 30_000;
  const SCREENS = [['/', 'Home'], ['/customer', 'Customer'], ['/kitchen', 'Kitchen'], ['/manager', 'Manager']];

  const dot = (ok) => `<span class="dot" data-ok="${ok === true ? 'yes' : ok === false ? 'no' : 'default'}" aria-hidden="true"></span>`;
  const word = (ok) => (ok === true ? 'OK' : ok === false ? 'Fix' : 'Default');
  const facts = (rows) => rows.filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
  const fmtMs = (ms) => `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;

  function summary(level, title, text) {
    $('summary').dataset.level = level;
    $('summaryTitle').textContent = title;
    $('summaryText').textContent = text;
  }

  function kpis(s, roundTrip) {
    const cards = [
      ['Database', s.database.connected ? 'Connected' : 'Down', `${fmtMs(s.database.latency_ms)} per query`],
      ['Round trip', fmtMs(roundTrip), 'browser → server → database'],
      ['Open orders', s.activity.open_orders, `${s.activity.occupied_tables} table(s) occupied`],
      ['Kitchen queue', s.activity.kitchen_queue, `${s.activity.menu_available} of ${s.activity.menu_items} dishes available`],
    ];
    $('kpis').innerHTML = cards.map(([label, value, sub]) =>
      `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`).join('');
  }

  async function screens() {
    const results = await Promise.all(SCREENS.map(async ([path, name]) => {
      const t0 = performance.now();
      try {
        const r = await fetch(path, { cache: 'no-store' });
        return { path, name, ok: r.ok, info: r.ok ? fmtMs(performance.now() - t0) : `HTTP ${r.status}` };
      } catch { return { path, name, ok: false, info: 'unreachable' }; }
    }));
    $('screens').innerHTML = results.map((r) => `
      <li>${dot(r.ok)}<div><a href="${esc(r.path)}" target="_blank" rel="noopener"><strong>${esc(r.name)}</strong> <code>${esc(r.path)}</code></a>
      <span class="muted">${r.ok ? 'Loads' : 'Not loading'} · ${esc(r.info)}</span></div><span class="verdict">${word(r.ok)}</span></li>`).join('');
    return results.every((r) => r.ok);
  }

  function render(s, roundTrip) {
    kpis(s, roundTrip);

    $('settings').innerHTML = s.settings.map((v) => `
      <li>${dot(v.ok)}<div><span><code>${esc(v.name)}</code>${v.required ? '' : ' <span class="muted">(optional)</span>'}</span>
      <span class="muted">${esc(v.detail)}</span></div><span class="verdict">${word(v.ok)}</span></li>`).join('');

    const d = s.database;
    $('dbEngine').textContent = d.engine;
    $('database').innerHTML = facts([
      ['Status', `${dot(true)} Connected`],
      ['Engine', esc(d.engine)],
      ['Version', esc(d.server_version)],
      ['Host', d.host && `<code>${esc(d.host)}</code>`],
      ['Connection', d.pooler && esc(d.pooler)],
      ['Query time', esc(fmtMs(d.latency_ms))],
      ['Schema version', esc(d.schema_version)],
      ['Last change', d.live_version ? esc(new Date(d.live_version).toLocaleString()) : null],
    ]);

    const rlsKnown = s.tables.some((t) => t.rls !== null);
    const total = s.tables.reduce((n, t) => n + t.rows, 0);
    $('tableNote').textContent = `${s.tables.length} tables · ${total.toLocaleString('en-IN')} rows`;
    $('tables').querySelector('tbody').innerHTML = s.tables.map((t) => `
      <tr><td><code>${esc(t.name)}</code></td><td class="right num">${t.rows.toLocaleString('en-IN')}</td>
      <td>${t.rls === null ? '<span class="muted">n/a (local SQLite)</span>' : t.rls ? `${dot(true)} Blocked (row level security on)` : `${dot(false)} Open to anyone with the anon key`}</td></tr>`).join('');

    const dep = s.deployment;
    $('platform').textContent = dep.platform;
    $('deployment').innerHTML = facts([
      ['Platform', esc(dep.platform)],
      ['Environment', esc(dep.environment)],
      ['Region', dep.region && esc(dep.region)],
      ['Address', dep.url && `<code>${esc(dep.url)}</code>`],
      ['Version', dep.commit && `<code>${esc(dep.commit.sha)}</code> ${esc(dep.commit.message)}`],
      ['Branch', dep.commit?.branch && esc(dep.commit.branch)],
      ['Live sync', esc(dep.live_sync)],
      ['Node.js', esc(dep.node)],
    ]);

    const problems = s.settings.filter((v) => v.ok === false).map((v) => v.name)
      .concat(rlsKnown ? s.tables.filter((t) => t.rls === false).map((t) => t.name) : []);
    if (problems.length) {
      summary('warn', 'Running, but needs attention', `Connected to ${d.engine}. Check: ${problems.join(', ')}.`);
    } else {
      summary('ok', 'All systems working', `${dep.platform} is connected to ${d.engine}; all ${s.tables.length} tables answer and settings look right.`);
    }
    $('checked').textContent = `Checked ${clock(s.checked_at)}`;
  }

  let busy = false;
  async function refresh() {
    if (busy) return;
    busy = true;
    $('refreshBtn').disabled = true;
    const screensOk = screens();
    try {
      const t0 = performance.now();
      const s = await api('/api/admin/status');
      render(s, performance.now() - t0);
      if (!(await screensOk) && $('summary').dataset.level === 'ok') {
        summary('warn', 'Running, but needs attention', 'The database is fine, but a screen is not loading (see Screens).');
      }
    } catch (err) {
      if (err.status === 401) return; // PIN expired: the gate takes over
      summary('down', err.status === 503 ? 'Database not reachable' : 'Server error', err.message);
      $('kpis').innerHTML = '';
      $('database').innerHTML = facts([['Status', `${dot(false)} ${esc(err.message)}`]]);
      $('checked').textContent = `Checked ${clock(Date.now())}`;
    } finally {
      busy = false;
      $('refreshBtn').disabled = false;
    }
  }

  $('refreshBtn').addEventListener('click', refresh);
  $('lockBtn').addEventListener('click', () => logout('manager'));
  document.addEventListener('auth-expired', () => location.reload());

  pinGate('manager', 'System status').then(() => {
    refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  });
})();
