/* 2GETHER BIKES — predictive search bubble.
 * Attaches to every [data-tg-suggest] wrapper containing a search input.
 * Queries Shopify's suggest API for products + collections and renders
 * a dropdown bubble; Enter opens the full search results page. */
(function () {
  var ENDPOINT = '/search/suggest.json';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function init(wrap) {
    var input = wrap.querySelector('input[type="search"]');
    if (!input) return;

    var bubble = document.createElement('div');
    bubble.className = 'tg-suggest';
    bubble.hidden = true;
    wrap.appendChild(bubble);

    var timer = null;
    var lastQ = '';

    function close() { bubble.hidden = true; }

    function render(data, q) {
      var res = (data && data.resources && data.resources.results) || {};
      var prods = res.products || [];
      var colls = res.collections || [];
      var h = '';

      if (!prods.length && !colls.length) {
        h = '<div class="tg-suggest-empty">Няма съвпадения за „' + esc(q) + '”</div>';
      } else {
        if (prods.length) {
          h += '<div class="tg-suggest-group">Продукти</div>';
          h += prods.map(function (p) {
            var img = p.featured_image && p.featured_image.url
              ? '<img src="' + esc(p.featured_image.url) + '" alt="" loading="lazy" width="44" height="44">'
              : '<span class="tg-suggest-noimg" aria-hidden="true"></span>';
            return (
              '<a class="tg-suggest-item" href="' + esc(p.url) + '">' + img +
                '<span class="tg-suggest-item-body">' +
                  '<span class="tg-suggest-item-title">' + esc(p.title) + '</span>' +
                  (p.price ? '<span class="tg-suggest-item-price">' + esc(p.price) + '</span>' : '') +
                '</span>' +
              '</a>'
            );
          }).join('');
        }
        if (colls.length) {
          h += '<div class="tg-suggest-group">Категории</div>';
          h += colls.map(function (c) {
            return (
              '<a class="tg-suggest-item tg-suggest-item--coll" href="' + esc(c.url) + '">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7h5l2 3h11v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 0V5a2 2 0 0 1 2-2h4l2 3"/></svg>' +
                '<span class="tg-suggest-item-title">' + esc(c.title) + '</span>' +
              '</a>'
            );
          }).join('');
        }
        h += '<a class="tg-suggest-all" href="/search?type=product&q=' + encodeURIComponent(q) + '">Виж всички резултати &rarr;</a>';
      }

      bubble.innerHTML = h;
      bubble.hidden = false;
    }

    input.addEventListener('input', function () {
      var q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 2) { close(); return; }
      timer = setTimeout(function () {
        lastQ = q;
        var url = ENDPOINT +
          '?q=' + encodeURIComponent(q) +
          '&resources[type]=product,collection' +
          '&resources[limit]=6' +
          '&resources[options][unavailable_products]=last';
        fetch(url, { headers: { Accept: 'application/json' } })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
          .then(function (d) { if (q === lastQ) render(d, q); })
          .catch(close);
      }, 220);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'Enter') {
        var q = input.value.trim();
        if (q) {
          e.preventDefault();
          window.location.href = '/search?type=product&q=' + encodeURIComponent(q);
        }
      }
    });

    input.addEventListener('focus', function () {
      if (bubble.innerHTML && input.value.trim().length >= 2) bubble.hidden = false;
    });

    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) close();
    });
  }

  document.querySelectorAll('[data-tg-suggest]').forEach(init);
})();
