// Product Library core tests (library.js). Node only: no browser, no network, no npm dependencies.
// Usage: node library.test.mjs
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { zip, P, docXml, SMP_PARAS } from './docx-fixture.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const L = createRequire(import.meta.url)(join(here, '..', 'library.js'));

let pass = 0;
let fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').slice(0, 6).join('\n      ')}`); }
};

// ------------------------------------------------------------------ fixtures

const FILE = { buf: zip({ 'word/document.xml': docXml(SMP_PARAS) }, true), name: 'Spring SMP.docx' };

// A fake public storefront. Records every request so tests can prove the driver only reads.
function fakeStore(products, { fail = [] } = {}) {
  const calls = [];
  const byHandle = Object.fromEntries(products.map((p) => [p.handle, p]));
  const fetchJson = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (fail.some((f) => url.includes(f))) { const e = new Error('Network down'); throw e; }
    if (u.pathname === '/search/suggest.json') {
      const text = u.searchParams.get('q').toLowerCase();
      const skuOnly = (u.searchParams.get('resources[options][fields]') || '') === 'variants.sku';
      const hits = products.filter((p) => (skuOnly ? p.variants.some((v) => (v.sku || '').toLowerCase().includes(text)) : [p.title, ...p.variants.map((v) => v.sku || '')].join(' ').toLowerCase().includes(text) || text.split(' ').some((t) => t.length > 3 && p.title.toLowerCase().includes(t))));
      return { resources: { results: { products: hits.map((p) => ({ handle: p.handle, title: p.title })) } } };
    }
    const m = u.pathname.match(/^\/products\/(.+)\.js$/);
    if (m && byHandle[m[1]]) return JSON.parse(JSON.stringify(byHandle[m[1]]));
    if (m) { const e = new Error('nope'); e.status = 404; throw e; }
    if (u.pathname === '/cart.js') return { currency: 'USD' };
    const e = new Error('nope'); e.status = 404; throw e;
  };
  return { fetchJson, calls };
}
const prod = (id, handle, title, variants, extra = {}) => ({ id, handle, title, featured_image: `//cdn.example.com/${handle}.jpg`, options: [{ name: 'Flavor', position: 1, values: variants.map((v) => v.option1) }], variants, ...extra });
const variant = (id, sku, price, option1, extra = {}) => ({ id, title: option1, sku, price, compare_at_price: null, available: true, option1, options: [option1], ...extra });
const ORIGIN = 'https://shop.example.com';
const driverFor = (store) => L.createDriver({ origin: ORIGIN, fetchJson: store.fetchJson });

const STORE_PRODUCTS = [
  prod(1111111111, 'black-seed-oil', 'Acme Black Seed Oil', [variant(4444444441, 'ACM100101', 1997, 'Unflavored')]),
  prod(1111111112, 'charcoal', 'Acme Charcoal', [variant(4444444442, 'ACM200101', 1599, 'Unflavored')]), // 2 cents off the SMP
  prod(1111111113, 'ursolic', 'Acme Ursolic Acid', [variant(4444444443, 'ACM300101', 1998, 'Unflavored', { available: false })]), // 1 cent off, sold out
  prod(1111111114, 'zma', 'Acme ZMA Capsules', [variant(4444444444, 'ACM400101', 2797, '120 ct'), variant(4444444445, 'ACM400101', 4997, '240 ct')]), // duplicate SKU, price narrows it
  prod(1111111115, 'twin', 'Acme Twin', [variant(4444444446, 'ACM777777', 1000, 'A'), variant(4444444447, 'ACM777777', 1000, 'B')]), // duplicate SKU, same price: ambiguous
  prod(1111111116, 'pre-x-workout', 'Acme Pre-X Workout Powder', [variant(4444444448, 'ACM500108', 4197, 'Blue Raz')]), // SKU is 500108, the SMP says 500107
];

async function libWithSmp() {
  const imp = await L.importDocx(FILE.buf, { fileName: FILE.name });
  const lib = { store: ORIGIN, campaign: 'spring-smp-2026', smp: { v: 1, imports: [imp] }, work: L.emptyWork() };
  return lib;
}

// ------------------------------------------------------------------ money and reconciliation

await test('toCents reads prices as integer cents without float error', () => {
  assert.equal(L.toCents('$19.97'), 1997);
  assert.equal(L.toCents('1,234.50'), 123450);
  assert.equal(L.toCents('19,97'), 1997);
  assert.equal(L.toCents(19.97), 1997);
  assert.equal(L.toCents('0.1'), 10);
  assert.equal(L.toCents('11.99Nutricost'), 1199);
  assert.equal(L.toCents('12'), 1200);
  assert.equal(L.toCents('abc'), null);
  assert.equal(L.toCents(''), null);
  assert.equal(L.toCents(-3), null);
  assert.equal(L.fmt(1997, 'USD'), '$19.97');
  assert.equal(L.fmt(1997, 'CAD'), '19.97 CAD');
  assert.equal(L.fmt(null), '—');
});

await test('reconcile: match, one-cent rounding, mismatch, unknown', () => {
  assert.deepEqual(L.reconcile(1997, 1997), { status: 'match', diffCents: 0 });
  assert.deepEqual(L.reconcile(1997, 1998), { status: 'rounding', diffCents: 1 });
  assert.deepEqual(L.reconcile(1997, 1996), { status: 'rounding', diffCents: -1 });
  assert.deepEqual(L.reconcile(1997, 1999), { status: 'mismatch', diffCents: 2 });
  assert.equal(L.reconcile(null, 1000).status, 'unknown');
});

// ------------------------------------------------------------------ import parsing

await test('CSV import: columns, original values kept, duplicate SKU stays one product with two placements', () => {
  const csv = 'Section,SKU,Product Name,Original Price,Sale Price\nBest Sellers,AAA1,Alpha,$19.97,$11.99\nHighlighted,AAA1,Alpha,$19.97,$11.99\nHighlighted,BBB2,Beta,"$1,020.50",\n';
  const imp = L.importCsv(csv, { fileName: 'x.csv' });
  assert.equal(imp.placements.length, 3);
  assert.equal(imp.groups.length, 2);
  assert.equal(imp.placements[0].originalCents, 1997);
  assert.equal(imp.placements[0].saleCents, 1199);
  assert.equal(imp.placements[2].originalCents, 102050);
  assert.equal(imp.placements[2].saleCents, null);
  assert.equal(imp.placements[0].raw.original, '$19.97'); // the text as written
  assert.equal(imp.source.fileName, 'x.csv');
  const products = L.smpProducts({ imports: [imp] });
  assert.equal(products.length, 2);
  assert.equal(products.find((p) => p.sku === 'AAA1').placements.length, 2);
});

await test('CSV import: a row with no SKU is kept by name, a row with nothing is skipped, bad prices warn', () => {
  const imp = L.importCsv('SKU,Name,Price\n,Gamma Bundle,$10.00\n,,\nCCC3,Delta,oops\n', {});
  assert.equal(imp.placements.length, 2);
  assert.equal(imp.placements[0].sku, null);
  assert.equal(L.smpProducts({ imports: [imp] })[0].key, 'name:gamma-bundle');
  assert.ok(imp.warnings.some((w) => /oops/.test(w)));
  assert.throws(() => L.importCsv('Foo,Bar\n1,2\n'), /SKU or name/);
});

await test('JSON import: flat list, {products}, and {sections}; cents fields; bad JSON is refused', () => {
  assert.equal(L.importJson('[{"sku":"A1","name":"A","original_price":"$5.00","sale_price":4}]').placements[0].saleCents, 400);
  assert.equal(L.importJson({ products: [{ sku: 'A1', name: 'A', originalPriceCents: 500 }] }).placements[0].originalCents, 500);
  const s = L.importJson({ name: 'Fall', sections: [{ name: 'Hero', declaredCount: 2, products: [{ sku: 'A1', name: 'A', price: 5 }] }] });
  assert.equal(s.groups[0].label, 'Hero');
  assert.equal(s.campaign.name, 'Fall');
  assert.ok(s.warnings.some((w) => /says 2 products but the file lists 1/.test(w)));
  assert.throws(() => L.importJson('{nope'), /valid JSON/);
  assert.throws(() => L.importJson({ hello: 1 }), /Unrecognized/);
});

await test('DOCX import (deflated and stored): sections, glued text, split paragraphs, two products per paragraph', async () => {
  for (const deflate of [true, false]) {
    const imp = await L.importDocx(zip({ 'word/document.xml': docXml(SMP_PARAS) }, deflate), { fileName: 'a.docx' });
    const by = (sku) => imp.placements.filter((p) => p.sku === sku);
    assert.equal(imp.placements.length, 7, `deflate=${deflate}`);
    assert.equal(imp.campaign.name, 'Spring \u{1F338} SMP - 2026');
    assert.equal(imp.campaign.meta.discountPercent, 40);
    assert.equal(imp.campaign.meta.promotions[0].code, 'VIP40');
    assert.deepEqual(imp.groups.map((g) => g.label), ['Highlighted Products', 'Best Sellers', 'Product CTA']);
    assert.equal(imp.groups[0].list, 'Spring Theme');
    assert.equal(by('ACM100101')[0].name, 'Acme Black Seed Oil'); // "OilSKU:" glued
    assert.equal(by('ACM100101')[0].originalCents, 1997);
    assert.equal(by('ACM100101')[0].saleCents, 1199);
    assert.equal(by('ACM300101')[0].name, 'Acme Ursolic Acid'); // two products in one paragraph
    assert.equal(by('ACM400101')[0].originalCents, 2797);
    assert.equal(by('ACM500107')[0].name, 'Acme Pre-X Workout Powder'); // name and SKU in separate paragraphs
    assert.equal(by('ACM600101')[0].saleCents, 1019); // sale price on the next paragraph
    assert.equal(by('ACM100101').length, 2); // placed in two sections: two placements...
    assert.equal(L.smpProducts({ imports: [imp] }).length, 6); // ...one product
  }
});

