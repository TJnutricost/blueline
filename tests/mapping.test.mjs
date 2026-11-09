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
  assert.ok(lines.length <= 10);
  assert.equal(lines[0], '- **Product mapping** from list “Acme test list” (https://shop.example.com)');
  assert.equal(lines[1], '  - Card: `[data-card="2"]`, in section “Featured Deals”, card 2 of 3, currently “[Product Name]”');
  assert.equal(lines[2], '  - Product: Acme Alpha Powder · list SKU `ACM-100`');
  assert.equal(lines[3], `  - Shopify: variant id \`${BIG_ID}\` (“Blue Raz”), variant SKU \`ACM-100\`, product id \`1111\`, handle \`alpha-powder\``);
  assert.equal(lines[4], '  - Prices: regular $20.00 (approved, SMP price), sale $12.00 (SMP promotional price)');
  assert.equal(lines[5], '  - Image: `https://cdn.example.com/alpha-powder.jpg`');
  assert.equal(lines[6], `  - Link: \`${ORIGIN}/products/alpha-powder?variant=${BIG_ID}\``);
  assert.match(lines[7], /^  - Displayed price: the sale price \*\*\$12\.00\*\* is the displayed \(current\) price; where the card also has a struck-through price it is the regular \$20\.00\. A card with one price shows the sale price, not the regular price\.$/);
  assert.equal(lines[8], '  - Replace this card’s title, image, prices and link with the values above, keeping its markup and styling.');
  assert.ok(!lines.some((l) => /cart|checkout/i.test(l))); // no cart wiring text per card while the option is off
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
  assert.doesNotMatch(t, /cart or checkout wiring/); // cart text lives in the page-level section now
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

// ------------------------------------------------------------------ M4: page elements (fields), discount, reading prices and badges

const C = createRequire(import.meta.url)(join(here, '..', 'cards.js'));
const mappingFor = (key = 'sku:ACM-100') => {
  let lib = baseLib();
  lib = L.chooseVariant(lib, key, variantOf(prodJson(BIG_ID, 'alpha', 'Acme Alpha Powder', [vJson(BIG_ID, 'ACM-100', '20.00', 'Vanilla')])));
  lib = L.decide(lib, key, 'smp');
  return L.productMappingSnapshot(lib, key, { now: NOW });
};
const REF = (path = 'h3:nth-child(1)', tag = 'h3') => ({ v: 1, path, tag, classes: [], fp: 'abc', sel: null, text: 'x' });

