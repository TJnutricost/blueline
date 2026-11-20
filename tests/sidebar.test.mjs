// Dockable sidebar tests (Chrome Side Panel). Real Chrome over the DevTools protocol, no npm dependencies.
//
// The extension itself cannot be loaded headless, so the two documents that make up the feature are loaded as ordinary
// pages with a small chrome.* stub and a Node-side relay that behaves like Chrome's port plumbing:
//   * a "tab"   page: the fixture with page-hook.js, content.js, library.js, cards.js, tools.js, library-ui.js, sidebar.js
//   * a "panel" page: sidepanel.html (served from /__ext/) whose chrome.tabs.connect() reaches only the tab it names
// Real mouse and keyboard input is used in both documents. See tests/README.md.
//
// Usage: node sidebar.test.mjs [extension-dir]   (from tests/)
import { launch } from './cdp.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PRODUCTS } from './fake-store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(process.argv[2] || join(here, '..'));
const LibNode = createRequire(import.meta.url)(join(ext, 'library.js'));
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('Chrome not found. Set CHROME_PATH.'); process.exit(2); }

const src = (f) => readFileSync(join(ext, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
setTimeout(() => { console.error('FAIL  watchdog: the suite took longer than 6 minutes'); process.exit(1); }, 360000).unref();
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`); };

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const EXT_FILES = new Set(['sidepanel.html', 'sidepanel.js']);
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const name = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  let file;
  if (name.startsWith('__ext/') && EXT_FILES.has(name.slice(6))) file = join(ext, name.slice(6));
  else { file = resolve(join(here, 'fixtures', name)); if (!file.startsWith(join(here, 'fixtures'))) file = null; }
  if (!file || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

// ---- the stubs ------------------------------------------------------------------------------------------------------
// Ports: both documents queue what they send in window.__out; the Node relay moves it to the other document, the way
// Chrome routes a chrome.tabs.connect() port only to the tab it names.
const BUS = `(() => {
  window.__out = []; window.__onConnect = [];
  const ports = new Map();
  const make = (pid, name, sender) => {
    const L = { m: [], d: [] }; let open = true;
    const port = {
      name, sender,
      onMessage: { addListener: (f) => L.m.push(f) }, onDisconnect: { addListener: (f) => L.d.push(f) },
      postMessage: (m) => { if (!open) throw new Error('Attempting to use a disconnected port object'); window.__out.push({ k: 'msg', pid, data: JSON.parse(JSON.stringify(m)) }); },
      disconnect: () => { if (!open) return; open = false; ports.delete(pid); window.__out.push({ k: 'dc', pid }); },
    };
    ports.set(pid, { port, L, gone() { if (!open) return; open = false; ports.delete(pid); L.d.forEach((f) => f(port)); } });
    return port;
  };
  window.__bus = {
    accept(pid, name) {
      if (!window.__onConnect.length) { window.__out.push({ k: 'refuse', pid }); return; }
      const port = make(pid, name, { id: 'blueline-test', url: 'chrome-extension://blueline-test/sidepanel.html' });
      window.__onConnect.forEach((f) => f(port));
    },
    msg(pid, d) { const p = ports.get(pid); if (p) p.L.m.forEach((f) => f(d, p.port)); },
    dc(pid) { const p = ports.get(pid); if (p) p.gone(); },
    open: () => ports.size,
  };
  window.__make = make;
})();`;

const REAL_STORAGE = `(() => {
  const store = {}; const listeners = [];
  const fire = (changes) => setTimeout(() => listeners.forEach((f) => f(changes, 'local')), 0);
  window.chrome.storage = {
    local: {
      get: async (keys) => { const out = {}; for (const k of [].concat(keys || Object.keys(store))) if (k in store) out[k] = JSON.parse(JSON.stringify(store[k])); return out; },
      set: async (o) => { const changes = {}; for (const [k, v] of Object.entries(o)) { changes[k] = { oldValue: store[k], newValue: JSON.parse(JSON.stringify(v)) }; store[k] = JSON.parse(JSON.stringify(v)); } fire(changes); },
      remove: async (keys) => { const changes = {}; for (const k of [].concat(keys)) { changes[k] = { oldValue: store[k] }; delete store[k]; } fire(changes); },
    },
    onChanged: { addListener: (f) => listeners.push(f) },
  };
})();`;

const TAB_STUB = `window.chrome = {
  runtime: {
    id: 'blueline-test', getManifest: () => ({ version: 'test' }),
    onMessage: { addListener: (f) => { (window.__onMsg = window.__onMsg || []).push(f); } },
    onConnect: { addListener: (f) => window.__onConnect.push(f) },
    sendMessage: async (m) => {
      (window.__sent = window.__sent || []).push(m);
      if (m && m.type === 'blueline:hello') return { active: true };
      if (m && m.type === 'blueline:sb-state') return window.__sbState || { supported: true, docked: false };
      if (m && m.type === 'blueline:sb-dock') return window.__dockAnswer || { ok: true };
      if (m && m.type === 'blueline:sb-undock') return { ok: true };
      return null;
    },
  },
}; window.__BLUELINE_TEST__ = {};
(() => { // count window listeners Blueline adds and removes, to prove docking leaves none behind
  const net = (window.__wl = {}); const add = window.addEventListener.bind(window); const rm = window.removeEventListener.bind(window);
  window.addEventListener = (t, f, o) => { net[t] = (net[t] || 0) + 1; return add(t, f, o); };
  window.removeEventListener = (t, f, o) => { net[t] = (net[t] || 0) - 1; return rm(t, f, o); };
})();`;

const PANEL_STUB = (tabId) => `window.chrome = {
  runtime: { id: 'blueline-test', lastError: undefined },
  tabs: { connect: (tab, info) => {
    const pid = 'p' + Math.random().toString(36).slice(2);
    const port = window.__make(pid, info.name, undefined);
    window.__out.push({ k: 'connect', pid, tabId: tab, name: info.name });
    return port;
  } },
}; window.__clip = [];
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__clip.push(t); } }, configurable: true });`;

// ---- the relay -----------------------------------------------------------------------------------------------------
class Relay {
  constructor() { this.pages = new Map(); this.panels = new Set(); this.routes = new Map(); this.busy = false; this.t = setInterval(() => this.pump(), 8); }
  addPage(tabId, page) { this.pages.set(tabId, page); }
  addPanel(page) { this.panels.add(page); }
  async drain(p) { try { return await p.evaluate(() => (window.__out ? window.__out.splice(0) : [])); } catch { return []; } }
  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const [tabId, pg] of this.pages) for (const m of await this.drain(pg)) await this.fromPage(pg, m);
      for (const pn of this.panels) for (const m of await this.drain(pn)) await this.fromPanel(pn, m);
    } catch { /* a page closed mid-pump */ } finally { this.busy = false; }
  }
  to(p, fn, ...a) { return p.evaluate(fn, ...a).catch(() => {}); }
  async fromPanel(pn, m) {
    if (m.k === 'connect') {
      const pg = this.pages.get(m.tabId);
      if (!pg) { await this.to(pn, (pid) => __bus.dc(pid), m.pid); return; }
      this.routes.set(m.pid, { pn, pg });
      await this.to(pg, (pid, name) => __bus.accept(pid, name), m.pid, m.name);
    } else if (m.k === 'msg') { const r = this.routes.get(m.pid); if (r) await this.to(r.pg, (pid, d) => __bus.msg(pid, d), m.pid, m.data); }
    else if (m.k === 'dc') { const r = this.routes.get(m.pid); this.routes.delete(m.pid); if (r) await this.to(r.pg, (pid) => __bus.dc(pid), m.pid); }
  }
  async fromPage(pg, m) {
    const r = this.routes.get(m.pid);
    if (!r || r.pg !== pg) return;
    if (m.k === 'msg') await this.to(r.pn, (pid, d) => __bus.msg(pid, d), m.pid, m.data);
    else { this.routes.delete(m.pid); await this.to(r.pn, (pid) => __bus.dc(pid), m.pid); } // 'dc' or 'refuse'
  }
  // Chrome closes a tab's ports when it navigates; and a panel's ports when it is closed.
  async dropPage(pg) { for (const [pid, r] of [...this.routes]) if (r.pg === pg) { this.routes.delete(pid); await this.to(r.pn, (p) => __bus.dc(p), pid); } }
  async dropPanel(pn) { this.panels.delete(pn); for (const [pid, r] of [...this.routes]) if (r.pn === pn) { this.routes.delete(pid); await this.to(r.pg, (p) => __bus.dc(p), pid); } }
  forget(page) { for (const [id, p] of this.pages) if (p === page) this.pages.delete(id); this.panels.delete(page); }
  stop() { clearInterval(this.t); }
}

const browser = await launch({ executablePath: CHROME, args: ['--window-size=1280,900'] });
const relay = new Relay();
const SCRIPTS = ['page-hook.js', 'content.js', 'library.js', 'cards.js', 'tools.js', 'library-ui.js', 'sidebar.js'];

async function loadScripts(page, { sbState, seed, keepFloat = true } = {}) {
  // most scenarios start from the floating panel; a phone-sized page would otherwise collapse itself (tested separately)
  await page.evaluate((k) => { try { if (k) sessionStorage.setItem('__blueline_keepfloat', '1'); else sessionStorage.removeItem('__blueline_keepfloat'); } catch {} }, keepFloat);
  await page.addScriptTag({ content: BUS });
  await page.addScriptTag({ content: TAB_STUB });
  await page.addScriptTag({ content: REAL_STORAGE });
  if (sbState) await page.evaluate((s) => { window.__sbState = s; }, sbState);
  if (seed) await page.evaluate((s) => chrome.storage.local.set(s), seed);
  for (const f of SCRIPTS) await page.addScriptTag({ content: src(f) });
  await page.waitForFunction(() => window.__BL?.S?.active && window.__BL.S.ui && window.__BL.sidebar);
  await sleep(200);
}
async function openTab(tabId, { fixture = 'sidebar.html', viewport = { width: 1280, height: 900 }, seed, sbState, keepFloat = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.goto(`http://127.0.0.1:${PORT}/${fixture}`);
  await loadScripts(page, { seed, sbState, keepFloat });
  relay.addPage(tabId, page);
  page.tabId = tabId;
  return page;
}
async function reloadTab(page, { fixture = 'sidebar.html', sbState, seed } = {}) {
  await relay.dropPage(page);
  await page.goto(`http://127.0.0.1:${PORT}/${fixture}`);
  await loadScripts(page, { sbState, seed });
}
async function openPanel(tabId, viewport = { width: 380, height: 760 }) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: BUS + PANEL_STUB(tabId) });
  relay.addPanel(page);
  await page.goto(`http://127.0.0.1:${PORT}/__ext/sidepanel.html?tab=${tabId}`);
  return page;
}

