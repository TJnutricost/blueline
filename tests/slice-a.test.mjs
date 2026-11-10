// Slice A focused browser tests: Home "Products" section, Assign Products import empty state / import availability /
// immediate list refresh / preservation of staged work. Same harness as run.mjs, but only these checks.
//
// Usage: node slice-a.test.mjs [extension-dir]   (from tests/)
import { launch } from './cdp.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { PRODUCTS } from './fake-store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(process.argv[2] || join(here, '..'));
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('Chrome not found. Set CHROME_PATH.'); process.exit(2); }

const LibNode = createRequire(import.meta.url)(join(ext, 'library.js'));
const src = (f) => readFileSync(join(ext, f), 'utf8');
const STUB = `window.chrome = {
  runtime: { id: 'blueline-test', getManifest: () => ({ version: 'test' }), sendMessage: async (m) => (m && m.type === 'blueline:hello' ? { active: true } : null), onMessage: { addListener() {} } },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {} } },
}; window.__BLUELINE_TEST__ = {};`;
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
async function open(fixture, { seed = null } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(pathToFileURL(join(here, 'fixtures', fixture)).href);
  await page.addScriptTag({ content: STUB });
  await page.addScriptTag({ content: REAL_STORAGE });
  if (seed) await page.evaluate((s) => chrome.storage.local.set(s), seed);
  for (const f of ['page-hook.js', 'content.js', 'library.js', 'cards.js', 'tools.js', 'library-ui.js']) await page.addScriptTag({ content: src(f) });
  await page.waitForFunction(() => window.__BL?.S?.active && window.__BL.S.ui);
  await sleep(150);
  return page;
}
const xClick = async (P, x, ms = 350) => { await P.evaluate((x) => __BL.S.ui.root.querySelector(`[data-x="${x}"]`).click(), x); await sleep(ms); };
const reboot = async (P) => { await P.evaluate(() => __BLUELINE_TEST__.api.setActive(false)); await sleep(500); await P.evaluate(() => __BLUELINE_TEST__.api.setActive(true)); await sleep(800); };

const CSV1 = 'Section,SKU,Product Name,Original Price,Sale Price\nFeatured,ACM400101,Acme ZMA Capsules,$27.97,$19.99\nFeatured,ACM999001,Acme Fish Oil Softgels,$30.97,\n';
const CSV2 = 'Section,SKU,Product Name,Original Price,Sale Price\nSpring,ACM200101,Acme Charcoal,$15.99,\nSpring,ACM100101,Acme Black Seed Oil,$19.97,$14.99\n';