await test('M4 discount: whole-number percent from integer cents, half rounds up', () => {
  assert.equal(L.discountPercent(3999, 2799), 30); // $39.99 → $27.99
  assert.equal(L.discountPercent(5991, 3999), 33); // $59.91 → $39.99
  assert.equal(L.discountPercent(2000, 1000), 50);
  assert.equal(L.discountPercent(1000, 1000), 0);
  assert.equal(L.discountPercent(1000, 0), 100);
  assert.equal(L.discountPercent(10, 9), 10);
  assert.equal(L.discountPercent(1999, 1599), 20); // 20.01% (no float drift)
  assert.equal(L.discountPercent(3, 2), 33);
  assert.equal(L.discountPercent(200, 99), 51); // 50.5 rounds up
});
await test('M4 discount: nothing is calculated from missing, invalid or inverted prices (and never inferred from a badge)', () => {
  for (const [r, s] of [[null, 100], [100, null], [undefined, undefined], [0, 0], [-5, 3], [1000, -1], [1000, 1001], [10.5, 5], ['1000', '500'], [NaN, 5]]) assert.equal(L.discountPercent(r, s), null, `${r}/${s}`);
  const m = mappingFor();
  const di = L.discountInfo({ ...m, approved: { ...m.approved, regularCents: null, promoCents: null } }, { kind: 'percent', percent: 30 });
  assert.equal(di.percent, null);
  assert.match(di.why, /no approved regular price/);
  assert.equal(di.regularCents, null); // the badge's 30% did not become a regular price
});
await test('M4 discount: uses the approved prices and a page-specific override, and flags a badge that disagrees', () => {
  const m = mappingFor(); // $20.00 regular, $12.00 sale
  assert.equal(m.approved.regularCents, 2000);
  assert.equal(m.approved.promoCents, 1200);
  let di = L.discountInfo(m, { kind: 'percent', percent: 40 });
  assert.equal(di.percent, 40);
  assert.equal(di.discrepancy, null);
  di = L.discountInfo(m, { kind: 'percent', percent: 25 });
  assert.match(di.discrepancy, /badge says 25% off but the approved prices give 40%/);
  const ov = L.setMappingOverride(L.setMappingOverride(m, 'regularCents', '39.99'), 'promoCents', '27.99');
  assert.equal(L.discountInfo(ov).percent, 30); // the override drives the calculation
  assert.equal(L.discountInfo(ov, { kind: 'percent', percent: 30 }).discrepancy, null);
  assert.equal(L.discountInfo(m).percent, 40); // ...without having changed the original mapping
  assert.equal(m.approved.regularCents, 2000);
  assert.equal(L.discountInfo(m, { kind: 'percent', percent: null, placeholder: true }).discrepancy, null);
  assert.match(L.discountInfo(m, { kind: 'percent', percent: null, placeholder: true }).badgeNote, /placeholder/);
  assert.match(L.discountInfo(m, { kind: 'amount', cents: 500 }).discrepancy, /\$5\.00 off but the approved prices differ by \$8\.00/);
  assert.equal(L.discountInfo(m, { kind: 'amount', cents: 800 }).discrepancy, null);
});
await test('M4 reading text: prices in integer cents, placeholders and discount badges', () => {
  assert.deepEqual(C.pricesIn('Now $27.99').map((p) => p.cents), [2799]);
  assert.deepEqual(C.pricesIn('$1,299.5 and $12').map((p) => p.cents), [129950, 1200]);
  assert.deepEqual(C.pricesIn('19.97 USD').map((p) => p.cents), [1997]);
  assert.equal(C.pricesIn('[$Sale]')[0].placeholder, true);
  assert.equal(C.pricesIn('[$Sale]')[0].cents, null);
  assert.equal(C.pricesIn('Free shipping').length, 0);
  assert.equal(C.parseBadge('30% OFF').percent, 30);
  assert.equal(C.parseBadge('-30%').percent, 30);
  assert.equal(C.parseBadge('Save 30%').percent, 30);
  assert.equal(C.parseBadge('[XX% OFF]').placeholder, true);
  assert.equal(C.parseBadge('Save $12').cents, 1200);
  assert.equal(C.parseBadge('$12 off').kind, 'amount');
  for (const t of ['Sale', 'New', 'Free shipping', 'Best seller', '$27.99', '']) assert.equal(C.parseBadge(t), null, t);
});
await test('M4 fields: assigning an element changes no value, no variant and no list data', () => {
  const m = mappingFor();
  const before = JSON.stringify(m);
  const n = L.setFieldAssignment(m, 'title', { state: 'confirmed', source: 'suggested', how: 'semantic', ref: REF(), detected: { text: 'Acme' } }, { now: NOW });
  assert.equal(JSON.stringify(m), before); // pure: the input is untouched
  const strip = (x) => { const c = JSON.parse(JSON.stringify(x)); delete c.fields; return c; };
  assert.deepEqual(strip(n), strip(m)); // everything except `fields` is identical
  assert.equal(n.variant.variantId, BIG_ID);
  assert.equal(typeof n.variant.variantId, 'string');
  assert.equal(n.fields.v, 1);
  assert.equal(n.fields.items.title.state, 'confirmed');
  assert.equal(n.fields.items.title.ref.tag, 'h3');
  assert.equal(L.effectiveValues(n).title, L.effectiveValues(m).title); // the title VALUE is still the approved one
});
await test('M4 fields: unmapped, replace, forget, order, and bad input', () => {
  const m = mappingFor();
  let n = L.setFieldAssignment(m, 'link', { state: 'unmapped' }, { now: NOW });
  n = L.setFieldAssignment(n, 'title', { state: 'confirmed', ref: REF() }, { now: NOW });
  n = L.setFieldAssignment(n, 'cta', { state: 'confirmed', ref: REF('button:nth-child(2)', 'button') }, { now: NOW });
  assert.deepEqual(Object.keys(n.fields.items), ['title', 'cta', 'link']); // fixed order, whatever the insertion order
  assert.equal(n.fields.items.link.state, 'unmapped');
  const same = L.setFieldAssignment(n, 'title', { state: 'confirmed', ref: REF() }, { now: NOW + 5000 });
  assert.deepEqual(same, n); // the same element again changes nothing (so "Save" doesn't light up)
  const other = L.setFieldAssignment(n, 'title', { state: 'confirmed', ref: REF('h2:nth-child(1)', 'h2') }, { now: NOW + 5000 });
  assert.equal(other.fields.items.title.ref.tag, 'h2');
  const gone = L.setFieldAssignment(L.setFieldAssignment(L.setFieldAssignment(n, 'title', null), 'cta', null), 'link', null);
  assert.equal('fields' in gone, false); // forgetting the last one leaves the mapping exactly as before
  assert.deepEqual(gone, m);
  assert.throws(() => L.setFieldAssignment(m, 'price', { state: 'unmapped' }), /can’t be mapped/);
  assert.throws(() => L.setFieldAssignment(m, 'title', { state: 'confirmed' }), /needs the element/);
  assert.throws(() => L.setFieldAssignment(m, 'title', { state: 'maybe', ref: REF() }), /Unknown field state/);
  assert.throws(() => L.setFieldAssignment(null, 'title', null), /no mapping/);
});
await test('M4 fields: mappings saved before M4 (and damaged ones) still work', () => {
  const m = mappingFor();
  assert.equal('fields' in m, false);
  assert.deepEqual(L.fieldItems(m), {});
  assert.deepEqual(L.fieldItems({ ...m, fields: 'junk' }), {});
  assert.deepEqual(L.fieldItems({ ...m, fields: { v: 1, items: { title: 7, cta: { state: 'wat' }, link: { state: 'unmapped' }, bogus: { state: 'confirmed' } } } }), { link: { state: 'unmapped' } });
  assert.deepEqual(L.mappingReportLines(m), L.mappingReportLines({ ...m, fields: { v: 1, items: {} } })); // the report is unchanged
  assert.equal(L.mappingReportLines(m).some((l) => /Page elements/.test(l)), false);
  assert.equal(L.mappingStatus(m).approval.label, L.mappingStatus({ ...m, fields: { v: 1, items: { link: { state: 'unmapped' } } } }).approval.label); // status doesn't depend on fields
});
await test('M4 fields: they follow the card through a product change and an adopt, never the product', () => {
  const lib = baseLib();
  let n = L.setFieldAssignment(mappingFor(), 'title', { state: 'confirmed', ref: REF() }, { now: NOW });
  let l2 = L.chooseVariant(lib, 'sku:ACM-200', variantOf(prodJson('222', 'beta', 'Acme Beta Capsules', [vJson('222', 'ACM-200', '30.00', 'Plain')])));
  l2 = L.decide(l2, 'sku:ACM-200', 'smp');
  const next = L.buildSelectionMapping(l2, 'sku:ACM-200', { current: n, now: NOW });
  assert.equal(next.product.key, 'sku:ACM-200');
  assert.deepEqual(next.fields, n.fields);
  assert.equal(next.variant.variantId, '222');
  const adopted = L.adoptListValues(L.decide(L.chooseVariant(baseLib(), 'sku:ACM-100', variantOf(prodJson(BIG_ID, 'alpha', 'Acme Alpha Powder', [vJson(BIG_ID, 'ACM-100', '20.00', 'Vanilla')]))), 'sku:ACM-100', 'smp'), n);
  assert.deepEqual(adopted.fields, n.fields);
});
await test('M4 report: mapped elements, selectors, discount and mismatch; never claims the cart is wired', () => {
  let m = mappingFor();
  for (const [k, tag, path] of [['title', 'h3', 'h3:nth-child(2)'], ['sale', 'ins', 'ins:nth-child(1)'], ['regular', 'del', 'del:nth-child(1)'], ['badge', 'span', 'span:nth-child(3)'], ['cta', 'button', 'button:nth-child(5)']]) {
    m = L.setFieldAssignment(m, k, { state: 'confirmed', ref: { ...REF(path, tag), sel: k === 'cta' ? 'button.add' : null }, detected: { text: k === 'badge' ? '25% OFF' : 'seen', badge: k === 'badge' ? { kind: 'percent', percent: 25 } : undefined } }, { now: NOW });
  }
  m = L.setFieldAssignment(m, 'link', { state: 'unmapped' });
  const lines = L.mappingReportLines(m);
  const text = lines.join('\n');
  assert.match(text, /Page elements in this card \(assigned by you in Product Mapping/);
  assert.match(text, /Add to Cart button: `button\.add` within the card/);
  assert.match(text, /Title: `h3:nth-child\(2\)` within the card/);
  assert.match(text, /Not on this card: Product link/);
  assert.match(text, /Discount: 40% off, from approved regular \$20\.00 and sale \$12\.00\. \*\*Mismatch:\*\* the badge says 25% off but the approved prices give 40%/);
  assert.match(text, new RegExp(`variant id \`${BIG_ID}\``)); // the exact variant id is still reported as a string
  assert.equal(/wired|add to cart/i.test(text.replace(/Add to Cart button/g, '')), false, 'no cart claims while the option is off');
  const stale = L.fieldReportLines(m, { check: { items: { title: { state: 'moved', reasons: ['the element is no longer where it was'], value: null }, cta: { state: 'ok', reasons: [], value: { text: 'Add to cart' } } } } }).join('\n');
  assert.match(stale, /Title: .* \(needs review: it moved\)/);
  assert.match(stale, /\*\*Review before using:\*\* Title \(the element is no longer where it was\)/);
  assert.match(stale, /Add to Cart button: .* \(confirmed\); page shows “Add to cart”/);
  const noPrices = L.fieldReportLines({ ...m, approved: { ...m.approved, promoCents: null } }).join('\n');
  assert.match(noPrices, /Discount: not calculated \(no approved sale price\)/);
});
await test('M4 persistence: the whole mapping with fields survives JSON storage and still checks equal', () => {
  const m = L.setFieldAssignment(mappingFor(), 'title', { state: 'confirmed', source: 'chosen', how: 'content', ref: REF(), detected: { text: 'Name' } }, { now: NOW });
  const back = JSON.parse(JSON.stringify(m));
  assert.deepEqual(back, m);
  assert.equal(back.variant.variantId, BIG_ID);
  assert.equal(back.fields.items.title.source, 'chosen');
  assert.equal(L.isMapping(back), true);
});

// ------------------------------------------------------------------ page workspace: card records, Start Fresh, recovery copy
const CARD = (n) => ({ v: 1, selector: `#row > article:nth-child(${n})`, tag: 'article', section: { heading: 'Featured Deals' }, index: n, count: 3, text: `Card ${n}` });
const mappedMemo = new Map(); // one fixed mapping per card (mappingFor stamps times, so build each once)
const mappedWith = (n) => { if (!mappedMemo.has(n)) mappedMemo.set(n, { ...mappingFor(), card: CARD(n) }); return JSON.parse(JSON.stringify(mappedMemo.get(n))); };
const wsNote = (id, extra = {}) => ({ id, note: `note ${id}`, type: 'polish', createdAt: NOW, url: `${ORIGIN}/p`, path: '/p', el: { label: 'h1', selector: 'h1' }, elementEdits: [{ tweaks: [{ prop: 'color', to: 'red' }] }], hasShot: true, ...extra });
const wsRec = (id, n, withMapping) => ({ id, cardRecord: true, note: '', type: 'change', createdAt: NOW, url: `${ORIGIN}/p`, path: '/p', el: { label: 'article', selector: 'article' }, ...(withMapping ? { productMapping: mappedWith(n) } : { productCard: CARD(n) }) });
const pageItems = () => [
  wsNote('n-plain'),
  wsNote('n-card', { productCard: CARD(1) }),
  wsNote('n-mapped', { productMapping: mappedWith(2) }),
  wsRec('r-empty', 3, false),
  wsRec('r-assigned', 4, true),
];

await test('Workspace: a note that carries a card or assignment hands it to a card record; a plain note leaves nothing', () => {
  assert.equal(L.toCardRecord(wsNote('n-plain')), null);
  const r = L.toCardRecord(wsNote('n-mapped', { productMapping: mappedWith(2) }));
  assert.equal(r.cardRecord, true);
  assert.equal(r.id, 'n-mapped'); // same id: nothing is re-linked
  assert.equal(r.note, '');
  assert.equal(r.elementEdits, undefined);
  assert.equal(r.hasShot, undefined);
  assert.deepEqual(r.productMapping, mappedWith(2));
  assert.equal(r.productMapping.variant.variantId, BIG_ID);
  const c = L.toCardRecord(wsNote('n-card', { productCard: CARD(1) }));
  assert.deepEqual(c.productCard, CARD(1));
  assert.equal(c.productMapping, undefined);
});
await test('Workspace: a new card definition is its own item (no note, no product, no description)', () => {
  const r = L.newCardRecord({ url: `${ORIGIN}/p`, path: '/p', el: { label: 'article', selector: 'article' }, note: 'ignored', id: 'x', productMapping: { bad: 1 } }, CARD(5), 'card-1', NOW);
  assert.equal(r.cardRecord, true);
  assert.equal(r.id, 'card-1');
  assert.equal(r.note, '');
  assert.deepEqual(r.productCard, CARD(5));
  assert.equal(r.productMapping, undefined);
  assert.equal(L.hasCardData(r), true);
  assert.equal(L.hasAssignment(r), false);
  assert.deepEqual(L.pageCounts([r]), { notes: 0, cards: 1, assignments: 0 });
});
await test('Workspace: counts separate notes, defined cards and assignments', () => {
  assert.deepEqual(L.pageCounts(pageItems()), { notes: 3, cards: 4, assignments: 2 });
});
await test('Workspace: clearing notes only keeps every card and assignment (a note holding one becomes a card record)', () => {
  const items = deepFreeze(JSON.parse(JSON.stringify(pageItems())));
  const p = L.planReset(items, { notes: true });
  assert.deepEqual(p.cleared, { notes: 3, cards: 0, assignments: 0 });
  assert.deepEqual(p.notesGone, ['n-plain', 'n-card', 'n-mapped']);
  assert.deepEqual(p.items.map((i) => i.id), ['n-card', 'n-mapped', 'r-empty', 'r-assigned']);
  assert.equal(p.items.every((i) => i.cardRecord === true), true);
  assert.deepEqual(L.pageCounts(p.items), { notes: 0, cards: 4, assignments: 2 });
  assert.deepEqual(p.items.find((i) => i.id === 'n-mapped').productMapping, mappedWith(2));
  assert.equal(p.items.find((i) => i.id === 'n-mapped').productMapping.variant.variantId, BIG_ID);
});
await test('Workspace: clearing assignments only keeps notes and the defined cards', () => {
  const items = deepFreeze(JSON.parse(JSON.stringify(pageItems())));
  const p = L.planReset(items, { assignments: true });
  assert.deepEqual(p.cleared, { notes: 0, cards: 0, assignments: 2 });
  assert.deepEqual(p.items.map((i) => i.id), ['n-plain', 'n-card', 'n-mapped', 'r-empty', 'r-assigned']);
  assert.deepEqual(L.pageCounts(p.items), { notes: 3, cards: 4, assignments: 0 });
  const nm = p.items.find((i) => i.id === 'n-mapped');
  assert.equal(nm.productMapping, undefined);
  assert.deepEqual(nm.productCard, CARD(2)); // the card definition survives on the note
  assert.equal(nm.note, 'note n-mapped'); // the note itself is untouched
  assert.deepEqual(p.items.find((i) => i.id === 'r-assigned').productCard, CARD(4));
});
await test('Workspace: clearing defined cards also clears their assignments, and keeps the notes', () => {
  const items = deepFreeze(JSON.parse(JSON.stringify(pageItems())));
  const p = L.planReset(items, { cards: true });
  assert.deepEqual(p.cleared, { notes: 0, cards: 4, assignments: 2 });
  assert.deepEqual(p.scope, { notes: false, cards: true, assignments: true });
  assert.deepEqual(p.items.map((i) => i.id), ['n-plain', 'n-card', 'n-mapped']); // records are gone, notes stay
  assert.deepEqual(L.pageCounts(p.items), { notes: 3, cards: 0, assignments: 0 });
  assert.equal(p.items.find((i) => i.id === 'n-mapped').note, 'note n-mapped');
});
await test('Workspace: clearing everything leaves nothing; clearing nothing changes nothing', () => {
  const all = L.planReset(pageItems(), { notes: true, cards: true });
  assert.deepEqual(all.items, []);
  assert.deepEqual(all.cleared, { notes: 3, cards: 4, assignments: 2 });
  const none = L.planReset(pageItems(), {});
  assert.deepEqual(none.cleared, { notes: 0, cards: 0, assignments: 0 });
  assert.deepEqual(none.items, pageItems());
});
await test('Workspace: planning a reset never changes the Product Library or the items it was given', () => {
  const lib = deepFreeze(baseLib());
  const before = JSON.stringify(lib);
  const items = deepFreeze(JSON.parse(JSON.stringify(pageItems())));
  L.planReset(items, { notes: true, cards: true, assignments: true });
  L.makeSnapshot({ pageKey: `${ORIGIN}/p`, page: {}, before: items, after: [], scope: {}, now: NOW });
  assert.equal(JSON.stringify(lib), before);
  assert.deepEqual(items, JSON.parse(JSON.stringify(pageItems())));
});
await test('Workspace: the recovery copy holds the page exactly as it was (variant ids stay strings) and survives JSON storage', () => {
  const items = pageItems();
  const p = L.planReset(items, { notes: true });
  const snap = L.makeSnapshot({ pageKey: `${ORIGIN}/p`, page: { origin: ORIGIN, path: '/p' }, before: items, after: p.items, scope: p.scope, cleared: p.cleared, shots: { 'blueline:shot:n-plain': 'data:image/png;base64,AAA' }, now: NOW });
  const back = JSON.parse(JSON.stringify(snap));
  assert.deepEqual(back.before, items);
  assert.equal(back.before[2].productMapping.variant.variantId, BIG_ID);
  assert.equal(typeof back.before[2].productMapping.variant.variantId, 'string');
  assert.equal(back.pageKey, `${ORIGIN}/p`);
  assert.deepEqual(Object.keys(back.afterSig).sort(), p.items.map((i) => i.id).sort());
  assert.equal(back.shots['blueline:shot:n-plain'], 'data:image/png;base64,AAA');
});
await test('Workspace: restoring with nothing changed since puts back exactly what was saved, with no confirmation needed', () => {
  const items = pageItems();
  const p = L.planReset(items, { notes: true, cards: true });
  const snap = JSON.parse(JSON.stringify(L.makeSnapshot({ pageKey: 'k', page: {}, before: items, after: p.items, scope: p.scope, cleared: p.cleared, now: NOW })));
  const r = L.restorePlan(snap, p.items);
  assert.equal(r.conflict, null);
  assert.deepEqual(r.items, items);
});
await test('Workspace: restoring asks first when anything changed since the reset, and keeps notes made since', () => {
  const items = pageItems();
  const p = L.planReset(items, { cards: true });
  const snap = JSON.parse(JSON.stringify(L.makeSnapshot({ pageKey: 'k', page: {}, before: items, after: p.items, scope: p.scope, cleared: p.cleared, now: NOW })));
  // since the reset: a new note, a new card record, and an edited old note
  const now = [...p.items.map((i) => (i.id === 'n-plain' ? { ...i, note: 'edited after reset' } : i)), wsNote('n-new'), wsRec('r-new', 9, true)];
  const r = L.restorePlan(snap, now);
  assert.deepEqual(r.conflict.changed, ['n-plain']);
  assert.deepEqual(r.conflict.added.sort(), ['n-new', 'r-new']);
  assert.deepEqual(r.conflict.removed, []);
  const ids = r.items.map((i) => i.id);
  assert.equal(ids.includes('n-new'), true, 'a note made since the reset is kept');
  assert.equal(ids.includes('r-new'), false, 'a card made since the reset is replaced');
  assert.deepEqual(r.dropped, { cards: 1, assignments: 1 });
  assert.equal(r.items.find((i) => i.id === 'n-plain').note, 'note n-plain', 'the saved version comes back');
  assert.equal(r.items.find((i) => i.id === 'r-assigned').productMapping.variant.variantId, BIG_ID);
});
await test('Workspace: an item removed since the reset also counts as a change', () => {
  const items = pageItems();
  const p = L.planReset(items, { assignments: true });
  const snap = JSON.parse(JSON.stringify(L.makeSnapshot({ pageKey: 'k', page: {}, before: items, after: p.items, scope: p.scope, cleared: p.cleared, now: NOW })));
  const r = L.restorePlan(snap, p.items.filter((i) => i.id !== 'n-plain'));
  assert.deepEqual(r.conflict.removed, ['n-plain']);
  assert.equal(r.items.some((i) => i.id === 'n-plain'), true);
});

// ------------------------------------------------------------------ Change Report: field targets, source vs target, cart option
const LOC = (o = {}) => ({ sel: null, path: null, tag: 'span', classes: [], snippet: '<span class="x">[$Price]</span>', parent: 'div.row', wrapper: false, self: false, fragile: false, fragileWhy: null, ...o });
const TARGETS = (over = {}) => ({
  fields: {
    title: { basis: 'confirmed', loc: LOC({ sel: 'h3.name' }), value: { text: '[Product Name]' } },
    image: { basis: 'detected', confidence: 'high', loc: LOC({ sel: 'img.photo' }), value: { src: 'https://old.example/x.jpg' } },
    sale: { basis: 'detected', confidence: 'medium', loc: LOC({ sel: 'span.price' }), value: { text: '[$Price]' } },
    regular: { basis: 'missing' },
    badge: { basis: 'detected', confidence: 'high', loc: LOC({ sel: 'span.badge' }), value: { text: '[XX% OFF]', badge: { placeholder: true } } },
    cta: { basis: 'detected', confidence: 'high', loc: LOC({ sel: 'a.btn' }), value: { text: 'Shop now' } },
    link: { basis: 'unmapped' },
  },
  labels: [],
  ...over,
});
const rep = (m, o = {}) => text(L.mappingReportLines(m, o));

await test('Change Report fields: confirmed vs detected are labelled, a detected field is never called confirmed', () => {
  const t = rep(mappingFor(), { fieldTargets: TARGETS() });
  assert.match(t, /Title \[confirmed by you\]: `h3\.name` within the card; shows “\[Product Name\]” → set to “Acme Alpha Powder”/);
  assert.match(t, /Image \[detected by Blueline, not confirmed, high confidence\]: `img\.photo` within the card/);
  assert.match(t, /Sale price \[detected by Blueline, not confirmed, medium confidence\]/);
  assert.doesNotMatch(t, /Image \[confirmed/);
  assert.doesNotMatch(t, /Sale price \[confirmed/);
  assert.match(t, /Product link: not on this card \(you marked it so\)/);
  assert.match(t, /Fields in this card \(where each value goes\)\. \*\*confirmed\*\* = you assigned it in Product Mapping; \*\*detected\*\* = found by Blueline, never confirmed/);
});

await test('Change Report fields: single price card shows the sale price; the regular price is flagged absent, not invented', () => {
  const t = rep(mappingFor(), { fieldTargets: TARGETS() });
  assert.match(t, /Displayed price: show \*\*\$12\.00\*\* \(the sale price\) as the only price\. The regular price \$20\.00 is not shown on this card/);
  assert.match(t, /Sale price \[detected[^\]]*\]: `span\.price` within the card; shows “\[\$Price\]” → show \$12\.00 \(the only price on this card\)/);
  assert.doesNotMatch(t, /Regular price \[\*\*not identified/); // expected to be absent on a single-price card
});

await test('Change Report fields: dual-price card names the current and the struck-through price', () => {
  const tg = TARGETS(); tg.fields.regular = { basis: 'confirmed', loc: LOC({ sel: 'del.was' }), value: { text: '$99' } };
  const t = rep(mappingFor(), { fieldTargets: tg });
  assert.match(t, /Displayed price: current price \*\*\$12\.00\*\* \(sale\), struck-through regular price \*\*\$20\.00\*\*/);
  assert.match(t, /Regular price \[confirmed by you\]: `del\.was` within the card; shows “\$99” → show \$20\.00 \(struck-through regular price\)/);
});

await test('Change Report fields: no sale price shows the approved regular price; overrides are respected; nothing changes the product price', () => {
  let m = mappingFor();
  m = { ...m, approved: { ...m.approved, promoCents: null } };
  assert.match(rep(m, { fieldTargets: TARGETS() }), /Displayed price: show \*\*\$20\.00\*\* \(approved regular price; there is no sale price\)/);
  const o = L.setMappingOverride(mappingFor(), 'promoCents', 999, { now: NOW });
  const t = rep(o, { fieldTargets: TARGETS() });
  assert.match(t, /show \*\*\$9\.99\*\*/);
  assert.match(t, /Page-specific prices are display values; they don’t change what Shopify charges at checkout/);
});

await test('Change Report fields: missing and ambiguous fields are named for review with no invented selector', () => {
  const tg = TARGETS();
  tg.fields.cta = { basis: 'missing' };
  tg.fields.image = { basis: 'ambiguous', candidates: [{ loc: LOC({ sel: 'img.a', snippet: '<img class="a">' }), value: {} }, { loc: LOC({ sel: 'img.b', snippet: '<img class="b">' }), value: {} }] };
  tg.fields.title = { basis: 'review', state: 'moved', reasons: ['the element is no longer where it was'], candidates: [{ loc: LOC({ sel: 'h4.t', snippet: '<h4 class="t">x</h4>' }), value: {} }] };
  const t = rep(mappingFor(), { fieldTargets: tg });
  assert.match(t, /Add to Cart button: none on this card \(normal for some designs\)\. Nothing to change\./);
  assert.doesNotMatch(t, /\*\*Review before editing:\*\*[^\n]*Add to Cart/); // a missing control is not an error
  assert.match(t, /Image \[\*\*ambiguous\*\*\]: `img\.a` within the card .* or `img\.b` within the card/);
  assert.match(t, /Title \[confirmed earlier, \*\*needs review\*\*\]: the element is no longer where it was; closest match `h4\.t`/);
  assert.match(t, /\*\*Review before editing:\*\* Title; Image/);
});

await test('Change Report fields: fragile or generic selectors carry DOM context', () => {
  const tg = TARGETS();
  tg.fields.sale = { basis: 'detected', confidence: 'high', loc: LOC({ sel: null, path: 'div:nth-child(2) > span:nth-child(1)', fragile: true, fragileWhy: 'no short unique selector: the structural path depends on the card’s exact markup order', snippet: '<span>[$Price]</span>', parent: 'div.row' }), value: { text: '[$Price]' } };
  const t = rep(mappingFor(), { fieldTargets: tg });
  assert.match(t, /Sale price \[detected[^\]]*\]: `:scope > div:nth-child\(2\) > span:nth-child\(1\)` within the card/);
  assert.match(t, /\*\*Fragile\*\* \(no short unique selector.*Find it by its markup `<span>\[\$Price\]<\/span>` inside `div\.row`/);
  const generic = TARGETS(); generic.fields.cta = { basis: 'detected', confidence: 'high', loc: LOC({ sel: 'a', fragile: true, fragileWhy: 'the selector is only tag names, so it is generic', snippet: '<a href="#">Shop</a>' }), value: {} };
  assert.match(rep(mappingFor(), { fieldTargets: generic }), /\*\*Fragile\*\* \(the selector is only tag names/);
});

await test('Change Report fields: badge is calculated only when reliable; otherwise review', () => {
  assert.match(rep(mappingFor(), { fieldTargets: TARGETS() }), /Discount badge \[detected[^\]]*\]: `span\.badge` within the card; shows “\[XX% OFF\]” → set to `40% OFF`, calculated from regular \$20\.00 and sale \$12\.00/);
  const m = mappingFor();
  const none = rep({ ...m, approved: { ...m.approved, promoCents: null } }, { fieldTargets: TARGETS() });
  assert.match(none, /Discount badge[^\n]*→ \*\*review:\*\* the discount can’t be calculated reliably \(no approved sale price\); don’t invent a percentage/);
});

await test('Change Report fields: category labels are flagged when they do not fit the assigned product', () => {
  const tg = TARGETS({ labels: [{ text: 'PROTEIN', loc: LOC({ sel: 'span.cat', snippet: '<span class="cat">PROTEIN</span>' }) }, { text: 'POWDER', loc: LOC({ sel: 'span.kind', snippet: '<span class="kind">POWDER</span>' }) }] });
  const t = rep(mappingFor(), { fieldTargets: tg });
  assert.match(t, /Existing label “PROTEIN” \(`span\.cat` within the card\): \*\*review:\*\* it may belong to the previous product and not fit “Acme Alpha Powder”\. Change it only if the correct category is known; don’t invent one/);
  assert.match(t, /Existing label “POWDER” .*appears to fit the assigned product/);
  assert.match(t, /\*\*Review before editing:\*\* label “PROTEIN”/);
  assert.equal(L.labelFits('PRE-WORKOUT', mappingFor()), false);
});

await test('Change Report: previously saved mappings (no live targets) keep the saved-only field lines and still export', () => {
  let m = L.setFieldAssignment(mappingFor(), 'title', { state: 'confirmed', ref: REF('h3:nth-child(1)', 'h3') }, { now: NOW });
  const t = rep(m);
  assert.match(t, /Title: `h3:nth-child\(1\)` within the card \(as saved; not re-checked on the page yet\)/);
  assert.match(t, /detected-only fields are not listed/);
  assert.match(t, /Displayed price: /);
  const old = JSON.parse(JSON.stringify(mappingFor())); delete old.fields;
  assert.equal(L.isMapping(old), true);
  assert.ok(rep(old).includes('Product: Acme Alpha Powder'));
});

await test('Change Report: source page vs implementation target; the inspected file path is never the edit target', () => {
  const file = 'file:///Users/dev/blueline/qa/black-friday-2026/cyber-monday-draft.html';
  const t = text(L.sourceTargetLines([{ url: file, path: '/Users/dev/blueline/qa/black-friday-2026/cyber-monday-draft.html' }, { url: file, path: '/Users/dev/blueline/qa/black-friday-2026/cyber-monday-draft.html' }]));
  assert.match(t, /## Source page and implementation target/);
  assert.equal((t.match(/Inspected source page/g) || []).length, 1);
  assert.match(t, /Inspected source page \(reference only\):\*\* `\/Users\/dev\/blueline\/qa\/black-friday-2026\/cyber-monday-draft\.html` \(a local file opened in Chrome\)/);
  assert.match(t, /Implementation target:\*\* the matching HTML, templates or components in the project you have open\. It is not necessarily the inspected page/);
  assert.match(t, /Inspect the current workspace, find the files that render this page, and match the inspected structure/);
  assert.match(t, /If more than one file could be the target and you can’t tell which, ask before editing\. Never edit the inspected file or URL itself, QA fixtures, or original source documents/);
  assert.equal(L.pageLabel(file, '/Users/dev/x/cyber-monday-draft.html'), 'cyber-monday-draft.html'); // headings never repeat the full path
  assert.equal(L.pageLabel('https://shop.example.com/pages/sale', '/pages/sale'), '/pages/sale');
  assert.match(text(L.sourceTargetLines([{ url: 'https://shop.example.com/pages/sale', path: '/pages/sale' }])), /`https:\/\/shop\.example\.com\/pages\/sale`/);
});

await test('Change Report: Add to Cart OFF forbids unsolicited cart work; ON asks for platform-aware implementation', () => {
  const off = text(L.cartLines({ on: false }));
  assert.match(off, /## Add to Cart\n- Not requested\. Don’t add or change cart, checkout or purchase behavior/);
  assert.doesNotMatch(off, /Ajax|implement working/i);
  const on = text(L.cartLines({ on: true, hasVariants: true }));
  assert.match(on, /## Add to Cart implementation \(requested\)/);
  for (const re of [/Inspect the target project, identify its ecommerce platform and existing cart architecture/, /Don’t assume Shopify/, /preserve existing cart drawers, counters and interactions/, /loading, error and unavailable or sold-out/, /variant ids are strings; keep them exact\)\. Never invent or guess a missing id/, /Never silently change checkout or product prices/, /display values from the list; they don’t establish what Shopify or any checkout charges/, /report the blockers/, /Ajax Cart API \(`POST \/cart\/add\.js`/, /standalone or third-party page can’t call a store’s same-origin Ajax Cart API/, /doesn’t mean the destination uses Shopify checkout/, /Other targets:\*\* inspect their actual cart implementation; don’t fabricate a generic cart API/]) assert.match(on, re);
  assert.match(text(L.cartLines({ on: true, hasVariants: false })), /No mapped product in this report has a recorded variant id/);
});

await test('Change Report: Add to Cart ON adds a per-card instruction with the exact variant id string; OFF adds none', () => {
  const m = mappingFor();
  const on = rep(m, { fieldTargets: TARGETS(), cart: true });
  assert.match(on, new RegExp(`Add to Cart button \\[detected[^\\]]*\\]: \`a\\.btn\` within the card; shows “Shop now” → this is the card’s intended Add to Cart control: wire it to variant id \`${BIG_ID}\``));
  assert.match(on, new RegExp(`Add to Cart: implement it for this card with variant id \`${BIG_ID}\``));
  const off = rep(m, { fieldTargets: TARGETS(), cart: false });
  assert.match(off, /Add to Cart button \[detected[^\]]*\]: `a\.btn` within the card; shows “Shop now” → leave its existing behavior unchanged/);
  assert.doesNotMatch(off, /Add to Cart: implement/);
  const rich = richLib();
  const noVariant = L.productMappingSnapshot(rich.lib, rich.handKey, { now: NOW });
  assert.match(rep(noVariant, { cart: true }), /Add to Cart: no variant is recorded for this card\. Don’t invent an id; report it as a blocker/);
});

await test('Change Report: SHOP DEAL is the intended Add to Cart control; the product URL is separate and the control is never turned into a link', () => {
  const tg = TARGETS(); tg.fields.cta = { basis: 'detected', confidence: 'high', loc: LOC({ sel: 'a.btn', snippet: '<a class="btn" href="#">SHOP DEAL</a>' }), value: { text: 'SHOP DEAL', href: '' } };
  tg.fields.link = { basis: 'missing', sharedWithCta: true };
  const on = rep(mappingFor(), { fieldTargets: tg, cart: true });
  assert.match(on, /Add to Cart button \[detected[^\]]*\]: `a\.btn` within the card; shows “SHOP DEAL” → this is the card’s intended Add to Cart control: wire it to variant id/);
  assert.match(on, /Product link: no separate link element; the only link is the call-to-action, which is not changed here\. The product URL stays as mapping data/);
  assert.doesNotMatch(on, /Product link[^\n]*set the address to/);
  assert.doesNotMatch(on, /Review before editing:[^\n]*Product link/);
  const off = rep(mappingFor(), { fieldTargets: tg, cart: false });
  assert.match(off, /SHOP DEAL” → leave its existing behavior unchanged/);
  assert.doesNotMatch(off, /Add to Cart: implement|wire it to/);
  const shared = TARGETS(); shared.fields.cta = tg.fields.cta; shared.fields.link = { basis: 'confirmed', loc: LOC({ sel: 'a.btn', sharesCta: true, snippet: '<a class="btn">SHOP DEAL</a>' }), value: { href: 'https://x/y' } };
  assert.match(rep(mappingFor(), { fieldTargets: shared, cart: true }), /this is also the Add to Cart control: don’t turn the cart control into a product link/);
  assert.match(text(L.cartLines({ on: true })), /“SHOP DEAL” button\) is the control to wire, even if it is currently a plain link; don’t also turn it into a product-page link/);
});

await test('Change Report: a card with no Add to Cart control is reported accurately, not as an error, and no button is invented', () => {
  const tg = TARGETS(); tg.fields.cta = { basis: 'missing' };
  const off = rep(mappingFor(), { fieldTargets: tg });
  assert.match(off, /Add to Cart button: none on this card \(normal for some designs\)\. Nothing to change\./);
  assert.doesNotMatch(off, /Review before editing:[^\n]*Add to Cart/);
  const on = rep(mappingFor(), { fieldTargets: tg, cart: true });
  assert.match(on, new RegExp(`Add to Cart button: none found on this card\\. Add to Cart was requested, so this product still needs a cart control using variant id \`${BIG_ID}\`; where it goes and how it looks is for the developer and designer to decide\\. Don’t invent one here`));
  assert.doesNotMatch(on, /Review before editing:[^\n]*Add to Cart/);
});

await test('Change Report: an image placeholder that is not an <img> is described safely; a real <img> gets src', () => {
  assert.match(rep(mappingFor(), { fieldTargets: TARGETS() }), /Image \[detected[^\]]*\]: `img\.photo`[^\n]*→ put the product image `[^`]+` in it; it is a placeholder or container \(<span>\), not an <img>/);
  const tg = TARGETS(); tg.fields.image.loc = LOC({ sel: 'img.photo', tag: 'img' });
  assert.match(rep(mappingFor(), { fieldTargets: tg }), /→ set src to `https:\/\/cdn\.example\.com\/alpha\.jpg` \(alt: the product title\)/);
});

await test('Change Report: source and target are never mixed into per-card headings (no absolute path in the card block)', () => {
  const t = rep(mappingFor(), { fieldTargets: TARGETS(), cart: true });
  assert.doesNotMatch(t, /file:\/\/|\/Users\//);
});

console.log(`\n${pass}/${pass + fail} mapping tests passed`);
process.exit(fail ? 1 : 0);
