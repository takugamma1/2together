/* 2GETHER BIKES — Club blog: YouTube clips as thumbnail facades.
 * Finds YouTube iframes and bare YouTube links inside the article body
 * and replaces them with a thumbnail + play button. The real iframe is
 * only loaded on click (faster page, no third-party requests up front). */
(function () {
  var ID_RE = /(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

  function ytId(url) {
    var m = String(url || '').match(ID_RE);
    return m ? m[1] : null;
  }

  function thumbUrl(id, name) {
    return 'https://i.ytimg.com/vi/' + id + '/' + name + '.jpg';
  }

  function buildFacade(id, playLabel) {
    var wrap = document.createElement('div');
    wrap.className = 'tg-yt';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tg-yt-face';
    btn.setAttribute('aria-label', playLabel);

    var img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = thumbUrl(id, 'maxresdefault');
    // maxresdefault does not exist for every video: it either 404s or
    // comes back as a 120px placeholder — fall back to hqdefault.
    img.addEventListener('load', function () {
      if (img.naturalWidth <= 120) img.src = thumbUrl(id, 'hqdefault');
    });
    img.addEventListener('error', function () {
      if (img.src.indexOf('hqdefault') === -1) img.src = thumbUrl(id, 'hqdefault');
    });

    var play = document.createElement('span');
    play.className = 'tg-yt-play';
    play.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5-11-6.5Z"/></svg>';

    var label = document.createElement('span');
    label.className = 'tg-yt-label';
    label.textContent = playLabel;

    btn.appendChild(img);
    btn.appendChild(play);
    btn.appendChild(label);
    wrap.appendChild(btn);

    btn.addEventListener('click', function () {
      var iframe = document.createElement('iframe');
      iframe.className = 'tg-yt-iframe';
      iframe.src = 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0';
      iframe.title = playLabel;
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      iframe.allowFullscreen = true;
      wrap.textContent = '';
      wrap.appendChild(iframe);
      iframe.focus();
    });

    return wrap;
  }

  function enhance(body) {
    var playLabel = body.getAttribute('data-yt-play-label') || 'Play video';

    // 1) Iframes pasted via the admin rich-text editor ("insert video").
    body
      .querySelectorAll('iframe[src*="youtube.com/embed/"], iframe[src*="youtube-nocookie.com/embed/"]')
      .forEach(function (iframe) {
        var id = ytId(iframe.getAttribute('src'));
        if (!id) return;
        var target = iframe.parentElement;
        // Shopify wraps pasted videos in a <div>/<p> holding only the iframe.
        if (!target || target === body || target.childElementCount !== 1 || target.textContent.trim() !== '') {
          target = iframe;
        }
        target.replaceWith(buildFacade(id, playLabel));
      });

    // 2) Bare YouTube links (URL pasted as its own line/paragraph).
    body
      .querySelectorAll('a[href*="youtube.com/watch"], a[href*="youtu.be/"], a[href*="youtube.com/shorts/"], a[href*="youtube.com/live/"]')
      .forEach(function (a) {
        var id = ytId(a.getAttribute('href'));
        if (!id) return;
        var text = a.textContent.trim();
        // Only convert links whose visible text is the URL itself; leave
        // worded links ("watch our ride here") as regular links.
        if (!/^https?:\/\//.test(text)) return;
        var p = a.closest('p, div');
        var target = p && p !== body && p.textContent.trim() === text ? p : a;
        target.replaceWith(buildFacade(id, playLabel));
      });

    // 3) YouTube URLs left as plain text (not auto-linked by the editor).
    body.querySelectorAll('p, div').forEach(function (el) {
      if (el.childElementCount !== 0) return;
      var text = el.textContent.trim();
      if (!/^https?:\/\/\S+$/.test(text)) return;
      var id = ytId(text);
      if (id) el.replaceWith(buildFacade(id, playLabel));
    });
  }

  document.querySelectorAll('[data-tg-article-body]').forEach(enhance);
})();
