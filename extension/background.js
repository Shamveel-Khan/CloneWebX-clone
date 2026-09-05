// Service worker: orchestrates analyze → rebuild → package → zip.
// All state lives in chrome.storage.local so the popup can render progress
// at any time (and survive being closed/reopened mid-run).

import { buildZip, utf8Bytes } from './lib/zip.js';
import { modelToElementor, nodeToElementor } from './lib/elementor.js';
import { analyzePage, scrollAndSettle } from './content/analyzer.js';

const IDLE = {
  phase: 'idle', // idle | analyzing | ready | rebuilding | done | error | cancelled
  error: '',
  sourceUrl: '',
  siteTitle: '',
  platform: '',
  pageLimit: 5,
  pages: [], // [{url, title, slug, status}]
  assetCount: 0,
  log: [],
  progress: { current: 0, total: 0, label: '' },
  zipName: '',
  summary: null,
  cancelRequested: false,
  startModel: null,
};

// ------------------------------------------------------------- ZIP storage
// ZIP blobs live in IndexedDB (Blob-efficient, survives service-worker
// restarts) instead of chrome.storage.local (JSON/base64, ~2.7x size).

const idb = (mode, fn) =>
  new Promise((res, rej) => {
    const open = indexedDB.open('sr-zips', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('zips');
    open.onsuccess = () => {
      const tx = open.result.transaction('zips', mode);
      const req = fn(tx.objectStore('zips'));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error);
    };
    open.onerror = () => rej(open.error);
  });
const idbPutZip = (name, blob) => idb('readwrite', (s) => s.put({ name, blob, created: Date.now() }, 'last'));
const idbGetZip = () => idb('readonly', (s) => s.get('last'));
const idbDelZip = () => idb('readwrite', (s) => s.delete('last')).catch(() => {});

async function downloadZip() {
  const rec = await idbGetZip().catch(() => null);
  if (!rec || !rec.blob) {
    void updateState((s) => {
      s.phase = 'error';
      s.error = 'Package expired — please rebuild the site.';
    });
    return;
  }
  try {
    // MV3 service workers lack URL.createObjectURL, so the blob URL is
    // created in an offscreen document (which reads the blob from IndexedDB
    // itself — Blobs don't survive chrome.runtime messaging).
    await setupOffscreenDocument();
    const res = await sendToOffscreen({ type: 'create-blob-url' });
    if (!res || !res.url) {
      throw new Error('could not prepare the package: ' + ((res && res.error) || 'no blob URL'));
    }
    const downloadId = await chrome.downloads.download({
      url: res.url,
      filename: rec.name,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    const done = () => {
      void sendToOffscreen({ type: 'revoke-blob-url' }).catch(() => {});
      chrome.downloads.onChanged.removeListener(onChange);
    };
    const timer = setTimeout(done, 120000); // leak guard
    function onChange(delta) {
      if (delta.id === downloadId && delta.state && delta.state.current !== 'in_progress') {
        clearTimeout(timer);
        done();
      }
    }
    chrome.downloads.onChanged.addListener(onChange);
  } catch (err) {
    void updateState((s) => {
      s.phase = 'error';
      s.error = 'Download failed: ' + (err && err.message ? err.message : String(err));
    });
  }
}

async function setupOffscreenDocument() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts && contexts.length > 0) return;
  } catch (e) {
    // getContexts unavailable on older Chrome — try creating and let the
    // duplicate-document error below tell us it already exists.
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Create a blob URL for the exported ZIP download',
    });
  } catch (e) {
    if (!String((e && e.message) || e).includes('single offscreen')) throw e;
  }
}

function sendToOffscreen(msg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('offscreen document timed out')), 8000);
    chrome.runtime.sendMessage(msg, (res) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

// ---------------------------------------------------------------- state utils

let queue = Promise.resolve();
function getState() {
  return chrome.storage.local.get('state').then(({ state }) => state || { ...IDLE });
}
function updateState(mutator) {
  queue = queue.then(async () => {
    const state = { ...(await getState()) };
    await mutator(state);
    await chrome.storage.local.set({ state });
  });
  return queue;
}
function addLog(state, msg) {
  state.log = [...(state.log || []), `${new Date().toLocaleTimeString()} — ${msg}`].slice(-200);
}

// ---------------------------------------------------------------- tab analysis

function waitComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') done();
    }
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function analyzeInTab(url) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await waitComplete(tab.id);
    // Progressive scroll + quiescence pass: triggers lazy loaders, waits for
    // network/DOM to go quiet (bounded by internal deadlines), returns stats.
    let settle = { ms: 0, screens: 0 };
    try {
      const [s] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scrollAndSettle,
      });
      settle = (s && s.result) || settle;
    } catch (e) {
      // Page blocks script injection — fall back to immediate analysis.
    }
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: analyzePage,
    });
    return res && res.result ? { model: res.result, settle } : null;
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ---------------------------------------------------------------- assets

