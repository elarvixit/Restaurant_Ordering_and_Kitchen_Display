'use strict';
(() => {
  const { api, esc, money, clock, toast } = App;
  const $ = (id) => document.getElementById(id);

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  const state = {
    tables: [],
    tableId: store.get('table-id'),
    menu: { categories: [], items: [] },
    itemsById: new Map(),
    cart: [],          // [{ item_id, qty, note }] — local until "Place order"
    bill: null,
    blocked: new Set(), // item ids the server rejected on the last attempt
    vegOnly: false,
    placing: false,
  };

  const cartKey = () => `cart:${state.tableId}`;
  const saveCart = () => store.set(cartKey(), state.cart);
  const table = () => state.tables.find((t) => t.id === state.tableId);

  // ---------- data ----------

  async function loadTables() {
    state.tables = await api('/api/tables');
  }

  async function loadMenu() {
    state.menu = await api('/api/menu');
    state.itemsById = new Map(state.menu.items.map((i) => [i.id, i]));
  }

  async function loadBill() {
    if (!state.tableId) return;
    state.bill = await api(`/api/tables/${state.tableId}/bill`);
  }

  // ---------- table picker ----------

  function showPicker() {
    $('ordering').classList.add('hidden');
    $('cartFab').classList.add('hidden');
    $('tableBtn').classList.add('hidden');
    $('picker').classList.remove('hidden');
    $('tableGrid').innerHTML = state.tables.map((t) => `
      <button class="table-btn ${t.open_orders ? 'busy' : ''}" data-id="${t.id}" type="button">
        <small class="muted">Table</small><strong>${t.number}</strong>
        <small class="muted">${t.open_orders ? 'Ordering now' : `${t.seats} seats`}</small>
      </button>`).join('');
  }

  $('tableGrid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    chooseTable(Number(b.dataset.id));
  });

  async function chooseTable(id) {
    state.tableId = id;
    store.set('table-id', id);
    state.cart = store.get(cartKey()) || [];
    await loadBill();
    showOrdering();
  }

  $('tableBtn').addEventListener('click', () => {
    if (state.cart.length && !confirm('Switch table? Your cart for this table is kept.')) return;
    state.tableId = null;
    store.set('table-id', null);
    showPicker();
  });

  // ---------- menu ----------

  function showOrdering() {
    $('picker').classList.add('hidden');
    $('ordering').classList.remove('hidden');
    $('cartFab').classList.remove('hidden');
    const t = table();
    $('tableBtn').textContent = `Table ${t ? t.number : '?'} · change`;
    $('tableBtn').classList.remove('hidden');
    renderMenu();
    renderSide();
  }

  function renderMenu() {
    const cats = state.menu.categories;
    const inCart = new Map();
    for (const l of state.cart) inCart.set(l.item_id, (inCart.get(l.item_id) || 0) + l.qty);

    $('catTabs').innerHTML = cats.map((c, i) =>
      `<button class="cat-tab ${i === 0 ? 'active' : ''}" data-cat="${c.id}" type="button">${esc(c.name)}</button>`).join('') +
      `<label class="veg-toggle switch"><input type="checkbox" id="vegOnly" ${state.vegOnly ? 'checked' : ''}> Veg only</label>`;

    $('menu').innerHTML = cats.map((c) => {
      const items = state.menu.items.filter((i) => i.category_id === c.id && (!state.vegOnly || i.is_veg));
      if (!items.length) return '';
      return `
        <section class="menu-section" id="cat-${c.id}" data-cat="${c.id}">
          <h2>${esc(c.name)}</h2>
          <div class="menu-grid">
            ${items.map((i) => `
              <article class="menu-card ${i.is_available ? '' : 'off'}">
                <div class="name"><span class="veg-mark ${i.is_veg ? '' : 'nv'}" title="${i.is_veg ? 'Veg' : 'Non-veg'}"></span>${esc(i.name)}</div>
                <div class="meta"><span class="price">${money(i.price_paise)}</span> · ~${i.prep_minutes} min
                  ${inCart.get(i.id) ? `<span class="in-cart"> · ${inCart.get(i.id)} in cart</span>` : ''}</div>
                ${i.is_available
                  ? `<button class="btn small add" data-add="${i.id}" type="button">Add</button>`
                  : `<span class="add muted" style="font-size:.8rem;font-weight:700">Unavailable</span>`}
              </article>`).join('')}
          </div>
        </section>`;
    }).join('') || '<p class="empty">Nothing on the menu right now.</p>';
  }

  $('catTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    document.getElementById(`cat-${b.dataset.cat}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('catTabs').addEventListener('change', (e) => {
    if (e.target.id === 'vegOnly') { state.vegOnly = e.target.checked; renderMenu(); }
  });

  // Highlight the category tab for the section in view.
  const spy = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      document.querySelectorAll('.cat-tab').forEach((t) => t.classList.toggle('active', t.dataset.cat === en.target.dataset.cat));
    }
  }, { rootMargin: '-130px 0px -60% 0px' });
  new MutationObserver(() => document.querySelectorAll('.menu-section').forEach((s) => spy.observe(s)))
    .observe($('menu'), { childList: true });

  // ---------- add dialog ----------

  let adding = null;
  $('menu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]');
    if (!b) return;
    const item = state.itemsById.get(Number(b.dataset.add));
    if (!item || !item.is_available) return;
    adding = { item, qty: 1 };
    $('addName').textContent = item.name;
    $('addMeta').textContent = `${money(item.price_paise)} · ${item.is_veg ? 'Veg' : 'Non-veg'} · ~${item.prep_minutes} min`;
    $('addNote').value = '';
    renderAddQty();
    $('addDialog').showModal();
  });

  function renderAddQty() {
    $('addQty').textContent = adding.qty;
    $('addConfirm').textContent = `Add · ${money(adding.qty * adding.item.price_paise)}`;
  }

  $('addForm').addEventListener('click', (e) => {
    const b = e.target.closest('[data-d]');
    if (!b || !adding) return;
    adding.qty = Math.min(20, Math.max(1, adding.qty + Number(b.dataset.d)));
    renderAddQty();
  });

  $('addDialog').addEventListener('close', () => {
    if ($('addDialog').returnValue !== 'add' || !adding) return;
    const note = $('addNote').value.trim().slice(0, 140);
    const same = state.cart.find((l) => l.item_id === adding.item.id && l.note === note);
    if (same) same.qty = Math.min(50, same.qty + adding.qty);
    else state.cart.push({ item_id: adding.item.id, qty: adding.qty, note });
    state.blocked.delete(adding.item.id);
    saveCart();
    toast(`Added ${adding.qty} × ${adding.item.name}`);
    adding = null;
    renderMenu();
    renderSide();
  });

  // ---------- cart & orders ----------

  function cartProblems() {
    return state.cart.map((l) => {
      const m = state.itemsById.get(l.item_id);
      if (!m) return 'No longer on the menu — please remove';
      if (!m.is_available || state.blocked.has(l.item_id)) return 'Just became unavailable — please remove';
      return null;
    });
  }

  function renderSide() {
    const problems = cartProblems();
    const cartTotal = state.cart.reduce((s, l) => s + l.qty * (state.itemsById.get(l.item_id)?.price_paise || 0), 0);
    const cartCount = state.cart.reduce((s, l) => s + l.qty, 0);
    const hasProblem = problems.some(Boolean);
    const openNew = state.bill?.orders.find((o) => o.status === 'New');

    $('cart').innerHTML = state.cart.length ? `
      ${state.cart.map((l, idx) => {
        const m = state.itemsById.get(l.item_id);
        return `
          <div class="line ${problems[idx] ? 'bad' : ''}">
            <div><strong>${esc(m?.name || 'Unknown item')}</strong><div class="muted num" style="font-size:.85rem">${m ? money(m.price_paise) : ''}</div></div>
            <span class="stepper"><button type="button" data-cart="${idx}" data-d="-1" aria-label="Less">−</button><span>${l.qty}</span><button type="button" data-cart="${idx}" data-d="1" aria-label="More" ${problems[idx] ? 'disabled' : ''}>+</button></span>
            ${l.note ? `<div class="note">“${esc(l.note)}”</div>` : ''}
            ${problems[idx] ? `<div class="warn">${problems[idx]}</div>` : ''}
          </div>`;
      }).join('')}
      <div class="totals"><div class="grand"><span>Cart total</span><span class="num">${money(cartTotal)}</span></div></div>
      <button id="placeBtn" class="btn primary block" style="margin-top:12px" type="button" ${hasProblem || state.placing ? 'disabled' : ''}>
        ${state.placing ? 'Sending…' : openNew ? `Add to order #${openNew.id}` : 'Place order'}
      </button>
      ${openNew ? `<p class="lock-note">Your order #${openNew.id} hasn't been started yet, so these items join it.</p>` : ''}`
      : '<p class="empty">Your cart is empty.<br>Tap “Add” on any dish.</p>';

    const b = state.bill;
    $('orders').innerHTML = b && b.orders.length ? `
      ${b.orders.map((o) => `
        <div class="order-block">
          <header><strong>Order #${o.id}</strong><span class="muted">${clock(o.placed_at)}</span><span class="pill ${o.status}">${o.status}</span></header>
          ${o.items.map((l) => `
            <div class="line">
              <div>${esc(l.item_name)}<div class="muted num" style="font-size:.82rem">${money(l.unit_price_at_order)} each</div></div>
              ${o.editable
                ? `<span class="stepper"><button type="button" data-line="${l.id}" data-q="${l.qty - 1}" aria-label="Less">−</button><span>${l.qty}</span><button type="button" data-line="${l.id}" data-q="${l.qty + 1}" aria-label="More">+</button></span>`
                : `<span class="num"><strong>× ${l.qty}</strong></span>`}
              ${l.note ? `<div class="note">“${esc(l.note)}”</div>` : ''}
            </div>`).join('')}
          <p class="lock-note">${o.editable ? 'You can still change this order until the kitchen starts it.' : o.status === 'Preparing' ? '🔒 The kitchen is preparing this, so it can no longer be changed.' : o.status === 'Ready' ? '🔔 Ready, on its way to your table.' : '✓ Served. Enjoy!'}</p>
        </div>`).join('')}
      <div class="totals num">
        <div><span>Subtotal</span><span>${money(b.subtotal_paise)}</span></div>
        <div class="muted"><span>GST ${b.gst_rate_percent}%</span><span>${money(b.gst_paise)}</span></div>
        <div class="grand"><span>Total</span><span>${money(b.total_paise)}</span></div>
      </div>
      <p class="lock-note">When you're done, ask a staff member for the bill.</p>`
      : '<p class="empty">No orders yet for this table.</p>';

    $('cartFab').innerHTML = `<span>🛒 Cart ${cartCount ? `(${cartCount})` : ''}</span><span class="num">${cartCount ? money(cartTotal) : b?.orders.length ? `Bill ${money(b.total_paise)}` : ''}</span>`;
  }

  $('cart').addEventListener('click', async (e) => {
    const step = e.target.closest('[data-cart]');
    if (step) {
      const l = state.cart[Number(step.dataset.cart)];
      l.qty += Number(step.dataset.d);
      if (l.qty <= 0) state.cart.splice(Number(step.dataset.cart), 1);
      saveCart(); renderMenu(); renderSide();
      return;
    }
    if (e.target.id === 'placeBtn') placeOrder();
  });

  async function placeOrder() {
    if (!state.cart.length || state.placing) return;
    state.placing = true; renderSide();
    try {
      const r = await api(`/api/tables/${state.tableId}/orders`, { method: 'POST', body: { items: state.cart } });
      state.cart = []; saveCart(); state.blocked.clear();
      toast(r.appended ? `Added to order #${r.order_id}` : `Order #${r.order_id} sent to the kitchen`, 'good');
      closeSide();
    } catch (err) {
      if (err.status === 409 && err.data.item_ids) {
        err.data.item_ids.forEach((id) => state.blocked.add(id));
        await loadMenu().catch(() => {});
      }
      toast(err.message, 'error');
    } finally {
      state.placing = false;
      await loadBill().catch(() => {});
      renderMenu(); renderSide();
    }
  }

  $('orders').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-line]');
    if (!b) return;
    const qty = Number(b.dataset.q);
    if (qty === 0 && !confirm('Remove this item from your order?')) return;
    try {
      await api(`/api/tables/${state.tableId}/lines/${b.dataset.line}`, { method: 'PATCH', body: { qty } });
    } catch (err) {
      toast(err.message, 'error');
    }
    await loadBill(); renderSide();
  });

  // ---------- mobile sheet ----------
  function openSide() {
    $('side').classList.add('open');
    if (!document.querySelector('.scrim')) {
      const s = document.createElement('div'); s.className = 'scrim'; s.addEventListener('click', closeSide); document.body.append(s);
    }
  }
  function closeSide() { $('side').classList.remove('open'); document.querySelector('.scrim')?.remove(); }
  $('cartFab').addEventListener('click', openSide);
  $('closeSide').addEventListener('click', closeSide);

  // ---------- live ----------
  App.live(async (topics) => {
    try {
      if (topics.includes('menu')) await loadMenu();
      if (topics.includes('orders') || topics.includes('tables')) await Promise.all([loadBill(), loadTables()]);
      if (state.tableId && table()) { renderMenu(); renderSide(); } else if (!$('picker').classList.contains('hidden')) showPicker();
    } catch {}
  }, App.syncBadge($('sync')));

  // ---------- boot ----------
  (async () => {
    try {
      await Promise.all([loadTables(), loadMenu()]);
      if (state.tableId && table()) await chooseTable(state.tableId);
      else showPicker();
    } catch (err) {
      toast('Could not reach the restaurant server. Retrying…', 'error');
      setTimeout(() => location.reload(), 4000);
    }
  })();
})();
