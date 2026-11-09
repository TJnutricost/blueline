/* Blueline Product Library — core logic (no DOM, no Chrome APIs, so it can be unit-tested in Node).
 *
 * Pieces: money helpers (integer cents), CSV / JSON / DOCX importers that normalize an SMP into one structure,
 * a read-only public Shopify storefront driver, exact variant resolution, price reconciliation, manual
 * decisions, persistence (isolated per store + campaign) and the approved-library export.
 *
 * Rules this file keeps:
 *  - The imported SMP is never altered. Importers only read; the normalized import is stored once (`smp`) and
 *    never written again except by adding another import. Corrections, Shopify data and manual products live
 *    in a separate `work` record.
 *  - The driver only issues GET requests to public storefront JSON endpoints. No credentials, nothing is written.
 *  - A product id is never a variant id. Variant ids are strings.
 *  - A variant is chosen automatically only on an exact SKU match (a duplicate SKU is narrowed by the SMP
 *    price only when that leaves exactly one). Otherwise the person chooses.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BluelineLibrary = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ------------------------------------------------------------------ money (integer cents)

  // "$1,234.50", "19.97", 19.97 -> integer cents. Never goes through floating point for strings.
  function toCents(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null;
    let s = String(v).trim().replace(/[^\d.,]/g, '');
    if (!/\d/.test(s)) return null;
    if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');
    else if (s.includes(',')) s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
    const [whole, frac = ''] = s.split('.');
    if (!/^\d+$/.test(whole || '0')) return null;
    const f = (frac + '00').slice(0, 2);
    let cents = parseInt(whole || '0', 10) * 100 + parseInt(f, 10);
    if (frac.length > 2 && frac[2] >= '5') cents += 1;
    return Number.isSafeInteger(cents) ? cents : null;
  }

  function fmt(cents, currency) {
    if (cents === null || cents === undefined) return '—';
    const n = (cents / 100).toFixed(2);
    return !currency || currency === 'USD' ? `$${n}` : `${n} ${currency}`;
  }

  // Compares two integer-cent prices. One cent apart is "rounding": shown, never silently changed.
  function reconcile(smpCents, shopifyCents) {
    if (smpCents === null || smpCents === undefined || shopifyCents === null || shopifyCents === undefined) return { status: 'unknown', diffCents: null };
    const diffCents = shopifyCents - smpCents;
    const status = diffCents === 0 ? 'match' : Math.abs(diffCents) === 1 ? 'rounding' : 'mismatch';
    return { status, diffCents };
  }

  // ------------------------------------------------------------------ keys and store origins

  const slug = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const productKey = ({ sku, name }) => (sku && String(sku).trim() ? `sku:${String(sku).trim().toUpperCase()}` : `name:${slug(name) || 'unnamed'}`);
  const skuEq = (a, b) => !!a && !!b && String(a).trim().toUpperCase() === String(b).trim().toUpperCase();

  // "nutricost.com", "https://shop.example.com/products/x" -> "https://shop.example.com". Plain http only for local hosts.
  function normalizeStore(input) {
    let s = String(input ?? '').trim();
    if (!s) return { error: 'Enter the store address, for example https://example.myshopify.com.' };
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
    let u;
    try { u = new URL(s); } catch { return { error: 'That doesn\u2019t look like a web address.' }; }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { error: 'The store address must start with https://.' };
    if (!u.hostname.includes('.') && !local) return { error: 'That doesn\u2019t look like a store address.' };
    return { origin: u.origin.toLowerCase() };
  }

  // The store is optional: empty input means "no store" (a list that is never verified against Shopify).
  const optionalStore = (input) => (String(input ?? '').trim() ? normalizeStore(input) : { origin: '' });

  // ------------------------------------------------------------------ CSV (moved verbatim from tools.js)

  function parseCSV(text) {
    const first = text.split(/\r?\n/, 1)[0] || '';
    const delim = [',', '\t', ';'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [];
    let cell = '';
    let inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += c;
      } else if (c === '"') inQ = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c !== '\r') cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim()));
  }

  // ------------------------------------------------------------------ importers -> one normalized import

  const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/^(?:[-–•*]+\s*|\d+[.)]\s+)/, '').replace(/[\s:\-–]+$/, '').replace(/\b(\w[\w®™'’.-]*)(?:\s+\1\b)+/gi, '$1').trim();

  // Builds the stored import. `placements` are in document order; a SKU placed in several sections stays several
  // placements (one product). `raw` keeps what the file said, exactly.
  function makeImport({ kind, fileName, size, lastModified, sha256, campaign, groups, placements, warnings }) {
    const importedAt = Date.now();
    const id = `imp-${(sha256 || String(importedAt)).slice(0, 10)}`;
    const gs = [];
    const gid = (g) => {
      const g0 = g || { label: 'Ungrouped' };
      const idg = `g-${slug([g0.list, g0.label].filter(Boolean).join(' ')) || 'ungrouped'}`;
      if (!gs.find((x) => x.id === idg)) gs.push({ id: idg, label: g0.label || 'Ungrouped', list: g0.list || null, declaredCount: g0.declaredCount ?? null });
      return idg;
    };
    const ps = placements.map((p, i) => ({
      id: `${id}:${i + 1}`,
      groupId: gid(p.group),
      position: p.position ?? i + 1,
      sku: p.sku || null,
      name: p.name || null,
      originalCents: p.originalCents ?? null,
      saleCents: p.saleCents ?? null,
      currency: p.currency || null,
      raw: p.raw || {},
    }));
    (groups || []).forEach((g) => gid(g));
    const ws = [...(warnings || [])];
    for (const g of gs) {
      const n = ps.filter((p) => p.groupId === g.id).length;
      if (g.declaredCount != null && n !== g.declaredCount) ws.push(`"${[g.list, g.label].filter(Boolean).join(' · ')}" says ${g.declaredCount} products but the file lists ${n}.`);
    }
    // Promotional-price checks (sale vs discount %) are not import notes: they are per-product warnings in buildRows,
    // kept apart from original-price mismatches.
    return { v: 1, id, source: { kind, fileName: fileName || null, size: size ?? null, lastModified: lastModified ?? null, sha256: sha256 || null }, importedAt, campaign: campaign || { name: null, meta: {} }, groups: gs, placements: ps, warnings: ws };
  }

  const pick = (o, names) => { for (const n of names) if (o[n] !== undefined && o[n] !== null && String(o[n]).trim() !== '') return o[n]; return undefined; };
  const normKey = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); // originalPrice, original_price, "Original Price" -> one form

  // One generic row object ({any header: value}) -> a placement, or null. Used by CSV and JSON.
  function placementFromRecord(rec, warnings, where, defaultGroup) {
    const o = {};
    for (const [k, v] of Object.entries(rec || {})) o[normKey(k)] = v;
    const sku = pick(o, ['sku', 'variant sku', 'product sku', 'item sku']);
    const name = pick(o, ['name', 'product', 'product name', 'title', 'product title', 'item']);
    if (sku === undefined && name === undefined) return null;
    const money = (cents, text, label) => {
      const c = cents !== undefined ? (Number.isFinite(+cents) ? Math.round(+cents) : null) : toCents(text);
      if (c === null && (text !== undefined || cents !== undefined)) warnings.push(`${where}: couldn\u2019t read the ${label} price "${text ?? cents}".`);
      return c;
    };
    const ocRaw = pick(o, ['original price cents', 'original cents']);
    const scRaw = pick(o, ['sale price cents', 'sale cents', 'discount price cents']);
    const origText = pick(o, ['original price', 'original', 'regular price', 'price', 'compare at price', 'list price', 'msrp']);
    const saleText = pick(o, ['sale price', 'discount price', 'discounted price', 'promo price', 'promotional price', 'sale']);
    const section = pick(o, ['section', 'group', 'list', 'placement', 'category']);
    const list = pick(o, ['campaign list', 'theme']);
    return {
      sku: sku === undefined ? null : String(sku).trim(),
      name: name === undefined ? null : cleanName(name),
      originalCents: money(ocRaw, origText, 'original'),
      saleCents: money(scRaw, saleText, 'sale'),
      currency: (pick(o, ['currency']) || '').toString().trim().toUpperCase() || null,
      position: pick(o, ['position', 'order']) !== undefined ? +pick(o, ['position', 'order']) || undefined : undefined,
      group: section !== undefined ? { label: String(section).trim(), list: list ? String(list).trim() : null } : defaultGroup || null,
      raw: { sku: sku === undefined ? null : String(sku), name: name === undefined ? null : String(name), original: origText === undefined ? null : String(origText), sale: saleText === undefined ? null : String(saleText), section: section === undefined ? null : String(section) },
    };
  }

  function importCsv(text, meta = {}) {
    const rows = parseCSV(String(text || '').replace(/^\uFEFF/, ''));
    if (rows.length < 2) throw new Error('The CSV needs a header row and at least one product.');
    const head = rows[0];
    const warnings = [];
    const placements = [];
    rows.slice(1).forEach((r, i) => {
      const rec = {};
      head.forEach((h, j) => { rec[h] = r[j]; });
      const p = placementFromRecord(rec, warnings, `Row ${i + 2}`);
      if (p) placements.push(p); else warnings.push(`Row ${i + 2}: no SKU or name, skipped.`);
    });
    if (!placements.length) throw new Error('No product rows found. The CSV needs a SKU or name column.');
    return makeImport({ ...meta, kind: 'csv', campaign: meta.campaign || { name: null, meta: {} }, placements, warnings });
  }

  function importJson(input, meta = {}) {
    let data = input;
    if (typeof input === 'string') { try { data = JSON.parse(input.replace(/^\uFEFF/, '')); } catch { throw new Error('That file isn\u2019t valid JSON.'); } }
    const warnings = [];
    const placements = [];
    const add = (rec, where, group) => { const p = placementFromRecord(rec, warnings, where, group); if (p) placements.push(p); else warnings.push(`${where}: no SKU or name, skipped.`); };
    const sections = Array.isArray(data?.sections) ? data.sections : Array.isArray(data?.groups) ? data.groups : null;
    const flat = Array.isArray(data) ? data : data?.products || data?.items || data?.placements || null;
    if (sections) sections.forEach((s, si) => (s.products || s.items || []).forEach((rec, i) => add(rec, `Section ${si + 1}, item ${i + 1}`, { label: s.label || s.name || `Section ${si + 1}`, list: s.list || null, declaredCount: s.declaredCount ?? null })));
    else if (Array.isArray(flat)) flat.forEach((rec, i) => add(rec, `Item ${i + 1}`));
    else throw new Error('Unrecognized JSON. Expected a list of products, {"products": [...]} or {"sections": [{"name", "products": [...]}]}.');
    if (!placements.length) throw new Error('No products found in the JSON.');
    const campaign = { name: data?.campaign?.name || data?.campaign || data?.name || null, meta: data?.campaign?.meta || {} };
    if (typeof campaign.name !== 'string') campaign.name = null;
    return makeImport({ ...meta, kind: 'json', campaign, placements, warnings });
  }

  // ---- DOCX (a zip; only word/document.xml is read). Uses the browser's / Node's DecompressionStream.

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }

  async function unzipEntry(buf, wanted, maxBytes = 30 * 1024 * 1024) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('That isn\u2019t a .docx file (no zip directory found).');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('The .docx zip directory is damaged.');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true);
      const elen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nlen));
      if (name === wanted) {
        if (usize > maxBytes) throw new Error('The document is too large to read.');
        if (dv.getUint32(lho, true) !== 0x04034b50) throw new Error('The .docx zip entry is damaged.');
        const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
        const data = b.subarray(start, start + csize);
        if (method === 0) return data;
        if (method === 8) return inflateRaw(data);
        throw new Error('The .docx uses an unsupported compression method.');
      }
      p += 46 + nlen + elen + clen;
    }
    return null;
  }

  const xmlText = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l === 'amp') return '&'; if (l === 'lt') return '<'; if (l === 'gt') return '>'; if (l === 'quot') return '"'; if (l === 'apos') return "'";
    const code = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    try { return String.fromCodePoint(code); } catch { return ''; }
  });

  // word/document.xml -> plain text, one line per paragraph or line break.
  function docxXmlToText(xml) {
    const out = [];
    const paras = xml.match(/<w:p(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:p>)/g) || [];
    for (const p of paras) {
      let line = '';
      p.replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(br|cr)\b[^>]*\/?>|<w:tab\b[^>]*\/?>/g, (m, t, br) => { line += t !== undefined ? xmlText(t) : br ? '\n' : ' '; return m; });
      out.push(line);
    }
    return out.join('\n');
  }

  const HEADING = /^(highlighted products?|best sellers?|product cta|featured products?|top picks?)\b/i;
  const THEME_TAIL = /\(([^()]*\b(?:theme|driven)\b[^()]*)\)\s*$/i;

  // The "Black Friday SMP" layout: section headings ("Highlighted Products (Black Friday Theme)") followed by
  // products written as "Name SKU: X Original Price - $A Discount Price - $B", often with the pieces glued
  // together, split over several paragraphs, or two products in one paragraph.
  function parseSmpText(text) {
    const lines = text.split(/\r?\n/).map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean);
    const campaign = { name: lines[0] && !/SKU\s*:/i.test(lines[0]) && !HEADING.test(lines[0]) ? lines[0] : null, meta: {} };
    const promos = [];
    let cur = null;
    for (const l of lines) {
      const lm = l.match(/^(.*?)\s*Launching\s*:\s*(.+)$/i);
      if (lm) { cur = { phase: lm[1].trim() || null, dates: lm[2].trim() }; promos.push(cur); continue; }
      if (cur && /^offer\s*:/i.test(l)) cur.offer = l.replace(/^offer\s*:\s*/i, '');
      else if (cur && /^code\s*:/i.test(l)) cur.code = l.replace(/^code\s*:\s*/i, '');
    }
    if (promos.length) {
      campaign.meta.promotions = promos;
      const pcts = [...new Set(promos.map((p) => (p.offer || '').match(/(\d+(?:\.\d+)?)\s*%/)?.[1]).filter(Boolean))];
      if (pcts.length === 1) campaign.meta.discountPercent = +pcts[0];
    }
    // Headings become markers; everything else is joined into one stream so a name on one line and its SKU on the
    // next still belong together.
    const chunks = [{ group: null, text: [] }];
    for (const l of lines) {
      if (!/SKU\s*:/i.test(l) && (HEADING.test(l) || THEME_TAIL.test(l))) {
        const list = l.match(THEME_TAIL)?.[1].trim() || null;
        const base = l.replace(THEME_TAIL, '').trim();
        const count = base.match(/\((\d+)\s*products?\)/i)?.[1];
        const label = base.replace(/\(\s*\d+\s*products?\s*\)/gi, '').replace(/\s+/g, ' ').trim() || l;
        chunks.push({ group: { label, list, declaredCount: count ? +count : null }, text: [] });
      } else chunks[chunks.length - 1].text.push(l);
    }
    const num = '([\\d,]+(?:\\.\\d+)?)';
    const REC = new RegExp(`([\\s\\S]*?)SKU\\s*:\\s*([A-Za-z0-9][A-Za-z0-9_.\\-]*?)(?=Original|Discount|Sale|\\s|$)\\s*(?:Original\\s*Price\\s*[-–:]?\\s*\\$?\\s*${num})?\\s*(?:(?:Discount|Sale)(?:ed)?\\s*Price\\s*[-–:]?\\s*\\$?\\s*${num})?`, 'gi');
    const warnings = [];
    const placements = [];
    for (const ch of chunks) {
      const s = ch.text.join(' ');
      REC.lastIndex = 0;
      let m;
      while ((m = REC.exec(s)) && m[0]) {
        const raw = m[0].trim();
        const p = { sku: m[2], name: cleanName(m[1]) || null, originalCents: m[3] ? toCents(m[3]) : null, saleCents: m[4] ? toCents(m[4]) : null, group: ch.group, raw: { name: m[1].trim(), sku: m[2], original: m[3] ? `$${m[3]}` : null, sale: m[4] ? `$${m[4]}` : null, text: raw } };
        if (!p.name) warnings.push(`${p.sku}: no product name found.`);
        if (p.originalCents === null) warnings.push(`${p.sku}: no original price found.`);
        if (p.saleCents === null) warnings.push(`${p.sku}: no discount price found.`);
        placements.push(p);
      }
    }
    return { campaign, placements, warnings };
  }

  async function sha256Hex(bytes) {
    try {
      const d = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
    } catch { return null; }
  }

  // `buffer` is read, never written. The hash lets someone confirm the file they imported is the file they have.
  async function importDocx(buffer, meta = {}) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const entry = await unzipEntry(bytes, 'word/document.xml');
    if (!entry) throw new Error('That .docx has no document text (word/document.xml).');
    const parsed = parseSmpText(docxXmlToText(new TextDecoder().decode(entry)));
    if (!parsed.placements.length) throw new Error('No products found. Expected lines like "Name SKU: ABC123 Original Price - $19.97 Discount Price - $11.99".');
    return makeImport({ ...meta, kind: 'docx', sha256: meta.sha256 || (await sha256Hex(bytes)), campaign: parsed.campaign, placements: parsed.placements, warnings: parsed.warnings });
  }

  // Picks the importer from the file name (and bytes for .docx). Returns the import; never touches the file.
  async function importFile(file) {
    const name = file.name || '';
    const meta = { fileName: name, size: file.size, lastModified: file.lastModified };
    if (/\.docx$/i.test(name)) return importDocx(await file.arrayBuffer(), meta);
    const text = await file.text();
    if (/\.json$/i.test(name)) return importJson(text, { ...meta, sha256: await sha256Hex(new TextEncoder().encode(text)) });
    if (/\.(csv|tsv|txt)$/i.test(name)) return importCsv(text, { ...meta, sha256: await sha256Hex(new TextEncoder().encode(text)) });
    throw new Error('Use a .csv, .json or .docx file.');
  }

  // ------------------------------------------------------------------ products derived from imports

  // One product per SKU. Every placement is kept; the first placement's values are the SMP's values for it.
  function smpProducts(smp) {
    const map = new Map();
    for (const imp of smp?.imports || []) for (const p of imp.placements) {
      const key = productKey(p);
      let prod = map.get(key);
      if (!prod) { prod = { key, origin: 'smp', sku: p.sku, name: p.name, discountPercent: imp.campaign?.meta?.discountPercent ?? null, smp:{ name: p.name, originalCents: p.originalCents, saleCents: p.saleCents, currency: p.currency }, placements: [], conflicts: [] }; map.set(key, prod); }
      else if (p.originalCents !== null && prod.smp.originalCents !== null && p.originalCents !== prod.smp.originalCents) prod.conflicts.push(`Also listed at ${fmt(p.originalCents)} (original) in ${imp.source.fileName || imp.source.kind}.`);
      const g = imp.groups.find((x) => x.id === p.groupId);
      prod.placements.push({ id: p.id, importId: imp.id, groupId: p.groupId, group: g ? { label: g.label, list: g.list } : null, position: p.position, originalCents: p.originalCents, saleCents: p.saleCents });
    }
    return [...map.values()];
  }

  // ------------------------------------------------------------------ Shopify public storefront driver (read-only)

  class DriverError extends Error { constructor(kind, message, status) { super(message); this.kind = kind; this.status = status; } }

  const absUrl = (origin, u) => (!u ? null : String(u).startsWith('//') ? `https:${u}` : /^https?:/i.test(u) ? u : `${origin}${u.startsWith('/') ? '' : '/'}${u}`);
  const centsOf = (p) => {
    if (p === null || p === undefined || p === '') return null;
    if (typeof p === 'number') return Number.isInteger(p) ? p : Math.round(p * 100);
    return /^\d+$/.test(String(p).trim()) ? parseInt(p, 10) : toCents(p);
  };

  // Product JSON from /products/<handle>.js -> { productId, handle, title, image, url, variants: [VariantInfo] }
  function normalizeProduct(json, origin, currency) {
    if (!json || typeof json !== 'object' || !Array.isArray(json.variants)) throw new DriverError('parse', 'The store returned something that isn\u2019t a product.');
    const names = (json.options || []).map((o) => (typeof o === 'string' ? o : o?.name));
    const productId = String(json.id);
    return {
      productId,
      handle: json.handle,
      title: json.title,
      url: `${origin}/products/${json.handle}`,
      image: absUrl(origin, json.featured_image || json.images?.[0]?.src || json.images?.[0] || null),
      variants: json.variants.map((v) => {
        const vals = Array.isArray(v.options) ? v.options : [v.option1, v.option2, v.option3].filter((x) => x != null);
        const variantId = String(v.id);
        return {
          productId,
          handle: json.handle,
          productTitle: json.title,
          variantId,
          variantGid: `gid://shopify/ProductVariant/${variantId}`,
          variantTitle: v.title === 'Default Title' ? null : v.title,
          sku: v.sku ? String(v.sku).trim() : null,
          priceCents: centsOf(v.price),
          compareAtCents: centsOf(v.compare_at_price),
          currency: currency || null,
          options: vals.map((value, i) => ({ name: names[i] || `Option ${i + 1}`, value })).filter((o) => o.value && o.value !== 'Default Title'),
          image: absUrl(origin, v.featured_image?.src || json.featured_image || json.images?.[0]?.src || json.images?.[0] || null),
          available: v.available !== false,
          url: `${origin}/products/${json.handle}?variant=${variantId}`,
        };
      }),
    };
  }

  // Accepts a product URL, "/products/handle", or a bare handle; keeps a ?variant= id when there is one.
  function parseProductRef(input) {
    const s = String(input || '').trim();
    const m = s.match(/\/products\/([^/?#\s]+)/i);
    const vid = s.match(/[?&]variant=(\d+)/i)?.[1] || null;
    if (m) return { handle: decodeURIComponent(m[1]).replace(/\.(js|json)$/i, ''), variantId: vid };
    return /^[a-z0-9][a-z0-9-]*$/i.test(s) && s.includes('-') ? { handle: s.toLowerCase(), variantId: null } : null;
  }

  // `fetchJson(url)` must perform a plain GET and return parsed JSON, or throw. The extension supplies one that
  // goes through the page (same origin) or the service worker (other origins).
  function createDriver({ origin, fetchJson, currency = 'USD' }) {
    const get = async (path) => {
      try {
        try { return await fetchJson(`${origin}${path}`); }
        catch (e) { // a store that is rate-limiting us gets one patient retry
          if (!(e && e.status === 429)) throw e;
          await new Promise((r) => setTimeout(r, 1200));
          return await fetchJson(`${origin}${path}`);
        }
      } catch (e) {
        if (e instanceof DriverError) throw e;
        if (e && e.status === 404) throw new DriverError('not-found', 'Not found.', 404);
        throw new DriverError(e && e.status ? 'http' : 'network', (e && e.message) || 'The request failed.', e && e.status);
      }
    };
    const cache = new Map();
    return {
      origin,
      currency,
      async suggest(text, { skuOnly = false, limit = 10 } = {}) {
        const fields = skuOnly ? '&resources[options][fields]=variants.sku' : '&resources[options][fields]=title,variants.sku,variants.title,product_type';
        const j = await get(`/search/suggest.json?q=${encodeURIComponent(text)}&resources[type]=product&resources[limit]=${limit}${fields}`);
        return (j?.resources?.results?.products || []).map((p) => ({ handle: p.handle, title: p.title }));
      },
      async product(handle) {
        if (cache.has(handle)) return cache.get(handle);
        let prod = null;
        try { prod = normalizeProduct(await get(`/products/${encodeURIComponent(handle)}.js`), origin, currency); }
        catch (e) { if (!(e instanceof DriverError && e.kind === 'not-found')) throw e; }
        cache.set(handle, prod);
        return prod;
      },
      async detectCurrency() { const j = await get('/cart.js'); return typeof j?.currency === 'string' ? j.currency.toUpperCase() : null; },
    };
  }

  const tokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length > 1 && !['the', 'and', 'nutricost'].includes(t));

  // Fallback suggestions (never auto-selected): name / flavor / quantity overlap, plus a bonus for the same price.
  function scoreSuggestions(products, { name, smpCents }) {
    const want = new Set(tokens(name));
    const out = [];
    for (const p of products) for (const v of p.variants) {
      const have = new Set(tokens(`${p.title} ${v.variantTitle || ''} ${v.options.map((o) => o.value).join(' ')}`));
      const hit = [...want].filter((t) => have.has(t)).length;
      const base = want.size ? hit / want.size : 0;
      const samePrice = smpCents != null && v.priceCents === smpCents;
      // One shared word (a brand name) is not evidence. Two words, or one plus the same price, is worth offering.
      if ((hit >= 2 && base >= 0.5) || (samePrice && hit >= 1 && base >= 0.34)) out.push({ ...v, score: Math.round((base + (samePrice ? 0.25 : 0)) * 100) / 100 });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 8);
  }

  // Looks a product up in the store. Returns { match, variant } where match.status is one of:
  //   exact      one variant, SKU matches exactly (match.method says how: 'sku' or 'sku+price')
  //   ambiguous  several variants share the SKU and the SMP price doesn't single one out: choose
  //   not-found  no variant has that SKU (match.candidates holds fuzzy suggestions, never auto-used)
  //   unresolved no SKU to look up (suggestions by name only)
  //   error      the store couldn't be read
  async function lookupProduct(driver, { sku, name, smpCents }) {
    const now = Date.now();
    const fail = (message) => ({ match: { status: 'error', message, checkedAt: now, candidates: [] }, variant: null });
    try {
      if (sku) {
        const found = await fetchProducts(driver, await driver.suggest(sku, { skuOnly: true }));
        const exact = found.products.flatMap((p) => p.variants).filter((v) => skuEq(v.sku, sku));
        if (exact.length === 1) return resolved(exact[0], 'sku', found.failed, now);
        if (exact.length > 1) {
          const byPrice = smpCents != null ? exact.filter((v) => v.priceCents === smpCents) : [];
          if (byPrice.length === 1) return resolved(byPrice[0], 'sku+price', found.failed, now, `${exact.length} variants share SKU ${sku}; chose the one priced at the SMP price.`);
          return { match: { status: 'ambiguous', message: `${exact.length} variants share SKU ${sku}. Choose the right one.`, checkedAt: now, candidates: exact }, variant: null };
        }
        if (found.failed && !found.products.length) return fail(`Couldn\u2019t read the products found for ${sku}.`);
      }
      const byName = name ? await fetchProducts(driver, await driver.suggest(name, { limit: 6 })) : { products: [] };
      const candidates = scoreSuggestions(byName.products, { name, smpCents });
      return { match: { status: sku ? 'not-found' : 'unresolved', message: sku ? `No variant in the store has SKU ${sku}.` : 'No SKU to look up. Choose a variant.', checkedAt: now, candidates }, variant: null };
    } catch (e) {
      return fail(e instanceof DriverError ? (e.kind === 'not-found' ? 'The store has no public product search.' : e.message) : String(e && e.message || e));
    }
  }

  async function fetchProducts(driver, hits) {
    const products = [];
    let failed = 0;
    for (const h of hits.slice(0, 8)) {
      try { const p = await driver.product(h.handle); if (p) products.push(p); } catch { failed++; }
    }
    return { products, failed };
  }

  function resolved(variant, method, failed, now, note) {
    const warnings = [];
    if (note) warnings.push(note);
    if (!variant.available) warnings.push('This variant is sold out.');
    if (failed) warnings.push('Some search results could not be read; the SKU match may not be complete.');
    if (variant.variantId === variant.productId) warnings.push('Variant id equals the product id. Check this is the variant, not the product.');
    return { match: { status: 'exact', method, checkedAt: now, warnings, candidates: [] }, variant };
  }

  // Runs lookups with a few at a time. `onResult(key, result, done, total)`.
  async function lookupAll(driver, items, onResult, concurrency = 3) {
    let i = 0;
    let done = 0;
    const worker = async () => {
      while (i < items.length) {
        const it = items[i++];
        const r = await lookupProduct(driver, it);
        done++;
        if (onResult) await onResult(it.key, r, done, items.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  }


  // Re-reads a variant we already know by id (a manual choice is never replaced by a new search).
  async function refreshVariant(driver, variant) {
    const p = await driver.product(variant.handle);
    const v = p?.variants.find((x) => x.variantId === variant.variantId);
    return v ? { ...v, currency: variant.currency || driver.currency } : null;
  }

  // New price / availability for a known variant; `null` means the store no longer lists it (kept, and flagged).
  function setRefresh(lib, key, variant, error) {
    const rec = lib.work.shopify[key];
    if (!rec) return lib;
    const now = Date.now();
    const warnings = (rec.match?.warnings || []).filter((w) => !/^(No longer|Couldn)/.test(w) && !/sold out/.test(w));
    if (error) warnings.push(`Couldn\u2019t refresh: ${error}`);
    else if (!variant) warnings.push('No longer found in the store. The saved details are from the last check.');
    else if (!variant.available) warnings.push('This variant is sold out.');
    const next = { match: { ...rec.match, warnings, checkedAt: error ? rec.match?.checkedAt : now }, variant: variant ? { ...rec.variant, ...variant } : rec.variant };
    return { ...lib, work: { ...lib.work, shopify: { ...lib.work.shopify, [key]: next }, updatedAt: now } };
  }

  // Looks up every product that has no variant yet and refreshes the ones that do. Variants already chosen (by an
  // exact match or by the person) are refreshed by id, never searched for again.
  async function checkAll(driver, lib, onProgress, concurrency = 3) {
    const rows = buildRows(lib);
    let cur = lib;
    let i = 0;
    let done = 0;
    const worker = async () => {
      while (i < rows.length) {
        const r = rows[i++];
        if (r.variant) {
          // Await first, then apply to the latest `cur`: workers run concurrently and must not overwrite each other.
          let fresh;
          let err;
          try { fresh = await refreshVariant(driver, r.variant); } catch (e) { err = e.message; }
          cur = setRefresh(cur, r.key, err ? r.variant : fresh, err);
        } else if (r.origin === 'smp') {
          const result = await lookupProduct(driver, { sku: r.sku, name: r.name, smpCents: r.smp?.originalCents ?? null });
          cur = setLookup(cur, r.key, result);
        }
        done++;
        if (onProgress) onProgress(done, rows.length, cur);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
    return cur;
  }

  // ------------------------------------------------------------------ library state: rows, decisions

  // work = everything that is not the imported file: Shopify lookups, decisions, identity approvals, edits.
  // Lists saved by earlier versions lack `identity` and `edits`; loadLibrary fills those in with empty ones.
  const emptyWork = () => ({ v: 1, shopify: {}, decisions: {}, identity: {}, edits: {}, manualProducts: {}, settings: { currency: 'USD', currencySource: 'assumed' }, updatedAt: null });

  const safeUrl = (u) => { try { const x = new URL(String(u).trim()); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; } };

  // Everything the UI shows for each product, computed from the immutable import plus the work record.
  // Three things are kept apart on every row and never overwrite each other:
  //   source    what the imported file said (key, SKU, name, prices, placements)
  //   selected  the Shopify product/variant now linked to it (variant, match)
  //   working   what a person approved or edited for display (approved price, edits)
  function buildRows(lib) {
    const work = { ...emptyWork(), ...(lib.work || {}) };
    const list = [...smpProducts(lib.smp)];
    for (const [key, m] of Object.entries(work.manualProducts || {})) list.push({ key, origin: 'manual', local: !!m.local, sku: m.sku || null, name: m.name, smp: null, placements: [], conflicts: [] });
    return list.map((p) => {
      const rec = work.shopify[p.key] || null;
      const variant = rec?.variant || null;
      const smpCents = p.smp?.originalCents ?? null;
      const shopCents = variant?.priceCents ?? null;
      const cur = work.settings?.currency || 'USD';
      const ed = work.edits[p.key] || {};
      let status;
      let diffCents = null;
      if (!variant) status = rec?.match?.status || 'unchecked';
      else if (smpCents === null) status = 'no-smp-price';
      else if (p.smp?.currency && variant.currency && p.smp.currency !== variant.currency) status = 'currency';
      else { const r = reconcile(smpCents, shopCents); status = r.status === 'unknown' ? 'no-shopify-price' : r.status; diffCents = r.diffCents; }
      const d = work.decisions[p.key] || null;
      let approved = null;
      if (d) {
        const stale = !!variant && (d.variantId !== variant.variantId || (d.source === 'shopify' && shopCents !== d.approvedCents));
        approved = { cents: d.approvedCents, source: d.source, stale, acknowledgedRounding: !!d.acknowledgedRounding, decidedAt: d.decidedAt };
      } else if (status === 'match') approved = { cents: smpCents, source: 'match', stale: false };
      const correction = approved ? (approved.stale ? 'stale' : approved.source === 'match' ? 'auto' : 'approved') : ['rounding', 'mismatch', 'no-smp-price', 'currency', 'no-shopify-price'].includes(status) ? 'needs-review' : 'none';

      // Identity: is the selected variant the product the file listed? A manual choice with a different SKU is a
      // substitution and stays unapproved until a person says so. A matching price proves nothing about identity.
      let identity = { state: variant ? 'selected' : 'none', sourceSku: p.sku, selectedSku: variant?.sku || null, skuMatchesSource: null, approvedAt: null };
      if (variant && p.origin === 'smp') {
        const same = skuEq(p.sku, variant.sku);
        const ap = work.identity[p.key];
        const ok = !!ap && ap.variantId === variant.variantId;
        identity = { ...identity, skuMatchesSource: same, state: rec.match?.method !== 'manual' || same ? 'exact' : ok ? 'substitute-approved' : 'substitute-pending', approvedAt: ok ? ap.approvedAt : null };
      }
      const identityOk = identity.state !== 'substitute-pending';
      // An approval only counts once the selected variant is accepted as the product the list named.
      const approvedFresh = approved && !approved.stale && identityOk ? approved.cents : null;

      // Variant resolution, price comparison and approval are separate questions; `review` combines them.
      const variantState = variant ? 'resolved' : status === 'unchecked' ? 'unchecked' : status; // ambiguous / not-found / unresolved / error
      const reasons = [];
      if (!variant && variantState !== 'unchecked') reasons.push(STATUS_LABEL[variantState] || 'No variant');
      if (variant && correction === 'needs-review') reasons.push(status === 'mismatch' || status === 'rounding' ? `${STATUS_LABEL[status]}: SMP ${fmt(smpCents, variant.currency || cur)}, Shopify ${fmt(shopCents, variant.currency || cur)}` : STATUS_LABEL[status]);
      if (correction === 'stale') reasons.push('Approved price is out of date');
      if (!identityOk) reasons.push(`Substitution: the selected variant is SKU ${variant.sku || 'none'}, the list says ${p.sku || 'no SKU'}. Approve it to use it.`);
      const settled = approvedFresh !== null && identityOk && (variant ? true : variantState === 'unchecked');

      // Promotional-price warnings are their own thing: the promo price against the discount the file states.
      const promoSource = p.smp?.saleCents ?? null;
      const promo = ed.promoCents !== undefined ? ed.promoCents : promoSource;
      const promoWarnings = [];
      if (p.discountPercent && promo !== null) {
        if (smpCents !== null && !promoOk(smpCents, promo, p.discountPercent)) promoWarnings.push(`The promo price ${fmt(promo)} is not ${p.discountPercent}% off its own original price ${fmt(smpCents)} (that would be ${fmt(promoOf(smpCents, p.discountPercent))}).`);
        if (approvedFresh !== null && approvedFresh !== smpCents && !promoOk(approvedFresh, promo, p.discountPercent)) promoWarnings.push(`The promo price ${fmt(promo)} is not ${p.discountPercent}% off the approved price ${fmt(approvedFresh)} (that would be ${fmt(promoOf(approvedFresh, p.discountPercent))}).`);
      }
      const edited = ['title', 'promoCents', 'image'].filter((k) => ed[k] !== undefined);
      const display = { title: ed.title ?? p.name ?? variant?.productTitle ?? p.sku ?? 'Unnamed', image: ed.image || variant?.image || null, edited };
      return {
        key: p.key, origin: p.origin, local: !!p.local, sku: p.sku, name: p.name, placements: p.placements, conflicts: p.conflicts,
        variant, match: rec?.match || null,
        smp: p.smp,
        source: { sku: p.sku, name: p.name, originalCents: smpCents, promoCents: promoSource },
        prices: { smpCents, shopifyCents: shopCents, compareAtCents: variant?.compareAtCents ?? null, approvedCents: approvedFresh, promoCents: promo, promoSourceCents: promoSource, currency: variant?.currency || cur },
        verification: { status, diffCents },
        variantState,
        identity,
        approval: correction === 'needs-review' ? 'pending' : correction,
        review: { needsReview: reasons.length > 0, reasons },
        promoWarnings,
        display, edits: ed,
        settled,
        approved, correction,
      };
    });
  }

  const promoOf = (cents, pct) => Math.ceil((cents * (100 - pct)) / 100);
  const promoOk = (orig, sale, pct) => Math.abs(promoOf(orig, pct) - sale) <= 1 || Math.abs(Math.round((orig * (100 - pct)) / 100) - sale) <= 1;

  // One set of counts for every summary line, so the screen cannot disagree with itself.
  function summarize(rows) {
    const smpRows = rows.filter((r) => r.origin === 'smp');
    const n = (f) => rows.filter(f).length;
    return {
      total: rows.length,
      unique: smpRows.length,
      manual: rows.length - smpRows.length,
      placements: smpRows.reduce((s, r) => s + r.placements.length, 0),
      variantsResolved: n((r) => !!r.variant),
      noVariant: n((r) => !r.variant && r.variantState !== 'unchecked'),
      notChecked: n((r) => r.variantState === 'unchecked'),
      priceMatch: n((r) => r.verification.status === 'match'),
      priceDiffer: n((r) => !!r.variant && ['rounding', 'mismatch', 'currency', 'no-shopify-price'].includes(r.verification.status)),
      needsReview: n((r) => r.review.needsReview),
      approved: n((r) => r.settled),
      substitutions: n((r) => r.identity.state === 'substitute-pending'),
      promoWarnings: n((r) => r.promoWarnings.length > 0),
      edited: n((r) => r.display.edited.length > 0),
    };
  }

  const STATUS_LABEL = { match: 'Prices match', rounding: '1¢ rounding difference', mismatch: 'Price differs', 'no-smp-price': 'No SMP price', 'no-shopify-price': 'No Shopify price', currency: 'Currency differs', unchecked: 'Not verified', exact: 'Variant found', ambiguous: 'Several variants', 'not-found': 'SKU not found', unresolved: 'No variant', error: 'Lookup failed' };

  // Decisions. All keep SMP and Shopify values as they were; only the approved price is recorded. A list that was
  // never checked against Shopify can still approve the file's price or a typed one; only "Shopify price" needs a variant.
  function decide(lib, key, source, customCents) {
    const row = buildRows(lib).find((r) => r.key === key);
    if (!row) throw new Error('Unknown product.');
    if (source === 'shopify' && !row.variant) throw new Error('Choose the Shopify variant first.');
    let cents;
    if (source === 'shopify') cents = row.prices.shopifyCents;
    else if (source === 'smp') cents = row.prices.smpCents;
    else if (source === 'custom') cents = Number.isInteger(customCents) ? customCents : null;
    else throw new Error('Unknown correction.');
    if (cents === null || cents === undefined || cents < 0) throw new Error(source === 'custom' ? 'Enter a valid price.' : `There is no ${source === 'smp' ? 'SMP' : 'Shopify'} price to use.`);
    const work = { ...lib.work, decisions: { ...lib.work.decisions, [key]: { source, approvedCents: cents, smpCents: row.prices.smpCents, shopifyCents: row.prices.shopifyCents, variantId: row.variant?.variantId ?? null, acknowledgedRounding: row.verification.status === 'rounding', decidedAt: Date.now() } }, updatedAt: Date.now() };
    return { ...lib, work };
  }
  const clearDecision = (lib, key) => { const decisions = { ...lib.work.decisions }; delete decisions[key]; return { ...lib, work: { ...lib.work, decisions, updatedAt: Date.now() } }; };

  // Approving a substitution is its own explicit act, bound to the variant it was given for.
  function approveSubstitution(lib, key) {
    const row = buildRows(lib).find((r) => r.key === key);
    if (!row?.variant) throw new Error('Choose the Shopify variant first.');
    return { ...lib, work: { ...lib.work, identity: { ...(lib.work.identity || {}), [key]: { variantId: row.variant.variantId, sku: row.variant.sku || null, approvedAt: Date.now() } }, updatedAt: Date.now() } };
  }
  function revokeSubstitution(lib, key) { const identity = { ...(lib.work.identity || {}) }; delete identity[key]; return { ...lib, work: { ...lib.work, identity, updatedAt: Date.now() } }; }

  // Working/display edits. Never touch the import or the saved Shopify identity.
  //   title: string · promoCents: integer cents · image: http(s) URL · (local products only) sku
  const EDITABLE = ['title', 'promoCents', 'image'];
  function setEdit(lib, key, field, value) {
    if (!EDITABLE.includes(field)) throw new Error('That field can’t be edited.');
    let v = value;
    if (field === 'title') { v = String(value ?? '').replace(/\s+/g, ' ').trim(); if (!v) throw new Error('The title can’t be empty. Reset it to use the original.'); }
    if (field === 'promoCents') { if (!Number.isInteger(v) || v < 0) throw new Error('Enter a valid promotional price.'); }
    if (field === 'image') { v = safeUrl(value); if (!v) throw new Error('Enter an image address starting with http:// or https://.'); }
    const edits = { ...(lib.work.edits || {}), [key]: { ...((lib.work.edits || {})[key] || {}), [field]: v } };
    return { ...lib, work: { ...lib.work, edits, updatedAt: Date.now() } };
  }
  function resetEdit(lib, key, field) {
    const cur = { ...((lib.work.edits || {})[key] || {}) };
    delete cur[field];
    const edits = { ...(lib.work.edits || {}) };
    if (Object.keys(cur).length) edits[key] = cur; else delete edits[key];
    return { ...lib, work: { ...lib.work, edits, updatedAt: Date.now() } };
  }
  function setLocalSku(lib, key, sku) {
    const m = lib.work.manualProducts?.[key];
    if (!m || !m.local) throw new Error('Only products added by hand can change their SKU.');
    return { ...lib, work: { ...lib.work, manualProducts: { ...lib.work.manualProducts, [key]: { ...m, sku: String(sku || '').trim() || null } }, updatedAt: Date.now() } };
  }

  function setLookup(lib, key, result) {
    const variant = result.variant ? { ...result.variant, currency: result.variant.currency || lib.work.settings.currency } : null;
    return { ...lib, work: { ...lib.work, shopify: { ...lib.work.shopify, [key]: { match: result.match, variant } }, updatedAt: Date.now() } };
  }

  // The person picks a variant themselves (ambiguous, not found, a substitute, or a manual product). Manual choice is
  // authoritative for which variant is linked; the source SKU and name are never replaced, and a different SKU is a
  // substitution that waits for approval.
  function chooseVariant(lib, key, variant) {
    const row = buildRows(lib).find((r) => r.key === key);
    const warnings = [];
    if (row?.sku && !skuEq(row.sku, variant.sku)) warnings.push(`SKU differs: the list says ${row.sku}, this variant is ${variant.sku || 'missing a SKU'}.`);
    if (!variant.available) warnings.push('This variant is sold out.');
    const result = { match: { status: 'exact', method: 'manual', checkedAt: Date.now(), warnings, candidates: [] }, variant };
    // A decision or approval made for another variant no longer applies; buildRows marks them stale or pending.
    return setLookup(lib, key, result);
  }

  // A Shopify product that wasn't in the imported list. Returns the same library when that variant is already there.
  function addManualProduct(lib, variant) {
    const existing = buildRows(lib).find((r) => r.variant && r.variant.variantId === variant.variantId);
    if (existing) return { lib, key: existing.key, duplicate: true };
    const key = `v:${variant.variantId}`;
    const name = [variant.productTitle, variant.variantTitle].filter(Boolean).join(' — ');
    const next = { ...lib, work: { ...lib.work, manualProducts: { ...lib.work.manualProducts, [key]: { sku: variant.sku, name, addedAt: Date.now() } } } };
    return { lib: chooseVariant(next, key, variant), key, duplicate: false };
  }

  // A product typed in by hand, with no Shopify involved. Its price is the person's own entry, so it starts approved.
  function addLocalProduct(lib, { name, sku, regularCents, promoCents }) {
    const title = String(name || '').replace(/\s+/g, ' ').trim();
    if (!title) throw new Error('Enter a product name.');
    if (regularCents !== null && regularCents !== undefined && !(Number.isInteger(regularCents) && regularCents >= 0)) throw new Error('Enter a valid price.');
    const key = `m:${newListId().slice(2)}`;
    let next = { ...lib, work: { ...lib.work, manualProducts: { ...lib.work.manualProducts, [key]: { sku: String(sku || '').trim() || null, name: title, local: true, addedAt: Date.now() } }, updatedAt: Date.now() } };
    if (Number.isInteger(regularCents)) next = decide(next, key, 'custom', regularCents);
    if (Number.isInteger(promoCents)) next = setEdit(next, key, 'promoCents', promoCents);
    return { lib: next, key };
  }

  function removeManualProduct(lib, key) {
    const w = { ...lib.work, manualProducts: { ...lib.work.manualProducts }, shopify: { ...lib.work.shopify }, decisions: { ...lib.work.decisions }, identity: { ...(lib.work.identity || {}) }, edits: { ...(lib.work.edits || {}) } };
    delete w.manualProducts[key]; delete w.shopify[key]; delete w.decisions[key]; delete w.identity[key]; delete w.edits[key];
    return { ...lib, work: { ...w, updatedAt: Date.now() } };
  }

  // ------------------------------------------------------------------ export
  //
  // `blueline.product-library/2`. Source, selected and working information are separate objects, so a substituted
  // variant is never mistaken for the imported SKU:
  //   sku, name          the SOURCE product's SKU and name, exactly as imported (as in earlier exports)
  //   source             the same plus the imported prices and placements
  //   shopifySku, variantId, variantGid, productId, handle, url, productTitle, variantTitle, options, image,
  //                      available   the SELECTED Shopify variant (null when none)
  //   identity           exact | substitute-approved | substitute-pending | selected (added from Shopify) | none
  //   prices             smpOriginal, shopify, compare-at, approved (regular), promo (working) and promoSource
  //   display            what the working copy shows (title, image) and which fields were edited
  //   verification       what was verified against Shopify and what still needs review
  // `scope: 'full'` has every product (unresolved and non-Shopify ones too); `'approved'` has the settled ones only
  // and lists the rest under `needsAttention` with the reason.
  const EXPORT_SCHEMA = 'blueline.product-library/2';

  function exportList(lib, scope = 'approved', now = Date.now()) {
    const rows = buildRows(lib);
    const reason = (r) => (r.review.reasons[0] || (r.approved ? 'Not verified' : 'Not approved'));
    const rec = (r) => {
      const v = r.variant;
      return {
        key: r.key, origin: r.origin, sku: r.sku, name: r.name,
        source: r.origin === 'smp' ? { sku: r.sku, name: r.name, originalCents: r.prices.smpCents, promoCents: r.prices.promoSourceCents, placements: r.placements.map((p) => ({ groupId: p.groupId, group: p.group, position: p.position, originalCents: p.originalCents, saleCents: p.saleCents })) } : null,
        shopifySku: v ? v.sku || null : null,
        productId: v ? v.productId : null, variantId: v ? v.variantId : null, variantGid: v ? v.variantGid : null, handle: v ? v.handle : null, url: v ? v.url : null,
        productTitle: v ? v.productTitle : null, variantTitle: v ? v.variantTitle : null, options: v ? v.options : [], image: v ? v.image : null, available: v ? v.available : null,
        matchMethod: r.match?.method || null,
        identity: { state: r.identity.state, sourceSku: r.identity.sourceSku, shopifySku: r.identity.selectedSku, skuMatchesSource: r.identity.skuMatchesSource, substitutionApproved: r.identity.state === 'substitute-approved', approvedAt: r.identity.approvedAt },
        prices: { currency: r.prices.currency, smpOriginalCents: r.prices.smpCents, shopifyCents: r.prices.shopifyCents, shopifyCompareAtCents: r.prices.compareAtCents, approvedCents: r.prices.approvedCents, promoCents: r.prices.promoCents, promoSourceCents: r.prices.promoSourceCents },
        approval: r.approved && !r.approved.stale ? { source: r.approved.source, acknowledgedRounding: !!r.approved.acknowledgedRounding, decidedAt: r.approved.decidedAt || null } : null,
        display: { title: r.display.title, image: r.display.image, edited: r.display.edited },
        verification: { shopify: r.variantState === 'resolved' ? 'verified' : r.variantState === 'unchecked' ? 'not-verified' : r.variantState, priceStatus: v ? r.verification.status : null, priceDiffCents: v ? r.verification.diffCents : null, settled: r.settled, needsReview: r.review.needsReview, reasons: r.review.reasons },
        promoWarnings: r.promoWarnings,
      };
    };
    const sel = scope === 'full' ? rows : rows.filter((r) => r.settled);
    return {
      schema: EXPORT_SCHEMA,
      scope,
      exportedAt: new Date(now).toISOString(),
      store: lib.store || null,
      list: { id: lib.campaign, name: listName(lib) },
      campaign: { id: lib.campaign, name: listName(lib) }, // earlier name for `list`, kept so existing readers still work
      sources: [...(lib.smp?.imports || []), ...(lib.smp?.replaced || [])].map((i) => ({ importId: i.id, ...i.source, importedAt: i.importedAt, replaced: !!i.replacedAt })),
      groups: [...new Map((lib.smp?.imports || []).flatMap((i) => i.groups).map((g) => [g.id, g])).values()],
      products: sel.map(rec),
      needsAttention: scope === 'full' ? [] : rows.filter((r) => !r.settled).map((r) => ({ key: r.key, sku: r.sku, name: r.name, reason: reason(r) })),
      summary: (({ total, unique, manual, placements, approved, needsReview }) => ({ total, unique, manual, placements, approved, needsReview }))(summarize(rows)),
    };
  }
  const exportApproved = (lib, now) => exportList(lib, 'approved', now);

  // ------------------------------------------------------------------ product mapping (saved on a note)
  //
  // A mapping ties one product card on a page to one product (and variant) of one saved list. It is stored on the
  // note as `productMapping` and holds a SNAPSHOT: the approved values as they were when it was made. It is not
  // proof that the list or the store still say the same thing; the snapshot keeps enough source identity
  // (`product.source`, `libraryRef`, the exact variant and approval state) for a later slice to compare it with the
  // live record. It reads the library through buildRows() and never writes to it.
  //
  //   v, origin ('manual' | 'suggested'), mappedAt (ms)
  //   list      { store, id, name }                      which saved list (store + generated id) it came from
  //   product   { key, origin, local, sku, name, source } the list's own identity for the product (as imported)
  //   variant   null | { variantId, productId, ... }     the selected Shopify variant, ids kept as strings
  //   approved  { title, image, currency, regularCents, regularSource, promoCents, promoSource, ... } integer cents
  //   reference { smpCents, shopifyCents, compareAtCents } what the sources said (context when nothing is approved)
  //   state     verification, identity, approval, needsReview, reasons, promoWarnings
  //   libraryRef { importHashes, workUpdatedAt }         which list content it was taken from
  //   card      null | { selector, section, index, count, text }  where it goes on the page; filled by a later slice
  const MAPPING_SCHEMA = 1;
  const deepCopy = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const isMapping = (m) => !!m && typeof m === 'object' && !!m.product && typeof m.product.key === 'string' && m.product.key !== '';

  function productMappingSnapshot(lib, key, { origin = 'manual', card = null, now = Date.now() } = {}) {
    if (origin !== 'manual' && origin !== 'suggested') throw new Error('Unknown mapping origin.');
    const row = buildRows(lib).find((r) => r.key === key);
    if (!row) throw new Error('That product isn’t in this list.');
    const v = row.variant;
    const regularCents = row.prices.approvedCents ?? null; // null when unapproved, stale or a substitution is still pending
    const promoCustom = row.display.edited.includes('promoCents');
    const snap = {
      v: MAPPING_SCHEMA,
      origin,
      mappedAt: now,
      list: { store: lib.store || '', id: lib.campaign, name: listName(lib) },
      product: {
        key: row.key, origin: row.origin, local: !!row.local, sku: row.sku || null, name: row.name || null,
        source: row.origin === 'smp' ? { originalCents: row.source.originalCents ?? null, promoCents: row.source.promoCents ?? null } : null,
      },
      variant: v ? {
        variantId: String(v.variantId), variantGid: v.variantGid || null, productId: v.productId != null ? String(v.productId) : null,
        handle: v.handle || null, url: v.url || null, sku: v.sku || null, productTitle: v.productTitle || null, variantTitle: v.variantTitle || null,
        options: (v.options || []).map((o) => ({ name: o.name, value: o.value })), available: v.available !== false,
      } : null,
      approved: {
        title: row.display.title, image: row.display.image || null, currency: row.prices.currency || null,
        regularCents, regularSource: regularCents !== null ? row.approved.source : null,
        promoCents: row.prices.promoCents ?? null, promoSource: promoCustom ? 'custom' : row.prices.promoSourceCents != null ? 'smp' : null,
        titleEdited: row.display.edited.includes('title'), imageEdited: row.display.edited.includes('image'),
      },
      reference: { smpCents: row.prices.smpCents ?? null, shopifyCents: row.prices.shopifyCents ?? null, compareAtCents: row.prices.compareAtCents ?? null },
      state: {
        verification: row.variantState === 'resolved' ? 'verified' : row.variantState === 'unchecked' ? 'not-verified' : row.variantState,
        identity: row.identity.state, sourceSku: row.identity.sourceSku || null, shopifySku: row.identity.selectedSku || null,
        approval: row.approval, priceStatus: v ? row.verification.status : null,
        settled: !!row.settled, needsReview: !!row.review.needsReview, reasons: [...row.review.reasons], promoWarnings: [...row.promoWarnings],
      },
      libraryRef: {
        importHashes: (lib.smp?.imports || []).map((i) => i.source?.sha256).filter(Boolean), workUpdatedAt: lib.work?.updatedAt ?? null,
        // What the list itself said when this was mapped. Drift is measured against this, never against what the card now shows.
        baseline: { variantId: v ? String(v.variantId) : null, sku: v?.sku || null, approval: row.approval, identity: row.identity.state, regularCents, promoCents: row.prices.promoCents ?? null, title: row.display.title || null },
      },
      card: card ? card : null,
    };
    return deepCopy(snap); // plain JSON, sharing nothing with the library
  }

  // ---- M3: page-specific values, comparing a saved mapping with its list, changing the variant, searching
  //
  // `overrides` sits beside `approved` on the mapping: { title, image, regularCents, promoCents, url }, only the keys the
  // person changed. They belong to this card on this page. The list's product, the imported file and the store are never
  // written, and the selected variant is never changed by them. Editing a displayed price does not change what Shopify
  // charges at checkout.
  const OVERRIDE_FIELDS = ['title', 'image', 'regularCents', 'promoCents', 'url'];
  function effectiveValues(m) {
    const a = (m && m.approved) || {};
    const o = (m && m.overrides) || {};
    const base = { title: a.title || m?.product?.name || null, image: a.image || null, regularCents: Number.isInteger(a.regularCents) ? a.regularCents : null, promoCents: Number.isInteger(a.promoCents) ? a.promoCents : null, url: m?.variant?.url || null };
    const out = { ...base, edited: [], base };
    for (const k of OVERRIDE_FIELDS) if (Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined) { out[k] = o[k]; out.edited.push(k); }
    return out;
  }
  // Sets (or, with an empty value, resets) one page-specific value. Returns a new mapping; throws a readable message for a bad value.
  function setMappingOverride(m, field, value) {
    if (!isMapping(m)) throw new Error('There is no mapping to edit.');
    if (!OVERRIDE_FIELDS.includes(field)) throw new Error('That value can\u2019t be edited.');
    const next = deepCopy(m);
    const o = { ...(next.overrides || {}) };
    const empty = value === undefined || value === null || String(value).trim() === '';
    if (empty) delete o[field];
    else if (field === 'regularCents' || field === 'promoCents') {
      const c = Number.isInteger(value) ? value : toCents(value);
      if (!Number.isInteger(c) || c < 0) throw new Error('Enter a price such as 19.97.');
      o[field] = c;
    } else if (field === 'image' || field === 'url') {
      const u = safeUrl(value);
      if (!u) throw new Error('Enter a full web address starting with http:// or https://.');
      o[field] = u;
    } else o[field] = String(value).replace(/\s+/g, ' ').trim();
    if (Object.keys(o).length) next.overrides = o; else delete next.overrides;
    return next;
  }
  // ---- Changing the variant of a mapping, and approving a replacement
  //
  // A different variant of the same Shopify product is a different SKU as far as the list is concerned. The list's
  // approval (price, title, image, promotional price) belonged to the product the list named, so none of it is carried
  // onto a different SKU: the title and image default to the new variant's, both prices start empty (nothing is invented),
  // and `replacement` records that a person still has to approve it for this card. Approval is about this card's mapping
  // only; the list is not written. Page-specific `overrides` are kept but must be resolved (keep mine / use the new
  // default) before the replacement can be approved.
  const variantRec = (variant) => ({
    variantId: String(variant.variantId), variantGid: variant.variantGid || null, productId: variant.productId != null ? String(variant.productId) : null,
    handle: variant.handle || null, url: variant.url || null, sku: variant.sku || null, productTitle: variant.productTitle || null, variantTitle: variant.variantTitle || null,
    options: (variant.options || []).map((o) => ({ name: o.name, value: o.value })), available: variant.available !== false,
  });
  const variantDefaultTitle = (variant) => [variant.productTitle, variant.variantTitle].filter(Boolean).join(' - ') || null;
  const replacementPending = (m) => !!m && (m.replacement ? m.replacement.status === 'pending' : m.state?.identity === 'substitute-pending');
  const overrideConflicts = (m) => (replacementPending(m) ? Object.keys((m && m.overrides) || {}) : []);

  // Stale flavor-specific defaults must not survive onto another SKU.
  function applyReplacementDefaults(next, variant, fromSku) {
    const a = next.approved || {};
    next.approved = { ...a, title: variantDefaultTitle(variant) || a.title || null, titleEdited: false, image: variant.image || null, imageEdited: false, regularCents: null, regularSource: null, promoCents: null, promoSource: null };
    next.reference = { ...(next.reference || {}), smpCents: null, shopifyCents: Number.isInteger(variant.priceCents) ? variant.priceCents : null, compareAtCents: Number.isInteger(variant.compareAtCents) ? variant.compareAtCents : null };
    next.replacement = { status: 'pending', fromSku: fromSku || null, toSku: variant.sku || null, at: Date.now() };
    const why = `Substitution: the selected variant is SKU ${variant.sku || 'none'}, the list says ${next.product.sku || 'no SKU'}.`;
    next.state = { ...(next.state || {}), identity: 'substitute-pending', shopifySku: variant.sku || null, approval: 'pending', settled: false, needsReview: true, priceStatus: null, promoWarnings: [],
      reasons: [...(next.state?.reasons || []).filter((r) => !/^Substitution|^Variant changed/.test(r)), why] };
    return next;
  }
  function ensureReplacement(m) {
    if (!m.variant || m.replacement || m.state?.identity !== 'substitute-pending') return m;
    const v = m.variant;
    return applyReplacementDefaults(m, { ...v, image: m.approved?.image && !m.approved?.imageEdited ? m.approved.image : null, priceCents: m.reference?.shopifyCents ?? null, compareAtCents: m.reference?.compareAtCents ?? null }, m.product.sku);
  }

  function changeMappingVariant(m, variant) {
    if (!isMapping(m)) throw new Error('There is no mapping to edit.');
    if (!variant || variant.variantId == null) throw new Error('Choose a variant.');
    const next = deepCopy(m);
    const cur = next.variant;
    if (cur && String(cur.variantId) === String(variant.variantId)) return next;
    const prevSku = cur?.sku || next.product.sku || null;
    next.variant = variantRec(variant);
    next.variantChangedAt = Date.now();
    const substitute = !!next.product.sku && !skuEq(next.product.sku, variant.sku);
    if (substitute) return applyReplacementDefaults(next, variant, prevSku);
    // The list's own SKU on another variant id: still not the variant the list's approval was for.
    next.approved = { ...(next.approved || {}), regularCents: null, regularSource: null };
    next.reference = { ...(next.reference || {}), shopifyCents: Number.isInteger(variant.priceCents) ? variant.priceCents : null, compareAtCents: Number.isInteger(variant.compareAtCents) ? variant.compareAtCents : null };
    delete next.replacement;
    next.state = { ...(next.state || {}), identity: 'exact', shopifySku: variant.sku || null, approval: 'pending', settled: false, needsReview: true, priceStatus: null, verification: 'verified',
      reasons: [...(next.state?.reasons || []).filter((r) => !/^Substitution|^Variant changed/.test(r)), 'Regular price for this variant isn’t approved.'] };
    return next;
  }

  // The explicit confirmation for this card. Page-specific values that were set before the replacement must each be
  // resolved: 'keep' (still intended for the new variant) or 'default' (drop mine, use the new variant's default).
  function approveMappingReplacement(m, { resolutions = {}, now = Date.now() } = {}) {
    if (!isMapping(m)) throw new Error('There is no mapping to approve.');
    if (!replacementPending(m)) throw new Error('This card has no replacement waiting for approval.');
    const next = deepCopy(m);
    const keys = Object.keys(next.overrides || {});
    const res = { ...((next.replacement && next.replacement.resolved) || {}), ...resolutions };
    const open = keys.filter((k) => res[k] !== 'keep' && res[k] !== 'default');
    if (open.length) throw new Error(`Decide what to do with your page-specific ${open.join(', ')} first.`);
    const resolved = {};
    for (const k of keys) { resolved[k] = res[k]; if (res[k] === 'default') delete next.overrides[k]; }
    if (next.overrides && !Object.keys(next.overrides).length) delete next.overrides;
    const rep = next.replacement || { fromSku: next.product.sku || null, toSku: next.variant?.sku || null };
    next.replacement = { ...rep, status: 'approved', approvedAt: now, resolved };
    const regular = Number.isInteger(next.approved?.regularCents);
    next.state = { ...(next.state || {}), identity: 'substitute-approved', needsReview: !regular,
      reasons: [...(next.state?.reasons || []).filter((r) => !/^Substitution|^Variant changed|^Regular price/.test(r)), ...(regular ? [] : ['Regular price for the replacement isn’t approved.'])] };
    return next;
  }

  // The mapping a person ends up with after choosing a product (and optionally a variant) for a card. Built from the list
  // record and the chosen variant only; the list is read, never written. With `approve`, a pending replacement is approved
  // in the same step (it is the final explicit confirmation).
  function buildSelectionMapping(lib, key, { variant = null, approve = false, current = null, resolutions = {}, card = null, origin = 'manual', now = Date.now() } = {}) {
    let next = productMappingSnapshot(lib, key, { origin, card, now });
    if (variant && !(next.variant && String(next.variant.variantId) === String(variant.variantId))) next = changeMappingVariant(next, variant);
    else next = ensureReplacement(next);
    const sameProduct = current && current.product && current.product.key === next.product.key && current.list && current.list.id === next.list.id && (current.list.store || '') === (next.list.store || '');
    if (sameProduct && current.overrides) next.overrides = deepCopy(current.overrides);
    if (current && current.fields) next.fields = deepCopy(current.fields); // page elements belong to the card, not to the product
    if (approve && replacementPending(next)) next = approveMappingReplacement(next, { resolutions, now });
    return next;
  }

  // The list's current values for this product, adopted on purpose (after a drift warning). Page-specific values stay.
  function adoptListValues(lib, m) {
    if (!isMapping(m)) throw new Error('There is no mapping.');
    const next = ensureReplacement(productMappingSnapshot(lib, m.product.key, { origin: m.origin, card: m.card || null }));
    if (m.overrides) next.overrides = deepCopy(m.overrides);
    if (m.fields) next.fields = deepCopy(m.fields);
    return next;
  }

  // One honest status for a saved mapping: is the product identity approved, and are the prices intended for display?
  // A page-specific price is a display value, never an approval.
  function mappingStatus(m) {
    const st = (m && m.state) || {};
    const a = (m && m.approved) || {};
    const identity = replacementPending(m) ? 'pending' : st.identity === 'substitute-approved' || (m && m.replacement && m.replacement.status === 'approved') ? 'approved' : 'exact';
    const regularApproved = Number.isInteger(a.regularCents);
    let label;
    let tone;
    if (identity === 'pending') { label = 'Replacement approval required'; tone = 'warn'; }
    else if (identity === 'approved') { label = regularApproved ? 'Replacement approved' : 'Replacement approved · regular price not approved'; tone = regularApproved ? 'ok' : 'warn'; }
    else if (!regularApproved) { label = st.verification === 'verified' ? 'Regular price not approved' : 'Not verified · regular price not approved'; tone = 'warn'; }
    else { label = st.verification === 'verified' ? 'Verified' : 'Not verified (values from the list)'; tone = st.verification === 'verified' ? 'ok' : ''; }
    // Approval on its own (never the Shopify check or whether anything is saved).
    const approval = identity === 'pending' ? { tone: 'warn', label: 'Replacement approval required' }
      : identity === 'approved' ? { tone: regularApproved ? 'ok' : 'warn', label: regularApproved ? 'Replacement approved' : 'Replacement approved \u00b7 regular price not approved' }
      : regularApproved ? { tone: 'ok', label: 'Product approved' } : { tone: 'warn', label: 'Regular price not approved' };
    return { identity, regularApproved, label, tone, approval, full: identity !== 'pending' && regularApproved };
  }

  // The saved mapping against the list record it came from, right now. Read-only; it never applies the list's newer values.
  // Only a change to the LIST'S OWN record counts: the comparison is against what the list said when this was mapped
  // (`libraryRef.baseline`), so choosing another variant for the card is never reported as drift.
  // state: 'current' | 'changed' | 'list-missing' | 'product-missing'
  const baselineOf = (m) => {
    const b = m.libraryRef && m.libraryRef.baseline;
    if (b) return b;
    if (m.variantChangedAt || m.replacement) return null; // saved before baselines existed and then changed on purpose: nothing trustworthy to compare
    return { variantId: m.variant ? String(m.variant.variantId) : null, approval: m.state?.approval ?? null, identity: m.state?.identity ?? null, regularCents: m.approved?.regularCents ?? null, promoCents: m.approved?.promoCents ?? null, title: m.approved?.title ?? null };
  };
  function mappingCheck(lib, m) {
    if (!isMapping(m)) return { state: 'current', notes: [] };
    const name = m.list?.name || m.list?.id || 'the list';
    if (!lib) return { state: 'list-missing', notes: [`The list “${name}” isn’t saved in this browser. The saved values are shown.`] };
    const row = buildRows(lib).find((r) => r.key === m.product.key);
    if (!row) return { state: 'product-missing', notes: [`“${m.product.name || m.product.key}” is no longer in “${name}”. The saved values are shown.`] };
    const b = baselineOf(m);
    const notes = [];
    if (b) {
      const cur = row.prices.currency || m.approved?.currency || undefined;
      const money = (c) => (Number.isInteger(c) ? fmt(c, cur) : 'none');
      const nowVid = row.variant ? String(row.variant.variantId) : null;
      if ((b.variantId ?? null) !== nowVid) notes.push(`Variant id in the list: ${b.variantId || 'none'} → ${nowVid || 'none'}.`);
      if ((b.regularCents ?? null) !== (row.prices.approvedCents ?? null)) notes.push(`Approved regular price: ${money(b.regularCents)} → ${money(row.prices.approvedCents)}.`);
      if ((b.promoCents ?? null) !== (row.prices.promoCents ?? null)) notes.push(`Promotional price: ${money(b.promoCents)} → ${money(row.prices.promoCents)}.`);
      if ((b.approval ?? null) !== row.approval) notes.push(`Approval: ${b.approval || 'none'} → ${row.approval}.`);
      if ((b.identity ?? null) !== row.identity.state) notes.push(`Variant identity: ${b.identity || 'none'} → ${row.identity.state}.`);
      if ((b.title ?? null) !== (row.display.title || null)) notes.push(`Title: “${b.title || ''}” → “${row.display.title || ''}”.`);
    }
    return { state: notes.length ? 'changed' : 'current', notes };
  }

  // Read-only check of the mapped variant against the store (`product` is the driver's /products/<handle>.js result, or
  // null when the store no longer has it). It says what it found; it approves nothing and overwrites nothing.
  function shopifyCheck(m, product) {
    if (!isMapping(m)) return { state: 'skipped', notes: [] };
    const v = m.variant;
    if (!v) return { state: 'skipped', notes: ['No Shopify variant is mapped for this card.'] };
    if (!product) return { state: 'missing', notes: [`The store no longer has the product “${v.handle || v.productId || ''}”.`] };
    const now = (product.variants || []).find((x) => String(x.variantId) === String(v.variantId));
    if (!now) return { state: 'missing', notes: [`Variant id ${v.variantId} is no longer on “${product.title || v.handle}”.`] };
    const cur = m.approved?.currency || now.currency || undefined;
    const notes = [];
    if ((v.sku || null) !== (now.sku || null)) notes.push(`SKU: ${v.sku || 'none'} → ${now.sku || 'none'}.`);
    if (v.available !== false && now.available === false) notes.push('The variant is sold out in Shopify now.');
    if (v.available === false && now.available !== false) notes.push('The variant is available in Shopify now.');
    const saved = m.reference?.shopifyCents;
    if (Number.isInteger(saved) && Number.isInteger(now.priceCents) && saved !== now.priceCents) notes.push(`Shopify price: ${fmt(saved, cur)} → ${fmt(now.priceCents, cur)}.`);
    const ap = m.approved?.regularCents;
    if (Number.isInteger(ap) && Number.isInteger(now.priceCents) && ap !== now.priceCents) notes.push(`Approved regular price ${fmt(ap, cur)} differs from Shopify’s ${fmt(now.priceCents, cur)}.`);
    const opts = (now.options || []).map((o) => o.value).join(', ') || now.variantTitle || '';
    return { state: notes.length ? 'changed' : 'ok', notes, found: { variantId: String(now.variantId), sku: now.sku || null, available: now.available !== false, priceCents: now.priceCents ?? null, options: opts } };
  }

  // Products matching what was typed: every word must appear in the name, SKU, display title or variant SKU/options.
  function searchRows(rows, text, limit = 40) {
    const words = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (r) => [r.name, r.sku, r.display?.title, r.variant?.sku, r.variant?.variantTitle, ...(r.variant?.options || []).map((o) => o.value)].filter(Boolean).join(' ').toLowerCase();
    const out = words.length ? rows.filter((r) => { const h = hay(r); return words.every((w) => h.includes(w)); }) : rows.slice();
    out.sort((a, b) => (skuEq(a.sku, text) ? -1 : 0) - (skuEq(b.sku, text) ? -1 : 0));
    return out.slice(0, limit);
  }

  // ---- M4: the card's page elements (fields) and the discount they imply
  //
  // `fields` sits beside `overrides` on the mapping: { v: 1, items: { title, image, sale, regular, badge, cta, link } },
  // each item `{ state: 'confirmed' | 'unmapped', source, how, ref, detected, at }`. `ref` is how the element is found again
  // (see cards.js: path, tag, classes, fingerprint, optional unique attribute), relative to the card, never to the page.
  // 'confirmed' means a person accepted, chose or picked that element; 'unmapped' means they said the card has none.
  // A suggestion that was never accepted is not stored. Assigning an element changes no value: prices, title and link
  // are still the approved values and the page-specific overrides above. None of this touches the list, the imported
  // file, the store or the variant.
  const FIELD_KEYS = ['title', 'image', 'sale', 'regular', 'badge', 'cta', 'link'];
  const FIELD_LABELS = { title: 'Title', image: 'Image', sale: 'Sale price', regular: 'Regular price', badge: 'Discount badge', cta: 'Add to Cart button', link: 'Product link' };
  const fieldItems = (m) => {
    const it = m && m.fields && typeof m.fields === 'object' && m.fields.items && typeof m.fields.items === 'object' ? m.fields.items : {};
    const out = {};
    for (const k of FIELD_KEYS) if (it[k] && typeof it[k] === 'object' && (it[k].state === 'confirmed' || it[k].state === 'unmapped')) out[k] = it[k];
    return out;
  };
  // Assigns (or, with null, forgets) one field. Returns a new mapping.
  function setFieldAssignment(m, key, a, { now = Date.now() } = {}) {
    if (!isMapping(m)) throw new Error('There is no mapping to edit.');
    if (!FIELD_KEYS.includes(key)) throw new Error('That field can’t be mapped.');
    const next = deepCopy(m);
    const items = { ...fieldItems(next) };
    if (a == null) delete items[key];
    else if (a.state === 'confirmed' && items[key]?.state === 'confirmed' && JSON.stringify(items[key].ref) === JSON.stringify(a.ref)) { /* the same element again: nothing changes */ }
    else if (a.state === 'unmapped' && items[key]?.state === 'unmapped') { /* already so */ }
    else {
      if (a.state !== 'confirmed' && a.state !== 'unmapped') throw new Error('Unknown field state.');
      if (a.state === 'confirmed' && !(a.ref && typeof a.ref === 'object' && typeof a.ref.tag === 'string')) throw new Error('A confirmed field needs the element it points to.');
      items[key] = a.state === 'unmapped'
        ? { state: 'unmapped', source: 'person', at: now }
        : { state: 'confirmed', source: a.source || 'suggested', how: a.how || null, ref: deepCopy(a.ref), detected: deepCopy(a.detected || null), at: now };
    }
    const ordered = {};
    for (const k of FIELD_KEYS) if (items[k]) ordered[k] = items[k];
    if (Object.keys(ordered).length) next.fields = { v: 1, items: ordered }; else delete next.fields;
    return next;
  }

  // Whole-number percent off, from integer cents: ((regular - sale) / regular) * 100, rounded half up. null when either
  // price is missing or invalid, or when the sale price is higher than the regular price. Never inferred from a badge.
  function discountPercent(regularCents, saleCents) {
    if (!Number.isInteger(regularCents) || !Number.isInteger(saleCents) || regularCents <= 0 || saleCents < 0 || saleCents > regularCents) return null;
    return Math.floor(((regularCents - saleCents) * 200 + regularCents) / (2 * regularCents));
  }
  // The discount the approved (and page-specific) prices give, and whether a displayed badge agrees. `badge` is what the
  // page shows ({ kind: 'percent', percent } or { kind: 'amount', cents }), or null.
  function discountInfo(m, badge = null) {
    const ev = effectiveValues(m);
    const regularCents = ev.regularCents; const saleCents = ev.promoCents;
    const percent = discountPercent(regularCents, saleCents);
    let why = null;
    if (percent === null) {
      why = !Number.isInteger(regularCents) ? 'no approved regular price' : !Number.isInteger(saleCents) ? 'no approved sale price' : 'the sale price is not lower than the regular price';
    }
    let discrepancy = null;
    let badgeNote = null;
    if (badge) {
      if (badge.placeholder) badgeNote = 'the badge is a placeholder with no number yet';
      else if (percent === null) badgeNote = 'the badge can’t be checked without both approved prices';
      else if (badge.kind === 'percent' && Number.isInteger(badge.percent)) { if (badge.percent !== percent) discrepancy = `the badge says ${badge.percent}% off but the approved prices give ${percent}%`; }
      else if (badge.kind === 'amount' && Number.isInteger(badge.cents)) { const diff = regularCents - saleCents; if (badge.cents !== diff) discrepancy = `the badge says ${fmt(badge.cents, m.approved?.currency || undefined)} off but the approved prices differ by ${fmt(diff, m.approved?.currency || undefined)}`; }
    }
    return { regularCents: Number.isInteger(regularCents) ? regularCents : null, saleCents: Number.isInteger(saleCents) ? saleCents : null, percent, why, discrepancy, badgeNote };
  }

  // What the card should display, from the effective (approved + page-specific) values. `single`: the card shows one price
  // element. A promotional price is the displayed price where there is one; the regular price only when there is no sale.
  // These are display values from the list: they never say what a checkout charges.
  function displayPrice(m, { single = null } = {}) {
    const ev = effectiveValues(m);
    const cur = m?.approved?.currency || undefined;
    const money = (c) => (Number.isInteger(c) ? fmt(c, cur) : null);
    const sale = Number.isInteger(ev.promoCents) && (!Number.isInteger(ev.regularCents) || ev.promoCents < ev.regularCents) ? ev.promoCents : null;
    const reg = Number.isInteger(ev.regularCents) ? ev.regularCents : null;
    if (sale !== null) {
      if (single === true) return { mode: 'single-sale', current: money(sale), regular: money(reg), text: `show **${money(sale)}** (the sale price) as the only price. The regular price ${reg !== null ? money(reg) : '(not approved)'} is not shown on this card` };
      if (single === false && reg !== null) return { mode: 'dual', current: money(sale), regular: money(reg), text: `current price **${money(sale)}** (sale), struck-through regular price **${money(reg)}**` };
      return { mode: 'sale', current: money(sale), regular: money(reg), text: `the sale price **${money(sale)}** is the displayed (current) price${reg !== null ? `; where the card also has a struck-through price it is the regular ${money(reg)}` : ''}. A card with one price shows the sale price, not the regular price` };
    }
    if (reg !== null) return { mode: 'regular', current: money(reg), regular: money(reg), text: `show **${money(reg)}** (approved regular price; there is no sale price)` };
    return { mode: 'none', current: null, regular: null, text: 'no approved price: leave the price as it is and flag it for review' };
  }
  // Does the market-facing category/label text still fit the assigned product? Only a hint: a word of the label has to
  // appear in the product's name, variant or handle to count as consistent.
  function labelFits(label, m) {
    const hay = [m?.product?.name, m?.approved?.title, m?.variant?.title, m?.variant?.variantTitle, m?.variant?.handle, ...(m?.variant?.options || []).map((o) => o.value)].join(' ').toLowerCase();
    const words = String(label).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    return words.some((w) => hay.includes(w));
  }

  // Report lines from LIVE targets (cards.js exportFields): one line per field with where it is, how sure Blueline is,
  // and the value that goes there. Missing or ambiguous fields are named for review; no selector is ever invented.
  function targetReportLines(m, targets, { cart = false } = {}) {
    const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';
    const ev = effectiveValues(m);
    const cur = m.approved?.currency || undefined;
    const money = (c) => (Number.isInteger(c) ? fmt(c, cur) : null);
    const F = targets.fields || {};
    const priceBasis = (k) => F[k] && (F[k].basis === 'confirmed' || F[k].basis === 'detected');
    const single = priceBasis('sale') !== priceBasis('regular') ? true : priceBasis('sale') && priceBasis('regular') ? false : null;
    const dp = displayPrice(m, { single });
    const baseLabel = { confirmed: 'confirmed by you', detected: 'detected by Blueline, not confirmed' };
    const where = (loc) => {
      if (!loc) return '';
      if (loc.self) return 'the card element itself';
      if (loc.wrapper) return 'the link around the card';
      return (loc.sel ? `${code(loc.sel)} within the card` : `${code(':scope > ' + loc.path)} within the card`);
    };
    const ctx = (loc) => (loc && loc.fragile ? ` **Fragile** (${loc.fragileWhy}). Find it by its markup ${code(loc.snippet)} inside ${loc.parent === 'outside the card' ? 'the wrapping element' : code(loc.parent)}.` : '');
    const L = ['  - Fields in this card (where each value goes). **confirmed** = you assigned it in Product Mapping; **detected** = found by Blueline, never confirmed, so verify it; selectors are relative to the card:'];
    const review = [];
    const val = (k, x) => {
      if (k === 'title') return ev.title ? `set to “${ev.title}”` : null;
      if (k === 'image') return ev.image ? (x && x.loc && x.loc.tag === 'img' ? `set src to ${code(ev.image)} (alt: the product title)` : `put the product image ${code(ev.image)} in it; it is a placeholder or container (<${x && x.loc ? x.loc.tag : 'element'}>), not an <img>, so keep its size and styling`) : null;
      if (k === 'link') return ev.url ? `set the address to ${code(ev.url)}${x && x.loc && x.loc.sharesCta ? '; **this is also the Add to Cart control: don’t turn the cart control into a product link**' : ''}` : null;
      if (k === 'sale') return dp.mode === 'regular' && single !== false ? `show ${dp.current}` : dp.current ? (single === false ? `show ${dp.current} (current price)` : `show ${dp.current}${single === true ? ' (the only price on this card)' : ''}`) : null;
      if (k === 'regular') return dp.regular ? (dp.mode === 'regular' ? `show ${dp.regular}` : `show ${dp.regular} (struck-through regular price)`) : null;
      if (k === 'badge') {
        const d = discountInfo(m, x?.value?.badge || null);
        if (d.percent === null) return null;
        const hasOff = /off/i.test(x?.value?.text || '');
        return `set to ${code(d.percent + '%' + (hasOff ? ' OFF' : ''))}, calculated from regular ${money(d.regularCents)} and sale ${money(d.saleCents)}${d.discrepancy ? `; **mismatch:** ${d.discrepancy}` : ''}`;
      }
      if (k === 'cta') return cart ? (m.variant ? `this is the card’s intended Add to Cart control: wire it to variant id ${code(m.variant.variantId)} (see Add to Cart instructions), keep its label and styling, and don’t also make it a product-page link` : 'intended Add to Cart control, but no variant is recorded: do not invent an id') : 'leave its existing behavior unchanged';
      return null;
    };
    for (const k of FIELD_KEYS) {
      const x = F[k];
      if (!x) continue;
      const label = FIELD_LABELS[k];
      if (x.basis === 'unmapped') { L.push(`    - ${label}: not on this card (you marked it so)`); continue; }
      if (x.basis === 'confirmed' || x.basis === 'detected') {
        const v = val(k, x);
        const seen = x.value && (x.value.href || x.value.src || x.value.text);
        const conf = x.basis === 'detected' ? `${baseLabel.detected}${x.confidence ? `, ${x.confidence} confidence` : ''}` : baseLabel.confirmed;
        let line = `    - ${label} [${conf}]: ${where(x.loc)}`;
        if (seen) line += `; shows “${String(seen).slice(0, 60)}”`;
        line += v ? ` → ${v}` : k === 'badge' ? ` → **review:** the discount can’t be calculated reliably (${discountInfo(m).why}); don’t invent a percentage` : '';
        line += '.' + ctx(x.loc);
        L.push(line);
        continue;
      }
      if (x.basis === 'review') {
        const cand = (x.candidates || [])[0];
        L.push(`    - ${label} [confirmed earlier, **needs review**]: ${(x.reasons || [])[0] || x.state}${cand ? `; closest match ${where(cand.loc)} ${code(cand.loc.snippet)}` : ''}. Don’t edit until identified.`);
        review.push(label);
        continue;
      }
      if (x.basis === 'ambiguous') {
        L.push(`    - ${label} [**ambiguous**]: ${(x.candidates || []).map((c) => `${where(c.loc)} ${code(c.loc.snippet)}`).join(' or ')}. Blueline could not tell which is right; ask or compare with the screenshot before editing.`);
        review.push(label);
        continue;
      }
      if (k === 'cta') {
        L.push(cart
          ? `    - Add to Cart button: none found on this card. Add to Cart was requested, so this product still needs a cart control${m.variant ? ` using variant id ${code(m.variant.variantId)}` : ''}; where it goes and how it looks is for the developer and designer to decide. Don’t invent one here.`
          : '    - Add to Cart button: none on this card (normal for some designs). Nothing to change.');
        continue;
      }
      if (k === 'link' && x.sharedWithCta) { L.push('    - Product link: no separate link element; the only link is the call-to-action, which is not changed here. The product URL stays as mapping data above.'); continue; }
      if (!(k === 'regular' && dp.mode === 'single-sale') && !(k === 'regular' && dp.mode === 'regular')) { L.push(`    - ${label} [**not identified**]: no element found. No selector is given; check the card by hand.`); review.push(label); }
    }
    for (const lb of targets.labels || []) {
      const fits = labelFits(lb.text, m);
      L.push(`    - Existing label “${lb.text}” (${lb.loc.sel ? code(lb.loc.sel) + ' within the card' : code(':scope > ' + lb.loc.path)}): ${fits ? 'appears to fit the assigned product' : `**review:** it may belong to the previous product and not fit “${ev.title || m.product.name}”. Change it only if the correct category is known; don’t invent one`}.${ctx(lb.loc)}`);
      if (!fits) review.push(`label “${lb.text}”`);
    }
    if (review.length) L.push(`    - **Review before editing:** ${review.join('; ')}`);
    return L;
  }

  const FIELD_STATE_TEXT = { ok: 'confirmed', moved: 'needs review: it moved', ambiguous: 'needs review: several look-alikes', changed: 'needs review: something else is there now', invalid: 'needs review: it no longer holds this value', missing: 'needs review: not found on the page' };
  // Report lines for the card's mapped page elements. `check` = { items: { key: { state, reasons, value } } } from the page,
  // when it was checked this session; without it the lines say only what was saved. Never claims Add to Cart is wired.
  function fieldReportLines(m, { check = null, targets = null, cart = false } = {}) {
    if (targets) return targetReportLines(m, targets, { cart });
    const items = fieldItems(m);
    if (!Object.keys(items).length) return [];
    const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';
    const ev = effectiveValues(m);
    const cur = m.approved?.currency || undefined;
    const money = (c) => (Number.isInteger(c) ? fmt(c, cur) : null);
    const L = ['  - Page elements in this card (assigned by you in Product Mapping; where each value goes; this page was not re-read, so detected-only fields are not listed):'];
    const approvedOf = { title: ev.title, sale: money(ev.promoCents), regular: money(ev.regularCents), link: ev.url, image: ev.image };
    const unresolved = [];
    const unmapped = [];
    for (const k of FIELD_KEYS) {
      const it = items[k];
      if (!it) continue;
      if (it.state === 'unmapped') { unmapped.push(FIELD_LABELS[k]); continue; }
      const chk = check?.items?.[k];
      const where = it.ref?.path === '^' ? 'the link around the card' : code(it.ref?.sel || it.ref?.path || it.ref?.tag || '?') + ' within the card';
      const state = chk ? (FIELD_STATE_TEXT[chk.state] || chk.state) : 'as saved; not re-checked on the page yet';
      const seen = chk?.value ? (chk.value.href || chk.value.src || chk.value.text) : (it.detected?.href || it.detected?.src || it.detected?.text);
      const approved = approvedOf[k];
      let line = `    - ${FIELD_LABELS[k]}: ${where} (${state})`;
      if (seen) line += `; page ${chk?.value ? 'shows' : 'showed when mapped'} “${String(seen).slice(0, 70)}”`;
      if (approved && seen && (k === 'sale' || k === 'regular' || k === 'title') && String(seen).replace(/\s+/g, ' ').trim() !== String(approved).replace(/\s+/g, ' ').trim()) line += `; approved ${k === 'title' ? '“' + approved + '”' : approved}`;
      L.push(line);
      if (chk && chk.state !== 'ok') unresolved.push(`${FIELD_LABELS[k]} (${(chk.reasons || [])[0] || chk.state})`);
    }
    if (unmapped.length) L.push(`    - Not on this card: ${unmapped.join(', ')}`);
    if (unresolved.length) L.push(`    - **Review before using:** ${unresolved.join('; ')}`);
    const badge = check?.items?.badge?.value?.badge || items.badge?.detected?.badge || null;
    const d = discountInfo(m, badge);
    if (items.sale || items.regular || items.badge) {
      L.push(d.percent !== null
        ? `    - Discount: ${d.percent}% off, from approved regular ${money(d.regularCents)} and sale ${money(d.saleCents)}${(m.overrides && (m.overrides.regularCents != null || m.overrides.promoCents != null)) ? ' (includes this page’s price override)' : ''}${d.discrepancy ? `. **Mismatch:** ${d.discrepancy}` : badge && !badge.placeholder ? '. The page badge agrees' : ''}`
        : `    - Discount: not calculated (${d.why})${d.badgeNote ? `; ${d.badgeNote}` : ''}`);
    }
    return L;
  }

  // The report lines for a saved mapping, from the snapshot only (the report is built synchronously and nothing is
  // re-read from the library or the store). Every line is a bullet; nothing is added that the snapshot doesn't hold, and
  // nothing that doesn't help a developer implement the card (no disclaimers about how the values were gathered).
  function mappingReportLines(m, { check = null, fieldCheck = null, fieldTargets = null, cart = false } = {}) {
    if (!isMapping(m)) return [];
    const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';
    const a = m.approved || {};
    const cur = a.currency || undefined;
    const money = (c) => (Number.isInteger(c) ? fmt(c, cur) : null);
    const v = m.variant || null;
    const st = m.state || {};
    const L = [];
    const list = m.list ? ` from list “${m.list.name || m.list.id}”${m.list.store ? ` (${m.list.store})` : ' (no Shopify store)'}` : '';
    L.push(`- **Product mapping**${m.origin === 'suggested' ? ' (suggested match accepted)' : ''}${list}`);

    const c = m.card;
    if (c && typeof c === 'object') {
      const sec = typeof c.section === 'string' ? c.section : c.section?.heading;
      const bits = [c.selector ? code(c.selector) : '', sec ? `in section “${sec}”` : '', Number.isInteger(c.index) && Number.isInteger(c.count) ? `card ${c.index} of ${c.count}` : '', c.text ? `currently “${String(c.text).slice(0, 60)}”` : ''].filter(Boolean);
      if (bits.length) L.push(`  - Card: ${bits.join(', ')}`);
    }

    const ev = effectiveValues(m);
    const has = (k) => ev.edited.includes(k);
    const title = ev.title || m.product.name || m.product.key;
    const alias = has('title') ? ` (page-specific title; the list calls it “${ev.base.title || m.product.name}”)` : m.product.name && m.product.name !== title && !m.replacement ? ` (the list calls it “${m.product.name}”)` : '';
    L.push(`  - Product: ${title}${alias}${m.product.sku ? ` · list SKU ${code(m.product.sku)}` : ''}`);

    if (v) {
      const opts = (v.options || []).map((o) => o.value).filter(Boolean).join(', ') || v.variantTitle;
      L.push(`  - Shopify: variant id ${code(v.variantId)}${opts ? ` (“${opts}”)` : ''}${v.sku ? `, variant SKU ${code(v.sku)}` : ''}${v.productId ? `, product id ${code(v.productId)}` : ''}${v.handle ? `, handle ${code(v.handle)}` : ''}`);
    } else L.push('  - Shopify: no variant recorded. Don’t invent an id or link.');

    const src = { shopify: 'Shopify price', smp: 'SMP price', custom: 'manual override', match: 'SMP and Shopify agree' };
    const reg = has('regularCents') ? `regular ${money(ev.regularCents)} (page-specific override${Number.isInteger(ev.base.regularCents) ? `; approved ${money(ev.base.regularCents)}` : '; no approved regular price'})`
      : Number.isInteger(a.regularCents)
      ? `regular ${money(a.regularCents)} (approved, ${src[a.regularSource] || 'approved'})`
      : `regular price not approved${m.reference ? ` (${[Number.isInteger(m.reference.smpCents) ? `SMP ${money(m.reference.smpCents)}` : '', Number.isInteger(m.reference.shopifyCents) ? `Shopify ${money(m.reference.shopifyCents)}` : ''].filter(Boolean).join(', ') || 'no price on record'})` : ''}`;
    const promo = has('promoCents') ? `sale ${money(ev.promoCents)} (page-specific override${Number.isInteger(ev.base.promoCents) ? `; list ${money(ev.base.promoCents)}` : ''})`
      : Number.isInteger(a.promoCents) ? `sale ${money(a.promoCents)} (${a.promoSource === 'custom' ? 'manual override' : a.promoSource === 'smp' ? 'SMP promotional price' : 'working price'})` : 'no sale price';
    L.push(`  - Prices: ${reg}, ${promo}`);
    if (ev.edited.some((k) => k === 'regularCents' || k === 'promoCents')) L.push('  - Page-specific prices are display values; they don’t change what Shopify charges at checkout.');
    L.push(`  - Image: ${ev.image ? code(ev.image) : 'none recorded'}${has('image') ? ' (page-specific override)' : ''}`);
    L.push(`  - Link: ${ev.url ? code(ev.url) : 'none recorded'}${has('url') ? ' (page-specific override)' : ''}`);

    // Only what still needs a decision or explains a difference.
    const status = [];
    const ms = mappingStatus(m);
    if (ms.identity === 'pending') status.push(`**replacement not approved** (list SKU ${st.sourceSku || m.product.sku || 'none'}, selected variant SKU ${st.shopifySku || v?.sku || 'none'}); don’t use these values until it is approved`);
    else if (ms.identity === 'approved') status.push(`replacement approved for this card (list SKU ${m.replacement?.fromSku || st.sourceSku || m.product.sku || 'none'} → variant SKU ${st.shopifySku || v?.sku || 'none'})`);
    if (st.verification && !['verified', 'not-verified'].includes(st.verification)) status.push(`not verified in Shopify: ${STATUS_LABEL[st.verification] || st.verification}`);
    const reasons = (st.reasons || []).filter((r) => !/^Substitution|^Variant changed|^Regular price/.test(r));
    if (reasons.length) status.push(`needs review: ${reasons.slice(0, 3).join('; ')}`);
    for (const w of st.promoWarnings || []) status.push(`warning: ${w}`);
    if (status.length) L.push(`  - Status: ${status.join('; ')}`);
    if (check && check.state && check.state !== 'current') for (const n of check.notes || []) L.push(`  - **Warning, the saved list record changed:** ${n}`);

    const both = Number.isInteger(ev.promoCents) && Number.isInteger(ev.regularCents);
    const what = ['title', ev.image ? 'image' : '', both ? 'prices' : Number.isInteger(ev.promoCents) || Number.isInteger(ev.regularCents) ? 'price' : '', ev.url ? 'link' : ''].filter(Boolean);
    const list2 = what.length < 2 ? what.join('') : `${what.slice(0, -1).join(', ')} and ${what[what.length - 1]}`;
    {
      const t = fieldTargets && fieldTargets.fields;
      const pb = (k) => t && t[k] && (t[k].basis === 'confirmed' || t[k].basis === 'detected');
      const dp = displayPrice(m, { single: t ? (pb('sale') !== pb('regular') ? true : pb('sale') && pb('regular') ? false : null) : null });
      L.push(`  - Displayed price: ${dp.text}.`);
    }
    L.push(...fieldReportLines(m, { check: fieldCheck, targets: fieldTargets, cart }));
    L.push(`  - Replace this card’s ${list2} with the values above, keeping its markup and styling.`);
    if (cart) L.push(v ? `  - Add to Cart: implement it for this card with variant id ${code(v.variantId)}${v.productId ? ` (product id ${code(v.productId)}${v.handle ? `, handle ${code(v.handle)}` : ''})` : ''}, following the Add to Cart instructions at the top. Use no other id.` : '  - Add to Cart: no variant is recorded for this card. Don’t invent an id; report it as a blocker.');
    return L;
  }

  // ---- Change Report: page-level guidance (source vs implementation target, Add to Cart)
  // `sources`: [{ url, path }] the pages Blueline inspected. Pure text; nothing here reads the page.
  const isFileUrl = (u) => /^file:/i.test(String(u || ''));
  const filePathOf = (u) => { try { return decodeURIComponent(new URL(u).pathname).replace(/^\/([A-Za-z]:)/, '$1'); } catch { return String(u || ''); } };
  const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
  // A short label for a page: a local file shows only its file name (the full path is given once, in the source section).
  const pageLabel = (url, path) => (isFileUrl(url) ? baseName(filePathOf(url) || path) : path || url || '');
  function sourceTargetLines(sources = []) {
    const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';
    const seen = new Set();
    const L = ['', '## Source page and implementation target'];
    for (const s of sources) {
      const ref = isFileUrl(s.url) ? `${code(filePathOf(s.url))} (a local file opened in Chrome)` : code(s.url || s.path);
      if (seen.has(ref)) continue;
      seen.add(ref);
      L.push(`- **Inspected source page (reference only):** ${ref}. This is what Blueline analyzed in Chrome; the selectors, DOM context and screenshots below describe it.`);
    }
    L.push('- **Implementation target:** the matching HTML, templates or components in the project you have open. It is not necessarily the inspected page, and the path or URL above may not exist on your machine.');
    L.push('- Inspect the current workspace, find the files that render this page, and match the inspected structure (section headings, card markup, classes, text) to them; class names and order may differ from the selectors here. Apply the changes there.');
    L.push('- If more than one file could be the target and you can’t tell which, ask before editing. Never edit the inspected file or URL itself, QA fixtures, or original source documents.');
    return L;
  }
  // Always present when the report holds product mappings. Off by default.
  function cartLines({ on = false, hasVariants = true } = {}) {
    if (!on) return ['', '## Add to Cart', '- Not requested. Don’t add or change cart, checkout or purchase behavior. Variant ids are reference data, or for a cart control a card already has. Prices shown on cards are display values and don’t change what checkout charges.'];
    return [
      '', '## Add to Cart implementation (requested)',
      '- Implement working Add to Cart for the mapped products below that have an exact variant id. Blueline doesn’t assume a platform; the target project decides how.',
      '- A card’s call-to-action that Blueline lists as its Add to Cart control (for example a “SHOP DEAL” button) is the control to wire, even if it is currently a plain link; don’t also turn it into a product-page link. Product URLs are separate mapping data. Cards with no such control are normal: say so, and if one needs a control leave its placement and design to the developer and designer.',
      '  1. Inspect the target project, identify its ecommerce platform and existing cart architecture (cart form, drawer, counter, API calls). Don’t assume Shopify.',
      '  2. Implement behavior compatible with it and preserve existing cart drawers, counters and interactions.',
      '  3. Handle loading, error and unavailable or sold-out variant states.',
      '  4. Use only the exact product and variant ids in each mapping (variant ids are strings; keep them exact). Never invent or guess a missing id.',
      '  5. Never silently change checkout or product prices. The sale prices here are display values from the list; they don’t establish what Shopify or any checkout charges. If the live price differs, report it instead of overriding it.',
      '  6. If the target can’t support working cart operations without more integration (a standalone HTML page, an unknown platform, no backend), don’t fake it: implement what is possible and report the blockers.',
      '- **Shopify theme targets:** use the theme’s own cart mechanism, such as the Ajax Cart API (`POST /cart/add.js` with `{ id: <variant id>, quantity: 1 }`) or the theme’s cart component and section refresh, with the exact variant id from the mapping. A standalone or third-party page can’t call a store’s same-origin Ajax Cart API, and a Shopify product source doesn’t mean the destination uses Shopify checkout.',
      '- **Other targets:** inspect their actual cart implementation; don’t fabricate a generic cart API.',
      ...(hasVariants ? [] : ['- No mapped product in this report has a recorded variant id, so there is nothing to wire; report that as a blocker.']),
    ];
  }

  // ------------------------------------------------------------------ list names (unique, case-insensitive)
  //
  // A list's visible name is a label (its identity is its generated id), but two lists with the same label are
  // indistinguishable in a picker, so names are kept unique: "X", "X (2)", "X (3)". Comparison trims and ignores case.
  const nameKey = (s) => String(s ?? '').trim().toLowerCase();
  const cleanListName = (s) => String(s ?? '').trim();
  // `taken`: the other lists' names. Returns `name` itself when free, otherwise the first free "name (n)".
  function uniqueListName(name, taken) {
    const base = cleanListName(name) || 'Untitled list';
    const used = new Set((taken || []).map(nameKey));
    if (!used.has(nameKey(base))) return base;
    for (let n = 2; ; n++) { const c = `${base} (${n})`; if (!used.has(nameKey(c))) return c; }
  }
  // Pure and deterministic: lists are visited oldest first (then by id); the first keeps its name, later ones that
  // collide get the next free suffix. Names that are already unique are untouched, so running it again changes nothing.
  // entries: [{ store, campaign, name, createdAt }] -> [{ store, campaign, from, to }] for the ones to rename.
  function reconcileNames(entries) {
    const order = [...entries].sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0) || (x.campaign < y.campaign ? -1 : x.campaign > y.campaign ? 1 : 0) || (x.store < y.store ? -1 : x.store > y.store ? 1 : 0));
    const seen = new Set();
    const out = [];
    for (const e of order) {
      const cur = cleanListName(e.name);
      if (cur && !seen.has(nameKey(cur))) { seen.add(nameKey(cur)); if (cur !== e.name) out.push({ store: e.store, campaign: e.campaign, from: e.name, to: cur }); continue; }
      const to = uniqueListName(cur || 'Untitled list', [...seen]);
      seen.add(nameKey(to));
      out.push({ store: e.store, campaign: e.campaign, from: e.name, to });
    }
    return out;
  }


  const K_INDEX = 'blueline:lib:index';
  const libId = (store, campaign) => `${store}|${campaign}`;
  const kSmp = (store, campaign) => `blueline:lib:smp:${libId(store, campaign)}`;
  const kWork = (store, campaign) => `blueline:lib:work:${libId(store, campaign)}`;
  const campaignId = (name) => slug(name) || 'default'; // how Pass 1 named lists; kept to read libraries saved then

  // A list's identity is a generated id, never its name: renaming a list changes only the label. (The stored field is
  // still called `campaign`, as in Pass 1, so libraries saved then keep working without a rewrite; for those the id
  // is the old name-derived slug, which is just an opaque id from now on.)
  function newListId() {
    const bytes = new Uint8Array(6);
    (globalThis.crypto || { getRandomValues: (b) => b.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(bytes);
    return `l-${[...bytes].map((b) => b.toString(36).padStart(2, '0')).join('')}`;
  }
  // "Black Friday SMP - 2026.docx" -> "Black Friday SMP - 2026"
  const defaultListName = (fileName) => String(fileName || '').replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || null;
  const listName = (lib) => (lib && lib.name) || lib?.smp?.imports?.[0]?.campaign?.name || 'Untitled list';
  const newLibrary = (store, name) => ({ store, campaign: newListId(), name: name || null, smp: { v: 1, imports: [] }, work: emptyWork() });
  const isPristine = (lib) => !lib.smp.imports.length && !lib.work.updatedAt && !Object.keys(lib.work.manualProducts || {}).length;

  // `storage` has chrome.storage.local's shape: get(keys) / set(obj) / remove(keys), all promises.
  async function loadIndex(storage) {
    const idx = (await storage.get(K_INDEX))[K_INDEX];
    return idx && Array.isArray(idx.libs) ? idx : { v: 1, libs: [], active: {} };
  }
  async function loadLibrary(storage, store, campaign) {
    const r = await storage.get([kSmp(store, campaign), kWork(store, campaign)]);
    const entry = (await loadIndex(storage)).libs.find((l) => l.store === store && l.campaign === campaign);
    const smp = r[kSmp(store, campaign)] || { v: 1, imports: [] };
    const name = entry?.name && entry.name !== campaign ? entry.name : smp.imports?.[0]?.campaign?.name || entry?.name || null;
    return { store, campaign, name, smp, work: { ...emptyWork(), ...(r[kWork(store, campaign)] || {}) } };
  }
  // The list's name rides along with every save (it lives in the index, not in the immutable import).
  async function saveLibrary(storage, lib, { smpChanged = false, name, touch = true } = {}) {
    const out = { [kWork(lib.store, lib.campaign)]: lib.work };
    if (smpChanged) out[kSmp(lib.store, lib.campaign)] = lib.smp;
    const idx = await loadIndex(storage);
    const at = Date.now();
    let label = name || lib.name || lib.campaign;
    if (label === lib.campaign && lib.smp?.imports?.[0]?.campaign?.name) label = lib.smp.imports[0].campaign.name; // an id is not a name
    const entry = idx.libs.find((l) => l.store === lib.store && l.campaign === lib.campaign);
    // Names stay unique across saved lists; a list keeps its own name when it is already the one stored.
    if (!entry || entry.name !== label) label = uniqueListName(label, idx.libs.filter((l) => l !== entry).map((l) => l.name));
    if (entry) { if (touch) entry.updatedAt = at; entry.name = label; if (!entry.createdAt) entry.createdAt = firstImportAt(lib) || at; } else idx.libs.push({ store: lib.store, campaign: lib.campaign, name: label, createdAt: firstImportAt(lib) || at, updatedAt: at });
    out[K_INDEX] = idx;
    await storage.set(out);
    return { name: label };
  }
  // Renaming touches only the label.
  async function renameLibrary(storage, store, campaign, name) {
    const idx = await loadIndex(storage);
    const entry = idx.libs.find((l) => l.store === store && l.campaign === campaign);
    if (!entry) return false;
    entry.name = uniqueListName(name, idx.libs.filter((l) => l !== entry).map((l) => l.name)); entry.updatedAt = Date.now();
    await storage.set({ [K_INDEX]: idx });
    return true;
  }
  // The label a saved list ended up with (after the uniqueness rule), or null.
  async function listLabel(storage, store, campaign) {
    const e = (await loadIndex(storage)).libs.find((l) => l.store === store && l.campaign === campaign);
    return e ? e.name : null;
  }
  // Makes the saved lists' names unique, once, deterministically (see reconcileNames). Only the label in the index is
  // written, and only for lists that collide: ids, imports, corrections, approvals, settings and the mappings that point
  // at a list id are untouched. A list whose label is still its raw id is judged by the name it shows (its first import).
  async function reconcileListNames(storage) {
    const idx = await loadIndex(storage);
    const entries = [];
    for (const e of idx.libs) {
      let name = e.name;
      if (!name || name === e.campaign) { const smp = (await storage.get(kSmp(e.store, e.campaign)))[kSmp(e.store, e.campaign)]; name = smp?.imports?.[0]?.campaign?.name || name || e.campaign; }
      entries.push({ store: e.store, campaign: e.campaign, name, createdAt: e.createdAt || e.updatedAt || 0 });
    }
    const changes = reconcileNames(entries);
    let changed = false;
    for (const c of changes) {
      const e = idx.libs.find((l) => l.store === c.store && l.campaign === c.campaign);
      if (e && e.name !== c.to) { e.name = c.to; changed = true; }
    }
    if (changed) await storage.set({ [K_INDEX]: idx });
    return changes.filter((c) => c.from !== c.to);
  }
  // Attaching (or changing) a list's store moves its two records to the new keys and updates the index. Only ever
  // done on purpose, for one list: lists are never merged.
  async function moveLibrary(storage, lib, newStore) {
    if (newStore === lib.store) return lib;
    const moved = { ...lib, store: newStore };
    await storage.set({ [kSmp(newStore, lib.campaign)]: moved.smp, [kWork(newStore, lib.campaign)]: moved.work });
    await storage.remove([kSmp(lib.store, lib.campaign), kWork(lib.store, lib.campaign)]);
    const idx = await loadIndex(storage);
    const entry = idx.libs.find((l) => l.store === lib.store && l.campaign === lib.campaign);
    if (entry) entry.store = newStore; else idx.libs.push({ store: newStore, campaign: lib.campaign, name: lib.name || lib.campaign, createdAt: firstImportAt(lib) || Date.now(), updatedAt: Date.now() });
    for (const a of Object.values(idx.active)) if (a.store === lib.store && a.campaign === lib.campaign) a.store = newStore;
    await storage.set({ [K_INDEX]: idx });
    return moved;
  }
  const firstImportAt = (lib) => [...(lib.smp?.imports || []), ...(lib.smp?.replaced || [])].map((i) => i.importedAt).filter(Boolean).sort((a, b) => a - b)[0] || null;

  // One entry per saved list for the List Manager: identity, original creation time, store, counts, whether it holds
  // the person's own work, and which other lists were imported from the same source file (by hash). Read-only apart
  // from filling in `createdAt` on lists saved before it existed (derived from their first import, so it never changes).
  // Sorted by creation time, then id: opening or editing a list never moves it.
  async function listSummaries(storage) {
    const idx = await loadIndex(storage);
    let changed = false;
    const out = [];
    for (const e of idx.libs) {
      const lib = await loadLibrary(storage, e.store, e.campaign);
      if (!e.createdAt) { e.createdAt = firstImportAt(lib) || e.updatedAt || Date.now(); changed = true; }
      const rows = buildRows(lib);
      const sm = summarize(rows);
      const w = lib.work;
      const corrections = {
        approvedPrices: Object.keys(w.decisions || {}).length,
        edits: Object.keys(w.edits || {}).length,
        manualProducts: Object.keys(w.manualProducts || {}).length,
        manualChoices: rows.filter((r) => r.origin === 'smp' && r.match?.method === 'manual').length,
        approvedSubstitutions: rows.filter((r) => r.identity.state === 'substitute-approved').length,
      };
      const imps = [...(lib.smp.imports || []), ...(lib.smp.replaced || [])];
      out.push({ store: e.store, campaign: e.campaign, name: listName(lib), createdAt: e.createdAt, updatedAt: e.updatedAt || null, products: rows.length, needsReview: sm.needsReview, substitutions: sm.substitutions, corrections, hasCorrections: Object.values(corrections).some((n) => n > 0), hashes: imps.map((i) => i.source?.sha256).filter(Boolean), files: imps.map((i) => i.source?.fileName).filter(Boolean) });
    }
    if (changed) await storage.set({ [K_INDEX]: idx });
    for (const a of out) a.duplicates = out.filter((b) => b !== a && b.hashes.some((h) => a.hashes.includes(h))).map((b) => ({ store: b.store, campaign: b.campaign, name: b.name }));
    // "First imported" = saved earliest among lists that share a source file. It says nothing about which one is most correct.
    const earlier = (b, a) => b.createdAt < a.createdAt || (b.createdAt === a.createdAt && b.campaign < a.campaign);
    for (const a of out) { const same = out.filter((b) => b !== a && b.hashes.some((h) => a.hashes.includes(h))); a.sameSource = same.length > 0; a.firstImported = same.length > 0 && !same.some((b) => earlier(b, a)); }
    return out.sort((a, b) => a.createdAt - b.createdAt || (a.campaign < b.campaign ? -1 : a.campaign > b.campaign ? 1 : 0));
  }
  const listsForStore = (idx, store) => idx.libs.filter((l) => l.store === store).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  // Which library a page was last using. Keyed by the page's own origin so another site never inherits it.
  async function setActive(storage, pageOrigin, store, campaign) {
    const idx = await loadIndex(storage);
    idx.active = { ...idx.active, [pageOrigin]: { store, campaign } };
    await storage.set({ [K_INDEX]: idx });
  }
  async function getActive(storage, pageOrigin) { return (await loadIndex(storage)).active[pageOrigin] || null; }
  async function deleteLibrary(storage, store, campaign) {
    await storage.remove([kSmp(store, campaign), kWork(store, campaign)]);
    const idx = await loadIndex(storage);
    idx.libs = idx.libs.filter((l) => !(l.store === store && l.campaign === campaign));
    for (const [k, a] of Object.entries(idx.active)) if (a.store === store && a.campaign === campaign) delete idx.active[k];
    await storage.set({ [K_INDEX]: idx });
  }

  // Adds an import without touching earlier ones. Importing the same file again is a no-op.
  // "Replace" an upload: the new import becomes the list's content; the earlier import is kept, untouched, under
  // `smp.replaced` (never deleted). Corrections made to products that still exist in the new import stay attached.
  function replaceImports(lib, imp) {
    const old = (lib.smp.imports || []).map((i) => ({ ...i, replacedAt: Date.now() }));
    return { ...lib, smp: { ...lib.smp, imports: [imp], replaced: [...(lib.smp.replaced || []), ...old] } };
  }
  function addImport(lib, imp) {
    if (imp.source.sha256 && lib.smp.imports.some((i) => i.source.sha256 === imp.source.sha256)) return { lib, duplicate: true };
    return { lib: { ...lib, smp: { ...lib.smp, imports: [...lib.smp.imports, imp] } }, duplicate: false };
  }

  // ---------------------------------------------------------------- page workspace: card records, Start Fresh, recovery copy
  // Pure data rules (no storage, no DOM). A saved item is one of: a NOTE (what the person wrote and changed), or a CARD RECORD
  // (`cardRecord: true`): a product card Blueline was asked to remember, with or without a product assigned. A note may still
  // carry a card / mapping (`productCard`, `productMapping`, how older versions saved them). Deleting or clearing a note never
  // takes its card or assignment with it: the note's card data moves into a card record (same id, so nothing is re-linked).
  const wsClone = (x) => JSON.parse(JSON.stringify(x));
  const isCardRecord = (it) => !!(it && it.cardRecord === true);
  const cardOfItem = (it) => (it && it.productMapping && it.productMapping.card && it.productMapping.card.v ? it.productMapping.card : it && it.productCard && it.productCard.v ? it.productCard : null);
  const hasCardData = (it) => !!cardOfItem(it);
  const hasAssignment = (it) => !!(it && it.productMapping && isMapping(it.productMapping));
  const RECORD_KEEP = ['id', 'createdAt', 'type', 'url', 'path', 'viewport', 'page', 'mode', 'el', 'styling'];
  // The card record for an item that carries card data, or null. Only the card and its assignment are kept.
  function toCardRecord(it) {
    if (!hasCardData(it)) return null;
    const rec = { cardRecord: true, note: '', updatedAt: it.updatedAt || it.createdAt || 0 };
    for (const k of RECORD_KEEP) if (it[k] !== undefined) rec[k] = wsClone(it[k]);
    if (it.productMapping) rec.productMapping = wsClone(it.productMapping);
    else rec.productCard = wsClone(it.productCard);
    return rec;
  }
  // A "Not a card" exclusion: a card record that holds no card of its own, only the fingerprint of a detected candidate the person
  // ruled out (`exclusion.card`), so discovery stops proposing it until it is restored. `why` is 'not-a-card' or 'boundary'.
  const isExclusion = (it) => !!(it && it.cardRecord === true && it.exclusion && it.exclusion.card && it.exclusion.card.v);
  function newExclusionRecord(info, card, id, now, why) {
    const rec = newCardRecord(info, card, id, now);
    delete rec.productCard;
    rec.exclusion = { v: 1, card: wsClone(card), why: why || 'not-a-card', at: now };
    return rec;
  }
  // A new, empty card definition record (no note, no product).
  function newCardRecord(info, card, id, now) {
    const rec = { cardRecord: true, note: '', id, createdAt: now, updatedAt: now };
    for (const k of RECORD_KEEP) if (info && info[k] !== undefined && k !== 'id' && k !== 'createdAt') rec[k] = wsClone(info[k]);
    rec.type = 'change';
    rec.productCard = wsClone(card);
    return rec;
  }
  // The note with its assignment removed (its card stays as the note's own card).
  function withoutAssignment(it) {
    const n = wsClone(it);
    if (!n.productMapping) return n;
    const card = cardOfItem(n);
    delete n.productMapping;
    if (card) n.productCard = card; else delete n.productCard;
    return n;
  }
  const withoutCard = (it) => { const n = wsClone(it); delete n.productMapping; delete n.productCard; return n; };
  // What a page holds, in the three units Start Fresh clears.
  function pageCounts(items) {
    const c = { notes: 0, cards: 0, assignments: 0 };
    for (const it of items || []) {
      if (!isCardRecord(it)) c.notes++;
      if (hasCardData(it)) c.cards++;
      if (hasAssignment(it)) c.assignments++;
    }
    return c;
  }
  // What clearing would leave. `scope` = { notes, cards, assignments }; clearing cards always clears their assignments.
  // Returns the page's items afterwards (same order), the ids of notes that are gone, and what was cleared.
  function planReset(items, scope) {
    const sc = { notes: !!scope?.notes, cards: !!scope?.cards, assignments: !!(scope?.assignments || scope?.cards) };
    const out = [];
    const notesGone = [];
    const cleared = { notes: 0, cards: 0, assignments: 0 };
    for (const it of items || []) {
      const rec = isCardRecord(it);
      let cur = it;
      if (isExclusion(it)) { if (!sc.cards) out.push(it); continue; } // exclusions are card management: they go with the cards
      if (hasCardData(cur)) {
        if (sc.cards) { cleared.cards++; if (hasAssignment(cur)) cleared.assignments++; cur = withoutCard(cur); }
        else if (sc.assignments && hasAssignment(cur)) { cleared.assignments++; cur = withoutAssignment(cur); }
      }
      if (rec) { if (hasCardData(cur)) out.push(cur === it ? it : cur); continue; }
      if (sc.notes) {
        cleared.notes++;
        notesGone.push(it.id);
        const keep = toCardRecord(cur);
        if (keep) out.push(keep);
        continue;
      }
      out.push(cur);
    }
    return { items: out, notesGone, cleared, scope: sc };
  }
  // A short stable fingerprint of an item (to notice later changes without storing a second copy).
  function hashJson(x) {
    const s = JSON.stringify(x);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return `${s.length}:${h.toString(36)}`;
  }
  // The recovery copy taken just before clearing: the page's items exactly as they were, plus a fingerprint of each item as
  // it is AFTER clearing (so restoring can tell whether anything changed since). One per page; JSON keeps variant ids as strings.
  function makeSnapshot({ pageKey, page, before, after, scope, cleared, shots, now }) {
    const afterSig = {};
    for (const it of after || []) afterSig[it.id] = hashJson(it);
    return { v: 1, at: now, pageKey, page: wsClone(page || {}), scope: wsClone(scope), cleared: wsClone(cleared || {}), before: wsClone(before || []), afterSig, shots: shots ? wsClone(shots) : {} };
  }
  // Restoring the recovery copy onto the page's current items. Nothing is changed here; the caller decides.
  //   conflict: what changed since the reset ({ changed, added, removed } ids). If any, the person must confirm.
  //   items: the page's items after restoring: every saved item back exactly as it was; notes made since stay;
  //          cards and assignments made since the reset are replaced (the confirmation says so).
  function restorePlan(snapshot, current) {
    const sig = snapshot.afterSig || {};
    const cur = new Map((current || []).map((it) => [it.id, it]));
    const changed = [];
    const added = [];
    const removed = [];
    for (const [id, h] of Object.entries(sig)) { const c = cur.get(id); if (!c) removed.push(id); else if (hashJson(c) !== h) changed.push(id); }
    for (const it of current || []) if (!(it.id in sig)) added.push(it.id);
    const beforeIds = new Set((snapshot.before || []).map((it) => it.id));
    const items = (snapshot.before || []).map(wsClone);
    const dropped = { cards: 0, assignments: 0 };
    for (const it of current || []) {
      if (beforeIds.has(it.id)) continue;
      if (hasCardData(it)) { dropped.cards++; if (hasAssignment(it)) dropped.assignments++; if (isCardRecord(it)) continue; items.push(withoutCard(it)); } else items.push(it);
    }
    return { conflict: changed.length || added.length || removed.length ? { changed, added, removed } : null, items, dropped };
  }

  return {
    toCents, fmt, reconcile, slug, productKey, skuEq, normalizeStore, parseCSV,
    importCsv, importJson, importDocx, importFile, parseSmpText, docxXmlToText, unzipEntry,
    smpProducts, DriverError, normalizeProduct, parseProductRef, createDriver, scoreSuggestions, lookupProduct, lookupAll, refreshVariant, setRefresh, checkAll,
    listSummaries, optionalStore, moveLibrary, replaceImports, exportList, EXPORT_SCHEMA, approveSubstitution, revokeSubstitution, setEdit, resetEdit, setLocalSku, addLocalProduct,
    newListId, defaultListName, listName, newLibrary, isPristine, renameLibrary, listsForStore, summarize,
    emptyWork, buildRows, STATUS_LABEL, decide, clearDecision, setLookup, chooseVariant, addManualProduct, removeManualProduct, exportApproved,
    MAPPING_SCHEMA, FIELD_KEYS, FIELD_LABELS, fieldItems, setFieldAssignment, discountPercent, discountInfo, displayPrice, labelFits, sourceTargetLines, cartLines, pageLabel, targetReportLines, fieldReportLines, isMapping, productMappingSnapshot, mappingReportLines, OVERRIDE_FIELDS, effectiveValues, setMappingOverride, changeMappingVariant, mappingCheck, searchRows,
    approveMappingReplacement, buildSelectionMapping, adoptListValues, mappingStatus, shopifyCheck, replacementPending, overrideConflicts,
    uniqueListName, reconcileNames, reconcileListNames, listLabel,
    K_INDEX, kSmp, kWork, campaignId, loadIndex, loadLibrary, saveLibrary, setActive, getActive, deleteLibrary, addImport,
    isCardRecord, isExclusion, newExclusionRecord, cardOfItem, hasCardData, hasAssignment, toCardRecord, newCardRecord, withoutAssignment, withoutCard, pageCounts, planReset, hashJson, makeSnapshot, restorePlan,
  };
});
