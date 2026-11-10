// Slice B focused browser tests: read-only generated Change Report + Additional instructions (regeneration, copy, save, preservation).
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

const note = (text) => ({ id: 'n1abcd', type: 'polish', kind: 'element', note: text, url: 'file:///x.html', title: 'x', createdAt: 1, viewport: { w: 1280, h: 900 }, selector: '#a', tag: 'div' });
const ui = (P, fn, ...a) => P.evaluate(fn, ...a);
const out = (P) => P.evaluate(() => __BL.S.ui.root.querySelector('.out').value);
const vis = (P, sel) => P.evaluate((sel) => { const e = __BL.S.ui.root.querySelector(sel); return !!e && !e.hidden && e.getBoundingClientRect().height > 0; }, sel);
const click = async (P, act) => { await P.evaluate((a) => __BL.S.ui.root.querySelector(`[data-act="${a}"]`).click(), act); await sleep(150); };
const regen = async (P) => { await P.evaluate(() => __BL.refreshExport()); await sleep(150); };

console.log('\n# Slice B: read-only Change Report + Additional instructions (fixtures/card-groups.html)');
{
  const A = await open('card-groups.html');
  await A.evaluate((n) => { __BL.S.batch = { id: 'b1', items: [n], guides: [] }; }, note('Make the heading bigger'));
  await A.evaluate(() => { window.__sent = []; window.__clip = null; navigator.clipboard.writeText = async (t) => { window.__clip = t; }; chrome.runtime.sendMessage = async (m) => { window.__sent.push(m); return m && m.type === 'blueline:download' ? { paths: [{ id: 'prompt', path: '/dl/blueline-change-report.md' }] } : null; }; });
  const batchBefore = await A.evaluate(() => JSON.stringify(__BL.S.batch));
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.modal').hidden = false; });
  await regen(A);
  const gen0 = await out(A);
  const H = '\n\n## Additional instructions\n\n';
  const count = (t) => (t.match(/## Additional instructions/g) || []).length;
  const typeExtra = async (t) => { await A.evaluate((t) => { const e = __BL.S.ui.root.querySelector('.extra'); e.value = t; e.dispatchEvent(new Event('input', { bubbles: true })); }, t); await sleep(80); };
  const extraVal = () => A.evaluate(() => __BL.S.ui.root.querySelector('.extra').value);
  const lastSaved = () => A.evaluate(() => { const m = window.__sent.filter((x) => x.type === 'blueline:download').pop(); return { folder: m.folder, n: m.files.length, name: m.files[0].name, text: decodeURIComponent(m.files[0].dataUrl.replace('data:text/markdown;charset=utf-8,', '')) }; });
  const clip = async () => { await click(A, 'copy'); return A.evaluate(() => window.__clip); };

  check('The generated report is read-only (selectable, not editable)', await A.evaluate(() => __BL.S.ui.root.querySelector('.out').readOnly) && /Make the heading bigger/.test(gen0), gen0.slice(0, 80));
  check('No Reset button, confirmation or outdated-report notice exists', await A.evaluate(() => !__BL.S.ui.root.querySelector('[data-act^="report-reset"], .rep-note')));
  check('Additional instructions field is visible, labelled, editable', await vis(A, '.extra') && /Additional instructions/.test(await A.evaluate(() => __BL.S.ui.root.querySelector('.extra-wrap').textContent)) && await A.evaluate(() => !__BL.S.ui.root.querySelector('.extra').readOnly));

  check('Empty field: Copy is exactly the generated report, no heading', (await clip()) === gen0);
  await typeExtra('Keep the mobile layout.\nDo not touch checkout.');
  check('Typing instructions does not change the report text', (await out(A)) === gen0);
  let c = await clip();
  check('Copy = generated report + Additional instructions, once', c === gen0.replace(/\s+$/, '') + H + 'Keep the mobile layout.\nDo not touch checkout.\n' && count(c) === 1, c.slice(-80));
  await click(A, 'save-md'); await sleep(150);
  const sv = await lastSaved();
  check('Save as .md writes the same text once, as one standalone file (no folder)', sv.text === c && count(sv.text) === 1 && !sv.folder && sv.n === 1 && sv.name === 'blueline-change-report.md');
  check('Copying again does not duplicate the instructions', count(await clip()) === 1);

  await A.evaluate(() => { __BL.S.batch.items[0].note = 'Make the heading MUCH bigger'; }); await regen(A);
  check('The report regenerates automatically from changed notes', /MUCH bigger/.test(await out(A)));
  check('...and the instructions are preserved', (await extraVal()) === 'Keep the mobile layout.\nDo not touch checkout.');
  c = await clip();
  check('Copy has the latest report, then the instructions once', /MUCH bigger/.test(c) && c.endsWith(H + 'Keep the mobile layout.\nDo not touch checkout.\n') && count(c) === 1);
  await A.evaluate(() => { const b = __BL.S.ui.root.querySelector('.opt-cart'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(100);
  check('Add to Cart toggle still works and keeps the instructions', await A.evaluate(() => __BL.S.exportCart === true) && (await extraVal()).startsWith('Keep the mobile') && /MUCH bigger/.test(await out(A)));
  await A.evaluate(() => { const b = __BL.S.ui.root.querySelector('.opt-cart'); b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(100);
  check('Add to Cart OFF again: instructions still there', await A.evaluate(() => __BL.S.exportCart === false) && (await extraVal()).startsWith('Keep the mobile'));
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-act="modal-close"]').click()); await sleep(100);
  await A.evaluate(() => { __BL.S.ui.root.querySelector('.modal').hidden = false; }); await regen(A);
  check('Closing and reopening keeps the instructions', (await extraVal()) === 'Keep the mobile layout.\nDo not touch checkout.');
  await typeExtra('   ');
  check('Whitespace-only instructions: no heading', (await clip()) === (await out(A)));
  await typeExtra('Keep the mobile layout.');

  const batchAfter = await A.evaluate(() => JSON.stringify(__BL.S.batch));
  const stored = await A.evaluate(() => chrome.storage.local.get(null).then((o) => JSON.stringify(o)));
  check('Instructions are not written to notes or storage', !/mobile layout/.test(batchAfter) && !/mobile layout/.test(stored) && JSON.parse(batchBefore).items.length === JSON.parse(batchAfter).items.length);

  await A.evaluate(() => { const b = __BL.S.ui.root.querySelector('[data-act="clear"]'); b.disabled = false; b.click(); }); await sleep(100);
  await A.evaluate(() => { __BL.S.ui.root.querySelector('[data-act="clear"]').click(); }); await sleep(500);
  check('Clear batch clears the instructions', (await extraVal()) === '' && (await A.evaluate(() => __BL.S.extra)) === '');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
