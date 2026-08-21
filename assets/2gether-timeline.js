/* 2GETHER Timeline — horizontal, clickable, smooth-scrolling */
(() => {
  const init = (section) => {
    if (!section || section.dataset.tlReady) return;
    section.dataset.tlReady = '1';

    const track   = section.querySelector('[data-tl-track]');
    const rail    = section.querySelector('[data-tl-rail]');
    const nodes   = [...section.querySelectorAll('[data-tl-node]')];
    const imgs    = [...section.querySelectorAll('[data-tl-img]')];
    const panels  = [...section.querySelectorAll('[data-tl-panel]')];
    const bars    = [...section.querySelectorAll('[data-tl-progress] i')];
    const fill    = section.querySelector('[data-tl-fill]');
    const big     = section.querySelector('[data-tl-big]');
    const prevBtn = section.querySelector('[data-tl-prev]');
    const nextBtn = section.querySelector('[data-tl-next]');
    if (!track || !nodes.length) return;

    let current = 0;
    let dragged = false;

    const updateFill = () => {
      const n = nodes[current];
      fill.style.width = (n.offsetLeft + n.offsetWidth / 2) + 'px';
    };

    const centerNode = (i, smooth = true) => {
      const n = nodes[i];
      const left = n.offsetLeft + n.offsetWidth / 2 - track.clientWidth / 2;
      track.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
    };

    const activate = (i, { scroll = true, focus = false } = {}) => {
      i = Math.max(0, Math.min(nodes.length - 1, i));
      if (i !== current || !nodes[i].classList.contains('is-active')) {
        nodes.forEach((n, k) => {
          const on = k === i;
          n.classList.toggle('is-active', on);
          n.setAttribute('aria-selected', on);
          n.tabIndex = on ? 0 : -1;
        });
        imgs.forEach((img, k) => img.classList.toggle('is-active', k === i));
        panels.forEach((p, k) => {
          const on = k === i;
          p.classList.toggle('is-active', on);
          if (on) p.hidden = false;
          else setTimeout(() => { if (!p.classList.contains('is-active')) p.hidden = true; }, 450);
        });
        bars.forEach((b, k) => b.classList.toggle('is-active', k <= i));
        if (big) {
          big.style.opacity = 0;
          big.style.transform = 'translateY(12px)';
          setTimeout(() => {
            big.textContent = nodes[i].dataset.tlYear || '';
            big.style.opacity = 1;
            big.style.transform = 'none';
          }, 220);
        }
        current = i;
      }
      if (prevBtn) prevBtn.disabled = current === 0;
      if (nextBtn) nextBtn.disabled = current === nodes.length - 1;
      updateFill();
      if (scroll) centerNode(current);
      if (focus) nodes[current].focus({ preventScroll: true });
    };

    nodes.forEach((n, i) => {
      n.addEventListener('click', () => { if (!dragged) activate(i); });
      n.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); activate(i + 1, { focus: true }); }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); activate(i - 1, { focus: true }); }
        if (e.key === 'Home')       { e.preventDefault(); activate(0, { focus: true }); }
        if (e.key === 'End')        { e.preventDefault(); activate(nodes.length - 1, { focus: true }); }
      });
    });
    prevBtn && prevBtn.addEventListener('click', () => activate(current - 1));
    nextBtn && nextBtn.addEventListener('click', () => activate(current + 1));

    // Drag to scroll (mouse)
    let isDown = false, startX = 0, startScroll = 0;
    track.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') return;
      isDown = true; dragged = false;
      startX = e.clientX; startScroll = track.scrollLeft;
      track.classList.add('is-dragging');
    });
    window.addEventListener('pointermove', (e) => {
      if (!isDown) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 4) dragged = true;
      track.scrollLeft = startScroll - dx;
    });
    window.addEventListener('pointerup', () => {
      if (!isDown) return;
      isDown = false;
      track.classList.remove('is-dragging');
      if (dragged) {
        const center = track.scrollLeft + track.clientWidth / 2;
        let best = 0, bestD = Infinity;
        nodes.forEach((n, k) => {
          const d = Math.abs(n.offsetLeft + n.offsetWidth / 2 - center);
          if (d < bestD) { bestD = d; best = k; }
        });
        activate(best);
      }
      setTimeout(() => { dragged = false; }, 0);
    });

    // Vertical wheel over the track scrolls it horizontally
    track.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        track.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    // Reveal
    const reveal = () => {
      if (section.classList.contains('visible')) return;
      section.classList.add('visible');
      updateFill();
      centerNode(current, false);
      io && io.disconnect();
      window.removeEventListener('scroll', revealIfInView);
    };
    const revealIfInView = () => {
      const r = section.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.85 && r.bottom > 0) reveal();
    };
    const io = 'IntersectionObserver' in window
      ? new IntersectionObserver((entries) => entries.forEach((en) => en.isIntersecting && reveal()), { threshold: 0.2 })
      : null;
    io && io.observe(section);
    window.addEventListener('scroll', revealIfInView, { passive: true });
    window.addEventListener('load', revealIfInView);

    // Keep fill + centering in sync with layout changes
    let rafId = 0;
    const resync = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => { updateFill(); centerNode(current, false); });
    };
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(resync);
      ro.observe(track);
      rail && ro.observe(rail);
    } else {
      window.addEventListener('resize', resync);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(resync);

    // Theme editor: selecting a block activates it
    section.__tlActivate = activate;

    activate(0, { scroll: false });
    centerNode(0, false);
    revealIfInView();
  };

  const initAll = () => document.querySelectorAll('[data-tg-timeline]').forEach(init);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();

  document.addEventListener('shopify:section:load', (e) => {
    const s = e.target.querySelector('[data-tg-timeline]');
    s && init(s);
  });
  document.addEventListener('shopify:block:select', (e) => {
    const s = e.target.closest('[data-tg-timeline]');
    if (!s || !s.__tlActivate) return;
    const idx = [...s.querySelectorAll('[data-tl-node]')].findIndex((n) => n.dataset.blockId === e.detail.blockId);
    if (idx > -1) s.__tlActivate(idx);
  });
})();
