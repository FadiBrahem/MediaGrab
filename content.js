// Media Grab - content script for Twitter/X, Instagram, Facebook, YouTube (isolated world).
// Receives items from inject.js and runs a strict DOM fallback for images.
(() => {
  'use strict';
  const { isUrl, hash, extOf, pathKey } = MGCore.util;
  const H = location.hostname;
  const PLATFORM =
    /(^|\.)(x|twitter)\.com$/.test(H) ? 'twitter' :
    /(^|\.)instagram\.com$/.test(H) ? 'instagram' :
    /(^|\.)facebook\.com$/.test(H) ? 'facebook' :
    /(^|\.)youtube\.com$/.test(H) ? 'youtube' : null;
  if (!PLATFORM) return;

  const BAD = /(emoji|twemoji|sprite|rsrc\.php|profile_images|hashtag_img|abs(-0)?\.twimg\.com|static\.xx\.fbcdn\.net|t51\.2885-19|\/s150x150\/|favicon|semantic_core_img|\/ui\/)/i;
  const SELECTORS = {
    twitter: 'article [data-testid="tweetPhoto"] img',
    instagram: 'article img, main img',
    facebook: '[role="article"] img, [role="main"] img',
    youtube: ''
  };
  function bestSrc(img) {
    let best = img.currentSrc || img.src, w0 = 0;
    if (img.srcset) {
      for (const part of img.srcset.split(',')) {
        const [u, d] = part.trim().split(/\s+/);
        const w = parseInt(d, 10) || 0;
        if (u && w >= w0) { w0 = w; best = u; }
      }
    }
    return best;
  }
  function upgradeUrl(url) {
    const m = /^(https:\/\/pbs\.twimg\.com\/media\/[\w-]+)/.exec(url);
    if (!m) return url;
    const f = /[?&]format=(\w+)/.exec(url) || /\.(\w{3,4})(?:[?:]|$)/.exec(url.slice(m[1].length));
    return `${m[1]}?format=${f ? f[1] : 'jpg'}&name=orig`;
  }
  function scanDom() {
    const sel = SELECTORS[PLATFORM];
    if (!sel) return;
    document.querySelectorAll(sel).forEach(img => {
      try {
        const r = img.getBoundingClientRect();
        if (r.width < 140 || r.height < 140) return;                 // icons, flags, avatars
        if (img.naturalWidth && img.naturalWidth < 200) return;
        if (/profile picture|avatar/i.test(img.alt || '')) return;
        let url = bestSrc(img);
        if (!isUrl(url) || BAD.test(url)) return;
        url = upgradeUrl(url);
        if (core.isPoster(url)) return;                               // video poster
        core.add({
          id: 'dom_' + hash(pathKey(url)), type: 'image', url, thumb: url, ext: extOf(url, 'jpg'),
          width: img.naturalWidth || Math.round(r.width), height: img.naturalHeight || Math.round(r.height), source: 'dom'
        });
      } catch (e) {}
    });
  }

  function rescan() { window.postMessage({ __mediaGrabCmd: 'rescan' }, location.origin); }
  let diagResolve = null;
  function diag() {
    return new Promise(res => {
      diagResolve = res;
      window.postMessage({ __mediaGrabCmd: 'diag' }, location.origin);
      setTimeout(() => res(null), 700);
    });
  }

  const core = MGCore.create({ platform: PLATFORM, scan: scanDom, rescan, settle: 400, diag });

  window.addEventListener('message', e => {
    if (e.source !== window || !e.data) return;
    if (e.data.__mediaGrab === true && Array.isArray(e.data.items)) e.data.items.forEach(core.add);
    else if (e.data.__mediaGrabDiag === true && diagResolve) { diagResolve(e.data.diag); diagResolve = null; }
  });
})();
