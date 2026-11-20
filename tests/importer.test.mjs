// Product Library importer tests for the New Year SMP findings: "Current Price" as the regular price (CSV, JSON, DOCX),
// DOCX records kept apart from headings, descriptions and neighbouring products, and the source's own anomalies kept as is.
// Node only: no browser, no network, no npm dependencies.   Usage: node importer.test.mjs
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { zip, P } from './docx-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const L = createRequire(import.meta.url)(join(here, '..', 'library.js'));

let pass = 0;
let fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').slice(0, 8).join('\n      ')}`); }
};

// ------------------------------------------------------------------ fixture: the New Year SMP layout, brand "Acme"
// Word table cells hold the paragraphs; some records are one paragraph with soft line breaks, some are one paragraph per
// line, one paragraph holds two products. Headings put their "(list)" on the next line. Anomalies match the real document.
const cell = (...paras) => `<w:tc>${paras.join('')}</w:tc>`;
const docOf = (...cells) => `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:tbl><w:tr>${cells.join('')}</w:tr></w:tbl></w:body></w:document>`;
const rec = (name, sku, regLabel, reg, disc, extra = []) => [P(name), ...extra, P(`SKU: ${sku}`), P(`${regLabel} – ${reg}`), P(`Discount Price – ${disc}`)];
const THEMED = '(Design Team - Themed Products)';
const DATA = '(Data Driven for All Other Teams)';

const NY_XML = docOf(
  cell(P('Acme NY SMP - 2027'), P('Please look at both the Design Theme and Data Driven lists'), P('Launching: January 1st -11th, 2027'), P('Offer: 30% Off Collection'), P('Code: NY2027')),
  cell(
    P('Bundles Section'), P(THEMED),
    // one paragraph, soft line breaks between every field
    P('Acme Anti-Stress Kit', '\n', 'Includes: Ashwagandha Root Extract Capsules, L-Theanine Capsules, and Magnesium+ Extra Strength Capsules', '\n', 'SKU: STRESSBUNDLE', '\n', 'Current Price – $44.95', '\n', 'Discount Price –$31.47 ', '\n', 'Theme fit: “Make Time to Reset,” balancing workout goals with downtime.'),
    ...rec('Acme Magnesium Glycinate Double Bundle', 'MAG-2', 'Current Price', '$28.49', '$19.94', [P('Includes: Two bottles of Magnesium Glycinate')]),
    P('Theme fit: “Build Your Daily Routine,” a consistency-focused feature.'),
  ),
  cell(
    P('Highlighted Products'), P(THEMED),
    ...rec('Acme Electrolytes, Strawberry Lemonade, 60 servings', 'NTC620408', 'Current Price', '$19.97', '$13.98'),
    P('Theme fit: “Make Hydration a Habit.” An approachable New Year’s goal, with creative centered on a water bottle.'),
    ...rec('Acme Melatonin Capsules, 5 mg', 'NTC019101', 'Current Price', '$11.97', '$8.38'),
    P('Theme fit: “Make Time to Wind Down.” A bedtime-routine angle.'),
    P('Best Sellers'), P(THEMED),
    ...rec('Acme Pre-X Workout Complex Powder, Blue Raspberry, 30 servings', 'NTC270102', 'Current Price', '$27.97', '$19.58'),
    ...rec('Acme EAA Powder, Blue Raspberry', 'NTC462101', 'Current Price', '$21.97', '$15.38'),
    P('Product CTA (5 Products)'), P(THEMED),
    P('Acme Multivitamin Capsules'), P('SKU: NTC092101'), P('Current Price – $15.97'), P('Discount Price –'),
    // two products glued in one paragraph, status text instead of a discount
    P('Acme Peanut Butter Powder SKU: NTC279101 Current Price – $46.97 Discount Price – OUT OF STOCK', 'Acme Matcha Powder, Culinary Grade SKU: NTC316101 Current Price - $16.97 Discount Price - OUT OF STOCK'),
    ...rec('Acme Vitamin C with Rose Hips Capsules, 120 capsules', 'NTC153201', 'Current Price', '$15.97', '$22.36'),
  ),
  cell(
    P('Highlighted Products'), P(DATA),
    ...rec('Acme NMN', 'NTC422101', 'Original Price', '$21.97', '$15.38'),
    ...rec('Acme EAA Powder, Blue Raspberry', 'NTC462101', 'Original Price', '$21.97', '$15.38'), // same SKU, another section
    ...rec('Acme BCAA Powder, Unflavored, 60 servings', 'NTC024009', 'Original Price', '$21.97', '$158.38'),
    P('Creative'), P('Creative Brief', 'Trello Request'),
  ),
);
const NY = { buf: zip({ 'word/document.xml': NY_XML }, true), name: 'Acme New Year SMP - 2027.docx' };
const imp = await L.importDocx(NY.buf, { fileName: NY.name });
const bySku = (sku) => imp.placements.filter((p) => p.sku === sku);
const one = (sku) => { const a = bySku(sku); assert.equal(a.length, 1, `${sku} placements`); return a[0]; };
const group = (p) => imp.groups.find((g) => g.id === p.groupId);

