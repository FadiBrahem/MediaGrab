const PLATFORMS = {
  twitter: { label: 'X / Twitter', hosts: ['twitter.com', 'x.com'] },
  instagram: { label: 'Instagram', hosts: ['instagram.com'] },
  facebook: { label: 'Facebook', hosts: ['facebook.com'] },
  youtube: { label: 'YouTube', hosts: ['youtube.com'] },
  other: { label: 'Other sites', hosts: [] }
};
const ORDER = ['twitter', 'instagram', 'facebook', 'youtube', 'other'];
const KEY = p => 'mediaGrab_' + p;
const HIST = 'mg_history';
const $ = id => document.getElementById(id);

let platform = 'twitter';
let activeTabId = null, activeUrl = '', activeSite = '', activeIsWeb = false, activePlatform = null;
let items = [];
let history = {};
let shown = 150;
let lastIdx = null;
const selected = new Set();
let settings = { type: 'all', quality: 'best', view: 'list', showDl: false, siteOnly: true, last: '' };

// ---------- helpers ----------
function platformFromUrl(url) {
  try {
    const h = new URL(url).hostname;
    for (const p of ORDER) {
      if (PLATFORMS[p].hosts.some(x => h === x || h.endsWith('.' + x))) return p;
    }
  } catch (e) {}
  return null;
}
const isRestricted = u => /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(u);
function activeScannable() {
  if (platform === 'other') return activeIsWeb && activePlatform === null && !isRestricted(activeUrl);
  return activePlatform === platform;
}
const setStatus = t => { $('status').textContent = t || ''; };
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const doneFor = (p, it) => !!(history[p + '|' + it.key] || (it.pk && history[p + '|' + it.pk]));
const safeDir = s => String(s || 'web').replace(/[^\w.-]/g, '_').slice(0, 60);

async function send(cmd) {
  if (activeTabId == null) return null;
  try { return await chrome.tabs.sendMessage(activeTabId, { cmd }); } catch (e) {}
  // "Other sites": attach the scanner on demand (activeTab grants access after the popup was opened)
  if (platform === 'other' && ['start', 'auto', 'diag'].includes(cmd) && activeScannable()) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: activeTabId }, files: ['core.js', 'generic.js'] });
      return await chrome.tabs.sendMessage(activeTabId, { cmd });
    } catch (e) { return null; }
  }
  return null;
}

// ---------- tabs / controls ----------
function selectPlatform(p) {
  platform = p;
  shown = settings.view === 'grid' ? 120 : 150;
  lastIdx = null;
  selected.clear();
  settings.last = p;
  saveSettings();
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.platform === p));
  $('siteWrap').hidden = !(p === 'other' && activeSite);
  refreshControls();
  loadAll();
}
function setPill(mode) {
  const p = $('pill');
  p.textContent = mode === 'auto' ? 'auto-scanning' : 'idle';
  p.classList.toggle('on', mode === 'auto');
}
function notice(text, info) {
  const n = $('notice');
  n.hidden = !text;
  n.textContent = text || '';
  n.classList.toggle('info', !!info);
}
async function refreshControls() {
  const ok = activeScannable();
  ['scanBtn', 'stopBtn', 'autoToggle'].forEach(id => { $(id).disabled = !ok; });
  setPill('idle');
  if (!ok) {
    $('autoToggle').checked = false;
    if (platform === 'other') {
      notice(activePlatform
        ? `You're on ${PLATFORMS[activePlatform].label}. Use its tab to scan; "Other" is for any different website.`
        : "This page can't be scanned (browser-internal or protected page). Saved items below can still be downloaded.");
    } else {
      notice(`Open ${PLATFORMS[platform].label} in the current tab to scan. Saved items below can still be downloaded.`);
    }
    return;
  }
  const st = await send('status');
  if (!st) {
    if (platform === 'other') notice('Press Scan to read this page. Nothing is injected until you do.', true);
    else notice('Reload this tab once so Media Grab can attach, then scroll and scan.');
    return;
  }
  notice('');
  $('autoToggle').checked = st.mode === 'auto';
  setPill(st.mode);
}

// ---------- data ----------
async function loadAll() {
  const keys = ORDER.map(KEY).concat([HIST]);
  const r = await chrome.storage.local.get(keys);
  history = r[HIST] || {};
  items = (r[KEY(platform)] || []).slice().sort((a, b) => b.capturedAt - a.capturedAt);
  document.querySelectorAll('.tab').forEach(b => {
    const p = b.dataset.platform;
    const n = (r[KEY(p)] || []).filter(i => !doneFor(p, i)).length;
    const badge = b.querySelector('.num');
    badge.hidden = n === 0;
    badge.textContent = n > 999 ? '999+' : String(n);
  });
  render();
}
function typeOk(i) {
  return settings.type === 'all' || (settings.type === 'image' ? i.type === 'image' : i.type !== 'image');
}
function siteOk(i) {
  return !(platform === 'other' && settings.siteOnly && activeSite) || i.site === activeSite;
}
const visibleItems = () => items.filter(i => typeOk(i) && siteOk(i) && (settings.showDl || !doneFor(platform, i)));
const selectedItems = () => visibleItems().filter(i => selected.has(i.key));

