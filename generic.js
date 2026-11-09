// Media Grab - generic scanner for any website ("Other sites" tab).
// Injected on demand through activeTab + scripting (no blanket host access needed).
// Finds: <img> (incl. lazy-load attributes), <video>, links to media files, og:/twitter: meta,
// CSS background images, and media files the page loaded (Resource Timing).
(() => {
  'use strict';
  if (globalThis.__mgGenericInjected) return;
  globalThis.__mgGenericInjected = true;

  const U = MGCore.util;
  const SITE = location.hostname;
  const IMG = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
  const VID = /\.(mp4|webm|mov|m4v|mkv)$/i;
  const STREAM = /\.(m3u8|mpd)$/i;
  const BAD = /(sprite|pixel|beacon|1x1|spacer|blank\.|placeholder|analytics|doubleclick|googlesyndication|facebook\.com\/tr|favicon|\/emoji\/|gravatar\.com\/avatar)/i;
  const FULL_ATTRS = ['data-full-src', 'data-full', 'data-large', 'data-zoom-image', 'data-hires', 'data-original', 'data-src', 'data-lazy-src'];

  const abs = u => { try { return new URL(u, location.href).href; } catch (e) { return ''; } };
  const pathOf = u => { try { return new URL(u, location.href).pathname; } catch (e) { return ''; } };
  function stemOf(url) {
    let s = pathOf(url).split('/').filter(Boolean).pop() || '';
    try { s = decodeURIComponent(s); } catch (e) {}
    return U.clean(s.replace(/\.[a-z0-9]{2,5}$/i, '')).slice(0, 80);
  }
  function idOf(url) {
    try { return U.hash(new URL(url).host + U.pathKey(url)); } catch (e) { return U.hash(url); }
  }

  function emitMedia(o) {
    const url = abs(o.url);
    if (!/^https?:/.test(url) || BAD.test(url)) return;
    const id = idOf(url);
    core.add({
      id, type: o.type, url,
      thumb: o.thumb ? abs(o.thumb) : '',
      stem: stemOf(url) || ('media_' + id),
      width: o.width || 0, height: o.height || 0,
      postUrl: location.href, source: o.source || 'dom',
      streaming: !!o.streaming, ytdlpUrl: o.streaming ? (o.ytdlpUrl || url) : ''
    });
  }

  function bestSrc(img) {
    let best = img.currentSrc || img.src, w0 = 0;
    const set = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    if (set) {
      for (const part of set.split(',')) {
        const [u, d] = part.trim().split(/\s+/);
        const w = parseInt(d, 10) || 0;
        if (u && w >= w0) { w0 = w; best = u; }
      }
    }
    return best;
  }

  function scanImages() {
    document.querySelectorAll('img').forEach(img => {
      try {
        const r = img.getBoundingClientRect();
        const nw = img.naturalWidth || 0, nh = img.naturalHeight || 0;
        if (Math.max(r.width, nw) < 150 || Math.max(r.height, nh) < 100) return;   // icons, ads, spacers
        const shown = bestSrc(img);
        let full = '';
        for (const a of FULL_ATTRS) {
          const v = img.getAttribute(a);
          if (v && /^(https?:)?\/\//.test(v) || (v && v.startsWith('/'))) { full = v; break; }
        }
        let url = full || shown;
        if (!url || url.startsWith('data:') || /\.svg(\?|$)/i.test(url)) return;
        emitMedia({
          url, type: 'image', source: 'dom',
          thumb: full && shown && abs(shown) !== abs(full) ? shown : '',
          width: full ? 0 : (nw || Math.round(r.width)), height: full ? 0 : (nh || Math.round(r.height))
        });
      } catch (e) {}
    });
  }

  function scanVideos() {
    document.querySelectorAll('video').forEach((v, i) => {
      try {
        const srcEl = v.querySelector('source[src]');
        const src = v.currentSrc || v.src || (srcEl && srcEl.src) || '';
        if (!src) return;
        const r = v.getBoundingClientRect();
        const w = v.videoWidth || Math.round(r.width), h = v.videoHeight || Math.round(r.height);
        const poster = v.poster || '';
        if (src.startsWith('blob:') || src.startsWith('mediasource:')) {
          // The real file is assembled in memory: hand the page to yt-dlp instead.
          core.add({
            id: 'blob_' + U.hash(location.href + '|' + poster + '|' + i), type: 'video', url: location.href, ext: 'mp4',
            stem: U.clean(document.title || SITE).slice(0, 80), thumb: poster, width: w, height: h,
            postUrl: location.href, streaming: true, ytdlpUrl: location.href, source: 'dom'
          });
        } else if (STREAM.test(pathOf(src))) {
          emitMedia({ url: src, type: 'video', thumb: poster, width: w, height: h, streaming: true, ytdlpUrl: abs(src) });
        } else {
          emitMedia({ url: src, type: 'video', thumb: poster, width: w, height: h });
        }
      } catch (e) {}
    });
  }

  function scanLinks() {
    let n = 0;
    for (const a of document.querySelectorAll('a[href]')) {
      if (++n > 3000) break;
      const href = a.href;
      if (!/^https?:/.test(href)) continue;
      const p = pathOf(href);
      const isImg = IMG.test(p), isVid = VID.test(p), isStream = STREAM.test(p);
      if (!isImg && !isVid && !isStream) continue;
      const th = a.querySelector('img');
      emitMedia({
        url: href, type: isImg ? 'image' : 'video', source: 'link', streaming: isStream, ytdlpUrl: isStream ? href : '',
        thumb: th ? (th.currentSrc || th.src) : ''
      });
    }
  }

  function scanMeta() {
    const vals = sel => [...document.querySelectorAll(sel)].map(m => m.getAttribute('content') || m.getAttribute('href')).filter(Boolean);
    const num = sel => { const m = document.querySelector(sel); return m ? (+m.getAttribute('content') || 0) : 0; };
    const w = num('meta[property="og:image:width"]'), h = num('meta[property="og:image:height"]');
    vals('meta[property="og:image"],meta[property="og:image:url"],meta[property="og:image:secure_url"],meta[name="twitter:image"],meta[name="twitter:image:src"],link[rel="image_src"]')
      .forEach(u => emitMedia({ url: u, type: 'image', width: w, height: h, source: 'meta' }));
    vals('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"],meta[name="twitter:player:stream"]')
      .forEach(u => {
        const p = pathOf(u);
        if (VID.test(p)) emitMedia({ url: u, type: 'video', source: 'meta' });
        else if (STREAM.test(p)) emitMedia({ url: u, type: 'video', source: 'meta', streaming: true, ytdlpUrl: abs(u) });
      });
  }

  function scanBackgrounds() {
    const t0 = performance.now();
    let n = 0;
    for (const el of document.querySelectorAll('[style*="url("], div, section, header, figure, li, a, span')) {
      if (++n > 2500 || performance.now() - t0 > 40) break;      // time-boxed: keeps big pages responsive
      let bg = '';
      try { bg = getComputedStyle(el).backgroundImage; } catch (e) { continue; }
      if (!bg || bg === 'none' || bg.indexOf('url(') < 0) continue;
      const m = /url\(["']?(.*?)["']?\)/.exec(bg);
      if (!m || !m[1] || m[1].startsWith('data:') || /\.svg(\?|$)/i.test(m[1])) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 150 || r.height < 100) continue;
      emitMedia({ url: m[1], type: 'image', width: Math.round(r.width), height: Math.round(r.height), source: 'bg' });
    }
  }

  // Media the page actually loaded (catches mp4/webm/m3u8 started by scripts, big CSS/XHR images).
  const RES = /\.(mp4|webm|mov|m4v|mkv|m3u8|mpd|jpe?g|png|webp|gif|avif)$/i;
  function onEntry(e) {
    try {
      if (!/^https?:/.test(e.name)) return;
      const m = RES.exec(pathOf(e.name));
      if (!m) return;
      const ext = m[1].toLowerCase();
      const isStream = ext === 'm3u8' || ext === 'mpd';
      const isVid = isStream || /^(mp4|webm|mov|m4v|mkv)$/.test(ext);
      if (isVid && e.initiatorType === 'img') return;
      if (!isVid && !(e.decodedBodySize >= 20000)) return;     // images: only when known to be large
      emitMedia({ url: e.name, type: isVid ? 'video' : 'image', source: 'perf', streaming: isStream, ytdlpUrl: isStream ? e.name : '' });
    } catch (err) {}
  }
  function scanResources() {
    try { performance.getEntriesByType('resource').forEach(onEntry); } catch (e) {}
  }
  try {
    new PerformanceObserver(list => list.getEntries().forEach(onEntry)).observe({ type: 'resource', buffered: false });
  } catch (e) {}

  function scan() {
    scanImages();
    scanVideos();
    scanLinks();
    scanMeta();
    scanBackgrounds();
    scanResources();
  }

  const core = MGCore.create({ platform: 'other', scan, settle: 150 });
})();