// ---- helpers (tab) ------------------------------------------------------------------------------------------------
const waitUntil = async (fn, { timeout = 8000, step = 40 } = {}) => { const end = Date.now() + timeout; for (;;) { if (await fn()) return true; if (Date.now() > end) return false; await sleep(step); } };
const mode = (P) => P.evaluate(() => __BL.sidebar.mode());
const sent = (P, type) => P.evaluate((t) => (window.__sent || []).filter((m) => m.type === t).length, type);
const store = (P) => P.evaluate(() => chrome.storage.local.get().then((r) => JSON.stringify(Object.fromEntries(Object.entries(r).sort()))));
const notes = (P) => P.evaluate(() => (__BL.S.batch?.items || []).filter((i) => !i.cardRecord).map((i) => i.note));
const rect = (P, sel) => P.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
const real = (P, sel) => P.evaluate((s) => { const e = __BL.S.ui.root.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { w: b.width, h: b.height, vis: cs.visibility, hidden: e.hidden, text: e.textContent.trim().slice(0, 80), val: e.value }; }, sel);
const uiSig = (P) => P.evaluate(() => [...__BL.S.ui.root.children].filter((c) => !['hl', 'pins', 'x-layers'].some((k) => c.classList.contains(k)) && !c.hasAttribute('data-sb-skip')).map((c) => c.outerHTML).join('\n'));
// ---- helpers (panel)
const pq = (Pn, sel) => Pn.evaluate((s) => {
  const r = document.getElementById('bl-host')?.shadowRoot; const e = r && r.querySelector(s); if (!e) return null;
  const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
  return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, vis: cs.visibility, disp: cs.display, hidden: e.hidden, text: e.textContent.trim().slice(0, 100), val: e.value, checked: e.checked, cls: e.className };
}, sel);
const picking = (P) => P.evaluate(() => __BL.toolsApi.A.on === true);
const closeNote = async (Pn, P) => { if (await P.evaluate(() => !!__BL.S.pop)) { await pclick(Pn, '[data-act="pop-cancel"]'); await waitUntil(async () => !(await P.evaluate(() => !!__BL.S.pop))); } };
const pclick = async (Pn, sel) => { let r = null; await waitUntil(async () => { r = await pq(Pn, sel); return !!r && r.w > 0; }, { timeout: 4000 }); if (!r || !(r.w > 0)) throw new Error(`panel: ${sel} is not available: ${JSON.stringify(r)} visible buttons: ${JSON.stringify(await Pn.evaluate(() => [...(document.getElementById('bl-host')?.shadowRoot?.querySelectorAll('button') || [])].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.dataset.act || b.dataset.x || '?')))} status: ${await msgText(Pn)}`); await Pn.mouse.click(r.x, r.y); await sleep(60); };
const ptype = async (Pn, text) => { for (const ch of text) await Pn.keyboard.press(ch); await sleep(60); };
const pSig = (Pn) => Pn.evaluate(() => [...document.getElementById('bl-host').shadowRoot.children].filter((c) => c.__bl !== undefined).map((c) => c.outerHTML).join('\n'));
const inSync = async (P, Pn) => waitUntil(async () => (await uiSig(P)) === (await pSig(Pn)), { timeout: 4000 });
const msgText = (Pn) => Pn.evaluate(() => { const m = document.getElementById('msg'); return m.hidden ? '' : m.textContent.trim(); });