// ---------- rendering ----------
function buildItem(it, idx) {
  const d = el('div', 'item');
  d.dataset.key = it.key;
  if (selected.has(it.key)) d.classList.add('sel');
  const done = doneFor(platform, it);
  if (done) d.classList.add('done');

  d.appendChild(el('span', 'cb'));

  const th = el('div', 'thumb');
  const fallback = () => { th.textContent = it.type === 'image' ? '\u{1F5BC}' : '\u{1F3AC}'; };
  if (it.thumb) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => { img.remove(); fallback(); });
    img.src = it.thumb;
    th.appendChild(img);
  } else fallback();
  if (it.type !== 'image') th.appendChild(el('span', 'tag type', it.type === 'gif' ? 'GIF' : it.reel ? 'REEL' : '\u25B6'));
  if (done) th.appendChild(el('span', 'tag done', '\u2713'));
  d.appendChild(th);

  const meta = el('div', 'meta');
  const name = el('div', 'name', it.name);
  name.title = it.name;
  const sub = el('div', 'sub');
  const bits = [it.type === 'gif' ? 'GIF' : it.reel ? 'Reel' : it.type === 'video' ? 'Video' : 'Image'];
  if (it.width && it.height) bits.push(`${it.width}\u00D7${it.height}`);
  if (it.quality) bits.push(it.quality);
  if (it.author) bits.push('@' + it.author);
  if (platform === 'other' && it.site && !activeSite) bits.push(it.site);
  sub.textContent = bits.join(' \u00B7 ');
  if (it.streaming) sub.appendChild(el('span', 'warn', ' \u00B7 stream-only (use yt-dlp)'));
  if (done) sub.appendChild(el('span', '', ' \u00B7 downloaded'));
  const url = el('div', 'url', it.url);
  url.title = it.url;
  meta.append(name, sub, url);
  d.appendChild(meta);

  const open = el('button', 'open', '\u2197');
  open.title = 'Open in a new tab';
  open.addEventListener('click', e => {
    e.stopPropagation();
    chrome.tabs.create({ url: it.streaming ? (it.ytdlpUrl || it.postUrl) : pickVariant(it).url });
  });
  d.appendChild(open);

  d.addEventListener('click', e => onItemClick(e, idx, it));
  return d;
}
function onItemClick(e, idx, it) {
  const vis = visibleItems();
  if (e.shiftKey && lastIdx !== null && vis[lastIdx]) {
    const [a, b] = [Math.min(lastIdx, idx), Math.max(lastIdx, idx)];
    const on = !selected.has(it.key);
    for (let i = a; i <= b; i++) { if (vis[i]) on ? selected.add(vis[i].key) : selected.delete(vis[i].key); }
  } else {
    selected.has(it.key) ? selected.delete(it.key) : selected.add(it.key);
  }
  lastIdx = idx;
  syncSelection();
}
function syncSelection() {
  document.querySelectorAll('#list .item').forEach(n => n.classList.toggle('sel', selected.has(n.dataset.key)));
  updateCounts();
}
function render() {
  const list = $('list');
  list.className = 'list v-' + settings.view;
  list.textContent = '';
  const vis = visibleItems();
  const vk = new Set(vis.map(i => i.key));
  for (const k of selected) if (!vk.has(k)) selected.delete(k);

  if (!vis.length) {
    const e = el('div', 'empty');
    e.appendChild(el('div', 'big', '\u{1F4E5}'));
    const hidden = items.filter(i => typeOk(i) && siteOk(i) && doneFor(platform, i)).length;
    e.appendChild(document.createTextNode(hidden
      ? `${hidden} item(s) already downloaded are hidden. Tick "Show downloaded" to see them.`
      : 'Nothing here yet. Open the site, scroll a little, then press Scan (or turn on Auto).'));
    list.appendChild(e);
  } else {
    const frag = document.createDocumentFragment();
    vis.slice(0, shown).forEach((it, i) => frag.appendChild(buildItem(it, i)));
    if (vis.length > shown) {
      const more = el('button', 'btn more', `Show more (${vis.length - shown} hidden)`);
      more.addEventListener('click', () => { shown += settings.view === 'grid' ? 120 : 150; render(); });
      frag.appendChild(more);
    }
    list.appendChild(frag);
  }
  updateCounts();
}
function updateCounts() {
  const vis = visibleItems();
  const sel = vis.filter(i => selected.has(i.key));
  const hiddenDone = settings.showDl ? 0 : items.filter(i => typeOk(i) && siteOk(i) && doneFor(platform, i)).length;
  $('count').textContent = `${vis.length} shown` + (hiddenDone ? ` \u00B7 ${hiddenDone} downloaded hidden` : '');
  $('dlBtn').textContent = `Download (${sel.length})`;
  $('dlBtn').disabled = sel.length === 0;
  $('selectAll').checked = vis.length > 0 && sel.length === vis.length;
}