// ------------------------------------------------------------------ Bug A: Current Price

await test('CSV: "Current Price" is read as the regular/reference price; "Discount Price" stays the promo price', () => {
  const c = L.importCsv('Product Name,SKU,Current Price,Discount Price\nAcme A,A1,$27.97,$19.58\n');
  assert.deepEqual([c.placements[0].originalCents, c.placements[0].saleCents], [2797, 1958]);
  assert.equal(c.placements[0].raw.original, '$27.97');
  assert.equal(c.warnings.length, 0);
});

await test('CSV: "Original Price", "Regular Price" and "Price" still work, and Original Price wins when both labels are present', () => {
  for (const h of ['Original Price', 'Regular Price', 'Price', 'MSRP']) assert.equal(L.importCsv(`Name,SKU,${h},Sale Price\nA,A1,$10.00,$7.00\n`).placements[0].originalCents, 1000, h);
  const both = L.importCsv('Name,SKU,Current Price,Original Price,Discount Price\nA,A1,$9.00,$10.00,$7.00\n');
  assert.deepEqual([both.placements[0].originalCents, both.placements[0].saleCents], [1000, 700]);
});

await test('CSV: a Current Price column is never read as the promo price, and a discount-only row has no regular price', () => {
  const c = L.importCsv('Name,SKU,Discount Price\nA,A1,$7.00\n');
  assert.deepEqual([c.placements[0].originalCents, c.placements[0].saleCents], [null, 700]);
});

await test('CSV/JSON: current price keys in every spelling (camelCase, snake_case, cents) are the regular price', () => {
  const j = L.importJson([{ sku: 'A1', name: 'A', currentPrice: '$27.97', discountPrice: '$19.58' }, { sku: 'A2', name: 'B', current_price: 21.97, discount_price: 15.38 }, { sku: 'A3', name: 'C', 'Current Price': '$1.00' }, { sku: 'A4', name: 'D', currentPriceCents: 1234, salePriceCents: 999 }]);
  assert.deepEqual(j.placements.map((p) => [p.originalCents, p.saleCents]), [[2797, 1958], [2197, 1538], [100, null], [1234, 999]]);
});

await test('CSV: an unreadable current price is reported, never replaced', () => {
  const c = L.importCsv('Name,SKU,Current Price,Discount Price\nA,A1,call us,$7.00\nB,B1,,$8.00\n');
  assert.equal(c.placements[0].originalCents, null);
  assert.ok(c.warnings.some((w) => /Row 2.*original price "call us"/.test(w)), c.warnings.join('|'));
  assert.equal(c.placements[1].originalCents, null);
});

await test('DOCX: "Current Price" and "Original Price" in one document are both the regular price', () => {
  assert.deepEqual([one('NTC620408').originalCents, one('NTC620408').saleCents], [1997, 1398]);
  assert.deepEqual([one('NTC422101').originalCents, one('NTC422101').saleCents], [2197, 1538]); // labelled "Original Price"
});

// ------------------------------------------------------------------ Bug B: DOCX records

