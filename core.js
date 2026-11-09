// Media Grab - shared core (isolated world). Used by content.js (Twitter/Instagram/
// Facebook/YouTube) and generic.js (any other site).
// Responsibilities: normalize items, dedupe (by media id AND asset path, keep the
// largest version), persist per platform, answer popup commands.
(() => {
  'use strict';
  if (globalThis.MGCore) return;

  const clean = s => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  const isUrl = u => typeof u === 'string' && /^https?:\/\//i.test(u);
  const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function extOf(url, def) {
    const f = /[?&]format=(\w{3,4})/.exec(url);
    if (f) return f[1].toLowerCase();
    try {
      const m = /\.(jpe?g|png|webp|gif|avif|bmp|mp4|webm|mov|m4v|mkv)$/i.exec(new URL(url).pathname);
      if (m) return m[1].toLowerCase();
    } catch (e) {}
    return def;
  }
  function pathKey(url) {
    try {
      const p = new URL(url).pathname;
      const yt = /^\/vi(?:_webp)?\/([\w-]{11})\//.exec(p);
      if (yt) return 'yt/' + yt[1];
      return p.replace(/\.(jpe?g|png|webp|gif|avif|bmp|mp4|mov|webm|m4v|mkv)$/i, '');
    } catch (e) { return url; }
  }
  const score = it => (it.width || 0) * (it.height || 0) + (it.alts ? it.alts.length : 0);

  function create(cfg) {
    const PLATFORM = cfg.platform;
    const KEY = 'mediaGrab_' + PLATFORM;
    const MAX_ITEMS = 1000;
    const buffer = new Map();     // item.key -> item
    const byPath = new Map();     // item.pk  -> item.key
    const thumbPaths = new Set(); // image|pathKey of posters/thumbnails that belong to another item
    const removedKeys = new Set();
    let mode = 'idle', observer = null, domTimer = null, commitTimer = null;
    let chain = Promise.resolve();

    function normalize(r) {
      if (!r || !isUrl(r.url)) return null;
      const type = r.type === 'video' || r.type === 'gif' ? r.type : 'image';
      const id = String(r.id || '').slice(0, 120);
      if (!id) return null;
      const def = type === 'image' ? 'jpg' : 'mp4';
      const ext = String(r.ext || extOf(r.url, def)).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || def;
      let stem;
      if (r.stem) {
        stem = clean(r.stem).slice(0, 100);
      } else {
        const bits = r.title ? [r.title, id] : [r.author, r.postId && r.postId !== id ? r.postId : '', id];
        stem = clean(bits.filter(Boolean).join('_')).slice(0, 120);
        if (!r.author && !r.title) stem = PLATFORM + (r.reel ? '_reel_' : '_') + stem;
      }
      if (!stem) stem = PLATFORM + '_' + id;
      return {
        key: (type === 'image' ? 'img' : 'vid') + ':' + id,
        id, platform: PLATFORM, type,
        url: r.url,
        thumb: isUrl(r.thumb) ? r.thumb : '',
        fallbackUrl: isUrl(r.fallbackUrl) ? r.fallbackUrl : '',
        name: stem + '.' + ext, ext,
        width: +r.width || 0, height: +r.height || 0,
        quality: String(r.quality || ''),
        author: clean(r.author),
        site: PLATFORM === 'other' ? location.hostname : '',
        postUrl: isUrl(r.postUrl) ? r.postUrl : location.href,
        ytdlpUrl: isUrl(r.ytdlpUrl) ? r.ytdlpUrl : '',
        reel: !!r.reel,
        streaming: !!r.streaming,
        alts: Array.isArray(r.alts) ? r.alts.filter(a => a && isUrl(a.url)).slice(0, 8)
          .map(a => ({ url: a.url, quality: String(a.quality || ''), height: +a.height || 0, bitrate: +a.bitrate || 0 })) : [],
        source: r.source || 'api',
        capturedAt: +r.capturedAt || Date.now(),
        pk: type + '|' + pathKey(r.url)
      };
    }

    function add(raw) {
      const it = normalize(raw);
      if (!it) return;
      const existing = buffer.has(it.key) ? it.key : byPath.get(it.pk);
      if (existing) {
        const old = buffer.get(existing);
        if (old && score(it) <= score(old)) return;
        buffer.delete(existing);
        if (existing !== it.key) removedKeys.add(existing);
      }
      buffer.set(it.key, it);
      byPath.set(it.pk, it.key);
      // A poster/thumbnail that belongs to this item must not be listed as its own image.
      if (it.thumb && pathKey(it.thumb) !== pathKey(it.url)) {
        const tk = 'image|' + pathKey(it.thumb);
        thumbPaths.add(tk);
        const k = byPath.get(tk), o = k && buffer.get(k);
        if (o && o.source !== 'api' && k !== it.key) { buffer.delete(k); byPath.delete(tk); removedKeys.add(k); }
      }
      if (mode === 'auto') scheduleCommit();
    }
    const isPoster = url => thumbPaths.has('image|' + pathKey(url));

    function scheduleCommit(delay = 400) {
      clearTimeout(commitTimer);
      commitTimer = setTimeout(commit, delay);
    }
    function commit() {
      chain = chain.then(doCommit).catch(() => 0);
      return chain;
    }
    async function doCommit() {
      if (!buffer.size && !removedKeys.size) return 0;
      const res = await chrome.storage.local.get(KEY);
      const map = new Map((res[KEY] || []).map(i => [i.key, i]));
      removedKeys.forEach(k => map.delete(k));
      removedKeys.clear();
      const pmap = new Map();
      for (const i of map.values()) pmap.set(i.pk || (i.type + '|' + pathKey(i.url)), i.key);
      for (const [k, it] of buffer) {
        const ek = pmap.get(it.pk);
        if (ek && ek !== k) {
          const old = map.get(ek);
          if (old && score(it) <= score(old)) continue;
          map.delete(ek);
        }
        const same = map.get(k);
        if (!same || score(it) > score(same) || same.source === 'dom') map.set(k, it);
        pmap.set(it.pk, k);
      }
      let arr = [...map.values()].sort((a, b) => a.capturedAt - b.capturedAt);
      if (arr.length > MAX_ITEMS) arr = arr.slice(-MAX_ITEMS);
      await chrome.storage.local.set({ [KEY]: arr });
      return arr.length;
    }

    function startAuto() {
      mode = 'auto';
      if (cfg.rescan) cfg.rescan();
      try { cfg.scan(); } catch (e) {}
      scheduleCommit(0);
      if (observer) observer.disconnect();
      observer = new MutationObserver(() => {
        clearTimeout(domTimer);
        domTimer = setTimeout(() => { try { cfg.scan(); } catch (e) {} }, 700);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
    }
    function stopAuto() {
      mode = 'idle';
      if (observer) { observer.disconnect(); observer = null; }
      clearTimeout(domTimer);
      clearTimeout(commitTimer);
    }

    chrome.runtime.onMessage.addListener((msg, _sender, send) => {
      (async () => {
        switch (msg && msg.cmd) {
          case 'status':
            return { ok: true, platform: PLATFORM, mode, buffered: buffer.size };
          case 'start':
            if (cfg.rescan) cfg.rescan();
            try { await cfg.scan(); } catch (e) {}
            await sleep(cfg.settle === undefined ? 400 : cfg.settle);
            await commit();
            return { ok: true, buffered: buffer.size };
          case 'auto':
            startAuto();
            return { ok: true, mode };
          case 'stop':
            stopAuto();
            await commit();
            return { ok: true, mode };
          case 'clear':
            buffer.clear(); byPath.clear(); thumbPaths.clear(); removedKeys.clear();
            await chrome.storage.local.set({ [KEY]: [] });
            return { ok: true };
          case 'diag':
            return { ok: true, platform: PLATFORM, page: location.href.split('?')[0], mode, buffered: buffer.size, extra: cfg.diag ? await cfg.diag() : null };
        }
      })().then(send);
      return true;
    });

    return { add, commit, isPoster, buffer };
  }

  globalThis.MGCore = { create, util: { clean, isUrl, hash, extOf, pathKey, sleep } };
})();