// ---------- actions ----------
function pickVariant(it) {
  const alts = it.alts || [];
  if (alts.length > 1 && settings.quality === 'smallest') return alts[alts.length - 1];
  return alts[0] || it;
}
function fileName(it, v) {
  if (v === it || !v.quality || v.url === it.url) return it.name;
  return it.name.replace(/(\.\w+)$/, `_${v.quality}$1`);
}
async function download() {
  const sel = selectedItems();
  const jobs = [];
  let skipped = 0;
  for (const it of sel) {
    if (it.streaming) { skipped++; continue; }
    const v = pickVariant(it);
    const dir = platform === 'other' ? `MediaGrab/other/${safeDir(it.site)}` : `MediaGrab/${platform}`;
    jobs.push({
      url: v.url,
      fallbackUrl: it.fallbackUrl || '',
      filename: `${dir}/${fileName(it, v)}`,
      marks: [platform + '|' + it.key, it.pk ? platform + '|' + it.pk : ''].filter(Boolean)
    });
  }
  if (!jobs.length) {
    setStatus(skipped ? `${skipped} stream-only item(s). Use the yt-dlp button for those.` : 'Select something first.');
    return;
  }
  await chrome.runtime.sendMessage({ cmd: 'download', jobs });
  setStatus(`Queued ${jobs.length} download(s)` + (skipped ? `, skipped ${skipped} stream-only` : '') + '\u2026');
}
async function copy(text, okMsg) {
  try { await navigator.clipboard.writeText(text); setStatus(okMsg); }
  catch (e) { setStatus('Copy failed.'); }
}
function copyUrls() {
  const sel = selectedItems();
  const pool = sel.length ? sel : visibleItems();
  if (!pool.length) return setStatus('Nothing to copy.');
  copy(pool.map(i => (i.streaming ? (i.ytdlpUrl || i.url) : pickVariant(i).url)).join('\n'), `Copied ${pool.length} URL(s).`);
}
function copyYtdlp() {
  const sel = selectedItems();
  const pool = (sel.length ? sel : visibleItems()).filter(i => i.type !== 'image');
  const urls = [...new Set(pool.map(i => i.ytdlpUrl || i.postUrl))];
  if (!urls.length) return setStatus('No videos to build commands for.');
  copy(urls.map(u => `yt-dlp --cookies-from-browser chrome "${u}"`).join('\n'), `Copied ${urls.length} yt-dlp command(s).`);
}
function saveSettings() { chrome.storage.local.set({ mg_settings: settings }); }
function setSeg(id, value) {
  document.querySelectorAll('#' + id + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === value));
}
function showProgress(s) {
  const bar = $('progress');
  if (!s || !s.total) { bar.hidden = true; return; }
  const fin = s.done + s.failed;
  bar.hidden = false;
  bar.firstElementChild.style.width = Math.round(100 * fin / s.total) + '%';
  if (fin >= s.total) {
    setStatus(`Finished: ${s.done} downloaded` + (s.failed ? `, ${s.failed} failed` : '') + '.');
    setTimeout(() => { bar.hidden = true; }, 2500);
  } else setStatus(`Downloading ${fin}/${s.total}\u2026`);
}

// ---------- menu ----------
async function markListedDownloaded() {
  const vis = visibleItems();
  if (!vis.length) return setStatus('Nothing listed.');
  const r = await chrome.storage.local.get(HIST);
  const h = r[HIST] || {};
  const now = Date.now();
  vis.forEach(i => { h[platform + '|' + i.key] = now; if (i.pk) h[platform + '|' + i.pk] = now; });
  await chrome.storage.local.set({ [HIST]: h });
  setStatus(`Marked ${vis.length} item(s) as downloaded.`);
}
let resetArmed = null;
async function resetHistory() {
  const b = $('mReset');
  if (!resetArmed) {
    b.textContent = 'Click again to confirm reset';
    resetArmed = setTimeout(() => { resetArmed = null; b.textContent = 'Reset downloaded history'; }, 3000);
    return;
  }
  clearTimeout(resetArmed);
  resetArmed = null;
  b.textContent = 'Reset downloaded history';
  await chrome.storage.local.set({ [HIST]: {} });
  $('menu').hidden = true;
  setStatus('Downloaded history cleared.');
}
async function copyDiagnostics() {
  const d = await send('diag');
  const out = {
    version: chrome.runtime.getManifest().version,
    tab: platform, page: activeUrl.split('?')[0], scannable: activeScannable(),
    listed: items.length, diag: d
  };
  copy(JSON.stringify(out, null, 1), 'Diagnostics copied. Paste them to me if something is not detected.');
}

