'use strict';
(() => {
  const { api, esc, clock, duration, minutesSince, toast } = App;
  const $ = (id) => document.getElementById(id);
  const LATE_MINUTES = 20;
  const ACTION = { New: 'Tap to start preparing →', Preparing: 'Tap when ready →', Ready: 'Tap when served ✓' };

  let orders = [];
  let known = null;        // Map order id -> item count, to spot new or grown tickets
  let lastStatus = new Map(); // order id -> status, to animate tickets that changed column
  const pending = new Set(); // ids with an advance request in flight (debounces taps)
  let soundOn = true;
  try { soundOn = localStorage.getItem('kds-sound') !== 'off'; } catch {}

  // ---------- sound (Web Audio, no files) ----------
  // Three alerts, each easy to tell apart across a noisy kitchen:
  //   new      a new ticket: three rising notes, played twice
  //   added    items added to a ticket that is still New: two notes
  //   reminder a ticket has waited over REMIND_AFTER_MIN without being started: one low double beep,
  //            repeated every REMIND_EVERY_MS until someone taps it into Preparing
  const REMIND_AFTER_MIN = 2;
  const REMIND_EVERY_MS = 60_000;
  const SOUNDS = {
    new: { notes: [784, 988, 1319, 784, 988, 1319], gap: 0.16, gain: 0.5, type: 'triangle' },
    added: { notes: [988, 1319], gap: 0.18, gain: 0.4, type: 'sine' },
    reminder: { notes: [523, 523], gap: 0.22, gain: 0.35, type: 'square' },
  };
  let audio = null;
  function unlockAudio() {
    if (!audio && window.AudioContext) {
      audio = new AudioContext();
      audio.addEventListener('statechange', renderSoundBtn);
    }
    audio?.resume().then(renderSoundBtn, renderSoundBtn);
  }
  const audioBlocked = () => soundOn && (!audio || audio.state !== 'running');
  function chime(kind = 'new') {
    if (!soundOn || !audio || audio.state !== 'running') return;
    const { notes, gap, gain, type } = SOUNDS[kind];
    const t = audio.currentTime + 0.02;
    notes.forEach((f, i) => {
      const at = t + i * gap + (kind === 'new' && i >= 3 ? 0.25 : 0); // short pause between the two runs
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(gain, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + gap * 1.8);
      o.connect(g).connect(audio.destination);
      o.start(at); o.stop(at + gap * 2);
    });
  }
  function renderSoundBtn() {
    const blocked = audioBlocked();
    const btn = $('soundBtn');
    btn.textContent = !soundOn ? '🔕 Sound off' : blocked ? '🔇 Tap to turn on sound' : '🔔 Sound on';
    btn.classList.toggle('primary', blocked);
    btn.classList.toggle('attention', blocked);
    btn.setAttribute('aria-pressed', String(soundOn && !blocked));
    btn.title = blocked ? 'The browser blocks sound until someone taps the screen once' : 'New order alerts';
  }
  $('soundBtn').addEventListener('click', () => {
    if (audioBlocked() && soundOn) { unlockAudio(); setTimeout(() => chime('new'), 150); return; } // just unlock
    soundOn = !soundOn;
    try { localStorage.setItem('kds-sound', soundOn ? 'on' : 'off'); } catch {}
    unlockAudio(); renderSoundBtn(); if (soundOn) setTimeout(() => chime('new'), 150);
  });
  document.addEventListener('pointerdown', unlockAudio, { once: true });

  // Reminder for tickets nobody has started. Each ticket reminds at most once per REMIND_EVERY_MS.
  const reminded = new Map(); // order id -> last reminder time
  setInterval(() => {
    const now = App.now();
    const waiting = orders.filter((o) => o.status === 'New' && now - o.placed_at >= REMIND_AFTER_MIN * 60_000
      && now - (reminded.get(o.id) || 0) >= REMIND_EVERY_MS);
    if (!waiting.length) return;
    waiting.forEach((o) => reminded.set(o.id, now));
    chime('reminder');
    for (const o of waiting) App.replay(document.querySelector(`.ticket[data-id="${o.id}"]`), 'nudge');
  }, 5000);

  // ---------- render ----------
  function ticket(o, fresh, moved) {
    const mins = minutesSince(o.placed_at);
    const late = mins >= LATE_MINUTES;
    const count = o.items.reduce((s, l) => s + l.qty, 0);
    return `
      <button class="ticket ${late ? 'late' : ''} ${fresh ? 'fresh' : ''} ${moved ? 'moved' : ''}" data-id="${o.id}" data-status="${o.status}" data-placed="${o.placed_at}" type="button"
              aria-label="Table ${o.table_number}, order ${o.id}, ${o.status}, ${mins} minutes. ${ACTION[o.status]}">
        <div class="ticket-head">
          <span class="tbl">T${o.table_number}</span>
          <span class="elapsed" title="Minutes since the order was placed">${mins} min</span>
        </div>
        <div class="ticket-meta">
          <span>#${o.id}</span><span>Placed ${clock(o.placed_at)}</span><span>${count} item${count === 1 ? '' : 's'}</span>
          ${o.prep_ms != null ? `<span>Prep ${duration(o.prep_ms)}</span>` : ''}
        </div>
        <ul>
          ${o.items.map((l) => `
            <li><span class="q num">${l.qty}×</span><span class="n">${esc(l.item_name)}${l.added_at - o.placed_at > 1000 ? '<span class="added">+ADDED</span>' : ''}</span>
              ${l.note ? `<span class="note">⚠ ${esc(l.note)}</span>` : ''}</li>`).join('')}
        </ul>
        <div class="ticket-action">${pending.has(o.id) ? 'Updating…' : ACTION[o.status]}</div>
      </button>`;
  }

  function render(freshIds = new Set(), movedIds = new Set()) {
    for (const col of document.querySelectorAll('.kds-col')) {
      const s = col.dataset.status;
      // Server already sorts oldest first; keep that order within each column.
      const list = orders.filter((o) => o.status === s);
      col.querySelector('.count').textContent = list.length;
      col.querySelector('.kds-cards').innerHTML = list.length
        ? list.map((o) => ticket(o, freshIds.has(o.id), movedIds.has(o.id))).join('')
        : `<p class="kds-empty">${s === 'New' ? 'Waiting for orders…' : 'Nothing here'}</p>`;
    }
  }

  // Timers tick locally every second using the server-corrected clock; no refetch needed.
  function tick() {
    $('clock').textContent = new Date(App.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    for (const el of document.querySelectorAll('.ticket')) {
      const mins = minutesSince(Number(el.dataset.placed));
      el.querySelector('.elapsed').textContent = `${mins} min`;
      el.classList.toggle('late', mins >= LATE_MINUTES);
    }
  }

  async function load() {
    const next = await api('/api/kitchen/orders');
    const fresh = new Set();
    let brandNew = false;
    if (known) {
      for (const o of next) {
        const n = o.items.reduce((s, l) => s + l.qty, 0);
        if (!known.has(o.id)) { fresh.add(o.id); brandNew = true; } else if (o.status === 'New' && n > known.get(o.id)) fresh.add(o.id);
      }
    }
    const moved = new Set(next.filter((o) => lastStatus.has(o.id) && lastStatus.get(o.id) !== o.status).map((o) => o.id));
    known = new Map(next.map((o) => [o.id, o.items.reduce((s, l) => s + l.qty, 0)]));
    lastStatus = new Map(next.map((o) => [o.id, o.status]));
    orders = next;
    render(fresh, moved);
    if (fresh.size) chime(brandNew ? 'new' : 'added');
  }

  $('board').addEventListener('click', async (e) => {
    const card = e.target.closest('.ticket');
    if (!card) return;
    const id = Number(card.dataset.id);
    if (pending.has(id)) return;
    const o = orders.find((x) => x.id === id);
    if (!o) return;
    pending.add(id);
    card.querySelector('.ticket-action').textContent = 'Updating…';
    try {
      await api(`/api/orders/${id}/advance`, { method: 'POST', body: { from: o.status } });
    } catch (err) {
      toast(err.status === 409 ? `#${id}: ${err.message} (another screen moved it)` : err.message, 'error');
    } finally {
      pending.delete(id);
      await load().catch(() => {});
    }
  });

  $('lockBtn').addEventListener('click', () => App.logout('kitchen'));
  document.addEventListener('auth-expired', () => location.reload());

  // ---------- boot ----------
  (async () => {
    renderSoundBtn();
    await App.pinGate('kitchen', 'Kitchen display');
    unlockAudio(); // the PIN tap counts as a user gesture, so sound can play later
    await load();
    tick();
    setInterval(tick, 1000);
    App.live((topics) => { if (topics.includes('orders')) load().catch(() => {}); }, App.syncBadge($('sync')));
  })();
})();
