// Slice D focused browser tests: product-card annotation scopes (one note applying to the corresponding element in several
// defined product cards): scope control and defaults, section identity, per-card matching, grouped CSS with per-target
// conflict state and individual exceptions, text-only grouped Change Reports, persistence and isolation.
//
// Usage: node slice-d.test.mjs [extension-dir]   (from tests/)
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
async function open(fixture = 'slice-d.html') {
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

// ---- helpers (all run in the page)
const defineCard = (P, id, mapping) => P.evaluate(async (id, mapping) => {
  const el = document.getElementById(id);
  const rec = { id: `rec-${id}`, cardRecord: true, note: '', createdAt: Date.now(), ...__BL.describe(el, 'change'), productCard: BluelineCards.describe(el) };
  if (mapping) rec.productMapping = { ...mapping, card: BluelineCards.describe(el) };
  await __BL.addItem(rec);
}, id, mapping);
const editor = async (P, sel) => { await P.evaluate((s) => __BL.openPop(document.querySelector(s)), sel); await sleep(350); };
const reopen = async (P, id) => { await P.evaluate((id) => __BL.openPop(null, __BL.findItem(id)), id); await sleep(350); };
const setNote = (P, t) => P.evaluate((t) => { const e = __BL.S.ui.root.querySelector('.pop-note'); e.value = t; e.dispatchEvent(new Event('input', { bubbles: true })); }, t);
const setCss = (P, prop, to, from = '0px') => P.evaluate((prop, to, from) => { const p = __BL.toolsApi.getP(); p.tweaks[prop] = { prop, from, to, rule: { key: 'element' } }; p.bps = new Set(['mobile', 'tablet', 'desktop']); __BL.toolsApi.updateCardScope(); }, prop, to, from);
const setBps = (P, bps) => P.evaluate((bps) => { __BL.toolsApi.getP().bps = new Set(bps); }, bps);
const pickScope = async (P, v) => { await P.evaluate((v) => { const r = __BL.S.ui.root.querySelector(`[name="cscope"][value="${v}"]`); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }, v); await sleep(250); };
const cs = (P) => P.evaluate(() => {
  const r = __BL.S.ui.root; const box = r.querySelector('.cs-box');
  const radios = [...r.querySelectorAll('[name="cscope"]')].map((x) => ({ v: x.value, on: x.checked, off: x.disabled }));
  const sd = r.querySelector('[data-d="scope"]');
  return { shown: !!box && !box.hidden, radios, mode: radios.find((x) => x.on)?.v, sum: r.querySelector('.cs-sum').textContent, detail: r.querySelector('.cs-detail').textContent, refresh: !r.querySelector('.cs-refresh').hidden, cssScope: !!sd && !sd.hidden };
});
const save = async (P) => { await P.evaluate(() => __BL.S.ui.root.querySelector('[data-act="pop-save"]').click()); await sleep(450); };
const dialog = (P) => P.evaluate(() => { const m = __BL.S.ui.root.querySelector('.cf-modal'); return m ? { groups: [...m.querySelectorAll('.cf-group')].map((g) => ({ target: g.querySelector('.cf-target code').textContent, rows: g.querySelectorAll('.cf-row').length })) } : null; });
const resolveDialog = async (P, value) => { await P.evaluate((v) => { const m = __BL.S.ui.root.querySelector('.cf-modal'); for (const row of m.querySelectorAll('.cf-row')) { const r = row.querySelector(`input[value="${v}"]`); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } m.querySelector('[data-cf="ok"]').click(); }, value); await sleep(450); };
const items = (P) => P.evaluate(() => JSON.parse(JSON.stringify(__BL.S.batch.items.filter((i) => !i.cardRecord))));
const px = (P, sel) => P.evaluate((s) => getComputedStyle(document.querySelector(s)).minHeight, sel);
const report = (P) => P.evaluate(() => __BLUELINE_TEST__.api.buildPrompt({ items: __BL.S.batch.items.filter((i) => !i.cardRecord), guides: [] }));
const closeEditor = async (P) => { await P.evaluate(() => __BL.closePop && __BL.closePop()); await sleep(250); };
const plan = (P, sel, setup) => P.evaluate((sel) => {
  const p = __BL.toolsApi.cardScopePlan(document.querySelector(sel));
  if (!p) return null;
  return { role: { key: p.role.key, ok: p.role.ok, basis: p.role.basis }, sec: { reliable: p.section.reliable, label: p.section.label, why: p.section.why }, limited: !!p.limited, rows: p.rows.map((r) => ({ id: r.cardEl.id, state: r.state, inSection: r.inSection, basis: r.basis, why: r.reasons[0] || '' })) };
}, sel);
const states = (pl, ids) => ids.map((i) => pl.rows.find((r) => r.id === i)?.state).join(',');
const MAP = (key, name, url, fields) => ({ product: { key, name }, approved: { title: name }, variant: { url, handle: url.split('/products/')[1]?.split('?')[0] || null, variantId: 1 }, identity: { state: 'exact' }, ...(fields ? { fields: { items: fields } } : {}) });

// =============================================================================================================
console.log('\n# Slice D: product-card annotation scopes (fixtures/slice-d.html)');
{
  const A = await open();
  await defineCard(A, 'a1');

  // ---- B. Section identity -------------------------------------------------------------------------------
  const sec = await A.evaluate(() => {
    const I = (id) => BluelineCards.sectionInfo(document.getElementById(id));
    const a1 = I('a1'); const a4 = I('a4'); const b1 = I('b1'); const c1 = I('c1'); const d1 = I('d1');
    const gone = BluelineCards.resolveSection({ tag: 'section', path: '#nope-x' });
    const dup = document.createElement('div'); dup.innerHTML = '<section data-blueline-product-section="Dup"></section><section data-blueline-product-section="Dup"></section>'; document.body.append(dup);
    const amb = BluelineCards.resolveSection({ tag: 'section', explicit: 'Dup' });
    dup.remove();
    return { a1: [a1.reliable, a1.label], same: a1.node === a4.node, ab: a1.node !== b1.node, labels: [a1.label, b1.label], c: [c1.reliable, c1.label], d: [d1.reliable, d1.node === null, d1.why], gone: gone.state, amb: amb.state, ref: a1.ref };
  });
  check('B: cards in one section share one section container, labelled by its heading', sec.a1[0] && sec.a1[1] === 'Featured Deals' && sec.same);
  check('B: two sections with IDENTICAL headings are different sections (identity is the container, not the heading text)', sec.labels[0] === sec.labels[1] && sec.ab, JSON.stringify(sec.labels));
  check('B: a section with no heading is still reliable, and has no invented label', sec.c[0] === true && sec.c[1] === null, JSON.stringify(sec.c));
  check('B: a card with no container around it has no reliable section (a heading alone is not a section)', sec.d[0] === false && sec.d[1] && /heading alone/.test(sec.d[2]), JSON.stringify(sec.d));
  check('B: a saved section reference that no longer resolves is "missing"; one that matches several containers is "ambiguous", never guessed', sec.gone === 'missing' && sec.amb === 'ambiguous', `${sec.gone} ${sec.amb}`);
  check('B: the saved section reference is data (tag, path), not a DOM node', sec.ref && sec.ref.tag === 'section' && typeof sec.ref.path === 'string' && sec.ref.path.length > 0);

  // ---- C. Matching ----------------------------------------------------------------------------------------
  let pl = await plan(A, '#a1 .nm');
  check('C: title in a defined card: other cards in the section match by their own title, including a card built with a wrapper (a3)', pl && pl.role.key === 'title' && states(pl, ['a1', 'a2', 'a3', 'a4', 'a5']) === 'matched,matched,matched,matched,matched', states(pl, ['a1', 'a2', 'a3', 'a4', 'a5']));
  check('C: the section scope holds exactly the five cards of its own section (same-heading section B is not mixed in)', pl.rows.filter((r) => r.inSection).map((r) => r.id).join() === 'a1,a2,a3,a4,a5', pl.rows.filter((r) => r.inSection).map((r) => r.id).join());
  check('C: unassigned cards (no Product Mapping) are eligible when their card and field are identified', pl.rows.filter((r) => r.id !== 'a1').every((r) => r.state !== 'matched' || r.basis === 'detected'));
  check('C: a hidden card is reported unavailable, not matched', pl.rows.find((r) => r.id === 'b3').state === 'unavailable');
  pl = await plan(A, '#a1 img');
  check('C: image role matches each card\'s own image (linked or not)', pl.role.key === 'image' && states(pl, ['a1', 'a2', 'a3', 'a4', 'a5']) === 'matched,matched,matched,matched,matched', states(pl, ['a1', 'a2', 'a3', 'a4', 'a5']));
  pl = await plan(A, '#a1 .go');
  check('C: button role matches each card\'s own Add to Cart control', pl.role.key === 'cta' && states(pl, ['a1', 'a2', 'a3', 'a4', 'a5']) === 'matched,matched,matched,matched,matched');
  pl = await plan(A, '#a1 .sale');
  check('C: price role matches each card\'s own sale price', pl.role.key === 'sale' && states(pl, ['a1', 'a2', 'a3', 'a4', 'a5']) === 'matched,matched,matched,matched,matched');
  pl = await plan(A, '#a1 .reg');
  check('C: a card without that element (a5 has no regular price) is reported missing, not forced', pl.role.key === 'regular' && states(pl, ['a1', 'a2', 'a3', 'a4']) === 'matched,matched,matched,matched' && ['missing', 'ambiguous'].includes(pl.rows.find((r) => r.id === 'a5').state), JSON.stringify(pl.rows.find((r) => r.id === 'a5')));
  pl = await plan(A, '#a1 .il');
  check('C: the product link is matched per card; a card whose only link is its Add to Cart control has no product link (missing), never the cart button', pl.role.key === 'link' && states(pl, ['a1', 'a2', 'a5']) === 'matched,matched,matched' && states(pl, ['a3', 'a4']) === 'missing,missing', `${pl.role.key} ${states(pl, ['a1', 'a2', 'a3', 'a4', 'a5'])}`);
  pl = await plan(A, '#a1 .pr');
  check('C: an element that is none of the fields matches by validated structure only: a card built differently (a3, price inside a wrapper) is missing, not guessed', pl.role.basis === 'structure' && states(pl, ['a1', 'a2', 'a4', 'a5']) === 'matched,matched,matched,matched' && pl.rows.find((r) => r.id === 'a3').state === 'missing', `${pl.role.basis} ${states(pl, ['a1', 'a2', 'a3', 'a4', 'a5'])}`);
  pl = await plan(A, '#a1');
  check('C: selecting the card itself scopes to the cards themselves', pl.role.key === 'card' && states(pl, ['a1', 'a2', 'a3', 'a4', 'a5']) === 'matched,matched,matched,matched,matched');

  // explicitly absent field + saved confirmed field + ambiguity
  await defineCard(A, 'a4', MAP('sku:D', 'Delta Greens', 'https://shop.test/products/delta?variant=14', { image: { state: 'unmapped' } }));
  pl = await plan(A, '#a1 img');
  check('C: a field the card was explicitly marked as not having is respected (absent), never matched', pl.rows.find((r) => r.id === 'a4').state === 'absent' && /no image/i.test(pl.rows.find((r) => r.id === 'a4').why), JSON.stringify(pl.rows.find((r) => r.id === 'a4')));
  {
    const B = await open();
    await B.evaluate(() => { const nm = document.querySelector('#a2 .nm'); const dupe = nm.cloneNode(true); dupe.textContent = 'Bravo Creatine XL'; nm.after(dupe); });
    await defineCard(B, 'a1');
    const pb = await plan(B, '#a1 .nm');
    check('C: a card with two equally likely titles is ambiguous and skipped (no first-match guess)', pb.rows.find((r) => r.id === 'a2').state === 'ambiguous', pb.rows.find((r) => r.id === 'a2').state);
    await B.close();
  }
  await A.evaluate(() => { const o = BluelineCards.discoverCards; window.__origDiscover = o; BluelineCards.discoverCards = (s, opts) => { const r = o(s, opts); return { ...r, cards: r.cards.concat(Array(150).fill(r.cards[0])) }; }; });
  pl = await plan(A, '#a1 .nm');
  await A.evaluate(() => { BluelineCards.discoverCards = window.__origDiscover; });
  check('C: when card discovery hits its limit the plan says so', pl.limited === true);
  const lonePl = await plan(A, '#lone');
  check('A: an element outside every defined product card has no card scope at all', lonePl === null);
  await A.close();
}

// =============================================================================================================
console.log('\n# Slice D: the Apply to control, defaults, save and reopen');
{
  const A = await open();
  await defineCard(A, 'a1');
  await editor(A, '#lone');
  let c = await cs(A);
  check('A: no "Apply to" control for an element outside product cards; the normal CSS scope control stays', !c.shown && c.cssScope);
  await closeEditor(A);

  await editor(A, '#a2 .nm');
  c = await cs(A);
  check('A: inside a defined card the compact Apply to control appears with exactly the three approved choices', c.shown && c.radios.map((r) => r.v).join() === 'card,section,page');
  check('A: reliable section + matching targets: a NEW note defaults to "Cards in this section"', c.mode === 'section', c.mode);
  check('A: the summary comes from resolved targets: "Featured Deals · 5 matching titles"', c.sum === 'Featured Deals · 5 matching titles', c.sum);
  check('A: in section mode the generic CSS scope control is replaced (not shown twice)', !c.cssScope);
  await pickScope(A, 'page');
  c = await cs(A);
  check('A: "All product cards on this page": 11 matching titles across the section groups, 1 hidden, counted not assumed', c.mode === 'page' && c.sum === '11 matching titles · 1 hidden', c.sum);
  await pickScope(A, 'card');
  c = await cs(A);
  check('A: "This card" shows no legacy CSS scope control either (one scope control inside product cards)', c.mode === 'card' && !c.cssScope && c.sum === '');
  await closeEditor(A);

  await editor(A, '#d1 .nm');
  c = await cs(A);
  check('A: no reliable section (no container): defaults to "This card", section choice is disabled and explained, page scope still offered', c.mode === 'card' && c.radios.find((r) => r.v === 'section').off && !c.radios.find((r) => r.v === 'page').off && /section/.test(c.detail), JSON.stringify(c));
  await pickScope(A, 'page');
  c = await cs(A);
  check('A: page scope resolves safely without a section ("11 matching titles across this page" style summary)', /matching titles/.test(c.sum) && /1 hidden/.test(c.sum), c.sum);
  await closeEditor(A);

  await editor(A, '#c1 .nm');
  c = await cs(A);
  check('A: a section without a heading is a reliable section: default is the section, summary uses a neutral name', c.mode === 'section' && c.sum === 'This section · 2 matching titles', c.sum);
  await closeEditor(A);

  // copy replacement stays one card
  await editor(A, '#a2 .nm');
  await A.evaluate(() => { const p = __BL.toolsApi.getP(); p.textEdit = { before: 'Bravo Creatine', after: 'Bravo Creatine 2' }; __BL.toolsApi.updateCardScope(); });
  c = await cs(A);
  check('A/F: a copy replacement is never turned into a group change: scope is forced to "This card" and the group choices are disabled', c.mode === 'card' && c.radios.filter((r) => r.v !== 'card').every((r) => r.off) && /this card only/i.test(c.sum), JSON.stringify(c));
  await closeEditor(A);

  // ---- group note, saved ------------------------------------------------------------------------------------
  await editor(A, '#a2 .nm');
  await setNote(A, 'Give every title in this section the same minimum height');
  await setCss(A, 'min-height', '60px');
  await sleep(200);
  const live = await A.evaluate(() => ['a1', 'a3', 'a4', 'a5', 'b1', 'c1'].map((id) => getComputedStyle(document.querySelector(`#${id} .nm`)).minHeight));
  check('D: while editing, the CSS preview shows on every other resolved target of the scope, and only those (sections B and C untouched)', live.slice(0, 4).every((v) => v === '60px') && live.slice(4).every((v) => v === '0px'), live.join());
  await save(A);
  let its = await items(A);
  const g = its[0];
  check('F: ONE user-facing note is saved, with additive group metadata (no fifteen duplicate notes)', its.length === 1 && g.cardScope && g.cardScope.mode === 'section' && g.cardScope.targets.length === 5 && g.elementEdits.length === 1, JSON.stringify(Object.keys(g)));
  check('F: reviewed membership records independent targets: own card identity, own reference, own selector, a source flag', g.cardScope.targets.every((t) => t.card?.v === 1 && t.ref?.tag && t.selector && t.where) && g.cardScope.targets.filter((t) => t.source).length === 1 && g.cardScope.targets.some((t) => t.selector !== g.cardScope.targets[0].selector));
  check('F: the section is stored as a revalidatable reference with its heading as a label', g.cardScope.section.label === 'Featured Deals' && g.cardScope.section.ref.path && g.cardScope.role.key === 'title' && g.cardScope.path === (await A.evaluate(() => __BL.currentPath())));
  check('D: after saving, the saved note\'s preview paints every confirmed target (5), none outside the section', (await A.evaluate(() => ['a1', 'a2', 'a3', 'a4', 'a5'].every((id) => getComputedStyle(document.querySelector(`#${id} .nm`)).minHeight === '60px') && ['b1', 'b2', 'c1', 'd1'].every((id) => getComputedStyle(document.querySelector(`#${id} .nm`)).minHeight === '0px'))));

  // reopen keeps the saved behaviour and membership
  await reopen(A, g.id);
  c = await cs(A);
  check('F: reopening the saved note keeps "Cards in this section" and says the membership is the saved one', c.mode === 'section' && /5 matching titles/.test(c.sum) && /Saved membership/.test(c.detail) && c.refresh, JSON.stringify(c));
  await closeEditor(A);

  // no automatic expansion
  await A.evaluate(() => { const row = document.getElementById('row-a'); const n = document.getElementById('a5').cloneNode(true); n.id = 'a6'; n.querySelector('.nm').textContent = 'Foxtrot New'; row.append(n); });
  await reopen(A, g.id);
  c = await cs(A);
  check('F: when the page changes, the saved note still shows its saved targets (the cards whose identity changed now need review), never a silently grown or shrunk set', c.shown && c.mode === 'section' && /need review/.test(c.sum) && /Saved membership/.test(c.detail) && (await items(A))[0].cardScope.targets.length === 5, JSON.stringify(c));
  await save(A);
  its = await items(A);
  check('F: updating a note whose page changed keeps its reviewed scope exactly as saved (the scope does not vanish)', its[0].cardScope && its[0].cardScope.targets.length === 5);
  // the person re-confirms the card on the changed page: a fresh scan sees six cards, the saved note still has five
  await A.evaluate(async () => { const it = __BL.findItem('rec-a1'); it.productCard = BluelineCards.describe(document.getElementById('a1')); await __BL.saveBatch(); });
  const planNow = await plan(A, '#a1 .nm');
  check('F: a fresh scan sees 6 cards in the section, but nothing is added to the saved note', planNow.rows.filter((r) => r.inSection && r.state === 'matched').length === 6 && (await items(A))[0].cardScope.targets.length === 5);
  await reopen(A, g.id);
  await A.evaluate(() => __BL.S.ui.root.querySelector('[data-x="cs-refresh"]').click()); await sleep(250);
  c = await cs(A);
  check('F: "Refresh targets" is the explicit, minimal way to update membership: it re-scans (6) and says to Update to save', /6 matching titles/.test(c.sum) && /Update the note/.test(c.detail) && !c.refresh, JSON.stringify(c));
  await save(A);
  its = await items(A);
  check('F: after Refresh + Update, the note holds the refreshed membership', its[0].cardScope.targets.length === 6);
  await A.evaluate(() => document.getElementById('a6').remove());
  await A.evaluate(async () => { const it = __BL.findItem('rec-a1'); it.productCard = BluelineCards.describe(document.getElementById('a1')); await __BL.saveBatch(); });

  // legacy note keeps its behaviour
  await A.evaluate(async () => { const el = document.querySelector('#b2 .nm'); await __BL.addItem({ id: 'legacy1', note: 'Older single-card note', createdAt: 1, ...__BL.describe(el, 'change') }); });
  await reopen(A, 'legacy1');
  c = await cs(A);
  check('A/F: an existing saved note (no card scope) opens as "This card" even though new notes default to the section', c.shown && c.mode === 'card');
  await save(A);
  its = await items(A);
  check('F: re-saving an existing single-card note adds no group scope (old notes never acquire one)', !its.find((i) => i.id === 'legacy1').cardScope);
}

// =============================================================================================================
console.log('\n# Slice D: per-card CSS conflicts, exceptions, breakpoints');
{
  const A = await open();
  await defineCard(A, 'a1');
  await editor(A, '#a2 .nm');
  await setNote(A, 'Section titles: minimum height');
  await setCss(A, 'min-height', '60px');
  await setBps(A, ['mobile', 'tablet', 'desktop']);
  await save(A);
  const g0 = (await items(A))[0];

  // exception for card 3 only: a single-card note with a different value
  await editor(A, '#a3 .nm');
  await pickScope(A, 'card');
  await setNote(A, 'Card 3 needs a taller title');
  await setCss(A, 'min-height', '80px');
  await save(A);
  const d = await dialog(A);
  check('D: a one-card exception conflicts with the group on THAT card only (one target, not five)', d && d.groups.length === 1 && d.groups[0].rows === 1, JSON.stringify(d));
  await resolveDialog(A, 'new');
  const its = await items(A);
  const grp = its.find((i) => i.cardScope);
  const ex = its.find((i) => !i.cardScope);
  const t3 = grp.cardScope.targets.find((t) => t.set);
  const others = grp.cardScope.targets.filter((t) => t !== t3 && t.where !== t3?.where);
  check('D: keeping the exception sets the group value aside for card 3 alone (target-specific state in the group note)', t3 && t3.where === 'card 3 of 5' && t3.set?.['min-height']?.bps?.length === 3 && others.length === 4 && others.every((t) => !t.set), JSON.stringify(grp.cardScope.targets.map((t) => [t.where, t.set])));
  check('D: nothing is deleted: the group note still carries 60px (its shared value), the exception note carries 80px', grp.elementEdits[0].tweaks.find((t) => t.prop === 'min-height').to === '60px' && ex.elementEdits[0].tweaks.find((t) => t.prop === 'min-height').to === '80px');
  await A.evaluate(() => __BL.toolsApi.getP && 0); await sleep(300);
  const heights = await A.evaluate(() => { __BL.toolsApi.getP(); return ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => getComputedStyle(document.querySelector(`#${id} .nm`)).minHeight); });
  check('D: effective result 60 / 60 / 80 / 60 / 60 (the exception affects only card 3)', heights.join() === '60px,60px,80px,60px,60px', heights.join());

  let rep = await report(A);
  const section = rep.slice(rep.indexOf('Scope: cards in this section'));
  check('E/G: the report gives the effective shared CSS once, and names card 3 as an individual exception with the winning value', /Effective CSS.*4 of 5 targets/.test(section) && /Individual exceptions \(1\)/.test(section) && /card 3 of 5/.test(section.slice(section.indexOf('Individual exceptions'))) && /min-height: 80px/.test(section), section.slice(0, 1800));
  check('G: the set-aside 60px is not exported as active for card 3 (it is described as not applied there)', /min-height: 60px is not applied at all screen sizes/.test(section));
  check('G: the exception note is exported normally with its own 80px (one active value per card)', /0px → 80px|min-height: 0px → 80px/.test(rep.slice(rep.indexOf('Card 3 needs a taller title'))));

  // reactivation: deleting the exception note brings the group value back for card 3
  await A.evaluate(async (id) => { const items = __BL.S.batch.items; const i = items.findIndex((x) => x.id === id); const [it] = items.splice(i, 1); __BL.hook('onItemDeleted', it); __BL.hooks.afterItemDeleted && __BL.hooks.afterItemDeleted(); await __BL.saveBatch(); }, ex.id);
  const after = (await items(A)).find((i) => i.cardScope);
  check('D: removing the winning exception reactivates card 3\'s group value (inactive state cleared), never lost', after.cardScope.targets.every((t) => !t.set), JSON.stringify(after.cardScope.targets.map((t) => t.set)));
  rep = await report(A);
  check('D: ...and the report is back to one shared CSS block for all 5 targets with no exceptions', /Effective CSS\*\* for all 5 targets/.test(rep) && !/Individual exceptions/.test(rep));

  // breakpoints: an exception at one size only
  await editor(A, '#a3 .nm');
  await pickScope(A, 'card');
  await setNote(A, 'Card 3 taller on mobile');
  await setCss(A, 'min-height', '90px');
  await setBps(A, ['mobile']);
  await save(A);
  const d2 = await dialog(A);
  check('D: an exception at a non-overlapping size set conflicts only where sizes overlap (mobile)', !!d2);
  await resolveDialog(A, 'new');
  const grp2 = (await items(A)).find((i) => i.cardScope);
  const t3b = grp2.cardScope.targets.find((t) => t.set);
  check('D: the group is set aside for card 3 on MOBILE only; tablet and desktop keep the group value', t3b && t3b.set['min-height'].bps.join() === 'mobile', JSON.stringify(t3b?.set));
  rep = await report(A);
  const sec2 = rep.slice(rep.indexOf('Scope: cards in this section'));
  check('E/G: the report says the exception is mobile-only and the group value still applies at tablet and desktop for that card', /not applied at mobile/.test(sec2) && /still applies at tablet \+ desktop/.test(sec2), sec2.slice(0, 1500));

  // multiple properties
  await reopen(A, grp2.id);
  await setCss(A, 'margin-bottom', '12px');
  await save(A);
  const grp3 = (await items(A)).find((i) => i.cardScope);
  rep = await report(A);
  check('D: several properties in one group note are all exported as the shared CSS, with the exception still limited to its property and size', grp3.elementEdits[0].tweaks.length === 2 && /margin-bottom/.test(rep) && /min-height/.test(rep) && !/margin-bottom: 12px is not applied/.test(rep));
  await A.close();
}

