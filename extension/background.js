// Service worker: orchestrates analyze → rebuild → package → zip.
// All state lives in chrome.storage.local so the popup can render progress
// at any time (and survive being closed/reopened mid-run).

import { buildZip, utf8Bytes } from './lib/zip.js';
import { modelToElementor, nodeToElementor } from './lib/elementor.js';
import { analyzePage } from './content/analyzer.js';

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
  zipB64: '',
  zipName: '',
  summary: null,
  cancelRequested: false,
  startModel: null,
};

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(1500); // let lazy content / fonts settle
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: analyzePage,
    });
    return res && res.result;
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ---------------------------------------------------------------- assets

const MAX_ASSETS = 250;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

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
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_ASSET_BYTES) throw new Error('larger than 8 MB');
  const mime = res.headers.get('content-type') || '';
  return { mime: mime.split(';')[0], b64: bytesToB64(buf), size: buf.length };
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
    case 'cancel':
      void updateState((s) => {
        s.cancelRequested = true;
        addLog(s, 'Cancel requested — stopping after the current step.');
      });
      break;
    case 'reset':
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
    const model = await analyzeInTab(url);
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
      const model = i === 0 && state.startModel ? state.startModel : await analyzeInTab(page.url);
      if (!model) throw new Error('Failed to analyze ' + page.url);
      models.push(model);
      await updateState((s) => {
        if (s.pages[i]) s.pages[i].status = 'analyzed';
        addLog(s, `Analyzed ${page.url} (${(model.body || []).length} top-level blocks).`);
      });
    }

    const state0 = await getState();
    if (state0.cancelRequested) return void (await updateState((s) => { s.phase = 'cancelled'; }));

    // 2. Download assets ------------------------------------------------------
    const first = models[0];
    const assetUrls = new Set();
    for (const m of models) for (const a of m.assets || []) assetUrls.add(a);
    const assets = {}; // url → {path, mime, b64, ok}
    const failed = [];
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
        const ext = extFromMime(a.mime, url);
        const path = `assets/${fnv1a(url)}-${fnv1a(a.b64.slice(0, 256))}.${ext}`;
        assets[url] = { path, mime: a.mime || 'application/octet-stream', b64: a.b64, size: a.size };
      } catch (err) {
        failed.push(url);
        assets[url] = null; // keep remote URL in the Elementor output
      }
    }
    await updateState((s) => {
      addLog(s, `Assets: ${Object.values(assets).filter(Boolean).length} downloaded, ${failed.length} will stay as remote URLs.`);
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
      if (a) assetsIndex[a.path] = { url, mime: a.mime };
    }

    const pkg = {
      format: 'site-rebuilder/1',
      generatedAt: new Date().toISOString(),
      source: { url: first.url, platform: first.platform || 'generic' },
      siteStyles: first.globalStyles || {},
      navigation: first.navLinks || [],
      assets: assetsIndex,
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
    const zipBytes = new Uint8Array(await blob.arrayBuffer());
    const zipB64 = bytesToB64(zipBytes);
    const host = (() => { try { return new URL(first.url).hostname.replace(/^www\./, ''); } catch { return 'site'; } })();
    const zipName = `site-rebuilder-${host}-${Date.now()}.zip`;

    const downloaded = Object.values(assets).filter(Boolean).length;
    await updateState((s) => {
      s.phase = 'done';
      s.zipB64 = zipB64;
      s.zipName = zipName;
      s.summary = {
        pages: pages.length,
        assets: downloaded,
        remoteAssets: failed.length,
        hasHeader: !!headerEl,
        hasFooter: !!footerEl,
        zipBytes: zipBytes.length,
      };
      addLog(s, `Done! Package ready: ${pages.length} page(s), ${downloaded} local assets, ${(zipBytes.length / 1024 / 1024).toFixed(1)} MB.`);
    });
  } catch (err) {
    await updateState((s) => {
      s.phase = 'error';
      s.error = 'Rebuild failed: ' + (err && err.message ? err.message : String(err));
      addLog(s, s.error);
    });
  }
}