// click the Dock button on the page (a real click), then "Chrome opens the panel" for this tab
const launcherRect = (P) => P.evaluate(() => { const b = __BL.S.ui.root.querySelector('.sb-launch-dock'); if (!b) return null; const r = b.getBoundingClientRect(); const cs = getComputedStyle(b); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, vis: cs.visibility }; });
async function dockViaButton(P) {
  const SEL = (await mode(P)) === 'launcher' ? '.sb-launch-dock' : '[data-act="sb-dock"]';
  if (!(await waitUntil(async () => ['floating', 'launcher'].includes(await mode(P)) && (await real(P, SEL === '.sb-launch-dock' ? '.panel' : SEL))?.w > 0 || (SEL === '.sb-launch-dock' && !!(await launcherRect(P))), { timeout: 4000 }))) throw new Error(`cannot dock: mode is ${await mode(P)} (the test left a dialog or panel open)`);
  const at = () => P.evaluate((sel) => { const r = __BL.S.ui.root.querySelector(sel).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, SEL);
  let pos = await at();
  for (let i = 0; i < 20; i++) { await sleep(60); const again = await at(); if (again.x === pos.x && again.y === pos.y) break; pos = again; } // let the layout settle first
  await P.mouse.click(pos.x, pos.y);
  await sleep(60);
  const pn = await openPanel(P.tabId);
  await waitUntil(async () => (await mode(P)) === 'sidebar');
  await pq(pn, '.panel') || await waitUntil(async () => !!(await pq(pn, '.panel')));
  return pn;
}
// Make the tab report itself visible or hidden (headless Chrome decides that by which window was opened last)
const setVisible = (P, vis) => P.evaluate((v) => { window.__vis = v ? 'visible' : 'hidden'; if (!window.__visPatched) { window.__visPatched = true; Object.defineProperty(document, 'visibilityState', { get: () => window.__vis, configurable: true }); } document.dispatchEvent(new Event('visibilitychange')); }, vis);
const closePanel = async (Pn) => { await relay.dropPanel(Pn); relay.forget(Pn); await Pn.close(); };

// =====================================================================================================================
console.log('\n# Sidebar: floating default, docking, page stays unobstructed (390px phone viewport)');
let A = await openTab(1, { viewport: { width: 390, height: 844 } });
check('Floating mode is the default, and a Dock to sidebar control is visible in it', (await mode(A)) === 'floating' && (await real(A, '[data-act="sb-dock"]'))?.w > 20 && (await real(A, '.panel')).vis === 'visible');
check('Return-to-floating control is not shown while floating', (await real(A, '.sb-only')).w === 0);
check('Nothing about the sidebar is requested by merely opening Blueline', (await sent(A, 'blueline:sb-dock')) === 0 && (await A.evaluate(() => window.__bus.open())) === 0);
const layout = () => A.evaluate(() => ({ w: document.documentElement.clientWidth, body: Math.round(document.body.getBoundingClientRect().width), style: document.documentElement.getAttribute('style'), scrollX: scrollX }));
const L0 = await layout();
const storeBefore = await store(A);

let PN = await dockViaButton(A);
check('Dock to sidebar asks the background exactly once (synchronously from the click)', (await sent(A, 'blueline:sb-dock')) === 1);
check('Docked: the real floating UI is hidden but still laid out', await A.evaluate(() => { const p = __BL.S.ui.root.querySelector('.panel'); const cs = getComputedStyle(p); return cs.visibility === 'hidden' && p.getBoundingClientRect().width > 0 && __BL.S.ui.host.hasAttribute('data-sb'); }));
check('The side panel shows the real Blueline panel, filling the panel width', await (async () => { const p = await pq(PN, '.panel'); return !!p && p.vis === 'visible' && Math.abs(p.w - 380) < 2 && p.h > 600; })());
check('Docked panel has Return to floating panel, not Dock, side or minimize', (await pq(PN, '[data-act="sb-undock"]'))?.w > 100 && (await pq(PN, '[data-act="sb-dock"]'))?.disp === 'none' && (await pq(PN, '[data-act="collapse"]'))?.disp === 'none');
check('Nothing of Blueline covers the page: probing the old panel corner and centre hits page elements only', await A.evaluate(() => [[360, 800], [195, 420], [30, 800], [360, 40]].every(([x, y]) => { const e = document.elementFromPoint(x, y); return e && e.localName !== 'blueline-ui'; })));
check('The page is not resized or shifted by docking (viewport width, body width, root style, scroll)', JSON.stringify(await layout()) === JSON.stringify(L0), JSON.stringify(await layout()));
check('Docking does not write any workspace data (storage is byte-identical)', (await store(A)) === storeBefore);
check('The mirrored panel markup is identical to the real panel markup', await inSync(A, PN));

console.log('\n# Sidebar: selecting and annotating from the sidebar (page selection initiated in the panel)');
await pclick(PN, '[data-x="start-select"]');
check('Select element in the sidebar starts selecting on the page', await waitUntil(() => picking(A)));
check('The sidebar shows the on-page instructions (the Esc bar) while selecting', await waitUntil(async () => { const b = await pq(PN, '.x-bar'); return !!b && b.hidden === false && b.w > 100 && /Click|Esc|element/i.test(b.text); }));
check('The page shows the crosshair cursor style while selecting', await A.evaluate(() => !!document.getElementById('blueline-cursor')));
const c1 = await rect(A, '#c1 .nm');
await A.mouse.click(c1.x, c1.y);
check('Clicking an element on the page opens the note editor, shown in the sidebar', await waitUntil(async () => { const p = await pq(PN, '.pop-note'); return !!p && p.w > 100 && (await pq(PN, '.pop'))?.disp !== 'none' && (await pq(PN, '.pop'))?.hidden === false; }));
check('The selection outline stays on the page (not mirrored)', await A.evaluate(() => { const h = __BL.S.ui.root.querySelector('.hl, .hl2'); return !!h; }) && !(await PN.evaluate(() => !!document.getElementById('bl-host').shadowRoot.querySelector('.hl, .pins, .x-layers'))));
await pclick(PN, '.pop-note');
await ptype(PN, 'Make title bigger');
check('Typing in the sidebar reaches the real note field without losing characters', await waitUntil(async () => (await real(A, '.pop-note')).val === 'Make title bigger'), (await real(A, '.pop-note')).val);
const draftSig = await store(A);
check('Nothing is saved while the note is only a draft', (await notes(A)).length === 0);

console.log('\n# Sidebar: switching modes keeps unsaved work');
await pclick(PN, '[data-act="sb-undock"]');
check('Return to floating panel returns to floating mode', await waitUntil(async () => (await mode(A)) === 'floating'));
check('The floating panel is visible again with the unsaved draft and the open note editor intact', await A.evaluate(() => { const p = __BL.S.ui.root.querySelector('.panel'); return getComputedStyle(p).visibility === 'visible' && __BL.S.ui.root.querySelector('.pop-note').value === 'Make title bigger' && !!__BL.S.pop; }));
check('The side panel is told Blueline is back in the floating panel', await waitUntil(async () => /floating panel/.test(await msgText(PN))));
check('Background was asked to release the side panel for this tab', (await sent(A, 'blueline:sb-undock')) === 1);
await closePanel(PN);
check('No workspace data changed by the mode round trip', (await store(A)) === draftSig);
PN = await dockViaButton(A);
check('Docking again re-shows the same draft in the sidebar', await waitUntil(async () => (await pq(PN, '.pop-note'))?.val === 'Make title bigger'));
await pclick(PN, '[data-act="pop-save"]');
check('Save note from the sidebar saves exactly one note through the normal handler', await waitUntil(async () => (await notes(A)).join('|') === 'Make title bigger'));
check('The saved note appears in the sidebar list and the mirror still matches', await waitUntil(async () => /Make title bigger/.test((await pq(PN, '.list'))?.text || '')) && await inSync(A, PN));
check('The annotation marker stays on the page (and is not in the sidebar)', await A.evaluate(() => __BL.S.ui.root.querySelectorAll('.x-marksbox .mk').length === 1) && !(await PN.evaluate(() => !!document.getElementById('bl-host').shadowRoot.querySelector('.x-marksbox, .mk'))));
const savedStore = await store(A);
await pclick(PN, '[data-act="sb-undock"]');
await waitUntil(async () => (await mode(A)) === 'floating');
check('After returning to floating the annotation, note list and storage are intact', (await notes(A)).join('|') === 'Make title bigger' && (await store(A)) === savedStore && await A.evaluate(() => __BL.S.ui.root.querySelectorAll('.item').length === 1));
await closePanel(PN);

console.log('\n# Sidebar: Escape and keyboard');
PN = await dockViaButton(A);
await pclick(PN, '[data-x="start-select"]');
await waitUntil(() => picking(A));
await PN.keyboard.press('Escape');
check('Escape typed in the sidebar cancels selecting on the page', await waitUntil(async () => !(await picking(A))));
await pclick(PN, '[data-act="pop-cancel"]'); // the empty note editor Select element opened stays until cancelled
await waitUntil(async () => !(await A.evaluate(() => !!__BL.S.pop)));
await pclick(PN, '[data-x="start-select"]');
await waitUntil(() => picking(A));
await pclick(PN, '[data-x="bar-cancel"]');
check('The Cancel (Esc) button in the sidebar cancels selecting too', await waitUntil(async () => !(await picking(A))));
await pclick(PN, '[data-act="pop-cancel"]');
await waitUntil(async () => !(await A.evaluate(() => !!__BL.S.pop)));
await pclick(PN, '[data-act="export"]');
check('Export Change Report opens its modal in the sidebar', await waitUntil(async () => { const m = await pq(PN, '.modal'); return !!m && m.hidden === false && m.w > 300; }), JSON.stringify([await real(A, '.modal'), await pq(PN, '.modal'), await A.evaluate(() => ({ pop: !!__BL.S.pop, on: __BL.toolsApi.A.on, items: (__BL.S.batch?.items || []).length }))]));
check('The modal fills the sidebar width, with the existing sheet inside', await (async () => { const m = await pq(PN, '.modal'); const s = await pq(PN, '.modal .sheet'); return Math.abs(m.w - 380) < 2 && s.w > 340 && s.w <= 380; })());
await pclick(PN, '[data-act="copy"]');
check('Copy Report is written to the clipboard by the sidebar (the page is not focused)', await waitUntil(() => PN.evaluate(() => window.__clip.length > 0 && /Make title bigger/.test(window.__clip.at(-1)))));
await PN.keyboard.press('Escape');
check('Escape closes the export modal from the sidebar', await waitUntil(async () => (await pq(PN, '.modal')).hidden === true));
check('Page-side shortcut Alt+P works from the sidebar', await (async () => { await PN.keyboard.down('Alt'); await PN.keyboard.press('p'); await PN.keyboard.up('Alt'); return waitUntil(() => picking(A)); })());
await PN.keyboard.press('Escape');
await waitUntil(async () => !(await picking(A)));
await closeNote(PN, A);

console.log('\n# Sidebar: Start Fresh keeps its confirmation safeguards');
const startFresh = await A.evaluate(() => [...__BL.S.ui.root.querySelectorAll('[data-x]')].map((e) => e.dataset.x).filter((x) => /fresh|reset|restore/i.test(x)));
console.log(`  (Start Fresh controls found: ${startFresh.join(', ') || 'none'})`);
if (startFresh.length) {
  const trigger = startFresh.find((x) => /^(fresh|start-fresh|sf-open)$/.test(x)) || startFresh[0];
  const before = await store(A);
  await pclick(PN, `[data-x="${trigger}"]`);
  check('Start Fresh opens its confirmation in the sidebar and changes nothing yet', await waitUntil(async () => !!(await pq(PN, '.sf-modal'))) && (await store(A)) === before);
  await PN.keyboard.press('Escape');
  check('Escape cancels the Start Fresh confirmation in the sidebar and nothing was changed', await waitUntil(async () => !(await pq(PN, '.sf-modal'))) && (await store(A)) === before);
}

console.log('\n# Sidebar: no duplicate UI or listeners after repeated docking');
await pclick(PN, '[data-act="sb-undock"]');
await waitUntil(async () => (await mode(A)) === 'floating');
await closePanel(PN);
const snap = () => A.evaluate(() => ({ hosts: document.querySelectorAll('blueline-ui').length, panels: __BL.S.ui.root.querySelectorAll('.panel').length, onConnect: window.__onConnect.length, wl: JSON.stringify(window.__wl), dbg: __BL.sidebar.debug(), ports: window.__bus.open() }));
PN = await dockViaButton(A); await pclick(PN, '[data-act="sb-undock"]'); await waitUntil(async () => (await mode(A)) === 'floating'); await closePanel(PN);
const first = await snap();
for (let i = 0; i < 4; i++) { PN = await dockViaButton(A); await pclick(PN, '[data-act="sb-undock"]'); await waitUntil(async () => (await mode(A)) === 'floating'); await closePanel(PN); }
const after = await snap();
check('Exactly one Blueline host and one panel after repeated docking', after.hosts === 1 && after.panels === 1);
check('One chrome.runtime.onConnect listener, no matter how often the sidebar was used', after.onConnect === 1);
check('No window listeners accumulate (net add/remove counts identical after 4 more cycles)', after.wl === first.wl, `${first.wl} vs ${after.wl}`);
check('Floating again: no observer, poll, timer, mirrored nodes or open port left behind', !after.dbg.observer && !after.dbg.poll && !after.dbg.timer && after.dbg.known === 0 && !after.dbg.patched && after.ports === 0, JSON.stringify(after.dbg));
check('Focus and clipboard hooks are removed when floating', await A.evaluate(() => HTMLElement.prototype.focus.toString().includes('[native code]') && Clipboard.prototype.writeText.toString().includes('[native code]')));
PN = await dockViaButton(A);
check('A reopened panel has exactly one mirror host and one copy of the panel', await PN.evaluate(() => document.querySelectorAll('#bl-host').length === 1 && document.getElementById('bl-host').shadowRoot.querySelectorAll('.panel').length === 1));

console.log('\n# Sidebar: closing and reopening the sidebar');
await A.evaluate(() => __BL.openPop(document.querySelector('#c2 .nm')));
await waitUntil(async () => (await pq(PN, '.pop-note'))?.w > 100);
await pclick(PN, '.pop-note');
await ptype(PN, 'draft b');
await waitUntil(async () => (await real(A, '.pop-note')).val === 'draft b');
await setVisible(A, true);
await closePanel(PN); // the user closes Chrome's side panel
const undocksBefore = await sent(A, 'blueline:sb-undock');
check('Closing the sidebar on a phone-sized page (390px) shows a small launcher, not the floating panel', await waitUntil(async () => (await mode(A)) === 'launcher', { timeout: 6000 }));
const lr = await launcherRect(A);
check('The launcher is small and in a corner; the big panel stays hidden; nothing else covers the page', !!lr && lr.h <= 40 && lr.w <= 150 && lr.vis === 'visible' && (await real(A, '.panel')).vis === 'hidden' && await A.evaluate(() => [[195, 420], [30, 800], [195, 40]].every(([x, y]) => { const e = document.elementFromPoint(x, y); return e && e.localName !== 'blueline-ui'; })));
check('Blueline tells the background it is in launcher mode (not an explicit return to floating)', (await sent(A, 'blueline:sb-launcher')) >= 1 && (await sent(A, 'blueline:sb-undock')) === undocksBefore);
check('The draft typed in the sidebar is preserved while only the launcher shows', (await real(A, '.pop-note')).val === 'draft b' && !!(await A.evaluate(() => __BL.S.pop)));
await sleep(3500);
check('No reconnect loop or flip-flop: it stays in launcher mode, with one launcher, no ports and no mirror', await A.evaluate(() => __BL.sidebar.mode() === 'launcher' && __BL.S.ui.root.querySelectorAll('.sb-launch').length === 1 && window.__bus.open() === 0 && !__BL.sidebar.debug().observer));
await A.mouse.click(lr.x, lr.y);
PN = await openPanel(A.tabId); // Chrome opens the panel in answer to the launcher click
check('Clicking the launcher asks for the sidebar again (a user click) and docks with the same draft', await waitUntil(async () => (await mode(A)) === 'sidebar') && await waitUntil(async () => (await pq(PN, '.pop-note'))?.val === 'draft b'));
check('The launcher is gone while docked, and the reopened mirror matches the real panel', (await launcherRect(A)) === null && await inSync(A, PN));

console.log('\n# Sidebar: switching to another tab and back (the tab is hidden while its panel is away)');
await pclick(PN, '[data-x="start-select"]').catch(() => {});
await closeNote(PN, A);
await setVisible(A, false);
await closePanel(PN); // Chrome hides/unloads this tab's panel while another tab is in front
await sleep(3500); // longer than the grace period used for a visible tab
check('A hidden tab whose panel went away stays docked (waiting), it does not give up and reopen floating', (await mode(A)) === 'pending' && (await real(A, '.panel')).vis === 'hidden');
await setVisible(A, true);
PN = await openPanel(A.tabId); // Chrome shows the tab's panel again when the tab comes back
check('When the tab comes back its panel reconnects and Blueline is docked again with the same state', await waitUntil(async () => (await mode(A)) === 'sidebar') && await waitUntil(async () => !!(await pq(PN, '.panel'))) && await inSync(A, PN));
await setVisible(A, false);
await closePanel(PN);
await setVisible(A, true);
check('If the panel does not come back after the tab returns (phone-sized), the launcher shows, not the floating panel', await waitUntil(async () => (await mode(A)) === 'launcher', { timeout: 10000 }) && (await real(A, '.panel')).vis === 'hidden');
await A.evaluate(() => { window.__dockAnswer = { ok: false, error: 'nope' }; });
const lr2 = await launcherRect(A);
await A.mouse.click(lr2.x, lr2.y);
check('If Chrome refuses to open the panel from the launcher, the launcher stays (no floating panel)', await waitUntil(async () => (await mode(A)) === 'launcher') && !!(await launcherRect(A)));
await A.evaluate(() => { window.__dockAnswer = null; __BL.sidebar.undock(); });
check('Return to floating panel is explicit and always restores the floating panel, even at 390px', await waitUntil(async () => (await mode(A)) === 'floating') && (await real(A, '.panel')).vis === 'visible' && (await launcherRect(A)) === null && (await real(A, '.pop-note')).val === 'draft b');

console.log('\n# Sidebar: sidebar that never opens (or is refused) does not strand the floating panel');
await A.evaluate(() => { window.__dockAnswer = { ok: false, error: 'nope' }; });
const rb = await A.evaluate(() => { const r = __BL.S.ui.root.querySelector('[data-act="sb-dock"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
await A.mouse.click(rb.x, rb.y);
check('If Chrome refuses to open the side panel, Blueline stays floating and says so', await waitUntil(async () => (await mode(A)) === 'floating') && (await real(A, '.panel')).vis === 'visible' && /sidebar/i.test((await real(A, '.toast')).text));
await A.evaluate(() => { window.__dockAnswer = null; });
await A.mouse.click(rb.x, rb.y); // accepted, but no panel ever connects
check('If the panel never connects, Blueline gives up waiting (launcher on a phone-sized page)', await waitUntil(async () => (await mode(A)) === 'pending', { timeout: 1000 }) && await waitUntil(async () => (await mode(A)) === 'launcher', { timeout: 9000 }));

console.log('\n# Sidebar: page navigation and reconnection');
const noteSeed = await store(A);
PN = await dockViaButton(A);
// The tab navigates (a new document with the extension scripts again); the background says this tab is docked.
await reloadTab(A, { sbState: { supported: true, docked: true }, seed: JSON.parse(noteSeed) });
check('The old connection is dropped by the navigation; the sidebar says it is waiting/reconnecting', await waitUntil(async () => /Reconnecting|Waiting|Connecting/.test(await msgText(PN)) || (await mode(A)) === 'sidebar', { timeout: 5000 }));
check('After navigation the new page starts docked (no floating panel flashes back) and the panel reconnects by itself', await waitUntil(async () => (await mode(A)) === 'sidebar', { timeout: 8000 }));
check('The reconnected sidebar shows the stored note list again (state comes from storage, not the panel)', await waitUntil(async () => /Make title bigger/.test((await pq(PN, '.list'))?.text || '')));
check('The reconnected mirror matches the real panel, with one host and one panel', await inSync(A, PN) && await PN.evaluate(() => document.querySelectorAll('#bl-host').length === 1 && document.getElementById('bl-host').shadowRoot.querySelectorAll('.panel').length === 1));
check('After navigation a note can still be picked and saved from the sidebar', await (async () => {
  await pclick(PN, '[data-x="start-select"]'); await waitUntil(() => picking(A));
  const p = await rect(A, '#c3 .nm'); await A.mouse.click(p.x, p.y);
  await waitUntil(async () => (await pq(PN, '.pop-note'))?.w > 100);
  await pclick(PN, '.pop-note'); await ptype(PN, 'after nav'); await pclick(PN, '[data-act="pop-save"]');
  return waitUntil(async () => (await notes(A)).includes('after nav'));
})());

console.log('\n# Sidebar: turning Blueline off while docked');
await A.evaluate(() => window.__onMsg.forEach((f) => f({ type: 'blueline:set-active', on: false })));
check('Turning Blueline off tells the sidebar, and leaves no docked state', await waitUntil(async () => /Blueline is off/.test(await msgText(PN))) && await A.evaluate(() => !__BL.S.active && !document.querySelector('blueline-ui')));
check('Background is told to release the side panel', (await sent(A, 'blueline:sb-undock')) >= 1);
await closePanel(PN);
relay.forget(A); await A.close();

console.log('\n# Sidebar: correct tab targeting and no cross-tab leakage');
const T1 = await openTab(11, { fixture: 'sidebar.html' });
const T2 = await openTab(12, { fixture: 'sidebar.html' });
await T2.evaluate(() => __BL.addItem({ id: 'n2', note: 'Tab two secret note', type: 'polish', createdAt: Date.now(), ...__BL.describe(document.querySelector('#c4 .nm'), 'change') }));
await T1.evaluate(() => __BL.addItem({ id: 'n1', note: 'Tab one note', type: 'polish', createdAt: Date.now(), ...__BL.describe(document.querySelector('#c1 .nm'), 'change') }));
const P1 = await dockViaButton(T1);
check('The panel for tab 1 shows tab 1 notes only', await waitUntil(async () => /Tab one note/.test((await pq(P1, '.list'))?.text || ''), { timeout: 6000 }) && !(await P1.evaluate(() => document.body.innerHTML + document.getElementById('bl-host').shadowRoot.innerHTML)).includes('Tab two secret note'));
check('Tab 2 stays floating and is never connected to the panel', (await mode(T2)) === 'floating' && (await T2.evaluate(() => window.__bus.open())) === 0);
await closeNote(P1, T1);
await pclick(P1, '[data-x="start-select"]');
check('A click in tab 1’s sidebar only changes tab 1', await waitUntil(() => picking(T1)) && (await picking(T2)) === false);
await P1.keyboard.press('Escape');
await T2.evaluate(() => __BL.openPop(document.querySelector('#c2 .nm')));
await sleep(300);
check('Changes made in tab 2 never appear in tab 1’s sidebar', !(await P1.evaluate(() => document.getElementById('bl-host').shadowRoot.innerHTML)).includes('Tab two secret note') && (await T2.evaluate(() => !!__BL.S.pop)));
const P2 = await dockViaButton(T2);
check('Docking tab 2 opens a second panel bound to tab 2', await waitUntil(async () => /Tab two secret note/.test((await pq(P2, '.list'))?.text || '')) && (await mode(T1)) === 'sidebar');
check('Each panel has its own port to its own tab', (await T1.evaluate(() => window.__bus.open())) === 1 && (await T2.evaluate(() => window.__bus.open())) === 1);
await pclick(P2, '[data-act="sb-undock"]');
await waitUntil(async () => (await mode(T2)) === 'floating');
check('Returning tab 2 to floating does not affect tab 1’s docked state', (await mode(T1)) === 'sidebar' && await inSync(T1, P1));
await closePanel(P2); await closePanel(P1);
relay.forget(T1); relay.forget(T2); await T1.close(); await T2.close();

console.log('\n# Sidebar: closing the side panel on a normal desktop viewport, and the launcher across tab lifecycle');
{
  const D = await openTab(31, { viewport: { width: 1280, height: 900 } });
  await D.evaluate(() => __BL.openPop(document.querySelector('#c1 .nm')));
  await sleep(300);
  const DP = await dockViaButton(D);
  await pclick(DP, '.pop-note'); await ptype(DP, 'desktop draft');
  await waitUntil(async () => (await real(D, '.pop-note')).val === 'desktop draft');
  const dStore = await store(D);
  await setVisible(D, true);
  await closePanel(DP);
  check('Closing the side panel on a desktop-sized page keeps the existing floating fallback', await waitUntil(async () => (await mode(D)) === 'floating', { timeout: 6000 }) && (await real(D, '.panel')).vis === 'visible' && (await launcherRect(D)) === null);
  check('Desktop closure keeps the draft and writes nothing, and tells the background to release the panel', (await real(D, '.pop-note')).val === 'desktop draft' && (await store(D)) === dStore && (await sent(D, 'blueline:sb-undock')) >= 1);
  relay.forget(D); await D.close();

  // phone-sized: launcher survives a navigation, and is removed when Blueline is turned off
  const M = await openTab(32, { viewport: { width: 393, height: 852 } });
  await M.evaluate(() => __BL.addItem({ id: 'm1', note: 'Launcher note', type: 'polish', createdAt: Date.now(), ...__BL.describe(document.querySelector('#c1 .nm'), 'change') }));
  const MP = await dockViaButton(M);
  await setVisible(M, true);
  await closePanel(MP);
  await waitUntil(async () => (await mode(M)) === 'launcher', { timeout: 6000 });
  const mSeed = await store(M);
  await reloadTab(M, { sbState: { supported: true, docked: false, launcher: true }, seed: JSON.parse(mSeed) });
  await M.evaluate(() => { window.__vis = 'visible'; });
  check('After a navigation the tab is still in launcher mode (no large floating panel flashes back)', await waitUntil(async () => (await mode(M)) === 'launcher') && (await real(M, '.panel')).vis === 'hidden' && !!(await launcherRect(M)));
  const ml = await launcherRect(M);
  await M.mouse.click(ml.x, ml.y);
  const MP2 = await openPanel(32);
  check('The launcher on the new page reopens the sidebar with the stored notes', await waitUntil(async () => (await mode(M)) === 'sidebar') && await waitUntil(async () => /Launcher note/.test((await pq(MP2, '.list'))?.text || '')));
  await closePanel(MP2);
  await waitUntil(async () => (await mode(M)) === 'launcher', { timeout: 6000 });
  await M.evaluate(() => window.__onMsg.forEach((f) => f({ type: 'blueline:set-active', on: false })));
  check('Turning Blueline off from launcher mode removes the launcher and all sidebar state', await waitUntil(async () => !(await M.evaluate(() => !!document.querySelector('blueline-ui')))) && (await sent(M, 'blueline:sb-undock')) >= 1);
  relay.forget(M); await M.close();
}

console.log('\n# Sidebar: immediate close notice (sidePanel.onClosed / onOpened), with the older-Chrome fallback');
{
  const C = await openTab(41, { viewport: { width: 393, height: 852 } });
  await C.evaluate(() => __BL.openPop(document.querySelector('#c1 .nm'))); await sleep(300);
  const CP = await dockViaButton(C);
  await pclick(CP, '.pop-note'); await ptype(CP, 'close draft');
  await waitUntil(async () => (await real(C, '.pop-note')).val === 'close draft');
  await setVisible(C, true);
  const t0 = Date.now();
  await C.evaluate(() => window.__onMsg.forEach((f) => f({ type: 'blueline:sb-closed' }))); // the background forwards sidePanel.onClosed
  check('onClosed: the launcher appears promptly (well before the 2.5s fallback), with the panel still connected', await waitUntil(async () => (await mode(C)) === 'launcher', { timeout: 1500, step: 20 }) && Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
  check('Prompt closure: one launcher, floating panel hidden, draft preserved, no ports left', await C.evaluate(() => __BL.sidebar.debug().launchers === 1 && getComputedStyle(__BL.S.ui.root.querySelector('.panel')).visibility === 'hidden' && __BL.S.ui.root.querySelector('.pop-note').value === 'close draft' && window.__bus.open() === 0));
  await closePanel(CP);
  await sleep(3200);
  check('The later connection drop does not flip or duplicate anything (still one launcher, no reconnect loop)', await C.evaluate(() => __BL.sidebar.mode() === 'launcher' && __BL.sidebar.debug().launchers === 1 && window.__bus.open() === 0));
  const lr = await launcherRect(C); await C.mouse.click(lr.x, lr.y);
  const CP2 = await openPanel(41);
  await waitUntil(async () => (await mode(C)) === 'sidebar');
  await C.evaluate(() => { window.__onMsg.forEach((f) => f({ type: 'blueline:sb-closed' })); window.__onMsg.forEach((f) => f({ type: 'blueline:sb-opened' })); });
  await sleep(900);
  check('onClosed followed by onOpened (reconnect or tab switch) does not show the launcher', (await mode(C)) === 'sidebar' && (await C.evaluate(() => __BL.sidebar.debug().launchers)) === 0);
  await setVisible(C, false);
  await C.evaluate(() => window.__onMsg.forEach((f) => f({ type: 'blueline:sb-closed' })));
  await sleep(900);
  check('onClosed for a tab that is not in front is ignored (no launcher flicker while switching tabs)', (await mode(C)) === 'sidebar');
  await setVisible(C, true);
  await C.setViewport({ width: 1280, height: 900 });
  await C.evaluate(() => window.__onMsg.forEach((f) => f({ type: 'blueline:sb-closed' })));
  check('onClosed on a desktop-sized page restores the floating panel as before', await waitUntil(async () => (await mode(C)) === 'floating', { timeout: 1500 }) && (await real(C, '.panel')).vis === 'visible');
  await closePanel(CP2);
  relay.forget(C); await C.close();
}

console.log('\n# Sidebar: phone-sized floating panel collapses to a "Dock to sidebar" launcher (once, by choice)');
{
  const V = await openTab(51, { viewport: { width: 1280, height: 900 }, keepFloat: false });
  await V.evaluate(() => __BL.openPop(document.querySelector('#c1 .nm'))); await sleep(300);
  await V.evaluate(() => { const t = __BL.S.ui.root.querySelector('.pop-note'); t.value = 'compact draft'; t.dispatchEvent(new Event('input', { bubbles: true })); });
  check('A desktop-sized page keeps the floating panel (no automatic collapse)', (await mode(V)) === 'floating' && (await real(V, '.panel')).vis === 'visible');
  await V.setViewport({ width: 393, height: 852 });
  check('Entering a phone-sized viewport collapses the large panel to the launcher', await waitUntil(async () => (await mode(V)) === 'launcher', { timeout: 3000 }) && (await real(V, '.panel')).vis === 'hidden');
  const lb = await V.evaluate(() => { const r = __BL.S.ui.root.querySelector('.sb-launch'); const b = r.getBoundingClientRect(); return { w: b.width, h: b.height, dock: r.querySelector('.sb-launch-dock').textContent.trim(), exp: r.querySelector('.sb-launch-float').textContent.trim(), right: innerWidth - b.right, bottom: innerHeight - b.bottom }; });
  check('The launcher is compact, labelled "Dock to sidebar", with an "Expand" secondary option', lb.dock === 'Dock to sidebar' && lb.exp === 'Expand' && lb.h <= 44 && lb.w <= 250 && lb.right >= 8 && lb.bottom >= 8, JSON.stringify(lb));
  check('Collapsing never opens the side panel by itself (no dock request) and keeps the draft, note editor and state', (await sent(V, 'blueline:sb-dock')) === 0 && (await V.evaluate(() => __BL.S.ui.root.querySelector('.pop-note').value === 'compact draft' && !!__BL.S.pop)));
  for (const w of [1280, 393, 900, 393, 320]) { await V.setViewport({ width: w, height: 852 }); await sleep(450); }
  check('Resizing across the threshold repeatedly neither re-collapses nor expands it: one collapse, one launcher', await V.evaluate(() => __BL.sidebar.debug().compacts === 1 && __BL.sidebar.debug().launchers === 1 && __BL.sidebar.mode() === 'launcher'));
  const el = await V.evaluate(() => { const b = __BL.S.ui.root.querySelector('.sb-launch-float').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await V.mouse.click(el.x, el.y);
  check('Expand returns to the floating panel, with the draft and note editor intact', await waitUntil(async () => (await mode(V)) === 'floating') && (await real(V, '.panel')).vis === 'visible' && (await V.evaluate(() => __BL.S.ui.root.querySelector('.pop-note').value === 'compact draft' && !!__BL.S.pop && !__BL.S.ui.root.querySelector('.sb-launch'))));
  for (const w of [1280, 393, 360]) { await V.setViewport({ width: w, height: 852 }); await sleep(450); }
  check('After choosing floating, narrow viewports do not collapse it again (explicit choice respected)', (await mode(V)) === 'floating' && (await V.evaluate(() => __BL.sidebar.debug().compacts)) === 1);
  await reloadTab(V, { keepFloat: undefined });
  await sleep(700);
  check('The choice also holds after a navigation in the same tab', (await mode(V)) === 'floating');
  relay.forget(V); await V.close();

  const W = await openTab(52, { viewport: { width: 393, height: 852 }, keepFloat: false });
  check('A phone-sized page collapses on arrival (no large panel left over the site)', await waitUntil(async () => (await mode(W)) === 'launcher', { timeout: 3000 }));
  const WP = await dockViaButton(W);
  check('"Dock to sidebar" from the compact launcher docks (the click is the user gesture)', (await sent(W, 'blueline:sb-dock')) === 1 && (await mode(W)) === 'sidebar' && !!(await pq(WP, '.panel')));
  await closePanel(WP);
  await waitUntil(async () => (await mode(W)) === 'launcher', { timeout: 6000 });
  await W.evaluate(() => window.__onMsg.forEach((f) => f({ type: 'blueline:set-active', on: false })));
  check('Toolbar off from the compact launcher removes Blueline and the launcher', await waitUntil(async () => !(await W.evaluate(() => !!document.querySelector('blueline-ui')))));
  relay.forget(W); await W.close();
}

console.log('\n# Sidebar: header spacing and hit areas');
{
  const H = await openTab(61, { viewport: { width: 330, height: 700 } });
  const headerOf = (P, useReal) => P.evaluate((useReal) => {
    const r = useReal ? __BL.S.ui.root : document.getElementById('bl-host').shadowRoot;
    const bar = r.querySelector('.bar'); const panel = r.querySelector('.panel').getBoundingClientRect();
    const btns = [...bar.querySelectorAll('.tools button')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => { const q = b.getBoundingClientRect(); return { act: b.dataset.act, l: q.left, r: q.right, w: q.width, h: q.height }; });
    const brand = bar.querySelector('.brand').getBoundingClientRect();
    const c = bar.querySelector('.count'); const cr = c.getBoundingClientRect(); const mk = bar.querySelector('.mark').getBoundingClientRect();
    const title = [...bar.querySelector('.brand').childNodes].find((n) => n.nodeType === 3 && n.data.includes('Blueline'));
    const count = { text: c.textContent, w: cr.width, h: cr.height, inside: cr.left >= brand.left - 0.5 && cr.right <= brand.right + 0.5, clipped: c.scrollWidth > c.clientWidth + 1, markW: mk.width };
    return { btns, brandRight: brand.right, edge: panel.right - Math.max(...btns.map((b) => b.r)), overflow: bar.scrollWidth > bar.clientWidth + 1, count, brandClipped: bar.querySelector('.brand').scrollWidth > bar.querySelector('.brand').clientWidth + 1 };
  }, useReal);
  const countOk = (h, text) => h.count.text === text && h.count.w >= 18 && h.count.h >= 18 && h.count.inside && !h.count.clipped && h.count.markW >= 14 && !h.brandClipped;
  const ok = (h) => h.btns.length >= 2 && h.btns.every((b) => b.w >= 28 && b.h >= 28) && h.btns.every((b, i) => i === 0 || b.l - h.btns[i - 1].r >= 2) && h.edge >= 8 && !h.overflow && h.brandRight <= h.btns[0].l + 1;
  const addNotes = (n) => H.evaluate(async (n) => { for (let i = 0; i < n; i++) await __BL.addItem({ id: 'h' + Math.random(), note: 'n' + i, type: 'polish', createdAt: Date.now(), ...__BL.describe(document.querySelector('#c1 .nm'), 'change') }); }, n);
  await addNotes(1);
  await waitUntil(async () => (await H.evaluate(() => __BL.S.ui.root.querySelector('.count').textContent)) === '1');
  const hf = await headerOf(H, true);
  check('The annotation-count badge is fully visible in the floating header (1 note, 330px), beside the whole title and mode label', countOk(hf, '1'), JSON.stringify(hf.count));
  check('Floating header (330px): Dock, minimise, side and close are separated, at least 28px, 8px+ from the edge, nothing clipped', ok(hf) && hf.btns.some((b) => b.act === 'sb-dock'), JSON.stringify(hf));
  await addNotes(11);
  await waitUntil(async () => (await H.evaluate(() => __BL.S.ui.root.querySelector('.count').textContent)) === '12');
  const hf12 = await headerOf(H, true);
  check('A two-digit count (12) is also fully visible and the controls still fit with spacing', countOk(hf12, '12') && ok(hf12), JSON.stringify(hf12));
  const dockBtn = await H.evaluate(() => { const b = __BL.S.ui.root.querySelector('[data-act="sb-dock"]'); return { text: b.textContent.trim(), w: b.getBoundingClientRect().width, clipped: b.scrollWidth > b.clientWidth + 1, fs: parseFloat(getComputedStyle(b).fontSize) }; });
  check('The Dock button reads "Dock" in full at a readable size', dockBtn.text === 'Dock' && dockBtn.w >= 40 && !dockBtn.clipped && dockBtn.fs >= 12, JSON.stringify(dockBtn));
  for (const w of [380, 320, 300]) {
    const HP = await dockViaButton(H);
    await HP.setViewport({ width: w, height: 700 });
    await sleep(500);
    const hs = await headerOf(HP, false);
    check(`Docked header at ${w}px: controls separated, at least 28px, 8px+ from the edge, nothing clipped or overlapping`, hs.btns.length >= 1 && hs.btns.every((b) => b.w >= 28 && b.h >= 28) && hs.btns.every((b, i) => i === 0 || b.l - hs.btns[i - 1].r >= 1.5) && hs.edge >= 8 && !hs.overflow && hs.brandRight <= hs.btns[0].l + 1, JSON.stringify(hs));
    check(`Docked header at ${w}px: the two-digit count badge is fully visible (the optional mode label gives way first)`, countOk(hs, '12'), JSON.stringify(hs.count));
    await pclick(HP, '[data-act="sb-undock"]');
    await waitUntil(async () => (await mode(H)) === 'floating');
    await closePanel(HP);
  }
  relay.forget(H); await H.close();
}

console.log('\n# Sidebar: files, product library and Assign Products (card-groups fixture, 1280px)');
{
  const origin = `http://127.0.0.1:${PORT}`;
  const CSV = 'Section,SKU,Product Name,Original Price,Sale Price\nFeatured,ACM400101,Acme ZMA Capsules,$27.97,$19.99\nFeatured,ACM999001,Acme Fish Oil Softgels,$30.97,\nFeatured,ACM200101,Acme Charcoal,$15.99,\nFeatured,ACM100101,Acme Black Seed Oil,$20.99,$15.99';
  const vOf = (handle) => LibNode.normalizeProduct(PRODUCTS.find((p) => p.handle === handle), origin, 'USD').variants[0];
  let lib = { store: origin, campaign: 'l-sb', name: 'Sidebar list', smp: { v: 1, imports: [LibNode.importCsv(CSV, { fileName: 'sb.csv', sha256: 'sb1' })] }, work: LibNode.emptyWork() };
  for (const [k, h] of [['sku:ACM400101', 'zma'], ['sku:ACM999001', 'fish-oil'], ['sku:ACM200101', 'charcoal'], ['sku:ACM100101', 'black-seed-oil']]) lib = LibNode.decide(LibNode.chooseVariant(lib, k, vOf(h)), k, 'smp');
  const G = await openTab(21, { fixture: 'card-groups.html' });
  await G.evaluate((l) => BluelineLibrary.saveLibrary(chrome.storage.local, l, { smpChanged: true }), lib);
  await G.evaluate(async () => {
    const el = document.querySelector('#row-feat > article:nth-child(2)');
    await __BL.addItem({ id: 'rec-1', cardRecord: true, note: '', createdAt: Date.now(), ...__BL.describe(el, 'change'), productCard: BluelineCards.describe(el) });
  });
  const rootStyle = () => G.evaluate(() => document.documentElement.getAttribute('style'));
  const bodyW = () => G.evaluate(() => Math.round(document.body.getBoundingClientRect().width));
  const W0 = await bodyW();
  const GP = await dockViaButton(G);
  await G.evaluate(() => { __BL.libraryUi.open({ existing: true }); });
  check('Product Library opens in the sidebar, filling the panel', await waitUntil(async () => { const m = await pq(GP, '[data-m="library"]'); return !!m && m.hidden === false && m.w > 300 && m.w <= 380; }));
  check('The library modal on the page is hidden, and the page layout is untouched', (await G.evaluate(() => getComputedStyle(__BL.S.ui.root.querySelector('[data-m="library"]')).visibility)) === 'hidden' && (await rootStyle()) === null && (await bodyW()) === W0);
  check('The mirrored library matches the real one', await inSync(G, GP));
  // Upload File through the sidebar's native file picker path: bytes travel to the real input
  const gotFile = G.evaluate(() => new Promise((res) => { const i = __BL.S.ui.root.querySelector('[data-lib="file"]'); i.addEventListener('change', () => res({ name: i.files[0].name, size: i.files[0].size, text: null }), { once: true }); setTimeout(() => res(null), 4000); }));
  await GP.evaluate(() => {
    const i = document.getElementById('bl-host').shadowRoot.querySelector('[data-lib="file"]');
    const dt = new DataTransfer(); dt.items.add(new File(['SKU,Name\nA1,Alpha\n'], 'pick.csv', { type: 'text/csv' }));
    i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const fr = await gotFile;
  check('A file chosen in the sidebar reaches the page’s real file input with its name and bytes', !!fr && fr.name === 'pick.csv' && fr.size === 18, JSON.stringify(fr));
  await G.keyboard?.press?.('Escape').catch(() => {});
  await G.evaluate(() => { __BL.libraryUi.close(); });
  await sleep(200);

  await G.evaluate(() => { __BL.libraryUi.assignStart(); });
  check('Assign Products opens in the sidebar, titled Assign Products', await waitUntil(async () => /Assign Products/.test((await pq(GP, '.lib-head'))?.text || '') && (await G.evaluate(() => !!__BL.libraryUi.L.bulk)), { timeout: 10000 }));
  const rows = (P) => P.evaluate(() => { const r = (document.getElementById('bl-host')?.shadowRoot) || __BL.S.ui.root; return { cards: r.querySelectorAll('.lib-bk').length, products: r.querySelectorAll('.lib-sel-row').length, text: [...r.querySelectorAll('.lib-bk .lib-bk-t b')].map((b) => b.textContent).join('|') }; });
  await waitUntil(async () => (await rows(G)).cards > 0 && JSON.stringify(await rows(G)) === JSON.stringify(await rows(GP)), { timeout: 8000 });
  const rr = await rows(G); const rp = await rows(GP);
  check('The sidebar lists the existing page cards and the Library products, identical to the real workspace', rr.cards >= 1 && rr.products === 4 && JSON.stringify(rr) === JSON.stringify(rp), JSON.stringify([rr, rp]));
  check('Assign Products does not reserve or shrink the page while docked (no padding on the root, same body width)', (await rootStyle()) === null && (await bodyW()) === W0, `${await rootStyle()} ${await bodyW()} vs ${W0}`);
  check('The workspace is laid out as a full-panel sheet', await (async () => { const s = await pq(GP, '.lib-sheet'); return !!s && s.w > 300 && s.w <= 380 && s.h > 400; })());
  check('Page card markers stay on the page', (await G.evaluate(() => __BL.S.ui.root.querySelectorAll('.x-pmbox .pmb').length)) >= 1);
  // select a product for the first card from the sidebar with a real click
  const sel = await pq(GP, '.lib-sel-row');
  if (sel) { await pclick(GP, '.lib-sel-row'); await sleep(300); }
  check('Clicking a product in the sidebar runs the real selection handler (page state updates)', await G.evaluate(() => __BL.libraryUi.L.bulk?.sel !== undefined) && await inSync(G, GP));
  // undock while the workspace is open (the workspace covers the panel, so the Return control is reached after closing it;
  // this calls the same function that button calls): it must return to the floating layout with its staged work
  const stagedBefore = await G.evaluate(() => JSON.stringify(Object.keys(__BL.libraryUi.L.bulk.drafts || {})));
  await G.evaluate(() => { __BL.sidebar.undock(); });
  const floated = await waitUntil(async () => (await mode(G)) === 'floating');
  check('Returning to floating with Assign Products open keeps the workspace and its staged work, and re-applies the floating dock', floated && (await G.evaluate(() => !!__BL.libraryUi.L.bulk)) && (await G.evaluate(() => JSON.stringify(Object.keys(__BL.libraryUi.L.bulk.drafts || {})))) === stagedBefore && (await G.evaluate(() => /lib-adock/.test(__BL.S.ui.root.querySelector('.lib-modal').className))), await G.evaluate(() => __BL.S.ui.root.querySelector('.lib-modal').className));
  check('Floating Assign Products reserves page space again, as before (that is its normal behaviour)', (await G.evaluate(() => document.documentElement.getAttribute('style'))) !== null);
  await closePanel(GP);
  relay.forget(G); await G.close();
}

relay.stop();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
