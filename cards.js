/* Blueline Product Cards (Product Mapping, M2) — card detection, card identity and safe re-validation.
 *
 * No UI and no storage here: this file only reads the page's DOM. tools.js draws the "Product card" section of a
 * note with it and the Change Report uses its check.
 *
 * What it does
 *  - propose(el)     From any element the user selected, finds the ancestor that is most likely a product card, by
 *                    structure (repeated sibling containers that hold product-like content), never by tag or class
 *                    name. It only PROPOSES: the caller shows it and the user confirms, or steps to a parent / child.
 *  - describe(el)    The confirmed card's identity (the "fingerprint"): selector (advisory only), section heading,
 *                    position and sibling count, tag/class structure, stable attributes, a structural hash, a hash of
 *                    the whole group of comparable cards, neighbours, and which evidence tells this card apart from
 *                    its siblings. Shape-compatible with `productMapping.card` from M1 (selector, section, index,
 *                    count, text are all there).
 *  - evaluate(card)  Re-checks a saved card against the page and says what it can honestly claim:
 *        confirmed   nothing we recorded has changed (or a stable Blueline/explicit id matches exactly one element)
 *        changed     the cards changed and ONE candidate is singled out by content that is unique to it: suggested,
 *                    never applied
 *        ambiguous   cards changed and the evidence cannot tell which one it was (for example identical placeholder
 *                    cards after one was inserted): candidates listed, nothing chosen
 *        hidden      the card is identified but is not visible right now (a filter, a closed tab)
 *        not-found   no comparable card on the page
 *    A positional selector alone (`:nth-of-type`) is never treated as proof: it is only trusted while the whole group
 *    of comparable cards is unchanged.
 *  - discoverSlots(cardEl) / slotElement(cardEl, slot)   The card's parts (image, title, price, struck-through
 *    price, link/button, badge, other text), found by content, with a path back to each. Hints only: a card may lack
 *    any of them and price pairs are not assumed to share markup. Nothing is assigned to them yet.
 *
 * Optional accelerators (never required): data-blueline-product-card, data-blueline-slot-id,
 * data-blueline-product-field, data-blueline-product-section.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BluelineCards = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BL = () => globalThis.__BL || {};
  const isStableClass = (c) => (BL().isStableClass ? BL().isStableClass(c) : c.length <= 40);
  const pathOf = (el) => (BL().cssPath ? BL().cssPath(el) : '');
  const SCHEMA = 1;

  // ------------------------------------------------------------------ small helpers

  function hash(str) { // cyrb53, base 36: enough to compare, not a security hash
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  // textContent, not innerText: the same whether or not the card is currently hidden by a filter.
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const tagOf = (el) => el.tagName.toLowerCase();
  const classesOf = (el) => [...el.classList].filter(isStableClass).sort();
  const sameList = (a, b) => (a || []).length === (b || []).length && (a || []).every((x, i) => x === b[i]);
  const stableId = (id) => !!id && id.length <= 60 && !/^[:«]|\d{5,}|^[a-f0-9]{8,}$|^(?:ember|react|radix|headlessui)/i.test(id);
  const esc = (s) => (globalThis.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));
  const qsa = (sel, rootEl = document) => { try { return [...rootEl.querySelectorAll(sel)]; } catch { return []; } };

  const SKIP_ATTR = /^data-(?:blueline-pick|blueline-src|state|active|selected|open|expanded|index|key|reactid|v-|radix|headlessui)/;
  // Attributes that say something about WHICH card this is. The `hidden` attribute and state classes are left out on
  // purpose, so showing or hiding a card never changes its identity.
  function attrsOf(el) {
    const out = {};
    for (const a of el.attributes) {
      if (!/^data-/.test(a.name) || SKIP_ATTR.test(a.name) || a.value.length > 60) continue;
      out[a.name] = a.value;
    }
    if (el.id && stableId(el.id)) out.id = el.id;
    return out;
  }
  const attrKey = (a) => Object.keys(a).sort().map((k) => `${k}=${a[k]}`).join(';');

  // ------------------------------------------------------------------ structure

  // The element's shape: every tag path down to depth 3 with how often it occurs (text and attributes ignored).
  function shapeTokens(el, maxDepth = 3, cap = 150) {
    const out = new Map();
    let n = 0;
    const walk = (node, path, depth) => {
      for (const c of node.children) {
        if (n++ >= cap) return;
        const p = path ? `${path}>${tagOf(c)}` : tagOf(c);
        out.set(p, (out.get(p) || 0) + 1);
        if (depth < maxDepth) walk(c, p, depth + 1);
      }
    };
    walk(el, '', 1);
    return out;
  }
  const shapeKey = (m) => [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}*${v}`).join('|');
  const shapeHash = (el) => hash(shapeKey(shapeTokens(el)));
  function dice(a, b) {
    let inter = 0; let ta = 0; let tb = 0;
    for (const v of a.values()) ta += v;
    for (const v of b.values()) tb += v;
    for (const [k, v] of a) inter += Math.min(v, b.get(k) || 0);
    return ta + tb ? (2 * inter) / (ta + tb) : 1;
  }
  // Comparable siblings: same tag, mostly the same classes, mostly the same inner structure. Tolerant, so a card
  // with an extra badge still counts as one of the group.
  function similar(a, shapeA, b) {
    if (a.tagName !== b.tagName) return false;
    const ca = classesOf(a); const cb = classesOf(b);
    const both = new Set([...ca, ...cb]);
    const common = ca.filter((c) => cb.includes(c)).length;
    if (both.size && common / both.size < 0.5) return false;
    return dice(shapeA, shapeTokens(b)) >= 0.6;
  }
  function group(el) {
    const p = el.parentElement;
    if (!p) return { parent: null, members: [el], index: 1, count: 1 };
    const sa = shapeTokens(el);
    const members = [...p.children].filter((c) => c === el || similar(el, sa, c));
    return { parent: p, members, index: members.indexOf(el) + 1, count: members.length };
  }

  // ------------------------------------------------------------------ product-like content

  const PRICE_RE = /(?:[$€£¥]\s?\d[\d.,]*)|(?:\b\d[\d.,]*\s?(?:USD|EUR|GBP|CAD|AUD)\b)|\[\s*[$€£]\s*[A-Za-z ]*\s*\]/i; // "$19.97", "19.97 USD", the placeholder "[$Sale]"
  const CTA_RE = /\b(shop|buy|add|cart|order|view|get|deal|checkout|select|choose|subscribe|learn|details)\b/i;
  const MEDIA_RE = /\b(shot|image|photo|picture|thumbnail)\b/i; // placeholder text standing in for a product image
  // The text a node holds itself (not its children's): an image box can hold "[Product shot]" and a badge element.
  const ownText = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' ').replace(/\s+/g, ' ').trim();
  const labelOf = (n) => (/^(A|BUTTON)$/.test(n.tagName) || n.getAttribute('role') === 'button' ? textOf(n) : ownText(n));
  const isCtaEl = (n) => /^(A|BUTTON)$/.test(n.tagName) || n.getAttribute('role') === 'button';
  const fieldOf = (n) => (n.getAttribute && n.getAttribute('data-blueline-product-field')) || '';

  function signals(el) {
    const s = { price: false, title: false, media: false, cta: false, explicit: false };
    const nodes = qsa('*', el).slice(0, 250);
    for (const n of nodes) {
      if (fieldOf(n)) s.explicit = true;
      if (/^(IMG|PICTURE|VIDEO|CANVAS)$/.test(n.tagName) || (n.tagName.toLowerCase() === 'svg' && n.getBoundingClientRect().width > 40)) { s.media = true; continue; }
      if (!s.media && /url\(/.test(getComputedStyle(n).backgroundImage)) s.media = true;
      const t = labelOf(n);
      if (!t) continue;
      if (PRICE_RE.test(t) && t.length <= 40) s.price = true;
      else if (isCtaEl(n) && CTA_RE.test(t) && t.length <= 40) s.cta = true;
      else if (MEDIA_RE.test(t) && t.length <= 40 && !s.media) s.media = true;
      else if (/^H[1-6]$/.test(n.tagName) || /^(?:600|700|800|900|bold)$/.test(getComputedStyle(n).fontWeight) || parseFloat(getComputedStyle(n).fontSize) >= 16) s.title = true;
    }
    s.count = ['price', 'title', 'media', 'cta'].filter((k) => s[k]).length;
    return s;
  }
  // A card holds something to look at and something to buy or price: (image and price/button) or (price and button).
  const productLike = (s) => s.explicit || (s.media && (s.price || s.cta)) || (s.price && s.cta);

  // Does `el` contain two or more product cards (so it is a section or a row of cards, not a card)?
  function containsCards(el) {
    const parents = new Set();
    for (const n of qsa('*', el).slice(0, 600)) {
      const p = n.parentElement;
      if (!p || parents.has(p) || p === el.parentElement) continue;
      const kids = [...p.children];
      if (kids.length < 2) continue;
      const first = kids[0];
      if (kids.filter((k) => k.tagName === first.tagName).length < 2) continue;
      parents.add(p);
      if (parents.size > 40) break;
      for (const c of kids.slice(0, 3)) {
        const g = group(c);
        if (g.count >= 2 && productLike(signals(c))) return true;
      }
    }
    return false;
  }
  const cardLike = (el) => {
    if (el.hasAttribute('data-blueline-product-card')) return true;
    const g = group(el);
    return g.count >= 2 && productLike(signals(el)) && !containsCards(el);
  };
  const BROAD_TAGS = /^(SECTION|MAIN|HEADER|FOOTER|NAV|ASIDE)$/;
  // A container that would swallow several cards, or a whole region of the page: the UI asks for clear confirmation.
  function isBroad(el) {
    if (BROAD_TAGS.test(el.tagName)) return true;
    if (el.hasAttribute('data-blueline-product-card')) return false;
    if (containsCards(el)) return true;
    const r = el.getBoundingClientRect();
    return group(el).count < 2 && r.height > innerHeight * 1.5;
  }

  const chainOf = (el) => {
    const out = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement && out.length < 14; n = n.parentElement) out.push(n);
    return out;
  };

  // From the element the user selected: the ancestors up to the page body, and which one (if any) looks like the
  // product card. `chain[0]` is the user's own element; moving to a parent or back down walks this list.
  function propose(el) {
    const chain = chainOf(el);
    let at = chain.findIndex((n) => n.hasAttribute('data-blueline-product-card'));
    let confidence = at >= 0 ? 'explicit' : 'none';
    if (at < 0) {
      for (let i = 0; i < chain.length; i++) if (cardLike(chain[i])) { at = i; confidence = 'structure'; break; }
      // The lowest match can be only a lower part of the card (a content area that repeats beside another one).
      // Keep climbing while an ancestor is also a repeated, product-like group, and stop before anything that holds
      // several cards (a row or a section), so the whole card is preferred and a row never is.
      if (at >= 0) {
        for (let j = at + 1; j < chain.length; j++) {
          if (BROAD_TAGS.test(chain[j].tagName) || containsCards(chain[j])) break;
          if (cardLike(chain[j])) at = j;
        }
      }
    }
    // A card with nothing similar beside it can't be told by repetition: the lowest product-like container that is not
    // a section is offered, marked as a weaker guess.
    if (at < 0) {
      for (let i = 0; i < chain.length; i++) if (!BROAD_TAGS.test(chain[i].tagName) && productLike(signals(chain[i])) && !containsCards(chain[i])) { at = i; confidence = 'single'; break; }
    }
    return { chain, at, confidence, broad: chain.map(isBroad) };
  }

  // ------------------------------------------------------------------ section and identity

  function headingText(node) {
    const by = node.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\s+/).map((id) => { const h = document.getElementById(id); return h ? textOf(h) : ''; }).filter(Boolean).join(' '); if (t) return t; }
    const ex = node.getAttribute('data-blueline-product-section');
    if (ex) return ex;
    const al = node.getAttribute('aria-label');
    if (al) return al.trim();
    const h = node.querySelector('h1,h2,h3,h4,h5,h6');
    return h ? textOf(h) : '';
  }
  function sectionOf(el) {
    let node = el.closest('[data-blueline-product-section]');
    for (let n = el.parentElement; !node && n && n !== document.body; n = n.parentElement) {
      if (n.matches('section,[role="region"],[aria-labelledby],[aria-label],main')) node = n;
    }
    let heading = node ? headingText(node) : '';
    if (!heading) { // nearest heading that comes before the card in the document
      let last = null;
      for (const h of qsa('h1,h2,h3,h4,h5,h6')) if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && !h.contains(el)) last = h;
      if (last) heading = textOf(last);
    }
    return { heading: clip(heading, 80) || null, id: node && node.id && stableId(node.id) ? node.id : null, explicit: node?.getAttribute('data-blueline-product-section') || null };
  }
  function explicitOf(el) {
    for (const name of ['data-blueline-slot-id', 'data-blueline-product-card']) {
      const v = el.getAttribute(name);
      if (v) return { name, value: v };
    }
    return null;
  }
  // Identity of a group member WITHOUT its text: text can be filled in or change later (live prices, real names)
  // without the cards having moved. Text is compared only when it was what told the card apart (uniqueBy).
  const memberKey = (m) => `${tagOf(m)}|${classesOf(m).join('.')}|${attrKey(attrsOf(m))}|${shapeHash(m)}`;

  // The card as the page has it right now (everything evaluate() compares).
  function measure(el) {
    const g = group(el);
    const keys = g.members.map(memberKey);
    const me = keys[g.index - 1];
    const attrs = attrsOf(el);
    const p = el.parentElement;
    const otherText = g.members.filter((m) => m !== el).map((m) => hash(textOf(m)));
    const otherAttrs = g.members.filter((m) => m !== el).map((m) => attrKey(attrsOf(m)));
    const uniqueBy = [];
    if (g.count > 1 && textOf(el) && !otherText.includes(hash(textOf(el)))) uniqueBy.push('text');
    if (g.count > 1 && attrKey(attrs) && !otherAttrs.includes(attrKey(attrs))) uniqueBy.push('attrs');
    return {
      tag: tagOf(el), classes: classesOf(el), attrs, index: g.index, count: g.count,
      shape: shapeHash(el), textHash: hash(textOf(el)), groupHash: hash(`${g.count}#${keys.join('\n')}`),
      section: sectionOf(el),
      parent: p ? { tag: tagOf(p), classes: classesOf(p), id: p.id && stableId(p.id) ? p.id : null } : null,
      neighbors: { prev: g.index > 1 ? hash(keys[g.index - 2]) : null, next: g.index < g.count ? hash(keys[g.index]) : null },
      uniqueBy, me, members: g.members,
    };
  }

  // The fingerprint saved with a note (JSON). `selector` is advisory: evaluate() never trusts it on its own.
  function describe(el, { now = Date.now() } = {}) {
    const m = measure(el);
    const ex = explicitOf(el);
    const explicitUnique = ex ? qsa(`[${esc(ex.name)}="${esc(ex.value)}"]`).length === 1 : false;
    return JSON.parse(JSON.stringify({
      v: SCHEMA, kind: 'product-card',
      selector: pathOf(el), tag: m.tag, classes: m.classes, attrs: m.attrs, explicit: explicitUnique ? ex : null,
      section: m.section, parent: m.parent,
      index: m.index, count: m.count, neighbors: m.neighbors,
      shape: m.shape, groupHash: m.groupHash, textHash: m.textHash, text: clip(textOf(el), 60),
      evidence: explicitUnique ? 'explicit' : m.uniqueBy.length ? 'unique-content' : 'positional', uniqueBy: m.uniqueBy,
      slots: discoverSlots(el), capturedAt: now,
    }));
  }

  // ------------------------------------------------------------------ evaluation

  const isHidden = (el) => {
    if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) return true;
    const r = el.getBoundingClientRect();
    return r.width === 0 && r.height === 0;
  };
  const resolveSelector = (sel) => { if (!sel) return { el: null, n: 0 }; const all = qsa(sel); return { el: all.length === 1 ? all[0] : null, n: all.length }; };

  function changesBetween(card, now) {
    const out = [];
    if (now.count !== card.count) out.push(`the number of comparable cards changed (${card.count} → ${now.count})`);
    if (now.index !== card.index) out.push(`its position changed (card ${card.index} → ${now.index})`);
    if (now.groupHash !== card.groupHash && now.count === card.count) out.push('the cards in this group were changed or reordered');
    if (now.shape !== card.shape) out.push('its inner structure changed');
    if (card.parent && (!now.parent || now.parent.tag !== card.parent.tag || !sameList(now.parent.classes, card.parent.classes))) out.push('the container around it changed');
    if ((now.section.heading || '') !== (card.section?.heading || '')) out.push(`its section heading changed (“${card.section?.heading || ''}” → “${now.section.heading || ''}”)`);
    if ((card.uniqueBy || []).includes('text') && now.textHash !== card.textHash) out.push('its text changed');
    return out;
  }

  // Every comparable card on the page that could be the saved one, best pool first (same section, then any section).
  function candidatePool(card) {
    if (!card.tag) return [];
    const sel = card.tag + (card.classes || []).map((c) => `.${esc(c)}`).join('');
    const all = qsa(sel).slice(0, 300);
    const parentOk = (el) => !card.parent || (el.parentElement && tagOf(el.parentElement) === card.parent.tag && sameList(classesOf(el.parentElement), card.parent.classes));
    const p1 = all.filter(parentOk);
    const inSection = p1.filter((el) => (sectionOf(el).heading || '') === (card.section?.heading || ''));
    return inSection.length ? inSection : p1.length ? p1 : all;
  }

  function evaluate(card) {
    const res = { state: 'not-found', el: null, candidates: [], reasons: [], evidence: 'positional', basis: null };
    if (!card || typeof card !== 'object' || card.v !== SCHEMA || !card.tag) { res.state = 'unchecked'; res.reasons.push('This card was saved without identity details, so it can’t be checked.'); return res; }
    res.evidence = card.evidence || 'positional';
    const finish = (state, el, basis) => {
      res.state = state; res.el = el || null; res.basis = basis || null;
      if (el && state === 'confirmed' && isHidden(el)) { res.state = 'hidden'; res.reasons.push('the card is identified but not visible right now (for example hidden by a filter)'); }
      return res;
    };

    // 1. A Blueline identifier names the card outright, wherever it now sits.
    if (card.explicit?.name) {
      const found = qsa(`[${esc(card.explicit.name)}="${esc(card.explicit.value)}"]`);
      if (found.length === 1) return finish('confirmed', found[0], 'explicit-id');
      if (found.length > 1) { res.candidates = found; res.state = 'ambiguous'; res.reasons.push(`${found.length} elements carry the same Blueline identifier`); return res; }
      res.reasons.push('the element carrying its Blueline identifier is gone');
    }

    // 2. The saved selector is trusted only while the whole group of comparable cards is unchanged.
    const hit = resolveSelector(card.selector);
    let diffs = [];
    if (hit.el) {
      const now = measure(hit.el);
      diffs = changesBetween(card, now);
      const same = !diffs.length && now.tag === card.tag && sameList(now.classes, card.classes) && now.groupHash === card.groupHash && (!card.parent || (now.parent && now.parent.tag === card.parent.tag));
      if (same) return finish('confirmed', hit.el, card.evidence === 'positional' ? 'unchanged-structure' : 'unchanged-content');
      res.reasons.push(...diffs);
    } else if (hit.n > 1) res.reasons.push(`the saved selector now matches ${hit.n} elements`);
    else if (!card.explicit?.name || !res.reasons.length) res.reasons.push('the saved selector matches nothing now');

    // 3. Something changed: look for the card by what is unique to it. Suggest, never apply.
    const pool = candidatePool(card);
    res.candidates = pool.slice(0, 30);
    if (!pool.length) { res.state = 'not-found'; res.reasons.push('no comparable card is on the page'); return res; }
    const by = card.uniqueBy || [];
    if (by.length) {
      const match = pool.filter((el) => {
        const m = measure(el);
        return (!by.includes('text') || m.textHash === card.textHash) && (!by.includes('attrs') || attrKey(m.attrs) === attrKey(card.attrs || {}));
      });
      if (match.length === 1) { res.reasons.push(`found by its ${by.join(' and ')}, which no other card shares; confirm it`); return finish('changed', match[0], 'unique-content'); }
      if (match.length > 1) { res.candidates = match; res.state = 'ambiguous'; res.reasons.push(`${match.length} cards share what identified it`); return res; }
      // Nothing else carries it. If the card is still where it was and only its text changed, it was most likely edited in place.
      if (hit.el && diffs.length === 1 && diffs[0] === 'its text changed') { res.reasons.push('its text was edited and no other card has the old text; confirm it is the same card'); return finish('changed', hit.el, 'edited-in-place'); }
      res.state = 'not-found'; res.reasons.push('no card on the page has the content that identified it'); return res;
    }
    if (pool.length === 1 && card.count === 1) { res.reasons.push('it is the only comparable card on the page; confirm it'); return finish('changed', pool[0], 'only-candidate'); }
    res.state = 'ambiguous';
    res.reasons.push('the cards look alike (nothing on them tells them apart), so which one it was can’t be told');
    return res;
  }

  // ------------------------------------------------------------------ the card's parts (for field mapping later)

  const FIELD_ROLES = { image: 'image', photo: 'image', title: 'title', name: 'title', price: 'price', 'sale-price': 'price', 'regular-price': 'compare-price', 'compare-price': 'compare-price', url: 'cta', link: 'cta', cta: 'cta', 'add-to-cart': 'cta', badge: 'badge' };
  function relPath(root, node) {
    const segs = [];
    for (let n = node; n && n !== root; n = n.parentElement) segs.unshift(`${tagOf(n)}:nth-child(${[...n.parentElement.children].indexOf(n) + 1})`);
    return segs.join(' > ');
  }
  // Looks for parts by content. Every part is optional and a role may repeat or be missing; roles are hints.
  function discoverSlots(cardEl, cap = 10) {
    const out = [];
    const titles = [];
    for (const n of qsa('*', cardEl).slice(0, 300)) {
      const ex = fieldOf(n);
      const cs = getComputedStyle(n);
      const own = labelOf(n);
      let role = null;
      if (ex) role = FIELD_ROLES[ex.toLowerCase()] || ex.toLowerCase();
      else if (/^(IMG|PICTURE|VIDEO)$/.test(n.tagName) || (/url\(/.test(cs.backgroundImage) && n !== cardEl)) role = 'image';
      else if (own && PRICE_RE.test(own) && own.length <= 40) role = /^(S|DEL|STRIKE)$/.test(n.tagName) || /line-through/.test(cs.textDecorationLine) ? 'compare-price' : 'price';
      else if (own && isCtaEl(n) && CTA_RE.test(own) && own.length <= 40) role = 'cta';
      else if (own && MEDIA_RE.test(own) && own.length <= 40) role = 'image';
      else if (own && cs.position === 'absolute') role = 'badge';
      else if (own && (/^H[1-6]$/.test(n.tagName) || /^(?:600|700|800|900|bold)$/.test(cs.fontWeight) || parseFloat(cs.fontSize) >= 16)) { titles.push({ n, size: parseFloat(cs.fontSize) || 0 }); continue; }
      else if (own && own.length >= 2) role = 'text';
      if (!role) continue;
      out.push({ role, tag: tagOf(n), path: relPath(cardEl, n), text: clip(own, 40) || undefined, source: ex ? 'explicit' : 'content' });
    }
    // Of the heading-like texts, the largest is the title; the others stay plain text.
    titles.sort((a, b) => b.size - a.size).forEach(({ n }, i) => out.push({ role: i === 0 ? 'title' : 'text', tag: tagOf(n), path: relPath(cardEl, n), text: clip(textOf(n), 40), source: 'content' }));
    const order = new Map(qsa('*', cardEl).map((n, i) => [relPath(cardEl, n), i]));
    return out.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0)).slice(0, cap);
  }
  function slotElement(cardEl, slot) {
    if (!cardEl || !slot || !slot.path) return null;
    try { const n = cardEl.querySelector(`:scope > ${slot.path}`); return n && tagOf(n) === slot.tag ? n : null; } catch { return null; }
  }

  // ------------------------------------------------------------------ report

  const NOTE = {
    confirmed: () => 'confirmed on the page',
    hidden: () => 'identified but hidden on the page (for example by a filter)',
    changed: (r) => `**not confirmed:** the page changed since this card was picked, so the saved selector may point at a different card (${r.reasons.join('; ')}). Locate the card from the details above, not the selector alone`,
    ambiguous: (r) => `**not confirmed:** the page changed and this card can’t be told apart from the others (${r.reasons.join('; ')}). Don’t rely on the selector alone`,
    'not-found': (r) => `**not confirmed:** not found on the page (${r.reasons.join('; ')})`,
  };
  // Lines for the Change Report. `nested` = inside a Product Mapping block (adds only the page check); otherwise
  // a card-only note gets its own short description first. Saved cards without identity details add nothing.
  function reportLines(card, result, { nested = false } = {}) {
    if (!card || card.v !== SCHEMA || !result || result.state === 'unchecked') return [];
    const L = [];
    const note = (NOTE[result.state] || (() => result.state))(result);
    if (!nested) {
      const sec = card.section?.heading ? `, in section “${card.section.heading}”` : '';
      const pos = Number.isInteger(card.index) && Number.isInteger(card.count) ? `, card ${card.index} of ${card.count}` : '';
      L.push(`- **Product card**: \`${String(card.selector || card.tag).replace(/`/g, "'")}\`${sec}${pos}${card.text ? `, currently “${card.text}”` : ''}.`);
      L.push(`  - Card check: ${note}.`);
    } else L.push(`  - Card check: ${note}.`);
    return L;
  }

  return { SCHEMA, hash, propose, describe, evaluate, measure, discoverSlots, slotElement, reportLines, isBroad, cardLike, group, sectionOf, signals };
});
