/* 2GETHER — service booking wizard (metaobjects + worker) */
(() => {
  const root = document.querySelector('[data-tg-sb]'); if (!root) return;
  const T = (window.TG_SB && window.TG_SB.t) || {}; const MONTHS = (window.TG_SB && window.TG_SB.months) || [];
  const EP = root.dataset.endpoint || '/apps/club';
  const state = { service: null, mechanic: 'any', mechanicName: T.anyMech, date: null, time: null, slotMech: null, slots: {}, month: null, loaded: new Set() };
  const steps = [...root.querySelectorAll('[data-sb-step]')]; const tabs = [...root.querySelectorAll('[data-sb-step-tab]')];
  const show = (n) => { steps.forEach(s => s.classList.toggle('is-active', s.dataset.sbStep === String(n))); tabs.forEach(t => { const k = +t.dataset.sbStepTab; t.classList.toggle('is-active', k === n); t.classList.toggle('is-done', k < n); }); window.scrollTo({ top: root.querySelector('#tg-sb-book').offsetTop - 80, behavior: 'smooth' }); };
  const stepEl = (n) => root.querySelector(`[data-sb-step="${n}"]`);
  const fmtDate = (iso) => { const d = new Date(iso + 'T12:00:00'); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };

  // step 1 — select
  const sticky = root.querySelector('[data-sb-sticky]');
  function selectService(b) {
    root.querySelectorAll('[data-sb-service]').forEach(x => x.classList.toggle('is-selected', x === b));
    state.service = { handle: b.dataset.sbService, name: b.dataset.name, duration: +b.dataset.duration, price: b.dataset.price, priceTo: b.dataset.priceTo || '' };
    stepEl(1).querySelector('[data-sb-next]').disabled = false; state.loaded.clear(); state.slots = {}; state.date = state.time = null;
    if (sticky) { sticky.hidden = false; sticky.querySelector('[data-sb-sticky-name]').textContent = state.service.name; }
  }
  root.querySelectorAll('[data-sb-service]').forEach(b => b.addEventListener('click', () => selectService(b)));
  // step 1 — filter (chips + search)
  const search = root.querySelector('[data-sb-search]'); const chips = root.querySelectorAll('[data-sb-cat]'); let cat = '';
  function applyFilter() {
    const q = (search ? search.value : '').trim().toLowerCase(); let any = false;
    root.querySelectorAll('[data-sb-group]').forEach(g => {
      let n = 0; g.querySelectorAll('[data-sb-service]').forEach(b => { const ok = (!cat || b.dataset.cat === cat) && (!q || b.dataset.search.includes(q)); b.hidden = !ok; if (ok) n++; });
      g.hidden = n === 0; any = any || n > 0;
    });
    const empty = root.querySelector('[data-sb-empty]'); if (empty) empty.hidden = any;
  }
  chips.forEach(c => c.addEventListener('click', () => { cat = c.dataset.sbCat; chips.forEach(x => x.classList.toggle('is-active', x === c)); applyFilter(); }));
  if (search) search.addEventListener('input', applyFilter);
  // price list → pick a service
  root.querySelectorAll('[data-sb-pick]').forEach(b => b.addEventListener('click', () => {
    const target = root.querySelector(`[data-sb-service="${b.dataset.sbPick}"]`); if (!target) return;
    cat = ''; chips.forEach(x => x.classList.toggle('is-active', x.dataset.sbCat === '')); if (search) search.value = ''; applyFilter();
    selectService(target); show(2);
  }));
  // price list — expand + search + counts
  root.querySelectorAll('[data-sb-pl-toggle]').forEach(b => b.addEventListener('click', () => { const d = b.closest('[data-sb-pl-item]').querySelector('.tg-sb-pl-desc'); const open = d.hidden; d.hidden = !open; b.setAttribute('aria-expanded', String(open)); }));
  const plSearch = root.querySelector('[data-sb-price-search]');
  function applyPlFilter() {
    const q = (plSearch ? plSearch.value : '').trim().toLowerCase(); let any = false;
    root.querySelectorAll('[data-sb-pl-cat]').forEach(d => {
      let n = 0; d.querySelectorAll('[data-sb-pl-item]').forEach(it => { const ok = !q || it.dataset.search.includes(q); it.hidden = !ok; if (ok) n++; });
      d.hidden = n === 0; d.querySelector('[data-sb-pl-count]').textContent = n; if (q && n) d.open = true; any = any || n > 0;
    });
    const e = root.querySelector('[data-sb-pl-empty]'); if (e) e.hidden = any;
  }
  if (plSearch) plSearch.addEventListener('input', applyPlFilter); applyPlFilter();
  // step 2
  root.querySelectorAll('[data-sb-mechanic]').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('[data-sb-mechanic]').forEach(x => x.classList.toggle('is-selected', x === b));
    state.mechanic = b.dataset.sbMechanic; state.mechanicName = b.dataset.name; state.loaded.clear(); state.slots = {}; state.date = state.time = null;
  }));
  // nav
  root.querySelectorAll('[data-sb-next]').forEach(b => b.addEventListener('click', () => { const cur = +b.closest('[data-sb-step]').dataset.sbStep; if (cur === 2) { renderCal(); } if (cur === 3) fillSummary(); show(cur + 1); }));
  root.querySelectorAll('[data-sb-back]').forEach(b => b.addEventListener('click', () => { const cur = +b.closest('[data-sb-step]').dataset.sbStep; show(cur - 1); }));

  // step 3 — calendar
  const cal = root.querySelector('[data-sb-cal]'), daysEl = root.querySelector('[data-sb-cal-days]'), titleEl = root.querySelector('[data-sb-cal-title]'), noteEl = root.querySelector('[data-sb-cal-note]');
  const timesEl = root.querySelector('[data-sb-times]'), timesTitle = root.querySelector('[data-sb-times-title]');
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  async function loadMonth(first) {
    const k = key(first); if (state.loaded.has(k)) return; state.loaded.add(k);
    noteEl.textContent = T.loading; noteEl.hidden = false;
    const from = key(first < new Date() ? new Date() : first);
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const span = Math.max(1, daysInMonth - (first < new Date() ? new Date().getDate() - 1 : 0));
    try {
      const r = await fetch(`${EP}/service-slots?from=${from}&days=${span}&service=${encodeURIComponent(state.service.handle)}&mechanic=${encodeURIComponent(state.mechanic)}&nc=${Date.now()}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json(); Object.assign(state.slots, j.slots || {}); state.mechNames = Object.fromEntries((j.mechanics || []).map(m => [m.handle, m.name]));
      noteEl.hidden = true;
    } catch (e) { noteEl.textContent = T.errGeneric; state.workerDown = true; }
    paintDays();
  }
  function paintDays() {
    const first = state.month; const start = new Date(first); const lead = (start.getDay() + 6) % 7; const dim = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    titleEl.textContent = `${MONTHS[first.getMonth()]} ${first.getFullYear()}`; daysEl.innerHTML = '';
    for (let i = 0; i < lead; i++) daysEl.appendChild(Object.assign(document.createElement('span'), { className: 'tg-sb-day tg-sb-day--pad' }));
    const today = key(new Date());
    for (let d = 1; d <= dim; d++) {
      const dt = new Date(first.getFullYear(), first.getMonth(), d); const k = key(dt); const free = state.slots[k] ? Object.values(state.slots[k]).reduce((n, a) => n + a.length, 0) : 0;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'tg-sb-day' + (free ? ' has-free' : '') + (k === state.date ? ' is-selected' : '') + (k < today ? ' is-past' : ''); b.disabled = !free; b.innerHTML = `<span>${d}</span>${free ? `<small>${free}</small>` : ''}`;
      b.addEventListener('click', () => { state.date = k; state.time = null; paintDays(); paintTimes(); });
      daysEl.appendChild(b);
    }
  }
  function paintTimes() {
    const next = stepEl(3).querySelector('[data-sb-next]'); next.disabled = true; timesEl.innerHTML = '';
    if (!state.date) { timesTitle.textContent = T.pickDay; return; }
    timesTitle.textContent = fmtDate(state.date); const perMech = state.slots[state.date] || {};
    if (!Object.keys(perMech).length) { timesEl.innerHTML = `<p class="tg-rp-text">${T.noSlots}</p>`; return; }
    for (const [mh, list] of Object.entries(perMech)) {
      const g = document.createElement('div'); g.className = 'tg-sb-time-group';
      if (state.mechanic === 'any') g.innerHTML = `<h4>${state.mechNames && state.mechNames[mh] || mh}</h4>`;
      const wrap = document.createElement('div'); wrap.className = 'tg-sb-time-chips';
      list.forEach(t => { const c = document.createElement('button'); c.type = 'button'; c.className = 'tg-rp-seg-btn' + (state.time === t && state.slotMech === mh ? ' is-active' : ''); c.textContent = t; c.addEventListener('click', () => { state.time = t; state.slotMech = mh; paintTimes(); next.disabled = false; }); wrap.appendChild(c); });
      g.appendChild(wrap); timesEl.appendChild(g);
    }
  }
  function renderCal() { if (!state.month) state.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1); paintDays(); paintTimes(); loadMonth(state.month); }
  root.querySelector('[data-sb-cal-prev]').addEventListener('click', () => { const m = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1); if (m < new Date(new Date().getFullYear(), new Date().getMonth(), 1)) return; state.month = m; renderCal(); });
  root.querySelector('[data-sb-cal-next]').addEventListener('click', () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1); renderCal(); });

  // step 4
  function fillSummary() {
    const s = root.querySelector('[data-sb-summary]'); const mechName = state.mechanic === 'any' ? (state.mechNames && state.mechNames[state.slotMech]) || T.anyMech : state.mechanicName;
    s.querySelector('[data-sum="service"]').textContent = state.service.name; s.querySelector('[data-sum="mechanic"]').textContent = mechName;
    s.querySelector('[data-sum="when"]').textContent = `${fmtDate(state.date)}, ${state.time}`; 
    s.querySelector('[data-sum="price"]').textContent = state.service.price ? (state.service.priceTo ? `€${state.service.price} – ${state.service.priceTo}` : `€${state.service.price}`) : '—';
  }
  const form = root.querySelector('[data-sb-form]'), err = root.querySelector('[data-sb-error]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.hidden = true;
    const f = form.elements; if (!f.name.value.trim() || !f.phone.value.trim()) { err.textContent = T.errFields; err.hidden = false; return; }
    const btn = form.querySelector('[data-sb-submit]'); const label = btn.textContent; btn.disabled = true; btn.textContent = T.sending;
    const startIso = new Date(`${state.date}T${state.time}:00`).toISOString();
    const payload = { mechanic: state.slotMech || state.mechanic, service: state.service.handle, start: startIso, name: f.name.value.trim(), phone: f.phone.value.trim(), email: f.email.value.trim(), bike: f.bike.value.trim(), note: f.note.value.trim() };
    try {
      const r = await fetch(`${EP}/service-book`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
      if (r.status === 409) { err.textContent = T.errSlot; err.hidden = false; state.loaded.clear(); state.slots = {}; show(3); renderCal(); return; }
      if (r.status === 404 || r.status >= 500) throw new Error('down');
      const j = await r.json(); if (!j.ok) throw new Error('bad');
      done(j.reference, j.mechanic, false);
    } catch (ex) {
      // fallback: e-mail via Shopify contact form
      const fb = document.getElementById('tg-sb-fallback'); if (fb) { fb.querySelector('[data-fb="name"]').value = payload.name; fb.querySelector('[data-fb="phone"]').value = payload.phone; fb.querySelector('[data-fb="email"]').value = payload.email; fb.querySelector('[data-fb="details"]').value = `Сервиз: ${state.service.name} | Механик: ${payload.mechanic} | ${state.date} ${state.time} | Колело: ${payload.bike} | ${payload.note}`; try { await fetch(fb.action, { method: 'POST', body: new FormData(fb) }); } catch (_) {} }
      done('—', state.mechanicName, true);
    } finally { btn.disabled = false; btn.textContent = label; }
  });
  function done(ref, mech, fallback) {
    const txt = fallback ? T.doneFallback : (T.doneText || '').replace('[service]', state.service.name).replace('[mechanic]', mech || '').replace('[when]', `${fmtDate(state.date)}, ${state.time}`);
    root.querySelector('[data-sb-done-text]').textContent = txt; root.querySelector('[data-sb-ref]').textContent = ref; show('done');
  }
})();