// ---------- init ----------
(async function init() {
  const s = await chrome.storage.local.get('mg_settings');
  settings = { ...settings, ...(s.mg_settings || {}) };
  setSeg('typeSeg', settings.type);
  setSeg('viewSeg', settings.view);
  $('qualityPref').value = settings.quality;
  $('showDl').checked = settings.showDl;
  $('siteOnly').checked = settings.siteOnly;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab ? tab.id : null;
  activeUrl = (tab && tab.url) || '';
  activeIsWeb = /^https?:\/\//.test(activeUrl);
  activePlatform = platformFromUrl(activeUrl);
  try { activeSite = activeIsWeb && !activePlatform ? new URL(activeUrl).hostname : ''; } catch (e) { activeSite = ''; }

  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => selectPlatform(b.dataset.platform)));
  $('scanBtn').addEventListener('click', async () => {
    setStatus('Scanning\u2026');
    const r = await send('start');
    if (!r) { setStatus(''); return refreshControls(); }
    notice('');
    await loadAll();
    setStatus(`Scan done. ${r.buffered} item(s) captured on this page.`);
  });
  $('stopBtn').addEventListener('click', async () => {
    await send('stop');
    $('autoToggle').checked = false;
    setPill('idle');
    setStatus('Stopped.');
  });
  $('autoToggle').addEventListener('change', async e => {
    const r = await send(e.target.checked ? 'auto' : 'stop');
    if (!r) { e.target.checked = false; return refreshControls(); }
    notice('');
    setPill(e.target.checked ? 'auto' : 'idle');
    setStatus(e.target.checked ? 'Auto: capturing as you scroll.' : 'Stopped.');
  });
  $('selectAll').addEventListener('change', e => {
    visibleItems().forEach(i => e.target.checked ? selected.add(i.key) : selected.delete(i.key));
    syncSelection();
  });
  $('showDl').addEventListener('change', e => { settings.showDl = e.target.checked; saveSettings(); render(); });
  $('siteOnly').addEventListener('change', e => { settings.siteOnly = e.target.checked; saveSettings(); render(); });
  $('typeSeg').addEventListener('click', e => {
    const v = e.target.dataset && e.target.dataset.v;
    if (!v) return;
    settings.type = v; saveSettings(); setSeg('typeSeg', v); render();
  });
  $('viewSeg').addEventListener('click', e => {
    const v = e.target.dataset && e.target.dataset.v;
    if (!v) return;
    settings.view = v; saveSettings(); setSeg('viewSeg', v); shown = v === 'grid' ? 120 : 150; render();
  });
  $('qualityPref').addEventListener('change', e => { settings.quality = e.target.value; saveSettings(); });
  $('dlBtn').addEventListener('click', download);
  $('copyUrls').addEventListener('click', copyUrls);
  $('copyYtdlp').addEventListener('click', copyYtdlp);

  $('moreBtn').addEventListener('click', e => { e.stopPropagation(); $('menu').hidden = !$('menu').hidden; });
  document.addEventListener('click', e => { if (!$('menu').contains(e.target)) $('menu').hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('menu').hidden = true; });
  $('mClear').addEventListener('click', async () => {
    await chrome.storage.local.set({ [KEY(platform)]: [] });
    if (activeScannable()) await send('clear');
    selected.clear();
    $('menu').hidden = true;
    setStatus('List cleared.');
  });
  $('mMarkAll').addEventListener('click', async () => { await markListedDownloaded(); $('menu').hidden = true; });
  $('mReset').addEventListener('click', e => { e.stopPropagation(); resetHistory(); });
  $('mDiag').addEventListener('click', async () => { await copyDiagnostics(); $('menu').hidden = true; });

  let t;
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (Object.keys(ch).some(k => k.startsWith('mediaGrab_') || k === HIST)) { clearTimeout(t); t = setTimeout(loadAll, 200); }
  });
  chrome.runtime.onMessage.addListener(m => { if (m && m.evt === 'progress') showProgress(m.stats); });
  try {
    const p = await chrome.runtime.sendMessage({ cmd: 'progress' });
    if (p && p.stats && p.stats.total && p.stats.done + p.stats.failed < p.stats.total) showProgress(p.stats);
  } catch (e) {}

  selectPlatform(activePlatform || (activeIsWeb && !isRestricted(activeUrl) ? 'other' : (settings.last || 'twitter')));
})();