const MAX_ASSETS = 250;
const MAX_ASSET_BYTES = 25 * 1024 * 1024; // single asset cap (tunable)
const MAX_TOTAL_ASSET_BYTES = 150 * 1024 * 1024; // whole-package budget
const ASSET_FETCH_TIMEOUT_MS = 30000;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function extFromMime(mime, url) {
  const map = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/x-icon': 'ico',
    'video/mp4': 'mp4', 'video/webm': 'webm',
  };
  if (map[mime]) return map[mime];
  const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url || '');
  return m ? m[1].toLowerCase() : 'bin';
}

function bytesToB64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function fetchAsset(url) {
  const ctrl = new AbortController();
  const kill = setTimeout(() => ctrl.abort(), ASSET_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { credentials: 'omit', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_ASSET_BYTES) throw new Error('asset-too-large');
    const mime = res.headers.get('content-type') || '';
    return { mime: mime.split(';')[0], b64: bytesToB64(buf), size: buf.length };
  } finally {
    clearTimeout(kill);
  }
}

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg && msg.type) {
    case 'analyze':
      void runAnalyze(msg);
      break;
    case 'rebuild':
      void runRebuild();
      break;
    case 'downloadZip':
      void downloadZip();
      break;
    case 'cancel':
      void updateState((s) => {
        s.cancelRequested = true;
        addLog(s, 'Cancel requested — stopping after the current step.');
      });
      break;
    case 'reset':
      void idbDelZip();
      void updateState((s) => Object.assign(s, structuredClone(IDLE)));
      break;
  }
  return false; // all UI updates flow through storage.onChanged
});

// ---------------------------------------------------------------- analyze

