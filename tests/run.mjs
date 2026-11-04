// Blueline headless regression tests (Chrome over the DevTools protocol; no npm dependencies).
//
// Loads page-hook.js, content.js and tools.js into local fixture pages with a small chrome.* stub, then
// drives real mouse and keyboard input: Shift+hover, Shift+click, Select element, Shift+drag, Measure,
// drawing, Clear selection + Undo, modals. See tests/README.md.
//
// Usage: npm test                      (from tests/)
//        node run.mjs [extension-dir]  (defaults to the repository root)
import { launch } from './cdp.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zip, docXml, SMP_PARAS } from './docx-fixture.mjs';
import { shopRoute, requests as shopRequests, PRODUCTS } from './fake-store.mjs';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(process.argv[2] || join(here, '..'));
const LibNode = createRequire(import.meta.url)(join(ext, 'library.js'));
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('Chrome not found. Set CHROME_PATH to your Chrome or Chromium executable.'); process.exit(2); }

const src = (f) => readFileSync(join(ext, f), 'utf8');
const STUB = `window.chrome = {
  runtime: { id: 'blueline-test', getManifest: () => ({ version: 'test' }), sendMessage: async (m) => (m && m.type === 'blueline:hello' ? { active: true } : null), onMessage: { addListener() {} } },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {} } },
}; window.__BLUELINE_TEST__ = {};`;

// A stub closer to Chrome's: values persist as JSON copies and onChanged fires (asynchronously, also for the page
// that wrote them), so what happens after Save Note in a real extension can be tested.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`); };

const browser = await launch({ executablePath: CHROME, args: ['--window-size=1280,900'] });

// Fixtures that need a real origin (linked, imported and cross-origin stylesheets) are served over http. The page
// is opened on 127.0.0.1; the same server reached as localhost counts as another origin.
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript' };
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const shop = shopRoute(u.pathname, u.searchParams); // the fake public storefront used by the Product Library tests
  if (shop) { res.writeHead(shop.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(shop.body)); return; }
  const path = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  const file = resolve(join(here, 'fixtures', path));
  if (!file.startsWith(join(here, 'fixtures')) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

async function open(fixture, { http = false, realStorage = false, seed = null, host = '127.0.0.1' } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(http ? `http://${host}:${PORT}/${fixture}` : pathToFileURL(join(here, 'fixtures', fixture)).href);
  await page.addScriptTag({ content: STUB });
  if (realStorage) await page.addScriptTag({ content: REAL_STORAGE });
  if (seed) await page.evaluate((s) => chrome.storage.local.set(s), seed); // a later session: what an earlier one saved
  for (const f of ['page-hook.js', 'content.js', 'library.js', 'cards.js', 'tools.js', 'library-ui.js']) await page.addScriptTag({ content: src(f) });
  await page.waitForFunction(() => window.__BL?.S?.active && window.__BL.S.ui);
  await sleep(150);
  return page;
}

// ------------------------------------------------------------------ helpers (all take the page)
// Point inside an element: 'text' = centre of its text, 'center' = box centre, [fx, fy] = fraction of the
// box, {from, dx, dy} = offset from a box corner (tl, tr, bl, br). Scrolls the element into view first.
const pointFor = (page, sel, spec) => page.evaluate((sel, spec) => {
  const el = document.querySelector(sel);
  el.scrollIntoView({ block: 'center' });
  let r = el.getBoundingClientRect();
  if (spec === 'text') { const rg = document.createRange(); rg.selectNodeContents(el); r = rg.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  if (spec === 'center') return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  if (Array.isArray(spec)) return { x: r.left + r.width * spec[0], y: r.top + r.height * spec[1] };
  const x0 = spec.from.includes('r') ? r.right : r.left;
  const y0 = spec.from.includes('b') ? r.bottom : r.top;
  return { x: x0 + spec.dx, y: y0 + spec.dy };
}, sel, spec);
// Viewport rectangle around elements: kind 'text' uses the text bounds, 'box' the element box.
const rectAround = (page, ids, kind = 'text', pad = 8) => page.evaluate((ids, kind, pad) => {
  document.getElementById(ids[0]).scrollIntoView({ block: 'center' });
  const rs = ids.map((id) => { const e = document.getElementById(id); if (kind === 'box') return e.getBoundingClientRect(); const rg = document.createRange(); rg.selectNodeContents(e); return rg.getBoundingClientRect(); });
  return { l: Math.min(...rs.map((r) => r.left)) - pad, t: Math.min(...rs.map((r) => r.top)) - pad, r: Math.max(...rs.map((r) => r.right)) + pad, b: Math.max(...rs.map((r) => r.bottom)) + pad };
}, ids, kind, pad);
const hlRect = (page) => page.evaluate(() => { const h = __BL.S.ui.root.querySelector('.hl2'); if (!h || h.hidden) return null; const r = h.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, tag: h.querySelector('.hl-tag').textContent }; });
const rectOf = (page, id) => page.evaluate((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; }, id);
const same = (a, b) => !!a && !!b && ['l', 't', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) < 1.5);
const selectedIds = (page) => page.evaluate(() => (window.__BL.toolsApi.getP()?.els || []).map((e) => e.id || e.tagName));
const closeNote = (page) => page.evaluate(() => { if (__BL.S.pop) __BL.closePop(); });
const rawHit = (page, x, y) => page.evaluate((x, y) => { const e = document.elementFromPoint(x, y); return e ? e.id || e.tagName : null; }, x, y);
const nested = (page) => page.evaluate(() => { const els = window.__BL.toolsApi.getP()?.els || []; return els.some((a) => els.some((b) => a !== b && a.contains(b))); });
async function shiftClick(page, p) {
  await page.mouse.move(p.x - 30, p.y, { steps: 2 });
  await page.keyboard.down('Shift');
  await page.mouse.move(p.x, p.y, { steps: 3 });
  const hl = await hlRect(page);
  await page.mouse.down(); await page.mouse.up();
  await sleep(60);
  await page.keyboard.up('Shift');
  return hl;
}
async function shiftDrag(page, r) {
  await page.mouse.move(r.l, r.t);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(r.r, r.b, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await sleep(80);
}

// ------------------------------------------------------------------ 1. point selection
console.log('\n# Point selection: Shift+hover, Shift+click, Select element (fixtures/selection.html)');
{
  const page = await open('selection.html');
  const sectionsHTML = () => page.evaluate(() => [...document.querySelectorAll('header, section')].map((s) => s.outerHTML).join('\n'));
  const domBefore = await sectionsHTML();
  {
    const tip = await page.evaluate(() => { const row = __BL.S.ui.root.querySelector('.startrow'); const subs = [...(row?.querySelectorAll('.sub') || [])].map((s) => s.textContent.trim()); return { subs, buttons: row?.querySelectorAll('button').length, visible: !!row && row.getBoundingClientRect().height > 0 }; });
    check('Home screen shows the Shift tip as muted helper text, no new controls', tip.visible && tip.subs.includes('Tip: Shift+click to select an element. Shift+drag to select an area.') && tip.buttons === 2, JSON.stringify(tip));
  }
  // [name, selector, point spec, expected id]
  const CASES = [
    ['A  hero+cover link: disclaimer', '#a-disc', 'text', 'a-disc'],
    ['A  hero+cover link: headline', '#a-h', 'text', 'a-h'],
    ['A  hero+cover link: CTA button', '#a-cta', 'center', 'a-cta'],
    ['A  hero+cover link: empty area', '#a', [0.9, 0.5], 'a-img'],
    ['A2 pe:none text: disclaimer', '#a2-disc', 'text', 'a2-disc'],
    ['A2 pe:none text: headline', '#a2-h', 'text', 'a2-h'],
    ['A2 pe:none text: CTA (pe:auto)', '#a2-cta', 'center', 'a2-cta'],
    ['A2 pe:none text: empty area', '#a2', [0.9, 0.5], 'a2-img'],
    ['A3 ::after tint: disclaimer', '#a3-disc', 'text', 'a3-disc'],
    ['A3 ::after tint: headline', '#a3-h', 'text', 'a3-h'],
    ['A4 tint layer: disclaimer', '#a4-disc', 'text', 'a4-disc'],
    ['B  nested divs: paragraph', '#b-p', 'text', 'b-p'],
    ['B  nested divs: wrapper padding', '#b-w2', { from: 'tl', dx: 4, dy: 30 }, 'b-w2'],
    ['C  button: label text', '#c-label', 'text', 'c-label'],
    ['C  button: icon (svg, not path)', '#c-svg', 'center', 'c-svg'],
    ['C  button: padding', '#c-btn', { from: 'tl', dx: 4, dy: 19 }, 'c-btn'],
    ['D  card: image', '#d1-img', 'center', 'd1-img'],
    ['D  card: title', '#d1-a', 'text', 'd1-a'],
    ['D  card: price', '#d1-price', 'text', 'd1-price'],
    ['D  card: info padding', '#d1-info', { from: 'bl', dx: 60, dy: -4 }, 'd1-info'],
    ['H  other card: price', '#d3-price', 'text', 'd3-price'],
    ['H  other card: image', '#d2-img', 'center', 'd2-img'],
    ['E  row gap', '#e-row', [0.5, 0.5], 'e-row'],
    ['E  boxed section padding', '#e', { from: 'tl', dx: 10, dy: 10 }, 'e'],
    ['K  fade slideshow: visible slide text', '#k-t1', 'text', 'k-t1'],
    ['   plain link', '#i-link', 'text', 'i-link'],
    ['   sticky header: empty area', '#hdr', [0.6, 0.5], 'hdr'],
  ];
  for (const [name, sel, spec, want] of CASES) {
    const p = await pointFor(page, sel, spec);
    await sleep(30);
    const raw = await rawHit(page, p.x, p.y);
    const hl = await shiftClick(page, p);
    const got = await selectedIds(page);
    await closeNote(page);
    await sleep(30);
    check(`${name}: hover outline = #${want}`, same(hl, await rectOf(page, want)), `outline "${hl?.tag}" (browser hit: #${raw})`);
    check(`${name}: Shift+click selects #${want}`, got.length === 1 && got[0] === want, `selected [${got}] (browser hit: #${raw})`);
  }

  for (const [name, sel, spec, want] of CASES.filter((c) => /disclaimer|price|pe:none text: headline|nested divs: paragraph|icon/.test(c[0]))) {
    const p = await pointFor(page, sel, spec);
    await page.evaluate(() => __BL.toolsApi.startSelect(false));
    await sleep(30);
    await page.mouse.move(p.x, p.y, { steps: 3 });
    const hl = await hlRect(page);
    await page.mouse.down(); await page.mouse.up();
    await sleep(60);
    const ids = await selectedIds(page);
    await closeNote(page);
    check(`Select element: ${name}`, ids[0] === want && same(hl, await rectOf(page, want)), `selected [${ids}]`);
  }

  {
    const r = await page.evaluate(() => { const r = document.getElementById('d').getBoundingClientRect(); return { l: r.left + 8, t: r.top + 8, r: r.left + 760, b: r.bottom - 8 }; });
    await shiftDrag(page, r);
    const ids = await selectedIds(page);
    check('Shift+drag over a card grid selects the three cards', ids.join() === 'd1,d2,d3', `selected [${ids}]`);
    await closeNote(page);
  }

  {
    await shiftClick(page, await pointFor(page, '#d1-price', 'text'));
    await shiftClick(page, await pointFor(page, '#a-disc', 'text'));
    const two = await selectedIds(page);
    check('Shift+click in two different containers selects both', two.join() === 'd1-price,a-disc', `[${two}]`);
    await page.evaluate(() => __BL.S.ui.root.querySelector('[data-x="sel-clear"]').click());
    await sleep(60);
    const none = await selectedIds(page);
    await page.mouse.move(5, 400);
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(mod); await page.keyboard.press('z'); await page.keyboard.up(mod);
    await sleep(80);
    const back = await selectedIds(page);
    check('Clear selection empties it, Undo restores it', none.length === 0 && back.join() === 'd1-price,a-disc', `after clear [${none}], after undo [${back}]`);
    await closeNote(page);
  }

  {
    const p = await pointFor(page, '#g-p', 'text');
    await page.keyboard.down('Shift');
    await page.mouse.move(p.x, p.y, { steps: 3 });
    check('After scrolling, the hover outline matches text far down the page', same(await hlRect(page), await rectOf(page, 'g-p')));
    await page.keyboard.up('Shift');
    await page.evaluate(() => { const r = document.getElementById('g-p').getBoundingClientRect(); window.scrollBy(0, r.top - 20); });
    await sleep(50);
    const x = await page.evaluate(() => { const rg = document.createRange(); rg.selectNodeContents(document.getElementById('g-p')); return rg.getBoundingClientRect().left + 250; });
    await page.keyboard.down('Shift');
    await page.mouse.move(x, 28, { steps: 3 });
    const hl = await hlRect(page);
    await page.keyboard.up('Shift');
    check('Text under an opaque sticky header is not picked through it', same(hl, await rectOf(page, 'hdr')), `outline "${hl?.tag}"`);
  }

  {
    await page.evaluate(() => window.scrollTo(0, 0));
    const pr = await page.evaluate(() => { const r = __BL.S.ui.root.querySelector('.panel').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 20 }; });
    await page.mouse.move(pr.x, pr.y);
    await page.keyboard.down('Shift');
    await page.mouse.move(pr.x + 3, pr.y, { steps: 2 });
    const hl = await hlRect(page);
    await page.keyboard.up('Shift');
    check('Shift over the Blueline window shows no page outline', !hl, hl ? `outline "${hl.tag}"` : '');

    await shiftClick(page, await pointFor(page, '#d1-price', 'text'));
    await page.evaluate(() => __BL.S.ui.root.querySelector('[data-x="tb-measure"]').click());
    await sleep(80);
    const p2 = await pointFor(page, '#d2-price', 'text');
    await page.mouse.move(p2.x, p2.y, { steps: 3 });
    await page.mouse.down(); await page.mouse.up();
    await sleep(120);
    const m = await page.evaluate(() => { const P = __BL.toolsApi.getP(); const sel = P.measures[0]?.selector; let to = null; try { to = sel && document.querySelector(sel)?.id; } catch { /* bad selector */ } return { n: P.measures.length, sel, to }; });
    check('Measure picks the second element with the same rules', m.n === 1 && m.to === 'd2-price', JSON.stringify(m));
    await closeNote(page);

    await shiftClick(page, await pointFor(page, '#b-p', 'text'));
    await page.evaluate(() => __BL.S.ui.root.querySelector('[data-x="tool-draw"]').click());
    await page.evaluate(() => __BL.S.ui.root.querySelector('[data-draw="arrow"]').click());
    await sleep(60);
    await page.mouse.move(200, 300); await page.mouse.down(); await page.mouse.move(320, 360, { steps: 6 }); await page.mouse.up();
    await sleep(80);
    const marks = await page.evaluate(() => __BL.toolsApi.getP().marks.filter((mk) => !mk.auto).length);
    check('Drawing an arrow adds a mark', marks === 1, `marks=${marks}`);
    await page.keyboard.press('Escape');
    await closeNote(page);
  }

  // Escape clears the selection (one undo step) only when nothing else should get the key.
  {
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    const undo = async () => { await page.keyboard.down(mod); await page.keyboard.press('z'); await page.keyboard.up(mod); await sleep(80); };
    const esc = async () => { await page.keyboard.press('Escape'); await sleep(80); };
    await page.evaluate(() => { window.__pageEsc = 0; document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__pageEsc++; }); });
    const pageEsc = () => page.evaluate(() => window.__pageEsc);
    const state = () => page.evaluate(() => ({ open: !!__BL.S.pop, note: __BL.S.ui.root.querySelector('.pop-note')?.value || '', drawn: (__BL.toolsApi.getP()?.marks || []).filter((m) => !m.auto).length, ids: (__BL.toolsApi.getP()?.els || []).map((e) => e.id) }));

    // No selection, no note: the page gets Escape as usual.
    await page.mouse.move(5, 300);
    await esc();
    check('Esc with nothing selected is left to the page', (await pageEsc()) === 1 && !(await state()).open, `page saw ${await pageEsc()}`);

    // Select two elements, write a correction, draw a box; Esc clears only the selection.
    await shiftClick(page, await pointFor(page, '#b-p', 'text'));
    await shiftClick(page, await pointFor(page, '#c-label', 'text'));
    await page.evaluate(() => { const t = __BL.S.ui.root.querySelector('.pop-note'); t.value = 'Make this bigger'; t.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.evaluate(() => __BL.S.ui.root.querySelector('[data-x="tool-draw"]').click());
    await page.evaluate(() => __BL.S.ui.root.querySelector('[data-draw="box"]').click());
    await sleep(40);
    await page.mouse.move(300, 200); await page.mouse.down(); await page.mouse.move(420, 280, { steps: 5 }); await page.mouse.up();
    await sleep(60);
    const beforeEsc = await pageEsc();
    // Drawing is active: the first Esc stops drawing and keeps the selection.
    await esc();
    const afterTool = await state();
    const drawing = await page.evaluate(() => !!__BL.toolsApi.D.tool);
    check('Esc during drawing stops drawing first, selection kept', !drawing && afterTool.ids.join() === 'b-p,c-label', JSON.stringify(afterTool));
    // Now the second Esc clears the selection, keeping note text and the drawn box.
    await esc();
    const cleared = await state();
    check('Esc clears the selection; note, text and drawing stay', cleared.open && cleared.ids.length === 0 && cleared.note === 'Make this bigger' && cleared.drawn === 1, JSON.stringify(cleared));
    check('Esc that cleared the selection is not passed to the page', (await pageEsc()) === beforeEsc, `page saw ${(await pageEsc()) - beforeEsc}`);
    await undo();
    const restored = await state();
    check('Undo restores the selection cleared by Esc', restored.ids.join() === 'b-p,c-label' && restored.drawn === 1, JSON.stringify(restored));

    // Typing in the note: Esc belongs to the text field (it blurs), selection kept.
    await page.evaluate(() => __BL.S.ui.root.querySelector('.pop-note').focus());
    await esc();
    const typing = await state();
    check('Esc while typing in the note leaves the selection alone', typing.ids.join() === 'b-p,c-label' && typing.note === 'Make this bigger', JSON.stringify(typing));

    // Blueline's own dialog: Esc closes it and keeps the selection.
    const hasSheet = await page.evaluate(() => { const b = __BL.S.ui.root.querySelector('[data-x="sheet"]'); if (b) b.click(); return !!b && !__BL.S.ui.root.querySelector('[data-m="sheet"]').hidden; });
    if (hasSheet) {
      await page.mouse.move(5, 300);
      await esc();
      const sheetOpen = await page.evaluate(() => !__BL.S.ui.root.querySelector('[data-m="sheet"]').hidden);
      check('Esc closes Blueline’s own dialog and keeps the selection', !sheetOpen && (await state()).ids.join() === 'b-p,c-label', `sheet open: ${sheetOpen}`);
    }
    await closeNote(page);

    // Measure picking (one element selected, so Measure waits for the second): Esc cancels the pick first.
    await shiftClick(page, await pointFor(page, '#d1-price', 'text'));
    await page.evaluate(() => __BL.S.ui.root.querySelector('[data-x="tb-measure"]').click());
    await sleep(80);
    const picking = await page.evaluate(() => !!__BL.toolsApi.T.pick);
    await page.mouse.move(5, 300);
    await esc();
    const afterPick = await state();
    const stillPicking = await page.evaluate(() => !!__BL.toolsApi.T.pick);
    check('Esc during a measure pick cancels the pick first, selection kept', picking && !stillPicking && afterPick.ids.join() === 'd1-price', `picking before: ${picking}, ${JSON.stringify(afterPick)}`);
    await esc();
    check('A second Esc then clears the selection', (await state()).ids.length === 0);
    await closeNote(page);

    // Inline text editing: Esc cancels the edit and keeps the selection.
    await shiftClick(page, await pointFor(page, '#b-p', 'text'));
    await page.evaluate(() => __BL.S.ui.root.querySelector('[data-x="edittext"]').click());
    await sleep(60);
    const editingOn = await page.evaluate(() => document.getElementById('b-p').isContentEditable);
    await page.keyboard.press('x');
    await esc();
    const ed = await page.evaluate(() => ({ editable: document.getElementById('b-p').isContentEditable, text: document.getElementById('b-p').textContent, ids: __BL.toolsApi.getP().els.map((e) => e.id) }));
    check('Esc during inline text editing cancels the edit, selection kept', editingOn && !ed.editable && ed.text === 'Deeply nested paragraph text.' && ed.ids.join() === 'b-p', JSON.stringify({ editingOn, ...ed }));
    await closeNote(page);
  }

  {
    const p = await pointFor(page, '#i-link', 'text');
    await page.mouse.move(p.x, p.y);
    await page.mouse.click(p.x, p.y);
    await sleep(50);
    const clicks = await page.evaluate(() => window.__pageClicks || 0);
    check('A plain click (no Shift) reaches the page link', clicks === 1, `clicks=${clicks}`);
    check('Crosshair cursor style is gone once Shift is released', !(await page.evaluate(() => !!document.getElementById('blueline-cursor'))));
    check('Fixture DOM unchanged by hovering and selecting', (await sectionsHTML()) === domBefore);
  }
  check('No page errors (selection.html)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 2. area selection
console.log('\n# Area selection: Shift+drag (fixtures/area.html)');
{
  const page = await open('area.html');
  const textAt = (id, fx0, fy0, fx1, fy1) => page.evaluate((id, a, b, c, d) => { document.getElementById(id).scrollIntoView({ block: 'nearest' }); const rg = document.createRange(); rg.selectNodeContents(document.getElementById(id)); const r = rg.getBoundingClientRect(); return { x0: r.left + r.width * a, y0: r.top + r.height * b, x1: r.left + r.width * c, y1: r.top + r.height * d }; }, id, fx0, fy0, fx1, fy1);
  // [name, rectangle getter, expected ids]
  const CASES = [
    ['Horizon group: around heading + paragraph', () => rectAround(page, ['r1-h', 'r1-p']), ['r1-h', 'r1-p']],
    ['Horizon group: left half of heading + paragraph', async () => { const r = await rectAround(page, ['r1-h', 'r1-p']); return { ...r, r: (r.l + r.r) / 2 }; }, ['r1-h', 'r1-p']],
    ['Horizon group: band from the heading into the paragraph', async () => { const h = await textAt('r1-h', 0.3, 0.4, 1, 1); const p = await textAt('r1-p', 0, 0, 0.6, 0.45); return { l: h.x0, t: h.y0, r: p.x1, b: p.y1 }; }, ['r1-h', 'r1-p']],
    ['Horizon group: around the whole boxed panel', () => rectAround(page, ['r1-group'], 'box', 6), ['r1-group']],
    ['Horizon group (fit height): band from the heading into the paragraph', async () => { const h = await textAt('r2-h', 0.3, 0.4, 1, 1); const p = await textAt('r2-p', 0, 0, 0.6, 0.45); return { l: h.x0, t: h.y0, r: p.x1, b: p.y1 }; }, ['r2-h', 'r2-p']],
    ['Horizon group (fit height): around heading + paragraph', () => rectAround(page, ['r2-h', 'r2-p']), ['r2-h', 'r2-p']],
    ['Nested headings in plain wrappers', () => rectAround(page, ['hd-h2', 'hd-h4'], 'text', 6), ['hd-h2', 'hd-h4']],
    ['Card: title + price inside the card', () => rectAround(page, ['cd-h', 'cd-price'], 'text', 6), ['cd-h', 'cd-price']],
    ['Card: around the whole card', () => rectAround(page, ['cd'], 'box', 6), ['cd']],
    ['Two buttons in a row', () => rectAround(page, ['bt-1', 'bt-2'], 'box', 6), ['bt-1', 'bt-2']],
  ];
  for (const [name, getRect, want] of CASES) {
    const r = await getRect();
    await sleep(30);
    await shiftDrag(page, r);
    const ids = await selectedIds(page);
    const dup = await nested(page);
    await closeNote(page);
    check(`${name} → [${want}]`, ids.join() === want.join() && !dup, `selected [${ids}]${dup ? ' (parent and child both selected)' : ''}`);
  }
  {
    // Empty space keeps v0.6 behaviour: an area note ("add something here") with no elements.
    const r = await rectAround(page, ['pn'], 'box', 0);
    await shiftDrag(page, { l: r.l + 300, t: r.t + 80, r: r.l + 520, b: r.t + 180 });
    const ids = await selectedIds(page);
    const region = await page.evaluate(() => !!__BL.S.pop?.region);
    await closeNote(page);
    check('Empty space in a boxed panel → area note, no elements', ids.length === 0 && region, `selected [${ids}], area note: ${region}`);
  }
  {
    await shiftDrag(page, await rectAround(page, ['ls'], 'box', 6));
    const ids = await selectedIds(page);
    const dup = await nested(page);
    await closeNote(page);
    check('A long list stays a small, non-overlapping selection', ids.length >= 1 && ids.length <= 8 && !dup, `selected [${ids}]`);
  }
  {
    const p = await pointFor(page, '#r1-p', 'text');
    await shiftClick(page, p);
    const ids = await selectedIds(page);
    await closeNote(page);
    check('Shift+click inside the Horizon group still selects just the paragraph', ids.join() === 'r1-p', `selected [${ids}]`);
  }
  // Repeated Shift+drags over already-selected elements: never add their shared parent, never duplicate,
  // still add new content, and a fresh drag around a boxed panel still selects the panel.
  {
    const ids = () => selectedIds(page);
    await page.evaluate(() => document.getElementById('r3-group').scrollIntoView({ block: 'center' }));
    await shiftDrag(page, await rectAround(page, ['r3-h', 'r3-p'], 'text', 4));
    const first = await ids();
    await shiftDrag(page, await rectAround(page, ['r3-h', 'r3-p'], 'text', 4));
    const again = await ids();
    const toastAgain = await page.evaluate(() => __BL.S.ui.root.querySelector('.toast')?.textContent || '');
    await shiftDrag(page, await rectAround(page, ['r3-h', 'r3-p'], 'box', 10));
    const bigger = await ids();
    const dupBigger = await nested(page);
    await shiftDrag(page, await rectAround(page, ['r3-group'], 'box', 6));
    const whole = await ids();
    const dupWhole = await nested(page);
    check('Repeat drag: first drag selects the two texts', first.join() === 'r3-h,r3-p', `[${first}]`);
    check('Repeat drag: the same drag again adds nothing (no parent, no duplicates)', again.join() === 'r3-h,r3-p', `[${again}] ${toastAgain}`);
    check('Repeat drag: a slightly bigger drag does not add the shared parent', bigger.slice(0, 2).join() === 'r3-h,r3-p' && !bigger.includes('r3-group') && !dupBigger && new Set(bigger).size === bigger.length, `[${bigger}]`);
    check('Repeat drag: dragging the whole panel adds only the new text inside it', whole.join() === 'r3-h,r3-p,r3-note' && !dupWhole, `[${whole}]`);
    // Explicit parent selection still works through Shift+click on the panel's padding.
    const pad = await pointFor(page, '#r3-group', { from: 'tr', dx: -6, dy: 4 });
    await shiftClick(page, pad);
    const withParent = await ids();
    check('Repeat drag: Shift+click can still add the parent panel explicitly', withParent.includes('r3-group'), `[${withParent}]`);
    await closeNote(page);
    await shiftDrag(page, await rectAround(page, ['r3-group'], 'box', 6));
    const fresh = await ids();
    await closeNote(page);
    check('Repeat drag: a fresh drag around the boxed panel still selects the panel', fresh.join() === 'r3-group', `[${fresh}]`);
  }

  // The Shift+drag rectangle is temporary: shown while dragging, gone on release. Selection, outlines and
  // chips stay; drawn annotations stay; an empty-area note keeps its region box.
  {
    const ui = () => page.evaluate(() => {
      const root = __BL.S.ui.root;
      const dr = root.querySelector('.dr');
      const P = __BL.toolsApi.getP();
      const selb = [...root.querySelectorAll('.selb')].map((n) => { const r = n.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
      const want = (P?.els || []).map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
      return {
        dragBox: !!dr && !dr.hidden, dragBoxSet: !!dr && !dr.hidden && dr.classList.contains('set'),
        shapes: root.querySelector('.x-marks')?.children.length || 0,
        outlinesOk: selb.length === want.length && want.every((w, i) => ['l', 't', 'w', 'h'].every((k) => Math.abs(w[k] - selb[i][k]) < 1.5)),
        outlines: selb.length, chips: root.querySelectorAll('.x-sel .tchip').length,
        ids: (P?.els || []).map((e) => e.id), autoBoxKept: !!P?.marks?.some((m) => m.auto), drawn: (P?.marks || []).filter((m) => !m.auto).length,
      };
    });
    async function dragWithPeek(r) {
      await page.mouse.move(r.l, r.t);
      await page.keyboard.down('Shift');
      await page.mouse.down();
      await page.mouse.move((r.l + r.r) / 2, (r.t + r.b) / 2, { steps: 4 });
      const during = await ui();
      await page.mouse.move(r.r, r.b, { steps: 4 });
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await sleep(80);
      return { during, after: await ui() };
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    const r1 = await rectAround(page, ['hd-h2', 'hd-h4'], 'text', 6);
    const a = await dragWithPeek(r1);
    check('Drag rectangle: visible while dragging', a.during.dragBox, JSON.stringify(a.during));
    check('Drag rectangle: gone after release (no preview, no leftover box)', !a.after.dragBox && a.after.shapes === 0, JSON.stringify(a.after));
    check('Drag rectangle: elements stay selected with blue outlines and chips', a.after.ids.join() === 'hd-h2,hd-h4' && a.after.outlinesOk && a.after.chips === 2, JSON.stringify(a.after));
    check('Drag rectangle: area box still kept for the marked-up screenshot', a.after.autoBoxKept, JSON.stringify(a.after));

    const r2 = await rectAround(page, ['bt-1', 'bt-2'], 'box', 6);
    const b = await dragWithPeek(r2);
    check('Second drag: fresh rectangle while dragging', b.during.dragBox, JSON.stringify(b.during));
    check('Second drag: rectangle gone after release, both selections kept with outlines', !b.after.dragBox && b.after.shapes === 0 && b.after.ids.join() === 'hd-h2,hd-h4,bt-1,bt-2' && b.after.outlinesOk && b.after.chips === 4, JSON.stringify(b.after));

    await page.evaluate(() => __BL.S.ui.root.querySelector('[data-x="sel-clear"]').click());
    await sleep(60);
    const cleared = await ui();
    await page.mouse.move(5, 5);
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(mod); await page.keyboard.press('z'); await page.keyboard.up(mod);
    await sleep(80);
    const undone = await ui();
    check('Clear selection removes selection and outlines', cleared.ids.length === 0 && cleared.outlines === 0 && !cleared.dragBox && cleared.shapes === 0, JSON.stringify(cleared));
    check('Undo restores the selection and outlines, without a leftover box', undone.ids.join() === 'hd-h2,hd-h4,bt-1,bt-2' && undone.outlinesOk && !undone.dragBox && undone.shapes === 0, JSON.stringify(undone));

    // A drawn box stays visible through a later Shift+drag.
    await page.evaluate(() => __BL.S.ui.root.querySelector('[data-x="tool-draw"]').click());
    await page.evaluate(() => __BL.S.ui.root.querySelector('[data-draw="box"]').click());
    await sleep(60);
    const cr = await rectAround(page, ['cd'], 'box', 0);
    await page.mouse.move(cr.r + 20, cr.t); await page.mouse.down(); await page.mouse.move(cr.r + 180, cr.t + 120, { steps: 6 }); await page.mouse.up();
    await sleep(60);
    await page.keyboard.press('Escape');
    await sleep(60);
    const drawnBefore = await ui();
    const c = await dragWithPeek(await rectAround(page, ['cd-h', 'cd-price'], 'text', 6));
    check('A drawn box stays visible after another Shift+drag', drawnBefore.drawn === 1 && drawnBefore.shapes === 1 && c.after.drawn === 1 && c.after.shapes === 1 && !c.after.dragBox, `before ${JSON.stringify(drawnBefore)} after ${JSON.stringify(c.after)}`);
    await closeNote(page);

    // Empty-area note: its region box is the note's target and stays visible.
    const pr = await rectAround(page, ['pn'], 'box', 0);
    const e = await dragWithPeek({ l: pr.l + 300, t: pr.t + 80, r: pr.l + 520, b: pr.t + 180 });
    const region = await page.evaluate(() => !!__BL.S.pop?.region);
    check('Empty-area drag still makes an area note with its region box shown', region && e.after.ids.length === 0 && e.after.dragBoxSet && e.after.chips === 1, JSON.stringify({ region, ...e.after }));
    await closeNote(page);
  }
  check('No page errors (area.html)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 3. modals
console.log('\n# Modals block selection; decorative overlays do not (fixtures/modal.html)');
{
  const page = await open('modal.html');
  const inPage = (ids) => page.evaluate((ids) => ids.some((id) => { const e = document.getElementById(id) || document.querySelector(id.toLowerCase()); return !!e && !!e.closest('.page'); }), ids);
  const MODALS = [
    [1, 'native <dialog> (showModal)', ['m1-h', 'm1-p']],
    [2, 'popup: see-through backdrop + panel', ['m2-h', 'm2-p']],
    [3, 'framework: wrapper + backdrop sibling', ['m3-h', 'm3-p']],
    [4, 'fully transparent click-catcher', ['m4-p']],
  ];
  for (const [n, name, inside] of MODALS) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate((n) => window.openModal(n), n);
    await sleep(80);
    // Hover and Shift+click on page text that sits behind the backdrop.
    const p = await pointFor(page, '#pg-4', 'text');
    const hl = await shiftClick(page, p);
    const got = await selectedIds(page);
    await closeNote(page);
    check(`M${n} ${name}: hover behind the backdrop does not outline page text`, !same(hl, await rectOf(page, 'pg-4')), `outline "${hl?.tag}"`);
    check(`M${n} ${name}: Shift+click behind the backdrop selects no page content`, !(await inPage(got)), `selected [${got}]`);
    // Shift+drag over page text behind the backdrop.
    await shiftDrag(page, await rectAround(page, ['pg-3', 'pg-5'], 'text', 6));
    const dragged = await selectedIds(page);
    await closeNote(page);
    check(`M${n} ${name}: Shift+drag behind the backdrop selects no page content`, !(await inPage(dragged)), `selected [${dragged}]`);
    // Content inside the modal is selectable.
    const q = await pointFor(page, `#${inside[inside.length - 1]}`, 'text');
    const hl2 = await shiftClick(page, q);
    const got2 = await selectedIds(page);
    await closeNote(page);
    const want = inside[inside.length - 1];
    check(`M${n} ${name}: text inside the modal is outlined and selected`, got2.join() === want && same(hl2, await rectOf(page, want)), `selected [${got2}]`);
    if (inside.length > 1) {
      await shiftDrag(page, await rectAround(page, inside, 'text', 6));
      const ids = await selectedIds(page);
      await closeNote(page);
      check(`M${n} ${name}: Shift+drag inside the modal selects its content`, ids.join() === inside.join(), `selected [${ids}]`);
    }
    await page.evaluate(() => window.closeModals());
    await sleep(60);
  }
  {
    // With a page popup open, Esc is the page's (to close the popup), even when something is selected.
    await page.evaluate(() => { window.__pageEsc = 0; document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__pageEsc++; }); window.openModal(2); });
    await sleep(60);
    await shiftClick(page, await pointFor(page, '#m2-p', 'text'));
    await page.mouse.move(5, 5);
    await page.keyboard.press('Escape');
    await sleep(60);
    const ids = await selectedIds(page);
    const seen = await page.evaluate(() => window.__pageEsc);
    check('Esc with a page popup open goes to the page, selection kept', seen === 1 && ids.join() === 'm2-p', `page saw ${seen}, selected [${ids}]`);
    await closeNote(page);
    await page.evaluate(() => window.closeModals());
  }
  {
    const hl = await shiftClick(page, await pointFor(page, '#hero-h', 'text'));
    const ids = await selectedIds(page);
    await closeNote(page);
    check('With no modal open, a hero tint layer is still seen through', ids.join() === 'hero-h' && same(hl, await rectOf(page, 'hero-h')), `selected [${ids}]`);
  }
  check('No page errors (modal.html)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 4. Toolbox, CSS changes per instance, corrections, export
console.log('\n# Toolbox, per-instance CSS changes, corrections and export (fixtures/toolbox.html)');
{
  const page = await open('toolbox.html');
  const ui = (fn, ...a) => page.evaluate(fn, ...a);
  const T = (t) => `[data-t="${t}"]`;
  // Inline style a Blueline preview put on an element ('' when none).
  const inline = (sel, prop) => ui((sel, prop) => document.querySelector(sel).style.getPropertyValue(prop), sel, prop);
  // Edit CSS shows only the selected rule's own properties; a property it doesn't declare is added first with
  // + Add CSS property (search, then pick), the way a user would.
  const addProp = (prop) => ui((prop) => {
    const root = __BL.S.ui.root;
    if (root.querySelector('.css-add-box').hidden) root.querySelector('[data-x="css-add"]').click();
    const qi = root.querySelector('.css-add-q');
    qi.value = prop;
    qi.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector(`.css-add-opt[data-prop="${prop}"]`).click();
  }, prop);
  const setCss = async (prop, value) => {
    if (!(await ui((prop) => !!__BL.S.ui.root.querySelector(`.style-rows .st[data-prop="${prop}"]`), prop))) await addProp(prop);
    await ui((prop, value) => { const row = __BL.S.ui.root.querySelector(`.style-rows .st[data-prop="${prop}"]`); const i = row.querySelector('.sv'); i.value = value; i.dispatchEvent(new Event('input', { bubbles: true })); }, prop, value);
  };
  const choose = (i) => ui((i) => { const s = __BL.S.ui.root.querySelector('.element-choice'); s.value = String(i); s.dispatchEvent(new Event('change', { bubbles: true })); }, i);
  const click = (sel) => ui((sel) => __BL.S.ui.root.querySelector(sel).click(), sel);
  const changes = () => ui(() => [...__BL.S.ui.root.querySelectorAll('.css-changes .chg > span')].map((s) => s.textContent.replace(/\s+/g, ' ').trim()));
  const card = () => ui(() => { const r = __BL.S.ui.root; const b = r.querySelector('.element-editor'); return { shown: !!b && !b.hidden, name: b?.querySelector('.se-name')?.textContent.trim(), sel: b?.querySelector('.se-sel')?.textContent, of: b?.querySelector('.se-of')?.textContent || '' }; });
  const shown = () => ui(() => { const r = __BL.S.ui.root; return { panels: [...r.querySelectorAll('[data-tool-panel]')].filter((p) => !p.hidden).map((p) => p.dataset.toolPanel), pressed: [...r.querySelectorAll('.tool-main')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent.trim()) }; });
  const ids = () => ui(() => (__BL.toolsApi.getP()?.els || []).map((e) => e.dataset.t || e.id));
  const save = async () => { await click('[data-act="pop-save"]'); await sleep(400); };
  const prompt = () => ui(() => __BLUELINE_TEST__.api.buildPrompt(__BL.S.batch));
  const resolves = (sel, want) => ui((sel, want) => { try { return document.querySelector(sel) === document.querySelector(want); } catch { return false; } }, sel, want);
  // Lines of the export that belong to one instance block.
  const instanceBlock = (text, selector) => { const lines = text.split('\n'); const i = lines.findIndex((l) => l.includes('**Instance') && l.includes(selector)); if (i < 0) return ''; const out = []; for (let k = i + 1; k < lines.length && !lines[k].includes('**Instance') && !lines[k].startsWith('---') && !lines[k].startsWith('Screenshot'); k++) out.push(lines[k]); return out.join('\n'); };

  // Interface: the ribbon, Toolbox as the default, primary and secondary actions, Describe controls.
  await shiftClick(page, await pointFor(page, T('t1'), 'text'));
  await shiftClick(page, await pointFor(page, T('t2'), 'text'));
  const dflt = await shown(); // the Toolbox actions start collapsed
  await click('[data-x="tool-elements"]');
  {
    const r = await ui(() => {
      const root = __BL.S.ui.root;
      const visible = (e) => !!e && e.getClientRects().length > 0;
      return {
        ribbon: [...root.querySelectorAll('.tool-main')].map((b) => b.textContent.trim()),
        actions: [...root.querySelectorAll('.tb-actions .tool-action')].map((b) => b.textContent.trim()),
        actionsShown: [...root.querySelectorAll('.tb-actions .tool-action')].every(visible),
        cols: getComputedStyle(root.querySelector('.tb-actions')).gridTemplateColumns.split(' ').length,
        more: root.querySelectorAll('[data-x="tb-more"], .tb-more').length, cssAction: root.querySelectorAll('.tb-actions [data-x="edit-css"], [data-x="edit-css"]').length,
        matchAll: visible(root.querySelector('.match-all')),
        steps: [...root.querySelectorAll('.pop .stephead')].map((s) => s.textContent.trim()),
        prio: root.querySelectorAll('[data-prio]').length, types: root.querySelectorAll('.types, .type').length,
        bps: [...root.querySelectorAll('[data-bp]')].map((b) => b.textContent.trim()), bpsVisible: [...root.querySelectorAll('[data-bp]')].every(visible) && !root.querySelector('[data-bp]').closest('details'),
        broken: !!root.querySelector('.pop-broken') && !root.querySelector('.pop-broken').checked,
        noteBelowTools: !!(root.querySelector('.tool-ribbon').compareDocumentPosition(root.querySelector('.pop-note')) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    check('Ribbon reads Toolbox | Edit CSS | Annotate | Align', r.ribbon.join('|') === 'Toolbox|Edit CSS|Annotate|Align', JSON.stringify(r.ribbon));
    check('The Toolbox actions are collapsed by default (the four tools stay visible); pressing Toolbox expands them', JSON.stringify(dflt) === JSON.stringify({ panels: [], pressed: [] }) && JSON.stringify(await shown()) === JSON.stringify({ panels: ['elements'], pressed: ['Toolbox'] }), JSON.stringify(dflt));
    await click('[data-x="tool-elements"]');
    const closed = await shown();
    await click('[data-x="tool-elements"]');
    check('Pressing Toolbox again collapses its actions, and again expands them', JSON.stringify(closed) === JSON.stringify({ panels: [], pressed: [] }) && (await shown()).panels.join() === 'elements', JSON.stringify(closed));
    check('Toolbox shows all six actions in a two-column grid: Edit text, Move, Measure, Match style, Hide, Sample color', r.actions.join('|') === 'Edit text|Move|Measure|Match style|Hide|Sample color' && r.actionsShown && r.cols === 2, JSON.stringify(r));
    check('No More menu, no Edit CSS action inside the Toolbox; "apply match style to all selected" kept', r.more === 0 && r.cssAction === 0 && r.matchAll, JSON.stringify(r));
    check('Steps read Select, Edit, Describe; the description sits below the editing tools', r.steps.join('|') === '1Select|2Edit|3Describe' && r.noteBelowTools, JSON.stringify(r.steps));
    check('No Priority or note-type controls; Broken checkbox present and off', r.prio === 0 && r.types === 0 && r.broken, JSON.stringify(r));
    check('Screen size controls read All, Desktop, Tablet, Mobile, inline', r.bps.join('|') === 'All|Desktop|Tablet|Mobile' && r.bpsVisible, JSON.stringify(r));
    check('No explanatory sentence under the screen size controls', await ui(() => { const root = __BL.S.ui.root; return !root.querySelector('.bp-note') && !/Records the screen size|doesn.t resize the page/.test(root.querySelector('.bp-row').parentElement.textContent); }), '');
    await click('[data-x="tool-draw"]');
    const draw = await shown();
    await click('[data-x="tool-draw"]');
    check('Annotate opens its panel; pressing it again returns to the Toolbox (still expanded)', draw.panels.join() === 'draw' && draw.pressed.join() === 'Annotate' && (await shown()).panels.join() === 'elements', JSON.stringify(draw));
    await click('[data-x="tool-css"]');
    const css = await shown();
    await click('[data-x="tool-elements"]');
    check('Edit CSS is its own tab; Toolbox returns to the actions', css.panels.join() === 'css' && css.pressed.join() === 'Edit CSS' && (await shown()).panels.join() === 'elements', JSON.stringify(css));
    const hint = await ui(() => { const b = __BL.S.ui.root.querySelector('[data-x="sel-add"]'); const h = b?.nextElementSibling; return { text: h?.textContent, cls: h?.className, size: h ? parseFloat(getComputedStyle(h).fontSize) : 0, btn: b?.textContent }; });
    check('"+ Add another element" shows a subtle Shift+click hint next to it', hint.btn === '+ Add another element' && hint.text === 'Shift+click' && hint.cls === 'kbd-hint' && hint.size <= 11, JSON.stringify(hint));
  }

  // The Selected element card follows the instance being edited.
  {
    const c1 = await card();
    check('Selected element card: type, text, class selector, instance 1 of 2', c1.shown && c1.name === 'Heading 3 “Whey protein”' && c1.sel === 'h3.card-title' && c1.of === 'Editing 1 of 2', JSON.stringify(c1));
    await choose(1);
    const c2 = await card();
    const cur = await ui(() => { const root = __BL.S.ui.root; const t2 = document.querySelector('[data-t="t2"]').getBoundingClientRect(); const cur = [...root.querySelectorAll('.selb.cur')]; const chip = root.querySelector('.x-sel .tchip.cur')?.textContent || ''; return { n: cur.length, onT2: cur.length === 1 && Math.abs(cur[0].getBoundingClientRect().left - t2.left) < 1.5, chip }; });
    check('Switching instance updates the card and marks the current target on the page', c2.name === 'Heading 3 “Creatine”' && c2.of === 'Editing 2 of 2' && cur.onT2 && cur.chip.includes('Creatine'), JSON.stringify({ c2, cur }));
  }

  // CSS values stay with the element and class they were made on.
  {
    await click('[data-x="tool-css"]');
    // v0.7 contextual editor: the rows are the selected rule's own declarations (.card-title: margin, font-size), not a fixed list.
    const open = await ui(() => { const root = __BL.S.ui.root; const p = root.querySelector('[data-tool-panel="css"]'); return { shown: !p.hidden, rows: [...p.querySelectorAll('.style-rows .st')].map((r) => r.dataset.prop).join(), rule: p.querySelector('.css-rule').selectedOptions[0]?.textContent, toolbox: !!root.querySelector('[data-tool-panel="elements"] .style-rows') }; });
    check('The Edit CSS tab holds the CSS property controls: the matching rule’s own declarations', open.shown && open.rows === 'margin,font-size' && open.rule.startsWith('.card-title · inline <style>') && !open.toolbox, JSON.stringify(open));
    await setCss('color', '#005EB8');
    await setCss('font-size', '28');
    check('CSS preview lands on the edited instance only', (await inline(T('t2'), 'font-size')) === '28px' && (await inline(T('t1'), 'font-size')) === '' && (await inline(T('t3'), 'font-size')) === '' && (await inline(T('t2'), 'color')) !== '', `t1 "${await inline(T('t1'), 'font-size')}" t2 "${await inline(T('t2'), 'font-size')}"`);
    const ch = await changes();
    // v0.7 contextual editor: a property the rule didn't declare reads “added” (its original declaration is absent), not its computed value.
    check('Changes list shows original → updated values', ch.join(' | ') === 'color: added → #005EB8 | font-size: 18px → 28px', JSON.stringify(ch));
    await choose(0);
    const ch1 = await changes();
    const row = await ui(() => __BL.S.ui.root.querySelector('.st[data-prop="font-size"] .sv').value);
    check('Switching to another instance does not carry its CSS changes over', ch1.length === 0 && row === '18px' && (await inline(T('t2'), 'font-size')) === '28px', JSON.stringify({ ch1, row }));
    // The same property edited on instance 1 right after instance 2 is its own undo step (not merged with it).
    await setCss('font-size', '30');
    await click('[data-x="undo"]');
    await sleep(60);
    check('Undo after editing two instances reverts only the latest instance', (await inline(T('t1'), 'font-size')) === '' && (await inline(T('t2'), 'font-size')) === '28px', `t1 "${await inline(T('t1'), 'font-size')}" t2 "${await inline(T('t2'), 'font-size')}"`);
    await setCss('padding', '4px');
    await setCss('margin', '2px');
    await click('.chg button[data-prop="margin"]');
    check('✕ in the Changes list reverts that one value', (await inline(T('t1'), 'margin')) === '' && (await inline(T('t1'), 'padding')) === '4px' && (await changes()).join() === 'padding: added → 4px', JSON.stringify(await changes()));
    await choose(1);
    check('Switching back shows the instance’s own changes', (await changes()).join(' | ') === 'color: added → #005EB8 | font-size: 18px → 28px', JSON.stringify(await changes()));
  }

  // Scope stays per instance, and a broader scope never restyles the other matching elements by itself.
  {
    await ui(() => { const r = __BL.S.ui.root.querySelector('[name="scope"][value="all"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
    const s = await ui(() => ({ sum: __BL.S.ui.root.querySelector('.scope-sum').textContent, sim: __BL.toolsApi.T.simEls?.length || 0 }));
    check('Scope "everywhere" on instance 2 highlights the class matches without restyling them', s.sum === 'everywhere · 3' && s.sim === 2 && (await inline(T('t3'), 'font-size')) === '' && (await inline(T('t1'), 'font-size')) === '', JSON.stringify(s));
    await choose(0);
    const s0 = await ui(() => __BL.S.ui.root.querySelector('[name="scope"]:checked')?.value);
    await choose(1);
    const s1 = await ui(() => __BL.S.ui.root.querySelector('[name="scope"]:checked')?.value);
    check('Each instance keeps its own scope when switching', s0 === 'one' && s1 === 'all', `${s0} / ${s1}`);
  }

  // Save: the correction keeps target, selector, property, original, updated value and scope per instance.
  let saved;
  {
    await ui(() => { const t = __BL.S.ui.root.querySelector('.pop-note'); t.value = 'Make the second title stand out'; });
    await click('[data-bp="mobile"]');
    await save();
    saved = await ui(() => JSON.parse(JSON.stringify(__BL.S.batch.items[0])));
    const ee = saved.elementEdits || [];
    check('Saved note: type "change", no priority, chosen screen sizes', saved.type === 'change' && !('priority' in saved) && saved.bps.join() === 'mobile,desktop', JSON.stringify({ type: saved.type, priority: saved.priority, bps: saved.bps }));
    // v0.7: with CSS changes made in a CSS rule, the scope names that rule (.card-title) instead of the guessed similar-element selector (h3.card-title).
    check('Saved instance 1: its own selector, padding only, scope "one" with the class selector', ee.length === 2 && (await resolves(ee[0].el.selector, T('t1'))) && JSON.stringify(ee[0].tweaks.map((t) => [t.prop, t.from, t.to, t.declared, t.rule?.matched])) === '[["padding","","4px",false,".card-title"]]' && ee[0].scope.mode === 'one' && ee[0].scope.selector === '.card-title' && ee[0].scope.basis === 'rule' && ee[0].el.classes === 'card-title', JSON.stringify(ee[0]));
    check('Saved instance 2: its own selector, font-size and color with original and new values, scope "all"', (await resolves(ee[1]?.el.selector, T('t2'))) && JSON.stringify(ee[1].tweaks.map((t) => [t.prop, t.from, t.to, t.declared, t.rule?.matched])) === '[["color","","#005EB8",false,".card-title"],["font-size","18px","28px",true,".card-title"]]' && ee[1].tweaks[0].computed === 'rgb(34, 34, 34)' && ee[1].scope.mode === 'all' && ee[1].scope.count === 3 && ee[1].scope.selector === '.card-title' && ee[1].scope.basis === 'rule', JSON.stringify(ee[1]));
    check('After saving, previews stay on their own elements', (await inline(T('t2'), 'font-size')) === '28px' && (await inline(T('t1'), 'padding')) === '4px' && (await inline(T('t3'), 'font-size')) === '' && (await inline(T('t1'), 'font-size')) === '');
    const text = await prompt();
    const b1 = instanceBlock(text, ee[0].el.selector);
    const b2 = instanceBlock(text, ee[1].el.selector);
    // v0.7 export: CSS changes are listed under their rule ("prop: from → to", "added" when the rule didn't declare it).
    check('Export: instance 2 lists its own CSS change and its "everywhere" scope for the class', b2.includes('CSS rule `.card-title` in inline <style> 1:') && b2.includes('font-size: 18px → 28px') && b2.includes('color: added → #005EB8') && b2.includes('Scope: **everywhere**: change rule `.card-title`'), b2);
    check('Export: instance 1 keeps "this one only" and none of instance 2’s values', b1.includes('padding: added → 4px') && b1.includes('this one only') && b1.includes('they must stay unchanged') && !b1.includes('font-size'), b1);
    check('Export: item heading is "Change", nothing about priority', /\n## 1\. Change: /.test(text) && !/nice to have/i.test(text) && !/must-fix/i.test(text), text.split('\n').find((l) => l.startsWith('## 1.')));
  }

  // Reopen: each instance gets its own edits back.
  {
    await click('.list .item');
    await sleep(700);
    const back = await ids();
    await choose(1);
    const c2 = await changes();
    await choose(0);
    const c1 = await changes();
    check('Reopened note restores each instance’s CSS changes to the right element', back.join() === 't1,t2' && c2.join(' | ') === 'color: added → #005EB8 | font-size: 18px → 28px' && c1.join() === 'padding: added → 4px', JSON.stringify({ back, c1, c2 }));
    await closeNote(page);
    // The selector an instance was saved with still finds it when the element's path is now different.
    await ui(() => { __BL.S.batch.items[0].elementEdits[1].el.selector = '[data-t="t2"]'; });
    await click('.list .item');
    await sleep(700);
    await choose(1);
    const c3 = await changes();
    check('Reopen matches a saved instance by its saved selector when its path changed', c3.join(' | ') === 'color: added → #005EB8 | font-size: 18px → 28px', JSON.stringify(c3));
    await closeNote(page);
  }

  // Broken / error flag.
  {
    await shiftClick(page, await pointFor(page, '#lead', 'text'));
    await ui(() => { const b = __BL.S.ui.root.querySelector('.pop-broken'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); __BL.S.ui.root.querySelector('.pop-note').value = 'The link does nothing'; });
    await save();
    const it = await ui(() => __BL.S.batch.items[1]);
    check('Broken checkbox saves the note as a bug', it.type === 'bug' && /\n## 2\. Bug: /.test(await prompt()), it.type);
    await ui(() => __BL.S.ui.root.querySelectorAll('.list .item')[1].click());
    await sleep(700);
    const on = await ui(() => __BL.S.ui.root.querySelector('.pop-broken').checked);
    await ui(() => { const b = __BL.S.ui.root.querySelector('.pop-broken'); b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true })); });
    check('Reopened bug shows Broken ticked; unticking makes it a change', on && (await ui(() => __BL.S.popType)) === 'change');
    await closeNote(page);
  }

  // Hide sits in the Toolbox and shows in the Changes list.
  {
    await shiftClick(page, await pointFor(page, '#lead', 'text'));
    await click('.tb-actions [data-x="hide"]');
    const hidden = (await inline('#lead', 'display')) === 'none' && (await ui(() => [...__BL.S.ui.root.querySelectorAll('.css-changes .chg')].some((c) => c.textContent.includes('Hidden'))));
    await click('.css-changes [data-x="hide"]');
    check('Hide (in the Toolbox) previews and lists the change; ✕ shows it again', hidden && (await inline('#lead', 'display')) === '');
    await closeNote(page);
  }

  // Notes saved before v0.7: older types and priority still load, export and update.
  {
    await ui(() => {
      const el = document.querySelector('[data-t="p3"]');
      const info = __BLUELINE_TEST__.api.describe(el, 'copy');
      __BL.S.batch.items.push({ id: 'legacy1', note: 'Make the price bolder', createdAt: Date.now(), ...info, priority: 'nice', bps: ['desktop'],
        tweaks: [{ prop: 'font-weight', from: '600', to: '800' }], scope: { mode: 'one', count: 1, selector: 'p.card-price', similar: 3, chosen: false } });
      __BL.render();
    });
    const text = await prompt();
    const head = text.split('\n').find((l) => l.startsWith('## 3.')) || '';
    check('Older note exports with its own type and without priority wording', head.startsWith('## 3. Copy: ') && !/nice to have/i.test(text) && !/Types:|Suggested order/.test(text) && text.includes('font-weight 600 → 800'), head);
    const meta = await ui(() => __BL.S.ui.root.querySelectorAll('.list .item')[2]?.querySelector('.meta')?.textContent || '');
    check('Notes list shows the older type and no priority', meta.startsWith('Change text · ') && !/nice/i.test(meta), meta);
    await ui(() => __BL.S.ui.root.querySelectorAll('.list .item')[2].click());
    await sleep(700);
    const st = await ui(() => ({ broken: __BL.S.ui.root.querySelector('.pop-broken').checked, type: __BL.S.popType, name: __BL.S.ui.root.querySelector('.se-name')?.textContent.trim() }));
    const ch = await changes();
    check('Older note reopens with its type kept, its CSS change on its element', !st.broken && st.type === 'copy' && st.name === 'Paragraph “$12.99”' && ch.join() === 'font-weight: 600 → 800' && (await inline(T('p3'), 'font-weight')) === '800', JSON.stringify({ st, ch }));
    await save();
    const up = await ui(() => __BL.S.batch.items[2]);
    check('Updating an older note keeps its type and moves its CSS change onto its element', up.type === 'copy' && up.elementEdits?.length === 1 && (await resolves(up.elementEdits[0].el.selector, T('p3'))) && up.elementEdits[0].tweaks[0].prop === 'font-weight' && up.elementEdits[0].tweaks[0].to === '800', JSON.stringify(up.elementEdits));
  }
  // Saved elements that aren't on the page when a note is reopened: their edits are kept as saved, never
  // moved to another element, written back on Update, and still exported.
  {
    const openItem = async (n) => { await ui((n) => __BL.S.ui.root.querySelectorAll('.list .item')[n].click(), n); await sleep(700); };
    const item = (n) => ui((n) => JSON.parse(JSON.stringify(__BL.S.batch.items[n])), n);
    const missingChips = () => ui(() => [...__BL.S.ui.root.querySelectorAll('.x-sel .tchip.missing')].map((c) => c.firstChild.textContent));
    const detach = (sel, key) => ui((sel, key) => { const e = document.querySelector(sel); window[key] = { e, parent: e.parentNode, next: e.nextSibling }; e.remove(); }, sel, key);
    const reattach = (key) => ui((key) => { const k = window[key]; k.parent.insertBefore(k.e, k.next); }, key);
    const setNote = (t) => ui((t) => { __BL.S.ui.root.querySelector('.pop-note').value = t; }, t);
    const inlineAnywhere = (prop, value) => ui((prop, value) => [...document.querySelectorAll('body *')].filter((e) => e.style.getPropertyValue(prop) === value).map((e) => e.dataset.t || e.id || e.tagName), prop, value);
    const tweaks = (rec) => JSON.stringify((rec.tweaks || []).map((t) => [t.prop, t.from, t.to]));

    // A note on three prices, each with its own edit; then one price leaves the page.
    for (const t of ['p1', 'p2', 'p3']) await shiftClick(page, await pointFor(page, T(t), 'text'));
    await choose(0); await click('[data-x="tool-css"]'); await setCss('padding', '4px');
    await choose(1); await setCss('font-size', '22');
    await choose(2); await setCss('color', '#005EB8');
    await ui(() => { const r = __BL.S.ui.root.querySelector('[name="scope"][value="all"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
    await setNote('Price styling');
    await save();
    const before = await item(3);
    await closeNote(page);
    await detach(T('p2'), '__p2');
    await openItem(3);
    const opened = { ids: await ids(), chips: await missingChips(), stray: [...await inlineAnywhere('font-size', '22px'), ...await ui(() => [...__BL.toolsApi.getP().edits].filter(([, r]) => r.tweaks['font-size']).map(([e]) => e.dataset.t))] };
    check('Missing element: reopening shows "Element not found" and keeps the others', opened.ids.join() === 'p1,p3' && opened.chips.join() === 'Element not found: p.card-price', JSON.stringify(opened));
    check('Missing element: its edits are not applied to another element', opened.stray.length === 0, JSON.stringify(opened.stray));
    await choose(1);
    check('Missing element: the elements found keep their own edits', (await changes()).join() === 'color: added → #005EB8', JSON.stringify(await changes()));
    await setNote('Price styling, updated');
    await save();
    const after = await item(3);
    const ee = after.elementEdits || [];
    const p2rec = before.elementEdits[1];
    const keptP2 = ee.find((r) => r.el.selector === p2rec.el.selector);
    check('Missing element: Update keeps its saved record exactly (selector, class, values, scope)', after.note === 'Price styling, updated' && ee.length === 3 && JSON.stringify(keptP2) === JSON.stringify(p2rec), JSON.stringify(ee.map((r) => r.el.selector)));
    check('Missing element: the other instances are saved with their own edits', tweaks(ee.find((r) => r.el.selector === before.elementEdits[0].el.selector)) === tweaks(before.elementEdits[0]) && tweaks(ee.find((r) => r.el.selector === before.elementEdits[2].el.selector)) === tweaks(before.elementEdits[2]) && ee.find((r) => r.el.selector === before.elementEdits[2].el.selector).scope.mode === 'all', JSON.stringify(ee));
    check('Missing element: the note still lists it, so it is found again later', after.el.selector === before.el.selector && (after.also || []).some((a) => a.selector === p2rec.el.selector) && after.also.length === 2, JSON.stringify(after.also));
    {
      const text = await prompt();
      const b = instanceBlock(text, p2rec.el.selector);
      const t = p2rec.tweaks[0];
      check('Missing element: the export still includes its correction after Update', b.includes(`font-size: ${t.declared === false ? 'added' : t.from} → ${t.to}`) && b.includes('this one only'), b);
    }
    await reattach('__p2');
    await openItem(3);
    const back = await ids();
    await choose(back.indexOf('p2'));
    check('Missing element: when it is back on the page, its edits return to it', back.length === 3 && back.includes('p2') && (await missingChips()).length === 0 && (await changes()).join() === `font-size: ${p2rec.tweaks[0].declared === false ? 'added' : p2rec.tweaks[0].from} → 22px`, JSON.stringify({ back, ch: await changes() }));
    await closeNote(page);

    // All of the note's elements missing: nothing to edit, everything kept on Update.
    for (const t of ['p1', 'p2', 'p3']) await detach(T(t), `__all_${t}`);
    const full = await item(3);
    await openItem(3);
    const none = { ids: await ids(), chips: await missingChips(), hint: await ui(() => __BL.S.ui.root.querySelector('.x-sel > .sub')?.textContent) };
    await setNote('All three missing');
    await save();
    const kept = await item(3);
    check('All elements missing: three "Element not found" chips, nothing selected', none.ids.length === 0 && none.chips.length === 3 && none.hint === 'Not on the page right now. Its saved edits are kept.', JSON.stringify(none));
    check('All elements missing: Update changes the note and keeps every instance', kept.note === 'All three missing' && JSON.stringify(kept.elementEdits) === JSON.stringify(full.elementEdits) && JSON.stringify(kept.also) === JSON.stringify(full.also) && JSON.stringify(kept.el) === JSON.stringify(full.el), JSON.stringify(kept.elementEdits?.length));
    for (const t of ['p3', 'p2', 'p1']) await reattach(`__all_${t}`);

    // The note's own (first) element missing: the note keeps its details and that instance stays first.
    await shiftClick(page, await pointFor(page, '#hero-h', 'text'));
    await shiftClick(page, await pointFor(page, '#cta', { from: 'tl', dx: 5, dy: 10 }));
    await choose(0); await click('[data-x="tool-css"]'); await setCss('letter-spacing', '2px');
    await choose(1); await setCss('padding', '14px 24px');
    await save();
    const own = await item(4);
    await closeNote(page);
    await detach('#hero-h', '__hero');
    await openItem(4);
    const o = { ids: await ids(), chips: await missingChips(), card: (await card()).name };
    await setNote('Hero and button');
    await save();
    const ownAfter = await item(4);
    check('First element missing: the remaining element is edited, the missing one is flagged', o.ids.join() === 'cta' && o.chips.join() === 'Element not found: h2#hero-h' && o.card === 'Button “★ Shop now”', JSON.stringify(o));
    check('First element missing: Update keeps the note’s element details and its instance first', JSON.stringify(ownAfter.el) === JSON.stringify(own.el) && JSON.stringify(ownAfter.elementEdits[0]) === JSON.stringify(own.elementEdits[0]) && tweaks(ownAfter.elementEdits[1]) === tweaks(own.elementEdits[1]) && ownAfter.also.map((a) => a.selector).join() === own.also.map((a) => a.selector).join(), JSON.stringify(ownAfter.elementEdits.map((r) => r.el.selector)));
    {
      const text = await prompt();
      check('First element missing: the export keeps its selector and its correction', instanceBlock(text, own.elementEdits[0].el.selector).includes('letter-spacing') && text.includes('- Selector: `#hero-h`'), instanceBlock(text, own.elementEdits[0].el.selector));
    }
    await reattach('__hero');

    // A note saved before Slice 2A (one set of edits, text change on its first element) whose first element is gone.
    await ui(() => {
      const t1 = document.querySelector('[data-t="t1"]');
      const t3 = document.querySelector('[data-t="t3"]');
      const info = __BLUELINE_TEST__.api.describe(t1, 'polish');
      const r = t3.getBoundingClientRect();
      __BL.S.batch.items.push({ id: 'legacy2', note: 'Shorter, bolder titles', createdAt: Date.now(), ...info, priority: 'nice', bps: ['desktop'],
        tweaks: [{ prop: 'font-weight', from: '700', to: '800' }], textEdit: { before: 'Whey protein', after: 'Whey' },
        scope: { mode: 'one', count: 1, selector: 'h3.card-title', similar: 3, chosen: false },
        also: [{ label: 'h3.card-title', selector: __BLUELINE_TEST__.api.cssPath(t3), text: 'Magnesium', size: `${Math.round(r.width)}×${Math.round(r.height)}` }] });
      __BL.render();
    });
    const legacy = await item(5);
    await detach(T('t1'), '__t1');
    await openItem(5);
    const lg = { ids: await ids(), chips: await missingChips(), ch: await changes(), text: await ui(() => document.querySelector('[data-t="t3"]').textContent), strips: await ui(() => __BL.S.ui.root.querySelector('.x-strips').textContent) };
    check('Older note, first element missing: the other element keeps the shared CSS, not the first element’s text change', lg.ids.join() === 't3' && lg.chips.length === 1 && lg.ch.join() === 'font-weight: 700 → 800' && lg.text === 'Magnesium' && !lg.strips.includes('Whey'), JSON.stringify(lg));
    await save();
    const lgAfter = await item(5);
    const own0 = lgAfter.elementEdits?.[0];
    check('Older note, first element missing: Update keeps its type, its details and the missing element’s text and CSS change', lgAfter.type === 'polish' && JSON.stringify(lgAfter.el) === JSON.stringify(legacy.el) && own0?.el.selector === legacy.el.selector && own0.textEdit?.after === 'Whey' && tweaks(own0) === '[["font-weight","700","800"]]' && lgAfter.elementEdits[1]?.el.selector === legacy.also[0].selector && !lgAfter.elementEdits[1].textEdit, JSON.stringify(lgAfter.elementEdits));
    {
      const text = (await prompt()).split('\n## 6.')[1] || '';
      check('Older note, first element missing: the export keeps both corrections', instanceBlock(text, legacy.el.selector).includes('Copy change: “Whey protein” → “Whey”') && instanceBlock(text, legacy.el.selector).includes('font-weight 700 → 800') && instanceBlock(text, legacy.also[0].selector).includes('font-weight 700 → 800'), text);
    }
    await reattach('__t1');

    // A note from another page is never matched to elements on this one, and Update keeps its instances.
    await ui(() => { const it = JSON.parse(JSON.stringify(__BL.S.batch.items[3])); __BL.S.batch.items.push({ ...it, id: 'other1', path: '/elsewhere' }); __BL.render(); });
    const other = await item(6);
    await openItem(6);
    const oth = { ids: await ids(), chips: await missingChips(), edits: await ui(() => __BL.toolsApi.getP().edits.size) };
    await setNote('From another page');
    await save();
    const othAfter = await item(6);
    check('Note from another page: no elements here are picked up, and Update keeps its instances', oth.ids.length === 0 && oth.chips.length === 0 && oth.edits === 0 && othAfter.note === 'From another page' && JSON.stringify(othAfter.elementEdits) === JSON.stringify(other.elementEdits), JSON.stringify(oth));
  }

  // Switching tools keeps the webpage, the Blueline panel and the ribbon where they are.
  {
    const clickUI = async (sel) => {
      const p = await ui((sel) => { const r = __BL.S.ui.root.querySelector(sel).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
      await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up(); await sleep(120);
    };
    const where = () => ui(() => { const root = __BL.S.ui.root; return { pageY: Math.round(scrollY), panel: Math.round(root.querySelector('.panel').getBoundingClientRect().top), ribbon: Math.round(root.querySelector('.tool-ribbon').getBoundingClientRect().top), sel: (__BL.toolsApi.getP().els || []).map((e) => e.dataset.t).join() }; });
    await ui(() => { for (const at of ['afterbegin', 'beforeend']) document.body.insertAdjacentHTML(at, '<div class="tall-spacer" style="height:2400px"></div>'); document.querySelector('#grid').scrollIntoView({ block: 'center' }); });
    await sleep(80);
    await shiftClick(page, await pointFor(page, T('t1'), 'text'));
    await shiftClick(page, await pointFor(page, T('t2'), 'text'));
    await page.mouse.move(5, 5);
    await clickUI('[data-x="tool-css"]');
    // Scroll the note so the ribbon sits near the top of the panel, with the tall CSS section below it.
    await ui(() => { const pop = __BL.S.ui.root.querySelector('.pop'); pop.scrollTop += __BL.S.ui.root.querySelector('.tool-ribbon').getBoundingClientRect().top - pop.getBoundingClientRect().top - 20; });
    const start = await where();
    const seen = [];
    for (const tool of ['draw', 'align', 'elements', 'css', 'draw', 'align', 'align', 'elements', 'css', 'css', 'draw', 'css', 'elements']) {
      await clickUI(`[data-x="tool-${tool}"]`);
      seen.push({ tool, ...(await where()) });
    }
    const moved = seen.filter((s) => s.pageY !== start.pageY || s.panel !== start.panel || Math.abs(s.ribbon - start.ribbon) > 1);
    check('Switching tools never scrolls the webpage', seen.every((s) => s.pageY === start.pageY), JSON.stringify(seen.map((s) => s.pageY)));
    check('Switching tools keeps the panel and its ribbon in place, even from a tall section to a short one', !moved.length, JSON.stringify({ start, moved }));
    check('Switching tools keeps the selection', seen.every((s) => s.sel === 't1,t2'), JSON.stringify(seen.map((s) => s.sel)));
    const before = await where();
    const anchor = async () => ui(() => Math.round(__BL.S.ui.root.querySelector('[data-x="edittext"]').getBoundingClientRect().top));
    const a0 = await anchor();
    const edits = [];
    for (let i = 0; i < 2; i++) { await clickUI('[data-x="edittext"]'); edits.push(await anchor()); await page.keyboard.press('Escape'); await sleep(80); edits.push(await anchor()); }
    const after = await where();
    check('Edit text keeps the page and the panel in place', edits.every((y) => Math.abs(y - a0) <= 1) && after.pageY === before.pageY && after.panel === before.panel, JSON.stringify({ a0, edits, before, after }));
    // With an element alignment and a CSS change in the note, switching between Align and Edit CSS still holds everything still.
    await clickUI('[data-x="tool-css"]');
    await setCss('padding', '6px');
    await ui(() => { const P = __BL.toolsApi.getP(); const cta = document.getElementById('cta'); P.alignUi = { ...P.alignUi, mode: 'element', method: 'edges', ref: { el: cta, info: { label: 'button#cta', selector: '#cta', text: 'Shop now' } }, h: 'left', v: '' }; __BL.toolsApi.previewAlign(); });
    const mid = await where();
    const live = async () => ({ pad: await inline(T('t1'), 'padding'), tr: await inline(T('t1'), 'translate') });
    const m0 = await live();
    const seen2 = [];
    for (const tool of ['align', 'css', 'align', 'elements', 'css']) { await clickUI(`[data-x="tool-${tool}"]`); seen2.push({ ...(await where()), ...(await live()) }); }
    check('Switching between Align and Edit CSS with both kinds of change never scrolls the page or moves the ribbon, and keeps both previews', m0.pad === '6px' && m0.tr !== '' && seen2.every((s) => s.pageY === mid.pageY && s.panel === mid.panel && Math.abs(s.ribbon - mid.ribbon) <= 1 && s.sel === 't1,t2' && s.pad === m0.pad && s.tr === m0.tr), JSON.stringify({ mid, m0, seen2 }));
    await closeNote(page);
    await ui(() => { document.querySelectorAll('.tall-spacer').forEach((s) => s.remove()); window.scrollTo(0, 0); });
    await sleep(60);
  }

  // Align to an element: Guides or Element; Align edges or Place next to; the reference is chosen right after
  // Element; choices preview at once (no Apply); a stationary reference; independent axes; groups; guides.
  const rect = (sel) => ui((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2, w: r.width }; }, sel);
  const near = (a, b) => Math.abs(a - b) <= 1;
  const al = () => ui(() => { const root = __BL.S.ui.root; const P = __BL.toolsApi.getP(); const axes = root.querySelector('.al-axes:not([hidden])'); return { ref: root.querySelector('.al-ref').textContent, refEl: P.alignUi.ref?.el?.id || null, method: P.alignUi.method, h: axes?.querySelector('[data-al-h][aria-pressed="true"]')?.textContent, v: axes?.querySelector('[data-al-v][aria-pressed="true"]')?.textContent, mode: P.alignUi.mode, outline: !!root.querySelector('.refb'), pickBtn: root.querySelector('[data-x="al-pick"]').textContent, status: root.querySelector('.al-status').textContent, apply: !!root.querySelector('[data-x="al-apply"]') }; });
  const picking = () => ui(() => { const root = __BL.S.ui.root; const m = root.querySelector('.x-mini'); const r = m.getBoundingClientRect(); return { on: !!__BL.toolsApi.T.pick, mini: !m.hidden && r.width > 0, small: r.width < 360 && r.height < 70, text: [...m.querySelectorAll('.mini-h, .mini-step, button')].map((x) => x.textContent.trim()).join(' '), panelHidden: getComputedStyle(root.querySelector('.panel')).visibility === 'hidden', bar: !root.querySelector('.x-bar').hidden }; });
  // The button's own padding, so the pick is the button and not its label (and clear of saved-note badges).
  const CTA = ['#cta', { from: 'br', dx: -5, dy: -6 }];
  const pickAt = async (sel, spec) => { const p = await pointFor(page, sel, spec); await page.mouse.move(p.x, p.y, { steps: 3 }); await page.mouse.down(); await page.mouse.up(); await sleep(120); };
  const H = async (v) => { await click(`.al-axes:not([hidden]) [data-al-h="${v}"]`); await sleep(40); };
  const V = async (v) => { await click(`.al-axes:not([hidden]) [data-al-v="${v}"]`); await sleep(40); };
  const startElement = async () => { await click('[data-x="tool-align"]'); await click('[data-al-mode="element"]'); await sleep(60); };
  const undoBtn = async () => { await click('[data-x="undo"]'); await sleep(60); };
  const delLast = async () => { await ui(() => { const items = __BL.S.ui.root.querySelectorAll('.list .item'); items[items.length - 1].querySelector('[data-act="del"]').click(); }); await sleep(100); };
  const lastItem = () => ui(() => JSON.parse(JSON.stringify(__BL.S.batch.items.slice(-1)[0])));
  const lastBlock = async () => (await prompt()).split('\n---\n').slice(-1)[0];
  const openLast = async () => { await ui(() => { const items = __BL.S.ui.root.querySelectorAll('.list .item'); items[items.length - 1].click(); }); await sleep(700); };
  {
    await ui(() => { window.__ctaClicks = 0; document.getElementById('cta').addEventListener('click', () => { window.__ctaClicks++; }); });
    const cta0 = await rect('#cta');
    const t2a = await rect(T('t2'));

    // Choosing Element starts the reference pick at once; the panel steps aside for a compact toolbar.
    await shiftClick(page, await pointFor(page, T('t2'), 'text'));
    await click('[data-x="tool-align"]');
    const mode0 = await al();
    await click('[data-al-mode="element"]');
    await sleep(60);
    const auto = await picking();
    const selDuring = await ids();
    await pickAt(...CTA);
    const picked = await al();
    const after = await picking();
    check('Align offers Guides or Element; Guides is the default; there is no Apply button', mode0.mode === 'guides' && !mode0.apply, JSON.stringify(mode0));
    check('Choosing Element starts picking the reference right away (compact Blueline toolbar, selection kept)', auto.on && auto.mini && auto.small && auto.panelHidden && !auto.bar && auto.text.includes('Blueline · Align') && auto.text.includes('Click the element to align to') && selDuring.join() === 't2', JSON.stringify({ auto, selDuring }));
    check('The clicked element becomes the reference: outlined, not selected, its click not passed to the page, panel back', picked.refEl === 'cta' && picked.ref.startsWith('button#cta') && picked.outline && (await ids()).join() === 't2' && (await ui(() => window.__ctaClicks)) === 0 && !after.on && !after.mini && !after.panelHidden, JSON.stringify({ picked, after }));
    check('The reference shows its details and a Change button; Align edges is the default method', picked.pickBtn === 'Change' && picked.ref.includes('Shop now') && picked.method === 'edges', JSON.stringify(picked));

    // Align edges: each choice previews at once and replaces the previous one on its axis.
    await H('left');
    const l1 = await rect(T('t2'));
    check('Live preview: Left lines up the left edges at once; the vertical position is unchanged', near(l1.l, cta0.l) && near(l1.t, t2a.t), JSON.stringify({ l1, cta0, t2a }));
    await H('right');
    const r1 = await rect(T('t2'));
    await H('center');
    const c1 = await rect(T('t2'));
    await H('left');
    const l2 = await rect(T('t2'));
    check('Right, then Center, replace the previous choice: right edges, then centers line up', near(r1.r, cta0.r) && near(r1.t, t2a.t) && near(c1.cx, cta0.cx), JSON.stringify({ r1, c1, cta0 }));
    check('Switching choices back and forth never drifts: Left again lands exactly where Left did', Math.abs(l2.l - l1.l) < 0.5 && Math.abs(l2.t - l1.t) < 0.5, JSON.stringify({ l1, l2 }));
    await V('bottom');
    const v1 = await rect(T('t2'));
    await H('');
    const v2 = await rect(T('t2'));
    check('Independent axes: Bottom adds the vertical alignment and keeps the horizontal one', near(v1.b, cta0.b) && near(v1.l, cta0.l), JSON.stringify({ v1, cta0 }));
    check('None removes that axis only: horizontal back where it was, bottom still lined up', near(v2.l, t2a.l) && near(v2.b, cta0.b), JSON.stringify({ v2, t2a }));
    check('The reference never moves and gets no styles', JSON.stringify(await rect('#cta')) === JSON.stringify(cta0) && (await inline('#cta', 'translate')) === '');
    await undoBtn();
    const u1 = { r: await rect(T('t2')), ...(await al()) };
    check('Undo reverts the last choice only, and the panel shows that choice again', near(u1.r.l, cta0.l) && near(u1.r.b, cta0.b) && u1.h === 'Left' && u1.v === 'Bottom', JSON.stringify(u1));

    // Change starts a new pick; Esc cancels it. A selected element can't be the reference.
    await click('[data-x="al-pick"]');
    await sleep(60);
    const changing = await picking();
    await page.keyboard.press('Escape');
    await sleep(60);
    const esc = { ...(await picking()), ...(await al()), sel: await ids(), r: await rect(T('t2')) };
    check('Change picks a new reference; Esc cancels it and keeps the selection, reference and alignment', changing.on && changing.mini && !esc.on && !esc.mini && !esc.panelHidden && esc.refEl === 'cta' && esc.sel.join() === 't2' && near(esc.r.l, cta0.l), JSON.stringify(esc));
    await click('[data-x="al-pick"]');
    await sleep(60);
    await pickAt(T('t2'), 'text');
    const self = { ...(await al()), sel: await ids() };
    check('A selected element can’t be its own reference', self.refEl === 'cta' && self.sel.join() === 't2', JSON.stringify(self));
    // Changing the reference recalculates the current choices against the new one; changing back restores them.
    const lead = await rect('#lead');
    await click('[data-x="al-pick"]');
    await sleep(60);
    await pickAt('#lead', 'text');
    const toLead = { r: await rect(T('t2')), ...(await al()) };
    await click('[data-x="al-pick"]');
    await sleep(60);
    await pickAt(...CTA);
    const toCta = { r: await rect(T('t2')), ...(await al()) };
    check('Changing the reference recalculates the preview (Left + Bottom against the new reference), and back', toLead.refEl === 'lead' && near(toLead.r.l, lead.l) && near(toLead.r.b, lead.b) && toCta.refEl === 'cta' && near(toCta.r.l, cta0.l) && near(toCta.r.b, cta0.b) && JSON.stringify(await rect('#lead')) === JSON.stringify(lead), JSON.stringify({ toLead, toCta, lead }));

    // Guides keep working: create, drag, align, remove. A vertical guide replaces the horizontal element alignment only.
    await click('[data-al-mode="guides"]');
    const nG = await ui(() => (__BL.S.batch.guides || []).length);
    await click('.al-guides [data-x="g-h"]');
    await sleep(40);
    const hg = await ui(() => __BL.S.batch.guides.slice(-1)[0]);
    check('Guides: + Horizontal guide adds a horizontal guide', hg.axis === 'y' && (await ui(() => __BL.S.batch.guides.length)) === nG + 1, JSON.stringify(hg));
    await ui((id) => __BL.toolsApi.removeGuide(id), hg.id);
    await click('.al-guides [data-x="g-v"]');
    await sleep(60);
    const gid = await ui(() => __BL.S.batch.guides.slice(-1)[0].id);
    const g0 = await ui((id) => { const n = __BL.S.ui.root.querySelector(`.gd[data-id="${id}"] .hit`); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, pos: __BL.S.batch.guides.find((g) => g.id === id).pos }; }, gid);
    await page.mouse.move(g0.x, 120); await page.mouse.down(); await page.mouse.move(g0.x + 40, 120, { steps: 6 }); await page.mouse.up();
    await sleep(60);
    const gpos = await ui((id) => __BL.S.batch.guides.find((g) => g.id === id).pos, gid);
    check('Guides: a vertical guide can be dragged into place', Math.abs(gpos - g0.pos - 40) <= 7, JSON.stringify({ g0, gpos }));
    const gx = await ui((id) => __BL.S.batch.guides.find((g) => g.id === id).pos - scrollX, gid);
    await ui(() => { const row = [...__BL.S.ui.root.querySelectorAll('.align-rows .strip')].slice(-1)[0]; row.querySelector('.align-edge').value = 'left'; row.querySelector('[data-x="align-go"]').click(); });
    await sleep(60);
    const g1 = await rect(T('t2'));
    const ae = await ui(() => ({ a: __BL.toolsApi.getP().alignEl, h: __BL.toolsApi.getP().alignUi.h, v: __BL.toolsApi.getP().alignUi.v }));
    check('Guides still align: a vertical guide sets the left edge; the vertical element alignment stays', near(g1.l, gx) && near(g1.b, cta0.b) && !ae.a.x && ae.a.y?.edge === 'bottom' && ae.h === '' && ae.v === 'bottom', JSON.stringify({ g1, gx, ae }));
    await ui((id) => __BL.S.ui.root.querySelector(`.align-rows [data-x="g-del"][data-id="${id}"]`).click(), gid);
    await sleep(60);
    const g2 = await rect(T('t2'));
    check('Guides: removing a guide removes it and its alignment; the element alignment stays', near(g2.l, t2a.l) && near(g2.b, cta0.b) && (await ui((id) => !__BL.S.batch.guides.some((g) => g.id === id) && !__BL.S.ui.root.querySelector(`.gd[data-id="${id}"]`), gid)), JSON.stringify(g2));
    await closeNote(page);
    check('Cancel removes the alignment preview', near((await rect(T('t2'))).l, t2a.l) && near((await rect(T('t2'))).t, t2a.t));

    // Place next to: outside the reference's box, touching it, on each axis independently.
    await shiftClick(page, await pointFor(page, T('t3'), 'text'));
    const t3a = await rect(T('t3'));
    await startElement();
    await pickAt(...CTA);
    await click('[data-al-method="next"]');
    const nx = await ui(() => { const b = __BL.S.ui.root.querySelector('.al-axes:not([hidden])'); return { h: [...b.querySelectorAll('[data-al-h]')].map((x) => x.textContent).join('|'), v: [...b.querySelectorAll('[data-al-v]')].map((x) => x.textContent).join('|') }; });
    check('Place next to offers None / Left of / Center / Right of and None / Above / Middle / Below', nx.h === 'None|Left of|Center|Right of' && nx.v === 'None|Above|Middle|Below', JSON.stringify(nx));
    await H('right-of');
    const p1 = await rect(T('t3'));
    await V('below');
    const p2 = await rect(T('t3'));
    await H('left-of');
    const p3 = await rect(T('t3'));
    await V('above');
    const p4 = await rect(T('t3'));
    await H('');
    const p5 = await rect(T('t3'));
    check('Right of: just right of the reference, touching it, no gap; vertical position unchanged', near(p1.l, cta0.r) && near(p1.t, t3a.t), JSON.stringify({ p1, cta0, t3a }));
    check('Right of + Below: diagonally off the reference’s bottom-right corner', near(p2.l, cta0.r) && near(p2.t, cta0.b), JSON.stringify({ p2, cta0 }));
    check('Left of replaces Right of: its right edge touches the reference’s left edge (Below kept)', near(p3.r, cta0.l) && near(p3.t, cta0.b), JSON.stringify({ p3, cta0 }));
    check('Above replaces Below; None on horizontal puts the horizontal position back', near(p4.b, cta0.t) && near(p4.r, cta0.l) && near(p5.l, t3a.l) && near(p5.b, cta0.t), JSON.stringify({ p4, p5, cta0, t3a }));
    await click('[data-al-method="edges"]');
    const e1 = { r: await rect(T('t3')), ...(await al()) };
    await click('[data-al-method="next"]');
    const e2 = { r: await rect(T('t3')), ...(await al()) };
    check('Switching method recalculates: Align edges with no choice removes the placement; back to Place next to restores Above', e1.method === 'edges' && e1.h === 'None' && e1.v === 'None' && near(e1.r.l, t3a.l) && near(e1.r.t, t3a.t) && e2.method === 'next' && e2.v === 'Above' && e2.h === 'None' && near(e2.r.b, cta0.t) && near(e2.r.l, t3a.l), JSON.stringify({ e1, e2 }));
    check('Place next to keeps the reference stationary', JSON.stringify(await rect('#cta')) === JSON.stringify(cta0) && (await inline('#cta', 'translate')) === '');
    await save();
    const pn = await lastItem();
    const aeN = pn.elementEdits[0].alignEl;
    check('Saved: method, side, reference, shift and scope', aeN?.y?.method === 'next' && aeN.y.edge === 'above' && aeN.y.ref.selector === '#cta' && !aeN.x && typeof aeN.y.shift === 'number' && pn.elementEdits[0].scope.mode === 'one', JSON.stringify(pn.elementEdits[0]));
    {
      const text = await lastBlock();
      check('Export (Place next to): positioned immediately above the reference, which stays put', text.includes('Position `h3.card-title` (`#c3 > h3.card-title`) immediately above `button#cta` (`#cta`), outside its box and touching it. Keep `button#cta` stationary.') && (await prompt()).includes('not a fixed offset or transform') && !text.includes('Build it with the layout'), text);
    }
    await delLast();

    // Align edges, Top + Right on one element; saved and exported as a relationship.
    await shiftClick(page, await pointFor(page, T('t3'), 'text'));
    await startElement();
    await pickAt(...CTA);
    await H('right');
    await V('top');
    const tr = await rect(T('t3'));
    check('Align edges, Top + Right: both edges line up', near(tr.r, cta0.r) && near(tr.t, cta0.t), JSON.stringify({ tr, cta0 }));
    await save();
    const one = await lastItem();
    const ae1 = one.elementEdits?.[0]?.alignEl;
    check('Saved: the element alignment keeps target, reference, method, both axes, shifts and scope', (await resolves(one.elementEdits[0].el.selector, T('t3'))) && ae1?.x?.edge === 'right' && ae1?.y?.edge === 'top' && ae1.x.method === 'edges' && ae1.x.ref.selector === '#cta' && ae1.x.ref.label === 'button#cta' && typeof ae1.x.shift === 'number' && one.elementEdits[0].scope.mode === 'one', JSON.stringify(one.elementEdits?.[0]));
    {
      const text = await lastBlock();
      check('Export (Align edges): the top and right edges line up with the reference, which stays put', text.includes('Align the top and right edges of `h3.card-title` (`#c3 > h3.card-title`) with `button#cta` (`#cta`). Keep `button#cta` stationary.') && (await prompt()).includes('not a fixed offset or transform') && text.includes('Alignment (described above) was previewed with a shift of'), text);
    }
    await delLast();

    // Groups: three prices move as one box and keep their spacing, with either method.
    const ts = await Promise.all(['p1', 'p2', 'p3'].map((t) => rect(T(t))));
    for (const t of ['p1', 'p2', 'p3']) await shiftClick(page, await pointFor(page, T(t), 'text'));
    await startElement();
    await pickAt(...CTA);
    await H('center');
    const gs = await Promise.all(['p1', 'p2', 'p3'].map((t) => rect(T(t))));
    const box = { l: Math.min(...gs.map((r) => r.l)), r: Math.max(...gs.map((r) => r.r)) };
    const kept = gs.every((r, i) => near(r.l - gs[0].l, ts[i].l - ts[0].l) && near(r.t, ts[i].t));
    check('Group alignment: the combined box is centred on the reference', near((box.l + box.r) / 2, cta0.cx), JSON.stringify({ box, cta0 }));
    check('Group alignment: the elements keep their positions relative to each other', kept, JSON.stringify({ ts, gs }));
    await click('[data-al-method="next"]');
    await V('below');
    const gb = await Promise.all(['p1', 'p2', 'p3'].map((t) => rect(T(t))));
    check('Place next to, group: the combined box sits just below the reference; spacing kept; horizontal unchanged', near(Math.min(...gb.map((r) => r.t)), cta0.b) && gb.every((r, i) => near(r.l, ts[i].l) && near(r.t - gb[0].t, ts[i].t - ts[0].t)), JSON.stringify({ gb, ts, cta0 }));
    check('Group placement never moves the reference', JSON.stringify(await rect('#cta')) === JSON.stringify(cta0));
    await click('[data-al-method="edges"]');
    const back = await Promise.all(['p1', 'p2', 'p3'].map((t) => rect(T(t))));
    check('Back to Align edges restores its own choice (Center) for the group', back.every((r, i) => near(r.l, gs[i].l) && near(r.t, ts[i].t)), JSON.stringify({ back, gs }));
    await save();
    const grp = await lastItem();
    const xs = grp.elementEdits.map((e) => e.alignEl?.x);
    check('Saved group: every element has the same reference, method, edge, group and shift', xs.length === 3 && xs.every((x) => x && x.edge === 'center' && x.method === 'edges' && x.ref.selector === '#cta' && x.group.id === xs[0].group.id && x.group.size === 3 && x.shift === xs[0].shift) && grp.elementEdits.every((e) => !e.alignEl.y), JSON.stringify(xs));
    {
      const text = await lastBlock();
      check('Export: the group’s horizontal center lines up with the reference, keeping its spacing', text.includes('Align the horizontal center of these 3 selected elements, taken as one group (`p.card-price`, `p.card-price`, `p.card-price`) using their combined bounding box, with `button#cta` (`#cta`). Keep `button#cta` stationary, and keep the selected elements in the same positions relative to each other.') && (text.match(/Alignment \(described above\) was previewed/g) || []).length === 3, text);
    }
    await openLast();
    const reopened = { ...(await al()), tool: (await shown()).pressed.join(), ch: await changes(), r: await Promise.all(['p1', 'p2', 'p3'].map((t) => rect(T(t)))) };
    check('Reopened: the alignment is restored with its reference and choices', reopened.mode === 'element' && reopened.method === 'edges' && reopened.refEl === 'cta' && reopened.h === 'Center' && reopened.v === 'None' && reopened.tool === 'Align' && reopened.ch.join() === 'Aligned horizontal center with button#cta (' + xs[0].shift + 'px)' && reopened.r.every((r, i) => near(r.l, gs[i].l)), JSON.stringify(reopened));
    await closeNote(page);
    // Missing-element preservation also covers element alignment.
    await ui(() => { const e = document.querySelector('[data-t="p2"]'); window.__t2gone = { e, p: e.parentNode, n: e.nextSibling }; e.remove(); });
    await openLast();
    await save();
    const kept2 = await lastItem();
    await ui(() => { const k = window.__t2gone; k.p.insertBefore(k.e, k.n); });
    await delLast();
    check('Missing element: its saved alignment is kept on Update', JSON.stringify(kept2.elementEdits.find((e) => e.el.selector === grp.elementEdits[1].el.selector)) === JSON.stringify(grp.elementEdits[1]), JSON.stringify(kept2.elementEdits.map((e) => e.el.selector)));

    // Align and Edit CSS in one note: Place next to → Below, then margin and width, switching back and forth.
    await shiftClick(page, await pointFor(page, T('t1'), 'text'));
    const t1a = await rect(T('t1'));
    await startElement();
    await pickAt(...CTA);
    await click('[data-al-method="next"]');
    await V('below');
    const f1 = await rect(T('t1'));
    await click('[data-x="tool-css"]');
    await setCss('margin', '24px 0px 6px');
    await setCss('width', '200');
    const f2 = await rect(T('t1'));
    // The taller card moves the button down; the relationship follows the button where it is now.
    const ctaNow = await rect('#cta');
    check('Place next to + Edit CSS: below the reference, and the added top margin becomes the space between them', near(f1.t, cta0.b) && near(f2.t, ctaNow.b + 24) && (await inline(T('t1'), 'width')) === '200px' && near(f2.l, t1a.l), JSON.stringify({ f1, f2, ctaNow, t1a }));
    await click('[data-x="tool-align"]');
    const inAlign = { ...(await al()), y: await ui(() => __BL.toolsApi.getP().alignEl?.y?.edge), m: await inline(T('t1'), 'margin'), w: await inline(T('t1'), 'width'), r: await rect(T('t1')) };
    check('Switching to Align keeps the CSS changes, and the placement is still active', inAlign.method === 'next' && inAlign.v === 'Below' && inAlign.y === 'below' && inAlign.m === '24px 0px 6px' && inAlign.w === '200px' && near(inAlign.r.t, (await rect('#cta')).b + 24), JSON.stringify(inAlign));
    await click('[data-x="tool-css"]');
    const rows = await ui(() => ({ m: __BL.S.ui.root.querySelector('.st[data-prop="margin"] .sv').value, w: __BL.S.ui.root.querySelector('.st[data-prop="width"] .sv').value }));
    const both = await changes();
    check('Back in Edit CSS the values are kept, and Changes lists the CSS values and the placement together', rows.m === '24px 0px 6px' && rows.w === '200' && both.some((c) => c.startsWith('margin: 0 0 6px → 24px 0px 6px')) && both.some((c) => c.startsWith('width:')) && both.some((c) => c.startsWith('Placed below button#cta')), JSON.stringify({ rows, both }));
    await undoBtn();
    const un = { r: await rect(T('t1')), w: await inline(T('t1'), 'width'), m: await inline(T('t1'), 'margin'), y: await ui(() => __BL.toolsApi.getP().alignEl?.y?.edge) };
    check('Undo reverts the width only; the placement and the margin stay', un.w === '' && un.m === '24px 0px 6px' && near(un.r.t, (await rect('#cta')).b + 24) && un.y === 'below', JSON.stringify(un));
    await click('.chg button[data-prop="margin"]');
    const rm = { r: await rect(T('t1')), m: await inline(T('t1'), 'margin'), y: await ui(() => __BL.toolsApi.getP().alignEl?.y?.edge) };
    check('✕ on the margin change reverts it and the placement follows (touching the reference again)', rm.m === '' && near(rm.r.t, (await rect('#cta')).b) && rm.y === 'below', JSON.stringify(rm));
    await setCss('width', '180');
    await click('[data-x="style-reset"]');
    check('Reset all in Edit CSS puts the CSS values back and keeps the placement', (await inline(T('t1'), 'width')) === '' && near((await rect(T('t1'))).t, (await rect('#cta')).b) && (await ui(() => __BL.toolsApi.getP().alignEl?.y?.edge)) === 'below');
    await setCss('margin', '24px 0px 6px');
    await setCss('width', '200');
    const beforeSave = await rect(T('t1'));
    await ui(() => { __BL.S.ui.root.querySelector('.pop-note').value = 'Heading under the button'; });
    await save();
    const cm = await lastItem();
    const rec = cm.elementEdits[0];
    check('Saved: one note holds the placement (method, side, reference, shift) and the CSS values', rec.alignEl?.y?.method === 'next' && rec.alignEl.y.edge === 'below' && rec.alignEl.y.ref.selector === '#cta' && JSON.stringify(rec.tweaks.filter((t) => !t.snap).map((t) => [t.prop, t.to])) === '[["margin","24px 0px 6px"],["width","200px"]]' && rec.tweaks.some((t) => t.snap && t.prop === 'translate'), JSON.stringify(rec));
    {
      const text = await lastBlock();
      const block = instanceBlock(text, rec.el.selector);
      check('Export: the relationship and the CSS values together, with no fixed offset', text.includes('Position `h3.card-title` (`#c1 > h3.card-title`) immediately below `button#cta` (`#cta`), outside its box and touching it. Keep `button#cta` stationary. Apply the CSS changes listed below as part of it; the gap comes from the margin change, not an extra offset.') && block.includes('margin: 0 0 6px → 24px 0px 6px') && block.includes('width: added → 200px') && block.includes('with the CSS values above applied'), text);
    }
    await openLast();
    const ro = { ...(await al()), tool: (await shown()).pressed.join(), ch: await changes(), r: await rect(T('t1')), m: await inline(T('t1'), 'margin'), w: await inline(T('t1'), 'width') };
    check('Reopened: the placement and the CSS values both come back', ro.mode === 'element' && ro.method === 'next' && ro.v === 'Below' && ro.refEl === 'cta' && ro.m === '24px 0px 6px' && ro.w === '200px' && near(ro.r.t, beforeSave.t) && ro.ch.some((c) => c.startsWith('margin:')) && ro.ch.some((c) => c.startsWith('Placed below')), JSON.stringify(ro));
    // Editing the reopened note: the change and the worked-out placement stay (saved previews don't overwrite them).
    await click('[data-x="tool-css"]');
    await setCss('margin', '30px 0px 6px');
    await sleep(1000);
    const re = { m: await inline(T('t1'), 'margin'), r: await rect(T('t1')), cta: await rect('#cta') };
    check('Editing a reopened note: a new margin keeps the placement and isn’t overwritten by the saved preview', re.m === '30px 0px 6px' && near(re.r.t, re.cta.b + 30), JSON.stringify(re));
    await closeNote(page);
    await delLast();

    // A note saved before the two methods existed (alignEl without a method) still exports, reopens and updates.
    await ui(() => {
      const t2 = document.querySelector('[data-t="t2"]');
      const info = __BLUELINE_TEST__.api.describe(t2, 'change');
      const el = { label: 'h3.card-title', selector: __BLUELINE_TEST__.api.cssPath(t2), text: 'Creatine', size: '1×1' };
      __BL.S.batch.items.push({ id: 'oldalign', note: '', createdAt: Date.now(), ...info, bps: ['desktop'],
        elementEdits: [{ el, scope: { mode: 'one', count: 1, selector: 'h3.card-title', similar: 3, chosen: false }, tweaks: [{ prop: 'translate', from: 'none', to: '12px 0px', snap: true }], textEdit: null, hidden: false, match: null, move: null, align: [], measures: [],
          alignEl: { x: { edge: 'left', ref: { label: 'button#cta', selector: '#cta', text: 'Shop now' }, shift: 12, group: { id: 'g-old', size: 1 } }, y: null } }] });
      __BL.render();
    });
    const old = await lastItem();
    {
      const text = await lastBlock();
      check('Older alignment note (no method) exports as Align edges', text.includes('Align the left edge of `h3.card-title` (`#c2 > h3.card-title`) with `button#cta` (`#cta`). Keep `button#cta` stationary.'), text);
    }
    await openLast();
    const oa = await al();
    await save();
    const upd = await lastItem();
    check('Older alignment note reopens as Align edges / Left and Update keeps it as saved', oa.mode === 'element' && oa.method === 'edges' && oa.h === 'Left' && oa.refEl === 'cta' && JSON.stringify(upd.elementEdits[0].alignEl) === JSON.stringify(old.elementEdits[0].alignEl), JSON.stringify({ oa, a: upd.elementEdits[0].alignEl }));
    await delLast();
  }

  // Several elements: a compact summary by default; the full list on request; instance editing kept.
  {
    for (const t of ['t1', 't2', 't3', 'p1', 'p2', 'p3']) await shiftClick(page, await pointFor(page, T(t), 'text'));
    await shiftClick(page, await pointFor(page, '#cta', { from: 'br', dx: -5, dy: -6 }));
    const sum = () => ui(() => { const root = __BL.S.ui.root; const list = root.querySelector('.sel-list'); return { title: root.querySelector('.sel-sum .tb-h')?.textContent, btn: root.querySelector('[data-x="sel-showall"]')?.textContent, listHidden: !!list?.hidden, rows: list ? list.querySelectorAll('.sel-row').length : 0, chips: root.querySelectorAll('.x-sel .tchip').length, editing: list?.querySelector('.sel-tag')?.closest('.sel-row')?.textContent || '', step1: Math.round(root.querySelector('.x-sel').getBoundingClientRect().height), dupList: !!root.querySelector('.element-editor details') }; });
    const c0 = await sum();
    check('Seven selected: compact summary, list collapsed, no duplicate list in the card', c0.title === 'Selected elements (7)' && c0.btn === 'Show all 7 elements' && c0.listHidden && c0.chips === 7 && !c0.dupList && c0.step1 < 200, JSON.stringify({ ...c0, ids: await ids() }));
    await choose(2);
    await setCss('font-size', '26');
    await choose(4);
    const cardNow = await card();
    await click('[data-x="sel-showall"]');
    const c1 = await sum();
    check('Show all lists every element, marks the one being edited', !c1.listHidden && c1.rows === 7 && c1.btn === 'Hide list' && c1.editing.includes('$19.99') && cardNow.of === 'Editing 5 of 7', JSON.stringify({ c1, cardNow }));
    await ui(() => __BL.S.ui.root.querySelectorAll('.sel-row')[2].querySelector('[data-x="edit-element"]').click());
    const c2 = await card();
    check('Edit in the list switches the instance, which keeps its own changes', c2.of === 'Editing 3 of 7' && (await changes()).join() === 'font-size: 18px → 26px', JSON.stringify({ c2, ch: await changes() }));
    await ui(() => __BL.S.ui.root.querySelectorAll('.sel-row')[6].querySelector('[data-x="sel-rm"]').click());
    const c3 = await sum();
    check('Removing an element from the list still works', c3.title === 'Selected elements (6)' && (await ids()).length === 6 && !(await ids()).includes('cta'), JSON.stringify(c3));
    await click('[data-x="sel-showall"]');
    check('The list collapses again', (await sum()).listHidden);
    await closeNote(page);
  }
  // Measure in the Toolbox: a compact floating toolbar while picking, Cancel and Esc, and Show / Hide.
  {
    const meas = () => ui(() => { const root = __BL.S.ui.root; const P = __BL.toolsApi.getP(); return { n: P.measures.length, drawn: root.querySelector('.x-meas').childNodes.length, btns: [...root.querySelectorAll('.measure-row .measure-actions')].map((a) => a.querySelector('.xb').textContent), section: !root.querySelector('.tb-measure').hidden, tool: [...root.querySelectorAll('[data-tool-panel]')].filter((p) => !p.hidden).map((p) => p.dataset.toolPanel).join() }; });
    const view = () => ui(() => ({ pageY: scrollY, panel: Math.round(__BL.S.ui.root.querySelector('.panel').getBoundingClientRect().top), pop: Math.round(__BL.S.ui.root.querySelector('.pop').scrollTop) }));

    // Nothing selected: "Blueline · Measure, Select element 1 of 2", then "2 of 2", then the panel is back.
    await click('[data-x="add-note"]');
    await sleep(80);
    const v0 = await view();
    await click('[data-x="tb-measure"]');
    await sleep(60);
    const s1 = await picking();
    await pickAt(T('t1'), 'text');
    const s2 = await picking();
    await pickAt(T('p2'), 'text');
    const s3 = await picking();
    const m1 = await meas();
    check('Measure from the Toolbox minimizes the panel to a compact toolbar: step 1 of 2 and Cancel', s1.on && s1.mini && s1.small && s1.panelHidden && !s1.bar && s1.text === 'Blueline · Measure Select element 1 of 2 Cancel', JSON.stringify(s1));
    check('After the first element the toolbar shows step 2 of 2 and stays put', s2.on && s2.mini && s2.panelHidden && s2.text.includes('Select element 2 of 2'), JSON.stringify(s2));
    check('On completion the panel comes back on the Toolbox with the measurement listed and drawn', !s3.on && !s3.mini && !s3.panelHidden && m1.n === 1 && m1.drawn > 0 && m1.section && m1.tool === 'elements' && (await ids()).join() === 't1', JSON.stringify({ s3, m1 }));
    check('Measuring never scrolls the webpage or moves the panel', (await view()).pageY === v0.pageY && (await view()).panel === v0.panel, JSON.stringify({ v0, v1: await view() }));

    // No Show / Hide on measurements (Toolbox → Hide is for page elements). A new measurement is visible; selecting a
    // row in the list draws that one; tool switching leaves the overlay alone; everything stays in the note.
    const noHide = () => ui(() => { const root = __BL.S.ui.root; return { hide: root.querySelectorAll('[data-x="measure-hide"]').length, rowTexts: [...root.querySelectorAll('.measure-row .measure-actions .xb')].map((b) => b.textContent), pick: root.querySelectorAll('.measure-row .measure-pick').length }; });
    const nh = await noHide();
    check('A measurement has no Hide or Show button; it offers Change target and Remove, and its row can be selected', nh.hide === 0 && nh.rowTexts.join() === 'Change target,Remove' && nh.pick === 1, JSON.stringify(nh));
    check('A new measurement is visible when created', m1.drawn > 0, JSON.stringify(m1));
    for (const t of ['css', 'align', 'draw', 'elements']) await click(`[data-x="tool-${t}"]`);
    const h2 = await meas();
    check('Switching tools doesn’t change the measurement overlay', h2.drawn > 0 && h2.n === 1, JSON.stringify(h2));
    await click('[data-x="measure-new"]');
    await sleep(60);
    const s4 = await picking();
    await pickAt(T('p3'), 'text');
    const two = await meas();
    const cur = () => ui(() => [...__BL.S.ui.root.querySelectorAll('.measure-row')].map((r) => r.classList.contains('current')).join());
    check('A second measurement is visible by default and becomes the selected row', s4.mini && s4.text.includes('Select the element to measure to') && two.n === 2 && two.drawn > 0 && (await cur()) === 'false,true', JSON.stringify({ s4, two }));
    const ovBefore = await ui(() => __BL.S.ui.root.querySelector('.x-meas').innerHTML);
    await ui(() => __BL.S.ui.root.querySelectorAll('.measure-row')[0].querySelector('[data-x="measure-show"]').click());
    const two2 = await meas();
    const ovAfter = await ui(() => __BL.S.ui.root.querySelector('.x-meas').innerHTML);
    check('Selecting the other measurement in the list shows that one instead (one at a time)', (await cur()) === 'true,false' && two2.drawn > 0 && ovAfter !== ovBefore, JSON.stringify({ cur: await cur(), two2 }));
    // Toolbox → Hide hides the selected page element and has nothing to do with measurements.
    await click('[data-x="tool-elements"]');
    const hideBtn = await ui(() => { const b = [...__BL.S.ui.root.querySelectorAll('.tool-action')].find((x) => /Hide|Show/.test(x.textContent)); return { text: b?.textContent.trim(), x: b?.dataset.x }; });
    await click(`[data-x="${hideBtn.x}"]`);
    const hid = await ui(() => ({ display: getComputedStyle(document.querySelector('[data-t="t1"]')).display, hasHide: __BL.toolsApi.getP().hide, measures: __BL.toolsApi.getP().measures.length, hideBtns: __BL.S.ui.root.querySelectorAll('[data-x="measure-hide"]').length, rows: __BL.S.ui.root.querySelectorAll('.measure-row').length }));
    check('Toolbox Hide hides the selected page element and leaves the measurements as they are', hid.display === 'none' && hid.hasHide === true && hid.measures === 2 && hid.hideBtns === 0 && hid.rows === 2, JSON.stringify(hid));
    await click(`[data-x="${hideBtn.x}"]`);
    check('Toolbox Hide again shows the element', (await ui(() => getComputedStyle(document.querySelector('[data-t="t1"]')).display)) !== 'none');
    await ui(() => { __BL.S.ui.root.querySelector('.pop-note').value = 'Spacing check'; });
    await save();
    const it = await lastItem();
    const text = await lastBlock();
    check('Both measurements stay in the saved note and in the export', it.elementEdits[0].measures.length === 2 && (text.match(/Reference measurement to/g) || []).length === 2, JSON.stringify(it.elementEdits[0].measures));
    await delLast();

    // Cancelling restores the panel and leaves the note as it was.
    await click('[data-x="add-note"]');
    await sleep(80);
    await click('[data-x="tb-measure"]');
    await sleep(60);
    await pickAt(T('t2'), 'text');
    await page.keyboard.press('Escape');
    await sleep(80);
    const c1 = { ...(await picking()), ...(await meas()), ids: await ids(), open: await ui(() => !!__BL.S.pop) };
    check('Esc at step 2 restores the panel, keeps the note open and saves nothing (the first pick isn’t kept)', !c1.on && !c1.mini && !c1.panelHidden && c1.open && c1.n === 0 && c1.ids.length === 0, JSON.stringify(c1));
    await click('[data-x="tb-measure"]');
    await sleep(60);
    const c2a = await picking();
    await click('.x-mini [data-x="bar-cancel"]');
    await sleep(60);
    const c2 = { ...(await picking()), ...(await meas()), open: await ui(() => !!__BL.S.pop) };
    check('The toolbar’s Cancel button does the same', c2a.on && c2a.mini && !c2.on && !c2.mini && !c2.panelHidden && c2.open && c2.n === 0, JSON.stringify({ c2a, c2 }));
    await closeNote(page);

    // With one element selected and an unsaved CSS change: step 2 of 2; Esc keeps both, nothing scrolls.
    await shiftClick(page, await pointFor(page, T('t2'), 'text'));
    await click('[data-x="tool-css"]');
    await setCss('font-size', '26');
    await click('[data-x="tool-elements"]');
    const before = await view();
    await click('[data-x="tb-measure"]');
    await sleep(60);
    const sx = await picking();
    await page.keyboard.press('Escape');
    await sleep(80);
    const ax = { ...(await picking()), ...(await view()), ids: await ids(), fs: await inline(T('t2'), 'font-size') };
    check('One element selected: Measure asks for element 2 of 2; Esc keeps the selection and the unsaved CSS change, with no scrolling', sx.on && sx.text.includes('Select element 2 of 2') && !ax.on && !ax.panelHidden && ax.ids.join() === 't2' && ax.fs === '26px' && ax.pageY === before.pageY && ax.panel === before.panel && ax.pop === before.pop, JSON.stringify({ sx, ax, before }));
    await closeNote(page);
  }
  check('No page errors (toolbox.html)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 5. CSS rule discovery
console.log('\n# CSS rule discovery (fixtures/css-rules.html, served over http)');
{
  const page = await open('css-rules.html', { http: true });
  const rulesOf = (id) => page.evaluate((id) => { const r = __BLUELINE_TEST__.api.cssRulesFor(document.getElementById(id)); return JSON.parse(JSON.stringify({ ...r, rules: r.rules.map(({ cssText, ...x }) => x) })); }, id);
  const sheetsText = () => page.evaluate(() => [...document.styleSheets].map((s) => { try { return [...s.cssRules].map((r) => r.cssText).join('\n'); } catch { return 'blocked'; } }).join('\n---\n'));
  const before = await sheetsText();
  const r1 = await rulesOf('pt-1');
  const decl = (rule, prop) => rule?.decls.find((d) => d.prop === prop);
  const base = r1.rules.find((r) => r.matched === '.product-title' && r.source.label === '<style id="base">' && decl(r, 'font-size'));
  check('Class rule: authored values kept (rem, var(), shorthand margin as written)', !!base && decl(base, 'font-size').value === '1.5rem' && decl(base, 'color').value === 'var(--brand-color)' && decl(base, 'margin').value === '0 0 16px' && !decl(base, 'margin-top') && base.kind === 'class', JSON.stringify(base?.decls));
  check('Rule identity: selector, source, source order and a rule path', base?.selector === '.product-title' && base.source.kind === 'style' && typeof base.order === 'number' && /^\d+\/\d+$/.test(base.path) && base.specificity.join() === '0,1,0', JSON.stringify(base && { s: base.source, p: base.path }));
  const list = r1.rules.find((r) => r.selector.includes('.promo-heading'));
  check('Selector list: only the matching part is reported, with its classes', list?.matched === '.product-title.featured' && list.selector === '.product-title.featured, .promo-heading' && list.classes.join() === 'product-title,featured' && list.specificity.join() === '0,2,0', JSON.stringify(list));
  const promo = (await rulesOf('promo')).rules.find((r) => r.selector.includes('.promo-heading'));
  check('Selector list on another element: its own part matches', promo?.matched === '.promo-heading', JSON.stringify(promo));
  const idr = r1.rules.find((r) => r.matched === '#pt-1');
  check('ID rule: kind "id", specificity 1,0,0', idr?.kind === 'id' && idr.specificity.join() === '1,0,0' && decl(idr, 'letter-spacing')?.value === '0.5px', JSON.stringify(idr));
  const tag = r1.rules.find((r) => r.matched === 'h2');
  check('Type rule: kind "other"', tag?.kind === 'other' && decl(tag, 'line-height')?.value === '1.2', JSON.stringify(tag));
  const ctx = (c) => r1.rules.filter((r) => r.context === c);
  check('Media: a matching @media rule is listed with its condition; a non-matching one and a print sheet are not', ctx('@media (min-width: 600px)').length === 1 && decl(ctx('@media (min-width: 600px)')[0], 'padding-top')?.value === '4px' && ctx('@media (min-width: 600px)')[0].media === '@media (min-width: 600px)' && !r1.rules.some((r) => decl(r, 'padding-top')?.value === '99px' || r.source.label === 'rules-print.css'), JSON.stringify(r1.rules.map((r) => r.context)));
  check('@supports: a supported condition is listed, an unsupported one is not', ctx('@supports (display: grid)').length === 1 && !r1.rules.some((r) => decl(r, 'outline')), JSON.stringify(r1.rules.map((r) => r.context)));
  const cq = r1.rules.find((r) => r.context.startsWith('@container'));
  check('@container: kept but marked uncertain (can’t be checked); other rules are not', cq?.uncertain === true && cq.media === '@container card (min-width: 100px)' && r1.rules.filter((r) => r.uncertain).length === 1, JSON.stringify(cq));
  const layer = r1.rules.find((r) => r.layer === 'theme');
  check('@layer: the layer name is recorded', layer?.context === '@layer theme' && decl(layer, 'border-radius')?.value === '4px', JSON.stringify(layer));
  const nested = r1.rules.find((r) => decl(r, 'column-gap'));
  check('Nested rule: resolved against its parent and matched', !!nested && nested.matched.includes('.card') && nested.matched.includes('.product-title') && nested.authored === '& .product-title', JSON.stringify(nested));
  const imp = r1.rules.find((r) => decl(r, 'margin-bottom'));
  check('!important is flagged', imp?.decls.length === 1 && decl(imp, 'margin-bottom').important === true && decl(imp, 'margin-bottom').value === '8px' && decl(base, 'font-size').important === false, JSON.stringify(imp));
  const linked = r1.rules.find((r) => r.source.label === 'rules-linked.css');
  const imported = r1.rules.find((r) => r.source.kind === 'import');
  check('Linked and @import-ed stylesheets are read, the import names its parent', decl(linked, 'text-transform')?.value === 'uppercase' && imported?.source.label === 'rules-imported.css (imported by rules-linked.css)' && decl(imported, 'word-spacing')?.value === '1px' && imported.order < linked.order, JSON.stringify({ linked: linked?.source, imported: imported?.source }));
  const adopted = r1.rules.find((r) => r.source.kind === 'adopted');
  check('Adopted stylesheet rules are read', adopted?.source.label === 'adopted stylesheet 1' && decl(adopted, 'font-style')?.value === 'normal' && adopted.order === Math.max(...r1.rules.map((r) => r.order)), JSON.stringify(adopted?.source));
  check('Pseudo-element and :hover rules are not reported as matching', !r1.rules.some((r) => decl(r, 'content') || decl(r, 'text-decoration')), JSON.stringify(r1.rules.map((r) => r.matched)));
  check('Inline style attribute: its declarations, as written', r1.inline?.kind === 'inline' && r1.inline.decls.length === 1 && r1.inline.decls[0].prop === 'outline' && r1.inline.decls[0].value === '0px solid transparent', JSON.stringify(r1.inline));
  check('Cross-origin stylesheet: counted and named, its rules skipped, nothing thrown', r1.blocked === 1 && r1.blockedSources.length === 1 && r1.blockedSources[0].endsWith('/css/rules-cross.css') && !r1.rules.some((r) => decl(r, 'opacity')), JSON.stringify({ b: r1.blocked, s: r1.blockedSources }));
  const stack = (await rulesOf('stack')).rules[0];
  check('Custom properties and var() shorthands are declarations like any other', decl(stack, '--stack-gap')?.value === '8px' && decl(stack, 'padding')?.value === 'var(--pad) 12px' && !decl(stack, 'padding-top'), JSON.stringify(stack?.decls));
  const tw = await rulesOf('tw');
  const util = Object.fromEntries(tw.rules.map((r) => [r.matched, r.utility]));
  check('Utility classes are flagged (Tailwind-style names); a component class on the same element is not', tw.tailwind && util['.flex'] && util['.p-4'] && util['.text-lg'] && util['.font-bold'] && util['.mt-2'] && util['.tw-card'] === false && decl(tw.rules.find((r) => r.matched === '.tw-card'), 'border')?.value === '1px solid #ddd', JSON.stringify(util));
  const plain = await rulesOf('plain');
  check('Inherited-only element: no rules and no inline declarations (nothing inherited is reported)', plain.rules.length === 0 && plain.inline.decls.length === 0, JSON.stringify(plain.rules.map((r) => r.matched)));
  const legacy = await page.evaluate(() => { const el = document.getElementById('pt-1'); const a = __BLUELINE_TEST__.api.matchedRules(el); const b = __BLUELINE_TEST__.api.matchedRules(document.getElementById('tw'), true); return { n: a.rules.length, keys: Object.keys(a.rules[0] || {}).join(), blocked: a.blocked, media: a.rules.map((r) => r.media).filter(Boolean), tw: b.rules.map((r) => r.sel) }; });
  check('Inspection view (matchedRules) keeps its shape: last 8 rules as {sel, file, media, decl}, blocked count, utilities skipped on request', legacy.n === 8 && legacy.keys === 'sel,file,media,decl' && legacy.blocked === 1 && legacy.media.includes('@container card (min-width: 100px)') && legacy.tw.length === 0, JSON.stringify(legacy));
  check('Discovery never changes the page’s stylesheets', (await sheetsText()) === before);
  check('No page errors (css-rules.html, discovery)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 6. Contextual CSS editor
console.log('\n# Contextual CSS editor: rule picker, declared rows, Add CSS property (fixtures/css-rules.html)');
{
  const page = await open('css-rules.html', { http: true });
  const ui = (fn, ...a) => page.evaluate(fn, ...a);
  const click = (sel) => ui((sel) => __BL.S.ui.root.querySelector(sel).click(), sel);
  const inline = (sel, prop) => ui((sel, prop) => document.querySelector(sel).style.getPropertyValue(prop), sel, prop);
  const changes = () => ui(() => [...__BL.S.ui.root.querySelectorAll('.css-changes .chg > span')].map((s) => s.textContent.replace(/\s+/g, ' ').trim()));
  const editor = () => ui(() => {
    const root = __BL.S.ui.root;
    const sel = root.querySelector('.css-rule');
    return {
      rule: sel.selectedOptions[0]?.textContent || '', key: sel.value,
      options: [...sel.options].map((o) => o.textContent), groups: [...sel.querySelectorAll('optgroup')].map((g) => g.label),
      rows: [...root.querySelectorAll('.style-rows .st')].map((r) => ({ prop: r.dataset.prop, value: r.querySelector('.sv').value, added: r.dataset.added === '1', placeholder: r.querySelector('.sv').placeholder, note: r.querySelector('.st-note')?.textContent || '', disabled: r.querySelector('.sv').disabled })),
      info: root.querySelector('.css-rule-info').textContent, selected: root.querySelector('.css-selected').textContent,
      empty: root.querySelector('.css-empty').hidden ? '' : root.querySelector('.css-empty').textContent,
      utils: { shown: !root.querySelector('.css-utils').hidden, open: root.querySelector('.css-utils').open, chips: [...root.querySelectorAll('.css-utils-list .chip')].map((c) => c.textContent) },
      propsHeading: !root.querySelector('.css-props-h').hidden,
    };
  });
  const pickRule = (match) => ui((match) => { const sel = __BL.S.ui.root.querySelector('.css-rule'); const o = [...sel.options].find((x) => x.textContent.startsWith(match)); sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return o.textContent; }, match);
  const setRow = (prop, value) => ui((prop, value) => { const i = __BL.S.ui.root.querySelector(`.style-rows .st[data-prop="${prop}"] .sv`); i.value = value; i.dispatchEvent(new Event('input', { bubbles: true })); }, prop, value);
  const search = (text) => ui((text) => { const root = __BL.S.ui.root; if (root.querySelector('.css-add-box').hidden) root.querySelector('[data-x="css-add"]').click(); const qi = root.querySelector('.css-add-q'); qi.value = text; qi.dispatchEvent(new Event('input', { bubbles: true })); return { opts: [...root.querySelectorAll('.css-add-opt')].map((b) => b.dataset.prop), msg: root.querySelector('.css-add-res').textContent.trim(), focused: root.activeElement === qi }; }, text);
  const pickProp = (prop) => click(`.css-add-opt[data-prop="${prop}"]`);
  const tweaks = () => ui(() => { __BL.toolsApi.rememberElement(); return JSON.parse(JSON.stringify(Object.values(__BL.toolsApi.getP().tweaks))); });
  const undoBtn = async () => { await click('[data-x="undo"]'); await sleep(60); };
  const choose = (i) => ui((i) => { const s = __BL.S.ui.root.querySelector('.element-choice'); s.value = String(i); s.dispatchEvent(new Event('change', { bubbles: true })); }, i);

  const styleAttr = await ui(() => document.getElementById('pt-1').style.cssText);
  await shiftClick(page, await pointFor(page, '#pt-1', 'text'));
  await click('[data-x="tool-css"]');
  const e0 = await editor();
  check('Selected line and default rule: the element’s own class rule', e0.selected === 'Selected: h2 · PRODUCT TITLE' && e0.rule === '.product-title · <style id="base"> (#1)', JSON.stringify({ s: e0.selected, r: e0.rule }));
  check('Only the rule’s declared properties are shown, as written (no inherited or computed rows)', JSON.stringify(e0.rows.map((r) => [r.prop, r.value, r.added])) === '[["font-size","1.5rem",false],["color","var(--brand-color)",false],["margin","0 0 16px",false]]' && e0.propsHeading, JSON.stringify(e0.rows));
  check('Picker: class rules first, then other rules, then this element; matching rules only', e0.groups.join() === 'Class rules,Other rules,No rule' && e0.options[e0.options.length - 1] === 'This element only (its style attribute)' && e0.options.some((o) => o.startsWith('#pt-1 · ')) && e0.options.some((o) => o.startsWith('h2 · ')) && !e0.options.some((o) => o.includes('99px') || o.includes('rules-print') || o.includes('rules-cross')), JSON.stringify(e0.options));
  check('Picker: identical selectors are told apart by source, condition or number', new Set(e0.options).size === e0.options.length && e0.options.includes('.product-title · rules-linked.css') && e0.options.includes('.product-title · <style id="base"> · @media (min-width: 600px)') && e0.options.some((o) => o.includes('(#2)')) && e0.options.some((o) => o.startsWith('.product-title · adopted stylesheet 1')), JSON.stringify(e0.options));
  check('Picker: an unverifiable condition is labelled, and the info line makes no cascade claim', e0.options.some((o) => o.includes('@container card (min-width: 100px) · condition not checked')) && e0.info.includes('Which one wins for each property isn’t checked') && !/controls|wins:/.test(e0.info), e0.info);
  check('Unreadable cross-origin stylesheet is mentioned', e0.info.includes('1 stylesheet from another site can’t be inspected'), e0.info);

  // Edit a declared value: previewed inline on this element only, recorded with its rule and authored original.
  await setRow('font-size', '1.75rem');
  const t1 = (await tweaks()).find((t) => t.prop === 'font-size');
  check('Editing a declared value previews on this element only', (await inline('#pt-1', 'font-size')) === '1.75rem' && (await inline('#pt-2', 'font-size')) === '' && (await ui(() => getComputedStyle(document.getElementById('pt-1')).fontSize)) === '28px', await inline('#pt-1', 'font-size'));
  check('The change keeps its rule, source and the declared original', t1?.from === '1.5rem' && t1.to === '1.75rem' && t1.declared === true && t1.rule.matched === '.product-title' && t1.rule.source === '<style id="base">' && t1.rule.kind === 'class' && !!t1.rule.key, JSON.stringify(t1));
  check('Changes list: original → new, tagged with the rule', (await changes()).join() === 'font-size: 1.5rem → 1.75rem' && (await ui(() => __BL.S.ui.root.querySelector('.css-changes .chg-rule')?.textContent)) === '.product-title', JSON.stringify(await changes()));
  await click('.style-rows .st[data-prop="font-size"] [data-x="st-inc"]');
  check('+ nudges a rem value in rem steps', (await inline('#pt-1', 'font-size')) === '1.875rem', await inline('#pt-1', 'font-size'));
  await click('.style-rows .st[data-prop="color"] [data-x="st-inc"]');
  check('+ leaves a var() value alone', (await editor()).rows.find((r) => r.prop === 'color').value === 'var(--brand-color)' && !(await tweaks()).some((t) => t.prop === 'color'));
  await undoBtn();
  // Typing a value and nudging it straight after is one burst, so one Undo step (existing undo grouping).
  check('Undo reverts the typed value and its nudge together; the no-op nudge on var() added no step', (await inline('#pt-1', 'font-size')) === '' && !(await tweaks()).length, await inline('#pt-1', 'font-size'));
  await setRow('font-size', '1.75rem');

  // + Add CSS property: search, results without declared properties, an added row with an absent original.
  const s1 = await search('margin');
  check('Add property: search "margin" lists the longhands first and leaves out the declared margin', s1.focused && s1.opts.slice(0, 4).join() === 'margin-top,margin-right,margin-bottom,margin-left' && !s1.opts.includes('margin'), JSON.stringify(s1));
  const s2 = await search('transl');
  check('Add property: translate (used by Align) is not offered', !s2.opts.includes('translate') && s2.opts.includes('text-transform') === false, JSON.stringify(s2));
  const s3 = await search('--');
  const s4 = await search('--card-gap');
  check('Add property: a valid custom property name is offered, an incomplete one explains the rule', s3.opts.length === 0 && s3.msg.includes('custom property name') && s4.opts.join() === '--card-gap', JSON.stringify({ s3, s4 }));
  await search('margin-t');
  await pickProp('margin-top');
  const e1 = await editor();
  const mt = e1.rows.find((r) => r.prop === 'margin-top');
  check('Picking a property adds an empty row marked as added, with the current value only as a hint', mt?.added && mt.value === '' && mt.placeholder === '0px' && mt.note.startsWith('added to this rule') && !(await tweaks()).some((t) => t.prop === 'margin-top') && (await ui(() => __BL.S.ui.root.querySelector('.css-add-box').hidden)), JSON.stringify(mt));
  await setRow('margin-top', '24px');
  const t2 = (await tweaks()).find((t) => t.prop === 'margin-top');
  check('An added property records its original as absent, with the computed value for reference only', t2?.declared === false && t2.from === '' && t2.to === '24px' && t2.computed === '0px' && t2.rule.matched === '.product-title' && (await inline('#pt-1', 'margin-top')) === '24px', JSON.stringify(t2));
  check('Changes list: an added property reads "added → value"', (await changes()).join(' | ') === 'font-size: 1.5rem → 1.75rem | margin-top: added → 24px', JSON.stringify(await changes()));
  await search('--card-gap');
  await pickProp('--card-gap');
  await setRow('--card-gap', '12');
  const t3 = (await tweaks()).find((t) => t.prop === '--card-gap');
  check('A custom property is previewed as typed (no px added)', t3?.to === '12' && (await inline('#pt-1', '--card-gap')) === '12', JSON.stringify(t3));
  check('Searching again doesn’t offer properties the rule now has', !(await search('margin-t')).opts.includes('margin-top'));
  await ui(() => { const qi = __BL.S.ui.root.querySelector('.css-add-q'); qi.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true })); });
  check('Esc in the property search closes it and keeps the note and selection', (await ui(() => __BL.S.ui.root.querySelector('.css-add-box').hidden && !!__BL.S.pop && __BL.toolsApi.getP().els.length === 1)));
  await click('.style-rows .st[data-prop="--card-gap"] [data-x="css-row-rm"]');
  check('✕ on an added row removes the row and its preview', !(await editor()).rows.some((r) => r.prop === '--card-gap') && (await inline('#pt-1', '--card-gap')) === '' && !(await tweaks()).some((t) => t.prop === '--card-gap'));
  await undoBtn();
  check('Undo brings the removed property back', (await editor()).rows.some((r) => r.prop === '--card-gap' && r.value === '12') && (await inline('#pt-1', '--card-gap')) === '12');

  // Other rules: their own rows; !important flagged; the style attribute; a property moved between rules.
  await pickRule('#pt-1');
  const e2 = await editor();
  check('Choosing another rule shows only its declarations', JSON.stringify(e2.rows.map((r) => r.prop)) === '["letter-spacing"]' && e2.info.startsWith('<style id="base">. Matches this element'), JSON.stringify(e2));
  await pickRule('.product-title · <style id="base"> (#2)');
  check('!important is shown on its row', (await editor()).rows[0]?.prop === 'margin-bottom' && (await editor()).rows[0].note.includes('!important'));
  await pickRule('This element only');
  const e3 = await editor();
  check('This element only: the page’s own style attribute, without Blueline’s previews', JSON.stringify(e3.rows.map((r) => [r.prop, r.value])) === '[["outline","0px solid transparent"]]' && e3.info.startsWith('Changes for this element only'), JSON.stringify(e3.rows));
  await pickRule('#pt-1');
  await search('font-size');
  await pickProp('font-size');
  await setRow('font-size', '30px');
  const moved = (await tweaks()).filter((t) => t.prop === 'font-size');
  await pickRule('.product-title · <style id="base">');
  const back = (await editor()).rows.find((r) => r.prop === 'font-size');
  check('Editing a property under another rule moves its change there (one value per property per element)', moved.length === 1 && moved[0].rule.matched === '#pt-1' && moved[0].declared === false && back.value === '1.5rem' && back.note.includes('changed under #pt-1') && (await inline('#pt-1', 'font-size')) === '30px', JSON.stringify({ moved, back }));
  await undoBtn();
  check('Undo moves it back to the first rule', (await tweaks()).find((t) => t.prop === 'font-size')?.rule.matched === '.product-title' && (await inline('#pt-1', 'font-size')) === '1.75rem', JSON.stringify({ t: await tweaks(), fs: await inline('#pt-1', 'font-size') }));

  // Display and Hide stay independent.
  await pickRule('.product-title · <style id="base"> · @supports');
  await setRow('display', 'flex');
  await click('[data-x="hide"]');
  const hidden = await ui(() => getComputedStyle(document.getElementById('pt-1')).display);
  await setRow('display', 'grid');
  const hidden2 = await ui(() => getComputedStyle(document.getElementById('pt-1')).display);
  await click('[data-x="hide"]');
  const shown = await ui(() => getComputedStyle(document.getElementById('pt-1')).display);
  check('Hide wins over a display value, a display edit while hidden keeps it hidden, and showing brings the display edit back', hidden === 'none' && hidden2 === 'none' && shown === 'grid' && (await tweaks()).find((t) => t.prop === 'display')?.to === 'grid', JSON.stringify({ hidden, hidden2, shown }));
  await click('[data-x="hide"]');
  await click('[data-x="style-reset"]');
  const afterReset = { display: await ui(() => getComputedStyle(document.getElementById('pt-1')).display), css: (await tweaks()).filter((t) => !t.snap).length, fs: await inline('#pt-1', 'font-size'), hide: await ui(() => __BL.toolsApi.getP().hide) };
  check('Reset all removes the CSS values (also added ones) but not Hide', afterReset.display === 'none' && afterReset.css === 0 && afterReset.fs === '' && afterReset.hide === true, JSON.stringify(afterReset));
  await undoBtn();
  check('Undo after Reset all restores every CSS value', (await tweaks()).filter((t) => !t.snap).map((t) => t.prop).sort().join() === '--card-gap,display,font-size,margin-top' && (await inline('#pt-1', 'font-size')) === '1.75rem', JSON.stringify({ t: (await tweaks()).map((t) => [t.prop, t.to]), fs: await inline('#pt-1', 'font-size') }));
  await click('[data-x="hide"]');
  check('Showing again after Undo keeps the display edit', (await ui(() => getComputedStyle(document.getElementById('pt-1')).display)) === 'grid');
  await closeNote(page);
  // Chrome re-serialises a style attribute once it is touched, so it is compared as the CSSOM reads it.
  check('Cancel puts the page back exactly (no preview left)', (await ui(() => document.getElementById('pt-1').style.cssText)) === styleAttr && (await inline('#pt-2', 'font-size')) === '', JSON.stringify({ now: await ui(() => document.getElementById('pt-1').style.cssText), styleAttr }));

  // Several elements: each instance keeps its own rule choice and its own changes.
  await shiftClick(page, await pointFor(page, '#pt-2', 'text'));
  await shiftClick(page, await pointFor(page, '#stack', 'text'));
  await click('[data-x="tool-css"]');
  const m0 = await editor();
  await setRow('font-size', '2rem');
  await choose(1);
  const m1 = await editor();
  check('Second instance: its own rules and rows', m0.rule.startsWith('.product-title · <style id="base">') && m1.rule === '.stack · <style id="base">' && JSON.stringify(m1.rows.map((r) => [r.prop, r.value])) === '[["padding","var(--pad) 12px"],["--stack-gap","8px"],["width","300px"]]' && (await changes()).length === 0, JSON.stringify(m1));
  await setRow('width', '320px');
  await pickRule('This element only');
  await choose(0);
  const m2 = await editor();
  await choose(1);
  const m3 = await editor();
  check('Each instance keeps its own rule choice and changes when switching', m2.rule.startsWith('.product-title') && (await inline('#pt-2', 'font-size')) === '2rem' && (await inline('#stack', 'width')) === '320px' && (await inline('#pt-2', 'width')) === '' && m3.rule.startsWith('This element only') && (await changes()).join() === 'width: 300px → 320px', JSON.stringify({ m2: m2.rule, m3: m3.rule, ch: await changes() }));
  await closeNote(page);

  // Utility classes: collapsed group; no rules at all: empty state and element-only editing.
  await shiftClick(page, await pointFor(page, '#tw', 'text'));
  await click('[data-x="tool-css"]');
  const u0 = await editor();
  check('Utility classes sit in a collapsed group; the component class is the default rule', u0.rule === '.tw-card · <style id="base">' && u0.utils.shown && !u0.utils.open && u0.utils.chips.join() === '.flex,.p-4,.text-lg,.font-bold,.mt-2' && !u0.options.some((o) => o.startsWith('.p-4')), JSON.stringify(u0));
  await click('.css-utils-list [data-x="css-rule-pick"]:nth-child(2)');
  const u1 = await editor();
  check('Choosing a utility class shows its declarations', u1.rule.startsWith('.p-4 · ') && JSON.stringify(u1.rows.map((r) => [r.prop, r.value])) === '[["padding","1rem"]]' && u1.groups.includes('Utility class') && u1.utils.open, JSON.stringify(u1));
  await closeNote(page);
  await shiftClick(page, await pointFor(page, '#plain', 'text'));
  await click('[data-x="tool-css"]');
  const p0 = await editor();
  check('No matching rule: helpful empty state, element-only editing offered, nothing invented', p0.options.join() === 'This element only (no rule)' && p0.rows.length === 0 && p0.empty.startsWith('No directly matching CSS rule found. 1 stylesheet can’t be inspected, so the styling may come from it. It may also be inherited from a parent element.') && !p0.propsHeading, JSON.stringify(p0));
  await search('color');
  await pickProp('color');
  await setRow('color', '#ff0000');
  const pc = (await tweaks()).find((t) => t.prop === 'color');
  check('A property added with no rule belongs to this element only', pc?.rule.key === 'element' && pc.declared === false && (await inline('#plain', 'color')) === 'rgb(255, 0, 0)' && (await ui(() => __BL.S.ui.root.querySelector('.css-changes .chg-rule')?.textContent)) === 'this element', JSON.stringify({ pc, tag: await ui(() => __BL.S.ui.root.querySelector('.css-changes')?.innerHTML) }));
  await closeNote(page);
  check('No page errors (css-rules.html, editor)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 7. CSS changes: save, scope, export, alignment
console.log('\n# CSS changes keep their rule: save, reopen, scope, export, older notes, alignment (fixtures/css-rules.html)');
{
  const page = await open('css-rules.html', { http: true });
  const ui = (fn, ...a) => page.evaluate(fn, ...a);
  const click = (sel) => ui((sel) => __BL.S.ui.root.querySelector(sel).click(), sel);
  const inline = (sel, prop) => ui((sel, prop) => document.querySelector(sel).style.getPropertyValue(prop), sel, prop);
  const changes = () => ui(() => [...__BL.S.ui.root.querySelectorAll('.css-changes .chg > span')].map((s) => s.textContent.replace(/\s+/g, ' ').trim()));
  const editor = () => ui(() => { const root = __BL.S.ui.root; const sel = root.querySelector('.css-rule'); return { rule: sel.selectedOptions[0]?.textContent || '', options: [...sel.options].map((o) => o.textContent), info: root.querySelector('.css-rule-info').textContent, rows: [...root.querySelectorAll('.style-rows .st')].map((r) => ({ prop: r.dataset.prop, value: r.querySelector('.sv').value, added: r.dataset.added === '1', note: r.querySelector('.st-note')?.textContent || '', disabled: r.querySelector('.sv').disabled })) }; });
  const pickRule = (match) => ui((match) => { const sel = __BL.S.ui.root.querySelector('.css-rule'); const o = [...sel.options].find((x) => x.textContent.startsWith(match)); sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }, match);
  const setRow = (prop, value) => ui((prop, value) => { const i = __BL.S.ui.root.querySelector(`.style-rows .st[data-prop="${prop}"] .sv`); i.value = value; i.dispatchEvent(new Event('input', { bubbles: true })); }, prop, value);
  const addProp = (prop) => ui((prop) => { const root = __BL.S.ui.root; if (root.querySelector('.css-add-box').hidden) root.querySelector('[data-x="css-add"]').click(); const qi = root.querySelector('.css-add-q'); qi.value = prop; qi.dispatchEvent(new Event('input', { bubbles: true })); root.querySelector(`.css-add-opt[data-prop="${prop}"]`).click(); }, prop);
  const setScope = (v) => ui((v) => { const r = __BL.S.ui.root.querySelector(`[name="scope"][value="${v}"]`); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }, v);
  const save = async (note) => { await ui((note) => { __BL.S.ui.root.querySelector('.pop-note').value = note; }, note); await click('[data-act="pop-save"]'); await sleep(400); };
  const reopen = async (i) => { await ui((i) => __BL.S.ui.root.querySelectorAll('.list .item')[i].click(), i); await sleep(700); };
  const item = (i) => ui((i) => JSON.parse(JSON.stringify(__BL.S.batch.items[i])), i);
  const prompt = () => ui(() => __BLUELINE_TEST__.api.buildPrompt(__BL.S.batch));
  const section = (text, n) => { const parts = text.split(/\n(?=## \d+\. )/); return parts.find((p) => p.startsWith(`## ${n}. `)) || ''; };
  const rect = (sel) => ui((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }, sel);
  const near = (a, b) => Math.abs(a - b) <= 1;
  const undoBtn = async () => { await click('[data-x="undo"]'); await sleep(60); };

  // 1. A rule change with scope Everywhere: preview on this element only, the scope names the rule.
  await shiftClick(page, await pointFor(page, '#pt-1', 'text'));
  await click('[data-x="tool-css"]');
  await setRow('font-size', '1.75rem');
  await addProp('margin-top');
  await setRow('margin-top', '24px');
  await setScope('all');
  const sc = await ui(() => ({ info: __BL.S.ui.root.querySelector('.scope-info').textContent, sum: __BL.S.ui.root.querySelector('.scope-sum').textContent, sim: (__BL.toolsApi.T.simEls || []).map((e) => e.id) }));
  check('Everywhere: highlights the rule’s matches and says the preview stays on this element', sc.info.startsWith('The change goes to the rule .product-title: 3 matches for .product-title') && sc.info.includes('The preview shows on this element only') && sc.sum === 'everywhere · 3' && sc.sim.join() === 'pt-2,pt-3' && (await inline('#pt-2', 'font-size')) === '' && (await inline('#pt-3', 'margin-top')) === '', JSON.stringify(sc));
  await save('Bigger product title');
  const n1 = await item(0);
  const e1 = n1.elementEdits?.[0];
  const fs = e1?.tweaks.find((t) => t.prop === 'font-size');
  const mt = e1?.tweaks.find((t) => t.prop === 'margin-top');
  check('Saved: element identity (selector and classes) and, per change, rule, source, declared original or absent, new value', e1?.el.selector && (await ui((s) => document.querySelector(s)?.id, e1.el.selector)) === 'pt-1' && e1.el.classes === 'product-title featured' && fs?.rule.matched === '.product-title' && fs.rule.source === '<style id="base">' && fs.rule.selector === '.product-title' && fs.from === '1.5rem' && fs.to === '1.75rem' && fs.declared === true && mt?.declared === false && mt.from === '' && mt.to === '24px' && mt.rule.key === fs.rule.key && !fs.rule.notFound, JSON.stringify(e1));
  check('Saved: per-element scope records the rule as the intended target, and that the preview was this element only', e1?.scope.mode === 'all' && e1.scope.basis === 'rule' && e1.scope.selector === '.product-title' && e1.scope.count === 3 && e1.scope.preview === 'element' && e1.scope.rule?.source === '<style id="base">' && e1.scope.rule.reliable === true, JSON.stringify(e1?.scope));
  check('After saving, the preview is still on this element only', (await inline('#pt-1', 'font-size')) === '1.75rem' && (await inline('#pt-2', 'font-size')) === '' && (await inline('#pt-1', 'margin-top')) === '24px');
  const x1 = section(await prompt(), 1);
  check('Export: rule, source, scope and "from → to" / "added → to" values', x1.includes('CSS rule `.product-title` in <style id="base">:') && x1.includes('  - font-size: 1.5rem → 1.75rem') && x1.includes('  - margin-top: added → 24px') && x1.includes('Scope: **everywhere**: change rule `.product-title` in <style id="base"> itself') && !x1.includes('previewed on this element only'), x1);
  const full = await prompt();
  check('Export: the annotation key explains rule lines and "added"; the inspection still lists matched rules', full.includes('Values were previewed live on the selected element only') && full.includes('**added** means') && !x1.includes('Matched rules') && !x1.includes('Computed:') && full.includes('cross-origin stylesheet couldn’t be inspected'), full.slice(0, 1500));

  // 2. Reopen: the same rule, values and added row come back; Update without changes keeps the data.
  await reopen(0);
  await click('[data-x="tool-css"]');
  const r1 = await editor();
  check('Reopen: Edit CSS shows the rule the changes were made in, with the new and added values', r1.rule === '.product-title · <style id="base"> (#1)' && JSON.stringify(r1.rows.map((r) => [r.prop, r.value, r.added])) === '[["font-size","1.75rem",false],["color","var(--brand-color)",false],["margin","0 0 16px",false],["margin-top","24px",true]]' && (await changes()).join(' | ') === 'font-size: 1.5rem → 1.75rem | margin-top: added → 24px', JSON.stringify(r1.rows));
  await save('Bigger product title');
  const n1b = await item(0);
  check('Update without changes keeps every change exactly', JSON.stringify(n1b.elementEdits[0].tweaks) === JSON.stringify(e1.tweaks) && JSON.stringify(n1b.elementEdits[0].scope) === JSON.stringify(e1.scope), JSON.stringify(n1b.elementEdits[0].tweaks));

  // 3. "This element only" on a shared rule: the export says not to change that rule.
  await shiftClick(page, await pointFor(page, '#pt-2', 'text'));
  await click('[data-x="tool-css"]');
  await setRow('font-size', '2rem');
  await save('');
  const x2 = section(await prompt(), 2);
  check('This element: the export names the shared rule and keeps it unchanged', x2.includes('Scope: **this one only**. Rule `.product-title` in <style id="base"> also matches 2 other elements on this page; they must stay unchanged.') && x2.includes('  - font-size: 1.5rem → 2rem'), x2);

  // 4. A saved rule that isn't on the page: kept, shown as not found, never moved to another rule; a rule that
  //    only shifted (same selector, source and condition) is linked again.
  await ui(() => {
    const it = __BL.S.batch.items[1];
    const t = it.elementEdits[0].tweaks[0];
    t.rule = { ...t.rule, key: '.old-title|old.css||0', matched: '.old-title', selector: '.old-title', source: 'old.css', file: 'old.css' };
    const it0 = __BL.S.batch.items[0];
    for (const tw of it0.elementEdits[0].tweaks) tw.rule.key = tw.rule.key.replace(/\|0$/, '|7');
    __BL.saveBatch(); __BL.render();
  });
  await reopen(1);
  await click('[data-x="tool-css"]');
  const m1 = await editor();
  check('Missing rule: shown as "not found on this page" with its saved change, and still previewed on its own element', m1.rule === '.old-title · old.css · not found on this page' && JSON.stringify(m1.rows.map((r) => [r.prop, r.value])) === '[["font-size","2rem"]]' && m1.info.startsWith('This rule isn’t on the page now') && (await inline('#pt-2', 'font-size')) === '2rem', JSON.stringify(m1));
  await pickRule('.product-title · <style id="base"> (#1)');
  const m2 = await editor();
  check('Missing rule: the matching rule on the page doesn’t take the change over', m2.rows.find((r) => r.prop === 'font-size')?.value === '1.5rem' && m2.rows.find((r) => r.prop === 'font-size').note.includes('changed under .old-title'), JSON.stringify(m2.rows));
  await save('');
  const kept = (await item(1)).elementEdits[0].tweaks[0];
  check('Missing rule: Update keeps the change with its saved rule, flagged notFound', kept.rule.matched === '.old-title' && kept.rule.source === 'old.css' && kept.rule.notFound === true && kept.to === '2rem' && kept.from === '1.5rem', JSON.stringify(kept));
  check('Missing rule: the export says so', section(await prompt(), 2).includes('CSS rule `.old-title` in old.css: Not found on the page when saved'), section(await prompt(), 2));
  await reopen(0);
  await save('Bigger product title');
  const relinked = (await item(0)).elementEdits[0].tweaks;
  check('A rule whose key shifted is linked again by selector, source and condition', relinked.every((t) => t.rule.key.endsWith('|0') && !t.rule.notFound && t.rule.matched === '.product-title'), JSON.stringify(relinked.map((t) => t.rule)));

  // 5. Older notes (no rule on their changes) load, edit and export as before.
  await ui(() => {
    const el = document.getElementById('pt-3');
    const info = __BLUELINE_TEST__.api.describe(el, 'change');
    __BL.S.batch.items.push({ id: 'old07', note: 'Older note', createdAt: Date.now(), ...info, bps: ['desktop'],
      elementEdits: [{ el: { label: info.el.label, selector: info.el.selector, text: 'Third title', size: '1×1' }, scope: { mode: 'one', count: 1, selector: 'h2.product-title', similar: 3, chosen: false }, tweaks: [{ prop: 'letter-spacing', from: 'normal', to: '2px' }], textEdit: null, hidden: false, match: null, move: null, align: [], alignEl: null, measures: [] }] });
    __BL.saveBatch(); __BL.render();
  });
  const x3 = section(await prompt(), 3);
  check('Older note: export unchanged (previewed line, guessed-selector scope)', x3.includes('Previewed by the author: letter-spacing normal → 2px') && x3.includes('2 similar elements (`h2.product-title`) must stay unchanged') && !x3.includes('CSS rule `') && x3.includes('- Matched rules (cascade order):'), x3);
  await reopen(2);
  await click('[data-x="tool-css"]');
  const o1 = await editor();
  check('Older note: its change shows under This element only, marked as saved before rules were recorded, and previews', o1.rule.startsWith('This element only') && o1.rows.some((r) => r.prop === 'letter-spacing' && r.value === '2px' && r.note.includes('saved before rules were recorded')) && (await inline('#pt-3', 'letter-spacing')) === '2px' && (await changes()).join() === 'letter-spacing: normal → 2px', JSON.stringify(o1));
  await save('Older note');
  const o2 = (await item(2)).elementEdits[0].tweaks;
  check('Older note: Update keeps the change as it was (no rule invented)', o2.length === 1 && !o2[0].rule && o2[0].from === 'normal' && o2[0].to === '2px', JSON.stringify(o2));

  // 6. Utility class changes: scope falls back to the guessed selector and the export warns.
  await shiftClick(page, await pointFor(page, '#tw', 'text'));
  await click('[data-x="tool-css"]');
  await click('.css-utils-list [data-x="css-rule-pick"]:nth-child(2)');
  await setRow('padding', '1.5rem');
  await setScope('all');
  const us = await ui(() => __BL.S.ui.root.querySelector('.scope-info').textContent);
  await save('');
  const ue = (await item(3)).elementEdits[0];
  check('Utility class: the scope keeps a guessed selector and says why; the change keeps its utility rule', ue.scope.basis === 'similar' && ue.scope.rule?.reliable === false && ue.tweaks[0].rule.utility === true && us.includes('which is a utility class'), JSON.stringify({ scope: ue.scope, us }));
  check('Utility class: the export says to change classes, not redefine the utility', section(await prompt(), 4).includes('CSS rule `.p-4` in <style id="base">: Utility class:'), section(await prompt(), 4));

  // 7. translate is kept for Align: a declared translate row is read-only.
  await shiftClick(page, await pointFor(page, '#ref', 'text'));
  await click('[data-x="tool-css"]');
  const tr = (await editor()).rows.find((r) => r.prop === 'translate');
  check('A declared translate is shown read-only with a pointer to Align', tr?.disabled === true && tr.note.includes('Use Align'), JSON.stringify(tr));
  await closeNote(page);

  // 8. Align + Edit CSS in one note: Place below, then margin-top (rem, calc), margin + margin-top, Reset all.
  await shiftClick(page, await pointFor(page, '#mover', 'text'));
  await click('[data-x="tool-align"]');
  await click('[data-al-mode="element"]');
  await sleep(60);
  const rp = await pointFor(page, '#ref', 'center');
  await page.mouse.move(rp.x, rp.y, { steps: 3 }); await page.mouse.down(); await page.mouse.up(); await sleep(120);
  await click('[data-al-method="next"]');
  await click('.al-axes:not([hidden]) [data-al-v="below"]');
  await sleep(40);
  const a0 = { m: await rect('#mover'), r: await rect('#ref') };
  check('Place below: the element sits right under the reference', near(a0.m.t, a0.r.b), JSON.stringify(a0));
  await click('[data-x="tool-css"]');
  await addProp('margin-top');
  await setRow('margin-top', '1.5rem');
  const a1 = { m: await rect('#mover'), r: await rect('#ref') };
  check('margin-top in rem added in Edit CSS becomes the space from the reference (24px)', near(a1.m.t, a1.r.b + 24), JSON.stringify(a1));
  await setRow('margin-top', 'calc(1rem + 8px)');
  const a2 = { m: await rect('#mover'), r: await rect('#ref') };
  check('A calc() margin-top also counts (24px)', near(a2.m.t, a2.r.b + 24), JSON.stringify(a2));
  await addProp('margin');
  await setRow('margin', '10px 0px 0px');
  const a3 = { m: await rect('#mover'), r: await rect('#ref'), mt: await ui(() => getComputedStyle(document.getElementById('mover')).marginTop) };
  check('margin and margin-top together: the longhand edit is kept over the shorthand (still 24px)', a3.mt === '24px' && near(a3.m.t, a3.r.b + 24), JSON.stringify(a3));
  await click('.chg button[data-prop="margin-top"]');
  const a4 = { m: await rect('#mover'), r: await rect('#ref') };
  check('Removing margin-top leaves the margin shorthand’s 10px as the space', near(a4.m.t, a4.r.b + 10), JSON.stringify(a4));
  await undoBtn();
  check('Undo puts margin-top back (24px)', near((await rect('#mover')).t, (await rect('#ref')).b + 24));
  await click('[data-x="style-reset"]');
  const a5 = { m: await rect('#mover'), r: await rect('#ref'), y: await ui(() => __BL.toolsApi.getP().alignEl?.y?.edge), mt: await inline('#mover', 'margin-top') };
  check('Reset all removes the CSS values but keeps the placement', a5.y === 'below' && a5.mt === '' && near(a5.m.t, a5.r.b), JSON.stringify(a5));
  await undoBtn();
  await save('Under the reference with a gap');
  const al = (await item(4)).elementEdits[0];
  check('Saved: one correction holds the placement and the CSS values with their rule', al.alignEl?.y?.method === 'next' && al.alignEl.y.edge === 'below' && al.tweaks.filter((t) => !t.snap).map((t) => `${t.prop}=${t.to}@${t.rule.matched}`).join() === 'margin-top=calc(1rem + 8px)@.box,margin=10px 0px 0px@.box' && al.tweaks.some((t) => t.snap && t.prop === 'translate'), JSON.stringify(al.tweaks));
  const x5 = section(await prompt(), 5);
  check('Export: the relationship, then the CSS rule block, with the margin as the space', x5.includes('immediately below `div#ref`') && x5.includes('the gap comes from the margin change, not an extra offset.') && x5.includes('CSS rule `.box` in <style id="base">:') && x5.includes('  - margin-top: added → calc(1rem + 8px)'), x5);
  // The inspection data is still collected without the previews; the export shows it only for bugs and items with no CSS rule recorded.
  const ins = (await item(4)).el;
  check('Inspection is taken without the previews, even with margin and margin-top both previewed (the export leaves it out for an item with CSS rules)', ins.markup === '<div class="box" id="mover">' && ins.box.startsWith('margin 0 | ') && !x5.includes('**Inspection**') && !x5.includes('Computed:'), JSON.stringify({ markup: ins.markup, box: ins.box }));
  check('No page errors (css-rules.html, save/scope/export/alignment)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 8. Selected-element ✕, saved and missing elements, nested selection, export filtering
// Shared helpers for the Slice 2A final-refinement suites below.
const tools = (page) => {
  const ui = (fn, ...a) => page.evaluate(fn, ...a);
  const T = (t) => `[data-t="${t}"]`;
  const click = (sel) => ui((sel) => __BL.S.ui.root.querySelector(sel).click(), sel);
  const addProp = (prop) => ui((prop) => {
    const root = __BL.S.ui.root;
    if (root.querySelector('.css-add-box').hidden) root.querySelector('[data-x="css-add"]').click();
    const qi = root.querySelector('.css-add-q');
    qi.value = prop;
    qi.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector(`.css-add-opt[data-prop="${prop}"]`).click();
  }, prop);
  const setCss = async (prop, value) => {
    if (!(await ui((prop) => !!__BL.S.ui.root.querySelector(`.style-rows .st[data-prop="${prop}"]`), prop))) await addProp(prop);
    await ui((prop, value) => { const row = __BL.S.ui.root.querySelector(`.style-rows .st[data-prop="${prop}"]`); const i = row.querySelector('.sv'); i.value = value; i.dispatchEvent(new Event('input', { bubbles: true })); }, prop, value);
  };
  return {
    ui, T, click, setCss,
    inline: (sel, prop) => ui((sel, prop) => document.querySelector(sel).style.getPropertyValue(prop), sel, prop),
    choose: (i) => ui((i) => { const s = __BL.S.ui.root.querySelector('.element-choice'); s.value = String(i); s.dispatchEvent(new Event('change', { bubbles: true })); }, i),
    changes: () => ui(() => [...__BL.S.ui.root.querySelectorAll('.css-changes .chg > span')].map((s) => s.textContent.replace(/\s+/g, ' ').trim())),
    ids: () => ui(() => (__BL.toolsApi.getP()?.els || []).map((e) => e.dataset.t || e.id)),
    card: () => ui(() => { const b = __BL.S.ui.root.querySelector('.element-editor'); return { shown: !!b && !b.hidden, name: b?.querySelector('.se-name')?.textContent.trim(), of: b?.querySelector('.se-of')?.textContent || '' }; }),
    save: async (note) => { if (note !== undefined) await ui((note) => { __BL.S.ui.root.querySelector('.pop-note').value = note; }, note); await click('[data-act="pop-save"]'); await sleep(400); },
    item: (i) => ui((i) => JSON.parse(JSON.stringify(__BL.S.batch.items[i])), i),
    reopen: async (i) => { await ui((i) => __BL.S.ui.root.querySelectorAll('.list .item')[i].click(), i); await sleep(700); },
    prompt: () => ui(() => __BLUELINE_TEST__.api.buildPrompt(__BL.S.batch)),
    undo: async () => { await click('[data-x="undo"]'); await sleep(80); },
    detach: (sel, key) => ui((sel, key) => { const e = document.querySelector(sel); window[key] = { e, parent: e.parentNode, next: e.nextSibling }; e.remove(); }, sel, key),
    reattach: (key) => ui((key) => { const k = window[key]; k.parent.insertBefore(k.e, k.next); }, key),
    chips: () => ui(() => [...__BL.S.ui.root.querySelectorAll('.x-sel .tchip')].map((c) => ({ text: c.firstChild.textContent, missing: c.classList.contains('missing'), x: c.querySelector('button')?.dataset.x || null }))),
    outlines: () => ui(() => __BL.S.ui.root.querySelectorAll('.selb').length),
    rmChip: (i, missing = false) => ui((i, missing) => { const kind = missing ? 'sel-rm-missing' : 'sel-rm'; const b = [...__BL.S.ui.root.querySelectorAll(`.x-sel [data-x="${kind}"]`)].find((x) => +x.dataset.i === i); b.click(); }, i, missing),
    title: () => ui(() => __BL.S.ui.root.querySelector('.x-sel .tb-h')?.textContent || ''),
    open: () => ui(() => !!__BL.S.pop),
    // Lines of the export that belong to one instance block.
    instanceBlock: (text, selector) => { const lines = text.split('\n'); const i = lines.findIndex((l) => l.includes('**Instance') && l.includes(selector)); if (i < 0) return ''; const out = []; for (let k = i + 1; k < lines.length && !lines[k].includes('**Instance') && !lines[k].startsWith('---') && !lines[k].startsWith('Screenshot'); k++) out.push(lines[k]); return out.join('\n'); },
    section: (text, n) => (text.split(/\n(?=## \d+\. )/).find((p) => p.startsWith(`## ${n}. `)) || ''),
  };
};

console.log('\n# Selected elements: ✕ removes one element and its edits, saved and missing ones too (fixtures/toolbox.html)');
{
  const page = await open('toolbox.html');
  const { ui, T, click, setCss, inline, choose, changes, ids, card, save, item, reopen, prompt, undo, detach, reattach, chips, outlines, rmChip, title, open: isOpen } = tools(page);
  const threeWithEdits = async () => {
    for (const t of ['t1', 't2', 't3']) await shiftClick(page, await pointFor(page, T(t), 'text'));
    await choose(0); await click('[data-x="tool-css"]'); await setCss('font-size', '30');
    await choose(1); await setCss('color', '#005EB8');
    await choose(2); await setCss('padding', '4px');
  };

  // A new note.
  await threeWithEdits();
  await click('[data-x="sel-showall"]');
  const c0 = await chips();
  check('Every selected-element chip has its own ✕ button', c0.length === 3 && c0.every((c) => c.x === 'sel-rm' && !c.missing), JSON.stringify(c0));
  const cardBefore = await card();
  await rmChip(1);
  const r1 = { ids: await ids(), title: await title(), outlines: await outlines(), card: await card(), t2color: await inline(T('t2'), 'color'), t1: await inline(T('t1'), 'font-size'), t3: await inline(T('t3'), 'padding'), edits: await ui(() => [...__BL.toolsApi.getP().edits.keys()].map((e) => e.dataset.t).join()), parked: await ui(() => [...__BL.toolsApi.getP().parked.keys()].map((e) => e.dataset.t).join()), open: await isOpen() };
  check('✕ removes that element only: the others stay selected, the count and the outlines follow', r1.ids.join() === 't1,t3' && r1.title === 'Selected elements (2)' && r1.outlines === 2 && r1.open, JSON.stringify(r1));
  check('✕ discards that element’s edits (preview reverted, nothing parked) and keeps every other element’s edits', r1.t2color === '' && r1.t1 === '30px' && r1.t3 === '4px' && r1.edits === 't1,t3' && r1.parked === '', JSON.stringify(r1));
  check('The element being edited stays the same when another one is removed', cardBefore.of === 'Editing 3 of 3' && r1.card.of === 'Editing 2 of 2' && r1.card.name === 'Heading 3 “Magnesium”', JSON.stringify({ cardBefore, card: r1.card }));
  await undo();
  await choose(1);
  check('Undo puts the element back with its edit', (await ids()).join() === 't1,t2,t3' && (await changes()).join() === 'color: added → #005EB8' && (await inline(T('t2'), 'color')) !== '', JSON.stringify({ ids: await ids(), ch: await changes() }));
  await rmChip(1);
  await shiftClick(page, await pointFor(page, T('t2'), 'text'));
  await choose(2);
  check('Selecting a removed element again starts clean (its old edits were discarded, not parked)', (await ids()).join() === 't1,t3,t2' && (await changes()).length === 0 && (await inline(T('t2'), 'color')) === '', JSON.stringify({ ids: await ids(), ch: await changes() }));
  await choose(1);
  await rmChip(1);
  const r2 = { ids: await ids(), card: await card(), ch: await changes(), t1: await inline(T('t1'), 'font-size') };
  check('Removing the element being edited moves editing to the first remaining one, with its own edits', r2.ids.join() === 't1,t2' && r2.card.name === 'Heading 3 “Whey protein”' && r2.ch.join() === 'font-size: 18px → 30px', JSON.stringify(r2));
  await save('Two titles');
  const sv = await item(0);
  const text = await prompt();
  check('The removed element is not in the saved note or the export', (sv.elementEdits || []).map((e) => e.el.selector).join() === '#c1 > h3.card-title,#c2 > h3.card-title' && !JSON.stringify(sv).includes('#c3') && !text.includes('#c3'), JSON.stringify((sv.elementEdits || []).map((e) => e.el.selector)));

  // The last element: the note stays open with nothing selected (like Clear selection), Undo brings it back.
  await shiftClick(page, await pointFor(page, T('t3'), 'text'));
  await rmChip(0);
  const last = { ids: await ids(), open: await isOpen(), canSave: await ui(() => __BL.hooks.blockSave()), outlines: await outlines() };
  check('Removing the last element keeps the note open with nothing selected, and saving waits for a new selection', last.ids.length === 0 && last.open && last.outlines === 0 && last.canSave.startsWith('Nothing is selected'), JSON.stringify(last));
  await undo();
  check('Undo restores the last element', (await ids()).join() === 't3', JSON.stringify(await ids()));
  await ui(() => __BL.closePop());

  // A saved note: chips keep their ✕, removing one saves without it.
  await reopen(0);
  await click('[data-x="sel-showall"]');
  const o0 = await chips();
  check('Reopening a saved note: every element chip has its ✕', o0.length === 2 && o0.every((c) => c.x === 'sel-rm'), JSON.stringify(o0));
  await rmChip(1);
  check('Reopened note: ✕ removes that element and reverts its preview', (await ids()).join() === 't1' && (await inline(T('t2'), 'color')) === '' && (await inline(T('t1'), 'font-size')) === '30px', JSON.stringify(await ids()));
  {
    const overlays = () => ui(() => { const box = __BL.S.ui.root.querySelector('.x-marksbox'); const vis = (n) => n.style.display !== 'none'; return { sel: box.querySelectorAll('.selb').length, saved: [...box.querySelectorAll('.mk')].filter(vis).length, hover: !__BL.S.ui.root.querySelector('.hl2').hidden }; });
    await undo(); // back to the two elements
    await rmChip(0);
    const o = await overlays();
    check('Reopened note: the removed element’s dashed outline and selection box go at once, without Update', o.sel === 1 && o.saved === 1 && (await inline(T('t1'), 'font-size')) === '', JSON.stringify(o));
    await undo();
    const o2 = await overlays();
    check('Undo brings the removed element’s outlines and edits back', o2.sel === 2 && o2.saved === 2 && (await ids()).join() === 't1,t2' && (await inline(T('t1'), 'font-size')) === '30px', JSON.stringify({ o2, ids: await ids(), c: await inline(T('t1'), 'font-size') }));
    await rmChip(0);
    await ui(() => __BL.closePop());
    await sleep(100);
    const o3 = await overlays();
    check('Cancel after ✕ puts the saved note’s outlines and previews back (it was not changed)', o3.saved === 2 && o3.sel === 0 && (await inline(T('t1'), 'font-size')) === '30px', JSON.stringify(o3));
    await reopen(0);
    await click('[data-x="sel-showall"]');
    await rmChip(1);
  }
  await save('One title');
  const sv2 = await item(0);
  check('Update after ✕: the note keeps only the remaining element and its edit', sv2.elementEdits.length === 1 && sv2.elementEdits[0].el.selector === '#c1 > h3.card-title' && !(sv2.also || []).length && sv2.elementEdits[0].tweaks[0].prop === 'font-size' && !(await prompt()).includes('#c2'), JSON.stringify(sv2.elementEdits.map((e) => e.el.selector)));
  await ui(() => { const items = __BL.S.ui.root.querySelectorAll('.list .item'); items[0].querySelector('[data-act="del"]').click(); });
  await sleep(100);
  check('No page errors (✕ removal, new and saved notes)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

console.log('\n# Saved elements that are missing from the page: removed only on purpose (fixtures/toolbox.html)');
{
  const page = await open('toolbox.html');
  const { ui, T, click, setCss, inline, choose, ids, save, item, reopen, prompt, undo, detach, reattach, chips, rmChip, open: isOpen } = tools(page);
  const note = async (list, edits) => {
    for (const t of list) await shiftClick(page, await pointFor(page, T(t), 'text'));
    await click('[data-x="tool-css"]');
    for (const [i, [prop, value]] of edits.entries()) { await choose(i); await setCss(prop, value); }
    await save('Note');
  };
  await note(['t1', 't2', 't3'], [['font-size', '30'], ['color', '#005EB8'], ['padding', '4px']]);
  const full = await item(0);
  await detach(T('t2'), '__t2');
  await reopen(0);
  const m0 = await chips();
  check('A saved element that is not on the page shows "Element not found" with its own ✕', m0.filter((c) => c.missing).length === 1 && m0.find((c) => c.missing).x === 'sel-rm-missing' && (await ids()).join() === 't1,t3', JSON.stringify(m0));
  await save('Updated without removing');
  const kept = await item(0);
  check('Updating without pressing ✕ keeps the missing element’s record exactly', JSON.stringify(kept.elementEdits.find((e) => e.el.selector === '#c2 > h3.card-title')) === JSON.stringify(full.elementEdits.find((e) => e.el.selector === '#c2 > h3.card-title')) && kept.elementEdits.length === 3, JSON.stringify(kept.elementEdits.map((e) => e.el.selector)));

  // ✕ then Undo, then Cancel: nothing is lost.
  await reopen(0);
  await rmChip(0, true);
  const m1 = await chips();
  check('✕ on a missing element removes its chip and the count', m1.every((c) => !c.missing) && (await ui(() => __BL.S.ui.root.querySelector('.x-sel .tb-h')?.textContent)) === 'Selected elements (2)', JSON.stringify(m1));
  await undo();
  check('Undo brings the missing element back', (await chips()).filter((c) => c.missing).length === 1, JSON.stringify(await chips()));
  await rmChip(0, true);
  await ui(() => __BL.closePop());
  await sleep(100);
  check('Cancel after ✕ leaves the saved note exactly as it was', JSON.stringify((await item(0)).elementEdits) === JSON.stringify(kept.elementEdits), '');

  // ✕ then Update: the element and its edits are gone from the note.
  await reopen(0);
  await rmChip(0, true);
  await save('Without the missing one');
  const gone = await item(0);
  check('Update after ✕ on the missing element discards only that element and its edits', gone.elementEdits.map((e) => e.el.selector).join() === '#c1 > h3.card-title,#c3 > h3.card-title' && (gone.also || []).map((a) => a.selector).join() === '#c3 > h3.card-title' && !(await prompt()).includes('#c2'), JSON.stringify(gone.elementEdits.map((e) => e.el.selector)));
  await reattach('__t2');
  await reopen(0);
  check('When the element is back on the page it is no longer part of the note', (await ids()).join() === 't1,t3' && (await chips()).every((c) => !c.missing), JSON.stringify(await ids()));
  await ui(() => __BL.closePop());

  // Every remaining element is missing: removing one of them still saves.
  await ui(() => { const items = __BL.S.ui.root.querySelectorAll('.list .item'); items[0].querySelector('[data-act="del"]').click(); });
  await sleep(100);
  await note(['t1', 't2'], [['font-size', '30'], ['color', '#005EB8']]);
  await detach(T('t1'), '__a'); await detach(T('t2'), '__b');
  await reopen(0);
  const all = await chips();
  await rmChip(0, true);
  check('All elements missing: each has a ✕, and nothing is selected', all.length === 2 && all.every((c) => c.missing && c.x === 'sel-rm-missing') && (await ids()).length === 0, JSON.stringify(all));
  await save('One left');
  const one = await item(0);
  check('All elements missing: Update after ✕ keeps the other one, as the note’s element', one.elementEdits.length === 1 && one.elementEdits[0].el.selector === '#c2 > h3.card-title' && one.el.selector === '#c2 > h3.card-title' && !(one.also || []).length && one.elementEdits[0].tweaks[0].prop === 'color', JSON.stringify(one.elementEdits.map((e) => e.el.selector)));
  await reattach('__b'); await reattach('__a');
  check('No page errors (missing elements)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

console.log('\n# Nested parent and child selection (fixtures/nested.html)');
{
  const page = await open('nested.html');
  const { ui, click, ids, save, item, reopen, prompt } = tools(page);
  const idsOf = () => ui(() => (__BL.toolsApi.getP()?.els || []).map((e) => e.id));
  const rectBox = (id, pad = 6) => ui((id, pad) => { const r = document.getElementById(id).getBoundingClientRect(); return { l: r.left - pad, t: r.top - pad, r: r.right + pad, b: r.bottom + pad }; }, id, pad);
  const close = () => ui(() => { if (__BL.S.pop) __BL.closePop(); });
  const bannerPad = async () => { const r = await ui(() => { const r = document.getElementById('banner').getBoundingClientRect(); return { x: r.left + 6, y: r.top + r.height / 2 }; }); return r; };
  const selectMode = async () => { await ui(() => __BL.S.ui.root.querySelector('[data-x="sel-element"]').click()); await sleep(100); };
  const dragAround = async (r) => { await page.mouse.move(r.l, r.t); await page.mouse.down(); await page.mouse.move(r.r, r.b, { steps: 8 }); await page.mouse.up(); await sleep(100); };

  // Select element
  await ui(() => __BL.S.ui.root.querySelector('[data-x="add-note"]').click());
  await sleep(80);
  await selectMode();
  const bp = await bannerPad();
  await page.mouse.click(bp.x, bp.y);
  await sleep(100);
  check('Select element on the banner selects only the banner, not its child', (await idsOf()).join() === 'banner', JSON.stringify(await idsOf()));
  await close();
  await selectMode();
  await page.mouse.click(...Object.values(await pointFor(page, '#grow', 'text')));
  await sleep(100);
  check('Select element on the child’s text selects only the child', (await idsOf()).join() === 'grow', JSON.stringify(await idsOf()));
  await close();
  await selectMode();
  await dragAround(await rectBox('banner'));
  check('Select element: dragging around the banner selects the banner, not banner and child', (await idsOf()).join() === 'banner', JSON.stringify(await idsOf()));
  await close();

  // Shift+click adds or removes on purpose
  await shiftClick(page, await bannerPad());
  check('Shift+click on the banner selects only the banner', (await idsOf()).join() === 'banner', JSON.stringify(await idsOf()));
  await shiftClick(page, await pointFor(page, '#grow', 'text'));
  check('Shift+click on the child adds it on purpose (banner and child)', (await idsOf()).join() === 'banner,grow', JSON.stringify(await idsOf()));
  await shiftClick(page, await pointFor(page, '#grow', 'text'));
  check('Shift+click on it again removes only the child', (await idsOf()).join() === 'banner', JSON.stringify(await idsOf()));
  await close();

  // Shift+drag keeps its existing behavior
  await shiftDrag(page, await rectBox('banner'));
  check('Shift+drag around the banner selects the banner alone', (await idsOf()).join() === 'banner', JSON.stringify(await idsOf()));
  await close();
  await shiftDrag(page, await rectAround(page, ['p1', 'p2']));
  check('Area selection still picks several elements: both paragraphs of the panel', (await idsOf()).join() === 'p1,p2', JSON.stringify(await idsOf()));
  await close();
  // With the banner already selected, a drag that covers its child adds that child. This is area selection adding
  // what the rectangle encloses (unchanged); it is how a banner + child pair can appear without a click on the child.
  await shiftClick(page, await bannerPad());
  await shiftDrag(page, await rectBox('grow', 2));
  check('Documented: a Shift+drag over the child of an already-selected banner adds the child (area selection is unchanged)', (await idsOf()).join() === 'banner,grow', JSON.stringify(await idsOf()));
  await close();

  // Saving and reopening never adds a child
  await shiftClick(page, await bannerPad());
  await save('Banner');
  const s1 = await item(0);
  await reopen(0);
  const reopened = await idsOf();
  await save('Banner again');
  const s2 = await item(0);
  check('A note on the banner reopens and updates with the banner alone (no child added)', s1.elementEdits.length === 1 && reopened.join() === 'banner' && s2.elementEdits.length === 1 && !(s2.also || []).length, JSON.stringify({ reopened, n1: s1.elementEdits.length, n2: s2.elementEdits.length }));
  check('No page errors (nested selection)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

console.log('\n# Export leaves out selected elements with no changes (fixtures/toolbox.html)');
{
  const page = await open('toolbox.html');
  const { ui, T, click, setCss, choose, save, item, prompt, instanceBlock, section } = tools(page);
  // Two titles selected; only the first is changed.
  await shiftClick(page, await pointFor(page, T('t1'), 'text'));
  await shiftClick(page, await pointFor(page, T('t2'), 'text'));
  await choose(0); await click('[data-x="tool-css"]'); await setCss('font-size', '30');
  await save('Make the first title bigger');
  const sv = await item(0);
  const x1 = section(await prompt(), 1);
  const scopeLines = (x1.match(/Scope:/g) || []).length;
  check('The saved note still holds both selected elements (the empty one is not deleted from the model)', sv.elementEdits.length === 2 && sv.elementEdits[1].el.selector === '#c2 > h3.card-title' && !sv.elementEdits[1].tweaks?.length, JSON.stringify(sv.elementEdits.map((e) => e.el.selector)));
  check('Export: the changed element has its instance, CSS and scope', instanceBlock(await prompt(), '#c1 > h3.card-title').includes('font-size: 18px → 30px') && scopeLines === 1, x1);
  check('Export: the element with no changes gets no instance block and no scope instructions', !x1.includes('**Instance `h3.card-title` (`#c2 > h3.card-title`)**') && instanceBlock(await prompt(), '#c2 > h3.card-title') === '' && scopeLines === 1, x1);
  check('Export: with a written note it is named once, as selected with nothing to apply to it', x1.includes('Also selected, no changes of their own: `h3.card-title` (`#c2 > h3.card-title`).'), x1);
  // No written note and nothing drawn: it is left out altogether.
  await ui(() => { __BL.S.batch.items[0].note = ''; });
  check('Export: with no written note or drawings the unchanged element is not mentioned at all', !section(await prompt(), 1).includes('#c2 > h3.card-title'), section(await prompt(), 1));
  // A drawn annotation can refer to it, so it is named (still without instructions).
  await ui(() => { __BL.S.batch.items[0].marks = [{ t: 'box', c: '#E5239D', a: { x: 10, y: 10 }, b: { x: 60, y: 60 } }]; });
  check('Export: with a drawn annotation it is named in the same single line', section(await prompt(), 1).includes('Also selected, no changes of their own') && !section(await prompt(), 1).includes('**Instance `h3.card-title` (`#c2 > h3.card-title`)**'), section(await prompt(), 1));

  // Elements that are meaningfully involved are all kept.
  await ui(() => {
    const it = __BL.S.batch.items[0];
    it.marks = undefined;
    it.note = 'Several corrections';
    const base = it.elementEdits[1];
    const third = JSON.parse(JSON.stringify(base));
    third.el = { label: 'h3.card-title', selector: '#c3 > h3.card-title', text: 'Magnesium', size: '220×27' };
    third.measures = [{ label: 'button#cta', selector: '#cta', summary: '12px below' }];
    it.elementEdits[1].hidden = true;
    it.elementEdits.push(third);
    it.also = [it.elementEdits[1].el, third.el];
  });
  const x2 = section(await prompt(), 1);
  check('Export: elements with a CSS change, a hide or a measurement each keep their instance', x2.includes('**Instance `h3.card-title` (`#c1 > h3.card-title`)**') && x2.includes('**Instance `h3.card-title` (`#c2 > h3.card-title`)**') && x2.includes('**Instance `h3.card-title` (`#c3 > h3.card-title`)**') && instanceBlock(await prompt(), '#c2 > h3.card-title').includes('Hide this element') && instanceBlock(await prompt(), '#c3 > h3.card-title').includes('Reference measurement to `button#cta` (`#cta`)') && !x2.includes('Also selected, no changes'), x2);
  // Alignment relationships: an element that only has an alignment is kept.
  await ui(() => {
    const it = __BL.S.batch.items[0];
    it.elementEdits[1].hidden = false;
    it.elementEdits[2].measures = [];
    it.elementEdits[2].alignEl = { x: null, y: { method: 'edges', edge: 'top', ref: { label: 'button#cta', selector: '#cta', text: '★ Shop now' }, shift: 10, group: { id: 'g1', size: 1 } } };
    it.elementEdits[1].alignEl = null;
  });
  const x3 = section(await prompt(), 1);
  check('Export: an alignment-only element keeps its instance and its alignment sentence; the unchanged one is only named', x3.includes('**Instance `h3.card-title` (`#c3 > h3.card-title`)**') && x3.includes('Align the top edge of `h3.card-title` (`#c3 > h3.card-title`) with `button#cta` (`#cta`)') && x3.includes('Also selected, no changes of their own') && !x3.includes('**Instance `h3.card-title` (`#c2 > h3.card-title`)**'), x3);
  check('No page errors (export filtering)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 9. Place next to: Center and Middle, page-width protection (fixtures/placement.html)
console.log('\n# Place next to: Center / Middle, off-page protection, Undo, CSS (fixtures/placement.html)');
{
  const page = await open('placement.html');
  const { ui, click, setCss, inline, changes, save, item, reopen, prompt, undo, section } = tools(page);
  const rect = (sel) => ui((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 }; }, sel);
  const near = (a, b) => Math.abs(a - b) <= 1;
  const H = async (v) => { await click(`.al-axes:not([hidden]) [data-al-h="${v}"]`); await sleep(40); };
  const V = async (v) => { await click(`.al-axes:not([hidden]) [data-al-v="${v}"]`); await sleep(40); };
  const al = () => ui(() => { const root = __BL.S.ui.root; const axes = root.querySelector('.al-axes:not([hidden])'); return { h: axes?.querySelector('[data-al-h][aria-pressed="true"]')?.textContent, v: axes?.querySelector('[data-al-v][aria-pressed="true"]')?.textContent, status: root.querySelector('.al-status').textContent, need: root.querySelector('.al-status').classList.contains('need') }; });
  const pickAt = async (sel, spec) => { const p = await pointFor(page, sel, spec); await page.mouse.move(p.x, p.y, { steps: 3 }); await page.mouse.down(); await page.mouse.up(); await sleep(120); };
  const scroll = () => ui(() => ({ x: scrollX, y: scrollY, wide: document.documentElement.scrollWidth > document.documentElement.clientWidth }));

  await shiftClick(page, await pointFor(page, '#box', 'text'));
  const ref0 = await rect('#ref');
  const box0 = await rect('#box');
  await click('[data-x="tool-align"]');
  await click('[data-al-mode="element"]');
  await sleep(60);
  await pickAt('#ref', 'text');
  await click('[data-al-method="next"]');

  // Center + Below / Above.
  await H('center');
  const c1 = await rect('#box');
  check('Center alone lines up the horizontal centers and leaves the vertical position', near(c1.cx, ref0.cx) && near(c1.t, box0.t) && (await al()).h === 'Center', JSON.stringify({ c1, ref0, box0 }));
  await V('below');
  const c2 = await rect('#box');
  check('Center + Below: centered under the reference, touching it', near(c2.cx, ref0.cx) && near(c2.t, ref0.b), JSON.stringify({ c2, ref0 }));
  await V('above');
  const c3 = await rect('#box');
  check('Center + Above: centered above the reference, touching it', near(c3.cx, ref0.cx) && near(c3.b, ref0.t), JSON.stringify({ c3, ref0 }));
  check('The reference stays put (no translate, same place)', JSON.stringify(await rect('#ref')) === JSON.stringify(ref0) && (await inline('#ref', 'translate')) === '');

  // Right of / Left of + Middle.
  await H('right-of'); await V('middle');
  const m1 = await rect('#box');
  check('Right of + Middle: to the right of the reference, vertically centered on it', near(m1.l, ref0.r) && near(m1.cy, ref0.cy), JSON.stringify({ m1, ref0 }));
  await H('left-of');
  const m2 = await rect('#box');
  check('Left of + Middle: to the left of the reference, vertically centered on it', near(m2.r, ref0.l) && near(m2.cy, ref0.cy), JSON.stringify({ m2, ref0 }));
  await V('');
  const m3 = await rect('#box');
  check('Middle then None puts the vertical position back', near(m3.t, box0.t) && near(m3.r, ref0.l), JSON.stringify({ m3, box0 }));

  // Center + Middle together would cover the reference: refused, pointing to Align edges.
  await H('center');
  const before = await rect('#box');
  await V('middle');
  const after = await rect('#box');
  const cm = await al();
  check('Center + Middle is not applied in Place next to; the status points to Align edges', JSON.stringify(after) === JSON.stringify(before) && cm.v === 'None' && cm.h === 'Center' && cm.need && cm.status.includes('Align edges'), JSON.stringify({ before, after, cm }));
  await click('[data-al-method="edges"]');
  await H('center'); await V('middle');
  const e1 = await rect('#box');
  check('Align edges centers on both axes', near(e1.cx, ref0.cx) && near(e1.cy, ref0.cy), JSON.stringify({ e1, ref0 }));
  await click('[data-al-method="next"]');

  // Undo walks back through placements.
  await click('[data-x="al-clear"]');
  await sleep(40);
  check('Remove alignment puts the element back', near((await rect('#box')).t, box0.t) && near((await rect('#box')).l, box0.l));
  await H('center'); await V('below');
  await undo();
  const u1 = await rect('#box');
  await undo();
  const u2 = await rect('#box');
  check('Undo steps back through the placement: Below first, then Center', near(u1.cx, ref0.cx) && near(u1.t, box0.t) && near(u2.l, box0.l) && near(u2.t, box0.t), JSON.stringify({ u1, u2, box0 }));

  // Place next to + Edit CSS.
  await H('center'); await V('below');
  await click('[data-x="tool-css"]');
  await setCss('width', '200px');
  const cc = await rect('#box');
  check('Center + Below keeps its relationship when Edit CSS changes the width (still centered, still touching)', near(cc.w, 200) && near(cc.cx, ref0.cx) && near(cc.t, ref0.b) && (await changes()).includes('width: 120px → 200px') && (await changes()).some((c) => c.startsWith('Placed below')), JSON.stringify({ cc, ch: await changes() }));
  await save('Centered below');
  const saved = await item(0);
  const ax = saved.elementEdits[0].alignEl;
  check('Saved: method, Center and Below, reference and the CSS value', ax.x.method === 'next' && ax.x.edge === 'center' && ax.y.method === 'next' && ax.y.edge === 'below' && ax.x.ref.selector === '#ref' && saved.elementEdits[0].tweaks.some((t) => t.prop === 'width' && t.to === '200px'), JSON.stringify(ax));
  const text1 = section(await prompt(), 1);
  check('Export: below the reference, touching it, and horizontally centered on it; the CSS change is part of it', text1.includes('immediately below `div#ref` (`#ref`), outside its box and touching it, and horizontally centered on it. Keep `div#ref` stationary.') && text1.includes('Apply the CSS changes listed below as part of it'), text1);
  await reopen(0);
  const ro = await al();
  await click('[data-x="tool-align"]');
  const ro2 = await al();
  check('Reopened: the Center and Below choices are restored', ro2.h === 'Center' && ro2.v === 'Below' && near((await rect('#box')).cx, ref0.cx), JSON.stringify({ ro, ro2 }));
  await H('right-of');
  await V('middle');
  await save('Right of and middle');
  const text2 = section(await prompt(), 1);
  check('Export: to the right of the reference, vertically centered on it', text2.includes('immediately to the right of `div#ref` (`#ref`), outside its box and touching it, and vertically centered on it.'), text2);
  await ui(() => { __BL.S.ui.root.querySelector('.list .item [data-act="del"]').click(); });
  await sleep(100);

  // Off-page protection: a 1100px-wide heading to the right of a reference that is 360px from the left edge.
  await shiftClick(page, await pointFor(page, '#wide', 'text'));
  const wide0 = await rect('#wide');
  await click('[data-x="tool-align"]');
  await click('[data-al-mode="element"]');
  await sleep(60);
  await pickAt('#ref', 'text');
  await click('[data-al-method="next"]');
  await V('below');
  const wideBelow = await rect('#wide');
  const sc0 = await scroll();
  await H('right-of');
  const wideRight = await rect('#wide');
  const wr = await al();
  const sc1 = await scroll();
  check('Right of that would push a very wide heading off the page is not applied: the earlier placement stays', JSON.stringify(wideRight) === JSON.stringify(wideBelow) && near(wideBelow.t, ref0.b) && near(wideRight.w, wide0.w), JSON.stringify({ wideBelow, wideRight }));
  check('A short warning explains it; the Align choices go back to the previous valid ones (Below, no horizontal)', wr.need && /past the right edge of the page/.test(wr.status) && wr.status.length < 220 && wr.h === 'None' && wr.v === 'Below', JSON.stringify(wr));
  check('The refused placement never resizes the element, scrolls the page or makes it scroll sideways', near(wideRight.w, 1100) && sc1.x === sc0.x && sc1.y === sc0.y && !sc1.wide, JSON.stringify({ sc0, sc1 }));
  await undo();
  check('The refused attempt adds no undo step: Undo reverts the earlier Below placement', near((await rect('#wide')).t, wide0.t), JSON.stringify({ now: await rect('#wide'), wide0 }));
  // A narrower element is fine on the same side.
  await ui(() => __BL.closePop());
  await shiftClick(page, await pointFor(page, '#box', 'text'));
  await click('[data-x="tool-align"]');
  await click('[data-al-mode="element"]');
  await sleep(60);
  await pickAt('#ref', 'text');
  await click('[data-al-method="next"]');
  await H('right-of');
  check('The same placement for a narrow element is applied', near((await rect('#box')).l, ref0.r), JSON.stringify(await rect('#box')));

  // Vertical placement on a scrollable page is always fine (a reference far below, off screen).
  await V('');
  await H('');
  await ui(() => scrollTo(0, 0));
  await ui(() => scrollTo(0, 1400));
  await click('[data-x="al-pick"]');
  await sleep(60);
  await pickAt('#ref2', 'text');
  const farRef = await ui(() => { const r = document.getElementById('ref2').getBoundingClientRect(); return { b: r.bottom + scrollY, cx: (r.left + r.right) / 2 }; });
  const yBefore = (await scroll()).y;
  await H('center'); await V('below');
  const farBox = await ui(() => { const r = document.getElementById('box').getBoundingClientRect(); return { t: r.top + scrollY, cx: (r.left + r.right) / 2 }; });
  const sc2 = await scroll();
  check('Vertical placement far down a scrollable page is applied, without scrolling the page', near(farBox.t, farRef.b) && near(farBox.cx, farRef.cx) && sc2.y === yBefore && !sc2.wide, JSON.stringify({ farBox, farRef, yBefore, sc2 }));
  // All four edges, clipping containers and decorative images.
  await ui(() => __BL.closePop());
  await ui(() => scrollTo(0, 0));
  const boundary = async (sel, h, v, expect) => {
    await ui(() => scrollTo(0, 0));
    await shiftClick(page, await pointFor(page, sel, sel === '#deco' ? [0.1, 0.5] : 'text'));
    await click('[data-x="tool-align"]');
    await click('[data-al-mode="element"]');
    await sleep(60);
    await pickAt('#ref', 'text');
    await click('[data-al-method="next"]');
    const was = await rect(sel);
    if (h) await H(h);
    if (v) await V(v);
    const now = await rect(sel);
    const st = await al();
    await ui(() => __BL.closePop());
    return { was, now, st, moved: Math.abs(now.l - was.l) > 1 || Math.abs(now.t - was.t) > 1 };
  };
  const refR = await rect('#ref');
  const left = await boundary('#wide', 'left-of', '');
  check('Left: a heading placed left of the reference that would leave the page is refused, with a warning naming the left edge', !left.moved && left.st.need && /past the left edge of the page/.test(left.st.status), JSON.stringify(left));
  const top = await boundary('#tbox', '', 'above');
  check('Top: an element that would end up above the top of the page is refused', !top.moved && top.st.need && /past the top edge of the page/.test(top.st.status), JSON.stringify(top));
  const small = await boundary('#box', 'left-of', 'middle');
  check('Inside the page on every side: placed normally (Left of + Middle)', small.moved && near(small.now.r, refR.l), JSON.stringify(small));
  const clipped = await boundary('#clipped', 'right-of', '');
  check('A heading in a container that clips it would be moved out of view: refused, naming the clipping container', !clipped.moved && clipped.st.need && /container that clips it/.test(clipped.st.status), JSON.stringify(clipped));
  const deco = await boundary('#deco', 'right-of', '');
  check('A decorative image in a clipping container may overflow on purpose: placed even past the page edge', deco.moved && near(deco.now.l, refR.r) && !deco.st.need, JSON.stringify(deco));
  const decoL = await boundary('#deco', 'left-of', '');
  check('Decorative images are not limited on the left either', decoL.moved && near(decoL.now.r, refR.l), JSON.stringify(decoL));
  // Bottom: a page that scrolls reaches anything below; a page that can't scroll doesn't.
  await ui(() => { document.documentElement.style.overflow = 'hidden'; });
  await shiftClick(page, await pointFor(page, '#box', 'text'));
  await click('[data-x="tool-align"]');
  await click('[data-al-mode="element"]');
  await sleep(60);
  await pickAt('#ref', 'text');
  await click('[data-al-method="next"]');
  await ui(() => { __BL.toolsApi.getP().alignUi.ref = { ...__BL.toolsApi.getP().alignUi.ref, el: document.getElementById('ref2'), info: { label: 'div#ref2', selector: '#ref2', text: 'Far reference' } }; });
  const lockedBefore = await rect('#box');
  await H('center');
  await V('below');
  const lockedAfter = await rect('#box');
  const lockedSt = await al();
  await ui(() => { document.documentElement.style.overflow = ''; });
  check('Bottom: on a page that can’t scroll, placing it below the visible area is refused (the center placement stays)', near(lockedAfter.t, lockedBefore.t) && lockedSt.need && /past the bottom edge of the page/.test(lockedSt.status) && lockedSt.v === 'None', JSON.stringify({ lockedBefore, lockedAfter, lockedSt }));
  await V('below');
  const reach = await ui(() => { const r = document.getElementById('box').getBoundingClientRect(); const f = document.getElementById('ref2').getBoundingClientRect(); return { box: r.top + scrollY, ref: f.bottom + scrollY }; });
  check('The same placement on a page that scrolls is applied: content below the viewport is reachable', near(reach.box, reach.ref), JSON.stringify(reach));
  await ui(() => __BL.closePop());
  check('Align edges and Move are not restricted: right edges aligned to the reference may sit where Place next to would be refused', await (async () => {
    await ui(() => scrollTo(0, 0));
    await shiftClick(page, await pointFor(page, '#wide', 'text'));
    await click('[data-x="tool-align"]');
    await click('[data-al-mode="element"]');
    await sleep(60);
    await pickAt('#ref', 'text');
    await H('right');
    const r = await rect('#wide');
    const ok = near(r.r, refR.r);
    await ui(() => __BL.closePop());
    return ok;
  })());
  check('No page errors (placement)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 11. Shift+hover at start, Describe placeholder
console.log('\n# Shift+hover works from the first move; the Describe placeholder follows the recorded changes');
{
  const page = await open('nested.html');
  const hl = () => page.evaluate(() => { const h = __BL.S.ui.root.querySelector('.hl2'); return h && !h.hidden ? h.querySelector('.hl-tag').textContent : null; });
  const point = (id) => page.evaluate((id) => { const el = document.getElementById(id); const rg = document.createRange(); rg.selectNodeContents(el); const r = rg.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, id);
  const ids = () => page.evaluate(() => (__BL.toolsApi.getP()?.els || []).map((e) => e.id));

  // Straight after load: no click first.
  const p1 = await point('p1');
  await page.mouse.move(p1.x - 60, p1.y, { steps: 2 });
  await page.keyboard.down('Shift');
  await page.mouse.move(p1.x, p1.y, { steps: 3 });
  const h1 = await hl();
  check('Fresh load: Shift then moving over an element shows its outline, with no click first', !!h1 && h1.startsWith('p'), String(h1));
  await page.keyboard.up('Shift');
  check('Releasing Shift hides it', (await hl()) === null);

  // The page kept focus in a text field (an autofocused search box): the outline must still show.
  await page.evaluate(() => { const i = document.createElement('input'); i.id = 'q'; i.style.cssText = 'position:fixed;left:-300px;top:0'; document.body.appendChild(i); i.focus(); });
  const p2 = await point('p2');
  await page.mouse.move(p2.x - 60, p2.y, { steps: 2 });
  await page.keyboard.down('Shift');
  await page.mouse.move(p2.x, p2.y, { steps: 3 });
  const h2 = await hl();
  check('With a page text field still focused, moving the pointer with Shift held still shows the outline', !!h2 && h2.startsWith('p'), String(h2));
  await page.keyboard.up('Shift');
  // Shift alone while typing in that field (pointer idle) shows nothing: Shift is for capital letters.
  await page.keyboard.down('Shift');
  await sleep(60);
  check('The Shift key alone in a focused text field shows no outline (typing capitals)', (await hl()) === null);
  await page.keyboard.up('Shift');
  await page.evaluate(() => document.getElementById('q').blur());
  await page.keyboard.down('Shift');
  await sleep(60);
  check('Without a focused field, pressing Shift over an element shows its outline at once', !!(await hl()));
  await page.keyboard.up('Shift');

  // Shift+click and Shift+drag keep working, and nothing was clicked on the page.
  await shiftClick(page, await point('p1'));
  check('Shift+click still selects', (await ids()).join() === 'p1', JSON.stringify(await ids()));
  await page.evaluate(() => __BL.closePop());
  await shiftDrag(page, await rectAround(page, ['p1', 'p2']));
  check('Shift+drag still selects an area', (await ids()).join() === 'p1,p2', JSON.stringify(await ids()));
  await page.evaluate(() => __BL.closePop());

  // A single-page app changes the page without a load: the outline works on what it adds, still without a click.
  await page.evaluate(() => { history.pushState({}, '', '#/next'); document.body.insertAdjacentHTML('beforeend', '<section><p id="spa" style="margin:0">Added by a route change</p></section>'); });
  const p3 = await point('spa');
  await page.mouse.move(p3.x - 60, p3.y, { steps: 2 });
  await page.keyboard.down('Shift');
  await page.mouse.move(p3.x, p3.y, { steps: 3 });
  check('After a client-side navigation the outline shows on newly added content', (await hl()) === 'p#spa ' + (await page.evaluate(() => { const r = document.getElementById('spa').getBoundingClientRect(); return `${Math.round(r.width)}×${Math.round(r.height)}`; })) || !!(await hl()), String(await hl()));
  await page.keyboard.up('Shift');
  check('No page errors (Shift+hover)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

{
  const page = await open('toolbox.html');
  const { ui, T, click, setCss, choose, save, undo } = tools(page);
  const ph = () => ui(() => __BL.S.ui.root.querySelector('.pop-note').placeholder);
  const NONE = 'No changes detected. Describe what you’d like changed.';
  const SOME = 'Optional: Add any additional details about your changes.';
  await shiftClick(page, await pointFor(page, T('t1'), 'text'));
  check('Describe placeholder with nothing recorded', (await ph()) === NONE, await ph());
  await ui(() => { __BL.S.ui.root.querySelector('.pop-note').value = 'My own words'; });
  await click('[data-x="hide"]');
  check('Toolbox: a recorded change switches the placeholder to the optional one', (await ph()) === SOME, await ph());
  await undo();
  check('Undo puts the first placeholder back', (await ph()) === NONE, await ph());
  check('What was typed is never erased', (await ui(() => __BL.S.ui.root.querySelector('.pop-note').value)) === 'My own words');
  await click('[data-x="tool-css"]');
  await setCss('font-size', '30');
  check('Edit CSS: a value change switches it', (await ph()) === SOME, await ph());
  await click('.chg button[data-prop="font-size"]');
  check('✕ on the only change switches it back', (await ph()) === NONE, await ph());
  await click('[data-x="tool-align"]');
  await ui(() => { const P = __BL.toolsApi.getP(); P.marks.push({ t: 'box', c: '#E5239D', a: { x: 10, y: 10 }, b: { x: 50, y: 50 } }); __BL.toolsApi.getP(); });
  await click('[data-x="tool-draw"]');
  await ui(() => __BL.render());
  await click('[data-x="tool-elements"]');
  check('Annotate: a drawn mark switches it', (await ph()) === SOME, await ph());
  await ui(() => { __BL.toolsApi.getP().marks.length = 0; });
  await click('[data-x="tool-css"]');
  await click('[data-x="tool-elements"]');
  check('Removing the mark switches it back', (await ph()) === NONE, await ph());
  // Measure
  await click('[data-x="tb-measure"]');
  await sleep(60);
  const p = await pointFor(page, T('p2'), 'text');
  await page.mouse.move(p.x, p.y, { steps: 3 }); await page.mouse.down(); await page.mouse.up(); await sleep(120);
  check('Measure: a measurement switches it', (await ph()) === SOME, await ph());
  await undo();
  check('Undoing the measurement switches it back', (await ph()) === NONE, await ph());
  // Validation is unchanged: with nothing recorded and nothing written, saving is refused; a recorded change lets it save.
  await ui(() => { __BL.S.ui.root.querySelector('.pop-note').value = ''; });
  const before = await ui(() => (__BL.S.batch?.items || []).length);
  await click('[data-act="pop-save"]');
  await sleep(200);
  const refused = { saved: (await ui(() => (__BL.S.batch?.items || []).length)) === before, need: await ui(() => __BL.S.ui.root.querySelector('.pop-note').classList.contains('need')), open: await ui(() => !!__BL.S.pop) };
  check('Existing validation: nothing recorded and no description is refused', refused.saved && refused.need && refused.open, JSON.stringify(refused));
  await click('[data-x="hide"]');
  await click('[data-act="pop-save"]');
  await sleep(400);
  check('Existing validation: a recorded change saves without a description', (await ui(() => __BL.S.batch.items.length)) === before + 1 && !(await ui(() => !!__BL.S.pop)));
  check('No page errors (placeholder)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 12. Concise export (fixtures/toolbox.html)
console.log('\n# Change Report export: concise, change-focused, older notes still export (fixtures/toolbox.html)');
{
  const page = await open('toolbox.html');
  const { ui, T, click, setCss, choose, save, item, prompt, instanceBlock, section } = tools(page);
  const REMOVED = ['How to read this request', 'Finding the source', '## Overview', 'Suggested order', '## Annotation key', 'Likely sources', 'Items not marked broken are visual'];

  check('The Home-screen button reads Export Change Report', (await ui(() => __BL.S.ui.root.querySelector('[data-act="export"]').textContent.trim())) === 'Export Change Report' && (await ui(() => __BL.S.ui.root.querySelector('.sheet').getAttribute('aria-label'))) === 'Export Change Report');

  // A CSS note on two instances: different values, scope and screen sizes.
  await shiftClick(page, await pointFor(page, T('t1'), 'text'));
  await shiftClick(page, await pointFor(page, T('t2'), 'text'));
  await choose(0); await click('[data-x="tool-css"]'); await setCss('font-size', '30');
  await choose(1); await setCss('color', '#005EB8');
  await ui(() => { const r = __BL.S.ui.root.querySelector('[name="scope"][value="all"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('[data-bp="mobile"]');
  await save('Make the titles stand out');
  const text = await prompt();
  const x1 = section(text, 1);
  check('Structure: title, Page, short Notes, then the item; none of the removed boilerplate', text.startsWith('# Webpage Change Request') && text.includes('## Page') && text.includes('## Notes') && REMOVED.every((r) => !text.includes(r)), text.slice(0, 900));
  check('The export is short for one note: no tutorials, overview, or per-item computed styles and markup', text.length < 4200 && !x1.includes('Computed:') && !x1.includes('- Markup:') && !x1.includes('- Layout:') && !x1.includes('**Inspection**'), `${text.length} chars`);
  check('Viewport is stated once, not on every item', (text.match(/- Viewport: 1280×900/g) || []).length === 1 && !/## 1\..*1280×900/.test(x1), x1.split('\n')[0]);
  check('Screen sizes are on the item heading (mobile + desktop here)', /## 1\. Change: .*\(mobile \+ desktop\)/.test(x1), x1.split('\n')[0]);
  check('The target keeps its element, selector and classes', x1.includes('- Element: `h3.card-title`') && x1.includes('- Selector: `#c1 > h3.card-title`') && x1.includes('- Classes: `card-title`'), x1);
  check('CSS changes keep rule, source, selector, original and new values', instanceBlock(text, '#c1 > h3.card-title').includes('CSS rule `.card-title` in inline <style> 1:') && instanceBlock(text, '#c1 > h3.card-title').includes('font-size: 18px → 30px') && instanceBlock(text, '#c2 > h3.card-title').includes('color: added → #005EB8'), x1);
  check('Two instances: each has its own block and its own scope; the Notes line says values are previews and Scope says where they go', x1.includes('**Instance `h3.card-title` (`#c1 > h3.card-title`)**') && x1.includes('**Instance `h3.card-title` (`#c2 > h3.card-title`)**') && text.includes('Values were previewed live on the selected element only') && text.includes('**Scope** says where the real change goes'), x1);
  const scopes = [...x1.matchAll(/Scope: \*\*([^*]+)\*\*/g)].map((m) => m[1]);
  check('The scope of each instance is stated once', scopes.length === 2 && scopes.every((x) => /everywhere|this one only/.test(x)), JSON.stringify(scopes));

  // Responsive: all sizes, and a second viewport.
  await ui(() => { __BL.S.batch.items[0].bps = ['mobile', 'tablet', 'desktop']; });
  check('All three screen sizes read "all breakpoints"', /## 1\. .*\(all breakpoints\)/.test(section(await prompt(), 1)));
  await ui(() => { const it = JSON.parse(JSON.stringify(__BL.S.batch.items[0])); it.id = 'v2'; it.viewport = { w: 390, h: 800 }; it.bps = ['mobile']; __BL.S.batch.items.push(it); });
  const t2 = await prompt();
  check('When items were made at different viewport sizes, each item names its own and there is no single viewport line', !t2.includes('- Viewport:') && /## 1\. .*1280×900\)/.test(section(t2, 1)) && /## 2\. .*\(mobile, 390×800\)/.test(section(t2, 2)), t2.split('\n').filter((l) => /^## \d|Viewport/.test(l)).join(' | '));
  await ui(() => { __BL.S.batch.items.pop(); });

  // Alignment, measurements and reference-only items.
  await ui(() => {
    const el = document.querySelector('[data-t="t3"]');
    const info = __BLUELINE_TEST__.api.describe(el, 'change');
    const ref = { label: 'button#cta', selector: '#cta', text: '★ Shop now' };
    const rec = (extra) => ({ el: { label: info.el.label, selector: info.el.selector, text: 'x', size: '1×1' }, scope: { mode: 'one', count: 1, selector: 'h3.card-title', similar: 3, chosen: false }, tweaks: [], textEdit: null, hidden: false, match: null, move: null, align: [], alignEl: null, measures: [], ...extra });
    __BL.S.batch.items.push({ id: 'al1', note: '', createdAt: Date.now(), ...info, bps: ['desktop'], elementEdits: [rec({ alignEl: { x: null, y: { method: 'next', edge: 'below', ref, shift: 40, group: { id: 'g', size: 1 } } }, tweaks: [{ prop: 'translate', from: 'none', to: '0px 40px', snap: true }] })] });
    __BL.S.batch.items.push({ id: 'ref1', note: '', createdAt: Date.now(), ...info, bps: ['desktop'], elementEdits: [rec({ measures: [{ label: 'button#cta', selector: '#cta', summary: '24px below' }] })] });
  });
  const t3 = await prompt();
  const a = section(t3, 2);
  const r = section(t3, 3);
  check('Alignment: the relationship is stated with its reference, and the "build it with layout" advice appears once in Notes, not per item', a.includes('immediately below `button#cta` (`#cta`), outside its box and touching it. Keep `button#cta` stationary.') && (t3.match(/not a fixed offset or transform/g) || []).length === 1 && t3.includes('Any pixel shift is only a preview') && a.includes('Alignment (described above) was previewed with a shift of 40px down'), a);
  check('Reference-only: marked as such, measurement labelled as context, and no inspection dump', section(t3, 3).split('\n')[0].includes('(reference only)') && r.includes('Reference measurement to `button#cta` (`#cta`)') && r.includes('change nothing for this item') && !r.includes('**Inspection**') && t3.includes('Measurements and sampled colors are reference only'), r);

  // A bug keeps the diagnostic context.
  await ui(() => {
    const el = document.querySelector('[data-t="t3"]');
    const info = __BLUELINE_TEST__.api.describe(el, 'bug');
    __BL.S.batch.items.push({ id: 'bug1', note: 'Price is cut off', createdAt: Date.now(), ...info, type: 'bug', armed: true, bps: ['desktop'], steps: [{ kind: 'click', what: 'button#cta', path: info.path }], console: [{ level: 'error', msg: 'TypeError: x is undefined' }] });
  });
  const b = section(await prompt(), 4);
  check('A bug keeps its inspection (computed styles, box, markup), reproduction steps and console', b.includes('**Inspection**') && b.includes('- Computed:') && b.includes('- Box:') && b.includes('- Markup:') && b.includes('**Steps before the note**') && b.includes('1. click button#cta') && b.includes('TypeError: x is undefined'), b);
  // An item with no CSS rule recorded gets the matched rules so the source can be found, but not the full dump.
  await ui(() => {
    const el = document.querySelector('[data-t="t2"]');
    const info = __BLUELINE_TEST__.api.describe(el, 'change');
    __BL.S.batch.items.push({ id: 'plain1', note: 'Make this heading bigger', createdAt: Date.now(), ...info, bps: ['desktop'] });
  });
  const p = section(await prompt(), 5);
  check('A note with no recorded values gets matched rules (to find the source) but not computed styles or markup', p.includes('- Matched rules (cascade order):') && !p.includes('- Computed:') && !p.includes('- Markup:'), p);

  // Older saved notes.
  await ui(() => {
    const info = __BLUELINE_TEST__.api.describe(document.querySelector('[data-t="t1"]'), 'polish');
    const also = [{ label: 'h3.card-title', selector: '#c2 > h3.card-title', text: 'Creatine', size: '220×27' }];
    __BL.S.batch.items.push({ id: 'old1', note: 'Older note', createdAt: Date.now(), ...info, type: 'polish', priority: 'nice', bps: ['desktop'], tweaks: [{ prop: 'font-weight', from: '600', to: '800' }], also, scope: { mode: 'one', count: 1, selector: 'h3.card-title', similar: 3, chosen: false } });
  });
  const o = section(await prompt(), 6);
  check('An older note (one set of edits, priority, "also") still exports its target, previewed values and the other elements', o.startsWith('## 6. Polish: ') && o.includes('- Selector: `#c1 > h3.card-title`') && o.includes('Previewed by the author (on all selected elements): font-weight 600 → 800') && o.includes('Also applies to 1 more element') && o.includes('`#c2 > h3.card-title`') && !/nice to have/i.test(o), o);
  const all = await prompt();
  check('Whatever the mix, no removed boilerplate comes back', REMOVED.every((r) => !all.includes(r)) && !all.includes('Repeated'), all.slice(0, 600));
  check('No page errors (export)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 13. Change Report dialog: Export Screenshots is explicit
console.log('\n# Change Report dialog: screenshots download only when Export Screenshots is pressed (fixtures/toolbox.html)');
{
  const page = await open('toolbox.html');
  const { ui, click, prompt } = tools(page);
  await ui(() => {
    window.__calls = [];
    window.__dlFail = false;
    chrome.runtime.sendMessage = async (m) => {
      if (m && m.type === 'blueline:hello') return { active: true };
      window.__calls.push({ type: m?.type, names: (m?.files || []).map((f) => f.name), folder: m?.folder });
      if (m?.type === 'blueline:download') return window.__dlFail ? { error: 'blocked' } : { paths: m.files.map((f) => ({ id: f.id, path: `/Users/me/Downloads/${m.folder}/${f.name}` })) };
      return null;
    };
    chrome.storage.local.get = async (keys) => Object.fromEntries([].concat(keys).map((k) => [k, 'data:image/png;base64,AAAA']));
    __BL.ensureBatch();
    const info = __BLUELINE_TEST__.api.describe(document.querySelector('[data-t="t1"]'), 'change');
    __BL.S.batch.items.push({ id: 'aaaa1111', note: 'First', createdAt: Date.now(), ...info, bps: ['desktop'], hasShot: true });
    __BL.S.batch.items.push({ id: 'bbbb2222', note: 'Second', createdAt: Date.now(), ...info, bps: ['desktop'], hasShot: true, hasMarkup: true });
    __BL.render();
  });
  const calls = () => ui(() => window.__calls.filter((c) => c.type === 'blueline:download'));
  const dlg = () => ui(() => { const r = __BL.S.ui.root; return { shots: r.querySelector('[data-act="export-shots"]').textContent.trim(), disabled: r.querySelector('[data-act="export-shots"]').disabled, checkbox: r.querySelectorAll('.opt-shots').length, copy: r.querySelector('[data-act="copy"]').textContent.trim(), note: r.querySelector('.shots-note').textContent, md: r.querySelector('[data-act="save-md"]').textContent.trim() }; });
  const shotLines = async () => (await prompt()) && ui(() => __BL.S.ui.root.querySelector('.out').value.split('\n').filter((l) => /^(Marked-up )?[Ss]creenshot/.test(l)));

  await click('[data-act="export"]');
  await sleep(300);
  const d0 = await dlg();
  check('Opening the Change Report downloads nothing', (await calls()).length === 0, JSON.stringify(await calls()));
  check('Export Screenshots uses the same blue button style as Copy Report', await ui(() => { const r = __BL.S.ui.root; const shots = r.querySelector('[data-act="export-shots"]'); const copy = r.querySelector('[data-act="copy"]'); return shots.className === copy.className && getComputedStyle(shots).backgroundColor === getComputedStyle(copy).backgroundColor && getComputedStyle(shots).color === 'rgb(255, 255, 255)'; }));
  check('There is an Export Screenshots button and no screenshot checkbox; the copy button reads Copy Report', d0.shots === 'Export Screenshots' && !d0.disabled && d0.checkbox === 0 && d0.copy === 'Copy Report' && d0.md === 'Save as .md', JSON.stringify(d0));
  check('Before exporting, the report doesn’t list screenshot paths and the dialog says they are not exported', (await shotLines()).length === 0 && /3 screenshots not exported/.test(d0.note), JSON.stringify(d0.note));
  await click('[data-act="copy"]');
  await sleep(200);
  check('Copying the report downloads nothing', (await calls()).length === 0, JSON.stringify(await calls()));
  await click('[data-act="save-md"]');
  await sleep(300);
  const md = await calls();
  check('Saving the Markdown report downloads only the report, never screenshots', md.length === 1 && md[0].names.join() === 'blueline-change-report.md', JSON.stringify(md));
  check('The report is still free of screenshot paths after saving it', (await shotLines()).length === 0);

  // A failed export is not reported as done.
  await ui(() => { window.__dlFail = true; });
  await click('[data-act="export-shots"]');
  await sleep(300);
  const f = await dlg();
  check('If the download fails, the dialog says so and the report lists no screenshots', /Screenshots not saved: blocked/.test(f.note) && (await shotLines()).length === 0, JSON.stringify(f.note));

  // The explicit export.
  await ui(() => { window.__dlFail = false; });
  await click('[data-act="export-shots"]');
  await sleep(300);
  const shots = (await calls()).filter((c) => c.names.some((n) => n.endsWith('.png')));
  const after = await dlg();
  const lines = await shotLines();
  check('Export Screenshots downloads each screenshot once, with numbered names', shots.length === 2 && shots[1].names.join() === '01-aaaa.png,02-bbbb.png,02-bbbb-markup.png', JSON.stringify(shots));
  check('The report now references them with the same file names', lines.length === 3 && lines[0].endsWith('/01-aaaa.png') && lines[1].endsWith('/02-bbbb.png') && lines[2].includes('Marked-up screenshot:') && lines[2].endsWith('/02-bbbb-markup.png'), JSON.stringify(lines));
  check('The dialog reports where they were saved', /Screenshots saved in \/Users\/me\/Downloads\/blueline\//.test(after.note), after.note);
  const n = (await calls()).length;
  await click('[data-act="export-shots"]');
  await sleep(200);
  check('Pressing it again doesn’t download them twice', (await calls()).length === n);
  await click('[data-act="modal-close"]');
  await click('[data-act="export"]');
  await sleep(300);
  check('Reopening the report downloads nothing and keeps the references', (await calls()).length === n && (await shotLines()).length === 3);

  // No screenshots at all.
  await ui(() => { for (const it of __BL.S.batch.items) { it.hasShot = false; it.hasMarkup = false; it.shotPath = null; it.markupPath = null; } });
  await click('[data-act="modal-close"]');
  await click('[data-act="export"]');
  await sleep(300);
  const none = await dlg();
  check('With no screenshots the button is disabled and says so', none.disabled && /No screenshots/.test(none.note), JSON.stringify(none));
  check('No page errors (Change Report dialog)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 10. CSS rule restoration safety (fixtures/css-rules.html)
console.log('\n# A saved CSS change is never attached to an unrelated rule (fixtures/css-rules.html)');
{
  const page = await open('css-rules.html', { http: true });
  const { ui, click, save, item, reopen, prompt, section } = tools(page);
  const baseRules = await ui(() => __BL.cssRulesFor(document.getElementById('pt-2')).rules.filter((r) => r.matched === '.product-title' && r.source.label === '<style id="base">' && !r.context).map((r) => ({ path: r.path, props: r.decls.map((d) => d.prop).join() })));
  const rA = baseRules.find((r) => r.props.includes('font-size'));
  const rB = baseRules.find((r) => r.props.includes('margin-bottom'));
  const baseCount = await ui(() => document.getElementById('base').sheet.cssRules.length);
  const baseText = await ui(() => [...document.getElementById('base').sheet.cssRules].filter((r) => r.selectorText === '.product-title').map((r) => r.style.cssText).join('|'));
  check('Fixture: two unconditional .product-title rules in the base sheet (font-size; margin-bottom)', baseRules.length === 2 && !!rA && !!rB && rA.path !== rB.path, JSON.stringify(baseRules));
  const inject = (id, tweak, selector = '#pt-2', matched = '.product-title') => ui((id, tweak, selector, matched) => {
    const el = document.querySelector(selector);
    const info = __BLUELINE_TEST__.api.describe(el, 'change');
    const rule = { key: `${matched}|<style id="base">||9`, kind: 'class', selector: matched, matched, source: '<style id="base">', file: 'base', path: tweak.path, ...tweak.rule };
    const t = { prop: tweak.prop, from: tweak.from, to: tweak.to, declared: tweak.declared, rule, ...(tweak.important ? { important: true } : {}) };
    __BL.S.batch.items.push({ id, note: 'Saved', createdAt: Date.now(), ...info, bps: ['desktop'], elementEdits: [{ el: { label: info.el.label, selector: info.el.selector, text: 'x', size: '1×1' }, scope: { mode: 'one', count: 1, selector: matched, similar: 1, chosen: false }, tweaks: [t], textEdit: null, hidden: false, match: null, move: null, align: [], alignEl: null, measures: [] }] });
    __BL.saveBatch(); __BL.render();
  }, id, tweak, selector, matched);
  const result = async (n) => { await reopen(n); await save('Update'); return (await item(n)).elementEdits[0].tweaks[0]; };
  const keyOf = (path) => ui((path) => __BL.cssRulesFor(document.getElementById('pt-2')).rules.find((r) => r.path === path).source.label, path);

  const linked = (t, path) => !t.rule.notFound && t.rule.path === path && !t.rule.key.endsWith('|9');
  const unresolved = (t) => t.rule.notFound === true && t.rule.key.endsWith('|9');
  await ui(() => { __BL.ensureBatch(); });

  // 1. Duplicate rules (same selector, source, condition): told apart by what they declare, not by position.
  //    The saved key is gone and the saved position now belongs to the other rule.
  await inject('dup1', { prop: 'font-size', from: '1.5rem', to: '2rem', declared: true, path: rB.path });
  const t1 = await result(0);
  check('Duplicate rules: the change goes to the rule that declares its property, not to the rule at its old position', linked(t1, rA.path), JSON.stringify(t1.rule));
  await inject('dup2', { prop: 'margin-bottom', from: '8px', to: '12px', declared: true, path: rA.path });
  const t2 = await result(1);
  check('Duplicate rules: a margin-bottom change goes to the rule that declares margin-bottom, and the rules stay separate', linked(t2, rB.path) && t1.rule.key !== t2.rule.key, JSON.stringify({ a: t1.rule.key, b: t2.rule.key }));
  // 2. Values changed in the source since: still the same rule.
  await inject('val1', { prop: 'font-size', from: '9px', to: '2rem', declared: true, path: '99/99' });
  const t3 = await result(2);
  check('Duplicate rules: a changed source value still reconnects (by declaration), keeping the saved values', linked(t3, rA.path) && t3.from === '9px' && t3.to === '2rem', JSON.stringify(t3));
  await inject('val2', { prop: 'padding', from: '3px', to: '5px', declared: true, path: '0', rule: { matched: '.stack', selector: '.stack', key: '.stack|<style id="base">||9' } }, '#stack', '.stack');
  const t4 = await result(3);
  check('Unique rule: the only rule with that selector, source and condition reconnects even though its value changed', !t4.rule.notFound && !t4.rule.key.endsWith('|9') && t4.rule.matched === '.stack' && t4.from === '3px' && t4.to === '5px', JSON.stringify(t4));
  // 3. Ambiguous: nothing tells the two rules apart.
  await inject('amb1', { prop: 'margin-top', from: '', to: '9px', declared: false, path: rA.path });
  const t5 = await result(4);
  check('Ambiguous: two rules, only an added property, and a matching position: not guessed (position alone is not enough)', unresolved(t5) && t5.rule.path === rA.path, JSON.stringify(t5));
  const e5 = section(await prompt(), 5);
  check('Ambiguous: the change is kept with its selector, source, values and scope, flagged not found, and still previewed', e5.includes('CSS rule `.product-title` in <style id="base">: Not found on the page when saved') && e5.includes('margin-top: added → 9px') && e5.includes('Scope: **this one only**') && (await ui(() => document.getElementById('pt-2').style.marginTop)) === '9px', e5);
  await inject('amb2', { prop: 'margin-top', from: '', to: '9px', declared: false, path: '99/99', rule: { decls: [{ prop: 'margin-bottom', value: '8px', important: true }] } });
  const t6 = await result(5);
  check('A saved list of the rule’s properties identifies it among duplicates, even when the changed property was only added', linked(t6, rB.path), JSON.stringify(t6.rule));
  // 4. The cascade information is kept.
  await inject('imp1', { prop: 'margin-bottom', from: '8px', to: '12px', declared: true, path: rB.path, rule: {}, important: true });
  const t7 = await result(6);
  const e7 = section(await prompt(), 7);
  check('!important on the rule’s declaration is kept and exported; rule source, selector and values stay as saved', t7.important === true && t7.rule.decls.some((d) => d.prop === 'margin-bottom' && d.important === true) && e7.includes('margin-bottom: 8px → 12px (the rule declares it !important)') && t7.rule.source === '<style id="base">', e7);
  check('The page’s own stylesheet rules are never changed by any of this', (await ui(() => document.getElementById('base').sheet.cssRules.length)) === baseCount && (await ui(() => [...document.getElementById('base').sheet.cssRules].filter((r) => r.selectorText === '.product-title').map((r) => r.style.cssText).join('|'))) === baseText);
  check('No page errors (rule restoration)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 8. Slice 2C: CSS previews after Save Note (real storage behaviour)
console.log('\n# CSS previews stay after Save Note, with Chrome-like storage (fixtures/css-rules.html)');
{
  const page = await open('css-rules.html', { http: true, realStorage: true });
  const ui = (fn, ...a) => page.evaluate(fn, ...a);
  const click = (sel) => ui((sel) => __BL.S.ui.root.querySelector(sel).click(), sel);
  const inline = (sel, prop) => ui((sel, prop) => document.querySelector(sel).style.getPropertyValue(prop), sel, prop);
  const computed = (sel, prop) => ui((sel, prop) => getComputedStyle(document.querySelector(sel))[prop], sel, prop);
  const setRow = (prop, value) => ui((prop, value) => { const i = __BL.S.ui.root.querySelector(`.style-rows .st[data-prop="${prop}"] .sv`); i.value = value; i.dispatchEvent(new Event('input', { bubbles: true })); }, prop, value);
  const addProp = (prop) => ui((prop) => { const root = __BL.S.ui.root; if (root.querySelector('.css-add-box').hidden) root.querySelector('[data-x="css-add"]').click(); const qi = root.querySelector('.css-add-q'); qi.value = prop; qi.dispatchEvent(new Event('input', { bubbles: true })); root.querySelector(`.css-add-opt[data-prop="${prop}"]`).click(); }, prop);
  const save = async (note) => { await ui((note) => { __BL.S.ui.root.querySelector('.pop-note').value = note; }, note); await click('[data-act="pop-save"]'); };

  await shiftClick(page, await pointFor(page, '#plain', 'text'));
  await click('[data-x="tool-css"]');
  await addProp('color');
  await setRow('color', 'red');
  await addProp('border');
  await setRow('border', '2px solid red');
  check('Editing: color and border preview', (await computed('#plain', 'color')) === 'rgb(255, 0, 0)' && (await computed('#plain', 'borderTopWidth')) === '2px');
  await save('Red collections');
  const samples = [];
  for (const wait of [0, 50, 300, 1200]) { await sleep(wait); samples.push(await ui(() => { const e = document.getElementById('plain'); const c = getComputedStyle(e); return `${c.color}|${c.borderTopWidth}|${e.getAttribute('style')}`; })); }
  check('After Save Note the color and border are still previewed (immediately, and after storage change events and refreshes)', samples.every((s) => s.startsWith('rgb(255, 0, 0)|2px')), JSON.stringify(samples));
  check('The blue outline remains too', (await ui(() => !!__BL.S.ui.root.querySelector('.x-marksbox .mk'))));
  // "Hide my live edits" left on from an earlier session: editing and saving shows the changes again.
  await ui(() => { __BL.S.prefs.previews = false; });
  await shiftClick(page, await pointFor(page, '#stack', 'text'));
  await click('[data-x="tool-css"]');
  await addProp('color');
  await setRow('color', 'red');
  check('Hidden previews: a new CSS edit switches live edits back on', (await ui(() => __BL.S.prefs.previews)) === true && (await computed('#stack', 'color')) === 'rgb(255, 0, 0)');
  await ui(() => { __BL.S.prefs.previews = false; });
  await save('Red stack');
  await sleep(1200);
  check('Hidden previews: saving a note with changes shows them (and the button says Hide my live edits)', (await computed('#stack', 'color')) === 'rgb(255, 0, 0)' && (await ui(() => __BL.S.prefs.previews)) === true && (await ui(() => __BL.S.ui.root.querySelector('[data-x="previews"] b').textContent)) === 'Hide my live edits');
  // The toggle itself still hides and shows saved edits.
  await click('[data-x="previews"]');
  await sleep(300);
  check('Hide my live edits still hides saved edits, Show brings them back', (await computed('#stack', 'color')) !== 'rgb(255, 0, 0)' && (await computed('#plain', 'borderTopWidth')) === '0px');
  await click('[data-x="previews"]');
  await sleep(300);
  check('Show my live edits restores color and border', (await computed('#stack', 'color')) === 'rgb(255, 0, 0)' && (await computed('#plain', 'borderTopWidth')) === '2px');
  check('No page errors (preview after save)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 9. Slice 2C: previews while editing other notes
console.log('\n# Saved CSS previews stay while other notes are edited, undone, cancelled or for other screen sizes (fixtures/css-rules.html)');
{
  const page = await open('css-rules.html', { http: true, realStorage: true });
  const { ui, click, setCss, save, T } = tools(page);
  const computed = (sel, prop) => ui((sel, prop) => getComputedStyle(document.querySelector(sel))[prop], sel, prop);
  const edit = async (sel, prop, value) => { await shiftClick(page, await pointFor(page, sel, 'text')); await click('[data-x="tool-css"]'); await setCss(prop, value); };

  await edit('#stack', 'color', 'red');
  await setCss('border', '3px solid red');
  await save('Note A');
  await sleep(500);
  check('Setup: the saved note previews color and border', (await computed('#stack', 'color')) === 'rgb(255, 0, 0)' && (await computed('#stack', 'borderTopWidth')) === '3px');

  // Another note on a different element: nothing about the first one changes.
  await edit('#plain', 'letter-spacing', '3px');
  await setCss('padding', '9px');
  await sleep(1200);
  check('A second note on another element: the first note’s color and border stay while it is edited (and after refreshes)', (await computed('#stack', 'color')) === 'rgb(255, 0, 0)' && (await computed('#stack', 'borderTopWidth')) === '3px' && (await computed('#plain', 'letterSpacing')) === '3px');
  await ui(() => __BL.closePop());
  await sleep(300);

  // A second note on the same element: when it takes its own value back, the saved note's value returns.
  await edit('#stack', 'color', 'blue');
  check('Same element: the note being edited shows its own value on top', (await computed('#stack', 'color')) === 'rgb(0, 0, 255)');
  await click('.css-changes .chg[data-prop="color"] [data-x="css-rm"]');
  check('Same element: removing the open note’s value brings the saved note’s color back, with its border untouched', (await computed('#stack', 'color')) === 'rgb(255, 0, 0)' && (await computed('#stack', 'borderTopWidth')) === '3px', await computed('#stack', 'color'));
  await setCss('color', 'blue');
  await click('[data-x="undo"]');
  await sleep(100);
  check('Same element: Undo of the open note’s value brings the saved note’s color back', (await computed('#stack', 'color')) === 'rgb(255, 0, 0)', await computed('#stack', 'color'));
  await setCss('color', 'blue');
  await click('[data-x="style-reset"]');
  await sleep(100);
  check('Same element: Reset all brings the saved note’s color back', (await computed('#stack', 'color')) === 'rgb(255, 0, 0)', await computed('#stack', 'color'));
  await setCss('color', 'blue');
  await ui(() => __BL.closePop());
  await sleep(150);
  check('Same element: Cancel leaves the saved note’s color on the page', (await computed('#stack', 'color')) === 'rgb(255, 0, 0)' && (await computed('#stack', 'borderTopWidth')) === '3px', await computed('#stack', 'color'));

  // Notes for other screen sizes never take a saved note’s value away.
  await ui(() => {
    const first = __BL.S.batch.items[0];
    const copy = JSON.parse(JSON.stringify(first));
    copy.id = 'mob'; copy.bps = ['mobile'];
    for (const e of copy.elementEdits) for (const t of e.tweaks) if (t.prop === 'color') t.to = 'green';
    __BL.S.batch.items.push(copy);
    __BL.saveBatch(); __BL.render();
  });
  await sleep(1300);
  check('A note for another screen size, saved later on the same element and property, does not undo the desktop note’s preview', (await computed('#stack', 'color')) === 'rgb(255, 0, 0)' && (await computed('#stack', 'borderTopWidth')) === '3px', await computed('#stack', 'color'));
  check('No page errors (previews)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 10. Slice 2C: CSS conflicts, settled when Save Note is clicked
console.log('\n# CSS conflicts: one dialog on Save Note, a choice for every change, the loser kept but inactive (fixtures/css-rules.html)');
{
  const page = await open('css-rules.html', { http: true, realStorage: true });
  const { ui, click, setCss, save, item, reopen, prompt, section } = tools(page);
  const computed = (sel, prop) => ui((sel, prop) => getComputedStyle(document.querySelector(sel))[prop], sel, prop);
  const fill = async (sel, prop, value, note) => {
    await shiftClick(page, await pointFor(page, sel, 'text'));
    await click('[data-x="tool-css"]');
    await setCss(prop, value);
    await ui((note) => { __BL.S.ui.root.querySelector('.pop-note').value = note; }, note);
  };
  const saveClick = () => click('[data-act="pop-save"]');
  const dialog = () => ui(() => {
    const m = __BL.S.ui.root.querySelector('.cf-modal');
    if (!m) return null;
    const txt = (n, sel) => n.querySelector(sel)?.textContent.trim();
    return {
      title: txt(m, '#cf-title'), role: m.querySelector('.cf-sheet').getAttribute('role'),
      groups: [...m.querySelectorAll('.cf-group')].map((g) => ({
        target: txt(g, '.cf-target code'), prop: txt(g, '.cf-prop code'),
        rows: [...g.querySelectorAll('.cf-row')].map((r) => ({ size: txt(r, '.cf-size'), opts: [...r.querySelectorAll('.cf-opt')].map((o) => ({ title: txt(o, '.cf-t'), who: txt(o, '.cf-who'), val: txt(o, '.cf-val'), checked: o.querySelector('input').checked })) })),
      })),
      ok: !m.querySelector('[data-cf="ok"]').disabled, okText: txt(m, '[data-cf="ok"]'), left: txt(m, '.cf-left'),
    };
  });
  const waitDialog = () => page.waitForFunction(() => !!__BL.S.ui.root.querySelector('.cf-modal'), { timeout: 4000 }).catch(() => {});
  const choose = (row, which) => ui((row, which) => __BL.S.ui.root.querySelectorAll('.cf-row')[row].querySelectorAll('.cf-opt input')[which].click(), row, which);
  const popOpen = () => ui(() => !!__BL.S.pop);
  const count = () => ui(() => __BL.S.batch.items.length);
  const tw = (n, prop = 'color') => item(n).then((it) => it.elementEdits[0].tweaks.find((t) => t.prop === prop));

  await fill('#stack', 'color', 'red', 'Make the stack red');
  await saveClick(); await sleep(700);
  await fill('#stack', 'letter-spacing', '2px', 'Letter spacing');
  await saveClick(); await sleep(700);
  check('No conflict (first note; a different property on the same element): no dialog, both notes saved', !(await dialog()) && (await count()) === 2);

  // A conflict is found on Save Note, before anything is saved.
  await fill('#stack', 'color', 'blue', 'Make the stack blue');
  await saveClick(); await waitDialog();
  const d1 = await dialog();
  check('Save Note with a clashing value opens one dialog titled "CSS Conflict — Action Required"', !!d1 && d1.title === 'CSS Conflict — Action Required' && d1.role === 'alertdialog', JSON.stringify(d1));
  check('It names the target element, the property and the screen size, with the existing and new note and value side by side', d1.groups.length === 1 && d1.groups[0].target.includes('stack') && d1.groups[0].prop === 'color' && d1.groups[0].rows.length === 1 && /Desktop/.test(d1.groups[0].rows[0].size) && d1.groups[0].rows[0].opts.map((o) => `${o.title}|${o.who}|${o.val}`).join(' / ') === 'Keep Existing|Note 1|color: red / Use New|New note|color: blue', JSON.stringify(d1.groups));
  check('Nothing is chosen for you: no option is selected and Resolve & Save is disabled', d1.groups[0].rows[0].opts.every((o) => !o.checked) && !d1.ok && d1.okText === 'Resolve & Save' && /1 change still to choose/.test(d1.left), JSON.stringify(d1));
  check('Nothing is saved while the dialog is open, and the note stays open', (await count()) === 2 && (await popOpen()));
  await click('[data-cf="ok"]');
  check('Resolve & Save does nothing until a choice is made', !!(await dialog()) && (await count()) === 2);
  await click('[data-cf="cancel"]');
  check('Cancel closes the dialog, saves nothing and keeps the note open to edit', !(await dialog()) && (await count()) === 2 && (await popOpen()) && (await ui(() => __BL.S.ui.root.querySelector('.pop-note').value)) === 'Make the stack blue');
  await saveClick(); await waitDialog();
  await page.keyboard.press('Escape');
  await sleep(100);
  check('Esc also cancels; saving again asks again', !(await dialog()) && (await count()) === 2 && (await popOpen()));
  await saveClick(); await waitDialog();
  await choose(0, 0);
  const d2 = await dialog();
  check('Choosing Keep Existing enables Resolve & Save', d2.ok && d2.groups[0].rows[0].opts[0].checked && !d2.groups[0].rows[0].opts[1].checked && /All conflicts resolved/.test(d2.left), JSON.stringify(d2));
  await click('[data-cf="ok"]');
  await sleep(1400);
  const tA = await tw(0), tC = await tw(2);
  check('Keep Existing: the new note is saved; its blue stays in it, marked inactive for Desktop; Note 1 is untouched', (await count()) === 3 && !(await dialog()) && !(await popOpen()) && tC.to === 'blue' && JSON.stringify(tC.inactive) === '{"bps":["desktop"]}' && tA.to === 'red' && !tA.inactive, JSON.stringify({ tA, tC }));
  check('Only the winning value previews', (await computed('#stack', 'color')) === 'rgb(255, 0, 0)', await computed('#stack', 'color'));
  check('The other property on the same element is not touched', !(await tw(1, 'letter-spacing')).inactive && (await computed('#stack', 'letterSpacing')) === '2px');
  let exp = await prompt();
  check('The Change Report lists the winning value only, and says a set-aside value is not to be built', /color: .* → red/.test(exp) && !exp.includes('→ blue') && exp.includes('set aside on purpose'), exp.slice(0, 1200));
  check('The Home screen has no conflict warnings, "Use this one" buttons or batch priority', (await ui(() => __BL.S.ui.root.querySelectorAll('.conf-row, [data-act="conf-win"], .conflict').length)) === 0 && (await ui(() => !('priority' in __BL.S.batch))));
  const inList = await ui(() => __BL.S.ui.root.querySelector('.list').textContent);
  check('Nothing in the notes list mentions priority or conflicts', !/priority|conflict|Use this one/i.test(inList), inList);

  // The decision is part of the saved data and survives a new session.
  const snapshot = await ui(() => chrome.storage.local.get());
  const page2 = await open('css-rules.html', { http: true, realStorage: true, seed: snapshot });
  const t2 = tools(page2);
  await sleep(1200);
  const items2 = await page2.evaluate(() => __BL.S.batch.items.map((i) => i.elementEdits[0].tweaks.find((t) => t.prop === 'color')?.inactive || null));
  check('A new session keeps the decision: the same change is still inactive, and the winner still previews', JSON.stringify(items2) === '[null,null,{"bps":["desktop"]}]' && (await page2.evaluate(() => getComputedStyle(document.querySelector('#stack')).color)) === 'rgb(255, 0, 0)', JSON.stringify(items2));
  check('No conflict dialog or warning appears for the saved decision', (await page2.evaluate(() => !__BL.S.ui.root.querySelector('.cf-modal'))));
  await page2.close();

  // Updating the note that lost, without touching that value, asks nothing and keeps it inactive.
  await reopen(2);
  await save('Make the stack blue (updated)');
  const tC2 = await tw(2);
  check('Updating the note that lost (value untouched) asks nothing and keeps the value inactive', !(await dialog()) && (await item(2)).note.endsWith('(updated)') && JSON.stringify(tC2.inactive) === '{"bps":["desktop"]}');
  await ui(() => __BL.closePop());

  // A third note: only the active value can conflict.
  await fill('#stack', 'color', 'green', 'Make the stack green');
  await saveClick(); await waitDialog();
  const d3 = await dialog();
  check('A later note conflicts only with the value in effect (the set-aside value is not asked about again)', d3.groups.length === 1 && d3.groups[0].rows.length === 1 && d3.groups[0].rows[0].opts[0].who === 'Note 1' && d3.groups[0].rows[0].opts[0].val === 'color: red', JSON.stringify(d3));
  await choose(0, 1);
  await click('[data-cf="ok"]');
  await sleep(1400);
  const tA3 = await tw(0), tC3 = await tw(2), tD3 = await tw(3);
  check('Use New: the existing value is kept in its own note but marked inactive; the new value is in effect', JSON.stringify(tA3.inactive) === '{"bps":["desktop"]}' && tA3.to === 'red' && !tD3.inactive && tD3.to === 'green' && JSON.stringify(tC3.inactive) === '{"bps":["desktop"]}', JSON.stringify({ tA3, tC3, tD3 }));
  check('Use New: only the new value previews, and no other property of Note 1 changed', (await computed('#stack', 'color')) === 'rgb(0, 128, 0)', await computed('#stack', 'color'));
  exp = await prompt();
  check('The report now lists the new value as the effective change', /color: .* → green/.test(exp) && !exp.includes('→ red') && !exp.includes('→ blue'), exp.slice(0, 1400));

  // Removing the note that won brings back the value it replaced (and only that one).
  await ui(() => __BL.S.ui.root.querySelectorAll('.list .item')[3].querySelector('[data-act="del"]').click());
  await sleep(1400);
  const afterDel = [await tw(0), await tw(2)];
  check('Deleting the winning note makes the value it replaced apply again, and the other set-aside value stays inactive', !afterDel[0].inactive && JSON.stringify(afterDel[1].inactive) === '{"bps":["desktop"]}' && (await computed('#stack', 'color')) === 'rgb(255, 0, 0)', JSON.stringify(afterDel));
  check('No page errors (conflicts)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

console.log('\n# CSS conflicts: screen sizes, several competing notes, scope of a choice (fixtures/css-rules.html)');
{
  const page = await open('css-rules.html', { http: true, realStorage: true });
  const { ui, click, setCss, save, item, prompt } = tools(page);
  const computed = (sel, prop) => ui((sel, prop) => getComputedStyle(document.querySelector(sel))[prop], sel, prop);
  const fill = async (sel, prop, value, note) => {
    await shiftClick(page, await pointFor(page, sel, 'text'));
    await click('[data-x="tool-css"]');
    await setCss(prop, value);
    await ui((note) => { __BL.S.ui.root.querySelector('.pop-note').value = note; }, note);
  };
  const saveClick = () => click('[data-act="pop-save"]');
  const waitDialog = () => page.waitForFunction(() => !!__BL.S.ui.root.querySelector('.cf-modal'), { timeout: 4000 }).catch(() => {});
  const rows = () => ui(() => [...__BL.S.ui.root.querySelectorAll('.cf-row')].map((r) => ({ id: r.dataset.id, size: r.querySelector('.cf-size').textContent.trim(), who: [...r.querySelectorAll('.cf-opt .cf-who')].map((w) => w.textContent).join('/') })));
  const groups = () => ui(() => __BL.S.ui.root.querySelectorAll('.cf-group').length);
  const okEnabled = () => ui(() => !__BL.S.ui.root.querySelector('[data-cf="ok"]').disabled);
  const choose = (row, which) => ui((row, which) => __BL.S.ui.root.querySelectorAll('.cf-row')[row].querySelectorAll('.cf-opt input')[which].click(), row, which);
  const tw = (n) => item(n).then((it) => it.elementEdits[0].tweaks.find((t) => t.prop === 'color'));
  const setBps = (n, bps) => ui((n, bps) => { __BL.S.batch.items[n].bps = bps; __BL.saveBatch(); __BL.render(); }, n, bps);

  // Notes for other screen sizes never conflict.
  await fill('#stack', 'color', 'red', 'Desktop red');
  await saveClick(); await sleep(700);
  await setBps(0, ['mobile']);
  await fill('#stack', 'color', 'blue', 'Desktop blue');
  await saveClick(); await sleep(900);
  check('A mobile note and a desktop note with different values do not conflict: no dialog', !(await ui(() => !!__BL.S.ui.root.querySelector('.cf-modal'))) && (await ui(() => __BL.S.batch.items.length)) === 2);

  // One new note that overlaps two existing ones: both are asked, grouped, and each needs a choice.
  await fill('#stack', 'color', 'green', 'All sizes green');
  await click('[data-bp="all"]');
  await saveClick(); await waitDialog();
  const r3 = await rows();
  check('One new note that overlaps two notes: the competing notes are grouped under one target and property, one row each, each with its own overlapping screen size', (await groups()) === 1 && r3.length === 2 && /Mobile/.test(r3[0].size) && !/Desktop/.test(r3[0].size) && /Desktop/.test(r3[1].size) && !/Mobile/.test(r3[1].size) && r3[0].who.startsWith('Note 1/') && r3[1].who.startsWith('Note 2/'), JSON.stringify(r3));
  await choose(0, 1);
  check('Resolve & Save stays disabled until every conflicting change has a choice', !(await okEnabled()));
  await choose(1, 0);
  check('With every change chosen it is enabled', await okEnabled());
  await click('[data-cf="ok"]');
  await sleep(1400);
  const [a, b, c] = [await tw(0), await tw(1), await tw(2)];
  check('Choices apply per change and per screen size: Note 1 (mobile) set aside, Note 2 (desktop) kept, the new note inactive on desktop only', JSON.stringify(a.inactive) === '{"bps":["mobile"]}' && !b.inactive && JSON.stringify(c.inactive) === '{"bps":["desktop"]}', JSON.stringify({ a, b, c }));
  check('Desktop: Note 2’s blue is in effect', (await computed('#stack', 'color')) === 'rgb(0, 0, 255)', await computed('#stack', 'color'));
  await page.setViewport({ width: 400, height: 900 });
  await sleep(1400);
  check('Mobile: the new note’s green is in effect (it is set aside only on desktop)', (await computed('#stack', 'color')) === 'rgb(0, 128, 0)', await computed('#stack', 'color'));
  const exp = await prompt();
  check('The report says where a partly set-aside value still applies', /color: .* → green \(only on mobile and tablet/.test(exp) && /→ blue/.test(exp) && !/→ red/.test(exp), exp.slice(0, 2200));
  await page.setViewport({ width: 1280, height: 900 });

  // The check itself: element, property, value and screen size all have to match.
  const probe = await ui(() => {
    const api = __BL.toolsApi;
    const edit = (selector, prop, to) => ({ el: { selector, label: selector }, tweaks: [{ prop, from: '', to }] });
    const sel = document.querySelector('#stack') && __BL.cssPath(document.querySelector('#stack'));
    const mk = (bps, selector, prop, to) => ({ bps, elementEdits: [edit(selector, prop, to)] });
    __BL.S.batch.items = [{ id: 'x1', path: __BL.currentPath(), note: 'x', bps: ['desktop'], el: { selector: sel, label: 'stack' }, elementEdits: [edit(sel, 'color', 'red')] }];
    const n = (f) => api.findCssConflicts(f, null).length;
    return {
      same: n(mk(['desktop'], sel, 'color', 'blue')), equal: n(mk(['desktop'], sel, 'color', ' RED ')), other: n(mk(['mobile'], sel, 'color', 'blue')),
      prop: n(mk(['desktop'], sel, 'background-color', 'blue')), element: n(mk(['desktop'], '#plain', 'color', 'blue')), all: n(mk([], sel, 'color', 'blue')),
      shorthand: n(mk(['desktop'], sel, 'border-color', 'blue')),
    };
  });
  check('The check needs the same element, property, a different value and an overlapping screen size (empty means all)', probe.same === 1 && probe.all === 1 && probe.equal === 0 && probe.other === 0 && probe.prop === 0 && probe.element === 0 && probe.shorthand === 0, JSON.stringify(probe));
  check('No page errors (conflict details)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 10. Slice 2C: structured CSS value fields
console.log('\n# Structured CSS value fields: border, margin, padding, radius, shadow, gradient (fixtures/css-rules.html)');
{
  const page = await open('css-rules.html', { http: true });
  const ui = (fn, ...a) => page.evaluate(fn, ...a);
  const click = (sel) => ui((sel) => __BL.S.ui.root.querySelector(sel).click(), sel);
  const inline = (sel, prop) => ui((sel, prop) => document.querySelector(sel).style.getPropertyValue(prop), sel, prop);
  const rawVal = (prop) => ui((prop) => __BL.S.ui.root.querySelector(`.style-rows .st[data-prop="${prop}"] .sv`).value, prop);
  const setRaw = (prop, value) => ui((prop, value) => { const i = __BL.S.ui.root.querySelector(`.style-rows .st[data-prop="${prop}"] .sv`); i.value = value; i.dispatchEvent(new Event('input', { bubbles: true })); }, prop, value);
  const hasRow = (prop) => ui((prop) => !!__BL.S.ui.root.querySelector(`.style-rows .st[data-prop="${prop}"]`), prop);
  const addProp = (prop) => ui((prop) => { const root = __BL.S.ui.root; if (root.querySelector('.css-add-box').hidden) root.querySelector('[data-x="css-add"]').click(); const qi = root.querySelector('.css-add-q'); qi.value = prop; qi.dispatchEvent(new Event('input', { bubbles: true })); root.querySelector(`.css-add-opt[data-prop="${prop}"]`).click(); }, prop);
  const part = (prop, k, value) => ui((prop, k, value) => {
    const f = __BL.S.ui.root.querySelector(`.style-rows .st[data-prop="${prop}"] .pv[data-k="${k}"]`);
    if (f.type === 'checkbox') { f.checked = !!value; f.dispatchEvent(new Event('change', { bubbles: true })); }
    else if (f.tagName === 'SELECT') { f.value = value; f.dispatchEvent(new Event('change', { bubbles: true })); }
    else { f.value = value; f.dispatchEvent(new Event('input', { bubbles: true })); }
  }, prop, k, value);
  const parts = (prop) => ui((prop) => { const b = __BL.S.ui.root.querySelector(`.style-rows .st[data-prop="${prop}"] .parts`); return b ? { hidden: b.hidden, vals: Object.fromEntries([...b.querySelectorAll('.pv')].map((f) => [f.dataset.k, f.type === 'checkbox' ? f.checked : f.value])), msg: b.querySelector('.parts-msg')?.textContent || '', bad: !!b.querySelector('.parts-msg.bad'), need: [...b.querySelectorAll('.pv.need')].map((f) => f.dataset.k), req: [...b.querySelectorAll('.pf.req label')].map((l) => l.textContent.replace(/\s+/g, ' ').trim()), opt: [...b.querySelectorAll('.pf:not(.req) label')].map((l) => l.textContent.trim()) } : null; }, prop);
  const tw = () => ui(() => Object.values(__BL.toolsApi.getP().tweaks).map((t) => ({ prop: t.prop, to: t.to })));
  const J = (x) => JSON.stringify(x);
  const save = async (note) => { await ui((note) => { __BL.S.ui.root.querySelector('.pop-note').value = note; }, note); await click('[data-act="pop-save"]'); await sleep(400); };

  // Pure parse / compose.
  const pc = (prop, v) => ui((prop, v) => { const f = __BL.toolsApi.compositeFor(prop); const p = f.parse(v); return p && { parts: p, out: __BL.toolsApi.composeCss(prop, p) }; }, prop, v);
  const rt = async (prop, v) => (await pc(prop, v))?.out?.value;
  check('Border: width, style and color in any order, with var() and calc()', (await rt('border', '1px solid #ddd')) === '1px solid #ddd' && (await rt('border', 'solid red 2px')) === '2px solid red' && (await rt('border', 'var(--w) dashed var(--c)')) === 'var(--w) dashed var(--c)' && (await rt('border', 'calc(1px + 1px) solid')) === 'calc(1px + 1px) solid' && (await rt('border', 'none')) === 'none');
  check('Border: a value the fields cannot represent is raw only', (await pc('border', '1px 2px solid red')) === null && (await pc('border', 'inherit')) === null);
  const cc = (parts) => ui((parts) => __BL.toolsApi.composeCss('border', parts), parts);
  check('Border: width and style are required, color is optional; no implicit medium width', J(await cc({ width: '2px', style: '', color: '' })).includes('Style is required') && J(await cc({ width: '', style: 'dotted', color: '' })).includes('Width is required') && (await cc({ width: '', style: 'dotted', color: '' })).value === undefined && (await cc({ width: '2px', style: 'solid', color: '' })).value === '2px solid');
  check('Border: negative widths are invalid; 2 and 4 become 2px and 4px; 0 stays 0', J(await cc({ width: '-2', style: 'solid' })).includes('negative') && J(await cc({ width: '-1px', style: 'solid' })).includes('negative') && (await cc({ width: '2', style: 'solid' })).value === '2px solid' && (await cc({ width: '4', style: 'dashed', color: 'red' })).value === '4px dashed red' && (await cc({ width: '0', style: 'solid' })).value === '0 solid');
  check('Margin and padding: one to four values collapse the way CSS reads them', (await rt('margin', '0 0 16px')) === '0 0 16px' && (await rt('margin', '10px')) === '10px' && (await rt('padding', '1px 2px 1px 2px')) === '1px 2px' && (await rt('padding', 'var(--pad) 12px')) === 'var(--pad) 12px' && (await rt('margin', '1px 2px 3px 4px')) === '1px 2px 3px 4px' && (await rt('margin', 'auto')) === 'auto');
  check('Margin: blank sides take their CSS default; the first value is required', (await ui(() => __BL.toolsApi.composeCss('margin', { top: '8px', right: '', bottom: '', left: '2px' }).value)) === '8px 8px 8px 2px' && !!(await ui(() => __BL.toolsApi.composeCss('margin', { top: '', right: '1px', bottom: '', left: '' }).error)));
  check('Border radius: corners, and the elliptical form stays raw', (await rt('border-radius', '4px')) === '4px' && (await rt('border-radius', '4px 8px')) === '4px 8px' && (await pc('border-radius', '10px / 20px')) === null);
  check('Box shadow: offsets required, blur, spread, color and inset optional; several shadows stay raw', (await rt('box-shadow', '0 4px 8px rgba(0,0,0,.2)')) === '0 4px 8px rgba(0,0,0,.2)' && (await rt('box-shadow', 'inset 1px 2px 3px 4px red')) === 'inset 1px 2px 3px 4px red' && (await pc('box-shadow', '0 1px red, 0 2px blue')) === null && !!(await ui(() => __BL.toolsApi.composeCss('box-shadow', { x: '1px', y: '', blur: '', spread: '', color: '', inset: '' }).error)) && (await ui(() => __BL.toolsApi.composeCss('box-shadow', { x: '0', y: '0', blur: '', spread: '4px', color: 'red', inset: '' }).value)) === '0 0 0 4px red');
  check('Linear gradient: direction and any number of color stops with optional positions; other layers stay raw', (await rt('background-image', 'linear-gradient(90deg, red 0%, #00f 40%, rgb(0 0 0 / .5))')) === 'linear-gradient(90deg, red 0%, #00f 40%, rgb(0 0 0 / .5))' && (await rt('background', 'linear-gradient(to right, red, blue)')) === 'linear-gradient(to right, red, blue)' && (await pc('background', 'linear-gradient(red, blue), url(a.png)')) === null && (await pc('background', '#fff')) === null && (await pc('background-image', 'linear-gradient(red 10%, 20%, blue)')) === null);
  check('Validation: a composed value the browser rejects is reported', (await ui(() => !!__BL.toolsApi.composeCss('border', { width: '2px', style: 'solid', color: 'notacolor' }).error)));

  // Border, with an existing rule value kept until a field is edited.
  await shiftClick(page, await pointFor(page, '#tw', 'text'));
  await click('[data-x="tool-css"]');
  const fieldsBtn = (prop) => `.style-rows .st[data-prop="${prop}"] [data-x="st-fields"]`;
  const openState = () => ui(() => [...__BL.S.ui.root.querySelectorAll('.style-rows .st')].filter((r) => r.querySelector('.st-fields')).map((r) => `${r.dataset.prop}:${r.querySelector('.st-fields').getAttribute('aria-pressed')}:${r.querySelector('.parts').hidden ? 'hidden' : 'shown'}`).join(' '));
  check('Fields sections start collapsed on a note’s existing properties (nothing is expanded until asked)', !/true/.test(await openState()) && /border:false:hidden/.test(await openState()), await openState());
  await click(fieldsBtn('border'));
  const b0 = await parts('border');
  check('Existing border value fills the fields unchanged; nothing is recorded until an edit', J(b0.vals) === J({ width: '1px', style: 'solid', color: '#ddd' }) && !b0.hidden && (await rawVal('border')) === '1px solid #ddd' && (await tw()).length === 0 && b0.req.join() === 'Width *,Style *' && b0.opt.join() === 'Color');
  await part('border', 'color', 'red');
  check('Editing a field rewrites the raw value and previews it; the saved change is the plain string', (await rawVal('border')) === '1px solid red' && J(await tw()) === J([{ prop: 'border', to: '1px solid red' }]) && (await inline('#tw', 'border')).includes('red'));
  await setRaw('border', '3px dashed #00f');
  const b1 = await parts('border');
  check('Raw CSS edits update the fields', J(b1.vals) === J({ width: '3px', style: 'dashed', color: '#00f' }), J(b1));
  await setRaw('border', '1px 2px solid red');
  check('Syntax the fields cannot show: raw only, with a message, and the value is kept', (await parts('border')).vals.width === undefined && (await ui(() => __BL.S.ui.root.querySelector('.style-rows .st[data-prop="border"] .parts-msg').textContent)).includes('Edit it as CSS') && (await rawVal('border')) === '1px 2px solid red');
  await setRaw('border', '1px solid #ddd');
  await click(fieldsBtn('border'));
  check('The Fields button hides the fields', (await parts('border')).hidden === true);
  await click(fieldsBtn('border'));
  check('…and shows them again', (await parts('border')).hidden === false);
  await closeNote(page);

  // Added border: style is required and nothing is applied until it is complete.
  await shiftClick(page, await pointFor(page, '#plain', 'text'));
  await click('[data-x="tool-css"]');
  await addProp('border');
  await part('border', 'style', 'solid');
  const a0 = await parts('border');
  check('A style without a width is refused: message, Width flagged, no border previewed (no implicit medium)', a0.bad && a0.msg.includes('Width is required') && a0.need.join() === 'width' && (await ui(() => getComputedStyle(document.getElementById('plain')).borderTopWidth)) === '0px' && (await inline('#plain', 'border')) === '' && (await tw()).length === 0, J(a0));
  await part('border', 'width', '2px');
  check('Once complete the border is applied (color stays empty)', (await rawVal('border')) === '2px solid' && (await inline('#plain', 'border-top-width')) === '2px' && !(await parts('border')).bad);
  await part('border', 'color', 'notacolor');
  check('An invalid composed value is reported and not applied', (await parts('border')).bad && (await rawVal('border')) === '2px solid');
  await part('border', 'color', '#ff0000');
  check('A valid color is applied', (await rawVal('border')) === '2px solid #ff0000' && (await ui(() => getComputedStyle(document.getElementById('plain')).borderTopColor)) === 'rgb(255, 0, 0)');
  // A bare number means the field's default unit: 4 becomes 4px, and the stepper works from there.
  await part('border', 'width', '4');
  const typed = await rawVal('border');
  await ui(() => __BL.S.ui.root.querySelector('.style-rows .st[data-prop="border"] .pv[data-k="width"]').dispatchEvent(new Event('change', { bubbles: true }))); // leaving the field
  const w4 = await parts('border');
  check('Border width: typing 4 gives 4px at once, and the field shows 4px when it is left', typed === '4px solid #ff0000' && (await rawVal('border')) === '4px solid #ff0000' && (await inline('#plain', 'border-top-width')) === '4px' && w4.vals.width === '4px', J({ raw: await rawVal('border'), w4 }));
  await ui(() => __BL.S.ui.root.querySelector('.style-rows .st[data-prop="border"] .pst[data-dir="1"]').click());
  check('Border width: + steps it in its unit (5px)', (await rawVal('border')) === '5px solid #ff0000' && (await inline('#plain', 'border-top-width')) === '5px', await rawVal('border'));
  // Box shadow and gradient on the same element.
  await addProp('box-shadow');
  await part('box-shadow', 'x', '0');
  await part('box-shadow', 'y', '4px');
  const sh = await parts('box-shadow');
  check('Box shadow: offsets are required and marked; once both are set it is applied', sh.req.join() === 'X offset *,Y offset *' && sh.opt.join() === 'Blur,Spread,Color,Inset' && (await rawVal('box-shadow')) === '0 4px');
  await part('box-shadow', 'blur', '8px');
  await part('box-shadow', 'color', 'rgba(0,0,0,.3)');
  await part('box-shadow', 'inset', true);
  check('Box shadow: blur, color and inset compose into valid CSS', (await rawVal('box-shadow')) === 'inset 0 4px 8px rgba(0,0,0,.3)' && (await ui(() => getComputedStyle(document.getElementById('plain')).boxShadow)).includes('inset'));
  await addProp('background-image');
  await setRaw('background-image', 'linear-gradient(90deg, red 0%, blue 100%)');
  const g0 = await parts('background-image');
  check('Gradient: direction and each stop get fields, stop colors are required', g0.vals.dir === '90deg' && g0.vals.c0 === 'red' && g0.vals.p0 === '0%' && g0.vals.c1 === 'blue' && g0.req.join() === 'Stop 1 color *,Stop 2 color *', J(g0));
  await click('.style-rows .st[data-prop="background-image"] [data-x="part-add"]');
  const g1 = await parts('background-image');
  check('Add color stop: a blank stop is added but not applied until it has a color', 'c2' in g1.vals && (await rawVal('background-image')) === 'linear-gradient(90deg, red 0%, blue 100%)');
  await part('background-image', 'c2', 'green');
  await part('background-image', 'p2', '100%');
  await part('background-image', 'p1', '50%');
  check('A third stop composes into the gradient and previews', (await rawVal('background-image')) === 'linear-gradient(90deg, red 0%, blue 50%, green 100%)' && (await ui(() => getComputedStyle(document.getElementById('plain')).backgroundImage)).startsWith('linear-gradient'));
  await click('.style-rows .st[data-prop="background-image"] [data-x="part-rm"][data-i="1"]');
  check('Removing a stop (at least two stay) updates the gradient', (await rawVal('background-image')) === 'linear-gradient(90deg, red 0%, green 100%)' && (await parts('background-image')).vals.c2 === undefined);
  await closeNote(page);

  // Margin / padding on rule values that were written compactly.
  await shiftClick(page, await pointFor(page, '#pt-1', 'text'));
  await click('[data-x="tool-css"]');
  await click('.style-rows .st[data-prop="margin"] [data-x="st-fields"]');
  const m0 = await parts('margin');
  check('Margin shorthand "0 0 16px" fills the four sides', J(m0.vals) === J({ top: '0', right: '0', bottom: '16px', left: '0' }) && m0.req.join() === 'Top *' && (await tw()).length === 0, J(m0));
  await part('margin', 'left', '8px');
  check('Editing one side composes the full value', (await rawVal('margin')) === '0 0 16px 8px', await rawVal('margin'));
  await part('margin', 'top', '');
  check('Clearing the required field is refused, value kept', (await parts('margin')).bad && (await rawVal('margin')) === '0 0 16px 8px');
  await part('margin', 'top', '12px');
  await part('margin', 'bottom', '');
  check('An optional side left empty takes the CSS default (bottom = top)', (await rawVal('margin')) === '12px 0 12px 8px', await rawVal('margin'));
  await save('Margin fields');
  const note = await ui(() => JSON.parse(JSON.stringify(__BL.S.batch.items[0].elementEdits[0].tweaks.map((t) => ({ prop: t.prop, to: t.to, keys: Object.keys(t).filter((k) => !['prop', 'from', 'to', 'token', 'rule', 'declared', 'computed', 'important'].includes(k)) })))));
  check('Saved data is the same plain value as before: no new keys', note.length === 1 && note[0].to === '12px 0 12px 8px' && note[0].keys.length === 0, J(note));
  check('No page errors (value fields)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 11. Slice 2C: outlines and rule messages
console.log('\n# Selection outlines stay out of the way; CSS rule messages (fixtures/nested.html, css-rules.html)');
{
  const page = await open('css-rules.html', { http: true, realStorage: true });
  const ui = (fn, ...a) => page.evaluate(fn, ...a);
  const click = (sel) => ui((sel) => __BL.S.ui.root.querySelector(sel).click(), sel);
  const styleOf = (sel) => ui((sel) => { const n = __BL.S.ui.root.querySelector(sel); if (!n || n.hidden) return null; const c = getComputedStyle(n); const r = n.getBoundingClientRect(); return { bw: c.borderTopWidth, bg: c.backgroundColor, shadow: c.boxShadow, ow: c.outlineWidth, os: c.outlineStyle, oo: c.outlineOffset, oc: c.outlineColor, l: r.left, t: r.top, w: r.width, h: r.height }; }, sel);
  await shiftClick(page, await pointFor(page, '#tw', 'text'));
  const el = await rectOf(page, 'tw');
  const toggle = (attr) => ui((attr) => __BL.S.ui.root.querySelector('[data-x="marks"]').getAttribute(attr), attr);
  const quiet = await styleOf('.x-marksbox .selb');
  check('Outlines are off by default (the toggle offers "Show outlines"), yet the element being edited has its thin outline', !!quiet && /^rgba\(43, 78, 255, 0?\.\d+\)$/.test(quiet.oc) && quiet.bw === '0px' && (await toggle('aria-pressed')) === 'false' && (await toggle('aria-label')) === 'Show outlines' && /^Show outlines/.test(await toggle('title')), JSON.stringify({ quiet, pressed: await toggle('aria-pressed'), label: await toggle('aria-label') }));
  await click('[data-x="marks"]');
  check('Show outlines turns them on (and the toggle then offers "Hide outlines")', (await toggle('aria-pressed')) === 'true' && (await toggle('aria-label')) === 'Hide outlines' && (await ui(() => __BL.S.prefs.marks)) === 'full');
  const hl = (await styleOf('.x-marksbox .selb')) || (await styleOf('.hl2')) || (await styleOf('.hl'));
  const slim = (s) => s && s.bw === '0px' && s.bg === 'rgba(0, 0, 0, 0)' && s.shadow === 'none' && s.os !== 'none' && parseFloat(s.ow) <= 2 && s.oo === '3px' && /rgba\(.*, 0?\.\d+\)/.test(s.oc);
  check('Selected element: a thin, translucent outline set 3px outside the element, no border, no tint, no dimming', slim(hl) && same({ l: hl.l, t: hl.t, w: hl.w, h: hl.h }, el), JSON.stringify(hl));
  await click('[data-x="tool-css"]');
  await ui(() => { __BL.S.ui.root.querySelector('.pop-note').value = 'outline'; });
  await click('[data-act="pop-save"]');
  await sleep(700);
  const mk = await styleOf('.x-marksbox .mk');
  check('Saved note outline: same rules; the element’s own border box is left uncovered', slim(mk) && same({ l: mk.l, t: mk.t, w: mk.w, h: mk.h }, el) && mk.os === 'dashed', JSON.stringify(mk));
  await click('[data-x="marks"]');
  const hidden = await ui(() => { const m = __BL.S.ui.root.querySelector('.x-marksbox .mk'); const b = m.querySelector('.bd'); const r = b.getBoundingClientRect(); return { oc: getComputedStyle(m).outlineColor, badge: r.width > 0 && getComputedStyle(b).visibility !== 'hidden', num: b.textContent }; });
  check('Hide outlines removes the outline but keeps the numbered badge that identifies the note', hidden.oc === 'rgba(0, 0, 0, 0)' && hidden.badge && hidden.num === '1' && (await ui(() => __BL.S.prefs.marks)) === 'badges', JSON.stringify(hidden));
  await click('[data-x="marks"]');
  const bd = await ui(() => { const b = __BL.S.ui.root.querySelector('.x-marksbox .mk .bd'); const r = b.getBoundingClientRect(); const e = document.getElementById('tw').getBoundingClientRect(); return { dx: Math.round(r.left - e.left), dy: Math.round(r.top - e.top) }; });
  check('The numbered badge still sits at the element’s top-left corner', Math.abs(bd.dx + 11) <= 3 && Math.abs(bd.dy + 11) <= 3, JSON.stringify(bd));
  const empty = await (async () => { await closeNote(page); await shiftClick(page, await pointFor(page, '#plain', 'text')); await click('[data-x="tool-css"]'); return ui(() => __BL.S.ui.root.querySelector('.css-empty').textContent); })();
  check('Blocked stylesheet: says no directly matching rule, that a stylesheet can’t be inspected, and that styling may be inherited', empty === 'No directly matching CSS rule found. 1 stylesheet can’t be inspected, so the styling may come from it. It may also be inherited from a parent element. Use + Add CSS property to change this element only.', empty);
  await closeNote(page);
  check('No page errors (outlines, messages)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
  const p2 = await open('nested.html');
  await p2.evaluate(() => { const s = document.createElement('div'); s.id = 'zz'; s.textContent = 'No rule here'; s.style.cssText = ''; document.body.appendChild(s); });
  await shiftClick(p2, await pointFor(p2, '#zz', 'text'));
  await p2.evaluate(() => __BL.S.ui.root.querySelector('[data-x="tool-css"]').click());
  const e2 = await p2.evaluate(() => ({ empty: __BL.S.ui.root.querySelector('.css-empty').textContent, info: __BL.S.ui.root.querySelector('.css-rule-info').textContent }));
  check('Nothing blocked: no directly matching rule, possibly inherited, and no claim about unreadable stylesheets', e2.empty === 'No directly matching CSS rule found. It may also be inherited from a parent element. Use + Add CSS property to change this element only.' && !e2.info.includes('inspected') && !e2.empty.includes('inspected'), JSON.stringify(e2));
  await p2.close();
}

// ------------------------------------------------------------------ 12. Slice 2C final QA: accordion, layout, dropdown, Enter, edit-mode outline, summaries
console.log('\n# Final QA: one Fields section open at a time, layout, property dropdown, Enter in CSS inputs (fixtures/css-rules.html)');
{
  const page = await open('css-rules.html', { http: true, realStorage: true });
  const { ui, click, setCss } = tools(page);
  const state = () => ui(() => [...__BL.S.ui.root.querySelectorAll('.style-rows .st')].filter((r) => r.querySelector('.st-fields')).map((r) => `${r.dataset.prop}:${r.querySelector('.st-fields').getAttribute('aria-pressed') === 'true' ? 'open' : 'closed'}`).join(' '));
  const openCount = async () => (await state()).split(' ').filter((x) => x.endsWith(':open')).length;
  const fieldsBtn = (prop) => `.style-rows .st[data-prop="${prop}"] [data-x="st-fields"]`;
  const hiddenParts = (prop) => ui((prop) => __BL.S.ui.root.querySelector(`.style-rows .st[data-prop="${prop}"] .parts`).hidden, prop);
  const rawVal = (prop) => ui((prop) => __BL.S.ui.root.querySelector(`.style-rows .st[data-prop="${prop}"] .sv`).value, prop);
  const addProp = (prop) => ui((prop) => { const root = __BL.S.ui.root; if (root.querySelector('.css-add-box').hidden) root.querySelector('[data-x="css-add"]').click(); const qi = root.querySelector('.css-add-q'); qi.value = prop; qi.dispatchEvent(new Event('input', { bubbles: true })); root.querySelector(`.css-add-opt[data-prop="${prop}"]`).click(); }, prop);
  const part = (prop, k, value) => ui((prop, k, value) => {
    const f = __BL.S.ui.root.querySelector(`.style-rows .st[data-prop="${prop}"] .pv[data-k="${k}"]`);
    if (f.tagName === 'SELECT') { f.value = value; f.dispatchEvent(new Event('change', { bubbles: true })); } else { f.value = value; f.dispatchEvent(new Event('input', { bubbles: true })); }
  }, prop, k, value);
  const partVal = (prop, k) => ui((prop, k) => __BL.S.ui.root.querySelector(`.style-rows .st[data-prop="${prop}"] .pv[data-k="${k}"]`)?.value ?? null, prop, k);
  const msg = (prop) => ui((prop) => { const m = __BL.S.ui.root.querySelector(`.style-rows .st[data-prop="${prop}"] .parts-msg`); return m ? { text: m.textContent, bad: m.classList.contains('bad') } : null; }, prop);

  await shiftClick(page, await pointFor(page, '#tw', 'text'));
  await click('[data-x="tool-css"]');
  await addProp('margin');
  check('Adding a property that has fields opens its Fields section, and only that one', (await state()).includes('margin:open') && (await openCount()) === 1, await state());
  await addProp('box-shadow');
  check('Opening another property’s Fields collapses the previous one', (await state()).includes('box-shadow:open') && (await state()).includes('margin:closed') && (await openCount()) === 1 && (await hiddenParts('margin')) === true, await state());
  await part('box-shadow', 'x', '0'); await part('box-shadow', 'y', '4px'); await part('box-shadow', 'blur', '8px');
  await click(fieldsBtn('border'));
  check('Clicking Fields on a third property opens it and closes the shadow', (await state()).includes('border:open') && (await openCount()) === 1 && (await hiddenParts('box-shadow')) === true, await state());
  check('Collapsing keeps what was entered: the shadow value stays applied', (await rawVal('box-shadow')) === '0 4px 8px');
  await click(fieldsBtn('box-shadow'));
  check('Reopening shows the same field values', (await partVal('box-shadow', 'x')) === '0' && (await partVal('box-shadow', 'y')) === '4px' && (await partVal('box-shadow', 'blur')) === '8px' && (await openCount()) === 1);
  await click(fieldsBtn('box-shadow'));
  check('Clicking an expanded Fields button collapses it (none open)', (await openCount()) === 0 && (await hiddenParts('box-shadow')) === true, await state());
  // Incomplete entries survive a collapse too.
  await click(fieldsBtn('border'));
  await part('border', 'style', '');
  check('An incomplete border is refused (value kept) with its message', (await msg('border'))?.bad && (await rawVal('border')) === '1px solid #ddd');
  await part('border', 'width', '6px');
  await click(fieldsBtn('margin'));
  await click(fieldsBtn('border'));
  check('Collapsing and reopening keeps the unfinished entry and its message; the applied value is unchanged', (await partVal('border', 'width')) === '6px' && (await partVal('border', 'style')) === '' && (await msg('border'))?.bad && (await rawVal('border')) === '1px solid #ddd', JSON.stringify({ w: await partVal('border', 'width'), s: await partVal('border', 'style'), m: await msg('border') }));
  await part('border', 'style', 'dashed');
  check('Finishing it applies it', (await rawVal('border')) === '6px dashed #ddd' && !(await msg('border')).bad);

  // Layout: nothing overflows sideways at the real panel width, or at a narrower one.
  await addProp('background-image');
  await ui(() => { const i = __BL.S.ui.root.querySelector('.style-rows .st[data-prop="background-image"] .sv'); i.value = 'linear-gradient(90deg, red 0%, blue 50%, green 100%)'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await addProp('padding');
  const fit = () => ui(() => {
    const root = __BL.S.ui.root; const pop = root.querySelector('.pop'); const pr = pop.getBoundingClientRect(); const right = pr.left + pop.clientWidth;
    const bad = [];
    for (const n of root.querySelectorAll('.style-rows button, .style-rows input, .style-rows select, .style-rows label')) {
      if (n.closest('[hidden]')) continue;
      const r = n.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if (r.left < pr.left - 1 || r.right > right + 1) bad.push(`${n.dataset.x || n.dataset.k || n.className || n.tagName}: ${Math.round(r.left - pr.left)}..${Math.round(r.right - pr.left)} of ${pop.clientWidth}`);
      if (n.tagName !== 'LABEL' && n.type !== 'checkbox' && r.width < 14) bad.push(`${n.dataset.x || n.dataset.k || n.tagName} is ${Math.round(r.width)}px wide`);
    }
    const panel = root.querySelector('.panel');
    return { popOver: pop.scrollWidth - pop.clientWidth, panelOver: panel.scrollWidth - panel.clientWidth, bad };
  });
  for (const width of [340, 290]) {
    await ui((w) => { __BL.S.ui.root.querySelector('.panel').style.width = `${w}px`; }, width);
    for (const prop of ['border', 'margin', 'padding', 'box-shadow', 'background-image']) {
      const st = await state();
      if (!st.includes(`${prop}:open`)) await click(fieldsBtn(prop));
      const f = await fit();
      check(`Layout at ${width}px panel, ${prop} fields open: no horizontal scroll, every control inside the panel`, f.popOver <= 1 && f.panelOver <= 1 && f.bad.length === 0, JSON.stringify(f));
    }
  }
  await ui(() => { __BL.S.ui.root.querySelector('.panel').style.width = ''; });

  // Enter in a single-line CSS input: commit, leave the field, stay in the note, save nothing.
  const focused = () => ui(() => { const a = __BL.S.ui.root.activeElement; return a ? `${a.tagName}.${a.className}` : null; });
  const items = () => ui(() => (__BL.S.batch?.items || []).length);
  const popOpen = () => ui(() => !!__BL.S.pop);
  await ui(() => { const i = __BL.S.ui.root.querySelector('.style-rows .st[data-prop="padding"] .sv'); i.focus(); i.value = '4'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.keyboard.press('Enter');
  await sleep(60);
  check('Enter in a CSS value input commits it (4 → 4px), removes focus and stays in the note, with nothing saved', (await rawVal('padding')) === '4px' && !(await focused())?.startsWith('INPUT.xin sv') && (await popOpen()) && (await items()) === 0 && (await ui(() => document.getElementById('tw').style.getPropertyValue('padding'))) === '4px', JSON.stringify({ raw: await rawVal('padding'), f: await focused() }));
  await click(fieldsBtn('padding'));
  if (!(await state()).includes('padding:open')) await click(fieldsBtn('padding'));
  await ui(() => { const i = __BL.S.ui.root.querySelector('.style-rows .st[data-prop="padding"] .pv[data-k="top"]'); i.focus(); i.value = '9'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.keyboard.press('Enter');
  await sleep(60);
  check('Enter in a structured field commits it, leaves the field, and keeps the note open', (await rawVal('padding')) === '9px 4px 4px' && (await partVal('padding', 'top')) === '9px' && (await popOpen()) && (await items()) === 0 && !(await focused())?.includes('pv'), JSON.stringify({ raw: await rawVal('padding'), top: await partVal('padding', 'top'), f: await focused() }));
  await ui(() => { const i = __BL.S.ui.root.querySelector('.style-rows .st[data-prop="border"] .pv[data-k="color"]'); i.focus(); i.value = 'notacolor'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  const beforeBorder = await rawVal('border');
  await page.keyboard.press('Enter');
  await sleep(60);
  check('Enter on an invalid value is not applied: the message stays, the applied value is unchanged, the note stays open', (await msg('border'))?.bad && (await rawVal('border')) === beforeBorder && (await popOpen()) && (await items()) === 0);
  const enterInNote = await ui(() => { const ta = __BL.S.ui.root.querySelector('.pop-note'); ta.focus(); const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, composed: true }); ta.dispatchEvent(ev); return { prevented: ev.defaultPrevented, still: __BL.S.ui.root.activeElement === ta }; });
  check('Enter in the multi-line description is left alone (no preventDefault, focus stays) and saves nothing', !enterInNote.prevented && enterInNote.still && (await items()) === 0 && (await popOpen()), JSON.stringify(enterInNote));
  await ui(() => { __BL.S.ui.root.querySelector('.pop-note').value = ''; });

  // The property search: a popup that stays inside the window.
  const popup = () => ui(() => {
    const root = __BL.S.ui.root; const b = root.querySelector('.css-add-box'); const r = b.getBoundingClientRect(); const bt = root.querySelector('[data-x="css-add"]').getBoundingClientRect(); const res = root.querySelector('.css-add-res');
    return { hidden: b.hidden, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), btnTop: Math.round(bt.top), btnBottom: Math.round(bt.bottom), up: b.classList.contains('up'), scrolls: res.scrollHeight > res.clientHeight, opts: root.querySelectorAll('.css-add-opt').length, vh: innerHeight, vw: innerWidth, popScroll: root.querySelector('.pop').scrollTop };
  });
  const inside = (p) => !p.hidden && p.top >= 0 && p.bottom <= p.vh && p.left >= 0 && p.right <= p.vw;
  await click('[data-x="css-add"]');
  await ui(() => __BL.S.ui.root.querySelector('.css-add-box').hidden = true);
  await page.setViewport({ width: 1280, height: 700 });
  await sleep(300);
  await ui(() => __BL.S.ui.root.querySelector('[data-x="css-add"]').scrollIntoView({ block: 'end' }));
  const scrollBefore = await ui(() => __BL.S.ui.root.querySelector('.pop').scrollTop);
  await click('[data-x="css-add"]');
  const lower = await popup();
  check('Button near the bottom of the panel: the property list opens upward and is fully inside the window', inside(lower) && lower.up && lower.bottom <= lower.btnTop && lower.opts > 3, JSON.stringify(lower));
  check('Opening it does not scroll the panel', lower.popScroll === scrollBefore, `${scrollBefore} → ${lower.popScroll}`);
  await ui(() => { const qi = __BL.S.ui.root.querySelector('.css-add-q'); qi.value = 'margin'; qi.dispatchEvent(new Event('input', { bubbles: true })); });
  const typed = await popup();
  check('Searching keeps it inside the window and anchored to the button', inside(typed) && typed.up && typed.bottom <= typed.btnTop, JSON.stringify(typed));
  await page.keyboard.press('Escape');
  await ui(() => __BL.S.ui.root.querySelector('[data-x="css-add"]').scrollIntoView({ block: 'start' }));
  await click('[data-x="css-add"]');
  const upper = await popup();
  check('Button near the top: it opens downward, inside the window', inside(upper) && !upper.up && upper.top >= upper.btnBottom, JSON.stringify(upper));
  await ui(() => __BL.S.ui.root.querySelector('.css-add-box').hidden = true);
  await page.setViewport({ width: 1280, height: 420 });
  await sleep(300);
  await ui(() => __BL.S.ui.root.querySelector('[data-x="css-add"]').scrollIntoView({ block: 'center' }));
  await click('[data-x="css-add"]');
  const tiny = await popup();
  check('In a short window it still fits, with the list scrolling inside it', inside(tiny) && tiny.scrolls, JSON.stringify(tiny));
  await page.mouse.click(30, 30);
  await sleep(80);
  check('Clicking elsewhere closes it', (await popup()).hidden);
  await page.setViewport({ width: 1280, height: 900 });
  await closeNote(page);
  check('No page errors (final QA: fields)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

console.log('\n# Final QA: outline while editing, summaries from effective changes (fixtures/css-rules.html)');
{
  const page = await open('css-rules.html', { http: true, realStorage: true });
  const { ui, click, setCss, item, prompt } = tools(page);
  const sel = () => ui(() => [...__BL.S.ui.root.querySelectorAll('.x-marksbox .selb')].map((n) => { const c = getComputedStyle(n); return { oc: c.outlineColor, ow: c.outlineWidth, oo: c.outlineOffset, bw: c.borderTopWidth, bg: c.backgroundColor, sh: c.boxShadow }; }));
  const mks = () => ui(() => [...__BL.S.ui.root.querySelectorAll('.x-marksbox .mk')].map((n) => getComputedStyle(n).outlineColor));
  const visible = (o) => /^rgba\(43, 78, 255, 0?\.\d+\)$/.test(o.oc) && o.bw === '0px' && o.bg === 'rgba(0, 0, 0, 0)' && o.sh === 'none' && o.oo === '3px' && parseFloat(o.ow) <= 2;
  const save = async () => { await click('[data-act="pop-save"]'); await sleep(700); };
  const waitDialog = () => page.waitForFunction(() => !!__BL.S.ui.root.querySelector('.cf-modal'), { timeout: 4000 }).catch(() => {});
  const choose = (row, which) => ui((row, which) => __BL.S.ui.root.querySelectorAll('.cf-row')[row].querySelectorAll('.cf-opt input')[which].click(), row, which);
  const prefs = () => ui(() => __BL.S.prefs.marks ?? null);
  const startNote = async (selector) => { await shiftClick(page, await pointFor(page, selector, 'text')); await click('[data-x="tool-css"]'); };

  // Edit-mode outline, with Home-screen outlines off.
  await startNote('#stack');
  await setCss('color', 'red');
  const e1 = await sel();
  check('Outlines off: the element being edited has a thin outline (outside the element, no border, tint, shadow or dimming)', e1.length === 1 && visible(e1[0]), JSON.stringify(e1));
  await save();
  check('After saving, Home shows no outline (selection ends, outlines are off)', (await sel()).length === 0 && (await mks()).every((c) => c === 'rgba(0, 0, 0, 0)') && (await prefs()) !== 'full');
  await startNote('#plain');
  await setCss('letter-spacing', '2px');
  const e2 = await sel();
  check('A second note: only its own element is outlined; the saved note keeps no outline', e2.length === 1 && visible(e2[0]) && (await mks()).every((c) => c === 'rgba(0, 0, 0, 0)'), JSON.stringify({ e2, m: await mks() }));
  await ui(() => __BL.closePop());
  await sleep(100);
  check('Back on Home, outlines are as before (off), the badges stay', (await sel()).length === 0 && (await mks()).every((c) => c === 'rgba(0, 0, 0, 0)') && (await ui(() => __BL.S.ui.root.querySelectorAll('.x-marksbox .mk .bd').length)) === 1);
  await ui(() => __BL.S.ui.root.querySelector('.list .item').click());
  await sleep(700);
  const e3 = await sel();
  check('Reopening a saved note outlines its element for the edit, while other saved notes stay unoutlined', e3.length === 1 && visible(e3[0]), JSON.stringify(e3));
  await ui(() => __BL.closePop());
  await click('[data-x="marks"]');
  check('Show outlines still outlines saved notes (and nothing extra after closing the editor)', (await mks()).every((c) => /^rgba\(43, 78, 255/.test(c)) && (await sel()).length === 0 && (await prefs()) === 'full');
  await startNote('#plain');
  check('With outlines on the edit outline is still shown, and Home keeps the on state afterwards', (await sel()).length === 1);
  await ui(() => __BL.closePop());
  await sleep(100);
  check('Closing the note keeps the preference on', (await prefs()) === 'full' && (await sel()).length === 0);
  await click('[data-x="marks"]');
  check('No page errors (outline)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

{
  // Summaries and instructions come from the effective CSS changes only.
  const page = await open('css-rules.html', { http: true, realStorage: true });
  const { ui, click, setCss, item, prompt } = tools(page);
  const waitDialog = () => page.waitForFunction(() => !!__BL.S.ui.root.querySelector('.cf-modal'), { timeout: 4000 }).catch(() => {});
  const choose = (row, which) => ui((row, which) => __BL.S.ui.root.querySelectorAll('.cf-row')[row].querySelectorAll('.cf-opt input')[which].click(), row, which);
  const note = async (props) => {
    await shiftClick(page, await pointFor(page, '#stack', 'text'));
    await click('[data-x="tool-css"]');
    for (const [k, v] of props) await setCss(k, v);
    await click('[data-act="pop-save"]');
  };
  const summaries = () => ui(() => [...__BL.S.ui.root.querySelectorAll('.list .item .note')].map((n) => n.textContent.trim()));
  await note([['color', 'red'], ['border-color', 'red']]);
  await sleep(800);
  await note([['color', 'blue'], ['margin-top', '4px']]);
  await waitDialog();
  await choose(0, 1);
  await click('[data-cf="ok"]');
  await sleep(1000);
  const before = JSON.stringify(await ui(() => __BL.S.batch));
  const s1 = await summaries();
  check('Note 1 (color set aside, border-color active) summarizes only CSS border-color', s1[0] === 'CSS border-color', JSON.stringify(s1));
  check('Note 2 (everything active) summarizes CSS color, margin-top', s1[1] === 'CSS color, margin-top', JSON.stringify(s1));
  const exp = await prompt();
  check('The Change Report’s fallback summaries use the effective changes too', exp.includes('the change is the annotations below: CSS border-color.') && exp.includes('the change is the annotations below: CSS color, margin-top.') && !exp.includes('CSS color, border-color'), exp.slice(0, 1800));
  check('The detailed instructions list no set-aside value (not red for color)', !/color: [^\n]*→ red/.test(exp.replace(/border-color[^\n]*/g, '')) && /→ blue/.test(exp), exp.slice(0, 1800));
  // A note whose only CSS was set aside.
  await note([['color', 'green']]);
  await waitDialog();
  await choose(0, 0);
  await click('[data-cf="ok"]');
  await sleep(1000);
  const s3 = await summaries();
  const exp3 = await prompt();
  check('A note whose only CSS was set aside says so, never "reference only", and lists no property', /set aside/.test(s3[2]) && !/reference only/.test(s3[2]) && !/CSS color/.test(s3[2]) && /Its CSS changes were set aside/.test(exp3) && !/green/.test(exp3.replace(/Its CSS changes were set aside[^\n]*/, '')) && !/## 3\.[^\n]*reference only/.test(exp3), JSON.stringify({ s3, head: exp3.split('\n').filter((l) => l.startsWith('## 3.')) }));
  const after = JSON.stringify(await ui(() => __BL.S.batch));
  check('Summaries and the report change nothing in the stored notes or decisions', before === JSON.stringify(JSON.parse(before)) && after.includes('"inactive":{"bps":["desktop"]}') && (await item(0)).elementEdits[0].tweaks.some((t) => t.prop === 'color' && t.inactive) && (await item(2)).elementEdits[0].tweaks.some((t) => t.prop === 'color' && t.to === 'green' && t.inactive));
  check('No page errors (summaries)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 13. Follow-up QA: closing removes everything, Shift+hover after a refresh, border width, property search message
console.log('\n# Closing Blueline removes its previews and outlines; Shift+hover with the pointer at rest; structured border width (fixtures/css-rules.html)');
{
  const page = await open('css-rules.html', { http: true, realStorage: true });
  const { ui, click, setCss, save } = tools(page);
  const style = (sel) => ui((sel) => ({ attr: document.querySelector(sel).getAttribute('style'), bw: getComputedStyle(document.querySelector(sel)).borderTopWidth }), sel);
  const setActive = (on) => ui((on) => __BLUELINE_TEST__.api.setActive(on), on);
  await shiftClick(page, await pointFor(page, '#plain', 'text'));
  await click('[data-x="tool-css"]');
  await setCss('border', '2px solid #00ff62');
  await save('Green border');
  await sleep(900);
  check('Setup: the saved preview shows while Blueline is open', (await style('#plain')).bw === '2px');
  const stored = JSON.stringify(await ui(() => chrome.storage.local.get()));
  // A refresh is pending (scroll) when it is closed, and a note is open (its close also repaints later).
  await shiftClick(page, await pointFor(page, '#stack', 'text'));
  await click('[data-x="tool-css"]');
  await setCss('letter-spacing', '3px');
  await ui(() => window.dispatchEvent(new Event('scroll')));
  await click('[data-act="close"]').catch(() => {});
  await setActive(false);
  await sleep(1800);
  const closed = await ui(() => ({ host: !!document.querySelector('blueline-ui'), plain: document.getElementById('plain').getAttribute('style'), stack: document.getElementById('stack').getAttribute('style'), bw: getComputedStyle(document.getElementById('plain')).borderTopWidth, ls: getComputedStyle(document.getElementById('stack')).letterSpacing }));
  check('Closing removes the interface, every preview (also from a pending refresh and an open note) and leaves no inline style behind', !closed.host && !closed.plain && !closed.stack && closed.bw === '0px' && closed.ls === 'normal', JSON.stringify(closed));
  check('Saved notes are untouched in storage', JSON.stringify(await ui(() => chrome.storage.local.get())) === stored);
  await setActive(true);
  await sleep(1200);
  check('Reopening restores the notes and reapplies the effective previews', (await style('#plain')).bw === '2px' && (await ui(() => __BL.S.batch.items.length)) === 1);

  // Shift+hover with the pointer resting where it was (what a refresh looks like).
  await setActive(false);
  await sleep(200);
  const p = await pointFor(page, '#plain', 'text');
  await page.mouse.move(p.x, p.y);
  await setActive(true);
  await sleep(500);
  await page.keyboard.down('Shift');
  await sleep(150);
  const hl = await hlRect(page);
  await page.keyboard.up('Shift');
  check('Shift pressed with the pointer already resting on an element outlines that element, with outlines off, no mouse move needed', !!hl && /^span#plain/.test(hl.tag) && (await ui(() => __BL.S.prefs.marks ?? null)) !== 'full', JSON.stringify(hl));
  const after = await hlRect(page);
  check('Releasing Shift removes the outline', !after);

  // Structured border width.
  await shiftClick(page, await pointFor(page, '#stack', 'text'));
  await click('[data-x="tool-css"]');
  await ui(() => { const root = __BL.S.ui.root; root.querySelector('[data-x="css-add"]').click(); const qi = root.querySelector('.css-add-q'); qi.value = 'border'; qi.dispatchEvent(new Event('input', { bubbles: true })); root.querySelector('.css-add-opt[data-prop="border"]').click(); });
  const part = (k, v) => ui((k, v) => { const f = __BL.S.ui.root.querySelector(`.style-rows .st[data-prop="border"] .pv[data-k="${k}"]`); f.value = v; f.dispatchEvent(new Event(f.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }, k, v);
  const raw = () => ui(() => __BL.S.ui.root.querySelector('.style-rows .st[data-prop="border"] .sv').value);
  const msg = () => ui(() => __BL.S.ui.root.querySelector('.style-rows .st[data-prop="border"] .parts-msg').textContent);
  const bw = () => ui(() => getComputedStyle(document.getElementById('stack')).borderTopWidth);
  const labels = await ui(() => [...__BL.S.ui.root.querySelectorAll('.style-rows .st[data-prop="border"] .pf.req label')].map((l) => l.textContent.trim()));
  check('Width and Style are marked required on a new border', labels.join() === 'Width *,Style *', labels.join());
  await part('style', 'solid');
  check('A new border with a style and no width is not applied (no thick default)', (await raw()) === '' && (await bw()) === '0px' && /Width is required/.test(await msg()), JSON.stringify({ r: await raw(), bw: await bw(), m: await msg() }));
  await part('width', '4');
  check('Width 4 normalizes to 4px and applies', (await raw()) === '4px solid' && (await bw()) === '4px');
  await part('width', '');
  await part('width', '');
  check('Clearing the width of a new border removes it from the preview (no stale 4px, no medium), with a message and the style kept in the field', (await raw()) === '' && (await bw()) === '0px' && /Width is required/.test(await msg()) && (await ui(() => __BL.S.ui.root.querySelector('.style-rows .st[data-prop="border"] .pv[data-k="style"]').value)) === 'solid', JSON.stringify({ r: await raw(), bw: await bw() }));
  await part('width', '0');
  check('Width 0 gives no visible border', (await raw()) === '0 solid' && (await bw()) === '0px');
  await part('width', '2');
  check('Width 2 gives 2px', (await raw()) === '2px solid' && (await bw()) === '2px');
  await part('width', '-3');
  check('A negative width is refused and the new border leaves the preview', /negative/.test(await msg()) && (await raw()) === '' && (await bw()) === '0px');
  await part('width', '3');
  const swatch = await ui(() => { const r = __BL.S.ui.root.querySelector('.style-rows .st[data-prop="border"]'); return { sw: r.querySelector('.pvsw').value, color: getComputedStyle(document.getElementById('stack')).borderTopColor, text: getComputedStyle(document.getElementById('stack')).color, ph: r.querySelector('.pv[data-k="color"]').placeholder }; });
  const hex = (c) => '#' + c.match(/\d+/g).slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('');
  check('Border color: the picker shows the colour the border really renders in (the text colour, currentColor), and says so', swatch.sw === hex(swatch.color) && swatch.sw === hex(swatch.text) && swatch.ph === 'currentColor', JSON.stringify(swatch));
  await ui(() => { const r = __BL.S.ui.root.querySelector('.style-rows .st[data-prop="border"] .pvsw'); r.value = '#ff0000'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  check('Picking a colour makes the border that colour', (await raw()) === '3px solid #ff0000' && (await ui(() => getComputedStyle(document.getElementById('stack')).borderTopColor)) === 'rgb(255, 0, 0)');
  await ui(() => { const root = __BL.S.ui.root; root.querySelector('[data-x="css-add"]').click(); const qi = root.querySelector('.css-add-q'); qi.value = 'linear-gradient'; qi.dispatchEvent(new Event('input', { bubbles: true })); });
  const empty = await ui(() => __BL.S.ui.root.querySelector('.css-add-res').textContent.trim());
  check('Searching "linear-gradient" explains that gradients are values and points to background-image / background', /Gradients.* are values/.test(empty) && /background-image/.test(empty) && empty.length < 140 && (await ui(() => !__BL.S.ui.root.querySelector('.css-add-opt'))), empty);
  check('No page errors (follow-up)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ 14. Workspaces: one per website, one view per page
console.log('\n# Each website is its own workspace and only the current page\u2019s notes show (fixtures/css-rules.html)');
{
  const page = await open('css-rules.html', { http: true, realStorage: true });
  const { ui, click, setCss, save, prompt } = tools(page);
  const view = () => ui(() => ({ ids: __BL.S.batch ? __BL.S.batch.items.map((i) => i.id) : [], count: __BL.S.ui.root.querySelector('.count').textContent, rows: __BL.S.ui.root.querySelectorAll('.list .item').length, go: __BL.S.ui.root.querySelectorAll('[data-act="go"]').length, text: __BL.S.ui.root.querySelector('.list').textContent }));
  const bw = (sel) => ui((sel) => getComputedStyle(document.querySelector(sel)).borderTopWidth, sel);
  const stored = () => ui(() => chrome.storage.local.get('blueline:batch').then((r) => r['blueline:batch']));
  await shiftClick(page, await pointFor(page, '#plain', 'text'));
  await click('[data-x="tool-css"]');
  await setCss('border', '2px solid red');
  await save('Red border here');
  await sleep(800);
  const mine = await ui(() => __BL.S.batch.items[0].id);
  // Notes from other places, as they would be stored: another website, another page of this site, a hash route, a legacy note without a url.
  await ui(() => {
    const A = JSON.parse(JSON.stringify(__BL.S.batch.items[0]));
    const make = (id, over) => { const c = JSON.parse(JSON.stringify(A)); c.id = id; c.note = `Note ${id}`; Object.assign(c, over); for (const e of c.elementEdits) e.tweaks = [{ prop: 'letter-spacing', from: '', to: '9px', declared: false, rule: { key: 'element', kind: 'element' } }]; return c; };
    const here = new URL(location.href);
    const all = JSON.parse(JSON.stringify(__BL.S.all));
    all.items.push(make('perk', { url: 'https://perkenergy.com/', path: '/' }), make('otherpage', { url: `${here.origin}/other.html`, path: '/other.html' }), make('hash', { url: `${here.origin}${here.pathname}#/home`, path: `${here.pathname}#/home` }), (() => { const l = make('legacy', {}); delete l.url; return l; })());
    all.guides = [{ id: 'g-old', name: 'A', axis: 'x', pos: 5, path: here.pathname }];
    chrome.storage.local.set({ 'blueline:batch': all });
  });
  await sleep(400);
  const v1 = await view();
  check('Only the notes for this website and this page are listed and counted (not another site, another page, a route or an unplaced note)', v1.ids.join() === mine && v1.count === '1' && v1.rows === 1 && !/Note (perk|otherpage|hash|legacy)/.test(v1.text), JSON.stringify(v1));
  check('There are no links to notes elsewhere', v1.go === 0 && !/perkenergy|other\.html/.test(v1.text));
  const exp = await prompt();
  check('The Change Report has only this page\u2019s note', /1 item on 1 page/.test(exp) && !/perkenergy|Note perk|Note otherpage|Note hash/.test(exp), exp.slice(0, 500));
  check('Previews: only this page’s note paints (the other notes’ letter-spacing is not applied)', (await bw('#plain')) === '2px' && (await ui(() => getComputedStyle(document.getElementById('plain')).letterSpacing)) === 'normal');
  check('Guides without a website are not shown', (await ui(() => (__BL.S.batch.guides || []).length)) === 0);
  // Conflicts look at this page only.
  await shiftClick(page, await pointFor(page, '#plain', 'text'));
  await click('[data-x="tool-css"]');
  await setCss('letter-spacing', '3px');
  await click('[data-act="pop-save"]');
  await sleep(900);
  check('A value that differs from other sites’ and pages’ notes is not a conflict: no dialog, saved', !(await ui(() => !!__BL.S.ui.root.querySelector('.cf-modal'))) && (await view()).ids.length === 2);
  const all2 = await stored();
  const byId = Object.fromEntries(all2.items.map((i) => [i.id, i]));
  check('Everything stored for other sites and pages is still there, unchanged (also the unplaced note and guide)', ['perk', 'otherpage', 'hash', 'legacy'].every((k) => byId[k]) && !byId.legacy.url && all2.guides?.some((g) => g.id === 'g-old') && byId.perk.note === 'Note perk' && all2.items.length === 6, Object.keys(byId).join());
  // Navigating inside the site (a hash route) shows that route's notes, then back.
  await ui(() => { location.hash = '#/home'; });
  await sleep(1300);
  const v2 = await view();
  check('A hash route is its own page: only its note shows, and the first page’s previews are gone', v2.ids.join() === 'hash' && v2.count === '1' && (await bw('#plain')) === '0px', JSON.stringify({ v2, bw: await bw('#plain'), st: await ui(() => document.getElementById('plain').getAttribute('style')) }));
  await ui(() => { history.replaceState(null, '', location.pathname); window.dispatchEvent(new HashChangeEvent('hashchange')); });
  await sleep(1300);
  const v3 = await view();
  check('Returning restores the page’s notes and effective previews', v3.ids.length === 2 && v3.ids[0] === mine && (await bw('#plain')) === '2px', JSON.stringify(v3));
  const snap = await stored();
  // Another website (same server, another origin) sees none of it, saves its own, and leaves the rest alone.
  const other = await open('css-rules.html', { http: true, realStorage: true, seed: { 'blueline:batch': snap }, host: 'localhost' });
  const o = tools(other);
  await sleep(800);
  const ov = await other.evaluate(() => ({ n: __BL.S.batch ? __BL.S.batch.items.length : 0, count: __BL.S.ui.root.querySelector('.count').textContent, b: getComputedStyle(document.getElementById('plain')).borderTopWidth }));
  check('A different origin shows no notes and applies no previews', ov.n === 0 && ov.count === '' && ov.b === '0px', JSON.stringify(ov));
  await shiftClick(other, await pointFor(other, '#stack', 'text'));
  await o.click('[data-x="tool-css"]');
  await o.setCss('color', 'green');
  await o.save('Green on the other site');
  await sleep(800);
  const snap2 = await other.evaluate(() => chrome.storage.local.get('blueline:batch').then((r) => r['blueline:batch']));
  check('Saving there keeps every note stored for the first site and adds its own', snap2.items.length === snap.items.length + 1 && snap.items.every((i) => snap2.items.some((j) => j.id === i.id && JSON.stringify(j) === JSON.stringify(i))), `${snap.items.length} → ${snap2.items.length}`);
  await other.close();
  const back = await open('css-rules.html', { http: true, realStorage: true, seed: { 'blueline:batch': snap2 } });
  await sleep(1000);
  const bv = await back.evaluate(() => ({ ids: __BL.S.batch.items.map((i) => i.id), b: getComputedStyle(document.getElementById('plain')).borderTopWidth, text: __BL.S.ui.root.querySelector('.list').textContent }));
  check('Back on the first site (after a refresh) its notes and previews are there, without the other site’s', bv.ids.length === 2 && bv.ids[0] === mine && bv.b === '2px' && !/Green on the other/.test(bv.text), JSON.stringify(bv));
  await back.close();
  check('No page errors (workspaces)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

console.log('\n# Borders: a new border that is cleared leaves only its own contribution; existing borders stay (fixtures/css-rules.html)');
{
  const page = await open('css-rules.html', { http: true, realStorage: true });
  const { ui, click, setCss, save } = tools(page);
  const bw = (sel) => ui((sel) => getComputedStyle(document.querySelector(sel)).borderTopWidth, sel);
  const part = (k, v) => ui((k, v) => { const f = __BL.S.ui.root.querySelector(`.style-rows .st[data-prop="border"] .pv[data-k="${k}"]`); f.value = v; f.dispatchEvent(new Event(f.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }, k, v);
  const raw = () => ui(() => __BL.S.ui.root.querySelector('.style-rows .st[data-prop="border"] .sv').value);
  // An existing border (the page's own rule) keeps its value when a field is cleared.
  await shiftClick(page, await pointFor(page, '#tw', 'text'));
  await click('[data-x="tool-css"]');
  await click('.style-rows .st[data-prop="border"] [data-x="st-fields"]');
  await part('width', '');
  check('An existing border: clearing a field is refused and the page’s own border is left as it is', (await raw()) === '1px solid #ddd' && (await bw('#tw')) === '1px' && (await ui(() => Object.keys(__BL.toolsApi.getP().tweaks).length)) === 0);
  await ui(() => __BL.closePop());
  // Another note's border on the same element is never removed by a new note's cleared border.
  await shiftClick(page, await pointFor(page, '#stack', 'text'));
  await click('[data-x="tool-css"]');
  await setCss('border', '2px solid red');
  await save('Saved border');
  await sleep(700);
  await shiftClick(page, await pointFor(page, '#stack', 'text'));
  await click('[data-x="tool-css"]');
  await ui(() => { const root = __BL.S.ui.root; root.querySelector('[data-x="css-add"]').click(); const qi = root.querySelector('.css-add-q'); qi.value = 'border-top'; qi.dispatchEvent(new Event('input', { bubbles: true })); root.querySelector('.css-add-opt[data-prop="border-top"]').click(); });
  await ui(() => { const r = __BL.S.ui.root.querySelector('.style-rows .st[data-prop="border-top"]'); const set = (k, v) => { const f = r.querySelector(`.pv[data-k="${k}"]`); f.value = v; f.dispatchEvent(new Event(f.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }; set('style', 'dashed'); set('width', '8'); });
  const during = await ui(() => getComputedStyle(document.getElementById('stack')).borderTopWidth);
  await ui(() => { const r = __BL.S.ui.root.querySelector('.style-rows .st[data-prop="border-top"]'); const f = r.querySelector('.pv[data-k="width"]'); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(100);
  const afterClear = await ui(() => ({ w: getComputedStyle(document.getElementById('stack')).borderTopWidth, s: getComputedStyle(document.getElementById('stack')).borderTopStyle }));
  check('Clearing a new border’s width removes only that contribution: another saved note’s border on the element stays', during === '8px' && afterClear.w === '2px' && afterClear.s === 'solid', JSON.stringify({ during, afterClear }));
  check('No page errors (borders)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}



// Product card helpers. The card is compact; technical data lives behind Details. `libRow` returns the card as the
// person sees it (`card`, Details closed) and with Details open (`text`, `prices`), then puts the disclosure back as it was.
const libRow = (pg, sku) => pg.evaluate((sku) => {
  const U = __BL.libraryUi, root = __BL.S.ui.root;
  const keyOf = (s) => U.L.rows.find((r) => r.key === s || r.key === `sku:${s}` || r.sku === s)?.key;
  const find = (k) => [...root.querySelectorAll('.lib-row')].find((r) => r.dataset.key === k);
  const k = keyOf(sku);
  if (!k || !find(k)) return null;
  const was = U.L.expanded.has(k);
  U.L.expanded.delete(k); U.render();
  const c = find(k);
  const card = { text: c.innerText, html: c.innerHTML, v: c.dataset.v, pending: c.dataset.pending === '1', recent: c.dataset.recent === '1', editing: c.dataset.editing === '1', img: c.querySelector('.lib-img img')?.getAttribute('src') || null, height: c.getBoundingClientRect().height };
  const wasCmp = U.L.cmpOpen.has(k);
  U.L.expanded.add(k); U.L.cmpOpen.add(k); U.render();
  const r = find(k);
  const kv = Object.fromEntries([...r.querySelectorAll('.lib-kv dt')].map((dt) => [dt.textContent.trim(), dt.nextElementSibling.textContent.replace(/\s+/g, ' ').trim()]));
  const cmp = Object.fromEntries([...r.querySelectorAll('.lib-cmpt tbody tr')].map((tr) => [tr.querySelector('th').textContent.trim(), [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim())]));
  const cmpDiff = Object.fromEntries([...r.querySelectorAll('.lib-cmpt tbody tr')].map((tr) => [tr.querySelector('th').textContent.trim(), [...tr.querySelectorAll('td')].map((td) => td.dataset.diff === '1')]));
  kv['Approved regular'] = cmp['Regular price']?.[2];
  const money = (x) => (x && /^\$/.test(x) ? x.match(/^\$[\d,]+\.\d\d/)[0] : '—');
  const out = { ...card, openHeight: r.getBoundingClientRect().height, card: card.text, text: r.innerText, html: r.innerHTML, key: k, kv, cmp, cmpDiff, prices: [money(cmp['Regular price']?.[0]), money(cmp['Regular price']?.[1]), money(cmp['Regular price']?.[2]), money(cmp['Promotional price']?.[2])] };
  if (!wasCmp) U.L.cmpOpen.delete(k);
  if (!was) { U.L.expanded.delete(k); }
  U.render();
  return out;
}, sku);
const libRowBtn = (pg, sku, x, extra = '') => pg.evaluate((sku, x, extra) => {
  const U = __BL.libraryUi, root = __BL.S.ui.root;
  const k = U.L.rows.find((r) => r.key === sku || r.key === `sku:${sku}` || r.sku === sku)?.key;
  const find = () => [...root.querySelectorAll('.lib-row')].find((r) => r.dataset.key === k);
  let b = find()?.querySelector(`[data-x="${x}"]${extra}`);
  if (!b) { U.L.expanded.add(k); U.render(); b = find().querySelector(`[data-x="${x}"]${extra}`); } // less common actions live in Details
  b.click();
}, sku, x, extra);

const libName = (pg) => pg.evaluate(() => { const r = __BL.S.ui.root; const s = r.querySelector('[data-lib="listsel"]'); const t = s.options[s.selectedIndex]?.textContent || ''; return /^New list \(not saved yet\)$/.test(t) ? '' : t; });
// Renaming lives in Manage lists (the header only chooses a list): open it, rename the open list, and come back.
const libRename = async (pg, name, how = 'save') => {
  await pg.evaluate(() => { const r = __BL.S.ui.root; if (r.querySelector('.lib-mgr').hidden) r.querySelector('[data-x="lib-lists"]').click(); });
  await sleep(250);
  await pg.evaluate(() => __BL.S.ui.root.querySelector('.lib-lm[data-cur] [data-x="lib-lm-ren"]').click());
  await pg.evaluate((n) => { const i = __BL.S.ui.root.querySelector('[data-lib="lm-name"]'); i.value = n; i.dispatchEvent(new Event('input', { bubbles: true })); }, name);
  await pg.evaluate((h) => { const r = __BL.S.ui.root; if (h === 'enter') r.querySelector('[data-lib="lm-name"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true })); else r.querySelector(h === 'cancel' ? '[data-x="lib-lm-cancel"]' : '[data-x="lib-lm-ren-go"]').click(); }, how);
  await sleep(250);
  await pg.evaluate(() => { const r = __BL.S.ui.root; if (!r.querySelector('.lib-mgr').hidden) r.querySelector('[data-x="lib-lists-close"]').click(); });
  await sleep(150);
};
const mgrOpen = async (pg) => { await pg.evaluate(() => { const r = __BL.S.ui.root; if (r.querySelector('.lib-mgr').hidden) r.querySelector('[data-x="lib-lists"]').click(); }); await sleep(300); };
const mgrNew = async (pg) => { await mgrOpen(pg); await pg.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-new"]').click()); await sleep(300); };
const mgrOpenBy = async (pg, test) => { await mgrOpen(pg); await pg.evaluate((t) => { const e = [...__BL.S.ui.root.querySelectorAll('.lib-lm')].find((x) => (t.id ? x.dataset.id === t.id : x.querySelector('.lib-lm-main b').textContent.startsWith(t.name))); e.querySelector('[data-x="lib-lm-open"]').click(); }, test); await sleep(350); };

console.log('\n# Product Library: import, check, correct, add, save, reload, isolate, export (fake storefront)');
{
  const docx = [...zip({ 'word/document.xml': docXml(SMP_PARAS) }, true)];
  const page = await open('toolbox.html', { http: true, realStorage: true });
  const ui = (fn, ...a) => page.evaluate(fn, ...a);
  const Q = (sel) => ui((sel) => __BL.S.ui.root.querySelector(sel)?.textContent || '', sel);
  const click = (sel) => ui((sel) => __BL.S.ui.root.querySelector(sel).click(), sel);
  const setVal = (sel, v, ev = 'input') => ui((sel, v, ev) => { const i = __BL.S.ui.root.querySelector(sel); i.value = v; i.dispatchEvent(new Event(ev, { bubbles: true })); }, sel, v, ev);
  const key = (sel, k) => ui((sel, k) => __BL.S.ui.root.querySelector(sel).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, composed: true })), sel, k);
  const row = (sku) => libRow(page, sku);
  const rowBtn = (sku, x, extra = '') => libRowBtn(page, sku, x, extra);
  const rowsCount = () => ui(() => __BL.S.ui.root.querySelectorAll('.lib-row').length);
  const modalOpen = () => ui(() => !__BL.S.ui.root.querySelector('[data-m="library"]').hidden);
  const wait = (fn, t = 8000) => page.waitForFunction(fn, { timeout: t });
  const ORIGIN_NOW = await ui(() => location.origin);
  const addFile = (name, bytes) => ui((name, bytes) => __BL.libraryUi.importFile(new File([new Uint8Array(bytes)], name)), name, bytes);

  // Opening
  await ui(() => { __BL.S.ui.root.querySelector('[data-d="aids"]').open = true; });
  check('Product Library: the button is in More tools and the modal starts closed', (await ui(() => !!__BL.S.ui.root.querySelector('[data-d="aids"] [data-x="library"]'))) && !(await modalOpen()));
  await click('[data-x="library"]');
  await sleep(150);
  check('Product Library: opens; a non-Shopify page does not assume a store', (await modalOpen()) && (await ui(() => __BL.S.ui.root.querySelector('[data-lib="store"]').value)) === '' && !(await ui(() => __BL.S.ui.root.querySelector('.lib-start').hidden)), await Q('.lib-msg'));
  await setVal('[data-lib="store"]', 'http://shop.example.com');
  await click('[data-x="lib-open"]');
  await sleep(100);
  check('Product Library: a non-https store address is refused with a message', /https/.test(await Q('.lib-msg')), await Q('.lib-msg'));
  await setVal('[data-lib="store"]', ORIGIN_NOW);
  await key('[data-lib="store"]', 'Enter');
  await sleep(250);
  check('Product Lists: an empty list says "Upload a product list" with Upload File and the accepted formats', (await ui(() => !__BL.S.ui.root.querySelector('.lib-start').hidden)) && /Upload a product list/.test(await Q('.lib-start')) && /Upload File/.test(await Q('.lib-start')) && /CSV, JSON, DOCX/.test(await Q('.lib-start')) && !/SMP|Campaign/i.test(await Q('.lib-start')) && (await rowsCount()) === 0, await Q('.lib-start'));
  check('Product Lists: nothing is saved for an untouched new list, and the title is Product Library while the entry point stays generic', !Object.keys(await ui(() => chrome.storage.local.get())).some((k) => k.startsWith('blueline:lib:smp:') || k.startsWith('blueline:lib:work:')) && /Product Library/.test(await Q('.xmodal[data-m="library"] header')) && !/Import Product List/.test(await Q('.xmodal[data-m="library"] header')) && /Import Product List/.test(await Q('[data-x="library"]')));

  // Import the SMP (.docx)
  await addFile('Spring SMP.docx', docx);
  await sleep(250);
  check('Import .docx: 6 products from 7 placements, the list is named from the file name, original untouched message', (await rowsCount()) === 6 && /Imported 7 placements \(6 products\)/.test(await Q('.lib-msg')) && /Original file was only read|original file was only read/.test(await Q('.lib-msg')) && (await libName(page)) === 'Spring SMP', await Q('.lib-msg'));
  check('Counts: unique products and source placements are both shown, and the populated list is called Product Library', /6 unique products · 7 source placements/.test(await Q('.lib-sum')) && /Product Library/.test(await Q('.xmodal[data-m="library"] header')) && (await ui(() => __BL.S.ui.root.querySelector('.lib-h').hidden)) && (await libName(page)) === 'Spring SMP', await Q('.lib-sum'));
  check('Import .docx: import notes (declared count) are available; the original file is one concise line with no hash', /note/.test(await Q('.lib-warn summary')) && /Original imported file: Spring SMP\.docx/.test(await Q('.lib-warn')) && !/sha256|[0-9a-f]{16}|never changed/i.test((await Q('.lib-warn')).replace(/\d+ notes? from the import.*$/s, '')), await Q('.lib-warn'));
  await click('[data-x="lib-prov"]');
  check('Provenance details (file, type, size, import time, full SHA-256, never-changed note) are available from Details', /SHA-256/.test(await Q('.lib-warn')) && /[0-9a-f]{64}/.test(await Q('.lib-warn')) && /only read, never changed/.test(await Q('.lib-warn')) && /Spring SMP\.docx/.test(await Q('.lib-warn')), await Q('.lib-warn'));
  await click('[data-x="lib-prov"]');
  const dupRow = await row('ACM100101');
  check('A product placed in two sections is one row showing both placements', !!dupRow && /Source placements \(2\)/i.test(dupRow.text) && /Highlighted Products/.test(dupRow.text) && /Best Sellers/.test(dupRow.text), dupRow?.text);
  check('Before checking: SMP prices shown, no variant, nothing approved', dupRow.prices[0].includes('$19.97') && dupRow.prices[1].includes('—') && dupRow.prices[3].includes('$11.99') && /Not verified/.test(dupRow.text));
  const before = await ui(() => Object.keys(window.__store || {}).length);

  // Check in Shopify
  await click('[data-x="lib-check"]');
  await wait(() => /Checked 6 products/.test(__BL.S.ui.root.querySelector('.lib-msg').textContent));
  check('The check message reports variants, prices and review; the list no longer repeats them in a statistics line (the counts and filters stay)', /Checked 6 products: 4 variants found, 2 without one · 2 prices match, 2 differ · 4 need review\./.test(await Q('.lib-msg')) && /Needs review 4/.test(await Q('.lib-chips')) && !/variants found|prices match|approved/.test(await Q('.lib-chips')), (await Q('.lib-msg')) + ' || ' + (await Q('.lib-chips')));
  const a = await row('ACM100101'); const b = await row('ACM200101'); const c = await row('ACM300101'); const d = await row('ACM400101');
  check('Exact SKU match: variant ID, SKU, image, option, three prices and "Prices match"', /4444444441/.test(a.text) && /^1111111111/.test(a.kv['Product ID']) && a.img === 'https://cdn.example.com/black-seed-oil.jpg' && /Flavor: Unflavored/.test(a.text) && /Prices match/.test(a.text) && a.prices[1].includes('$19.97') && a.prices[2].includes('$19.97') && a.v === 'ok', JSON.stringify(a));
  check('A 2¢ difference is shown as a discrepancy with the direction, and nothing is approved for it', /Price differs · Shopify \+\$0\.02/.test(b.text) && b.prices[1].includes('$15.99') && b.prices[2].includes('—') && /Needs review/.test(b.text) && b.v === 'bad', b.text);
  check('A 1¢ difference is flagged as rounding, with Acknowledge offered, and the sold-out variant is flagged', /1¢ rounding difference/.test(c.text) && /Acknowledge 1¢/.test(c.text) && /Sold out/.test(c.text), c.text);
  check('A duplicate SKU narrowed by the SMP price is labelled, and picks the 120 ct variant', d.kv['Matched by'] === 'SKU + price' && /4444444444/.test(d.text) && /120 ct/.test(d.text), d.text);
  const e = await row('ACM500107'); const f = await row('ACM600101');
  check('A missing SKU: "SKU not found", no variant chosen, the same-name product only offered as a possible match', /SKU not found/.test(e.text) && !('Variant ID' in e.kv) && /Shopify variant/.test(e.text) && /Possible matches \(not exact SKU matches\)/.test(e.text) && /ACM500108/.test(e.text) && !/Chosen by you/.test(e.text) && /No variant in the store has SKU ACM500107/.test(e.text), e.text);
  check('A SKU with no match at all offers nothing to pick', /SKU not found/.test(f.text) && !/Possible matches/.test(f.text) && /Find product/.test(f.text), f.text);
  // Needs review: a resolved variant with a price difference is listed with the unresolved ones
  await click('[data-f="review"]');
  check('Needs review chip filters the list to every unresolved product, including resolved variants whose price differs', (await ui(() => __BL.S.ui.root.querySelector('[data-lib="filter"]').value)) === 'review' && (await rowsCount()) === 4 && !!(await row('ACM200101')) && !!(await row('ACM300101')) && !!(await row('ACM500107')) && !(await row('ACM100101')) && (await ui(() => [...__BL.S.ui.root.querySelectorAll('.lib-row')].every((r) => /Needs review/.test(r.innerText)))));
  await setVal('[data-lib="filter"]', 'all', 'change');
  // Placements: expandable, informational
  const dp = await row('ACM100101');
  await rowBtn('ACM100101', 'lib-details');
  const placeText = await ui(() => __BL.S.ui.root.querySelector('.lib-row[data-key="sku:ACM100101"] .lib-places')?.innerText || '');
  check('A product in two sections expands to show both placements, as information rather than a mapping', /position/.test(placeText) && placeText.split('\n').filter(Boolean).length === 2 && /Highlighted Products/.test(placeText) && /Best Sellers/.test(placeText) && /Informational/.test((await row('ACM100101')).text), placeText);
  await rowBtn('ACM100101', 'lib-details');
  check('Placement details collapse again', !(await ui(() => !!__BL.S.ui.root.querySelector('.lib-places'))));
  const reqs = shopRequests.slice();
  check('The store was only read: every request was a public GET path', reqs.length > 0 && reqs.every((r) => /^\/(search\/suggest\.json|products\/[^/]+\.js|cart\.js)/.test(r)), reqs.join(' '));

  // Copy actions
  await ui(() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied.push(t); } }, configurable: true }); });
  await rowBtn('ACM100101', 'lib-copy', '[data-what="SKU"]');
  await rowBtn('ACM100101', 'lib-copy', '[data-what="variant ID"]');
  check('Copy buttons copy the SKU and the exact variant ID', JSON.stringify(await ui(() => window.__copied)) === JSON.stringify(['ACM100101', '4444444441']), JSON.stringify(await ui(() => window.__copied)));

  // Corrections
  await rowBtn('ACM200101', 'lib-use', '[data-src="shopify"]');
  await sleep(100);
  const b2 = await row('ACM200101');
  check('Use Shopify price: approved becomes $15.99; SMP $15.97 and Shopify $15.99 stay as they were', b2.prices[0].includes('$15.97') && b2.prices[1].includes('$15.99') && b2.prices[2].includes('$15.99') && /\$15\.99 · Shopify price/.test(b2.kv['Approved regular']), b2.text);
  await rowBtn('ACM200101', 'lib-undo');
  await rowBtn('ACM200101', 'lib-use', '[data-src="smp"]');
  await sleep(100);
  const b3 = await row('ACM200101');
  check('Accept SMP price: approved is $15.97 while Shopify still shows $15.99 and the difference is still reported', b3.prices[2].includes('$15.97') && b3.prices[1].includes('$15.99') && /\$15\.97 · SMP price/.test(b3.kv['Approved regular']) && /Price differs/.test(b3.text), b3.text);
  await rowBtn('ACM200101', 'lib-custom');
  await setVal('[data-lib="custom"]', 'abc');
  await rowBtn('ACM200101', 'lib-custom-set');
  check('Custom price: a non-price is refused with a message', /Enter a price/.test(await Q('.lib-msg')) && (await row('ACM200101')).prices[2].includes('$15.97'));
  await setVal('[data-lib="custom"]', '15.50');
  await key('[data-lib="custom"]', 'Enter');
  await sleep(100);
  const b4 = await row('ACM200101');
  check('Custom price: $15.50 approved; SMP and Shopify values unchanged', b4.prices[0].includes('$15.97') && b4.prices[1].includes('$15.99') && b4.prices[2].includes('$15.50') && /\$15\.50 · custom price/.test(b4.kv['Approved regular']), b4.text);
  check('Promo price check is its own warning (not an original-price mismatch): shown on the row, counted, and filterable', /Promo price check: The promo price \$9\.59 is not 40% off the approved price \$15\.50/.test(b4.text) && /Promo price warnings 1/.test(await Q('.lib-chips')) && !/Promo price check/.test((await row('ACM100101')).text), b4.text);
  await click('[data-f="promo"]');
  check('Promo warnings filter lists only the products with one', (await rowsCount()) === 1 && !!(await row('ACM200101')));
  await setVal('[data-lib="filter"]', 'all', 'change');
  await rowBtn('ACM300101', 'lib-use', '[data-src="smp"]');
  await sleep(100);
  const c2 = await row('ACM300101');
  check('Acknowledging a 1¢ rounding difference keeps the SMP price and says so; the difference stays visible', /1¢ acknowledged/.test(c2.text) && c2.prices[2].includes('$19.97') && c2.prices[1].includes('$19.98') && /1¢ rounding difference/.test(c2.text), c2.text);

  // Choosing a variant by hand
  await rowBtn('ACM500107', 'lib-cand', '[data-i="0"]');
  await sleep(100);
  const e2 = await row('ACM500107');
  check('Choosing a suggested variant is a manual choice: marked "Chosen by you", warns the SKU differs, and shows that variant ID', /Chosen by you/.test(e2.text) && /The list names SKU ACM500107/.test(e2.text) && /Replacement approval required/.test(e2.text) && /4444444448/.test(e2.text) && e2.prices[1].includes('$41.97') && e2.prices[2].includes('—') && /ORIGINAL IMPORTED|Original imported/i.test(e2.text) && /ACM500107/.test(e2.text) && /Approve Replacement/.test(e2.text), e2.text);
  await rowBtn('ACM600101', 'lib-pick');
  await setVal('.lib-fq', 'ACM999002');
  await click('[data-x="lib-search"]');
  await wait(() => __BL.S.ui.root.querySelectorAll('.lib-find-res .lib-cand').length > 0);
  check('Choose variant: search by SKU lists that exact variant, and nothing is chosen until Use is pressed', !('Variant ID' in (await row('ACM600101')).kv) && /ACM999002/.test(await Q('.lib-find-res')));
  check('Choose variant: the exact SKU match is listed first', /ACM999002/.test(await ui(() => __BL.S.ui.root.querySelector('.lib-find-res .lib-cand').innerText)));
  await click('.lib-find-res [data-x="lib-found"]');
  check('Selecting a variant only selects it: nothing is applied until the change is confirmed, and a different SKU is called out', !('Variant ID' in (await row('ACM600101')).kv) && /Confirm Variant Change/.test(await Q('.lib-find-res')) && /Different SKU from the list’s \(ACM600101\)/.test(await Q('.lib-confirm')) && (await ui(() => !!__BL.S.ui.root.querySelector('.lib-find-res [data-sel="1"]'))));
  await click('[data-x="lib-confirm"]');
  await sleep(150);
  check('A different SKU gives "Variant changed — replacement approval required", as a warning rather than a success', /^Variant changed — replacement approval required/.test(await Q('.lib-msg')) && (await ui(() => __BL.S.ui.root.querySelector('.lib-msg').className)).includes('warn') && !(await ui(() => __BL.S.ui.root.querySelector('.lib-msg').className)).includes('ok') && /Replacement approval required/.test((await row('ACM600101')).card), await Q('.lib-msg'));
  const picked = await row('ACM600101');
  check('Choose variant: the pressed variant is attached, as a manual choice', /4444444450/.test(picked?.text || '') && /Chosen by you/.test(picked?.text || '') && /\$54\.97/.test(picked?.prices[1] || ''), picked?.text);

  // Change Variant: a dedicated view inside the modal (not an expandable picker above the list)
  const vv = () => ui(() => { const r = __BL.S.ui.root; const vis = (el) => !!el && el.getClientRects().length > 0; const rv = r.querySelector('[data-x="lib-vv-review"]'); return { vmode: r.querySelector('.lib-sheet').classList.contains('lib-vmode'), view: vis(r.querySelector('.lib-vv')), list: vis(r.querySelector('.lib-list')), cfg: vis(r.querySelector('.lib-cfg')), find: vis(r.querySelector('.lib-find')), head: r.querySelector('.lib-vv-h')?.textContent, prod: r.querySelector('.lib-vv-prod')?.textContent, cur: r.querySelector('.lib-vv-cur')?.textContent, radios: [...r.querySelectorAll('.lib-vv-list input[type=radio]')].map((i) => ({ v: i.value, checked: i.checked })), rows: [...r.querySelectorAll('.lib-vv-list .lib-vr')].map((x) => ({ cur: x.dataset.cur === '1', sel: x.dataset.sel === '1', text: x.innerText.replace(/\s+/g, ' ') })), review: rv ? { text: rv.textContent, disabled: rv.disabled } : null, imgs: r.querySelectorAll('.lib-vv img').length, step: __BL.libraryUi.L.find?.step, rv: r.querySelector('.lib-vv-rvb')?.innerText.replace(/\s+/g, ' ') }; });
  const pickRadio = (i) => ui((i) => { const el = __BL.S.ui.root.querySelectorAll('.lib-vv-list input[type=radio]')[i]; el.click(); }, i);
  await rowBtn('ACM400101', 'lib-variants');
  await wait(() => __BL.S.ui.root.querySelectorAll('.lib-vv-list input[type=radio]').length === 2);
  const pk = await vv();
  check('Change Variant is a dedicated view: the Product Library, header controls and any picker above the list are replaced, not stacked', pk.vmode && pk.view && !pk.list && !pk.cfg && !pk.find, JSON.stringify(pk));
  check('Change Variant header: heading, the product name and "Current: <variant>"', pk.head === 'Change Variant' && pk.prod === 'Acme ZMA Capsules' && pk.cur === 'Current: 120 ct' && (await ui(() => !!__BL.S.ui.root.querySelector('[data-x="lib-vv-back"]'))), JSON.stringify([pk.head, pk.prod, pk.cur]));
  check('Change Variant: single-selection radio rows with options, SKU, price, availability and a Current marker; variant IDs are visible but secondary; no thumbnails', pk.radios.length === 2 && pk.radios[0].checked && !pk.radios[1].checked && pk.rows[0].cur && /120 ct/.test(pk.rows[0].text) && /Current/.test(pk.rows[0].text) && /SKU: ACM400101 · \$27\.97 · Available/.test(pk.rows[0].text) && /Variant ID 4444444444/.test(pk.rows[0].text) && /240 ct/.test(pk.rows[1].text) && /SKU: ACM400101 · \$49\.97 · Available/.test(pk.rows[1].text) && /Variant ID 4444444445/.test(pk.rows[1].text) && !/Current/.test(pk.rows[1].text) && pk.imgs === 0, JSON.stringify(pk.rows));
  check('Review Variant Change is a full-width blue button, disabled while the current variant is selected', pk.review.text === 'Review Variant Change' && pk.review.disabled && await ui(() => { const b = __BL.S.ui.root.querySelector('[data-x="lib-vv-review"]'); const cs = getComputedStyle(b); return cs.backgroundColor.replace(/\s/g, '') === 'rgb(43,78,255)' && cs.color.replace(/\s/g, '') === 'rgb(255,255,255)' && Math.abs(b.getBoundingClientRect().width - b.parentElement.getBoundingClientRect().width) < 2; }));
  await pickRadio(1);
  const pk2 = await vv();
  check('Selecting a radio only selects: the other radio clears, the button enables, and nothing is saved', pk2.radios[1].checked && !pk2.radios[0].checked && pk2.rows[1].sel && !pk2.rows[0].sel && !pk2.review.disabled && /4444444444/.test((await row('ACM400101')).text) && !/Chosen by you/.test((await row('ACM400101')).text) && /4444444444/.test((await ui(() => JSON.stringify(__BL.libraryUi.L.lib.work.shopify['sku:ACM400101'].variant.variantId)))), JSON.stringify(pk2.radios));
  await setVal('[data-lib="vv-filter"]', '240');
  check('Change Variant: the filter narrows the variants and keeps the selection', (await ui(() => __BL.S.ui.root.querySelectorAll('.lib-vv-list .lib-vr').length)) === 1 && (await vv()).rows[0].sel);
  await setVal('[data-lib="vv-filter"]', '');
  await click('[data-x="lib-vv-review"]');
  const rv1 = await vv();
  check('Review: a before-and-after summary names the current and the new variant with SKU and ID; the same SKU needs no replacement approval', rv1.step === 'review' && /Review Variant Change/.test(rv1.rv) && /Current 120 ct SKU ACM400101/i.test(rv1.rv) && /New 240 ct SKU ACM400101/i.test(rv1.rv) && !/different SKU/.test(rv1.rv) && /Confirm Variant Change/.test(await Q('.lib-vv-review')) && /Back to Variants/.test(await Q('.lib-vv-review')), rv1.rv);
  await click('[data-x="lib-vv-tochoose"]');
  const back1 = await vv();
  check('Back to Variants returns to the choice with the selection kept and nothing saved', back1.step === 'choose' && back1.rows[1].sel && /4444444444/.test((await row('ACM400101')).text));
  await key('.lib-vv-list', 'Escape');
  check('Escape leaves the view without changing the saved variant', !(await vv()).vmode && (await vv()).list && /4444444444/.test((await row('ACM400101')).text) && !/Chosen by you/.test((await row('ACM400101')).text));
  await rowBtn('ACM400101', 'lib-variants');
  await wait(() => __BL.S.ui.root.querySelectorAll('.lib-vv-list input[type=radio]').length === 2);
  check('Reopening starts again from the current variant', (await vv()).radios[0].checked && (await vv()).review.disabled);
  await click('[data-x="lib-vv-back"]');
  check('The Back arrow returns to the Product Library without changing the saved selection', !(await vv()).vmode && (await vv()).list && (await vv()).cfg && !/Chosen by you/.test((await row('ACM400101')).text));
  await rowBtn('ACM400101', 'lib-variants');
  await wait(() => __BL.S.ui.root.querySelectorAll('.lib-vv-list input[type=radio]').length === 2);
  await pickRadio(1);
  await click('[data-x="lib-vv-review"]');
  await click('[data-x="lib-vv-confirm"]');
  await sleep(200);
  const z = await row('ACM400101');
  check('Confirm Variant Change updates the derived record and re-runs price verification; the SMP values are untouched; back in the library with the product emphasised', !(await vv()).vmode && /4444444445/.test(z.text) && /Chosen by you/.test(z.text) && z.prices[0].includes('$27.97') && z.prices[1].includes('$49.97') && /Price differs · Shopify \+\$22\.00/.test(z.text) && /Now using/.test(await Q('.lib-msg')) && z.recent && /Needs review/.test(z.card), z.text);
  await rowBtn('ACM400101', 'lib-variants');
  await wait(() => __BL.S.ui.root.querySelectorAll('.lib-vv-list input[type=radio]').length === 2);
  check('The newly chosen variant is the one marked current', (await vv()).rows.map((r) => r.cur).join() === 'false,true' && (await vv()).cur === 'Current: 240 ct');
  await ui(() => { __BL.S.ui.root.querySelector('.lib-adv').open = true; });
  await setVal('.lib-sq', 'ACM999001');
  await click('[data-x="lib-sku-search"]');
  await wait(() => __BL.S.ui.root.querySelectorAll('.lib-sku-res .lib-vr').length === 1);
  check('Advanced SKU search lists the exact variant as another radio row and chooses nothing', /ACM999001/.test(await Q('.lib-sku-res')) && /4444444449/.test(await Q('.lib-sku-res')) && /4444444445/.test((await row('ACM400101')).text) && (await vv()).review.disabled);
  await click('[data-x="lib-different"]');
  check('"Find a different product" leaves the view for the separate search workflow', /Find the product for/.test(await Q('.lib-find-title')) && (await ui(() => !__BL.S.ui.root.querySelector('.lib-find').hidden)) && !(await vv()).vmode);
  await click('[data-x="lib-find-close"]');
  await rowBtn('ACM400101', 'lib-variants');
  await wait(() => __BL.S.ui.root.querySelectorAll('.lib-vv-list input[type=radio]').length === 2);
  await pickRadio(0);
  await click('[data-x="lib-vv-review"]');
  await click('[data-x="lib-vv-confirm"]');
  await sleep(200);
  check('Choosing the original variant again restores the price match', /4444444444/.test((await row('ACM400101')).text) && /Prices match/.test((await row('ACM400101')).text));

  // Adding a product that wasn't in the SMP
  await click('[data-x="lib-add"]');
  // Live search: typing alone finds products
  const sBefore = shopRequests.length;
  const suggests = () => shopRequests.slice(sBefore).filter((r) => r.startsWith('/search/suggest.json'));
  for (const t of ['fi', 'fis', 'fish', 'fish o']) { await setVal('.lib-fq', t); await sleep(60); }
  await wait(() => __BL.S.ui.root.querySelectorAll('.lib-find-res .lib-cand').length >= 2, 6000);
  check('Live search: typing finds the product with no Search click, with one request after the typing pauses', suggests().length === 1 && /q=fish o/.test(suggests()[0]) && /Fish Oil/.test(await Q('.lib-find-res')), suggests().join(' '));
  await setVal('.lib-fq', 'fi');
  await sleep(900);
  await setVal('.lib-fq', 'fish o');
  await sleep(900);
  check('Live search: under three characters and an unchanged query send nothing more', suggests().length === 1, suggests().join(' '));
  await setVal('.lib-fq', 'fish oil');
  await key('.lib-fq', 'Enter');
  await wait(() => __BL.S.ui.root.querySelectorAll('.lib-find-res .lib-cand').length >= 2);
  await ui(() => __BL.S.ui.root.querySelectorAll('.lib-find-res [data-x="lib-found"]')[0].click());
  await sleep(150);
  const m = await row('ACM999001');
  check('Add a Shopify product that was not in the SMP: added manually, no SMP price, ready to approve', !!m && /Added from Shopify/.test(m.text) && /No SMP price/.test(m.text) && /4444444449/.test(m.text) && m.prices[0].includes('—') && (await rowsCount()) === 7, m?.text);
  await ui(() => __BL.S.ui.root.querySelectorAll('.lib-find-res [data-x="lib-found"]')[0].click());
  await sleep(100);
  check('Adding the same variant twice is refused', (await rowsCount()) === 7 && /already in the library/.test(await Q('.lib-msg')), await Q('.lib-msg'));
  await rowBtn('ACM999001', 'lib-use', '[data-src="shopify"]');
  await click('[data-x="lib-find-close"]');

  // Filter and search
  await setVal('[data-lib="search"]', 'fish');
  check('Search narrows the list by name, including the linked Shopify product (two Fish Oil rows)', (await rowsCount()) === 2);
  await setVal('[data-lib="search"]', '4444444441');
  check('Search by variant ID', (await rowsCount()) === 1 && !!(await row('ACM100101')));
  await setVal('[data-lib="search"]', '');
  await setVal('[data-lib="filter"]', 'novariant', 'change');
  check('Filter: "No variant" shows only the products still without one', (await rowsCount()) === 0 || (await ui(() => [...__BL.S.ui.root.querySelectorAll('.lib-row')].every((r) => /Variant ID —/.test(r.innerText.replace(/\s+/g, ' '))))));
  await setVal('[data-lib="filter"]', 'all', 'change');

  // Rename and switch lists: identity is an id, the name is only a label
  const libKeys = async () => Object.keys(await ui(() => chrome.storage.local.get())).filter((k) => k.startsWith('blueline:lib:')).sort();
  const keys0 = await libKeys();
  const listId = await ui(() => __BL.libraryUi.L.listId);
  await libRename(page, 'Cyber Week 2026', 'enter');
  const idxNow = (await ui(() => chrome.storage.local.get('blueline:lib:index')))['blueline:lib:index'];
  check('Renaming a list changes only its label: same id, same storage keys, same rows', JSON.stringify(await libKeys()) === JSON.stringify(keys0) && idxNow.libs.some((l) => l.campaign === listId && l.name === 'Cyber Week 2026') && (await libName(page)) === 'Cyber Week 2026' && /^l-/.test(listId) && (await rowsCount()) === 7, listId);
  await mgrNew(page);
  check('New list: empty with the upload prompt; the other list is untouched in storage', (await rowsCount()) === 0 && (await ui(() => !__BL.S.ui.root.querySelector('.lib-start').hidden)) && (await ui(() => __BL.libraryUi.L.listId)) !== listId && JSON.stringify(await libKeys()) === JSON.stringify(keys0));
  await mgrOpenBy(page, { id: listId });
  check('Switching back restores the first list with its decisions and name', (await rowsCount()) === 7 && (await row('ACM200101')).prices[2].includes('$15.50') && (await libName(page)) === 'Cyber Week 2026');

  // Persistence: close, reopen in the same session, and then in a brand-new session from the saved data
  const snapshot = await ui(() => chrome.storage.local.get());
  check('Saved data: the SMP import and the work record are separate storage entries, and no annotation data was touched', Object.keys(snapshot).filter((k) => k.startsWith('blueline:lib:smp:')).length === 1 && Object.keys(snapshot).filter((k) => k.startsWith('blueline:lib:work:')).length === 1 && !('blueline:batch' in snapshot), Object.keys(snapshot).join(', '));
  const smpKey = Object.keys(snapshot).find((k) => k.startsWith('blueline:lib:smp:'));
  await ui(() => __BL.libraryUi.close());
  check('Closing hides the modal', !(await modalOpen()));
  await ui(() => __BL.libraryUi.open());
  await sleep(300);
  check('Reopening restores the same library, decisions and manual product from storage', (await rowsCount()) === 7 && (await row('ACM200101')).prices[2].includes('$15.50') && /Chosen by you/.test((await row('ACM500107')).text) && !!(await row('ACM999001')));
  const reloaded = await open('toolbox.html', { http: true, realStorage: true, seed: snapshot });
  await reloaded.evaluate(() => { __BL.S.ui.root.querySelector('[data-d="aids"]').open = true; __BL.S.ui.root.querySelector('[data-x="library"]').click(); });
  await sleep(400);
  const updAt = (o) => o['blueline:lib:index'].libs.find((l) => l.campaign === listId)?.updatedAt;
  check('Opening a list in a new session (which re-detects the store currency) does not change Last edited', updAt(await reloaded.evaluate(() => chrome.storage.local.get('blueline:lib:index'))) === updAt(snapshot) && !!updAt(snapshot), String(updAt(snapshot)));
  const rq = (fn, ...a) => reloaded.evaluate(fn, ...a);
  check('A new session on the same page origin comes back with the library the page last used', (await rq(() => __BL.S.ui.root.querySelectorAll('.lib-row').length)) === 7 && (await rq(() => __BL.S.ui.root.querySelector('[data-lib="store"]').value)) === ORIGIN_NOW && /\$15\.50/.test(await rq(() => [...__BL.S.ui.root.querySelectorAll('.lib-row')].find((r) => r.dataset.key === 'sku:ACM200101').innerText)));
  await reloaded.close();

  // Isolation: another website (a different origin, here localhost) starts empty even though the data is in storage
  const other = await open('toolbox.html', { http: true, realStorage: true, seed: snapshot, host: 'localhost' });
  await other.evaluate(() => { __BL.S.ui.root.querySelector('[data-d="aids"]').open = true; __BL.S.ui.root.querySelector('[data-x="library"]').click(); });
  await sleep(400);
  check('Another website does not inherit the library: no store, no products, and the upload prompt shows', (await other.evaluate(() => __BL.S.ui.root.querySelector('[data-lib="store"]').value)) === '' && (await other.evaluate(() => __BL.S.ui.root.querySelectorAll('.lib-row').length)) === 0 && (await other.evaluate(() => !__BL.S.ui.root.querySelector('.lib-start').hidden)));
  await other.evaluate(() => { const i = __BL.S.ui.root.querySelector('[data-lib="store"]'); i.value = 'https://another-store.example.com'; __BL.S.ui.root.querySelector('[data-x="lib-open"]').click(); });
  await sleep(300);
  check('Pointing it at a different store shows a new empty list for that store (the other lists exist but are not loaded)', (await other.evaluate(() => __BL.S.ui.root.querySelectorAll('.lib-row').length)) === 0 && (await other.evaluate(() => !__BL.S.ui.root.querySelector('.lib-start').hidden)) && (await libName(other)) === '' && !/Cyber Week/.test(await other.evaluate(() => { const s = __BL.S.ui.root.querySelector('[data-lib="listsel"]'); return s.options[s.selectedIndex].textContent; })));
  await other.evaluate((o) => { const i = __BL.S.ui.root.querySelector('[data-lib="store"]'); i.value = o; __BL.S.ui.root.querySelector('[data-x="lib-open"]').click(); }, ORIGIN_NOW);
  await sleep(300);
  check('A store chosen on purpose still loads nothing by itself; its saved list is offered in the selector', (await other.evaluate(() => __BL.S.ui.root.querySelectorAll('.lib-row').length)) === 0 && (await (async () => { await mgrOpen(other); return other.evaluate(() => [...__BL.S.ui.root.querySelectorAll('.lib-lm')].map((e) => e.innerText).join('|')); })()).includes('Cyber Week 2026'));
  await mgrOpenBy(other, { name: 'Cyber Week 2026' });
  check('Picking the saved list there loads it', (await other.evaluate(() => __BL.S.ui.root.querySelectorAll('.lib-row').length)) === 7);
  check('No page errors (Product Library, other origin)', other.errors.length === 0, other.errors.join(' | '));
  await other.close();

  // Export
  const text = await ui(() => __BL.libraryUi.exportJson());
  const out = JSON.parse(text);
  const skus = out.products.map((p) => p.sku).sort();
  check('Export names the list and its stable id', out.list.name === 'Cyber Week 2026' && out.list.id === listId && out.campaign.id === listId);
  check('Export approved JSON: exact + approved products only, string IDs, distinct prices, placements', out.schema === 'blueline.product-library/2' && out.scope === 'approved' && JSON.stringify(skus) === JSON.stringify(['ACM100101', 'ACM200101', 'ACM300101', 'ACM400101', 'ACM500108', 'ACM999001'].sort().filter((x) => skus.includes(x))) && out.products.every((p) => typeof p.variantId === 'string' && p.variantId !== p.productId), skus.join(','));
  const p200 = out.products.find((p) => p.sku === 'ACM200101');
  check('Export: approved, Shopify and SMP prices are separate integer cents, and the source is recorded', p200.prices.approvedCents === 1550 && p200.prices.shopifyCents === 1599 && p200.prices.smpOriginalCents === 1597 && p200.approval.source === 'custom' && out.sources[0].fileName === 'Spring SMP.docx');
  check('Export: a product that is not approved is listed with a reason, not dropped or exported', out.needsAttention.some((x) => x.sku === 'ACM600101' && /differs/.test(x.reason)) && !skus.includes('ACM999002'), JSON.stringify(out.needsAttention));

  // Export Full List / Export Approved Products, and an explicit substitution approval
  const full = JSON.parse(await ui(() => __BL.libraryUi.exportJson('full')));
  const f500 = full.products.find((p) => p.key === 'sku:ACM500107');
  const f600 = full.products.find((p) => p.key === 'sku:ACM600101');
  check('Export Full List: every product, unresolved ones too; the substituted variant stays apart from the imported SKU', full.scope === 'full' && full.products.length === 7 && !!f600 && f600.variantId === '4444444450' && f600.sku === 'ACM600101' && f600.shopifySku === 'ACM999002' && f600.identity.state === 'substitute-pending' && f500.sku === 'ACM500107' && f500.shopifySku === 'ACM500108' && f500.variantId === '4444444448' && f500.identity.state === 'substitute-pending' && f500.identity.substitutionApproved === false && f500.source.name === 'Acme Pre-X Workout Powder', JSON.stringify(f500?.identity));
  check('Export Approved Products: the unapproved substitution is left out and listed with its reason', !out.products.some((p) => p.key === 'sku:ACM500107') && out.needsAttention.some((x) => x.sku === 'ACM500107' && /Substitution/.test(x.reason)));
  const vis = () => ui(() => { const r = __BL.S.ui.root.querySelector('.lib-row[data-key="sku:ACM500107"]'); const cs = (el) => (el ? getComputedStyle(el) : null); const rgb = (c) => c.replace(/\s/g, ''); const b = r.querySelector('[data-x="lib-ident"]'); return { v: r.dataset.v, pending: r.dataset.pending === '1', warn: !!r.querySelector('.lib-subst'), ok: !!r.querySelector('.lib-repok'), rep: !!r.querySelector('.lib-prop'), repShadow: r.querySelector('.lib-prop') ? rgb(cs(r.querySelector('.lib-prop')).boxShadow) : '', repLabel: r.querySelector('.lib-prop i')?.textContent || '', origLabel: r.querySelector('.lib-orig i')?.textContent || '', btn: b ? { text: b.textContent.trim(), bg: rgb(cs(b).backgroundColor), color: rgb(cs(b).color) } : null, badges: [...r.querySelectorAll('.lib-badge')].map((x) => x.textContent).join('|'), bgRow: rgb(cs(r).backgroundColor) }; });
  const pend = await vis();
  check('Pending replacement: the card stays amber, original and proposed replacement are kept apart, the replacement has a green inset accent (labelled "not approved yet"), and Approve Replacement is a green primary button', pend.v === 'warn' && pend.pending && pend.warn && pend.rep && /rgb\(46,158,91\)/.test(pend.repShadow) && /not approved yet/i.test(pend.repLabel) && /Original/.test(pend.origLabel) && pend.btn.text === 'Approve Replacement' && pend.btn.bg === 'rgb(30,122,62)' && pend.btn.color === 'rgb(255,255,255)' && /^Replacement approval required$/.test(pend.badges.split('|')[0]) && !/Replacement approved/.test(pend.badges) && pend.bgRow === 'rgb(255,250,235)', JSON.stringify(pend));
  await rowBtn('ACM500107', 'lib-ident');
  await sleep(150);
  const e3 = await row('ACM500107');
  const out2 = JSON.parse(await ui(() => __BL.libraryUi.exportJson('approved')));
  const done = await vis();
  check('Approved replacement: "Replacement approved" status, the pending warning and button are gone, the card is no longer amber', /Replacement approved/.test(done.badges) && !/approval required/.test(done.badges) && !done.warn && !done.pending && done.ok && done.v === 'ok' && done.btn === null && !done.rep, JSON.stringify(done));
  const a500 = out2.products.find((p) => p.key === 'sku:ACM500107');
  check('Approving the substitution is explicit; the approved export still says substitute, never an exact match', /Replacement approved/.test(e3.text) && e3.prices[2].includes('$41.97') && !!a500 && a500.sku === 'ACM500107' && a500.shopifySku === 'ACM500108' && a500.identity.state === 'substitute-approved' && a500.matchMethod === 'manual', e3.text);

  // Delete
  await click('[data-x="lib-delete"]');
  check('Delete library needs a second click', (await rowsCount()) === 7 && /Click again/.test(await Q('[data-x="lib-delete"]')));
  await click('[data-x="lib-delete"]');
  await sleep(400);
  const after = await ui(() => chrome.storage.local.get());
  check('Delete library removes its saved data (and nothing else) and starts empty again', (await rowsCount()) === 0 && !Object.keys(after).some((k) => k.startsWith('blueline:lib:smp:') || k.startsWith('blueline:lib:work:')) && !(smpKey in after));

  // Escape
  await key('[data-lib="store"]', 'Escape');
  check('Escape closes the Product Library', !(await modalOpen()));
  check('No page errors (Product Library)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

console.log('\n# Product lists without Shopify: upload, drag and drop, import choices, edit, filters, old lists, extension reload');
{
  const page = await open('toolbox.html', { http: true, realStorage: true });
  const ui = (fn, ...a) => page.evaluate(fn, ...a);
  const Q = (sel) => ui((sel) => __BL.S.ui.root.querySelector(sel)?.textContent || '', sel);
  const click = (sel) => ui((sel) => __BL.S.ui.root.querySelector(sel).click(), sel);
  const setVal = (sel, v, ev = 'input') => ui((sel, v, ev) => { const i = __BL.S.ui.root.querySelector(sel); i.value = v; i.dispatchEvent(new Event(ev, { bubbles: true })); }, sel, v, ev);
  const row = (sku) => libRow(page, sku);
  const rowBtn = (sku, x, extra = '') => libRowBtn(page, sku, x, extra);
  const rowsCount = () => ui(() => __BL.S.ui.root.querySelectorAll('.lib-row').length);
  const file = (name, text) => ui((n, t) => __BL.libraryUi.importFile(new File([t], n)), name, text);
  const drop = (type, files) => ui((type, files) => { const dt = new DataTransfer(); for (const [n, t] of files) dt.items.add(new File([t], n)); const target = __BL.S.ui.root.querySelector('.lib-start:not([hidden])') || __BL.S.ui.root.querySelector('.lib-body'); const ev = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, composed: true }); target.dispatchEvent(ev); return ev.defaultPrevented; }, type, files);
  const store = () => ui(() => chrome.storage.local.get());
  const smpKeys = async () => Object.keys(await store()).filter((k) => k.startsWith('blueline:lib:smp:'));
  const chooseMode = (v) => ui((v) => { [...__BL.S.ui.root.querySelectorAll('[name="libmode"]')].find((r) => r.value === v).checked = true; }, v);
  const reqs0 = shopRequests.length;

  // 1. No store at all
  await ui(() => { __BL.S.ui.root.querySelector('[data-d="aids"]').open = true; __BL.S.ui.root.querySelector('[data-x="library"]').click(); });
  await sleep(250);
  check('Upload File is active with no store (not dimmed, not disabled), the formats are shown beneath it, the store is marked optional', await ui(() => { const b = __BL.S.ui.root.querySelector('.lib-start .xb-file'); const cs = getComputedStyle(b); return !b.querySelector('input').disabled && cs.opacity === '1' && cs.pointerEvents !== 'none'; }) && /CSV, JSON, DOCX/.test(await Q('.lib-start')) && /optional/i.test(await Q('.lib-cfg')) && /Upload a product list/.test(await Q('.lib-start')));
  check('The empty upload screen is compact, not a tall empty modal', (await ui(() => __BL.S.ui.root.querySelector('.lib-sheet').getBoundingClientRect().height)) < 520, String(await ui(() => __BL.S.ui.root.querySelector('.lib-sheet').getBoundingClientRect().height)));
  await file('Plain list.csv', 'SKU,Name,Price,Sale Price\nP1,Plain One,$10.00,$8.00\nP2,Plain Two,$20.00,\n');
  await sleep(250);
  const p1 = await row('P1');
  check('A list imports with no Shopify store: named from the file, no store request, products show a neutral "Not verified"', (await rowsCount()) === 2 && (await libName(page)) === 'Plain list' && shopRequests.length === reqs0 && /Not verified/.test(p1.text) && !/Needs review/.test(p1.text) && p1.v === '' && /Needs review 0/.test(await Q('.lib-chips')) && (await ui(() => __BL.S.ui.root.querySelector('.lib-h').hidden)), p1.text);
  await click('[data-x="lib-check"]');
  check('Check in Shopify with no store asks for one, sends nothing, and changes nothing', /Shopify store/.test(await Q('.lib-msg')) && shopRequests.length === reqs0 && (await rowsCount()) === 2);
  await rowBtn('P1', 'lib-use', '[data-src="smp"]');
  await sleep(120);
  check('Without a store a price can still be approved (Accept SMP price)', (await row('P1')).prices[2].includes('$10.00'));
  check('The original imported file is named as such', /Original imported file: Plain list\.csv/.test(await Q('.lib-warn')));

  // 2. Edit Information
  const sk = (await smpKeys())[0];
  const smp0 = JSON.stringify((await ui((k) => chrome.storage.local.get(k), sk))[sk]);
  await rowBtn('P1', 'lib-edit');
  await setVal('[data-lib="ed-title"]', 'Plain One — Launch');
  await setVal('[data-lib="ed-price"]', '11.00');
  await setVal('[data-lib="ed-promo"]', '7.50');
  await setVal('[data-lib="ed-image"]', 'https://cdn.example.com/p1.png');
  check('Edit Information: Save is the blue primary action', await ui(() => __BL.S.ui.root.querySelector('[data-x="lib-ed-save"]').classList.contains('lib-primary')));
  await rowBtn('P1', 'lib-ed-save');
  await sleep(200);
  const p1e = await row('P1');
  check('Edit Information: working values shown and marked Edited, the original imported name still visible, image applied', /Plain One — Launch/.test(p1e.text) && /Edited\s*title, promo price, image/i.test(p1e.text) && /Imported name\s*Plain One/i.test(p1e.text) && p1e.prices[2].includes('$11.00') && p1e.prices[3].includes('$7.50') && p1e.img === 'https://cdn.example.com/p1.png', p1e.text);
  check('Edit Information never touches the saved original import', JSON.stringify((await ui((k) => chrome.storage.local.get(k), sk))[sk]) === smp0);
  await rowBtn('P1', 'lib-edit');
  await rowBtn('P1', 'lib-ed-reset', '[data-field="title"]');
  await sleep(100);
  await rowBtn('P1', 'lib-ed-reset', '[data-field="promoCents"]');
  await sleep(100);
  await rowBtn('P1', 'lib-ed-cancel');
  const p1r = await row('P1');
  check('Reset returns a field to its source value (title and promo), the others stay edited', /Plain One/.test(p1r.text) && !/Launch/.test(p1r.text) && p1r.prices[3].includes('$8.00') && /Edited\s*image/i.test(p1r.text) && p1r.prices[2].includes('$11.00'), p1r.text);
  await ui(() => __BL.libraryUi.close());
  await ui(() => __BL.libraryUi.open());
  await sleep(300);
  check('Edits persist after closing and reopening', (await row('P1')).img === 'https://cdn.example.com/p1.png' && (await row('P1')).prices[2].includes('$11.00'));

  // 3. Filters: All chip and toggling
  await click('[data-f="review"]');
  check('A status chip filters the list', (await ui(() => __BL.S.ui.root.querySelector('[data-lib="filter"]').value)) === 'review' && (await rowsCount()) === 0);
  await click('[data-f="review"]');
  check('Clicking the active chip again restores All', (await ui(() => __BL.S.ui.root.querySelector('[data-lib="filter"]').value)) === 'all' && (await rowsCount()) === 2 && (await ui(() => __BL.S.ui.root.querySelector('[data-f="all"]').getAttribute('aria-pressed'))) === 'true');
  await click('[data-f="review"]');
  await click('[data-f="all"]');
  check('The All chip clears whatever filter is on', (await rowsCount()) === 2);

  // 4. Drag and drop (a new list, then into a populated screen)
  await mgrNew(page);
  const href0 = await ui(() => location.href);
  const over = await drop('dragover', [['x.json', '[]']]);
  const dropped = await drop('drop', [['Dropped.json', JSON.stringify({ products: [{ sku: 'D1', name: 'Dropped One', price: '$5.00' }] })]]);
  await sleep(300);
  check('Drag and drop: dragover and drop are cancelled so the browser never opens the file, and the page stays put', over === true && dropped === true && (await ui(() => location.href)) === href0);
  check('Drag and drop: the dropped file is imported, named from the file, with a success message', (await rowsCount()) === 1 && (await libName(page)) === 'Dropped' && /Imported 1 placement/.test(await Q('.lib-msg')), await Q('.lib-msg'));
  await drop('drop', [['notes.pdf', 'x']]);
  check('A dropped unsupported file is refused with a clear message and changes nothing', /notes\.pdf can’t be imported\. Use a CSV, JSON or DOCX/.test(await Q('.lib-msg')) && (await rowsCount()) === 1);
  await drop('drop', [['a.csv', 'x'], ['b.csv', 'y']]);
  check('Dropping several files at once is refused', /one file at a time/i.test(await Q('.lib-msg')));
  await drop('drop', [['empty.csv', '']]);
  check('An empty file is refused', /empty\.csv is empty/.test(await Q('.lib-msg')));
  await drop('drop', [['broken.csv', 'just one line']]);
  await sleep(300);
  check('A file that can’t be read says why', /broken\.csv:/.test(await Q('.lib-msg')) && (await rowsCount()) === 1, await Q('.lib-msg'));
  check('Dropping with the library closed does nothing', await (async () => { await ui(() => __BL.libraryUi.close()); const r = await ui(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.csv')); const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, composed: true }); __BL.S.ui.root.querySelector('.lib-modal').dispatchEvent(ev); return ev.defaultPrevented; }); await ui(() => __BL.libraryUi.open()); await sleep(300); return r === false; })());

  // 5. Importing another file into a list that has content: explicit choice, never silent
  const before = JSON.stringify(Object.fromEntries(Object.entries(await store()).filter(([k]) => k.startsWith('blueline:lib:'))));
  await file('Second.csv', 'SKU,Name,Price\nS1,Second One,$1.00\nS2,Second Two,$2.00\n');
  await sleep(250);
  check('Required actions share one visual hierarchy: Import is a blue primary button', await ui(() => { const b = __BL.S.ui.root.querySelector('[data-x="lib-choice-go"]'); return b.classList.contains('lib-primary') && getComputedStyle(b).backgroundColor.replace(/\s/g, '') === 'rgb(43,78,255)' && getComputedStyle(b).color.replace(/\s/g, '') === 'rgb(255,255,255)'; }));
  check('A second file asks how to import it; "Create a new list" is the default and nothing has changed yet', (await ui(() => !__BL.S.ui.root.querySelector('.lib-choice').hidden)) && (await ui(() => [...__BL.S.ui.root.querySelectorAll('[name="libmode"]')].map((r) => r.value + (r.checked ? '*' : '')).join())) === 'new*,add,replace' && (await rowsCount()) === 1 && JSON.stringify(Object.fromEntries(Object.entries(await store()).filter(([k]) => k.startsWith('blueline:lib:')))) === before);
  await click('[data-x="lib-choice-cancel"]');
  check('Cancel leaves everything as it was', (await ui(() => __BL.S.ui.root.querySelector('.lib-choice').hidden)) && (await rowsCount()) === 1);
  await file('Second.csv', 'SKU,Name,Price\nS1,Second One,$1.00\nS2,Second Two,$2.00\n');
  await sleep(200);
  const listsBefore = (await smpKeys()).length;
  await click('[data-x="lib-choice-go"]');
  await sleep(300);
  check('Create a new list: a separate list holds the file; the other list is untouched', (await rowsCount()) === 2 && (await libName(page)) === 'Second' && (await smpKeys()).length === listsBefore + 1 && !!(await row('S1')));
  await mgrOpenBy(page, { name: 'Dropped' });
  check('The earlier list still has only its own product', (await rowsCount()) === 1 && !!(await row('D1')));
  await file('Third.csv', 'SKU,Name,Price\nT1,Third One,$3.00\nD1,Dropped One,$5.00\n');
  await sleep(200);
  await chooseMode('add');
  await click('[data-x="lib-choice-go"]');
  await sleep(300);
  check('Add products to the current list: the list keeps its name, new SKUs join, a repeated SKU becomes a second placement', (await rowsCount()) === 2 && (await libName(page)) === 'Dropped' && /Source placements \(2\)/i.test((await row('D1')).text) && !!(await row('T1')));
  await file('Fourth.csv', 'SKU,Name,Price\nF1,Fourth One,$4.00\n');
  await sleep(200);
  await chooseMode('replace');
  await click('[data-x="lib-choice-go"]');
  check('The confirm-to-replace step turns red (destructive)', await ui(() => __BL.S.ui.root.querySelector('[data-x="lib-choice-go"]').classList.contains('lib-danger')));
  check('Replace needs a second, explicit click and changes nothing before it', /Click again to replace/.test(await Q('[data-x="lib-choice-go"]')) && (await rowsCount()) === 2);
  await click('[data-x="lib-choice-go"]');
  await sleep(300);
  const rk = (await smpKeys()).find((k) => /Dropped|l-/.test(k) && true);
  const smps = Object.entries(await store()).filter(([k]) => k.startsWith('blueline:lib:smp:')).map(([, v]) => v);
  const replacedRec = smps.find((v) => (v.replaced || []).length);
  check('Replace: the new import is the list; the earlier import is kept whole in storage, not deleted', (await rowsCount()) === 1 && !!(await row('F1')) && !!replacedRec && replacedRec.replaced.length === 2 && replacedRec.replaced.every((i) => i.source.sha256 && i.placements.length) && /Replaced/.test(await Q('.lib-msg')), await Q('.lib-msg'));

  // 6. A list saved before this change still loads
  const ORIG = `http://127.0.0.1:${PORT}`;
  const imp = LibNode.importCsv('SKU,Name,Price\nL1,Legacy One,$5.00\n', { fileName: 'legacy.csv', sha256: 'legacy' });
  const seed = { 'blueline:lib:index': { v: 1, libs: [{ store: ORIG, campaign: 'legacy-list', name: 'Legacy list', updatedAt: 1 }], active: { [ORIG]: { store: ORIG, campaign: 'legacy-list' } } }, [`blueline:lib:smp:${ORIG}|legacy-list`]: { v: 1, imports: [imp] }, [`blueline:lib:work:${ORIG}|legacy-list`]: { v: 1, shopify: {}, decisions: {}, manualProducts: {}, settings: { currency: 'USD', currencySource: 'assumed' }, updatedAt: null } };
  const old = await open('toolbox.html', { http: true, realStorage: true, seed });
  await old.evaluate(() => { __BL.S.ui.root.querySelector('[data-d="aids"]').open = true; __BL.S.ui.root.querySelector('[data-x="library"]').click(); });
  await sleep(500);
  check('A list saved before this change loads with its name, store and products', (await old.evaluate(() => __BL.S.ui.root.querySelectorAll('.lib-row').length)) === 1 && (await libName(old)) === 'Legacy list' && (await old.evaluate(() => __BL.S.ui.root.querySelector('[data-lib="store"]').value)) === ORIG);
  check('No page errors (old list)', old.errors.length === 0, old.errors.join(' | '));
  await old.close();

  check('No page errors (product lists without Shopify)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();

  // 7. The extension is reloaded while a tab stays open: the old copy must stop quietly, not throw
  const rt = await open('toolbox.html', { http: true });
  const res = await rt.evaluate(async () => {
    const out = {};
    out.alive = __BL.runtimeAlive();
    const real = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async () => { throw new Error('Extension context invalidated.'); };
    out.rejected = await __BL.send({ type: 't' });
    chrome.runtime.sendMessage = real;
    out.stillLive = __BL.S.retired !== true;
    chrome.runtime.id = undefined; // what Chrome does to an orphaned script
    out.noId = await __BL.send({ type: 't' });
    out.retired = __BL.S.retired === true;
    out.active = __BL.S.active;
    window.chrome = undefined; // and sometimes the whole object goes
    out.noChrome = await __BL.send({ type: 't' });
    out.save = await __BL.saveBatch().then(() => 'ok', (e) => 'threw: ' + e.message);
    out.prefs = await __BL.savePrefs().then(() => 'ok', (e) => 'threw: ' + e.message);
    out.aliveAfter = __BL.runtimeAlive();
    return out;
  });
  check('Extension reload: messaging a dead context returns quietly instead of throwing, and the old copy retires itself', res.alive === true && res.rejected === null && res.stillLive === true && res.noId === null && res.retired === true && res.active === false && res.noChrome === null && res.save === 'ok' && res.prefs === 'ok' && res.aliveAfter === false, JSON.stringify(res));
  check('Extension reload: no uncaught errors reach the page', rt.errors.length === 0, rt.errors.join(' | '));
  await rt.close();
  const rl = await open('toolbox.html', { http: true, realStorage: true });
  await rl.evaluate(() => { __BL.S.ui.root.querySelector('[data-d="aids"]').open = true; chrome.runtime.id = undefined; __BL.libraryUi.open(); });
  await sleep(300);
  check('Product Lists on a dead extension context shows a plain "reload the page" message', /reload/i.test(await rl.evaluate(() => __BL.S.ui.root.querySelector('.lib-msg').textContent)) && rl.errors.length === 0, rl.errors.join(' | '));
  await rl.close();
}

console.log('\n# List Manager: identifiable lists, stable order, rename, duplicates, delete warnings');
{
  const page = await open('toolbox.html', { http: true, realStorage: true });
  const ui = (fn, ...a) => page.evaluate(fn, ...a);
  const Q = (sel) => ui((sel) => __BL.S.ui.root.querySelector(sel)?.textContent || '', sel);
  const click = (sel) => ui((sel) => __BL.S.ui.root.querySelector(sel).click(), sel);
  const setVal = (sel, v, ev = 'input') => ui((sel, v, ev) => { const i = __BL.S.ui.root.querySelector(sel); i.value = v; i.dispatchEvent(new Event(ev, { bubbles: true })); }, sel, v, ev);
  const file = (name, text) => ui((n, t) => __BL.libraryUi.importFile(new File([t], n)), name, text);
  const listId = () => ui(() => __BL.libraryUi.L.listId);
  const order = () => ui(() => [...__BL.S.ui.root.querySelectorAll('.lib-lm')].map((e) => e.dataset.id));
  const entry = (id) => ui((id) => { const e = __BL.S.ui.root.querySelector(`.lib-lm[data-id="${id}"]`); return e ? { text: e.innerText.replace(/\s+/g, ' '), cur: e.dataset.cur === '1' } : null; }, id);
  const entryBtn = (id, x) => ui((id, x) => __BL.S.ui.root.querySelector(`.lib-lm[data-id="${id}"] [data-x="${x}"]`).click(), id, x);
  const A = 'SKU,Name,Price\nA1,Alpha,$1.00\nA2,Beta,$2.00\n';
  const B = 'SKU,Name,Price\nB1,Gamma,$3.00\n';
  const rename = (name) => libRename(page, name);

  await ui(() => { __BL.S.ui.root.querySelector('[data-d="aids"]').open = true; __BL.S.ui.root.querySelector('[data-x="library"]').click(); });
  await sleep(250);
  await file('A.csv', A); await sleep(250); await rename('Weekly');
  const id1 = await listId();
  await sleep(1100);
  await mgrNew(page); await file('B.csv', B); await sleep(250); await rename('Weekly');
  const id2 = await listId();
  await sleep(1100);
  await mgrNew(page); await file('A.csv', A); await sleep(250); await rename('Weekly');
  const id3 = await listId();

  await mgrOpen(page);
  check('The List Manager shows every saved list as its own entry, with prominent New List, and the list dropdown is gone', JSON.stringify(await order()) === JSON.stringify([id1, id2, id3]) && !(await ui(() => !!__BL.S.ui.root.querySelector('[data-lib="list"]'))) && (await ui(() => /lib-primary/.test(__BL.S.ui.root.querySelector('[data-x="lib-new"]').className))), JSON.stringify(await order()));
  const e1 = await entry(id1); const e2 = await entry(id2); const e3 = await entry(id3);
  check('Each entry shows name, creation date and time, store, product count and review count', [e1, e2, e3].every((e) => /Weekly/.test(e.text) && /Created: .*\d{4}.*\d:\d\d/.test(e.text) && /Last edited: .*\d{4}.*\d:\d\d/.test(e.text) && /no store/.test(e.text) && /products? · 0 need review/.test(e.text)) && /2 products/.test(e1.text) && /1 product/.test(e2.text), e1.text);
  check('Identical names stay distinguishable (different dates and contents), and the open list is marked', e3.cur && !e1.cur && e1.text !== e2.text);
  check('The same source file (by hash) is flagged "Same source file" on both lists (not just "possible duplicate"), and nothing is merged', /Same source file/.test(e1.text) && /Same source file/.test(e3.text) && !/Same source file/.test(e2.text) && !/Possible duplicate/.test(e1.text) && (await order()).length === 3);
  check('"First imported" marks only the oldest of the lists from one file, and never the unrelated list', /First imported/.test(e1.text) && !/First imported/.test(e3.text) && !/First imported/.test(e2.text), e1.text + ' | ' + e3.text);
  const upd = async (id) => (await ui((id) => chrome.storage.local.get('blueline:lib:index').then((r) => r['blueline:lib:index'].libs.find((l) => l.campaign === id)), id));
  const u0 = await upd(id1);

  // Opening a list does not reorder; the oldest opens first and stays first
  await entryBtn(id1, 'lib-lm-open');
  await sleep(350);
  await setVal('[data-lib="search"]', 'Alpha'); await ui(() => { const U = __BL.libraryUi; U.L.expanded.add(U.L.rows[0].key); U.render(); }); await sleep(150); await mgrOpen(page); await click('[data-x="lib-lists-close"]'); await setVal('[data-lib="search"]', '');
  const u1 = await upd(id1);
  check('Opening a list, searching, expanding Details and opening the manager do not change Last edited (or Created)', u1.updatedAt === u0.updatedAt && u1.createdAt === u0.createdAt, JSON.stringify([u0, u1]));
  check('Opening a list loads it and does not move it in the manager', (await listId()) === id1 && (await ui(() => __BL.S.ui.root.querySelectorAll('.lib-row').length)) === 2 && (await ui(() => __BL.S.ui.root.querySelector('.lib-mgr').hidden)));
  await sleep(1100);
  await ui(() => { const U = __BL.libraryUi; U.L.expanded.add(U.L.rows[0].key); U.render(); __BL.S.ui.root.querySelector('.lib-row [data-x="lib-use"][data-src="smp"]').click(); });
  await sleep(200);
  const u2 = await upd(id1);
  await mgrOpen(page);
  check('A real edit (approving a price) updates Last edited and nothing else about its place: Created is unchanged', u2.updatedAt > u0.updatedAt && u2.createdAt === u0.createdAt && /Last edited/.test((await entry(id1)).text), JSON.stringify([u0, u2]));
  check('Editing a list (newer update time) does not move it either; "Has your corrections" appears', JSON.stringify(await order()) === JSON.stringify([id1, id2, id3]) && /Has your corrections/.test((await entry(id1)).text) && !/Has your corrections/.test((await entry(id2)).text));

  // Rename in the manager: label only
  const keys0 = Object.keys(await ui(() => chrome.storage.local.get())).filter((k) => k.startsWith('blueline:lib:')).sort();
  await entryBtn(id2, 'lib-lm-ren');
  await setVal('[data-lib="lm-name"]', 'Gamma list');
  await click('[data-x="lib-lm-ren-go"]');
  await sleep(250);
  check('Rename in the manager changes only the label: same ids, same storage keys, same position', /Gamma list/.test((await entry(id2)).text) && JSON.stringify(await order()) === JSON.stringify([id1, id2, id3]) && JSON.stringify(Object.keys(await ui(() => chrome.storage.local.get())).filter((k) => k.startsWith('blueline:lib:')).sort()) === JSON.stringify(keys0));

  // Delete: shows what would be lost first
  await entryBtn(id1, 'lib-lm-del');
  const warn = await ui((id) => __BL.S.ui.root.querySelector(`.lib-lm[data-id="${id}"] .lib-lm-more`)?.innerText.replace(/\s+/g, ' ') || '', id1);
  check('Delete first shows the unique corrections and the duplicate list, and nothing is deleted yet', /approved price/.test(warn) && /exists nowhere else/.test(warn) && /same file/.test(warn) && /cannot be undone/.test(warn) && (await order()).length === 3, warn);
  check('Delete permanently is a red destructive button', await ui((id) => __BL.S.ui.root.querySelector(`.lib-lm[data-id="${id}"] [data-x="lib-lm-del-go"]`).classList.contains('lib-danger'), id1));
  await entryBtn(id1, 'lib-lm-cancel');
  check('Cancel keeps the list', (await order()).length === 3 && !(await entry(id1)).text.includes('Delete permanently'));
  await entryBtn(id2, 'lib-lm-del');
  const warn2 = await ui((id) => __BL.S.ui.root.querySelector(`.lib-lm[data-id="${id}"] .lib-lm-more`)?.innerText.replace(/\s+/g, ' ') || '', id2);
  check('A list with no corrections says so before deleting', /no corrections, edits or approved replacements/.test(warn2), warn2);
  await ui((id) => __BL.S.ui.root.querySelector(`.lib-lm[data-id="${id}"] [data-x="lib-lm-del-go"]`).click(), id2);
  await sleep(300);
  const after = await ui(() => chrome.storage.local.get());
  check('Deleting removes only that list; the others and their data are untouched', JSON.stringify(await order()) === JSON.stringify([id1, id3]) && !Object.keys(after).some((k) => k.includes(`|${id2}`)) && Object.keys(after).some((k) => k.includes(`|${id1}`)) && Object.keys(after).some((k) => k.includes(`|${id3}`)));
  check('No page errors (List Manager)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

console.log('\n# Product Library refinement: compact cards, Details, Change Variant view, scroll restoration, clipping, narrow width');
{
  const page = await open('toolbox.html', { http: true, realStorage: true });
  const ui = (fn, ...a) => page.evaluate(fn, ...a);
  const Q = (sel) => ui((sel) => __BL.S.ui.root.querySelector(sel)?.textContent || '', sel);
  const T = (sel) => ui((sel) => __BL.S.ui.root.querySelector(sel)?.innerText || '', sel);
  const click = (sel) => ui((sel) => __BL.S.ui.root.querySelector(sel).click(), sel);
  const setVal = (sel, v, ev = 'input') => ui((sel, v, ev) => { const i = __BL.S.ui.root.querySelector(sel); i.value = v; i.dispatchEvent(new Event(ev, { bubbles: true })); }, sel, v, ev);
  const wait = (fn, t = 12000) => page.waitForFunction(fn, { timeout: t });
  const row = (sku) => libRow(page, sku);
  const rowBtn = (sku, x, extra = '') => libRowBtn(page, sku, x, extra);
  const ORIGIN_NOW = await ui(() => location.origin);
  const listTop = () => ui(() => __BL.S.ui.root.querySelector('.lib-list').scrollTop);
  const rowRect = (k) => ui((k) => { const l = __BL.S.ui.root.querySelector('.lib-list'); const r = [...l.querySelectorAll('.lib-row')].find((x) => x.dataset.key === k)?.getBoundingClientRect(); const lr = l.getBoundingClientRect(); return r ? { top: r.top - lr.top, bottom: lr.bottom - r.bottom, in: r.top >= lr.top && r.bottom <= lr.bottom } : null; }, k);
  const keyOf = (sku) => `sku:${sku}`;
  const shot = async (name) => { if (!process.env.BL_SHOTS) return; const r = await page.send('Page.captureScreenshot', { format: 'png' }); (await import('node:fs')).writeFileSync(`${process.env.BL_SHOTS}/${name}.png`, Buffer.from(r.data, 'base64')); };
  const clip = (sel) => ui((sel) => { // would the element's focus ring or accent be cut off by the scroll container that holds it?
    const root = __BL.S.ui.root; const el = root.querySelector(sel); if (!el) return null;
    let sc = el.parentElement; while (sc && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
    const cs = getComputedStyle(el); const w = cs.outlineStyle === 'none' ? 0 : parseFloat(cs.outlineWidth) + Math.max(parseFloat(cs.outlineOffset) || 0, 0);
    const r = el.getBoundingClientRect(); const s = sc.getBoundingClientRect();
    return { top: r.top - w - s.top, bottom: s.bottom - (r.bottom + w), left: r.left - w - s.left, right: s.right - (r.right + w), w, sc: sc.className };
  }, sel);
  const fits = (c, min = 0) => !!c && c.top >= min && c.bottom >= min && c.left >= min && c.right >= min;

  // a list of 41 products: four real ones from the fake store among 37 that are not in it
  let csv = 'SKU,Name,Price,Sale Price\n';
  for (let i = 1; i <= 24; i++) csv += `FILL${String(i).padStart(3, '0')},Filler Product ${i},$${10 + i}.00,\n`;
  csv += 'ACM100101,Acme Black Seed Oil,$19.97,\nACM999001,Acme Fish Oil Softgels,$30.97,\nACM200101,Acme Charcoal,$15.97,\nACM400101,Acme ZMA Capsules,$27.97,\n';
  for (let i = 25; i <= 37; i++) csv += `FILL${String(i).padStart(3, '0')},Filler Product ${i},$${10 + i}.00,\n`;

  await ui(() => { __BL.S.ui.root.querySelector('[data-d="aids"]').open = true; __BL.S.ui.root.querySelector('[data-x="library"]').click(); });
  await sleep(250);
  // Header
  const hd = await ui(() => { const r = __BL.S.ui.root; const name = r.querySelector('.lib-lsel').getBoundingClientRect(); const link = r.querySelector('[data-x="lib-lists"]'); const lr = link.getBoundingClientRect(); const st = r.querySelector('[data-x="lib-open"]'); return { link: link.textContent.trim(), linkTag: link.className, below: lr.top >= name.bottom - 1, noDropdown: true, set: st.textContent.trim(), cfg: r.querySelector('.lib-cfg').innerText, storePlaceholder: r.querySelector('[data-lib="store"]').placeholder }; });
  check('Header: "Manage lists" is a small text link directly under the List dropdown', hd.link === 'Manage lists' && /lib-tg/.test(hd.linkTag) && hd.below && hd.noDropdown, JSON.stringify(hd));
  check('Store control: the button reads "Set Store" (not "Use store"), the field says it is optional and only for verification, and it does not look like a search', hd.set === 'Set Store' && !/Use store/.test(hd.cfg) && /optional/i.test(hd.cfg) && /verify/i.test(hd.cfg) && !/search/i.test(hd.storePlaceholder), hd.cfg);
  await ui((o) => { const i = __BL.S.ui.root.querySelector('[data-lib="store"]'); i.value = o; __BL.S.ui.root.querySelector('[data-x="lib-open"]').click(); }, ORIGIN_NOW);
  await sleep(200);
  await ui((t) => __BL.libraryUi.importFile(new File([t], 'Black Friday SMP - 2026.csv')), csv);
  await sleep(500);
  const smpKey = Object.keys(await ui(() => chrome.storage.local.get())).find((k) => k.startsWith('blueline:lib:smp:'));
  const smp0 = JSON.stringify((await ui((k) => chrome.storage.local.get(k), smpKey))[smpKey]);
  check('The imported file is one concise line with the dynamic file name (no hash, no explanation)', (await T('.lib-warn')).replace(/\s+/g, ' ').trim().replace(/ Details$/, '') === 'Original imported file: Black Friday SMP - 2026.csv', await T('.lib-warn'));
  const nv0 = await ui(() => [...__BL.S.ui.root.querySelectorAll('.lib-row')].filter((r) => { const b = [...r.querySelectorAll('.lib-badge')]; return !(b.length === 1 && b[0].textContent === 'Not verified' && !['ok', 'warn', 'bad'].some((c) => b[0].classList.contains(c))); }).slice(0, 2).map((r) => r.dataset.key + ':' + [...r.querySelectorAll('.lib-badge')].map((x) => x.textContent + '/' + x.className).join(',')).join(' | '));
  check('Imported: 41 products, none verified yet: every card has the neutral "Not verified" status and no other badge', (await ui(() => __BL.S.ui.root.querySelectorAll('.lib-row').length)) === 41 && nv0 === '', nv0);
  await click('[data-x="lib-check"]');
  await wait(() => /Checked 41 products/.test(__BL.S.ui.root.querySelector('.lib-msg').textContent), 60000);

  // Compact card
  const a = await row('ACM100101');
  const idsRe = /4444444441|1111111111|ACM100101|Variant ID|Shopify SKU|Product ID|black-seed-oil|Imported name|Source placements/i;
  await shot('01-library');
  check('Compact card: image, name, selected option, approved price and one primary status ("Verified", green) are shown; Edit Information, Change Variant and Details are the visible actions', /Acme Black Seed Oil/.test(a.card) && /Flavor: Unflavored/.test(a.card) && /\$19\.97/.test(a.card) && /Approved price/.test(a.card) && /^Verified$/m.test(a.card) && /Edit Information/.test(a.card) && /Change Variant/.test(a.card) && /Details/.test(a.card) && a.img === 'https://cdn.example.com/black-seed-oil.jpg', a.card);
  check('Compact card: SKUs, product and variant IDs, Shopify names, handles, placements and copy buttons are not on the card', !idsRe.test(a.card) && !/⧉/.test(a.card), a.card);
  const badges = await ui(() => [...__BL.S.ui.root.querySelector('.lib-row[data-key="sku:ACM100101"] .lib-badges').children].map((b) => b.textContent + ':' + b.className));
  check('One primary status badge per card (a verified, matching product has no second badge)', badges.length === 1 && /Verified:lib-badge ok/.test(badges[0]), badges.join());
  const sz = await ui(() => { const r = __BL.S.ui.root.querySelector('.lib-row[data-key="sku:ACM100101"] .lib-img').getBoundingClientRect(); return { w: r.width, h: r.height }; });
  check('The product image is small (48px or less)', sz.w <= 48 && sz.h <= 48, JSON.stringify(sz));

  // Primary statuses
  const b = await row('ACM200101'); const f = await row('FILL001'); const z = await row('ACM400101');
  check('Primary statuses: a price difference is "Needs review" (amber) with the reason on the card; an unresolved SKU is "Needs review" too', /^Needs review$/m.test(b.card) && /Price differs/.test(b.card) && b.card.indexOf('Verified') === -1 && /^Needs review$/m.test(f.card) && /SKU not found/.test(f.card) && /^Verified$/m.test(z.card), b.card);
  const rq = await ui(() => { const r = __BL.S.ui.root.querySelector('.lib-row[data-key="sku:ACM200101"]'); const bt = (x) => r.querySelector(`[data-x="${x}"]`); const cs = (el) => getComputedStyle(el).backgroundColor.replace(/\s/g, ''); return { badge: cs(r.querySelector('.lib-badge')), shop: bt('lib-use') ? cs(r.querySelector('[data-x="lib-use"][data-src="shopify"]')) : null, smp: cs(r.querySelector('[data-x="lib-use"][data-src="smp"]')), custom: cs(bt('lib-custom')), open: r.querySelector('.lib-dt') !== null }; });
  check('A required price approval is visible without opening Details; approval buttons are green, Custom price is neutral', !rq.open && rq.shop === 'rgb(30,122,62)' && rq.smp === 'rgb(30,122,62)' && rq.custom === 'rgb(255,255,255)' && rq.badge === 'rgb(255,244,214)', JSON.stringify(rq));
  check('Approval and secondary price actions that are not required now are not on the card (Refresh, Clear approval and the rest live in Details)', !/Refresh|Clear approval|Revoke|Find different/.test(a.card) && /Refresh/.test(a.text), a.card);

  // Details: disclosure, every technical field, copy buttons
  const dt = await ui(() => { const r = __BL.S.ui.root.querySelector('.lib-row[data-key="sku:ACM100101"]'); const t = r.querySelector('[data-x="lib-details"]'); return { exp: t.getAttribute('aria-expanded'), ctl: t.getAttribute('aria-controls'), neutral: getComputedStyle(t).backgroundColor.replace(/\s/g, ''), label: t.textContent.trim() }; });
  check('Details is an obvious, neutral disclosure button (collapsed by default, aria-expanded false)', dt.exp === 'false' && /^Details/.test(dt.label) && dt.neutral === 'rgb(255,255,255)' && !!dt.ctl, JSON.stringify(dt));
  await rowBtn('ACM100101', 'lib-details');
  const ad = await row('ACM100101');
  await ui(() => __BL.S.ui.root.querySelector('.lib-row[data-key="sku:ACM100101"]').scrollIntoView({ block: 'start' }));
  await shot('02-details');
  const open1 = await ui(() => { const r = __BL.S.ui.root.querySelector('.lib-row[data-key="sku:ACM100101"]'); return { exp: r.querySelector('[data-x="lib-details"]').getAttribute('aria-expanded'), id: r.querySelector('.lib-dt')?.id, ctl: r.querySelector('[data-x="lib-details"]').getAttribute('aria-controls'), url: r.querySelector('.lib-kv a')?.href, vid: r.querySelector('.lib-vid')?.innerText.replace('⧉', '').trim(), copies: [...r.querySelectorAll('.lib-dt [data-x="lib-copy"]')].map((c) => c.dataset.what) }; });
  check('Details opens in place and exposes every identifier once: product, SKU, variant ID, product ID, handle and URL, with copy buttons', open1.exp === 'true' && open1.id === open1.ctl && ['Product', 'SKU', 'Variant ID', 'Product ID', 'Handle / URL'].every((k) => k in ad.kv) && open1.vid === '4444444441' && /\/products\/black-seed-oil/.test(open1.url) && ['SKU', 'variant ID', 'product ID', 'handle', 'product URL'].every((w) => open1.copies.includes(w)), JSON.stringify(open1));
  const sumTxt = Object.entries(ad.kv).filter(([k]) => k !== 'Approved regular').map(([, v]) => v).join(' | ');
  check('Details for a verified product shows matching values once: one SKU row, one regular price ($19.97 once) with a verified mark, no separate imported / Shopify names, SKUs or prices', !('Imported name' in ad.kv) && !('Imported SKU' in ad.kv) && !('Shopify SKU' in ad.kv) && !('Imported price' in ad.kv) && !('Shopify price' in ad.kv) && (sumTxt.match(/ACM100101/g) || []).length === 1 && (sumTxt.match(/\$19\.97/g) || []).length === 1 && /Imported, Shopify and approved agree/.test(ad.kv['Regular price']) && /Matches imported SKU/.test(ad.kv.SKU), JSON.stringify(ad.kv));
  check('Details keeps the promotional price apart from the regular price, plus availability, verification, source and placements; no compare-at row when there is none', ['Regular price', 'Promotional price', 'Availability', 'Price check', 'Matched by', 'Source'].every((k) => k in ad.kv) && !('Compare-at price' in ad.kv) && ad.kv.Availability === 'Available' && /Source placements \(1\)/i.test(ad.text), JSON.stringify(ad.kv));
  const cb0 = await ui(() => { const r = __BL.S.ui.root.querySelector('.lib-row[data-key="sku:ACM100101"]'); const b = r.querySelector('[data-x="lib-cmp"]'); return { exp: b?.getAttribute('aria-expanded'), table: !!r.querySelector('.lib-cmpt'), label: b?.textContent.trim() }; });
  check('"Full source comparison" is a collapsed disclosure inside Details', cb0.exp === 'false' && !cb0.table && /Full source comparison/.test(cb0.label), JSON.stringify(cb0));
  await rowBtn('ACM100101', 'lib-cmp');
  await ui(() => __BL.S.ui.root.querySelector('.lib-row[data-key="sku:ACM100101"]').scrollIntoView({ block: 'start' }));
  await shot('02b-comparison');
  const cmpHead = await ui(() => [...__BL.S.ui.root.querySelectorAll('.lib-row[data-key="sku:ACM100101"] .lib-cmpt thead th')].map((t) => t.textContent.trim()));
  const cmpRows = (await row('ACM100101')).cmp;
  check('The comparison is a table: Field | Imported SMP | Shopify | Approved / Current, with every source value (identical ones too), and no highlighted differences for a verified product', cmpHead.join('|') === 'Field|Imported SMP|Shopify|Approved / Current' && cmpRows.SKU.join('|') === 'ACM100101|ACM100101|ACM100101' && cmpRows['Regular price'][0] === '$19.97' && /^\$19\.97/.test(cmpRows['Regular price'][2]) && cmpRows['Variant ID'][1] === '4444444441' && Object.values((await row('ACM100101')).cmpDiff).every((d) => !d.some(Boolean)), JSON.stringify(cmpRows));
  await rowBtn('ACM100101', 'lib-cmp');
  await ui(() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied.push(t); } }, configurable: true }); });
  for (const w of ['variant ID', 'product ID', 'handle', 'product URL', 'SKU']) await rowBtn('ACM100101', 'lib-copy', `[data-what="${w}"]`);
  const copied = await ui(() => window.__copied);
  check('The copy buttons copy the exact variant ID, product ID, handle, URL and SKU (the variant ID is one disclosure away from the card)', copied[0] === '4444444441' && copied[1] === '1111111111' && copied[2] === 'black-seed-oil' && /\/products\/black-seed-oil(\?variant=4444444441)?$/.test(copied[3]) && copied[4] === 'ACM100101', JSON.stringify(copied));
  const hOpen = (await row('ACM100101')).openHeight;
  await rowBtn('ACM100101', 'lib-details');
  check('Details closes again, and the card is shorter than with Details open', !(await ui(() => !!__BL.S.ui.root.querySelector('.lib-row[data-key="sku:ACM100101"] .lib-dt'))) && (await row('ACM100101')).height < 175 && hOpen > (await row('ACM100101')).height + 150, `${hOpen} vs ${(await row('ACM100101')).height}`);

  // A promo-price warning stays discoverable from the card and its filter: the SMP promo against a stated discount
  await ui(() => { const U = __BL.libraryUi; U.L.lib = { ...U.L.lib, work: { ...U.L.lib.work, edits: { ...U.L.lib.work.edits, 'sku:ACM400101': { promoCents: 100 } } } }; });
  // (the stated discount percent comes from the file, so also set one through an edit-free path: use a row that already has one in the SMP fixture block above)

  // ---- Change Variant: scroll restoration, cancel, review, confirm, replacement approval
  await setVal('[data-lib="filter"]', 'matched', 'change');
  check('Filter "Prices match" lists the matching products (ACM999001 among them) before the change', !!(await rowRect(keyOf('ACM999001'))));
  await ui(() => { const l = __BL.S.ui.root.querySelector('.lib-list'); const r = l.querySelector('.lib-row[data-key="sku:ACM999001"]'); l.scrollTop = Math.max(0, r.offsetTop - l.offsetTop - 40); });
  await setVal('[data-lib="filter"]', 'all', 'change');
  await ui(() => { const l = __BL.S.ui.root.querySelector('.lib-list'); const r = l.querySelector('.lib-row[data-key="sku:ACM999001"]'); l.scrollTop = r.offsetTop - l.offsetTop - 60; });
  const st0 = await listTop();
  check('The list is scrolled well down with the product being edited in view (37 more products above and below)', st0 > 500 && (await rowRect(keyOf('ACM999001'))).in, String(st0));
  await rowBtn('ACM999001', 'lib-variants');
  await wait(() => __BL.S.ui.root.querySelectorAll('.lib-vv-list input[type=radio]').length === 2);
  const r0 = await ui(() => { const r = __BL.S.ui.root; const vis = (e) => !!e && e.getClientRects().length > 0; return { list: vis(r.querySelector('.lib-list')), chips: vis(r.querySelector('.lib-chips')), view: vis(r.querySelector('.lib-vv')), win: document.querySelectorAll('dialog').length, modals: [...r.querySelectorAll('.xmodal')].filter((m) => !m.hidden).length, head: r.querySelector('.lib-vv-h').textContent, prod: r.querySelector('.lib-vv-prod').textContent, cur: r.querySelector('.lib-vv-cur').textContent }; });
  check('Change Variant replaces the library content inside the same modal: no second modal, window or popup, and the list is hidden', r0.view && !r0.list && !r0.chips && r0.win === 0 && r0.modals === 1 && r0.head === 'Change Variant' && r0.prod === 'Acme Fish Oil Softgels' && r0.cur === 'Current: 90 ct', JSON.stringify(r0));
  await shot('03-change-variant');
  await ui(() => { const el = __BL.S.ui.root.querySelectorAll('.lib-vv-list input[type=radio]')[0]; el.focus(); });
  await page.keyboard.press('ArrowDown');
  await sleep(80);
  const kb = await ui(() => ({ checked: [...__BL.S.ui.root.querySelectorAll('.lib-vv-list input[type=radio]')].map((i) => i.checked), dis: __BL.S.ui.root.querySelector('[data-x="lib-vv-review"]').disabled, sel: __BL.libraryUi.L.find.selId }));
  check('Arrow keys move the single radio selection and enable Review Variant Change (keyboard accessible)', kb.checked.join() === 'false,true' && !kb.dis && kb.sel === '4444444450', JSON.stringify(kb));
  await click('[data-x="lib-vv-review"]');
  const rv = await T('.lib-vv-review');
  await shot('04-review');
  check('Review step: Current and New with name and SKU; a different SKU explains that a separate replacement approval will be required', /Current/i.test(rv) && /90 ct/.test(rv) && /SKU ACM999001/.test(rv) && /NEW/i.test(rv) && /180 ct/.test(rv) && /SKU ACM999002/.test(rv) && /This variant has a different SKU than the original imported product/.test(rv) && /Confirming the change will require a separate replacement approval\./.test(rv), rv);
  const cb = await ui(() => { const c = __BL.S.ui.root.querySelector('[data-x="lib-vv-confirm"]'); const k = __BL.S.ui.root.querySelector('[data-x="lib-vv-tochoose"]'); const cs = (e) => getComputedStyle(e).backgroundColor.replace(/\s/g, ''); return { c: cs(c), k: cs(k), cw: c.getBoundingClientRect().width, pw: c.parentElement.getBoundingClientRect().width, text: [c.textContent.trim(), k.textContent.trim()] }; });
  check('Confirm Variant Change is the blue primary; Back to Variants is the neutral secondary', cb.c === 'rgb(43,78,255)' && cb.k === 'rgb(255,255,255)' && cb.text.join('|') === 'Confirm Variant Change|Back to Variants' && Math.abs(cb.cw - cb.pw) < 2, JSON.stringify(cb));
  // Cancelling changes nothing and restores the scroll position
  await click('[data-x="lib-vv-back"]');
  check('Back from the review returns to the choice (selection kept); nothing saved', (await ui(() => __BL.libraryUi.L.find.step)) === 'choose' && (await ui(() => __BL.libraryUi.L.find.selId)) === '4444444450' && (await ui(() => __BL.libraryUi.L.lib.work.shopify['sku:ACM999001'].variant.variantId)) === '4444444449');
  await click('[data-x="lib-vv-back"]');
  const afterCancel = await listTop();
  check('Cancel returns to the Product Library, restores the scroll position, and leaves the saved selection and approvals untouched', Math.abs(afterCancel - st0) <= 1 && (await rowRect(keyOf('ACM999001'))).in && !(await row('ACM999001')).pending && /4444444449/.test((await row('ACM999001')).text) && !(await ui(() => [...__BL.S.ui.root.querySelectorAll('.lib-row')].some((r) => r.dataset.recent === '1'))), `${st0} -> ${afterCancel}`);
  // Confirm, with the filter set so the product would normally drop out of the list
  await setVal('[data-lib="filter"]', 'matched', 'change');
  await ui(() => { const l = __BL.S.ui.root.querySelector('.lib-list'); l.scrollTop = 0; });
  const st1 = await listTop();
  await rowBtn('ACM999001', 'lib-variants');
  await wait(() => __BL.S.ui.root.querySelectorAll('.lib-vv-list input[type=radio]').length === 2);
  await ui(() => __BL.S.ui.root.querySelectorAll('.lib-vv-list input[type=radio]')[1].click());
  await click('[data-x="lib-vv-review"]');
  await click('[data-x="lib-vv-confirm"]');
  await sleep(250);
  const rc = await row('ACM999001');
  await shot('05-after-confirm');
  const rr = await rowRect(keyOf('ACM999001'));
  check('Confirm applies the new variant, returns to the library at the previous scroll position (moved only as far as needed to show the taller card), keeps the edited product visible even though the Prices-match filter no longer fits it, and emphasises it', rc.recent && rr?.in && (Math.abs((await listTop()) - st1) <= 1 || ((await listTop()) > st1 && rr.bottom < 4)) && !(await ui(() => __BL.S.ui.root.querySelector('.lib-vv').getClientRects().length)), JSON.stringify({ rc: rc.recent, rr, st1, now: await listTop(), listH: await ui(() => __BL.S.ui.root.querySelector('.lib-list').clientHeight), rowH: rc.height, sheetH: await ui(() => __BL.S.ui.root.querySelector('.lib-sheet').clientHeight), hs: await ui(() => ['.lib-cfg', '.lib-msg', '.lib-warn', '.lib-sum', '.lib-chips', '.lib-filter', '.lib-tools', '.lib-h', '.lib-sheet > header'].map((c) => { const e = __BL.S.ui.root.querySelector(c); return c + ':' + (e ? Math.round(e.getBoundingClientRect().height) : '-'); }).join(' ')) }));
  check('The edited product shows its resulting state on the card: "Replacement approval required" (amber) with original and proposed replacement apart and a green Approve Replacement button, without opening Details', /^Replacement approval required$/m.test(rc.card) && rc.pending && /Original \(imported\)/i.test(rc.card) && /Proposed replacement \(not approved yet\)/i.test(rc.card) && /SKU ACM999001/.test(rc.card) && /SKU ACM999002/.test(rc.card) && /Approve Replacement/.test(rc.card), rc.card);
  check('The message says the change needs approval (a warning, never a success)', /^Variant changed — replacement approval required/.test(await Q('.lib-msg')) && /warn/.test(await ui(() => __BL.S.ui.root.querySelector('.lib-msg').className)));
  const exp1 = JSON.parse(await ui(() => __BL.libraryUi.exportJson('approved')));
  check('An unapproved replacement is not in the approved export; it is listed as needing attention', !exp1.products.some((p) => p.key === 'sku:ACM999001') && exp1.needsAttention.some((x) => x.sku === 'ACM999001'));
  await rowBtn('ACM999001', 'lib-details'); await rowBtn('ACM999001', 'lib-cmp');
  await ui(() => __BL.S.ui.root.querySelector('.lib-row[data-key="sku:ACM999001"]').scrollIntoView({ block: 'start' }));
  await shot('05b-substitution-details');
  await rowBtn('ACM999001', 'lib-cmp'); await rowBtn('ACM999001', 'lib-details');
  const sc = await row('ACM999001');
  check('A different selected Shopify SKU: Details lists the imported and the Shopify SKU and price separately and flags them; approval is shown as pending', ['Imported SKU', 'Shopify SKU', 'Imported price', 'Shopify price', 'Approved price'].every((k) => k in sc.kv) && /Different SKU/.test(sc.kv['Shopify SKU']) && /not approved|waiting/i.test(sc.kv['Approved price']) && sc.kv.Replacement === 'Not approved yet', JSON.stringify(sc.kv));
  check('The Full source comparison makes the substitution obvious: SKU and regular price highlighted under Shopify, approved shown as pending, source values unchanged', sc.cmp.SKU.join('|') === 'ACM999001|ACM999002|ACM999002' && sc.cmpDiff.SKU.join() === 'false,true,true' && sc.cmp['Regular price'][0] === '$30.97' && sc.cmp['Regular price'][1] === '$54.97' && sc.cmpDiff['Regular price'].join() === 'false,true,false' && /Not approved/.test(sc.cmp['Regular price'][2]), JSON.stringify(sc.cmp));
  // Emphasis: an inset accent, never an outline; the border never changes size
  const emph = await ui(() => { const rs = [...__BL.S.ui.root.querySelectorAll('.lib-row')]; const rec = rs.find((r) => r.dataset.recent === '1'); const norm = rs.find((r) => !r.dataset.recent); const g = (e) => { const c = getComputedStyle(e); return { ol: c.outlineStyle, bw: c.borderTopWidth + '/' + c.borderLeftWidth, shadow: c.boxShadow, w: Math.round(e.getBoundingClientRect().width) }; }; return { rec: rec ? g(rec) : null, norm: norm ? g(norm) : null }; });
  check('Emphasis is an inset accent and border colour (no outline); the border widths and the card width do not change', emph.rec && emph.rec.ol === 'none' && /inset/.test(emph.rec.shadow) && emph.rec.bw === emph.norm.bw && emph.rec.w === emph.norm.w, JSON.stringify(emph));
  // Approve Replacement, then the price, then revoke
  await rowBtn('ACM999001', 'lib-ident');
  await sleep(150);
  const ap = await row('ACM999001');
  check('After Approve Replacement the amber pending state is gone; the price still differs, so the card says so and offers the price approvals', !ap.pending && !/Approve Replacement/.test(ap.card) && /^Needs review$/m.test(ap.card) && /Use Shopify price/.test(ap.card), ap.card);
  await rowBtn('ACM999001', 'lib-use', '[data-src="smp"]');
  await sleep(150);
  const ap2 = await row('ACM999001');
  check('Once the price is approved too, the card reads "Replacement approved" (green) and is in the approved export as a substitute', /^Replacement approved$/m.test(ap2.card) && ap2.v === 'ok' && /Revoke approval/.test(ap2.text) && !/Revoke approval/.test(ap2.card) && JSON.parse(await ui(() => __BL.libraryUi.exportJson('approved'))).products.some((p) => p.key === 'sku:ACM999001' && p.identity.state === 'substitute-approved'), ap2.card);
  await rowBtn('ACM999001', 'lib-ident-revoke');
  await sleep(150);
  check('Revoke approval (in Details) returns the replacement to pending', (await row('ACM999001')).pending);
  await setVal('[data-lib="filter"]', 'all', 'change');
  check('The original SMP record is byte-for-byte unchanged by all of this', JSON.stringify((await ui((k) => chrome.storage.local.get(k), smpKey))[smpKey]) === smp0);

  // Clipping: selected / current states are inset, nothing sits at a scroll container's edge
  await ui(() => { const l = __BL.S.ui.root.querySelector('.lib-list'); l.scrollTop = 0; });
  const topRow = await ui(() => { const l = __BL.S.ui.root.querySelector('.lib-list'); const r = l.querySelector('.lib-row'); const lr = l.getBoundingClientRect(); const rr = r.getBoundingClientRect(); return { top: rr.top - lr.top, left: rr.left - lr.left }; });
  await ui(() => { const l = __BL.S.ui.root.querySelector('.lib-list'); l.scrollTop = l.scrollHeight; });
  const botRow = await ui(() => { const l = __BL.S.ui.root.querySelector('.lib-list'); const rs = l.querySelectorAll('.lib-row'); const lr = l.getBoundingClientRect(); const rr = rs[rs.length - 1].getBoundingClientRect(); return { bottom: lr.bottom - rr.bottom, right: lr.right - rr.right }; });
  check('The first and last cards sit inside the scroll area with a gutter on every side (nothing touches or is cut off by the container)', topRow.top >= 3 && topRow.left >= 3 && botRow.bottom >= 3 && botRow.right >= 3, JSON.stringify({ topRow, botRow }));
  await ui(() => { const U = __BL.libraryUi; U.L.editFor = U.L.rows[0].key; U.render(); });
  const edRow = await ui(() => { const r = __BL.S.ui.root.querySelector('.lib-list .lib-row'); const l = __BL.S.ui.root.querySelector('.lib-list'); l.scrollTop = 0; const c = getComputedStyle(r); return { ol: c.outlineStyle, bg: c.backgroundColor }; });
  await ui(() => { const U = __BL.libraryUi; U.L.editFor = null; U.L.find = { mode: 'pick', key: U.L.rows[0].key, results: [], busy: false, note: '', product: null, filter: '', skuResults: null, last: null, cache: new Map(), queued: false, pendingIdx: null }; U.render(); });
  const pickRow = await ui(() => { const r = __BL.S.ui.root.querySelector('.lib-list .lib-row[data-editing="1"]'); if (!r) return null; const c = getComputedStyle(r); return { ol: c.outlineStyle, shadow: c.boxShadow, bg: c.backgroundColor }; });
  await ui(() => { __BL.libraryUi.L.find = null; __BL.libraryUi.render(); });
  check('The product being searched for or edited is marked with a tint and an inset accent, never an outline that a scroll area could clip', pickRow && pickRow.ol === 'none' && /inset/.test(pickRow.shadow) && pickRow.bg !== 'rgb(255, 255, 255)', JSON.stringify(pickRow));
  // Keyboard focus rings stay inside the scroll area, at both ends
  await ui(() => { const l = __BL.S.ui.root.querySelector('.lib-list'); l.scrollTop = 0; });
  await ui(() => __BL.S.ui.root.querySelector('.lib-list .lib-row [data-x="lib-edit"]').focus({ focusVisible: true }));
  const fTop = await clip('.lib-list .lib-row [data-x="lib-edit"]');
  await ui(() => { const l = __BL.S.ui.root.querySelector('.lib-list'); l.scrollTop = l.scrollHeight; const rs = l.querySelectorAll('.lib-row'); rs[rs.length - 1].querySelector('[data-x="lib-details"]').focus({ focusVisible: true }); });
  const fBot = await ui(() => { const l = __BL.S.ui.root.querySelector('.lib-list'); const rs = l.querySelectorAll('.lib-row'); const el = rs[rs.length - 1].querySelector('[data-x="lib-details"]'); const cs = getComputedStyle(el); const w = parseFloat(cs.outlineWidth) + Math.max(parseFloat(cs.outlineOffset) || 0, 0); const r = el.getBoundingClientRect(); const s = l.getBoundingClientRect(); return { focused: el.matches(':focus-visible'), style: cs.outlineStyle, bottom: s.bottom - (r.bottom + w), right: s.right - (r.right + w) }; });
  check('Keyboard focus is visible (a solid outline) and its ring stays inside the list at the very top and the very bottom', fits(fTop, 0) && fBot.focused && fBot.style !== 'none' && fBot.bottom >= 0 && fBot.right >= 0, JSON.stringify({ fTop, fBot }));

  // Narrow widths: no horizontal overflow, the review button stays reachable
  await page.setViewport({ width: 360, height: 640 });
  await sleep(250);
  const nar = await ui(() => { const r = __BL.S.ui.root; const sh = r.querySelector('.lib-sheet'); const l = r.querySelector('.lib-list'); const rows = [...l.querySelectorAll('.lib-row')].slice(0, 8); return { sheet: sh.scrollWidth <= sh.clientWidth + 1, list: l.scrollWidth <= l.clientWidth + 1, rows: rows.every((x) => x.scrollWidth <= x.clientWidth + 1), sw: Math.round(sh.getBoundingClientRect().width), vw: innerWidth }; });
  check('At 360 px wide the library has no horizontal scrolling: the sheet, the list and the cards all fit', nar.sheet && nar.list && nar.rows && nar.sw <= nar.vw, JSON.stringify(nar));
  await shot('06-narrow-library');
  await rowBtn('ACM999001', 'lib-variants');
  await wait(() => __BL.S.ui.root.querySelectorAll('.lib-vv-list input[type=radio]').length === 2);
  const nv = await ui(() => { const r = __BL.S.ui.root; const sh = r.querySelector('.lib-sheet').getBoundingClientRect(); const b = r.querySelector('[data-x="lib-vv-review"]').getBoundingClientRect(); const sc = r.querySelector('.lib-sheet'); const rows = [...r.querySelectorAll('.lib-vr')].map((x) => x.scrollWidth <= x.clientWidth + 1); return { btnIn: b.bottom <= sh.bottom && b.top >= sh.top && b.right <= sh.right, hs: sc.scrollWidth <= sc.clientWidth + 1, rows: rows.every(Boolean), vh: innerHeight, bottom: Math.round(b.bottom) }; });
  check('At 360 × 640 the Change Variant view fits: the radio rows do not overflow and Review Variant Change stays on screen', nv.btnIn && nv.hs && nv.rows && nv.bottom <= nv.vh, JSON.stringify(nv));
  await shot('07-narrow-variants');
  await click('[data-x="lib-vv-back"]');
  await mgrOpen(page);
  const nm = await ui(() => { const r = __BL.S.ui.root; const m = r.querySelector('.lib-mgr'); const l = r.querySelector('.lib-mgr-list'); const sh = r.querySelector('.lib-sheet'); return { fits: l.scrollWidth <= l.clientWidth + 1, sheetFits: sh.scrollWidth <= sh.clientWidth + 1, noNested: getComputedStyle(l).overflowY === 'visible', h: Math.round(m.getBoundingClientRect().height), vh: innerHeight }; });
  check('At 360 px the Manage Lists view has no horizontal overflow, fits the window, and has no nested scroller', nm.fits && nm.sheetFits && nm.noNested, JSON.stringify(nm));
  await shot('08-narrow-manager');
  await page.setViewport({ width: 1280, height: 900 });
  await click('[data-x="lib-lists-close"]');

  check('No page errors (Product Library refinement)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

console.log('\n# Product Library QA fixes: Manage Lists view, pencil rename, Shopify Store styling, accents reserved for status cards');
{
  const page = await open('toolbox.html', { http: true, realStorage: true });
  const ui = (fn, ...a) => page.evaluate(fn, ...a);
  const click = (sel) => ui((sel) => __BL.S.ui.root.querySelector(sel).click(), sel);
  const file = (name, text) => ui((n, t) => __BL.libraryUi.importFile(new File([t], n)), name, text);
  const shot = async (name) => { if (!process.env.BL_SHOTS) return; const r = await page.send('Page.captureScreenshot', { format: 'png' }); (await import('node:fs')).writeFileSync(`${process.env.BL_SHOTS}/${name}.png`, Buffer.from(r.data, 'base64')); };
  const idx = async () => (await ui(() => chrome.storage.local.get('blueline:lib:index')))['blueline:lib:index'];
  const listId = () => ui(() => __BL.libraryUi.L.listId);
  const vis = (sel) => ui((sel) => { const e = __BL.S.ui.root.querySelector(sel); return !!e && e.getClientRects().length > 0; }, sel);
  const accents = () => ui(() => [...__BL.S.ui.root.querySelectorAll('.lib-sheet *')].filter((e) => !e.closest('.lib-row') && !e.closest('.lib-cmp') && /(^| )[1-9]\d*px 0px 0px 0px inset/.test(getComputedStyle(e).boxShadow)).map((e) => e.className || e.tagName));

  await ui(() => { __BL.S.ui.root.querySelector('[data-d="aids"]').open = true; __BL.S.ui.root.querySelector('[data-x="library"]').click(); });
  await sleep(250);
  // Shopify Store: a plain form group
  const sb = await ui(() => { const r = __BL.S.ui.root; const b = r.querySelector('.lib-storebox'); const cs = getComputedStyle(b); const sh = r.querySelector('.lib-sheet').getBoundingClientRect(); const br = b.getBoundingClientRect(); return { shadow: cs.boxShadow, bl: cs.borderLeftWidth, bg: cs.backgroundColor, left: br.left - sh.left, right: sh.right - br.right, text: b.innerText, btn: !!b.querySelector('[data-x="lib-open"]'), field: !!b.querySelector('[data-lib="store"], [data-lib="storesel"]') }; });
  check('Shopify Store has no left accent: no inset shadow, no left border, no tinted card; the optional explanation, field and Set Store button are kept and inside the modal', sb.shadow === 'none' && sb.bl === '0px' && /rgba\(0, 0, 0, 0\)|transparent/.test(sb.bg) && /optional/i.test(sb.text) && /verify/i.test(sb.text) && sb.btn && sb.field && sb.left >= 12 && sb.right >= 12, JSON.stringify(sb));
  check('Colored left accents appear only on Product Library cards: none on settings, forms, notices or navigation (empty screen)', (await accents()).length === 0, JSON.stringify(await accents()));
  await shot('10-empty');
  // pencil rename on a new list
  check('The header offers a List dropdown, with no rename pencil or name input; Manage lists stays under it', await vis('[data-lib="listsel"]') && !(await vis('[data-x="lib-name-edit"]')) && !(await vis('[data-lib="name"]')) && await vis('[data-x="lib-lists"]') && /^List:/.test(await ui(() => __BL.S.ui.root.querySelector('.lib-lsel').innerText)), JSON.stringify([await vis('[data-lib="listsel"]'), await vis('[data-x="lib-name-edit"]'), await vis('[data-lib="name"]'), await vis('[data-x="lib-lists"]'), await ui(() => __BL.S.ui.root.querySelector('.lib-lsel').innerText)]));
  await file('Alpha.csv', 'SKU,Name,Price\nA1,Alpha,$1.00\nA2,Beta,$2.00\n');
  await sleep(300);
  const id1 = await listId();
  const smpKey = Object.keys(await ui(() => chrome.storage.local.get())).find((k) => k.startsWith('blueline:lib:smp:'));
  const smp0 = JSON.stringify((await ui((k) => chrome.storage.local.get(k), smpKey))[smpKey]);
  check('After an import the list is named from the file and shown in the List dropdown', (await libName(page)) === 'Alpha' && !(await vis('[data-lib="name"]')));
  const e0 = (await idx()).libs.find((l) => l.campaign === id1);
  await sleep(30);
  await libRename(page, 'Typed but cancelled', 'cancel');
  check('Cancel in Manage lists leaves the name and the saved list exactly as they were', (await libName(page)) === 'Alpha' && (await idx()).libs.find((l) => l.campaign === id1).updatedAt === e0.updatedAt);
  await libRename(page, 'Alpha', 'save');
  check('Saving an unchanged name modifies nothing (Last edited stays)', (await idx()).libs.find((l) => l.campaign === id1).updatedAt === e0.updatedAt && (await libName(page)) === 'Alpha');
  await libRename(page, 'Alpha Launch', 'save');
  const e1 = (await idx()).libs.find((l) => l.campaign === id1);
  check('Saving a real change renames only the label: same id, Last edited moves, Created and the imported record do not', (await libName(page)) === 'Alpha Launch' && e1.name === 'Alpha Launch' && e1.updatedAt > e0.updatedAt && e1.createdAt === e0.createdAt && JSON.stringify((await ui((k) => chrome.storage.local.get(k), smpKey))[smpKey]) === smp0 && (await listId()) === id1);
  await libRename(page, 'Alpha Launch 2', 'enter');
  check('Enter in the field saves', (await libName(page)) === 'Alpha Launch 2');
  await libRename(page, 'Alpha Launch', 'save');

  // many lists
  for (let i = 2; i <= 11; i++) { await ui(() => { const r = __BL.S.ui.root; if (r.querySelector('.lib-mgr').hidden) r.querySelector('[data-x="lib-lists"]').click(); }); await sleep(120); await click('[data-x="lib-new"]'); await sleep(200); await file(`List ${i}.csv`, `SKU,Name,Price\nS${i},Item ${i},$${i}.00\n`); await sleep(250); }
  const main = await ui(() => { const r = __BL.S.ui.root; const l = r.querySelector('.lib-list'); return { rows: l.querySelectorAll('.lib-row').length }; });
  const before = await ui(() => __BL.S.ui.root.querySelector('.lib-list').scrollTop);
  await click('[data-x="lib-lists"]');
  await sleep(250);
  const mv = await ui(() => {
    const r = __BL.S.ui.root; const sh = r.querySelector('.lib-sheet'); const m = r.querySelector('.lib-mgr'); const l = r.querySelector('.lib-mgr-list');
    const shr = sh.getBoundingClientRect(); const mr = m.getBoundingClientRect(); const rects = (s) => r.querySelector(s)?.getClientRects().length || 0;
    return { open: !m.hidden && mr.height > 0, mainHidden: rects('.lib-cfg') === 0 && rects('.lib-list') === 0 && rects('.lib-chips') === 0 && rects('.lib-tools') === 0, inside: mr.left >= shr.left && mr.right <= shr.right && mr.top >= shr.top && mr.bottom <= shr.bottom + 1, back: !!r.querySelector('[data-x="lib-lists-close"]')?.getClientRects().length, backLabel: r.querySelector('[data-x="lib-lists-close"]').getAttribute('aria-label'), head: m.querySelector('h3').textContent, newBtn: !!r.querySelector('[data-x="lib-new"]')?.getClientRects().length, entries: l.querySelectorAll('.lib-lm').length, listScrolls: l.scrollHeight > l.clientHeight, sheetScrolls: sh.scrollHeight > sh.clientHeight + 1, modals: [...r.querySelectorAll('.xmodal')].filter((x) => !x.hidden).length, zs: getComputedStyle(m).zIndex };
  });
  check('Manage lists is a dedicated view in the same modal: the library is hidden, not overlapped; it has a Back button, the heading and New List, inside the sheet', mv.open && mv.mainHidden && mv.inside && mv.back && /Back/.test(mv.backLabel) && mv.head === 'Manage lists' && mv.newBtn && mv.modals === 1 && mv.zs === 'auto', JSON.stringify(mv));
  check('With 11 lists there is one scroller (the list), the sheet itself does not scroll, and nothing is cut off', mv.entries === 11 && mv.listScrolls && !mv.sheetScrolls, JSON.stringify(mv));
  await shot('11-manage-lists');
  const ent = await ui(() => [...__BL.S.ui.root.querySelectorAll('.lib-lm')].slice(0, 2).map((e) => e.innerText.replace(/\s+/g, ' ')));
  check('Entries show name, Created and Last edited, store, counts, and the Open / Rename / Delete actions', /Alpha Launch/.test(ent[0]) && /Created: .*\d{4}/.test(ent[0]) && /Last edited: .*\d{4}/.test(ent[0]) && /products?/.test(ent[0]) && /Open Rename Delete/.test(ent[0]), ent[0]);
  check('No colored left accents in the manager (the open list is a tint and border only)', (await accents()).length === 0 && await ui(() => { const e = __BL.S.ui.root.querySelector('.lib-lm[data-cur="1"]'); const c = getComputedStyle(e); return c.outlineStyle === 'none' && c.boxShadow === 'none'; }));
  const clipM = await ui(() => { const r = __BL.S.ui.root; const l = r.querySelector('.lib-mgr-list'); const out = []; for (const pos of ['top', 'bottom']) { l.scrollTop = pos === 'top' ? 0 : l.scrollHeight; const rs = l.querySelectorAll('.lib-lm'); const el = (pos === 'top' ? rs[0] : rs[rs.length - 1]).querySelector('[data-x="lib-lm-ren"]'); el.focus({ focusVisible: true }); const cs = getComputedStyle(el); const w = parseFloat(cs.outlineWidth) + Math.max(parseFloat(cs.outlineOffset) || 0, 0); const b = el.getBoundingClientRect(); const s = l.getBoundingClientRect(); out.push({ pos, ring: cs.outlineStyle !== 'none', top: b.top - w - s.top, bottom: s.bottom - (b.bottom + w), right: s.right - (b.right + w) }); } return out; });
  check('Keyboard focus rings in the first and last entries stay inside the list', clipM.every((c) => c.ring && c.top >= 0 && c.bottom >= 0 && c.right >= 0), JSON.stringify(clipM));
  // rename and delete inside the view
  await ui(() => { __BL.S.ui.root.querySelector('.lib-mgr-list').scrollTop = 0; });
  await ui(() => __BL.S.ui.root.querySelector('.lib-lm [data-x="lib-lm-ren"]').click());
  const rn = await ui(() => { const i = __BL.S.ui.root.querySelector('[data-lib="lm-name"]'); return { v: i.value, save: !!__BL.S.ui.root.querySelector('[data-x="lib-lm-ren-go"]'), cancel: !!__BL.S.ui.root.querySelector('.lib-lm-more [data-x="lib-lm-cancel"]') }; });
  check('Rename inside Manage lists uses the same Save / Cancel pattern', rn.v === 'Alpha Launch' && rn.save && rn.cancel);
  await ui(() => __BL.S.ui.root.querySelector('.lib-lm-more [data-x="lib-lm-cancel"]').click());
  await ui(() => __BL.S.ui.root.querySelector('.lib-lm [data-x="lib-lm-del"]').click());
  const dl = await ui(() => ({ danger: !!__BL.S.ui.root.querySelector('[data-x="lib-lm-del-go"]'), text: __BL.S.ui.root.querySelector('.lib-lm-more.bad')?.innerText || '', count: __BL.S.ui.root.querySelectorAll('.lib-lm').length }));
  check('Delete still asks first, says what would be lost, and deletes nothing until "Delete permanently"', dl.danger && /Deleting cannot be undone/.test(dl.text) && dl.count === 11, dl.text);
  await ui(() => __BL.S.ui.root.querySelector('.lib-lm-more [data-x="lib-lm-cancel"]').click());
  const ids = await ui(() => [...__BL.S.ui.root.querySelectorAll('.lib-lm')].map((e) => e.dataset.id));
  await ui(() => __BL.S.ui.root.querySelectorAll('.lib-lm')[1].querySelector('[data-x="lib-lm-open"]').click());
  await sleep(300);
  check('Opening a list returns to the library with that list, without reordering the manager', !(await vis('.lib-mgr')) && (await vis('.lib-list')) && (await listId()) === ids[1] && JSON.stringify(await ui(async () => { __BL.S.ui.root.querySelector('[data-x="lib-lists"]').click(); await new Promise((r) => setTimeout(r, 200)); return [...__BL.S.ui.root.querySelectorAll('.lib-lm')].map((e) => e.dataset.id); })) === JSON.stringify(ids));
  await click('[data-x="lib-lists-close"]');
  check('Back closes the view and shows the library again with the same list and scroll', (await vis('.lib-list')) && !(await vis('.lib-mgr')) && (await vis('.lib-cfg')));
  await click('[data-x="lib-lists"]'); await sleep(100);
  await ui(() => __BL.S.ui.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true })));
  await sleep(100);
  check('Escape closes Manage lists (not the whole Product Library)', !(await vis('.lib-mgr')) && (await vis('.lib-list')) && (await ui(() => !__BL.S.ui.root.querySelector('[data-m="library"]').hidden)));
  await page.setViewport({ width: 360, height: 640 });
  await sleep(200);
  await click('[data-x="lib-lists"]'); await sleep(200);
  const nv = await ui(() => { const r = __BL.S.ui.root; const sh = r.querySelector('.lib-sheet'); return { h: sh.scrollWidth <= sh.clientWidth + 1, rows: [...r.querySelectorAll('.lib-lm')].every((e) => e.scrollWidth <= e.clientWidth + 1) }; });
  check('At 360 px Manage lists has no horizontal overflow', nv.h && nv.rows, JSON.stringify(nv));
  await shot('12-manage-lists-narrow');
  await click('[data-x="lib-lists-close"]');
  await page.setViewport({ width: 1280, height: 900 });
  check('No page errors (QA fixes)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ Product Mapping (M1): a saved snapshot on a note
console.log('\n# Product Mapping (M1): a saved snapshot on a note is exported, kept on update, and isolated per page (fixtures/css-rules.html)');
{
  const page = await open('css-rules.html', { http: true, realStorage: true });
  const { ui, click, setCss, save, prompt, section, item, reopen, open: isOpen } = tools(page);
  // Synthetic snapshots, built the way the Product Library builds them (library.js, in Node).
  const CSVX = 'Section,SKU,Product Name,Original Price,Sale Price\nFeatured,ACM-100,Acme Alpha Powder,$20.00,$12.00\n';
  const mkLib = (campaign, store) => ({ store, campaign, name: `List ${campaign}`, smp: { v: 1, imports: [LibNode.importCsv(CSVX, { fileName: 'acme.csv' })] }, work: LibNode.emptyWork() });
  const BIG = '9007199254740993';
  const variant = LibNode.normalizeProduct({ id: 1111, handle: 'alpha-powder', title: 'Acme Alpha Powder', featured_image: '//cdn.example.com/a.jpg', options: [{ name: 'Flavor' }], variants: [{ id: BIG, title: 'Blue Raz', sku: 'ACM-100', price: 2000, compare_at_price: null, available: true, option1: 'Blue Raz', options: ['Blue Raz'] }] }, 'https://shop.example.com', 'USD').variants[0];
  const libA = LibNode.decide(LibNode.chooseVariant(mkLib('l-list-a', 'https://shop.example.com'), 'sku:ACM-100', variant), 'sku:ACM-100', 'smp');
  const snapA = LibNode.productMappingSnapshot(libA, 'sku:ACM-100', { now: Date.UTC(2026, 10, 3), card: { selector: '#stack', section: { heading: 'Featured Deals' }, index: 2, count: 3, text: '[Product Name]' } });
  const libB = LibNode.addLocalProduct(mkLib('l-list-b', ''), { name: 'Elsewhere Widget', sku: 'EW-1', regularCents: 999 });
  const snapB = LibNode.productMappingSnapshot(libB.lib, libB.key, { now: Date.UTC(2026, 10, 3) });
  const norm = (s) => s.replace(/\s*---\s*$/, '').trim();
  const stored = () => ui(() => chrome.storage.local.get('blueline:batch').then((r) => r['blueline:batch']));

  // 1. An ordinary note with CSS and no mapping (what every existing note looks like).
  await shiftClick(page, await pointFor(page, '#plain', 'text'));
  await click('[data-x="tool-css"]');
  await setCss('border', '2px solid red');
  await save('Red border here');
  await sleep(600);
  const baseline = norm(section(await prompt(), 1));
  check('Older note: no mapping field and no mapping text in its export', !('productMapping' in (await item(0))) && !/Product mapping/.test(baseline));

  // 2. A note with CSS and a mapping, and a note that is only a mapping (no description, no CSS).
  await shiftClick(page, await pointFor(page, '#stack', 'text'));
  await click('[data-x="tool-css"]');
  await setCss('color', 'green');
  await save('Card with mapping');
  await sleep(600);
  await ui((m) => { __BL.S.batch.items[1].productMapping = m; return __BL.saveBatch(); }, snapA);
  await ui((m) => {
    const c = JSON.parse(JSON.stringify(__BL.S.batch.items[1]));
    c.id = 'maponly'; c.note = ''; c.tweaks = undefined; c.elementEdits = (c.elementEdits || []).map((e) => ({ ...e, tweaks: [] })); c.productMapping = m;
    __BL.S.batch.items.push(c);
    return __BL.saveBatch();
  }, snapB);
  await sleep(600);
  const exp = await prompt();
  check('Export: a mapping block for each mapped note, none for the others', (exp.match(/\*\*Product mapping\*\*/g) || []).length === 2 && /3 items on 1 page/.test(exp), exp.slice(0, 200));
  check('Export: the unmapped note’s section is exactly as before', norm(section(exp, 1)) === baseline);
  const s2 = section(exp, 2);
  check('Export: the CSS note keeps its CSS lines and adds the mapping after them', /color/.test(s2) && s2.indexOf('Product mapping') > s2.indexOf('color') && s2.includes('**Author’s annotations**'), s2.slice(0, 400));
  check('Export: exact variant id, SKU, prices, image, link and the replace instruction', s2.includes(`variant id \`${BIG}\``) && s2.includes('SKU `ACM-100`') && s2.includes('regular $20.00 (approved, SMP price), sale $12.00 (SMP promotional price)') && s2.includes('`https://cdn.example.com/a.jpg`') && s2.includes(`?variant=${BIG}\``) && /Replace this card’s title, image, prices and link/.test(s2), s2);
  check('Export: the saved card (selector, section, position) is reported as given, with no live-verification claim', s2.includes('Card: `#stack`, in section “Featured Deals”, card 2 of 3') && !/live-verified/.test(s2));
  const s3 = section(exp, 3);
  check('Mapping-only note: not "reference only", names the mapping, reports a manual product without Shopify', !/reference only/i.test(s3) && s3.includes('map to product “Elsewhere Widget”') && s3.includes('Shopify: no variant recorded') && !/variant id/.test(s3), s3.slice(0, 500));
  const rows = await ui(() => [...__BL.S.ui.root.querySelectorAll('.list .item')].map((r) => r.textContent));
  check('Notes list: a mapping-only note shows what it does instead of "No description"', rows.length === 3 && /map to product/.test(rows[2]) && !/No description/.test(rows[2]), rows[2]);
  const st1 = await stored();
  check('Stored: the mapping is saved on its notes as plain JSON with the variant id as a string', st1.items[1].productMapping.variant.variantId === BIG && JSON.stringify(st1.items[1].productMapping) === JSON.stringify(snapA) && JSON.stringify(st1.items[2].productMapping) === JSON.stringify(snapB));

  // 3. Reopening and updating keeps the mapping; a mapping-only note can be saved with no text.
  await reopen(2);
  const ph = await ui(() => ({ open: !!__BL.S.pop, note: __BL.S.ui.root.querySelector('.pop-note').value, placeholder: __BL.S.ui.root.querySelector('.pop-note').placeholder }));
  check('Mapping-only note reopens, and its description box does not ask for a description first', ph.open && ph.note === '' && /^Optional/.test(ph.placeholder), JSON.stringify(ph));
  await save();
  const up3 = await item(2);
  check('Mapping-only note saves with no description (the mapping is its content), mapping unchanged', !(await isOpen()) && up3.note === '' && JSON.stringify(up3.productMapping) === JSON.stringify(snapB) && !!up3.updatedAt, JSON.stringify({ open: await isOpen(), note: up3.note }));
  await reopen(1);
  await save('Card with mapping, edited');
  const up2 = await item(1);
  check('Updating the CSS note keeps its mapping and its CSS change', up2.note === 'Card with mapping, edited' && JSON.stringify(up2.productMapping) === JSON.stringify(snapA) && (up2.elementEdits || []).some((e) => (e.tweaks || []).some((t) => t.prop === 'color')), JSON.stringify(up2.productMapping && up2.productMapping.list));
  await reopen(0);
  await save('Red border here, edited');
  check('Updating the unmapped note does not add a mapping and leaves the others as they were', !('productMapping' in (await item(0))) && JSON.stringify((await item(1)).productMapping) === JSON.stringify(snapA));

  // 4. Notes from another website and another page keep their own mappings and never show here.
  await ui((m) => {
    const A = JSON.parse(JSON.stringify(__BL.S.batch.items[0]));
    const make = (id, over) => { const c = JSON.parse(JSON.stringify(A)); c.id = id; c.note = `Note ${id}`; Object.assign(c, over); c.productMapping = m; return c; };
    const here = new URL(location.href);
    const all = JSON.parse(JSON.stringify(__BL.S.all));
    all.items.push(make('perk', { url: 'https://perkenergy.com/', path: '/' }), make('otherpage', { url: `${here.origin}/other.html`, path: '/other.html' }));
    chrome.storage.local.set({ 'blueline:batch': all });
  }, snapB);
  await sleep(500);
  const view = await ui(() => ({ ids: __BL.S.batch.items.map((i) => i.id).length, text: __BL.S.ui.root.querySelector('.list').textContent }));
  const exp2 = await prompt();
  check('Another website’s and another page’s mappings are not listed or exported here', view.ids === 3 && (exp2.match(/\*\*Product mapping\*\*/g) || []).length === 2 && !/Note (perk|otherpage)/.test(exp2 + view.text), JSON.stringify(view));
  await reopen(0);
  await save('Red border here, again');
  const st2 = await stored();
  const byId = Object.fromEntries(st2.items.map((i) => [i.id, i]));
  check('Saving here leaves the mappings stored for other pages and sites byte-for-byte unchanged', JSON.stringify(byId.perk.productMapping) === JSON.stringify(snapB) && JSON.stringify(byId.otherpage.productMapping) === JSON.stringify(snapB) && byId.perk.note === 'Note perk' && st2.items.length === 5, Object.keys(byId).join());

  // 5. Bad data never breaks the report.
  await ui(() => { __BL.S.batch.items[0].productMapping = {}; __BL.S.batch.items[1].productMapping = { product: { key: 'sku:X' } }; });
  let broken = null;
  try { broken = await prompt(); } catch (e) { broken = `THREW ${e.message}`; }
  check('An empty or half-filled mapping never breaks the report, and the empty one adds nothing', typeof broken === 'string' && !broken.startsWith('THREW') && !/undefined|NaN|\[object/.test(broken) && !/Product mapping/.test(norm(section(broken, 1))) && /Product mapping/.test(section(broken, 2)), String(broken).slice(0, 300));
  check('No page errors (Product Mapping)', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ Product card (M2)
console.log('\n# Product Mapping M2: card proposal, parent / child targeting, fingerprint and safe re-validation (fixtures/product-cards.html)');
{
  const cardsPage = () => open('product-cards.html', { http: true, realStorage: true });
  const view = (page) => page.evaluate(() => {
    const r = __BL.S.ui.root; const d = r.querySelector('[data-d="card"]');
    const n = r.querySelector('.cardb[data-k="card"]'); const b = n && n.getBoundingClientRect();
    return { open: d.open, sum: d.querySelector('.card-sum').textContent, text: d.querySelector('.card-body').textContent.replace(/\s+/g, ' ').trim(), btn: [...d.querySelectorAll('button')].map((x) => x.dataset.x + (x.disabled ? '!' : '')), out: b ? { l: b.left, t: b.top, w: b.width, h: b.height, tag: n.querySelector('.hl-tag').textContent, cls: n.className } : null };
  });
  const rectSel = (page, sel) => page.evaluate((sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; }, sel);
  const near = (a, b) => !!a && !!b && ['l', 't', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) <= 1.5);
  const openSection = async (page) => { await page.evaluate(() => { __BL.S.ui.root.querySelector('[data-d="card"]').open = true; }); await sleep(250); };
  const selected = (page) => page.evaluate(() => __BL.toolsApi.getP().els.map((e) => e.textContent.trim().slice(0, 20)));
  const norm = (s) => s.replace(/\s*---\s*$/, '').trim();
  const scene = async (body, ...args) => { const pg = await cardsPage(); try { return await pg.evaluate(body, ...args); } finally { await pg.close(); } };

  // ---- 1. The interaction on a real note: propose, outline, parent / child, confirm, save
  const A = await cardsPage();
  const t1 = tools(A);
  const PRICE = '#rail-feat > article:nth-child(2) .pr > span:first-child';
  const CARD2 = '#rail-feat > article:nth-child(2)';
  await shiftClick(A, await pointFor(A, PRICE, 'text'));
  check('The section is closed and quiet until opened: no card outline on the page', (await view(A)).out === null && !(await view(A)).open);
  await openSection(A);
  let v = await view(A);
  check('Selecting a price inside a card proposes the whole card, names its position and section, and outlines it', /Likely product card/.test(v.text) && /card 2 of 3/.test(v.text) && /Featured/.test(v.text) && v.out && v.out.tag === 'Likely product card' && near(v.out, await rectSel(A, CARD2)), JSON.stringify(v));
  const sel0 = await selected(A);
  check('The author’s own selection (the price) is not replaced by the card', sel0.length === 1 && sel0[0] === '[$Sale]', JSON.stringify(sel0));
  await t1.click('[data-x="card-up"]'); await sleep(120);
  v = await view(A);
  check('Parent: the row of cards is outlined with a warning, and confirming it needs "Confirm anyway"', /holds several cards/.test(v.text) && /Confirm anyway/.test(v.text) && v.out.cls.includes('broad') && near(v.out, await rectSel(A, '#rail-feat')), JSON.stringify(v));
  await t1.click('[data-x="card-up"]'); await sleep(120);
  v = await view(A);
  check('Parent again reaches the whole section, still warned', /holds several cards/.test(v.text) && near(v.out, await rectSel(A, '#feat')));
  await t1.click('[data-x="card-down"]'); await t1.click('[data-x="card-down"]'); await sleep(120);
  v = await view(A);
  check('Child comes back down to the card', /Likely product card/.test(v.text) && !/holds several cards/.test(v.text) && near(v.out, await rectSel(A, CARD2)));
  for (let i = 0; i < 3; i++) await t1.click('[data-x="card-down"]');
  await sleep(120);
  v = await view(A);
  check('Child stops at the element the author selected (the price)', v.btn.includes('card-down!') && near(v.out, await rectSel(A, PRICE)) && (await selected(A)).join() === '[$Sale]', JSON.stringify(v.btn));
  for (let i = 0; i < 3; i++) await t1.click('[data-x="card-up"]');
  await t1.click('[data-x="card-ok"]'); await sleep(150);
  v = await view(A);
  check('Confirming sets the card, shows it as confirmed, and leaves the selection alone', /Confirmed/.test(v.text) && /card 2 of 3/.test(v.text) && /Not saved yet/.test(v.text) && /confirmed/.test(v.sum) && (await selected(A)).join() === '[$Sale]', JSON.stringify(v));
  check('Detected fields are a collapsed disclosure with a count, and no explanatory paragraph', /Detected fields \(\d+\)/.test(v.text) && !/struck-through price/.test(v.text) && !/Parts found in it|nothing is assigned/.test(v.text) && (await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="card-fields"]')?.getAttribute('aria-expanded'))) === 'false');
  await t1.click('[data-x="card-fields"]'); await sleep(100);
  v = await view(A);
  check('Expanded, the parts found can still be shown on the page (by content, none assigned)', /title/.test(v.text) && /struck-through price/.test(v.text) && /image/.test(v.text) && (await A.evaluate(() => __BL.S.ui.root.querySelectorAll('.card-parts [data-x="card-slot"]').length)) >= 3);
  check('The confirmed card carries no "unchanged since it was picked" paragraph, and the check button is "Check card"', !/unchanged since it was picked/.test(v.text) && /Check card/.test(v.text) && !/Check again/.test(v.text));
  await t1.save('Card note');
  const n1 = await t1.item(0);
  const pc = n1.productCard;
  check('Saved on the note as a plain-JSON fingerprint: selector, section, position, count, structure, evidence, parts', !!pc && pc.v === 1 && pc.tag === 'article' && pc.index === 2 && pc.count === 3 && pc.section.heading === 'Featured' && pc.classes.join() === 'pcard' && pc.parent.tag === 'div' && pc.parent.id === 'rail-feat' && !!pc.shape && !!pc.groupHash && pc.evidence === 'positional' && pc.uniqueBy.length === 0 && typeof pc.selector === 'string' && ['image', 'badge', 'title', 'price', 'compare-price', 'cta'].every((r) => pc.slots.some((s) => s.role === r)), JSON.stringify(pc).slice(0, 400));
  check('The fingerprint is compatible with the Product Mapping card slot and round-trips through JSON', pc.selector && pc.section && pc.index === 2 && pc.count === 3 && pc.text.startsWith('[Product shot]') && JSON.stringify(JSON.parse(JSON.stringify(pc))) === JSON.stringify(pc));
  check('The note still points at the price the author selected, not at the card', n1.el.text === '[$Sale]' || /\[\$Sale\]/.test(JSON.stringify(n1.el)), JSON.stringify(n1.el));

  // ---- 2. An element can still be annotated on its own; the card is not forced onto it
  await shiftClick(A, await pointFor(A, '#rail-feat > article:nth-child(3) .nm', 'text'));
  await t1.click('[data-x="tool-css"]');
  await t1.setCss('color', '#cc0000');
  await t1.save('Name colour');
  const n2 = await t1.item(1);
  check('Annotating a title with CSS works as before: the edit is on the title, and no card was attached', !('productCard' in n2) && (n2.elementEdits || []).some((e) => (e.tweaks || []).some((t) => t.prop === 'color')) && /nm/.test(JSON.stringify(n2.el)), JSON.stringify(n2.el));
  const exp1 = await t1.prompt();
  const s1 = t1.section(exp1, 1);
  check('Export: the card note has a Product card block with where it is, its parts and a passing check', s1.includes('**Product card**') && s1.includes('in section “Featured”, card 2 of 3') && !/Parts found/.test(s1) && s1.includes('Card check: confirmed on the page'), s1.slice(0, 900));
  check('Export: the CSS note keeps its CSS lines and has no card block', /color/.test(t1.section(exp1, 2)) && !t1.section(exp1, 2).includes('Product card'));

  // ---- 3. Which element is proposed, in different markup
  const prop = (sel) => A.evaluate((sel) => {
    const C = BluelineCards; const p = C.propose(document.querySelector(sel)); const at = p.chain[p.at]; const g = at && C.group(at);
    return { at: p.at, confidence: p.confidence, tag: at ? at.tagName.toLowerCase() : null, cls: at ? String(at.className) : null, index: g ? g.index : null, count: g ? g.count : null };
  }, sel);
  const pr = {
    cta: await prop('#rail-feat > article:nth-child(1) .go'), badge: await prop('#rail-feat > article:nth-child(3) .bdg'), image: await prop('#rail-feat > article:nth-child(2) .pic'),
    pick: await prop('#rail-picks > article:nth-child(5) .nm'), tile: await prop('#tiles > li:nth-child(2) h3'), opt: await prop('#tiles > li:nth-child(2) .opts li:nth-child(1)'),
    add: await prop('#tiles > li:nth-child(3) .add'), div: await prop('#row-div > div:nth-child(2) .x3'), expl: await prop('#row-explicit > div:nth-child(2) [data-blueline-product-field="title"]'),
    lone: await prop('#lone-card .nm'), nav: await prop('nav .links li:nth-child(2) a'), h2: await prop('#feat > h2'),
  };
  check('From a button, a badge or the image area the surrounding <article> is proposed', [pr.cta, pr.badge, pr.image].every((x) => x.tag === 'article' && x.confidence === 'structure') && pr.cta.index === 1 && pr.badge.index === 3 && pr.image.index === 2 && pr.pick.index === 5 && pr.pick.count === 6, JSON.stringify([pr.cta, pr.badge, pr.image, pr.pick]));
  check('Without <article>: list items and plain divs with arbitrary classes are proposed too', pr.tile.tag === 'li' && pr.tile.cls === 'tile' && pr.tile.index === 2 && pr.tile.count === 3 && pr.add.tag === 'li' && pr.div.tag === 'div' && pr.div.cls === 'x1' && pr.div.index === 2 && pr.div.count === 2, JSON.stringify([pr.tile, pr.add, pr.div]));
  check('A repeated row inside a card (option rows with prices) is not mistaken for the card', pr.opt.tag === 'li' && pr.opt.cls === 'tile', JSON.stringify(pr.opt));
  check('Explicit Blueline attributes name the card outright', pr.expl.confidence === 'explicit' && pr.expl.tag === 'div' && pr.expl.index === 2 && pr.expl.count === 2, JSON.stringify(pr.expl));
  check('A card with nothing similar beside it is offered as a weaker "possible" card', pr.lone.confidence === 'single' && pr.lone.cls === 'lonecard', JSON.stringify(pr.lone));
  check('Repeated non-product elements (a nav list) and headings are not proposed as cards', pr.nav.at === -1 && pr.h2.at === -1, JSON.stringify([pr.nav, pr.h2]));

  // ---- 4. What can honestly be claimed after the page changes (each in a fresh page)
  const S = {
    same: await scene(() => { const C = BluelineCards; const el = document.querySelectorAll('#rail-feat > article')[1]; const fp = C.describe(el); const r = C.evaluate(fp); return { st: r.state, basis: r.basis, ev: fp.evidence, el: r.el === el }; }),
    insert: await scene(() => {
      const C = BluelineCards; const rail = document.getElementById('rail-picks'); const el = rail.children[3]; const fp = C.describe(el);
      rail.insertBefore(rail.children[0].cloneNode(true), rail.children[0]);
      const r = C.evaluate(fp);
      return { st: r.state, n: r.candidates.length, el: r.el ? 'set' : null, old: document.querySelector(fp.selector) === el, why: r.reasons.join('; ') };
    }),
    swap: await scene(() => { const C = BluelineCards; const rail = document.getElementById('rail-picks'); const fp = C.describe(rail.children[0]); rail.insertBefore(rail.children[1], rail.children[0]); const r = C.evaluate(fp); return { st: r.state, el: r.el ? 'set' : null }; }),
    tileInsert: await scene(() => {
      const C = BluelineCards; const ul = document.getElementById('tiles'); const beta = ul.children[1]; const fp = C.describe(beta);
      const t = ul.children[0].cloneNode(true); t.querySelector('h3').textContent = 'Delta Gel'; ul.insertBefore(t, ul.children[0]);
      const r = C.evaluate(fp);
      return { st: r.state, ev: fp.evidence, found: r.el === beta, idx: [...ul.children].indexOf(r.el), old: document.querySelector(fp.selector) === beta, oldName: document.querySelector(fp.selector)?.querySelector('h3')?.textContent, why: r.reasons.join('; ') };
    }),
    tileRemove: await scene(() => { const C = BluelineCards; const ul = document.getElementById('tiles'); const fp = C.describe(ul.children[1]); ul.children[1].remove(); const r = C.evaluate(fp); return { st: r.state, el: r.el ? 'set' : null }; }),
    tileRename: await scene(() => { const C = BluelineCards; const ul = document.getElementById('tiles'); const el = ul.children[1]; const fp = C.describe(el); el.querySelector('h3').textContent = 'Beta Renamed'; const r = C.evaluate(fp); return { st: r.state, same: r.el === el, basis: r.basis, why: r.reasons.join('; ') }; }),
    tileSwap: await scene(() => { const C = BluelineCards; const ul = document.getElementById('tiles'); const beta = ul.children[1]; const fp = C.describe(beta); ul.insertBefore(beta, ul.children[0]); const r = C.evaluate(fp); return { st: r.state, found: r.el === beta, idx: [...ul.children].indexOf(r.el), old: document.querySelector(fp.selector) === beta }; }),
    hidden: await scene(() => {
      const C = BluelineCards; const rail = document.getElementById('rail-picks'); const el = rail.children[1]; const fp = C.describe(el);
      document.querySelector('[data-filter="A"]').click(); const r1 = C.evaluate(fp);
      document.querySelector('[data-filter="All"]').click(); const r2 = C.evaluate(fp);
      return { hiddenSt: r1.state, hiddenEl: r1.el === el, hiddenBasis: r1.basis, backSt: r2.state, hasHiddenAttr: 'hidden' in fp.attrs };
    }),
    explicitMove: await scene(() => {
      const C = BluelineCards; const row = document.getElementById('row-explicit'); const b = row.children[1]; const fp = C.describe(b);
      row.insertBefore(b, row.children[0]); const r1 = C.evaluate(fp);
      const dup = row.children[0].cloneNode(true); row.appendChild(dup); const r2 = C.evaluate(fp);
      return { st: r1.state, basis: r1.basis, el: r1.el === b, ex: fp.explicit && fp.explicit.value, ev: fp.evidence, dupSt: r2.state, dupN: r2.candidates.length };
    }),
    heading: await scene(() => { const C = BluelineCards; const fp = C.describe(document.querySelectorAll('#rail-feat > article')[1]); document.getElementById('h-feat').textContent = 'Hero deals'; const r = C.evaluate(fp); return { st: r.state, why: r.reasons.join('; ') }; }),
    rerender: await scene(() => { const C = BluelineCards; const rail = document.getElementById('rail-feat'); const old = rail.children[1]; const fp = C.describe(old); rail.innerHTML = rail.innerHTML; const r = C.evaluate(fp); return { st: r.state, fresh: r.el !== old && !!r.el && r.el.isConnected }; }),
    late: await scene(() => {
      const C = BluelineCards;
      document.body.insertAdjacentHTML('beforeend', '<section aria-labelledby="h-late"><h2 id="h-late">Late</h2><div class="rail" id="rail-late"><article class="pcard"><div class="pic">[Product shot]</div><div class="nm">One</div><span>$1.00</span> <a class="go" href="#">Shop</a></article><article class="pcard"><div class="pic">[Product shot]</div><div class="nm">Two</div><span>$2.00</span> <a class="go" href="#">Shop</a></article></div></section>');
      const el = document.querySelector('#rail-late > article:nth-child(2) span'); const p = C.propose(el); const card = p.chain[p.at]; const fp = C.describe(card); const r = C.evaluate(fp);
      return { ok: card && card.parentElement.id === 'rail-late', sec: fp.section.heading, idx: [fp.index, fp.count], st: r.state };
    }),
    lone: await scene(() => {
      const C = BluelineCards; const el = document.getElementById('lone-card'); const fp = C.describe(el); const r0 = C.evaluate(fp);
      const w = document.createElement('div'); el.parentNode.insertBefore(w, el); w.appendChild(el); const r1 = C.evaluate(fp);
      return { st0: r0.state, st1: r1.state, found: r1.el === el, basis: r1.basis, count: fp.count };
    }),
    legacy: await scene(() => { const C = BluelineCards; const legacy = { selector: '#feat', section: 'Featured', index: 1, count: 3, text: 'x' }; const r = C.evaluate(legacy); return { st: r.state, lines: C.reportLines(legacy, r).length }; }),
  };
  check('Unchanged page: the card is confirmed ("the cards around it are unchanged"), and identical cards give positional evidence only', S.same.st === 'confirmed' && S.same.basis === 'unchanged-structure' && S.same.ev === 'positional' && S.same.el, JSON.stringify(S.same));
  check('A card inserted among identical cards: NOT confirmed. The old selector now hits a different card, and Blueline refuses to pick one', S.insert.st === 'ambiguous' && S.insert.el === null && S.insert.n === 7 && S.insert.old === false && /number of comparable cards changed \(6 → 7\)/.test(S.insert.why), JSON.stringify(S.insert));
  check('Reordered identical cards are not confirmed either', S.swap.st === 'ambiguous' && S.swap.el === null, JSON.stringify(S.swap));
  check('Cards with unique names: after an insert the card is found by its content, suggested (needs confirmation), not applied', S.tileInsert.st === 'changed' && S.tileInsert.ev === 'unique-content' && S.tileInsert.found && S.tileInsert.idx === 2 && S.tileInsert.old === false && S.tileInsert.oldName === 'Alpha Powder' && /found by its text/.test(S.tileInsert.why), JSON.stringify(S.tileInsert));
  check('A card that was removed is not found', S.tileRemove.st === 'not-found' && S.tileRemove.el === null, JSON.stringify(S.tileRemove));
  check('A card edited in place (same spot, new text, nobody else has the old text) is suggested for confirmation, not confirmed and not lost', S.tileRename.st === 'changed' && S.tileRename.same && S.tileRename.basis === 'edited-in-place' && /edited/.test(S.tileRename.why), JSON.stringify(S.tileRename));
  check('Two uniquely named cards that swap places: the card is found where its content moved, and the old position is not trusted', S.tileSwap.st === 'changed' && S.tileSwap.found && S.tileSwap.idx === 0 && S.tileSwap.old === false, JSON.stringify(S.tileSwap));
  check('A card hidden by a filter is reported hidden (identity intact), and confirmed again when shown; hiding is not part of its identity', S.hidden.hiddenSt === 'hidden' && S.hidden.hiddenEl && S.hidden.backSt === 'confirmed' && !S.hidden.hasHiddenAttr, JSON.stringify(S.hidden));
  check('An explicit Blueline identifier follows the card wherever it moves; a duplicated identifier is ambiguous', S.explicitMove.st === 'confirmed' && S.explicitMove.basis === 'explicit-id' && S.explicitMove.el && S.explicitMove.ex === 'slot-b' && S.explicitMove.ev === 'explicit' && S.explicitMove.dupSt === 'ambiguous' && S.explicitMove.dupN === 2, JSON.stringify(S.explicitMove));
  check('A changed section heading stops identical cards from being confirmed', S.heading.st === 'ambiguous' && /section heading changed/.test(S.heading.why), JSON.stringify(S.heading));
  check('Re-rendered cards (same markup, new elements) are confirmed on their new elements, not bound to the old ones', S.rerender.st === 'confirmed' && S.rerender.fresh, JSON.stringify(S.rerender));
  check('Cards that appear after load can be proposed, fingerprinted and checked like any other', S.late.ok && S.late.sec === 'Late' && S.late.idx.join() === '2,2' && S.late.st === 'confirmed', JSON.stringify(S.late));
  check('A card with no siblings: confirmed while nothing moves; if it is wrapped (selector breaks) it is suggested, not assumed', S.lone.st0 === 'confirmed' && S.lone.st1 === 'changed' && S.lone.found && S.lone.basis === 'only-candidate' && S.lone.count === 1, JSON.stringify(S.lone));
  check('A saved card without identity details (the older M1 shape) is not checked and adds nothing to the report', S.legacy.st === 'unchecked' && S.legacy.lines === 0, JSON.stringify(S.legacy));

  // ---- 5. Reattachment through the UI: nothing changes until the author confirms
  const B = await cardsPage();
  const tb = tools(B);
  await shiftClick(B, await pointFor(B, '#tiles > li:nth-child(2) .price', 'text'));
  await openSection(B);
  v = await view(B);
  check('Unique-name tiles: the tile around a selected price is proposed', /Likely product card/.test(v.text) && /card 2 of 3/.test(v.text) && v.out && near(v.out, await rectSel(B, '#tiles > li:nth-child(2)')), JSON.stringify(v));
  await tb.click('[data-x="card-ok"]'); await sleep(100);
  await tb.save('Beta tile note');
  const savedBefore = (await tb.item(0)).productCard;
  check('Saved with unique-content evidence', savedBefore.evidence === 'unique-content' && savedBefore.uniqueBy.includes('text') && savedBefore.index === 2, JSON.stringify(savedBefore.uniqueBy));
  await B.evaluate(() => { const ul = document.getElementById('tiles'); const t = ul.children[0].cloneNode(true); t.querySelector('h3').textContent = 'Delta Gel'; ul.insertBefore(t, ul.children[0]); });
  await tb.reopen(0);
  await openSection(B);
  v = await view(B);
  check('Reopened after a tile was inserted: "Needs confirmation", never "Confirmed", and the suggested card is outlined', /Needs confirmation/.test(v.text) && !/Confirmed/.test(v.text) && v.out && v.out.tag === 'Suggested card (confirm it)' && near(v.out, await rectSel(B, '#tiles > li:nth-child(3)')), JSON.stringify(v));
  const hazard = await B.evaluate((sel) => document.querySelector(sel)?.querySelector('h3')?.textContent, savedBefore.selector);
  check('The saved selector now resolves to another card, which is exactly why it is not trusted', hazard === 'Alpha Powder', hazard);
  const expBad = await tb.prompt();
  check('Export: an unconfirmed card is flagged "not confirmed" and must be located from the details, not the selector', /\*\*not confirmed:\*\*/.test(expBad) && /selector may point at a different card/.test(expBad), expBad.slice(0, 700));
  await tb.save('Beta tile note (edited)');
  check('Updating the note without touching the card leaves the saved fingerprint byte-for-byte as it was', JSON.stringify((await tb.item(0)).productCard) === JSON.stringify(savedBefore));
  await tb.reopen(0); await openSection(B);
  await tb.click('[data-x="card-cands"]'); await sleep(120);
  v = await view(B);
  check('"Choose from the cards found" lists candidates, the suggestion first, with a highlight', /Candidate 1 of /.test(v.text) && near(v.out, await rectSel(B, '#tiles > li:nth-child(3)')) && v.btn.includes('card-ok'), JSON.stringify(v));
  await tb.click('[data-x="card-next"]'); await sleep(100);
  v = await view(B);
  check('Stepping to another candidate moves the highlight and still changes nothing', /Candidate 2 of /.test(v.text) && (await B.evaluate(() => __BL.toolsApi.getP().card.index)) === 2);
  await tb.click('[data-x="card-cancel"]'); await sleep(80);
  await tb.save();
  check('Cancel, then Update: the saved card is untouched', JSON.stringify((await tb.item(0)).productCard) === JSON.stringify(savedBefore));
  await tb.reopen(0); await openSection(B);
  await tb.click('[data-x="card-cands"]'); await tb.click('[data-x="card-ok"]'); await sleep(150);
  v = await view(B);
  check('Choosing the card explicitly confirms it (not saved until Update)', /Confirmed/.test(v.text) && /Not saved yet/.test(v.text), JSON.stringify(v));
  await tb.save();
  const after = (await tb.item(0)).productCard;
  check('After Update the note holds the re-confirmed card at its new position', after.index === 3 && after.count === 4 && after.section.heading === 'Tiles' && after.selector !== savedBefore.selector, JSON.stringify({ i: after.index, n: after.count, a: after.selector, b: savedBefore.selector }));
  const expOk = await tb.prompt();
  check('Export: the re-confirmed card checks out', /Card check: confirmed on the page/.test(expOk) && !/not confirmed/.test(expOk));
  check('No page errors (card flows)', B.errors.length === 0 && A.errors.length === 0, [...A.errors, ...B.errors].join(' | '));
  await B.close();

  // ---- 6. Identical cards, a Product Mapping on the note, isolation
  const D = await cardsPage();
  const td = tools(D);
  await shiftClick(D, await pointFor(D, '#rail-feat > article:nth-child(2) .nm', 'text'));
  await openSection(D);
  await td.click('[data-x="card-ok"]'); await sleep(100);
  await td.save('Middle card');
  const mid = (await td.item(0)).productCard;
  await D.evaluate(() => { const rail = document.getElementById('rail-feat'); rail.insertBefore(rail.children[0].cloneNode(true), rail.children[0]); });
  await td.reopen(0); await openSection(D);
  v = await view(D);
  check('Identical cards after an insert: "Can’t tell which card", nothing outlined as the card, nothing chosen', /Can’t tell which card/.test(v.text) && v.out === null && /look alike/.test(v.text), JSON.stringify(v));
  await td.click('[data-x="card-cands"]'); await sleep(100);
  await td.click('[data-x="card-next"]'); await td.click('[data-x="card-next"]'); await sleep(100);
  v = await view(D);
  check('Every comparable card is a candidate (4), outlined as it is stepped to', /Candidate 3 of 4/.test(v.text) && near(v.out, await rectSel(D, '#rail-feat > article:nth-child(3)')), JSON.stringify(v));
  await td.click('[data-x="card-ok"]'); await td.save();
  const chosen = (await td.item(0)).productCard;
  check('The author’s choice is saved, and the selector points at the card they chose', chosen.index === 3 && chosen.count === 4 && (await D.evaluate((s) => document.querySelector(s) === document.querySelectorAll('#rail-feat > article')[2], chosen.selector)), JSON.stringify({ i: chosen.index, was: mid.index }));

  // a Product Mapping on the note: the card lives in productMapping.card
  const libX = LibNode.addLocalProduct({ store: '', campaign: 'l-x', name: 'X', smp: { v: 1, imports: [] }, work: LibNode.emptyWork() }, { name: 'Card Widget', sku: 'CW-1', regularCents: 1999 });
  const snapX = LibNode.productMappingSnapshot(libX.lib, libX.key, { now: Date.UTC(2026, 10, 3) });
  await shiftClick(D, await pointFor(D, '#tiles > li:nth-child(1) .price', 'text'));
  await td.save('Mapped tile'); await sleep(300);
  await D.evaluate((m) => { const it = __BL.S.batch.items[__BL.S.batch.items.length - 1]; it.productMapping = m; return __BL.saveBatch(); }, snapX);
  await sleep(400);
  const mi = (await D.evaluate(() => __BL.S.batch.items.length)) - 1;
  await td.reopen(mi); await openSection(D);
  await td.click('[data-x="card-ok"]'); await sleep(100);
  await td.save();
  const mapped = await td.item(mi);
  const { card: mcard, ...mrest } = mapped.productMapping;
  const { card: _c, ...xrest } = snapX;
  check('With a Product Mapping the card is saved inside it (productMapping.card) and the rest of the mapping is unchanged; no separate productCard', mcard && mcard.v === 1 && mcard.index === 1 && mcard.count === 3 && !('productCard' in mapped) && JSON.stringify(mrest) === JSON.stringify(xrest), JSON.stringify(mcard && { i: mcard.index, n: mcard.count }));
  const expM = await td.prompt();
  const sm = td.section(expM, mi + 1);
  check('Export: the mapping block carries the card line and one card check, and no second Product card block', sm.includes('**Product mapping**') && /Card: `[^`]+`, in section “Tiles”, card 1 of 3/.test(sm) && /Card check: confirmed/.test(sm) && !sm.includes('**Product card**'), sm.slice(0, 900));

  // other pages and sites keep their own cards
  await D.evaluate((c) => {
    const A0 = JSON.parse(JSON.stringify(__BL.S.batch.items[0]));
    const make = (id, over) => { const x = JSON.parse(JSON.stringify(A0)); x.id = id; x.note = `Note ${id}`; Object.assign(x, over); x.productCard = c; return x; };
    const here = new URL(location.href);
    const all = JSON.parse(JSON.stringify(__BL.S.all));
    all.items.push(make('otherpage', { url: `${here.origin}/other.html`, path: '/other.html' }), make('othersite', { url: 'https://example.org/', path: '/' }));
    chrome.storage.local.set({ 'blueline:batch': all });
  }, mid);
  await sleep(500);
  const expI = await td.prompt();
  check('Cards saved for another page or site are not shown or exported here', !/Note (otherpage|othersite)/.test(expI) && (expI.match(/\*\*Product card\*\*/g) || []).length === 1, (expI.match(/\*\*Product card\*\*/g) || []).length);
  await td.reopen(0); await td.save();
  const allI = await D.evaluate(() => chrome.storage.local.get('blueline:batch').then((r) => r['blueline:batch']));
  const byId = Object.fromEntries(allI.items.map((i) => [i.id, i]));
  check('Saving here leaves the cards stored for other pages and sites byte-for-byte unchanged', JSON.stringify(byId.otherpage.productCard) === JSON.stringify(mid) && JSON.stringify(byId.othersite.productCard) === JSON.stringify(mid));

  // a card can be cleared, and the note stays
  await td.reopen(0); await openSection(D);
  await td.click('[data-x="card-clear"]'); await sleep(80);
  await td.save();
  check('Clearing the card removes it from the note and nothing else', !('productCard' in (await td.item(0))) && (await td.item(0)).note.length > 0);
  check('No page errors (identical cards, mapping, isolation)', D.errors.length === 0, D.errors.join(' | '));
  await D.close();
  await A.close();
}

// ------------------------------------------------------------------ Product Mapping M3: picker, values, saved mappings, report, QA fixes
console.log('\n# Product Mapping M3: product picker, variants, page-specific values, saved mappings and the M2 selection fix (fixtures/product-cards.html)');
{
  const cardsPage = () => open('product-cards.html', { http: true, realStorage: true });
  const norm3 = (s) => s.replace(/\s*---\s*$/, '').trim();
  const CSV3 = 'Section,SKU,Product Name,Original Price,Sale Price\nFeatured,ACM400101,Acme ZMA Capsules,$27.97,$19.99\nFeatured,ACM999001,Acme Fish Oil Softgels,$30.97,\nFeatured,GEN-1,Generic Gamma,$9.00,\nFeatured,ACM200101,Acme Charcoal,$15.99,\n';
  const A = await cardsPage();
  const ORIGIN3 = await A.evaluate(() => location.origin);
  const vOf = (handle, i = 0) => LibNode.normalizeProduct(PRODUCTS.find((p) => p.handle === handle), ORIGIN3, 'USD').variants[i];
  let libA = { store: ORIGIN3, campaign: 'l-m3-a', name: 'M3 list A', smp: { v: 1, imports: [LibNode.importCsv(CSV3, { fileName: 'm3.csv', sha256: 'm3a' })] }, work: LibNode.emptyWork() };
  libA = LibNode.decide(LibNode.chooseVariant(libA, 'sku:ACM400101', vOf('zma', 0)), 'sku:ACM400101', 'smp');
  libA = LibNode.decide(LibNode.chooseVariant(libA, 'sku:ACM999001', vOf('fish-oil', 0)), 'sku:ACM999001', 'smp');
  libA = LibNode.decide(LibNode.chooseVariant(libA, 'sku:ACM200101', vOf('charcoal', 0)), 'sku:ACM200101', 'smp');
  const local = LibNode.addLocalProduct(libA, { name: 'Local Widget', sku: 'LW-1', regularCents: 500 });
  libA = local.lib;
  const libB = { store: '', campaign: 'l-m3-b', name: 'M3 list B', smp: { v: 1, imports: [LibNode.importCsv('SKU,Name,Price\nB-1,Elsewhere Widget,$5.00\n', { fileName: 'b.csv', sha256: 'm3b' })] }, work: LibNode.emptyWork() };
  const seed = (lib) => A.evaluate((lib) => BluelineLibrary.saveLibrary(chrome.storage.local, lib, { smpChanged: true }), lib);
  await seed(libA); await seed(libB);
  const libRaw = () => A.evaluate(() => chrome.storage.local.get().then((r) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => /^blueline:lib:(smp|work):/.test(k)).sort()))));
  const libBefore = await libRaw();
  const t = tools(A);
  const body = () => A.evaluate(() => __BL.S.ui.root.querySelector('[data-d="card"] .card-body').textContent.replace(/\s+/g, ' ').trim());
  const clk = (x, extra = '') => t.click(`[data-x="${x}"]${extra}`);
  const openCard = async () => { await A.evaluate(() => { __BL.S.ui.root.querySelector('[data-d="card"]').open = true; }); await sleep(250); };
  const esc = async () => { await A.keyboard.press('Escape'); await sleep(100); };
  // the Product Library window in selection mode
  const modal = () => A.evaluate(() => { const r = __BL.S.ui.root; const sheet = r.querySelector('.lib-sheet'); const sh = sheet.getBoundingClientRect(); const foot = r.querySelector('.lib-sel-foot').getBoundingClientRect(); return { open: !r.querySelector('[data-m="library"]').hidden && sheet.classList.contains('lib-smode'), head: r.querySelector('.lib-head').textContent.trim(), h: r.querySelector('.lib-sel-h').textContent.trim(), text: r.querySelector('.lib-sel-body').textContent.replace(/\s+/g, ' ').trim(), foot: r.querySelector('.lib-sel-foot').textContent.replace(/\s+/g, ' ').trim(), footVisible: foot.height > 0 && foot.bottom <= innerHeight + 1 && foot.top >= 0 && foot.bottom <= sh.bottom + 1, rows: r.querySelectorAll('.lib-sel-row').length, lists: [...r.querySelectorAll('[data-lib="sel-list"] option')].map((o) => o.textContent) }; });
  const selQ = (v) => A.evaluate((v) => { const i = __BL.S.ui.root.querySelector('[data-lib="sel-q"]'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  const selPick = (key) => A.evaluate((key) => { __BL.S.ui.root.querySelector(`.lib-sel-row[data-key="${key}"]`).click(); }, key).then(() => sleep(600));
  const selList = (v) => A.evaluate((v) => { const s = __BL.S.ui.root.querySelector('[data-lib="sel-list"]'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }, v).then(() => sleep(300));
  const selUse = async () => { await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-sel-use"]').click()); await sleep(300); };
  const selVar = (id) => A.evaluate((id) => { const i = __BL.S.ui.root.querySelector(`input[data-lib="sel-v"][value="${id}"]`); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); }, id).then(() => sleep(200));
  const els = () => A.evaluate(() => __BL.toolsApi.getP().els.length);
  const NAME2 = '#rail-feat > article:nth-child(2) .nm';
  const NAME1 = '#rail-feat > article:nth-child(1) .nm';

  // ---- 1. M2 QA fix: confirming a card keeps the author's own element, and Esc no longer clears it
  await shiftClick(A, await pointFor(A, NAME1, 'text'));
  await openCard();
  await esc();
  check('Esc with a card proposal open dismisses only the proposal: the selection stays', (await els()) === 1 && !/Confirm card/.test(await body()) && await A.evaluate(() => !!__BL.S.pop), await body());
  await clk('card-start'); await clk('card-ok'); await sleep(120);
  await esc(); await esc();
  check('After confirming a card, Esc never clears the original element (the lost-selection bug)', (await els()) === 1 && /Confirmed/.test(await body()));
  await t.save('Card keeps its element');
  const n0 = await t.item(0);
  check('Save works straight after confirming the card: no "Nothing is selected", note keeps its element and card', n0.note === 'Card keeps its element' && /nm/.test(JSON.stringify(n0.el)) && n0.productCard?.index === 1, JSON.stringify(n0.el));
  // The same thing with a mapping-only note (no description) is covered in section 3.

  // ---- 2. Proposal prefers the whole card
  const prop = (sel) => A.evaluate((sel) => { const C = BluelineCards; const p = C.propose(document.querySelector(sel)); const at = p.chain[p.at]; const g = at && C.group(at); return { tag: at?.tagName.toLowerCase(), cls: at && String(at.className), index: g?.index, count: g?.count, broad: p.broad[p.at] }; }, sel);
  const dual = await prop('#rail-dual > article:nth-child(2) .dpart:first-of-type .nm');
  const dual2 = await prop('#rail-dual > article:nth-child(3) .dpart:last-of-type a');
  check('A card whose lower area is a pair of product-like parts: the whole <article> is proposed, not the lower part', dual.tag === 'article' && dual.index === 2 && dual.count === 3 && !dual.broad && dual2.tag === 'article' && dual2.index === 3, JSON.stringify([dual, dual2]));
  const rowP = await A.evaluate(() => { const C = BluelineCards; const p = C.propose(document.querySelector('#rail-dual > article:nth-child(1) .nm')); return p.chain.map((e, i) => [e.tagName.toLowerCase() + (e.id ? '#' + e.id : ''), p.broad[i]]).filter((x) => x[1]).map((x) => x[0]); });
  check('The row of cards and the section are still marked broad (not proposed as the card)', rowP.includes('div#rail-dual') && rowP.includes('section#dual'), JSON.stringify(rowP));

  // ---- 3. Choose Product opens the Product Mapping window, which opens the Product Library picker; the note stays open underneath
  // the Product Mapping window (the one place a mapping is changed, approved and saved)
  const mdl = () => A.evaluate(() => { const r = __BL.S.ui.root; const sheet = r.querySelector('.lib-sheet'); const m = __BL.libraryUi.L.map; const save = r.querySelector('[data-x="lib-map-save"]'); return { open: !!m && !r.querySelector('[data-m="library"]').hidden && sheet.classList.contains('lib-pmode') && !sheet.classList.contains('lib-smode'), head: r.querySelector('.lib-head').textContent.trim(), text: r.querySelector('.lib-map-body').textContent.replace(/\s+/g, ' ').trim(), foot: r.querySelector('.lib-map-foot').textContent.replace(/\s+/g, ' ').trim(), cta: save ? save.textContent.trim() : null, ctaOff: save ? save.disabled : null, ctaBg: save ? getComputedStyle(save).backgroundColor : null, draft: m && m.draft ? JSON.parse(JSON.stringify(m.draft)) : null, btns: [...r.querySelectorAll('.lib-map-act .xb')].map((b) => b.textContent.trim()).join('|'), badges: [...r.querySelectorAll('.lib-map-st > span')].map((d) => d.textContent.replace(/\s+/g, ' ').trim()).join(' / '), footVisible: !!save && save.getBoundingClientRect().height > 0 && save.getBoundingClientRect().bottom <= innerHeight + 1 }; });
  const mc = (x) => A.evaluate((x) => { __BL.S.ui.root.querySelector(`[data-x="${x}"]`).click(); }, x).then(() => sleep(350));
  const mSet = async (f, v) => { await A.evaluate((f, v) => { const i = __BL.S.ui.root.querySelector(`.lib-map-body input[data-lib="map-f"][data-f="${f}"]`); i.value = v; i.dispatchEvent(new Event('change', { bubbles: true })); }, f, v); await sleep(80); };
  const mSave = async () => { await mc('lib-map-save'); await sleep(500); };
  const mRes = async (f, v) => { await A.evaluate((f, v) => { const i = __BL.S.ui.root.querySelector(`input[data-lib="map-res"][data-f="${f}"][value="${v}"]`); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); }, f, v); await sleep(150); };
  const mapStored = (i) => t.item(i).then((x) => x.productMapping);
  await shiftClick(A, await pointFor(A, NAME2, 'text'));
  await openCard();
  await clk('card-ok'); await sleep(120);
  const top = await A.evaluate(() => { const f = __BL.S.ui.root.querySelector('[data-d="card"] .card-body').firstElementChild; const b = f.querySelector('[data-x="map-start"]'); return { first: f.className, text: b?.textContent.trim(), disabled: b?.disabled, bg: b ? getComputedStyle(b).backgroundColor : '', sum: __BL.S.ui.root.querySelector('[data-d="card"] summary').textContent.trim() }; });
  check('The section is named Product Mapping; "Choose Product" is its first control, prominent (blue), with no ellipsis; the Library is untouched', top.first === 'map-sec' && top.text === 'Choose Product' && !top.disabled && top.bg === 'rgb(43, 78, 255)' && /^Product Mapping/.test(top.sum) && !/Product card/.test(top.sum) && (await libRaw()) === libBefore, JSON.stringify(top));
  await clk('map-start'); await sleep(600);
  let md = await modal();
  check('It opens the Product Mapping window, which goes straight to the Product Library picker (title unchanged), with the note still open underneath', md.open && md.head === 'Product Library' && md.h === 'Choose a product' && await A.evaluate(() => !!__BL.S.pop && !!__BL.toolsApi.getP().card && !!__BL.libraryUi.L.map), JSON.stringify(md));
  check('The window lists every saved list and the products of the chosen one (no Shopify call is needed)', md.lists.length === 2 && md.lists.some((x) => /M3 list A/.test(x)) && md.lists.some((x) => /M3 list B/.test(x)) && md.rows === 5 && /Cancel/.test(md.foot), JSON.stringify(md));
  await selQ('zma');
  const found = await A.evaluate(() => [...__BL.S.ui.root.querySelectorAll('.lib-sel-row')].map((b) => b.textContent));
  await selQ('ACM999001');
  const bySku = await A.evaluate(() => [...__BL.S.ui.root.querySelectorAll('.lib-sel-row')].map((b) => b.textContent));
  check('Search finds a product by name or by SKU', found.length === 1 && /ZMA/.test(found[0]) && bySku.length === 1 && /Fish Oil/.test(bySku[0]), JSON.stringify([found, bySku]));
  await selQ('zma');
  await selPick('sku:ACM400101');
  md = await modal();
  check('The selected product is presented with its image, SKU, exact variant id, prices and approval, and the confirming button is visible without scrolling', /ACM400101/.test(md.text) && md.text.includes('4444444444') && /\$27\.97/.test(md.text) && /Approved/.test(md.text) && /Use this product/.test(md.foot) && md.footVisible && await A.evaluate(() => !!__BL.S.ui.root.querySelector('.lib-sel-prod img')), JSON.stringify(md));
  check('More than one Shopify variant: each is listed with its options, SKU, price and id, the list’s own is marked', md.text.includes('120 ct') && md.text.includes('240 ct') && md.text.includes('4444444445') && /\$49\.97/.test(md.text) && /List’s variant/.test(md.text) && !/Only one variant/.test(md.text), md.text);
  check('Nothing in the Library changed while looking', (await libRaw()) === libBefore);
  await esc();
  md = await modal();
  check('Esc steps back from a product to the list of products', md.open && md.h === 'Choose a product');
  await esc();
  let mm0 = await mdl();
  check('A second Esc closes the picker and returns to the Product Mapping window (nothing chosen, Map & Save waiting)', mm0.open && /No product is mapped to this card yet/.test(mm0.text) && mm0.cta === 'Map & Save' && mm0.ctaOff === true && mm0.head === 'Product Mapping', JSON.stringify(mm0));
  await esc();
  check('A third Esc closes the window: the note (and its card) is open and unchanged, with no mapping', !(await mdl()).open && !(await modal()).open && await A.evaluate(() => !!__BL.S.pop && !__BL.toolsApi.getP().mapping && !!__BL.toolsApi.getP().card));
  await clk('map-start'); await sleep(500);
  await selQ('zma'); await selPick('sku:ACM400101');
  await selUse();
  mm0 = await mdl();
  check('Choosing a product returns to the Product Mapping window with it proposed: Approval, Shopify and Saved are three separate facts; it is not saved and not called Verified', mm0.open && /Acme ZMA Capsules/.test(mm0.text) && /Product approved/.test(mm0.badges) && /Not checked yet/.test(mm0.badges) && /Not saved yet/.test(mm0.badges) && !/Verified/.test(mm0.text + mm0.badges), mm0.badges);
  check('The one primary action is Map & Save (blue) and is enabled; Cancel is beside it', mm0.cta === 'Map & Save' && !mm0.ctaOff && mm0.ctaBg === 'rgb(43, 78, 255)' && /Cancel/.test(mm0.foot) && mm0.footVisible, JSON.stringify([mm0.cta, mm0.ctaBg, mm0.foot]));
  check('Nothing is saved yet: no note was created, the editor holds no mapping, the Library is unchanged', (await A.evaluate(() => __BL.S.batch.items.length)) === 1 && (await A.evaluate(() => !__BL.toolsApi.getP().mapping)) && (await libRaw()) === libBefore);
  check('The four actions: Change Product, Change Variant, Check Shopify (no Remove here)', mm0.btns === 'Change Product|Change Variant|Check Shopify', mm0.btns);
  const vals = await A.evaluate(() => Object.fromEntries([...__BL.S.ui.root.querySelectorAll('.lib-map-body input[data-lib="map-f"]')].map((i) => [i.dataset.f, i.value])));
  check('The five editable values start from the approved Library data', vals.title === 'Acme ZMA Capsules' && vals.regularCents === '27.97' && vals.promoCents === '19.99' && /products\/zma\?variant=4444444444$/.test(vals.url) && /zma\.jpg$/.test(vals.image), JSON.stringify(vals));
  await mSet('title', 'ZMA Night Formula'); await mSet('regularCents', '29.99'); await mSet('promoCents', '17.50');
  await mSet('url', 'not a url');
  const badUrl = await A.evaluate(() => ({ ov: JSON.stringify(__BL.libraryUi.L.map.draft.overrides || {}), err: __BL.S.ui.root.querySelector('.lib-map-ferr')?.textContent || '' }));
  check('A bad web address is refused with a message and not stored', !/url/.test(badUrl.ov) && /http/.test(badUrl.err), JSON.stringify(badUrl));
  await mSet('url', 'https://shop.example.com/products/zma-night'); await mSet('image', 'https://cdn.example.com/zma-night.jpg');
  check('Edited values are marked edited and have Reset; the window says the displayed price does not change Shopify checkout', await A.evaluate(() => __BL.S.ui.root.querySelectorAll('.lib-map-ed').length === 5 && /doesn’t change Shopify checkout/.test(__BL.S.ui.root.querySelector('.lib-map-body').textContent)));
  await mc('lib-map-reset-all');
  check('Reset all returns every value to the default', await A.evaluate(() => !__BL.libraryUi.L.map.draft.overrides && __BL.S.ui.root.querySelectorAll('.lib-map-ed').length === 0));
  await mSet('title', 'ZMA Night Formula'); await mSet('regularCents', '29.99'); await mSet('promoCents', '17.50');
  await mSet('url', 'https://shop.example.com/products/zma-night'); await mSet('image', 'https://cdn.example.com/zma-night.jpg');
  await mSave();
  const m1 = await t.item(1);
  const pm = m1.productMapping;
  check('Map & Save persisted the whole mapping at once, with no description and no separate Update click: the window and the editor are closed and the note exists', !!pm && m1.note === '' && pm.product.key === 'sku:ACM400101' && !(await mdl()).open && !(await modal()).open && !(await A.evaluate(() => !!__BL.S.pop)));
  check('Stored mapping: exact string variant id, product id, SKU, handle, original list id, the card, approvals', pm.variant.variantId === '4444444444' && pm.variant.productId === '1111111114' && pm.variant.sku === 'ACM400101' && pm.variant.handle === 'zma' && pm.list.id === 'l-m3-a' && pm.list.store === ORIGIN3 && pm.card?.index === 2 && pm.approved.regularCents === 2797 && pm.state.verification === 'verified' && !('productCard' in m1), JSON.stringify(pm.list));
  check('Page-specific values are overrides beside the approved data, which is unchanged', JSON.stringify(pm.overrides) === JSON.stringify({ title: 'ZMA Night Formula', regularCents: 2999, promoCents: 1750, url: 'https://shop.example.com/products/zma-night', image: 'https://cdn.example.com/zma-night.jpg' }) && pm.approved.title === 'Acme ZMA Capsules' && pm.approved.promoCents === 1999);
  check('The Product Library records are byte-for-byte unchanged by mapping and editing', (await libRaw()) === libBefore);
  let exp = await t.prompt();
  let sec = t.section(exp, 2);
  check('Report: card and section, product, exact variant id and SKU, page-specific prices, URL, image', sec.includes('**Product mapping**') && /in section “Featured”, card 2 of 3/.test(sec) && sec.includes('ZMA Night Formula') && sec.includes('variant id `4444444444`') && sec.includes('SKU `ACM400101`') && /regular \$29\.99 \(page-specific override; approved \$27\.97\)/.test(sec) && /sale \$17\.50 \(page-specific override; list \$19\.99\)/.test(sec) && sec.includes('https://shop.example.com/products/zma-night') && sec.includes('zma-night.jpg') && /don’t change what Shopify charges at checkout/.test(sec), sec.slice(0, 1200));
  check('Report: concise: no live-verification claim, no empty Inspection heading, no invented cart wiring, one card check, no "Also selected" echo, no stylesheet warning', !/live-verified/.test(sec) && !/\*\*Inspection\*\*/.test(sec) && /don’t add cart or checkout wiring/.test(sec) && (sec.match(/Card check:/g) || []).length === 1 && !/Also selected/.test(sec) && !/cross-origin stylesheet/.test(sec), sec.slice(0, 900));

  // ---- 4. Reopen, Toolbox state, change product / variant in the window
  await A.evaluate(() => BluelineLibrary.setActive(chrome.storage.local, location.origin, '', 'l-m3-b'));
  await t.reopen(1); await openCard(); await sleep(500);
  const ro = await body();
  check('Reopening shows the saved product in a compact summary with Edit Product Mapping and Remove Mapping, no Check Shopify or value fields', /Acme ZMA Capsules|ZMA Night/.test(ro) && /M3 list A/.test(ro) && /Product approved/.test(ro) && !/Verified/.test(ro) && (await A.evaluate(() => [...__BL.S.ui.root.querySelectorAll('.map-card .xbtns .xb')].map((b) => b.textContent.trim()).join('|'))) === 'Edit Product Mapping|Remove Mapping' && (await A.evaluate(() => __BL.S.ui.root.querySelectorAll('.map-ov, [data-x="map-shopify"]').length)) === 0, ro.slice(0, 260));
  await clk('map-start'); await sleep(500);
  mm0 = await mdl();
  const roVals = await A.evaluate(() => Object.fromEntries([...__BL.S.ui.root.querySelectorAll('.lib-map-body input[data-lib="map-f"]')].map((i) => [i.dataset.f, i.value])));
  check('The window shows the saved product, variant and overrides from its original list even though another list is now active, with no stale warning, Saved, and Map & Save replaced by a disabled Save Mapping', mm0.open && /M3 list A/.test(mm0.text) && roVals.title === 'ZMA Night Formula' && roVals.regularCents === '29.99' && (await A.evaluate(() => __BL.toolsApi.getP().mapCheck?.state)) === 'current' && !/list changed/.test(mm0.text) && /Saved/.test(mm0.badges) && mm0.cta === 'Save Mapping' && mm0.ctaOff === true && /Variant ID 4444444444/.test(mm0.text), JSON.stringify([mm0.badges, mm0.cta, roVals]));
  check('Open Note is not offered when the note is already open', !/Open Note/.test(mm0.text));
  await mc('lib-map-product'); await sleep(300);
  check('Change Product opens the picker on the mapping’s own list, not the active one, and marks the current product', /M3 list A/.test(await A.evaluate(() => __BL.S.ui.root.querySelector('[data-lib="sel-list"]').selectedOptions[0].textContent)) && await A.evaluate(() => __BL.S.ui.root.querySelectorAll('.lib-sel-row[data-cur="1"]').length) === 1);
  await esc();
  check('Escape from the picker leaves the mapping exactly as it was', (await mdl()).open && (await mdl()).draft.variant.variantId === '4444444444' && (await A.evaluate(() => __BL.toolsApi.getP().mapping.variant.variantId)) === '4444444444');
  await esc();
  check('Escape with nothing pending closes the window and keeps the note open', !(await mdl()).open && await A.evaluate(() => !!__BL.S.pop));
  check('A reopened note starts with the Toolbox collapsed and the other tools visible', JSON.stringify(await A.evaluate(() => ({ panels: [...__BL.S.ui.root.querySelectorAll('[data-tool-panel]')].filter((p) => !p.hidden).map((p) => p.dataset.toolPanel), tools: [...__BL.S.ui.root.querySelectorAll('.tool-main')].map((b) => b.textContent.trim()) }))) === JSON.stringify({ panels: [], tools: ['Toolbox', 'Edit CSS', 'Annotate', 'Align'] }));

  // Change Variant: opens at this product's variants, the same SKU on another variant keeps the page-specific values
  await clk('map-start'); await sleep(400);
  await mc('lib-map-variant'); await sleep(700);
  md = await modal();
  check('Change Variant opens the picker straight at the product’s variants; the current one is marked and cannot be "chosen" again', md.open && md.h === 'Choose a variant' && md.text.includes('4444444445') && /Current/.test(md.text) && /Use this variant/.test(md.foot) && await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-sel-use"]').disabled), JSON.stringify(md));
  await selVar('4444444445');
  check('Choosing a variant with the same SKU is a plain blue "Use this variant"', await A.evaluate(() => { const b = __BL.S.ui.root.querySelector('[data-x="lib-sel-use"]'); return !b.disabled && b.textContent === 'Use this variant' && getComputedStyle(b).backgroundColor === 'rgb(43, 78, 255)'; }));
  await selUse();
  mm0 = await mdl();
  check('Back in the Product Mapping window the variant is proposed but not saved, and the stored mapping still has the old variant', mm0.open && mm0.draft.variant.variantId === '4444444445' && /Not saved yet/.test(mm0.badges) && (await mapStored(1)).variant.variantId === '4444444444' && mm0.cta === 'Replace & Save' && !mm0.ctaOff && mm0.ctaBg === 'rgb(43, 78, 255)', JSON.stringify([mm0.cta, mm0.badges]));
  await mSave();
  const pv = await mapStored(1);
  check('Replace & Save: the new variant replaces the identity only: exact string id, same SKU stays exact, page-specific values kept, approved price not carried over; saved with no Update click', pv.variant.variantId === '4444444445' && pv.state.identity === 'exact' && pv.overrides.title === 'ZMA Night Formula' && pv.approved.regularCents === null && pv.state.needsReview === true && !pv.replacement && !(await mdl()).open && await A.evaluate(() => !!__BL.S.pop && __BL.toolsApi.getP().mapping.variant.variantId === '4444444445' && !__BL.toolsApi.getP().mapDirty), JSON.stringify(pv.state));
  exp = await t.prompt(); sec = t.section(exp, 2);
  check('Report after a variant change: the new id, a regular price that is explicitly not approved, the page override still shown', sec.includes('variant id `4444444445`') && /regular \$29\.99 \(page-specific override; no approved regular price\)/.test(sec), sec.slice(0, 900));
  await t.reopen(1); await openCard(); await sleep(600);
  check('Reopening an intentionally changed variant produces no Library-stale warning (state current)', (await A.evaluate(() => __BL.toolsApi.getP().mapping.variant.variantId)) === '4444444445' && (await A.evaluate(() => __BL.toolsApi.getP().mapCheck?.state)) === 'current' && !/list changed|may have changed/.test(await body()), await body());

  // A different SKU: nothing is approved or saved until Approve & Save Replacement is chosen
  await clk('map-start'); await sleep(400);
  await mc('lib-map-product'); await sleep(300);
  await selQ('fish'); await selPick('sku:ACM999001');
  await selVar('4444444450');
  md = await modal();
  const cta = await A.evaluate(() => { const b = __BL.S.ui.root.querySelector('[data-x="lib-sel-use"]'); return { text: b.textContent, bg: getComputedStyle(b).backgroundColor, off: b.disabled }; });
  check('In the picker a different-SKU choice is a plain blue "Use this product" (never the green approval button) that says approval happens in Product Mapping; no stale price or promo is carried over', cta.text === 'Use this product' && cta.bg === 'rgb(43, 78, 255)' && !cta.off && /The list approved SKU ACM999001, not SKU ACM999002/.test(md.text) && /in Product Mapping/.test(md.text) && /not approved/.test(md.text) && md.footVisible, JSON.stringify([cta, md.text.slice(0, 500)]));
  check('There is no separate "Review Replacement" step', !/Review Replacement/.test(md.text + md.foot));
  await selUse();
  mm0 = await mdl();
  check('The replacement is proposed, NOT approved and NOT saved: Approval says approval is required, Saved says not saved, and no Verified claim', mm0.open && /Replacement approval required/.test(mm0.badges) && /Not saved yet/.test(mm0.badges) && /Not checked yet/.test(mm0.badges) && !/Verified/.test(mm0.badges) && mm0.draft.replacement.status === 'pending', mm0.badges);
  check('The primary action is the green Approve & Save Replacement, with the reason shown above it', mm0.cta === 'Approve & Save Replacement' && !mm0.ctaOff && mm0.ctaBg === 'rgb(30, 122, 62)' && /Replacement approval/.test(mm0.text) && /ACM999001/.test(mm0.text) && /ACM999002/.test(mm0.text) && mm0.footVisible, JSON.stringify([mm0.cta, mm0.ctaBg]));
  const stored1 = await mapStored(1);
  check('Until then the stored mapping is still the saved one (nothing approved, nothing saved)', stored1.variant.variantId === '4444444445' && !stored1.replacement && (await libRaw()) === libBefore);
  await mSave();
  const ps = await mapStored(1);
  check('Approve & Save Replacement approved and saved it in one step: exact new variant id, approved identity for this card, no approved regular price, no invented promo, the new variant’s default title, no earlier overrides', ps.variant.variantId === '4444444450' && ps.state.identity === 'substitute-approved' && ps.replacement.status === 'approved' && ps.replacement.fromSku === 'ACM999001' && ps.replacement.toSku === 'ACM999002' && ps.approved.regularCents === null && ps.approved.promoCents === null && ps.approved.title === 'Acme Fish Oil Softgels - 180 ct' && !ps.overrides && ps.list.id === 'l-m3-a', JSON.stringify(ps.replacement));
  check('The note shows the replacement as approved but not fully approved while the regular price is unapproved', /Replacement approved · regular price not approved/.test(await body()));
  check('The Library did not receive the approval (approval is for this card only)', (await libRaw()) === libBefore);
  sec = t.section(await t.prompt(), 2);
  check('Report: the replacement is stated once, with both SKUs; the regular price is not approved; no promo is invented', /replacement approved for this card \(list SKU ACM999001 → variant SKU ACM999002\)|replacement approved for this card/.test(sec) && /regular price not approved/.test(sec) && /no sale price/.test(sec) && sec.includes('variant id `4444444450`'), sec.slice(0, 800));

  // Page-specific values must be resolved before a replacement is approved
  await t.reopen(1); await openCard(); await sleep(400);
  await clk('map-start'); await sleep(400);
  await mc('lib-map-product'); await sleep(300);
  await selQ('fish'); await selPick('sku:ACM999001'); await selVar('4444444449'); await selUse();
  mm0 = await mdl();
  check('Going back to SKU ACM999001 from the approved ACM999002 changes the card’s SKU, so it needs approval again (Approve & Save Replacement)', mm0.cta === 'Approve & Save Replacement' && /Replacement approval/.test(mm0.text) && /ACM999002/.test(mm0.text) && mm0.ctaBg === 'rgb(30, 122, 62)', JSON.stringify([mm0.cta, mm0.ctaBg]));
  await mSet('title', 'Fish Hero'); await mSet('promoCents', '9.99');
  await mSave();
  await clk('map-start'); await sleep(400);
  await mc('lib-map-variant'); await sleep(700);
  await selVar('4444444450'); await selUse();
  mm0 = await mdl();
  check('Existing page-specific values conflict with the replacement and must each be resolved in the window; the primary action waits', /Your page-specific values/.test(mm0.text) && /Keep mine: Fish Hero/.test(mm0.text) && /Use the new default: Acme Fish Oil Softgels - 180 ct/.test(mm0.text) && mm0.ctaOff && /Choose what to do/.test(mm0.foot), mm0.text.slice(0, 600));
  await mRes('title', 'keep'); await mRes('promoCents', 'default');
  mm0 = await mdl();
  check('Once resolved, Approve & Save Replacement is enabled', mm0.cta === 'Approve & Save Replacement' && !mm0.ctaOff);
  await mSave();
  const rs = await mapStored(1);
  check('Kept values stay as page-specific overrides, dropped ones fall back to the new default; resolutions recorded', JSON.stringify(rs.overrides) === JSON.stringify({ title: 'Fish Hero' }) && rs.replacement.resolved.title === 'keep' && rs.replacement.resolved.promoCents === 'default' && rs.approved.promoCents === null && rs.replacement.status === 'approved', JSON.stringify(rs.replacement) + JSON.stringify(rs.overrides));
  // a mapping saved by an earlier version that is still waiting for approval: the same one-step confirmation
  await A.evaluate(async () => { const it = __BL.S.batch.items[1]; const Lb = BluelineLibrary; const m0 = JSON.parse(JSON.stringify(it.productMapping)); delete m0.overrides; delete m0.replacement; m0.variant.variantId = '4444444449'; m0.variant.sku = 'ACM999001'; const p = Lb.changeMappingVariant(m0, { variantId: '4444444450', sku: 'ACM999002', handle: 'fish-oil', productTitle: 'Acme Fish Oil Softgels', variantTitle: '180 ct', options: [], priceCents: 5497 }); it.productMapping = p; await __BL.saveBatch(); });
  await t.reopen(1); await openCard(); await sleep(500);
  const pend = await A.evaluate(() => { const b = __BL.S.ui.root.querySelector('.map-card [data-x="map-start"]'); return b ? { text: b.textContent } : null; });
  check('A saved mapping still waiting for approval says so in the note and offers Review & Approve (no approve button hidden in the note)', !!pend && pend.text === 'Review & Approve' && /Replacement approval required/.test(await body()) && (await A.evaluate(() => !__BL.S.ui.root.querySelector('[data-x="map-approve"]'))), JSON.stringify(pend) + (await body()).slice(0, 200));
  await clk('map-start'); await sleep(500);
  mm0 = await mdl();
  check('The window opens ready to approve: Approve & Save Replacement (green) and enabled even though the product is unchanged', mm0.open && mm0.cta === 'Approve & Save Replacement' && !mm0.ctaOff && mm0.ctaBg === 'rgb(30, 122, 62)' && /Replacement approval required/.test(mm0.badges) && /Saved/.test(mm0.badges), JSON.stringify([mm0.cta, mm0.badges]));
  await mSave();
  check('Approving it saved the approved state', (await mapStored(1)).replacement.status === 'approved' && (await mapStored(1)).state.identity === 'substitute-approved');
  sec = t.section(await t.prompt(), 2);
  check('Report for an approved replacement', /replacement approved for this card/.test(sec) && sec.includes('variant id `4444444450`'), sec.slice(0, 700));

  // Remove Mapping keeps the card, the note and its CSS
  await t.reopen(1); await openCard(); await sleep(300);
  const rmBtn = await A.evaluate(() => getComputedStyle(__BL.S.ui.root.querySelector('[data-x="map-remove"]')).color);
  check('Remove Mapping is styled as a destructive action (red)', rmBtn === 'rgb(180, 35, 24)', rmBtn);
  await clk('map-remove');
  const rmOk = await A.evaluate(() => { const r = __BL.S.ui.root; return { bg: getComputedStyle(r.querySelector('[data-x="map-remove-ok"]')).backgroundColor, keepBg: getComputedStyle(r.querySelector('[data-x="map-remove-no"]')).backgroundColor }; });
  check('Its confirmation is solid red; Keep is neutral', rmOk.bg === 'rgb(180, 35, 24)' && rmOk.keepBg !== 'rgb(180, 35, 24)', JSON.stringify(rmOk));
  await clk('map-remove-no');
  check('Remove Mapping asks first, and Keep leaves the mapping', await A.evaluate(() => !!__BL.toolsApi.getP().mapping));
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.pop-note').value = 'Unsaved draft words'; });
  await clk('map-remove'); await clk('map-remove-ok'); await sleep(500);
  const rmNow = await t.item(1);
  check('Remove Mapping persists immediately after the confirmation (no Update note): the saved note has no mapping, keeps its card, and the unsaved draft text stays in the editor, unsaved', !('productMapping' in rmNow) && rmNow.productCard?.index === 2 && rmNow.note !== 'Unsaved draft words' && await A.evaluate(() => __BL.S.ui.root.querySelector('.pop-note').value === 'Unsaved draft words' && !__BL.toolsApi.getP().mapping && !__BL.S.ui.root.querySelector('.x-pmbox .pmb')), JSON.stringify(Object.keys(rmNow)));
  await t.save('Now just a card');
  const rm = await t.item(1);
  check('Removing the mapping leaves the confirmed card on the note (as its own card) and nothing else', !('productMapping' in rm) && rm.productCard?.index === 2 && rm.productCard.section.heading === 'Featured', JSON.stringify(Object.keys(rm)) + JSON.stringify(rm.productCard || null).slice(0, 200));
  exp = await t.prompt();
  check('Report: no mapping block any more, the card block remains', !/Product mapping/.test(t.section(exp, 2)) && /\*\*Product card\*\*/.test(t.section(exp, 2)), t.section(exp, 2).slice(0, 900));

  // ---- 5. A single-variant product, a manual product (no Shopify) and another saved list
  await t.reopen(1); await openCard(); await sleep(300);
  await clk('map-start'); await sleep(500);
  check('With no mapping the window starts on the page’s active list (not the note’s earlier one)', /M3 list B/.test(await A.evaluate(() => __BL.S.ui.root.querySelector('[data-lib="sel-list"]').selectedOptions[0].textContent)));
  await selList(`${ORIGIN3}|l-m3-a`);
  await selQ('charcoal'); await selPick('sku:ACM200101');
  md = await modal();
  check('A product with one Shopify variant says "Only one variant available" instead of asking for a variant', /Only one variant available/.test(md.text) && !(await A.evaluate(() => __BL.S.ui.root.querySelectorAll('input[data-lib="sel-v"]').length)) && /Use this product/.test(md.foot), md.text.slice(0, 300));
  await esc();
  await selQ('local'); await selPick(await A.evaluate(() => [...__BL.S.ui.root.querySelectorAll('.lib-sel-row')].map((b) => b.dataset.key)[0]));
  md = await modal();
  check('A manual product (no Shopify) can be chosen: no variant list, its own price', /No Shopify variant is linked/.test(md.text) && /\$5\.00/.test(md.text) && !/Variant ID/.test(md.text), md.text.slice(0, 300));
  await selUse();
  mm0 = await mdl();
  check('A manual product maps without Shopify: no variant, its own price, and only Change Product (no Change Variant or Check Shopify); the Shopify fact says there is no store', mm0.draft.variant === null && mm0.draft.approved.regularCents === 500 && mm0.draft.product.origin === 'manual' && mm0.btns === 'Change Product' && /No Shopify store/.test(mm0.badges) && mm0.cta === 'Map & Save', JSON.stringify([mm0.draft.approved, mm0.btns, mm0.badges, mm0.cta]));
  await mSave();
  sec = t.section(await t.prompt(), 2);
  check('Report: a manual product says there is no Shopify variant and does not invent an id', /Shopify: no variant recorded/.test(sec) && !/variant id/.test(sec) && /regular \$5\.00/.test(sec), sec.slice(0, 600));
  await t.reopen(1); await openCard(); await sleep(300);
  await clk('map-start'); await sleep(400);
  await mc('lib-map-product'); await sleep(300);
  await selList('|l-m3-b');
  await selPick('sku:B-1');
  await selUse();
  mm0 = await mdl();
  check('Replacing the card’s product with one from another saved list: a different SKU, so the action is Approve & Save Replacement', mm0.cta === 'Approve & Save Replacement' && !mm0.ctaOff, JSON.stringify([mm0.cta, mm0.text.slice(0, 300)]));
  await mSave();
  const lb = await mapStored(1);
  check('The mapping then belongs to the newly chosen list (its id, a list with no store); the first list is untouched', lb.list.id === 'l-m3-b' && lb.list.store === '' && lb.product.sku === 'B-1' && lb.variant === null && (await libRaw()) === libBefore);
  check('Other notes and the Library records are untouched', (await t.item(0)).productCard.index === 1 && !(await t.item(0)).productMapping && (await libRaw()) === libBefore);

  // ---- 6. Library drift: only genuine changes to the originating record are warned about, never silently applied
  await t.reopen(1); await openCard(); await sleep(300);
  await clk('map-start'); await sleep(400);
  await mc('lib-map-product'); await sleep(300);
  await selList(`${ORIGIN3}|l-m3-a`);
  await selQ('zma'); await selPick('sku:ACM400101'); await selUse();
  await mSave();
  const savedZma = JSON.stringify(await mapStored(1));
  const libA2 = LibNode.decide(libA, 'sku:ACM400101', 'custom', 2000);
  await seed(libA2);
  await t.reopen(1); await openCard(); await sleep(700);
  const st1 = await body();
  check('A genuinely changed approval in the list is warned about on reopen', /The list changed since this was mapped/.test(st1), st1.slice(0, 400));
  await clk('map-start'); await sleep(500);
  mm0 = await mdl();
  check('The window gives the specific difference and the explicit way to adopt it', /Approved regular price: \$27\.97 → \$20\.00/.test(mm0.text) && /Use the list’s current values/.test(mm0.text), mm0.text.slice(0, 400));
  check('The saved values are not replaced by the list’s newer ones', (await A.evaluate(() => __BL.toolsApi.getP().mapping.approved.regularCents)) === 2797 && mm0.draft.approved.regularCents === 2797);
  await esc();
  await A.evaluate(() => __BL.hooks.beforeExport());
  sec = t.section(await t.prompt(), 2);
  check('Report: carries the changed-record warning for that note', /Warning, the saved list record changed:\*\* Approved regular price: \$27\.97 → \$20\.00/.test(sec), sec.slice(0, 1400));
  await t.save('');
  check('Saving without choosing again does not rewrite the mapping', JSON.stringify(await mapStored(1)) === savedZma);
  await t.reopen(1); await openCard(); await sleep(700);
  await clk('map-start'); await sleep(500);
  await mc('lib-map-adopt'); await sleep(300);
  mm0 = await mdl();
  check('"Use the list’s current values" is the explicit way to adopt them: the approved price follows the list, the variant is the list’s; it must then be saved (Save Mapping)', mm0.draft.approved.regularCents === 2000 && mm0.draft.variant.variantId === '4444444444' && mm0.cta === 'Save Mapping' && !mm0.ctaOff && (await mapStored(1)).approved.regularCents === 2797);
  await mSave();
  check('Saving adopted the list’s values and cleared the warning', (await mapStored(1)).approved.regularCents === 2000 && (await A.evaluate(() => __BL.toolsApi.getP().mapping.approved.regularCents)) === 2000 && !/list changed/.test(await body()));
  await t.save('');
  const libA4 = { ...libA2, smp: { v: 1, imports: [LibNode.importCsv('SKU,Name,Price\nACM999001,Acme Fish Oil Softgels,$30.97\n', { fileName: 'other.csv', sha256: 'o' })] } };
  await seed(libA4);
  await t.reopen(1); await openCard(); await sleep(700);
  check('A product that is no longer in its list is reported as missing', /is no longer in/.test(await body()));
  await A.evaluate(() => BluelineLibrary.deleteLibrary(chrome.storage.local, location.origin, 'l-m3-a'));
  await t.reopen(1); await openCard(); await sleep(700);
  check('A list that is gone is reported as missing, and the saved mapping still shows', /isn’t saved in this browser/.test(await body()) && /Acme ZMA Capsules/.test(await body()) && (await A.evaluate(() => __BL.toolsApi.getP().mapping.list.id)) === 'l-m3-a');
  await t.save('');
  await seed(libA);

  // ---- 6b. Check Shopify is read-only and says what happened; mapped-card markers; destructive colors; unique list names
  await t.reopen(1); await openCard(); await sleep(600);
  await clk('map-start'); await sleep(500);
  await mc('lib-map-adopt'); await sleep(250); // back in step with the (restored) list
  await mSave();
  await t.reopen(1); await openCard(); await sleep(500);
  await clk('map-start'); await sleep(500);
  const mapBefore = JSON.stringify(await mapStored(1));
  const shopBtn = await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-map-shopify"]')?.textContent);
  check('Check Shopify is offered in the Product Mapping window, and Shopify says "Not checked yet" before it runs', shopBtn === 'Check Shopify' && /Not checked yet/.test((await mdl()).badges));
  await mc('lib-map-shopify'); await sleep(900);
  let sc = await mdl();
  check('A finished check says so clearly: complete, no differences, the exact variant id, SKU, price and availability, and the time; the Shopify fact becomes "Verified just now" while Approval and Saved are unchanged', /Shopify check complete: no differences/.test(sc.text) && /Shopify has variant ID 4444444444/.test(sc.text) && /SKU ACM400101/.test(sc.text) && /available/.test(sc.text) && /Read-only: nothing was approved, changed or saved/.test(sc.text) && /Verified just now/.test(sc.badges) && /Saved/.test(sc.badges) && /Product approved/.test(sc.badges), sc.text.slice(0, 600));
  check('The result is in a live region so assistive technology announces it', await A.evaluate(() => !!__BL.S.ui.root.querySelector('.lib-map-shop[role="status"][aria-live="polite"]')));
  check('It approves nothing and overwrites nothing: the stored mapping, the open note’s mapping and the Library are unchanged and the CTA is still waiting (nothing to save)', JSON.stringify(await mapStored(1)) === mapBefore && sc.ctaOff === true && (await libRaw()) === libBefore);
  await A.evaluate(() => { __BL.libraryUi.L.map.draft.variant.variantId = '999'; });
  await mc('lib-map-shopify'); await sleep(900);
  sc = await mdl();
  check('A variant the store no longer has is reported as a finished check with a red result, never as verified', /Shopify check complete: variant not found/.test(sc.text) && /Variant id 999 is no longer on/.test(sc.text) && /Variant not found/.test(sc.badges) && !/Verified just now/.test(sc.badges), sc.text.slice(0, 400));
  await A.evaluate(() => { const d = __BL.libraryUi.L.map.draft; d.variant.variantId = '4444444444'; d.reference.shopifyCents = 1; });
  await mc('lib-map-shopify'); await sleep(900);
  sc = await mdl();
  check('Genuine differences are shown with each one listed and the Shopify fact says differences were found', /Shopify check complete: differences found/.test(sc.text) && /Shopify price: \$0\.01 →/.test(sc.text) && /Differences found/.test(sc.badges), sc.text.slice(0, 500));
  await A.evaluate(() => { const d = __BL.libraryUi.L.map.draft; d.list.store = 'http://127.0.0.1:9'; });
  await mc('lib-map-shopify'); await sleep(1200);
  sc = await mdl();
  check('A store that cannot be reached is reported as a failed check, not as success', /Shopify check failed|Shopify check complete: variant not found/.test(sc.text) && !/Verified just now/.test(sc.badges), sc.text.slice(0, 400));
  await mc('lib-map-cancel');
  check('Cancelling discards everything the checks scribbled on the working copy: the saved mapping is unchanged', JSON.stringify(await mapStored(1)) === mapBefore && !(await mdl()).open);
  await t.save('');
  await sleep(600);
  const pmk = await A.evaluate(() => { const r = __BL.S.ui.root; const b = r.querySelector('.x-pmbox .pmb'); const card = document.querySelector('#rail-feat > article:nth-child(2)').getBoundingClientRect(); const m = b?.closest('.pmk').getBoundingClientRect(); return b ? { n: r.querySelectorAll('.x-pmbox .pmb').length, text: b.textContent, label: b.getAttribute('aria-label'), inside: !!m && Math.abs(m.left - card.left) < 2 && Math.abs(m.top - card.top) < 2 && Math.abs(m.width - card.width) < 2, wrapPE: getComputedStyle(b.closest('.pmk')).pointerEvents, btnPE: getComputedStyle(b).pointerEvents, light: document.querySelectorAll('.pmb, .pmk').length } : null; });
  check('A "Mapped" marker sits on the confirmed card, names the product, and only the chip takes clicks; the page itself has no added elements', !!pmk && pmk.n === 1 && /^Mapped/.test(pmk.text) && /ZMA/.test(pmk.label) && pmk.inside && pmk.wrapPE === 'none' && pmk.btnPE === 'auto' && pmk.light === 0, JSON.stringify(pmk));
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.x-pmbox .pmb').click(); }); await sleep(600);
  mm0 = await mdl();
  check('Clicking the marker opens the Product Mapping window directly (not the note editor), showing the saved product, with Open Note as a secondary action', mm0.open && !(await A.evaluate(() => !!__BL.S.pop)) && /Acme ZMA Capsules/.test(mm0.text) && /Open Note/.test(mm0.text) && /Saved/.test(mm0.badges), JSON.stringify([mm0.open, mm0.foot]));
  await mc('lib-map-note'); await sleep(900);
  check('Open Note closes the window and opens that note’s editor with its saved mapping', !(await mdl()).open && await A.evaluate(() => !!__BL.S.pop && __BL.toolsApi.getP().mapping?.product?.key === 'sku:ACM400101'));
  await t.save('');
  await seed(LibNode.decide(libA, 'sku:ACM400101', 'custom', 1800));
  await A.evaluate(() => __BL.hooks.beforeExport()); await sleep(200);
  const attn = await A.evaluate(() => { const b = __BL.S.ui.root.querySelector('.x-pmbox .pmb'); return b ? { cls: b.className, text: b.textContent, label: b.getAttribute('aria-label') } : null; });
  check('A mapping that needs attention says so on its marker (amber, "check") and in its accessible name', !!attn && /attn/.test(attn.cls) && /check/.test(attn.text) && /Needs attention/.test(attn.label), JSON.stringify(attn));
  await seed(libA);
  await A.evaluate(() => { const rail = document.querySelector('#rail-feat'); rail.insertBefore(rail.firstElementChild.cloneNode(true), rail.firstElementChild); });
  await t.reopen(1); await t.save('');
  await sleep(400);
  check('After the page changes so the card can’t be told apart, no marker is placed on a guessed card', await A.evaluate(() => __BL.S.ui.root.querySelectorAll('.x-pmbox .pmb').length) === 0);
  await A.evaluate(() => { const rail = document.querySelector('#rail-feat'); rail.removeChild(rail.firstElementChild); });
  const colors = await A.evaluate(() => { const r = __BL.S.ui.root; const c = (sel) => { const e = r.querySelector(sel); return e ? getComputedStyle(e).color : null; }; return { del: c('[data-act="pop-delete"]'), clear: c('[data-x="card-clear"]') }; });
  check('Delete note and Clear card share the red destructive color', colors.del === 'rgb(180, 35, 24)', JSON.stringify(colors));
  await A.evaluate(() => chrome.storage.local.get('blueline:lib:index').then((r) => { const idx = r['blueline:lib:index']; idx.libs.forEach((l) => { if (l.campaign === 'l-m3-b') l.name = 'M3 LIST A '; }); return chrome.storage.local.set({ 'blueline:lib:index': idx }); }));
  await t.reopen(1); await openCard(); await clk('map-start'); await sleep(600);
  await mc('lib-map-product'); await sleep(500);
  const names = await A.evaluate(() => [...__BL.S.ui.root.querySelectorAll('[data-lib="sel-list"] option')].map((o) => o.textContent));
  await esc(); await esc();
  check('Two lists that share a name (ignoring case and surrounding spaces) are shown with unique names; both keep their ids', names.length === 2 && new Set(names.map((n) => n.toLowerCase().trim())).size === 2 && names.some((n) => /\(2\)/.test(n)) && (await A.evaluate(() => chrome.storage.local.get('blueline:lib:index').then((r) => r['blueline:lib:index'].libs.map((l) => l.campaign).sort().join()))) === 'l-m3-a,l-m3-b', JSON.stringify(names));
  await t.save('');


  // ---- 7. The card safeguards still apply to a mapped card
  await t.reopen(1); await openCard(); await sleep(300);
  const before7 = JSON.stringify((await t.item(1)).productMapping.card);
  await t.save('');
  await A.evaluate(() => { const rail = document.querySelector('#rail-feat'); rail.insertBefore(rail.firstElementChild.cloneNode(true), rail.firstElementChild); });
  await t.reopen(1); await openCard(); await sleep(500);
  const amb = await body();
  check('After a card is inserted before it, a mapped card is not silently re-attached: it says it needs confirming', /Needs confirmation|Can’t tell which card/.test(amb), amb.slice(0, 200));
  await t.save('');
  check('Saving it unchanged leaves the saved card byte-for-byte as it was', JSON.stringify((await t.item(1)).productMapping.card) === before7);
  exp = await t.prompt();
  check('Report does not call a changed card confirmed', /not confirmed/.test(t.section(exp, 2)) && !/Card check: confirmed/.test(t.section(exp, 2)), t.section(exp, 2).slice(-400));

  // ---- 8. Isolation: other pages and sites keep their own notes
  await A.evaluate(() => {
    const base = JSON.parse(JSON.stringify(__BL.S.batch.items[1]));
    const make = (id, over) => { const x = JSON.parse(JSON.stringify(base)); x.id = id; x.note = `Note ${id}`; Object.assign(x, over); return x; };
    const all = JSON.parse(JSON.stringify(__BL.S.all));
    all.items.push(make('m3page', { url: `${location.origin}/other.html`, path: '/other.html' }), make('m3site', { url: 'https://example.org/', path: '/' }));
    return chrome.storage.local.set({ 'blueline:batch': all });
  });
  await sleep(500);
  const others = (await A.evaluate(() => chrome.storage.local.get('blueline:batch').then((r) => r['blueline:batch']))).items.filter((i) => /^m3/.test(i.id));
  const othersJson = JSON.stringify(others);
  check('Notes (and their mappings) for another page or site are not shown or exported here', !/Note m3(page|site)/.test(await t.prompt()));
  await t.reopen(1); await t.save('');
  const others2 = (await A.evaluate(() => chrome.storage.local.get('blueline:batch').then((r) => r['blueline:batch']))).items.filter((i) => /^m3/.test(i.id));
  check('Saving here leaves the other pages’ and sites’ mappings byte-for-byte unchanged', JSON.stringify(others2) === othersJson);

  // ---- 9. Existing CSS and note behavior, legacy Figma / variant data
  await shiftClick(A, await pointFor(A, '#tiles > li:nth-child(1) h3', 'text'));
  await clk('tool-css'); await t.setCss('color', '#0a7a2f');
  const link = await A.evaluate(() => { const d = __BL.S.ui.root.querySelector('[data-d="link"]'); return { sum: d.querySelector('summary').textContent.trim(), search: !!d.querySelector('.var-q') && !d.querySelector('.shop-only').hidden }; });
  check('The old "Figma link & product variant" section is now just "Figma link" and no longer offers a variant search', link.sum === 'Figma link' && !link.search, JSON.stringify(link));
  await A.evaluate(() => { const i = __BL.S.ui.root.querySelector('.figma-in'); i.value = 'https://www.figma.com/design/abc/x?node-id=1-2'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await t.save('Legacy-style note');
  const css = await t.item((await A.evaluate(() => __BL.S.batch.items.length)) - 1);
  check('A normal CSS note with a Figma link still saves its CSS and link, with no mapping', css.figma.includes('figma.com') && (css.elementEdits || []).some((e) => (e.tweaks || []).some((x) => x.prop === 'color')) && !css.productMapping);
  await A.evaluate((n) => {
    const i = __BL.S.batch.items.length - 1;
    __BL.S.batch.items[i].variant = { handle: 'zma', productId: '1111111114', variantId: '4444444444', title: '120 ct', sku: 'ACM400101', price: 27.97, available: true };
    return __BL.saveBatch();
  });
  const li = (await A.evaluate(() => __BL.S.batch.items.length)) - 1;
  await t.reopen(li);
  const legacy = await A.evaluate(() => ({ figma: __BL.S.ui.root.querySelector('.figma-in').value, strips: __BL.S.ui.root.querySelector('.x-strips').textContent, v: __BL.toolsApi.getP().variant?.variantId }));
  check('A note saved with the older product variant still shows it and keeps the Figma link', /figma\.com/.test(legacy.figma) && legacy.v === '4444444444', JSON.stringify(legacy));
  await t.save();
  const le = await t.item(li);
  check('Saving it again preserves the legacy variant data', le.variant?.variantId === '4444444444' && /figma\.com/.test(le.figma));
  const lexp = (await t.prompt()).split(/\n(?=## \d+\. )/).find((p) => p.includes('Legacy-style note')) || '';
  check('The legacy variant and Figma link still export', /Wire to Shopify variant: product `zma`, variant id `4444444444`/.test(lexp) && /Figma: https:\/\/www\.figma\.com/.test(lexp), lexp.slice(-500));

  // ---- 10. Housekeeping
  await shiftClick(A, await pointFor(A, '#lone-card .nm', 'text'));
  const sizes = await A.evaluate(() => [0, 512, 1023, 1024, 1536, 5 * 1024 * 1024, 1.5 * 1024 * 1024 * 1024, 123456].map((n) => __BL.libraryUi.fmtSize(n)));
  check('File sizes read as B / KB / MB / GB', sizes.join('|') === '0 B|512 B|1023 B|1 KB|1.5 KB|5 MB|1.5 GB|121 KB', sizes.join('|'));
  const mic = await A.evaluate(() => { const b = __BL.S.ui.root.querySelector('[data-x="dictate"]'); return { text: b.textContent.trim(), label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), svg: !!b.querySelector('svg'), w: b.getBoundingClientRect().width }; });
  check('"Speak your note" is a microphone icon button with an accessible name and pressed state', mic.text === '' && mic.label === 'Speak your note' && mic.pressed === 'false' && mic.svg && mic.w >= 24, JSON.stringify(mic));
  const gap = await A.evaluate(() => { const r = __BL.S.ui.root; const a = r.querySelector('.mic-row').getBoundingClientRect(); const b = r.querySelector('.bp-row').getBoundingClientRect(); return b.top - a.bottom; });
  check('There is breathing room between the microphone and the screen sizes', gap >= 8, String(gap));
  await A.evaluate(() => __BL.libraryUi.open());
  await sleep(500);
  const heads = [];
  heads.push(await A.evaluate(() => __BL.S.ui.root.querySelector('.xmodal[data-m="library"] header').textContent.trim()));
  await A.evaluate(() => { __BL.S.ui.root.querySelector('[data-x="lib-lists"]')?.click(); }); await sleep(500);
  heads.push(await A.evaluate(() => __BL.S.ui.root.querySelector('.xmodal[data-m="library"] header').textContent.trim()));
  check('The library window is titled "Product Library" in every view', heads.every((h) => /^Product Library/.test(h) && !/Import Product List|Product Lists/.test(h)), JSON.stringify(heads));
  // Blueline's overlays go with it: closing removes the "Mapped" markers, and the page was never modified
  await t.reopen(1).catch(() => {}); await t.save('').catch(() => {});
  const withMarkers = await A.evaluate(() => __BL.S.ui.root.querySelectorAll('.x-pmbox .pmb').length);
  await A.evaluate(() => __BLUELINE_TEST__.api.setActive(false)); await sleep(1500);
  check('Closing Blueline removes the Mapped markers; the page has no added elements or attributes', withMarkers >= 0 && await A.evaluate(() => !document.querySelector('blueline-ui') && !document.querySelector('.pmb, .pmk') && !document.querySelector('#rail-feat > article:nth-child(2)').hasAttribute('style')));
  check('No page errors in the M3 flows', A.errors.length === 0, A.errors.join(' | '));
  await A.close();
}

// ------------------------------------------------------------------ Product Mapping UX consolidation
console.log('\n# Product Mapping UX: one save action, accurate markers, Product Library button, draft safety (fixtures/product-cards.html)');
{
  const A = await open('product-cards.html', { http: true, realStorage: true });
  const ORIGIN4 = await A.evaluate(() => location.origin);
  const CSV4 = 'Section,SKU,Product Name,Original Price,Sale Price\nFeatured,ACM400101,Acme ZMA Capsules,$27.97,$19.99\nFeatured,ACM999001,Acme Fish Oil Softgels,$30.97,\n';
  const vOf = (handle, i = 0) => LibNode.normalizeProduct(PRODUCTS.find((p) => p.handle === handle), ORIGIN4, 'USD').variants[i];
  let lib = { store: ORIGIN4, campaign: 'l-ux-a', name: 'UX list', smp: { v: 1, imports: [LibNode.importCsv(CSV4, { fileName: 'ux.csv', sha256: 'ux1' })] }, work: LibNode.emptyWork() };
  lib = LibNode.decide(LibNode.chooseVariant(lib, 'sku:ACM400101', vOf('zma', 0)), 'sku:ACM400101', 'smp');
  lib = LibNode.decide(LibNode.chooseVariant(lib, 'sku:ACM999001', vOf('fish-oil', 0)), 'sku:ACM999001', 'smp');
  const t = tools(A);
  const NAME1 = '#rail-feat > article:nth-child(1) .nm';
  const NAME2 = '#rail-feat > article:nth-child(2) .nm';
  const libRaw = () => A.evaluate(() => chrome.storage.local.get().then((r) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => /^blueline:lib:(smp|work):/.test(k)).sort()))));
  const homeBtn = () => A.evaluate(() => { const r = __BL.S.ui.root; const b = r.querySelector('[data-x="lib-home"]'); const add = r.querySelector('.addnote'); const a = add.getBoundingClientRect(); const c = b.getBoundingClientRect(); return { hidden: b.hidden, shown: c.height > 0, text: b.textContent.trim(), under: add.nextElementSibling === b && c.top >= a.bottom - 1, addBg: getComputedStyle(add).backgroundColor, bg: getComputedStyle(b).backgroundColor, color: getComputedStyle(b).color, full: Math.abs(c.width - add.getBoundingClientRect().width) < 3, importStill: !!r.querySelector('[data-x="library"]') }; });
  const reboot = async () => { await A.evaluate(() => __BLUELINE_TEST__.api.setActive(false)); await sleep(500); await A.evaluate(() => __BLUELINE_TEST__.api.setActive(true)); await sleep(700); };

  // ---- Product Library button: hidden with no list, shown with one, opens the list manager
  let hb = await homeBtn();
  check('No saved list: the Product Library button is hidden; Import Product List is still the way to import', hb.hidden && !hb.shown && hb.importStill, JSON.stringify(hb));
  await A.evaluate((l) => BluelineLibrary.saveLibrary(chrome.storage.local, l, { smpChanged: true }), lib);
  await reboot();
  hb = await homeBtn();
  check('With a saved list the Product Library button appears directly under + Add note as a full-width GREEN button with white text', !hb.hidden && hb.shown && hb.text === 'Product Library' && hb.under && hb.bg === 'rgb(30, 122, 62)' && hb.color === 'rgb(255, 255, 255)' && hb.full, JSON.stringify(hb));
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-home"]').click()); await sleep(800);
  const dims = await A.evaluate(() => { const r = __BL.S.ui.root; const g = (e) => { const c = getComputedStyle(e); const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), pad: c.padding, fs: c.fontSize, fw: c.fontWeight, br: c.borderRadius, ta: c.textAlign, bg: c.backgroundColor }; }; return { add: g(r.querySelector('.addnote')), lib: g(r.querySelector('[data-x="lib-home"]')) }; });
  check('+ Add note and Product Library have identical width, height, padding, font size and weight, radius and alignment; only the colour differs (blue / green)', ['w', 'h', 'pad', 'fs', 'fw', 'br', 'ta'].every((k) => dims.add[k] === dims.lib[k]) && dims.add.bg === 'rgb(43, 78, 255)' && dims.lib.bg === 'rgb(30, 122, 62)', JSON.stringify(dims));
  const lv = () => A.evaluate(() => { const r = __BL.S.ui.root; const sel = r.querySelector('[data-lib="listsel"]'); return { open: !r.querySelector('[data-m="library"]').hidden, mgr: !r.querySelector('.lib-mgr').hidden, rows: r.querySelectorAll('.lib-list .lib-row').length, listId: __BL.libraryUi.L.listId, sel: sel.options[sel.selectedIndex]?.textContent, opts: [...sel.options].map((o) => o.textContent), label: r.querySelector('.lib-lsel').textContent.trim().slice(0, 5), manage: !!r.querySelector('[data-x="lib-lists"]')?.getClientRects().length, pencil: !!r.querySelector('[data-x="lib-name-edit"]'), head: r.querySelector('.lib-head').textContent.trim() }; });
  const lv1 = await lv();
  check('Clicking Product Library opens the products directly (no Manage Lists step), headed "List: [selected list]", with Manage lists below and no rename pencil', lv1.open && !lv1.mgr && lv1.rows >= 1 && lv1.label === 'List:' && /UX list/.test(lv1.sel) && lv1.manage && !lv1.pencil && lv1.head === 'Product Library', JSON.stringify(lv1));
  await A.keyboard.press('Escape'); await sleep(250);
  check('Esc from the main Product Library closes it in one press; the home button is still there', !(await lv()).open && !(await homeBtn()).hidden);
  // a second, independent list: the dropdown switches between them in the same window
  const lib2 = LibNode.decide({ ...lib, campaign: 'l-zz-second', name: 'Second list' }, 'sku:ACM400101', 'custom', 999);
  await A.evaluate((l) => BluelineLibrary.saveLibrary(chrome.storage.local, { ...l, campaign: 'l-zz-second', name: 'Second list' }, { smpChanged: true }), lib2);
  const rawFirst = await libRaw();
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-home"]').click()); await sleep(800);
  let lv2 = await lv();
  check('The dropdown lists every saved list, oldest first; the previously active list is open', lv2.opts.length === 2 && /UX list/.test(lv2.opts[0]) && /Second list/.test(lv2.opts[1]) && /UX list/.test(lv2.sel), JSON.stringify(lv2));
  await A.evaluate(() => { const sel = __BL.S.ui.root.querySelector('[data-lib="listsel"]'); sel.value = '1'; sel.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(600);
  const lv3 = await lv();
  check('Choosing another list shows it at once in the same window, with no list-selection modal and no manager', lv3.open && !lv3.mgr && lv3.listId === 'l-zz-second' && /Second list/.test(lv3.sel) && lv3.rows >= 1, JSON.stringify(lv3));
  const lrow = () => A.evaluate(() => { const r = __BL.S.ui.root.querySelector('.lib-row[data-key="sku:ACM400101"]'); return r ? r.innerText.replace(/\s+/g, ' ') : null; });
  const rowsOf = () => A.evaluate(() => [...__BL.S.ui.root.querySelectorAll('.lib-list .lib-row')].map((r) => r.dataset.key));
  const secondText = await lrow();
  check('The second list shows its OWN correction ($9.99 custom price) and carries its own store; the products on screen are the selected list’s', /9\.99/.test(secondText || '') && (await A.evaluate(() => __BL.libraryUi.L.lib.campaign === 'l-zz-second' && __BL.libraryUi.L.lib.store === __BL.libraryUi.L.store)) && (await A.evaluate(() => __BL.libraryUi.L.lib.store)) === ORIGIN4, secondText);
  await A.evaluate(() => { const i = __BL.S.ui.root.querySelector('[data-lib="search"]'); i.value = 'fish'; i.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(250);
  const fishRows = await rowsOf();
  check('Search applies to the selected list only', fishRows.length >= 1 && fishRows.every((k) => /999001/.test(k)) && (await A.evaluate(() => __BL.libraryUi.L.lib.campaign)) === 'l-zz-second');
  await A.evaluate(() => { const i = __BL.S.ui.root.querySelector('[data-lib="search"]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(150);
  await A.keyboard.press('Escape'); await sleep(250);
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-home"]').click()); await sleep(800);
  check('The last-used list is remembered: reopening shows the second list', (await lv()).listId === 'l-zz-second' && /Second list/.test((await lv()).sel));
  await A.evaluate(() => { const sel = __BL.S.ui.root.querySelector('[data-lib="listsel"]'); sel.value = '0'; sel.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(600);
  const firstText = await lrow();
  check('Switching back shows the first list with its own values; the second list’s correction is not there', !/9\.99/.test(firstText || '') && (await A.evaluate(() => __BL.libraryUi.L.lib.campaign)) === 'l-ux-a', firstText);
  check('Switching back restores the first list; neither list’s records changed by browsing', (await lv()).listId !== 'l-zz-second' && (await libRaw()).includes('l-zz-second') && JSON.stringify(JSON.parse(await libRaw())).length > 0 && JSON.stringify(Object.entries(JSON.parse(await libRaw())).filter(([k]) => !/l-zz-second/.test(k))) === JSON.stringify(Object.entries(JSON.parse(rawFirst)).filter(([k]) => !/l-zz-second/.test(k))));
  // Manage lists is still reachable, and Esc from it returns to the products without opening any list
  const openId = (await lv()).listId;
  // A real click focuses the button, which is hidden the moment the manager opens: Esc must still reach the window.
  await A.evaluate(() => { const b = __BL.S.ui.root.querySelector('[data-x="lib-lists"]'); b.focus(); b.click(); }); await sleep(400);
  check('Manage lists opens from its link under the dropdown', (await lv()).mgr);
  await A.keyboard.press('Escape'); await sleep(300);
  const lv4a = await lv();
  check('Esc inside Manage lists (opened by clicking its link) returns to the Product Library with the same list selected', lv4a.open && !lv4a.mgr && lv4a.listId === openId && lv4a.rows >= 1, JSON.stringify(lv4a));
  await A.evaluate(() => { const b = __BL.S.ui.root.querySelector('[data-x="lib-lists"]'); b.focus(); b.click(); }); await sleep(400);
  await A.evaluate(() => { const b = __BL.S.ui.root.querySelector('.lib-lm:not([data-cur]) [data-x="lib-lm-open"]'); b?.focus(); }); await sleep(100);
  await A.keyboard.press('Escape'); await sleep(300);
  const lv4 = await lv();
  check('Esc from Manage lists returns to the Product Library, even with an Open button focused: no list is opened or switched', lv4.open && !lv4.mgr && lv4.listId === openId, JSON.stringify(lv4));
  await A.keyboard.press('Escape'); await sleep(250);
  check('A second Esc closes the library', !(await lv()).open);
  await A.evaluate(([st, id]) => BluelineLibrary.deleteLibrary(chrome.storage.local, st, id), [ORIGIN4, 'l-zz-second']); await sleep(100);
  const libBefore = await libRaw();

  // ---- a first mapping on a NEW note with draft text: Map & Save creates the note with that text (there is no saved copy to write into)
  await shiftClick(A, await pointFor(A, NAME2, 'text'));
  await A.evaluate(() => { __BL.S.ui.root.querySelector('[data-d="card"]').open = true; }); await sleep(250);
  await t.click('[data-x="card-cancel"]'); await sleep(150);
  const fp = await A.evaluate(() => { const r = __BL.S.ui.root; const f = r.querySelector('[data-x="card-start"]'); const c = r.querySelector('[data-x="map-start"]'); const cs = f && getComputedStyle(f); const box = r.querySelector('.card-body').getBoundingClientRect(); return f ? { text: f.textContent.trim(), bg: cs.backgroundColor, color: cs.color, full: f.getBoundingClientRect().width > box.width * 0.9, first: !!(f.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING), chooseOff: c.disabled, chooseBg: getComputedStyle(c).backgroundColor } : null; });
  check('Before the card is confirmed, Find Product Card is the prominent first action (full-width green) and Choose Product waits, disabled, after it', !!fp && fp.text === 'Find Product Card' && fp.bg === 'rgb(30, 122, 62)' && fp.color === 'rgb(255, 255, 255)' && fp.full && fp.first && fp.chooseOff, JSON.stringify(fp));
  await t.click('[data-x="card-start"]'); await sleep(150);
  await t.click('[data-x="card-ok"]'); await sleep(150);
  check('After the card is confirmed, Choose Product is enabled', await A.evaluate(() => !__BL.S.ui.root.querySelector('[data-x="map-start"]').disabled));
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.pop-note').value = 'Draft words'; });
  await t.click('[data-x="map-start"]'); await sleep(600);
  await A.evaluate(() => { const i = __BL.S.ui.root.querySelector('[data-lib="sel-q"]'); i.value = 'zma'; i.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(200);
  await A.evaluate(() => __BL.S.ui.root.querySelector('.lib-sel-row[data-key="sku:ACM400101"]').click()); await sleep(600);
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-sel-use"]').click()); await sleep(300);
  const mdl = () => A.evaluate(() => { const r = __BL.S.ui.root; const m = __BL.libraryUi.L.map; const save = r.querySelector('[data-x="lib-map-save"]'); return { open: !!m && !r.querySelector('[data-m="library"]').hidden, text: r.querySelector('.lib-map-body')?.textContent.replace(/\s+/g, ' ').trim() || '', foot: r.querySelector('.lib-map-foot')?.textContent.replace(/\s+/g, ' ').trim() || '', cta: save?.textContent.trim(), ctaOff: save?.disabled, err: r.querySelector('.lib-map-body .lib-vv-notice.bad')?.textContent.replace(/\s+/g, ' ').trim() || '', draft: m?.draft ? JSON.parse(JSON.stringify(m.draft)) : null, badges: [...r.querySelectorAll('.lib-map-st > span')].map((d) => d.textContent.replace(/\s+/g, ' ').trim()).join(' / ') }; });
  const mc = (x) => A.evaluate((x) => { __BL.S.ui.root.querySelector(`[data-x="${x}"]`).click(); }, x).then(() => sleep(350));
  const mSave = async () => { await mc('lib-map-save'); await sleep(600); };
  const stored = () => A.evaluate(() => chrome.storage.local.get('blueline:batch').then((r) => JSON.stringify(r['blueline:batch'])));
  await mSave();
  const n0 = await t.item(0);
  check('On a brand-new note, Map & Save creates the note with its draft text and the mapping in one step, and closes the editor', n0.note === 'Draft words' && n0.productMapping?.variant?.variantId === '4444444444' && !(await A.evaluate(() => !!__BL.S.pop)) && !(await mdl()).open);

  // ---- no duplicate numbered pins for a mapped note; the green badge stays; other notes keep their pin
  await shiftClick(A, await pointFor(A, NAME1, 'text'));
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.pop-note').value = 'Plain note'; });
  await t.save('Plain note');
  await sleep(400);
  const pins = await A.evaluate(() => {
    const r = __BL.S.ui.root;
    const cs = (b) => getComputedStyle(b).display;
    const cardRect = (n) => document.querySelector(`#rail-feat > article:nth-child(${n})`).getBoundingClientRect();
    const inside = (el, rc) => { const b = el.getBoundingClientRect(); return b.left >= rc.left - 40 && b.left <= rc.right && b.top >= rc.top - 40 && b.top <= rc.bottom; };
    const pinsOn = (n) => [...r.querySelectorAll('.x-marksbox .mk .bd')].filter((b) => cs(b) !== 'none' && inside(b, cardRect(n))).map((b) => b.textContent);
    return { mapped: pinsOn(2), plain: pinsOn(1), badges: r.querySelectorAll('.x-pmbox .pmb').length, listItems: r.querySelectorAll('.list .item').length };
  });
  check('The mapped card has no blue numbered pin (only its green badge); the unmapped note keeps its numbered pin; both notes still exist', pins.mapped.length === 0 && pins.plain.length === 1 && pins.badges === 1 && pins.listItems === 2, JSON.stringify(pins));
  await t.reopen(0); await sleep(300);
  check('The underlying mapped note still opens normally from the list', await A.evaluate(() => !!__BL.S.pop && __BL.toolsApi.getP().mapping?.product?.key === 'sku:ACM400101'));
  await t.click('[data-act="pop-cancel"]'); await sleep(200);

  // ---- pending, cancelled, saved and failed replacement states on the badge
  const badge = () => A.evaluate(() => { const bs = [...__BL.S.ui.root.querySelectorAll('.x-pmbox .pmb')]; return { n: bs.length, text: bs[0]?.textContent || '', cls: bs[0]?.className || '', label: bs[0]?.getAttribute('aria-label') || '' }; });
  let b0 = await badge();
  check('Before editing, the badge shows the saved product', b0.n === 1 && /^Mapped · Acme ZMA/.test(b0.text) && !/pend/.test(b0.cls), JSON.stringify(b0));
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.x-pmbox .pmb').click(); }); await sleep(600);
  let m = await mdl();
  check('The badge opens Product Mapping directly; with nothing changed the action is disabled and there are no unsaved changes', m.open && m.cta === 'Save Mapping' && m.ctaOff && /Saved/.test(m.badges) && !(await A.evaluate(() => !!__BL.S.pop)));
  await mc('lib-map-product'); await sleep(300);
  await A.evaluate(() => { const i = __BL.S.ui.root.querySelector('[data-lib="sel-q"]'); i.value = 'fish'; i.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(150);
  await A.evaluate(() => __BL.S.ui.root.querySelector('.lib-sel-row[data-key="sku:ACM999001"]').click()); await sleep(700);
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-sel-use"]').click()); await sleep(300);
  m = await mdl(); b0 = await badge();
  check('An unsaved replacement is visibly proposed on the page ("Proposed … not saved", dashed), with a single badge on the card and no claim that it was saved', b0.n === 1 && /^Proposed · Acme Fish Oil/.test(b0.text) && /not saved/.test(b0.text) && /pend/.test(b0.cls) && /Not saved yet/.test(b0.label) && !/Mapped/.test(b0.text), JSON.stringify(b0));
  check('The saved note is untouched while it is pending', (await t.item(0)).productMapping.variant.variantId === '4444444444' && m.cta === 'Approve & Save Replacement');
  await mc('lib-map-cancel');
  b0 = await badge();
  check('Cancel discards the pending change: the badge shows the saved product again and the saved mapping is unchanged', b0.n === 1 && /^Mapped · Acme ZMA/.test(b0.text) && !/pend/.test(b0.cls) && !(await mdl()).open && (await t.item(0)).productMapping.variant.variantId === '4444444444');
  // Esc, ✕ and Cancel all close at once: no confirmation, no Keep editing / Discard buttons
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.x-pmbox .pmb').click(); }); await sleep(500);
  await A.evaluate(() => { const i = __BL.S.ui.root.querySelector('.lib-map-body input[data-lib="map-f"][data-f="title"]'); i.value = 'Unsaved title'; i.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(150);
  m = await mdl();
  const hd = await A.evaluate(() => { const r = __BL.S.ui.root; const h = r.querySelector('.lib-head').textContent.trim(); const hs = [...r.querySelectorAll('.lib-sheet')].flatMap((x) => [...x.querySelectorAll('.lib-map-h, .lib-head')]).filter((e) => e.getClientRects().length && /Product Mapping/.test(e.textContent)).length; const foot = [...r.querySelectorAll('.lib-map-foot button')].map((b) => b.textContent.trim()); const sv = r.querySelector('[data-x="lib-map-save"]'); const cn = r.querySelector('[data-x="lib-map-cancel"]'); return { h, hs, foot, ctx: r.querySelector('.lib-map-h').textContent.trim(), saveRight: sv.getBoundingClientRect().left > cn.getBoundingClientRect().left, saveBg: getComputedStyle(sv).backgroundColor, saveOn: !sv.disabled, saveVisible: sv.getBoundingClientRect().bottom <= innerHeight + 1 }; });
  check('While editing, the footer is exactly Cancel | Save Mapping, Save is on the right, blue, enabled and in view', JSON.stringify(hd.foot) === JSON.stringify(['Cancel', 'Save Mapping']) && hd.saveRight && hd.saveBg === 'rgb(43, 78, 255)' && hd.saveOn && hd.saveVisible, JSON.stringify(hd));
  check('"Product Mapping" appears once at the top, and the card position context stays', hd.hs === 1 && /^Card \d+ of \d+/.test(hd.ctx), JSON.stringify(hd));
  await A.keyboard.press('Escape'); await sleep(250);
  check('Esc closes the window at once (no confirmation); the unsaved edit is thrown away and the saved product is back on the badge', !(await mdl()).open && !(await t.item(0)).productMapping.overrides && /^Mapped/.test((await badge()).text) && !(await A.evaluate(() => /Keep editing|Discard/.test(__BL.S.ui.root.querySelector('.lib-sheet').textContent))));
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.x-pmbox .pmb').click(); }); await sleep(500);
  await A.evaluate(() => { const i = __BL.S.ui.root.querySelector('.lib-map-body input[data-lib="map-f"][data-f="title"]'); i.value = 'Unsaved title'; i.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(150);
  await A.evaluate(() => { __BL.S.ui.root.querySelector('[data-x="lib-close"]').click(); }); await sleep(250);
  check('✕ closes at once too, discarding the edit', !(await mdl()).open && !(await t.item(0)).productMapping.overrides && /^Mapped/.test((await badge()).text));
  // Esc closes only the topmost layer: the picker, then the window
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.x-pmbox .pmb').click(); }); await sleep(500);
  await mc('lib-map-product'); await sleep(400);
  await A.keyboard.press('Escape'); await sleep(300);
  check('Esc with the product picker open closes only the picker; Product Mapping is still open', (await mdl()).open && !(await A.evaluate(() => !!__BL.libraryUi.L.sel)));
  await A.keyboard.press('Escape'); await sleep(300);
  check('A second Esc closes Product Mapping', !(await mdl()).open);
  // a failed save keeps the saved mapping and says so; the approval does not exist anywhere until it is saved
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.x-pmbox .pmb').click(); }); await sleep(500);
  await mc('lib-map-product'); await sleep(300);
  await A.evaluate(() => { const i = __BL.S.ui.root.querySelector('[data-lib="sel-q"]'); i.value = 'fish'; i.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(150);
  await A.evaluate(() => __BL.S.ui.root.querySelector('.lib-sel-row[data-key="sku:ACM999001"]').click()); await sleep(700);
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-sel-use"]').click()); await sleep(300);
  const storedBefore = await stored();
  await A.evaluate(() => { window.__realSet = chrome.storage.local.set; chrome.storage.local.set = () => Promise.reject(new Error('disk full')); });
  await mSave();
  m = await mdl(); b0 = await badge();
  check('A failed save shows a clear error, keeps the window open with the proposed change, and nothing is approved or saved', m.open && /Not saved\./.test(m.err) && /disk full/.test(m.err) && /saved mapping is unchanged/.test(m.err) && /Not saved yet/.test(m.badges) && /Different SKU: approval required/.test(m.badges) && m.cta === 'Approve & Save Replacement' && !m.ctaOff, JSON.stringify([m.err, m.badges]));
  check('After the failure the saved mapping (in memory and in storage) is exactly as before, and the badge does not claim success', (await t.item(0)).productMapping.variant.variantId === '4444444444' && (await stored()) === storedBefore && /pend/.test(b0.cls) && /not saved/.test(b0.text));
  await A.evaluate(() => { chrome.storage.local.set = window.__realSet; });
  await mSave();
  b0 = await badge();
  const pm1 = (await t.item(0)).productMapping;
  check('Trying again with storage working saves it: persisted, the window closes and the badge shows the new product', pm1.variant.sku === 'ACM999001' && pm1.product.key === 'sku:ACM999001' && !(await mdl()).open && b0.n === 1 && /^Mapped · Acme Fish Oil/.test(b0.text) && !/pend/.test(b0.cls), JSON.stringify([pm1.variant, b0]));
  check('The Product Library records are unchanged by all of this', (await libRaw()) === libBefore);

  // ---- an open editor's unsaved draft is neither saved nor discarded when the mapping is saved from the window
  await t.reopen(0); await sleep(300);
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.pop-note').value = 'Unsaved draft text'; __BL.S.ui.root.querySelector('.pop-note').dispatchEvent(new Event('input', { bubbles: true })); });
  await t.click('[data-x="tool-css"]'); await t.setCss('color', '#118833'); await sleep(150);
  const noteBefore = (await t.item(0)).note;
  await t.click('[data-x="map-start"]'); await sleep(500);
  await A.evaluate(() => { const i = __BL.S.ui.root.querySelector('.lib-map-body input[data-lib="map-f"][data-f="title"]'); i.value = 'Hero Fish'; i.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(150);
  m = await mdl();
  check('Editing a value on a saved mapping offers Save Mapping (not a replacement)', m.cta === 'Save Mapping' && !m.ctaOff);
  await mSave();
  const kept = await A.evaluate(() => ({ note: __BL.S.ui.root.querySelector('.pop-note').value, open: !!__BL.S.pop, css: [...__BL.S.ui.root.querySelectorAll('.css-changes .chg')].length, mapDirty: __BL.toolsApi.getP().mapDirty, title: __BL.toolsApi.getP().mapping.overrides?.title }));
  const itemNow = await t.item(0);
  check('Save Mapping persisted just the mapping: the note editor is still open with its unsaved text and CSS edit, and the saved note text and CSS are unchanged', itemNow.productMapping.overrides.title === 'Hero Fish' && itemNow.note === noteBefore && !(itemNow.elementEdits || []).some((e) => (e.tweaks || []).some((x) => x.prop === 'color')) && kept.open && kept.note === 'Unsaved draft text' && kept.css >= 1 && kept.mapDirty === false && kept.title === 'Hero Fish', JSON.stringify([kept, itemNow.note]));
  await t.save();
  const itemAfter = await t.item(0);
  check('Update note then saves the draft as well, and the mapping is intact', itemAfter.note === 'Unsaved draft text' && itemAfter.productMapping.overrides.title === 'Hero Fish');

  // ---- a read-only Shopify check never touches overrides or approved prices
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.x-pmbox .pmb').click(); }); await sleep(500);
  const before = JSON.stringify((await t.item(0)).productMapping);
  await mc('lib-map-shopify'); await sleep(900);
  m = await mdl();
  const d = m.draft;
  check('Check Shopify completes with a visible result and leaves the page-specific title and the approved prices exactly as they were', /Shopify check complete/.test(m.text) && d.overrides.title === 'Hero Fish' && JSON.stringify(d) === before && JSON.stringify((await t.item(0)).productMapping) === before && m.ctaOff === true);
  await mc('lib-map-cancel');
  // ---- picker -> Product Mapping, end to end, and the exact state of the footer (rendering, visibility, enabled)
  const foot = () => A.evaluate(() => { const r = __BL.S.ui.root; const sv = r.querySelector('[data-x="lib-map-save"]'); const cn = r.querySelector('[data-x="lib-map-cancel"]'); const b = sv?.getBoundingClientRect(); const cs = sv && getComputedStyle(sv); const sheet = r.querySelector('.lib-sheet').getBoundingClientRect(); return { btns: [...r.querySelectorAll('.lib-map-foot button')].map((x) => x.textContent.trim()), cta: sv?.textContent.trim(), bg: cs?.backgroundColor, color: cs?.color, on: !!sv && !sv.disabled, shown: !!b && b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none', inView: !!b && b.top >= 0 && b.bottom <= innerHeight && b.bottom <= sheet.bottom + 1, right: !!b && b.left > cn.getBoundingClientRect().left, badges: [...r.querySelectorAll('.lib-map-st > span')].map((x) => x.textContent.trim()) }; });
  const pick = async (q, key) => {
    await mc('lib-map-product'); await sleep(400);
    await A.evaluate((q) => { const i = __BL.S.ui.root.querySelector('[data-lib="sel-q"]'); i.value = q; i.dispatchEvent(new Event('input', { bubbles: true })); }, q); await sleep(200);
    await A.evaluate((k) => __BL.S.ui.root.querySelector(`.lib-sel-row[data-key="${k}"]`).click(), key); await sleep(700);
    const useLabel = await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-sel-use"]')?.textContent.trim());
    await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-sel-use"]').click()); await sleep(400);
    return useLabel;
  };
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.x-pmbox .pmb').click(); }); await sleep(500);
  const saved0 = JSON.stringify((await t.item(0)).productMapping);
  const useLabel = await pick('zma', 'sku:ACM400101');
  let f1 = await foot();
  check('Picker: "Use this product" only proposes (blue); back in Product Mapping the new product and exact variant are shown and the saved mapping is untouched', useLabel === 'Use this product' && (await mdl()).open && (await mdl()).draft.variant.variantId === '4444444444' && /Acme ZMA/.test((await mdl()).text) && /Variant ID 4444444444/.test((await mdl()).text) && JSON.stringify((await t.item(0)).productMapping) === saved0, useLabel);
  check('A different-SKU replacement shows the GREEN "Approve & Save Replacement": rendered, visible in the window, enabled, on the right, white text; the footer is only Cancel | Approve & Save Replacement', f1.cta === 'Approve & Save Replacement' && f1.bg === 'rgb(30, 122, 62)' && f1.color === 'rgb(255, 255, 255)' && f1.on && f1.shown && f1.inView && f1.right && JSON.stringify(f1.btns) === JSON.stringify(['Cancel', 'Approve & Save Replacement']), JSON.stringify(f1));
  check('The status row says approval is required and the replacement is not saved', f1.badges.includes('Different SKU: approval required') && f1.badges.includes('Not saved yet') && !f1.badges.includes('Saved'), JSON.stringify(f1.badges));
  const hd2 = await A.evaluate(() => { const r = __BL.S.ui.root; const st = r.querySelector('.lib-map-st'); const bs = [...st.children]; return { n: bs.length, labels: bs.map((b) => b.getAttribute('aria-label')), keys: r.querySelectorAll('.lib-map-k').length, sameRow: bs.every((b) => Math.abs(b.getBoundingClientRect().top - bs[0].getBoundingClientRect().top) < 3), text: st.textContent.replace(/\s+/g, ' ').trim(), upper: /\b(APPROVAL|SHOPIFY|SAVED)\b/.test(r.querySelector('.lib-map-body').textContent) || /^(Approval|Shopify|Saved)\b/.test(st.textContent.trim()) }; });
  check('The three status badges stand alone in one row (no APPROVAL / SHOPIFY / SAVED headings), keep their order, and have accessible names', hd2.n === 3 && hd2.keys === 0 && hd2.sameRow && !hd2.upper && /^Approval: /.test(hd2.labels[0]) && /^Shopify check: /.test(hd2.labels[1]) && /^Saved state: /.test(hd2.labels[2]) && hd2.text === 'Different SKU: approval required Not checked yet Not saved yet', JSON.stringify(hd2));
  // a save that fails and is retried, while another writer replaces the in-memory view mid-save
  const stBefore = await stored();
  await A.evaluate(() => { window.__realSet2 = chrome.storage.local.set; chrome.storage.local.set = () => Promise.reject(new Error('quota exceeded')); });
  await mSave();
  let m2 = await mdl(); f1 = await foot();
  check('A failed save keeps the window open, the proposed replacement and the green button for a retry; nothing was approved or stored', m2.open && /Not saved\./.test(m2.err) && /quota exceeded/.test(m2.err) && f1.cta === 'Approve & Save Replacement' && f1.on && f1.inView && (await stored()) === stBefore && !m2.badges.includes('Replacement approved'), m2.err);
  await A.evaluate(() => { chrome.storage.local.set = window.__realSet2; });
  await A.evaluate(() => {
    // while the save runs, another save arrives and the in-memory notes are replaced (as happens with a second tab or an earlier write finishing late)
    const realGet = chrome.storage.local.get.bind(chrome.storage.local);
    let first = true;
    chrome.storage.local.get = async (k) => { const r = await realGet(k); if (first) { first = false; const b = (await realGet('blueline:batch'))['blueline:batch']; await chrome.storage.local.set({ 'blueline:batch': JSON.parse(JSON.stringify(b)) }); await new Promise((x) => setTimeout(x, 150)); } return r; };
    window.__restoreGet = () => { chrome.storage.local.get = realGet; };
  });
  await mSave(); await sleep(500);
  await A.evaluate(() => window.__restoreGet());
  const pm2 = (await t.item(0)).productMapping;
  check('The retry saves although the in-memory notes were replaced mid-save: exact variant ID, card-scoped approval recorded (from the old SKU to the new), window closed, badge updated', pm2.variant.variantId === '4444444444' && pm2.variant.sku === 'ACM400101' && pm2.replacement?.status === 'approved' && pm2.replacement.fromSku === 'ACM999001' && pm2.replacement.toSku === 'ACM400101' && !(await mdl()).open && /^Mapped · Acme ZMA/.test((await badge()).text), JSON.stringify(pm2.replacement));
  await reboot();
  const pm3 = (await t.item(0)).productMapping;
  await sleep(300);
  check('It survives reopening Blueline: the stored mapping, the approval and the badge are still there', pm3.variant.variantId === '4444444444' && pm3.replacement?.status === 'approved' && /^Mapped · Acme ZMA/.test((await badge()).text) && (await libRaw()) === libBefore);
  // value-only change on this saved mapping (Save Mapping) persists with the approval and exact variant kept
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.x-pmbox .pmb').click(); }); await sleep(500);
  await A.evaluate(() => { const i = __BL.S.ui.root.querySelector('.lib-map-body input[data-lib="map-f"][data-f="title"]'); i.value = 'ZMA hero'; i.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(150);
  f1 = await foot();
  check('A value-only edit offers the blue "Save Mapping"', f1.cta === 'Save Mapping' && f1.bg === 'rgb(43, 78, 255)' && f1.on && f1.inView, JSON.stringify(f1));
  await mSave();
  const pm4 = (await t.item(0)).productMapping;
  check('Save Mapping persists the override, keeps the exact variant and the approval, closes the window and updates the badge', pm4.overrides?.title === 'ZMA hero' && pm4.variant.variantId === '4444444444' && pm4.replacement?.status === 'approved' && !(await mdl()).open && /ZMA hero/.test((await badge()).text + (await badge()).label));
  // a different product whose SKU is missing (so it can't be shown to match) still asks for approval
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.x-pmbox .pmb').click(); }); await sleep(500);
  await A.evaluate(() => { const m = __BL.libraryUi.L.map; m.draft = { ...m.draft, product: { ...m.draft.product, key: 'name:other-thing', sku: null }, variant: { ...m.draft.variant, sku: null, variantId: '777' } }; const i = __BL.S.ui.root.querySelector('.lib-map-body input[data-lib="map-f"][data-f="title"]'); i.value = 'Other thing'; i.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(200);
  f1 = await foot();
  check('A different product with no SKU on it still needs approval: green "Approve & Save Replacement"', f1.cta === 'Approve & Save Replacement' && f1.bg === 'rgb(30, 122, 62)' && f1.on, JSON.stringify(f1));
  await mc('lib-map-cancel');
  // a same-SKU change of the variant id is a plain replacement, not an approval
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.x-pmbox .pmb').click(); }); await sleep(500);
  await A.evaluate(() => { const m = __BL.libraryUi.L.map; m.draft = { ...m.draft, variant: { ...m.draft.variant, variantId: '4444444999' } }; const i = __BL.S.ui.root.querySelector('.lib-map-body input[data-lib="map-f"][data-f="title"]'); i.value = 'ZMA hero 2'; i.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(200);
  f1 = await foot();
  check('A replacement with the same SKU needs no approval: blue "Replace & Save"', f1.cta === 'Replace & Save' && f1.bg === 'rgb(43, 78, 255)' && f1.on, JSON.stringify(f1));
  await mc('lib-map-cancel');
  check('Cancelling leaves the saved mapping exactly as it was', (await t.item(0)).productMapping.overrides.title === 'ZMA hero' && (await t.item(0)).productMapping.variant.variantId === '4444444444');
  // ---- Live save state: typing alone (no blur / change / Enter / Tab) updates Save Mapping
  const typeIn = async (f, v) => { await A.evaluate((f, v) => { const i = __BL.S.ui.root.querySelector(`.lib-map-body input[data-lib="map-f"][data-f="${f}"]`); i.focus(); i.value = v; i.setSelectionRange(v.length, v.length); i.dispatchEvent(new Event('input', { bubbles: true })); }, f, v); await sleep(60); };
  const liveSt = () => A.evaluate(() => { const r = __BL.S.ui.root; const sv = r.querySelector('[data-x="lib-map-save"]'); const ae = r.activeElement; return { off: sv.disabled, cta: sv.textContent.trim(), ferr: r.querySelector('.lib-map-ferr')?.textContent || '', focus: ae?.dataset?.f || null, val: ae?.value ?? null, caret: ae?.selectionStart ?? null, why: r.querySelector('.lib-sel-why')?.textContent || '' }; });
  const origVals = () => A.evaluate(() => Object.fromEntries([...__BL.S.ui.root.querySelectorAll('.lib-map-body input[data-lib="map-f"]')].map((i) => [i.dataset.f, i.value])));
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.x-pmbox .pmb').click(); }); await sleep(500);
  const ov0 = await origVals();
  const st0 = await liveSt();
  check('Live save: before any edit Save Mapping is disabled', st0.off === true && st0.cta === 'Save Mapping', JSON.stringify(st0));
  const goodVals = { title: 'Live title', image: 'https://img.example.com/live.png', regularCents: '31.50', promoCents: '25.25', url: 'https://example.com/live' };
  for (const f of ['title', 'image', 'regularCents', 'promoCents', 'url']) {
    await typeIn(f, goodVals[f]);
    const st = await liveSt();
    check(`Live save: typing in ${f} enables Save Mapping immediately, without blur, and keeps focus, text and caret`, st.off === false && st.focus === f && st.val === goodVals[f] && st.caret === goodVals[f].length, JSON.stringify(st));
    await typeIn(f, ov0[f]);
    const rv = await liveSt();
    check(`Live save: restoring ${f} to its saved value disables Save Mapping again`, rv.off === true, JSON.stringify(rv));
  }
  await typeIn('regularCents', 'abc');
  let bad = await liveSt();
  check('Live save: an invalid price disables Save, shows the validation message and keeps what was typed', bad.off === true && /price such as/.test(bad.ferr) && bad.val === 'abc' && /Fix the highlighted/.test(bad.why), JSON.stringify(bad));
  await typeIn('regularCents', '31.');
  bad = await liveSt();
  check('Live save: a half-typed price ("31.") stays as typed and is accepted as 31.00', bad.val === '31.' && bad.off === false, JSON.stringify(bad));
  await typeIn('regularCents', ov0.regularCents);
  await typeIn('url', 'ftp://nope');
  bad = await liveSt();
  check('Live save: an invalid link disables Save with a message', bad.off === true && /web address/.test(bad.ferr), JSON.stringify(bad));
  await typeIn('url', ov0.url);
  await typeIn('image', 'not a url');
  bad = await liveSt();
  check('Live save: an invalid image URL disables Save with a message', bad.off === true && /web address/.test(bad.ferr), JSON.stringify(bad));
  await typeIn('image', ov0.image);
  check('Live save: after fixing every invalid field Save is disabled (nothing changed) and nothing was auto-saved', (await liveSt()).off === true && (await t.item(0)).productMapping.overrides?.title === 'ZMA hero');
  // an edit reverted from an override: Reset updates the state immediately
  await typeIn('title', 'Reset me');
  await A.evaluate(() => { __BL.S.ui.root.querySelector('[data-x="lib-map-reset"][data-f="title"]').click(); }); await sleep(80);
  const afterReset = await liveSt();
  const defTitle = (await origVals()).title;
  check('Live save: typing then Reset restores the default and updates Save immediately (Save follows the saved override, "ZMA hero" differs from the default so it is enabled)', afterReset.off === false && defTitle !== 'ZMA hero' && defTitle !== 'Reset me', JSON.stringify([afterReset, defTitle]));
  await A.evaluate(() => { const b = __BL.S.ui.root.querySelector('[data-x="lib-map-reset-all"]'); if (b) b.click(); }); await sleep(80);
  const afterAll = await liveSt();
  check('Live save: Reset all updates Save immediately (overrides removed differ from the saved mapping)', afterAll.off === false, JSON.stringify(afterAll));
  await mc('lib-map-cancel');
  // Save clicked while the edited field still has focus saves the entered value, nothing earlier
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.x-pmbox .pmb').click(); }); await sleep(500);
  await typeIn('title', 'Focused save');
  check('Live save: nothing is stored while typing', (await t.item(0)).productMapping.overrides?.title === 'ZMA hero');
  await A.evaluate(() => { __BL.S.ui.root.querySelector('[data-x="lib-map-save"]').click(); }); await sleep(600);
  const pm5 = (await t.item(0)).productMapping;
  check('Live save: clicking Save Mapping while the field is still focused saves the typed value and keeps the exact variant and the approval', pm5.overrides?.title === 'Focused save' && pm5.variant.variantId === '4444444444' && pm5.replacement?.status === 'approved' && !(await mdl()).open, JSON.stringify([pm5.overrides, pm5.variant.variantId, pm5.replacement]));
  // Esc/Cancel still discard a live edit
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.x-pmbox .pmb').click(); }); await sleep(500);
  await typeIn('title', 'Discard me');
  await A.evaluate(() => { __BL.S.ui.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await sleep(150);
  check('Live save: Esc after live typing closes at once and discards it', !(await mdl()).open && (await t.item(0)).productMapping.overrides?.title === 'Focused save');
  check('Page errors', A.errors.length === 0, A.errors.join(' | '));
  await A.close();
}

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
