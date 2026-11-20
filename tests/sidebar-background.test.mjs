// Background service worker tests for the dockable sidebar: runs the real background.js in a Node vm against a mock
// chrome.* API. Covers which tab the side panel is enabled for, the user-gesture ordering of sidePanel.open(), refusal,
// undock/close/toggle-off cleanup, navigation, and that docking state is per tab.
//
// Usage: node sidebar-background.test.mjs [extension-dir]   (from tests/)
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(process.argv[2] || join(here, '..'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`); };

function makeWorker({ sidePanel = true, openFails = false, events = true } = {}) {
  const calls = [];
  const session = {};
  const L = { message: null, removed: [], updated: [], clicked: [], closed: [], opened: [] };
  const tabsSent = [];
  const chrome = {
    storage: { session: { get: async (k) => (typeof k === 'string' ? { [k]: session[k] } : { ...session }), set: async (o) => { Object.assign(session, JSON.parse(JSON.stringify(o))); } } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: { addListener: (f) => L.clicked.push(f) } },
    tabs: {
      onRemoved: { addListener: (f) => L.removed.push(f) }, onUpdated: { addListener: (f) => L.updated.push(f) },
      sendMessage: async (id, m) => { tabsSent.push([id, m]); },
    },
    scripting: { executeScript: async () => {} },
    runtime: { onMessage: { addListener: (f) => { L.message = f; } } },
    downloads: {},
  };
  if (sidePanel) {
    chrome.sidePanel = {
      ...(events ? { onClosed: { addListener: (f) => L.closed.push(f) }, onOpened: { addListener: (f) => L.opened.push(f) } } : {}),
      setOptions: (o) => { calls.push(['setOptions', JSON.parse(JSON.stringify(o))]); return Promise.resolve(); },
      open: (o) => { calls.push(['open', JSON.parse(JSON.stringify(o))]); return openFails ? Promise.reject(new Error('may only be called in response to a user gesture')) : Promise.resolve(); },
    };
  }
  const ctx = vm.createContext({ chrome, console, URL, fetch: async () => ({}), setTimeout, clearTimeout, Date, JSON, Promise, Object, Array, Set, Math });
  vm.runInContext(readFileSync(join(ext, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  const send = (msg, tabId = 7) => new Promise((resolveMsg) => { L.message(msg, { tab: { id: tabId, windowId: 1 } }, resolveMsg); });
  return { chrome, calls, session, L, send, tabsSent };
}

// ---- docking
{
  const w = makeWorker();
  const pending = w.send({ type: 'blueline:sb-dock' }, 7);
  check('sidePanel.open() and setOptions() are both issued synchronously from the click (before any await), for that tab only',
    w.calls.length === 2 && w.calls.every(([, o]) => o.tabId === 7) && w.calls.some(([n]) => n === 'open') && w.calls.some(([n, o]) => n === 'setOptions' && o.enabled === true));
  const setOpt = w.calls.find(([n]) => n === 'setOptions')[1];
  check('The panel page is bound to the tab through its URL', setOpt.path === 'sidepanel.html?tab=7', setOpt.path);
  const res = await pending;
  check('Docking answers ok and records the tab as docked (session storage only)', res && res.ok === true && JSON.stringify(w.session['blueline:sb-docked']) === '{"7":true}');
  check('State query: that tab is docked, another is not, and the side panel is supported', (await w.send({ type: 'blueline:sb-state' }, 7)).docked === true && (await w.send({ type: 'blueline:sb-state' }, 8)).docked === false && (await w.send({ type: 'blueline:sb-state' }, 8)).supported === true);

  const second = await w.send({ type: 'blueline:sb-dock' }, 9);
  check('Docking a second tab does not touch the first (per-tab state)', second.ok && JSON.stringify(Object.keys(w.session['blueline:sb-docked']).sort()) === '["7","9"]');
  w.calls.length = 0;

  await w.send({ type: 'blueline:sb-undock' }, 7);
  check('Undock disables the side panel for that tab and forgets it, leaving the other tab docked',
    w.calls.some(([n, o]) => n === 'setOptions' && o.tabId === 7 && o.enabled === false) && JSON.stringify(w.session['blueline:sb-docked']) === '{"9":true}');

  w.calls.length = 0;
  w.L.updated[0](9, { status: 'loading' });
  await new Promise((r) => setTimeout(r, 20));
  check('When a docked tab navigates, its panel options are put back (path and enabled)', w.calls.some(([n, o]) => n === 'setOptions' && o.tabId === 9 && o.enabled === true && o.path === 'sidepanel.html?tab=9'));
  w.calls.length = 0;
  w.L.updated[0](7, { status: 'loading' });
  await new Promise((r) => setTimeout(r, 20));
  check('A tab that is not docked is never given a panel on navigation', w.calls.length === 0);

  w.L.removed[0](9);
  await new Promise((r) => setTimeout(r, 20));
  check('Closing a docked tab clears its docked state', !w.session['blueline:sb-docked'] || !w.session['blueline:sb-docked'][9]);
}

// ---- toolbar toggle off while docked
{
  const w = makeWorker();
  await w.send({ type: 'blueline:toggle', on: true }, 5);
  await w.send({ type: 'blueline:sb-dock' }, 5);
  w.calls.length = 0;
  await w.send({ type: 'blueline:toggle', on: false }, 5);
  check('Turning Blueline off releases the docked side panel for that tab', w.calls.some(([n, o]) => n === 'setOptions' && o.tabId === 5 && o.enabled === false) && !(w.session['blueline:sb-docked'] || {})[5]);
  check('The toolbar toggle still tells the tab to switch off', w.tabsSent.some(([id, m]) => id === 5 && m.type === 'blueline:set-active' && m.on === false));
}

// ---- launcher (side panel closed on a phone-sized page)
{
  const w = makeWorker();
  await w.send({ type: 'blueline:sb-dock' }, 6);
  w.calls.length = 0;
  await w.send({ type: 'blueline:sb-launcher' }, 6);
  const st = await w.send({ type: 'blueline:sb-state' }, 6);
  check('Launcher mode releases the side panel for that tab and is remembered per tab, not as docked', st.launcher === true && st.docked === false && w.calls.some(([n, o]) => n === 'setOptions' && o.tabId === 6 && o.enabled === false) && (await w.send({ type: 'blueline:sb-state' }, 7)).launcher === false);
  await w.send({ type: 'blueline:sb-dock' }, 6);
  check('Docking again clears launcher mode', (await w.send({ type: 'blueline:sb-state' }, 6)).launcher === false && (await w.send({ type: 'blueline:sb-state' }, 6)).docked === true);
  await w.send({ type: 'blueline:sb-launcher' }, 6);
  await w.send({ type: 'blueline:sb-undock' }, 6);
  check('An explicit return to floating clears launcher mode', (await w.send({ type: 'blueline:sb-state' }, 6)).launcher === false);
  await w.send({ type: 'blueline:sb-launcher' }, 6);
  await w.send({ type: 'blueline:toggle', on: false }, 6);
  check('Turning Blueline off clears launcher mode', (await w.send({ type: 'blueline:sb-state' }, 6)).launcher === false);
}

// ---- immediate close / open notices (Chrome 142+), and older Chrome without them
{
  const w = makeWorker();
  await w.send({ type: 'blueline:sb-dock' }, 12);
  w.L.closed[0]({ tabId: 12, windowId: 1, path: 'sidepanel.html?tab=12' });
  w.L.closed[0]({ windowId: 1, path: 'sidepanel.html?tab=12' });
  w.L.opened[0]({ tabId: 12, windowId: 1, path: 'sidepanel.html?tab=12' });
  await new Promise((r) => setTimeout(r, 30));
  const got = w.tabsSent.filter(([id]) => id === 12).map(([, m]) => m.type);
  check('A docked tab is told when its side panel closes (tabId, or the ?tab= in the path) and when one opens', got.join() === 'blueline:sb-closed,blueline:sb-closed,blueline:sb-opened', got.join());
  w.tabsSent.length = 0;
  w.L.closed[0]({ tabId: 99, windowId: 1, path: 'sidepanel.html?tab=99' });
  await new Promise((r) => setTimeout(r, 30));
  check('A tab that is not docked is never notified (no cross-tab messages)', w.tabsSent.length === 0);
  await w.send({ type: 'blueline:sb-undock' }, 12);
  w.tabsSent.length = 0;
  w.L.closed[0]({ tabId: 12, windowId: 1, path: 'sidepanel.html?tab=12' });
  await new Promise((r) => setTimeout(r, 30));
  check('Our own programmatic close (undock / toolbar off) is not reported as the user closing the panel', w.tabsSent.length === 0);
  const old = makeWorker({ events: false });
  await old.send({ type: 'blueline:sb-dock' }, 13);
  check('Older Chrome (no onClosed / onOpened) still loads and docks; the tab falls back to noticing the dropped connection', old.L.closed.length === 0 && (await old.send({ type: 'blueline:sb-state' }, 13)).docked === true);
}

// ---- refusal and unsupported browsers
{
  const w = makeWorker({ openFails: true });
  const res = await w.send({ type: 'blueline:sb-dock' }, 3);
  check('If Chrome refuses to open the panel, the answer is not ok, with the reason, and nothing stays docked', res.ok === false && /gesture/.test(res.error) && !(w.session['blueline:sb-docked'] || {})[3]);
  check('A refused dock disables the per-tab panel it had enabled', w.calls.some(([n, o]) => n === 'setOptions' && o.tabId === 3 && o.enabled === false));
  const u = makeWorker({ sidePanel: false });
  const r2 = await u.send({ type: 'blueline:sb-dock' }, 3);
  check('Without chrome.sidePanel (older Chrome) docking is refused politely and state says unsupported', r2.ok === false && (await u.send({ type: 'blueline:sb-state' }, 3)).supported === false);
}

// ---- unchanged messages keep working
{
  const w = makeWorker();
  check('Existing messages are untouched (unknown types still answer null; hello reports inactive)', (await w.send({ type: 'nope' })) === null && (await w.send({ type: 'blueline:hello' }, 4)).active === false);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
