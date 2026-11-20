// Product-card discovery focused browser tests (cards.js + the Assign Products workspace): cards of one family that differ
// only by a colour class are found from the first confirmed card; a single card with repeated internal parts is not "several
// cards"; genuine multi-card wrappers still are; rescans never duplicate, reorder or overwrite anything.
//
// Usage: node cards-discovery.test.mjs [extension-dir]   (from tests/)
import { launch } from './cdp.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(process.argv[2] || join(here, '..'));
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('Chrome not found. Set CHROME_PATH.'); process.exit(2); }

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
async function open({ width = 1280, height = 900, full = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.goto(pathToFileURL(join(here, 'fixtures', 'card-families.html')).href);
  if (!full) { await page.addScriptTag({ content: src('cards.js') }); return page; }
  await page.addScriptTag({ content: STUB });
  await page.addScriptTag({ content: REAL_STORAGE });
  for (const f of ['page-hook.js', 'content.js', 'library.js', 'cards.js', 'tools.js', 'library-ui.js', 'sidebar.js']) await page.addScriptTag({ content: src(f) });
  await page.waitForFunction(() => window.__BL?.S?.active && window.__BL.S.ui);
  await sleep(150);
  return page;
}
const ids = (P, from) => P.evaluate((from) => BluelineCards.discoverCards(document.getElementById(from)).cards.map((c) => `${c.el.id}:${c.confidence}`), from);

console.log('\n# Card families: discovery and broad-container detection (fixtures/card-families.html)');
{
  const A = await open();

  // ---- C. different styling classes must not prevent discovery
  const fromFirst = await ids(A, 'fc1');
  check('From the first Featured Deals card (article.f-coral) its two siblings (f-peach, f-sky) are found, with high confidence', ['fc1:high', 'fc2:high', 'fc3:high'].every((x) => fromFirst.includes(x)), JSON.stringify(fromFirst));
  check('Each of the three Featured Deals cards is its own element (no overlap, no card inside another, no duplicates)', await A.evaluate(() => {
    const els = BluelineCards.discoverCards(document.getElementById('fc1')).cards.map((c) => c.el);
    return new Set(els).size === els.length && els.every((a) => els.every((b) => a === b || (!a.contains(b) && !b.contains(a))));
  }));
  check('Other sections with different layouts are discovered for review (tiles and bundles), never as confident cards', ['bt1', 'bt2', 'bt3', 'bt4', 'bb1', 'bb2'].every((i) => fromFirst.includes(`${i}:review`)), JSON.stringify(fromFirst));
  check('Cards in a wrapper that holds two rows (picks) are found too', ['pa1', 'pa2', 'pb1', 'pb2'].every((i) => fromFirst.some((x) => x.startsWith(i + ':'))), JSON.stringify(fromFirst));
  check('Navigation, hero banner and the footer gift cards are never cards', await A.evaluate(() => {
    const els = BluelineCards.discoverCards(document.getElementById('fc1')).cards.map((c) => c.el);
    return ['nav', '#hero', 'footer'].every((s) => { const d = document.querySelector(s); return !els.some((e) => d.contains(e) || e.contains(d)); });
  }));
  check('Cards come back in document order, and the page is not changed', await A.evaluate(() => {
    const before = document.body.innerHTML;
    const els = BluelineCards.discoverCards(document.getElementById('fc2')).cards.map((c) => c.el);
    return before === document.body.innerHTML && els.every((e, i) => !i || els[i - 1].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING);
  }));
  const fromSecond = await ids(A, 'fc2');
  const fromThird = await ids(A, 'fc3');
  check('Discovery is the same from any card of the family, and the same every time it is repeated (a rescan is stable)', JSON.stringify(fromFirst) === JSON.stringify(await ids(A, 'fc1')) && fromFirst.map((x) => x.split(':')[0]).sort().join() === fromSecond.map((x) => x.split(':')[0]).sort().join() && fromFirst.map((x) => x.split(':')[0]).sort().join() === fromThird.map((x) => x.split(':')[0]).sort().join(), JSON.stringify([fromFirst, fromSecond, fromThird]));
  check('Discovery from a differently built card (a tile) does not pull the Featured Deals cards in as confident matches of it', (await ids(A, 'bt1')).filter((x) => x.endsWith(':high')).map((x) => x.split(':')[0]).join() === 'bt1,bt2,bt3,bt4');

  // ---- D. a single card is never "several cards"; real multi-card containers still are
  const broad = (sel, viewport) => A.evaluate((sel) => BluelineCards.isBroad(document.querySelector(sel)), sel);
  check('The first Featured Deals card (with repeated badges, price spans, wrappers and a button) is NOT broad', !(await broad('#fc1')) && !(await broad('#fc2')) && !(await broad('#fc3')));
  check('Each card is flagged correctly: tiles and bundle cards are not broad either', !(await broad('#bt1')) && !(await broad('#bb1')) && !(await broad('#pa1')));
  check('The row of cards, the section, the two-row wrapper and each list/row of other layouts ARE broad (warning kept)', (await broad('#rail-feat')) && (await broad('#featured')) && (await broad('#picks')) && (await broad('#rail-a')) && (await broad('#list-best')) && (await broad('#row-bundles')) && (await broad('#best')));
  check('propose() from inside a card picks the whole card (not the body, not the row) and is not broad; the row above it is', await A.evaluate(() => {
    const p = BluelineCards.propose(document.querySelector('#fc1 .nm'));
    const at = p.chain[p.at];
    return at && at.id === 'fc1' && p.confidence === 'structure' && p.broad[p.at] === false && p.broad[p.chain.findIndex((n) => n.id === 'rail-feat')] === true;
  }));
  check('A lone card with repeated internal parts and no siblings is not "several cards"', await A.evaluate(() => {
    const d = document.createElement('div');
    d.innerHTML = '<article id="lone"><div class="media"><span class="ph">[Product shot]</span><span class="badge">A</span><span class="badge">B</span><span class="badge">C</span></div><div class="body"><div class="prices"><span>$10.00</span><span>$12.00</span></div><a href="/p">Shop</a><a href="/p">Buy now</a><button>Add to cart</button></div></article>';
    document.body.append(d);
    const r = BluelineCards.isBroad(d.firstChild);
    d.remove();
    return r === false;
  }));
  const small = await open({ width: 400, height: 300 }); // a short window: a 700px card is taller than 1.5x the window
  check('In a short browser window a normal, tall card is still not "a whole section"', await small.evaluate(() => ['fc1', 'fc2', 'fc3'].every((i) => { const e = document.getElementById(i); return e.getBoundingClientRect().height > innerHeight * 1.5 && BluelineCards.isBroad(e) === false; })));
  check('…and the rows and sections are still broad there', await small.evaluate(() => ['rail-feat', 'featured', 'picks'].every((i) => BluelineCards.isBroad(document.getElementById(i)))));
  check('A tall page region with no product in it (the hero wrapper made huge) is still broad in a short window', await small.evaluate(() => { const h = document.getElementById('hero'); h.style.height = '2000px'; const r = BluelineCards.isBroad(h); h.style.height = ''; return r === true; }));
  await small.close();
  await A.close();
}

console.log('\n# Card families: Assign Products workspace (saved, mapped, excluded and boundary-edited cards survive rescans)');
{
  const A = await open({ full: true });
  const defineCard = (id, mapping, extra = {}) => A.evaluate(async (id, mapping, extra) => {
    const el = document.getElementById(id);
    const rec = { id: `rec-${id}`, cardRecord: true, note: '', createdAt: Date.now(), ...__BL.describe(el, 'change'), productCard: BluelineCards.describe(el), ...extra };
    if (mapping) rec.productMapping = { ...mapping, card: BluelineCards.describe(el) };
    await __BL.addItem(rec);
  }, id, mapping, extra);
  const rows = () => A.evaluate(() => {
    const r = __BL.S.ui.root;
    return {
      open: !!__BL.libraryUi.L.bulk,
      rows: [...r.querySelectorAll('.lib-bk:not(.lib-bk-off)')].map((e) => ({ key: e.dataset.key, n: +e.querySelector('.lib-bk-n').textContent, badges: [...e.querySelectorAll('.lib-badge')].map((b) => b.textContent.trim()), prod: e.querySelector('.lib-bk-prod')?.textContent.replace(/\s+/g, ' ').trim() || '' })),
      msg: [...r.querySelectorAll('.lib-as-cbody .lib-vv-notice')].map((n) => n.textContent.trim()).join(' | '),
    };
  });
  const items = () => A.evaluate(() => JSON.parse(JSON.stringify(__BL.S.batch.items)));
  const MAPPING = { product: { key: 'sku:ACM1', name: 'Acme Melatonin' }, approved: { title: 'Acme Melatonin' }, variant: { url: 'https://shop.example.com/products/melatonin', handle: 'melatonin', variantId: 1 }, identity: { state: 'exact' } };

  await defineCard('fc1');
  await defineCard('fc2', MAPPING); // already mapped
  await defineCard('fc3', null, { noSeed: true }); // a card whose boundary was edited: it no longer stands for its layout family
  await sleep(300);
  const before = await items();
  await A.evaluate(() => { __BL.libraryUi.assignStart(); }); // the window stays open until closed, so it is not awaited
  await sleep(900);
  let w = await rows();
  const keyed = (list) => list.map((r) => r.key);
  check('Assign Products lists the saved cards at once together with the siblings found around them: all three Featured Deals cards are there', w.open && w.rows.length >= 3 && w.rows.filter((r) => r.badges.includes('Defined card')).length >= 1, JSON.stringify(w));
  const featured = await A.evaluate(() => ['fc1', 'fc2', 'fc3'].map((i) => document.getElementById(i).getBoundingClientRect().top));
  check('A defined card without an assigned product stays "Defined / not mapped": nothing was assigned by defining or discovering', (await items()).filter((i) => i.productMapping).length === 1 && (await items()).find((i) => i.id === 'rec-fc1').productMapping === undefined);
  const numbered = w.rows.map((r) => r.n);
  check('Cards are numbered in page order, 1..n, with no gaps', numbered.every((n, i) => n === i + 1), JSON.stringify(numbered));

  const firstKeys = keyed(w.rows);
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-bk-find"]').click());
  await sleep(500);
  w = await rows();
  check('Find Similar Cards rescans: nothing new is found, no card is duplicated, and the order and numbering are unchanged', JSON.stringify(keyed(w.rows)) === JSON.stringify(firstKeys) && /No new cards found/.test(w.msg), JSON.stringify([w.msg, keyed(w.rows), firstKeys]));
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-bk-find"]').click());
  await sleep(400);
  check('Rescanning again changes nothing (repeated scans never add records)', JSON.stringify(keyed((await rows()).rows)) === JSON.stringify(firstKeys) && (await items()).length === before.length);
  check('Saved assignments and card records are untouched by the rescans (same ids, same mapping, same card fingerprints)', JSON.stringify(await items()) === JSON.stringify(before));

  // a card that appears later is found; a removed one goes; nothing else moves
  await A.evaluate(() => { const rail = document.getElementById('rail-feat'); const c = document.getElementById('fc3').cloneNode(true); c.id = 'fc4'; c.className = 'f-lav'; rail.append(c); });
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-bk-find"]').click());
  await sleep(500);
  w = await rows();
  check('A fourth Featured Deals card added later (another colour class) is found by Find Similar Cards, once', w.rows.length === firstKeys.length + 1 && /Found 1 new card/.test(w.msg), JSON.stringify([w.msg, w.rows.length, firstKeys.length]));
  await A.evaluate(() => document.getElementById('fc4').remove());
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-bk-find"]').click());
  await sleep(400);
  check('…and is gone again when it leaves the page, the others stay in place', JSON.stringify(keyed((await rows()).rows)) === JSON.stringify(firstKeys));

  // exclusion: "Not a card" on a detected card stays excluded across rescans
  const victim = (await rows()).rows.find((r) => !r.badges.includes('Defined card'));
  const excludeBtn = await A.evaluate((key) => { const b = __BL.S.ui.root.querySelector(`.lib-bk[data-key="${key}"] [data-x="lib-bk-exclude"]`); if (b) { b.click(); return true; } return false; }, victim.key);
  if (excludeBtn) {
    await sleep(600);
    const afterEx = await rows();
    await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="lib-bk-find"]').click());
    await sleep(500);
    const afterFind = await rows();
    check('A card marked "Not a card" is not brought back by Find Similar Cards, and the rest of the list is unchanged', !afterEx.rows.some((r) => r.key === victim.key) && !afterFind.rows.some((r) => r.key === victim.key) && afterFind.rows.length === afterEx.rows.length && JSON.stringify(keyed(afterFind.rows)) === JSON.stringify(keyed(afterEx.rows)), JSON.stringify([victim, keyed(afterEx.rows), keyed(afterFind.rows)]));
  } else check('A card marked "Not a card" is not brought back by Find Similar Cards (control not found in this build)', false, 'no exclude control');
  await A.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
process.exit(failed ? 1 : 0);
