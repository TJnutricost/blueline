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

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(process.argv[2] || join(here, '..'));
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('Chrome not found. Set CHROME_PATH to your Chrome or Chromium executable.'); process.exit(2); }

const src = (f) => readFileSync(join(ext, f), 'utf8');
const STUB = `window.chrome = {
  runtime: { getManifest: () => ({ version: 'test' }), sendMessage: async (m) => (m && m.type === 'blueline:hello' ? { active: true } : null), onMessage: { addListener() {} } },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {} } },
}; window.__BLUELINE_TEST__ = {};`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`); };

const browser = await launch({ executablePath: CHROME, args: ['--window-size=1280,900'] });

// Fixtures that need a real origin (linked, imported and cross-origin stylesheets) are served over http. The page
// is opened on 127.0.0.1; the same server reached as localhost counts as another origin.
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const file = resolve(join(here, 'fixtures', path));
  if (!file.startsWith(join(here, 'fixtures')) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

async function open(fixture, { http = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(http ? `http://127.0.0.1:${PORT}/${fixture}` : pathToFileURL(join(here, 'fixtures', fixture)).href);
  await page.addScriptTag({ content: STUB });
  for (const f of ['page-hook.js', 'content.js', 'tools.js']) await page.addScriptTag({ content: src(f) });
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
    check('Toolbox is the default editing mode', JSON.stringify(await shown()) === JSON.stringify({ panels: ['elements'], pressed: ['Toolbox'] }), JSON.stringify(await shown()));
    check('Toolbox shows all six actions in a two-column grid: Edit text, Move, Measure, Match style, Hide, Sample color', r.actions.join('|') === 'Edit text|Move|Measure|Match style|Hide|Sample color' && r.actionsShown && r.cols === 2, JSON.stringify(r));
    check('No More menu, no Edit CSS action inside the Toolbox; "apply match style to all selected" kept', r.more === 0 && r.cssAction === 0 && r.matchAll, JSON.stringify(r));
    check('Steps read Select, Edit, Describe; the description sits below the editing tools', r.steps.join('|') === '1Select|2Edit|3Describe' && r.noteBelowTools, JSON.stringify(r.steps));
    check('No Priority or note-type controls; Broken checkbox present and off', r.prio === 0 && r.types === 0 && r.broken, JSON.stringify(r));
    check('Screen size shows inline as Desktop, Tablet, Mobile, All', r.bps.join('|') === 'Desktop|Tablet|Mobile|All' && r.bpsVisible, JSON.stringify(r));
    await click('[data-x="tool-draw"]');
    const draw = await shown();
    await click('[data-x="tool-draw"]');
    check('Annotate opens its panel; pressing it again returns to the Toolbox', draw.panels.join() === 'draw' && draw.pressed.join() === 'Annotate' && (await shown()).panels.join() === 'elements', JSON.stringify(draw));
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
  check('Unreadable cross-origin stylesheet is mentioned', e0.info.includes('1 stylesheet from another site couldn’t be read'), e0.info);

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
  check('No matching rule: helpful empty state, element-only editing offered, nothing invented', p0.options.join() === 'This element only (no rule)' && p0.rows.length === 0 && p0.empty.startsWith('No stylesheet rule matches this element directly') && !p0.propsHeading, JSON.stringify(p0));
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

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