await test('DOCX import: placements keep their original text, the declared count is checked, odd discounts are flagged', async () => {
  const imp = await L.importDocx(FILE.buf, { fileName: FILE.name });
  assert.ok(imp.placements[0].raw.original === '$19.97' && imp.placements[0].raw.sale === '$11.99');
  assert.ok(imp.warnings.some((w) => /Product CTA.*says 3 products but the file lists 4/.test(w)), imp.warnings.join('|'));
  assert.equal(imp.source.kind, 'docx');
  assert.match(imp.source.sha256, /^[0-9a-f]{64}$/);
});

await test('DOCX import never changes the bytes it reads, and the file hash is of the original bytes', async () => {
  const bytes = new Uint8Array(FILE.buf);
  const before = createHash('sha256').update(bytes).digest('hex');
  const imp = await L.importDocx(bytes, { fileName: 'a.docx' });
  assert.equal(createHash('sha256').update(bytes).digest('hex'), before);
  assert.equal(imp.source.sha256, before);
});

await test('DOCX import: not a zip, no document.xml, and a document with no products are refused clearly', async () => {
  await assert.rejects(L.importDocx(Buffer.from('hello world, not a zip')), /isn.t a \.docx/);
  await assert.rejects(L.importDocx(zip({ 'other.xml': '<a/>' }, false)), /no document text/);
  await assert.rejects(L.importDocx(zip({ 'word/document.xml': docXml([P('Just a heading')]) }, false)), /No products found/);
});

await test('importFile picks the importer by extension and refuses other types', async () => {
  const f = (name, body) => ({ name, size: 1, lastModified: 1, text: async () => body, arrayBuffer: async () => body });
  assert.equal((await L.importFile(f('a.csv', 'SKU,Price\nA1,$5\n'))).source.kind, 'csv');
  assert.equal((await L.importFile(f('a.json', '[{"sku":"A1","price":5}]'))).source.kind, 'json');
  assert.equal((await L.importFile({ ...f('a.docx', FILE.buf), arrayBuffer: async () => FILE.buf })).source.kind, 'docx');
  await assert.rejects(L.importFile(f('a.pdf', '')), /\.csv, \.json or \.docx/);
});

// ------------------------------------------------------------------ driver: product refs, variants, exact matching

await test('normalizeProduct keeps product id and variant id apart (as strings) and reads cents, options and images', () => {
  const p = L.normalizeProduct(STORE_PRODUCTS[0], ORIGIN, 'USD');
  const v = p.variants[0];
  assert.equal(p.productId, '1111111111');
  assert.equal(v.variantId, '4444444441');
  assert.notEqual(v.variantId, v.productId);
  assert.equal(v.variantGid, 'gid://shopify/ProductVariant/4444444441');
  assert.equal(v.priceCents, 1997);
  assert.deepEqual(v.options, [{ name: 'Flavor', value: 'Unflavored' }]);
  assert.equal(v.image, 'https://cdn.example.com/black-seed-oil.jpg');
  assert.equal(v.url, `${ORIGIN}/products/black-seed-oil?variant=4444444441`);
  // older storefront shapes: option names as strings, price as a decimal string
  const old = L.normalizeProduct({ id: 1, handle: 'h', title: 'T', options: ['Size'], variants: [{ id: 2, title: 'Large', sku: 'S', price: '19.97', option1: 'Large', available: true }] }, ORIGIN);
  assert.equal(old.variants[0].priceCents, 1997);
  assert.equal(old.variants[0].options[0].name, 'Size');
  assert.throws(() => L.normalizeProduct({ nope: 1 }, ORIGIN), /isn.t a product/);
});

await test('parseProductRef: URLs, paths and variant ids', () => {
  assert.deepEqual(L.parseProductRef('https://shop.example.com/products/black-seed-oil?variant=4444444441'), { handle: 'black-seed-oil', variantId: '4444444441' });
  assert.deepEqual(L.parseProductRef('/products/abc.js'), { handle: 'abc', variantId: null });
  assert.equal(L.parseProductRef('ACM100101'), null);
});

await test('exact SKU match picks that variant, and only that one; the driver only issues GETs to public JSON paths', async () => {
  const store = fakeStore(STORE_PRODUCTS);
  const r = await L.lookupProduct(driverFor(store), { sku: 'acm100101', name: 'Acme Black Seed Oil', smpCents: 1997 }); // case-insensitive
  assert.equal(r.match.status, 'exact');
  assert.equal(r.match.method, 'sku');
  assert.equal(r.variant.variantId, '4444444441');
  assert.equal(r.variant.productId, '1111111111');
  assert.ok(store.calls.every((u) => /^https:\/\/shop\.example\.com\/(search\/suggest\.json|products\/[^/]+\.js|cart\.js)/.test(u)), store.calls.join('\n'));
});

await test('a duplicate SKU is narrowed by the SMP price only when that leaves exactly one; otherwise it is ambiguous (never the first)', async () => {
  const store = fakeStore(STORE_PRODUCTS);
  const narrowed = await L.lookupProduct(driverFor(store), { sku: 'ACM400101', name: 'Acme ZMA Capsules', smpCents: 2797 });
  assert.equal(narrowed.match.status, 'exact');
  assert.equal(narrowed.match.method, 'sku+price');
  assert.equal(narrowed.variant.variantId, '4444444444');
  const other = await L.lookupProduct(driverFor(store), { sku: 'ACM400101', name: 'Acme ZMA Capsules', smpCents: 4997 });
  assert.equal(other.variant.variantId, '4444444445');
  const wrongPrice = await L.lookupProduct(driverFor(store), { sku: 'ACM400101', name: 'Acme ZMA Capsules', smpCents: 1 });
  assert.equal(wrongPrice.match.status, 'ambiguous');
  assert.equal(wrongPrice.variant, null);
  assert.equal(wrongPrice.match.candidates.length, 2);
  const twin = await L.lookupProduct(driverFor(store), { sku: 'ACM777777', name: 'Acme Twin', smpCents: 1000 });
  assert.equal(twin.match.status, 'ambiguous');
  assert.equal(twin.variant, null);
});

await test('a missing SKU is "not found" with suggestions that are never chosen automatically', async () => {
  const store = fakeStore(STORE_PRODUCTS);
  const r = await L.lookupProduct(driverFor(store), { sku: 'ACM500107', name: 'Acme Pre-X Workout Powder', smpCents: 4197 });
  assert.equal(r.match.status, 'not-found');
  assert.equal(r.variant, null);
  assert.equal(r.match.candidates[0].variantId, '4444444448'); // same name and price: offered
  assert.equal(r.match.candidates[0].sku, 'ACM500108'); // but its SKU differs, so it is only a suggestion
});

await test('a product with no SKU is "unresolved" (name suggestions only); an empty store and a 404 are handled', async () => {
  const store = fakeStore(STORE_PRODUCTS);
  const r = await L.lookupProduct(driverFor(store), { sku: null, name: 'Acme Charcoal', smpCents: 1597 });
  assert.equal(r.match.status, 'unresolved');
  assert.equal(r.variant, null);
  const none = await L.lookupProduct(driverFor(fakeStore([])), { sku: 'ZZZ', name: 'Nothing like it', smpCents: 1 });
  assert.equal(none.match.status, 'not-found');
  assert.deepEqual(none.match.candidates, []);
  assert.equal(await driverFor(store).product('gone'), null);
});

await test('failed requests become a clear "error" result, never a guess', async () => {
  const down = await L.lookupProduct(driverFor(fakeStore(STORE_PRODUCTS, { fail: ['suggest.json'] })), { sku: 'ACM100101', name: 'x', smpCents: 1997 });
  assert.equal(down.match.status, 'error');
  assert.match(down.match.message, /Network down/);
  assert.equal(down.variant, null);
  const noFetch = await L.lookupProduct(driverFor(fakeStore(STORE_PRODUCTS, { fail: ['/products/'] })), { sku: 'ACM100101', name: 'x', smpCents: 1997 });
  assert.equal(noFetch.variant, null);
  assert.notEqual(noFetch.match.status, 'exact');
});

await test('an unavailable variant is still matched exactly but flagged', async () => {
  const r = await L.lookupProduct(driverFor(fakeStore(STORE_PRODUCTS)), { sku: 'ACM300101', name: 'x', smpCents: 1997 });
  assert.equal(r.match.status, 'exact');
  assert.equal(r.variant.available, false);
  assert.ok(r.match.warnings.some((w) => /sold out/.test(w)));
});

// ------------------------------------------------------------------ reconciliation, overrides

async function checkedLib() {
  const store = fakeStore(STORE_PRODUCTS);
  return { lib: await L.checkAll(driverFor(store), await libWithSmp(), null), store };
}
const row = (lib, sku) => L.buildRows(lib).find((r) => r.sku === sku);

