/* Blueline v0.5 — service worker
 * Tracks which tabs have QC mode on, captures screenshots, and saves files to Downloads.
 */

const ACTIVE_KEY = 'blueline:active';
const INK = '#2B4EFF';

async function getActive() {
  const res = await chrome.storage.session.get(ACTIVE_KEY);
  return res[ACTIVE_KEY] || {};
}

async function setBadge(tabId, on) {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: INK });
  } catch {
    /* tab is gone */
  }
}

async function setActiveFlag(tabId, on) {
  const active = await getActive();
  if (on) active[tabId] = true;
  else delete active[tabId];
  await chrome.storage.session.set({ [ACTIVE_KEY]: active });
  await setBadge(tabId, on);
}

async function toggle(tab, force) {
  if (!tab || tab.id == null) return;
  const active = await getActive();
  const on = typeof force === 'boolean' ? force : !active[tab.id];
  await setActiveFlag(tab.id, on);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'blueline:set-active', on });
  } catch {
    // Page was open before the extension loaded: inject both scripts now.
    if (!on) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['page-hook.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js', 'library.js', 'cards.js', 'tools.js', 'library-ui.js'] });
    } catch (err) {
      await setActiveFlag(tab.id, false);
      console.warn('Blueline can\u2019t run on this page:', err && err.message);
    }
  }
}

function waitForDownload(id, timeout = 15000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (item && (item.state === 'complete' || item.state === 'interrupted')) return resolve(item);
      if (Date.now() - start > timeout) return resolve(item || null);
      setTimeout(check, 150);
    };
    check();
  });
}

async function downloadAll(folder, files = []) {
  const paths = [];
  for (const f of files) {
    try {
      // No folder: a standalone file goes where the browser normally puts downloads (or its own Save As prompt).
      const opts = folder ? { url: f.dataUrl, filename: `${folder}/${f.name}`, saveAs: false, conflictAction: 'uniquify' } : { url: f.dataUrl, filename: f.name, conflictAction: 'uniquify' };
      const id = await chrome.downloads.download(opts);
      const item = await waitForDownload(id);
      paths.push({ id: f.id, path: item && item.state === 'complete' ? item.filename : null });
    } catch (err) {
      return { paths, error: (err && err.message) || String(err) };
    }
  }
  return { paths };
}


// Product Library: read-only GET of a store's public storefront JSON. Content scripts are bound by the page's CORS
// rules; this worker is not, so a store on another origin can be read. Only three public paths are allowed, no
// cookies or credentials are sent, and nothing is ever written to the store.
const STORE_PATH = /^\/(products\/[^/]+\.js|search\/suggest\.json|cart\.js)$/;
async function fetchStoreJson(url) {
  let u;
  try { u = new URL(url); } catch { return { error: 'Not a valid address.' }; }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local)) || !STORE_PATH.test(u.pathname)) return { error: 'That request isn\u2019t allowed.' };
  try {
    const r = await fetch(u.href, { method: 'GET', credentials: 'omit', headers: { Accept: 'application/json' } });
    if (!r.ok) return { status: r.status, error: `The store answered ${r.status}.` };
    const text = await r.text();
    if (text.length > 4_000_000) return { error: 'The response was too large.' };
    return { json: JSON.parse(text) };
  } catch (err) {
    return { error: (err && err.message) || 'The request failed.' };
  }
}

chrome.action.onClicked.addListener((tab) => toggle(tab));
chrome.tabs.onRemoved.addListener((tabId) => { setActiveFlag(tabId, false).catch(() => {}); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tab = sender.tab;
  (async () => {
    switch (msg && msg.type) {
      case 'blueline:hello': {
        const active = !!(tab && (await getActive())[tab.id]);
        if (active) await setBadge(tab.id, true);
        return { active };
      }
      case 'blueline:toggle':
        await toggle(tab, msg.on);
        return { ok: true };
      case 'blueline:capture':
        try {
          return { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }) };
        } catch (err) {
          return { error: (err && err.message) || String(err) };
        }
      case 'blueline:fetch-json':
        return fetchStoreJson(msg.url);
      case 'blueline:download':
        return downloadAll(msg.folder, msg.files);
      default:
        return null;
    }
  })().then(sendResponse);
  return true;
});
