'use strict';
(() => {
  const { api, esc, money, moneyShort, clock, duration, toast } = App;
  const $ = (id) => document.getElementById(id);

  const localDate = (d = new Date(App.now())) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const state = { tab: 'dash', date: localDate(), tables: [], selectedTable: null, menu: { categories: [], items: [] } };

  // ---------- tabs ----------
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === b));
    for (const id of ['dash', 'tables', 'menu']) $(`tab-${id}`).classList.toggle('hidden', id !== state.tab);
    refresh(['orders', 'tables', 'menu'], true);
    try { sessionStorage.setItem('mgr-tab', state.tab); } catch {}
  });

  // ---------- dashboard ----------
  $('dashDate').value = state.date;
  $('dashDate').max = state.date;
  $('dashDate').addEventListener('change', () => { state.date = $('dashDate').value || localDate(); loadDashboard(true); });
  $('todayBtn').addEventListener('click', () => { state.date = localDate(); $('dashDate').value = state.date; loadDashboard(true); });

  // animate: count-up numbers and growing bars. On for opening the tab or picking a date,
  // off for live refreshes so the numbers don't restart from zero on every order.
  async function loadDashboard(animate = false) {
    const d = await api(`/api/admin/dashboard?date=${encodeURIComponent(state.date)}`);
    const isToday = d.date === localDate();
    $('dashNote').textContent = isToday ? 'Updates live as orders come in' : `Showing ${new Date(d.date + 'T00:00').toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}`;

    $('kpis').innerHTML = `
      <div class="kpi"><div class="label">Revenue</div><div class="value" id="kpiRevenue">${moneyShort(d.revenue_paise)}</div>
        <div class="sub">net of GST · ${d.items_sold} items sold</div></div>
      <div class="kpi"><div class="label">Orders</div><div class="value" id="kpiOrders">${d.orders}</div>
        <div class="sub">${d.orders ? `avg ${moneyShort(d.avg_order_paise)} per order` : 'none yet'}</div></div>
      <div class="kpi"><div class="label">Avg prep time</div><div class="value">${d.avg_prep_ms == null ? '—' : duration(d.avg_prep_ms)}</div>
        <div class="sub">${d.prepped_orders ? `New → Ready, ${d.prepped_orders} orders · slowest ${duration(d.max_prep_ms)}` : 'no orders ready yet'}</div></div>
      <div class="kpi"><div class="label">Collected</div><div class="value" id="kpiCollected">${moneyShort(d.collected.total_paise)}</div>
        <div class="sub">${d.collected.bills} bill${d.collected.bills === 1 ? '' : 's'} closed · incl. ${money(d.collected.gst_paise)} GST</div></div>`;

    if (animate) {
      App.countUp($('kpiRevenue'), d.revenue_paise, (v) => moneyShort(v));
      App.countUp($('kpiOrders'), d.orders, (v) => String(Math.round(v)));
      App.countUp($('kpiCollected'), d.collected.total_paise, (v) => moneyShort(v));
    }
    $('kpis').classList.toggle('enter', animate);

    renderChart(d.by_hour, animate);

    const maxQty = Math.max(1, ...d.top_items.map((i) => i.qty));
    $('topItems').classList.toggle('grow', animate);
    $('topItems').innerHTML = d.top_items.length ? d.top_items.map((i, n) => `
      <li style="--i:${n}">
        <span class="rank">${n + 1}</span>
        <span class="top-name">${App.dishPic(i, 'sm')}<span class="veg-mark ${i.is_veg ? '' : 'nv'}"></span> <strong>${esc(i.name)}</strong></span>
        <span class="num"><strong>${i.qty}</strong> <span class="muted">· ${moneyShort(i.revenue_paise)}</span></span>
        <span class="meter"><i style="width:${(i.qty / maxQty) * 100}%"></i></span>
      </li>`).join('') : '<p class="empty">No sales on this day.</p>';

    $('liveStrip').innerHTML = isToday ? `
      <span class="muted" style="font-size:.82rem;width:100%;font-weight:700">RIGHT NOW</span>
      <span class="pill New">${d.live.New} new</span><span class="pill Preparing">${d.live.Preparing} preparing</span>
      <span class="pill Ready">${d.live.Ready} ready</span><span class="pill Served">${d.open_tables} tables open</span>` : '';
  }

  // Single-series bar chart in plain SVG: one hue, recessive grid, hover tooltip, table fallback.
  function renderChart(byHour, animate) {
    const withData = byHour.filter((h) => h.revenue_paise > 0).map((h) => h.hour);
    const lo = Math.min(10, ...withData), hi = Math.max(23, ...withData);
    const rows = byHour.filter((h) => h.hour >= lo && h.hour <= hi);

    const W = 720, H = 260, L = 52, R = 8, T = 12, B = 28;
    const rawMax = Math.max(0, ...rows.map((r) => r.revenue_paise)) / 100;
    const step = niceStep(rawMax / 4 || 250);
    const yMax = Math.max(step * 4, Math.ceil(rawMax / step) * step);
    const band = (W - L - R) / rows.length;
    const barW = Math.min(28, band - 4);
    const y = (rupees) => T + (H - T - B) * (1 - rupees / yMax);
    const hourLabel = (h) => `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`;

    let grid = '';
    for (let v = 0; v <= yMax + 1e-9; v += step) {
      grid += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>
               <text class="axis-label" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">₹${v >= 1000 ? `${v / 1000}k` : v}</text>`;
    }
    let bars = '';
    rows.forEach((r, i) => {
      const x = L + i * band + (band - barW) / 2;
      const v = r.revenue_paise / 100;
      const top = y(v), base = y(0), h = base - top;
      if (h > 0) {
        const rad = Math.min(4, h, barW / 2);
        bars += `<path class="bar" data-i="${i}" style="--i:${i}" d="M${x},${base} V${top + rad} Q${x},${top} ${x + rad},${top} H${x + barW - rad} Q${x + barW},${top} ${x + barW},${top + rad} V${base} Z"/>`;
      }
      if (i % (rows.length > 14 ? 2 : 1) === 0) bars += `<text class="axis-label" x="${x + barW / 2}" y="${H - 8}" text-anchor="middle">${hourLabel(r.hour)}</text>`;
      bars += `<rect class="hit" data-i="${i}" x="${L + i * band}" y="${T}" width="${band}" height="${H - T - B}"/>`;
    });

    $('chart').innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="${animate ? 'grow' : ''}" role="img" aria-label="Revenue by hour bar chart">${grid}${bars}</svg>
      <div class="chart-tip hidden"></div>`;

    const tip = $('chart').querySelector('.chart-tip');
    const svg = $('chart').querySelector('svg');
    svg.addEventListener('mousemove', (e) => {
      const hit = e.target.closest('.hit');
      svg.querySelectorAll('.bar.hover').forEach((b) => b.classList.remove('hover'));
      if (!hit) return tip.classList.add('hidden');
      const r = rows[Number(hit.dataset.i)];
      svg.querySelector(`.bar[data-i="${hit.dataset.i}"]`)?.classList.add('hover');
      const box = svg.getBoundingClientRect(), s = box.width / W;
      const x = (L + Number(hit.dataset.i) * band + band / 2) * s;
      const top = y(r.revenue_paise / 100) * s;
      tip.style.left = `${Math.min(Math.max(x, 60), box.width - 60)}px`;
      tip.style.top = `${top}px`;
      tip.innerHTML = `<b>${hourLabel(r.hour)}–${hourLabel((r.hour + 1) % 24)}</b>${money(r.revenue_paise)} · ${r.orders} order${r.orders === 1 ? '' : 's'}`;
      tip.classList.remove('hidden');
    });
    svg.addEventListener('mouseleave', () => { tip.classList.add('hidden'); svg.querySelectorAll('.bar.hover').forEach((b) => b.classList.remove('hover')); });

    $('hourTable').innerHTML = `<table class="data num"><thead><tr><th>Hour</th><th class="r">Orders</th><th class="r">Revenue</th></tr></thead><tbody>
      ${rows.filter((r) => r.orders).map((r) => `<tr><td>${hourLabel(r.hour)}–${hourLabel((r.hour + 1) % 24)}</td><td class="r">${r.orders}</td><td class="r">${money(r.revenue_paise)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No orders</td></tr>'}
    </tbody></table>`;
  }

  function niceStep(raw) {
    const p = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
  }

  // ---------- tables & bills ----------
  async function loadTables() {
    state.tables = await api('/api/tables');
    $('tablesGrid').innerHTML = state.tables.map((t) => `
      <button class="tcard ${t.open_orders ? 'open' : ''} ${t.id === state.selectedTable ? 'sel' : ''}" data-id="${t.id}" type="button">
        <span class="muted" style="font-size:.8rem;font-weight:700">TABLE</span>
        <strong>${t.number}</strong>
        ${t.open_orders
          ? `<span class="num">${money(t.open_subtotal_paise)} <span class="muted">+ GST</span></span>
             <span class="muted" style="font-size:.82rem">${t.open_orders} order${t.open_orders === 1 ? '' : 's'}${t.unserved_orders ? ` · ${t.unserved_orders} not served` : ' · all served'} · since ${clock(t.first_order_at)}</span>`
          : `<span class="muted" style="font-size:.85rem">Free · ${t.seats} seats</span>`}
      </button>`).join('');
    if (state.selectedTable) await loadBill();
  }

  $('tablesGrid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    state.selectedTable = Number(b.dataset.id);
    document.querySelectorAll('.tcard').forEach((c) => c.classList.toggle('sel', c === b));
    loadBill();
  });

  async function loadBill() {
    const b = await api(`/api/tables/${state.selectedTable}/bill`);
    const unserved = b.orders.filter((o) => o.status !== 'Served');
    $('billPanel').innerHTML = `
      <div class="panel-head"><h2>Table ${b.table.number}</h2><span class="muted">${b.orders.length ? `${b.orders.length} open order${b.orders.length === 1 ? '' : 's'}` : 'Free'}</span></div>
      ${b.orders.length ? `
        ${b.orders.map((o) => `
          <div class="order-block">
            <header><strong>#${o.id}</strong><span class="muted">${clock(o.placed_at)}</span><span class="pill ${o.status}">${o.status}</span></header>
            ${o.items.map((l) => `
              <div class="line"><span>${esc(l.item_name)} <span class="muted">× ${l.qty}</span></span>
                <span class="muted">${money(l.unit_price_at_order)}</span><strong>${money(l.qty * l.unit_price_at_order)}</strong></div>`).join('')}
          </div>`).join('')}
        <div class="totals">
          <div><span>Subtotal</span><span>${money(b.subtotal_paise)}</span></div>
          <div class="muted"><span>GST ${b.gst_rate_percent}%</span><span>${money(b.gst_paise)}</span></div>
          <div class="grand"><span>Total</span><span>${money(b.total_paise)}</span></div>
        </div>
        <button class="btn primary block" id="closeTableBtn" style="margin-top:14px" type="button" ${b.can_close ? '' : 'disabled'}>Close table · mark paid</button>
        ${unserved.length ? `<p class="lock-note">Can't close yet: ${unserved.map((o) => `#${o.id} is ${o.status}`).join(', ')}.</p>` : ''}`
      : '<p class="empty">No open orders. This table is free.</p>'}`;
  }

  $('billPanel').addEventListener('click', async (e) => {
    if (e.target.id !== 'closeTableBtn') return;
    const t = state.tables.find((x) => x.id === state.selectedTable);
    if (!confirm(`Close table ${t?.number}? All its orders will be marked paid.`)) return;
    try {
      const r = await api(`/api/admin/tables/${state.selectedTable}/close`, { method: 'POST' });
      toast(`Table ${r.table.number} closed · ${money(r.total_paise)} collected`, 'good');
    } catch (err) { toast(err.message, 'error'); }
    await loadTables();
  });

  $('addTableForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/tables', { method: 'POST', body: { number: Number($('newTableNo').value) } });
      $('newTableNo').value = '';
      toast('Table added', 'good');
    } catch (err) { toast(err.message, 'error'); }
    await loadTables();
  });

  // ---------- menu ----------
  async function loadMenu() {
    state.menu = await api('/api/menu');
    const { categories, items } = state.menu;
    $('menuAdmin').innerHTML = categories.map((c) => {
      const list = items.filter((i) => i.category_id === c.id);
      return `
        <section class="cat-block">
          <header><h3>${esc(c.name)}</h3><span class="muted" style="font-size:.85rem">${list.length} items</span>
            <button class="btn small ghost" data-rename-cat="${c.id}" type="button">Rename</button>
            <button class="btn small ghost" data-del-cat="${c.id}" type="button" ${list.length ? 'disabled title="Remove its items first"' : ''}>Delete</button>
            <button class="btn small" data-new-item="${c.id}" type="button">+ Item</button></header>
          ${list.map((i) => `
            <div class="item-row">
              <span class="nm">${App.dishPic(i, 'sm')}<span class="veg-mark ${i.is_veg ? '' : 'nv'}"></span><span>${esc(i.name)}</span></span>
              <span class="num price-col">${money(i.price_paise)}</span>
              <span class="muted prep-col">${i.prep_minutes} min</span>
              <label class="switch"><input type="checkbox" data-avail="${i.id}" ${i.is_available ? 'checked' : ''}> ${i.is_available ? 'Available' : 'Unavailable'}</label>
              <button class="btn small" data-edit="${i.id}" type="button">Edit</button>
            </div>`).join('') || '<p class="empty">No items yet.</p>'}
        </section>`;
    }).join('') || '<p class="empty">Add a category to start the menu.</p>';
  }

  $('menuAdmin').addEventListener('change', async (e) => {
    const id = e.target.dataset.avail;
    if (!id) return;
    try {
      await api(`/api/admin/items/${id}`, { method: 'PUT', body: { is_available: e.target.checked } });
      toast(e.target.checked ? 'Back on the menu' : 'Marked unavailable. Existing orders are unaffected.');
    } catch (err) { toast(err.message, 'error'); }
    loadMenu();
  });

  $('menuAdmin').addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.edit) openItem(state.menu.items.find((i) => i.id === Number(t.dataset.edit)));
    else if (t.dataset.newItem) openItem(null, Number(t.dataset.newItem));
    else if (t.dataset.renameCat) {
      const c = state.menu.categories.find((x) => x.id === Number(t.dataset.renameCat));
      const name = prompt('Category name', c.name);
      if (name && name.trim() !== c.name) await catCall(`/api/admin/categories/${c.id}`, 'PUT', { name });
    } else if (t.dataset.delCat) {
      if (confirm('Delete this category?')) await catCall(`/api/admin/categories/${t.dataset.delCat}`, 'DELETE');
    }
  });

  async function catCall(path, method, body) {
    try { await api(path, { method, body }); } catch (err) { toast(err.message, 'error'); }
    loadMenu();
  }

  $('addCatBtn').addEventListener('click', async () => {
    const name = prompt('New category name');
    if (name?.trim()) await catCall('/api/admin/categories', 'POST', { name });
  });
  $('addItemBtn').addEventListener('click', () => {
    if (!state.menu.categories.length) return toast('Add a category first', 'error');
    openItem(null, state.menu.categories[0].id);
  });

  const PICS = ['🍛', '🍲', '🥘', '🍚', '🍗', '🍖', '🐟', '🦐', '🧀', '🌶️', '🥙', '🌯', '🫓', '🧄', '🥗', '🥟',
    '🍜', '🍝', '🍕', '🍔', '🍟', '🍡', '🍮', '🍨', '🧁', '🍰', '☕', '🥛', '🍋', '🥤', '🧃', '🍽️'];

  function renderPicPreview() {
    const f = $('itemForm');
    $('picPreview').innerHTML = App.dishPic({ emoji: f.emoji.value.trim(), category_id: Number(f.category_id.value) }, 'lg');
    $('picChoices').querySelectorAll('.pic-choice').forEach((b) => b.classList.toggle('sel', b.dataset.pic === f.emoji.value.trim()));
  }
  $('picChoices').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pic]');
    if (!b) return;
    $('itemForm').emoji.value = b.dataset.pic;
    renderPicPreview();
    App.replay($('picPreview').firstElementChild, 'pop');
  });
  $('itemForm').emoji.addEventListener('input', renderPicPreview);
  $('itemForm').category_id.addEventListener('change', renderPicPreview);

  let editing = null;
  function openItem(item, categoryId) {
    editing = item;
    const f = $('itemForm');
    $('itemDialogTitle').textContent = item ? 'Edit item' : 'New item';
    f.category_id.innerHTML = state.menu.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    f.name.value = item?.name ?? '';
    f.category_id.value = String(item?.category_id ?? categoryId);
    f.price.value = item ? (item.price_paise / 100).toFixed(2) : '';
    f.prep_minutes.value = item?.prep_minutes ?? 10;
    f.querySelector(`[name=is_veg][value="${item ? item.is_veg : 1}"]`).checked = true;
    f.is_available.checked = item ? !!item.is_available : true;
    f.emoji.value = item?.emoji || '🍽️';
    $('picChoices').innerHTML = PICS.map((p) => `<button type="button" class="pic-choice" data-pic="${p}">${p}</button>`).join('');
    renderPicPreview();
    $('itemError').textContent = '';
    $('archiveItemBtn').classList.toggle('hidden', !item);
    $('itemDialog').showModal();
  }

  $('itemForm').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'save') return; // Cancel closes the dialog
    e.preventDefault();
    const f = e.target;
    const body = {
      name: f.name.value,
      category_id: Number(f.category_id.value),
      price_paise: Math.round(Number(f.price.value) * 100),
      prep_minutes: Number(f.prep_minutes.value),
      is_veg: f.querySelector('[name=is_veg]:checked').value === '1',
      is_available: f.is_available.checked,
      emoji: f.emoji.value.trim(),
    };
    try {
      await api(editing ? `/api/admin/items/${editing.id}` : '/api/admin/items', { method: editing ? 'PUT' : 'POST', body });
      $('itemDialog').close();
      toast(editing ? 'Item updated' : 'Item added', 'good');
      loadMenu();
    } catch (err) { $('itemError').textContent = err.message; }
  });

  $('archiveItemBtn').addEventListener('click', async () => {
    if (!editing || !confirm(`Remove “${editing.name}” from the menu? Past orders keep it.`)) return;
    try { await api(`/api/admin/items/${editing.id}`, { method: 'DELETE' }); $('itemDialog').close(); toast('Item removed'); }
    catch (err) { $('itemError').textContent = err.message; }
    loadMenu();
  });

  // ---------- live ----------
  function refresh(topics, animate = false) {
    const jobs = [];
    if (state.tab === 'dash' && (topics.includes('orders') || topics.includes('tables'))) jobs.push(loadDashboard(animate));
    if (state.tab === 'tables' && (topics.includes('orders') || topics.includes('tables'))) jobs.push(loadTables());
    if (state.tab === 'menu' && topics.includes('menu')) jobs.push(loadMenu());
    return Promise.all(jobs).catch((err) => toast(err.message, 'error'));
  }

  $('lockBtn').addEventListener('click', () => App.logout('manager'));
  document.addEventListener('auth-expired', () => location.reload());

  (async () => {
    await App.pinGate('manager', 'Manager');
    let saved = null;
    try { saved = sessionStorage.getItem('mgr-tab'); } catch {}
    if (saved && saved !== 'dash') document.querySelector(`.tab[data-tab="${saved}"]`)?.click();
    else refresh(['orders'], true);
    App.live((topics) => refresh(topics), App.syncBadge($('sync')));
  })();
})();
