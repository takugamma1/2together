/* 2GETHER — rental booking (short-term hours / long-term date range) */
(() => {
  const root = document.querySelector('[data-tg-rb]'); if (!root) return;
  const I = window.tgRbI18n || {};
  const EP = root.dataset.endpoint || '/apps/club';
  const D = { hourly: +root.dataset.hourly || 3, day: +root.dataset.day || 12, h24: +root.dataset.h24 || 20, maxHours: +root.dataset.maxHours || 24, hStart: +root.dataset.hourStart || 9, hEnd: +root.dataset.hourEnd || 19, minDays: +root.dataset.minDays || 2 };
  const parseTiers = (s) => (s || '').split(';').map(x => x.split('|').map(v => parseFloat(v))).filter(a => a.length === 2 && !isNaN(a[0]) && !isNaN(a[1])).sort((a, b) => a[0] - b[0]);
  const tiersDefault = parseTiers(root.dataset.tiers);
  const bikes = [...root.querySelectorAll('[data-rb-bike]')];
  const sel = {};                       // handle → qty
  let mode = 'short', avail = { booked: {}, bikes: [] }, range = { start: null, end: null }, shortDate = '', shortHour = null, shortDur = null;
  const pad = (n) => String(n).padStart(2, '0');
  const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fmt = (n) => '€' + (Math.round(n * 100) / 100).toLocaleString('bg-BG');

  /* ── availability ── */
  const bikeCfg = (h) => { const el = bikes.find(b => b.dataset.rbBike === h); return { count: +el.dataset.count || 0, hourly: parseFloat(el.dataset.hourly) || D.hourly, day: parseFloat(el.dataset.day) || D.day, tiers: parseTiers(el.dataset.tiers).length ? parseTiers(el.dataset.tiers) : tiersDefault, name: el.dataset.name }; };
  const freeOn = (h, day) => { const c = bikeCfg(h).count; const used = ((avail.booked[h] || {})[day] || 0) + ((avail.booked['*'] || {})[day] || 0); return Math.max(0, c - used); };
  const loadAvail = async () => {
    const from = new Date(); const to = new Date(); to.setMonth(to.getMonth() + 4);
    try { const r = await fetch(`${EP}/rental-availability?from=${key(from)}&to=${key(to)}`, { headers: { Accept: 'application/json' } }); if (r.ok) avail = await r.json(); } catch (e) {}
    renderBikeAvail(); renderCal(); renderSummary();
  };
  const renderBikeAvail = () => bikes.forEach(b => {
    const h = b.dataset.rbBike; const days = mode === 'short' ? (shortDate ? [shortDate] : []) : (range.start && range.end ? daysIn(range.start, range.end) : []);
    const free = days.length ? Math.min(...days.map(d => freeOn(h, d))) : +b.dataset.count;
    b.querySelector('[data-rb-avail-n]').textContent = free; b.classList.toggle('is-soldout', free <= 0);
    if ((sel[h] || 0) > free) { sel[h] = free; b.querySelector('[data-rb-qty]').textContent = free; }
  });
  const daysIn = (a, b) => { const out = []; const d = new Date(a); const e = new Date(b); while (d <= e) { out.push(key(d)); d.setDate(d.getDate() + 1); } return out; };

  /* ── bikes qty ── */
  bikes.forEach(b => {
    const h = b.dataset.rbBike, q = b.querySelector('[data-rb-qty]');
    b.querySelector('[data-rb-inc]').addEventListener('click', () => { const max = +b.querySelector('[data-rb-avail-n]').textContent; sel[h] = Math.min(max, (sel[h] || 0) + 1); q.textContent = sel[h]; b.classList.toggle('is-selected', sel[h] > 0); renderCal(); renderSummary(); });
    b.querySelector('[data-rb-dec]').addEventListener('click', () => { sel[h] = Math.max(0, (sel[h] || 0) - 1); q.textContent = sel[h]; b.classList.toggle('is-selected', sel[h] > 0); renderCal(); renderSummary(); });
  });

  /* ── mode ── */
  root.querySelectorAll('[data-rb-mode]').forEach(btn => btn.addEventListener('click', () => {
    mode = btn.dataset.rbMode;
    root.querySelectorAll('[data-rb-mode]').forEach(b => { const on = b === btn; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', on); });
    root.querySelectorAll('[data-rb-pane]').forEach(p => p.hidden = p.dataset.rbPane !== mode);
    renderBikeAvail(); renderSummary();
  }));

  /* ── short term ── */
  const dateIn = root.querySelector('[data-rb-short-date]'); dateIn.min = key(new Date());
  dateIn.addEventListener('change', () => { shortDate = dateIn.value; renderBikeAvail(); renderSummary(); });
  const hoursBox = root.querySelector('[data-rb-hours]'), dursBox = root.querySelector('[data-rb-durations]');
  for (let h = D.hStart; h <= D.hEnd - 1; h++) { const c = document.createElement('button'); c.type = 'button'; c.className = 'tg-rb-chip'; c.textContent = pad(h) + ':00'; c.dataset.h = h; c.addEventListener('click', () => { shortHour = h; [...hoursBox.children].forEach(x => x.classList.toggle('is-on', x === c)); renderSummary(); }); hoursBox.appendChild(c); }
  const durs = [1, 2, 3, 4, 6, 8]; if (D.maxHours >= 24) durs.push(24);
  durs.forEach(n => { const c = document.createElement('button'); c.type = 'button'; c.className = 'tg-rb-chip'; c.textContent = n === 24 ? '24 ' + (I.unit_hours || 'ч') : n + ' ' + (I.unit_hours || 'ч'); c.dataset.n = n; c.addEventListener('click', () => { shortDur = n; [...dursBox.children].forEach(x => x.classList.toggle('is-on', x === c)); renderSummary(); }); dursBox.appendChild(c); });
  const shortPrice = (h, hours) => { const c = bikeCfg(h); if (hours >= 24) return D.h24 || c.day * 1.6; return Math.min(hours * c.hourly, c.day); };

  /* ── long term calendar ── */
  let calMonth = new Date(); calMonth.setDate(1);
  const monthsBox = root.querySelector('[data-rb-cal-months]'), calTitle = root.querySelector('[data-rb-cal-title]');
  root.querySelector('[data-rb-cal-prev]').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() - 1); renderCal(); });
  root.querySelector('[data-rb-cal-next]').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() + 1); renderCal(); });
  const selected = () => Object.keys(sel).filter(h => sel[h] > 0);
  const dayFree = (day) => { const hs = selected(); if (!hs.length) return true; return hs.every(h => freeOn(h, day) >= sel[h]); };
  function renderCal() {
    if (!monthsBox) return; monthsBox.innerHTML = ''; const today = key(new Date());
    const names = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд']; const mn = ['Януари', 'Февруари', 'Март', 'Април', 'Май', 'Юни', 'Юли', 'Август', 'Септември', 'Октомври', 'Ноември', 'Декември'];
    for (let m = 0; m < 2; m++) {
      const first = new Date(calMonth.getFullYear(), calMonth.getMonth() + m, 1); const box = document.createElement('div'); box.className = 'tg-rb-month';
      box.innerHTML = `<div class="tg-rb-month-name">${mn[first.getMonth()]} ${first.getFullYear()}</div><div class="tg-rb-dow">${names.map(n => `<span>${n}</span>`).join('')}</div>`;
      const grid = document.createElement('div'); grid.className = 'tg-rb-days';
      const lead = (first.getDay() + 6) % 7; for (let i = 0; i < lead; i++) grid.appendChild(document.createElement('i'));
      const dim = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      for (let d = 1; d <= dim; d++) {
        const dt = new Date(first.getFullYear(), first.getMonth(), d); const k = key(dt); const b = document.createElement('button'); b.type = 'button'; b.textContent = d; b.dataset.day = k;
        const past = k < today, busy = !dayFree(k);
        if (past || busy) b.disabled = true; if (busy && !past) b.classList.add('is-busy');
        if (range.start && k === range.start) b.classList.add('is-start'); if (range.end && k === range.end) b.classList.add('is-end');
        if (range.start && range.end && k > range.start && k < range.end) b.classList.add('is-in');
        b.addEventListener('click', () => pickDay(k)); grid.appendChild(b);
      }
      box.appendChild(grid); monthsBox.appendChild(box);
    }
    if (calTitle) calTitle.textContent = '';
  }
  const pickDay = (k) => {
    if (!range.start || (range.start && range.end)) { range = { start: k, end: null }; }
    else if (k < range.start) { range = { start: k, end: null }; }
    else { const days = daysIn(range.start, k); if (days.some(d => !dayFree(d))) { range = { start: k, end: null }; } else range.end = k; }
    renderCal(); renderBikeAvail(); renderSummary();
  };
  const longPrice = (h, nDays) => { const t = bikeCfg(h).tiers; let total = 0; for (let d = 1; d <= nDays; d++) { let rate = t.length ? t[0][1] : D.day; for (const [from, price] of t) if (d >= from) rate = price; total += rate; } return total; };

  /* ── summary ── */
  const lines = root.querySelector('[data-rb-lines]'), totalEl = root.querySelector('[data-rb-total]'), status = root.querySelector('[data-rb-status]');
  const plan = () => {
    const hs = selected(); if (!hs.length) return null;
    if (mode === 'short') { if (!shortDate || shortHour === null || !shortDur) return null; const start = new Date(`${shortDate}T${pad(shortHour)}:00:00`); const end = new Date(start.getTime() + shortDur * 3600000); return { mode, start, end, items: hs.map(h => ({ h, qty: sel[h], price: shortPrice(h, shortDur) * sel[h], label: `${shortDur} ${I.unit_hours || 'ч'}` })) }; }
    if (!range.start || !range.end) return null; const n = daysIn(range.start, range.end).length; if (n < D.minDays) return null;
    return { mode, start: new Date(range.start + 'T' + pad(D.hStart) + ':00:00'), end: new Date(range.end + 'T' + pad(D.hEnd) + ':00:00'), items: hs.map(h => ({ h, qty: sel[h], price: longPrice(h, n) * sel[h], label: `${n} ${n === 1 ? (I.unit_day || 'ден') : (I.unit_days || 'дни')}` })) };
  };
  function renderSummary() {
    const p = plan(); lines.innerHTML = '';
    if (!p) { lines.innerHTML = `<dd class="tg-rb-lines-empty">${I.summary_empty || ''}</dd>`; totalEl.textContent = '—'; return; }
    let total = 0; p.items.forEach(it => { total += it.price; lines.insertAdjacentHTML('beforeend', `<div><dt>${bikeCfg(it.h).name} ×${it.qty} · ${it.label}</dt><dd>${fmt(it.price)}</dd></div>`); });
    const when = p.mode === 'short' ? `${p.start.toLocaleDateString('bg-BG')} ${pad(p.start.getHours())}:00 → ${p.end.toLocaleDateString('bg-BG')} ${pad(p.end.getHours())}:00` : `${p.start.toLocaleDateString('bg-BG')} → ${p.end.toLocaleDateString('bg-BG')}`;
    lines.insertAdjacentHTML('beforeend', `<div class="tg-rb-when"><dt>${when}</dt><dd></dd></div>`); totalEl.textContent = fmt(total); p.total = total; return p;
  }

  /* ── submit ── */
  root.querySelector('[data-rb-form]').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target; const p = renderSummary(); const name = f.name.value.trim(), phone = f.phone.value.trim();
    if (!p || !name || !phone) { status.textContent = I.msg_incomplete || ''; return; }
    const btn = f.querySelector('[data-rb-submit]'); btn.disabled = true; status.textContent = '…';
    try {
      const refs = [];
      for (const it of p.items) {
        const r = await fetch(`${EP}/rental-book`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ bike: it.h, quantity: it.qty, mode: p.mode, start: p.start.toISOString(), end: p.end.toISOString(), name, phone, email: f.email.value.trim(), note: f.note.value.trim(), price: Math.round(it.price * 100) / 100 }) });
        const j = await r.json().catch(() => ({}));
        if (r.status === 409) { status.textContent = I.msg_unavailable || ''; btn.disabled = false; loadAvail(); return; }
        if (!r.ok) throw new Error('book ' + r.status); refs.push(j.reference);
      }
      status.textContent = (I.msg_success || 'OK {ref}').replace('{ref}', refs.join(', ')); f.reset(); Object.keys(sel).forEach(k => delete sel[k]); bikes.forEach(b => { b.querySelector('[data-rb-qty]').textContent = 0; b.classList.remove('is-selected'); }); range = { start: null, end: null }; loadAvail();
    } catch (err) {
      // worker not deployed / unreachable → e-mail fallback via Shopify contact form
      const fb = document.getElementById('tg-rb-fallback');
      if (fb) {
        const lines = p.items.map(it => `${bikeCfg(it.h).name} ×${it.qty} · ${it.label} · ${fmt(it.price)}`).join('\n');
        const when = p.mode === 'short' ? `${p.start.toLocaleString('bg-BG')} → ${p.end.toLocaleString('bg-BG')}` : `${p.start.toLocaleDateString('bg-BG')} → ${p.end.toLocaleDateString('bg-BG')}`;
        fb.querySelector('[data-fb-name]').value = name; fb.querySelector('[data-fb-phone]').value = phone; fb.querySelector('[data-fb-email]').value = f.email.value.trim() || 'no-reply@2getherbikes.bg';
        fb.querySelector('[data-fb-body]').value = `${p.mode === 'short' ? 'Краткосрочен' : 'Дългосрочен'} наем\n${when}\n${lines}\nОбщо: ${fmt(p.total)}\n${f.note.value.trim()}`;
        fb.submit(); return;
      }
      status.textContent = I.msg_error || ''; btn.disabled = false;
    }
  });
  loadAvail();
})();
