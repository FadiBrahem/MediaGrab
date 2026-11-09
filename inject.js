// Media Grab - page-world hook (world: MAIN, document_start).
// Reads the JSON the site already fetches (fetch/XHR + JSON embedded in the page) and
// extracts real media URLs: original-size images and direct mp4 files.
(() => {
  'use strict';
  if (window.__mediaGrabInjected) return;
  const H = location.hostname;
  const PLATFORM =
    /(^|\.)(x|twitter)\.com$/.test(H) ? 'twitter' :
    /(^|\.)instagram\.com$/.test(H) ? 'instagram' :
    /(^|\.)facebook\.com$/.test(H) ? 'facebook' :
    /(^|\.)youtube\.com$/.test(H) ? 'youtube' : null;
  if (!PLATFORM) return;
  window.__mediaGrabInjected = true;

  const area = o => (o && o.width && o.height) ? o.width * o.height : 0;
  const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  function extOf(url, def) {
    const f = /[?&]format=(\w{3,4})/.exec(url);
    if (f) return f[1].toLowerCase();
    try {
      const m = /\.(jpe?g|png|webp|gif|mp4|webm|mov|m4v)$/i.exec(new URL(url).pathname);
      if (m) return m[1].toLowerCase();
    } catch (e) {}
    return def;
  }

  // ---------- outbox (batched postMessage to the content script) ----------
  const seen = new Set();
  const diag = { reqs: [], hits: [] };
  let outbox = [];
  let timer = null;
  let emitted = 0;
  function emit(item) {
    if (!item || !item.id || !item.url) return;
    const k = item.type + '|' + item.id + '|' + item.url + '|' + (item.alts ? item.alts.length : 0);
    if (seen.has(k)) return;
    seen.add(k);
    item.platform = PLATFORM;
    item.capturedAt = Date.now();
    outbox.push(item);
    emitted++;
    if (!timer) timer = setTimeout(flush, 120);
  }
  function flush() {
    timer = null;
    if (!outbox.length) return;
    const items = outbox;
    outbox = [];
    window.postMessage({ __mediaGrab: true, items }, location.origin);
  }

  // ---------- generic JSON walker ----------
  // visit(node, ctx) -> undefined (continue), new ctx object, or false (stop descending)
  function walk(node, ctx, visit, depth) {
    if (!node || typeof node !== 'object' || depth > 80) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], ctx, visit, depth + 1);
      return;
    }
    const r = visit(node, ctx);
    if (r === false) return;
    const c = r || ctx;
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') walk(v, c, visit, depth + 1);
    }
  }

  // ---------- Twitter / X ----------
  function twVisit(node, ctx) {
    let c;
    const lg = node.legacy;
    if (node.rest_id && lg && typeof lg === 'object' && ('full_text' in lg || 'extended_entities' in lg || 'entities' in lg)) {
      const u = node.core && node.core.user_results && node.core.user_results.result;
      const user = (u && ((u.core && u.core.screen_name) || (u.legacy && u.legacy.screen_name))) || ctx.user;
      c = { tweetId: node.rest_id, user };
    }
    if (node.media_url_https && node.type && (node.id_str || node.media_key)) {
      twMedia(node, c || ctx);
      return false;
    }
    return c;
  }
  function twMedia(m, c) {
    const id = String(m.id_str || m.media_key);
    const raw = m.media_url_https;
    const postUrl = c.tweetId ? `https://x.com/${c.user || 'i'}/status/${c.tweetId}` : location.href;
    const base = { id, author: c.user || '', postId: c.tweetId || '', postUrl };
    const w = (m.original_info && m.original_info.width) || 0;
    const h = (m.original_info && m.original_info.height) || 0;

    if (m.type === 'photo') {
      const mm = /^(https:\/\/pbs\.twimg\.com\/media\/[\w-]+)\.(\w+)/.exec(raw);
      const ext = mm ? mm[2] : 'jpg';
      emit({
        ...base, type: 'image', ext, width: w, height: h,
        url: mm ? `${mm[1]}?format=${ext}&name=orig` : raw,
        thumb: mm ? `${mm[1]}?format=${ext}&name=small` : raw
      });
      return;
    }
    const type = m.type === 'animated_gif' ? 'gif' : 'video';
    const vars = (m.video_info && m.video_info.variants) || [];
    const mp4 = vars.filter(v => v.content_type === 'video/mp4' && v.url)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (mp4.length) {
      const alts = mp4.map(v => {
        const r = /\/(\d{2,4})x(\d{2,4})\//.exec(v.url);
        return { url: v.url, width: r ? +r[1] : 0, height: r ? +r[2] : 0, bitrate: v.bitrate || 0, quality: r ? r[2] + 'p' : '' };
      });
      emit({
        ...base, type, ext: 'mp4', thumb: raw, url: alts[0].url,
        width: alts[0].width || w, height: alts[0].height || h, quality: alts[0].quality, alts
      });
    } else {
      const any = vars.find(v => v.url);
      if (any) emit({ ...base, type, ext: 'mp4', thumb: raw, url: any.url, ytdlpUrl: postUrl, width: w, height: h, streaming: true });
    }
  }

  // ---------- Instagram ----------
  function igVisit(node, ctx) {
    let c;
    const code = node.code || node.shortcode;
    if (code && typeof code === 'string' &&
        (node.image_versions2 || node.video_versions || node.carousel_media || node.display_url ||
         node.edge_sidecar_to_children || node.media_type)) {
      const user = (node.user && node.user.username) || (node.owner && node.owner.username) || ctx.user;
      c = { code, user, kind: node.product_type === 'clips' ? 'reel' : 'p' };
    }
    const cc = c || ctx;
    if (node.image_versions2 || node.video_versions) {
      if (!node.carousel_media) igV1(node, cc);
    } else if (typeof node.display_url === 'string' && (node.__typename || node.is_video !== undefined) && !node.edge_sidecar_to_children) {
      igGql(node, cc);
    }
    return c;
  }
  function igPostUrl(c) {
    return c.code ? `https://www.instagram.com/${c.kind === 'reel' ? 'reel' : 'p'}/${c.code}/` : location.href;
  }
  function igV1(n, c) {
    const id = String(n.pk || n.id || '').split('_')[0];
    if (!id) return;
    const cands = ((n.image_versions2 && n.image_versions2.candidates) || [])
      .filter(x => x && x.url).sort((a, b) => area(b) - area(a));
    const best = cands[0];
    const small = cands.slice().reverse().find(x => x.width >= 150) || best;
    const base = { id, author: c.user || '', postId: c.code || '', postUrl: igPostUrl(c) };
    const vs = (n.video_versions || []).filter(v => v && v.url).sort((a, b) => area(b) - area(a));
    if (vs.length) {
      const alts = vs.map(v => ({ url: v.url, width: v.width || 0, height: v.height || 0, quality: v.height ? v.height + 'p' : '' }));
      emit({ ...base, type: 'video', ext: 'mp4', url: alts[0].url, thumb: small ? small.url : '', width: alts[0].width, height: alts[0].height, quality: alts[0].quality, alts });
      return;
    }
    if (best) emit({ ...base, type: 'image', ext: extOf(best.url, 'jpg'), url: best.url, thumb: small ? small.url : best.url, width: best.width || 0, height: best.height || 0 });
  }
  function igGql(n, c) {
    const id = String(n.id || n.shortcode || '');
    if (!id) return;
    const res = (n.display_resources || []).filter(r => r && r.src).sort((a, b) => (b.config_width || 0) - (a.config_width || 0));
    const imgUrl = (res[0] && res[0].src) || n.display_url;
    const dims = n.dimensions || {};
    const base = { id, author: c.user || '', postId: c.code || n.shortcode || '', postUrl: igPostUrl({ code: c.code || n.shortcode, kind: c.kind }) };
    if (n.is_video && n.video_url) {
      emit({ ...base, type: 'video', ext: 'mp4', url: n.video_url, thumb: n.display_url, width: dims.width || 0, height: dims.height || 0 });
    } else {
      emit({ ...base, type: 'image', ext: extOf(imgUrl, 'jpg'), url: imgUrl, thumb: n.thumbnail_src || n.display_url, width: (res[0] && res[0].config_width) || dims.width || 0, height: (res[0] && res[0].config_height) || dims.height || 0 });
    }
  }

  // ---------- Facebook (videos, reels, photos) ----------
  // Facebook's GraphQL shapes change often, so three layers are used:
  //  1. known fields (browser_native_*, playable_url*, progressive_urls[].progressive_url)
  //  2. schema-agnostic fallback: any string property that looks like an fbcdn .mp4
  //  3. DASH-only videos are listed as "stream-only" so they can go to yt-dlp
  const FB_MP4 = /^https:\/\/[^\/]*fbcdn\.net\/[^?#]*\.mp4(?:[?#]|$)/i;
  const fbVideos = new Map();   // video id -> Map(url -> alt)

  function fbEfg(u) {
    try {
      const efg = new URL(u).searchParams.get('efg');
      if (!efg) return '';
      const j = JSON.parse(atob(efg.replace(/-/g, '+').replace(/_/g, '/')));
      return String(j.vencode_tag || '');
    } catch (e) { return ''; }
  }
  function fbHeight(u, q) {
    const m = /(\d{3,4})p/.exec(fbEfg(u));
    if (m) return +m[1];
    return q === 'HD' ? 720 : q === 'SD' ? 360 : 0;
  }
  function fbCollect(n) {
    const out = [];
    const push = (u, q, trusted) => {
      if (typeof u !== 'string' || !/^https?:\/\//.test(u) || out.some(o => o.url === u)) return;
      if (!trusted) { const t = fbEfg(u); if (/dash/i.test(t) && !/progress/i.test(t)) return; }  // skip audio/video-only DASH pieces
      out.push({ url: u, quality: q || '' });
    };
    push(n.browser_native_hd_url, 'HD', 1); push(n.playable_url_quality_hd, 'HD', 1);
    push(n.hd_src_no_ratelimit || n.hd_src, 'HD', 1);
    push(n.browser_native_sd_url, 'SD', 1); push(n.playable_url, 'SD', 1);
    push(n.sd_src_no_ratelimit || n.sd_src, 'SD', 1);
    if (Array.isArray(n.progressive_urls)) {
      for (const p of n.progressive_urls) if (p) push(p.progressive_url, (p.metadata && p.metadata.quality) || '', 1);
    }
    for (const k in n) {
      const v = n[k];
      if (typeof v === 'string' && v.length > 40 && v.charCodeAt(0) === 104 && v.indexOf('.mp4') > 0 &&
          FB_MP4.test(v) && !/dash|audio|base_?url/i.test(k)) push(v, /hd/i.test(k) ? 'HD' : '', 0);
    }
    return out;
  }
  function fbPostUrl(c, vid) {
    if (c.link && /^https:\/\/(www\.)?facebook\.com\//.test(c.link)) return c.link;
    if (/^\d+$/.test(vid)) return c.reel ? `https://www.facebook.com/reel/${vid}` : `https://www.facebook.com/watch/?v=${vid}`;
    return location.href;
  }
  function fbVideo(c, urls) {
    let vid = c.vid;
    if (!vid) { try { vid = 'v' + hash(new URL(urls[0].url).pathname); } catch (e) { return; } }
    let acc = fbVideos.get(vid);
    if (!acc) fbVideos.set(vid, acc = new Map());
    urls.forEach(u => { if (!acc.has(u.url)) acc.set(u.url, { url: u.url, quality: u.quality, height: fbHeight(u.url, u.quality) }); });
    const alts = [...acc.values()].sort((a, b) => b.height - a.height || (a.url < b.url ? -1 : 1));
    emit({
      id: vid, type: 'video', ext: 'mp4', url: alts[0].url, thumb: c.thumb || '', quality: alts[0].quality,
      alts, reel: !!c.reel, postUrl: fbPostUrl(c, vid)
    });
  }
  function fbStreamOnly(c) {
    const postUrl = fbPostUrl(c, c.vid);
    emit({ id: c.vid, type: 'video', ext: 'mp4', url: postUrl, ytdlpUrl: postUrl, thumb: c.thumb || '', streaming: true, reel: !!c.reel, postUrl });
  }
  function fbVisit(node, ctx) {
    let c;
    if (node.short_form_video_context || node.__typename === 'ShortFormVideoContext') c = { ...ctx, reel: true };
    const hasId = typeof node.id === 'string' || typeof node.id === 'number';
    if (node.__typename === 'Video' && hasId) {
      const t = (node.preferred_thumbnail && node.preferred_thumbnail.image && node.preferred_thumbnail.image.uri) ||
                (node.thumbnailImage && node.thumbnailImage.uri) || (node.image && node.image.uri) || '';
      const link = node.permalink_url || node.url;
      const base = c || ctx;
      c = { ...base, vid: String(node.id), thumb: t || base.thumb, link: typeof link === 'string' ? link : '' };
      if (/\/reels?\//.test(c.link)) c.reel = true;
    }
    const cc = c || ctx;
    const urls = fbCollect(node);
    if (urls.length) {
      const vid = cc.vid || (hasId && /^\d{6,}$/.test(String(node.id)) ? String(node.id) : '');
      fbVideo({ ...cc, vid }, urls);
    } else if (cc.vid && (node.dash_manifest || node.dash_manifest_xml || node.dash_prefetch_experimental)) {
      fbStreamOnly(cc);
    } else if (node.__typename === 'Photo') {
      fbPhoto(node);
    }
    return c;
  }
  function fbPhoto(n) {
    const id = String(n.id || '');
    if (!id) return;
    const list = [n.largest_image, n.viewer_image, n.photo_image, n.image].filter(x => x && x.uri)
      .sort((a, b) => area(b) - area(a));
    const best = list[0];
    if (!best || (best.width && best.width < 200)) return;
    const link = n.url || n.permalink_url;
    emit({
      id, type: 'image', ext: extOf(best.uri, 'jpg'), url: best.uri, thumb: list[list.length - 1].uri,
      width: best.width || 0, height: best.height || 0,
      postUrl: typeof link === 'string' && /^https:\/\/(www\.)?facebook\.com/.test(link) ? link : location.href
    });
  }
  // Diagnostics: when a Facebook response mentions video fields but yields nothing, remember WHERE.
  function fbHunt(obj, path, out, depth) {
    if (out.length >= 8 || depth > 40 || !obj || typeof obj !== 'object') return;
    for (const k in obj) {
      const v = obj[k];
      if (typeof v === 'string') {
        if (v.indexOf('.mp4') > 0 && /^https?:/.test(v)) { try { const u = new URL(v); out.push({ p: path + '.' + k, v: u.host + u.pathname.slice(0, 60) }); } catch (e) {} }
      } else if (v && typeof v === 'object') {
        if (/dash|progressive|playable|videoDelivery|video_delivery/i.test(k)) out.push({ p: path + '.' + k });
        fbHunt(v, path + '.' + k, out, depth + 1);
      }
      if (out.length >= 8) return;
    }
  }

  // ---------- YouTube (thumbnails + direct progressive URLs when exposed) ----------
  function ytVisit(node) {
    if (node.videoDetails && node.streamingData) ytPlayer(node);
    let vid = null;
    if (typeof node.videoId === 'string' && node.videoId.length === 11 && node.thumbnail && node.thumbnail.thumbnails) vid = node.videoId;
    else if (typeof node.contentId === 'string' && node.contentId.length === 11 && node.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') vid = node.contentId;
    if (vid) {
      const title = (node.title && ((node.title.runs && node.title.runs[0] && node.title.runs[0].text) || node.title.simpleText)) ||
        (node.metadata && node.metadata.lockupMetadataViewModel && node.metadata.lockupMetadataViewModel.title && node.metadata.lockupMetadataViewModel.title.content) || '';
      ytThumb(vid, title);
    }
  }
  function ytThumb(vid, title) {
    emit({
      id: vid, type: 'image', ext: 'jpg', title: title || '', postId: vid,
      url: `https://i.ytimg.com/vi/${vid}/maxresdefault.jpg`,
      fallbackUrl: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
      thumb: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`,
      width: 1280, height: 720, postUrl: `https://www.youtube.com/watch?v=${vid}`
    });
  }
  function ytPlayer(n) {
    const d = n.videoDetails, vid = d.videoId;
    if (!vid) return;
    ytThumb(vid, d.title);
    const formats = (n.streamingData.formats || []).filter(f => f.url).sort((a, b) => (b.height || 0) - (a.height || 0));
    const base = { id: vid, type: 'video', ext: 'mp4', title: d.title || '', postId: vid, thumb: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`, postUrl: `https://www.youtube.com/watch?v=${vid}` };
    if (formats.length) {
      const alts = formats.map(f => ({ url: f.url, width: f.width || 0, height: f.height || 0, quality: f.height ? f.height + 'p' : '' }));
      emit({ ...base, url: alts[0].url, width: alts[0].width, height: alts[0].height, quality: alts[0].quality, alts });
    } else {
      emit({ ...base, url: base.postUrl, ytdlpUrl: base.postUrl, streaming: true });
    }
  }

  const VISIT = { twitter: twVisit, instagram: igVisit, facebook: fbVisit, youtube: ytVisit }[PLATFORM];
  const WANT = {
    twitter: /\/i\/api\/(graphql|2|1\.1)\//,
    instagram: /\/(api\/graphql|graphql|api\/v1)\b/,
    facebook: /\/(api\/graphql|ajax|graphql)/,
    youtube: /\/youtubei\/v1\//
  }[PLATFORM];

  function processJSON(obj) {
    try { walk(obj, {}, VISIT, 0); } catch (e) {}
  }
  function processText(text, src) {
    if (!text || text.length > 20e6) return;
    const before = emitted;
    text = text.replace(/^for \(;;\);/, '');
    let objs = [];
    try { objs = [JSON.parse(text)]; }
    catch (e) {
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t[0] === '{' || t[0] === '[') { try { objs.push(JSON.parse(t)); } catch (e2) {} }
      }
    }
    objs.forEach(processJSON);
    try {
      diag.reqs.push({ u: String(src || '').split('?')[0].slice(-70), n: emitted - before, size: text.length });
      if (diag.reqs.length > 30) diag.reqs.shift();
      if (PLATFORM === 'facebook' && emitted === before && /\.mp4|playable_url|progressive_url|dash_manifest/.test(text) && diag.hits.length < 12) {
        const out = [];
        objs.forEach(o => fbHunt(o, '$', out, 0));
        if (out.length) diag.hits.push(out);
      }
    } catch (e) {}
    flush();
  }

  // ---------- network hooks ----------
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const a0 = args[0];
        const url = typeof a0 === 'string' ? a0 : (a0 && a0.url) || String(a0);
        if (WANT.test(url)) {
          p.then(res => res.clone().text()).then(t => processText(t, url)).catch(() => {});
        }
      } catch (e) {}
      return p;
    };
  }
  const xOpen = XMLHttpRequest.prototype.open;
  const xSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    try { this.__mgUrl = String(u); } catch (e) {}
    return xOpen.call(this, m, u, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...a) {
    try {
      this.addEventListener('load', () => {
        try {
          if (this.__mgUrl && WANT.test(this.__mgUrl) && (this.responseType === '' || this.responseType === 'text')) processText(this.responseText, this.__mgUrl);
        } catch (e) {}
      });
    } catch (e) {}
    return xSend.apply(this, a);
  };

  // ---------- JSON embedded in the page (first load / streamed HTML) ----------
  const doneScripts = new WeakSet();
  const KEYWORDS = /image_versions2|video_versions|display_url|playable_url|browser_native|progressive_url|dash_manifest|short_form_video|media_url_https|"Photo"/;
  let lastInitial = null;
  function scanEmbedded() {
    try {
      document.querySelectorAll('script[type="application/json"]').forEach(s => {
        if (doneScripts.has(s)) return;
        doneScripts.add(s);
        const t = s.textContent;
        if (t && KEYWORDS.test(t)) processText(t, 'embedded');
      });
      if (PLATFORM === 'youtube') {
        const mp = document.getElementById('movie_player');
        const pr = (mp && typeof mp.getPlayerResponse === 'function' && mp.getPlayerResponse()) || window.ytInitialPlayerResponse;
        if (pr) processJSON(pr);
        if (window.ytInitialData && window.ytInitialData !== lastInitial) { lastInitial = window.ytInitialData; processJSON(lastInitial); }
      }
    } catch (e) {}
    flush();
  }
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data) return;
    if (e.data.__mediaGrabCmd === 'rescan') scanEmbedded();
    if (e.data.__mediaGrabCmd === 'diag') {
      window.postMessage({ __mediaGrabDiag: true, diag: { platform: PLATFORM, path: location.pathname, reqs: diag.reqs, hits: diag.hits, emitted } }, location.origin);
    }
  });
  document.addEventListener('DOMContentLoaded', scanEmbedded);
  window.addEventListener('load', () => setTimeout(scanEmbedded, 1500));
  // The HTML is often streamed in late; pick up new JSON scripts for the first ~25s.
  let ticks = 0;
  const iv = setInterval(() => { scanEmbedded(); if (++ticks >= 8) clearInterval(iv); }, 3000);
})();
