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

  // ------------------------------------------------------------------ M4: recognising the card's fields
  //
  // detectFields(cardEl) reads ONE card and proposes, for each field a product card can have, the element that most
  // likely holds it. It only PROPOSES (nothing is stored or changed): the Product Mapping window shows the proposal and the
  // person accepts, changes or clears it. Layers, strongest first:
  //   explicit  data-blueline-product-field (optional, never required)
  //   semantic  itemprop, heading / img / picture / del / s / ins / button / a
  //   pattern   class, id and data-* names (only ever together with matching content, never alone)
  //   content   what the text is (a price, a percentage, a call to action), how it is styled (struck through, size,
  //             weight, position) and what sits next to it in the card
  // Only the card's own descendants are considered, so a neighbour's price or the page's navigation can't be picked up.
  // When two candidates are about as likely, the field is reported as AMBIGUOUS with both: nothing is chosen for the person.
  // A field with no plausible element is simply missing. Nothing is invented to fill a gap.

  const FIELD_KEYS = ['title', 'image', 'sale', 'regular', 'badge', 'cta', 'link'];
  const FIELD_LABELS = { title: 'Title', image: 'Image', sale: 'Sale price', regular: 'Regular price', badge: 'Discount badge', cta: 'Add to Cart button', link: 'Product link' };
  const EXPLICIT_FIELD = { title: 'title', name: 'title', image: 'image', photo: 'image', price: 'sale', 'sale-price': 'sale', sale: 'sale', 'regular-price': 'regular', 'compare-price': 'regular', regular: 'regular', badge: 'badge', discount: 'badge', cta: 'cta', 'add-to-cart': 'cta', url: 'link', link: 'link' };
  const GAP = 12; // how much better the best candidate must be before it is proposed alone

  // ---- values read from text
  const MONEY_G = /(?:[$€£¥]\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?)|(?:\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:USD|EUR|GBP|CAD|AUD)\b)/gi;
  const PLACEHOLDER_PRICE = /^\s*\[\s*[$€£]\s*([A-Za-z ]*?)\s*\]\s*$/; // "[$Sale]", "[$Reg]"
  const toCentsParts = (whole, frac) => Number(String(whole).replace(/,/g, '')) * 100 + (frac ? Number((frac + '0').slice(0, 2)) : 0);
  // Every price in a text, as integer cents. A designer's placeholder ("[$Sale]") is one price with no value and a hint.
  function pricesIn(text) {
    const t = String(text || '');
    const ph = PLACEHOLDER_PRICE.exec(t);
    if (ph) return [{ cents: null, raw: t.trim(), placeholder: true, hint: ph[1].toLowerCase() }];
    const out = [];
    MONEY_G.lastIndex = 0;
    let m;
    while ((m = MONEY_G.exec(t))) out.push({ cents: toCentsParts(m[1] || m[3], m[2] || m[4]), raw: m[0], placeholder: false, hint: '' });
    return out;
  }
  // A discount badge's claim: a percentage ("30% OFF", "-30%", "Save 30%"), an amount ("Save $12") or a placeholder
  // ("[XX% OFF]"). Anything else is not a badge. Never turned into a price.
  function parseBadge(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 28) return null;
    if (/^\[\s*(?:x{1,3}|\d{0,3})\s*%\s*(?:off)?\s*\]$/i.test(t) || /^\[\s*%?\s*off\s*\]$/i.test(t)) return { kind: 'percent', percent: null, placeholder: true, text: t };
    let m = /(?:^|[^\d.])(\d{1,3}(?:\.\d+)?)\s?%/.exec(t);
    if (m && (/\b(off|save|saving|discount|sale|deal)\b/i.test(t) || /^[-−–]\s?\d/.test(t) || /^\d{1,3}\s?%$/.test(t))) return { kind: 'percent', percent: Math.round(Number(m[1])), placeholder: false, text: t };
    m = /\b(?:save|take)\s*[$€£]\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/i.exec(t) || /[$€£]\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s*off\b/i.exec(t);
    if (m) { const [w, f] = m[1].replace(/,/g, '').split('.'); return { kind: 'amount', cents: toCentsParts(w, f), placeholder: false, text: t }; }
    return null;
  }

  // ---- nodes
  const SKIP_TAG = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SOURCE|META|LINK|TRACK|BR|HR|PATH|CIRCLE|RECT|G|USE|DEFS)$/;
  const sigOf = (n) => [n.getAttribute('class') || '', n.id || '', n.getAttribute('itemprop') || '', n.getAttribute('aria-label') || '', n.getAttribute('data-testid') || '', n.getAttribute('role') || '',
    ...[...n.attributes].filter((a) => /^data-(?!blueline-pick|blueline-src)/.test(a.name)).map((a) => `${a.name} ${a.value.slice(0, 30)}`)].join(' ').toLowerCase();
  const visibleNow = (n, r) => {
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05 || n.hidden) return false;
    return r.width > 0 && r.height > 0;
  };
  // The element standing for a piece of text: the innermost element holding all of it, then outward through wrappers that
  // hold nothing else (<h3><a>Name</a></h3> is the h3).
  function outerText(n, cardEl) {
    let el = n;
    while (el.parentElement && el.parentElement !== cardEl && el.parentElement.children.length === 1 && textOf(el.parentElement) === textOf(el)) el = el.parentElement;
    return el;
  }
  const INLINE = /^(A|B|I|EM|STRONG|SPAN|SMALL|U|MARK|SUP|SUB|ABBR|S|DEL|INS|STRIKE|BDI|FONT|LABEL)$/;
  // A block of text is an element whose text is its own (or passes through one inline wrapper), never a container that
  // holds several separate pieces.
  function isLeafBlock(n) {
    const kids = [...n.children].filter((c) => !SKIP_TAG.test(c.tagName) && textOf(c));
    if (!kids.length) return true;
    if (kids.some((c) => !INLINE.test(c.tagName))) return false;
    return ownText(n) ? true : kids.length === 1;
  }
  function textBlocks(cardEl, nodes) {
    const out = [];
    for (const n of nodes) {
      if (SKIP_TAG.test(n.tagName) || /^(IMG|PICTURE|VIDEO|SVG|INPUT|SELECT|TEXTAREA)$/i.test(n.tagName)) continue;
      const t = textOf(n);
      if (!t || t.length > 200 || !isLeafBlock(n)) continue;
      if ([...n.children].some((c) => !SKIP_TAG.test(c.tagName) && textOf(c) === t)) continue; // an inner element holds the same text
      out.push({ n, el: outerText(n, cardEl), text: t });
    }
    return out;
  }
  const chainWithin = (n, cardEl) => { const out = []; for (let e = n; e && e !== cardEl && out.length < 8; e = e.parentElement) out.push(e); return out; };

  // ---- candidates
  function mk(key, el, score, how, reasons, value, extra) {
    return { key, el, score: Math.round(score), how, reasons, value: value || {}, text: clip(value?.text || textOf(el) || '', 60), visible: visibleNow(el, el.getBoundingClientRect()), ...(extra || {}) };
  }
  const bestHow = (parts) => parts.sort((a, b) => b.w - a.w)[0]?.how || 'content';

  function priceCandidates(cardEl, blocks) {
    const out = [];
    for (const b of blocks) {
      const ps = pricesIn(b.text);
      if (ps.length !== 1) { if (ps.length > 1 && b.text.length <= 40) out.push({ b, multi: true, p: ps[0], struck: false, sig: '' }); continue; }
      const p = ps[0];
      // The price must be what the text is about: "$27.99", "Now $27.99", "[$Sale]". Not "Free shipping over $50".
      const rest = b.text.replace(p.raw, '').replace(/[\s:*()]/g, '');
      const word = /^\s*(?:was|now|reg|regular|orig|original|sale|only|from)\b/i.test(b.text);
      const junk = /\/|\bper\b|\bship|\bover\b|\bsave\b|\boff\b|\bmonth|\bserving|\bcount\b/i.test(b.text);
      if (b.text.length > 26 || rest.length > 12 || (junk && !word)) continue;
      const chain = [];
      for (let e = b.n; e && e !== cardEl && pricesIn(textOf(e)).length === 1 && chain.length < 6; e = e.parentElement) chain.push(e);
      const struck = chain.some((e) => /^(S|DEL|STRIKE)$/.test(e.tagName) || /line-through/.test(getComputedStyle(e).textDecorationLine));
      out.push({ b, p, struck, chain, sig: chain.map(sigOf).join(' '), tags: chain.map((e) => e.tagName) });
    }
    return out;
  }
  const RE_REG = /(?:^|[^a-z])(was|compare|compareat|original|orig|regular|reg|msrp|old|list|before|strike|crossed|retail|rrp|full)(?:[^a-z]|$)/;
  const RE_SALE = /(?:^|[^a-z])(sale|now|special|promo|deal|current|offer|final|discounted|discount-price|price--sale|ins)(?:[^a-z]|$)/;
  const RE_LBL_REG = /\b(was|reg|regular|orig|original|msrp|list|compare)\b/i;
  const RE_LBL_SALE = /\b(now|sale|only|today|special|deal|promo)\b/i;

  function priceFields(pcs, ctx) {
    const real = pcs.filter((c) => !c.multi);
    const sale = []; const regular = [];
    const anyStruck = real.some((c) => c.struck);
    for (const c of real) {
      const hint = c.p.hint || '';
      const t = c.b.text;
      let r = 0; let s = 0; const rr = []; const sr = []; const rp = []; const sp = [];
      if (c.struck) { r += 60; rr.push('struck through'); rp.push({ how: /^(S|DEL|STRIKE)$/.test(c.tags?.[0] || '') ? 'semantic' : 'content', w: 60 }); s -= 50; }
      if (c.tags && c.tags.some((x) => x === 'INS')) { s += 55; sr.push('marked up as an insertion (<ins>)'); sp.push({ how: 'semantic', w: 55 }); }
      if (c.sig && RE_REG.test(c.sig)) { r += 40; rr.push('class or attribute names a regular price'); rp.push({ how: 'pattern', w: 40 }); }
      if (c.sig && RE_SALE.test(c.sig) && !c.struck) { s += 40; sr.push('class or attribute names a sale price'); sp.push({ how: 'pattern', w: 40 }); }
      if (RE_LBL_REG.test(t) || /reg|orig|compare|was/.test(hint)) { r += 35; rr.push('its text says it is the regular price'); rp.push({ how: 'content', w: 35 }); }
      if (RE_LBL_SALE.test(t) || /sale|now|promo|deal/.test(hint)) { s += 35; sr.push('its text says it is the sale price'); sp.push({ how: 'content', w: 35 }); }
      if (anyStruck && !c.struck) { s += 45; r -= 30; sr.push('the other price on the card is struck through'); sp.push({ how: 'content', w: 45 }); }
      c.rs = Math.max(r, 0); c.ss = Math.max(s, 0); c.rr = rr; c.sr = sr; c.rp = rp; c.sp = sp;
    }
    const cands = (key, scoreOf, reasonOf, partsOf) => real.map((c) => ({ c, v: scoreOf(c) })).filter((x) => x.v > 0).map(({ c, v }) => mk(key, c.b.el, v, bestHow(partsOf(c)), reasonOf(c), { text: c.b.text, cents: c.p.cents, placeholder: c.p.placeholder }, { struck: c.struck }));
    sale.push(...cands('sale', (c) => c.ss, (c) => c.sr, (c) => c.sp));
    regular.push(...cands('regular', (c) => c.rs, (c) => c.rr, (c) => c.rp));
    if (real.length === 1 && !real[0].rs && !real[0].ss) {
      // One unmarked price: it is the current price. Which field it belongs to is only a guess, so it is a weak suggestion.
      const c = real[0];
      const key = ctx.promo ? 'sale' : 'regular';
      (key === 'sale' ? sale : regular).push(mk(key, c.b.el, 30, 'content', ['the only price on the card (assumed from the product’s approved prices)'], { text: c.b.text, cents: c.p.cents, placeholder: c.p.placeholder }));
    } else if (real.length >= 2 && !sale.length && !regular.length) {
      // Two prices and nothing tells them apart: both are offered for both fields, nothing is chosen.
      for (const c of real) {
        sale.push(mk('sale', c.b.el, 20, 'content', ['one of two prices on the card; nothing says which is which'], { text: c.b.text, cents: c.p.cents, placeholder: c.p.placeholder }));
        regular.push(mk('regular', c.b.el, 20, 'content', ['one of two prices on the card; nothing says which is which'], { text: c.b.text, cents: c.p.cents, placeholder: c.p.placeholder }));
      }
    }
    // An element holding two prices can't be one price field: say so rather than pick a half of it.
    const multi = pcs.filter((c) => c.multi).map((c) => c.b.el);
    return { sale, regular, multi };
  }

  function titleCandidates(cardEl, blocks, taken) {
    const cands = [];
    const sizes = [];
    const rows = [];
    for (const b of blocks) {
      if (taken.has(b.n) || taken.has(b.el)) continue;
      const t = b.text;
      if (t.length < 2 || t.length > 140 || pricesIn(t).length || parseBadge(t) || MEDIA_RE.test(t) && t.length <= 40) continue;
      if (b.el.closest('button,[role="button"]') || (isCtaEl(b.el) && CTA_RE.test(t) && t.length <= 24)) continue;
      const cs = getComputedStyle(b.n);
      const size = parseFloat(cs.fontSize) || 0;
      const bold = /^(?:600|700|800|900|bold)$/.test(cs.fontWeight);
      sizes.push(size * (bold ? 1.25 : 1));
      rows.push({ b, size: size * (bold ? 1.25 : 1), bold, head: /^H[1-6]$/.test(b.el.tagName) || /^H[1-6]$/.test(b.n.tagName) || !!b.el.closest('h1,h2,h3,h4,h5,h6') && b.el.closest('h1,h2,h3,h4,h5,h6') !== cardEl });
    }
    const max = Math.max(1, ...sizes);
    for (const r of rows) {
      const sig = [r.b.el, r.b.n].map(sigOf).join(' ');
      let s = 0; const reasons = []; const parts = [];
      if (/\bname\b/.test(r.b.el.getAttribute('itemprop') || '') || r.b.n.getAttribute('itemprop') === 'name') { s += 75; reasons.push('itemprop="name"'); parts.push({ how: 'semantic', w: 75 }); }
      if (r.head) { s += 45; reasons.push('a heading'); parts.push({ how: 'semantic', w: 45 }); }
      if (/(?:^|[^a-z])(title|name|heading|product-?name|product-?title)(?:[^a-z]|$)/.test(sig)) { s += 35; reasons.push('class or attribute names a title'); parts.push({ how: 'pattern', w: 35 }); }
      const rel = r.size / max;
      if (rel >= 0.99) { s += 30; reasons.push('the most prominent text'); parts.push({ how: 'content', w: 30 }); } else if (rel >= 0.8) { s += 12; parts.push({ how: 'content', w: 12 }); }
      if (/product name|product title|\[[^\]]*name[^\]]*\]/i.test(r.b.text)) { s += 15; reasons.push('reads like a product-name placeholder'); parts.push({ how: 'content', w: 15 }); }
      if (s >= 20) cands.push(mk('title', r.b.el, s, bestHow(parts), reasons, { text: r.b.text }));
    }
    return cands;
  }

  const srcOf = (img) => {
    const g = (a) => (img.getAttribute(a) || '').trim();
    const first = (set) => (set ? set.split(',')[0].trim().split(/\s+/)[0] : '');
    const cands = [img.currentSrc, g('src'), g('data-src'), g('data-lazy-src'), g('data-original'), first(g('srcset')), first(g('data-srcset'))].filter(Boolean);
    return cands.find((u) => !/^data:image\/(?:gif|svg\+xml);/.test(u) || u.length > 400) || '';
  };
  const bgUrl = (cs) => { const m = /url\(["']?([^"')]+)["']?\)/.exec(cs.backgroundImage || ''); return m ? m[1] : ''; };
  function imageCandidates(cardEl, nodes) {
    const rows = [];
    for (const n of nodes) {
      if (n.tagName === 'IMG') {
        const r = n.getBoundingClientRect();
        const url = srcOf(n);
        if (!url && !(r.width > 0)) continue;
        rows.push({ n, el: n, area: r.width * r.height, vis: visibleNow(n, r), src: url, kind: 'img' });
      } else if (!/^(PICTURE|SVG|VIDEO|SOURCE)$/i.test(n.tagName)) {
        const cs = getComputedStyle(n);
        const u = bgUrl(cs);
        if (u) { const r = n.getBoundingClientRect(); rows.push({ n, el: n, area: r.width * r.height, vis: visibleNow(n, r), src: u, kind: 'bg' }); }
        else {
          const t = ownText(n);
          if (t && MEDIA_RE.test(t) && t.length <= 40) { const r = n.getBoundingClientRect(); rows.push({ n, el: n, area: r.width * r.height, vis: visibleNow(n, r), src: '', kind: 'placeholder', text: t }); }
        }
      }
    }
    const max = Math.max(1, ...rows.map((r) => r.area));
    const out = [];
    for (const r of rows) {
      if (r.kind !== 'placeholder' && r.area > 0 && r.area < 32 * 32) continue; // an icon
      const sig = sigOf(r.n);
      let s = r.kind === 'img' ? 60 : r.kind === 'bg' ? 45 : 40;
      const reasons = [r.kind === 'img' ? 'an <img>' : r.kind === 'bg' ? 'a CSS background image' : 'a placeholder standing in for the product image'];
      const parts = [{ how: r.kind === 'placeholder' ? 'content' : 'semantic', w: s }];
      if (r.n.getAttribute('itemprop') === 'image') { s += 15; reasons.push('itemprop="image"'); parts.push({ how: 'semantic', w: 15 }); }
      if (/(?:^|[^a-z])(image|img|photo|thumb|thumbnail|media|picture|product-?image)(?:[^a-z]|$)/.test(sig)) { s += 10; parts.push({ how: 'pattern', w: 10 }); }
      if (/(?:^|[^a-z])(logo|icon|badge|star|rating|payment|flag|arrow|sprite|avatar)(?:[^a-z]|$)/.test(sig)) { s -= 40; reasons.push('looks like an icon or logo'); }
      if (r.n.closest('picture')) reasons.push('inside a <picture>');
      if (r.kind === 'img' && (r.n.getAttribute('loading') === 'lazy' || r.n.getAttribute('data-src') || r.n.getAttribute('data-srcset'))) reasons.push('lazy-loaded');
      if (!r.vis && r.kind !== 'placeholder') { s -= 30; reasons.push('not visible right now (for example a hover image)'); }
      s += 25 * (r.area / max);
      if (s >= 25) out.push(mk('image', r.el, s, bestHow(parts), reasons, { text: r.text || '', src: r.src }, { visible: r.vis, placeholder: r.kind === 'placeholder', area: r.area }));
    }
    return out;
  }

  function badgeCandidates(cardEl, blocks, taken) {
    const out = [];
    for (const b of blocks) {
      if (taken.has(b.n) || taken.has(b.el)) continue;
      const bd = parseBadge(b.text);
      if (!bd) continue;
      const sig = [b.el, b.n].map(sigOf).join(' ');
      let s = 55; const reasons = [bd.placeholder ? 'a percent-off placeholder' : bd.kind === 'percent' ? `says ${bd.percent}% off` : 'an amount-off claim']; const parts = [{ how: 'content', w: 55 }];
      if (/(?:^|[^a-z])(badge|tag|label|ribbon|flag|sticker|save|discount|percent|pix)(?:[^a-z]|$)/.test(sig)) { s += 20; parts.push({ how: 'pattern', w: 20 }); }
      if (getComputedStyle(b.n).position === 'absolute') { s += 10; reasons.push('positioned over the card'); }
      out.push(mk('badge', b.el, s, bestHow(parts), reasons, { text: b.text, badge: bd }));
    }
    return out;
  }

  const CTA_ADD = /\badd\s*to\s*(?:cart|bag|basket)\b|^add$/i;
  const CTA_BUY = /\b(buy\s*(?:it\s*)?now|order\s*now|checkout)\b/i;
  const CTA_SHOP = /\b(shop\s*(?:now|deal)?|get\s*(?:the\s*)?deal|grab|claim|get\s*it|add)\b/i;
  const CTA_WEAK = /\b(view|details|learn|select|choose|quick\s*view|options)\b/i;
  const clickable = (n) => n.tagName === 'BUTTON' || (n.tagName === 'A' && n.hasAttribute('href')) || n.getAttribute('role') === 'button' || (n.tagName === 'INPUT' && /^(submit|button)$/i.test(n.type));
  function ctaCandidates(cardEl, nodes) {
    const out = [];
    for (const n of nodes) {
      if (!clickable(n)) continue;
      const label = (n.tagName === 'INPUT' ? n.value : textOf(n)) || n.getAttribute('aria-label') || '';
      if (!label || label.length > 40) continue;
      let s = 0; const reasons = []; const parts = [];
      if (CTA_ADD.test(label)) { s = 70; reasons.push('says “Add to cart”'); parts.push({ how: 'content', w: 70 }); }
      else if (CTA_BUY.test(label)) { s = 55; reasons.push(`says “${clip(label, 20)}”`); parts.push({ how: 'content', w: 55 }); }
      else if (CTA_SHOP.test(label)) { s = 50; reasons.push(`says “${clip(label, 20)}”`); parts.push({ how: 'content', w: 50 }); }
      else if (CTA_WEAK.test(label)) { s = 25; reasons.push(`says “${clip(label, 20)}” (more likely a link than a buy button)`); parts.push({ how: 'content', w: 25 }); }
      const form = n.closest('form');
      if (form && /cart\/add/.test(form.getAttribute('action') || '') && (n.tagName === 'BUTTON' || n.tagName === 'INPUT')) { s += 25; reasons.push('submits a /cart/add form'); parts.push({ how: 'semantic', w: 25 }); }
      if (n.getAttribute('name') === 'add') { s += 20; parts.push({ how: 'semantic', w: 20 }); }
      if (n.tagName === 'BUTTON' && s) { s += 8; parts.push({ how: 'semantic', w: 8 }); }
      if (s && /(?:^|[^a-z])(add-?to-?cart|atc|cta|buy|btn|button)(?:[^a-z]|$)/.test(sigOf(n))) { s += 10; parts.push({ how: 'pattern', w: 10 }); }
      if (s >= 25) out.push(mk('cta', n, s, bestHow(parts), reasons, { text: label, href: n.tagName === 'A' ? n.href : '' }));
    }
    return out;
  }
  const realHref = (h) => !!h && !/^(#|javascript:|mailto:|tel:)/i.test(h.trim());
  function linkCandidates(cardEl, nodes, titleEls, imageEls) {
    const out = [];
    const seen = new Set();
    const wrapper = cardEl.tagName === 'A' ? cardEl : cardEl.parentElement && cardEl.parentElement.closest('a[href]');
    const anchors = [...(wrapper ? [wrapper] : []), ...nodes.filter((n) => n.tagName === 'A' && n.hasAttribute('href'))];
    for (const a of anchors) {
      if (seen.has(a)) continue;
      seen.add(a);
      const raw = a.getAttribute('href') || '';
      if (/^(mailto:|tel:)/i.test(raw)) continue;
      const ok = realHref(raw);
      let s = 20; const reasons = []; const parts = [];
      if (a === wrapper) { s = 70; reasons.push(a === cardEl ? 'the whole card is this link' : 'the whole card sits inside this link'); parts.push({ how: 'semantic', w: 70 }); }
      else if ([...titleEls].some((t) => a.contains(t) || t.contains(a))) { s = 65; reasons.push('wraps the title'); parts.push({ how: 'content', w: 65 }); }
      else if ([...imageEls].some((t) => a.contains(t))) { s = 55; reasons.push('wraps the image'); parts.push({ how: 'content', w: 55 }); }
      else if (clickable(a) && CTA_RE.test(textOf(a)) && textOf(a).length <= 40) { s = 50; reasons.push('the call-to-action link'); parts.push({ how: 'content', w: 50 }); }
      if (/\/products\//.test(raw) && ok) { s += 20; reasons.push('points to /products/…'); parts.push({ how: 'content', w: 20 }); }
      if (!ok) { s -= 25; reasons.push(raw ? `its address is only “${clip(raw, 14)}” (a placeholder)` : 'it has no address yet'); }
      if (s >= 10) out.push(mk('link', a, s, bestHow(parts), reasons, { text: clip(textOf(a), 40), href: ok ? a.href : raw, placeholder: !ok }, { wrapper: a === wrapper && a !== cardEl }));
    }
    return out;
  }

  // ---- choosing among candidates
  function pickBest(cands, { sameValue } = {}) {
    const list = [...cands].sort((a, b) => b.score - a.score);
    // One element can be listed once; two elements that mean the same thing (same address) count as one.
    const uniq = [];
    for (const c of list) if (!uniq.some((u) => u.el === c.el || (sameValue && sameValue(u, c)))) uniq.push(c);
    const vis = uniq.some((c) => c.visible !== false) ? uniq.filter((c) => c.visible !== false) : uniq;
    if (!vis.length) return { status: 'none', best: null, candidates: [], confidence: null };
    const top = vis[0]; const second = vis[1];
    const confidence = top.score >= 70 ? 'high' : top.score >= 45 ? 'medium' : 'low';
    if (second && top.score - second.score < GAP) return { status: 'ambiguous', best: null, candidates: uniq, confidence: 'low', near: vis.filter((c) => top.score - c.score < GAP) };
    return { status: 'suggested', best: top, candidates: uniq, confidence };
  }

  // The explicit data-blueline-product-field marks: one per field wins outright.
  function explicitCandidates(nodes) {
    const by = {};
    for (const n of nodes) {
      const raw = fieldOf(n).toLowerCase();
      const key = EXPLICIT_FIELD[raw];
      if (!key) continue;
      (by[key] = by[key] || []).push(mk(key, n, 100, 'explicit', [`data-blueline-product-field="${raw}"`], { text: clip(textOf(n), 60), href: n.tagName === 'A' ? n.href : '', src: n.tagName === 'IMG' ? srcOf(n) : '' }));
    }
    return by;
  }

  // The card's fields. `ctx.promo`: the mapped product has an approved sale price (used only to place a lone price).
  function detectFields(cardEl, ctx = {}) {
    const nodes = qsa('*', cardEl).slice(0, 450).filter((n) => !SKIP_TAG.test(n.tagName));
    const blocks = textBlocks(cardEl, nodes);
    const exp = explicitCandidates(nodes);
    const pcs = priceCandidates(cardEl, blocks);
    const pf = priceFields(pcs, ctx);
    const priceEls = new Set(pcs.map((c) => c.b.el));
    const badgeCs = badgeCandidates(cardEl, blocks, priceEls);
    const taken = new Set([...priceEls, ...badgeCs.map((c) => c.el)]);
    const ctaCs = ctaCandidates(cardEl, nodes);
    const ctaEls = new Set(ctaCs.map((c) => c.el));
    for (const e of ctaEls) taken.add(e);
    const titleCs = titleCandidates(cardEl, blocks, new Set([...taken]));
    const imageCs = imageCandidates(cardEl, nodes);
    const linkCs = linkCandidates(cardEl, nodes, titleCs.map((c) => c.el), imageCs.map((c) => c.el));
    const raw = { title: titleCs, image: imageCs, sale: pf.sale, regular: pf.regular, badge: badgeCs, cta: ctaCs, link: linkCs };
    const fields = {};
    for (const key of FIELD_KEYS) {
      let cands = raw[key] || [];
      if (exp[key]) cands = [...exp[key], ...cands.filter((c) => !exp[key].some((e) => e.el === c.el))];
      // The same element can't be both the sale and the regular price, or the title and the price.
      let r = pickBest(cands, key === 'link' ? { sameValue: (a, b) => a.value.href && a.value.href === b.value.href } : {});
      fields[key] = { key, label: FIELD_LABELS[key], ...r, candidates: r.candidates.slice(0, 8), reasons: r.best ? r.best.reasons : [] };
    }
    // A price element goes to one field only: where both fields chose the same element the better-supported one keeps it.
    if (fields.sale.best && fields.regular.best && fields.sale.best.el === fields.regular.best.el) {
      const loser = fields.sale.best.score >= fields.regular.best.score ? 'regular' : 'sale';
      fields[loser] = { ...fields[loser], status: 'ambiguous', best: null, confidence: 'low' };
    }
    const multi = pf.multi.map((el) => ({ el, text: clip(textOf(el), 60) }));
    return { fields, multi, scanned: nodes.length };
  }

  // ---- references: how a confirmed assignment is saved and found again
  const roleTag = (el) => (el.getAttribute && (el.getAttribute('itemprop') || el.getAttribute('data-blueline-product-field') || '')) || '';
  const refPath = (cardEl, el) => (el === cardEl ? '' : relPath(cardEl, el));
  // A fingerprint of WHAT the element is and where it sits, never of its text (prices and names change legitimately).
  function fingerprint(cardEl, el, key) {
    const p = el.parentElement;
    const struck = (key === 'sale' || key === 'regular') ? (/^(S|DEL|STRIKE)$/.test(el.tagName) || /line-through/.test(getComputedStyle(el).textDecorationLine) || !!el.closest('s,del,strike')) : false;
    return hash([key, tagOf(el), classesOf(el).join('.'), roleTag(el), p && p !== cardEl.parentElement ? `${tagOf(p)}.${classesOf(p).join('.')}` : '', struck ? 'struck' : ''].join('|'));
  }
  function uniqueSelector(cardEl, el) {
    if (el === cardEl) return null;
    const tryIt = (sel) => { try { return cardEl.querySelectorAll(sel).length === 1 && cardEl.querySelector(sel) === el ? sel : null; } catch { return null; } };
    const cls = classesOf(el).slice(0, 3).map((c) => `.${esc(c)}`).join('');
    return tryIt(tagOf(el) + cls) || (el.parentElement && el.parentElement !== cardEl ? tryIt(`${tagOf(el.parentElement)}${classesOf(el.parentElement).slice(0, 2).map((c) => `.${esc(c)}`).join('')} > ${tagOf(el)}${cls}`) : null);
  }
  function stableAttr(cardEl, el) {
    for (const name of ['data-blueline-product-field', 'itemprop']) {
      const v = el.getAttribute && el.getAttribute(name);
      if (v && cardEl.querySelectorAll(`[${name}="${esc(v)}"]`).length === 1) return { name, value: v };
    }
    return null;
  }
  function fieldRef(cardEl, el, key) {
    const wrapper = el !== cardEl && !cardEl.contains(el);
    return JSON.parse(JSON.stringify({
      v: 1, path: wrapper ? '^' : refPath(cardEl, el), tag: tagOf(el), classes: classesOf(el).slice(0, 4), attr: wrapper ? null : stableAttr(cardEl, el),
      fp: fingerprint(cardEl, el, key), sel: wrapper ? null : uniqueSelector(cardEl, el), text: clip(textOf(el), 40) || undefined,
    }));
  }
  // The values as read from the page right now (never written back to the page).
  function fieldValue(el, key) {
    if (!el) return {};
    const t = textOf(el);
    if (key === 'sale' || key === 'regular') { const p = pricesIn(t); return { text: clip(t, 60), cents: p.length === 1 ? p[0].cents : null, placeholder: p.length === 1 && p[0].placeholder }; }
    if (key === 'image') return { src: el.tagName === 'IMG' ? srcOf(el) : bgUrl(getComputedStyle(el)), text: el.tagName === 'IMG' ? el.getAttribute('alt') || '' : clip(ownText(el), 40) };
    if (key === 'link') return { href: el.tagName === 'A' ? el.href : '', text: clip(t, 40), placeholder: el.tagName === 'A' ? !realHref(el.getAttribute('href') || '') : false };
    if (key === 'cta') return { text: clip(el.tagName === 'INPUT' ? el.value : t, 40), href: el.tagName === 'A' ? el.href : '' };
    if (key === 'badge') return { text: clip(t, 40), badge: parseBadge(t) };
    return { text: clip(t, 80) };
  }
  // Does the element still look like what the field is?
  function roleOk(key, el) {
    if (!el || !el.isConnected) return false;
    if (key === 'sale' || key === 'regular') return pricesIn(textOf(el)).length === 1;
    if (key === 'title') return !!textOf(el) && !pricesIn(textOf(el)).length;
    if (key === 'image') return el.tagName === 'IMG' || !!bgUrl(getComputedStyle(el)) || (!!ownText(el) && MEDIA_RE.test(ownText(el)));
    if (key === 'badge') return !!parseBadge(textOf(el));
    if (key === 'cta') return clickable(el);
    if (key === 'link') return el.tagName === 'A' && el.hasAttribute('href');
    return true;
  }
  // Finds a saved assignment on the page again. 'ok' only when it is certain; otherwise the page changed and the person
  // reviews it: 'moved' (one look-alike elsewhere in the card, offered), 'ambiguous' (several), 'changed' (something else
  // is where it was), 'invalid' (it no longer holds this kind of value) or 'missing'. Nothing is ever re-assigned silently.
  function resolveFieldRef(cardEl, key, ref) {
    const res = { state: 'missing', el: null, candidates: [], reasons: [] };
    if (!cardEl || !ref) { res.reasons.push('there is no saved reference'); return res; }
    if (ref.path === '^') {
      const a = cardEl.parentElement && cardEl.parentElement.closest('a[href]');
      if (a && roleOk(key, a)) { res.state = 'ok'; res.el = a; } else res.reasons.push('the link around the card is gone');
      return res;
    }
    const checks = (el) => (roleOk(key, el) ? null : 'it no longer holds this kind of value');
    if (ref.attr) {
      const hit = qsa(`[${esc(ref.attr.name)}="${esc(ref.attr.value)}"]`, cardEl);
      if (hit.length === 1) { const bad = checks(hit[0]); if (!bad) { res.state = 'ok'; res.el = hit[0]; return res; } res.state = 'invalid'; res.candidates = hit; res.reasons.push(bad); return res; }
    }
    let at = null;
    if (ref.path === '') at = cardEl;
    else { try { at = cardEl.querySelector(`:scope > ${ref.path}`); } catch { at = null; } }
    if (at && tagOf(at) === ref.tag && fingerprint(cardEl, at, key) === ref.fp) {
      const bad = checks(at);
      if (!bad) { res.state = 'ok'; res.el = at; return res; }
      res.state = 'invalid'; res.candidates = [at]; res.reasons.push(bad); return res;
    }
    const like = qsa(ref.tag, cardEl).filter((n) => fingerprint(cardEl, n, key) === ref.fp && roleOk(key, n));
    if (like.length === 1) { res.state = 'moved'; res.candidates = like; res.reasons.push('the element is no longer where it was; one look-alike is elsewhere in the card'); return res; }
    if (like.length > 1) { res.state = 'ambiguous'; res.candidates = like; res.reasons.push(`${like.length} look-alike elements now match`); return res; }
    if (at) { res.state = 'changed'; res.candidates = [at]; res.reasons.push('a different element is where it was saved'); return res; }
    res.reasons.push('the element is gone from the card');
    return res;
  }

  // ---- Change Report: where each field is, for a developer (read-only; nothing is stored or changed)
  //
  // fieldLocator describes ONE element so a developer can find it without Blueline: a selector scoped to the card when it
  // is unique there, otherwise a structural path (marked fragile), plus a short markup snippet and its parent.
  const attrSnippet = (el) => {
    const keep = ['id', 'class', 'itemprop', 'data-blueline-product-field', 'role', 'aria-label', 'href', 'src', 'alt'];
    const parts = [];
    for (const n of keep) { const v = el.getAttribute && el.getAttribute(n); if (v) parts.push(`${n}="${clip(v, n === 'class' || n === 'href' || n === 'src' ? 60 : 40).replace(/"/g, "'")}"`); }
    return parts.length ? ' ' + parts.join(' ') : '';
  };
  const snippetOf = (el) => `<${tagOf(el)}${attrSnippet(el)}>${clip(el.children.length ? textOf(el) : (el.textContent || '').trim(), 40).replace(/\s+/g, ' ')}</${tagOf(el)}>`;
  const parentTag = (cardEl, el) => { const p = el.parentElement; if (!p || p === cardEl) return 'the card itself'; return tagOf(p) + classesOf(p).slice(0, 3).map((c) => `.${c}`).join(''); };
  function fieldLocator(cardEl, el, key) {
    if (!cardEl || !el) return null;
    const wrapper = el !== cardEl && !cardEl.contains(el);
    const ref = fieldRef(cardEl, el, key);
    const sel = wrapper || el === cardEl ? null : ref.sel;
    const path = wrapper ? null : el === cardEl ? null : ref.path;
    const generic = !!sel && /^[a-z][a-z0-9]*(?: > [a-z][a-z0-9]*)?$/i.test(sel);
    let why = null;
    if (wrapper) why = 'the link wraps the card from outside';
    else if (el === cardEl) why = 'the card element itself';
    else if (!sel) why = 'no short unique selector: the structural path depends on the card’s exact markup order';
    else if (generic) why = 'the selector is only tag names, so it is generic';
    return {
      sel: sel || null, path: path || null, tag: tagOf(el), classes: classesOf(el).slice(0, 4), snippet: snippetOf(el), parent: wrapper ? 'outside the card' : parentTag(cardEl, el),
      wrapper, self: el === cardEl, fragile: !!why, fragileWhy: why,
    };
  }
  // The card's fields as a developer needs them. `saved` = the mapping's confirmed/unmapped items ({ key: { state, ref } }).
  // Every field gets a basis: confirmed (a person assigned it, and it resolves now), review (confirmed once, but the page no
  // longer matches), detected (found by Blueline, never confirmed), ambiguous (several equal candidates), missing, or
  // unmapped (a person said the card has none). Nothing is invented: a field with no element has no selector.
  function exportFields(cardEl, saved = {}, ctx = {}) {
    const det = detectFields(cardEl, { promo: !!ctx.promo });
    const out = {};
    const used = new Set();
    const els = {};
    for (const key of FIELD_KEYS) {
      const s = saved[key];
      const d = det.fields[key];
      if (s && s.state === 'unmapped') { out[key] = { basis: 'unmapped' }; continue; }
      if (s && s.state === 'confirmed') {
        const x = resolveFieldRef(cardEl, key, s.ref);
        if (x.state === 'ok') { out[key] = { basis: 'confirmed', loc: fieldLocator(cardEl, x.el, key), value: fieldValue(x.el, key) }; used.add(x.el); els[key] = x.el; continue; }
        out[key] = { basis: 'review', state: x.state, reasons: x.reasons, candidates: x.candidates.slice(0, 3).map((e) => ({ loc: fieldLocator(cardEl, e, key), value: fieldValue(e, key) })) };
        continue;
      }
      if (d.status === 'suggested' && d.best) { out[key] = { basis: 'detected', confidence: d.confidence, how: d.best.how, loc: fieldLocator(cardEl, d.best.el, key), value: fieldValue(d.best.el, key) }; used.add(d.best.el); els[key] = d.best.el; }
      else if (d.status === 'ambiguous') out[key] = { basis: 'ambiguous', candidates: (d.near || d.candidates).slice(0, 3).map((c) => ({ loc: fieldLocator(cardEl, c.el, key), value: fieldValue(c.el, key) })) };
      else out[key] = { basis: 'missing' };
    }
    // The call-to-action (e.g. SHOP DEAL) is the card's cart control, not a product link: it is never offered as the link, so
    // the product address stays separate mapping data. A card whose only link IS the control simply has no separate link.
    const ctaEl = els.cta || null;
    if (ctaEl && !(saved.link && (saved.link.state === 'confirmed' || saved.link.state === 'unmapped'))) {
      const rest = (det.fields.link.candidates || []).filter((c) => c.el !== ctaEl && !ctaEl.contains(c.el) && !c.el.contains(ctaEl));
      const hrefs = new Set(rest.map((c) => (c.value && c.value.href) || c.el));
      if (out.link.basis === 'detected' && out.link.loc && els.link === ctaEl) {
        if (!rest.length) out.link = { basis: 'missing', sharedWithCta: true };
        else if (hrefs.size === 1) out.link = { basis: 'detected', confidence: 'medium', how: rest[0].how, loc: fieldLocator(cardEl, rest[0].el, 'link'), value: fieldValue(rest[0].el, 'link') };
        else out.link = { basis: 'ambiguous', candidates: rest.slice(0, 3).map((c) => ({ loc: fieldLocator(cardEl, c.el, 'link'), value: fieldValue(c.el, 'link') })) };
      } else if (out.link.basis === 'ambiguous') {
        const keep = (out.link.candidates || []).filter((c) => c.loc && !(c.loc.sel === (out.cta.loc && out.cta.loc.sel) && c.loc.path === (out.cta.loc && out.cta.loc.path) && c.loc.tag === (out.cta.loc && out.cta.loc.tag)));
        if (keep.length === 1) out.link = { basis: 'detected', confidence: 'low', loc: keep[0].loc, value: keep[0].value };
        else if (!keep.length) out.link = { basis: 'missing', sharedWithCta: true };
        else out.link = { ...out.link, candidates: keep };
      }
    }
    if (out.link && out.link.loc && ctaEl && els.link === ctaEl) out.link.sharesCta = true;
    // Other short text in the card (a category or label written for the previous product), never one of the fields above.
    const nodes = qsa('*', cardEl).slice(0, 450).filter((n) => !SKIP_TAG.test(n.tagName));
    const labels = [];
    for (const b of textBlocks(cardEl, nodes)) {
      if ([...used].some((u) => u === b.el || u.contains(b.el) || b.el.contains(u)) || b.text.length < 2 || b.text.length > 28) continue;
      if (pricesIn(b.text).length || parseBadge(b.text) || isCtaEl(b.el) || b.el.closest('a,button')) continue;
      const loud = /^[A-Z0-9][A-Z0-9 &\-/+'’]{1,26}$/.test(b.text) && /[A-Z]{2}/.test(b.text);
      const named = /(?:^|[^a-z])(cat|category|eyebrow|kicker|label|tag|type|collection|goal|pill|chip)(?:[^a-z]|$)/.test(sigOf(b.el));
      if (loud || named) labels.push({ text: b.text, loc: fieldLocator(cardEl, b.el, 'label') });
      if (labels.length >= 3) break;
    }
    return { fields: out, labels };
  }

  // What a click on the page means for a field: the nearest element at or above the click that can hold that field (a
  // click on a price's currency symbol means the price). null when nothing there could be it. Used by the picker, which
  // is limited to the card.
  function snapPick(cardEl, key, el) {
    if (!cardEl || !el) return null;
    if (key === 'link') { const a = el.closest && el.closest('a[href]'); return a && (cardEl.contains(a) || a.contains(cardEl)) ? { el: a } : null; }
    if (key === 'image' && el.tagName === 'PICTURE') { const img = el.querySelector('img'); return img ? { el: img } : null; }
    for (let n = el; n && n !== cardEl && cardEl.contains(n); n = n.parentElement) {
      if (!roleOk(key, n)) continue;
      if (key === 'title' || key === 'sale' || key === 'regular' || key === 'badge') {
        if (textOf(n).length > 140) continue;
        return { el: outerText(n, cardEl) };
      }
      return { el: n };
    }
    return null;
  }

  // ------------------------------------------------------------------ the other product cards on the page
  //
  // discoverCards(seedEl) starts from ONE confirmed card and looks for the page's other product cards, in two steps:
  //   same layout    elements built like the confirmed one (same tag, mostly the same classes, a similar inner structure)
  //                  that also hold product content. These are proposed as cards.
  //   other layouts  repeated groups built differently (another section's cards). Held to a stricter test (a price, a
  //                  title, and an image or button, repeated at least twice, outside navigation / header / footer), and
  //                  marked "review": the person includes them on purpose.
  // Nothing here is stored. A card is never recognised by text or by a class name alone, a lone banner is never a card
  // (a card needs at least one comparable sibling), and the result is a list for the person to review, in document order.
  const CHROME_AREA = 'nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [role="dialog"], [aria-modal="true"]';
  const strongCard = (s) => s.price && (s.media || s.cta) && s.title;
  const docOrder = (a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

  function cardBrief(el) {
    const h = el.querySelector('h1,h2,h3,h4,h5,h6');
    let title = h ? textOf(h) : '';
    if (!title) {
      const named = qsa('[class*="title" i],[class*="name" i]', el).find((n) => textOf(n) && textOf(n).length <= 80 && !PRICE_RE.test(textOf(n)));
      if (named) title = textOf(named);
    }
    const img = el.querySelector('img');
    let media = '';
    if (img) media = img.currentSrc || img.getAttribute('src') || '';
    const placeholder = qsa('*', el).slice(0, 200).map((n) => ownText(n)).find((t) => t && MEDIA_RE.test(t) && t.length <= 40) || '';
    const prices = [];
    for (const n of qsa('*', el).slice(0, 200)) {
      const t = labelOf(n);
      if (t && PRICE_RE.test(t) && t.length <= 40 && !prices.includes(t)) prices.push(t);
      if (prices.length >= 2) break;
    }
    return { title: clip(title, 60), image: /^(https?:|data:image|\/|\.)/i.test(media) ? media : '', placeholder: clip(placeholder, 40), prices };
  }

  function discoverCards(seedEl, { cap = 150 } = {}) {
    if (!seedEl || !seedEl.isConnected) return { seed: null, cards: [] };
    const found = new Map(); // element -> { family, why }
    const sa = shapeTokens(seedEl);
    const seedClasses = classesOf(seedEl);
    const add = (el, family, why) => { if (!found.has(el)) found.set(el, { family, why }); };
    add(seedEl, 'same', 'the card you confirmed');

    // 1. Built like the confirmed card.
    let pool;
    if (seedClasses.length) pool = qsa(tagOf(seedEl) + seedClasses.map((c) => `.${esc(c)}`).join('')).slice(0, 400);
    else {
      const p = seedEl.parentElement;
      const pc = p ? classesOf(p) : [];
      const parents = p && pc.length ? qsa(tagOf(p) + pc.map((c) => `.${esc(c)}`).join('')).slice(0, 80) : p ? [p] : [];
      pool = parents.flatMap((pp) => [...pp.children].filter((c) => c.tagName === seedEl.tagName));
    }
    for (const el of pool) {
      if (el === seedEl || found.has(el)) continue;
      if (el.contains(seedEl) || seedEl.contains(el)) continue;
      if (!similar(seedEl, sa, el)) continue;
      if (!productLike(signals(el)) || containsCards(el)) continue;
      add(el, 'same', 'built like the card you confirmed');
    }

    // 2. Other layouts: repeated groups with real product evidence, away from navigation, headers and footers.
    let examined = 0;
    for (const p of qsa('body *').slice(0, 6000)) {
      if (examined >= 80 || found.size >= cap) break;
      const kids = [...p.children];
      if (kids.length < 2) continue;
      const byTag = new Map();
      for (const k of kids) byTag.set(k.tagName, [...(byTag.get(k.tagName) || []), k]);
      for (const group of byTag.values()) {
        if (group.length < 2) continue;
        const rep = group.find((k) => !found.has(k) && !k.contains(seedEl) && !seedEl.contains(k));
        if (!rep || !PRICE_RE.test(textOf(rep)) || rep.closest(CHROME_AREA)) continue;
        examined++;
        const sr = shapeTokens(rep);
        const members = group.filter((k) => !found.has(k) && !k.contains(seedEl) && !seedEl.contains(k) && (k === rep || similar(rep, sr, k)));
        if (members.length < 2) continue;
        if (!members.every((k) => strongCard(signals(k)) && !containsCards(k) && !k.closest(CHROME_AREA))) continue;
        for (const k of members) if (![...found.keys()].some((f) => f.contains(k) || k.contains(f))) add(k, 'other', 'a repeated group with prices, titles and images or buttons, built differently from the card you confirmed');
      }
    }

    const cards = [...found.entries()].sort((a, b) => docOrder(a[0], b[0])).slice(0, cap).map(([el, f]) => {
      const sec = sectionOf(el);
      return { el, family: f.family, confidence: f.family === 'same' ? 'high' : 'review', why: f.why, section: sec, hidden: isHidden(el), brief: cardBrief(el), seed: el === seedEl };
    });
    return { seed: seedEl, cards };
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

  return {
    SCHEMA, hash, propose, describe, evaluate, measure, discoverSlots, slotElement, reportLines, isBroad, cardLike, group, sectionOf, signals,
    discoverCards, cardBrief, isHidden, FIELD_KEYS, FIELD_LABELS, pricesIn, parseBadge, detectFields, exportFields, fieldLocator, snapPick, fieldRef, fieldValue, resolveFieldRef, roleOk,
  };
});