// Feeds a file to the workspace's own file input (the same path as choosing it in the picker).
const pickFile = (P, name, text) => P.evaluate((name, text) => {
  const inp = __BL.S.ui.root.querySelector('[data-lib="sel-file"]');
  if (!inp) return false;
  const dt = new DataTransfer(); dt.items.add(new File([text], name)); inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, name, text);
const dropFile = (P, name, text) => P.evaluate((name, text) => {
  const dt = new DataTransfer(); dt.items.add(new File([text], name));
  __BL.S.ui.root.querySelector('[data-m="library"]').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, name, text);
const picker = (P) => P.evaluate(() => {
  const r = __BL.S.ui.root; const sel = r.querySelector('[data-lib="sel-list"]');
  const cta = r.querySelector('.lib-sel-empty [data-x="lib-sel-import"]'); const more = r.querySelector('.lib-sel-imp [data-x="lib-sel-import"]');
  const b = (e) => !!e && e.getBoundingClientRect().height > 0;
  return {
    open: !!__BL.libraryUi.L.bulk, head: r.querySelector('.lib-head')?.textContent,
    options: sel ? [...sel.options].map((o) => ({ v: o.value, t: o.textContent })) : [], selected: sel?.value || null,
    cta: b(cta), ctaText: cta?.textContent.trim(), more: b(more), moreText: more?.textContent.trim(),
    note: r.querySelector('.lib-sel-body .lib-vv-notice')?.textContent.trim() || '',
  };
});
const lists = (P) => P.evaluate(async () => { const idx = await BluelineLibrary.loadIndex(chrome.storage.local); return idx.libs.map((l) => `${l.store}|${l.campaign}`); });
const libJson = (P, key) => P.evaluate(async (key) => { const [store, id] = [key.slice(0, key.lastIndexOf('|')), key.slice(key.lastIndexOf('|') + 1)]; return JSON.stringify(await BluelineLibrary.loadLibrary(chrome.storage.local, store, id)); }, key);

console.log('\n# Slice A: Products navigation and Assign Products import (fixtures/card-groups.html)');
{
  const A = await open('card-groups.html');

  // ---- Home
  const home = () => A.evaluate(() => {
    const r = __BL.S.ui.root; const rb = (e) => e.getBoundingClientRect(); const sec = r.querySelector('[data-d="products"]'); const add = r.querySelector('.addnote');
    const lib = r.querySelector('[data-x="lib-home"]'); const asg = r.querySelector('[data-x="assign-home"]');
    return {
      sec: !!sec, open: !!sec?.open, summary: sec?.querySelector('summary')?.firstChild?.textContent.trim(),
      libVisible: !!lib && rb(lib).height > 0, asgVisible: !!asg && rb(asg).height > 0, libText: lib?.querySelector('b')?.textContent, asgText: asg?.querySelector('b')?.textContent,
      inside: !!sec && sec.contains(lib) && sec.contains(asg), define: !!r.querySelector('[data-x="define-home"]'), greenBtns: r.querySelectorAll('.xb.plib').length,
      moreImport: !!r.querySelector('[data-x="library"]') || /Import Product List/.test(r.querySelector('[data-d="aids"]')?.textContent || ''),
      addFirst: r.querySelector('.body').firstElementChild === add, addPrimary: /addnote/.test(add.className), addAboveProducts: rb(add).bottom <= rb(sec).top + 1,
    };
  });
  let h = await home();
  check('Home: one "Products" section, collapsed by default, directly below the primary Add note', h.sec && h.summary === 'Products' && !h.open && h.addFirst && h.addAboveProducts, JSON.stringify(h));
  check('Home: no green product buttons and no separate Define Product Card action', h.greenBtns === 0 && !h.define, JSON.stringify(h));
  check('More tools no longer has Import Product List', !h.moreImport, JSON.stringify(h));
  await A.evaluate(() => { __BL.S.ui.root.querySelector('[data-d="products"]').open = true; }); await sleep(300);
  h = await home();
  check('Home: expanded Products shows Product Library and Assign Products, both available with no product list saved', h.open && h.inside && h.libVisible && h.asgVisible && h.libText === 'Product Library' && h.asgText === 'Assign Products', JSON.stringify(h));
  await reboot(A);
  h = await home();
  check('Home: the Products section remembers it was expanded', h.open === true, JSON.stringify(h));
  await A.evaluate(() => { __BL.S.ui.root.querySelector('[data-d="products"]').open = false; }); await sleep(300);
  await reboot(A);
  h = await home();
  check('Home: and remembers it was collapsed', h.open === false, JSON.stringify(h));
  await A.evaluate(() => { __BL.S.ui.root.querySelector('[data-d="products"]').open = true; }); await sleep(300);

  // ---- Select element / Select area styling
  const sb = () => A.evaluate(() => [...__BL.S.ui.root.querySelectorAll('[data-x="start-select"],[data-x="start-area"]')].map((b) => { const c = getComputedStyle(b); const r = b.getBoundingClientRect(); return { x: b.dataset.x, bg: c.backgroundColor, bd: c.borderTopColor, fg: c.color, outline: c.outlineStyle, ol: c.outlineColor, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }));
  let sbs = await sb();
  check('Select element and Select area: pastel sky-blue fill, blue border, dark-blue text', sbs.length === 2 && sbs.every((b) => b.bg === 'rgb(216, 238, 255)' && b.bd === 'rgb(130, 189, 234)' && b.fg === 'rgb(23, 90, 145)'), JSON.stringify(sbs));
  const addBg = await A.evaluate(() => getComputedStyle(__BL.S.ui.root.querySelector('.addnote')).backgroundColor);
  check('Add note keeps its own, different primary styling', addBg !== 'rgb(216, 238, 255)', addBg);
  await A.mouse.move(sbs[0].cx, sbs[0].cy); await sleep(300);
  sbs = await sb();
  check('Select element: a visibly different hover state', sbs[0].bg === 'rgb(194, 226, 250)' && sbs[1].bg === 'rgb(216, 238, 255)', JSON.stringify(sbs));
  await A.mouse.move(2, 2);
  await A.mouse.move(sbs[1].cx, sbs[1].cy); await A.mouse.down(); await sleep(250);
  sbs = await sb();
  await A.mouse.move(2, 2); await A.mouse.up();
  check('Select area: a visibly different pressed state', sbs[1].bg === 'rgb(174, 213, 243)', JSON.stringify(sbs));
  await A.keyboard.press('Shift');
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="start-area"]').focus()); await sleep(200);
  sbs = await sb();
  check('Keyboard focus shows a dark-blue outline', sbs[1].outline !== 'none' && sbs[1].ol === 'rgb(23, 90, 145)', JSON.stringify(sbs[1]));
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="start-area"]').blur());

  // ---- Product Library / Assign Products buttons share the sky-blue treatment
  const act = () => A.evaluate(() => [...__BL.S.ui.root.querySelectorAll('[data-x="lib-home"],[data-x="assign-home"]')].map((b) => { const c = getComputedStyle(b); const r = b.getBoundingClientRect(); return { x: b.dataset.x, bg: c.backgroundColor, bd: c.borderTopColor, fg: c.color, outline: c.outlineStyle, ol: c.outlineColor, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }));
  let ac = await act();
  check('Product Library and Assign Products: same sky-blue fill, blue border and dark-blue text as Select element / Select area', ac.length === 2 && ac.every((b) => b.bg === 'rgb(216, 238, 255)' && b.bd === 'rgb(130, 189, 234)' && b.fg === 'rgb(23, 90, 145)'), JSON.stringify(ac));
  await A.mouse.move(ac[0].cx, ac[0].cy); await sleep(300);
  ac = await act();
  check('Product Library: a visibly different hover state (Assign Products unchanged)', ac[0].bg === 'rgb(194, 226, 250)' && ac[1].bg === 'rgb(216, 238, 255)', JSON.stringify(ac));
  await A.mouse.move(2, 2);
  await A.mouse.move(ac[1].cx, ac[1].cy); await A.mouse.down(); await sleep(250);
  ac = await act();
  await A.mouse.move(2, 2); await A.mouse.up();
  check('Assign Products: a visibly different pressed state', ac[1].bg === 'rgb(174, 213, 243)', JSON.stringify(ac));
  await A.keyboard.press('Shift');
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="assign-home"]').focus()); await sleep(200);
  ac = await act();
  check('Assign Products: keyboard focus shows a dark-blue outline', ac[1].outline !== 'none' && ac[1].ol === 'rgb(23, 90, 145)', JSON.stringify(ac[1]));
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="assign-home"]').blur());

  // ---- Product Library is reachable with no list (the only way in was More tools before)
  await xClick(A, 'lib-home', 700);
  const libOpen = await A.evaluate(() => { const r = __BL.S.ui.root; const m = r.querySelector('[data-m="library"]'); return { shown: !m.hidden, head: r.querySelector('.lib-head').textContent, upload: !!r.querySelector('[data-lib="file"]') }; });
  check('Products → Product Library opens with no saved list and offers the upload', libOpen.shown && /^Product Library/.test(libOpen.head) && libOpen.upload, JSON.stringify(libOpen));
  await xClick(A, 'lib-close', 300);
  check('Opening and closing the empty Product Library saves nothing', (await lists(A)).length === 0);

  // ---- Assign Products with no list: empty-state CTA
  await xClick(A, 'assign-home', 900);
  let p = await picker(A);
  check('Assign Products with no list opens its workspace with an obvious "Import Product List" CTA inside it', p.open && p.head === 'Assign Products' && p.cta && p.ctaText === 'Import Product List' && p.options.length === 0, JSON.stringify(p));
  const winBefore = await A.evaluate(() => { const r = __BL.S.ui.root.querySelector('.lib-sheet').getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; });
  const bulkRef = await A.evaluate(() => { window.__bulk0 = __BL.libraryUi.L.bulk; return true; });

  // ---- bad files are refused by the existing importer checks and add nothing
  await pickFile(A, 'notes.txt', 'hello'); await sleep(400);
  p = await picker(A);
  check('Unsupported file type: refused with a message, no list created, workspace still open', /can’t be imported/.test(p.note) && p.open && (await lists(A)).length === 0, JSON.stringify(p));
  await pickFile(A, 'empty.csv', ''); await sleep(400);
  p = await picker(A);
  check('Empty file: refused with a message, no list created', /is empty/.test(p.note) && (await lists(A)).length === 0, JSON.stringify(p));
  await pickFile(A, 'broken.json', '{ not json'); await sleep(500);
  p = await picker(A);
  check('Unreadable JSON: the importer\'s own error is shown, no list created, workspace still open', p.open && p.note.startsWith('broken.json:') && (await lists(A)).length === 0, JSON.stringify(p));

  // ---- first import: appears at once, selected, no close/reopen
  await pickFile(A, 'Spring Sale.csv', CSV1); await sleep(900);
  p = await picker(A);
  const l1 = await lists(A);
  check('Import from the empty state: the list is saved and appears in the picker at once, already selected, without reopening', l1.length === 1 && p.options.length === 1 && p.selected === p.options[0].v && /Spring Sale/.test(p.options[0].t) && /Imported/.test(p.note), JSON.stringify([p, l1]));
  check('After importing, the empty-state CTA is replaced by "Import another list" in the same workspace', !p.cta && p.more && p.moreText === 'Import another list', JSON.stringify(p));
  check('Assign Products rows list the imported products straight away', await A.evaluate(() => __BL.S.ui.root.querySelectorAll('.lib-sel-results > *').length >= 2), JSON.stringify(await A.evaluate(() => __BL.S.ui.root.querySelector('.lib-sel-results')?.textContent.slice(0, 120))));
  const sameWin = await A.evaluate((b) => { const r = __BL.S.ui.root.querySelector('.lib-sheet').getBoundingClientRect(); return { same: __BL.libraryUi.L.bulk === window.__bulk0, l: Math.round(r.left) === b.l, t: Math.round(r.top) === b.t, w: Math.round(r.width) === b.w, h: Math.round(r.height) === b.h }; }, winBefore);
  check('The workspace object, position and size are untouched by the import', Object.values(sameWin).every(Boolean), JSON.stringify(sameWin));
  const homeLib = await A.evaluate(() => !!__BL.S.ui.root.querySelector('[data-x="lib-home"]') && !__BL.S.ui.root.querySelector('[data-x="lib-home"]').hidden);
  check('Home Product Library / Assign Products stay available after the import', homeLib);

  // ---- second import with staged work in progress: nothing is disturbed
  await A.evaluate(() => { const b = __BL.libraryUi.L.bulk; b.drafts.__sentinel = { product: { key: 'sku:SENTINEL' }, list: { id: 'x', store: '' } }; b.sel = '__sel'; b.removals.__r = true; });
  const firstKey = p.options[0].v;
  const firstBefore = await libJson(A, firstKey);
  await A.evaluate(() => { const s = __BL.libraryUi.L.sel; s.q = ''; });
  await pickFile(A, 'Summer Sale.csv', CSV2); await sleep(900);
  p = await picker(A);
  const l2 = await lists(A);
  const kept = await A.evaluate(() => { const b = __BL.libraryUi.L.bulk; return { same: b === window.__bulk0, draft: !!b.drafts.__sentinel, sel: b.sel, rem: !!b.removals.__r }; });
  check('Importing a second list from the Product Library column adds it to the picker immediately', l2.length === 2 && p.options.length === 2 && p.options.some((o) => /Summer Sale/.test(o.t)), JSON.stringify([p.options, l2]));
  check('The currently selected list is NOT switched (staged assignments stay valid)', p.selected === firstKey, JSON.stringify([p.selected, firstKey]));
  check('Staged assignments, removals and the selected card survive the import', kept.same && kept.draft && kept.sel === '__sel' && kept.rem, JSON.stringify(kept));
  check('The import message says the current list and staged work are unchanged', /unchanged/.test(p.note) && /Summer Sale/.test(p.note), p.note);
  check('Importing never rewrites an existing list (the first list is byte-for-byte the same)', (await libJson(A, firstKey)) === firstBefore);

  // ---- same file again, and a drop: always a new list, never an overwrite
  await pickFile(A, 'Spring Sale.csv', CSV1); await sleep(900);
  const l3 = await lists(A);
  check('Importing the same file again makes another new list instead of replacing or merging', l3.length === 3 && (await libJson(A, firstKey)) === firstBefore, JSON.stringify(l3));
  const namesUnique = await A.evaluate(() => { const o = [...__BL.S.ui.root.querySelector('[data-lib="sel-list"]').options].map((x) => x.textContent); return new Set(o).size === o.length; });
  check('Saved list names stay unique', namesUnique);
  const libStateBefore = await A.evaluate(() => JSON.stringify(__BL.libraryUi.L.lib?.campaign || null));
  await dropFile(A, 'Autumn.csv', CSV2); await sleep(900);
  const l4 = await lists(A);
  check('Dropping a file on the workspace imports it as a new list through the workspace (not into a hidden Library list)', l4.length === 4 && (await libJson(A, firstKey)) === firstBefore && (await A.evaluate(() => JSON.stringify(__BL.libraryUi.L.lib?.campaign || null))) === libStateBefore, JSON.stringify(l4));
  const stillKept = await A.evaluate(() => { const b = __BL.libraryUi.L.bulk; return b === window.__bulk0 && !!b.drafts.__sentinel; });
  check('Staged work is still intact after every import', stillKept);

  // ---- choosing the imported list is the user's call
  await A.evaluate((k) => { const s = __BL.S.ui.root.querySelector('[data-lib="sel-list"]'); s.value = [...s.options].find((o) => /Summer Sale/.test(o.textContent)).value; s.dispatchEvent(new Event('change', { bubbles: true })); }, firstKey); await sleep(500);
  p = await picker(A);
  check('The user can then switch to the imported list from the menu', /Summer Sale/.test(p.options.find((o) => o.v === p.selected)?.t || ''), JSON.stringify(p));

  // ---- Review & verify products: the existing Product Library view, then straight back
  const sheet = (P) => P.evaluate(() => {
    const r = __BL.S.ui.root; const sh = r.querySelector('.lib-sheet'); const b = sh.getBoundingClientRect(); const L = __BL.libraryUi.L; const vis = (e) => !!e && e.getClientRects().length > 0;
    const sel = r.querySelector('[data-lib="sel-list"]');
    return { cls: sh.className, head: r.querySelector('.lib-head').textContent, rect: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)].join(),
      mainShown: vis(r.querySelector('[data-x="lib-check"]')) && vis(r.querySelector('[data-x="lib-open"]')), assignShown: vis(r.querySelector('.lib-as-cols')), back: vis(r.querySelector('[data-x="lib-rv-back"]')),
      review: !!L.review, listId: L.listId, selected: sel?.value || null, bulkSame: L.bulk === window.__bulk0, draft: !!L.bulk?.drafts?.__sentinel, bsel: L.bulk?.sel,
      status: r.querySelector('.lib-sel-rv .sub')?.textContent || '', rvBtn: vis(r.querySelector('[data-x="lib-sel-review"]')), rvText: r.querySelector('[data-x="lib-sel-review"]')?.textContent.trim(), msg: r.querySelector('.lib-msg')?.textContent || '' };
  });
  let rv = await sheet(A);
  const selNow = rv.selected;
  const campaignNow = selNow.slice(selNow.lastIndexOf('|') + 1);
  check('A list is selected: the visible "Review & verify products" button and a compact status are in the Product Library column', rv.rvBtn && rv.rvText === 'Review & verify products' && /products · Not verified in Shopify/.test(rv.status), JSON.stringify(rv));
  check('Importing never opened the Product Library by itself (the review view only opens on request)', !rv.review && !/lib-review/.test(rv.cls) && rv.assignShown && !rv.mainShown, JSON.stringify(rv));
  const before = await sheet(A);
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-sel-review"]').click()); await sleep(900);
  rv = await sheet(A);
  check('Review & verify opens the existing Product Library view (Set Store, Check in Shopify, upload) for the selected list, inside the same window', rv.review && /lib-review/.test(rv.cls) && rv.mainShown && !rv.assignShown && rv.back && rv.listId === campaignNow && rv.rect === before.rect, JSON.stringify(rv));
  check('A Back to Assign Products button is shown; the workspace object and staged work are intact while reviewing', rv.back && rv.bulkSame && rv.draft && rv.bsel === '__sel', JSON.stringify(rv));
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-check"]').click()); await sleep(500);
  rv = await sheet(A);
  check('With no Shopify store configured the existing check explains what is needed and the review stays open', /Shopify store/.test(rv.msg) && rv.review, JSON.stringify(rv.msg));
  // a verification result lands while reviewing (what Check in Shopify would save): variant chosen for the first SKU
  const variant = LibNode.normalizeProduct(PRODUCTS.find((p) => p.handle === 'charcoal'), '', 'USD').variants[0];
  await A.evaluate(async (key, v) => {
    const store = key.slice(0, key.lastIndexOf('|')); const id = key.slice(key.lastIndexOf('|') + 1);
    let lib = await BluelineLibrary.loadLibrary(chrome.storage.local, store, id);
    lib = BluelineLibrary.decide(BluelineLibrary.chooseVariant(lib, 'sku:ACM200101', v), 'sku:ACM200101', 'smp');
    await BluelineLibrary.saveLibrary(chrome.storage.local, lib, { smpChanged: true });
  }, selNow, variant);
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-rv-back"]').click()); await sleep(900);
  rv = await sheet(A);
  check('Back returns to Assign Products: same window position and size, same selected list, same staged work and card', !rv.review && /lib-pmode/.test(rv.cls) && /lib-amode/.test(rv.cls) && !/lib-review/.test(rv.cls) && rv.head === 'Assign Products' && rv.assignShown && !rv.mainShown && rv.rect === before.rect && rv.selected === selNow && rv.bulkSame && rv.draft && rv.bsel === '__sel', JSON.stringify(rv));
  check('The verification status and list information refresh immediately on return', /1 found in Shopify/.test(rv.status), rv.status);
  check('The review button is still available for later use', rv.rvBtn);
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-sel-review"]').click()); await sleep(700);
  await A.keyboard.press('Escape'); await sleep(700);
  rv = await sheet(A);
  check('Esc in the review view also returns to Assign Products (it does not close the workspace)', !rv.review && rv.assignShown && rv.bulkSame && rv.draft && rv.selected === selNow, JSON.stringify(rv));
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-sel-review"]').click()); await sleep(700);
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-close"]').click()); await sleep(700);
  rv = await sheet(A);
  check('The window close button in the review view also returns to Assign Products with work intact', !rv.review && rv.assignShown && rv.bulkSame && rv.draft && rv.selected === selNow, JSON.stringify(rv));
  check('No list was added, removed or switched by reviewing', (await lists(A)).length === 4);

  // ---- cancel and reopen: lists persist, Home Assign still works with lists
  await xClick(A, 'lib-bk-cancel', 500);
  await xClick(A, 'assign-home', 900);
  p = await picker(A);
  check('Closing and reopening Assign Products keeps the imported lists', p.open && p.options.length === 4 && !p.cta && p.more, JSON.stringify(p));
  await xClick(A, 'lib-bk-cancel', 400);
  await A.close();
}

