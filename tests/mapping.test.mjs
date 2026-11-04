// Product Mapping (M1) core tests: the snapshot built from a Product Library row and the report lines written
// from it (library.js). Node only: no browser, no network, no npm dependencies. Synthetic data only.
// Usage: node mapping.test.mjs
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const L = createRequire(import.meta.url)(join(here, '..', 'library.js'));

let pass = 0;
let fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').slice(0, 8).join('\n      ')}`); }
};

// ------------------------------------------------------------------ synthetic fixtures

const ORIGIN = 'https://shop.example.com';
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0); // 2026-11-03
const BIG_ID = '9007199254740993'; // 2^53 + 1: not representable as a JavaScript number

const CSV = [
  'Section,SKU,Product Name,Original Price,Sale Price',
  'Featured,ACM-100,Acme Alpha Powder,$20.00,$12.00',
  'Featured,ACM-200,Acme Beta Capsules,$30.00,$18.00',
  'Featured,ACM-300,Acme Gamma Oil,$15.97,$9.59',
  'Best Sellers,,Acme Bundle,,',
].join('\n');

const prodJson = (id, handle, title, variants) => ({ id, handle, title, featured_image: `//cdn.example.com/${handle}.jpg`, options: [{ name: 'Flavor', position: 1, values: variants.map((v) => v.option1) }], variants });
const vJson = (id, sku, price, option1) => ({ id, title: option1, sku, price, compare_at_price: null, available: true, option1, options: [option1] });
const variantOf = (json, i = 0) => L.normalizeProduct(json, ORIGIN, 'USD').variants[i];

function baseLib(store = ORIGIN, campaign = 'l-test-a') {
  const imp = L.importCsv(CSV, { fileName: 'acme-test.csv', sha256: 'abc123' });
  return { store, campaign, name: 'Acme test list', smp: { v: 1, imports: [imp] }, work: L.emptyWork() };
}
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const text = (lines) => lines.join('\n');
const memStorage = () => { const d = {}; return { d, get: async (k) => Object.fromEntries([].concat(k).filter((x) => x in d).map((x) => [x, JSON.parse(JSON.stringify(d[x]))])), set: async (o) => { for (const [k, v] of Object.entries(o)) d[k] = JSON.parse(JSON.stringify(v)); }, remove: async (k) => { for (const x of [].concat(k)) delete d[x]; } }; };

// A list with: ACM-100 exact Shopify variant + SMP price approved; ACM-200 exact variant, custom regular price and
// custom promo; ACM-300 an approved substitution; a hand-added product with no Shopify at all.
function richLib() {
  let lib = baseLib();
  lib = L.chooseVariant(lib, 'sku:ACM-100', variantOf(prodJson(1111, 'alpha-powder', 'Acme Alpha Powder', [vJson(BIG_ID, 'ACM-100', 2000, 'Blue Raz')])));
  lib = L.decide(lib, 'sku:ACM-100', 'smp');
  lib = L.chooseVariant(lib, 'sku:ACM-200', variantOf(prodJson(2222, 'beta-caps', 'Acme Beta Capsules', [vJson(5555, 'ACM-200', 3000, 'Unflavored')])));
  lib = L.decide(lib, 'sku:ACM-200', 'custom', 2799);
  lib = L.setEdit(lib, 'sku:ACM-200', 'promoCents', 1999);
  lib = L.chooseVariant(lib, 'sku:ACM-300', variantOf(prodJson(3333, 'gamma-oil', 'Acme Gamma Oil Deluxe', [vJson(6666, 'ACM-399', 1597, 'Unflavored')])));
  lib = L.decide(lib, 'sku:ACM-300', 'shopify');
  lib = L.approveSubstitution(lib, 'sku:ACM-300');
  const hand = L.addLocalProduct(lib, { name: 'Hand Made Kit', sku: 'HM-1', regularCents: 4500, promoCents: 3600 });
  return { lib: hand.lib, handKey: hand.key };
}

// ------------------------------------------------------------------ snapshot

await test('Shopify-resolved product: exact variant id kept as a string, ids, SKU, options, prices in integer cents', () => {
  const { lib } = richLib();
  const m = L.productMappingSnapshot(lib, 'sku:ACM-100', { now: NOW });
  assert.equal(m.v, L.MAPPING_SCHEMA);
  assert.equal(m.origin, 'manual');
  assert.equal(m.mappedAt, NOW);
  assert.deepEqual(m.list, { store: ORIGIN, id: 'l-test-a', name: 'Acme test list' });
  assert.equal(m.product.key, 'sku:ACM-100');
  assert.equal(m.product.sku, 'ACM-100');
  assert.equal(m.variant.variantId, BIG_ID); // not 9007199254740992
  assert.equal(typeof m.variant.variantId, 'string');
  assert.equal(m.variant.productId, '1111');
  assert.equal(m.variant.handle, 'alpha-powder');
  assert.equal(m.variant.sku, 'ACM-100');
  assert.deepEqual(m.variant.options, [{ name: 'Flavor', value: 'Blue Raz' }]);
  assert.equal(m.variant.url, `${ORIGIN}/products/alpha-powder?variant=${BIG_ID}`);
  assert.equal(m.approved.regularCents, 2000);
  assert.equal(m.approved.regularSource, 'smp');
  assert.equal(m.approved.promoCents, 1200);
  assert.equal(m.approved.promoSource, 'smp');
  assert.equal(m.approved.currency, 'USD');
  assert.equal(m.approved.image, 'https://cdn.example.com/alpha-powder.jpg');
  assert.equal(m.state.verification, 'verified');
  assert.equal(m.state.identity, 'exact');
  assert.deepEqual(m.product.source, { originalCents: 2000, promoCents: 1200 });
  assert.deepEqual({ ...m.libraryRef, baseline: undefined }, { importHashes: ['abc123'], workUpdatedAt: lib.work.updatedAt, baseline: undefined });
  assert.equal(m.libraryRef.baseline.variantId, m.variant.variantId); // what the list said when this was mapped
  assert.equal(m.card, null);
  for (const n of [m.approved.regularCents, m.approved.promoCents]) assert.ok(Number.isInteger(n));
});

