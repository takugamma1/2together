/* === 2GETHER BIKES — CART DRAWER DELIVERY STEP (Econt) ===
 *
 * Lets the customer pick Econt office / address delivery inside the cart
 * drawer, shows the live Econt price (via the club-backend Worker), collects
 * name + phone (phone mandatory), stores everything as cart attributes and
 * sends the customer to checkout with the shipping address pre-filled.
 *
 * Expects the markup from snippets/2gether-cart-delivery.liquid and the
 * header's cart drawer dispatching `tg:cart-rendered` with the cart JSON.
 */
(function () {
  'use strict';

  const I = (window.tgI18n && window.tgI18n.cartDelivery) || {};

  const root = document.querySelector('[data-tg-cd]');
  if (!root) return;

  const EP = root.getAttribute('data-endpoint') || '/apps/club';
  const CHECKOUT_URL = root.getAttribute('data-checkout-url') || '/checkout';
  const STORAGE_KEY = 'tg-cart-delivery-v1';
  const cartRoot = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
  const drawer = root.closest('[data-tg-cart-drawer]');
  const checkoutBtn = drawer ? drawer.querySelector('[data-tg-cart-checkout]') : null;
  const subtotalEl = drawer ? drawer.querySelector('[data-tg-cart-subtotal]') : null;

  const $ = (sel) => root.querySelector(sel);
  const ui = {
    form: $('[data-cd-form]'),
    summary: $('[data-cd-summary]'),
    summaryMain: $('[data-cd-summary-main]'),
    summarySub: $('[data-cd-summary-sub]'),
    modes: Array.prototype.slice.call(root.querySelectorAll('[data-cd-mode]')),
    city: $('[data-cd-city]'),
    cityList: $('[data-cd-city-list]'),
    officeWrap: $('[data-cd-office-wrap]'),
    office: $('[data-cd-office]'),
    officeAddr: $('[data-cd-office-addr]'),
    addressWrap: $('[data-cd-address-wrap]'),
    street: $('[data-cd-street]'),
    other: $('[data-cd-other]'),
    name: $('[data-cd-name]'),
    phone: $('[data-cd-phone]'),
    error: $('[data-cd-error]'),
    price: $('[data-cd-price]'),
    total: $('[data-cd-total]'),
  };

  const currency = (drawer && drawer.getAttribute('data-currency')) || 'EUR';
  function money(cents) {
    try {
      return new Intl.NumberFormat(I.locale || 'bg-BG', { style: 'currency', currency }).format(cents / 100);
    } catch (err) {
      return (cents / 100).toFixed(2) + ' ' + currency;
    }
  }

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  const state = {
    mode: 'office',           // 'office' | 'address'
    city: null,               // { id, name, postCode, region }
    office: null,             // { code, name, address }
    street: '',
    other: '',
    name: '',
    phone: '',
    quote: null,              // { price, currency, free, service } | null
    quoteError: '',
    cart: { total_price: 0, total_weight: 0, item_count: 0 },
    editing: true,
  };

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (!s || typeof s !== 'object') return;
      if (s.mode === 'office' || s.mode === 'address') state.mode = s.mode;
      if (s.city && s.city.id) state.city = s.city;
      if (s.office && s.office.code) state.office = s.office;
      state.street = s.street || '';
      state.other = s.other || '';
      state.name = s.name || '';
      state.phone = s.phone || '';
    } catch (err) { /* storage unavailable */ }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: state.mode, city: state.city, office: state.office,
        street: state.street, other: state.other, name: state.name, phone: state.phone,
      }));
    } catch (err) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ */
  /* Validation                                                          */
  /* ------------------------------------------------------------------ */

  function normalizePhone(raw) {
    let p = String(raw || '').replace(/[\s().-]/g, '');
    if (/^00/.test(p)) p = '+' + p.slice(2);
    if (/^0(8[7-9]\d{7})$/.test(p)) p = '+359' + p.slice(1);
    return p;
  }

  function phoneValid(raw) {
    const p = normalizePhone(raw);
    if (/^\+3598[7-9]\d{7}$/.test(p)) return true;      // Bulgarian mobile
    if (/^\+359[2-9]\d{6,8}$/.test(p)) return true;      // Bulgarian landline
    return /^\+[1-9]\d{7,14}$/.test(p);                  // any international number
  }

  function destinationComplete() {
    if (!state.city) return false;
    if (state.mode === 'office') return !!state.office;
    return state.street.trim().length >= 3;
  }

  function nameValid() {
    return state.name.trim().length >= 2;
  }

  function readyForCheckout() {
    return destinationComplete() && phoneValid(state.phone) && nameValid();
  }

  function firstProblem() {
    if (!state.city) return I.errCity || 'Избери град или населено място.';
    if (state.mode === 'office' && !state.office) return I.errOffice || 'Избери офис на Еконт.';
    if (state.mode === 'address' && state.street.trim().length < 3) return I.errAddress || 'Въведи адрес за доставка.';
    if (!nameValid()) return I.errName || 'Въведи име и фамилия.';
    if (!phoneValid(state.phone)) return I.errPhone || 'Въведи валиден телефон — куриерът ще се свърже с теб.';
    return '';
  }

  function focusProblem() {
    if (!state.city) return ui.city.focus();
    if (state.mode === 'office' && !state.office) return ui.office.focus();
    if (state.mode === 'address' && state.street.trim().length < 3) return ui.street.focus();
    if (!nameValid()) return ui.name.focus();
    if (!phoneValid(state.phone)) return ui.phone.focus();
  }

  function showError(msg) {
    if (!ui.error) return;
    if (!msg) { ui.error.hidden = true; ui.error.textContent = ''; return; }
    ui.error.textContent = msg;
    ui.error.hidden = false;
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  function renderMode() {
    ui.modes.forEach((b) => b.setAttribute('aria-pressed', b.getAttribute('data-cd-mode') === state.mode ? 'true' : 'false'));
    ui.officeWrap.hidden = state.mode !== 'office';
    ui.addressWrap.hidden = state.mode !== 'address';
  }

  function renderOffices(list) {
    const sel = ui.office;
    sel.innerHTML = '';
    if (!list || !list.length) {
      sel.appendChild(new Option(state.city ? (I.noOffices || 'Няма офиси в този град') : (I.pickCityFirst || 'Първо избери град'), ''));
      sel.disabled = true;
      ui.officeAddr.textContent = '';
      return;
    }
    sel.appendChild(new Option(I.pickOffice || 'Избери офис…', ''));
    list.forEach((o) => {
      const label = (o.isAPS ? (I.econtomat || 'Еконтомат · ') : '') + o.name;
      const opt = new Option(label, o.code);
      opt.dataset.address = o.address || '';
      opt.dataset.name = o.name || '';
      sel.appendChild(opt);
    });
    sel.disabled = false;
    if (state.office && list.some((o) => o.code === state.office.code)) {
      sel.value = state.office.code;
      ui.officeAddr.textContent = state.office.address || '';
    } else {
      state.office = null;
      ui.officeAddr.textContent = '';
    }
  }

  function renderPrice() {
    const p = ui.price;
    const subtotal = state.cart.total_price || 0;
    if (!destinationComplete()) {
      p.textContent = '—'; p.dataset.state = 'idle';
      ui.total.textContent = money(subtotal);
      return;
    }
    if (state.quoteError) {
      p.textContent = state.quoteError; p.dataset.state = 'error';
      ui.total.textContent = money(subtotal);
      return;
    }
    if (!state.quote) {
      p.textContent = I.calculating || 'изчислява се…'; p.dataset.state = 'loading';
      ui.total.textContent = money(subtotal);
      return;
    }
    if (state.quote.free || state.quote.price === 0) {
      p.textContent = I.free || 'Безплатна'; p.dataset.state = 'free';
      ui.total.textContent = money(subtotal);
      return;
    }
    const shipCents = Math.round(state.quote.price * 100);
    p.textContent = money(shipCents); p.dataset.state = 'ok';
    ui.total.textContent = money(subtotal + shipCents);
  }

  function renderSummary() {
    const complete = readyForCheckout();
    const collapsed = complete && !state.editing;
    ui.form.hidden = collapsed;
    ui.summary.hidden = !collapsed;
    if (collapsed) {
      if (state.mode === 'office') {
        ui.summaryMain.textContent = (I.summaryOffice || 'Еконт до офис · ') + state.office.name;
        ui.summarySub.textContent = [state.city.name, state.office.address].filter(Boolean).join(' · ');
      } else {
        ui.summaryMain.textContent = (I.summaryAddress || 'Еконт до адрес · ') + state.city.name;
        ui.summarySub.textContent = [state.street, state.other].filter(Boolean).join(', ');
      }
      ui.summarySub.textContent += (ui.summarySub.textContent ? ' · ' : '') + state.name + ' · ' + normalizePhone(state.phone);
    }
  }

  function renderCheckoutGate() {
    if (!checkoutBtn) return;
    checkoutBtn.setAttribute('aria-disabled', readyForCheckout() ? 'false' : 'true');
  }

  function render() {
    renderMode();
    renderPrice();
    renderSummary();
    renderCheckoutGate();
  }

  /* ------------------------------------------------------------------ */
  /* Network                                                             */
  /* ------------------------------------------------------------------ */

  function api(path, opts) {
    return fetch(EP + path, Object.assign({ credentials: 'same-origin', headers: { Accept: 'application/json' } }, opts || {}))
      .then((r) => r.json().then((data) => ({ ok: r.ok, data })));
  }

  let cityReq = 0;
  function searchCities(q) {
    const id = ++cityReq;
    if (q.trim().length < 2) { renderCityList([]); return; }
    api('/econt-cities?q=' + encodeURIComponent(q.trim()))
      .then(({ ok, data }) => {
        if (id !== cityReq) return;
        renderCityList(ok && data.cities ? data.cities : [], !ok);
      })
      .catch(() => { if (id === cityReq) renderCityList([], true); });
  }

  let cityActive = -1;
  let cityItems = [];
  function renderCityList(list, failed) {
    cityItems = list;
    cityActive = -1;
    const ul = ui.cityList;
    ul.innerHTML = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'tg-cd-list-empty';
      li.textContent = failed ? (I.citiesUnavailable || 'Списъкът с градове не е достъпен в момента.') : (I.noCities || 'Няма намерени населени места.');
      ul.appendChild(li);
    } else {
      list.forEach((c, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.setAttribute('data-i', String(i));
        li.innerHTML = '<span>' + escapeHtml(c.name) + '</span><small>' + escapeHtml([c.postCode, c.region].filter(Boolean).join(' · ')) + '</small>';
        ul.appendChild(li);
      });
    }
    ul.hidden = false;
    ui.city.setAttribute('aria-expanded', 'true');
  }

  function closeCityList() {
    ui.cityList.hidden = true;
    ui.city.setAttribute('aria-expanded', 'false');
    cityActive = -1;
  }

  function chooseCity(c) {
    state.city = { id: c.id, name: c.name, postCode: c.postCode || '', region: c.region || '' };
    state.office = null;
    ui.city.value = c.name;
    ui.city.removeAttribute('aria-invalid');
    closeCityList();
    save();
    loadOffices();
    requestQuote();
    render();
  }

  let officeReq = 0;
  function loadOffices() {
    const id = ++officeReq;
    if (!state.city) { renderOffices([]); return; }
    ui.office.innerHTML = '';
    ui.office.appendChild(new Option(I.loading || 'Зареждане…', ''));
    ui.office.disabled = true;
    api('/econt-offices?city=' + encodeURIComponent(state.city.id))
      .then(({ ok, data }) => {
        if (id !== officeReq) return;
        renderOffices(ok && data.offices ? data.offices : []);
        if (state.mode === 'office' && !state.office && ui.office.options.length > 1 && !ui.office.disabled) {
          // Nothing to do — the customer picks; keep the price idle.
        }
        render();
      })
      .catch(() => { if (id === officeReq) { renderOffices([]); render(); } });
  }

  let quoteReq = 0;
  let quoteTimer = null;
  function requestQuote(delay) {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(doQuote, typeof delay === 'number' ? delay : 250);
  }

  function doQuote() {
    state.quote = null;
    state.quoteError = '';
    if (!destinationComplete() || !(state.cart.item_count > 0)) { render(); return; }
    const id = ++quoteReq;
    render();
    const body = {
      mode: state.mode,
      officeCode: state.mode === 'office' && state.office ? state.office.code : '',
      city: state.city,
      street: state.street,
      other: state.other,
      weightGrams: state.cart.total_weight || 0,
      subtotal: (state.cart.total_price || 0) / 100,
      name: state.name,
      phone: normalizePhone(state.phone),
    };
    api('/econt-quote', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
      .then(({ ok, data }) => {
        if (id !== quoteReq) return;
        if (ok && data && typeof data.price === 'number') {
          state.quote = data;
        } else {
          state.quoteError = I.quoteError || 'Цената ще се изчисли при плащане';
        }
        render();
        syncAttributes();
      })
      .catch(() => {
        if (id !== quoteReq) return;
        state.quoteError = I.quoteError || 'Цената ще се изчисли при плащане';
        render();
      });
  }

  /* ------------------------------------------------------------------ */
  /* Cart attributes + checkout hand-off                                 */
  /* ------------------------------------------------------------------ */

  function attributes() {
    const phone = normalizePhone(state.phone);
    const attrs = {
      'Доставка': state.mode === 'office' ? 'Еконт — до офис' : 'Еконт — до адрес',
      // Plain key for checkout apps that hide the other Econt rate (Shopify Functions).
      delivery_mode: state.mode,
      'Име': state.name.trim(),
      'Телефон': phone,
      'Град': state.city ? state.city.name + (state.city.postCode ? ' ' + state.city.postCode : '') : '',
      'Еконт офис': '',
      'Адрес': '',
      '_econt_office_code': '',
      '_econt_city_id': state.city ? String(state.city.id) : '',
      '_econt_price_estimate': state.quote && typeof state.quote.price === 'number' ? state.quote.price.toFixed(2) : '',
    };
    if (state.mode === 'office' && state.office) {
      attrs['Еконт офис'] = state.office.name + ' [код ' + state.office.code + ']' + (state.office.address ? ' — ' + state.office.address : '');
      attrs._econt_office_code = state.office.code;
    } else {
      attrs['Адрес'] = [state.street.trim(), state.other.trim()].filter(Boolean).join(', ');
    }
    return attrs;
  }

  let attrTimer = null;
  let lastAttrJson = '';
  function syncAttributes(immediate) {
    clearTimeout(attrTimer);
    const run = () => {
      if (!readyForCheckout()) return Promise.resolve();
      const attrs = attributes();
      const j = JSON.stringify(attrs);
      if (j === lastAttrJson) return Promise.resolve();
      lastAttrJson = j;
      return fetch(cartRoot + 'cart/update.js', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ attributes: attrs }),
      }).catch(() => { lastAttrJson = ''; });
    };
    if (immediate) return run();
    attrTimer = setTimeout(run, 500);
    return null;
  }

  function splitName(full) {
    const parts = full.trim().split(/\s+/);
    if (parts.length === 1) return { first: '', last: parts[0] };
    return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
  }

  function checkoutHref() {
    const n = splitName(state.name);
    const sa = {};
    sa.first_name = n.first;
    sa.last_name = n.last;
    sa.country = 'Bulgaria';
    sa.phone = normalizePhone(state.phone);
    sa.city = state.city ? state.city.name : '';
    sa.zip = state.city ? state.city.postCode : '';
    if (state.mode === 'office' && state.office) {
      sa.address1 = 'Еконт офис ' + state.office.name + ' [код ' + state.office.code + ']';
      sa.address2 = state.office.address || '';
    } else {
      sa.address1 = state.street.trim();
      sa.address2 = state.other.trim();
    }
    const params = new URLSearchParams();
    Object.keys(sa).forEach((k) => { if (sa[k]) params.set('checkout[shipping_address][' + k + ']', sa[k]); });
    return CHECKOUT_URL + (CHECKOUT_URL.indexOf('?') >= 0 ? '&' : '?') + params.toString();
  }

  function goToCheckout(e) {
    if (root.hidden) return; // delivery step not active (empty cart etc.)
    e.preventDefault();
    if (!readyForCheckout()) {
      state.editing = true;
      render();
      showError(firstProblem());
      focusProblem();
      return;
    }
    showError('');
    checkoutBtn.setAttribute('aria-busy', 'true');
    const href = checkoutHref();
    const done = () => { window.location.href = href; };
    const p = syncAttributes(true);
    let navigated = false;
    const go = () => { if (!navigated) { navigated = true; done(); } };
    if (p && typeof p.then === 'function') p.then(go, go);
    setTimeout(go, 2500); // never trap the customer if the cart update hangs
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  ui.modes.forEach((b) => b.addEventListener('click', () => {
    const m = b.getAttribute('data-cd-mode');
    if (m === state.mode) return;
    state.mode = m;
    state.editing = true;
    showError('');
    save();
    if (m === 'office' && state.city && ui.office.disabled) loadOffices();
    requestQuote(0);
    render();
  }));

  let cityTimer = null;
  ui.city.addEventListener('input', () => {
    const v = ui.city.value;
    if (state.city && v !== state.city.name) {
      state.city = null; state.office = null; renderOffices([]);
      state.quote = null; render();
    }
    clearTimeout(cityTimer);
    cityTimer = setTimeout(() => searchCities(v), 180);
  });
  ui.city.addEventListener('focus', () => { if (!state.city && ui.city.value.trim().length >= 2) searchCities(ui.city.value); });
  ui.city.addEventListener('keydown', (e) => {
    if (ui.cityList.hidden) return;
    const items = ui.cityList.querySelectorAll('li[role="option"]');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      cityActive = e.key === 'ArrowDown' ? Math.min(items.length - 1, cityActive + 1) : Math.max(0, cityActive - 1);
      items.forEach((li, i) => li.setAttribute('aria-selected', i === cityActive ? 'true' : 'false'));
      items[cityActive].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (cityActive >= 0 && cityItems[cityActive]) { e.preventDefault(); chooseCity(cityItems[cityActive]); }
      else if (cityItems.length === 1) { e.preventDefault(); chooseCity(cityItems[0]); }
    } else if (e.key === 'Escape') {
      closeCityList();
    }
  });
  ui.cityList.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[role="option"]');
    if (!li) return;
    e.preventDefault();
    const c = cityItems[parseInt(li.getAttribute('data-i'), 10)];
    if (c) chooseCity(c);
  });
  ui.city.addEventListener('blur', () => setTimeout(closeCityList, 120));

  ui.office.addEventListener('change', () => {
    const opt = ui.office.options[ui.office.selectedIndex];
    if (!opt || !opt.value) { state.office = null; ui.officeAddr.textContent = ''; }
    else {
      state.office = { code: opt.value, name: opt.dataset.name || opt.text, address: opt.dataset.address || '' };
      ui.officeAddr.textContent = state.office.address;
    }
    showError('');
    save();
    requestQuote(0);
    render();
  });

  function onAddressInput() {
    state.street = ui.street.value;
    state.other = ui.other.value;
    save();
    requestQuote(700);
    render();
  }
  ui.street.addEventListener('input', onAddressInput);
  ui.other.addEventListener('input', onAddressInput);

  ui.name.addEventListener('input', () => {
    state.name = ui.name.value;
    if (nameValid()) ui.name.removeAttribute('aria-invalid');
    save(); render(); syncAttributes();
  });

  ui.phone.addEventListener('input', () => {
    state.phone = ui.phone.value;
    if (phoneValid(state.phone)) { ui.phone.removeAttribute('aria-invalid'); showError(''); }
    save(); render(); syncAttributes();
  });
  ui.phone.addEventListener('blur', () => {
    if (state.phone.trim() && !phoneValid(state.phone)) ui.phone.setAttribute('aria-invalid', 'true');
    else ui.phone.removeAttribute('aria-invalid');
  });

  ui.summary.addEventListener('click', () => { state.editing = true; render(); });

  if (checkoutBtn) checkoutBtn.addEventListener('click', goToCheckout);

  // Collapse to the summary once everything is valid and a price is in.
  function maybeCollapse() {
    if (readyForCheckout() && state.quote && document.activeElement !== ui.phone && document.activeElement !== ui.name) {
      state.editing = false;
      render();
    }
  }
  [ui.name, ui.phone].forEach((el) => el.addEventListener('blur', () => setTimeout(maybeCollapse, 150)));

  /* ------------------------------------------------------------------ */
  /* Cart integration                                                    */
  /* ------------------------------------------------------------------ */

  function applyCart(cart) {
    if (!cart || typeof cart.item_count !== 'number') return;
    const changed = cart.total_price !== state.cart.total_price || cart.total_weight !== state.cart.total_weight;
    state.cart = { total_price: cart.total_price || 0, total_weight: cart.total_weight || 0, item_count: cart.item_count || 0 };
    root.hidden = !(state.cart.item_count > 0);
    if (changed && destinationComplete()) requestQuote(0);
    else render();
  }

  document.addEventListener('tg:cart-rendered', (e) => applyCart(e.detail));
  document.addEventListener('cart:updated', (e) => { if (e.detail && typeof e.detail.item_count === 'number') applyCart(e.detail); });

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  load();
  if (state.city) ui.city.value = state.city.name;
  ui.street.value = state.street;
  ui.other.value = state.other;
  ui.name.value = state.name;
  ui.phone.value = state.phone;
  renderOffices([]);
  if (state.city) loadOffices();
  state.editing = !readyForCheckout();
  render();

  fetch(cartRoot + 'cart.js', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then(applyCart)
    .catch(() => {});

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
})();
