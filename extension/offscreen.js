// Offscreen document: turns the packaged ZIP blob (stored in IndexedDB) into
// an object URL that the service worker can hand to chrome.downloads.download.
// MV3 service workers cannot call URL.createObjectURL themselves.

let currentUrl = '';

function idbGet() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('sr-zips', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('zips');
    open.onsuccess = () => {
      const tx = open.result.transaction('zips', 'readonly');
      const req = tx.objectStore('zips').get('last');
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'create-blob-url') {
    (async () => {
      try {
        const rec = await idbGet();
        if (currentUrl) URL.revokeObjectURL(currentUrl);
        currentUrl = rec && rec.blob ? URL.createObjectURL(rec.blob) : '';
        sendResponse({ url: currentUrl });
      } catch (err) {
        sendResponse({ url: '', error: err && err.message ? err.message : String(err) });
      }
    })();
    return true; // async response
  }
  if (msg && msg.type === 'revoke-blob-url') {
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = '';
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