await test('Manual product with no Shopify stays valid: no variant, no link, no invented ids; approved values kept', () => {
  const { lib, handKey } = richLib();
  const m = L.productMappingSnapshot(lib, handKey, { now: NOW });
  assert.equal(m.variant, null);
  assert.equal(m.product.origin, 'manual');
  assert.equal(m.product.local, true);
  assert.equal(m.product.sku, 'HM-1');
  assert.equal(m.product.source, null);
  assert.equal(m.approved.regularCents, 4500);
  assert.equal(m.approved.regularSource, 'custom');
  assert.equal(m.approved.promoCents, 3600);
  assert.equal(m.approved.promoSource, 'custom');
  assert.equal(m.state.verification, 'not-verified');
  assert.equal(m.approved.image, null);
  assert.ok(L.isMapping(m));
  const r = text(L.mappingReportLines(m));
  assert.match(r, /Shopify: no variant recorded\. Don’t invent an id or link\./);
  assert.match(r, /Link: none recorded/);
  assert.match(r, /Image: none recorded/);
  assert.doesNotMatch(r, /variant id|product id|handle/);
  assert.match(r, /regular \$45\.00 \(approved, manual override\), sale \$36\.00 \(manual override\)/);
  assert.doesNotMatch(r, /live-verified/);
});

await test('Approved custom prices are kept as approved, not reverted to the Shopify or SMP price', () => {
  const { lib } = richLib();
  const m = L.productMappingSnapshot(lib, 'sku:ACM-200');
  assert.equal(m.approved.regularCents, 2799); // SMP says 3000, Shopify says 3000
  assert.equal(m.approved.regularSource, 'custom');
  assert.equal(m.approved.promoCents, 1999); // SMP promo is 1800
  assert.equal(m.approved.promoSource, 'custom');
  assert.equal(m.reference.smpCents, 3000);
  assert.equal(m.reference.shopifyCents, 3000);
  assert.deepEqual(m.product.source, { originalCents: 3000, promoCents: 1800 });
  const r = text(L.mappingReportLines(m));
  assert.match(r, /regular \$27\.99 \(approved, manual override\), sale \$19\.99 \(manual override\)/);
});

await test('Approved substitution: both SKUs shown, marked approved; the approved Shopify price is kept', () => {
  const { lib } = richLib();
  const m = L.productMappingSnapshot(lib, 'sku:ACM-300');
  assert.equal(m.state.identity, 'substitute-approved');
  assert.equal(m.state.sourceSku, 'ACM-300');
  assert.equal(m.state.shopifySku, 'ACM-399');
  assert.equal(m.approved.regularCents, 1597);
  assert.equal(m.approved.regularSource, 'shopify');
  assert.equal(m.variant.variantId, '6666');
  const r = text(L.mappingReportLines(m));
  assert.match(r, /replacement approved for this card \(list SKU ACM-300 → variant SKU ACM-399\)/);
  assert.match(r, /variant SKU `ACM-399`/); // differs from the list SKU, so it is named
});

await test('Pending substitution: no approved price is claimed and the report says so', () => {
  let lib = baseLib();
  lib = L.chooseVariant(lib, 'sku:ACM-300', variantOf(prodJson(3333, 'gamma-oil', 'Acme Gamma Oil Deluxe', [vJson(6666, 'ACM-399', 1597, 'Unflavored')])));
  lib = L.decide(lib, 'sku:ACM-300', 'shopify'); // a price was chosen, but the substitution was never approved
  const m = L.productMappingSnapshot(lib, 'sku:ACM-300');
  assert.equal(m.state.identity, 'substitute-pending');
  assert.equal(m.approved.regularCents, null);
  assert.equal(m.approved.regularSource, null);
  assert.equal(m.state.settled, false);
  assert.equal(m.state.needsReview, true);
  assert.equal(m.reference.shopifyCents, 1597);
  const r = text(L.mappingReportLines(m));
  assert.match(r, /\*\*replacement not approved\*\* \(list SKU ACM-300, selected variant SKU ACM-399\)/);
  assert.match(r, /regular price not approved \(SMP \$15\.97, Shopify \$15\.97\)/);
});

await test('Unresolved approval (nothing checked, nothing approved): snapshot is valid and says nothing was approved', () => {
  const lib = baseLib();
  const m = L.productMappingSnapshot(lib, 'sku:ACM-100');
  assert.equal(m.variant, null);
  assert.equal(m.approved.regularCents, null);
  assert.equal(m.approved.promoCents, 1200); // the list's own promotional price (working value)
  assert.equal(m.state.verification, 'not-verified');
  assert.equal(m.state.approval, 'none');
  assert.equal(m.reference.smpCents, 2000);
  assert.ok(L.isMapping(m));
  assert.match(text(L.mappingReportLines(m)), /regular price not approved \(SMP \$20\.00\)/);
});

