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

async function open(fixture) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(pathToFileURL(join(here, 'fixtures', fixture)).href);
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
    await page.evaluate(() => __BL.S.ui.root.querySelector('[data-x="tool-measure"]').click());
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
    await page.evaluate(() => __BL.S.ui.root.querySelector('[data-x="tool-measure"]').click());
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

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
