/* 2GETHER — ramp positions illustrator (shared by the ramps page + product template) */
(() => {
  const init = (root) => {
    if (root.dataset.ready) return; root.dataset.ready = '1';
    const S = 2.6, PX = 60, GY = 232;
    const q = (k) => root.querySelector(k);
    const deck = q('[data-rp-deck]'), shape = q('[data-rp-deck-shape]'), side = q('[data-rp-deck-side]'), edge = q('[data-rp-deck-edge]'), grip = q('[data-rp-deck-grip]');
    const leg = q('[data-rp-leg]'), legLine = q('[data-rp-leg-line]');
    const dim = q('[data-rp-dim]'), dimLine = q('[data-rp-dim-line]'), dimTop = q('[data-rp-dim-top]'), dimText = q('[data-rp-dim-text]');
    const caption = q('[data-rp-caption]'), readout = q('[data-rp-readout]');
    const modelBtns = [...root.querySelectorAll('[data-rp-model]')];
    const posBtns = [...root.querySelectorAll('[data-rp-pos]')];
    if (!deck || !modelBtns.length) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const posWord = root.dataset.posWord || 'позиция';
    let model = modelBtns.find(b => b.classList.contains('is-active')) || modelBtns[0], pos = 0;
    let cur = { L: 0, h: 0 }, from = null, to = null, t0 = 0, raf = 0;

    const setSeg = (btns, active) => btns.forEach(b => { const on = b === active; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', on); });
    const target = () => {
      const L = parseFloat(model.dataset.length) || 130;
      const hs = (model.dataset.heights || '').split(',').map(v => parseFloat(v)).filter(n => !isNaN(n));
      return { L, h: hs[Math.min(pos, Math.max(hs.length - 1, 0))] || 0 };
    };
    const render = ({ L, h }) => {
      const Lpx = L * S, hpx = Math.min(h * S, Lpx - 1);
      const ang = Math.asin(hpx / Lpx), deg = -ang * 180 / Math.PI;
      const tipX = PX + Lpx * Math.cos(ang);
      shape.setAttribute('points', `0,0 0,-8 ${Lpx},-8 ${Lpx},0`);
      side.setAttribute('points', `0,0 ${Lpx},0 ${Lpx},12 0,12`);
      edge.setAttribute('x2', Lpx);
      deck.setAttribute('transform', `translate(${PX} ${GY}) rotate(${deg})`);
      leg.setAttribute('transform', `translate(${(tipX - 16).toFixed(1)} ${GY})`);
      legLine.setAttribute('y2', -(hpx - 6));
      dim.setAttribute('transform', `translate(${(tipX + 30).toFixed(1)} ${GY})`);
      dimLine.setAttribute('y2', -hpx);
      dimTop.setAttribute('y1', -hpx); dimTop.setAttribute('y2', -hpx);
      dimText.setAttribute('y', -hpx / 2 + 6);
      if (grip && grip.dataset.len !== String(Lpx)) {
        grip.dataset.len = String(Lpx); grip.innerHTML = '';
        for (let x = 40; x < Lpx - 30; x += 44) { const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); r.setAttribute('x', x); r.setAttribute('y', -7); r.setAttribute('width', 22); r.setAttribute('height', 6); r.setAttribute('rx', 1); grip.appendChild(r); }
      }
    };
    const ease = (x) => 1 - Math.pow(1 - x, 3);
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / 600), e = ease(p);
      cur = { L: from.L + (to.L - from.L) * e, h: from.h + (to.h - from.h) * e };
      render(cur);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    const draw = (animate = true) => {
      to = target();
      const { h } = to, name = model.dataset.name || '';
      dimText.textContent = `${h} cm`;
      if (caption) caption.textContent = `${name} · ${posWord} ${pos + 1}`;
      if (readout) readout.textContent = `${name} · ${posWord} ${pos + 1} · ${h} cm`;
      root.style.setProperty('--model', model.dataset.color || '#E8601C');
      cancelAnimationFrame(raf);
      if (!animate || reduce || !cur.L) { cur = { ...to }; render(cur); return; }
      from = { ...cur }; t0 = performance.now(); raf = requestAnimationFrame(tick);
    };
    modelBtns.forEach(b => b.addEventListener('click', () => { model = b; setSeg(modelBtns, b); draw(); }));
    posBtns.forEach(b => b.addEventListener('click', () => { pos = +b.dataset.rpPos; setSeg(posBtns, b); draw(); }));
    draw(false);
  };
  const all = () => document.querySelectorAll('[data-rp-positions]').forEach(init);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', all); else all();
  document.addEventListener('shopify:section:load', all);
})();