await test('Missing optional data (no SKU, no prices, no image, no store): no nulls, undefined or NaN in the report', () => {
  const lib = baseLib('', 'l-nostore');
  const m = L.productMappingSnapshot(lib, 'name:acme-bundle');
  assert.equal(m.product.sku, null);
  assert.equal(m.variant, null);
  assert.equal(m.approved.regularCents, null);
  assert.equal(m.approved.promoCents, null);
  assert.equal(m.approved.promoSource, null);
  assert.equal(m.list.store, '');
  const r = text(L.mappingReportLines(m));
  assert.match(r, /\(no Shopify store\)/);
  assert.match(r, /regular price not approved \(no price on record\), no sale price/);
  assert.match(r, /Replace this card’s title with the values above/); // nothing else to replace
  assert.doesNotMatch(r, /undefined|null|NaN|\[object/);
});

await test('The card slot is optional: nothing is invented without one, and what is given is reported', () => {
  const { lib } = richLib();
  const none = text(L.mappingReportLines(L.productMappingSnapshot(lib, 'sku:ACM-100', { now: NOW })));
  assert.doesNotMatch(none, /Card:/);
  const card = { selector: '#picks > article:nth-of-type(2)', section: { heading: 'Featured Deals' }, index: 2, count: 3, text: '[Product Name]' };
  const m = L.productMappingSnapshot(lib, 'sku:ACM-100', { now: NOW, card });
  assert.deepEqual(m.card, card);
  assert.notEqual(m.card, card); // a copy
  assert.match(text(L.mappingReportLines(m)), /Card: `#picks > article:nth-of-type\(2\)`, in section “Featured Deals”, card 2 of 3, currently “\[Product Name\]”/);
  const partial = text(L.mappingReportLines(L.productMappingSnapshot(lib, 'sku:ACM-100', { card: { section: 'Best Sellers' } })));
  assert.match(partial, /Card: in section “Best Sellers”/);
  const cardLine = partial.split('\n').find((l) => l.includes('Card:')) || '';
  assert.ok(cardLine && !cardLine.includes('`')); // no selector invented
});

await test('Suggested origin is recorded and reported', () => {
  const { lib } = richLib();
  const m = L.productMappingSnapshot(lib, 'sku:ACM-100', { origin: 'suggested', now: NOW });
  assert.equal(m.origin, 'suggested');
  assert.match(text(L.mappingReportLines(m)), /suggested match accepted/);
  assert.throws(() => L.productMappingSnapshot(lib, 'sku:ACM-100', { origin: 'auto' }), /Unknown mapping origin/);
});

await test('Unknown product and invalid mappings are refused or ignored', () => {
  const { lib } = richLib();
  assert.throws(() => L.productMappingSnapshot(lib, 'sku:NOPE'), /isn’t in this list/);
  for (const bad of [null, undefined, {}, { product: {} }, { product: { key: '' } }, 'x', 5]) { assert.equal(L.isMapping(bad), false); assert.deepEqual(L.mappingReportLines(bad), []); }
});

// ------------------------------------------------------------------ report

await test('Report: one concise block with the values, the replace instruction and no live-verification claim', () => {
  const { lib } = richLib();
  const card = { selector: '[data-card="2"]', section: { heading: 'Featured Deals' }, index: 2, count: 3, text: '[Product Name]' };
  const lines = L.mappingReportLines(L.productMappingSnapshot(lib, 'sku:ACM-100', { now: NOW, card }));
  console.log('      ' + lines.join('\n      '));
  assert.ok(lines.every((l) => l.startsWith('- ') || l.startsWith('  - ')));
  assert.ok(lines.length <= 9);
  assert.equal(lines[0], '- **Product mapping** from list “Acme test list” (https://shop.example.com)');
  assert.equal(lines[1], '  - Card: `[data-card="2"]`, in section “Featured Deals”, card 2 of 3, currently “[Product Name]”');
  assert.equal(lines[2], '  - Product: Acme Alpha Powder · list SKU `ACM-100`');
  assert.equal(lines[3], `  - Shopify: variant id \`${BIG_ID}\` (“Blue Raz”), variant SKU \`ACM-100\`, product id \`1111\`, handle \`alpha-powder\``);
  assert.equal(lines[4], '  - Prices: regular $20.00 (approved, SMP price), sale $12.00 (SMP promotional price)');
  assert.equal(lines[5], '  - Image: `https://cdn.example.com/alpha-powder.jpg`');
  assert.equal(lines[6], `  - Link: \`${ORIGIN}/products/alpha-powder?variant=${BIG_ID}\``);
  assert.equal(lines[7], '  - Replace this card’s title, image, prices and link with the values above, keeping its markup and styling. Where it shows two prices, the sale price is the current one and the regular price is the struck-through one. Use the variant id only on a cart control the card already has; don’t add cart or checkout wiring where it has none.');
  assert.ok(!lines.some((l) => /live-verified|Status:/.test(l))); // no disclaimers, no positive status line
});

await test('Report is written from the snapshot alone: no library or storage is consulted', () => {
  const { lib } = richLib();
  const m = L.productMappingSnapshot(lib, 'sku:ACM-100', { now: NOW });
  const before = text(L.mappingReportLines(m));
  lib.work.decisions = {}; lib.work.shopify = {}; lib.smp.imports = []; // the library changes afterwards
  assert.equal(text(L.mappingReportLines(m)), before);
});

// ------------------------------------------------------------------ serialisation, isolation, no side effects

await test('JSON round trip keeps everything, including the exact variant id and the report', () => {
  const { lib, handKey } = richLib();
  for (const key of ['sku:ACM-100', 'sku:ACM-200', 'sku:ACM-300', handKey, 'name:acme-bundle']) {
    const m = L.productMappingSnapshot(lib, key, { now: NOW, card: { selector: '#x', index: 1, count: 2 } });
    const back = JSON.parse(JSON.stringify(m));
    assert.deepEqual(back, m);
    assert.equal(JSON.stringify(back), JSON.stringify(m));
    assert.equal(text(L.mappingReportLines(back)), text(L.mappingReportLines(m)));
  }
  assert.equal(JSON.parse(JSON.stringify(L.productMappingSnapshot(lib, 'sku:ACM-100'))).variant.variantId, BIG_ID);
});

await test('The library is never modified: a frozen library works, and the snapshot shares nothing with it', () => {
  const { lib } = richLib();
  const before = JSON.stringify(lib);
  deepFreeze(lib);
  const m = L.productMappingSnapshot(lib, 'sku:ACM-100');
  m.variant.options.push({ name: 'x', value: 'y' });
  m.approved.regularCents = 1;
  m.list.id = 'changed';
  m.state.reasons.push('x');
  assert.equal(JSON.stringify(lib), before);
});

await test('Stored library records are untouched by taking a snapshot', async () => {
  const { lib } = richLib();
  const st = memStorage();
  await L.saveLibrary(st, lib, { smpChanged: true });
  const before = JSON.stringify(st.d);
  const loaded = await L.loadLibrary(st, lib.store, lib.campaign);
  L.productMappingSnapshot(loaded, 'sku:ACM-100');
  L.productMappingSnapshot(loaded, 'sku:ACM-200');
  assert.equal(JSON.stringify(st.d), before);
});

await test('Mappings carry their own list identity: the same product in two lists (or stores) never mixes', () => {
  const a = baseLib(ORIGIN, 'l-list-a');
  const b = baseLib('', 'l-list-b');
  const la = L.decide(a, 'sku:ACM-100', 'custom', 1111);
  const lb = L.decide(b, 'sku:ACM-100', 'custom', 2222);
  const ma = L.productMappingSnapshot(la, 'sku:ACM-100');
  const mb = L.productMappingSnapshot(lb, 'sku:ACM-100');
  assert.deepEqual([ma.list.id, ma.list.store, ma.approved.regularCents], ['l-list-a', ORIGIN, 1111]);
  assert.deepEqual([mb.list.id, mb.list.store, mb.approved.regularCents], ['l-list-b', '', 2222]);
  assert.equal(ma.product.key, mb.product.key); // same key, different list: the list id is what tells them apart
  assert.notEqual(JSON.stringify(ma.list), JSON.stringify(mb.list));
});

// ------------------------------------------------------------------ M3: page-specific values, variant change, comparing with the list, search

await test('M3 values: overrides sit beside the approved data, are validated, reset, and never change the original', () => {
  const { lib } = richLib();
  const m0 = L.productMappingSnapshot(lib, 'sku:ACM-100', { now: NOW });
  const frozen = JSON.stringify(m0);
  let m = L.setMappingOverride(m0, 'title', '  Alpha  Night  ');
  m = L.setMappingOverride(m, 'regularCents', '24.99');
  m = L.setMappingOverride(m, 'promoCents', 1500);
  m = L.setMappingOverride(m, 'url', 'https://shop.example.com/products/alpha-night');
  assert.deepEqual(m.overrides, { title: 'Alpha Night', regularCents: 2499, promoCents: 1500, url: 'https://shop.example.com/products/alpha-night' });
  assert.equal(JSON.stringify(m0), frozen); // the input was not changed
  assert.equal(m.approved.regularCents, 2000); assert.equal(m.approved.title, 'Acme Alpha Powder'); // the approved data is untouched
  assert.equal(m.variant.variantId, BIG_ID); // and so is the variant
  const ev = L.effectiveValues(m);
  assert.deepEqual([ev.title, ev.regularCents, ev.promoCents, ev.edited.join()], ['Alpha Night', 2499, 1500, 'title,regularCents,promoCents,url']);
  assert.equal(ev.base.regularCents, 2000);
  assert.throws(() => L.setMappingOverride(m, 'regularCents', 'abc'), /price/);
  assert.throws(() => L.setMappingOverride(m, 'image', 'javascript:alert(1)'), /web address/);
  assert.throws(() => L.setMappingOverride(m, 'variantId', '1'), /can’t be edited/);
  const reset = L.setMappingOverride(L.setMappingOverride(m, 'title', ''), 'regularCents', null);
  assert.deepEqual(Object.keys(reset.overrides).sort(), ['promoCents', 'url']);
  assert.equal('overrides' in L.setMappingOverride(L.setMappingOverride(L.setMappingOverride(reset, 'promoCents', ''), 'url', ''), 'title', ''), false);
});

await test('M3 values: an unapproved price is not treated as approved, and an override says so', () => {
  const lib = baseLib(); // nothing checked or approved
  const m = L.productMappingSnapshot(lib, 'sku:ACM-100', { now: NOW });
  assert.equal(L.effectiveValues(m).regularCents, null);
  const o = L.setMappingOverride(m, 'regularCents', '19.00');
  const lines = text(L.mappingReportLines(o));
  assert.match(lines, /regular \$19\.00 \(page-specific override; no approved regular price\)/);
  assert.match(lines, /don’t change what Shopify charges at checkout/);
});

await test('M3 report: overrides and the stale warning are shown, nothing else is invented', () => {
  const { lib } = richLib();
  let m = L.setMappingOverride(L.productMappingSnapshot(lib, 'sku:ACM-100', { now: NOW }), 'title', 'Alpha Night');
  m = L.setMappingOverride(m, 'image', 'https://cdn.example.com/night.jpg');
  const t = text(L.mappingReportLines(m, { check: { state: 'changed', notes: ['Approved regular price changed: saved $20.00, list now $18.00.'] } }));
  assert.match(t, /Product: Alpha Night .*page-specific title; the list calls it “Acme Alpha Powder”/);
  assert.match(t, /Image: `https:\/\/cdn\.example\.com\/night\.jpg` \(page-specific override\)/);
  assert.match(t, /\*\*Warning, the saved list record changed:\*\* Approved regular price changed/);
  assert.match(t, /don’t add cart or checkout wiring/);
  assert.doesNotMatch(text(L.mappingReportLines(m, { check: { state: 'current', notes: [] } })), /stale/);
  const rich = richLib();
  const manual = text(L.mappingReportLines(L.productMappingSnapshot(rich.lib, rich.handKey, { now: NOW })));
  assert.doesNotMatch(manual, /cart or checkout wiring/); // no variant: no cart advice at all
});

await test('M3 variant: another variant of the product replaces the identity only; a different SKU is a pending substitution', () => {
  const { lib } = richLib();
  const m = L.setMappingOverride(L.productMappingSnapshot(lib, 'sku:ACM-100', { now: NOW }), 'title', 'Keep me');
  const sameSku = variantOf(prodJson(1111, 'alpha-powder', 'Acme Alpha Powder', [vJson('9007199254740995', 'ACM-100', 2000, 'Green Apple')]));
  const a = L.changeMappingVariant(m, sameSku);
  assert.equal(a.variant.variantId, '9007199254740995'); // exact string
  assert.equal(a.state.identity, 'exact');
  assert.equal(a.approved.regularCents, null); // the approval belonged to the earlier variant
  assert.equal(a.overrides.title, 'Keep me');
  assert.equal(a.product.key, 'sku:ACM-100');
  assert.equal(m.variant.variantId, BIG_ID); // the original mapping object is unchanged
  const other = variantOf(prodJson(1111, 'alpha-powder', 'Acme Alpha Powder', [vJson('777', 'ACM-199', 2200, 'Mango')]));
  const b = L.changeMappingVariant(m, other);
  assert.equal(b.state.identity, 'substitute-pending');
  assert.match(text(L.mappingReportLines(b)), /replacement not approved/);
  assert.equal(L.changeMappingVariant(m, variantOf(prodJson(1111, 'alpha-powder', 'x', [vJson(BIG_ID, 'ACM-100', 2000, 'Blue Raz')])))?.variantChangedAt, undefined); // choosing the same variant changes nothing
  assert.throws(() => L.changeMappingVariant(m, null), /Choose a variant/);
});

await test('M3 compare: a saved mapping against its list is current, changed, product-missing or list-missing, and the list is never modified', () => {
  const { lib } = richLib();
  const m = L.productMappingSnapshot(lib, 'sku:ACM-100', { now: NOW });
  assert.deepEqual(L.mappingCheck(lib, m), { state: 'current', notes: [] });
  const approved2 = L.decide(lib, 'sku:ACM-100', 'custom', 1800);
  const c = L.mappingCheck(approved2, m);
  assert.equal(c.state, 'changed');
  assert.ok(c.notes.some((n) => /Approved regular price: \$20\.00 → \$18\.00/.test(n)), c.notes.join('|'));
  const relinked = L.chooseVariant(lib, 'sku:ACM-100', variantOf(prodJson(1111, 'alpha-powder', 'Acme Alpha Powder', [vJson('888', 'ACM-100', 2000, 'Lemon')])));
  assert.ok(L.mappingCheck(relinked, m).notes.some((n) => /Variant id in the list: 9007199254740993 → 888/.test(n)));
  const gone = { ...lib, smp: { v: 1, imports: [] }, work: { ...lib.work, manualProducts: {} } };
  assert.equal(L.mappingCheck(gone, m).state, 'product-missing');
  assert.equal(L.mappingCheck(null, m).state, 'list-missing');
  assert.equal(m.approved.regularCents, 2000); // checking never rewrites the mapping
  const changed = L.changeMappingVariant(m, variantOf(prodJson(1111, 'alpha-powder', 'Acme Alpha Powder', [vJson('999', 'ACM-100', 2000, 'Lime')])));
  assert.deepEqual(L.mappingCheck(lib, changed), { state: 'current', notes: [] }); // an intentional variant change is not drift
  const frozenLib = deepFreeze(JSON.parse(JSON.stringify(lib)));
  assert.doesNotThrow(() => L.mappingCheck(frozenLib, m));
});

await test('M3 search: by name, SKU, option or variant SKU; every word must match; an exact SKU comes first', () => {
  const { lib } = richLib();
  const rows = L.buildRows(lib);
  assert.deepEqual(L.searchRows(rows, 'beta').map((r) => r.sku), ['ACM-200']);
  assert.deepEqual(L.searchRows(rows, 'acm-100').map((r) => r.sku), ['ACM-100']);
  assert.deepEqual(L.searchRows(rows, 'acme powder').map((r) => r.sku), ['ACM-100']);
  assert.deepEqual(L.searchRows(rows, 'blue raz').map((r) => r.sku), ['ACM-100']);
  assert.deepEqual(L.searchRows(rows, 'ACM-399').map((r) => r.sku), ['ACM-300']); // the linked variant's own SKU
  assert.equal(L.searchRows(rows, 'zzzz').length, 0);
  assert.equal(L.searchRows(rows, '').length, rows.length);
  assert.equal(L.searchRows(rows, '', 2).length, 2);
});

// ------------------------------------------------------------------ M3 fixes: replacement approval, strict drift, unique names

const MANGO = () => variantOf(prodJson(1111, 'alpha-powder', 'Acme Alpha Powder', [vJson('777', 'ACM-199', 2200, 'Mango')]));

await test('Replacement: a different SKU starts with no approval, no price, no stale flavor title or image, and is pending until approved', () => {
  const { lib } = richLib();
  const m = L.buildSelectionMapping(lib, 'sku:ACM-100', { variant: MANGO(), now: NOW });
  assert.equal(L.replacementPending(m), true);
  assert.equal(m.variant.variantId, '777'); // the exact new id, as a string
  assert.equal(m.approved.regularCents, null); // the old SKU's approved price is not carried
  assert.equal(m.approved.promoCents, null); // nothing is invented for the sale price
  assert.equal(m.approved.promoSource, null);
  assert.equal(m.approved.title, 'Acme Alpha Powder - Mango'); // the new variant's default, not the old flavor's title
  assert.ok(m.approved.image && m.approved.image.includes('alpha-powder.jpg')); // the new variant's image (this synthetic variant shares the product's)
  assert.deepEqual([m.replacement.status, m.replacement.fromSku, m.replacement.toSku], ['pending', 'ACM-100', 'ACM-199']);
  assert.equal(L.mappingStatus(m).label, 'Replacement approval required');
  assert.equal(L.mappingStatus(m).full, false);
  assert.match(text(L.mappingReportLines(m)), /\*\*replacement not approved\*\*/);
  assert.equal(JSON.stringify(lib.work).includes('777'), false); // the list was never written
});

await test('Replacement: Approve Replacement is the explicit confirmation; it keeps the exact id, approves identity only, and never reuses the old price', () => {
  const { lib } = richLib();
  const pending = L.buildSelectionMapping(lib, 'sku:ACM-100', { variant: MANGO(), now: NOW });
  const ok = L.approveMappingReplacement(pending, { now: NOW + 1 });
  assert.equal(ok.state.identity, 'substitute-approved');
  assert.equal(ok.replacement.status, 'approved');
  assert.equal(ok.variant.variantId, '777');
  assert.equal(ok.approved.regularCents, null); // identity approved, price not
  const st = L.mappingStatus(ok);
  assert.equal(st.full, false);
  assert.match(st.label, /Replacement approved · regular price not approved/);
  assert.match(text(L.mappingReportLines(ok)), /replacement approved for this card \(list SKU ACM-100 → variant SKU ACM-199\)/);
  assert.match(text(L.mappingReportLines(ok)), /regular price not approved/);
  assert.throws(() => L.approveMappingReplacement(ok), /no replacement waiting/);
  assert.equal(L.buildSelectionMapping(lib, 'sku:ACM-100', { variant: MANGO(), approve: true, now: NOW }).replacement.status, 'approved'); // one step
  // an exact variant (the list's own) has nothing to approve, and keeps the list's approved price
  const exact = L.buildSelectionMapping(lib, 'sku:ACM-100', { approve: true, now: NOW });
  assert.equal(exact.replacement, undefined);
  assert.equal(exact.approved.regularCents, 2000);
  assert.equal(L.mappingStatus(exact).full, true);
  // an approved substitution in the list itself counts as the list's approval, with its approved price
  const sub = L.buildSelectionMapping(lib, 'sku:ACM-300', { now: NOW });
  assert.equal(sub.state.identity, 'substitute-approved');
  assert.equal(sub.approved.regularCents, 1597);
});

await test('Replacement: page-specific values are kept but each must be resolved before approval', () => {
  const { lib } = richLib();
  let cur = L.setMappingOverride(L.productMappingSnapshot(lib, 'sku:ACM-100', { now: NOW }), 'title', 'My Hero Title');
  cur = L.setMappingOverride(cur, 'promoCents', 999);
  const pending = L.buildSelectionMapping(lib, 'sku:ACM-100', { variant: MANGO(), current: cur, now: NOW });
  assert.deepEqual(L.overrideConflicts(pending).sort(), ['promoCents', 'title']);
  assert.equal(L.effectiveValues(pending).title, 'My Hero Title'); // still shown as the page-specific value...
  assert.equal(L.effectiveValues(pending).base.title, 'Acme Alpha Powder - Mango'); // ...and distinct from the new default
  assert.throws(() => L.approveMappingReplacement(pending), /page-specific/);
  assert.throws(() => L.approveMappingReplacement(pending, { resolutions: { title: 'keep' } }), /promoCents/);
  const done = L.approveMappingReplacement(pending, { resolutions: { title: 'default', promoCents: 'keep' } });
  assert.deepEqual(done.overrides, { promoCents: 999 });
  assert.deepEqual(done.replacement.resolved, { title: 'default', promoCents: 'keep' });
  assert.equal(L.effectiveValues(done).title, 'Acme Alpha Powder - Mango');
  // another product never inherits them
  assert.equal(L.buildSelectionMapping(lib, 'sku:ACM-200', { current: cur, now: NOW }).overrides, undefined);
});

await test('Drift: choosing another variant is not drift; only a change to the list’s own record is, and it can be adopted on purpose', () => {
  const { lib } = richLib();
  const m = L.buildSelectionMapping(lib, 'sku:ACM-100', { variant: MANGO(), approve: true, now: NOW });
  assert.deepEqual(L.mappingCheck(lib, m), { state: 'current', notes: [] });
  const same = L.buildSelectionMapping(lib, 'sku:ACM-100', { now: NOW });
  assert.deepEqual(L.mappingCheck(lib, same), { state: 'current', notes: [] });
  const list2 = L.decide(lib, 'sku:ACM-100', 'custom', 1850);
  const c = L.mappingCheck(list2, m);
  assert.equal(c.state, 'changed');
  assert.deepEqual(c.notes, ['Approved regular price: $20.00 → $18.50.', 'Approval: approved → approved.'].slice(0, 1).concat(c.notes.slice(1)));
  assert.ok(c.notes.length >= 1 && c.notes.every((n) => !/777/.test(n)));
  const adopted = L.adoptListValues(list2, m);
  assert.equal(adopted.variant.variantId, BIG_ID); // back to the list's own variant
  assert.equal(adopted.approved.regularCents, 1850);
  assert.equal(adopted.replacement, undefined);
  assert.deepEqual(L.mappingCheck(list2, adopted), { state: 'current', notes: [] });
  // a mapping saved before baselines existed and then changed on purpose has nothing to compare, so it never warns falsely
  const legacy = JSON.parse(JSON.stringify(m)); delete legacy.libraryRef.baseline;
  assert.deepEqual(L.mappingCheck(list2, legacy), { state: 'current', notes: [] });
  // an unchanged legacy mapping (no baseline, no variant change) still compares against what it saved
  const plain = JSON.parse(JSON.stringify(same)); delete plain.libraryRef.baseline;
  assert.equal(L.mappingCheck(list2, plain).state, 'changed');
});

await test('Replacing a mapping with a product from another saved list references that list’s id and keeps the first list untouched', () => {
  const a = richLib().lib;
  const b = { ...baseLib(ORIGIN, 'l-other'), name: 'Other list' };
  const before = JSON.stringify(a);
  const m1 = L.buildSelectionMapping(a, 'sku:ACM-100', { now: NOW });
  const m2 = L.buildSelectionMapping(b, 'sku:ACM-200', { current: m1, now: NOW });
  assert.deepEqual([m1.list.id, m2.list.id, m2.list.name], ['l-test-a', 'l-other', 'Other list']);
  assert.equal(m2.approved.regularCents, null); // list b approved nothing: nothing is transferred from list a
  assert.equal(JSON.stringify(a), before);
  // the same SKU in another list is still that list's own record: no overrides cross lists
  const o = L.setMappingOverride(m1, 'title', 'Mine');
  assert.equal(L.buildSelectionMapping(b, 'sku:ACM-100', { current: o, now: NOW }).overrides, undefined);
});

await test('Check Shopify: read-only comparison of the mapped variant with the store, with concise results', () => {
  const { lib, handKey } = richLib();
  const m = L.productMappingSnapshot(lib, 'sku:ACM-100', { now: NOW });
  const prod = (v) => L.normalizeProduct(prodJson(1111, 'alpha-powder', 'Acme Alpha Powder', [v]), ORIGIN, 'USD');
  const frozen = JSON.stringify(m);
  const ok = L.shopifyCheck(m, prod(vJson(BIG_ID, 'ACM-100', 2000, 'Blue Raz')));
  assert.equal(ok.state, 'ok'); assert.deepEqual(ok.notes, []); assert.equal(ok.found.variantId, BIG_ID);
  const price = L.shopifyCheck(m, prod(vJson(BIG_ID, 'ACM-100', 2400, 'Blue Raz')));
  assert.equal(price.state, 'changed');
  assert.ok(price.notes.some((n) => /Shopify price: \$20\.00 → \$24\.00/.test(n)) && price.notes.some((n) => /Approved regular price \$20\.00 differs/.test(n)));
  assert.match(L.shopifyCheck(m, prod(vJson('999', 'ACM-100', 2000, 'Blue Raz'))).notes[0], /Variant id 9007199254740993 is no longer on/);
  assert.equal(L.shopifyCheck(m, null).state, 'missing');
  assert.equal(L.shopifyCheck(L.productMappingSnapshot(lib, handKey, { now: NOW }), null).state, 'skipped'); // no variant mapped
  assert.equal(JSON.stringify(m), frozen); // nothing was approved or overwritten
});

await test('List names are unique: trimmed, case-insensitive, numbered from (2), at save and at rename; a list keeps its own name', async () => {
  assert.equal(L.uniqueListName('Black Friday 🖤 SMP - 2026', []), 'Black Friday 🖤 SMP - 2026');
  assert.equal(L.uniqueListName('  black friday 🖤 smp - 2026 ', ['Black Friday 🖤 SMP - 2026']), 'black friday 🖤 smp - 2026 (2)'.replace('black friday 🖤 smp - 2026 (2)', 'black friday 🖤 smp - 2026 (2)'));
  assert.equal(L.uniqueListName('X', ['x', 'X (2)']), 'X (3)');
  const st = memStorage();
  const mk = (n) => { const l = L.newLibrary('', n); return l; };
  const a = mk('Black Friday 🖤 SMP - 2026'); const b = mk(' black friday 🖤 smp - 2026'); const c = mk('Black Friday 🖤 SMP - 2026');
  for (const l of [a, b, c]) await L.saveLibrary(st, L.decide({ ...l, smp: { v: 1, imports: [L.importCsv(CSV, { fileName: 'x.csv', sha256: l.campaign })] } }, 'sku:ACM-100', 'smp'), { smpChanged: true });
  const idx = await L.loadIndex(st);
  assert.deepEqual(idx.libs.map((l) => l.name), ['Black Friday 🖤 SMP - 2026', 'black friday 🖤 smp - 2026 (2)', 'Black Friday 🖤 SMP - 2026 (3)']);
  assert.equal(new Set(idx.libs.map((l) => l.campaign)).size, 3); // ids are untouched
  // saving again changes nothing (no repeated suffixes)
  await L.saveLibrary(st, await L.loadLibrary(st, '', a.campaign));
  await L.saveLibrary(st, await L.loadLibrary(st, '', b.campaign));
  assert.deepEqual((await L.loadIndex(st)).libs.map((l) => l.name), idx.libs.map((l) => l.name));
  // renaming into a taken name is numbered; keeping its own name is not
  await L.renameLibrary(st, '', c.campaign, 'BLACK FRIDAY 🖤 SMP - 2026 (2)');
  assert.equal(await L.listLabel(st, '', c.campaign), 'BLACK FRIDAY 🖤 SMP - 2026 (2) (2)');
  await L.renameLibrary(st, '', c.campaign, 'BLACK FRIDAY 🖤 SMP - 2026 (2) (2)');
  assert.equal(await L.listLabel(st, '', c.campaign), 'BLACK FRIDAY 🖤 SMP - 2026 (2) (2)');
  await L.renameLibrary(st, '', b.campaign, 'Black Friday 🖤 SMP - 2026');
  assert.equal(await L.listLabel(st, '', b.campaign), 'Black Friday 🖤 SMP - 2026 (2)'); // b was the holder of (2); the first free number
});

await test('Existing duplicate names are reconciled once, oldest keeps its name, nothing else changes, and a second run changes nothing', async () => {
  const st = memStorage();
  const imp = (n) => ({ ...L.importCsv(CSV, { fileName: `${n}.csv`, sha256: `h${n}` }), importedAt: 1000 * n });
  const mkRaw = async (id, name, createdAt, n) => {
    const lib = { store: '', campaign: id, name, smp: { v: 1, imports: [imp(n)] } };
    st.d[L.kSmp('', id)] = lib.smp; st.d[L.kWork('', id)] = L.decide(baseLib('', id), 'sku:ACM-100', 'smp').work;
    const idx = (st.d[L.K_INDEX] ||= { v: 1, libs: [], active: {} });
    idx.libs.push({ store: '', campaign: id, name, createdAt, updatedAt: createdAt });
  };
  await mkRaw('l-new', 'Weekly', 300, 3); await mkRaw('l-old', 'Weekly', 100, 1); await mkRaw('l-mid', ' weekly ', 200, 2); await mkRaw('l-uniq', 'Other', 400, 4);
  st.d[L.K_INDEX].active = { 'https://x.example': { store: '', campaign: 'l-mid' } };
  const snapshot = JSON.stringify({ ...st.d, [L.K_INDEX]: undefined });
  const changes = await L.reconcileListNames(st);
  const names = Object.fromEntries((await L.loadIndex(st)).libs.map((l) => [l.campaign, l.name]));
  assert.deepEqual(names, { 'l-old': 'Weekly', 'l-mid': 'weekly (2)'.replace('weekly (2)', 'weekly (2)'), 'l-new': 'Weekly (3)', 'l-uniq': 'Other' });
  assert.equal(changes.length, 2); // only the two that collide are renamed
  assert.equal(JSON.stringify({ ...st.d, [L.K_INDEX]: undefined }), snapshot); // imports, corrections and settings untouched
  assert.deepEqual((await L.loadIndex(st)).active, { 'https://x.example': { store: '', campaign: 'l-mid' } }); // pointers by id survive
  assert.deepEqual(await L.reconcileListNames(st), []); // stable: nothing to do the second time
  assert.deepEqual(Object.fromEntries((await L.loadIndex(st)).libs.map((l) => [l.campaign, l.name])), names);
  // a mapping that points at a list id still resolves, whatever the label
  assert.equal((await L.loadLibrary(st, '', 'l-mid')).campaign, 'l-mid');
});

console.log(`\n${pass}/${pass + fail} mapping tests passed`);
process.exit(fail ? 1 : 0);