// ---- Review & verify placement and import warning copy
console.log('\n# Slice A: review action placement and import warning copy');
{
  const CSV_WARN = 'Section,SKU,Product Name,Original Price,Sale Price\nFeatured,ACM400101,Acme ZMA Capsules,$27.97,oops\nFeatured,ACM999001,Acme Fish Oil Softgels,nope,\n';
  const info = (P) => P.evaluate(() => {
    const r = __BL.S.ui.root; const vis = (e) => !!e && e.getClientRects().length > 0;
    const btns = [...r.querySelectorAll('[data-x="lib-sel-review"]')];
    const box = r.querySelector('.lib-imp-warn'); const res = r.querySelector('.lib-sel-results'); const ctl = r.querySelector('.lib-sel-ctl');
    const b = btns[0];
    return { n: btns.length, vis: vis(b), inBox: !!box && !!b && box.contains(b), text: b?.textContent.trim(), box: box?.innerText.replace(/\s+/g, ' ').trim() || '', boxBg: box ? getComputedStyle(box).backgroundColor : '',
      aboveResults: !!b && !!res && b.getBoundingClientRect().bottom <= res.getBoundingClientRect().top + 1, belowCtl: !!b && !!ctl && b.getBoundingClientRect().top >= ctl.getBoundingClientRect().top,
      note: r.querySelector('.lib-sel-body .lib-vv-notice')?.innerText.replace(/\s+/g, ' ').trim() || '' };
  });
  const A = await open('card-groups.html');
  await xClick(A, 'assign-home', 900);
  await pickFile(A, 'warn.csv', CSV_WARN); await sleep(900);
  let i = await info(A);
  check('Import with warnings: "Review & verify products" is inside the yellow warning box, once', i.n === 1 && i.vis && i.inBox && i.text === 'Review & verify products' && i.boxBg === 'rgb(255, 244, 214)', JSON.stringify(i));
  check('Warning copy is short: name and count, then the warning count, with no "and selected it" or "open the Product Library"', /^Imported “[^”]+” \(2 products\)\. 2 warnings need review\. Review & verify products$/.test(i.box) && !/selected it|open the Product Library/.test(i.box), i.box);
  check('The warning box (and button) sit above the product list', i.aboveResults, JSON.stringify(i));
  await A.evaluate(() => { const b = __BL.libraryUi.L.bulk; b.drafts.__sentinel = { product: { key: 'sku:SENTINEL' }, list: { id: 'x', store: '' } }; b.sel = '__sel'; window.__bulkW = b; });
  const keyBefore = await A.evaluate(() => __BL.S.ui.root.querySelector('[data-lib="sel-list"]').value);
  await xClick(A, 'lib-sel-review', 900);
  // Store settings: setting a store on the list changes its key; Back must find the same list and keep staged work
  await A.evaluate(() => { const r = __BL.S.ui.root; const inp = r.querySelector('[data-lib="store"]'); inp.value = 'https://store.example.com'; inp.dispatchEvent(new Event('input', { bubbles: true })); r.querySelector('[data-x="lib-open"]').click(); });
  await sleep(1200);
  await xClick(A, 'lib-rv-back', 900);
  i = await A.evaluate(() => { const r = __BL.S.ui.root; const L = __BL.libraryUi.L; const sel = r.querySelector('[data-lib="sel-list"]'); return { review: !!L.review, key: sel?.value, same: L.bulk === window.__bulkW, draft: !!L.bulk?.drafts?.__sentinel, bsel: L.bulk?.sel, opts: sel ? sel.options.length : 0, text: sel?.selectedOptions[0]?.textContent || '' }; });
  const campaign = (k) => k.slice(k.lastIndexOf('|') + 1);
  check('Store settings changing the list key: Back returns to Assign Products on the same list with staged assignments and the selected card intact', !i.review && i.same && i.draft && i.bsel === '__sel' && i.opts === 1 && campaign(i.key) === campaign(keyBefore), JSON.stringify({ i, keyBefore }));
  i = await info(A);
  check('After returning, the review action is still available once (no duplicate)', i.n === 1 && i.vis, JSON.stringify(i));
  await xClick(A, 'lib-bk-cancel', 400);
  await A.close();

  const B = await open('card-groups.html');
  await xClick(B, 'assign-home', 900);
  await pickFile(B, 'clean.csv', CSV1); await sleep(900);
  i = await info(B);
  check('Import without warnings: plain confirmation, no yellow box, no "and selected it"', /^Imported “[^”]+” \(2 products\)\.$/.test(i.note) && !i.box && !/selected it/.test(i.note), JSON.stringify(i));
  check('No warning: the one review button sits with the list controls, above the product list', i.n === 1 && i.vis && !i.inBox && i.aboveResults && i.belowCtl, JSON.stringify(i));
  await xClick(B, 'lib-sel-review', 800);
  check('Review still opens the existing Product Library view in the same window (no modal, not opened by the import)', await B.evaluate(() => !!__BL.libraryUi.L.review && /lib-review/.test(__BL.S.ui.root.querySelector('.lib-sheet').className)));
  await xClick(B, 'lib-rv-back', 800);
  await xClick(B, 'lib-bk-cancel', 400);
  await B.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