await test('DOCX: titles and SKUs are exactly the product, with no price text, headings or descriptions in them', () => {
  assert.equal(one('NTC270102').name, 'Acme Pre-X Workout Complex Powder, Blue Raspberry, 30 servings');
  assert.equal(one('NTC620408').name, 'Acme Electrolytes, Strawberry Lemonade, 60 servings');
  assert.equal(one('NTC019101').name, 'Acme Melatonin Capsules, 5 mg');
  assert.equal(one('STRESSBUNDLE').name, 'Acme Anti-Stress Kit');
  assert.equal(one('MAG-2').name, 'Acme Magnesium Glycinate Double Bundle');
  for (const p of imp.placements) assert.ok(!/Price|Theme fit|Includes|Highlighted|Best Sellers|Product CTA|Bundles|\(Design|\(Data|Launching|Offer:|\$\d/i.test(p.name), `${p.sku}: ${p.name}`);
});

await test('DOCX: prices belong to the product that precedes them (name, SKU, current, discount), not the next one', () => {
  assert.deepEqual([one('NTC270102').originalCents, one('NTC270102').saleCents], [2797, 1958]);
  assert.deepEqual([one('STRESSBUNDLE').originalCents, one('STRESSBUNDLE').saleCents], [4495, 3147]);
  assert.deepEqual([one('MAG-2').originalCents, one('MAG-2').saleCents], [2849, 1994]);
  assert.deepEqual([one('NTC019101').originalCents, one('NTC019101').saleCents], [1197, 838]);
});

await test('DOCX: soft line breaks inside one paragraph, one paragraph per line, and table cells all parse the same way', () => {
  assert.equal(one('STRESSBUNDLE').raw.sku, 'STRESSBUNDLE'); // soft-break record
  assert.equal(one('MAG-2').raw.sku, 'MAG-2'); // paragraph-per-line record, next table cell
  assert.equal(imp.placements.length, 13);
});

await test('DOCX: two products in one paragraph are two placements, status text and dash variants are understood', async () => {
  assert.deepEqual([one('NTC279101').name, one('NTC279101').originalCents, one('NTC279101').saleCents], ['Acme Peanut Butter Powder', 4697, null]);
  assert.deepEqual([one('NTC316101').name, one('NTC316101').originalCents, one('NTC316101').saleCents], ['Acme Matcha Powder, Culinary Grade', 1697, null]);
  const dashes = [['-', '$1.00', '$0.70'], ['–', '$2.00', '$1.40'], ['—', '$3.00', '$2.10'], [':', '$4.00', '$2.80'], ['', '$5.00', '$3.50'], ['  –  ', '$6.00', '$4.20']];
  const paras = dashes.map(([d, a, b], i) => P(`Acme  Dash   Item ${i}   SKU:  DSH${i}  Current Price ${d}${a}  Discount  Price${d}${b}`));
  const x = await L.importDocx(zip({ 'word/document.xml': docOf(cell(P('Highlighted Products (Test Theme)'), ...paras)) }, false), {});
  assert.deepEqual(x.placements.map((p) => [p.sku, p.name, p.originalCents, p.saleCents]), dashes.map((_, i) => [`DSH${i}`, `Acme Dash Item ${i}`, (i + 1) * 100, [70, 140, 210, 280, 350, 420][i]]));
});

await test('DOCX: section headings stay headings (with their list on the next line) and never join a product title', () => {
  assert.deepEqual(imp.groups.map((g) => [g.label, g.list, g.declaredCount]), [
    ['Bundles Section', 'Design Team - Themed Products', null],
    ['Highlighted Products', 'Design Team - Themed Products', null],
    ['Best Sellers', 'Design Team - Themed Products', null],
    ['Product CTA', 'Design Team - Themed Products', 5],
    ['Highlighted Products', 'Data Driven for All Other Teams', null],
  ]);
  assert.equal(group(one('STRESSBUNDLE')).label, 'Bundles Section');
  assert.equal(group(one('NTC270102')).label, 'Best Sellers');
  assert.equal(group(one('NTC422101')).list, 'Data Driven for All Other Teams');
  assert.equal(imp.campaign.name, 'Acme NY SMP - 2027');
  assert.equal(imp.campaign.meta.discountPercent, 30);
});

await test('DOCX: a SKU placed in several sections stays several placements and is still one product', () => {
  const eaa = bySku('NTC462101');
  assert.equal(eaa.length, 2);
  assert.notEqual(eaa[0].groupId, eaa[1].groupId);
  assert.equal(imp.placements.length, 13);
  assert.equal(new Set(imp.placements.map((p) => p.sku)).size, 12);
  const prods = L.smpProducts({ v: 1, imports: [imp] });
  assert.equal(prods.length, 12);
  assert.equal(prods.find((p) => p.sku === 'NTC462101').placements.length, 2);
  assert.equal(prods.find((p) => p.sku === 'NTC462101').conflicts.length, 0);
});

await test('DOCX: bundles are imported like any other product (nothing is excluded at import)', () => {
  assert.ok(bySku('STRESSBUNDLE').length && bySku('MAG-2').length);
});

// ------------------------------------------------------------------ source anomalies are kept, not corrected

await test('Source anomalies: regular < discount, a 10x discount, a blank discount and OUT OF STOCK are all kept exactly as the source says', () => {
  assert.deepEqual([one('NTC153201').originalCents, one('NTC153201').saleCents], [1597, 2236]);
  assert.deepEqual([one('NTC024009').originalCents, one('NTC024009').saleCents], [2197, 15838]);
  assert.deepEqual([one('NTC092101').originalCents, one('NTC092101').saleCents], [1597, null]);
  assert.equal(one('NTC279101').raw.sale, 'OUT OF STOCK');
  assert.equal(one('NTC092101').raw.sale, null);
  assert.ok(imp.warnings.includes('NTC092101: no discount price found.'), imp.warnings.join('|'));
  assert.ok(imp.warnings.includes('NTC279101: no discount price found (the document says OUT OF STOCK).'));
  assert.ok(imp.warnings.includes('NTC316101: no discount price found (the document says OUT OF STOCK).'));
  assert.ok(!imp.warnings.some((w) => /NTC153201|NTC024009/.test(w))); // import notes only; the promo warning is raised per product later
  assert.ok(!imp.warnings.some((w) => /no original price|no product name/.test(w)), imp.warnings.join('|'));
});

await test('Source anomalies: the declared "(5 Products)" is checked against the file, not forced to match', async () => {
  assert.ok(imp.warnings.some((w) => /Product CTA.*says 5 products but the file lists 4/.test(w)), imp.warnings.join('|'));
});

await test('Anomalous promo prices still raise the existing per-product promo warnings; nothing is approved or changed by the import', () => {
  const lib = { store: 'https://shop.example.com', campaign: 'c', smp: { v: 1, imports: [imp] }, work: L.emptyWork() };
  const rows = L.buildRows(lib);
  const r = (sku) => rows.find((x) => x.sku === sku);
  assert.equal(rows.length, 12);
  for (const x of rows) assert.equal(x.prices.approvedCents, null);
  assert.deepEqual([r('NTC153201').prices.smpCents, r('NTC024009').prices.smpCents], [1597, 2197]);
  assert.ok(r('NTC153201').promoWarnings.length >= 1 || r('NTC024009').promoWarnings.length >= 1);
  assert.equal(r('NTC092101').prices.promoCents ?? null, null);
});

// ------------------------------------------------------------------ existing flow downstream of the import

const STORE = [
  { id: 1, handle: 'electrolytes', title: 'Acme Electrolytes', variants: [{ id: 11, title: 'x', sku: 'NTC620408', price: '19.97', available: true, option1: 'x', options: ['x'] }], options: [{ name: 'Flavor', values: ['x'] }] },
  { id: 2, handle: 'melatonin', title: 'Acme Melatonin', variants: [{ id: 12, title: 'x', sku: 'NTC019101', price: '12.00', available: true, option1: 'x', options: ['x'] }], options: [{ name: 'Size', values: ['x'] }] },
];
const fake = async (url) => {
  const u = new URL(url);
  if (u.pathname === '/search/suggest.json') { const q = u.searchParams.get('q').toLowerCase(); return { resources: { results: { products: STORE.filter((p) => p.variants.some((v) => v.sku.toLowerCase().includes(q))).map((p) => ({ handle: p.handle, title: p.title })) } } }; }
  const m = u.pathname.match(/^\/products\/(.+)\.js$/);
  if (m && STORE.find((p) => p.handle === m[1])) return JSON.parse(JSON.stringify(STORE.find((p) => p.handle === m[1])));
  if (u.pathname === '/cart.js') return { currency: 'USD' };
  const e = new Error('nope'); e.status = 404; throw e;
};

await test('Shopify verification, approval and the approved export work on a Current Price import, keeping every price separate', async () => {
  const origin = 'https://shop.example.com';
  let lib = { store: origin, campaign: 'c', smp: { v: 1, imports: [imp] }, work: L.emptyWork() };
  lib = await L.checkAll(L.createDriver({ origin, fetchJson: fake }), lib, null);
  const r = (sku) => L.buildRows(lib).find((x) => x.sku === sku);
  assert.equal(r('NTC620408').verification.status, 'match');
  assert.equal(r('NTC019101').verification.status, 'mismatch'); // SMP $11.97 vs Shopify $12.00: shown, never silently changed
  assert.equal(r('NTC019101').prices.approvedCents, null);
  lib = L.decide(lib, 'sku:NTC019101', 'custom', 1150);
  const out = L.exportApproved(lib, 0);
  const a = out.products.find((p) => p.sku === 'NTC019101');
  assert.deepEqual([a.prices.smpOriginalCents, a.prices.shopifyCents, a.prices.approvedCents, a.prices.promoCents], [1197, 1200, 1150, 838]);
  assert.deepEqual(out.products.map((p) => p.sku).sort(), ['NTC019101', 'NTC620408']);
  assert.ok(out.needsAttention.find((p) => p.sku === 'STRESSBUNDLE'));
});

console.log(`\n${pass}/${pass + fail} importer tests passed`);
process.exit(fail ? 1 : 0);