await test('Check all: statuses for match, 2¢ mismatch, 1¢ rounding, narrowed duplicate, ambiguous-free, not found', async () => {
  const { lib } = await checkedLib();
  assert.equal(row(lib, 'ACM100101').verification.status, 'match');
  assert.equal(row(lib, 'ACM200101').verification.status, 'mismatch');
  assert.equal(row(lib, 'ACM200101').verification.diffCents, 2);
  assert.equal(row(lib, 'ACM300101').verification.status, 'rounding');
  assert.equal(row(lib, 'ACM400101').variant.variantId, '4444444444');
  assert.equal(row(lib, 'ACM500107').verification.status, 'not-found');
  assert.equal(row(lib, 'ACM600101').verification.status, 'not-found');
  // an exact match needs no decision; a mismatch and a rounding difference do
  assert.equal(row(lib, 'ACM100101').correction, 'auto');
  assert.equal(row(lib, 'ACM200101').correction, 'needs-review');
  assert.equal(row(lib, 'ACM300101').correction, 'needs-review');
  assert.equal(row(lib, 'ACM200101').prices.approvedCents, null); // nothing is approved silently
});

await test('three corrections keep SMP, Shopify and approved prices as separate values', async () => {
  const { lib } = await checkedLib();
  const a = L.decide(lib, 'sku:ACM200101', 'shopify');
  assert.deepEqual([row(a, 'ACM200101').prices.smpCents, row(a, 'ACM200101').prices.shopifyCents, row(a, 'ACM200101').prices.approvedCents], [1597, 1599, 1599]);
  const b = L.decide(lib, 'sku:ACM200101', 'smp');
  assert.deepEqual([row(b, 'ACM200101').prices.smpCents, row(b, 'ACM200101').prices.shopifyCents, row(b, 'ACM200101').prices.approvedCents], [1597, 1599, 1597]);
  const c = L.decide(lib, 'sku:ACM200101', 'custom', 1500);
  assert.deepEqual([row(c, 'ACM200101').prices.smpCents, row(c, 'ACM200101').prices.shopifyCents, row(c, 'ACM200101').prices.approvedCents], [1597, 1599, 1500]);
  assert.equal(row(c, 'ACM200101').approved.source, 'custom');
  assert.equal(row(c, 'ACM200101').prices.promoCents, 959); // the SMP sale price is untouched
  assert.throws(() => L.decide(lib, 'sku:ACM200101', 'custom', null), /valid price/);
  assert.throws(() => L.decide(lib, 'sku:ACM500107', 'shopify'), /Choose the Shopify variant first/);
});

await test('a one-cent difference is acknowledged, not rewritten: SMP price stays approved and the flag is recorded', async () => {
  const { lib } = await checkedLib();
  const a = L.decide(lib, 'sku:ACM300101', 'smp');
  const r = row(a, 'ACM300101');
  assert.equal(r.prices.approvedCents, 1997);
  assert.equal(r.prices.shopifyCents, 1998);
  assert.equal(r.approved.acknowledgedRounding, true);
  assert.equal(r.verification.status, 'rounding'); // still reported as a difference
});

await test('an approval goes stale when the Shopify price or the variant changes afterward', async () => {
  const { lib } = await checkedLib();
  const approved = L.decide(lib, 'sku:ACM200101', 'shopify');
  assert.equal(row(approved, 'ACM200101').correction, 'approved');
  const moved = L.setRefresh(approved, 'sku:ACM200101', { ...row(approved, 'ACM200101').variant, priceCents: 1699 });
  assert.equal(row(moved, 'ACM200101').correction, 'stale');
  assert.equal(row(moved, 'ACM200101').prices.approvedCents, null);
  const other = L.chooseVariant(approved, 'sku:ACM200101', { ...row(approved, 'ACM200101').variant, variantId: '999' });
  assert.equal(row(other, 'ACM200101').correction, 'stale');
  assert.equal(row(L.clearDecision(approved, 'sku:ACM200101'), 'ACM200101').correction, 'needs-review');
});

await test('manual choice is authoritative: Check all refreshes it by id and never searches over it', async () => {
  const { lib } = await checkedLib();
  const picked = L.chooseVariant(lib, 'sku:ACM500107', L.normalizeProduct(STORE_PRODUCTS[5], ORIGIN).variants[0]);
  assert.equal(row(picked, 'ACM500107').match.method, 'manual');
  assert.ok(row(picked, 'ACM500107').match.warnings.some((w) => /SKU differs/.test(w)));
  const store = fakeStore(STORE_PRODUCTS);
  const again = await L.checkAll(driverFor(store), picked, null);
  assert.equal(row(again, 'ACM500107').variant.variantId, '4444444448');
  assert.ok(!store.calls.some((u) => u.includes('suggest.json') && /ACM500107/.test(u)), 'did not search again for a product with a chosen variant');
  // the variant disappearing from the store is flagged, and the saved details are kept
  const gone = await L.checkAll(driverFor(fakeStore([])), picked, null);
  assert.equal(row(gone, 'ACM500107').variant.variantId, '4444444448');
  assert.ok(row(gone, 'ACM500107').match.warnings.some((w) => /No longer found/.test(w)));
});

await test('manually added Shopify products: not in the SMP, no SMP price, duplicates refused, removable', async () => {
  const { lib } = await checkedLib();
  const v = L.normalizeProduct(STORE_PRODUCTS[5], ORIGIN).variants[0];
  const added = L.addManualProduct(lib, v);
  assert.equal(added.duplicate, false);
  const r = L.buildRows(added.lib).find((x) => x.key === added.key);
  assert.equal(r.origin, 'manual');
  assert.equal(r.verification.status, 'no-smp-price');
  assert.equal(r.correction, 'needs-review');
  assert.equal(L.buildRows(L.decide(added.lib, added.key, 'shopify')).find((x) => x.key === added.key).prices.approvedCents, 4197);
  assert.equal(L.addManualProduct(added.lib, v).duplicate, true);
  assert.equal(L.addManualProduct(lib, L.normalizeProduct(STORE_PRODUCTS[0], ORIGIN).variants[0]).duplicate, true); // already on an SMP product
  assert.ok(!L.buildRows(L.removeManualProduct(added.lib, added.key)).some((x) => x.key === added.key));
});

await test('a currency stated by the SMP that differs from the store blocks the comparison', async () => {
  const imp = L.importCsv('SKU,Name,Price,Currency\nACM100101,Acme Black Seed Oil,19.97,CAD\n');
  let lib = { store: ORIGIN, campaign: 'c', smp: { v: 1, imports: [imp] }, work: L.emptyWork() };
  lib = await L.checkAll(driverFor(fakeStore(STORE_PRODUCTS)), lib, null);
  assert.equal(row(lib, 'ACM100101').verification.status, 'currency');
});

// ------------------------------------------------------------------ approved export

await test('export: only exact + currently approved products, with string ids and separate prices; the rest are listed with a reason', async () => {
  let { lib } = await checkedLib();
  lib = L.decide(lib, 'sku:ACM200101', 'custom', 1550);
  const out = L.exportApproved(lib, 0);
  assert.equal(out.schema, 'blueline.product-library/2'); assert.equal(out.scope, 'approved');
  assert.deepEqual(out.products.map((p) => p.sku).sort(), ['ACM100101', 'ACM200101', 'ACM400101']);
  const p = out.products.find((x) => x.sku === 'ACM200101');
  assert.equal(typeof p.variantId, 'string');
  assert.equal(p.variantId, '4444444442');
  assert.equal(p.productId, '1111111112');
  assert.deepEqual([p.prices.smpOriginalCents, p.prices.shopifyCents, p.prices.approvedCents, p.prices.promoCents], [1597, 1599, 1550, 959]);
  assert.equal(p.approval.source, 'custom');
  assert.deepEqual(out.products.find((x) => x.sku === 'ACM100101').source.placements.map((x) => x.group.label), ['Highlighted Products', 'Best Sellers']);
  assert.ok(out.needsAttention.find((x) => x.sku === 'ACM300101'));
  assert.ok(out.needsAttention.find((x) => x.sku === 'ACM500107'));
  assert.equal(out.sources[0].fileName, FILE.name);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(out)));
});

// ------------------------------------------------------------------ persistence and isolation

