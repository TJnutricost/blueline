// Slice C1 focused browser tests: Shopify platform, theme and cart context (Implementation target in the Change Report).
//
// Usage: node c1.test.mjs [extension-dir]   (from tests/)
import { launch } from './cdp.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

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
}; window.__BLUELINE_TEST__ = {}; window.__fetches = []; const _f = window.fetch; window.fetch = (...a) => { window.__fetches.push(String(a[0])); return _f.apply(window, a); };`;
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
async function open(fixture) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(pathToFileURL(join(here, 'fixtures', fixture)).href);
  await page.addScriptTag({ content: STUB });
  await page.addScriptTag({ content: REAL_STORAGE });
  for (const f of ['page-hook.js', 'content.js', 'library.js', 'cards.js', 'tools.js', 'library-ui.js']) await page.addScriptTag({ content: src(f) });
  await page.waitForFunction(() => window.__BL?.S?.active && window.__BL.S.ui);
  await sleep(150);
  return page;
}
const MAP = { product: { key: 'sku:A', name: 'Acme Omega' }, approved: { title: 'Acme Omega' }, variant: { url: 'https://shop.test/products/omega?variant=4242', handle: 'omega', variantId: '4242' }, identity: { state: 'exact' } };
const note = (text, withMap) => ({ id: 'n1abcd', type: 'polish', kind: 'element', note: text, url: 'file:///x.html', path: '/x.html', title: 'x', createdAt: 1, viewport: { w: 1280, h: 900 }, selector: '#a', tag: 'div', el: { label: 'h1', selector: '#a', size: '300x40' }, ...(withMap ? { productMapping: MAP } : {}) });
const out = (P) => P.evaluate(() => __BL.S.ui.root.querySelector('.out').value);
const vis = (P, sel) => P.evaluate((sel) => { const e = __BL.S.ui.root.querySelector(sel); return !!e && !e.hidden && e.getBoundingClientRect().height > 0; }, sel);
const regen = async (P) => { await P.evaluate(() => __BL.refreshExport()); await sleep(150); };
const select = async (P, sel, v) => { await P.evaluate((sel, v) => { const e = __BL.S.ui.root.querySelector(sel); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); }, sel, v); await sleep(80); };
const typeIn = async (P, sel, v) => { await P.evaluate((sel, v) => { const e = __BL.S.ui.root.querySelector(sel); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, sel, v); await sleep(80); };
const cart = async (P, on) => { await P.evaluate((on) => { const b = __BL.S.ui.root.querySelector('.opt-cart'); b.checked = on; b.dispatchEvent(new Event('change', { bubbles: true })); }, on); await sleep(100); };
const reopen = async (P) => { await P.evaluate(() => __BL.S.ui.root.querySelector('[data-act="modal-close"]').click()); await sleep(80); await P.evaluate(() => { __BL.S.ui.root.querySelector('.modal').hidden = false; }); await regen(P); };
const addDom = (P, html) => P.evaluate((h) => { const d = document.createElement('div'); d.id = 'inj'; d.innerHTML = h; document.body.appendChild(d); }, html);
const rmDom = (P) => P.evaluate(() => document.getElementById('inj')?.remove());
const section = (t) => t.slice(t.indexOf('## Source page and implementation target'), t.indexOf('## Add to Cart') > 0 ? t.indexOf('## Add to Cart') : undefined);

console.log('\n# Slice C1 corrections: cart wording by destination (library.cartLines, no browser)');
{
  const LibNode = createRequire(import.meta.url)(join(ext, 'library.js'));
  const T = (o) => LibNode.cartLines({ on: true, hasVariants: true, ...o }).join('\n');
  const n = (t, re) => (t.match(re) || []).length;
  const ROUTES = /build Ajax routes from/gi;
  const unconditional = (t) => /(^|\. |: )Build Ajax routes from `window\.Shopify\.routes\.root`/m.test(t) && !/If the destination is confirmed to be a Shopify theme: build Ajax|Only if that integration itself uses Shopify Ajax routes \(check its code or docs\): build Ajax/.test(t);
  let t = T({ mode: 'theme' });
  check('Theme cart + unknown destination: Shopify routing is conditional, never unconditional', /If the destination is confirmed to be a Shopify theme: build Ajax routes from `window\.Shopify\.routes\.root`/.test(t) && !unconditional(t));
  t = T({ mode: 'theme', dest: 'detected' });
  check('Theme cart + detected (unconfirmed) Shopify: routing is conditional', /If the destination is confirmed to be a Shopify theme: build Ajax routes/.test(t) && !unconditional(t) && n(t, ROUTES) === 1);
  t = T({ mode: 'theme', dest: 'other' });
  check('Theme cart + destination Other: no Shopify routes and no Shopify bullet', n(t, ROUTES) === 0 && !/Shopify theme targets/.test(t) && /existing theme cart/.test(t));
  t = T({ mode: 'theme', dest: 'shopify' });
  check('Theme cart + destination selected as Shopify: routes are given directly, once, with the refresh guidance', unconditional(t) && n(t, ROUTES) === 1 && /existing cart refresh|cart refresh/.test(t) && !/Don’t assume Shopify/.test(t));
  for (const dest of ['unknown', 'detected', 'shopify']) {
    t = T({ mode: 'custom', name: 'Rebuy Cart', dest });
    check(`Custom integration (${dest}): its own API/events come first, Shopify routes only if it uses them, no conflicting theme/Shopify bullet`,
      /call that integration’s own add-to-cart and refresh mechanism/.test(t) && /Only if that integration itself uses Shopify Ajax routes \(check its code or docs\): build Ajax routes/.test(t) && n(t, ROUTES) === 1 && !/Shopify theme targets/.test(t) && !/use the theme’s own cart mechanism/.test(t) && !/Other targets/.test(t) && /Inspect how the destination’s \*\*Rebuy Cart\*\*/.test(t) && t.indexOf('integration’s own add-to-cart') < t.indexOf('window.Shopify.routes.root'));
  }
  t = T({ mode: 'custom', name: 'Rebuy Cart', dest: 'other' });
  check('Custom integration + destination Other: no Shopify routing at all', n(t, ROUTES) === 0 && !/Shopify Ajax/.test(t));
  t = T({ dest: 'detected' });
  check('Auto-detected Shopify: acknowledges the detection and requires verification, with no "don’t assume Shopify" contradiction', /Blueline detected Shopify on the inspected page, but the target project decides how; verify the destination platform first/.test(t) && /confirm that against the destination project before relying on it/.test(t) && !/Don’t assume Shopify/.test(t) && !/Blueline doesn’t assume a platform/.test(t) && /Shopify theme targets \(Shopify was detected on the inspected page; verify the destination is a Shopify theme first\)/.test(t));
  t = T({ dest: 'shopify' });
  check('Destination selected as Shopify: no "don’t assume Shopify" contradiction', !/Don’t assume Shopify/.test(t) && !/Blueline doesn’t assume a platform/.test(t));
  t = T({});
  check('Default (nothing known): original platform-neutral wording is unchanged', /Don’t assume Shopify/.test(t) && /Blueline doesn’t assume a platform/.test(t) && n(t, ROUTES) === 0);
  check('Every mode keeps exact variant ids, loading/error/sold-out, display vs checkout price and existing drawers', ['unknown', 'detected', 'shopify', 'other'].every((dest) => ['auto', 'theme', 'custom'].every((mode) => { const x = T({ mode, dest }); return /exact product and variant ids/.test(x) && /loading, error and unavailable or sold-out/.test(x) && /display values from the list/.test(x) && /preserve existing cart drawers, counters and interactions/.test(x); })));
}

console.log('\n# Slice C1: Implementation target (fixtures/c1.html, a local HTML page)');
{
  const A = await open('c1.html');
  await A.evaluate((n) => { __BL.S.batch = { id: 'b1', items: [n], guides: [] }; }, note('Make the heading bigger', true));
  await A.evaluate(() => { window.__sent = []; window.__clip = null; navigator.clipboard.writeText = async (t) => { window.__clip = t; }; chrome.runtime.sendMessage = async (m) => { window.__sent.push(m); return m && m.type === 'blueline:download' ? { paths: [{ id: 'prompt', path: '/dl/blueline-change-report.md' }] } : null; }; });
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.modal').hidden = false; });
  await regen(A);
  const pageBefore = await A.evaluate(() => JSON.stringify(__BL.S.page));
  const batchBefore = await A.evaluate(() => JSON.stringify(__BL.S.batch));
  const storeBefore = await A.evaluate(() => chrome.storage.local.get(null).then((o) => JSON.stringify(o)));
  const modeBefore = await A.evaluate(() => __BL.modeOf(__BL.S.page));

  // ---- defaults and observed facts
  let t = await out(A);
  check('Implementation target section is collapsible, collapsed by default, inside the report window', await A.evaluate(() => { const d = __BL.S.ui.root.querySelector('.modal details.tgt'); return !!d && !d.open; }));
  check('Defaults: Platform Auto, cart OFF, cart-integration options hidden', await A.evaluate(() => __BL.S.ui.root.querySelector('.tgt-platform').value === 'auto' && !__BL.S.ui.root.querySelector('.opt-cart').checked) && !(await vis(A, '.cart-opts')) && !(await vis(A, '.tgt-shop')));
  check('Source summary: local file, theme not detected, no Shogun, cart integration Unknown', /Observed on the inspected page \(read-only facts\):\*\* Local HTML file\./.test(t) && /Theme metadata: not detected\./.test(t) && /Shogun evidence: none found\./.test(t) && /Cart evidence: none found\. Cart integration: Unknown\./.test(t), section(t));
  check('Destination defaults to Auto (nothing selected)', /Intended destination:\*\* Auto \(nothing detected or selected\)/.test(t));
  check('The panel shows a read-only observed summary', /^Observed \(read-only\): Local HTML file/.test(await A.evaluate(() => __BL.S.ui.root.querySelector('.tgt-obs').textContent)));
  check('Existing report sections are still there (source page, implementation target, cart off)', /## Source page and implementation target/.test(t) && /Inspected source page \(reference only\)/.test(t) && /Implementation target:\*\* the matching HTML/.test(t) && /## Add to Cart\n- Not requested/.test(t) && /Selector: `#a`/.test(t));

  // ---- passive evidence, reported separately, integration only on a reliable marker
  await addDom(A, '<form action="/cart/add" method="post"><button>Add</button></form>'); await regen(A); t = await out(A);
  check('A /cart/add form is cart evidence only: integration stays Unknown', /Cart evidence: a product form posting to `\/cart\/add`\. Cart integration: Unknown\./.test(t) && /Shogun evidence: none found/.test(t) && /Theme metadata: not detected/.test(t), section(t));
  await rmDom(A); await addDom(A, '<div id="upcart-container"></div>'); await regen(A); t = await out(A);
  check('A known app marker names the integration (UpCart, marker found)', /Cart integration: UpCart \(marker found\)/.test(t));
  await rmDom(A); await addDom(A, '<div class="shogun-root"><div class="shg-row">x</div></div>'); await regen(A); t = await out(A);
  check('Shogun markup is reported as Shogun evidence, separate from theme and cart', /Shogun evidence: Shogun page markup/.test(t) && /Theme metadata: not detected/.test(t) && /Cart integration: Unknown/.test(t));
  await rmDom(A); await regen(A);
  check('Detection is passive: nothing was fetched and the page DOM only has the fixture and Blueline', await A.evaluate(() => window.__fetches.length === 0 && !document.getElementById('inj')));

  // ---- local HTML -> Shopify / Shogun
  await A.evaluate(() => { __BL.S.ui.root.querySelector('details.tgt').open = true; });
  await select(A, '.tgt-platform', 'shopify');
  check('Choosing Shopify reveals theme and page-builder overrides', await vis(A, '.tgt-shop') && await vis(A, '.tgt-theme') && await vis(A, '.tgt-builder'));
  await typeIn(A, '.tgt-theme', 'Dawn Custom');
  await select(A, '.tgt-builder', 'shogun');
  t = await out(A);
  check('Local HTML -> Shopify/Shogun: destination is Shopify, theme and Shogun named', /Intended destination \(selected in Blueline\):\*\* Shopify\./.test(t) && /Theme: `Dawn Custom` \(selected in Blueline\)/.test(t) && /Page builder: Shogun \(selected in Blueline\)/.test(t), section(t));
  check('...and the observed source is still local HTML (observed facts unchanged)', /read-only facts\):\*\* Local HTML file\./.test(t) && /Theme metadata: not detected/.test(t) && /Shogun evidence: none found/.test(t));
  check('...with port-it guidance, reference-only local file, Shogun edited in Shogun', /local HTML file used only as a reference/.test(t) && /content built in Shogun is edited in Shogun/.test(t) && /Inspected source page \(reference only\)/.test(t));
  check('Local HTML stays classified as html: modeOf(S.page) unchanged, items keep their mode, S.page untouched', await A.evaluate(() => __BL.modeOf(__BL.S.page)) === modeBefore && modeBefore === 'html' && (await A.evaluate(() => JSON.stringify(__BL.S.page))) === pageBefore);
  await select(A, '.tgt-builder', 'other');
  check('Page builder Other asks for a name', await vis(A, '.tgt-builder-name'));
  await typeIn(A, '.tgt-builder-name', 'PageFly');
  check('...and the report uses it', /Page builder: PageFly \(selected in Blueline\)/.test(await out(A)));
  await select(A, '.tgt-builder', 'shogun');
  check('Switching back from Other clears the other name', await A.evaluate(() => __BL.S.target.builderName === ''));

  // ---- Other / unknown platform
  await select(A, '.tgt-platform', 'other');
  t = await out(A);
  check('Other or unknown: no Shopify assumptions; Shopify fields hidden and cleared', /other or unknown platform\. Don’t assume Shopify, Liquid, Shogun/.test(t) && !/Page builder: Shogun/.test(t) && !(await vis(A, '.tgt-shop')) && (await A.evaluate(() => __BL.S.target.theme === '' && __BL.S.target.builder === 'auto')));

  // ---- cart OFF / ON
  await select(A, '.tgt-platform', 'shopify'); await typeIn(A, '.tgt-theme', 'Dawn Custom'); await select(A, '.tgt-builder', 'shogun');
  t = await out(A);
  check('Cart OFF: no cart changes requested, options hidden, no cart integration text', /## Add to Cart\n- Not requested\. Don’t add or change cart/.test(t) && !/Add to Cart implementation \(requested\)/.test(t) && !(await vis(A, '.cart-opts')) && !/Cart integration \(selected/.test(t));
  await cart(A, true);
  check('Cart ON reveals Auto / Existing theme cart / App or custom', await vis(A, '.cart-opts') && (await A.evaluate(() => [...__BL.S.ui.root.querySelectorAll('.tgt-cart option')].map((o) => o.textContent).join('|'))) === 'Auto (none detected; inspect the project)|Existing theme cart|App or custom integration');
  t = await out(A);
  check('Cart ON + Auto + Shopify destination: no integration assumed (no UpCart/theme-cart claim), exact variant, states, price separation, locale-aware routes, existing refresh',
    /Add to Cart implementation \(requested\)/.test(t) && !/UpCart/.test(t) && !/Cart integration \(selected/.test(t) && /Inspect the destination Shopify theme’s existing cart architecture/.test(t) && !/Don’t assume Shopify/.test(t));
  check('...Shopify guidance: locale-aware Ajax routes + the destination’s existing cart refresh', /window\.Shopify\.routes\.root/.test(t) && /existing cart refresh/.test(t));
  check('...and the standing safeguards are kept (exact ids, loading/error/sold-out, display vs checkout price, existing drawers)', /exact product and variant ids/.test(t) && /loading, error and unavailable or sold-out/.test(t) && /display values from the list/.test(t) && /preserve existing cart drawers, counters and interactions/.test(t) && /4242/.test(t));
  await select(A, '.tgt-cart', 'theme');
  t = await out(A);
  check('Existing theme cart: selected, theme cart inspected, no parallel cart, no app assumed', /Cart integration \(selected in Blueline\):\*\* the destination’s existing theme cart/.test(t) && /Don’t assume an app cart/.test(t) && /window\.Shopify\.routes\.root/.test(t) && !/UpCart/.test(t) && await vis(A, '.tgt-cart-notes') && !(await vis(A, '.tgt-cart-name')));
  await select(A, '.tgt-cart', 'custom');
  check('App or custom shows name and instructions fields', await vis(A, '.tgt-cart-name') && await vis(A, '.tgt-cart-notes'));
  t = await out(A);
  check('Custom with no name: says to identify it in the project, never assumes an app', /app or custom integration \(name not given; identify it in the project\)/.test(t) && !/UpCart/.test(t));
  await typeIn(A, '.tgt-cart-name', 'Rebuy Cart'); await typeIn(A, '.tgt-cart-notes', 'Open the drawer after add.   Keep upsells.');
  t = await out(A);
  check('Manual integration override: named, instructions on one line, uses that integration’s own mechanism', /app or custom integration `Rebuy Cart`\./.test(t) && /Cart instructions from the requester: Open the drawer after add\. Keep upsells\./.test(t) && /call that integration’s own add-to-cart and refresh mechanism with the exact variant id/.test(t) && /Inspect how the destination’s \*\*Rebuy Cart\*\* cart integration is installed/.test(t) && !/## Add to Cart implementation[\s\S]*\*\*Shopify theme targets/.test(t));
  check('Manual override does not turn on detection: observed integration is still Unknown', /Cart integration: Unknown\./.test(t));
  await cart(A, false);
  t = await out(A);
  check('Cart OFF again: integration choices stay out of the report and the options hide', /## Add to Cart\n- Not requested/.test(t) && !/Rebuy Cart/.test(t) && !/Cart instructions from/.test(t) && !(await vis(A, '.cart-opts')));
  await cart(A, true);
  check('...and are remembered (not lost) when cart is turned back ON', /Rebuy Cart/.test(await out(A)));

  // ---- retention across reopen/regeneration; Copy and Save
  await reopen(A);
  t = await out(A);
  check('Selections survive closing/reopening the report and regeneration (UI shows them too)', /Theme: `Dawn Custom` \(selected/.test(t) && /Page builder: Shogun \(selected/.test(t) && /Rebuy Cart/.test(t) && await A.evaluate(() => { const r = __BL.S.ui.root; return r.querySelector('.tgt-platform').value === 'shopify' && r.querySelector('.tgt-theme').value === 'Dawn Custom' && r.querySelector('.tgt-builder').value === 'shogun' && r.querySelector('.tgt-cart').value === 'custom'; }));
  await A.evaluate(() => { __BL.S.batch.items[0].note = 'Make the heading MUCH bigger'; }); await regen(A);
  check('A changed note regenerates the report and keeps the selections', /MUCH bigger/.test(await out(A)) && /Page builder: Shogun \(selected/.test(await out(A)));
  await typeIn(A, '.extra', 'Keep the mobile layout.');
  const body = await out(A);
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-act="copy"]').click()); await sleep(150);
  const copied = await A.evaluate(() => window.__clip);
  check('Copy = generated report (with the target section) + Additional instructions once', copied === body.replace(/\s+$/, '') + '\n\n## Additional instructions\n\nKeep the mobile layout.\n' && /Intended destination/.test(copied));
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-act="save-md"]').click()); await sleep(200);
  const saved = await A.evaluate(() => { const m = window.__sent.filter((x) => x.type === 'blueline:download').pop(); return { folder: m.folder, n: m.files.length, name: m.files[0].name, text: decodeURIComponent(m.files[0].dataUrl.replace('data:text/markdown;charset=utf-8,', '')) }; });
  check('Save as .md writes the same text as one standalone file', saved.text === copied && !saved.folder && saved.n === 1 && saved.name === 'blueline-change-report.md');
  check('The report stays read-only', await A.evaluate(() => __BL.S.ui.root.querySelector('.out').readOnly));

  // ---- Auto clears
  await select(A, '.tgt-cart', 'auto');
  check('Cart Auto clears its name and instructions', await A.evaluate(() => __BL.S.target.cartName === '' && __BL.S.target.cartNotes === '') && !/Rebuy Cart|Cart instructions from/.test(await out(A)));
  await select(A, '.tgt-platform', 'auto');
  t = await out(A);
  check('Platform Auto clears the platform override, theme and page builder', /Intended destination:\*\* Auto/.test(t) && !/Dawn Custom|Shogun\./.test(t.replace(/Shogun evidence[^\n]*/, '')) && await A.evaluate(() => { const o = __BL.S.target; return o.platform === 'auto' && o.theme === '' && o.builder === 'auto'; }) && !(await vis(A, '.tgt-shop')));

  // ---- isolation: nothing leaks into S.page, notes, mappings or storage
  await select(A, '.tgt-platform', 'shopify'); await typeIn(A, '.tgt-theme', 'LeakCheckTheme'); await select(A, '.tgt-builder', 'shogun'); await select(A, '.tgt-cart', 'custom'); await typeIn(A, '.tgt-cart-name', 'LeakCheckCart');
  await sleep(300);
  const after = await A.evaluate(() => ({ page: JSON.stringify(__BL.S.page), batch: JSON.stringify(__BL.S.batch), store: null }));
  const storeAfter = await A.evaluate(() => chrome.storage.local.get(null).then((o) => JSON.stringify(o)));
  check('Never written to S.page', after.page === pageBefore && !/LeakCheck/.test(after.page));
  check('Never written to notes, product mappings or approvals (batch byte-identical; mapping and variant id intact)', after.batch === batchBefore.replace('"Make the heading bigger"', '"Make the heading MUCH bigger"') && JSON.parse(after.batch).items[0].productMapping.variant.variantId === '4242');
  check('Never written to persistent storage', storeAfter === storeBefore && !/LeakCheck|Shogun/.test(storeAfter));
  check('No network request was made by any control (no store check, no SKU lookup)', await A.evaluate(() => window.__fetches.length === 0));
  check('The Product Library, card-mapping and library UI code never read the target selections', !/S\.target|\btarget\(\)|tgt-/.test(src('library.js') + src('library-ui.js') + src('cards.js') + src('tools.js') + src('page-hook.js') + src('background.js')));
  check('manifest.json: permissions unchanged (storage, unlimitedStorage, scripting, downloads)', JSON.stringify(JSON.parse(src('manifest.json')).permissions) === JSON.stringify(['storage', 'unlimitedStorage', 'scripting', 'downloads']));

  // ---- navigation isolation (hash route: a path change Blueline tracks, valid on a file: page)
  await A.evaluate(() => { location.hash = '#/other-page'; });
  await sleep(1800);
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.modal').hidden = false; }); await regen(A);
  t = await out(A);
  check('Navigating to another page drops the overrides (Auto again, cart integration Auto, fields empty)', await A.evaluate(() => { const r = __BL.S.ui.root; return r.querySelector('.tgt-platform').value === 'auto' && r.querySelector('.tgt-cart').value === 'auto' && r.querySelector('.tgt-theme').value === '' && r.querySelector('.tgt-cart-name').value === ''; }) && /Intended destination:\*\* Auto/.test(t) && !/LeakCheck/.test(t));
  await select(A, '.tgt-platform', 'shopify');
  await A.evaluate(() => { location.hash = ''; }); await sleep(1800);
  check('...and going back does not bring the first page’s selections back', await A.evaluate(() => __BL.S.target.platform === 'auto'));
  // Clear batch also resets the memory-only selections
  await select(A, '.tgt-platform', 'shopify');
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.modal').hidden = true; });
  await A.evaluate(() => { const b = __BL.S.ui.root.querySelector('[data-act="clear"]'); b.disabled = false; b.click(); }); await sleep(100);
  await A.evaluate(() => { __BL.S.ui.root.querySelector('[data-act="clear"]').click(); }); await sleep(500);
  check('Clear batch resets the selections', await A.evaluate(() => (__BL.S.target?.platform || 'auto') === 'auto'));
}

console.log('\n# Slice C1 refinement: Auto shows what it will use (a live, non-file page with Shopify globals and markers)');
{
  const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(readFileSync(join(here, 'fixtures', 'c1.html'))); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/products/omega`;
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(url);
  await page.evaluate(() => { window.Shopify = { shop: 'demo.myshopify.com', theme: { name: 'MAIN', id: 123, role: 'main' } }; });
  await page.addScriptTag({ content: STUB });
  await page.addScriptTag({ content: REAL_STORAGE });
  for (const f of ['page-hook.js', 'content.js', 'library.js', 'cards.js', 'tools.js', 'library-ui.js']) await page.addScriptTag({ content: src(f) });
  await page.waitForFunction(() => window.__BL?.S?.active && window.__BL.S.ui);
  await sleep(200);
  const A = page;
  await addDom(A, '<div class="shogun-root"><div class="shg-row">x</div></div><div id="upcart-container"></div>');
  const live = await A.evaluate((url) => { const pg = __BL.S.page; return { pg, n: { id: 'n1abcd', type: 'polish', kind: 'element', note: 'Bigger', url, path: '/products/omega', title: 'x', createdAt: 1, viewport: { w: 1280, h: 900 }, selector: '#a', tag: 'div', mode: 'shopify', page: pg, el: { label: 'h1', selector: '#a', size: '300x40' }, productMapping: { product: { key: 'sku:A', name: 'Acme Omega' }, approved: { title: 'Acme Omega' }, variant: { url: 'https://shop.test/products/omega?variant=4242', handle: 'omega', variantId: '4242' }, identity: { state: 'exact' } } } }; }, url);
  await A.evaluate((n) => { __BL.S.batch = { id: 'b1', items: [n], guides: [] }; __BL.S.ui.root.querySelector('.modal').hidden = false; }, live.n);
  await regen(A);
  const pageBefore = await A.evaluate(() => JSON.stringify(__BL.S.page));
  const batchBefore = await A.evaluate(() => JSON.stringify(__BL.S.batch));
  const storeBefore = await A.evaluate(() => chrome.storage.local.get(null).then((o) => JSON.stringify(o)));
  const optTxt = (sel) => A.evaluate((sel) => [...__BL.S.ui.root.querySelectorAll(`${sel} option`)].map((o) => o.textContent).join('|'), sel);
  check('Test page really exposes Shopify globals (theme MAIN)', live.pg?.theme?.name === 'MAIN' && live.pg?.shop === 'demo.myshopify.com', JSON.stringify(live.pg));
  check('Auto platform option shows the detected platform', (await optTxt('.tgt-platform')).startsWith('Auto (detected: Shopify)|'), await optTxt('.tgt-platform'));
  check('Shopify theme and builder controls are visible under Auto, with detected values beside them (no blank-looking fields)', await vis(A, '.tgt-shop') && await A.evaluate(() => __BL.S.ui.root.querySelector('.tgt-theme').placeholder) === 'Detected: MAIN (override optional)' && (await optTxt('.tgt-builder')).startsWith('Auto (detected: Shogun)|'));
  check('The override controls are still blank/Auto: nothing is silently filled in', await A.evaluate(() => { const r = __BL.S.ui.root; return r.querySelector('.tgt-platform').value === 'auto' && r.querySelector('.tgt-theme').value === '' && r.querySelector('.tgt-builder').value === 'auto'; }));
  check('Add to Cart stays OFF by default, with its options hidden', await A.evaluate(() => !__BL.S.exportCart && !__BL.S.ui.root.querySelector('.opt-cart').checked) && !(await vis(A, '.cart-opts')));
  let t = await out(A);
  check('Auto report: destination resolves to Shopify, source-derived and to be verified', /Intended destination:\*\* Auto, which resolves to Shopify from the inspected page \(source-derived; verify it matches the destination project/.test(t), section(t));
  check('Auto report: detected theme and Shogun carried over, each labelled source-derived with a verify note', /Theme: `MAIN` \(source-derived from the inspected page; the destination theme may differ, so verify it\)/.test(t) && /Page builder: Shogun \(source-derived: markers were found on the inspected page; verify the destination page is built with it\)/.test(t) && /Shogun \(unconfirmed\): if the destination page is a Shogun page/.test(t));
  check('Auto report: observed facts still reported separately (theme, Shogun evidence, UpCart marker)', /Theme metadata: "MAIN" \(main, id 123\) on demo\.myshopify\.com/.test(t) && /Shogun evidence: Shogun page markup/.test(t) && /Cart integration: UpCart \(marker found\)/.test(t));
  check('Auto with cart OFF: no cart request and no UpCart instruction', /## Add to Cart\n- Not requested/.test(t) && !/Source-detected cart integration/.test(t));
  await cart(A, true);
  check('Cart ON: options appear and Auto shows the detected integration (UpCart)', await vis(A, '.cart-opts') && (await optTxt('.tgt-cart')).startsWith('Auto (detected: UpCart)|'));
  t = await out(A);
  check('Cart ON + Auto: report names UpCart as source-detected, unconfirmed for the destination, to verify; Shopify routes guidance included', /Source-detected cart integration: `UpCart` \(a marker on the inspected page, not confirmed for the destination\)\. Verify the destination project actually uses it/.test(t) && /window\.Shopify\.routes\.root/.test(t) && /exact product and variant ids/.test(t) && /4242/.test(t));
  check('Cart ON + Auto-detected Shopify: detection acknowledged, destination verification required, no contradiction', /Blueline detected Shopify on the inspected page, but the target project decides how; verify the destination platform first/.test(t) && !/Don’t assume Shopify/.test(t) && /If the destination is confirmed to be a Shopify theme|Shopify theme targets \(Shopify was detected/.test(t));
  await select(A, '.tgt-cart', 'theme');
  check('Theme cart under an unconfirmed (auto-detected) Shopify destination: routes only conditional', /If the destination is confirmed to be a Shopify theme: build Ajax routes from/.test(await out(A)) && !/(^|\. )Build Ajax routes from/m.test(await out(A)));
  check('Cart override still works: theme cart replaces the detected-app note', !/Source-detected cart integration/.test(await out(A)) && /existing theme cart/.test(await out(A)));
  await select(A, '.tgt-cart', 'custom'); await typeIn(A, '.tgt-cart-name', 'Custom Drawer');
  check('...and a custom integration overrides it', /`Custom Drawer`/.test(await out(A)) && !/Source-detected cart integration/.test(await out(A)));
  check('Custom integration: its own API/events first, Shopify routes only conditionally, no theme-cart bullet', /call that integration’s own add-to-cart and refresh mechanism/.test(await out(A)) && /Only if that integration itself uses Shopify Ajax routes/.test(await out(A)) && !/Shopify theme targets/.test(await out(A)));
  await select(A, '.tgt-cart', 'auto'); await cart(A, false);
  await typeIn(A, '.tgt-theme', 'Staging Theme'); await select(A, '.tgt-builder', 'other'); await typeIn(A, '.tgt-builder-name', 'PageFly');
  t = await out(A);
  check('Theme and builder overrides beat detected values and drop the source-derived wording', /Theme: `Staging Theme` \(selected in Blueline\)/.test(t) && /Page builder: PageFly \(selected in Blueline\)/.test(t) && !/Theme: `MAIN`/.test(t) && !/Shogun \(unconfirmed\)/.test(t));
  await select(A, '.tgt-platform', 'auto');
  check('Selecting Auto again clears the overrides and returns to the detected values', await A.evaluate(() => __BL.S.ui.root.querySelector('.tgt-theme').value === '' && __BL.S.ui.root.querySelector('.tgt-builder').value === 'auto') && /Theme: `MAIN` \(source-derived/.test(await out(A)));
  await select(A, '.tgt-platform', 'other');
  check('Other or unknown overrides the detected platform: no Shopify carried over', /other or unknown platform/.test(await out(A)) && !/Theme: `MAIN`/.test(await out(A)) && !(await vis(A, '.tgt-shop')));
  await select(A, '.tgt-platform', 'auto');
  // legacy notes: no saved mode must never be read as Shopify
  const saved0 = await A.evaluate(() => JSON.stringify(__BL.S.batch.items[0]));
  const setLegacy = async (drop) => { await A.evaluate((o) => { const it = JSON.parse(o.saved); for (const k of o.drop) delete it[k]; __BL.S.batch.items[0] = it; }, { saved: saved0, drop }); await regen(A); };
  await setLegacy(['mode', 'page']);
  t = await out(A);
  check('Legacy note with no mode and no page data: platform unknown (not Shopify, not plain HTML)', /Detected technology \(from the live page, may be incomplete\): unknown \(this note saved no platform data\)/.test(t) && !/Shopify theme/.test(t) && /Observed on the inspected page \(read-only facts\):\*\* Live page \(platform unknown\)\./.test(t));
  await setLegacy(['mode']);
  t = await out(A);
  check('Legacy note with no mode but saved Shopify page data: Shopify, from that evidence', /Detected technology[^\n]*Shopify theme "MAIN"/.test(t));
  await setLegacy(['mode', 'page']);
  await A.evaluate((o) => { const it = JSON.parse(o); it.mode = 'html'; it.page = {}; __BL.S.batch.items[0] = it; }, saved0); await regen(A);
  check('A note saved as plain HTML is reported as plain HTML', /Detected technology[^\n]*static HTML\/CSS\/JS/.test(await out(A)) && /Live page \(plain HTML\)/.test(await out(A)));
  await A.evaluate((o) => { __BL.S.batch.items[0] = JSON.parse(o); }, saved0); await regen(A);
  check('Original note restored for the isolation checks below', (await A.evaluate(() => JSON.stringify(__BL.S.batch.items[0]))) === saved0);
  check('S.page, notes, mappings and storage are untouched by detection and selections; no requests', (await A.evaluate(() => JSON.stringify(__BL.S.page))) === pageBefore && (await A.evaluate(() => JSON.stringify(__BL.S.batch))) === batchBefore && (await A.evaluate(() => chrome.storage.local.get(null).then((o) => JSON.stringify(o)))) === storeBefore && await A.evaluate(() => window.__fetches.length === 0));
  check('modeOf(S.page) is still shopify for this live page (unchanged logic)', await A.evaluate(() => __BL.modeOf(__BL.S.page)) === 'shopify');
  await A.evaluate(() => { window.__clip = null; navigator.clipboard.writeText = async (t) => { window.__clip = t; }; }); await typeIn(A, '.extra', 'Keep it.');
  const body = await out(A); await A.evaluate(() => __BL.S.ui.root.querySelector('[data-act="copy"]').click()); await sleep(150);
  check('Copy still = report + Additional instructions', (await A.evaluate(() => window.__clip)) === body.replace(/\s+$/, '') + '\n\n## Additional instructions\n\nKeep it.\n');
  await page.close(); server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
