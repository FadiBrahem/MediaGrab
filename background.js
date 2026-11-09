// Media Grab - background service worker.
// 1) throttled download queue
// 2) persistent "already downloaded" history (written only when a download COMPLETES,
//    so failed/cancelled downloads stay in the list)
const HIST_KEY = 'mg_history';
const stats = { total: 0, started: 0, done: 0, failed: 0 };
const queue = [];
let running = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function notify() {
  try { chrome.runtime.sendMessage({ evt: 'progress', stats }).catch(() => {}); } catch (e) {}
}

// ---------- history (debounced, serialized read-modify-write) ----------
let pendingMarks = [];
let flushTimer = null;
let histChain = Promise.resolve();
function queueMarks(marks) {
  if (!marks || !marks.length) return;
  pendingMarks.push(...marks);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushMarks, 400);
}
function flushMarks() {
  const marks = pendingMarks;
  pendingMarks = [];
  if (!marks.length) return;
  histChain = histChain.then(async () => {
    const r = await chrome.storage.local.get(HIST_KEY);
    const h = r[HIST_KEY] || {};
    const now = Date.now();
    marks.forEach(k => { h[k] = now; });
    const keys = Object.keys(h);
    if (keys.length > 30000) {
      keys.sort((a, b) => h[a] - h[b]).slice(0, keys.length - 25000).forEach(k => delete h[k]);
    }
    await chrome.storage.local.set({ [HIST_KEY]: h });
  }).catch(() => {});
}

// ---------- queue ----------
async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const j = queue.shift();
    let url = j.url;
    if (j.fallbackUrl) {
      // e.g. YouTube maxresdefault.jpg doesn't exist for every video
      try { const r = await fetch(url, { method: 'HEAD' }); if (!r.ok) url = j.fallbackUrl; }
      catch (e) { url = j.fallbackUrl; }
    }
    await new Promise(resolve => {
      chrome.downloads.download({ url, filename: j.filename, conflictAction: 'uniquify', saveAs: false }, id => {
        if (chrome.runtime.lastError || id === undefined) {
          stats.failed++;
          resolve();
        } else {
          stats.started++;
          // session storage survives the worker being suspended between events
          chrome.storage.session.set({ ['dl_' + id]: j.marks || [] }).then(resolve, resolve);
        }
      });
    });
    notify();
    await sleep(200);   // gentle pacing, avoids hammering CDNs
  }
  running = false;
}

chrome.downloads.onChanged.addListener(async d => {
  if (!d.state || (d.state.current !== 'complete' && d.state.current !== 'interrupted')) return;
  const k = 'dl_' + d.id;
  const r = await chrome.storage.session.get(k);
  if (!(k in r)) return;                       // not one of ours
  chrome.storage.session.remove(k);
  if (d.state.current === 'complete') { stats.done++; queueMarks(r[k]); }
  else stats.failed++;
  notify();
});

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (!msg) return false;
  if (msg.cmd === 'download') {
    if (!running && !queue.length) { stats.total = stats.started = stats.done = stats.failed = 0; }
    const jobs = Array.isArray(msg.jobs) ? msg.jobs : [];
    for (const j of jobs) {
      if (j && /^https?:\/\//.test(j.url) && typeof j.filename === 'string') { queue.push(j); stats.total++; }
    }
    pump();
    send({ ok: true, queued: jobs.length });
  } else if (msg.cmd === 'progress') {
    send({ stats });
  }
  return false;
});