function memStorage() {
  const data = {};
  const sets = [];
  return {
    data, sets,
    get: async (keys) => { const out = {}; for (const k of [].concat(keys)) if (k in data) out[k] = JSON.parse(JSON.stringify(data[k])); return out; },
    set: async (o) => { sets.push(Object.keys(o)); for (const [k, v] of Object.entries(o)) data[k] = JSON.parse(JSON.stringify(v)); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
  };
}

await test('save and reload restores the import, Shopify data and decisions exactly', async () => {
  const st = memStorage();
  let { lib } = await checkedLib();
  lib = L.decide(lib, 'sku:ACM200101', 'custom', 1550);
  await L.saveLibrary(st, lib, { smpChanged: true, name: 'Spring SMP' });
  const back = await L.loadLibrary(st, ORIGIN, 'spring-smp-2026');
  assert.deepEqual(back.smp, lib.smp);
  assert.deepEqual(back.work, lib.work);
  assert.deepEqual(L.buildRows(back).map((r) => [r.key, r.prices, r.correction]), L.buildRows(lib).map((r) => [r.key, r.prices, r.correction]));
  const idx = await L.loadIndex(st);
  assert.deepEqual(idx.libs.map((l) => [l.store, l.campaign, l.name]), [[ORIGIN, 'spring-smp-2026', 'Spring SMP']]);
});

await test('the imported SMP is written once; corrections and Shopify data are saved to a separate record and leave it identical', async () => {
  const st = memStorage();
  let lib = await libWithSmp();
  await L.saveLibrary(st, lib, { smpChanged: true });
  const smpKey = L.kSmp(ORIGIN, 'spring-smp-2026');
  const snapshot = JSON.stringify(st.data[smpKey]);
  lib = await L.checkAll(driverFor(fakeStore(STORE_PRODUCTS)), lib, null);
  lib = L.decide(lib, 'sku:ACM200101', 'shopify');
  lib = L.decide(lib, 'sku:ACM200101', 'custom', 1);
  await L.saveLibrary(st, lib);
  await L.saveLibrary(st, L.clearDecision(lib, 'sku:ACM200101'));
  assert.equal(st.sets.slice(1).filter((keys) => keys.includes(smpKey)).length, 0, 'later saves never write the SMP record');
  assert.equal(JSON.stringify(st.data[smpKey]), snapshot);
  assert.equal(JSON.stringify(lib.smp), snapshot); // decisions did not alter the in-memory import either
  const w = st.data[L.kWork(ORIGIN, 'spring-smp-2026')];
  assert.ok(w.shopify['sku:ACM200101'] && !('decisions' in JSON.parse(snapshot)));
});

await test('importing the same file again changes nothing; another file is added beside the first', async () => {
  const lib = await libWithSmp();
  const again = L.addImport(lib, await L.importDocx(FILE.buf, { fileName: 'copy.docx' }));
  assert.equal(again.duplicate, true);
  assert.equal(again.lib, lib);
  const csv = L.importCsv('SKU,Name,Price\nNEW1,New thing,$5\nACM100101,Acme Black Seed Oil,$19.97\n', { sha256: 'abc' });
  const two = L.addImport(lib, csv).lib;
  assert.equal(two.smp.imports.length, 2);
  assert.equal(L.smpProducts(two.smp).length, 7); // NEW1 is new; ACM100101 joined its existing product
  assert.equal(L.smpProducts(two.smp).find((p) => p.sku === 'ACM100101').placements.length, 3);
  assert.equal(lib.smp.imports.length, 1); // the earlier library object is untouched
});

await test('isolation: stores, campaigns and pages never see each other’s data', async () => {
  const st = memStorage();
  const a = await libWithSmp();
  await L.saveLibrary(st, L.decide(await L.checkAll(driverFor(fakeStore(STORE_PRODUCTS)), a, null), 'sku:ACM200101', 'smp'), { smpChanged: true });
  // same campaign, another store: empty
  const otherStore = await L.loadLibrary(st, 'https://other-shop.example.com', 'spring-smp-2026');
  assert.equal(otherStore.smp.imports.length, 0);
  assert.deepEqual(otherStore.work.decisions, {});
  assert.equal(L.buildRows(otherStore).length, 0);
  // same store, another campaign: empty
  const otherCampaign = await L.loadLibrary(st, ORIGIN, 'summer');
  assert.equal(otherCampaign.smp.imports.length, 0);
  // the original is still there
  assert.equal(L.buildRows(await L.loadLibrary(st, ORIGIN, 'spring-smp-2026')).length, 6);
  // saving to one never touches the other's keys
  const mine = (k) => k.includes(`${ORIGIN}|spring-smp-2026`);
  const keysBefore = Object.keys(st.data).filter(mine).sort();
  const before = JSON.stringify(Object.keys(st.data).filter(mine).map((k) => st.data[k]));
  await L.saveLibrary(st, { ...otherStore, smp: L.addImport(otherStore, L.importCsv('SKU,Name,Price\nZ1,Z,$1\n', { sha256: 'z' })).lib.smp }, { smpChanged: true });
  assert.deepEqual(Object.keys(st.data).filter(mine).sort(), keysBefore);
  assert.equal(JSON.stringify(Object.keys(st.data).filter(mine).map((k) => st.data[k])), before); // and their contents are unchanged
  assert.ok(Object.keys(st.data).some((k) => k.includes('https://other-shop.example.com|spring-smp-2026')));
  assert.equal(L.buildRows(await L.loadLibrary(st, ORIGIN, 'spring-smp-2026')).length, 6);
  // keys cannot collide across store/campaign boundaries
  // Keys join store and campaign with "|". Neither side can contain one: campaign ids are slugs, and "|" is not valid in a host name.
  assert.ok(!L.campaignId('b|c').includes('|'));
  assert.ok(L.normalizeStore('https://a.example.com|b').error);
});

await test('isolation: the library a page last used is remembered per page origin, so another website starts empty', async () => {
  const st = memStorage();
  await L.setActive(st, 'https://shop.example.com', ORIGIN, 'spring-smp-2026');
  assert.deepEqual(await L.getActive(st, 'https://shop.example.com'), { store: ORIGIN, campaign: 'spring-smp-2026' });
  assert.equal(await L.getActive(st, 'https://unrelated-site.example.org'), null);
  assert.equal(await L.getActive(st, 'file://'), null);
  await L.setActive(st, 'https://unrelated-site.example.org', 'https://other-shop.example.com', 'x');
  assert.deepEqual(await L.getActive(st, 'https://shop.example.com'), { store: ORIGIN, campaign: 'spring-smp-2026' }); // unchanged
});

await test('deleting one library leaves the others and forgets it in the index', async () => {
  const st = memStorage();
  await L.saveLibrary(st, await libWithSmp(), { smpChanged: true });
  await L.saveLibrary(st, { ...(await libWithSmp()), campaign: 'other' }, { smpChanged: true });
  await L.setActive(st, 'https://x.example.com', ORIGIN, 'other');
  await L.deleteLibrary(st, ORIGIN, 'other');
  assert.equal((await L.loadLibrary(st, ORIGIN, 'other')).smp.imports.length, 0);
  assert.equal((await L.loadLibrary(st, ORIGIN, 'spring-smp-2026')).smp.imports.length, 1);
  const idx = await L.loadIndex(st);
  assert.deepEqual(idx.libs.map((l) => l.campaign), ['spring-smp-2026']);
  assert.equal(idx.active['https://x.example.com'], undefined);
});

await test('normalizeStore: addresses are reduced to an origin; non-https and junk are refused', () => {
  assert.equal(L.normalizeStore('Shop.Example.com').origin, 'https://shop.example.com');
  assert.equal(L.normalizeStore('https://shop.example.com/products/x?y=1').origin, 'https://shop.example.com');
  assert.equal(L.normalizeStore('http://127.0.0.1:8080/x').origin, 'http://127.0.0.1:8080');
  assert.match(L.normalizeStore('http://shop.example.com').error, /https/);
  assert.ok(L.normalizeStore('').error);
  assert.ok(L.normalizeStore('not a url').error);
  assert.ok(L.normalizeStore('javascript:alert(1)').error);
  assert.ok(L.normalizeStore('localhostish').error);
});

// ------------------------------------------------------------------ Product Lists refinement

await test('one set of counts: variant resolution, price comparison and approval cannot contradict each other', async () => {
  const { lib } = await checkedLib();
  const rows = L.buildRows(lib);
  const s = L.summarize(rows);
  assert.deepEqual([s.unique, s.placements, s.manual, s.total], [6, 7, 0, 6]);
  assert.deepEqual([s.variantsResolved, s.noVariant, s.notChecked], [4, 2, 0]);
  assert.deepEqual([s.priceMatch, s.priceDiffer, s.approved], [2, 2, 2]);
  // a resolved variant with a price difference is still "needs review"; so are the two with no variant
  const mm = row(lib, 'ACM200101');
  assert.equal(mm.variantState, 'resolved');
  assert.equal(mm.verification.status, 'mismatch');
  assert.equal(mm.review.needsReview, true);
  assert.match(mm.review.reasons[0], /Price differs: SMP \$15\.97, Shopify \$15\.99/);
  assert.equal(s.needsReview, 4);
  assert.equal(rows.filter((r) => r.review.needsReview).length, s.needsReview);
  // every row is either settled (approved) or needs review: nothing falls between
  assert.equal(s.approved + s.needsReview, s.total);
  // settling the differences reduces "needs review" and nothing else
  const fixed = L.decide(L.decide(lib, 'sku:ACM200101', 'shopify'), 'sku:ACM300101', 'smp');
  const s2 = L.summarize(L.buildRows(fixed));
  assert.deepEqual([s2.needsReview, s2.approved, s2.priceDiffer, s2.noVariant], [2, 4, 2, 2]);
  // before anything is checked, rows are "not checked", not "needs review"
  const fresh = L.summarize(L.buildRows(await libWithSmp()));
  assert.deepEqual([fresh.notChecked, fresh.noVariant, fresh.needsReview, fresh.approved], [6, 0, 0, 0]);
});

await test('an approval that goes stale returns the product to needs review', async () => {
  const { lib } = await checkedLib();
  const ok = L.decide(lib, 'sku:ACM200101', 'shopify');
  assert.equal(row(ok, 'ACM200101').review.needsReview, false);
  const moved = L.setRefresh(ok, 'sku:ACM200101', { ...row(ok, 'ACM200101').variant, priceCents: 1700 });
  assert.equal(row(moved, 'ACM200101').correction, 'stale');
  assert.equal(row(moved, 'ACM200101').review.needsReview, true);
  assert.ok(row(moved, 'ACM200101').review.reasons.some((x) => /out of date/.test(x)));
});

await test('promo-price warnings are separate from original-price mismatches', async () => {
  const { lib } = await checkedLib();
  // the 2¢ original-price mismatch does not produce a promo warning
  assert.equal(row(lib, 'ACM200101').verification.status, 'mismatch');
  assert.deepEqual(row(lib, 'ACM200101').promoWarnings, []);
  // approving a very different price makes the SMP promo price inconsistent with it: a promo warning, nothing else changes
  const big = L.decide(lib, 'sku:ACM200101', 'custom', 2000);
  const r = row(big, 'ACM200101');
  assert.equal(r.promoWarnings.length, 1);
  assert.match(r.promoWarnings[0], /\$9\.59 is not 40% off the approved price \$20\.00 \(that would be \$12\.00\)/);
  assert.equal(r.verification.status, 'mismatch'); // the original-price comparison is its own question
  assert.equal(L.summarize(L.buildRows(big)).promoWarnings, 1);
  // an SMP whose own promo price is off: a warning per product, never an import note
  const imp = L.importJson({ campaign: { name: 'X', meta: { discountPercent: 40 } }, products: [{ sku: 'A1', name: 'A', originalPrice: '$10.00', salePrice: '$7.00' }, { sku: 'A2', name: 'B', originalPrice: '$10.00', salePrice: '$6.00' }] }, { sha256: 'p' });
  assert.ok(!imp.warnings.some((w) => /% off/.test(w)));
  const rows = L.buildRows({ store: ORIGIN, campaign: 'p', smp: { v: 1, imports: [imp] }, work: L.emptyWork() });
  assert.equal(rows.find((x) => x.sku === 'A1').promoWarnings.length, 1);
  assert.match(rows.find((x) => x.sku === 'A1').promoWarnings[0], /\$7\.00 is not 40% off its own original price \$10\.00 \(that would be \$6\.00\)/);
  assert.equal(rows.find((x) => x.sku === 'A2').promoWarnings.length, 0);
  // the real SMP's oddity: promo price not 40% off its original
  const real = L.buildRows(await libWithSmp());
  assert.ok(real.every((x) => Array.isArray(x.promoWarnings)));
});

await test('a missing compare-at price is normal; a present one is kept and shown without changing the comparison', async () => {
  const prods = [prod(1, 'a', 'Acme A', [variant(11, 'ACM100101', 1997, 'X'), ]), prod(2, 'b', 'Acme B', [variant(22, 'ACM200101', 1597, 'X', { compare_at_price: '25.00' })])];
  const lib = await L.checkAll(driverFor(fakeStore(prods)), await libWithSmp(), null);
  const a = row(lib, 'ACM100101'); const b = row(lib, 'ACM200101');
  assert.equal(a.prices.compareAtCents, null);
  assert.deepEqual([a.verification.status, a.review.needsReview, a.promoWarnings.length], ['match', false, 0]);
  assert.equal(b.prices.compareAtCents, 2500);
  assert.equal(b.verification.status, 'match'); // compare-at is never mistaken for the price
  const out = L.exportApproved(lib);
  assert.equal(out.products.find((p) => p.sku === 'ACM200101').prices.shopifyCompareAtCents, 2500);
  assert.equal(out.products.find((p) => p.sku === 'ACM100101').prices.shopifyCompareAtCents, null);
});

await test('list identity is a generated id, not the name: renaming changes only the label', async () => {
  const st = memStorage();
  const a = L.newLibrary(ORIGIN, 'Black Friday');
  const b = L.newLibrary(ORIGIN, 'Black Friday');
  assert.notEqual(a.campaign, b.campaign);
  assert.match(a.campaign, /^l-[0-9a-z]+$/);
  assert.ok(!a.campaign.includes('|'));
  assert.equal(L.isPristine(a), true);
  const imp = await L.importDocx(FILE.buf, { fileName: FILE.name });
  const filled = { ...a, smp: { v: 1, imports: [imp] } };
  await L.saveLibrary(st, filled, { smpChanged: true });
  const keysBefore = Object.keys(st.data).sort();
  assert.equal(await L.renameLibrary(st, ORIGIN, a.campaign, 'Cyber Week'), true);
  assert.deepEqual(Object.keys(st.data).sort(), keysBefore); // same storage keys, nothing moved
  const back = await L.loadLibrary(st, ORIGIN, a.campaign);
  assert.equal(L.listName(back), 'Cyber Week');
  assert.deepEqual(back.smp, filled.smp);
  // two lists may share a name; they stay separate
  await L.saveLibrary(st, { ...b, smp: { v: 1, imports: [await L.importCsv('SKU,Name,Price\nZ1,Z,$1\n', { sha256: 'z' })] } }, { smpChanged: true, name: 'Cyber Week' });
  const idx = await L.loadIndex(st);
  assert.equal(L.listsForStore(idx, ORIGIN).length, 2);
  assert.equal((await L.loadLibrary(st, ORIGIN, a.campaign)).smp.imports.length, 1);
  assert.equal(L.buildRows(await L.loadLibrary(st, ORIGIN, a.campaign)).length, 6);
  assert.equal(L.buildRows(await L.loadLibrary(st, ORIGIN, b.campaign)).length, 1);
  assert.equal(await L.renameLibrary(st, ORIGIN, 'l-missing', 'x'), false);
});

await test('lists are named from the file, and a library saved before list ids existed still loads untouched', async () => {
  assert.equal(L.defaultListName('Black Friday SMP - 2026.docx'), 'Black Friday SMP - 2026');
  assert.equal(L.defaultListName('C:\\x\\spring_launch.v2.CSV'), 'spring launch.v2');
  assert.equal(L.defaultListName('/tmp/a/b/products.json'), 'products');
  assert.equal(L.defaultListName(''), null);
  // data exactly as Pass 1 wrote it: id is the name-derived slug, index entry carries the name
  const st = memStorage();
  const imp = await L.importDocx(FILE.buf, { fileName: FILE.name });
  const legacyWork = { ...L.emptyWork(), decisions: { 'sku:ACM200101': { source: 'custom', approvedCents: 1550, smpCents: 1597, shopifyCents: 1599, variantId: '4444444442', acknowledgedRounding: false, decidedAt: 1 } } };
  st.data[L.kSmp(ORIGIN, 'spring-smp-2026')] = { v: 1, imports: [imp] };
  st.data[L.kWork(ORIGIN, 'spring-smp-2026')] = legacyWork;
  st.data[L.K_INDEX] = { v: 1, libs: [{ store: ORIGIN, campaign: 'spring-smp-2026', name: 'Spring SMP - 2026', updatedAt: 5 }], active: { [ORIGIN]: { store: ORIGIN, campaign: 'spring-smp-2026' } } };
  const lib = await L.loadLibrary(st, ORIGIN, 'spring-smp-2026');
  assert.equal(L.listName(lib), 'Spring SMP - 2026');
  assert.equal(L.buildRows(lib).length, 6);
  assert.deepEqual(lib.work.decisions, legacyWork.decisions);
  await L.saveLibrary(st, lib); // saving keeps the id and the name
  assert.deepEqual((await L.loadIndex(st)).libs.map((l) => [l.campaign, l.name]), [['spring-smp-2026', 'Spring SMP - 2026']]);
  assert.equal(L.exportApproved(lib).list.id, 'spring-smp-2026');
  assert.equal(L.exportApproved(lib).list.name, 'Spring SMP - 2026');
  // a legacy library whose index name was just the id falls back to the document's own title
  st.data[L.K_INDEX].libs[0].name = 'spring-smp-2026';
  assert.match(L.listName(await L.loadLibrary(st, ORIGIN, 'spring-smp-2026')), /Spring .* SMP - 2026/);
});

await test('the variant picker: every variant of the product, current one identifiable, choosing re-verifies and never touches the SMP', async () => {
  const { lib } = await checkedLib();
  const store = fakeStore(STORE_PRODUCTS);
  const before = JSON.stringify(lib.smp);
  const r0 = row(lib, 'ACM400101');
  const p = await driverFor(store).product(r0.variant.handle);
  assert.equal(p.variants.length, 2);
  assert.deepEqual(p.variants.map((v) => [v.variantId, v.sku, v.priceCents, v.available, v.options[0].value]), [['4444444444', 'ACM400101', 2797, true, '120 ct'], ['4444444445', 'ACM400101', 4997, true, '240 ct']]);
  assert.equal(p.variants.filter((v) => v.variantId === r0.variant.variantId).length, 1); // exactly one is "current"
  const approved = L.decide(lib, 'sku:ACM400101', 'smp');
  assert.equal(row(approved, 'ACM400101').correction, 'approved');
  const chosen = L.chooseVariant(approved, 'sku:ACM400101', p.variants[1]);
  const r1 = row(chosen, 'ACM400101');
  assert.equal(r1.variant.variantId, '4444444445');
  assert.equal(r1.match.method, 'manual');
  assert.equal(r1.verification.status, 'mismatch'); // price check re-ran against the new variant
  assert.equal(r1.verification.diffCents, 2200);
  assert.equal(r1.correction, 'stale'); // the earlier approval was for the other variant
  assert.equal(r1.review.needsReview, true);
  assert.equal(JSON.stringify(chosen.smp), before); // the imported SMP is byte-identical
  assert.deepEqual([r1.prices.smpCents, r1.prices.promoCents], [r0.prices.smpCents, r0.prices.promoCents]);
  // a SKU change is warned about, never silent
  const other = L.chooseVariant(lib, 'sku:ACM400101', (await driverFor(store).product('fish-oil'))?.variants?.[0] || { ...p.variants[0], sku: 'OTHER', variantId: '9' });
  assert.ok(row(other, 'ACM400101').match.warnings.some((w) => /SKU differs/.test(w)));
});

await test('a rate-limited store (429) is retried once, then reported; other errors are not retried', async () => {
  let n = 0;
  const flaky = L.createDriver({ origin: ORIGIN, fetchJson: async () => { n++; if (n === 1) { const e = new Error('slow down'); e.status = 429; throw e; } return { currency: 'USD' }; } });
  assert.equal(await flaky.detectCurrency(), 'USD');
  assert.equal(n, 2);
  let m = 0;
  const limited = L.createDriver({ origin: ORIGIN, fetchJson: async () => { m++; const e = new Error('slow down'); e.status = 429; throw e; } });
  await assert.rejects(() => limited.detectCurrency(), /slow down/);
  assert.equal(m, 2);
  let k = 0;
  const down = L.createDriver({ origin: ORIGIN, fetchJson: async () => { k++; const e = new Error('boom'); e.status = 500; throw e; } });
  await assert.rejects(() => down.detectCurrency(), /boom/);
  assert.equal(k, 1);
});

// ------------------------------------------------------------------ Product list QA corrections

const csvLib = (store = '') => {
  const lib = L.newLibrary(store, 'Plain list');
  const imp = L.importCsv('SKU,Name,Price,Sale Price\nP1,Plain One,$10.00,$8.00\nP2,Plain Two,$20.00,\n', { fileName: 'plain.csv', sha256: 'plain1' });
  return { ...lib, smp: L.addImport(lib, imp).lib.smp };
};

await test('a list never needs Shopify: import, display, approve, edit, save and export all work with no store', async () => {
  const st = memStorage();
  let lib = csvLib('');
  assert.equal(lib.store, '');
  assert.deepEqual(L.optionalStore(''), { origin: '' });
  assert.equal(L.optionalStore('https://shop.example.com').origin, 'https://shop.example.com');
  assert.ok(L.optionalStore('http://shop.example.com').error);
  let rows = L.buildRows(lib);
  assert.equal(rows.length, 2);
  // neutral "not verified": not an error, not "needs review"
  assert.deepEqual(rows.map((r) => [r.variantState, r.review.needsReview, r.verification.status]), [['unchecked', false, 'unchecked'], ['unchecked', false, 'unchecked']]);
  assert.equal(L.STATUS_LABEL.unchecked, 'Not verified');
  assert.deepEqual([L.summarize(rows).notChecked, L.summarize(rows).needsReview, L.summarize(rows).approved], [2, 0, 0]);
  // prices can be approved without a variant
  lib = L.decide(lib, 'sku:P1', 'smp');
  lib = L.decide(lib, 'sku:P2', 'custom', 2100);
  rows = L.buildRows(lib);
  assert.deepEqual(rows.map((r) => [r.settled, r.prices.approvedCents]), [[true, 1000], [true, 2100]]);
  assert.throws(() => L.decide(lib, 'sku:P1', 'shopify'), /Choose the Shopify variant first/);
  // edits and a hand-added product
  lib = L.setEdit(lib, 'sku:P1', 'title', 'Plain One (renamed)');
  const added = L.addLocalProduct(lib, { name: 'By Hand', sku: 'H1', regularCents: 500, promoCents: 400 });
  lib = added.lib;
  const hand = L.buildRows(lib).find((r) => r.key === added.key);
  assert.deepEqual([hand.origin, hand.local, hand.sku, hand.prices.approvedCents, hand.prices.promoCents, hand.settled], ['manual', true, 'H1', 500, 400, true]);
  // saved under a store-less key, reloaded, and exported without a store
  await L.saveLibrary(st, lib, { smpChanged: true });
  assert.ok(Object.keys(st.data).some((k) => k === L.kSmp('', lib.campaign)));
  const back = await L.loadLibrary(st, '', lib.campaign);
  assert.deepEqual(L.buildRows(back).map((r) => [r.key, r.display.title, r.prices.approvedCents]), L.buildRows(lib).map((r) => [r.key, r.display.title, r.prices.approvedCents]));
  const full = L.exportList(back, 'full', 0);
  assert.equal(full.store, null);
  assert.equal(full.products.length, 3);
  assert.ok(full.products.every((p) => p.variantId === null && p.verification.shopify === 'not-verified'));
  assert.equal(L.exportList(back, 'approved', 0).products.length, 3); // all three were approved by the person
  const noApproval = L.exportList(csvLib(''), 'approved', 0);
  assert.equal(noApproval.products.length, 0);
  assert.equal(noApproval.needsAttention.length, 2);
  assert.equal(L.exportList(csvLib(''), 'full', 0).products.length, 2); // the full list keeps unapproved ones
});

await test('attaching a store later moves that one list; other lists and stores are untouched', async () => {
  const st = memStorage();
  const a = csvLib('');
  const b = { ...csvLib(ORIGIN), campaign: L.newListId() };
  await L.saveLibrary(st, a, { smpChanged: true });
  await L.saveLibrary(st, b, { smpChanged: true });
  await L.setActive(st, 'https://page.example.com', '', a.campaign);
  const bKeys = Object.keys(st.data).filter((k) => k.includes(`${ORIGIN}|${b.campaign}`)).sort();
  const bBefore = JSON.stringify(bKeys.map((k) => st.data[k]));
  const moved = await L.moveLibrary(st, a, 'https://other-shop.example.com');
  assert.equal(moved.store, 'https://other-shop.example.com');
  assert.ok(!(L.kSmp('', a.campaign) in st.data) && !(L.kWork('', a.campaign) in st.data));
  assert.ok(L.kSmp('https://other-shop.example.com', a.campaign) in st.data);
  assert.deepEqual(L.buildRows(await L.loadLibrary(st, 'https://other-shop.example.com', a.campaign)).map((r) => r.sku), ['P1', 'P2']);
  assert.equal(L.buildRows(await L.loadLibrary(st, '', a.campaign)).length, 0);
  assert.equal(JSON.stringify(Object.keys(st.data).filter((k) => k.includes(`${ORIGIN}|${b.campaign}`)).sort().map((k) => st.data[k])), bBefore);
  const idx = await L.loadIndex(st);
  assert.deepEqual(idx.libs.map((l) => [l.store, l.campaign]).sort(), [['https://other-shop.example.com', a.campaign], [ORIGIN, b.campaign]].sort());
  assert.deepEqual(idx.active['https://page.example.com'], { store: 'https://other-shop.example.com', campaign: a.campaign });
  // no store, no merge: the same SKUs in two lists stay two separate rows sets
  assert.equal(L.buildRows(await L.loadLibrary(st, ORIGIN, b.campaign)).length, 2);
});

await test('source identity is never replaced: a different variant is a substitution that needs explicit approval', async () => {
  const store = fakeStore([prod(7, 'cookies', 'Acme Mass Gainer', [variant(71, 'NTC591103', 5997, 'Cookies -n-Cream'), variant(72, 'NTC591101', 5997, 'Double Chocolate')])]);
  const imp = L.importCsv('SKU,Name,Price\nNTC591103,Mass Gainer Cookies -n-Cream,$59.97\n', { sha256: 'cookies' });
  let lib = { ...L.newLibrary(ORIGIN, 'Gainers'), smp: { v: 1, imports: [imp] } };
  lib = await L.checkAll(driverFor(store), lib, null);
  let r = L.buildRows(lib)[0];
  assert.deepEqual([r.identity.state, r.settled, r.variant.variantId], ['exact', true, '71']);
  // the person picks the other flavor (same price!)
  const dc = (await driverFor(store).product('cookies')).variants[1];
  lib = L.chooseVariant(lib, 'sku:NTC591103', dc);
  r = L.buildRows(lib)[0];
  assert.equal(r.key, 'sku:NTC591103'); // source key
  assert.equal(r.sku, 'NTC591103'); // source SKU and name unchanged
  assert.equal(r.name, 'Mass Gainer Cookies -n-Cream');
  assert.equal(r.variant.sku, 'NTC591101'); // selected variant is separate
  assert.equal(r.variant.variantId, '72');
  assert.equal(r.verification.status, 'match'); // same price...
  assert.equal(r.identity.state, 'substitute-pending'); // ...proves nothing about identity
  assert.equal(r.settled, false);
  assert.equal(r.prices.approvedCents, null);
  assert.equal(r.review.needsReview, true);
  assert.match(r.review.reasons.join(' '), /Substitution: the selected variant is SKU NTC591101, the list says NTC591103/);
  assert.equal(L.summarize(L.buildRows(lib)).substitutions, 1);
  // not in the approved export until approved; always in the full export, clearly distinct
  assert.equal(L.exportList(lib, 'approved', 0).products.length, 0);
  assert.match(L.exportList(lib, 'approved', 0).needsAttention[0].reason, /Substitution/);
  const rec = L.exportList(lib, 'full', 0).products[0];
  assert.deepEqual([rec.sku, rec.name, rec.shopifySku, rec.variantId, rec.variantTitle, rec.identity.state, rec.identity.skuMatchesSource, rec.identity.substitutionApproved, rec.source.sku], ['NTC591103', 'Mass Gainer Cookies -n-Cream', 'NTC591101', '72', 'Double Chocolate', 'substitute-pending', false, false, 'NTC591103']);
  // explicit approval
  lib = L.approveSubstitution(lib, 'sku:NTC591103');
  r = L.buildRows(lib)[0];
  assert.deepEqual([r.identity.state, r.settled, r.prices.approvedCents], ['substitute-approved', true, 5997]);
  const ok = L.exportList(lib, 'approved', 0).products[0];
  assert.deepEqual([ok.sku, ok.shopifySku, ok.identity.state, ok.identity.substitutionApproved, ok.matchMethod], ['NTC591103', 'NTC591101', 'substitute-approved', true, 'manual']); // never presented as an exact match
  // the approval belongs to that variant: another choice needs its own
  lib = L.chooseVariant(lib, 'sku:NTC591103', (await driverFor(store).product('cookies')).variants[0]);
  assert.equal(L.buildRows(lib)[0].identity.state, 'exact'); // back to the SKU the list named
  lib = L.chooseVariant(lib, 'sku:NTC591103', dc);
  assert.equal(L.buildRows(lib)[0].identity.state, 'substitute-approved'); // approval was for variant 72 and still is
  lib = L.chooseVariant(lib, 'sku:NTC591103', { ...dc, variantId: '73', variantGid: 'gid://shopify/ProductVariant/73', sku: 'NTC591199' });
  assert.equal(L.buildRows(lib)[0].identity.state, 'substitute-pending');
  assert.equal(L.revokeSubstitution(L.approveSubstitution(lib, 'sku:NTC591103'), 'sku:NTC591103').work.identity['sku:NTC591103'], undefined);
  // the imported source is untouched through all of it
  assert.equal(JSON.stringify(lib.smp.imports[0]), JSON.stringify(imp));
});

await test('Edit Information: display title, promo price and image are working values; reset returns to the source; identity and original stay', async () => {
  let { lib } = await checkedLib();
  const smp0 = JSON.stringify(lib.smp);
  const k = 'sku:ACM100101';
  const before = L.buildRows(lib).find((r) => r.key === k);
  lib = L.setEdit(lib, k, 'title', '  Black Seed Oil — Launch  ');
  lib = L.setEdit(lib, k, 'promoCents', 1099);
  lib = L.setEdit(lib, k, 'image', 'https://cdn.example.com/custom.png');
  let r = L.buildRows(lib).find((x) => x.key === k);
  assert.deepEqual([r.display.title, r.prices.promoCents, r.prices.promoSourceCents, r.display.image, r.display.edited], ['Black Seed Oil — Launch', 1099, 1199, 'https://cdn.example.com/custom.png', ['title', 'promoCents', 'image']]);
  assert.deepEqual([r.name, r.sku, r.source.promoCents, r.variant.variantId, r.variant.image, r.prices.smpCents, r.prices.shopifyCents], [before.name, before.sku, 1199, before.variant.variantId, before.variant.image, before.prices.smpCents, before.prices.shopifyCents]); // original, fetched and identity unchanged
  assert.equal(JSON.stringify(lib.smp), smp0);
  assert.throws(() => L.setEdit(lib, k, 'image', 'javascript:alert(1)'), /http/);
  assert.throws(() => L.setEdit(lib, k, 'title', '   '), /empty/);
  assert.throws(() => L.setEdit(lib, k, 'promoCents', -1), /valid/);
  assert.throws(() => L.setEdit(lib, k, 'sku', 'X'), /can’t be edited/);
  assert.throws(() => L.setLocalSku(lib, k, 'X'), /added by hand/);
  // the export keeps source, selected and working apart
  const rec = L.exportList(lib, 'full', 0).products.find((p) => p.key === k);
  assert.deepEqual([rec.name, rec.display.title, rec.prices.promoSourceCents, rec.prices.promoCents, rec.display.edited.length], ['Acme Black Seed Oil', 'Black Seed Oil — Launch', 1199, 1099, 3]);
  // persistence
  const st = memStorage();
  await L.saveLibrary(st, lib, { smpChanged: true });
  const back = await L.loadLibrary(st, ORIGIN, lib.campaign);
  assert.deepEqual(L.buildRows(back).find((x) => x.key === k).display, r.display);
  // reset
  for (const f of ['title', 'promoCents', 'image']) lib = L.resetEdit(lib, k, f);
  r = L.buildRows(lib).find((x) => x.key === k);
  assert.deepEqual([r.display.title, r.prices.promoCents, r.display.image, r.display.edited, lib.work.edits[k]], [before.name, 1199, before.variant.image, [], undefined]);
  // an edited promo price feeds the promo warnings, independent of the regular price
  const odd = L.setEdit(lib, k, 'promoCents', 500);
  assert.equal(L.buildRows(odd).find((x) => x.key === k).promoWarnings.length, 1);
  assert.equal(L.buildRows(odd).find((x) => x.key === k).verification.status, 'match');
});

await test('explicit additional-file import: add keeps the list, replace keeps the earlier import and the corrections', async () => {
  let { lib } = await checkedLib();
  lib = L.decide(lib, 'sku:ACM200101', 'custom', 1550);
  lib = L.setEdit(lib, 'sku:ACM200101', 'title', 'Charcoal (mine)');
  const first = lib.smp.imports[0];
  const second = L.importCsv('SKU,Name,Price\nACM200101,Acme Charcoal,$15.97\nNEW9,Brand New,$9.00\n', { fileName: 'more.csv', sha256: 'more1' });
  // add: same SKU joins as another placement, new SKU is a new product
  const added = L.addImport(lib, second).lib;
  assert.equal(L.buildRows(added).length, 7);
  assert.equal(L.buildRows(added).find((r) => r.sku === 'ACM200101').placements.length, 2);
  assert.equal(L.buildRows(added).find((r) => r.sku === 'ACM200101').prices.approvedCents, 1550);
  // replace: the new import is the content; the old one is archived whole; corrections for surviving SKUs stay
  const replaced = L.replaceImports(lib, second);
  assert.deepEqual(L.buildRows(replaced).map((r) => r.sku), ['ACM200101', 'NEW9']);
  assert.equal(replaced.smp.imports.length, 1);
  assert.equal(replaced.smp.replaced.length, 1);
  assert.deepEqual({ ...replaced.smp.replaced[0], replacedAt: undefined }, { ...first, replacedAt: undefined });
  const kept = L.buildRows(replaced).find((r) => r.sku === 'ACM200101');
  assert.deepEqual([kept.prices.approvedCents, kept.display.title, kept.variant.variantId], [1550, 'Charcoal (mine)', '4444444442']);
  assert.equal(replaced.work.shopify['sku:ACM100101'].variant.variantId, '4444444441'); // data for dropped products is kept, just not shown
  assert.equal(L.exportList(replaced, 'full', 0).sources.length, 2);
  assert.ok(L.exportList(replaced, 'full', 0).sources.some((s) => s.replaced));
  assert.equal(JSON.stringify(lib.smp.imports[0]), JSON.stringify(first)); // the original library object is untouched
});

await test('lists saved before this change (no identity or edits) load, and their manual substitutions now wait for approval', async () => {
  const st = memStorage();
  const imp = L.importCsv('SKU,Name,Price\nNTC591103,Mass Gainer Cookies -n-Cream,$59.97\n', { sha256: 'old1', fileName: 'old.csv' });
  const legacyWork = { v: 1, shopify: { 'sku:NTC591103': { match: { status: 'exact', method: 'manual', checkedAt: 1, warnings: ['SKU differs: the SMP says NTC591103, this variant is NTC591101.'], candidates: [] }, variant: { productId: '7', handle: 'c', productTitle: 'Gainer', variantId: '44234954735846', variantGid: 'gid://shopify/ProductVariant/44234954735846', variantTitle: 'Double Chocolate', sku: 'NTC591101', priceCents: 5997, compareAtCents: null, currency: 'USD', options: [{ name: 'Flavor', value: 'Double Chocolate' }], image: null, available: true, url: 'https://x.example.com/products/c' } } }, decisions: { 'sku:NTC591103': { source: 'match', approvedCents: 5997, smpCents: 5997, shopifyCents: 5997, variantId: '44234954735846', decidedAt: 1 } }, manualProducts: {}, settings: { currency: 'USD', currencySource: 'cart.js' }, updatedAt: 5 };
  st.data[L.kSmp(ORIGIN, 'cookies-list')] = { v: 1, imports: [imp] };
  st.data[L.kWork(ORIGIN, 'cookies-list')] = legacyWork;
  st.data[L.K_INDEX] = { v: 1, libs: [{ store: ORIGIN, campaign: 'cookies-list', name: 'Cookies list', updatedAt: 9 }], active: {} };
  const lib = await L.loadLibrary(st, ORIGIN, 'cookies-list');
  assert.deepEqual([lib.work.identity, lib.work.edits], [{}, {}]);
  const r = L.buildRows(lib)[0];
  assert.deepEqual([r.sku, r.variant.sku, r.identity.state, r.settled], ['NTC591103', 'NTC591101', 'substitute-pending', false]);
  const rec = L.exportList(lib, 'full', 0).products[0];
  assert.deepEqual([rec.variantId, rec.sku, rec.shopifySku], ['44234954735846', 'NTC591103', 'NTC591101']);
  assert.equal(L.exportApproved(lib, 0).products.length, 0);
  // an old export-shaped helper still answers
  assert.equal(typeof L.exportApproved, 'function');
  assert.equal(L.exportApproved(lib, 0).campaign.id, 'cookies-list');
});

// ------------------------------------------------------------------ List Manager

await test('list summaries: stable creation order, counts, corrections, duplicates by source hash, nothing merged', async () => {
  const st = memStorage();
  const mk = async (name, csv, sha, at) => {
    const lib = L.newLibrary('', name);
    const imp = { ...L.importCsv(csv, { fileName: `${name}.csv`, sha256: sha }), importedAt: at };
    return { ...lib, smp: { v: 1, imports: [imp] } };
  };
  const a = await mk('Weekly', 'SKU,Name,Price\nA1,Alpha,$1.00\nA2,Beta,$2.00\n', 'hashA', 1000);
  const b = await mk('Weekly', 'SKU,Name,Price\nB1,Gamma,$3.00\n', 'hashB', 2000);
  const c = await mk('Weekly', 'SKU,Name,Price\nA1,Alpha,$1.00\nA2,Beta,$2.00\n', 'hashA', 3000);
  // saved out of order, and updated later: creation order must not change
  await L.saveLibrary(st, c, { smpChanged: true });
  await L.saveLibrary(st, a, { smpChanged: true });
  await L.saveLibrary(st, b, { smpChanged: true });
  await L.saveLibrary(st, L.decide(a, 'sku:A1', 'smp'));
  const before = (await L.listSummaries(st)).map((s) => s.campaign);
  assert.deepEqual(before, [a.campaign, b.campaign, c.campaign]);
  await L.saveLibrary(st, L.decide(b, 'sku:B1', 'custom', 350)); // "opening / editing" b
  await L.loadLibrary(st, '', c.campaign);
  const sums = await L.listSummaries(st);
  assert.deepEqual(sums.map((s) => s.campaign), before);
  assert.deepEqual(sums.map((s) => s.createdAt), [1000, 2000, 3000]); // original import time, not the save time
  assert.deepEqual(sums.map((s) => s.products), [2, 1, 2]);
  assert.deepEqual(sums.map((s) => s.name), ['Weekly (2)', 'Weekly (3)', 'Weekly']); // names are unique: the list saved first (c) keeps "Weekly"
  assert.deepEqual(sums.map((s) => s.hasCorrections), [true, true, false]);
  assert.equal(sums[0].corrections.approvedPrices, 1);
  // duplicates are reported, never merged or removed
  assert.deepEqual(sums[0].duplicates.map((d) => d.campaign), [c.campaign]);
  assert.deepEqual(sums[2].duplicates.map((d) => d.campaign), [a.campaign]);
  assert.deepEqual(sums[1].duplicates, []);
  assert.equal((await L.loadIndex(st)).libs.length, 3);
  assert.equal(L.buildRows(await L.loadLibrary(st, '', c.campaign)).length, 2);
});

await test('list summaries: "same source file" and "first imported" (oldest by creation, never implying it is the most correct); an unrelated list has neither', async () => {
  const st = memStorage();
  const mk = (name, csv, sha, at) => ({ ...L.newLibrary('', name), smp: { v: 1, imports: [{ ...L.importCsv(csv, { fileName: `${name}.csv`, sha256: sha }), importedAt: at }] } });
  const a = mk('One', 'SKU,Name,Price\nA1,Alpha,$1.00\n', 'same', 1000);
  const b = mk('Other', 'SKU,Name,Price\nB1,Beta,$2.00\n', 'diff', 2000);
  const c = mk('Three', 'SKU,Name,Price\nA1,Alpha,$1.00\n', 'same', 3000);
  const d = mk('Four', 'SKU,Name,Price\nA1,Alpha,$1.00\n', 'same', 4000);
  for (const l of [d, c, b, a]) await L.saveLibrary(st, l, { smpChanged: true });
  const s = await L.listSummaries(st);
  const by = (l) => s.find((x) => x.campaign === l.campaign);
  assert.deepEqual([by(a), by(c), by(d)].map((x) => x.sameSource), [true, true, true]);
  assert.deepEqual([by(a), by(c), by(d)].map((x) => x.firstImported), [true, false, false]);
  assert.deepEqual([by(b).sameSource, by(b).firstImported], [false, false]);
  assert.equal(s.length, 4); // nothing merged or removed
});

await test('Last edited: a save that is not an edit (automatic currency detection) keeps the list\'s updatedAt; a real edit moves it; createdAt never moves', async () => {
  const st = memStorage();
  const lib = { ...L.newLibrary('https://shop.example.com', 'Weekly'), smp: { v: 1, imports: [{ ...L.importCsv('SKU,Name,Price\nA1,Alpha,$1.00\n', { fileName: 'w.csv', sha256: 'h' }), importedAt: 1000 }] } };
  await L.saveLibrary(st, lib, { smpChanged: true });
  const e0 = (await L.loadIndex(st)).libs[0];
  await new Promise((r) => setTimeout(r, 15));
  await L.saveLibrary(st, { ...lib, work: { ...lib.work, settings: { currency: 'USD', currencySource: 'cart.js' } } }, { touch: false });
  const e1 = (await L.loadIndex(st)).libs[0];
  assert.equal(e1.updatedAt, e0.updatedAt);
  assert.equal((await L.loadLibrary(st, lib.store, lib.campaign)).work.settings.currencySource, 'cart.js'); // the data itself was saved
  await new Promise((r) => setTimeout(r, 15));
  await L.saveLibrary(st, L.decide(lib, 'sku:A1', 'smp'));
  const e2 = (await L.loadIndex(st)).libs[0];
  assert.ok(e2.updatedAt > e0.updatedAt);
  assert.equal(e2.createdAt, e0.createdAt);
});

await test('list summaries: lists saved before createdAt existed get one from their first import, kept stable; other fields untouched', async () => {
  const st = memStorage();
  const imp = { ...L.importCsv('SKU,Name,Price\nX1,Old,$5.00\n', { sha256: 'oldh', fileName: 'old.csv' }), importedAt: 5000 };
  st.data[L.kSmp(ORIGIN, 'old-list')] = { v: 1, imports: [imp] };
  st.data[L.kWork(ORIGIN, 'old-list')] = L.emptyWork();
  st.data[L.K_INDEX] = { v: 1, libs: [{ store: ORIGIN, campaign: 'old-list', name: 'Old list', updatedAt: 99999 }], active: { 'https://p.example.com': { store: ORIGIN, campaign: 'old-list' } } };
  const s1 = await L.listSummaries(st);
  assert.equal(s1[0].createdAt, 5000);
  const idx = await L.loadIndex(st);
  assert.deepEqual([idx.libs[0].campaign, idx.libs[0].name, idx.libs[0].updatedAt, idx.libs[0].createdAt], ['old-list', 'Old list', 99999, 5000]);
  assert.deepEqual(idx.active['https://p.example.com'], { store: ORIGIN, campaign: 'old-list' });
  await L.saveLibrary(st, await L.loadLibrary(st, ORIGIN, 'old-list'));
  assert.equal((await L.listSummaries(st))[0].createdAt, 5000);
});

await test('list summaries count approved replacements and substitutions, and isolation by store is kept', async () => {
  const store = fakeStore([prod(7, 'cookies', 'Acme Gainer', [variant(71, 'NTC591103', 5997, 'Cookies'), variant(72, 'NTC591101', 5997, 'Choc')])]);
  const imp = L.importCsv('SKU,Name,Price\nNTC591103,Gainer Cookies,$59.97\n', { sha256: 'g1' });
  let lib = { ...L.newLibrary(ORIGIN, 'Gainers'), smp: { v: 1, imports: [imp] } };
  lib = await L.checkAll(driverFor(store), lib, null);
  lib = L.chooseVariant(lib, 'sku:NTC591103', (await driverFor(store).product('cookies')).variants[1]);
  const st = memStorage();
  await L.saveLibrary(st, lib, { smpChanged: true });
  let [s1] = await L.listSummaries(st);
  assert.deepEqual([s1.substitutions, s1.needsReview, s1.corrections.manualChoices, s1.corrections.approvedSubstitutions], [1, 1, 1, 0]);
  await L.saveLibrary(st, L.approveSubstitution(lib, 'sku:NTC591103'));
  [s1] = await L.listSummaries(st);
  assert.deepEqual([s1.substitutions, s1.needsReview, s1.corrections.approvedSubstitutions, s1.hasCorrections, s1.store], [0, 0, 1, true, ORIGIN]);
  await L.saveLibrary(st, { ...csvLib(''), campaign: L.newListId() }, { smpChanged: true });
  const all = await L.listSummaries(st);
  assert.deepEqual(all.map((s) => s.store).sort(), ['', ORIGIN].sort());
});

console.log(`\n${pass}/${pass + fail} library tests passed`);
process.exit(fail ? 1 : 0);
