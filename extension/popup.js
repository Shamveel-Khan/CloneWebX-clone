// Popup UI — a thin view over chrome.storage.local "state", written by background.js.

const $ = (id) => document.getElementById(id);

const VIEWS = ['view-input', 'view-ready', 'view-running', 'view-done', 'view-error'];

function show(viewId) {
  for (const v of VIEWS) $(v).classList.toggle('hidden', v !== viewId);
}

function fmtBytes(n) {
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

function render(state) {
  const phase = state.phase || 'idle';

  const badge = $('phaseBadge');
  badge.classList.remove('hidden');
  const busy = phase === 'analyzing' || phase === 'rebuilding';
  badge.classList.toggle('busy', busy);
  badge.textContent =
    { idle: '', analyzing: 'Analyzing…', ready: 'Ready to rebuild', rebuilding: 'Rebuilding…', done: 'Done', error: 'Error', cancelled: 'Cancelled' }[phase] || '';

  $('url').value = state.sourceUrl || $('url').value || '';
  $('pageLimit').value = String(state.pageLimit || 5);

  if (phase === 'idle') {
    show('view-input');
  } else if (phase === 'analyzing') {
    show('view-running');
    $('runBar').style.width = '15%';
    $('runLabel').textContent = 'Analyzing ' + (state.sourceUrl || '') + ' — opening the page in a hidden tab…';
    $('log').textContent = (state.log || []).join('\n');
  } else if (phase === 'ready') {
    show('view-ready');
    $('readySource').textContent = state.sourceUrl || '';
    $('readySource').title = state.sourceUrl || '';
    $('readyPlatform').textContent = state.platform || 'unknown';
    $('readyPages').textContent = String((state.pages || []).length);
    $('readyAssets').textContent = String(state.assetCount || 0);
    $('readyPageList').innerHTML = (state.pages || [])
      .map((p, i) => `<div><span class="ellipsis">${i === 0 ? '★ ' : ''}${escapeHtml(p.title)}</span><span>${escapeHtml(shortUrl(p.url))}</span></div>`)
      .join('');
    $('log').textContent = '';
  } else if (phase === 'rebuilding') {
    show('view-running');
    const { current = 0, total = 1, label = '' } = state.progress || {};
    $('runBar').style.width = Math.round((current / Math.max(total, 1)) * 100) + '%';
    $('runLabel').textContent = label;
    $('log').textContent = (state.log || []).join('\n');
  } else if (phase === 'done') {
    show('view-done');
    const s = state.summary || {};
    $('donePages').textContent = String(s.pages || 0);
    $('doneAssets').textContent = String(s.assets || 0) + (s.remoteAssets ? ` (+${s.remoteAssets} kept remote)` : '');
    $('doneHF').textContent = (s.hasHeader ? 'header' : '—') + ' / ' + (s.hasFooter ? 'footer' : '—');
    $('doneSize').textContent = fmtBytes(s.zipBytes || 0);
    const note = $('doneRemoteNote');
    note.classList.toggle('hidden', !s.remoteAssets);
    if (s.remoteAssets) {
      note.textContent = `${s.remoteAssets} asset(s) could not be downloaded and reference the original site — the importer keeps them as remote URLs.`;
    }
    $('log').textContent = (state.log || []).join('\n');
  } else if (phase === 'cancelled') {
    show('view-error');
    $('errorMsg').textContent = 'Rebuild cancelled.';
  } else if (phase === 'error') {
    show('view-error');
    $('errorMsg').textContent = state.error || 'Something went wrong.';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shortUrl(u) {
  try {
    const url = new URL(u);
    return (url.pathname === '/' || url.pathname === '' ? '' : url.pathname) || '/';
  } catch {
    return u;
  }
}

// ---------------------------------------------------------------- actions

function send(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

$('btnAnalyze').addEventListener('click', () => {
  const url = $('url').value.trim();
  if (!url) {
    $('url').focus();
    return;
  }
  send({ type: 'analyze', url, pageLimit: parseInt($('pageLimit').value, 10) || 5 });
});
$('url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btnAnalyze').click();
});

$('btnRebuild').addEventListener('click', () => send({ type: 'rebuild' }));
$('btnCancel').addEventListener('click', () => send({ type: 'cancel' }));
$('btnRestart').addEventListener('click', () => send({ type: 'reset' }));
$('btnRetry').addEventListener('click', () => send({ type: 'reset' }));
$('btnBack1').addEventListener('click', () => send({ type: 'reset' }));

$('btnDownload').addEventListener('click', async () => {
  const { state } = await chrome.storage.local.get('state');
  if (!state || !state.zipB64) return;
  const bin = atob(state.zipB64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.zipName || 'site-rebuilder.zip';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
});

// ---------------------------------------------------------------- init

chrome.storage.local.get('state').then(({ state }) => render(state || { phase: 'idle' }));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state) render(changes.newValue || { phase: 'idle' });
});