// =============================================================================================================
console.log('\n# Slice D: text-only grouped Change Reports');
{
  const A = await open();
  await defineCard(A, 'a1', MAP('sku:A', 'Alpha Protein', 'https://shop.test/products/alpha?variant=11'));
  await defineCard(A, 'a2', MAP('sku:B', 'Bravo Creatine', 'https://shop.test/products/bravo?variant=12'));
  await defineCard(A, 'a3');
  await defineCard(A, 'a5', MAP('sku:E', 'Echo Sleep', 'https://shop.test/products/echo-sleep?variant=15'));
  await editor(A, '#a1 img');
  await pickScope(A, 'page');
  const sum = (await cs(A)).sum;
  await setNote(A, 'Make each product image clickable and link it to that product\u2019s respective product page.');
  await save(A);
  const its = await items(A);
  const n = its[0];
  check('E: a note with ONLY written instructions (no CSS) still carries the group scope and targets', n.cardScope && n.cardScope.mode === 'page' && n.cardScope.role.key === 'image' && !(n.elementEdits[0].tweaks || []).length, sum);
  const rep = await report(A);
  const body = rep.slice(rep.indexOf('Scope: all product cards on this page'));
  check('E: the report exports the text-only group: scope, current page, role, real counts and the shared instruction', /all product cards on this page/.test(body) && /corresponding product image in each of the 11 matched product cards/.test(body) && /Shared instruction: .*clickable/.test(body) && /Other pages are not affected/.test(body), body.slice(0, 900));
  check('E: it lists the corresponding elements, one per matched card', (body.match(/ \u201c[^”]*\u201d: `/g) || []).length >= 11);
  check('E: it names unavailable cards (the hidden one) rather than counting them', /Left out \(1\)/.test(body) && /hidden/.test(body));
  check('E: each card links to ITS OWN approved product page (from its Product Mapping), with the approved variant parameter kept', /card \d+ of \d+ \u201cAlpha Protein\u201d.*products\/alpha\?variant=11`/.test(body) && /\u201cBravo Creatine\u201d.*products\/bravo\?variant=12`/.test(body) && /\u201cEcho Sleep\u201d.*products\/echo-sleep\?variant=15`/.test(body));
  check('E: a card with no mapping falls back to a verified existing link already on the card (a3 has none: unresolved, a1/a2 aside)', /\u201cCharlie Omega\u201d: \*\*destination not resolved\*\*/.test(body));
  check('E: unresolved destinations are called out and the report says not to guess a URL', /Unresolved product pages \(\d+\)/.test(body) && /do not guess a URL/.test(body));
  const perCard = body.slice(body.indexOf('Per card:'));
  check('E: the Add to Cart address is never used as a product page', !/cart\/add/.test(perCard.replace(/Keep image source/g, '')) );
  check('E: image source, product page link and Add to Cart are stated as three separate things, and no card\'s product data is copied', /image source\*\* \(the asset URL\), the \*\*product page link\*\* \(where a click goes\) and \*\*Add to Cart\*\*/.test(body) && /Do not copy the source card/.test(body));
  check('E: image sources are preserved per card (each card keeps its own asset URL)', /Keep image source `\/img\/a1\.jpg`/.test(perCard) || /Keep image source `[^`]*a1\.jpg`/.test(perCard));
  check('E: an image already inside a link is flagged so no nested anchor is created', /Already inside a link to `\/products\/alpha`/.test(perCard));
  check('E: a note that has no link wording does not get per-card destinations', await (async () => { await reopen(A, n.id); await setNote(A, 'Round the corners of every product image'); await save(A); const r = await report(A); return !/Per card:/.test(r) && /Round the corners/.test(r) && /corresponding product image/.test(r); })());
  await A.evaluate(async () => { const el = document.querySelector('#a1 .nm'); await __BL.addItem({ id: 'mapped-note', note: 'Mapped single-card note', createdAt: 5, ...__BL.describe(el, 'change'), productMapping: { product: { key: 'sku:A', name: 'Alpha Protein' }, approved: { title: 'Alpha Protein' }, variant: { url: 'https://shop.test/products/alpha?variant=11', handle: 'alpha', variantId: 11 }, identity: { state: 'exact' }, card: BluelineCards.describe(document.getElementById('a1')) } }); });
  const mrep = await report(A);
  const mpart = mrep.slice(mrep.indexOf('Mapped single-card note'));
  check('G: a single-card Product Mapping note is exported as before: its mapping block is present and it gets no group scope text', /Product Mapping|product mapping|Alpha Protein/.test(mpart) && !/Scope: (cards in this section|all product cards)/.test(mpart.slice(0, mpart.indexOf('Round the corners') > 0 ? mpart.indexOf('Round the corners') : mpart.length)), mpart.slice(0, 600));

  // exclusion
  await A.evaluate(async () => { const el = document.getElementById('b2'); const L = BluelineLibrary; await __BL.addItem(L.newExclusionRecord(__BL.describe(el, 'change'), BluelineCards.describe(el), 'ex-b2', Date.now(), 'not-a-card')); });
  const pl = await plan(A, '#a1 img');
  check('C/E: a card marked "not a card" is excluded from every scope and reported as excluded', pl.rows.find((r) => r.id === 'b2').state === 'excluded');
  await A.close();
}

// =============================================================================================================
console.log('\n# Slice D: saved targets that change, persistence and page isolation');
{
  const A = await open();
  await defineCard(A, 'a1');
  await editor(A, '#a2 .nm');
  await setNote(A, 'Shared title look');
  await setCss(A, 'min-height', '60px');
  await save(A);
  const g = (await items(A))[0];
  const stateOf = (rows, i) => rows[i].state;
  const resolve = () => A.evaluate((id) => __BL.toolsApi.resolveCardScope(__BL.findItem(id).cardScope, { fresh: true }).rows.map((r) => ({ w: r.t.where, state: r.state })), g.id);
  let rows = await resolve();
  check('C: all five saved targets resolve as confirmed on the unchanged page', rows.map((r) => r.state).join() === 'confirmed,confirmed,confirmed,confirmed,confirmed', rows.map((r) => r.state).join());
  await A.evaluate(() => document.querySelector('#a2 .nm').remove());
  rows = await resolve();
  const confirmedNow = rows.filter((r) => r.state === 'confirmed').length;
  check('C: a target whose element was removed becomes "review", never re-pointed to another element (the changed group is re-checked conservatively)', rows[1].state === 'review' && rows.every((r) => ['confirmed', 'review'].includes(r.state)), rows.map((r) => r.state).join());
  let rep = await report(A);
  check('E: the report lists the unmatched target under "needs review" and counts only confirmed ones', /Not applied, needs review \(\d\)/.test(rep) && new RegExp(`each of the ${confirmedNow} matched product card`).test(rep) && /card 2 of 5/.test(rep.slice(rep.indexOf('needs review'))), rep.slice(rep.indexOf('Scope: cards'), rep.indexOf('Scope: cards') + 900));
  await A.evaluate(() => { const nm = document.querySelector('#a4 .nm'); const w = document.createElement('div'); w.className = 'wrap-x'; nm.before(w); w.append(nm); });
  rows = await resolve();
  check('C: a target that moved inside its card is NOT silently re-pointed: it needs review', rows[3].state === 'review', rows[3].state);
  await A.evaluate(() => { const row = document.getElementById('row-a'); row.insertBefore(document.getElementById('a5'), document.getElementById('a1')); });
  rows = await resolve();
  check('C: when cards are reordered, targets are not matched by position: each card is checked by its own identity', rows.every((r) => ['confirmed', 'review'].includes(r.state)));
  await A.close();

  // other pages and legacy generic scope
  const B = await open('card-groups.html');
  await B.evaluate(async (item) => { await __BL.addItem({ ...item, id: 'foreign', path: '/other/page.html', url: 'file:///other/page.html' }); }, g);
  const inView = await B.evaluate(() => !!__BL.S.batch?.items?.some((i) => i.id === 'foreign'));
  check('F: a group note saved for another page is not part of this page\'s workspace (page scope never reaches other pages)', inView === false);
  const resOther = await B.evaluate((g) => __BL.toolsApi.resolveCardScope({ ...g.cardScope, path: '/other/page.html' }).rows.map((r) => r.state).join(), g);
  check('F: a saved scope for another path is never evaluated against this page ("unchecked")', /^unchecked/.test(resOther));
  // existing generic scope behaviour unchanged for ordinary annotations
  await B.evaluate((s) => __BL.openPop(document.querySelector(s)), 'h2#h-feat'); await sleep(300);
  const generic = await cs(B);
  check('F: ordinary annotations outside defined product cards keep the existing scope control unchanged', !generic.shown && generic.cssScope);
  await B.close();
}

// =============================================================================================================
console.log('\n# Slice D cleanup: one scope control, accurate wording, variant links, breakpoints');
{
  const A = await open();
  await defineCard(A, 'a1', MAP('sku:A', 'Alpha Protein', 'https://shop.test/products/alpha?variant=11'));
  await defineCard(A, 'a2', MAP('sku:B', 'Bravo Creatine', 'https://shop.test/products/bravo'));
  await defineCard(A, 'a3', MAP('sku:C', 'Charlie Omega', 'https://shop.test/cart/add?id=13'));
  await defineCard(A, 'a4', MAP('sku:D', 'Delta Greens', 'not a url'));
  await defineCard(A, 'a5', { ...MAP('sku:E', 'Echo Sleep', 'https://shop.test/products/echo?variant=15'), identity: { state: 'substitute-pending' } });

  // 1. one scope control in every product-card mode; "This card" is restricted for real
  await editor(A, '#a2 .nm');
  for (const m of ['card', 'section', 'page']) { await pickScope(A, m); const c = await cs(A); check(`1: "${m}" mode shows only the Apply to control (no legacy "Apply CSS changes to")`, c.shown && !c.cssScope && c.mode === m, JSON.stringify(c)); }
  await A.evaluate(() => { const p = __BL.toolsApi.getP(); p.scope = 'all'; p.scopeTouched = true; });
  await pickScope(A, 'card');
  const forced = await A.evaluate(() => { const p = __BL.toolsApi.getP(); return [p.scope, [...p.edits.values()].map((r) => r.scope).join()]; });
  check('1: in "This card" a stray legacy site-wide scope is reset to "just this one" (behavior, not only hidden)', forced[0] === 'one' && !/all|group/.test(forced[1]), JSON.stringify(forced));
  await setNote(A, 'This card only'); await setCss(A, 'min-height', '70px'); await setBps(A, ['desktop']);
  await save(A);
  const n = (await items(A))[0];
  check('1: the saved single-card note has no group scope and a "just this one" CSS scope (cannot expand)', !n.cardScope && (!n.elementEdits[0].scope || n.elementEdits[0].scope.mode === 'one'), JSON.stringify(n.elementEdits[0].scope));
  const others = await A.evaluate(() => ['a1', 'a3', 'a4', 'a5', 'b1'].map((id) => getComputedStyle(document.querySelector(`#${id} .nm`)).minHeight).join());
  check('1: only the selected title is changed; no other card is touched', (await px(A, '#a2 .nm')) === '70px' && others === '0px,0px,0px,0px,0px', others);
  const rep1 = await report(A);
  check('1: its export does not claim a group or site-wide scope', !/Scope: (cards in|all product|everywhere)/.test(rep1.slice(rep1.indexOf('This card only'))));
  await A.evaluate(async () => { const el = document.querySelector('#b1 .nm'); await __BL.addItem({ id: 'legacy-all', note: 'Legacy site-wide', createdAt: 1, ...__BL.describe(el, 'change'), elementEdits: [{ el: { label: 'h3.nm', selector: __BL.cssPath(el) }, scope: { mode: 'all', count: 12, selector: 'h3.nm', chosen: true, similar: 12 }, tweaks: [] }] }); });
  await reopen(A, 'legacy-all');
  const lc = await cs(A);
  check('1: an existing note saved with a legacy site-wide scope still shows and keeps that control (backward compatible)', lc.cssScope, JSON.stringify(lc));
  await save(A);
  check('1: ...and re-saving keeps its scope as it was', (await items(A)).find((i) => i.id === 'legacy-all').elementEdits[0].scope.mode === 'all');
  await closeEditor(A);

  await editor(A, '#lone');
  const oc = await cs(A);
  check('1: an ordinary annotation outside product cards keeps the generic CSS scope control', !oc.shown && oc.cssScope);
  await A.evaluate(() => { const r = __BL.S.ui.root.querySelector('[name="scope"][value="all"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
  check('1: ...and its scope choice still works', await A.evaluate(() => __BL.toolsApi.getP().scope === 'all'));
  await closeEditor(A);

  // 2. wording
  await editor(A, '#a2 .nm'); await pickScope(A, 'section');
  await setNote(A, 'Section titles'); await setCss(A, 'min-height', '100px'); await save(A); if (await dialog(A)) await resolveDialog(A, 'existing'); // keeps the earlier single-card 70px on that title
  let rep = await report(A);
  const gpart = rep.slice(rep.indexOf('Section titles'));
  check('2: grouped CSS says it applies to each matched target, not "this element only"', /CSS to apply to each matched target/.test(gpart) && !/CSS on this element only/.test(gpart), gpart.slice(0, 1500));
  check('2: the report introduction describes grouped previews accurately', /selected element only \(except notes scoped to several product cards, which were previewed on each matched target\)/.test(rep));
  check('2: an individual annotation keeps its original wording', /CSS on this element only/.test(rep.slice(rep.indexOf('This card only'), rep.indexOf('Section titles'))), rep.slice(rep.indexOf('This card only'), rep.indexOf('This card only') + 900));
  const saveItems = await A.evaluate(() => __BL.S.batch.items.map((i) => i.id));
  const rep2 = await A.evaluate(() => __BLUELINE_TEST__.api.buildPrompt({ items: __BL.S.batch.items.filter((i) => !i.cardRecord && !i.cardScope), guides: [] }));
  check('2: with no grouped note the introduction is the original sentence', /selected element only and are the target/.test(rep2) && !/except notes scoped/.test(rep2));

  // 3. variant links
  await editor(A, '#a1 img'); await pickScope(A, 'section');
  await setNote(A, 'Make each product image clickable and link it to its product page.');
  await save(A);
  rep = await report(A);
  const per = rep.slice(rep.indexOf('Per card:'));
  check('3: an approved mapping URL keeps its variant parameter exactly', /“Alpha Protein”: product page `https:\/\/shop\.test\/products\/alpha\?variant=11`/.test(per), per.slice(0, 500));
  check('3: a mapping URL without a variant is exported as approved, not given a variant', /“Bravo Creatine”: product page `https:\/\/shop\.test\/products\/bravo`/.test(per) && !/bravo\?variant/.test(per));
  check('3: a cart URL in a mapping is never used as the product page', /“Charlie Omega”: \*\*destination not resolved\*\*/.test(per) && !/cart\/add\?id=13/.test(per));
  check('3: an invalid mapping URL is not used or invented', /“Delta Greens”: \*\*destination not resolved\*\*/.test(per) && !/not a url/.test(per));
  check('3: an unapproved (pending substitution) mapping is not used as the destination', !/echo\?variant=15/.test(per) && /“Echo Sleep”/.test(per));
  check('3: unresolved cards are still called out and the image source stays separate', /Unresolved product pages \(\d\)/.test(per) && /Keep image source/.test(per) && /do not guess a URL/.test(per));

  // 4. breakpoints
  const g = (await items(A)).find((i) => i.note?.startsWith('Make each product image'));
  await reopen(A, g.id); await setBps(A, ['mobile']); await save(A);
  const g2 = (await items(A)).find((i) => i.note?.startsWith('Make each product image'));
  rep = await report(A);
  const seg = rep.slice(rep.indexOf('Make each product image'));
  check('4: a mobile-only text-only group note stays mobile-only and the report says so (heading and scope line)', g2.bps.join() === 'mobile' && /Applies at mobile\./.test(seg) && /\(mobile\)/.test(rep.slice(rep.indexOf('Make each product image') - 120, rep.indexOf('Make each product image'))), g2.bps.join());
  await editor(A, '#c1 .nm'); await pickScope(A, 'section'); await setNote(A, 'Tablet only title tweak'); await setCss(A, 'min-height', '55px'); await setBps(A, ['tablet']); await save(A);
  rep = await report(A);
  const tp = rep.slice(rep.indexOf('Tablet only title tweak'));
  check('4: a tablet-only CSS group note is exported for tablet only (not broadened)', /Applies at tablet\./.test(tp) && (await items(A)).find((i) => i.note === 'Tablet only title tweak').bps.join() === 'tablet');
  check('4: the tablet-only group is not painted at desktop width', (await px(A, '#c1 .nm')) === '0px', await px(A, '#c1 .nm'));
  await A.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
