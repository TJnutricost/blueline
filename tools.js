/* Blueline v0.5 — one-panel annotation tools (extends the core in content.js through window.__BL)
 * One box: list of notes, tools, and the note editor all live in the same draggable panel.
 * One "Add note" action: click an element, Shift-click to add more, or drag to mark an area.
 */
(() => {
  const BL = globalThis.__BL;
  if (!BL || BL.tools) return;
  BL.tools = true;
  BL.docked = true;
  const { S, hooks } = BL;

  const INK = '#2B4EFF';
  const GUIDE = '#E5239D';
  const WARM = '#F08A1C';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const DRAW_COLORS = [GUIDE, INK, '#F5B400', '#16A34A', '#111111'];

  const T = { pick: null, speech: null, gdrag: null, simEls: null, hot: null, eatClick: false };
  const A = { on: false, mode: 'select', keep: false, drag: null };
  const D = { tool: null, color: GUIDE, cur: null };
  const emptyPop = () => ({
    priority: 'must', bps: new Set(), scope: 'one', groupIdx: 0, scopeTouched: false, tweaks: {}, textEdit: null, hide: false,
    figma: '', variant: null, match: null, move: null, align: {}, alignInfo: {}, snap: { x: 0, y: 0 }, measures: [], colors: [],
    marks: [], marksDirty: false, els: [], el: null, item: null, committed: false, auto: false,
  });
  let P = emptyPop();
  const touched = new WeakMap(); // el -> { prop: { v, p } } inline styles we overwrote for previews
  let mountedRoot = null;
  let attached = false;
  let varIdx = null;
  let editing = null;
  let varT = 0;
  let ovSaveT = 0;
  const OV = { host: null, img: null, state: { dataUrl: null, opacity: 50, width: 0, x: 0, y: 0, diff: false, visible: true } };
  let sheet = null;

  // ------------------------------------------------------------------ helpers

  const q = (sel) => (S.ui ? S.ui.root.querySelector(sel) : null);
  const qa = (sel) => (S.ui ? [...S.ui.root.querySelectorAll(sel)] : []);
  const mk = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rnd = (n) => Math.round(n * 10) / 10;
  const rnd2 = (n) => Math.round(n * 100) / 100;
  const code = (s) => BL.code(s);
  const clip = (s, n) => BL.clip(s, n);
  const here = () => BL.currentPath();
  const mine = (el) => !!S.ui && (el === S.ui.host || S.ui.host.contains(el));
  const itemsHere = () => (S.batch?.items || []).filter((i) => i.path === here());
  const bpNow = () => BL.bp(window.innerWidth);
  const toast = (m) => BL.toast(m);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const matches = (n) => `${n} match${n === 1 ? '' : 'es'}`;
  const hasPreview = (it) => !!((it.tweaks && it.tweaks.length) || it.textEdit || it.hidden);
  const appliesHere = (it) => !it.bps || !it.bps.length || it.bps.includes(bpNow());
  const isRegionPop = () => !!(S.pop && (S.pop.region || S.pop.item?.kind === 'region'));
  const setOn = (x, on) => { const b = q(`[data-x="${x}"]`); if (b) b.classList.toggle('on', !!on); };
  const textOf = (e, n = 24) => clip((e.innerText ?? e.textContent ?? '').replace(/\s+/g, ' ').trim(), n);
  const pickable = (e) => (e.target instanceof Element && e.target !== document.documentElement && e.target !== document.body && !mine(e.target) ? e.target : null);

  // ------------------------------------------------------------------ inline previews (all targets of a note)

  function setInline(el, prop, value) {
    let rec = touched.get(el);
    if (!rec) { rec = {}; touched.set(el, rec); }
    if (!(prop in rec)) rec[prop] = { v: el.style.getPropertyValue(prop), p: el.style.getPropertyPriority(prop) };
    el.style.setProperty(prop, value, 'important');
  }

  function restoreInline(el, prop) {
    const rec = touched.get(el);
    if (!rec || !(prop in rec)) return;
    const { v, p } = rec[prop];
    if (v) el.style.setProperty(prop, v, p); else el.style.removeProperty(prop);
    if (!(el.getAttribute('style') || '').trim()) el.removeAttribute('style');
    delete rec[prop];
  }

  function targetsOf(it) {
    const els = [];
    const prim = it.el?.selector ? BL.query(it.el.selector) : null;
    if (prim) els.push(prim);
    for (const a of it.also || []) { const e = BL.query(a.selector); if (e) els.push(e); }
    return els;
  }

  function applyItemPreview(it, on) {
    if (it.path !== here() || it.kind === 'region') return;
    const live = on && appliesHere(it);
    const els = targetsOf(it);
    for (const el of els) {
      for (const t of it.tweaks || []) { if (live) setInline(el, t.prop, t.to); else restoreInline(el, t.prop); }
      if (it.hidden) { if (live) setInline(el, 'display', 'none'); else restoreInline(el, 'display'); }
    }
    if (it.textEdit && els[0] && !els[0].children.length) {
      const want = live ? it.textEdit.after : it.textEdit.before;
      if (els[0].textContent.trim() !== want) els[0].textContent = want;
    }
  }

  function applyAllPreviews(forceOff) {
    const on = !forceOff && S.prefs.previews !== false;
    for (const it of S.batch?.items || []) if (hasPreview(it)) applyItemPreview(it, on);
  }

  function revertLive() {
    for (const el of P.els) {
      for (const prop of Object.keys(P.tweaks)) restoreInline(el, prop);
      if (P.hide) restoreInline(el, 'display');
    }
    if (P.textEdit && P.els[0] && !P.els[0].children.length) P.els[0].textContent = P.textEdit.before;
  }

  // ------------------------------------------------------------------ similar elements (scope)

  const moduleStem = (c) => (c.includes('-module__') ? c.slice(0, c.indexOf('-module__') + 9) : c.replace(/__[A-Za-z0-9_-]{5}$/, '__'));

  function similarSelector(el) {
    const tag = el.tagName.toLowerCase();
    const tw = BL.stylingOf(el).includes('tailwind');
    const cls = [...el.classList].filter(BL.isStableClass).slice(0, tw ? 8 : 3);
    if (cls.length) return tag + cls.map((c) => '.' + CSS.escape(c)).join('');
    const mod = [...el.classList].find(BL.decodeModule);
    if (mod) return `${tag}[class*="${moduleStem(mod)}"]`;
    const slot = el.getAttribute('data-slot');
    if (slot) return `${tag}[data-slot="${CSS.escape(slot)}"]`;
    const role = el.getAttribute('role');
    if (role) return `${tag}[role="${role}"]`;
    const type = el.getAttribute('type');
    if (type && /^(INPUT|BUTTON)$/.test(el.tagName)) return `${tag}[type="${type}"]`;
    return tag;
  }

  // Ancestors that contain more matches than the one below them: "all like it inside ___".
  function groupOptions(el) {
    const sel = similarSelector(el);
    const res = [];
    let last = 1;
    let node = el.parentElement;
    for (let i = 0; node && node !== document.documentElement && i < 10; i++, node = node.parentElement) {
      if (node === document.body) continue;
      let n = 0;
      try { n = node.querySelectorAll(sel).length; } catch { n = 0; }
      if (n > last) { res.push({ node, label: BL.label(node), count: n }); last = n; }
    }
    return res;
  }

  function similar(el, mode, groupIdx = 0) {
    if (mode === 'one') return { sel: BL.cssPath(el), els: [el], root: null };
    const sel = similarSelector(el);
    let root = document;
    if (mode === 'group') {
      const o = groupOptions(el)[groupIdx] || groupOptions(el)[0];
      if (!o) return { sel, els: [el], root: null };
      root = o.node;
    }
    let els = [];
    try { els = [...root.querySelectorAll(sel)]; } catch { els = []; }
    els = els.filter((e) => !mine(e) && e.getClientRects().length > 0);
    return { sel, els, root: mode === 'group' ? root : null };
  }

  function scopeInfo() {
    const el = P.el;
    const all = similar(el, 'all');
    const cur = P.scope === 'all' ? all : P.scope === 'group' ? similar(el, 'group', P.groupIdx) : { sel: all.sel, els: [el], root: null };
    return {
      mode: P.scope,
      count: P.scope === 'one' ? 1 : cur.els.length,
      selector: cur.sel,
      container: cur.root ? BL.label(cur.root) : null,
      labels: cur.els.filter((e) => e !== el).slice(0, 3).map((e) => { const t = textOf(e); return BL.label(e) + (t ? ` "${t}"` : ''); }),
      similar: all.els.length,
      chosen: P.scopeTouched || P.scope !== 'one',
    };
  }

  // ------------------------------------------------------------------ token hints

  const TW_FONT = { 12: 'text-xs', 14: 'text-sm', 16: 'text-base', 18: 'text-lg', 20: 'text-xl', 24: 'text-2xl', 30: 'text-3xl', 36: 'text-4xl', 48: 'text-5xl', 60: 'text-6xl', 72: 'text-7xl' };
  const TW_WEIGHT = { 100: 'font-thin', 200: 'font-extralight', 300: 'font-light', 400: 'font-normal', 500: 'font-medium', 600: 'font-semibold', 700: 'font-bold', 800: 'font-extrabold', 900: 'font-black' };
  const TW_RADIUS = { 0: 'rounded-none', 2: 'rounded-sm', 4: 'rounded', 6: 'rounded-md', 8: 'rounded-lg', 12: 'rounded-xl', 16: 'rounded-2xl', 24: 'rounded-3xl', 9999: 'rounded-full' };
  const TW_SPACE = [0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 256, 288, 320, 384];
  const spaceName = (x) => (x === 0 ? '0' : x === 1 ? 'px' : TW_SPACE.includes(x) ? String(x / 4) : null);

  function spacingClasses(prefix, v) {
    const parts = v.split(/\s+/);
    if (!parts.length || parts.length > 4 || !parts.every((p) => /^-?[\d.]+px$/.test(p))) return [];
    const n = parts.map(parseFloat);
    const [t, r, b, l] = n.length === 1 ? [n[0], n[0], n[0], n[0]] : n.length === 2 ? [n[0], n[1], n[0], n[1]] : n.length === 3 ? [n[0], n[1], n[2], n[1]] : n;
    const names = [t, r, b, l].map(spaceName);
    if (names.includes(null)) return [];
    if (t === r && r === b && b === l) return [`${prefix}-${names[0]}`];
    if (t === b && l === r) return [`${prefix}y-${names[0]}`, `${prefix}x-${names[3]}`];
    return [`${prefix}t-${names[0]}`, `${prefix}r-${names[1]}`, `${prefix}b-${names[2]}`, `${prefix}l-${names[3]}`];
  }

  function normForVar(v) {
    v = String(v).trim();
    if (/^(#|rgb|hsl|oklch|oklab|lab|lch|color\()/i.test(v)) {
      const c = BL.rgba(v);
      return c ? BL.hex(c) + (c.a < 1 ? `/${rnd(c.a)}` : '') : v.toLowerCase();
    }
    const m = v.match(/^(-?[\d.]+)(px|rem)?$/);
    if (m) return m[2] ? `${m[2] === 'rem' ? parseFloat(m[1]) * 16 : parseFloat(m[1])}px` : String(parseFloat(m[1]));
    return v.toLowerCase();
  }

  function cssVarIndex() {
    if (varIdx) return varIdx;
    const names = new Set();
    for (const sheetObj of document.styleSheets) {
      let rules;
      try { rules = sheetObj.cssRules; } catch { continue; }
      for (const r of rules || []) {
        if (r instanceof CSSStyleRule && /(^|,)\s*(:root|html|body)\s*(,|$)/.test(r.selectorText || '')) {
          for (let i = 0; i < r.style.length; i++) if (r.style[i].startsWith('--')) names.add(r.style[i]);
        }
      }
    }
    const cs = getComputedStyle(document.documentElement);
    varIdx = [];
    for (const n of names) { const val = cs.getPropertyValue(n).trim(); if (val) varIdx.push({ name: n, val: normForVar(val) }); }
    return varIdx;
  }

  function tokenHint(prop, value, tw) {
    const out = [];
    const v = String(value).trim();
    const n = parseFloat(v);
    const isPx = /^-?[\d.]+px$/.test(v);
    if (tw) {
      if (prop === 'font-size' && isPx && TW_FONT[n]) out.push(TW_FONT[n]);
      if (prop === 'font-weight' && TW_WEIGHT[v]) out.push(TW_WEIGHT[v]);
      if (prop === 'border-radius' && isPx && TW_RADIUS[n] !== undefined) out.push(TW_RADIUS[n]);
      if (prop === 'line-height') {
        const m = { 1: 'leading-none', 1.25: 'leading-tight', 1.375: 'leading-snug', 1.5: 'leading-normal', 1.625: 'leading-relaxed', 2: 'leading-loose' };
        if (!isPx && m[v]) out.push(m[v]);
        else if (isPx && [12, 16, 20, 24, 28, 32, 36, 40].includes(n)) out.push(`leading-${n / 4}`);
      }
      if (prop === 'padding') out.push(...spacingClasses('p', v));
      if (prop === 'margin') out.push(...spacingClasses('m', v));
      if (prop === 'gap' && isPx && spaceName(n)) out.push(`gap-${spaceName(n)}`);
      if (prop === 'opacity') { const pc = Math.round(parseFloat(v) * 100); if (pc % 5 === 0) out.push(`opacity-${pc}`); }
      if (prop === 'max-width' && isPx) out.push(`max-w-[${n}px]`);
      if (prop === 'width' && isPx) out.push(`w-[${n}px]`);
    }
    const norm = normForVar(v);
    if (norm && !/^(auto|none|normal)$/.test(norm)) for (const x of cssVarIndex()) if (x.val === norm) out.push(`var(${x.name})`);
    return out.slice(0, 4).map(code).join(', ');
  }

  // ------------------------------------------------------------------ region context

  function regionContext(vr) {
    const cx = (vr.left + vr.right) / 2;
    const cy = (vr.top + vr.bottom) / 2;
    const stack = (document.elementsFromPoint ? document.elementsFromPoint(cx, cy) : []).filter((e) => !mine(e) && e !== document.documentElement && e !== document.body);
    const contains = (b) => b.left <= vr.left + 2 && b.right >= vr.right - 2 && b.top <= vr.top + 2 && b.bottom >= vr.bottom - 2;
    const container = stack.find((e) => contains(e.getBoundingClientRect())) || document.querySelector('main') || document.body;
    const kids = [...container.children].filter((c) => !mine(c) && !/^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(c.tagName)).map((c) => ({ c, b: c.getBoundingClientRect() })).filter((k) => k.b.width > 0 && k.b.height > 0);
    const near = (k) => ({ label: BL.label(k.c), selector: BL.cssPath(k.c) });
    const above = kids.filter((k) => k.b.bottom <= vr.top + 4).sort((a, b) => b.b.bottom - a.b.bottom)[0];
    const below = kids.filter((k) => k.b.top >= vr.bottom - 4).sort((a, b) => a.b.top - b.b.top)[0];
    const sameRow = (k) => k.b.top < vr.bottom && k.b.bottom > vr.top;
    const left = kids.filter((k) => k.b.right <= vr.left + 4 && sameRow(k)).sort((a, b) => b.b.right - a.b.right)[0];
    const right = kids.filter((k) => k.b.left >= vr.right - 4 && sameRow(k)).sort((a, b) => a.b.left - b.b.left)[0];
    const overlaps = kids.filter((k) => k.b.left < vr.right && k.b.right > vr.left && k.b.top < vr.bottom && k.b.bottom > vr.top).slice(0, 4).map((k) => BL.label(k.c));
    const cb = container.getBoundingClientRect();
    return {
      container: { label: BL.label(container), selector: BL.cssPath(container), size: `${Math.round(cb.width)}×${Math.round(cb.height)}` },
      above: above && near(above), below: below && near(below), left: left && near(left), right: right && near(right), overlaps,
      _el: container,
    };
  }

  // ------------------------------------------------------------------ measuring

  function measureRects(a, b) {
    const gx = b.left >= a.right ? b.left - a.right : a.left >= b.right ? a.left - b.right : 0;
    const gy = b.top >= a.bottom ? b.top - a.bottom : a.top >= b.bottom ? a.top - b.bottom : 0;
    const w = (r) => r.width ?? r.right - r.left;
    const h = (r) => r.height ?? r.bottom - r.top;
    return {
      gapX: rnd(gx), gapY: rnd(gy),
      relX: b.left >= a.right ? 'right' : a.left >= b.right ? 'left' : null,
      relY: b.top >= a.bottom ? 'below' : a.top >= b.bottom ? 'above' : null,
      dLeft: rnd(b.left - a.left), dTop: rnd(b.top - a.top), dRight: rnd(b.right - a.right), dBottom: rnd(b.bottom - a.bottom),
      dCx: rnd(b.left + w(b) / 2 - (a.left + w(a) / 2)), dCy: rnd(b.top + h(b) / 2 - (a.top + h(a) / 2)),
    };
  }

  function measureText(m) {
    const bits = [];
    if (m.relY) bits.push(`${m.gapY}px ${m.relY}`);
    if (m.relX) bits.push(`${m.gapX}px to the ${m.relX}`);
    if (!bits.length) bits.push('overlapping');
    return `${bits.join(', ')}; edge offsets (target minus this): left ${m.dLeft}, top ${m.dTop}, right ${m.dRight}, bottom ${m.dBottom}`;
  }

  function drawMeasure(ra, rb) {
    const g = q('.x-meas');
    if (!g) return null;
    g.textContent = '';
    const add = (tag, attrs, text) => {
      const n = document.createElementNS(SVGNS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      if (text !== undefined) n.textContent = text;
      g.appendChild(n);
      return n;
    };
    const box = (r, c) => add('rect', { x: r.left, y: r.top, width: r.width ?? r.right - r.left, height: r.height ?? r.bottom - r.top, fill: 'none', stroke: c, 'stroke-width': 1.5 });
    box(ra, INK);
    box(rb, WARM);
    const m = measureRects(ra, rb);
    const label = (x, y, t) => add('text', { x, y, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, fill: GUIDE, stroke: '#fff', 'stroke-width': 3, 'paint-order': 'stroke', 'font-family': 'ui-monospace, Menlo, monospace' }, t);
    if (m.gapX > 0) {
      const x1 = m.relX === 'right' ? ra.right : ra.left;
      const x2 = m.relX === 'right' ? rb.left : rb.right;
      const o0 = Math.max(ra.top, rb.top);
      const o1 = Math.min(ra.bottom, rb.bottom);
      const y = o1 > o0 ? (o0 + o1) / 2 : m.relY === 'below' ? (ra.bottom + rb.top) / 2 : (rb.bottom + ra.top) / 2;
      add('line', { x1, y1: y, x2, y2: y, stroke: GUIDE, 'stroke-width': 1.5 });
      add('line', { x1, y1: y - 5, x2: x1, y2: y + 5, stroke: GUIDE }); add('line', { x1: x2, y1: y - 5, x2, y2: y + 5, stroke: GUIDE });
      label((x1 + x2) / 2, y - 6, `${m.gapX}`);
    }
    if (m.gapY > 0) {
      const y1 = m.relY === 'below' ? ra.bottom : ra.top;
      const y2 = m.relY === 'below' ? rb.top : rb.bottom;
      const o0 = Math.max(ra.left, rb.left);
      const o1 = Math.min(ra.right, rb.right);
      const x = o1 > o0 ? (o0 + o1) / 2 : m.relX === 'right' ? (ra.right + rb.left) / 2 : (rb.right + ra.left) / 2;
      add('line', { x1: x, y1, x2: x, y2, stroke: GUIDE, 'stroke-width': 1.5 });
      add('line', { x1: x - 5, y1, x2: x + 5, y2: y1, stroke: GUIDE }); add('line', { x1: x - 5, y1: y2, x2: x + 5, y2, stroke: GUIDE });
      label(x + 14, (y1 + y2) / 2 + 4, `${m.gapY}`);
    }
    return m;
  }

  const clearMeas = () => { const g = q('.x-meas'); if (g) g.textContent = ''; };

  // ------------------------------------------------------------------ CSV + price sheet

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

  function sheetFromRows(rows) {
    if (!rows.length) return { error: 'The file is empty.' };
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const col = (...names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
    const c = { sku: col('sku', 'variant sku'), price: col('price', 'variant price', 'new price', 'sale price'), handle: col('handle', 'product handle', 'url handle'), vid: col('variant id', 'variant_id'), title: col('title', 'product title', 'name') };
    if (c.price < 0 || (c.sku < 0 && c.handle < 0 && c.vid < 0)) return { error: 'Need a price column plus a SKU, handle, or variant id column.' };
    const num = (x) => { const n = parseFloat(String(x ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : null; };
    const cell = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() || null : null);
    const out = [];
    for (const r of rows.slice(1)) {
      const price = num(r[c.price]);
      if (price === null) continue;
      out.push({ sku: cell(r, c.sku), handle: cell(r, c.handle), vid: cell(r, c.vid), title: cell(r, c.title), price });
    }
    return { rows: out.slice(0, 3000), cols: c };
  }

  async function checkPrices(rows, onProgress) {
    const byHandle = new Map();
    rows.filter((r) => r.handle).forEach((r) => byHandle.set(r.handle, [...(byHandle.get(r.handle) || []), r]));
    const handles = [...byHandle.keys()].slice(0, 80);
    const res = { checked: 0, mismatches: [], missing: [], notFound: [], skipped: rows.filter((r) => !r.handle).length };
    let idx = 0;
    const worker = async () => {
      while (idx < handles.length) {
        const h = handles[idx++];
        try {
          const r = await fetch(`/products/${encodeURIComponent(h)}.js`, { headers: { Accept: 'application/json' } });
          if (!r.ok) { res.notFound.push(h); continue; }
          const prod = await r.json();
          for (const row of byHandle.get(h)) {
            const v = prod.variants.find((x) => (row.vid && String(x.id) === String(row.vid)) || (row.sku && x.sku === row.sku)) || (prod.variants.length === 1 && !row.sku && !row.vid ? prod.variants[0] : null);
            if (!v) { res.missing.push({ handle: h, sku: row.sku }); continue; }
            res.checked++;
            const live = v.price / 100;
            if (Math.abs(live - row.price) >= 0.005) res.mismatches.push({ handle: h, sku: v.sku || row.sku, sheet: row.price, live });
          }
        } catch { res.notFound.push(h); }
        if (onProgress) onProgress(idx, handles.length);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return res;
  }

  // ------------------------------------------------------------------ templates

  const CSS_X = `
    input, textarea, select, button { font-family: inherit; }
    .x-layers { position: fixed; inset: 0; pointer-events: none; z-index: -1; }
    .x-svg { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }

    .panel { width: 340px; max-height: min(80vh, 680px); }
    .panel.composing { max-height: min(86vh, 740px); }
    .panel.composing .body, .panel.composing .foot { display: none; }
    .panel.collapsed .pop { display: none !important; }
    .bar { cursor: grab; user-select: none; }
    .bar:active { cursor: grabbing; }
    .bar .tools button, .bar .brand { cursor: pointer; }
    .mk-toggle { font-size: 11px; font-weight: 600; color: #4A5063; border: 1px solid #E2E5EC; border-radius: 6px; padding: 2px 7px; margin-right: 4px; }
    .mk-toggle:hover { background: #F5F7FF; }
    .pick, .pick-hint { display: none !important; }
    .addnote { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 12px; border-radius: 9px; background: ${INK}; color: #fff; font-weight: 650; font-size: 13px; text-align: left; }
    .addnote:hover { background: #1A33C7; }
    .addnote.on { background: #16A34A; }
    .addnote kbd { margin-left: auto; opacity: .8; font-size: 11px; }
    .hintline { font-size: 11.5px; color: #6B7183; margin-top: -2px; }
    .panel .pop { position: static; width: auto; flex: 1 1 auto; min-height: 0; overflow: auto; border: 0; border-radius: 0; box-shadow: none; padding: 10px 12px 0; gap: 8px; }
    .pop > * { flex-shrink: 0; }
    .pop-head { display: none; }
    .pop-foot { position: sticky; bottom: 0; background: #fff; border-top: 1px solid #EDEFF3; margin: 4px -12px 0; padding: 10px 12px; z-index: 2; }
    .primary.done { background: #16A34A; }
    .toast { z-index: 9; }
    .pop.is-region .xe, .pop.is-region .xe1, .pop.is-multi .xe1, .pop.no-el .xe, .pop.no-el .xe1 { display: none !important; }

    .tbg { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
    .tb { padding: 5px 0; border: 1px solid #E2E5EC; border-radius: 6px; font-size: 11.5px; font-weight: 600; color: #4A5063; }
    .tb:hover { background: #F5F7FF; }
    .tb.on { background: ${INK}; border-color: ${INK}; color: #fff; }
    .x-guidebox { border: 1px solid #F0C6DD; background: #FFF7FB; border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
    .grow { display: flex; align-items: center; gap: 6px; font-size: 12px; }
    .grow .gsp { flex: 1; }
    .gdot { width: 8px; height: 8px; border-radius: 50%; background: ${GUIDE}; }

    .xrow { display: flex; align-items: center; gap: 6px; }
    .xlabel { font-size: 11px; color: #6B7183; min-width: 62px; }
    .chips { display: flex; gap: 4px; flex-wrap: wrap; }
    .chip { padding: 2px 8px; border: 1px solid #D9DCE4; border-radius: 10px; font-size: 11.5px; font-weight: 600; color: #4A5063; }
    .chip:hover { background: #F5F7FF; }
    .chip[aria-pressed="true"] { background: #EEF1FF; border-color: ${INK}; color: #1A33C7; }
    .x-sel { display: flex; flex-direction: column; gap: 4px; }
    .tchip { display: inline-flex; align-items: center; gap: 4px; background: #EEF1FF; color: #1A33C7; border-radius: 12px; padding: 2px 4px 2px 9px; font: 11.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; max-width: 100%; }
    .tchip:not(:has(button)) { padding-right: 9px; }
    .tchip button { width: 16px; height: 16px; border-radius: 50%; line-height: 16px; font-size: 10px; color: #1A33C7; }
    .tchip button:hover { background: rgba(26,51,199,.15); }
    .xbtns { display: flex; flex-wrap: wrap; gap: 4px; }
    .xb { padding: 4px 8px; border: 1px solid #D9DCE4; border-radius: 6px; font-size: 11.5px; font-weight: 600; color: #4A5063; background: #fff; }
    .xb:hover { background: #F5F7FF; }
    .xb.on { background: ${INK}; border-color: ${INK}; color: #fff; }
    .xb-file { cursor: pointer; display: inline-block; }
    .xd { border-top: 1px solid #F0F1F5; padding-top: 6px; }
    .xd > summary { cursor: pointer; font-size: 12px; font-weight: 600; color: #4A5063; list-style: none; padding: 2px 0; }
    .xd > summary::-webkit-details-marker { display: none; }
    .xd > summary::before { content: "▸ "; } .xd[open] > summary::before { content: "▾ "; }
    .sub { font-size: 11.5px; color: #6B7183; font-weight: 400; }
    .xin { width: 100%; border: 1px solid #D9DCE4; border-radius: 6px; padding: 4px 6px; font-size: 12px; background: #fff; color: #1E2230; }
    .xin:focus { outline: none; border-color: ${INK}; box-shadow: 0 0 0 3px rgba(43,78,255,.15); }
    .st { display: grid; grid-template-columns: 74px 22px 1fr 22px auto; gap: 3px; align-items: center; margin-top: 4px; }
    .st label { font-size: 11px; color: #6B7183; }
    .st .xin.ch { background: #FFFBEA; border-color: #F0C95A; }
    .st .nb { width: 22px; height: 24px; border: 1px solid #D9DCE4; border-radius: 5px; font-size: 13px; line-height: 1; color: #4A5063; }
    .st .nb:hover { background: #F5F7FF; }
    .st .tok { grid-column: 3 / 6; font-size: 11px; color: #1A33C7; }
    .xc { display: flex; gap: 3px; align-items: center; }
    .xc input[type=color] { width: 24px; height: 24px; padding: 0; border: 1px solid #D9DCE4; border-radius: 4px; background: none; }
    .x-strips { display: flex; flex-direction: column; gap: 4px; }
    .strip { display: flex; justify-content: space-between; align-items: center; gap: 8px; background: #F5F7FF; border: 1px solid #D4DBFF; border-radius: 6px; padding: 4px 4px 4px 8px; font-size: 11.5px; }
    .strip .xin { width: auto; display: inline-block; }
    .strip .icon { width: 22px; height: 22px; line-height: 22px; flex: none; }
    .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; border: 1px solid rgba(0,0,0,.2); vertical-align: -1px; margin-right: 3px; }
    .radio { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 3px 0; cursor: pointer; }
    .var-res { display: flex; flex-direction: column; gap: 3px; margin-top: 4px; max-height: 140px; overflow: auto; }
    .var-res button { text-align: left; padding: 4px 6px; border: 1px solid #E2E5EC; border-radius: 5px; font-size: 11.5px; }
    .var-res button:hover { background: #F5F7FF; }
    .dots { display: flex; gap: 6px; }
    .dot { width: 18px; height: 18px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px #C9CDD8; }
    .dot.on { box-shadow: 0 0 0 2px ${INK}; }

    .gd { position: fixed; pointer-events: none; }
    .gd.x { top: 0; bottom: 0; width: 0; border-left: 1px solid ${GUIDE}; }
    .gd.y { left: 0; right: 0; height: 0; border-top: 1px solid ${GUIDE}; }
    .gd .hit { position: absolute; pointer-events: auto; }
    .gd.x .hit { left: -6px; width: 13px; top: 0; bottom: 0; cursor: ew-resize; }
    .gd.y .hit { top: -6px; height: 13px; left: 0; right: 0; cursor: ns-resize; }
    .gd .tag { position: absolute; background: ${GUIDE}; color: #fff; border-radius: 3px; padding: 1px 5px; pointer-events: auto; cursor: grab; font: 600 10px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: nowrap; }
    .gd.x .tag { top: 8px; left: 4px; } .gd.y .tag { left: 8px; top: 4px; }
    .gd .tag button { color: #fff; opacity: .85; margin-left: 4px; font-size: 10px; }
    .mk { position: fixed; border: 2px dashed ${INK}; border-radius: 3px; pointer-events: none; }
    .mk.bug { border-color: ${GUIDE}; }
    .mk.badge-only { border-color: transparent; }
    .mk.hot { border-style: solid; background: rgba(43,78,255,.12); }
    .mk.region { background: rgba(43,78,255,.06); }
    .mk .bd { position: absolute; width: 22px; height: 22px; border-radius: 50%; background: ${INK}; color: #fff; font: 700 11px/22px -apple-system, Segoe UI, sans-serif; text-align: center; pointer-events: auto; cursor: pointer; box-shadow: 0 0 0 2px #fff, 0 2px 6px rgba(30,34,48,.3); }
    .mk.bug .bd { background: ${GUIDE}; }
    .mk .bd:hover { transform: scale(1.12); }
    .selb { position: fixed; border: 2px solid ${INK}; background: rgba(43,78,255,.1); border-radius: 3px; pointer-events: none; }
    .sm { position: fixed; border: 1.5px dashed ${WARM}; background: rgba(240,138,28,.1); pointer-events: none; border-radius: 2px; }
    .dr { position: fixed; border: 2px solid ${INK}; background: rgba(43,78,255,.12); pointer-events: none; border-radius: 3px; }
    .dr.set { border-style: dashed; }
    .dr .sz { position: absolute; right: 0; bottom: 100%; margin-bottom: 3px; background: ${INK}; color: #fff; padding: 1px 5px; border-radius: 3px; font: 600 10px/1.5 ui-monospace, Menlo, monospace; }
    .hl2 { position: fixed; pointer-events: none; border: 2px solid ${WARM}; background: rgba(240,138,28,.08); border-radius: 2px; }
    .hl2.ink { border-color: ${INK}; background: rgba(43,78,255,.08); }
    .hl2 .hl-tag { background: ${WARM}; }
    .hl2.ink .hl-tag { background: ${INK}; }
    .x-bar { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: #1E2230; color: #fff; padding: 7px 8px 7px 14px; border-radius: 9px; display: flex; gap: 10px; align-items: center; font-size: 12.5px; pointer-events: none; box-shadow: 0 8px 24px rgba(30,34,48,.3); z-index: 3; max-width: min(560px, 60vw); }
    .x-bar button { pointer-events: auto; flex: none; }
    .x-bar .ghost { color: #fff; border: 1px solid rgba(255,255,255,.3); padding: 3px 9px; }
    .x-bar .ghost:hover { background: rgba(255,255,255,.12); }
    .xtxt { position: fixed; z-index: 4; font-size: 15px; font-weight: 700; border: 1px solid ${INK}; border-radius: 4px; padding: 2px 5px; pointer-events: auto; background: #fff; }

    .xov { position: fixed; top: 12px; right: 12px; width: 270px; background: #fff; border: 1px solid #D9DCE4; border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 7px; box-shadow: 0 12px 32px rgba(30,34,48,.2); pointer-events: auto; z-index: 2; }
    .xov-h { display: flex; justify-content: space-between; align-items: center; cursor: grab; user-select: none; }
    .xov .opt { padding: 0; }
    .xmodal { position: fixed; inset: 0; background: rgba(30,34,48,.45); display: flex; align-items: center; justify-content: center; padding: 24px; pointer-events: auto; z-index: 4; }
    .xsheet { width: min(560px, 100%); max-height: 100%; overflow: auto; background: #fff; border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 24px 60px rgba(30,34,48,.3); }
    .xsheet header { display: flex; justify-content: space-between; align-items: center; cursor: grab; user-select: none; }
    .sh-out { font: 12px/1.5 ui-monospace, Menlo, monospace; background: #FAFBFC; border: 1px solid #E2E5EC; border-radius: 8px; padding: 8px; white-space: pre-wrap; max-height: 260px; overflow: auto; }
    .dr.circle { border-radius: 50%; }
    .stephead { display: flex; align-items: center; gap: 7px; font-weight: 650; font-size: 12.5px; color: #1E2230; margin-top: 2px; }
    .stepn { width: 18px; height: 18px; border-radius: 50%; background: #1E2230; color: #fff; font-size: 11px; line-height: 18px; text-align: center; flex: none; }
    .x-typehint { font-size: 11.5px; color: #6B7183; margin-top: -4px; }
    .startrow { display: flex; flex-direction: column; gap: 5px; }
    .sbtns { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .sbtn { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 8px 10px; border: 1px solid #D9DCE4; border-radius: 8px; text-align: left; background: #fff; }
    .sbtn b { font-size: 12.5px; }
    .sbtn span { font-size: 11px; color: #6B7183; font-weight: 400; }
    .sbtn:hover { background: #F5F7FF; border-color: ${INK}; }
    .sbtn.on { background: ${INK}; border-color: ${INK}; color: #fff; }
    .sbtn.on span { color: rgba(255,255,255,.85); }
    .acts { display: flex; flex-direction: column; gap: 5px; margin-top: 5px; }
    .act { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%; text-align: left; padding: 7px 9px; border: 1px solid #E2E5EC; border-radius: 7px; background: #fff; }
    .act b { font-size: 12px; font-weight: 650; }
    .act span { font-size: 11px; color: #6B7183; font-weight: 400; }
    .act:hover { background: #F5F7FF; }
    .act.on { border-color: ${INK}; background: #EEF1FF; }
    .toast { bottom: 64px; }
    .empty b { color: #1E2230; }
    .empty .step { display: flex; gap: 7px; margin-top: 5px; }
    .empty .step i { font-style: normal; width: 17px; height: 17px; border-radius: 50%; background: #E6E9F2; color: #4A5063; font-size: 11px; font-weight: 700; line-height: 17px; text-align: center; flex: none; }
    .tchip.auto { background: #FFF3E0; color: #8A4B00; }
  `;

  const LAYERS_HTML = `
    <div class="x-layers">
      <div class="x-sim"></div><div class="x-guides"></div><div class="x-marksbox"></div>
      <svg class="x-svg"><defs><marker id="xa" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${INK}"/></marker></defs><g class="x-marks"></g><g class="x-arrows"></g><g class="x-meas"></g></svg>
      <div class="dr" hidden><span class="sz"></span></div>
      <div class="hl2" hidden><span class="hl-tag"></span></div>
    </div>
    <div class="x-bar" hidden><span class="x-msg"></span><button class="ghost" data-x="bar-cancel">Esc</button></div>
    <div class="xov" hidden>
      <div class="xov-h"><b>Design overlay</b><button class="icon" data-x="ov-close" aria-label="Close">✕</button></div>
      <div class="xrow"><label class="xb xb-file">Choose image… <input type="file" accept="image/*" data-x="ov-file" hidden></label><span class="sub">or paste one</span></div>
      <div class="xrow"><span class="xlabel">Opacity</span><input type="range" min="0" max="100" data-ov="opacity" style="flex:1"></div>
      <div class="xrow"><span class="xlabel">Width px</span><input class="xin" type="number" data-ov="width"><button class="xb" data-x="ov-fit">Fit</button><button class="xb" data-x="ov-half">÷2</button></div>
      <div class="xrow"><span class="xlabel">Offset x, y</span><input class="xin" type="number" data-ov="x"><input class="xin" type="number" data-ov="y"></div>
      <label class="opt"><input type="checkbox" data-ov="diff"> Difference mode (matching pixels go black)</label>
      <label class="opt"><input type="checkbox" data-ov="visible"> Show overlay</label>
      <div class="xrow"><button class="xb" data-x="ov-clear">Remove image</button></div>
      <div class="sub">Drag this box by its title. ↑ ↓ in the offset fields nudge 1px (Shift: 10px).</div>
    </div>
    <div class="xmodal" data-m="sheet" hidden><div class="xsheet">
      <header><b>Price sheet check (read-only)</b><button class="icon" data-x="sh-close" aria-label="Close">✕</button></header>
      <p class="sub">Compares a CSV against live storefront prices. Nothing is written to the store.</p>
      <div class="xrow"><label class="xb xb-file">Choose CSV… <input type="file" accept=".csv,.tsv,text/csv" data-x="sh-file" hidden></label><span class="sh-name sub"></span></div>
      <div class="sh-sum sub"></div>
      <div class="xrow"><button class="primary" data-x="sh-check">Check live prices</button><button class="ghost" data-x="sh-clear">Remove sheet</button></div>
      <pre class="sh-out" hidden></pre>
    </div></div>
  `;

  const TOOLS_HTML = `
    <details class="xd" data-d="aids"><summary>More tools <span class="sub">guide lines, design overlay…</span></summary>
      <div class="acts">
        <button class="act" data-x="guides" title="Drag guide lines onto the page to check alignment, or to snap an element to"><b>Add guide lines</b><span>Drag lines onto the page to check or snap alignment</span></button>
        <div class="x-guidebox" hidden>
          <div class="xrow"><b style="font-size:12px">Guide lines</b><span style="flex:1"></span>
            <button class="xb" data-x="g-v" title="Add a line that runs top to bottom">+ Vertical</button><button class="xb" data-x="g-h" title="Add a line that runs left to right">+ Horizontal</button></div>
          <div class="g-list"></div>
          <div class="xrow"><button class="xb" data-x="g-show">Hide all</button></div>
          <div class="sub">Drag a line to move it (it snaps to element edges). To line an element up with one, open a note and use "Line up with a guide".</div>
        </div>
        <button class="act" data-x="overlay" title="Lay an image, such as a Figma export, over the page to compare"><b>Overlay a design image</b><span>Lay a Figma export over the page to compare</span></button>
        <button class="act" data-x="sheet" title="Compare a CSV of prices to the live store (read-only)" hidden><b>Check prices from a CSV</b><span>Compare a spreadsheet to live store prices (read-only)</span></button>
        <button class="act" data-x="previews" title="Switch between the page as it is and with your previewed changes" hidden><b>Hide my live edits</b><span>Switch between the real page and your previewed changes</span></button>
      </div></details>
  `;

  const TOP_HTML = `
    <div class="xrow"><button class="xb" data-x="dictate" title="Speak your note instead of typing it">Speak your note</button></div>
    <details class="xd" data-d="meta"><summary>Priority &amp; screen size <span class="sub meta-sum"></span></summary>
      <div class="xrow" style="margin-top:5px"><span class="xlabel">Priority</span><div class="chips">
        <button class="chip" data-prio="must" aria-pressed="true" title="Needs to be fixed">Must fix</button><button class="chip" data-prio="nice" aria-pressed="false" title="Only if there is time. Claude Code does these last">Nice to have</button></div></div>
      <div class="xrow" style="margin-top:5px"><span class="xlabel" title="Which screen sizes this change should apply to">Screen size</span><div class="chips">
        <button class="chip" data-bp="mobile" aria-pressed="false" title="Phones, under 750px wide">Mobile</button><button class="chip" data-bp="tablet" aria-pressed="false" title="750 to 989px wide">Tablet</button>
        <button class="chip" data-bp="desktop" aria-pressed="false" title="990px and wider">Desktop</button><button class="chip" data-bp="all" aria-pressed="false" title="All screen sizes">All</button></div></div></details>
  `;

  const MORE_HTML = `
    <div class="x-strips"></div>
    <div class="stephead"><span class="stepn">3</span>Optional: try it, mark it up</div>
    <details class="xd xe" data-d="props"><summary>Change how it looks <span class="sub style-sum"></span></summary>
      <div class="sub" style="margin-top:3px">Edit a value to preview it on the page. − / + or ↑ ↓ nudge it (Shift = ×10).</div>
      <div class="style-rows"></div>
      <div class="xrow" style="margin-top:6px"><button class="xb" data-x="style-reset" title="Undo all previewed changes to this element">Reset all</button></div></details>
    <details class="xd xe" data-d="actions"><summary>Do something with this element</summary>
      <div class="acts">
        <button class="act xe1" data-x="move-here" title="Pick where this element should go instead"><b>Move it somewhere else</b><span>Pick the spot it should go instead</span></button>
        <button class="act xe1" data-x="match" title="Compare it with another element and list the style differences"><b>Make it look like another element</b><span>Pick one to copy the style from</span></button>
        <button class="act xe1" data-x="measure-to" title="Read the distance in pixels to another element"><b>Measure the distance to another element</b><span>Pick one to measure to</span></button>
        <button class="act xe1" data-x="edittext" title="Retype its text right on the page"><b>Edit its text</b><span>Retype it on the page</span></button>
        <button class="act" data-x="hide" title="Hide it to preview the layout without it"><b>Hide it</b><span>See the layout without it</span></button>
        <button class="act" data-x="pop-color" title="Click anywhere on screen to copy that color"><b>Sample a color from the screen</b><span>Copies the hex code and adds it to the note</span></button>
      </div></details>
    <details class="xd xe1" data-d="scope"><summary>Apply to <span class="sub scope-sum"></span></summary>
      <label class="radio"><input type="radio" name="scope" value="one" checked> Just this one</label>
      <label class="radio"><input type="radio" name="scope" value="group"> All like it inside <select class="xin grp-sel" style="width:auto;max-width:170px"></select></label>
      <label class="radio"><input type="radio" name="scope" value="all"> Everywhere on the site <span class="sub all-count"></span></label>
      <div class="sub scope-info"></div></details>
    <details class="xd xe1" data-d="align"><summary>Line up with a guide</summary>
      <div class="align-rows"></div></details>
    <details class="xd" data-d="draw"><summary>Draw on the page <span class="sub draw-sum"></span></summary>
      <div class="xbtns" style="margin-top:4px">
        <button class="xb" data-draw="arrow" title="Draw an arrow">Arrow</button><button class="xb" data-draw="box" title="Draw a rectangle">Box</button><button class="xb" data-draw="circle" title="Draw an ellipse">Circle</button>
        <button class="xb" data-draw="pen" title="Draw freehand">Pen</button><button class="xb" data-draw="text" title="Click to place text">Text</button></div>
      <div class="xrow" style="margin-top:6px"><div class="dots">${DRAW_COLORS.map((c, i) => `<button class="dot${i === 0 ? ' on' : ''}" data-dc="${c}" style="background:${c}" aria-label="Color ${c}"></button>`).join('')}</div>
        <span style="flex:1"></span><button class="xb" data-x="draw-undo" title="Remove the last drawing">Undo</button><button class="xb" data-x="draw-clear" title="Remove all drawings from this note">Clear</button></div>
      <div class="sub">Pick a shape, then drag on the page. Drawings stay with the note and appear in its screenshot. Esc stops drawing.</div></details>
    <details class="xd" data-d="link"><summary>Figma link &amp; product variant</summary>
      <input class="xin figma-in" placeholder="Figma frame link (optional)" style="margin-top:4px">
      <div class="shop-only" hidden><input class="xin var-q" placeholder="Find a product or variant (read-only)" style="margin-top:6px"><div class="var-res"></div></div></details>
  `;

  const PROPS = [
    ['font-size', 'Font size'], ['font-weight', 'Weight'], ['line-height', 'Line height'], ['letter-spacing', 'Tracking'],
    ['color', 'Text color', true], ['background-color', 'Background', true], ['border-radius', 'Radius'],
    ['padding', 'Padding'], ['margin', 'Margin'], ['gap', 'Gap'], ['width', 'Width'], ['max-width', 'Max width'], ['opacity', 'Opacity'],
  ];
  const MATCH_PROPS = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'text-align', 'color', 'background-color', 'border', 'border-radius', 'padding', 'margin', 'box-shadow', 'opacity', 'gap'];
  const UNITLESS = new Set(['font-weight', 'opacity', 'line-height']);
  const posText = { before: 'before', after: 'after', 'inside-start': 'inside, as the first child of', 'inside-end': 'inside, as the last child of' };

  // ------------------------------------------------------------------ dragging boxes

  function makeDraggable(el, handle, opts = {}) {
    let st = null;
    let moved = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest(opts.ignore || 'button, input, select, textarea, a, [data-nodrag]')) return;
      const r = el.getBoundingClientRect();
      st = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, tx: el._tx || 0, ty: el._ty || 0 };
      moved = false;
      try { handle.setPointerCapture(e.pointerId); } catch { /* not supported */ }
    });
    handle.addEventListener('pointermove', (e) => {
      if (!st) return;
      const dx = e.clientX - st.x;
      const dy = e.clientY - st.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      if (opts.translate) {
        el._tx = st.tx + dx;
        el._ty = st.ty + dy;
        el.style.transform = `translate(${el._tx}px, ${el._ty}px)`;
      } else {
        const left = Math.min(Math.max(4, st.left + dx), window.innerWidth - el.offsetWidth - 4);
        const top = Math.min(Math.max(4, st.top + dy), window.innerHeight - 44);
        Object.assign(el.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
      }
    });
    const end = (e) => {
      if (!st) return;
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      st = null;
      if (moved) {
        if (opts.onEnd) opts.onEnd();
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        handle.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => handle.removeEventListener('click', swallow, true), 50);
      }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function applyPanelPos() {
    const p = q('.panel');
    if (!p || !S.prefs.pos) return;
    const left = Math.min(Math.max(4, S.prefs.pos.left), Math.max(4, window.innerWidth - 120));
    const top = Math.min(Math.max(4, S.prefs.pos.top), Math.max(4, window.innerHeight - 60));
    Object.assign(p.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
  }

  function clampPanel() {
    const p = q('.panel');
    if (!p || !p.style.top) return;
    const r = p.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) p.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`;
    if (r.right > window.innerWidth - 4) p.style.left = `${Math.max(4, window.innerWidth - r.width - 4)}px`;
  }

  // ------------------------------------------------------------------ mount

  hooks.onMount = (root) => {
    if (mountedRoot === root) return;
    mountedRoot = root;
    const tpl = document.createElement('template');
    tpl.innerHTML = `<style>${CSS_X}</style>${LAYERS_HTML}`;
    root.appendChild(tpl.content);
    const panel = root.querySelector('.panel');
    panel.insertBefore(root.querySelector('.pop'), panel.querySelector('.foot'));
    root.querySelector('.x-tools').innerHTML = TOOLS_HTML;
    root.querySelector('.x-top').innerHTML = TOP_HTML;
    root.querySelector('.x-more').innerHTML = MORE_HTML;
    const body = root.querySelector('.body');
    root.querySelector('.x-step2').innerHTML = '<div class="stephead"><span class="stepn">2</span>What should change?</div>';
    const add = mk('<button class="addnote" data-x="add-note" title="Open a new note. You can attach it to an element, or keep it as a general note"><span class="an-label">＋ Add note</span></button>');
    const startRow = mk(`<div class="startrow"><div class="sub">Or start straight from the page:</div><div class="sbtns">
      <button class="sbtn" data-x="start-select" title="Click an element on the page to attach a note to it (Alt+P)"><b>Select element</b><span>Click it on the page</span></button>
      <button class="sbtn" data-x="start-circle" title="Drag a circle around an element, or around an empty spot. Blueline finds the element under it"><b>Circle an area</b><span>Drag around it</span></button></div></div>`);
    body.insertBefore(add, body.firstChild);
    add.after(startRow);
    body.appendChild(root.querySelector('.x-tools'));
    const tools = root.querySelector('.bar .tools');
    tools.insertBefore(mk('<button class="mk-toggle" data-x="marks" title="Show an outline around each noted element on the page, or just the numbered badges">Outlines</button>'), tools.firstChild);
    makeDraggable(panel, root.querySelector('.bar'), { ignore: '.tools button, input, select, textarea, [data-nodrag]', onEnd: () => { const r = panel.getBoundingClientRect(); S.prefs.pos = { left: Math.round(r.left), top: Math.round(r.top) }; BL.savePrefs(); } });
    makeDraggable(root.querySelector('.xov'), root.querySelector('.xov-h'), { translate: true });
    makeDraggable(root.querySelector('.xsheet'), root.querySelector('.xsheet header'), { translate: true });
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', onUIKey);
    root.addEventListener('mouseover', (e) => { const li = e.target.closest('.item'); const id = li ? li.dataset.id : null; if (id !== T.hot) { T.hot = id; renderMarks(); } });
    root.addEventListener('mouseleave', () => { if (T.hot) { T.hot = null; renderMarks(); } });
    attachGlobal();
    applyPanelPos();
    loadOverlay();
    loadSheet();
    updateToolbar();
    renderAnn();
  };

  hooks.onUnmount = () => {
    cancelTools();
    stopDrawing();
    setAnnotate(false, true);
    applyAllPreviews(true);
    detachGlobal();
    if (T.speech) T.speech.stop();
    removeOverlayHost();
    mountedRoot = null;
    clearTimeout(ovSaveT);
  };

  function attachGlobal() {
    if (attached) return;
    attached = true;
    PTR.concat(SWALLOW).forEach((t) => window.addEventListener(t, onEvt, true));
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', clampPanel);
    document.addEventListener('paste', onPaste, true);
  }

  function detachGlobal() {
    if (!attached) return;
    attached = false;
    PTR.concat(SWALLOW).forEach((t) => window.removeEventListener(t, onEvt, true));
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', clampPanel);
    document.removeEventListener('paste', onPaste, true);
  }

  // ------------------------------------------------------------------ toolbar + tool state

  function updateToolbar() {
    if (!S.ui) return;
    q('[data-x="sheet"]').hidden = BL.modeOf(S.page) !== 'shopify';
    const pv = q('[data-x="previews"]');
    pv.hidden = !(S.batch?.items || []).some(hasPreview);
    pv.classList.toggle('on', S.prefs.previews !== false);
    pv.querySelector('b').textContent = S.prefs.previews !== false ? 'Hide my live edits' : 'Show my live edits';
    const g = guidesHere().length;
    q('[data-x="guides"] b').textContent = g ? `Guide lines (${g} on this page)` : 'Add guide lines';
    q('[data-x="marks"]').textContent = S.prefs.marks === 'badges' ? 'Outlines: off' : 'Outlines: on';
    q('[data-x="g-show"]').textContent = S.prefs.guidesHidden ? 'Show all' : 'Hide all';
    renderGuideList();
  }

  function showBar(msg, btn) {
    const b = q('.x-bar');
    if (!b) return;
    q('.x-msg').textContent = msg;
    const g = b.querySelector('[data-x="bar-cancel"]');
    if (g) g.textContent = btn || 'Cancel (Esc)';
    b.hidden = false;
  }
  function hideBar() { const b = q('.x-bar'); if (b) b.hidden = true; }

  const BAR_MSG = {
    select: 'Select an element: click it on the page (or drag a circle around it). Shift-click adds more.',
    add: 'Add more elements: click each one you want to include, then press Done.',
    circle: 'Circle an area: drag around the element(s). Blueline picks what is under your circle.',
  };

  function syncModeButtons() {
    for (const b of qa('[data-x="start-select"], [data-x="sel-element"]')) b.classList.toggle('on', A.on && A.mode === 'select' && !A.keep);
    for (const b of qa('[data-x="start-circle"], [data-x="sel-circle"]')) b.classList.toggle('on', A.on && A.mode === 'circle');
    for (const b of qa('[data-x="sel-add"]')) b.classList.toggle('on', A.on && A.keep);
  }

  function setAnnotate(on, quiet, mode = 'select', keep = false) {
    if (!on && !A.on) return;
    if (on) { cancelTools(); stopDrawing(); }
    A.on = on;
    A.mode = mode;
    A.keep = keep;
    A.drag = null;
    if (on) showBar(keep ? BAR_MSG.add : BAR_MSG[mode], keep ? 'Done' : 'Cancel (Esc)');
    else if (!T.pick && !D.tool) hideBar();
    if (!on) { drawHl2(null); hideDr(); }
    BL.cursorStyle(on || !!D.tool || !!T.pick);
    syncModeButtons();
    if (!quiet && S.pop) renderSel();
  }

  function startSelect(keep) {
    if (S.pop?.item) { toast('Finish or cancel this note first.'); return; }
    if (!S.pop) BL.openPop(null, null, { page: true, els: [] });
    setAnnotate(true, false, 'select', !!keep);
  }

  function startCircle() {
    if (S.pop?.item) { toast('Finish or cancel this note first.'); return; }
    if (!S.pop) BL.openPop(null, null, { page: true, els: [] });
    setAnnotate(true, false, 'circle', false);
  }

  hooks.toggleAnnotate = () => { if (A.on) setAnnotate(false); else startSelect(false); };

  function cancelTools() { if (T.pick) endPick(null); }
  hooks.cancelTools = cancelTools;

  function pickOne(msg, live) {
    cancelTools();
    stopDrawing();
    setAnnotate(false, true);
    return new Promise((resolve) => {
      T.pick = { resolve, live };
      showBar(msg);
      BL.cursorStyle(true);
      const panel = q('.panel');
      if (panel) panel.style.visibility = 'hidden';
    });
  }

  function endPick(val) {
    const p = T.pick;
    if (!p) return;
    T.pick = null;
    hideBar();
    drawHl2(null);
    clearMeas();
    BL.cursorStyle(false);
    const panel = q('.panel');
    if (panel) panel.style.visibility = '';
    p.resolve(val);
  }

  function drawHl2(el, ink) {
    const h = q('.hl2');
    if (!h) return;
    if (!el) { h.hidden = true; return; }
    const r = el.getBoundingClientRect();
    h.hidden = false;
    h.classList.toggle('ink', !!ink);
    Object.assign(h.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    const tag = h.querySelector('.hl-tag');
    tag.textContent = `${BL.label(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    tag.classList.toggle('below', r.top < 24);
  }

  function drawDr(x0, y0, x1, y1) {
    const dr = q('.dr');
    dr.hidden = false;
    dr.classList.remove('set');
    dr.classList.add('circle');
    Object.assign(dr.style, { left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
    dr.querySelector('.sz').textContent = `${Math.round(Math.abs(x1 - x0))}×${Math.round(Math.abs(y1 - y0))}`;
  }
  const hideDr = () => { const dr = q('.dr'); if (dr) { dr.hidden = true; dr.classList.remove('circle'); } };

  // ------------------------------------------------------------------ pointer + keyboard routing
  // Chrome does not fire mousedown/mouseup when pointerdown is cancelled, so everything here is
  // driven by POINTER events. Mouse and click events are only swallowed so the page never sees them.
  const PTR = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'];
  const SWALLOW = ['mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'auxclick', 'dragstart', 'selectstart'];

  // A one-shot tool ends on pointerup, but the browser still sends a click right after it.
  // Swallow that one click so selecting a button never presses it.
  const eatNextClick = () => { T.eatClick = true; setTimeout(() => { T.eatClick = false; }, 600); };

  function onEvt(e) {
    if (!S.active) return;
    if (T.eatClick && !(T.pick || A.on || D.tool) && /^(click|mouseup|dblclick|auxclick)$/.test(e.type) && !BL.fromUI(e)) {
      if (e.type === 'click') T.eatClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (!(T.pick || A.on || D.tool)) return;
    const isPtr = e.type.startsWith('pointer');
    if (BL.fromUI(e) && !(isPtr && (A.drag || D.cur))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!isPtr) return;
    if (T.pick) pickPointer(e);
    else if (D.tool) drawMouse(e);
    else if (A.on) annotatePointer(e);
  }

  function pickPointer(e) {
    const el = pickable(e);
    if (e.type === 'pointermove') { drawHl2(el); if (T.pick.live) T.pick.live(el, e); }
    else if (e.type === 'pointerup' && e.button <= 0 && el) { eatNextClick(); endPick({ el, x: e.clientX, y: e.clientY }); }
  }

  function onKey(e) {
    if (!S.active) return;
    if (e.key === 'Escape' && !(T.pick || D.tool || A.on)) {
      const m = q('[data-m="sheet"]');
      if (m && !m.hidden) { e.preventDefault(); e.stopImmediatePropagation(); m.hidden = true; return; }
    }
    if (e.key === 'Escape' && (T.pick || D.tool || A.on)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (T.pick) endPick(null);
      else if (D.tool) stopDrawing();
      else setAnnotate(false);
    }
  }

  // Which element(s) did the circle mean? Elements inside it, else the one under its middle, else an empty area.
  function autoSelect(vr) {
    const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
    const B = { left: vr.left, top: vr.top, right: vr.right ?? vr.left + vr.width, bottom: vr.bottom ?? vr.top + vr.height, width: vr.width, height: vr.height };
    const aB = Math.max(1, area(B));
    const cx = (B.left + B.right) / 2;
    const cy = (B.top + B.bottom) / 2;
    const stack = (document.elementsFromPoint ? document.elementsFromPoint(cx, cy) : []).filter((e) => !mine(e) && e !== document.documentElement && e !== document.body);
    const containsB = (r) => r.left <= B.left + 2 && r.right >= B.right - 2 && r.top <= B.top + 2 && r.bottom >= B.bottom - 2;
    const root = stack.find((e) => containsB(e.getBoundingClientRect())) || document.querySelector('main') || document.body;
    const overlap = (r) => { const iw = Math.min(r.right, B.right) - Math.max(r.left, B.left); const ih = Math.min(r.bottom, B.bottom) - Math.max(r.top, B.top); return iw > 0 && ih > 0 ? iw * ih : 0; };
    const pool = [root, ...[...root.querySelectorAll('*')].slice(0, 2500)];
    const cands = [];
    for (const e of pool) {
      if (mine(e) || /^(SCRIPT|STYLE|LINK|META|BR|NOSCRIPT|TEMPLATE|HEAD|TITLE|PATH|DEFS)$/i.test(e.tagName)) continue;
      const r = e.getBoundingClientRect();
      const aE = area(r);
      if (aE < 16) continue;
      const inter = overlap(r);
      if (!inter) continue;
      cands.push({ e, aE, inside: inter / aE });
    }
    let inside = cands.filter((c) => c.inside >= 0.75 && c.aE >= 0.04 * aB && c.e !== root);
    const set = new Set(inside.map((c) => c.e));
    inside = inside.filter((c) => { for (let p = c.e.parentElement; p; p = p.parentElement) if (set.has(p)) return false; return true; });
    if (inside.length && inside.length <= 6) return { els: inside.map((c) => c.e), how: 'inside' };
    for (let e = stack[0]; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      const r = e.getBoundingClientRect();
      if (area(r) > 10 * aB) break;
      if (overlap(r) / aB >= 0.5) return { els: [e], how: 'center' };
    }
    return { els: [], how: 'empty' };
  }

  function annotatePointer(e) {
    const el = pickable(e);
    if (e.type === 'pointermove') {
      if (A.drag) {
        A.drag.x1 = e.clientX;
        A.drag.y1 = e.clientY;
        if (Math.hypot(e.clientX - A.drag.x0, e.clientY - A.drag.y0) > 6) { A.drag.moved = true; drawHl2(null); drawDr(A.drag.x0, A.drag.y0, e.clientX, e.clientY); }
      } else drawHl2(el, true);
      return;
    }
    if (e.type === 'pointercancel') { A.drag = null; hideDr(); return; }
    if (e.type === 'pointerdown' && e.button === 0) {
      A.drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, el, add: e.shiftKey || e.metaKey || e.ctrlKey, moved: false };
      return;
    }
    if (e.type === 'pointerup' && A.drag) {
      const d = A.drag;
      A.drag = null;
      hideDr();
      eatNextClick();
      const w = Math.abs(e.clientX - d.x0);
      const h = Math.abs(e.clientY - d.y0);
      if (d.moved && w >= 10 && h >= 10) circleDone({ left: Math.min(d.x0, e.clientX), top: Math.min(d.y0, e.clientY), width: w, height: h, right: Math.max(d.x0, e.clientX), bottom: Math.max(d.y0, e.clientY) }, d.add || A.keep);
      else if (d.el) selectElement(d.el, d.add || A.keep);
    }
  }

  function finishSelect() { if (A.keep) renderSel(); else setAnnotate(false); }

  function selectElement(el, add) {
    if (S.pop?.item) { toast('Finish or cancel this note first.'); return; }
    if (!S.pop) BL.openPop(el, null, { els: [el] });
    else if (isRegionPop() || !P.els.length) setTarget({ els: [el] });
    else if (add) {
      const next = P.els.includes(el) ? P.els.filter((x) => x !== el) : [...P.els, el];
      if (!next.length) { BL.closePop(); return; }
      setTarget({ els: next });
    } else if (!(P.els.length === 1 && P.els[0] === el)) setTarget({ els: [el] });
    finishSelect();
  }

  function circleDone(vr, add) {
    if (S.pop?.item) { toast('Finish or cancel this note first.'); return; }
    const found = autoSelect(vr);
    if (!S.pop) BL.openPop(null, null, { page: true, els: [] });
    P.marks = P.marks.filter((m) => !m.auto);
    if (found.els.length) {
      const els = add && P.els.length ? [...P.els, ...found.els.filter((x) => !P.els.includes(x))] : found.els;
      setTarget({ els, auto: true });
    } else regionSelected(vr);
    P.marks.push({ t: 'circle', c: D.color, auto: true, a: { x: vr.left + scrollX, y: vr.top + scrollY }, b: { x: vr.right + scrollX, y: vr.bottom + scrollY } });
    P.marksDirty = true;
    syncDrawUi();
    renderAnn();
    finishSelect();
  }

  function regionSelected(vr) {
    const ctx = regionContext(vr);
    const cb = ctx._el.getBoundingClientRect();
    const region = {
      x: Math.round(vr.left + scrollX), y: Math.round(vr.top + scrollY), w: Math.round(vr.width), h: Math.round(vr.height),
      anchor: { selector: ctx.container.selector, ox: Math.round(vr.left - cb.left), oy: Math.round(vr.top - cb.top) },
      ctx, vr,
    };
    setTarget({ region, auto: true });
  }

  // Swap what the open note points at, keeping its text, type, priority, drawings, and colors.
  function setTarget(t) {
    revertLive();
    P.tweaks = {}; P.hide = false; P.textEdit = null; P.align = {}; P.alignInfo = {}; P.snap = { x: 0, y: 0 };
    P.move = null; P.match = null; P.measures = []; P.variant = null;
    P.auto = !!t.auto;
    S.pop.page = false;
    if (t.region) { P.els = []; P.el = null; S.pop.region = t.region; S.pop.el = null; S.pop.els = []; }
    else { P.els = t.els; P.el = t.els[0]; S.pop.region = null; S.pop.el = P.el; S.pop.els = P.els; }
    loadCompose();
    if (P.els.length) for (const k of ['props', 'actions']) { const dd = q(`[data-d="${k}"]`); if (dd) dd.open = true; }
  }

  // ------------------------------------------------------------------ compose lifecycle

  hooks.onPopOpen = (el, item) => {
    P = emptyPop();
    P.item = item || null;
    const sp = S.pop;
    if (item) {
      P.priority = item.priority || 'must';
      P.bps = new Set(item.bps || []);
      P.scope = item.scope?.mode || 'one';
      P.scopeTouched = !!item.scope?.chosen;
      P.auto = !!item.auto;
      (item.tweaks || []).forEach((t) => { P.tweaks[t.prop] = { ...t }; });
      P.textEdit = item.textEdit ? { ...item.textEdit } : null;
      P.hide = !!item.hidden;
      P.figma = item.figma || '';
      P.variant = item.variant || null;
      P.match = item.match || null;
      P.measures = (item.measures || []).slice();
      P.colors = (item.colors || []).slice();
      P.marks = (item.marks || []).map((m) => JSON.parse(JSON.stringify(m)));
      P.els = item.kind === 'region' || item.kind === 'page' ? [] : targetsOf(item);
      P.el = P.els[0] || null;
      const gs = guidesHere();
      for (const a of item.align || []) { const g = gs.find((x) => x.name === a.guide); if (g) { P.align[g.id] = a.edge; P.alignInfo[g.id] = { offset: a.offset, shift: a.shift || 0, axis: a.axis }; P.snap[a.axis] = a.shift || 0; } }
      setAnnotate(false, true);
    } else {
      P.bps = new Set([bpNow()]);
      P.els = sp.els || (el ? [el] : []);
      P.el = P.els[0] || null;
    }
    if (sp?.move) P.move = { to: targetInfo(sp.move.toEl), toEl: sp.move.toEl, position: sp.move.position };
    else if (item?.move) P.move = { to: item.move.to, toEl: BL.query(item.move.to.selector), position: item.move.position };
    S.pop.els = P.els;
    q('.panel').classList.add('composing');
    q('.pop-note').placeholder = sp?.move && !item ? 'Anything to add? (optional)' : 'Describe what should change, in your own words';
    for (const d of qa('.pop details')) d.open = (d.dataset.d === 'props' || d.dataset.d === 'actions') && !!P.el;
    if (Object.keys(P.tweaks).length) q('[data-d="props"]').open = true;
    if (P.scope !== 'one') q('[data-d="scope"]').open = true;
    if (Object.keys(P.align).length) q('[data-d="align"]').open = true;
    if (P.marks.some((m) => !m.auto)) q('[data-d="draw"]').open = true;
    BL.hideHL();
    loadCompose();
    clampPanel();
  };

  const TYPE_TIPS = { bug: 'Something is broken or behaves wrongly.', polish: 'Spacing, size, color or alignment needs adjusting.', copy: 'Wording, labels or messages need changing.', feature: 'Something new that does not exist yet.' };
  function updateTypeHint() { const h = q('.x-typehint'); if (h) h.textContent = TYPE_TIPS[S.popType] || ''; }

  function loadCompose() {
    const pop = q('.pop');
    const region = isRegionPop();
    pop.classList.toggle('is-region', region);
    pop.classList.toggle('is-multi', P.els.length > 1);
    pop.classList.toggle('no-el', !region && !P.els.length);
    pop.style.visibility = '';
    varIdx = null;
    q('.figma-in').value = P.figma;
    q('.shop-only').hidden = BL.modeOf(S.page) !== 'shopify';
    q('.var-res').textContent = '';
    q('.var-q').value = '';
    q('.pop-el').textContent = P.el ? BL.label(P.el) : '';
    updateTypeHint();
    renderSel();
    syncChips();
    buildStyleRows();
    buildAlignRows();
    updateScope();
    renderStrips();
    updateHideButton();
    syncDrawUi();
    const issues = P.el ? detectIssuesSafe(P.el) : P.item?.el?.issues || [];
    const ul = q('.issues');
    ul.textContent = '';
    issues.slice(0, 3).forEach((x) => { const li = document.createElement('li'); li.textContent = x.text; ul.appendChild(li); });
    if (issues.length > 3) { const li = document.createElement('li'); li.textContent = `${issues.length - 3} more in the export`; ul.appendChild(li); }
    ul.hidden = !issues.length;
    renderAnn();
  }

  function detectIssuesSafe(el) { try { return BL.detectIssues(el); } catch { return []; } }

  // Step 1 of the note: what is it about, and the buttons to change that.
  function renderSel() {
    const box = q('.x-sel');
    if (!box) return;
    const editing = !!P.item;
    const rg = S.pop?.region || (P.item?.kind === 'region' ? P.item.region : null);
    const chips = [];
    if (rg) chips.push(`<span class="tchip${P.auto ? ' auto' : ''}" title="An empty area you marked">▭ Empty area ${rg.w}×${rg.h} in ${esc(rg.ctx.container.label)}</span>`);
    else if (P.item?.kind === 'page') chips.push('<span class="tchip">Whole page (general note)</span>');
    else if (!P.els.length && P.item) chips.push(`<span class="tchip">${esc(P.item.el.label)}</span>`);
    else P.els.forEach((e, i) => chips.push(`<span class="tchip${P.auto ? ' auto' : ''}" title="${esc(BL.cssPath(e))}">${esc(BL.label(e))}${editing ? '' : `<button data-x="sel-rm" data-i="${i}" aria-label="Remove ${esc(BL.label(e))} from this note" title="Remove from this note">✕</button>`}</span>`));
    const none = !chips.length;
    const num = editing ? S.batch.items.indexOf(P.item) + 1 : 0;
    let hint = '';
    if (A.on) hint = A.keep ? 'Click each element you want to add, then press Done.' : A.mode === 'circle' ? 'Drag a circle around what you mean.' : 'Click an element on the page (or drag around it).';
    else if (editing && !P.els.length && P.item.kind !== 'region' && P.item.kind !== 'page') hint = `This note is on ${esc(P.item.path)}. Open that page to edit its target.`;
    else if (editing) hint = 'A saved note\u2019s target can\u2019t change. To point somewhere else, delete it and add a new note.';
    else if (P.auto && rg) hint = 'No element was under your circle, so this marks an empty area. That works for "add something here".';
    else if (P.auto) hint = 'Picked automatically from your circle. Remove it above or choose again if it\u2019s wrong.';
    else if (none) hint = 'Nothing selected yet. Choose a button below, or skip this to save a general note about the whole page.';
    else hint = 'Need to open a menu or tab first? Do that, then press Select element again.';
    const buttons = editing ? '' : `<div class="xbtns">
      <button class="xb${A.on && A.mode === 'select' && !A.keep ? ' on' : ''}" data-x="sel-element" title="Click an element on the page to attach this note to it">Select element</button>
      <button class="xb${A.on && A.mode === 'circle' ? ' on' : ''}" data-x="sel-circle" title="Drag a circle around an element or an empty spot. Blueline finds the element under it">Circle an area</button>
      ${P.els.length && !rg ? `<button class="xb${A.on && A.keep ? ' on' : ''}" data-x="sel-add" title="Include more elements in this same note">+ Add another element</button>` : ''}</div>`;
    box.innerHTML = `<div class="stephead"><span class="stepn">1</span>${editing ? `Editing note ${num}` : 'What is this about?'}</div>${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}${buttons}<div class="sub">${hint}</div>`;
  }

  hooks.onPopClose = () => {
    if (T.speech) T.speech.stop();
    if (editing) finishEdit(false);
    if (T.pick) endPick(null);
    stopDrawing();
    setAnnotate(false, true);
    T.simEls = null;
    const sm = q('.x-sim');
    if (sm) sm.textContent = '';
    clearMeas();
    hideDr();
    if (!P.committed) revertLive();
    const panel = q('.panel');
    if (panel) panel.classList.remove('composing');
    P = emptyPop();
    setTimeout(() => { renderAnn(); applyAllPreviews(); }, 0);
  };

  function syncChips() {
    for (const c of qa('[data-prio]')) c.setAttribute('aria-pressed', String(c.dataset.prio === P.priority));
    const all = ['mobile', 'tablet', 'desktop'].every((b) => P.bps.has(b));
    for (const c of qa('[data-bp]')) c.setAttribute('aria-pressed', String(c.dataset.bp === 'all' ? all : P.bps.has(c.dataset.bp)));
    const sum = q('.meta-sum');
    if (sum) sum.textContent = `${P.priority === 'nice' ? 'Nice to have' : 'Must fix'} · ${all ? 'all screen sizes' : ['mobile', 'tablet', 'desktop'].filter((b) => P.bps.has(b)).join(' + ') || 'any size'}`;
  }

  function updateHideButton() {
    const b = q('[data-x="hide"]');
    if (b) { b.textContent = P.hide ? 'Show it' : 'Hide it'; b.classList.toggle('on', P.hide); }
  }

  // ------------------------------------------------------------------ scope ("Apply to")

  function updateScope() {
    const sm = q('.x-sim');
    const el = P.el;
    if (!el || P.els.length > 1 || isRegionPop()) { T.simEls = null; if (sm) sm.textContent = ''; return; }
    const opts = groupOptions(el);
    const all = similar(el, 'all');
    const sel = q('.grp-sel');
    sel.innerHTML = opts.map((o, i) => `<option value="${i}">${esc(o.label)} (${o.count})</option>`).join('');
    P.groupIdx = Math.min(P.groupIdx, Math.max(0, opts.length - 1));
    sel.value = String(P.groupIdx);
    sel.disabled = !opts.length;
    if (P.scope === 'group' && !opts.length) P.scope = 'one';
    const grp = q('[name="scope"][value="group"]');
    grp.disabled = !opts.length;
    for (const r of qa('[name="scope"]')) r.checked = r.value === P.scope;
    q('.all-count').textContent = `(${all.els.length} on this page)`;
    const info = q('.scope-info');
    const sum = q('.scope-sum');
    if (P.scope === 'one') {
      T.simEls = null;
      sm.textContent = '';
      info.textContent = all.els.length > 1 ? `${all.els.length - 1} similar element${all.els.length === 2 ? '' : 's'} on this page stay unchanged.` : 'Nothing else on this page looks like it.';
      sum.textContent = '';
      return;
    }
    const s = P.scope === 'group' ? similar(el, 'group', P.groupIdx) : all;
    T.simEls = s.els.filter((e) => e !== el);
    renderSim();
    info.textContent = `${matches(s.els.length)} for ${s.sel}${s.root ? ` inside ${BL.label(s.root)}` : ''}. Highlighted in orange.${s.els.length > 150 ? ' That is a lot. Is the selector too broad?' : ''}`;
    sum.textContent = `${P.scope === 'group' ? 'group' : 'everywhere'} · ${s.els.length}`;
  }

  // ------------------------------------------------------------------ element properties

  const normInput = (prop, v) => {
    if (!/^-?\d*\.?\d+$/.test(v)) return v;
    if (prop === 'line-height') return +v >= 4 ? `${v}px` : v;
    return UNITLESS.has(prop) ? v : `${v}px`;
  };

  function stepVal(prop, v, dir, shift) {
    const step = prop === 'opacity' ? 0.05 : prop === 'font-weight' ? 100 : prop === 'line-height' && !/[a-z%]/i.test(v) && parseFloat(v) < 4 ? 0.1 : 1;
    return v.replace(/-?\d*\.?\d+/g, (n) => String(rnd2(+n + dir * step * (shift ? 10 : 1))));
  }

  const toHex = (v) => { const c = BL.rgba(v); return c ? BL.hex(c) : '#000000'; };
  const tweakCount = () => Object.values(P.tweaks).filter((t) => !t.snap).length;

  function buildStyleRows() {
    const box = q('.style-rows');
    box.textContent = '';
    q('.style-sum').textContent = tweakCount() ? `${tweakCount()} changed` : '';
    if (!P.el || isRegionPop()) return;
    const cs = getComputedStyle(P.el);
    for (const [prop, label, isColor] of PROPS) {
      const from = P.tweaks[prop]?.from ?? cs.getPropertyValue(prop).trim();
      const cur = P.tweaks[prop]?.to ?? from;
      const row = mk(`<div class="st" data-prop="${prop}" data-from="${esc(from)}"><label>${label}</label><button class="nb" data-x="st-dec" aria-label="Decrease ${label}">−</button><input class="xin sv" value="${esc(cur)}" spellcheck="false"><button class="nb" data-x="st-inc" aria-label="Increase ${label}">+</button>${isColor ? '<span class="xc"><input type="color" class="sw"><button class="xb" data-x="st-drop" title="Sample a color from the screen" aria-label="Eyedropper">◉</button></span>' : '<span></span>'}<div class="tok" hidden></div></div>`);
      box.appendChild(row);
      refreshRow(row);
    }
  }

  function refreshRow(row) {
    const t = P.tweaks[row.dataset.prop];
    const input = row.querySelector('.sv');
    input.classList.toggle('ch', !!t);
    const tok = row.querySelector('.tok');
    tok.hidden = !(t && t.token);
    tok.textContent = t && t.token ? `≈ ${t.token}` : '';
    const sw = row.querySelector('.sw');
    if (sw) sw.value = toHex(input.value || row.dataset.from);
  }

  function styleInput(row, raw) {
    if (!P.el) return;
    const prop = row.dataset.prop;
    const from = row.dataset.from;
    const v = raw.trim();
    if (!v || v === from) { for (const el of P.els) restoreInline(el, prop); delete P.tweaks[prop]; }
    else {
      const val = normInput(prop, v);
      for (const el of P.els) setInline(el, prop, val);
      P.tweaks[prop] = { prop, from, to: val, token: tokenHint(prop, val, BL.stylingOf(P.el).includes('tailwind')) };
    }
    refreshRow(row);
    q('.style-sum').textContent = tweakCount() ? `${tweakCount()} changed` : '';
    renderAnn();
  }

  function resetStyles() {
    for (const el of P.els) for (const prop of Object.keys(P.tweaks)) restoreInline(el, prop);
    P.tweaks = {};
    P.align = {}; P.alignInfo = {}; P.snap = { x: 0, y: 0 };
    buildStyleRows();
    buildAlignRows();
  }

  // ------------------------------------------------------------------ guides + snapping

  const guidesHere = () => (S.batch?.guides || []).filter((g) => g.path === here());

  function addGuide(axis) {
    const b = BL.ensureBatch();
    b.guides = b.guides || [];
    const used = new Set(b.guides.map((g) => g.name));
    let name = 'A';
    for (let c = 65; c < 91; c++) { name = String.fromCharCode(c); if (!used.has(name)) break; }
    b.guides.push({ id: BL.uid(), name, axis, pos: axis === 'x' ? scrollX + innerWidth / 2 : scrollY + innerHeight / 2, path: here(), vw: innerWidth, vh: innerHeight });
    S.prefs.guidesHidden = false;
    BL.saveBatch();
    renderAnn();
    updateToolbar();
    toast(`Guide ${name} added. Drag it into place.`);
  }

  function renderGuideList() {
    const box = q('.g-list');
    if (!box) return;
    const gs = guidesHere();
    box.innerHTML = gs.length ? gs.map((g) => `<div class="grow"><span class="gdot"></span><b>${esc(g.name)}</b><span class="sub">${g.axis === 'x' ? 'vertical' : 'horizontal'} · ${Math.round(g.pos)}px</span><span class="gsp"></span><button class="icon" data-x="g-eye" data-id="${g.id}" title="${g.hidden ? 'Show' : 'Hide'} this guide" aria-label="${g.hidden ? 'Show' : 'Hide'} guide ${esc(g.name)}">${g.hidden ? '◌' : '●'}</button><button class="icon" data-x="g-del" data-id="${g.id}" title="Remove this guide" aria-label="Remove guide ${esc(g.name)}">✕</button></div>`).join('') : '<div class="sub">No guides on this page yet.</div>';
  }

  function renderGuides() {
    const box = q('.x-guides');
    if (!box) return;
    const list = S.prefs.guidesHidden ? [] : guidesHere().filter((g) => !g.hidden);
    const have = new Map([...box.children].map((n) => [n.dataset.id, n]));
    for (const g of list) {
      let n = have.get(g.id);
      if (!n) {
        n = mk(`<div class="gd ${g.axis}" data-id="${g.id}"><div class="hit"></div><span class="tag"><b></b><button data-x="g-del" data-id="${g.id}" title="Remove guide" aria-label="Remove guide">✕</button></span></div>`);
        box.appendChild(n);
        wireGuide(n, g.id);
      }
      have.delete(g.id);
      if (g.axis === 'x') n.style.left = `${g.pos - scrollX}px`; else n.style.top = `${g.pos - scrollY}px`;
      n.querySelector('b').textContent = `${g.name} · ${g.axis === 'x' ? 'x' : 'y'} ${Math.round(g.pos)}`;
    }
    for (const n of have.values()) n.remove();
  }

  function wireGuide(n, id) {
    for (const h of [n.querySelector('.hit'), n.querySelector('.tag b')]) {
      h.addEventListener('pointerdown', (e) => { e.preventDefault(); try { h.setPointerCapture(e.pointerId); } catch { /* ignore */ } T.gdrag = id; });
      h.addEventListener('pointermove', (e) => { if (T.gdrag === id) moveGuide(id, e); });
      h.addEventListener('pointerup', () => { if (T.gdrag === id) { T.gdrag = null; BL.saveBatch(); renderGuideList(); } });
    }
  }

  function moveGuide(id, e) {
    const g = (S.batch.guides || []).find((x) => x.id === id);
    if (!g) return;
    let v = g.axis === 'x' ? e.clientX : e.clientY;
    const under = document.elementsFromPoint ? document.elementsFromPoint(e.clientX, e.clientY).find((n) => !mine(n) && n !== document.documentElement && n !== document.body) : null;
    if (under) {
      const r = under.getBoundingClientRect();
      const edges = g.axis === 'x' ? [r.left, r.right, (r.left + r.right) / 2] : [r.top, r.bottom, (r.top + r.bottom) / 2];
      for (const ed of edges) if (Math.abs(ed - v) < 6) { v = ed; break; }
    }
    g.pos = Math.round((v + (g.axis === 'x' ? scrollX : scrollY)) * 2) / 2;
    renderGuides();
  }

  const EDGES = { x: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']], y: [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']] };

  function buildAlignRows() {
    const box = q('.align-rows');
    if (!box) return;
    const gs = guidesHere();
    if (!gs.length) { box.innerHTML = '<div class="sub" style="margin-top:3px">No guides on this page. Add one from the Guides tool, then snap this element to it here.</div>'; return; }
    box.innerHTML = gs.map((g) => {
      const info = P.alignInfo[g.id];
      return `<div class="xrow" style="margin-top:4px"><span class="xlabel" style="min-width:74px">Guide ${esc(g.name)} · ${g.axis} ${Math.round(g.pos)}</span><div class="chips">${EDGES[g.axis].map(([k, l]) => `<button class="chip" data-x="snap" data-g="${g.id}" data-edge="${k}" aria-pressed="${P.align[g.id] === k}">${l}</button>`).join('')}</div></div>${P.align[g.id] && info ? `<div class="sub" style="margin-left:80px">Snapped. Moved ${Math.abs(rnd(info.shift))}px (it was ${Math.abs(rnd(info.offset))}px ${info.offset >= 0 ? (g.axis === 'x' ? 'right' : 'below') : g.axis === 'x' ? 'left' : 'above'} of the guide).</div>` : ''}`;
    }).join('');
  }

  function edgePos(r, edge) {
    return { left: r.left + scrollX, center: r.left + r.width / 2 + scrollX, right: r.right + scrollX, top: r.top + scrollY, middle: r.top + r.height / 2 + scrollY, bottom: r.bottom + scrollY }[edge];
  }

  // Preview-snap the element's edge onto the guide by shifting it with `translate`.
  function snapTo(gid, edge) {
    const el = P.el;
    const g = guidesHere().find((x) => x.id === gid);
    if (!el || !g) return;
    const axis = g.axis;
    const same = Object.keys(P.align).filter((id) => (guidesHere().find((x) => x.id === id) || {}).axis === axis);
    const toggledOff = P.align[gid] === edge;
    same.forEach((id) => { delete P.align[id]; delete P.alignInfo[id]; });
    restoreInline(el, 'translate');
    P.snap[axis] = 0;
    let basePos = null;
    if (!toggledOff) {
      const other = axis === 'x' ? 'y' : 'x';
      const keep = P.snap[other] || 0;
      if (keep) setInline(el, 'translate', axis === 'x' ? `0px ${keep}px` : `${keep}px 0px`);
      const r = el.getBoundingClientRect();
      const pos = edgePos(r, edge);
      basePos = pos;
      const shift = rnd(g.pos - pos);
      P.snap[axis] = shift;
      P.align[gid] = edge;
      P.alignInfo[gid] = { offset: rnd(pos - g.pos), shift, axis };
    }
    if (P.snap.x || P.snap.y) {
      setInline(el, 'translate', `${P.snap.x || 0}px ${P.snap.y || 0}px`);
      // Shifting can add a scrollbar and nudge a centered layout, so re-measure and correct.
      // Only correct if the element actually moved. If it did not respond to translate, leave it alone.
      if (P.align[gid] && basePos !== null && Math.abs(edgePos(el.getBoundingClientRect(), edge) - basePos) >= 0.5) {
        for (let i = 0; i < 3; i++) {
          const miss = rnd(g.pos - edgePos(el.getBoundingClientRect(), edge));
          if (Math.abs(miss) < 0.6) break;
          P.snap[axis] = rnd(P.snap[axis] + miss);
          setInline(el, 'translate', `${P.snap.x || 0}px ${P.snap.y || 0}px`);
        }
        P.alignInfo[gid].shift = P.snap[axis];
      }
      P.tweaks.translate = { prop: 'translate', from: 'none', to: `${P.snap.x || 0}px ${P.snap.y || 0}px`, snap: true };
    } else { restoreInline(el, 'translate'); delete P.tweaks.translate; }
    buildAlignRows();
    renderAnn();
  }

  function alignFields() {
    const out = [];
    for (const g of guidesHere()) {
      const edge = P.align[g.id];
      const info = P.alignInfo[g.id];
      if (!edge || !info) continue;
      out.push({ guide: g.name, axis: g.axis, edge, guidePos: Math.round(g.pos), offset: info.offset, shift: info.shift });
    }
    return out;
  }

  // ------------------------------------------------------------------ persistent marks on the page

  function reconcile(box, key, list, make, update) {
    const have = new Map([...box.children].map((n) => [n.dataset.k, n]));
    for (const item of list) {
      const k = key(item);
      let n = have.get(k);
      if (!n) { n = make(item); n.dataset.k = k; box.appendChild(n); }
      have.delete(k);
      update(n, item);
    }
    for (const n of have.values()) n.remove();
  }

  function regionRect(it) {
    const rg = it.region;
    let left = rg.x - scrollX;
    let top = rg.y - scrollY;
    if (rg.anchor?.selector) {
      const a = BL.query(rg.anchor.selector);
      if (a) { const b = a.getBoundingClientRect(); left = b.left + rg.anchor.ox; top = b.top + rg.anchor.oy; }
    }
    return { left, top, width: rg.w, height: rg.h };
  }

  function renderMarks() {
    const box = q('.x-marksbox');
    if (!box) return;
    const badgesOnly = S.prefs.marks === 'badges';
    const specs = [];
    const slotOf = new Map();
    (S.batch?.items || []).forEach((it, idx) => {
      if (it.path !== here() || it.kind === 'page') return;
      const cls = `${it.type === 'bug' ? 'bug' : ''}${badgesOnly ? ' badge-only' : ''}${T.hot === it.id ? ' hot' : ''}`;
      if (it.kind === 'region') { specs.push({ k: `${it.id}:r`, num: idx + 1, id: it.id, cls: `${cls} region`, rect: regionRect(it) }); return; }
      targetsOf(it).forEach((el, i) => { const n = slotOf.get(el) || 0; slotOf.set(el, n + 1); specs.push({ k: `${it.id}:${i}`, num: idx + 1, id: it.id, cls, el, slot: n }); });
    });
    reconcile(box, (s) => s.k, specs,
      () => mk('<div class="mk"><button class="bd" data-x="mk-open"></button></div>'),
      (n, s) => {
        const r = s.rect || s.el.getBoundingClientRect();
        const off = r.top + r.height < 0 || r.top > innerHeight || (r.width === 0 && r.height === 0);
        n.style.display = off ? 'none' : '';
        n.className = `mk ${s.cls}`;
        Object.assign(n.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        const bd = n.querySelector('.bd');
        bd.textContent = String(s.num);
        bd.dataset.id = s.id;
        bd.style.left = `${Math.max(4, Math.min(innerWidth - 26, r.left - 11 + (s.slot || 0) * 25)) - r.left - 2}px`;
        bd.style.top = `${Math.max(4, r.top - 11) - r.top - 2}px`;
      });
    // selection boxes while composing
    const sb = [];
    if (S.pop && !isRegionPop()) P.els.forEach((el, i) => sb.push({ k: `s${i}`, el }));
    for (const n of [...box.querySelectorAll('.selb')]) if (!sb.some((s) => s.k === n.dataset.k)) n.remove();
    for (const s of sb) {
      let n = box.querySelector(`.selb[data-k="${s.k}"]`);
      if (!n) { n = document.createElement('div'); n.className = 'selb'; n.dataset.k = s.k; box.appendChild(n); }
      const r = s.el.getBoundingClientRect();
      Object.assign(n.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    }
  }

  function svgShape(s) {
    const mkn = (t, a) => { const n = document.createElementNS(SVGNS, t); for (const k in a) n.setAttribute(k, a[k]); return n; };
    const base = { stroke: s.c, 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    if (s.t === 'pen') return mkn('polyline', { ...base, points: s.pts.map((p) => `${p.x},${p.y}`).join(' ') });
    if (s.t === 'box') return mkn('rect', { ...base, x: Math.min(s.a.x, s.b.x), y: Math.min(s.a.y, s.b.y), width: Math.abs(s.b.x - s.a.x), height: Math.abs(s.b.y - s.a.y), rx: 3 });
    if (s.t === 'circle') return mkn('ellipse', { ...base, cx: (s.a.x + s.b.x) / 2, cy: (s.a.y + s.b.y) / 2, rx: Math.abs(s.b.x - s.a.x) / 2, ry: Math.abs(s.b.y - s.a.y) / 2 });
    if (s.t === 'arrow') {
      const g = mkn('g', {});
      g.appendChild(mkn('line', { ...base, x1: s.a.x, y1: s.a.y, x2: s.b.x, y2: s.b.y }));
      const ang = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
      const hl = 15;
      const pt = (da) => `${s.b.x - hl * Math.cos(ang + da)},${s.b.y - hl * Math.sin(ang + da)}`;
      g.appendChild(mkn('polygon', { points: `${s.b.x},${s.b.y} ${pt(-0.45)} ${pt(0.45)}`, fill: s.c }));
      return g;
    }
    const t = mkn('text', { x: s.p.x, y: s.p.y, fill: s.c, stroke: '#fff', 'stroke-width': 4, 'paint-order': 'stroke', 'font-size': 17, 'font-weight': 700, 'font-family': '-apple-system, Segoe UI, sans-serif' });
    t.textContent = s.s;
    return t;
  }

  function renderDrawn() {
    const g = q('.x-marks');
    if (!g) return;
    g.textContent = '';
    g.setAttribute('transform', `translate(${-scrollX} ${-scrollY})`);
    if (S.prefs.marks === 'badges') return;
    const list = [];
    for (const it of itemsHere()) { if (S.pop?.item?.id === it.id) continue; (it.marks || []).forEach((m) => list.push(m)); }
    (P.marks || []).forEach((m) => list.push(m));
    if (D.cur) list.push(D.cur);
    for (const s of list) g.appendChild(svgShape(s));
  }

  function renderSim() {
    const box = q('.x-sim');
    if (!box) return;
    box.textContent = '';
    for (const e of (T.simEls || []).slice(0, 80)) {
      if (!e.isConnected) continue;
      const r = e.getBoundingClientRect();
      const n = document.createElement('div');
      n.className = 'sm';
      Object.assign(n.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      box.appendChild(n);
    }
  }

  function renderArrows() {
    const g = q('.x-arrows');
    if (!g) return;
    g.textContent = '';
    const draw = (a, b, pos) => {
      if (!a || !b) return;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const x1 = ra.left + ra.width / 2;
      const y1 = ra.top + ra.height / 2;
      const x2 = rb.left + rb.width / 2;
      const y2 = pos === 'before' ? rb.top : pos === 'after' ? rb.bottom : rb.top + rb.height / 2;
      const ln = document.createElementNS(SVGNS, 'line');
      Object.entries({ x1, y1, x2, y2, stroke: INK, 'stroke-width': 2, 'stroke-dasharray': '7 5', 'marker-end': 'url(#xa)' }).forEach(([k, v]) => ln.setAttribute(k, v));
      g.appendChild(ln);
      const t = document.createElementNS(SVGNS, 'text');
      Object.entries({ x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 6, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, fill: INK, stroke: '#fff', 'stroke-width': 3, 'paint-order': 'stroke' }).forEach(([k, v]) => t.setAttribute(k, v));
      t.textContent = pos.replace('-', ' ');
      g.appendChild(t);
    };
    if (S.prefs.marks !== 'badges') for (const it of itemsHere()) if (it.move) draw(BL.query(it.el.selector), BL.query(it.move.to.selector), it.move.position);
    if (S.pop && P.move && P.el) draw(P.el, P.move.toEl, P.move.position);
  }

  function renderAnn() {
    if (!S.ui) return;
    renderGuides();
    renderMarks();
    renderDrawn();
    renderArrows();
    if (T.simEls) renderSim();
    const rg = S.pop?.region;
    if (rg) {
      const r = regionRect({ region: rg });
      const dr = q('.dr');
      dr.hidden = false;
      dr.classList.add('set');
      dr.classList.remove('circle');
      Object.assign(dr.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      dr.querySelector('.sz').textContent = `${rg.w}×${rg.h}`;
    }
  }

  const ONBOARD = `<b>How it works</b>
    <div class="step"><i>1</i><span>Press <b>Add note</b>, or start from the page with <b>Select element</b> or <b>Circle an area</b>.</span></div>
    <div class="step"><i>2</i><span>Say what should change. Try values live if you like.</span></div>
    <div class="step"><i>3</i><span>When you have all your notes, press <b>Export prompt</b> and paste it into Claude Code.</span></div>`;

  const MODE_NAME = { shopify: 'a Shopify theme', next: 'a Next.js app', react: 'a React app', html: 'plain HTML/CSS/JS' };

  const uiType = (it) => (BL.TYPES.find((t) => t.id === it.type) || {}).ui || BL.typeLabel(it.type);
  function metaText(it) {
    const where = it.kind === 'region' ? `empty area ${it.region.w}×${it.region.h}` : it.kind === 'page' ? 'whole page' : it.el.label;
    const bits = [`${uiType(it)} · ${where}`];
    if (it.also?.length) bits.push(`+${it.also.length} more`);
    if (it.marks?.some((m) => !m.auto)) bits.push('drawn on');
    if (it.priority === 'nice') bits.push('nice to have');
    if (it.path !== here()) bits.unshift(it.path);
    return bits.join(' · ');
  }

  hooks.afterRender = () => {
    updateToolbar();
    renderAnn();
    applyAllPreviews();
    const empty = q('.empty');
    if (empty && !empty.dataset.init) { empty.dataset.init = '1'; empty.innerHTML = ONBOARD; }
    const mode = q('.mode');
    if (mode) mode.title = `Blueline detected ${MODE_NAME[BL.modeOf(S.page)]} on this page`;
    const ex = q('[data-act="export"]');
    if (ex) ex.title = 'Build one prompt from all your notes, ready to paste into Claude Code';
    for (const li of qa('.list .item')) {
      const it = BL.findItem(li.dataset.id);
      const meta = li.querySelector('.meta');
      if (!it || !meta) continue;
      meta.textContent = metaText(it);
    }
  };
  hooks.onSchedule = () => { renderAnn(); applyAllPreviews(); };

  // ------------------------------------------------------------------ drawing on the page

  function startDrawing(tool) {
    setAnnotate(false, true);
    cancelTools();
    D.tool = D.tool === tool ? null : tool;
    syncDrawUi();
    BL.cursorStyle(!!D.tool);
    if (D.tool) showBar(D.tool === 'text' ? 'Click where the text should go. Esc stops drawing.' : 'Drag on the page to draw. Esc stops drawing.'); else hideBar();
  }

  function stopDrawing() {
    if (!D.tool && !D.cur) return;
    D.tool = null;
    D.cur = null;
    hideBar();
    BL.cursorStyle(A.on);
    syncDrawUi();
  }

  function syncDrawUi() {
    for (const b of qa('[data-draw]')) b.classList.toggle('on', b.dataset.draw === D.tool);
    for (const b of qa('[data-dc]')) b.classList.toggle('on', b.dataset.dc === D.color);
    const s = q('.draw-sum');
    const drawn = P.marks.filter((m) => !m.auto).length;
    if (s) s.textContent = drawn ? `${drawn} drawing${drawn === 1 ? '' : 's'}` : '';
  }

  function drawMouse(e) {
    const p = { x: e.clientX + scrollX, y: e.clientY + scrollY };
    if (e.type === 'pointerdown' && e.button === 0) {
      if (D.tool === 'text') { textPrompt(e, p); return; }
      D.cur = D.tool === 'pen' ? { t: 'pen', c: D.color, pts: [p] } : { t: D.tool, c: D.color, a: p, b: p };
    } else if (e.type === 'pointermove' && D.cur) {
      if (D.cur.t === 'pen') D.cur.pts.push(p); else D.cur.b = p;
      renderDrawn();
    } else if (e.type === 'pointerup' && D.cur) {
      const c = D.cur;
      D.cur = null;
      const size = c.t === 'pen' ? c.pts.length : Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y);
      if (size > (c.t === 'pen' ? 3 : 6)) { P.marks.push(c); P.marksDirty = true; }
      syncDrawUi();
      renderAnn();
    }
  }

  function textPrompt(e, p) {
    const inp = mk('<input class="xtxt" placeholder="Type, then Enter">');
    inp.style.left = `${e.clientX}px`;
    inp.style.top = `${e.clientY - 14}px`;
    q('.x-bar').after(inp);
    inp.focus();
    // Removing a focused input fires blur straight away, so removal has to be idempotent.
    let gone = false;
    const kill = () => { if (gone) return; gone = true; inp.remove(); };
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter' && inp.value.trim()) { P.marks.push({ t: 'text', c: D.color, p, s: inp.value.trim() }); P.marksDirty = true; kill(); syncDrawUi(); renderAnn(); }
      else if (ev.key === 'Escape') kill();
    });
    inp.addEventListener('blur', kill);
  }

  function paintMarks(ctx, marks, k, lw) {
    const pt = (p) => ({ x: (p.x - scrollX) * k, y: (p.y - scrollY) * k });
    for (const s of marks) {
      const c = { t: s.t, c: s.c };
      if (s.pts) c.pts = s.pts.map(pt);
      if (s.a) { c.a = pt(s.a); c.b = pt(s.b); }
      if (s.p) { c.p = pt(s.p); c.s = s.s; }
      drawStroke(ctx, c, lw);
    }
  }

  function drawStroke(ctx, s, lw) {
    ctx.strokeStyle = s.c;
    ctx.fillStyle = s.c;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (s.t === 'pen') { s.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke(); }
    else if (s.t === 'arrow') {
      ctx.moveTo(s.a.x, s.a.y); ctx.lineTo(s.b.x, s.b.y); ctx.stroke();
      const ang = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
      const hl = lw * 5;
      ctx.beginPath();
      ctx.moveTo(s.b.x, s.b.y);
      ctx.lineTo(s.b.x - hl * Math.cos(ang - 0.45), s.b.y - hl * Math.sin(ang - 0.45));
      ctx.lineTo(s.b.x - hl * Math.cos(ang + 0.45), s.b.y - hl * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fill();
    } else if (s.t === 'box') ctx.strokeRect(s.a.x, s.a.y, s.b.x - s.a.x, s.b.y - s.a.y);
    else if (s.t === 'circle') { ctx.ellipse((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, Math.abs(s.b.x - s.a.x) / 2, Math.abs(s.b.y - s.a.y) / 2, 0, 0, Math.PI * 2); ctx.stroke(); }
    else if (s.t === 'text') {
      ctx.font = `700 ${lw * 5.6}px -apple-system, Segoe UI, sans-serif`;
      ctx.lineWidth = lw * 1.4;
      ctx.strokeStyle = '#fff';
      ctx.strokeText(s.s, s.p.x, s.p.y);
      ctx.fillText(s.s, s.p.x, s.p.y);
    }
  }

  // Saves a marked-up screenshot (page + outlines + your drawings) next to the note's other images.
  async function captureMarked(it, marks) {
    if (!S.ui) return;
    S.ui.host.style.visibility = 'hidden';
    await BL.frames(2);
    const res = await BL.send({ type: 'blueline:capture' });
    if (S.ui) S.ui.host.style.visibility = '';
    if (!res?.dataUrl) return;
    try {
      const img = await BL.loadImg(res.dataUrl);
      const k0 = Math.min(1, 1800 / img.naturalWidth);
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.naturalWidth * k0);
      cv.height = Math.round(img.naturalHeight * k0);
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      const k = cv.width / window.innerWidth;
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(2, 2 * k);
      for (const el of targetsOf(it)) { const r = el.getBoundingClientRect(); ctx.strokeRect(r.left * k, r.top * k, r.width * k, r.height * k); }
      if (it.kind === 'region') { const r = regionRect(it); ctx.setLineDash([8 * k, 5 * k]); ctx.strokeRect(r.left * k, r.top * k, r.width * k, r.height * k); ctx.setLineDash([]); }
      paintMarks(ctx, marks, k, Math.max(3, 3 * k));
      await chrome.storage.local.set({ [BL.shotKey(it.id) + ':markup']: cv.toDataURL('image/png') });
      it.hasMarkup = true;
      it.markupPath = undefined;
      await BL.saveBatch();
    } catch { /* capture failed; the note still saves */ }
  }

  // ------------------------------------------------------------------ region description + screenshot

  hooks.describeRegion = (ps, type) => {
    if (ps.page) {
      return {
        type, kind: 'page', url: location.href, path: here(), title: document.title,
        viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 }, page: S.page, mode: BL.modeOf(S.page), styling: [],
        el: { label: 'whole page', selector: '', text: '', markup: '', styles: '', box: '', layout: [], size: '', issues: [], classes: '', modules: [], rules: [], blockedSheets: 0, flags: [], section: null, block: null, src: null },
        steps: [], console: [], network: [], armed: !!S.page?.armed,
      };
    }
    const rg = ps.region;
    const ctx = rg.ctx;
    const mode = BL.modeOf(S.page);
    const rx = mode === 'next' || mode === 'react' ? BL.inspectReact(ctx._el) : null;
    const { _el, ...ctxPlain } = ctx;
    return {
      type, kind: 'region', url: location.href, path: here(), title: document.title,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 }, page: S.page, mode, styling: BL.stylingOf(_el),
      el: {
        label: `region ${rg.w}×${rg.h}`, selector: '', text: '', markup: '', styles: '', box: '', layout: [], size: `${rg.w}×${rg.h}`,
        issues: [], classes: '', modules: [], rules: [], blockedSheets: 0, react: rx, flags: [],
        section: mode === 'shopify' ? BL.findSection(_el) : null, block: null,
        src: _el.closest('[data-blueline-src]')?.getAttribute('data-blueline-src') || null,
      },
      region: { x: rg.x, y: rg.y, w: rg.w, h: rg.h, anchor: rg.anchor, ctx: ctxPlain },
      steps: [], console: [], network: [], armed: !!S.page?.armed,
    };
  };

  async function captureRect(r, dashed) {
    if (!S.ui) return null;
    S.ui.host.style.visibility = 'hidden';
    await BL.frames(2);
    const res = await BL.send({ type: 'blueline:capture' });
    if (S.ui) S.ui.host.style.visibility = '';
    if (!res?.dataUrl) return null;
    try {
      const img = await BL.loadImg(res.dataUrl);
      const scale = window.devicePixelRatio || img.naturalWidth / window.innerWidth;
      const pad = 24;
      const x0 = Math.max(0, r.left - pad);
      const y0 = Math.max(0, r.top - pad);
      const w = Math.min(window.innerWidth, r.left + r.width + pad) - x0;
      const h = Math.min(window.innerHeight, r.top + r.height + pad) - y0;
      if (w < 4 || h < 4) return null;
      const k = scale * Math.min(1, 1400 / (Math.max(w, h) * scale));
      const c = document.createElement('canvas');
      c.width = Math.round(w * k);
      c.height = Math.round(h * k);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, x0 * scale, y0 * scale, w * scale, h * scale, 0, 0, c.width, c.height);
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(2, 2 * k);
      if (dashed) ctx.setLineDash([8 * k, 5 * k]);
      ctx.strokeRect((r.left - x0) * k, (r.top - y0) * k, r.width * k, r.height * k);
      return c.toDataURL('image/png');
    } catch { return null; }
  }
  hooks.captureRegion = (rg) => captureRect({ left: rg.x - scrollX, top: rg.y - scrollY, width: rg.w, height: rg.h }, true);

  // ------------------------------------------------------------------ move

  function targetInfo(el) {
    const rx = ['next', 'react'].includes(BL.modeOf(S.page)) ? BL.inspectReact(el) : null;
    const comp = (rx?.components || []).filter((c) => !c.server).slice(-1)[0];
    return { label: BL.label(el), selector: BL.cssPath(el), text: textOf(el, 50), src: rx?.rendered || null, comp: comp?.name || null };
  }

  function positionFor(dst) {
    const r = dst.el.getBoundingClientRect();
    const fy = r.height ? (dst.y - r.top) / r.height : 0.5;
    if (fy < 0.3) return 'before';
    if (fy > 0.7) return 'after';
    return dst.el.children.length ? 'inside-end' : fy < 0.5 ? 'before' : 'after';
  }

  function insertPreview(el, e) {
    clearMeas();
    if (!el) return;
    const g = q('.x-meas');
    const r = el.getBoundingClientRect();
    const pos = positionFor({ el, x: e.clientX, y: e.clientY });
    if (pos === 'inside-end' || pos === 'inside-start') {
      const n = document.createElementNS(SVGNS, 'rect');
      Object.entries({ x: r.left + 3, y: r.top + 3, width: Math.max(0, r.width - 6), height: Math.max(0, r.height - 6), fill: 'none', stroke: INK, 'stroke-width': 3, 'stroke-dasharray': '6 4' }).forEach(([k, v]) => n.setAttribute(k, v));
      g.appendChild(n);
    } else {
      const n = document.createElementNS(SVGNS, 'line');
      const y = pos === 'before' ? r.top : r.bottom;
      Object.entries({ x1: r.left, y1: y, x2: r.right, y2: y, stroke: INK, 'stroke-width': 4 }).forEach(([k, v]) => n.setAttribute(k, v));
      g.appendChild(n);
    }
  }

  async function moveHere() {
    if (!P.el) return;
    const el = P.el;
    const dst = await pickOne('Click where this should go: top edge = before, bottom edge = after, middle = inside. Esc cancels.', insertPreview);
    if (!dst) return;
    if (dst.el === el || el.contains(dst.el)) { toast('Pick a destination outside the element you\u2019re moving.'); return; }
    P.move = { to: targetInfo(dst.el), toEl: dst.el, position: positionFor(dst) };
    renderStrips();
    renderAnn();
  }

  // ------------------------------------------------------------------ strips (move, match, text, measures, colors, variant)

  function renderStrips() {
    const box = q('.x-strips');
    if (!box) return;
    const rows = [];
    const rm = (k, i) => `<button class="icon" data-x="${k}"${i !== undefined ? ` data-i="${i}"` : ''} aria-label="Remove">✕</button>`;
    if (P.move) {
      const opts = [['before', 'before'], ['after', 'after'], ['inside-start', 'inside, first'], ['inside-end', 'inside, last']];
      rows.push(`<div class="strip"><span>Move to <select class="xin mv-pos">${opts.map(([v, l]) => `<option value="${v}"${P.move.position === v ? ' selected' : ''}>${l}</option>`).join('')}</select> ${esc(P.move.to.label)}</span>${rm('rm-move')}</div>`);
    }
    if (P.match) rows.push(`<div class="strip"><span>Match <b>${esc(P.match.label)}</b>: ${P.match.diffs.length} difference${P.match.diffs.length === 1 ? '' : 's'}</span><span><button class="xb" data-x="match-apply">Preview</button>${rm('rm-match')}</span></div>`);
    if (P.textEdit) rows.push(`<div class="strip"><span>Text: “${esc(clip(P.textEdit.before, 24))}” → “${esc(clip(P.textEdit.after, 24))}”</span>${rm('rm-text')}</div>`);
    P.measures.forEach((m, i) => rows.push(`<div class="strip"><span>Measure to <b>${esc(m.label)}</b>: ${esc(m.summary)}</span>${rm('rm-measure', i)}</div>`));
    if (P.colors.length) rows.push(`<div class="strip"><span>${P.colors.map((c) => `<span class="swatch" style="background:${c}"></span>${c}`).join('  ')}</span>${rm('rm-colors')}</div>`);
    if (P.variant) {
      const v = P.variant;
      const sr = sheet && v.sku ? sheet.rows.find((r) => r.sku === v.sku) : null;
      rows.push(`<div class="strip"><span>Variant <b>${esc(v.title)}</b> · ${esc(v.handle)} · $${v.price.toFixed(2)}${sr ? ` · sheet $${sr.price.toFixed(2)}${Math.abs(sr.price - v.price) >= 0.005 ? ' (differs)' : ''}` : ''}</span>${rm('rm-variant')}</div>`);
    }
    box.innerHTML = rows.join('');
  }

  // ------------------------------------------------------------------ event delegation

  function onClick(e) {
    if (e.target.classList && e.target.classList.contains('xmodal')) { e.target.hidden = true; return; }
    if (e.target.closest('.type')) { updateTypeHint(); return; }
    if (e.target.closest('[data-act="side"]')) { S.prefs.pos = null; const p = q('.panel'); Object.assign(p.style, { left: '', top: '', right: '', bottom: '' }); BL.savePrefs(); return; }
    const chip = e.target.closest('[data-prio],[data-bp]');
    if (chip) {
      if (chip.dataset.prio) P.priority = chip.dataset.prio;
      else if (chip.dataset.bp === 'all') {
        const all = ['mobile', 'tablet', 'desktop'].every((b) => P.bps.has(b));
        P.bps = new Set(all ? [bpNow()] : ['mobile', 'tablet', 'desktop']);
      } else if (P.bps.has(chip.dataset.bp)) { if (P.bps.size > 1) P.bps.delete(chip.dataset.bp); } else P.bps.add(chip.dataset.bp);
      syncChips();
      return;
    }
    const dt = e.target.closest('[data-draw]');
    if (dt) { startDrawing(dt.dataset.draw); return; }
    const dc = e.target.closest('[data-dc]');
    if (dc) { D.color = dc.dataset.dc; syncDrawUi(); return; }
    const b = e.target.closest('[data-x]');
    if (!b || b.tagName === 'INPUT') return;
    const x = b.dataset.x;
    switch (x) {
      case 'add-note': if (!S.pop) BL.openPop(null, null, { page: true, els: [] }); q('.pop-note').focus(); break;
      case 'start-select': case 'sel-element': startSelect(false); break;
      case 'start-circle': case 'sel-circle': startCircle(); break;
      case 'sel-add': startSelect(true); break;
      case 'guides': { const gb = q('.x-guidebox'); gb.hidden = !gb.hidden; setOn('guides', !gb.hidden); break; }
      case 'overlay': toggleOverlayPanel(); break;
      case 'sheet': openSheet(); break;
      case 'previews': S.prefs.previews = S.prefs.previews === false; BL.savePrefs(); applyAllPreviews(); updateToolbar(); break;
      case 'marks': S.prefs.marks = S.prefs.marks === 'badges' ? 'full' : 'badges'; BL.savePrefs(); updateToolbar(); renderAnn(); break;
      case 'bar-cancel': if (T.pick) endPick(null); else if (D.tool) stopDrawing(); else if (A.on) setAnnotate(false); break;
      case 'g-v': addGuide('x'); break;
      case 'g-h': addGuide('y'); break;
      case 'g-show': S.prefs.guidesHidden = !S.prefs.guidesHidden; BL.savePrefs(); renderAnn(); updateToolbar(); break;
      case 'g-eye': { const g = (S.batch?.guides || []).find((x2) => x2.id === b.dataset.id); if (g) { g.hidden = !g.hidden; BL.saveBatch(); renderAnn(); renderGuideList(); } break; }
      case 'g-del': if (S.batch?.guides) { S.batch.guides = S.batch.guides.filter((g) => g.id !== b.dataset.id); BL.saveBatch(); renderAnn(); updateToolbar(); if (S.pop) buildAlignRows(); } break;
      case 'mk-open': { const it = BL.findItem(b.dataset.id); if (!it) break; if (S.pop) toast('Save or cancel the note you\u2019re editing first.'); else hooksFocus(it); break; }
      case 'sel-rm': if (P.els.length > 1) setTarget({ els: P.els.filter((_, i) => i !== +b.dataset.i) }); else BL.closePop(); break;
      case 'dictate': toggleDictation(); break;
      case 'edittext': startEditText(); break;
      case 'hide': togglePopHide(); break;
      case 'match': startMatch(); break;
      case 'measure-to': startMeasureTo(); break;
      case 'pop-color': dropper((hex) => { P.colors.push(hex); copyText(hex); renderStrips(); toast(`${hex} copied`); }); break;
      case 'st-drop': { const row = b.closest('.st'); dropper((hex) => { row.querySelector('.sv').value = hex; styleInput(row, hex); }); break; }
      case 'st-dec': case 'st-inc': { const row = b.closest('.st'); const inp = row.querySelector('.sv'); styleInput(row, stepVal(row.dataset.prop, inp.value || row.dataset.from, x === 'st-inc' ? 1 : -1, e.shiftKey)); inp.value = P.tweaks[row.dataset.prop] ? P.tweaks[row.dataset.prop].to : row.dataset.from; break; }
      case 'style-reset': resetStyles(); break;
      case 'snap': snapTo(b.dataset.g, b.dataset.edge); break;
      case 'move-here': moveHere(); break;
      case 'draw-undo': P.marks.pop(); P.marksDirty = true; syncDrawUi(); renderAnn(); break;
      case 'draw-clear': P.marks = []; P.marksDirty = true; syncDrawUi(); renderAnn(); break;
      case 'rm-move': P.move = null; renderStrips(); renderAnn(); break;
      case 'rm-match': P.match = null; renderStrips(); break;
      case 'match-apply': applyMatchPreview(); break;
      case 'rm-text': if (P.el && P.textEdit && !P.el.children.length) P.el.textContent = P.textEdit.before; P.textEdit = null; renderStrips(); break;
      case 'rm-measure': P.measures.splice(+b.dataset.i, 1); renderStrips(); break;
      case 'rm-colors': P.colors = []; renderStrips(); break;
      case 'rm-variant': P.variant = null; renderStrips(); break;
      case 'var-product': pickProduct(b.dataset.handle); break;
      case 'var-variant': pickVariant(+b.dataset.i); break;
      case 'ov-close': q('.xov').hidden = true; setOn('overlay', false); break;
      case 'ov-fit': OV.state.width = document.documentElement.clientWidth; OV.state.x = 0; OV.state.y = 0; syncOverlayPanel(); paintOverlay(); saveOverlay(); break;
      case 'ov-half': if (OV.img?.naturalWidth) { OV.state.width = Math.round(OV.img.naturalWidth / 2); syncOverlayPanel(); paintOverlay(); saveOverlay(); } break;
      case 'ov-clear': OV.state.dataUrl = null; paintOverlay(); saveOverlay(); syncOverlayPanel(); break;
      case 'sh-close': q('[data-m="sheet"]').hidden = true; break;
      case 'sh-check': runPriceCheck(); break;
      case 'sh-clear': sheet = null; chrome.storage.local.remove('blueline:sheet'); if (S.batch) { delete S.batch.priceReport; BL.saveBatch(); } renderSheet(); break;
      default: break;
    }
  }

  function hooksFocus(it) {
    if (it.kind === 'region') { hooks.focusRegion(it); return; }
    const el = BL.query(it.el.selector);
    if (!el || it.path !== here()) { BL.openPop(null, it); return; }
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    setTimeout(() => BL.openPop(el, it), smooth ? 380 : 0);
  }

  function onInput(e) {
    const t = e.target;
    if (t.classList.contains('sv')) { styleInput(t.closest('.st'), t.value); return; }
    if (t.classList.contains('sw')) { const row = t.closest('.st'); row.querySelector('.sv').value = t.value; styleInput(row, t.value); return; }
    if (t.classList.contains('figma-in')) { P.figma = t.value.trim(); return; }
    if (t.classList.contains('var-q')) { clearTimeout(varT); varT = setTimeout(() => variantSearch(t.value.trim()), 300); return; }
    if (t.dataset.ov) onOverlayInput(t);
  }

  function onChange(e) {
    const t = e.target;
    if (t.name === 'scope') { P.scope = t.value; P.scopeTouched = true; updateScope(); }
    else if (t.classList.contains('grp-sel')) { P.groupIdx = +t.value; P.scope = 'group'; P.scopeTouched = true; updateScope(); }
    else if (t.classList.contains('mv-pos') && P.move) { P.move.position = t.value; renderAnn(); }
    else if (t.dataset.x === 'ov-file') loadOverlayFile(t.files[0]);
    else if (t.dataset.x === 'sh-file') loadSheetFile(t.files[0]);
    else if (t.dataset.ov) onOverlayInput(t);
  }

  function onUIKey(e) {
    const t = e.target;
    if (t.classList?.contains('sv') && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const row = t.closest('.st');
      styleInput(row, stepVal(row.dataset.prop, t.value || row.dataset.from, e.key === 'ArrowUp' ? 1 : -1, e.shiftKey));
      t.value = P.tweaks[row.dataset.prop] ? P.tweaks[row.dataset.prop].to : row.dataset.from;
    } else if (t.dataset?.ov && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && (t.dataset.ov === 'x' || t.dataset.ov === 'y')) {
      e.preventDefault();
      t.value = String((parseFloat(t.value) || 0) + (e.key === 'ArrowUp' ? -1 : 1) * (e.shiftKey ? 10 : 1));
      onOverlayInput(t);
    }
  }

  // ------------------------------------------------------------------ pop actions

  async function copyText(text) { try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked */ } }

  async function dropper(cb) {
    if (!window.EyeDropper) { toast('The eyedropper needs Chrome on https or localhost.'); return; }
    try { const r = await new window.EyeDropper().open(); cb(r.sRGBHex.toLowerCase()); } catch { /* cancelled */ }
  }

  function globalColor(hex) {
    copyText(hex);
    toast(`${hex} copied`);
    if (S.pop) { P.colors.push(hex); renderStrips(); }
  }

  function toggleDictation() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('Dictation isn\u2019t available here. Try your OS dictation shortcut.'); return; }
    if (T.speech) { T.speech.stop(); return; }
    const ta = q('.pop-note');
    const r = new SR();
    r.continuous = true;
    r.interimResults = false;
    r.lang = navigator.language || 'en-US';
    r.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) ta.value = `${ta.value.replace(/\s*$/, ' ')}${e.results[i][0].transcript.trim()}`.trimStart(); };
    r.onerror = (e) => toast(e.error === 'not-allowed' ? 'The mic is blocked for this site. Allow it in site settings, or use your OS dictation.' : `Dictation stopped: ${e.error}`);
    r.onend = () => { T.speech = null; setOn('dictate', false); const b = q('[data-x="dictate"]'); if (b) b.textContent = 'Speak your note'; };
    T.speech = r;
    r.start();
    setOn('dictate', true);
    const db = q('[data-x="dictate"]'); if (db) db.textContent = 'Listening… tap to stop';
  }

  function togglePopHide() {
    if (!P.els.length) return;
    P.hide = !P.hide;
    for (const el of P.els) { if (P.hide) setInline(el, 'display', 'none'); else restoreInline(el, 'display'); }
    updateHideButton();
    renderAnn();
  }

  function startEditText() {
    const el = P.el;
    if (!el || editing || P.els.length !== 1) return;
    if (el.children.length) { toast('This element has other elements inside. Select the text element itself.'); return; }
    const before = P.textEdit ? P.textEdit.before : el.textContent.trim();
    editing = { el, before };
    q('.panel').style.visibility = 'hidden';
    el.contentEditable = 'plaintext-only';
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    showBar('Editing text. Enter finishes, Esc cancels.');
    editing.onKey = (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); finishEdit(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finishEdit(false); }
    };
    editing.onBlur = () => finishEdit(true);
    el.addEventListener('keydown', editing.onKey, true);
    el.addEventListener('blur', editing.onBlur);
  }

  function finishEdit(keep) {
    if (!editing) return;
    const { el, before, onKey: onK, onBlur } = editing;
    editing = null;
    el.removeEventListener('keydown', onK, true);
    el.removeEventListener('blur', onBlur);
    const after = el.textContent.trim();
    el.removeAttribute('contenteditable');
    hideBar();
    const panel = q('.panel');
    if (panel) panel.style.visibility = '';
    if (keep && after && after !== before) P.textEdit = { before, after };
    else { el.textContent = P.textEdit ? P.textEdit.after : before; if (!P.textEdit) P.textEdit = null; }
    renderStrips();
  }

  async function startMatch() {
    if (!P.el) return;
    const r = await pickOne('Match: click the element this one should look like. Esc cancels.');
    if (!r) return;
    const a = getComputedStyle(P.el);
    const b = getComputedStyle(r.el);
    const diffs = [];
    for (const p of MATCH_PROPS) {
      const x = a.getPropertyValue(p).trim();
      const y = b.getPropertyValue(p).trim();
      if (x !== y) diffs.push({ prop: p, from: clip(x, 60), to: clip(y, 60) });
    }
    const info = targetInfo(r.el);
    P.match = { label: info.label, selector: info.selector, src: info.src, diffs: diffs.slice(0, 12) };
    renderStrips();
    toast(diffs.length ? `${diffs.length} difference${diffs.length === 1 ? '' : 's'} found. Tap Preview to try them.` : 'These already look identical.');
  }

  function applyMatchPreview() {
    if (!P.match || !P.el) return;
    const tw = BL.stylingOf(P.el).includes('tailwind');
    for (const d of P.match.diffs) {
      if (d.prop === 'margin') continue;
      setInline(P.el, d.prop, d.to);
      P.tweaks[d.prop] = { prop: d.prop, from: d.from, to: d.to, token: tokenHint(d.prop, d.to, tw) };
    }
    buildStyleRows();
    q('[data-d="props"]').open = true;
  }

  async function startMeasureTo() {
    if (!P.el) return;
    const a = P.el;
    const r = await pickOne('Measure: hover to preview the distance, click the element to record it. Esc cancels.', (el) => { if (el && el !== a) drawMeasure(a.getBoundingClientRect(), el.getBoundingClientRect()); });
    if (!r) return;
    const m = measureRects(a.getBoundingClientRect(), r.el.getBoundingClientRect());
    const info = targetInfo(r.el);
    P.measures.push({ label: info.label, selector: info.selector, ...m, summary: measureText(m) });
    renderStrips();
  }

  // ------------------------------------------------------------------ design overlay

  function ensureOverlayHost() {
    if (OV.host) return;
    OV.host = document.createElement('blueline-overlay');
    OV.host.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483646;';
    OV.img = document.createElement('img');
    OV.img.style.cssText = 'position:absolute;pointer-events:none;max-width:none;';
    OV.host.appendChild(OV.img);
    document.documentElement.appendChild(OV.host);
  }

  function removeOverlayHost() { if (OV.host) { OV.host.remove(); OV.host = null; OV.img = null; } }

  function paintOverlay() {
    const s = OV.state;
    if (!s.dataUrl || !s.visible) { removeOverlayHost(); return; }
    ensureOverlayHost();
    if (OV.img.src !== s.dataUrl) OV.img.src = s.dataUrl;
    Object.assign(OV.img.style, { left: `${s.x}px`, top: `${s.y}px`, width: s.width ? `${s.width}px` : 'auto', opacity: String(s.opacity / 100), mixBlendMode: s.diff ? 'difference' : 'normal' });
  }

  function saveOverlay() {
    clearTimeout(ovSaveT);
    ovSaveT = setTimeout(() => { try { chrome.storage.local.set({ 'blueline:overlay': OV.state }); } catch { /* context gone */ } }, 300);
  }

  async function loadOverlay() {
    try { const r = await chrome.storage.local.get('blueline:overlay'); if (r['blueline:overlay']) Object.assign(OV.state, r['blueline:overlay']); } catch { /* ignore */ }
    paintOverlay();
    syncOverlayPanel();
  }

  function syncOverlayPanel() {
    const p = q('.xov');
    if (!p) return;
    const s = OV.state;
    p.querySelector('[data-ov="opacity"]').value = s.opacity;
    p.querySelector('[data-ov="width"]').value = s.width || '';
    p.querySelector('[data-ov="x"]').value = s.x;
    p.querySelector('[data-ov="y"]').value = s.y;
    p.querySelector('[data-ov="diff"]').checked = !!s.diff;
    p.querySelector('[data-ov="visible"]').checked = s.visible !== false;
  }

  function onOverlayInput(t) {
    OV.state[t.dataset.ov] = t.type === 'checkbox' ? t.checked : parseFloat(t.value) || 0;
    paintOverlay();
    saveOverlay();
  }

  function toggleOverlayPanel() {
    const p = q('.xov');
    p.hidden = !p.hidden;
    setOn('overlay', !p.hidden);
    if (!p.hidden) syncOverlayPanel();
  }

  function loadOverlayFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const fr = new FileReader();
    fr.onload = () => {
      const probe = new Image();
      probe.onload = () => {
        OV.state = { ...OV.state, dataUrl: fr.result, width: Math.round(probe.naturalWidth), x: 0, y: 0, visible: true };
        paintOverlay();
        syncOverlayPanel();
        saveOverlay();
        toast('Overlay loaded. Set the width to your Figma frame width and use the opacity slider.');
      };
      probe.src = fr.result;
    };
    fr.readAsDataURL(file);
  }

  function onPaste(e) {
    if (!S.active || q('.xov')?.hidden !== false) return;
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); loadOverlayFile(f); }
  }

  // ------------------------------------------------------------------ Shopify variants (read-only)

  async function variantSearch(text) {
    const box = q('.var-res');
    if (!text) { box.textContent = ''; return; }
    box.textContent = 'Searching…';
    try {
      const r = await fetch(`/search/suggest.json?q=${encodeURIComponent(text)}&resources[type]=product&resources[limit]=6`, { headers: { Accept: 'application/json' } });
      const products = (await r.json()).resources?.results?.products || [];
      box.innerHTML = products.length ? products.map((p) => `<button data-x="var-product" data-handle="${esc(p.handle)}">${esc(p.title)}</button>`).join('') : '<span class="sub">No products found.</span>';
    } catch { box.innerHTML = '<span class="sub">Search failed. Is this a storefront page?</span>'; }
  }

  let lastProduct = null;
  async function pickProduct(handle) {
    const box = q('.var-res');
    box.textContent = 'Loading variants…';
    try {
      lastProduct = await (await fetch(`/products/${encodeURIComponent(handle)}.js`, { headers: { Accept: 'application/json' } })).json();
      box.innerHTML = lastProduct.variants.map((v, i) => `<button data-x="var-variant" data-i="${i}">${esc(v.title)} · $${(v.price / 100).toFixed(2)}${v.sku ? ` · ${esc(v.sku)}` : ''}${v.available ? '' : ' · sold out'}</button>`).join('');
    } catch { box.innerHTML = '<span class="sub">Couldn\u2019t load that product.</span>'; }
  }

  function pickVariant(i) {
    const v = lastProduct?.variants?.[i];
    if (!v) return;
    P.variant = { handle: lastProduct.handle, productId: lastProduct.id, productTitle: lastProduct.title, variantId: v.id, title: v.title, sku: v.sku || null, price: v.price / 100, available: v.available };
    q('.var-res').textContent = '';
    q('.var-q').value = '';
    renderStrips();
  }

  // ------------------------------------------------------------------ price sheet modal

  async function loadSheet() {
    try { const r = await chrome.storage.local.get('blueline:sheet'); sheet = r['blueline:sheet'] || null; } catch { /* ignore */ }
    renderSheet();
  }

  function openSheet() { renderSheet(); q('[data-m="sheet"]').hidden = false; }

  function loadSheetFile(file) {
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      const parsed = sheetFromRows(parseCSV(String(fr.result)));
      if (parsed.error) { toast(parsed.error); return; }
      sheet = { name: file.name, rows: parsed.rows, cols: parsed.cols };
      chrome.storage.local.set({ 'blueline:sheet': sheet });
      renderSheet();
    };
    fr.readAsText(file);
  }

  function renderSheet() {
    const m = q('[data-m="sheet"]');
    if (!m) return;
    m.querySelector('.sh-name').textContent = sheet ? sheet.name : '';
    const withHandle = sheet ? sheet.rows.filter((r) => r.handle).length : 0;
    m.querySelector('.sh-sum').textContent = sheet ? `${plural(sheet.rows.length, 'row')} · ${withHandle} with a product handle can be checked in bulk. Others are matched by SKU when you pick a variant on a note.` : 'No sheet loaded. Needs a price column plus SKU, handle, or variant id. Export Excel files as CSV first.';
    m.querySelector('[data-x="sh-check"]').disabled = !sheet || !withHandle;
    const out = m.querySelector('.sh-out');
    const rep = S.batch?.priceReport;
    out.hidden = !rep;
    if (rep) out.textContent = priceReportText(rep).join('\n');
  }

  async function runPriceCheck() {
    if (!sheet) return;
    const out = q('.sh-out');
    out.hidden = false;
    out.textContent = 'Checking…';
    const res = await checkPrices(sheet.rows, (d, n) => { out.textContent = `Checked ${d} of ${n} products…`; });
    const b = BL.ensureBatch();
    b.priceReport = { file: sheet.name, at: Date.now(), rows: sheet.rows.length, checked: res.checked, mismatches: res.mismatches.slice(0, 40), mismatchCount: res.mismatches.length, missing: res.missing.slice(0, 20), notFound: res.notFound.slice(0, 20), skipped: res.skipped };
    BL.saveBatch();
    out.textContent = priceReportText(b.priceReport).join('\n');
    BL.render();
  }

  function priceReportText(r) {
    const L = [`Compared ${r.file} (${r.rows} rows) with live storefront prices: ${r.checked} variants checked, ${r.mismatchCount} differ.`];
    r.mismatches.forEach((m) => L.push(`  ${m.handle}${m.sku ? ` (${m.sku})` : ''}: sheet $${m.sheet.toFixed(2)} vs live $${m.live.toFixed(2)}`));
    if (r.mismatchCount > r.mismatches.length) L.push(`  …and ${r.mismatchCount - r.mismatches.length} more`);
    if (r.missing.length) L.push(`No matching variant for: ${r.missing.map((m) => m.sku || m.handle).join(', ')}`);
    if (r.notFound.length) L.push(`Product not found: ${r.notFound.join(', ')}`);
    if (r.skipped) L.push(`${r.skipped} rows had no handle and were skipped.`);
    return L;
  }

  // ------------------------------------------------------------------ collect / commit

  function alsoInfo(el) {
    const mode = BL.modeOf(S.page);
    const rx = ['next', 'react'].includes(mode) ? BL.inspectReact(el) : null;
    const sec = mode === 'shopify' ? BL.findSection(el) : null;
    return { label: BL.label(el), selector: BL.cssPath(el), text: textOf(el, 40), size: `${Math.round(el.getBoundingClientRect().width)}×${Math.round(el.getBoundingClientRect().height)}`, rendered: rx?.rendered || null, section: sec ? sec.wrapperId : null };
  }

  hooks.collect = (ps) => {
    const region = !!(ps.region || ps.item?.kind === 'region');
    const f = {
      priority: P.priority, bps: ['mobile', 'tablet', 'desktop'].filter((b) => P.bps.has(b)), figma: P.figma || undefined,
      colors: P.colors.length ? [...P.colors] : undefined,
      marks: P.marks.length ? P.marks.map((m) => JSON.parse(JSON.stringify(m))) : undefined,
      auto: P.auto ? true : undefined,
    };
    let defaultNote = '';
    const marks = P.marks.slice();
    const marksDirty = P.marksDirty;
    if (!region && P.el) {
      f.scope = P.els.length > 1 ? undefined : scopeInfo();
      const tw = Object.values(P.tweaks);
      f.tweaks = tw.length ? tw.map(({ prop, from, to, token, snap }) => ({ prop, from, to, token, snap })) : undefined;
      f.textEdit = P.textEdit || undefined;
      f.hidden = P.hide || undefined;
      f.match = P.match || undefined;
      f.move = P.move ? { to: P.move.to, position: P.move.position } : undefined;
      const al = alignFields();
      f.align = al.length ? al : undefined;
      f.measures = P.measures.length ? P.measures.map(({ label, selector, summary }) => ({ label, selector, summary })) : undefined;
      f.variant = P.variant || undefined;
      f.also = P.els.length > 1 ? P.els.slice(1).map(alsoInfo) : undefined;
      if (P.move) defaultNote = `Move this ${posText[P.move.position]} ${P.move.to.label}`;
      else if (P.textEdit) defaultNote = `Change the text to \u201c${P.textEdit.after}\u201d`;
      else if (P.hide) defaultNote = 'Remove this element';
      else if (al.length) defaultNote = `Align to guide ${al[0].guide}`;
      else if (tw.some((t) => !t.snap)) defaultNote = `Use the previewed style values (${tw.filter((t) => !t.snap).map((t) => t.prop).join(', ')})`;
    }
    if (!defaultNote && marks.length) defaultNote = 'See the marks drawn on the page';
    // Inspect the element as the source has it, without our live previews applied.
    const live = Object.values(P.tweaks).map((t) => ({ prop: t.prop, to: t.to }));
    const els = P.els.slice();
    const hid = P.hide;
    const te = P.textEdit;
    const around = (fn) => {
      if (!els.length) return fn();
      for (const el of els) { live.forEach((t) => restoreInline(el, t.prop)); if (hid) restoreInline(el, 'display'); }
      if (te && !els[0].children.length) els[0].textContent = te.before;
      applyAllPreviews(true);
      try { return fn(); } finally {
        applyAllPreviews();
        for (const el of els) { live.forEach((t) => setInline(el, t.prop, t.to)); if (hid) setInline(el, 'display', 'none'); }
        if (te && !els[0].children.length) els[0].textContent = te.after;
      }
    };
    return {
      fields: f, defaultNote, around,
      commit: () => { P.committed = true; },
      onSaved: async (it) => {
        BL.savePrefs();
        applyItemPreview(it, S.prefs.previews !== false);
        if (marksDirty && marks.length) await captureMarked(it, marks);
        updateToolbar();
        renderAnn();
      },
    };
  };

  hooks.onItemDeleted = (it) => { applyItemPreview(it, false); };
  hooks.onClear = () => { applyAllPreviews(true); };

  hooks.focusRegion = (it) => {
    if (it.path !== here()) { BL.openPop(null, it); return; }
    const r = regionRect(it);
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (r.top < 40 || r.top + r.height > innerHeight - 40) window.scrollTo({ top: Math.max(0, r.top + scrollY - innerHeight / 3), behavior: smooth ? 'smooth' : 'auto' });
    setTimeout(() => BL.openPop(null, it), smooth ? 380 : 0);
  };

  // ------------------------------------------------------------------ prompt output

  const ref = (label, selector) => (selector && selector !== label ? `${code(label)} (${code(selector)})` : code(label));

  function whereLines(it) {
    const e = it.el || {};
    const rx = e.react;
    const L = [];
    if (rx?.react) {
      if (rx.rendered) L.push(`- Container rendered at: ${code(rx.rendered)}`);
      if (rx.components?.length) L.push(`- Components: ${rx.components.map((c) => c.name + (c.server ? ' (server)' : '')).join(' › ')}`);
    }
    const route = BL.routeGuess(it);
    if (route) L.push(`- Route file${route.exact ? '' : ' (guess)'}: ${code(route.file)}`);
    if (it.mode === 'shopify') L.push(`- ${BL.sectionLine(e.section, it.page?.pageType)}`);
    if (e.src) L.push(`- Source file (marked in the page): ${code(e.src)}`);
    return L;
  }

  hooks.promptRegion = (it) => {
    if (it.kind === 'page') return ['', '**Where**', `- A general note about the whole page ${code(it.path)}, not one specific element.`, ...whereLines(it)];
    const rg = it.region;
    const c = rg.ctx;
    const L = ['', '**Where** (new, nothing exists here yet)'];
    L.push(`- A ${rg.w}×${rg.h}px region at (${rg.x}, ${rg.y}) on a ${it.viewport.w}×${it.viewport.h} viewport`);
    L.push(`- Inside: ${ref(c.container.label, c.container.selector)} (${c.container.size})`);
    const rel = [];
    if (c.above) rel.push(`below ${code(c.above.label)}`);
    if (c.below) rel.push(`above ${code(c.below.label)}`);
    if (c.left) rel.push(`right of ${code(c.left.label)}`);
    if (c.right) rel.push(`left of ${code(c.right.label)}`);
    if (rel.length) L.push(`- It sits ${rel.join(', ')}`);
    if (c.overlaps?.length) L.push(`- It overlaps: ${c.overlaps.map(code).join(', ')}`);
    L.push(...whereLines(it));
    return L;
  };

  const showsScope = (i) => i.scope && (i.scope.chosen || i.scope.mode !== 'one');

  hooks.promptHeader = (items, batch) => {
    const L = [];
    const key = [];
    if (items.some((i) => i.kind === 'region')) key.push('**Region**: the author marked empty space where something new should go. No element exists there yet. Add it, following the conventions of its neighbours.');
    if (items.some((i) => i.move)) key.push('**Move**: relocate the element to the destination shown. Keep its markup and styles, and adjust any layout that depended on its old spot.');
    if (items.some(showsScope)) key.push('**Scope** says how far a style change reaches: this one only, everything like it inside a container, or everywhere.');
    if (items.some((i) => (i.tweaks && i.tweaks.some((t) => !t.snap)) || i.textEdit)) key.push('**Previewed** values were tried live in the browser and approved by the author. Treat them as the target, using existing tokens, variables, or utility classes instead of hardcoding.');
    if (items.some((i) => i.marks && i.marks.length)) key.push('**Drawn marks** (boxes, arrows, text) show where something belongs. Use the marked-up screenshot together with the text description.');
    if (items.some((i) => i.also && i.also.length)) key.push('**Multiple elements**: when a note lists "also applies to", make the same change to every listed element.');
    if (items.some((i) => i.priority === 'nice')) key.push('**Nice to have** items come last. Skip any that would put the must-fix items at risk.');
    if (items.some((i) => i.figma)) key.push('Some items carry **Figma links**. If a Figma MCP is available, read those frames for exact values before editing.');
    if (key.length) L.push('', '## Annotation key', ...key.map((k) => `- ${k}`));
    const gs = batch?.guides || [];
    if (gs.length) {
      L.push('', '## Guide lines');
      const byPath = new Map();
      gs.forEach((g) => byPath.set(g.path, [...(byPath.get(g.path) || []), g]));
      for (const [path, list] of byPath) L.push(`- On ${code(path)} (viewport ${list[0].vw}px wide): ${list.map((g) => `guide ${g.name} ${g.axis === 'x' ? 'vertical at x' : 'horizontal at y'}=${Math.round(g.pos)}px`).join('; ')}. Items that should line up with a guide say so.`);
    }
    if (batch?.priceReport) L.push('', '## Price check (read-only)', ...priceReportText(batch.priceReport).map((x) => `- ${x.trim()}`), '- Don\u2019t change prices in the store. Report mismatches, and replace any hardcoded prices in page code with Liquid so they follow the store.');
    return L;
  };

  function scopeLines(it) {
    const s = it.scope;
    const ex = s.labels?.length ? ` (e.g. ${s.labels.map(code).join(', ')})` : '';
    if (s.mode === 'one') return [`- Scope: **this one only**.${s.similar > 1 ? ` ${s.similar - 1} similar element${s.similar === 2 ? '' : 's'} (${code(s.selector)}) exist on this page and must stay unchanged.` : ''} Change this instance through its own classes, a variant or prop, or a block/section setting. Don\u2019t edit the shared default.`];
    if (s.mode === 'group') return [`- Scope: **everything like it inside ${code(s.container)}**: ${matches(s.count)} for ${code(s.selector)}${ex}. Change them together at that level (a scoped rule, wrapper class, or prop). Don\u2019t change the same component elsewhere.`];
    return [`- Scope: **everywhere**: ${matches(s.count)} for ${code(s.selector)} on this page${ex}. Change the shared source (component default, shared CSS rule, theme token or settings), then check other pages that use it.`];
  }

  function marksSummary(marks) {
    const n = {};
    marks.forEach((m) => { n[m.t] = (n[m.t] || 0) + 1; });
    const texts = marks.filter((m) => m.t === 'text').map((m) => `\u201c${m.s}\u201d`);
    return `${Object.entries(n).map(([k, v]) => `${v} ${k}${v > 1 ? 's' : ''}`).join(', ')}${texts.length ? ` (text: ${texts.join(', ')})` : ''}`;
  }

  hooks.promptItem = (it) => {
    const L = [];
    const add = (s) => L.push(`- ${s}`);
    if (it.also?.length) {
      add(`Also applies to ${it.also.length} more element${it.also.length === 1 ? '' : 's'}. Make the same change to each:`);
      it.also.forEach((a) => L.push(`  - ${ref(a.label, a.selector)}${a.text ? ` "${a.text}"` : ''} (${a.size})${a.rendered ? `, rendered at ${code(a.rendered)}` : ''}${a.section ? `, in ${code(a.section)}` : ''}`));
    }
    if (showsScope(it)) L.push(...scopeLines(it));
    const prev = (it.tweaks || []).filter((t) => !t.snap);
    if (prev.length) add(`Previewed by the author${it.also?.length ? ' (on all selected elements)' : ''}: ${prev.map((t) => `${t.prop} ${t.from} → ${t.to}${t.token ? ` (≈ ${t.token})` : ''}`).join('; ')}`);
    if (it.textEdit) add(`Copy change: “${it.textEdit.before}” → “${it.textEdit.after}”`);
    if (it.hidden) add('The author hid this element to preview the layout without it. Remove it (or hide it, per the note) and let the layout close up.');
    if (it.match) add(`Make it look like ${ref(it.match.label, it.match.selector)}${it.match.src ? ` (rendered at ${code(it.match.src)})` : ''}. Differences, this → target: ${it.match.diffs.map((d) => `${d.prop} ${d.from} → ${d.to}`).join('; ')}`);
    if (it.move) add(`Move this element **${posText[it.move.position]}** ${ref(it.move.to.label, it.move.to.selector)}${it.move.to.src ? ` (target rendered at ${code(it.move.to.src)})` : ''}. Keep its markup and styles; adjust any layout that depended on its old spot.`);
    for (const a of it.align || []) {
      const dir = a.axis === 'x' ? (a.offset >= 0 ? 'right of' : 'left of') : a.offset >= 0 ? 'below' : 'above';
      add(`Align its ${a.edge}${a.edge === 'center' || a.edge === 'middle' ? '' : ' edge'} to guide ${a.guide} (${a.axis === 'x' ? 'vertical at x' : 'horizontal at y'}=${a.guidePos}px). ${a.offset === 0 ? 'It is already on the guide; keep it there.' : `It is currently ${Math.abs(a.offset)}px ${dir} the guide. The author previewed the snap with a ${a.shift}px translate; implement it with real layout (alignment, margin, grid or flex), not a transform.`}`);
    }
    for (const m of it.measures || []) add(`Measured to ${ref(m.label, m.selector)}: ${m.summary}`);
    if (it.colors?.length) add(`Sampled colors: ${it.colors.map(code).join(', ')}`);
    if (it.auto) add('Selected by circling an area on the page, so the target was matched automatically. Confirm it against the marked-up screenshot.');
    if (it.marks?.length) add(`Drawn on the page: ${marksSummary(it.marks)}. See the marked-up screenshot.`);
    if (it.figma) add(`Figma: ${it.figma}`);
    if (it.variant) {
      const v = it.variant;
      add(`Wire to Shopify variant: product ${code(v.handle)}, variant id ${code(v.variantId)} (“${v.title}”${v.sku ? `, SKU ${v.sku}` : ''}, live price $${v.price.toFixed(2)}, ${v.available ? 'in stock' : 'sold out'}). Reference the product or variant by handle or id and render the price with Liquid money filters. Don\u2019t copy the price into the page, and don\u2019t write to the store.`);
    }
    return L.length ? ['', '**Author\u2019s annotations**', ...L] : [];
  };

  // ------------------------------------------------------------------ exports for tests

  BL.toolsApi = {
    similarSelector, similar, groupOptions, scopeInfo, tokenHint, spacingClasses, regionContext, measureRects, measureText, parseCSV, sheetFromRows, checkPrices,
    normForVar, stepVal, normInput, priceReportText, scopeLines, marksSummary, snapTo, autoSelect, startSelect, startCircle, T, A, D, getP: () => P, setP: (p) => { P = p; }, setAnnotate, setTarget, makeDraggable,
  };

  if (S.ui) hooks.onMount(S.ui.root);
})();