function normalizeUrl(input) {
  let url = String(input || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

async function runAnalyze(msg) {
  const url = normalizeUrl(msg.url);
  const pageLimit = Math.min(Math.max(parseInt(msg.pageLimit, 10) || 5, 1), 10);

  if (!url) {
    void updateState((s) => {
      s.phase = 'error';
      s.error = 'Please enter a valid http(s) website URL.';
    });
    return;
  }

  await updateState((s) => {
    Object.assign(s, structuredClone(IDLE));
    s.phase = 'analyzing';
    s.sourceUrl = url;
    s.pageLimit = pageLimit;
    addLog(s, 'Analyzing ' + url);
  });

  try {
    const { model } = await analyzeInTab(url);
    if (!model || !model.body) throw new Error('Could not read the page (site may block embedded analysis).');

    const queue = [url];
    for (const link of model.links || []) {
      if (queue.length >= pageLimit) break;
      if (link.url !== url) queue.push(link.url);
    }

    await updateState((s) => {
      s.platform = model.platform || 'generic';
      s.siteTitle = model.title || '';
      s.assetCount = (model.assets || []).length;
      s.startModel = model;
      s.pages = queue.map((u, i) => ({
        url: u,
        title: i === 0 ? model.title || 'Home' : (model.links.find((l) => l.url === u) || {}).text || u,
        slug: i === 0 ? model.slug || 'home' : slugFrom(u),
        status: 'pending',
      }));
      s.phase = 'ready';
      addLog(s, `Detected platform: ${s.platform}. Found ${s.pages.length} page(s), ${s.assetCount} assets on the start page.`);
    });
  } catch (err) {
    void updateState((s) => {
      s.phase = 'error';
      s.error = 'Analysis failed: ' + (err && err.message ? err.message : String(err));
    });
  }
}

function slugFrom(url) {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    const last = segs.length ? segs[segs.length - 1] : 'home';
    return (last.replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'home');
  } catch {
    return 'page';
  }
}

// ---------------------------------------------------------------- rebuild

async function runRebuild() {
  const start = await getState();
  if (start.phase !== 'ready') return;

  await updateState((s) => {
    s.phase = 'rebuilding';
    s.cancelRequested = false;
    s.progress = { current: 0, total: s.pages.length + 2, label: 'Analyzing pages' };
    addLog(s, 'Rebuild started.');
  });

  try {
    // 1. Analyze every queued page -------------------------------------------
    const models = [];
    for (let i = 0; i < start.pages.length; i++) {
      let state = await getState();
      if (state.cancelRequested) return void (await updateState((s) => { s.phase = 'cancelled'; }));
      const page = start.pages[i];
      await updateState((s) => {
        s.progress = { current: i + 1, total: s.pages.length + 2, label: `Analyzing page ${i + 1}/${s.pages.length}: ${page.url}` };
      });
      const r = i === 0 && state.startModel ? { model: state.startModel, settle: { ms: 0, screens: 0 } } : await analyzeInTab(page.url);
      const model = r && r.model;
      if (!model) throw new Error('Failed to analyze ' + page.url);
      models.push(model);
      await updateState((s) => {
        if (s.pages[i]) s.pages[i].status = 'analyzed';
        addLog(s, `Analyzed ${page.url} (${(model.body || []).length} top-level blocks, settled in ${r.settle.ms}ms over ${r.settle.screens} screens).`);
      });
    }

    const state0 = await getState();
    if (state0.cancelRequested) return void (await updateState((s) => { s.phase = 'cancelled'; }));

    // 2. Download assets ------------------------------------------------------
    const first = models[0];
    const assetUrls = new Set();
    for (const m of models) for (const a of m.assets || []) assetUrls.add(a);
    const assets = {}; // url → {path, mime, b64, size, status} | null (kept remote)
    const failed = [];
    const tooLarge = [];
    const overBudget = [];
    let totalAssetBytes = 0;
    const list = [...assetUrls].slice(0, MAX_ASSETS);
    for (let i = 0; i < list.length; i++) {
      if (i % 5 === 0) {
        const st = await getState();
        if (st.cancelRequested) return void (await updateState((s) => { s.phase = 'cancelled'; }));
        await updateState((s) => {
          s.progress = { current: s.pages.length + 1, total: s.pages.length + 2, label: `Downloading assets ${i + 1}/${list.length}` };
        });
      }
      const url = list[i];
      try {
        const a = await fetchAsset(url);
        if (totalAssetBytes + a.size > MAX_TOTAL_ASSET_BYTES) {
          overBudget.push(url);
          assets[url] = null;
          continue;
        }
        totalAssetBytes += a.size;
        const ext = extFromMime(a.mime, url);
        const path = `assets/${fnv1a(url)}-${fnv1a(a.b64.slice(0, 256))}.${ext}`;
        assets[url] = { path, mime: a.mime || 'application/octet-stream', b64: a.b64, size: a.size, status: 'downloaded' };
      } catch (err) {
        if (err && err.message === 'asset-too-large') tooLarge.push(url);
        else failed.push(url);
        assets[url] = null; // keep remote URL in the Elementor output
      }
    }
    await updateState((s) => {
      const downloaded = list.length - failed.length - tooLarge.length - overBudget.length;
      addLog(s, `Assets: ${downloaded} downloaded, ${failed.length} failed, ${tooLarge.length} too large, ${overBudget.length} over budget — the skipped ones stay as remote URLs.`);
    });

    // 3. Convert to Elementor JSON -------------------------------------------
    const resolve = (url) => (assets[url] && assets[url].path) || url || '';
    const pages = models.map((m, i) => {
      const { elements } = modelToElementor(m, resolve);
      return {
        title: (start.pages[i] && start.pages[i].title) || m.title || `Page ${i + 1}`,
        slug: m.slug || slugFrom(m.url),
        sourceUrl: m.url,
        elements,
      };
    });
    const headerEl = nodeToElementor(first.header, resolve);
    const footerEl = nodeToElementor(first.footer, resolve);

    const assetsIndex = {};
    for (const [url, a] of Object.entries(assets)) {
      if (a) assetsIndex[a.path] = { url, mime: a.mime, size: a.size, status: a.status };
    }

    const pkg = {
      format: 'site-rebuilder/1',
      generatedAt: new Date().toISOString(),
      source: { url: first.url, platform: first.platform || 'generic' },
      siteStyles: first.globalStyles || {},
      navigation: first.navLinks || [],
      assets: assetsIndex,
      assetFallbacks: [
        ...failed.map((url) => ({ url, status: 'failed' })),
        ...tooLarge.map((url) => ({ url, status: 'too-large' })),
        ...overBudget.map((url) => ({ url, status: 'over-budget' })),
      ],
      header: headerEl ? [headerEl] : null,
      footer: footerEl ? [footerEl] : null,
      pages,
    };

    // 4. Build ZIP ------------------------------------------------------------
    await updateState((s) => {
      s.progress = { current: s.pages.length + 2, total: s.pages.length + 2, label: 'Building export package' };
    });

    const entries = [{ name: 'package.json', data: utf8Bytes(JSON.stringify(pkg)) }];
    for (const a of Object.values(assets)) {
      if (!a) continue;
      const bin = Uint8Array.from(atob(a.b64), (c) => c.charCodeAt(0));
      entries.push({ name: a.path, data: bin });
    }
    const blob = buildZip(entries);
    const host = (() => { try { return new URL(first.url).hostname.replace(/^www\./, ''); } catch { return 'site'; } })();
    const zipName = `site-rebuilder-${host}-${Date.now()}.zip`;
    await idbPutZip(zipName, blob);

    const downloaded = list.length - failed.length - tooLarge.length - overBudget.length;
    await updateState((s) => {
      s.phase = 'done';
      s.zipName = zipName;
      s.summary = {
        pages: pages.length,
        assets: downloaded,
        remoteAssets: failed.length,
        skippedLarge: tooLarge.length,
        overBudget: overBudget.length,
        totalAssetMB: Math.round((totalAssetBytes / 1024 / 1024) * 10) / 10,
        hasHeader: !!headerEl,
        hasFooter: !!footerEl,
        zipBytes: blob.size,
      };
      addLog(s, `Done! Package ready: ${pages.length} page(s), ${downloaded} local assets (${s.summary.totalAssetMB} MB), ${(blob.size / 1024 / 1024).toFixed(1)} MB zipped.`);
    });
  } catch (err) {
    await updateState((s) => {
      s.phase = 'error';
      s.error = 'Rebuild failed: ' + (err && err.message ? err.message : String(err));
      addLog(s, s.error);
    });
  }
}
