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

  const T = { pick: null, speech: null, gdrag: null, simEls: null, hot: null, eatClick: false, shiftSel: null, shiftHeld: false };
  const A = { on: false, mode: 'select', keep: false, drag: null };
  const D = { tool: null, color: GUIDE, cur: null, selected: null, drag: null };
  const emptyPop = () => ({
    bps: new Set(), scope: 'one', groupIdx: 0, scopeTouched: false, tweaks: {}, textEdit: null, hide: false,
    figma: '', variant: null, match: null, move: null, align: {}, alignInfo: {}, snap: { x: 0, y: 0 }, measures: [], colors: [],
    marks: [], marksDirty: false, edits: new Map(), els: [], el: null, item: null, committed: false, auto: false,
    parked: new Map(), cleared: false, missing: [], missingEdited: false, alignEl: null, alignUi: { mode: 'guides', method: 'edges', memo: {}, ref: null, h: '', v: '' },
    cssRule: null, cssAdded: [],
  });
  let P = emptyPop();
  const touched = new WeakMap(); // el -> { prop: { v, p } } inline styles we overwrote for previews
  const pageStyle = new WeakMap(); // el -> its style attribute before our first preview
  let mountedRoot = null;
  let attached = false;
  let varIdx = null;
  let editing = null;
  let varT = 0;
  let ovSaveT = 0;
  const OV = { host: null, img: null, state: { dataUrl: null, opacity: 50, width: 0, x: 0, y: 0, diff: false, visible: true } };
  let sheet = null;
  let activeTool = null;
  let visibleMeasureIndex = null;

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
  const hasPreview = (it) => !!(it.elementEdits?.some(hasPreview) || (it.tweaks && it.tweaks.length) || it.textEdit || it.hidden);
  const appliesHere = (it) => !it.bps || !it.bps.length || it.bps.includes(bpNow());
  const isRegionPop = () => !!(S.pop && (S.pop.region || S.pop.item?.kind === 'region'));
  const setOn = (x, on) => { const b = q(`[data-x="${x}"]`); if (b) b.classList.toggle('on', !!on); };
  const textOf = (e, n = 24) => clip((e.innerText ?? e.textContent ?? '').replace(/\s+/g, ' ').trim(), n);
  const pickable = (e) => (e.target instanceof Element && e.target !== document.documentElement && e.target !== document.body && !mine(e.target) ? pointTarget(e.clientX, e.clientY) || e.target : null);

  // Keep the existing tool functions focused on one active element. Records are
  // keyed by DOM instance while composing, and by the existing selector on disk.
  // cssRule (the rule chosen in Edit CSS) and cssAdded (added property rows without a value yet) are per instance, not saved.
  const EDIT_KEYS = ['tweaks', 'textEdit', 'hide', 'match', 'move', 'align', 'alignInfo', 'snap', 'alignEl', 'measures', 'scope', 'scopeTouched', 'groupIdx', 'cssRule', 'cssAdded'];
  function rememberElement() {
    if (!P.el) return;
    const record = {};
    for (const key of EDIT_KEYS) record[key] = P[key];
    P.edits.set(P.el, record);
  }
  function visitElement(el, fn) {
    rememberElement();
    const previous = P.el;
    const record = P.edits.get(el) || emptyPop();
    P.el = el;
    for (const key of EDIT_KEYS) P[key] = record[key];
    try { return fn(); } finally {
      rememberElement();
      P.el = previous;
      const old = P.edits.get(previous) || emptyPop();
      for (const key of EDIT_KEYS) P[key] = old[key];
    }
  }
  function chooseElement(index) {
    const el = P.els[index];
    if (!el || el === P.el) return;
    if (editing) finishEdit(true);
    if (T.pick) endPick(null);
    rememberElement();
    P.el = el;
    const record = P.edits.get(el) || emptyPop();
    for (const key of EDIT_KEYS) P[key] = record[key];
    visibleMeasureIndex = P.measures.length ? P.measures.length - 1 : null;
    activeTool = Object.keys(P.align).length ? 'align' : P.measures.length || P.move || P.match || P.textEdit || P.hide ? null : activeTool;
    loadCompose();
  }
  function elementFields() {
    rememberElement();
    return P.els.map((el) => visitElement(el, () => (missingRuleEntries(cssModel(el)), {
      el: alsoInfo(el), scope: scopeInfo(), tweaks: Object.values(P.tweaks).map(savedTweak),
      textEdit: P.textEdit, hidden: P.hide, match: P.match,
      move: P.move ? { to: P.move.to, position: P.move.position } : null,
      align: alignFields(), alignEl: P.alignEl?.x || P.alignEl?.y ? JSON.parse(JSON.stringify(P.alignEl)) : null,
      measures: P.measures.map(({ label, selector, summary }) => ({ label, selector, summary })),
    })));
  }
  // A change as saved. A rule that isn't on the page now is kept as it was, flagged notFound (the export says so).
  function savedTweak(t) {
    const out = { ...t, rule: t.rule ? { ...t.rule } : undefined };
    if (!out.rule) { delete out.rule; return out; }
    if (out.rule.key === 'element' || !P.el) return out;
    if (cssModel(P.el).byKey.has(out.rule.key)) delete out.rule.notFound; else out.rule.notFound = true;
    return out;
  }
  function restoreElementRecord(el, data) {
    const record = emptyPop();
    (data.tweaks || []).forEach((t) => { record.tweaks[t.prop] = { ...t }; });
    record.textEdit = data.textEdit ? { ...data.textEdit } : null;
    record.hide = !!data.hidden;
    record.match = data.match || null;
    record.move = data.move ? { ...data.move, toEl: BL.query(data.move.to.selector) } : null;
    record.measures = (data.measures || []).map((m) => ({ ...m }));
    record.scope = data.scope?.mode || 'one';
    record.scopeTouched = !!data.scope?.chosen;
    record.groupIdx = Math.max(0, groupOptions(el).findIndex((o) => o.label === data.scope?.container));
    for (const a of data.align || []) {
      const g = guidesHere().find((x) => x.id === a.guideId || x.name === a.guide);
      if (g) { record.align[g.id] = a.edge; record.alignInfo[g.id] = { offset: a.offset, shift: a.shift || 0, axis: a.axis }; record.snap[a.axis] = a.shift || 0; }
    }
    record.alignEl = data.alignEl ? JSON.parse(JSON.stringify(data.alignEl)) : null;
    for (const axis of ['x', 'y']) if (record.alignEl?.[axis]) record.snap[axis] = record.alignEl[axis].shift || 0;
    P.edits.set(el, record);
  }
  // Saved instances of a note whose element isn't on the page right now. They are kept exactly as saved and
  // written back on Update; only removing them on purpose deletes them. The first record is the note's own
  // element (item.el); older notes are turned into records the same way they are restored.
  function missingRecords(item, used) {
    const copy = (x) => JSON.parse(JSON.stringify(x));
    if (item.elementEdits) return item.elementEdits.map((rec, i) => ({ rec: copy(rec), primary: i === 0 })).filter((m, i) => !used.has(item.elementEdits[i]));
    const scope = item.scope || { mode: 'one', count: 1, selector: item.el?.selector, similar: 1, chosen: false };
    const base = { scope, tweaks: item.tweaks || [], hidden: !!item.hidden, textEdit: null, match: null, move: null, align: [], measures: [] };
    const out = [];
    const { label, selector, text, size } = item.el || {};
    if (selector && !BL.query(selector)) out.push({ primary: true, rec: copy({ ...base, el: { label, selector, text, size }, textEdit: item.textEdit || null, match: item.match || null, move: item.move || null, align: item.align || [], measures: item.measures || [] }) });
    for (const a of item.also || []) if (!BL.query(a.selector)) out.push({ primary: false, rec: copy({ ...base, el: a }) });
    return out;
  }

  // Plain-language element type for the Selected element card.
  const KIND = {
    A: 'Link', BUTTON: 'Button', IMG: 'Image', SVG: 'Graphic', PICTURE: 'Picture', VIDEO: 'Video', P: 'Paragraph', SPAN: 'Text', LI: 'List item',
    UL: 'List', OL: 'List', LABEL: 'Label', INPUT: 'Input', SELECT: 'Dropdown', TEXTAREA: 'Text box', FORM: 'Form', NAV: 'Navigation',
    HEADER: 'Header', FOOTER: 'Footer', MAIN: 'Main content', SECTION: 'Section', ARTICLE: 'Article', ASIDE: 'Sidebar', FIGURE: 'Figure',
    TABLE: 'Table', TD: 'Table cell', TH: 'Table heading', BLOCKQUOTE: 'Quote', DIV: 'Container',
  };
  function elKind(el) {
    const tag = el.tagName.toUpperCase();
    if (/^H[1-6]$/.test(tag)) return `Heading ${tag[1]}`;
    const role = el.getAttribute('role');
    if (role === 'button' || role === 'link') return role === 'button' ? 'Button' : 'Link';
    return KIND[tag] || el.tagName.toLowerCase();
  }
  const elText = (el) => clip((el.getAttribute('aria-label') || el.getAttribute('alt') || textOf(el, 60) || el.getAttribute('placeholder') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim(), 48);
  function editSummary(r) {
    return [Object.keys(r.tweaks).filter((k) => !r.tweaks[k].snap).length ? `${Object.keys(r.tweaks).filter((k) => !r.tweaks[k].snap).length} CSS values` : '', r.hide ? 'hidden' : '', r.textEdit ? 'text' : '', r.move ? 'move' : '', r.match ? 'match style' : '', Object.keys(r.align).length || r.alignEl?.x || r.alignEl?.y ? 'alignment' : '', r.measures.length ? 'measurements' : ''].filter(Boolean);
  }

  // Step 2: which element the tools act on. With several selected, one instance is edited at a time and
  // every CSS value stays with the instance it was made on.
  function renderElementEditor() {
    let box = q('.element-editor');
    if (!box) { box = mk('<div class="element-editor"></div>'); q('.tool-ribbon').before(box); }
    rememberElement();
    box.hidden = !P.el || isRegionPop();
    if (box.hidden) { box.innerHTML = ''; renderChanges(); return; }
    const multi = P.els.length > 1;
    const idx = P.els.indexOf(P.el);
    const text = elText(P.el);
    const lbl = BL.label(P.el);
    // Classes the label leaves out (it prefers an id, and shows at most two classes).
    const extra = [...P.el.classList].filter((c) => BL.isStableClass(c) && !lbl.split(/(?=[.#[])/).includes(`.${c}`));
    box.innerHTML = `<div class="se-h"><span class="tb-h">Selected element</span>${multi ? `<span class="se-of">Editing ${idx + 1} of ${P.els.length}</span>` : ''}</div>
      <div class="se-name"><b>${esc(elKind(P.el))}</b>${text ? ` <span>“${esc(text)}”</span>` : ''}</div>
      <code class="se-sel" title="${esc(BL.cssPath(P.el))}">${esc(lbl)}</code>${extra.length ? `<span class="sub se-cls mono" title="Classes on this element">class ${esc(extra.map((c) => '.' + c).join(' '))}</span>` : ''}
      ${multi ? `<label class="sub se-pick" title="Edits apply to the element you choose here only">Change element <select class="xin element-choice" aria-label="Element to edit">${P.els.map((el, i) => `<option value="${i}"${el === P.el ? ' selected' : ''}>${i + 1}: ${esc(BL.label(el))} · ${esc(textOf(el, 24))}</option>`).join('')}</select></label>` : ''}`;
    renderChanges();
  }

  // What has been changed on the instance being edited: CSS values (original → updated), hide, alignment,
  // and the move / match / text strips. A presentation of the edit record, not a separate store.
  const showVal = (prop, v) => {
    if (/color/.test(prop)) { const c = BL.rgba(String(v)); if (c && c.a >= 1) return BL.hex(c).toUpperCase(); }
    return String(v);
  };
  // The Describe placeholder says whether anything has been recorded yet (a change or a reference measurement from
  // the Toolbox, Edit CSS, Align, Annotate or Measure). It follows adds, ✕, Undo and element changes, and never
  // touches what has been typed. Saving still requires a description when nothing is recorded.
  const PH_NONE = 'No changes detected. Describe what you\u2019d like changed.';
  const PH_SOME = 'Optional: Add any additional details about your changes.';
  function hasRecordedChanges() {
    rememberElement();
    const edit = (r) => (r.tweaks ? Object.values(r.tweaks) : []).length || r.textEdit || r.hide || r.hidden || r.match || r.move || Object.keys(r.align || {}).length || r.alignEl?.x || r.alignEl?.y || (r.measures || []).length;
    return !!(P.marks.some((m) => !m.auto) || P.colors.length || P.variant || [...P.edits.values()].some(edit) || P.missing.some((m) => (m.rec.tweaks || []).length || m.rec.textEdit || m.rec.hidden || m.rec.match || m.rec.move || (m.rec.align || []).length || m.rec.alignEl?.x || m.rec.alignEl?.y || (m.rec.measures || []).length));
  }
  function syncPlaceholder() {
    const ta = q('.pop-note');
    if (!ta || !S.pop) return;
    const want = hasRecordedChanges() ? PH_SOME : PH_NONE;
    if (ta.placeholder !== want) ta.placeholder = want;
  }

  function renderChanges() {
    syncPlaceholder();
    const box = q('.tb-changes');
    if (!box) return;
    const css = q('.css-changes');
    const has = !!P.el && !isRegionPop();
    const rows = [];
    if (has) {
      for (const t of Object.values(P.tweaks).filter((x) => !x.snap)) {
        const where = t.rule ? (t.rule.key === 'element' ? 'this element' : t.rule.matched || t.rule.selector) : '';
        const was = t.declared === false ? 'added' : showVal(t.prop, t.from);
        rows.push(`<div class="chg" data-prop="${esc(t.prop)}"${where ? ` data-rule="${esc(where)}"` : ''}><span><code>${esc(t.prop)}</code>: <span class="chg-from">${esc(was)}</span> → <b class="chg-to">${esc(showVal(t.prop, t.to))}</b>${t.token ? ` <span class="sub">≈ ${esc(t.token.replace(/`/g, ''))}</span>` : ''}</span>${where ? `<em class="chg-rule" title="${esc(t.rule.key === 'element' ? 'Set on this element only' : `In ${t.rule.selector || where} (${t.rule.source || ''}${t.rule.context ? `, ${t.rule.context}` : ''})`)}">${esc(where)}</em>` : ''}<button class="icon" data-x="css-rm" data-prop="${esc(t.prop)}" title="${t.declared === false ? `Remove ${esc(t.prop)}` : `Put ${esc(t.prop)} back to ${esc(t.from)}`}" aria-label="Undo ${esc(t.prop)} change">✕</button></div>`);
      }
      if (P.hide) rows.push('<div class="chg"><span>Hidden (preview)</span><button class="icon" data-x="hide" title="Show it again" aria-label="Show the element again">✕</button></div>');
      for (const a of alignFields()) rows.push(`<div class="chg"><span>Aligned ${esc(a.edge)} to guide ${esc(a.guide)} (${rnd(a.shift)}px)</span><button class="icon" data-x="align-clear" data-g="${esc(a.guideId)}" title="Undo this alignment" aria-label="Undo alignment">✕</button></div>`);
      for (const axis of ['x', 'y']) {
        const a = P.alignEl?.[axis];
        if (a) rows.push(`<div class="chg"><span>${esc(alignWord(a))} <code>${esc(a.ref.label)}</code> (${rnd(a.shift)}px)</span><button class="icon" data-x="alel-rm" data-axis="${axis}" title="Remove this alignment (from every element aligned with it)" aria-label="Remove alignment">✕</button></div>`);
      }
    }
    css.innerHTML = rows.join('');
    const strips = q('.x-strips');
    const any = rows.length || !!strips?.children.length;
    q('.tb-changes-n').textContent = any ? '' : has ? 'No changes yet. Use the Toolbox, Edit CSS or Align.' : '';
    box.hidden = !has && !strips?.children.length;
  }

  // ------------------------------------------------------------------ inline previews (all targets of a note)

  function setInline(el, prop, value) {
    let rec = touched.get(el);
    if (!rec) { rec = {}; touched.set(el, rec); }
    // The page's own style attribute as it was before this round of previews (taken while nothing is previewed).
    if (!Object.keys(rec).length) pageStyle.set(el, el.getAttribute('style') || '');
    if (!(prop in rec)) {
      // With a related shorthand or longhand already previewed (margin / margin-top), the element's style now holds
      // our value for this property too, so its original comes from the page's own attribute instead.
      const related = Object.keys(rec).some((k) => k.startsWith(`${prop}-`) || prop.startsWith(`${k}-`));
      const src = related ? pageDecl(el) : el.style;
      rec[prop] = { v: src.getPropertyValue(prop), p: src.getPropertyPriority(prop) };
    }
    el.style.setProperty(prop, value, 'important');
  }
  const pageDecl = (el) => { const s = document.createElement('div').style; s.cssText = pageStyle.get(el) || ''; return s; };

  function restoreInline(el, prop) {
    const rec = touched.get(el);
    if (!rec || !(prop in rec)) return;
    const { v, p } = rec[prop];
    if (v) el.style.setProperty(prop, v, p); else el.style.removeProperty(prop);
    delete rec[prop];
    // Removing a shorthand also removed the page's own longhands of it (its margin-top under margin): put those back,
    // unless a preview of that longhand is still recorded (it is restored on its own).
    const page = pageDecl(el);
    for (let i = 0; i < page.length; i++) {
      const k = page[i];
      if (k.startsWith(`${prop}-`) && !(k in rec) && !el.style.getPropertyValue(k)) el.style.setProperty(k, page.getPropertyValue(k), page.getPropertyPriority(k));
    }
    if (!(el.getAttribute('style') || '').trim()) el.removeAttribute('style');
  }

  // The page's own style attribute, without our previews: as written before we first touched the element, with the
  // properties we overwrote put back from what we recorded.
  function pageInline(el) {
    const rec = touched.get(el);
    if (!rec || !Object.keys(rec).length) return el.getAttribute('style') || '';
    if (pageStyle.has(el)) return pageStyle.get(el);
    const probe = document.createElement('div').style;
    probe.cssText = el.style.cssText;
    for (const [prop, { v, p }] of Object.entries(rec)) { probe.removeProperty(prop); if (v) probe.setProperty(prop, v, p); }
    return probe.cssText;
  }

  // Previews in a stable order: a shorthand before its longhands (margin before margin-top), so a longhand edit
  // is never overwritten by its shorthand.
  const cssOrder = (list) => [...list].sort((a, b) => a.prop.split('-').length - b.prop.split('-').length);

  // Applies one instance's CSS previews and then Hide, which always wins over a display value (the two stay
  // independent: showing the element again brings the display edit back).
  function paintCss(el, r) {
    if (!el || !r) return;
    for (const t of cssOrder(Object.values(r.tweaks || {}))) setInline(el, t.prop, t.to);
    if (r.hide) setInline(el, 'display', 'none');
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
    if (it.elementEdits) { for (const edit of it.elementEdits) applyItemPreview({ ...edit, path: it.path, bps: it.bps }, on); return; }
    const live = on && appliesHere(it);
    const els = targetsOf(it);
    for (const el of els) {
      for (const t of cssOrder(it.tweaks || [])) { if (live) setInline(el, t.prop, t.to); else restoreInline(el, t.prop); }
      if (it.hidden) { if (live) setInline(el, 'display', 'none'); else restoreInline(el, 'display'); }
    }
    // A text change belongs to the note's own element only, never to whichever element is found first.
    const own = it.el?.selector ? BL.query(it.el.selector) : null;
    if (it.textEdit && own && !own.children.length) {
      const want = live ? it.textEdit.after : it.textEdit.before;
      if (own.textContent.trim() !== want) own.textContent = want;
    }
  }

  // Saved notes' previews are refreshed regularly. The note being edited is left out (its saved values are out of
  // date while it is open), and its live CSS, hide and alignment previews are put back on top, so another note on
  // the same element can't overwrite what is being edited.
  function applyAllPreviews(forceOff) {
    const on = !forceOff && S.prefs.previews !== false;
    const open = S.pop ? P.item?.id : null;
    for (const it of S.batch?.items || []) if (hasPreview(it) && (forceOff || it.id !== open)) applyItemPreview(it, on);
    if (!S.pop || forceOff) return;
    rememberElement();
    for (const [el, r] of P.edits) paintCss(el, r);
  }

  function revertLive() {
    rememberElement();
    for (const [el, record] of P.edits) {
      for (const prop of Object.keys(record.tweaks)) restoreInline(el, prop);
      if (record.hide) restoreInline(el, 'display');
      if (record.textEdit && !el.children.length) el.textContent = record.textEdit.before;
    }
  }

  // ------------------------------------------------------------------ undo (annotation changes in the open note)
  // Each completed action pushes a snapshot of the note's annotation state taken just before it.
  // Selection, scope, and saved notes are left alone; only annotations roll back.

  const UNDO_MAX = 50;
  let undoStack = [];
  let undoKey = null;
  let undoT = 0;

  function cloneRecord(r) {
    return {
      ...r,
      tweaks: JSON.parse(JSON.stringify(r.tweaks || {})), align: { ...r.align }, alignInfo: JSON.parse(JSON.stringify(r.alignInfo || {})), snap: { ...r.snap },
      measures: (r.measures || []).map((m) => ({ ...m })), textEdit: r.textEdit ? { ...r.textEdit } : null, move: r.move ? { ...r.move } : null,
      alignEl: r.alignEl ? JSON.parse(JSON.stringify(r.alignEl)) : null,
    };
  }

  function snapshot() {
    rememberElement();
    return {
      marks: P.marks.map((m) => JSON.parse(JSON.stringify(m))), colors: [...P.colors],
      edits: new Map([...P.edits].map(([el, r]) => [el, cloneRecord(r)])), visibleMeasureIndex,
    };
  }

  // key coalesces bursts of the same edit (typing a CSS value, repeated nudges) into one step.
  function record(key = null) {
    if (!S.pop) return;
    const now = Date.now();
    if (key && key === undoKey && now - undoT < 1500) { undoT = now; return; }
    undoKey = key;
    undoT = now;
    undoStack.push(snapshot());
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    syncUndo();
  }
  // Shift-click and Shift-drag change the selection itself, so their undo step restores it too.
  function recordSelection() {
    if (!S.pop) return;
    const s = snapshot();
    s.sel = { els: [...P.els], region: S.pop.region || null, page: !!S.pop.page, auto: P.auto, missing: P.missing.slice(), cleared: P.cleared };
    pushSnapshot(s);
  }
  function pushSnapshot(s) { undoKey = null; undoStack.push(s); if (undoStack.length > UNDO_MAX) undoStack.shift(); syncUndo(); }
  function clearUndo() { undoStack = []; undoKey = null; syncUndo(); }

  // Saved notes keep their history for this page session, so Undo still works after Save.
  const histories = new Map(); // item id -> snapshot stack
  let historyOrder = []; // item ids, most recently saved last
  let pendingUndo = null;
  function rememberHistory(id, stack) {
    historyOrder = historyOrder.filter((x) => x !== id);
    if (stack.length) { histories.set(id, stack); historyOrder.push(id); } else histories.delete(id);
  }
  function forgetHistory(id) { histories.delete(id); historyOrder = historyOrder.filter((x) => x !== id); }
  function lastUndoable() {
    for (let i = historyOrder.length - 1; i >= 0; i--) {
      const it = BL.findItem(historyOrder[i]);
      if (it && it.path === here() && histories.get(it.id)?.length) return it;
    }
    return null;
  }

  function syncUndo() {
    const b = q('[data-x="undo"]');
    if (!b) return;
    const saved = S.pop ? null : lastUndoable();
    b.disabled = S.pop ? !undoStack.length : !saved;
    b.title = b.disabled ? `Nothing to undo (${UNDO_KEY})`
      : saved ? `Undo the last change in note ${S.batch.items.indexOf(saved) + 1}. It reopens so you can update or cancel (${UNDO_KEY})`
        : `Undo the last annotation change (${UNDO_KEY})`;
  }

  // Undo in the open note, or reopen the most recently saved note and undo there.
  function undoAction() {
    if (S.pop) return undo();
    const it = lastUndoable();
    if (!it) return false;
    pendingUndo = it.id;
    hooksFocus(it);
    return true;
  }

  function applyRecord(el, r) {
    paintCss(el, r);
    if (r.textEdit && !el.children.length) el.textContent = r.textEdit.after;
  }

  function undo(msg = 'Undone') {
    if (!S.pop || !undoStack.length) return false;
    if (editing) finishEdit(false);
    if (T.pick) endPick(null);
    D.cur = null; D.drag = null; D.selected = null;
    const s = undoStack.pop();
    undoKey = null;
    if (s.sel) {
      const tool = activeTool;
      if (s.sel.region) setTarget({ region: s.sel.region, auto: s.sel.auto });
      else { setTarget({ els: s.sel.els, auto: s.sel.auto }); if (!s.sel.els.length) { S.pop.page = true; renderSel(); } }
      activeTool = tool;
      if (s.sel.missing) { P.missing = s.sel.missing.slice(); P.cleared = !!s.sel.cleared; }
    }
    revertLive();
    const keep = new Map([...P.edits].map(([el, r]) => [el, { scope: r.scope, scopeTouched: r.scopeTouched, groupIdx: r.groupIdx }]));
    // Area-selection outlines follow the current selection, not the undo history.
    P.marks = s.sel ? s.marks : [...s.marks.filter((m) => !m.auto), ...P.marks.filter((m) => m.auto)];
    P.colors = s.colors;
    P.marksDirty = true;
    P.edits = new Map(P.els.map((el) => [el, { ...(s.edits.get(el) || emptyPop()), ...(keep.get(el) || {}) }]));
    for (const [el, r] of P.edits) applyRecord(el, r);
    const cur = P.edits.get(P.el) || emptyPop();
    for (const key of EDIT_KEYS) P[key] = cur[key];
    visibleMeasureIndex = P.measures.length ? Math.min(s.visibleMeasureIndex ?? P.measures.length - 1, P.measures.length - 1) : null;
    syncAlignUi();
    loadCompose();
    syncUndo();
    toast(msg);
    return true;
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

  // `ruleSel` (the CSS rule the changes were made in) replaces the guessed similar-element selector when given.
  function similar(el, mode, groupIdx = 0, ruleSel = null) {
    if (mode === 'one') return { sel: BL.cssPath(el), els: [el], root: null };
    const sel = ruleSel || similarSelector(el);
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

  // The rule the instance's CSS changes were made in (the one with most changes, the latest on a tie). It sets the
  // scope's selector only when reliable: on the page now, not under an unchecked condition, not a utility class.
  function scopeRule() {
    const by = new Map();
    for (const t of Object.values(P.tweaks)) if (!t.snap && t.rule && t.rule.key !== 'element') by.set(t.rule.key, { rule: t.rule, n: (by.get(t.rule.key)?.n || 0) + 1 });
    let best = null;
    for (const v of by.values()) if (!best || v.n >= best.n) best = v;
    if (!best || !P.el) return null;
    const live = cssModel(P.el).byKey.get(best.rule.key);
    return { rule: best.rule, reliable: !!live && !live.uncertain && !live.utility };
  }

  // Scope stays per instance. The preview is always this element only; the scope records how far the real
  // change should reach, and with a reliable rule it names that rule's selector instead of a guessed one.
  function scopeInfo() {
    const el = P.el;
    const sr = scopeRule();
    const ruleSel = sr?.reliable ? sr.rule.matched || sr.rule.selector : null;
    const all = similar(el, 'all', 0, ruleSel);
    const cur = P.scope === 'all' ? all : P.scope === 'group' ? similar(el, 'group', P.groupIdx, ruleSel) : { sel: all.sel, els: [el], root: null };
    const out = {
      mode: P.scope,
      count: P.scope === 'one' ? 1 : cur.els.length,
      selector: cur.sel,
      container: cur.root ? BL.label(cur.root) : null,
      labels: cur.els.filter((e) => e !== el).slice(0, 3).map((e) => { const t = textOf(e); return BL.label(e) + (t ? ` "${t}"` : ''); }),
      similar: all.els.length,
      chosen: P.scopeTouched || P.scope !== 'one',
      basis: ruleSel ? 'rule' : 'similar',
      preview: 'element',
    };
    if (sr) out.rule = { selector: sr.rule.matched || sr.rule.selector, source: sr.rule.source, context: sr.rule.context, reliable: sr.reliable };
    if (!out.rule) delete out.rule;
    return out;
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
    const box = (r, c) => add('rect', { x: r.left, y: r.top, width: r.width ?? r.right - r.left, height: r.height ?? r.bottom - r.top, fill: 'none', stroke: c, 'stroke-width': 1, 'stroke-dasharray': '3 5', opacity: .7 });
    box(ra, INK);
    box(rb, WARM);
    const m = measureRects(ra, rb);
    const label = (x, y, t) => {
      const pad = 65;
      const safeX = Math.max(Math.min(x, innerWidth - pad), Math.min(pad, innerWidth / 2));
      const safeY = Math.max(18, Math.min(y, innerHeight - 16));
      return add('text', { x: safeX, y: safeY, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 600, fill: GUIDE, stroke: '#fff', 'stroke-width': 3, 'paint-order': 'stroke', 'font-family': 'ui-monospace, Menlo, monospace' }, t);
    };
    if (m.gapX > 0) {
      const x1 = m.relX === 'right' ? ra.right : ra.left;
      const x2 = m.relX === 'right' ? rb.left : rb.right;
      const o0 = Math.max(ra.top, rb.top);
      const o1 = Math.min(ra.bottom, rb.bottom);
      const y = o1 > o0 ? (o0 + o1) / 2 : m.relY === 'below' ? (ra.bottom + rb.top) / 2 : (rb.bottom + ra.top) / 2;
      add('line', { x1, y1: y, x2, y2: y, stroke: GUIDE, 'stroke-width': 1.2, 'stroke-dasharray': '3 4' });
      add('line', { x1, y1: y - 5, x2: x1, y2: y + 5, stroke: GUIDE }); add('line', { x1: x2, y1: y - 5, x2, y2: y + 5, stroke: GUIDE });
      label((x1 + x2) / 2, y - 6, `${m.gapX}px`);
    }
    if (m.gapY > 0) {
      const y1 = m.relY === 'below' ? ra.bottom : ra.top;
      const y2 = m.relY === 'below' ? rb.top : rb.bottom;
      const o0 = Math.max(ra.left, rb.left);
      const o1 = Math.min(ra.right, rb.right);
      const x = o1 > o0 ? (o0 + o1) / 2 : m.relX === 'right' ? (ra.right + rb.left) / 2 : (rb.right + ra.left) / 2;
      add('line', { x1: x, y1, x2: x, y2, stroke: GUIDE, 'stroke-width': 1.2, 'stroke-dasharray': '3 4' });
      add('line', { x1: x - 5, y1, x2: x + 5, y2: y1, stroke: GUIDE }); add('line', { x1: x - 5, y1: y2, x2: x + 5, y2, stroke: GUIDE });
      label(x + 14, (y1 + y2) / 2 + 4, `${m.gapY}px`);
    }
    // Intersecting or nested elements have no edge-to-edge gap.
    // Show their center offset instead of incorrectly calling it a gap.
    if (m.gapX === 0 && m.gapY === 0) {
      const x1 = ra.left + (ra.width ?? ra.right - ra.left) / 2;
      const y1 = ra.top + (ra.height ?? ra.bottom - ra.top) / 2;
      const x2 = rb.left + (rb.width ?? rb.right - rb.left) / 2;
      const y2 = rb.top + (rb.height ?? rb.bottom - rb.top) / 2;
      add('line', { x1, y1, x2, y2, stroke: GUIDE, 'stroke-width': 1.2, 'stroke-dasharray': '3 4' });
      label((x1 + x2) / 2, (y1 + y2) / 2 - 9, `center offset ${Math.round(Math.hypot(x2 - x1, y2 - y1))}px`);
    }
    return m;
  }

  const clearMeas = () => { const g = q('.x-meas'); if (g) g.textContent = ''; };

  function showNoteMeasurement() {
    // Selection hover owns this SVG until the second target is confirmed.
    if (T.pick) return;
    const g = q('.x-meas');
    if (!g) return;
    if (!S.pop || !P.measures.length) { g.textContent = ''; return; }
    const source = P.el?.isConnected ? P.el : (P.item?.el?.selector ? BL.query(P.item.el.selector) : null);
    const latest = P.measures[visibleMeasureIndex ?? (P.measures.length - 1)] || P.measures[P.measures.length - 1];
    const target = latest?.selector ? BL.query(latest.selector) : null;
    if (!source || !target || source === target) { g.textContent = ''; return; }
    drawMeasure(source.getBoundingClientRect(), target.getBoundingClientRect());
  }

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

    .panel { width: 340px; max-height: min(80vh, 680px, calc(100vh - var(--bl-bottom, 16px) - 8px)); }
    .panel.composing { max-height: min(86vh, 740px, calc(100vh - var(--bl-bottom, 16px) - 8px)); }
    /* While a note is open the panel keeps one height, so switching tools never resizes or moves it. */
    .panel.composing:not(.collapsed) { height: min(86vh, 740px, calc(100vh - var(--bl-bottom, 16px) - 8px)); }
    .pop-spacer { flex: none; height: 0; }
    .panel.composing .body, .panel.composing .foot { display: none; }
    .panel.collapsed .pop { display: none !important; }
    .bar { cursor: grab; user-select: none; }
    .bar:active { cursor: grabbing; }
    .bar .tools button, .bar .brand { cursor: pointer; }
    .bar .icon svg { display: block; margin: auto; }
    .mk-toggle { color: #A0A6B6; }
    .mk-toggle[aria-pressed="true"] { color: #1A33C7; }
    .hd-undo:disabled { opacity: .35; cursor: default; background: none; }
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
    .tool-ribbon { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; margin-top: 3px; }
    .tool-main { min-width: 0; display: flex; flex-direction: column; gap: 3px; align-items: center; justify-content: center; min-height: 55px; padding: 5px 2px; border: 1px solid #D9DCE4; border-radius: 8px; background: #fff; font-size: 11px; font-weight: 600; }
    .tool-main:hover, .tool-action:hover { border-color: #8798F2; background: #F5F7FF; }
    .tool-main[aria-pressed="true"] { color: #1A33C7; background: #EEF1FF; border-color: #2B4EFF; box-shadow: inset 0 0 0 1px #2B4EFF; }
    .tool-main:disabled { opacity: .4; cursor: not-allowed; }
    .tool-action.on { color: #1A33C7; background: #EEF1FF; border-color: #2B4EFF; }
    .tool-main svg { flex: none; }
    .tool-panel { margin-top: 6px; border: 1px solid #E2E5EC; background: #FCFCFF; border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
    .tool-panel .sub { font-size: 11px; }
    .tool-draw-actions { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px; }
    .tool-draw-actions button { min-width: 0; font-size: 10px; padding: 6px 0; white-space: nowrap; }
    .tool-draw-actions .on { color: #1A33C7; background: #EEF1FF; border-color: #2B4EFF; }
    .tool-color-row { flex-wrap: wrap; gap: 7px; }
    .tool-custom-color { display: flex; align-items: center; gap: 3px; font-size: 10px; cursor: pointer; }
    .draw-custom { width: 26px; height: 24px; padding: 0; border: 1px solid #D9DCE4; border-radius: 5px; cursor: pointer; background: none; }
    .tool-footer-row { flex-wrap: wrap; }
    .tool-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; }
    .tool-action { min-width: 0; display: flex; align-items: center; gap: 7px; text-align: left; padding: 8px; border: 1px solid #E2E5EC; border-radius: 6px; background: #fff; font-size: 11px; font-weight: 600; }
    .tool-action svg { width: 16px; height: 16px; flex: none; }
    .tool-wide { align-self: flex-start; }
    .tool-measure-list { display: flex; flex-direction: column; gap: 6px; }
    .measure-row { display: flex; flex-direction: column; gap: 5px; padding: 7px; border: 1px solid #DEE4F5; border-radius: 6px; background: #fff; }
    .measure-row.current { border-color: #2B4EFF; }
    .measure-row strong { font-size: 11.5px; }
    .measure-row .sub { overflow-wrap: anywhere; }
    .measure-pick { display: flex; flex-direction: column; gap: 3px; width: 100%; text-align: left; background: none; border: 0; padding: 0; cursor: pointer; font: inherit; color: inherit; }
    .measure-pick:focus-visible { outline: 2px solid ${INK}; outline-offset: 2px; border-radius: 4px; }
    .measure-actions { display: flex; gap: 5px; flex-wrap: wrap; }
    .measure-pair { flex-wrap: wrap; gap: 5px; }
    .measure-pair .xin { width: auto; max-width: 120px; }
    .measure-actions .xb { font-size: 10px; padding: 5px 6px; }
    .toast { z-index: 9; }
    .pop.is-region .xe, .pop.is-region .xe1, .pop.no-el .xe, .pop.no-el .xe1 { display: none !important; }

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
    .st { display: grid; grid-template-columns: 96px 22px 1fr 22px auto; gap: 3px; align-items: center; margin-top: 4px; }
    .st label { font-size: 11px; color: #6B7183; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .st .st-note { grid-column: 1 / 6; font-size: 10.5px; color: #6B7183; }
    .st .badge { font-size: 10px; padding: 0 4px; border-radius: 4px; background: #EEF2FF; color: #1A33C7; margin-left: 3px; font-family: system-ui, sans-serif; }
    .st.added label { color: #1A33C7; }
    .st .xin:disabled { background: #F4F5F8; color: #6B7183; }
    .css-rule { width: 100%; margin-top: 3px; }
    .css-rule-info { margin-top: 3px; overflow-wrap: anywhere; }
    .css-utils { margin-top: 4px; }
    .css-utils-list { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
    .css-utils-list .chip { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    .css-props-h { margin-top: 8px; }
    .css-add { margin-top: 6px; }
    .css-add-box { margin-top: 4px; }
    .css-add-res { display: flex; flex-direction: column; max-height: 180px; overflow: auto; margin-top: 3px; border: 1px solid #E3E6EE; border-radius: 6px; }
    .css-add-res:empty { display: none; }
    .css-add-opt { text-align: left; padding: 4px 8px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; border: 0; background: none; color: #1F2433; cursor: pointer; }
    .css-add-opt:hover, .css-add-opt:focus-visible, .css-add-opt.first { background: #F5F7FF; }
    .css-add-opt .sub { font-family: system-ui, sans-serif; }
    .chg .chg-rule { font-style: normal; font-size: 10.5px; color: #6B7183; margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
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
    /* Compact toolbar shown in place of the panel while picking elements to measure or align to. */
    .x-mini { position: fixed; right: 16px; bottom: 16px; display: flex; align-items: center; gap: 10px; padding: 7px 8px 7px 12px; background: #fff; color: #1E2230; border: 1px solid #D9DCE4; border-left: 3px solid ${INK}; border-radius: 9px; box-shadow: 0 8px 24px rgba(30,34,48,.22); font-size: 12px; pointer-events: auto; z-index: 3; max-width: min(340px, calc(100vw - 32px)); }
    .x-mini[hidden] { display: none; }
    .x-mini .mini-txt { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .x-mini .mini-h { font-weight: 700; font-size: 11.5px; color: #1A33C7; }
    .x-mini .mini-step { color: #1E2230; }
    .x-mini .xb { flex: none; }
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
    .stephead { display: flex; align-items: center; gap: 7px; font-weight: 650; font-size: 12.5px; color: #1E2230; margin-top: 2px; }
    .stepn { width: 18px; height: 18px; border-radius: 50%; background: #1E2230; color: #fff; font-size: 11px; line-height: 18px; text-align: center; flex: none; }
    .tb-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; }
    .tb-actions .tool-action { padding: 7px 8px; }
    .tool-action:disabled { opacity: .4; cursor: not-allowed; }
    .tool-action[aria-expanded="true"] { color: #1A33C7; background: #EEF1FF; border-color: #2B4EFF; }
    .tb-measure { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid #ECEEF4; padding-top: 7px; }
    .tb-measure[hidden], .match-all-row[hidden] { display: none; }
    .kbd-hint { align-self: center; font-size: 10.5px; color: #8A90A2; }
    .tb-h { font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #6B7183; }
    .element-editor { display: flex; flex-direction: column; gap: 3px; padding: 8px 9px; border: 1px solid #C9D2FF; border-left: 3px solid ${INK}; border-radius: 8px; background: #F7F8FF; }
    .se-h { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .se-of { font-size: 11px; font-weight: 650; color: #1A33C7; }
    .se-name { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .se-name span { color: #4A5063; }
    .se-sel, .se-cls { color: #1A33C7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .se-cls { color: #6B7183; font-size: 11px; }
    .se-pick { display: flex; align-items: center; gap: 6px; margin-top: 3px; }
    .se-pick .xin { flex: 1; min-width: 0; }
    .tb-changes { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid #ECEEF4; padding-top: 7px; }
    .css-changes { display: flex; flex-direction: column; gap: 3px; }
    .chg { display: flex; justify-content: space-between; align-items: center; gap: 6px; font-size: 11.5px; padding: 2px 2px 2px 7px; border-radius: 5px; background: #FFFBEA; border: 1px solid #F3E2A5; overflow-wrap: anywhere; }
    .chg code { font-size: 11px; }
    .chg-from { color: #6B7183; }
    .chg .icon { width: 22px; height: 22px; line-height: 22px; flex: none; }
    .sampled-colors:not(:empty)::before { content: "Sampled colors (reference)"; display: block; font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #6B7183; margin-bottom: 3px; }
    .bp-row { flex-wrap: wrap; }
    .selb.cur { background: rgba(43,78,255,.18); box-shadow: 0 0 0 2px rgba(43,78,255,.35); }
    .tchip.cur { box-shadow: inset 0 0 0 1.5px ${INK}; }
    .tchip.missing { background: #F2F3F7; color: #6B7183; }
    .sel-sum { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .sel-list { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow: auto; padding: 2px 0; }
    .sel-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .sel-row .tchip { max-width: 100%; }
    .sel-row .xb { padding: 2px 7px; font-size: 11px; }
    .sel-tag { font-size: 10.5px; font-weight: 700; color: #1A33C7; }
    .al-mode .chips, .al-element .chips { flex-wrap: nowrap; }
    .al-axes { display: flex; flex-direction: column; gap: 7px; }
    .al-axes[hidden] { display: none; }
    .al-status.need { color: #B45309; }
    .al-element { display: flex; flex-direction: column; gap: 7px; }
    .al-element .xlabel { min-width: 70px; }
    .al-ref { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .al-ref.set { color: #15803D; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
    .refb { position: fixed; border: 2px dashed #16A34A; background: rgba(22,163,74,.07); border-radius: 3px; pointer-events: none; }
    .refb .hl-tag { background: #16A34A; }
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
    .note.auto-note { color: #6B7183; font-style: italic; }
  `;

  const LAYERS_HTML = `
    <div class="x-layers">
      <div class="x-sim"></div><div class="x-guides"></div><div class="x-marksbox"></div>
      <svg class="x-svg"><defs><marker id="xa" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${INK}"/></marker></defs><g class="x-marks"></g><g class="x-arrows"></g><g class="x-meas"></g></svg>
      <div class="dr" hidden><span class="sz"></span></div>
      <div class="hl2" hidden><span class="hl-tag"></span></div>
    </div>
    <div class="x-bar" hidden><span class="x-msg"></span><button class="ghost" data-x="bar-cancel">Esc</button></div>
    <div class="x-mini" hidden role="status" aria-live="polite"><div class="mini-txt"><span class="mini-h">Blueline · <span class="mini-tool"></span></span><span class="mini-step"></span></div><button class="xb" data-x="bar-cancel" title="Cancel (Esc)">Cancel</button></div>
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
    <div class="xrow bp-row"><span class="xlabel" title="Which screen sizes this change is for. Choosing one doesn\u2019t resize the page.">Screen size</span><div class="chips" role="group" aria-label="Screen size">
      <button class="chip" data-bp="desktop" aria-pressed="false" title="990px and wider">Desktop</button><button class="chip" data-bp="tablet" aria-pressed="false" title="750 to 989px wide">Tablet</button>
      <button class="chip" data-bp="mobile" aria-pressed="false" title="Phones, under 750px wide">Mobile</button><button class="chip" data-bp="all" aria-pressed="false" title="All screen sizes">All</button></div></div>
    <div class="sub bp-note">Records the screen size the change is for. It doesn\u2019t resize the page.</div>
  `;

  // Icons use the same stroke weight and dimensions across all tool CTAs.
  const icon = (inner) => `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const TOOL_ICON = {
    draw: icon('<path d="m4 20 5-1 11-11-4-4L5 15l-1 5Z"/><path d="m14 6 4 4"/>'),
    measure: icon('<path d="M3 8 8 3l13 13-5 5L3 8Z"/><path d="m7 7 2-2m0 5 2-2m0 5 2-2m0 5 2-2"/>'),
    align: icon('<path d="M4 3v18M20 3v18M8 6h8v12H8z"/><path d="M12 1v22" stroke-dasharray="2 3"/>'),
    elements: icon('<rect x="4" y="4" width="10" height="10" rx="1"/><path d="M14 10h6v10h-9v-6"/>'),
    move: icon('<path d="M12 2v20M2 12h20m-13-7 3-3 3 3m-6 14 3 3 3-3M5 9l-3 3 3 3m14-6 3 3-3 3"/>'),
    match: icon('<path d="M12 3a9 9 0 1 0 9 9h-9V3Z"/><path d="M14 3v7h7"/>'),
    edit: icon('<path d="m4 20 5-1L20 8l-4-4L5 15l-1 5Z"/><path d="M4 5h7"/>'),
    hide: icon('<path d="M3 3l18 18M10 10a3 3 0 0 0 4 4"/><path d="M8 5a10 10 0 0 1 4-1c5 0 9 5 10 8-.4 1-1.4 2.6-3 4M6 7C4 8.5 2.7 10.5 2 12c1 3 5 8 10 8a10 10 0 0 0 4-.8"/>'),
    sample: icon('<path d="m13 5 6 6m-2-8 4 4-11 11-4 1 1-4L18 4"/><path d="M3 21h6"/>'),
    css: icon('<path d="M8 4H6a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-2"/>'),
    more: icon('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
  };

  const hdIcon = (inner) => `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const OUTLINE_ICON = hdIcon('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke-dasharray="2.6 2.2"/>');
  const UNDO_ICON = hdIcon('<path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6h7a4 4 0 0 1 0 8H7"/>');
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const UNDO_KEY = IS_MAC ? '⌘Z' : 'Ctrl+Z';

  // Step 2. The ribbon's internal ids are unchanged (tool-elements = Toolbox, tool-draw = Annotate); "Annotate"
  // as an internal name still means selection mode (setAnnotate, hooks.toggleAnnotate). Measure is a Toolbox action.
  const MORE_HTML = `
    <div class="stephead"><span class="stepn">2</span>Edit</div>
    <div class="tool-ribbon" role="toolbar" aria-label="Editing tools">
      <button type="button" class="tool-main" data-x="tool-elements" data-tool="elements" aria-pressed="false" title="Edit text, move, measure, match style, hide, or sample a color">${TOOL_ICON.elements}<span>Toolbox</span></button>
      <button type="button" class="tool-main" data-x="tool-css" data-tool="css" aria-pressed="false" title="Preview CSS values (size, spacing, color and more) on the selected element">${TOOL_ICON.css}<span>Edit CSS</span></button>
      <button type="button" class="tool-main" data-x="tool-draw" data-tool="draw" aria-pressed="false" title="Draw arrows, shapes, freehand marks, or text on the page">${TOOL_ICON.draw}<span>Annotate</span></button>
      <button type="button" class="tool-main" data-x="tool-align" data-tool="align" aria-pressed="false" title="Align your selected elements to guide lines or to another element">${TOOL_ICON.align}<span>Align</span></button>
    </div>

    <div class="tool-panel" data-tool-panel="draw" hidden>
      <div class="tool-draw-actions" role="group" aria-label="Drawing shapes">
        <button type="button" class="xb" data-draw="arrow" title="Draw an arrow from one point to another">&#8599; Arrow</button>
        <button type="button" class="xb" data-draw="box" title="Draw a rectangular outline">&#9633; Box</button>
        <button type="button" class="xb" data-draw="circle" title="Draw an ellipse or circle">&#9675; Circle</button>
        <button type="button" class="xb" data-draw="pen" title="Draw freehand lines">&#9998; Pen</button>
        <button type="button" class="xb" data-draw="text" title="Place a text annotation on the page">T Text</button>
      </div>
      <div class="xrow"><button class="xb" data-x="draw-edit" title="Select an arrow, then drag an endpoint or its body">Edit drawings</button><button class="xb" data-x="draw-delete" title="Delete the selected arrow">Delete selected arrow</button></div>
      <div class="xrow tool-color-row">
        <span class="sub">Color</span>
        <div class="dots">${DRAW_COLORS.map((c) => `<button type="button" class="dot" data-dc="${c}" style="background:${c}" title="Use ${c} for new drawings" aria-label="Drawing color ${c}"></button>`).join('')}</div>
        <label class="tool-custom-color" title="Choose any annotation color"><input type="color" class="draw-custom" aria-label="Custom drawing color" value="${GUIDE}"><span>Custom</span></label>
      </div>
      <div class="xrow tool-footer-row"><span class="sub draw-sum"></span><span style="flex:1"></span><button class="xb" data-x="draw-undo" title="Remove the most recent drawing in this note">Remove last</button><button class="xb" data-x="draw-clear" title="Remove all drawn marks from this note">Clear</button></div>
      <div class="sub">Choose a shape, then draw on the page. Esc stops drawing. Color applies to new marks.</div>
    </div>

    <div class="tool-panel" data-tool-panel="css" hidden>
      <div class="sub css-guidance" hidden>Select an element above to edit its CSS.</div>
      <div class="css-editor">
        <div class="sub css-selected"></div>
        <div class="tb-h">CSS rule</div>
        <select class="xin css-rule" aria-label="CSS rule to edit"></select>
        <div class="sub css-rule-info"></div>
        <details class="xd css-utils" hidden><summary>Utility classes <span class="sub css-utils-n"></span></summary><div class="css-utils-list"></div></details>
        <div class="tb-h css-props-h">Existing properties</div>
        <div class="style-rows"></div>
        <div class="sub css-empty" hidden></div>
        <div class="css-add">
          <button class="xb" data-x="css-add" title="Search for a CSS property to add to this rule">+ Add CSS property</button>
          <div class="css-add-box" hidden>
            <input class="xin css-add-q" placeholder="Search properties, or type --custom-name" spellcheck="false" autocomplete="off" aria-label="Search CSS properties">
            <div class="css-add-res" role="listbox" aria-label="CSS properties"></div>
          </div>
        </div>
        <div class="sub">Changes preview on this element only, and are listed below and included in the prompt. <span class="style-sum"></span></div>
        <div class="xrow" style="margin-top:6px"><button class="xb" data-x="style-reset" title="Undo all previewed CSS values on this element. Alignment and other edits stay">Reset all</button></div>
      </div>
    </div>

    <div class="tool-panel" data-tool-panel="align" hidden>
      <div class="xrow al-mode"><span class="xlabel">Align to</span><div class="chips" role="group" aria-label="Align to">
        <button class="chip" data-al-mode="guides" aria-pressed="true" title="Align to guide lines you place on the page">Guides</button><button class="chip" data-al-mode="element" aria-pressed="false" title="Align to another element on the page. You click it next">Element</button></div></div>
      <div class="al-guides">
        <div class="xrow"><button class="xb" data-x="g-v" title="Add a vertical guide line you can drag into place">+ Vertical guide</button><button class="xb" data-x="g-h" title="Add a horizontal guide line you can drag into place">+ Horizontal guide</button></div>
        <div class="align-rows"></div>
        <div class="sub">Drag guides on the page, then align your selected element's edge or center to one. A vertical guide sets the horizontal position, a horizontal guide the vertical one.</div>
      </div>
      <div class="al-element" hidden>
        <div class="xrow"><span class="xlabel">Reference</span><span class="al-ref sub">None chosen</span><button class="xb" data-x="al-pick" title="Click an element on the page to align to. It stays where it is">Choose</button></div>
        <div class="xrow al-method"><span class="xlabel">Method</span><div class="chips" role="group" aria-label="Alignment method">
          <button class="chip" data-al-method="edges" aria-pressed="true" title="Line up edges or centers with the reference. The elements may overlap">Align edges</button><button class="chip" data-al-method="next" aria-pressed="false" title="Place the selection outside the reference, touching it">Place next to</button></div></div>
        <div class="al-axes" data-al-for="edges">
          <div class="xrow"><span class="xlabel">Horizontal</span><div class="chips" role="group" aria-label="Horizontal alignment">
            <button class="chip" data-al-h="" aria-pressed="true">None</button><button class="chip" data-al-h="left" aria-pressed="false">Left</button><button class="chip" data-al-h="center" aria-pressed="false">Center</button><button class="chip" data-al-h="right" aria-pressed="false">Right</button></div></div>
          <div class="xrow"><span class="xlabel">Vertical</span><div class="chips" role="group" aria-label="Vertical alignment">
            <button class="chip" data-al-v="" aria-pressed="true">None</button><button class="chip" data-al-v="top" aria-pressed="false">Top</button><button class="chip" data-al-v="middle" aria-pressed="false">Middle</button><button class="chip" data-al-v="bottom" aria-pressed="false">Bottom</button></div></div>
        </div>
        <div class="al-axes" data-al-for="next" hidden>
          <div class="xrow"><span class="xlabel">Horizontal</span><div class="chips" role="group" aria-label="Horizontal placement">
            <button class="chip" data-al-h="" aria-pressed="true">None</button><button class="chip" data-al-h="left-of" aria-pressed="false">Left of</button><button class="chip" data-al-h="center" aria-pressed="false" title="Center it horizontally on the reference">Center</button><button class="chip" data-al-h="right-of" aria-pressed="false">Right of</button></div></div>
          <div class="xrow"><span class="xlabel">Vertical</span><div class="chips" role="group" aria-label="Vertical placement">
            <button class="chip" data-al-v="" aria-pressed="true">None</button><button class="chip" data-al-v="above" aria-pressed="false">Above</button><button class="chip" data-al-v="middle" aria-pressed="false" title="Center it vertically on the reference">Middle</button><button class="chip" data-al-v="below" aria-pressed="false">Below</button></div></div>
        </div>
        <div class="xrow"><button class="xb" data-x="al-clear" hidden title="Remove the element alignment from all selected elements">Remove alignment</button></div>
        <div class="sub al-status"></div>
      </div>
    </div>

    <div class="tool-panel" data-tool-panel="elements" hidden>
      <div class="sub element-guidance"></div>
      <div class="tb-actions" role="group" aria-label="Element actions">
        <button type="button" class="tool-action" data-x="edittext" title="Edit this element's text directly on the page">${TOOL_ICON.edit}<span>Edit text</span></button>
        <button type="button" class="tool-action" data-x="move-here" title="Pick a new position for the selected element">${TOOL_ICON.move}<span>Move</span></button>
        <button type="button" class="tool-action" data-x="tb-measure" title="Measure the space between two elements: pick them on the page, or measure between the two you selected">${TOOL_ICON.measure}<span>Measure</span></button>
        <button type="button" class="tool-action" data-x="match" title="Pick another element to preview its styling on this one">${TOOL_ICON.match}<span>Match style</span></button>
        <button type="button" class="tool-action" data-x="hide" title="Temporarily hide the selected element to preview the layout">${TOOL_ICON.hide}<span class="hide-label">Hide</span></button>
        <button type="button" class="tool-action" data-x="pop-color" title="Sample a color from the webpage and copy its hex value">${TOOL_ICON.sample}<span>Sample color</span></button>
      </div>
      <label class="sub match-all-row"><input type="checkbox" class="match-all"> Apply match style to all selected</label>
      <div class="tb-measure" hidden>
        <div class="tb-h">Measurements</div>
        <div class="measure-pair xrow" hidden></div>
        <div class="tool-measure-list"></div>
        <button type="button" class="xb tool-wide" data-x="measure-new" title="Click another element on the page to measure to">+ Measure to another element</button>
        <div class="sub">Measurements are included in the exported prompt as reference. Hide only takes them off the page.</div>
      </div>
      <div class="sampled-colors"></div>
    </div>
    <div class="tb-changes" hidden><div class="tb-h">Changes</div><div class="css-changes"></div><div class="x-strips"></div><div class="sub tb-changes-n"></div></div>
    <details class="xd xe1" data-d="scope"><summary>Apply CSS changes to <span class="sub scope-sum"></span></summary>
      <label class="radio"><input type="radio" name="scope" value="one" checked> Just this one</label>
      <label class="radio"><input type="radio" name="scope" value="group"> All like it inside <select class="xin grp-sel" style="width:auto;max-width:170px"></select></label>
      <label class="radio"><input type="radio" name="scope" value="all"> Everywhere on the site <span class="sub all-count"></span></label>
      <div class="sub scope-info"></div></details>
  `;

  const LINK_HTML = `
    <details class="xd" data-d="link"><summary>Figma link &amp; product variant</summary>
      <input class="xin figma-in" placeholder="Figma frame link (optional)" style="margin-top:4px">
      <div class="shop-only" hidden><input class="xin var-q" placeholder="Find a product or variant (read-only)" style="margin-top:6px"><div class="var-res"></div></div></details>
  `;

  const MATCH_PROPS = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'text-align', 'color', 'background-color', 'border', 'border-radius', 'padding', 'margin', 'box-shadow', 'opacity', 'gap'];
  const UNITLESS = new Set(['font-weight', 'opacity', 'line-height', 'z-index', 'order', 'flex-grow', 'flex-shrink', 'flex', 'zoom', 'orphans', 'widows', 'tab-size', 'fill-opacity', 'stroke-opacity', 'aspect-ratio', 'scale', 'columns', 'column-count']);
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

  // The panel is anchored by its BOTTOM edge: expanding grows it upward, collapsing or leaving a
  // note shrinks it downward. Its max-height follows the room above that edge (via --bl-bottom),
  // so content scrolls inside the panel instead of running off screen.
  const PANEL_GAP = 16;
  let sessionPos = null; // { left, bottom } after a drag, until Blueline closes
  function applyPanelPos() {
    const p = q('.panel');
    if (!p) return;
    const W = document.documentElement.clientWidth || window.innerWidth; // excludes the page scrollbar
    const H = window.innerHeight;
    // A dragged position lasts only while Blueline is open; it is never stored. Clear any position
    // older versions saved, so every opening docks bottom-right.
    if ('pos' in S.prefs) { delete S.prefs.pos; BL.savePrefs(); }
    const pos = sessionPos;
    let bottom = PANEL_GAP;
    if (pos) {
      bottom = pos.bottom;
      const left = Math.min(Math.max(4, pos.left), Math.max(4, W - p.offsetWidth - 4));
      Object.assign(p.style, { left: `${left}px`, right: 'auto', top: 'auto' });
    } else {
      Object.assign(p.style, { left: '', right: '', top: '' });
    }
    // Leave enough room above the anchor for the panel's content; a minimized panel needs only its bar.
    const need = p.classList.contains('collapsed') ? (q('.bar')?.offsetHeight || 40) + 8 : Math.min(360, H - 16);
    bottom = Math.max(4, Math.min(bottom, H - need));
    p.style.bottom = `${bottom}px`;
    p.style.setProperty('--bl-bottom', `${bottom}px`);
  }
  const clampPanel = applyPanelPos;

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
    root.querySelector('.x-link').innerHTML = LINK_HTML;
    const body = root.querySelector('.body');
    root.querySelector('.x-step2').innerHTML = '<div class="stephead"><span class="stepn">3</span>Describe</div>';
    const add = mk('<button class="addnote" data-x="add-note" title="Open a new note. You can attach it to an element, or keep it as a general note"><span class="an-label">＋ Add note</span></button>');
    const startRow = mk(`<div class="startrow"><div class="sub">Or start straight from the page:</div><div class="sbtns">
      <button class="sbtn" data-x="start-select" title="Click an element on the page to attach a note to it (Alt+P)"><b>Select element</b><span>Click it on the page</span></button>
      <button class="sbtn" data-x="start-area" title="Drag a rectangle over an element, several elements, or an empty spot. Blueline finds the elements inside it"><b>Select area</b><span>Drag a rectangle</span></button></div>
      <div class="sub">Tip: Shift+click to select an element. Shift+drag to select an area.</div></div>`);
    body.insertBefore(add, body.firstChild);
    add.after(startRow);
    body.appendChild(root.querySelector('.x-tools'));
    const tools = root.querySelector('.bar .tools');
    tools.insertBefore(mk(`<button class="icon hd-undo" data-x="undo" title="Undo the last annotation change (${UNDO_KEY})" aria-label="Undo" disabled>${UNDO_ICON}</button>`), tools.firstChild);
    tools.insertBefore(mk(`<button class="icon mk-toggle" data-x="marks" aria-pressed="true" aria-label="Outlines">${OUTLINE_ICON}</button>`), tools.firstChild);
    makeDraggable(panel, root.querySelector('.bar'), { ignore: 'button, a, input, select, textarea, [data-nodrag]', onEnd: () => {
      const save = (r) => { sessionPos = { left: Math.round(r.left), bottom: Math.round(window.innerHeight - r.bottom) }; };
      save(panel.getBoundingClientRect());
      applyPanelPos(); // pull back on screen, then remember where it actually landed
      save(panel.getBoundingClientRect());
    } });
    makeDraggable(root.querySelector('.xov'), root.querySelector('.xov-h'), { translate: true });
    makeDraggable(root.querySelector('.xsheet'), root.querySelector('.xsheet header'), { translate: true });
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', onUIKey);
    root.querySelector('.pop-foot').before(mk('<div class="pop-spacer" aria-hidden="true"></div>'));
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
    sessionPos = null; // closing Blueline forgets where it was dragged
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
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onKeyUp);
    window.addEventListener('resize', clampPanel);
    document.addEventListener('paste', onPaste, true);
  }

  function detachGlobal() {
    if (!attached) return;
    attached = false;
    PTR.concat(SWALLOW).forEach((t) => window.removeEventListener(t, onEvt, true));
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', onKeyUp);
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
    const mt = q('[data-x="marks"]');
    const outlines = S.prefs.marks !== 'badges';
    mt.setAttribute('aria-pressed', String(outlines));
    mt.title = outlines ? 'Outlines on: each noted element has an outline. Click to show numbered badges only (drawings in the open note stay visible).' : 'Outlines off: only numbered badges show. Click to outline each noted element again.';
    syncUndo();
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
    select: 'Select an element: click it on the page (or drag a rectangle around it). Shift-click adds more.',
    add: 'Add more elements: click each one you want to include, then press Done.',
    area: 'Select area: drag a rectangle over the element(s). Blueline picks what is inside it.',
  };

  function syncModeButtons() {
    for (const b of qa('[data-x="start-select"], [data-x="sel-element"]')) b.classList.toggle('on', A.on && A.mode === 'select' && !A.keep);
    for (const b of qa('[data-x="start-area"], [data-x="sel-area"]')) b.classList.toggle('on', A.on && A.mode === 'area');
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
    syncCursor();
    syncModeButtons();
    if (!quiet && S.pop) renderSel();
  }

  function startSelect(keep) {
    if (S.pop?.item) { toast('Finish or cancel this note first.'); return; }
    if (!S.pop) BL.openPop(null, null, { page: true, els: [] });
    setAnnotate(true, false, 'select', !!keep);
  }

  function startArea() {
    if (S.pop?.item) { toast('Finish or cancel this note first.'); return; }
    if (!S.pop) BL.openPop(null, null, { page: true, els: [] });
    setAnnotate(true, false, 'area', false);
  }

  hooks.toggleAnnotate = () => { if (A.on) setAnnotate(false); else startSelect(false); };

  function cancelTools() { if (T.pick) endPick(null); }
  hooks.cancelTools = cancelTools;

  // While picking, the panel is hidden so the page is free to click. With `mini` ({ tool, step }) a small
  // Blueline toolbar takes the panel's corner instead, so it is clear Blueline is still open and how to cancel.
  function pickOne(msg, live, mini) {
    cancelTools();
    stopDrawing();
    setAnnotate(false, true);
    return new Promise((resolve) => {
      T.pick = { resolve, live };
      const panel = q('.panel');
      if (mini) showMini(mini, panel); else showBar(msg);
      syncCursor();
      if (panel) panel.style.visibility = 'hidden';
    });
  }

  function showMini(mini, panel) {
    const m = q('.x-mini');
    if (!m) return;
    m.querySelector('.mini-tool').textContent = mini.tool;
    m.querySelector('.mini-step').textContent = mini.step;
    const r = panel?.getBoundingClientRect();
    const W = document.documentElement.clientWidth || innerWidth;
    if (r && r.width) Object.assign(m.style, { right: `${Math.max(4, Math.round(W - r.right))}px`, bottom: `${Math.max(4, Math.round(innerHeight - r.bottom))}px` });
    m.hidden = false;
  }
  const hideMini = () => { const m = q('.x-mini'); if (m) m.hidden = true; };

  function endPick(val) {
    const p = T.pick;
    if (!p) return;
    T.pick = null;
    hideBar();
    hideMini();
    drawHl2(null);
    clearMeas();
    syncCursor();
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
    Object.assign(dr.style, { left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
    dr.querySelector('.sz').textContent = `${Math.round(Math.abs(x1 - x0))}×${Math.round(Math.abs(y1 - y0))}`;
  }
  const hideDr = () => { const dr = q('.dr'); if (dr) dr.hidden = true; };

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
    if ((e.type === 'pointermove' || e.type === 'pointerdown') && e.shiftKey !== T.shiftHeld) { T.shiftHeld = e.shiftKey; syncCursor(); }
    if (e.type === 'pointermove') { T.lastPt = { x: e.clientX, y: e.clientY }; shiftHover(BL.fromUI(e) || !(T.shiftHeld && shiftReady()) ? null : pickable(e), true); }
    if (T.eatClick && !(T.pick || A.on || D.tool) && /^(click|mouseup|dblclick|auxclick)$/.test(e.type) && !BL.fromUI(e)) {
      if (e.type === 'click') T.eatClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (!(T.pick || A.on || D.tool)) { shiftSelect(e); return; }
    const isPtr = e.type.startsWith('pointer');
    // Blueline controls must never be intercepted by page-picking or drawing.
    if (BL.fromUI(e)) {
      if (isPtr && (e.type === 'pointerup' || e.type === 'pointercancel')) {
        A.drag = null;
        D.cur = null;
        if (D.drag) { if (e.type === 'pointercancel') { P.marks[D.selected] = D.drag.before; D.drag = null; } else endArrowDrag(); renderDrawn(); }
        hideDr();
      }
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!isPtr) return;
    if (T.pick) pickPointer(e);
    else if (D.tool) drawMouse(e);
    else if (A.on) annotatePointer(e);
  }

  // Shift + click toggles one element; Shift + drag draws a rectangle and adds what is inside it
  // (same detection as Select area). Works whenever Blueline is on and no other tool is active;
  // with no note open it starts a new one. The whole press is swallowed, so the page never acts on it
  // (no link, no text selection, no image drag).
  const DRAG_MIN = 6;
  function shiftSelect(e) {
    if (T.shiftSel) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const st = T.shiftSel;
      if (e.type === 'pointercancel') { T.shiftSel = null; hideDr(); return; }
      if (e.type === 'pointermove' && !st.cancelled) {
        if (!st.moved && Math.hypot(e.clientX - st.x0, e.clientY - st.y0) > DRAG_MIN) st.moved = true;
        if (st.moved) { drawHl2(null); drawDr(st.x0, st.y0, e.clientX, e.clientY); }
        return;
      }
      if (e.type !== 'pointerup') return;
      T.shiftSel = null;
      hideDr();
      eatNextClick();
      if (st.cancelled) { syncCursor(); return; }
      const w = Math.abs(e.clientX - st.x0);
      const h = Math.abs(e.clientY - st.y0);
      if (st.moved && w >= 10 && h >= 10) shiftArea({ left: Math.min(st.x0, e.clientX), top: Math.min(st.y0, e.clientY), width: w, height: h, right: Math.max(st.x0, e.clientX), bottom: Math.max(st.y0, e.clientY) });
      else if (st.el) shiftToggle(st.el);
      syncCursor(); // opening a note resets the cursor; Shift may still be held
      return;
    }
    if (e.type !== 'pointerdown' || e.button !== 0 || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || BL.fromUI(e)) return;
    T.shiftSel = { el: pickable(e), x0: e.clientX, y0: e.clientY, moved: false, cancelled: false };
    syncCursor();
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // Saved element notes on this page can gain or lose elements; region, whole-page, and other-page
  // notes have no element list to change.
  // A note started from the page with Shift keeps keyboard focus on the page (not the note box), so the
  // next Cmd/Ctrl+Z undoes the selection instead of going to the empty text box.
  function openForShift() {
    BL.openPop(null, null, { page: true, els: [] });
    setTimeout(() => { const ta = q('.pop-note'); if (ta && !ta.value) ta.blur(); }, 0);
  }

  function lockedTarget() {
    if (P.item && (P.item.kind === 'region' || P.item.kind === 'page' || (!P.els.length && !P.cleared))) { toast('This note isn\u2019t attached to elements on this page. Start a new note to select elements.'); return true; }
    return false;
  }

  function shiftToggle(el) {
    if (!S.pop) { openForShift(); recordSelection(); setTarget({ els: [el] }); return; }
    if (lockedTarget()) return;
    if (P.els.length === 1 && P.els[0] === el && !isRegionPop()) { toast('That is the only selected element. Use ✕ on its chip to remove it.'); return; }
    const tool = activeTool;
    recordSelection();
    if (P.item) setTarget({ els: P.els.includes(el) ? P.els.filter((x) => x !== el) : [...P.els, el] });
    else selectElement(el, true);
    if (tool && S.pop && !activeTool) { activeTool = tool; syncToolPanels(); }
  }

  // What a drag adds to the current selection: not what is already selected, and not a container of
  // something already selected (its parts are what was picked; Shift+click selects a container on purpose).
  const addFound = (els) => [...P.els, ...els.filter((x) => !P.els.includes(x) && !P.els.some((s) => x.contains(s)))];

  function shiftArea(vr) {
    const adding = !!(S.pop && P.els.length && !isRegionPop());
    const found = autoSelect(vr, adding ? P.els : []);
    if (S.pop && lockedTarget()) return;
    if (adding && addFound(found.els).length === P.els.length) { toast(found.els.length ? 'Everything in that area is already selected.' : 'No elements found in that area.'); return; }
    if (!S.pop) openForShift();
    const tool = activeTool;
    recordSelection();
    if (P.item) setTarget({ els: addFound(found.els), auto: true });
    else areaDone(vr, adding, found);
    if (tool && S.pop && !activeTool) { activeTool = tool; syncToolPanels(); }
  }

  // Labels that tell same-selector elements apart: "a.card.stat · 53 Active assets".
  function elName(el, els = P.els) {
    const base = BL.label(el);
    const dup = els.some((o) => o !== el && BL.label(o) === base);
    const t = dup ? textOf(el, 28) : '';
    return t ? `${base} · ${t}` : base;
  }

  function pickPointer(e) {
    const el = pickable(e);
    if (e.type === 'pointermove') { drawHl2(el); if (T.pick.live) T.pick.live(el, e); }
    else if (e.type === 'pointerup' && e.button <= 0 && el) { eatNextClick(); endPick({ el, x: e.clientX, y: e.clientY }); }
  }

  // Text fields keep their own undo; only annotation undo is ours.
  const typingIn = (e) => {
    const t = e.composedPath()[0];
    return !!editing || (!!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')));
  };

  function onKey(e) {
    if (!S.active) return;
    if (e.key === 'Escape' && T.shiftSel && !T.shiftSel.cancelled) {
      e.preventDefault();
      e.stopImmediatePropagation();
      T.shiftSel.cancelled = true; // the release that follows is swallowed, so nothing is clicked
      hideDr();
      return;
    }
    if (e.key === 'Shift' && !typingIn(e)) { T.shiftHeld = true; syncCursor(); shiftHoverAtPointer(); }
    if ((e.key === 'z' || e.key === 'Z' || e.code === 'KeyZ') && (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.shiftKey && !e.altKey) {
      if (typingIn(e) || !(S.pop ? undoStack.length : lastUndoable())) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      undoAction();
      return;
    }
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
      return;
    }
    // With nothing in progress, Esc clears the open note's selection (one undo step; the note, its text and
    // annotations stay). Text fields, Blueline's own dialogs and an open page modal keep their Esc, and with
    // nothing selected the page gets it as usual.
    if (e.key === 'Escape' && canClearSelection() && !typingIn(e) && !uiDialogOpen() && !openModal() && !pageCover()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      clearSelection();
    }
  }
  const uiDialogOpen = () => !!S.ui && [...S.ui.root.querySelectorAll('.modal, .xmodal')].some((m) => !m.hidden);

  function onKeyUp(e) {
    if (e.type === 'keyup' && e.key !== 'Shift') return;
    T.shiftHeld = false;
    syncCursor();
    shiftHover(null);
  }

  // While Shift is held and a Shift selection is available, preview the element under the pointer
  // with the Select element hover outline and label. Hidden during a drag, while typing, while another
  // tool owns the pointer, and as soon as Shift is released.
  // A focused text field means Shift is for capital letters, so the Shift key alone shows nothing. Moving the
  // pointer with Shift held is deliberate, so a field on the page that kept focus (an autofocused search box)
  // doesn't stop the outline; typing in Blueline's own note still does.
  const typingFocus = (moved) => {
    let a = document.activeElement;
    if (moved && !mine(a)) return false;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  };
  function shiftHover(el, moved = false) {
    const show = !!el && T.shiftHeld && shiftReady() && !T.shiftSel?.moved && !typingFocus(moved);
    if (show) { drawHl2(el, true); T.shiftHover = true; } else if (T.shiftHover) { T.shiftHover = false; if (!(A.on || T.pick)) drawHl2(null); }
  }
  function shiftHoverAtPointer() {
    if (!T.lastPt) return;
    shiftHover(pointTarget(T.lastPt.x, T.lastPt.y));
  }

  // The crosshair shows while a tool or a Shift selection is in progress, or while Shift is held and
  // a Shift selection is available. Every cursor change goes through here so none can go stale.
  const shiftReady = () => S.active && !(T.pick || A.on || D.tool) && !editing;
  function syncCursor() {
    BL.cursorStyle(!!(A.on || D.tool || T.pick || T.shiftSel || (T.shiftHeld && shiftReady())));
  }

  const visibleColor = (c) => { const x = BL.rgba(c || ''); return !!x && x.a > 0; };
  const hasBox = (cs) => visibleColor(cs.backgroundColor) || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none' ||
    ['Top', 'Right', 'Bottom', 'Left'].some((s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none' && visibleColor(cs[`border${s}Color`]));
  const ownText = (e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const SELF_CONTAINED = /^(A|BUTTON|LABEL|INPUT|SELECT|TEXTAREA|IMG|SVG|VIDEO|CANVAS|IFRAME|PICTURE|H[1-6]|P|LI|TD|TH|FIGURE|SUMMARY)$/i;

  // The part of an element a person sees: for unboxed text elements, the bounds of the text itself.
  function visibleRect(e, r, cs) {
    if (/^(IMG|SVG|VIDEO|CANVAS|IFRAME|INPUT|SELECT|TEXTAREA|BUTTON)$/i.test(e.tagName) || hasBox(cs)) return r;
    if (!e.textContent.trim() || [...e.children].some((k) => !/^inline/.test(getComputedStyle(k).display))) return r;
    const range = document.createRange();
    range.selectNodeContents(e);
    const t = range.getBoundingClientRect();
    if (!t.width || !t.height) return r;
    const left = Math.max(t.left, r.left);
    const top = Math.max(t.top, r.top);
    const right = Math.min(t.right, r.right);
    const bottom = Math.min(t.bottom, r.bottom);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  const isPlainWrapper = (e, cs) => !SELF_CONTAINED.test(e.tagName) && !hasBox(cs) && !ownText(e);

  // ------------------------------------------------------------------ point selection
  // Which element is the person pointing at? The browser's hit target is the topmost element that takes
  // pointer events, which is often not what is visible there: a transparent cover link or tint layer,
  // a container's ::before/::after, a text layer with pointer-events: none, an invisible slide.
  // Prefer the most specific thing actually shown at the point; over empty space, the container there.
  const MEDIA = /^(IMG|SVG|VIDEO|CANVAS|IFRAME|PICTURE|OBJECT|EMBED|INPUT|SELECT|TEXTAREA)$/i;
  const MEDIA_SEL = 'img, svg, video, canvas, iframe, picture, object, embed, input, select, textarea';
  const inRect = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  const seen = (e) => !e.checkVisibility || e.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  // An SVG's shapes stand for the whole graphic.
  const outerSvg = (e) => { let s = e instanceof SVGElement ? e.closest('svg') : null; while (s?.parentElement?.closest('svg')) s = s.parentElement.closest('svg'); return s || e; };

  // Something of its own is visible at the point: an image or control, a styled button or link, or its own text.
  function showsAt(e, x, y) {
    const r = e.getBoundingClientRect();
    if (!inRect(r, x, y)) return false;
    if (MEDIA.test(e.tagName)) return true;
    const cs = getComputedStyle(e);
    if (/^(A|BUTTON|LABEL|SUMMARY)$/.test(e.tagName) && hasBox(cs) && e.textContent.trim()) return true;
    return ownText(e) && inRect(visibleRect(e, r, cs), x, y);
  }

  // See-through and empty: no text, image or control inside, and at most a light tint (cover links, tint
  // layers, empty positioning shells). Gradients, pictures and blur count as covering what is beneath:
  // sticky headers often fade the content under them with an empty gradient layer.
  function hollow(e) {
    if (MEDIA.test(e.tagName) || e.textContent.trim() || e.querySelector(MEDIA_SEL)) return false;
    const cs = getComputedStyle(e);
    return cs.backgroundImage === 'none' && (!cs.backdropFilter || cs.backdropFilter === 'none') && (BL.rgba(cs.backgroundColor)?.a ?? 0) <= 0.6;
  }

  // An open modal is a selection boundary: what is behind it can't be picked, even through a see-through
  // backdrop. A native <dialog> opened with showModal() says so itself. Otherwise a backdrop is a layer
  // fixed to the viewport and covering nearly all of it (unlike a hero tint or card link, which are local).
  const openModal = () => { try { return document.querySelector(':modal'); } catch { return null; } };
  function coversPage(e) {
    const r = e.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = document.documentElement.clientHeight || innerHeight;
    const w = Math.min(r.right, vw) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    if (w <= 0 || h <= 0 || w * h < 0.8 * vw * vh) return false;
    for (let p = e; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).position === 'fixed') return true;
    return false;
  }
  // The page-covering layer currently on top, if any (checked at the viewport corners).
  function pageCover() {
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = document.documentElement.clientHeight || innerHeight;
    for (const [x, y] of [[4, 4], [vw - 4, 4], [4, vh - 4], [vw - 4, vh - 4]]) {
      const top = (document.elementsFromPoint?.(x, y) || []).find((e) => !mine(e));
      if (top && top !== document.documentElement && top !== document.body && coversPage(top)) return top;
    }
    return null;
  }
  // Drawn behind the page-covering layer at its own visible centre?
  function behindCover(e, cover, r) {
    if (cover.contains(e)) return false;
    const st = (document.elementsFromPoint?.((r.left + r.right) / 2, (r.top + r.bottom) / 2) || []).filter((s) => !mine(s));
    const i = st.indexOf(cover);
    return i >= 0 && !st.slice(0, i).some((s) => s === e || s.contains(e) || e.contains(s));
  }

  function pointTarget(x, y) {
    const all = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
    if (all[0] && mine(all[0])) return null; // over Blueline's own window
    const modal = openModal();
    const stack = [];
    for (const e of all) {
      if (mine(e) || e === document.documentElement || e === document.body || !seen(e)) continue;
      if (modal && !modal.contains(e)) continue;
      const o = outerSvg(e);
      if (!stack.includes(o)) stack.push(o);
    }
    if (!stack.length) return modal;
    // Walk down the paint order. Skip what shows nothing here; stop at the first thing that shows content.
    // A container over empty space only gives way to its own children (drawn over by its ::before/::after).
    let hit = null;
    let box = null;
    for (const e of stack) {
      if (box && !box.contains(e)) break;
      if (showsAt(e, x, y)) { hit = e; break; }
      if (!box && hollow(e) && coversPage(e)) return e; // a modal backdrop: stop here
      if (!box && !hollow(e) && inRect(e.getBoundingClientRect(), x, y)) box = e;
    }
    if (hit && ownText(hit)) return hit;
    // Text that ignores the pointer (pointer-events: none) never appears in the stack; look for it near
    // what was found, drawn over it (inside it, or later in the page), and actually visible.
    const base = hit || box || stack.find((e) => inRect(e.getBoundingClientRect(), x, y)) || stack[0];
    let root = base;
    for (let p = base.parentElement, n = 0; p && p !== document.body && n < 3; p = p.parentElement, n++) if (inRect(p.getBoundingClientRect(), x, y)) root = p;
    let found = null;
    let budget = 400;
    const walk = (e) => {
      for (const k of e.children) {
        if (--budget < 0) return;
        if (mine(k) || k instanceof SVGElement || /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(k.tagName)) continue;
        const r = k.getBoundingClientRect();
        if (!r.width && !r.height) { if (getComputedStyle(k).display === 'contents') walk(k); continue; }
        if (!inRect(r, x, y) || !seen(k) || (modal && !modal.contains(k) && !k.contains(modal))) continue;
        if (!stack.includes(k) && getComputedStyle(k).pointerEvents === 'none' && ownText(k) && showsAt(k, x, y) &&
          (base.contains(k) || (!k.contains(base) && base.compareDocumentPosition(k) & Node.DOCUMENT_POSITION_FOLLOWING))) found = k;
        walk(k);
      }
    };
    walk(root);
    return found || base;
  }

  // Which element(s) did the area selection mean? Elements inside it, else the one under its middle, else an empty area.
  function autoSelect(vr, keep = []) {
    const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
    const B = { left: vr.left, top: vr.top, right: vr.right ?? vr.left + vr.width, bottom: vr.bottom ?? vr.top + vr.height, width: vr.width, height: vr.height };
    const aB = Math.max(1, area(B));
    const cx = (B.left + B.right) / 2;
    const cy = (B.top + B.bottom) / 2;
    const stack = (document.elementsFromPoint ? document.elementsFromPoint(cx, cy) : []).filter((e) => !mine(e) && e !== document.documentElement && e !== document.body);
    const containsB = (r) => r.left <= B.left + 2 && r.right >= B.right - 2 && r.top <= B.top + 2 && r.bottom >= B.bottom - 2;
    const modal = openModal();
    const cover = modal ? null : pageCover();
    const root = modal || stack.find((e) => containsB(e.getBoundingClientRect())) || document.querySelector('main') || document.body;
    const overlap = (r) => { const iw = Math.min(r.right, B.right) - Math.max(r.left, B.left); const ih = Math.min(r.bottom, B.bottom) - Math.max(r.top, B.top); return iw > 0 && ih > 0 ? iw * ih : 0; };
    const pool = [root, ...[...root.querySelectorAll('*')].slice(0, 2500)];
    const cands = []; // mostly inside the rectangle
    const crossed = []; // content the rectangle clearly crosses: text, images, controls
    for (const e of pool) {
      if (e === root || mine(e) || /^(SCRIPT|STYLE|LINK|META|BR|NOSCRIPT|TEMPLATE|HEAD|TITLE|PATH|DEFS|G|USE|TSPAN)$/i.test(e.tagName)) continue;
      const raw = e.getBoundingClientRect();
      if (area(raw) < 16 || !overlap(raw)) continue;
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      // Score by what is visible: a block heading's box spans its container, but its text may not.
      const r = visibleRect(e, raw, cs);
      const aE = area(r);
      const inter = overlap(r);
      if (aE < 64 || aE < 0.01 * aB || !inter) continue;
      // Crossed: a good part of it, or a third of both its width and height (a band through a paragraph).
      const across = inter / aE >= 0.3 || ((Math.min(r.right, B.right) - Math.max(r.left, B.left)) / r.width >= 0.3 && (Math.min(r.bottom, B.bottom) - Math.max(r.top, B.top)) / r.height >= 0.3);
      if (cover && across && behindCover(e, cover, r)) continue;
      if (inter / aE >= 0.6) cands.push({ e, cs });
      else if (across && (MEDIA.test(e.tagName) || ownText(e))) crossed.push({ e, cs });
    }
    const found = [...cands, ...crossed];
    const outermost = (list) => { const s = new Set(list.map((c) => c.e)); return list.filter((c) => { for (let p = c.e.parentElement; p; p = p.parentElement) if (s.has(p)) return false; return true; }); };
    // A plain layout wrapper (no box, no text of its own) stands for what is inside it: select that instead.
    // So does any container of something already selected (keep) when adding to a selection.
    const expand = (list) => list.flatMap((c) => {
      if (!isPlainWrapper(c.e, c.cs) && !keep.some((k) => k !== c.e && c.e.contains(k))) return [c];
      const kids = outermost(found.filter((x) => x.e !== c.e && c.e.contains(x.e)));
      return kids.length && kids.length <= 8 ? expand(kids) : [c];
    });
    const top = outermost(found);
    const picked = expand(top);
    const chosen = [picked, top, outermost(cands)].find((l) => l.length && l.length <= 8);
    if (chosen) return { els: chosen.map((c) => c.e), how: 'inside' };
    for (let e = stack[0]; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      if (modal && !modal.contains(e)) break;
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
      if (d.moved && w >= 10 && h >= 10) areaDone({ left: Math.min(d.x0, e.clientX), top: Math.min(d.y0, e.clientY), width: w, height: h, right: Math.max(d.x0, e.clientX), bottom: Math.max(d.y0, e.clientY) }, d.add || A.keep);
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

  function areaDone(vr, add, found = autoSelect(vr, add && S.pop && !isRegionPop() ? P.els : [])) {
    if (S.pop?.item) { toast('Finish or cancel this note first.'); return; }
    if (!S.pop) BL.openPop(null, null, { page: true, els: [] });
    P.marks = P.marks.filter((m) => !m.auto);
    if (found.els.length) {
      const els = add && P.els.length ? addFound(found.els) : found.els;
      setTarget({ els, auto: true });
    } else regionSelected(vr);
    P.marks.push({ t: 'box', c: D.color, auto: true, a: { x: vr.left + scrollX, y: vr.top + scrollY }, b: { x: vr.right + scrollX, y: vr.bottom + scrollY } });
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
    rememberElement();
    const oldEdits = new Map([...(P.parked || []), ...P.edits]);
    revertLive();
    P.tweaks = {}; P.hide = false; P.textEdit = null; P.align = {}; P.alignInfo = {}; P.snap = { x: 0, y: 0 };
    P.move = null; P.match = null; P.measures = []; P.variant = null;
    P.auto = !!t.auto;
    S.pop.page = false;
    if (t.region) { P.els = []; P.el = null; S.pop.region = t.region; S.pop.el = null; S.pop.els = []; }
    else { P.els = t.els; P.el = t.els[0] || null; S.pop.region = null; S.pop.el = P.el; S.pop.els = P.els; }
    P.edits = new Map(P.els.filter((el) => oldEdits.has(el)).map((el) => [el, oldEdits.get(el)]));
    P.parked = new Map([...oldEdits].filter(([el]) => !P.els.includes(el)));
    const current = P.edits.get(P.el) || emptyPop();
    for (const key of EDIT_KEYS) P[key] = current[key];
    rememberElement();
    for (const [el, record] of P.edits) applyItemPreview({ ...record, tweaks: Object.values(record.tweaks), hidden: record.hide, el: targetInfo(el), path: here() }, true);
    activeTool = null;
    visibleMeasureIndex = null;
    loadCompose();
  }

  // ------------------------------------------------------------------ compose lifecycle

  hooks.onPopOpen = (el, item) => {
    P = emptyPop();
    ruleModels.clear();
    clearUndo();
    // A copy, so Cancel leaves the saved note's history as it was.
    if (item && histories.has(item.id)) undoStack = histories.get(item.id).slice();
    const matchAll = q('.match-all'); if (matchAll) matchAll.checked = false;
    P.item = item || null;
    const sp = S.pop;
    if (item) {
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
      // A note's elements are looked up only on its own page, and each element only once.
      P.els = item.kind === 'region' || item.kind === 'page' || item.path !== here() ? [] : [...new Set(targetsOf(item))];
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
    if (item && P.els.length) {
      const used = new Set();
      const primary = BL.query(item.el?.selector);
      for (const target of P.els) {
        // Each saved instance is matched to its own element, once: by its current path, or by the selector it
        // was saved with when the page has changed since (the path can grow when similar elements appear).
        const pick = (test) => item.elementEdits?.find((e) => !used.has(e) && test(e));
        const data = pick((e) => e.el.selector === BL.cssPath(target)) || pick((e) => BL.query(e.el?.selector) === target);
        if (data) { used.add(data); restoreElementRecord(target, data); }
        // Older notes kept one set of edits for all their elements; text, move, alignment, match and
        // measurements belonged to the note's own (first) element.
        else if (!item.elementEdits) restoreElementRecord(target, { ...item, textEdit: target === primary ? item.textEdit : null, move: target === primary ? item.move : null, align: target === primary ? item.align : [], match: target === primary ? item.match : null, measures: target === primary ? item.measures : [] });
      }
      P.missing = missingRecords(item, used);
      const current = P.edits.get(P.el) || emptyPop();
      for (const key of EDIT_KEYS) P[key] = current[key];
    } else if (item && item.path === here() && item.kind !== 'region' && item.kind !== 'page') P.missing = missingRecords(item, new Set());
    S.pop.els = P.els;
    setTimeout(syncCursor, 0);
    q('.panel').classList.add('composing');
    q('.pop-note').placeholder = PH_NONE;
    for (const d of qa('.pop details')) d.open = false;
    T.selOpen = false;
    T.measureOpen = false;
    q('.pop-spacer').style.height = '0px';
    restoreAlignUi();
    q('.pop').scrollTop = 0;
    if (P.scope !== 'one') q('[data-d="scope"]').open = true;
    rememberElement();
    const anyEdit = (test) => [...P.edits.values()].some(test);
    activeTool = anyEdit((r) => Object.keys(r.align).length || r.alignEl?.x || r.alignEl?.y) ? 'align' : anyEdit((r) => Object.values(r.tweaks).some((t) => !t.snap)) ? 'css' : P.marks.some((m) => !m.auto) ? 'draw' : null;
    visibleMeasureIndex = P.measures.length ? P.measures.length - 1 : null;
    BL.hideHL();
    loadCompose();
    clampPanel();
    syncUndo();
    if (pendingUndo && pendingUndo === item?.id) {
      pendingUndo = null;
      setTimeout(() => undo('Undone. Update the note to keep this, or Cancel.'), 0);
    }
  };

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
    renderSel();
    renderElementEditor();
    syncChips();
    closeAddProp();
    buildStyleRows();
    buildAlignRows();
    updateScope();
    renderStrips();
    updateHideButton();
    syncDrawUi();
    syncToolPanels();
    updatePrerequisites();
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
    if (rg) chips.push(`<span class="tchip${P.auto ? ' auto' : ''}" title="An empty area you selected">▭ Empty area ${rg.w}×${rg.h} in ${esc(rg.ctx.container.label)}</span>`);
    else if (P.item?.kind === 'page') chips.push('<span class="tchip">Whole page (general note)</span>');
    else if (!P.els.length && P.item && !P.cleared && !P.missing.length) chips.push(`<span class="tchip">${esc(P.item.el.label)}</span>`);
    else P.els.forEach((e, i) => chips.push(`<span class="tchip${P.auto ? ' auto' : ''}${P.els.length > 1 && e === P.el ? ' cur' : ''}"${P.els.length > 1 && e === P.el ? ' aria-current="true"' : ''} title="${esc(BL.cssPath(e))}">${esc(elName(e))}<button data-x="sel-rm" data-i="${i}" aria-label="Remove ${esc(elName(e))} from this note" title="Remove from this note">✕</button></span>`));
    if (!rg && P.item?.kind !== 'page') P.missing.forEach((m, i) => chips.push(`<span class="tchip missing" title="${esc(m.rec.el?.selector || '')}. Its saved edits are kept until you remove it.">Element not found: ${esc(m.rec.el?.label || 'element')}<button data-x="sel-rm-missing" data-i="${i}" aria-label="Remove ${esc(m.rec.el?.label || 'element')} (not on this page) from this note" title="Remove from this note. Its saved edits are discarded">✕</button></span>`));
    const none = !chips.length;
    // Several elements: a count and a collapsed list (chips with their remove buttons, edits, and Edit).
    const many = !rg && P.item?.kind !== 'page' && P.els.length + P.missing.length > 1;
    let list = '';
    if (many) {
      rememberElement();
      const rows = P.els.map((e, i) => `<div class="sel-row">${chips[i]}${e === P.el ? '<span class="sel-tag">Editing</span>' : `<button class="xb" data-x="edit-element" data-i="${i}" title="Edit this element">Edit</button>`}<span class="sub">${esc(editSummary(P.edits.get(e) || emptyPop()).join(', '))}</span></div>`);
      const gone = chips.slice(P.els.length).map((c) => `<div class="sel-row">${c}</div>`);
      const n = P.els.length + P.missing.length;
      list = `<div class="sel-sum"><span class="tb-h">Selected elements (${n})</span><button class="xb" data-x="sel-showall" aria-expanded="${!!T.selOpen}">${T.selOpen ? 'Hide list' : `Show all ${n} elements`}</button></div><div class="sel-list"${T.selOpen ? '' : ' hidden'}>${[...rows, ...gone].join('')}</div>`;
    }
    const num = editing ? S.batch.items.indexOf(P.item) + 1 : 0;
    let hint = '';
    if (A.on) hint = A.keep ? 'Click each element you want to add, then press Done.' : A.mode === 'area' ? 'Drag a rectangle over what you mean.' : 'Click an element on the page (or drag around it).';
    else if (none) hint = `${PICK_HINT}${P.cleared || editing ? '' : ' Or skip this to save a general note about the whole page.'}`;
    else if (editing && !P.els.length && P.missing.length) hint = 'Not on the page right now. Its saved edits are kept.';
    else if (editing && !P.els.length && P.item.kind !== 'region' && P.item.kind !== 'page') hint = `This note is on ${esc(P.item.path)}. Open that page to edit its target.`;
    else if (editing) hint = 'Shift-click elements on the page to add or remove them from this note.';
    else if (P.auto && rg) hint = 'No element was inside your selection, so this marks an empty area. That works for "add something here".';
    else if (P.auto) hint = 'Picked automatically from your selected area. Remove it above or choose again if it\u2019s wrong.';
    else hint = 'Shift-click elements on the page to add or remove them. Need to open a menu or tab first? Do that, then press Select element again.';
    const buttons = editing ? '' : `<div class="xbtns">
      <button class="xb${A.on && A.mode === 'select' && !A.keep ? ' on' : ''}" data-x="sel-element" title="Click an element on the page to attach this note to it">Select element</button>
      <button class="xb${A.on && A.mode === 'area' ? ' on' : ''}" data-x="sel-area" title="Drag a rectangle over an element, several elements, or an empty spot. Blueline finds the elements inside it">Select area</button>
      ${P.els.length && !rg ? `<button class="xb${A.on && A.keep ? ' on' : ''}" data-x="sel-add" title="Include more elements in this same note">+ Add another element</button><span class="kbd-hint" title="Shift+click elements on the page to add or remove them">Shift+click</span>` : ''}</div>`;
    const canClear = canClearSelection();
    const clear = `<div class="xbtns"><button class="xb" data-x="sel-clear"${canClear ? '' : ' disabled'} title="${canClear ? 'Remove every selected element from this note. Drawings and other annotations stay. Undo restores the selection.' : 'Nothing selected to clear'}">Clear selection</button></div>`;
    box.innerHTML = `<div class="stephead"><span class="stepn">1</span>Select${editing ? ` (note ${num})` : ''}</div>${many ? list : chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}${buttons}${clear}<div class="sub">${hint}</div>`;
  }

  const PICK_HINT = 'Shift-click an element or Shift-drag to select an area.';
  // Saved region and whole-page notes have no element list to clear.
  const canClearSelection = () => !!S.pop && (P.els.length > 0 || (!!S.pop.region && !P.item));

  // Empties the selection as one undo step. The note stays open; drawings stay; per-element
  // annotations are parked and come back if the element is selected again.
  function clearSelection() {
    if (!canClearSelection()) return;
    if (A.on) setAnnotate(false, true);
    const tool = activeTool;
    recordSelection();
    P.marks = P.marks.filter((m) => !m.auto); // the area-selection outline goes with the selection
    P.marksDirty = true;
    P.cleared = true;
    setTarget({ els: [] });
    hideDr();
    activeTool = tool;
    syncToolPanels();
    syncDrawUi();
    renderAnn();
    syncCursor();
  }

  // The ✕ on a chip: takes that one element out of the note, with its edits (they are discarded, not parked, so
  // selecting it again starts clean). Every other element and edit stays. One undo step restores it all. The
  // element being edited stays the same unless it was the one removed. The last element leaves the note
  // with nothing selected (like Clear selection), never closing the note.
  function removeSelected(i) {
    const el = P.els[i];
    if (!S.pop || !el || isRegionPop()) return;
    const rest = P.els.filter((_, k) => k !== i);
    const current = P.el;
    if (!rest.length && !P.missing.length) { clearSelection(); P.parked.delete(el); return; }
    const tool = activeTool;
    recordSelection();
    setTarget({ els: rest, auto: P.auto });
    P.parked.delete(el);
    if (!rest.length) P.cleared = true;
    else if (current !== el && rest.includes(current)) chooseElement(rest.indexOf(current));
    if (tool && S.pop && !activeTool && P.el) { activeTool = tool; syncToolPanels(); }
    BL.hideHL();
    renderAnn();
  }

  // The ✕ on a saved element that isn't on this page: the only way its saved edits are discarded (on Update).
  function removeMissing(i) {
    if (!S.pop || !P.missing[i]) return;
    recordSelection();
    P.missing = P.missing.filter((_, k) => k !== i);
    P.missingEdited = true;
    if (!P.els.length && !P.missing.length) P.cleared = true;
    loadCompose();
  }

  // A cleared note must get a new selection (or Undo) before saving; it never silently becomes a
  // whole-page note.
  hooks.blockSave = () => (S.pop && P.cleared && !P.els.length && !P.missing.length && !S.pop.region ? `Nothing is selected. ${PICK_HINT} Or press Undo to restore the previous selection.` : '');

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
    ruleModels.clear();
    clearUndo();
    activeTool = null;
    visibleMeasureIndex = null;
    // S.pop is cleared only after this hook returns, so refresh Undo for the no-note state afterwards.
    setTimeout(() => { renderAnn(); applyAllPreviews(); syncUndo(); syncCursor(); }, 0);
  };

  function syncChips() {
    const all = ['mobile', 'tablet', 'desktop'].every((b) => P.bps.has(b));
    for (const c of qa('[data-bp]')) c.setAttribute('aria-pressed', String(c.dataset.bp === 'all' ? all : P.bps.has(c.dataset.bp)));
  }

  function updatePrerequisites() {
    for (const b of qa('[data-x="move-here"], [data-x="match"], [data-x="hide"], [data-x="align-go"], [data-x="edittext"]')) {
      const reason = !P.el || isRegionPop() ? 'Select an element first.' : b.dataset.x === 'edittext' && P.el.children.length ? 'Select the text element itself; this element contains other elements.' : '';
      b.disabled = !!reason;
      if (!b.dataset.readyTitle) b.dataset.readyTitle = b.title;
      b.title = reason || b.dataset.readyTitle;
    }
    const hint = q('.element-guidance');
    hint.textContent = P.el && !isRegionPop() ? '' : 'Select an element above to edit it. Sample color works without a selection.';
    hint.hidden = !hint.textContent;
    const noEl = !P.el || isRegionPop();
    q('.css-guidance').hidden = !noEl;
    q('.css-editor').hidden = noEl;
    q('.match-all-row').hidden = P.els.length < 2;
  }

  function updateHideButton() {
    const b = q('[data-x="hide"]');
    if (b) { const label = b.querySelector('.hide-label'); if (label) label.textContent = P.hide ? 'Show' : 'Hide'; else b.textContent = P.hide ? 'Show it' : 'Hide it'; b.classList.toggle('on', P.hide); }
  }

  // ------------------------------------------------------------------ scope ("Apply to")

  function updateScope() {
    const sm = q('.x-sim');
    const el = P.el;
    if (!el || isRegionPop()) { T.simEls = null; if (sm) sm.textContent = ''; return; }
    const opts = groupOptions(el);
    const sr = scopeRule();
    const ruleSel = sr?.reliable ? sr.rule.matched || sr.rule.selector : null;
    const all = similar(el, 'all', 0, ruleSel);
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
      info.textContent = ruleSel
        ? (all.els.length > 1 ? `The rule ${ruleSel} also matches ${plural(all.els.length - 1, 'other element')} here; the export asks for this element only, leaving that rule as it is.` : `The rule ${ruleSel} matches only this element on this page.`)
        : all.els.length > 1 ? `${all.els.length - 1} similar element${all.els.length === 2 ? '' : 's'} on this page stay unchanged.` : 'Nothing else on this page looks like it.';
      sum.textContent = '';
      return;
    }
    const s = P.scope === 'group' ? similar(el, 'group', P.groupIdx, ruleSel) : all;
    T.simEls = s.els.filter((e) => e !== el);
    renderSim();
    info.textContent = `${ruleSel ? `The change goes to the rule ${s.sel}: ` : ''}${matches(s.els.length)} for ${s.sel}${s.root ? ` inside ${BL.label(s.root)}` : ''}. Highlighted in orange. The preview shows on this element only.${s.els.length > 150 ? ' That is a lot. Is the selector too broad?' : ''}${sr && !sr.reliable ? ` (The changes were made in ${sr.rule.matched || sr.rule.selector}, which ${sr.rule.utility ? 'is a utility class' : 'isn\u2019t on the page now or has a condition that can\u2019t be checked'}, so a similar-element selector is used.)` : ''}`;
    sum.textContent = `${P.scope === 'group' ? 'group' : 'everywhere'} · ${s.els.length}`;
  }

  // ------------------------------------------------------------------ element properties (Edit CSS)
  // The editor shows the declarations of one CSS rule that matches the element being edited, as written in the
  // stylesheet. Every change is still previewed inline on that one element; the rule is recorded with the change
  // (tweak.rule) so the export can say where it belongs. One value per property per element: editing the same
  // property under another rule moves the change to that rule.

  const normInput = (prop, v) => {
    if (prop.startsWith('--') || !/^-?\d*\.?\d+$/.test(v)) return v;
    if (prop === 'line-height') return +v >= 4 ? `${v}px` : v;
    return UNITLESS.has(prop) ? v : `${v}px`;
  };

  function stepVal(prop, v, dir, shift) {
    // Colors, variables and calc() aren't nudged: changing a digit inside them would change a different thing.
    if (/var\(|calc\(|env\(|#[0-9a-f]{3,8}\b|\b(rgb|hsl|oklch|oklab|lab|lch|color)\(/i.test(v)) return v;
    const step = prop === 'opacity' ? 0.05 : prop === 'font-weight' ? 100 : prop === 'line-height' && !/[a-z%]/i.test(v) && parseFloat(v) < 4 ? 0.1 : /em$|rem$/.test(v.trim()) ? 0.125 : 1;
    return v.replace(/-?\d*\.?\d+/g, (n) => String(Math.round((+n + dir * step * (shift ? 10 : 1)) * 1000) / 1000));
  }

  const toHex = (v) => { const c = BL.rgba(v); return c ? BL.hex(c) : '#000000'; };
  const tweakCount = () => Object.values(P.tweaks).filter((t) => !t.snap).length;
  const isColorProp = (prop) => /color$/.test(prop) || /^(background|fill|stroke)$/.test(prop);
  const RESERVED = { translate: 'Alignment previews use translate. Use Align to move the element.' };
  const tweakKey = (t) => t?.rule?.key || 'element';

  // Rules matching an element, worked out once per element while a note is open (cleared on open and close).
  const ruleModels = new Map();
  function cssModel(el) {
    if (ruleModels.has(el)) return ruleModels.get(el);
    let res;
    try { res = BL.cssRulesFor(el, { inlineText: pageInline(el) }); } catch { res = { rules: [], inline: null, blocked: 0, blockedSources: [], tailwind: false }; }
    const seen = new Map();
    const total = new Map();
    const base = (r) => [r.matched, r.source.href || r.source.label, r.context].join('|');
    res.rules.forEach((r) => total.set(base(r), (total.get(base(r)) || 0) + 1));
    const rules = res.rules.map((r) => {
      const b = base(r);
      const n = seen.get(b) || 0;
      seen.set(b, n + 1);
      return { ...r, key: `${b}|${n}`, label: `${r.matched} · ${r.source.label}${r.context ? ` · ${r.context}` : ''}${total.get(b) > 1 ? ` (#${n + 1})` : ''}${r.uncertain ? ' · condition not checked' : ''}` };
    });
    // Most relevant first: rules aimed at the element itself (no ancestor in the selector), then rules without a
    // condition, then rules with more declarations, then later rules. A ranking for the list only, not the cascade.
    const direct = (r) => (/[\s>+~]/.test(r.matched.replace(/\([^)]*\)/g, '()')) ? 0 : 1);
    const strength = (a, b) => direct(b) - direct(a) || (a.context ? 1 : 0) - (b.context ? 1 : 0) || b.decls.length - a.decls.length || b.order - a.order;
    const inlineDecls = res.inline?.decls || [];
    const element = { ...(res.inline || {}), kind: inlineDecls.length ? 'inline' : 'element', decls: inlineDecls, key: 'element', matched: 'This element only', source: { kind: 'inline', label: 'style attribute', file: 'style attribute' }, context: '', label: inlineDecls.length ? 'This element only (its style attribute)' : 'This element only (no rule)' };
    const model = {
      classRules: rules.filter((r) => r.kind === 'class' && !r.utility).sort(strength),
      otherRules: rules.filter((r) => r.kind !== 'class' && !r.utility).sort(strength),
      utilities: rules.filter((r) => r.utility),
      element, blocked: res.blocked, blockedSources: res.blockedSources, count: rules.length,
    };
    model.byKey = new Map([...rules, element].map((r) => [r.key, r]));
    ruleModels.set(el, model);
    return model;
  }

  // What a change records about its rule. The element itself is recorded separately (its selector and classes).
  function ruleInfo(r) {
    if (r.key === 'element') return { key: 'element', kind: r.kind, source: 'style attribute' };
    const info = { key: r.key, kind: r.kind, selector: r.selector, matched: r.matched, source: r.source.label, file: r.source.file, href: r.source.href, context: r.context || undefined, media: r.media || undefined, layer: r.layer || undefined, uncertain: r.uncertain || undefined, utility: r.utility || undefined, path: r.path, decls: (r.decls || []).slice(0, 40).map((d) => ({ prop: d.prop, value: d.value, ...(d.important ? { important: true } : {}) })) };
    for (const k of Object.keys(info)) if (info[k] === undefined) delete info[k];
    return info;
  }

  // A saved rule whose key is gone (the page's stylesheets changed) is linked again by what identifies it, never by
  // its position alone. Candidates have the same selector, source and condition.
  //  - Exactly one candidate: it is the rule, even if its values changed since. The saved values stay as saved.
  //  - Several (the same selector declared more than once): a candidate is ruled out when a property the saved rule
  //    declared (`declared`) is no longer declared there. Of the rest, the one whose declared property names equal
  //    the rule's saved list (`decls`), else the only one that still declares the changed properties, else the only
  //    one whose values still match. Anything still tied stays unresolved: the stylesheet position is not used to
  //    pick between rules that look alike.
  // Unresolved: the change stays "not found" with its selector, source, property, values, !important and scope,
  // previewed on its own element, attached to no other rule.
  function relinkRule(model, tweaks) {
    const saved = tweaks[0].rule;
    const same = [...model.byKey.values()].filter((r) => r.key !== 'element' && r.matched === saved.matched && r.source.label === saved.source && (r.context || '') === (saved.context || ''));
    if (same.length <= 1) return same[0] || null;
    const declared = (r, prop) => (r.decls || []).find((d) => d.prop === prop);
    const live = same.filter((r) => tweaks.every((t) => t.declared !== true || declared(r, t.prop)));
    const only = (list) => (list.length === 1 ? list[0] : null);
    const names = (list) => [...new Set(list.map((d) => d.prop))].sort().join();
    const byList = saved.decls?.length ? live.filter((r) => names(r.decls || []) === names(saved.decls)) : [];
    const byProps = tweaks.some((t) => t.declared === true) ? live.filter((r) => tweaks.every((t) => t.declared !== true || declared(r, t.prop))) : [];
    const byValue = live.filter((r) => tweaks.some((t) => t.declared === true) && tweaks.every((t) => t.declared !== true || declared(r, t.prop)?.value === t.from));
    return only(byList) || only(byProps) || only(byValue) || null;
  }

  // Saved changes whose rule isn't on the page now: kept as they are and shown under their own entry.
  function missingRuleEntries(model) {
    const out = new Map();
    for (const t of Object.values(P.tweaks)) {
      if (!t.snap && t.rule && t.rule.key !== 'element' && !model.byKey.has(t.rule.key)) {
        const group = Object.values(P.tweaks).filter((x) => !x.snap && x.rule?.key === t.rule.key);
        const pick = relinkRule(model, group);
        if (pick) for (const x of group) x.rule = ruleInfo(pick);
      }
      if (t.snap || !t.rule || t.rule.key === 'element' || model.byKey.has(t.rule.key) || out.has(t.rule.key)) continue;
      out.set(t.rule.key, { key: t.rule.key, missing: true, kind: t.rule.kind, matched: t.rule.matched || t.rule.selector, selector: t.rule.selector, source: { label: t.rule.source || '' }, context: t.rule.context || '', decls: [], label: `${t.rule.matched || t.rule.selector} · ${t.rule.source || ''}${t.rule.context ? ` · ${t.rule.context}` : ''} · not found on this page` });
    }
    return [...out.values()];
  }

  // The rule the editor shows: the one chosen for this instance, else the rule of its latest change, else the
  // strongest class rule (by specificity and source order only, no cascade claim), else another rule, else the element.
  function currentRule(model, missing) {
    const find = (key) => model.byKey.get(key) || missing.find((m) => m.key === key) || null;
    if (P.cssRule && find(P.cssRule)) return find(P.cssRule);
    const last = Object.values(P.tweaks).filter((t) => !t.snap).pop();
    if (last) return find(tweakKey(last)) || model.element;
    return model.classRules.find((r) => !r.uncertain) || model.otherRules.find((r) => !r.uncertain) || model.element;
  }

  function buildStyleRows() {
    const box = q('.style-rows');
    box.textContent = '';
    q('.style-sum').textContent = tweakCount() ? `${tweakCount()} changed` : '';
    const sel = q('.css-rule');
    const info = q('.css-rule-info');
    const empty = q('.css-empty');
    const utils = q('.css-utils');
    if (!P.el || isRegionPop()) { sel.innerHTML = ''; info.textContent = ''; empty.hidden = true; utils.hidden = true; return; }
    const model = cssModel(P.el);
    const missing = missingRuleEntries(model);
    const rule = currentRule(model, missing);
    const text = elText(P.el);
    q('.css-selected').textContent = `Selected: ${P.el.tagName.toLowerCase()}${text ? ` · ${text}` : ''}`;

    // Picker: class rules first, then other rules, then this element; utility classes sit in a collapsed group.
    const opt = (r) => `<option value="${esc(r.key)}"${r.key === rule.key ? ' selected' : ''}>${esc(r.label)}</option>`;
    const groups = [];
    if (model.classRules.length) groups.push(`<optgroup label="Class rules">${model.classRules.map(opt).join('')}</optgroup>`);
    if (model.otherRules.length) groups.push(`<optgroup label="Other rules">${model.otherRules.map(opt).join('')}</optgroup>`);
    if (rule.utility) groups.push(`<optgroup label="Utility class">${opt(rule)}</optgroup>`);
    if (missing.length) groups.push(`<optgroup label="Saved, not on this page">${missing.map(opt).join('')}</optgroup>`);
    groups.push(`<optgroup label="No rule">${opt(model.element)}</optgroup>`);
    sel.innerHTML = groups.join('');
    sel.value = rule.key;
    utils.hidden = !model.utilities.length;
    q('.css-utils-n').textContent = model.utilities.length ? `(${model.utilities.length})` : '';
    q('.css-utils-list').innerHTML = model.utilities.map((r) => `<button class="chip" data-x="css-rule-pick" data-key="${esc(r.key)}" aria-pressed="${r.key === rule.key}" title="${esc(`${r.label}: ${r.decls.map((d) => `${d.prop}: ${d.value}`).join('; ')}`)}">${esc(r.matched)}</button>`).join('');
    if (rule.utility) utils.open = true;

    const where = rule.key === 'element' ? 'Changes for this element only, not tied to a stylesheet rule.'
      : rule.missing ? 'This rule isn’t on the page now (the page or its stylesheets changed). Its saved changes are kept and still previewed on this element.'
        : `${rule.selector !== rule.matched ? `Selector ${rule.selector} · ` : ''}${rule.source.label}${rule.context ? ` · ${rule.context}` : ''}. Matches this element${model.count > 1 ? `; ${model.count} rules do. Which one wins for each property isn’t checked` : ''}.${rule.uncertain ? ' Its condition can’t be checked here, so it may not apply right now.' : ''}`;
    const blocked = model.blocked ? ` ${plural(model.blocked, 'stylesheet')} from another site couldn’t be read, so ${model.blocked === 1 ? 'its' : 'their'} rules aren’t listed.` : '';
    info.textContent = where + blocked;

    // Rows: the rule's own declarations, then properties added to it.
    const rows = [];
    const declared = new Set();
    for (const d of rule.decls) {
      declared.add(d.prop);
      rows.push({ prop: d.prop, from: d.value, important: d.important, added: false });
    }
    for (const t of Object.values(P.tweaks)) {
      if (t.snap || declared.has(t.prop) || tweakKey(t) !== rule.key) continue;
      declared.add(t.prop);
      rows.push({ prop: t.prop, from: t.declared === false ? '' : t.from, added: t.declared === false, legacy: !t.rule && t.via !== 'match', match: t.via === 'match' });
    }
    for (const a of P.cssAdded) if (a.key === rule.key && !declared.has(a.prop)) { declared.add(a.prop); rows.push({ prop: a.prop, from: '', added: true }); }
    q('.css-props-h').hidden = !rows.length;
    const nothing = !model.count && !model.element.decls.length;
    empty.hidden = rows.length > 0;
    empty.textContent = nothing
      ? 'No stylesheet rule matches this element directly. Its look may be inherited from a parent or come from a stylesheet that can’t be read. Use + Add CSS property to set a value on this element only.'
      : rule.key === 'element' ? 'No properties on this element yet. Use + Add CSS property.' : 'This rule has no properties to show. Use + Add CSS property.';
    const cs = getComputedStyle(P.el);
    for (const r of rows) {
      const t = P.tweaks[r.prop];
      const mine = t && !t.snap && tweakKey(t) === rule.key;
      const reserved = RESERVED[r.prop];
      const cur = mine ? t.to : r.from;
      const computed = cs.getPropertyValue(r.prop).trim();
      const note = [r.important ? '!important' : '', r.added ? `added to this ${rule.key === 'element' ? 'element' : 'rule'}${computed ? ` · now ${clip(computed, 40)}` : ''}` : '', r.legacy ? 'saved before rules were recorded' : '', r.match ? 'from Match style (computed values)' : '', t && !t.snap && !mine ? `changed under ${tweakKey(t) === 'element' ? 'this element' : t.rule.matched || t.rule.selector}; editing here moves it` : '', reserved || ''].filter(Boolean).join(' · ');
      const row = mk(`<div class="st${r.added ? ' added' : ''}" data-prop="${esc(r.prop)}" data-from="${esc(r.from)}" data-base="${esc(computed)}" data-key="${esc(rule.key)}"${r.added ? ' data-added="1"' : ''}><label title="${esc(r.prop)}">${esc(r.prop)}</label><button class="nb" data-x="st-dec" aria-label="Decrease ${esc(r.prop)}"${reserved ? ' disabled' : ''}>−</button><input class="xin sv" value="${esc(cur)}" placeholder="${esc(r.added ? computed || 'value' : '')}" spellcheck="false" aria-label="${esc(r.prop)}"${reserved ? ' disabled' : ''}><button class="nb" data-x="st-inc" aria-label="Increase ${esc(r.prop)}"${reserved ? ' disabled' : ''}>+</button><span class="xc">${isColorProp(r.prop) && !reserved ? '<input type="color" class="sw" aria-label="Pick a color"><button class="xb" data-x="st-drop" title="Sample a color from the screen" aria-label="Eyedropper">◉</button>' : ''}${r.added ? `<button class="icon" data-x="css-row-rm" title="Remove ${esc(r.prop)} from this rule" aria-label="Remove added property ${esc(r.prop)}">✕</button>` : ''}</span><div class="tok" hidden></div>${note ? `<div class="st-note">${esc(note)}</div>` : ''}</div>`);
      box.appendChild(row);
      refreshRow(row);
    }
  }

  // The row's own change: the instance's change for this property, if it was made under this row's rule.
  const rowTweak = (row) => { const t = P.tweaks[row.dataset.prop]; return t && !t.snap && tweakKey(t) === row.dataset.key ? t : null; };

  function refreshRow(row) {
    const t = rowTweak(row);
    const input = row.querySelector('.sv');
    input.classList.toggle('ch', !!t);
    const tok = row.querySelector('.tok');
    tok.hidden = !(t && t.token);
    tok.textContent = t && t.token ? `≈ ${t.token}` : '';
    const sw = row.querySelector('.sw');
    if (sw) sw.value = toHex(input.value || row.dataset.from || row.dataset.base);
  }

  function styleInput(row, raw) {
    if (!P.el || RESERVED[row.dataset.prop]) return;
    const prop = row.dataset.prop;
    const key = row.dataset.key;
    const added = row.dataset.added === '1';
    const from = row.dataset.from;
    const v = raw.trim();
    const t = P.tweaks[prop];
    const own = t && !t.snap && tweakKey(t) === key;
    // Nothing changes (e.g. + on a var() value): no undo step.
    if (own ? normInput(prop, v) === t.to : !v || (!added && v === from)) { refreshRow(row); return; }
    record(`style:${P.els.indexOf(P.el)}:${key}:${prop}`);
    if (!v || (!added && v === from)) {
      if (own) { delete P.tweaks[prop]; restoreInline(P.el, prop); }
    } else {
      const model = cssModel(P.el);
      const rule = model.byKey.get(key) || missingRuleEntries(model).find((m) => m.key === key) || model.element;
      const val = normInput(prop, v);
      const tok = tokenHint(prop, val, BL.stylingOf(P.el).includes('tailwind'));
      if (own) Object.assign(t, { to: val, token: tok });
      else {
        // Edited under another rule before: the change moves here (one value per property on this element).
        if (t && !t.snap) toast(`${prop} now belongs to ${rule.key === 'element' ? 'this element' : rule.matched}.`);
        const computed = t && !t.snap ? t.computed ?? row.dataset.base : getComputedStyle(P.el).getPropertyValue(prop).trim();
        P.tweaks[prop] = { prop, from: added ? '' : from, to: val, token: tok, rule: rule.missing ? { ...(t?.rule || {}) } : ruleInfo(rule), declared: !added, computed, ...(rule.decls?.find((d) => d.prop === prop)?.important ? { important: true } : {}) };
      }
      if (added) P.cssAdded = P.cssAdded.filter((a) => !(a.key === key && a.prop === prop));
    }
    restoreInline(P.el, prop);
    paintCss(P.el, P);
    refreshRow(row);
    realign();
    renderElementEditor();
    updateScope();
    q('.style-sum').textContent = tweakCount() ? `${tweakCount()} changed` : '';
    renderAnn();
  }

  // Shown value of a row after a nudge: its own change, else what the rule declares.
  const rowValue = (row) => rowTweak(row)?.to ?? row.dataset.from;

  // Undo one CSS value on the instance being edited (from the Changes list).
  function removeTweak(prop) {
    if (!P.el || !P.tweaks[prop]) return;
    record();
    restoreInline(P.el, prop);
    delete P.tweaks[prop];
    paintCss(P.el, P);
    buildStyleRows();
    updateScope();
    realign();
    renderAnn();
  }

  // ✕ on an added property row: removes the row and its value.
  function removeAddedRow(row) {
    const { prop, key } = row.dataset;
    const t = rowTweak(row);
    record();
    if (t) { delete P.tweaks[prop]; restoreInline(P.el, prop); paintCss(P.el, P); }
    P.cssAdded = P.cssAdded.filter((a) => !(a.key === key && a.prop === prop));
    buildStyleRows();
    updateScope();
    realign();
    renderAnn();
  }

  function chooseRule(key) {
    if (!P.el) return;
    P.cssRule = key;
    closeAddProp();
    holdPosition(q('.css-rule'), () => buildStyleRows());
  }

  // + Add CSS property: a searchable list of the properties this browser supports (shorthands and longhands),
  // common ones first. Properties the rule already has, or already added, aren't offered again.
  const COMMON_PROPS = [
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'font-size', 'font-weight', 'line-height', 'letter-spacing', 'font-family', 'font-style', 'color', 'background-color', 'background', 'text-align',
    'text-transform', 'text-decoration', 'width', 'max-width', 'min-width', 'height', 'max-height', 'min-height', 'gap', 'row-gap', 'column-gap',
    'border', 'border-radius', 'border-color', 'border-width', 'border-style', 'border-top', 'border-bottom', 'box-shadow', 'opacity', 'display',
    'position', 'top', 'right', 'bottom', 'left', 'z-index', 'align-items', 'justify-content', 'flex-direction', 'flex-wrap', 'flex', 'grid-template-columns',
    'overflow', 'object-fit', 'aspect-ratio', 'transform', 'transition',
  ];
  let cssPropNames = null;
  function cssPropList() {
    if (cssPropNames) return cssPropNames;
    const names = new Set(COMMON_PROPS);
    const cs = getComputedStyle(document.documentElement);
    for (let i = 0; i < cs.length; i++) names.add(cs[i]);
    const st = document.createElement('div').style;
    for (const k in st) {
      if (typeof st[k] !== 'string' || /^(cssText|cssFloat)$/.test(k)) continue;
      names.add(/[A-Z]/.test(k) ? k.replace(/^webkit/, '-webkit').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`) : k);
    }
    cssPropNames = [...names].filter((n) => /^-?[a-z][a-z-]*$/.test(n) && !RESERVED[n] && (() => { try { return CSS.supports(n, 'inherit'); } catch { return false; } })());
    return cssPropNames;
  }
  const validCustom = (n) => /^--[A-Za-z_][\w-]*$/.test(n);
  function propResults(query) {
    const qv = query.trim().toLowerCase();
    const used = new Set([...qa('.style-rows .st')].map((r) => r.dataset.prop));
    if (query.trim().startsWith('--')) {
      const name = query.trim();
      return validCustom(name) && !used.has(name) ? [{ prop: name, custom: true }] : [];
    }
    if (!qv) return COMMON_PROPS.filter((p) => !used.has(p)).slice(0, 12).map((prop) => ({ prop }));
    const all = cssPropList().filter((p) => !used.has(p) && p.includes(qv) && (qv.startsWith('-') || !p.startsWith('-')));
    const rank = (p) => (p === qv ? 0 : COMMON_PROPS.includes(p) && p.startsWith(qv) ? 1 + COMMON_PROPS.indexOf(p) / 1000 : p.startsWith(qv) ? 2 : 3);
    return all.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 12).map((prop) => ({ prop }));
  }
  function renderAddResults() {
    const box = q('.css-add-res');
    const query = q('.css-add-q').value;
    const res = propResults(query);
    box.innerHTML = res.length
      ? res.map((r, i) => `<button type="button" class="css-add-opt${i === 0 ? ' first' : ''}" role="option" data-x="css-add-pick" data-prop="${esc(r.prop)}">${esc(r.prop)}${r.custom ? ' <span class="sub">custom property</span>' : ''}</button>`).join('')
      : `<div class="sub" style="padding:4px 8px">${query.trim().startsWith('--') ? (validCustom(query.trim()) ? 'Already in this rule.' : 'A custom property name is -- followed by letters, digits, - or _.') : 'No matching property, or it’s already in this rule.'}</div>`;
  }
  function openAddProp() {
    const boxEl = q('.css-add-box');
    holdPosition(q('[data-x="css-add"]'), () => { boxEl.hidden = false; });
    const input = q('.css-add-q');
    input.value = '';
    renderAddResults();
    input.focus({ preventScroll: true });
  }
  function closeAddProp() { const b = q('.css-add-box'); if (b) b.hidden = true; }
  function addCssProp(prop) {
    if (!P.el || !prop || RESERVED[prop]) return;
    const model = cssModel(P.el);
    const rule = currentRule(model, missingRuleEntries(model));
    if (!qa('.style-rows .st').some((r) => r.dataset.prop === prop)) P.cssAdded = [...P.cssAdded, { key: rule.key, prop }];
    closeAddProp();
    holdPosition(q('[data-x="css-add"]'), () => buildStyleRows());
    const input = qa('.style-rows .st').find((r) => r.dataset.prop === prop)?.querySelector('.sv');
    if (input) input.focus({ preventScroll: true });
  }

  // Bring the description field into view (Add note opens straight to writing).
  function revealDescribe() {
    const pop = q('.pop');
    const ta = q('.pop-note');
    if (pop && ta) pop.scrollTop = Math.max(0, pop.scrollTop + ta.getBoundingClientRect().top - pop.getBoundingClientRect().top - 40);
  }

  // Reset all puts back the previewed CSS values only. Alignment (its translate preview) is a separate edit and stays.
  function resetStyles() {
    for (const [prop, t] of Object.entries(P.tweaks)) {
      if (t.snap) continue;
      if (P.el) restoreInline(P.el, prop);
      delete P.tweaks[prop];
    }
    P.cssAdded = [];
    paintCss(P.el, P);
    buildStyleRows();
    updateScope();
    buildAlignRows();
    renderElementEditor();
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
    if (S.pop) buildAlignRows();
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
    box.innerHTML = gs.length ? gs.map((g) => {
      const info = P.alignInfo[g.id];
      return `<div class="strip" style="flex-wrap:wrap;margin-top:4px"><b>Guide ${esc(g.name)} · ${g.axis === 'x' ? 'vertical' : 'horizontal'} ${Math.round(g.pos)}px</b><button class="xb" data-x="g-del" data-id="${esc(g.id)}" title="Delete this guide and clear its alignment assignments">✕ Delete guide</button><select class="xin align-edge" data-g="${esc(g.id)}" aria-label="Edge for guide ${esc(g.name)}">${EDGES[g.axis].map(([k, l]) => `<option value="${k}"${P.align[g.id] === k ? ' selected' : ''}>${l}</option>`).join('')}</select><button class="xb" data-x="align-go" data-g="${esc(g.id)}" title="Align the active instance to this guide">Align to guide</button>${info ? `<span class="sub">${esc(BL.label(P.el))}: ${P.align[g.id]} aligned · ${rnd(info.shift)}px</span><button class="xb" data-x="align-clear" data-g="${esc(g.id)}" title="Undo this instance's alignment to this guide">Undo alignment</button>` : ''}</div>`;
    }).join('') : '<div class="sub">Create a guide above, drag it into position, choose an element and edge, then click Align to guide.</div>';
    if (!P.el && gs.length) box.insertAdjacentHTML('beforeend', '<div class="sub">Select an element first to align it.</div>');
  }
  function removeGuide(id) {
    rememberElement();
    for (const el of P.els) visitElement(el, () => { if (P.align[id]) snapTo(id, P.align[id], true); });
    for (const item of S.batch?.items || []) {
      for (const data of item.elementEdits || [item]) {
        const removed = (data.align || []).filter((a) => a.guideId === id || a.guide === guidesHere().find((g) => g.id === id)?.name);
        if (!removed.length) continue;
        const el = BL.query(data.el?.selector);
        if (el) restoreInline(el, 'translate');
        data.align = data.align.filter((a) => !removed.includes(a));
        const remaining = data.align;
        const translate = (data.tweaks || []).find((t) => t.snap && t.prop === 'translate');
        if (translate) { if (remaining.length) translate.to = `${remaining.find((a) => a.axis === 'x')?.shift || 0}px ${remaining.find((a) => a.axis === 'y')?.shift || 0}px`; else data.tweaks = data.tweaks.filter((t) => t !== translate); }
      }
    }
    if (S.batch) S.batch.guides = (S.batch.guides || []).filter((g) => g.id !== id);
    clearUndo();
    BL.saveBatch(); renderAnn(); updateToolbar(); renderGuideList(); buildAlignRows();
  }

  function edgePos(r, edge) {
    return { left: r.left + scrollX, center: r.left + r.width / 2 + scrollX, right: r.right + scrollX, top: r.top + scrollY, middle: r.top + r.height / 2 + scrollY, bottom: r.bottom + scrollY }[edge];
  }

  // Preview-snap the element's edge onto the guide by shifting it with `translate`.
  function snapTo(gid, edge, clear = false) {
    const el = P.el;
    const g = guidesHere().find((x) => x.id === gid);
    if (!el || !g) return;
    record();
    const axis = g.axis;
    const same = Object.keys(P.align).filter((id) => (guidesHere().find((x) => x.id === id) || {}).axis === axis);
    const toggledOff = clear;
    same.forEach((id) => { delete P.align[id]; delete P.alignInfo[id]; });
    if (P.alignEl?.[axis]) P.alignEl = { ...P.alignEl, [axis]: null };
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
    syncAlignUi();
    buildAlignRows();
    renderAlign();
    renderAnn();
  }

  // ------------------------------------------------------------------ align to an element
  // Two methods. Align edges: an edge or center of the selection matches the same edge or center of the
  // reference (overlapping is fine). Place next to: the selection sits just outside the reference, touching it.
  // The selected elements move as one group: their combined box is placed and every element gets the same
  // shift, so their spacing is kept. The reference never moves. Each element's shift is its own edit (alignEl,
  // previewed with `translate`, like guides). A shift is always worked out from where the elements sit without
  // any shift, so a new choice replaces the previous one instead of adding to it, and CSS changes (margin, width…)
  // are followed by working it out again.

  const EDGE_WORD = { left: 'left edge', center: 'horizontal center', right: 'right edge', top: 'top edge', middle: 'vertical center', bottom: 'bottom edge' };
  const NEXT_WORD = { 'left-of': 'to the left of', 'right-of': 'to the right of', above: 'above', below: 'below', center: 'horizontally centered on', middle: 'vertically centered on' };
  const methodOf = (a) => (a?.method === 'next' ? 'next' : 'edges');
  const alignWord = (a) => (methodOf(a) === 'next' ? `Placed ${NEXT_WORD[a.edge]}` : `Aligned ${EDGE_WORD[a.edge]} with`);
  const edgeOf = (r, edge) => ({ left: r.left, center: (r.left + r.right) / 2, right: r.right, top: r.top, middle: (r.top + r.bottom) / 2, bottom: r.bottom }[edge]);
  // The element's own side that is placed for each choice.
  const SIDE = { left: 'left', right: 'right', top: 'top', bottom: 'bottom', 'right-of': 'left', 'left-of': 'right', below: 'top', above: 'bottom' };

  // The element's box where the layout puts it, without any translate (ours or the page's). Reading the translate
  // in effect right now keeps this right even while a CSS transition runs. Plain inline elements can't be
  // translated, so their box is used as it is.
  const REPLACED = /^(IMG|SVG|VIDEO|CANVAS|IFRAME|INPUT|SELECT|TEXTAREA|BUTTON|OBJECT|EMBED)$/i;
  function layoutRect(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const t = cs.display === 'inline' && !REPLACED.test(el.tagName) ? ['none'] : String(cs.translate || 'none').trim().split(/\s+/);
    const px = (v) => (/^-?[\d.]+px$/.test(v || '') ? parseFloat(v) : 0);
    const dx = t[0] === 'none' ? 0 : px(t[0]);
    const dy = t[0] === 'none' ? 0 : px(t[1]);
    return { left: r.left - dx, right: r.right - dx, top: r.top - dy, bottom: r.bottom - dy };
  }
  function groupRect(rs) {
    return { left: Math.min(...rs.map((r) => r.left)), top: Math.min(...rs.map((r) => r.top)), right: Math.max(...rs.map((r) => r.right)), bottom: Math.max(...rs.map((r) => r.bottom)) };
  }
  // Space added on the placed side by a margin changed in Edit CSS (its original margin isn't counted), so a
  // larger margin moves the element away from the reference the way it would in the real layout.
  // Measured, not parsed: the computed margin on that side with the instance's margin edits (margin, margin-*,
  // logical margins, and custom properties a margin may use) minus without them, so rem, calc() and var() count.
  function marginChange(el, side) {
    const r = P.edits.get(el);
    const lift = Object.values(r?.tweaks || {}).filter((t) => !t.snap && (/^margin(-|$)/.test(t.prop) || t.prop.startsWith('--')));
    if (!lift.length) return 0;
    const read = () => parseFloat(getComputedStyle(el).getPropertyValue(`margin-${side}`)) || 0;
    const now = read();
    for (const t of lift) restoreInline(el, t.prop);
    const was = read();
    paintCss(el, r);
    return now - was;
  }
  // Where the group's own edge must go for one choice: [its edge, position on screen].
  function alignTarget(method, edge, ref, d) {
    if (edge === 'center' || edge === 'middle') return [edge, edgeOf(ref, edge)];
    if (method === 'next') return { 'right-of': ['left', ref.right + d], 'left-of': ['right', ref.left - d], below: ['top', ref.bottom + d], above: ['bottom', ref.top - d] }[edge];
    return [edge, edgeOf(ref, edge) + (edge === 'right' || edge === 'bottom' ? -d : d)];
  }
  // The element's translate preview from its guide and element alignment shifts (one per axis).
  function applySnap(el) {
    if (P.snap.x || P.snap.y) { setInline(el, 'translate', `${P.snap.x || 0}px ${P.snap.y || 0}px`); P.tweaks.translate = { prop: 'translate', from: 'none', to: `${P.snap.x || 0}px ${P.snap.y || 0}px`, snap: true }; }
    else { restoreInline(el, 'translate'); delete P.tweaks.translate; }
  }
  const setShift = (el, axis, v) => visitElement(el, () => { P.snap = { ...P.snap, [axis]: v }; applySnap(el); });
  const refOutside = (ref) => !P.els.some((e) => e === ref || e.contains(ref));

  // Place next to must not leave content where it can't be reached. A placement is refused (never applied, never
  // resized, never scrolled to) when it would push the group well past an edge of the page (left, right or top, and
  // the bottom only when the page can't scroll down to it) or out of a container that clips it (overflow hidden or
  // clip). A group that already stuck out may stay or move back in, but not go further out. Taller pages scroll, so
  // a position below the viewport is fine. Purely decorative media (images, graphics, video, canvas, or aria-hidden
  // content without text) may overflow on purpose and is never checked. Move and Align edges are not restricted.
  const OVERFLOW_TOL = 16;
  const DECORATIVE = /^(IMG|SVG|PICTURE|VIDEO|CANVAS)$/i;
  const isDecorative = (el) => DECORATIVE.test(el.tagName) || (el.getAttribute('aria-hidden') === 'true' && !el.textContent.trim());
  const clips = (v) => v === 'hidden' || v === 'clip';
  // The ranges (page coordinates) the group must stay inside on one axis: [from, to, what], to = Infinity when open.
  function axisLimits(els, axis) {
    const x = axis === 'x';
    const root = document.documentElement;
    const out = [];
    const cs = [getComputedStyle(root), document.body ? getComputedStyle(document.body) : null].filter(Boolean);
    const locked = cs.some((c) => clips(x ? c.overflowX : c.overflowY));
    out.push(x ? [0, root.clientWidth || innerWidth, 'the page'] : [0, locked ? Math.max(root.clientHeight, innerHeight) : Infinity, 'the page']);
    const seen = new Set();
    for (const el of els) for (let a = el.parentElement; a && a !== document.body && a !== root; a = a.parentElement) {
      if (seen.has(a)) continue;
      seen.add(a);
      if (!clips(x ? getComputedStyle(a).overflowX : getComputedStyle(a).overflowY)) continue;
      const r = a.getBoundingClientRect();
      out.push(x ? [r.left + scrollX, r.right + scrollX, 'the container that clips it'] : [r.top + scrollY, r.bottom + scrollY, 'the container that clips it']);
    }
    return out;
  }
  // `box` is the group's translate-free box (viewport coordinates); returns { side, by, what } or null.
  function boundsOverflow(els, axis, box, shift) {
    if (els.every(isDecorative)) return null;
    const x = axis === 'x';
    const lo = (x ? box.left + scrollX : box.top + scrollY);
    const hi = (x ? box.right + scrollX : box.bottom + scrollY);
    for (const [from, to, what] of axisLimits(els, axis)) {
      const nowLow = Math.max(0, from - lo), nowHigh = Math.max(0, hi - to);
      const lowBy = Math.max(0, from - (lo + shift)), highBy = Math.max(0, hi + shift - to);
      if (lowBy > Math.max(nowLow, OVERFLOW_TOL)) return { side: x ? 'left' : 'top', by: Math.round(lowBy), what };
      if (highBy > Math.max(nowHigh, OVERFLOW_TOL)) return { side: x ? 'right' : 'bottom', by: Math.round(highBy), what };
    }
    return null;
  }
  const overflowWarning = (o) => `That placement would push it about ${o.by}px past the ${o.side} edge of ${o.what}, so it wasn’t applied. The previous position is kept. Try another side, or make the element narrower in Edit CSS.`;

  // Places `els` as one group on one axis and returns their shared shift (null when nothing can be measured).
  // Measured from the layout, then checked once more: a shift can add a scrollbar and nudge a centered layout.
  // For Place next to, a placement that would leave the page's or a clipping container's bounds is not applied:
  // { overflow } comes back instead. With `dry`, nothing is applied at all and the first measured shift (or { overflow }) is returned.
  function placeGroup(els, axis, method, edge, refEl, dry = false) {
    rememberElement();
    const shown = els.filter((e) => e.isConnected && e.getClientRects().length);
    if (!shown.length || !refEl?.isConnected || !alignTarget(method, edge, { left: 0, right: 0, top: 0, bottom: 0 }, 0)) return null;
    let shift = null;
    for (let i = 0; i < 3; i++) {
      const rs = shown.map((e) => ({ e, r: layoutRect(e) }));
      const box = groupRect(rs.map((x) => x.r));
      const side = SIDE[edge];
      let d = 0;
      if (side) { const v = box[side]; const m = rs.find((x) => x.r[side] === v); d = m ? marginChange(m.e, side) : 0; }
      const [own, want] = alignTarget(method, edge, refEl.getBoundingClientRect(), d);
      const next = rnd(want - edgeOf(box, own));
      if (i === 0 && method === 'next') { const over = boundsOverflow(shown, axis, box, next); if (over) return { overflow: over }; }
      if (dry) return next;
      if (shift !== null && Math.abs(next - shift) < 0.6) break;
      shift = next;
      for (const e of els) setShift(e, axis, shift);
    }
    return shift;
  }

  // The Align panel's choices preview right away on every selected element (one undo step per change). None
  // removes that axis's element alignment; an element alignment replaces a guide alignment on the same axis.
  function previewAlign() {
    const U = P.alignUi;
    if (!P.els.length || isRegionPop()) { renderAlign(); return; }
    const refEl = U.ref?.el?.isConnected ? U.ref.el : null;
    rememberElement();
    const had = P.els.some((el) => { const r = P.edits.get(el); return r?.alignEl?.x || r?.alignEl?.y; });
    if ((U.h || U.v) && !refEl) { toast('Choose the element to align to first: press Choose, then click it on the page.'); renderAlign(); return; }
    if (refEl && !refOutside(refEl)) { toast('Choose a reference outside your selection.'); renderAlign(); return; }
    if (!U.h && !U.v && !had) { renderAlign(); return; }
    // A sideways placement that would leave the page is refused before anything changes: the earlier valid
    // position (and its Align choices) stay, and one short warning says why.
    if (U.method === 'next') {
      for (const [axis, edge] of [['x', U.h], ['y', U.v]]) {
        const probe = edge ? placeGroup(P.els, axis, U.method, edge, refEl, true) : null;
        if (probe && typeof probe === 'object') { syncAlignUi(); P.alignUi = { ...P.alignUi, hint: overflowWarning(probe.overflow) }; toast(overflowWarning(probe.overflow)); renderAlign(); return; }
      }
    }
    record();
    const group = { id: BL.uid(), size: P.els.length };
    for (const [axis, edge] of [['x', U.h], ['y', U.v]]) {
      if (!edge) {
        for (const el of P.els) visitElement(el, () => { if (P.alignEl?.[axis]) { P.alignEl = { ...P.alignEl, [axis]: null }; P.snap = { ...P.snap, [axis]: 0 }; applySnap(el); } });
        continue;
      }
      for (const el of P.els) visitElement(el, () => {
        Object.keys(P.align).filter((id) => guidesHere().find((g) => g.id === id)?.axis === axis).forEach((id) => { delete P.align[id]; delete P.alignInfo[id]; });
      });
      const shift = placeGroup(P.els, axis, U.method, edge, refEl);
      if (shift === null || typeof shift === 'object') continue;
      for (const el of P.els) visitElement(el, () => { P.alignEl = { x: P.alignEl?.x || null, y: P.alignEl?.y || null, [axis]: { method: U.method, edge, ref: { ...U.ref.info }, shift, group } }; });
    }
    buildAlignRows();
    renderAlign();
    renderAnn();
  }

  // After a CSS change (margin, width, hide, text…) each element alignment is worked out again from the new
  // layout, so the relationship still holds and no old shift is kept or applied twice. Part of the same undo step.
  function realign() {
    if (!S.pop || !P.els.length) return;
    rememberElement();
    const groups = new Map();
    for (const el of P.els) for (const axis of ['x', 'y']) {
      const a = P.edits.get(el)?.alignEl?.[axis];
      if (!a) continue;
      const k = `${axis}|${a.group?.id || BL.cssPath(el)}|${a.ref.selector}`;
      const g = groups.get(k) || { axis, a, els: [] };
      g.els.push(el);
      groups.set(k, g);
    }
    if (!groups.size) return;
    for (const g of groups.values()) {
      const U = P.alignUi;
      const refEl = U.ref?.el?.isConnected && U.ref.info.selector === g.a.ref.selector ? U.ref.el : BL.query(g.a.ref.selector);
      const shift = placeGroup(g.els, g.axis, methodOf(g.a), g.a.edge, refEl);
      if (shift && typeof shift === 'object') { toast(overflowWarning(shift.overflow)); continue; } // keeps the shift it had
      if (shift === null) continue;
      for (const el of g.els) visitElement(el, () => { P.alignEl = { ...P.alignEl, [g.axis]: { ...P.alignEl[g.axis], shift } }; });
    }
    renderAlign();
    renderChanges();
    renderMarks();
  }

  async function pickAlignRef() {
    if (!P.els.length || isRegionPop()) { toast('Select the element(s) to move first.'); renderAlign(); return; }
    const r = await pickOne('Align: click the element to align to. It stays where it is. Esc cancels.', null, { tool: 'Align', step: 'Click the element to align to' });
    if (!r?.el || !S.pop) { renderAlign(); renderAnn(); return; }
    if (!refOutside(r.el)) { toast('Choose an element outside your selection. The reference can’t be one of the elements being moved.'); renderAlign(); return; }
    const { label, selector, text } = targetInfo(r.el);
    P.alignUi = { ...P.alignUi, mode: 'element', ref: { el: r.el, info: { label, selector, text } } };
    if (P.alignUi.h || P.alignUi.v) previewAlign(); else { renderAlign(); renderAnn(); }
  }

  // Place next to puts the selection outside the reference, so Center and Middle together (which would cover it)
  // aren't offered there; the previous placement stays and the message points to Align edges.
  function chooseAlign(next) {
    if (next.method === 'next' && next.h === 'center' && next.v === 'middle') {
      const msg = 'Center and Middle together would put it on top of the reference. To center on both axes, use Align edges.';
      P.alignUi = { ...P.alignUi, hint: msg };
      toast(msg);
      renderAlign();
      return;
    }
    P.alignUi = next;
    previewAlign();
  }

  // Switching method keeps each method's own choices for this note and previews the other method's choices.
  function setAlignMethod(method) {
    const U = P.alignUi;
    if (U.method === method) return;
    const memo = { ...(U.memo || {}), [U.method]: { h: U.h, v: U.v } };
    const next = memo[method] || { h: '', v: '' };
    P.alignUi = { ...U, method, memo, h: next.h, v: next.v };
    previewAlign();
  }

  // Removes the element alignment from every selected element (both axes).
  function clearElementAlign() {
    rememberElement();
    if (!P.els.some((el) => { const r = P.edits.get(el); return r?.alignEl?.x || r?.alignEl?.y; })) return;
    record();
    for (const el of P.els) visitElement(el, () => {
      for (const axis of ['x', 'y']) if (P.alignEl?.[axis]) P.snap = { ...P.snap, [axis]: 0 };
      P.alignEl = null;
      applySnap(el);
    });
    P.alignUi = { ...P.alignUi, h: '', v: '' };
    renderAlign();
    renderAnn();
  }

  // Removes one axis of an element alignment (the Changes list ✕): from every element aligned together with it.
  function removeElementAlign(axis) {
    const a = P.alignEl?.[axis];
    if (!P.el || !a) return;
    record();
    const cur = P.el;
    for (const el of P.els) visitElement(el, () => {
      const b = P.alignEl?.[axis];
      if (!b || !(el === cur || (a.group?.id && b.group?.id === a.group.id))) return;
      P.alignEl = { ...P.alignEl, [axis]: null };
      P.snap = { ...P.snap, [axis]: 0 };
      applySnap(el);
    });
    syncAlignUi();
    renderAlign();
    renderAnn();
  }

  // The Align panel's choices follow the element being edited after Undo, a ✕ in Changes, or a guide.
  function syncAlignUi() {
    rememberElement();
    const U = P.alignUi;
    const own = P.alignEl?.x || P.alignEl?.y ? P.alignEl : null;
    const a = own || [...P.els].map((el) => P.edits.get(el)?.alignEl).find((x) => x?.x || x?.y);
    if (!a) { P.alignUi = { ...U, h: '', v: '', hint: '' }; return; }
    const any = a.x || a.y;
    const keepRef = U.ref && U.ref.info.selector === any.ref.selector;
    P.alignUi = { ...U, method: methodOf(any), h: a.x?.edge || '', v: a.y?.edge || '', hint: '', ref: keepRef ? U.ref : { info: { ...any.ref }, el: BL.query(any.ref.selector) } };
  }

  // A reopened note shows the element alignment it was saved with.
  function restoreAlignUi() {
    rememberElement();
    for (const r of [P.edits.get(P.el), ...P.edits.values()]) {
      const a = r?.alignEl;
      const any = a?.x || a?.y;
      if (!any) continue;
      P.alignUi = { mode: 'element', method: methodOf(any), memo: {}, ref: { info: { ...any.ref }, el: BL.query(any.ref.selector) }, h: a.x?.edge || '', v: a.y?.edge || '' };
      return;
    }
  }

  // "Placed below and to the right of button#cta." / "Aligned the top edge and the horizontal center with …"
  function alignStatus(a) {
    const [one, two] = [a.y, a.x].filter(Boolean);
    if (two && (methodOf(one) !== methodOf(two) || one.ref.selector !== two.ref.selector)) return `${alignStatus({ y: one })} ${alignStatus({ y: two })}`;
    const axes = { x: a.x?.edge, y: a.y?.edge };
    if (methodOf(one) === 'next') return `Placed ${[axes.y, axes.x].filter(Boolean).map((p) => NEXT_WORD[p]).join(' and ')} ${one.ref.label}.`;
    return `Aligned ${alignPhrase(axes)} with ${one.ref.label}.`;
  }

  function renderAlign() {
    const U = P.alignUi;
    if (!q('.al-element')) return;
    for (const b of qa('[data-al-mode]')) b.setAttribute('aria-pressed', String(b.dataset.alMode === U.mode));
    q('.al-guides').hidden = U.mode !== 'guides';
    q('.al-element').hidden = U.mode !== 'element';
    for (const b of qa('[data-al-method]')) b.setAttribute('aria-pressed', String(b.dataset.alMethod === U.method));
    for (const box of qa('.al-axes')) {
      box.hidden = box.dataset.alFor !== U.method;
      for (const b of box.querySelectorAll('[data-al-h]')) b.setAttribute('aria-pressed', String(!box.hidden && b.dataset.alH === U.h));
      for (const b of box.querySelectorAll('[data-al-v]')) b.setAttribute('aria-pressed', String(!box.hidden && b.dataset.alV === U.v));
    }
    const refBox = q('.al-ref');
    refBox.textContent = U.ref ? `${U.ref.info.label}${U.ref.info.text ? ` · ${U.ref.info.text}` : ''}${U.ref.el?.isConnected ? '' : ' (not found on the page)'}` : 'None chosen';
    refBox.classList.toggle('set', !!U.ref);
    refBox.title = U.ref?.info.selector || '';
    const pick = q('[data-x="al-pick"]');
    pick.textContent = U.ref ? 'Change' : 'Choose';
    pick.title = U.ref ? 'Choose a different element to align to' : 'Click an element on the page to align to. It stays where it is';
    rememberElement();
    const aligned = P.els.some((el) => { const r = P.edits.get(el); return r?.alignEl?.x || r?.alignEl?.y; });
    q('[data-x="al-clear"]').hidden = !aligned;
    const n = P.els.length;
    const reason = !n || isRegionPop() ? 'Select the element(s) to move first.'
      : !U.ref ? 'Choose the element to align to: press Choose, then click it on the page.'
        : !U.ref.el?.isConnected ? 'The reference isn’t on the page right now. Press Change to choose another.' : '';
    const cur = P.alignEl;
    const now = cur?.x || cur?.y ? `${alignStatus(cur)} The reference stays where it is.` : '';
    const who = n === 1 ? 'the selected element' : `all ${n} selected elements together, keeping their spacing`;
    const idle = U.method === 'next' ? `Choose a side to place ${who} just outside the reference. Adjust spacing with Edit CSS.` : `Choose an edge or center to line up ${who} with the reference. It previews right away.`;
    const status = q('.al-status');
    status.textContent = reason || U.hint || now || idle;
    status.classList.toggle('need', !!(reason || U.hint));
  }

  function alignFields() {
    const out = [];
    for (const g of guidesHere()) {
      const edge = P.align[g.id];
      const info = P.alignInfo[g.id];
      if (!edge || !info) continue;
      out.push({ guideId: g.id, guide: g.name, axis: g.axis, edge, guidePos: Math.round(g.pos), offset: info.offset, shift: info.shift });
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
      // The note being edited shows its current selection, so a removed element's outline goes at once.
      const els = S.pop && P.item?.id === it.id ? P.els : targetsOf(it);
      els.forEach((el, i) => { const n = slotOf.get(el) || 0; slotOf.set(el, n + 1); specs.push({ k: `${it.id}:${i}`, num: idx + 1, id: it.id, cls, el, slot: n }); });
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
    // the element alignment reference, while the Align panel shows it
    const rf = S.pop && shownTool() === 'align' && P.alignUi.mode === 'element' && P.alignUi.ref?.el?.isConnected ? P.alignUi.ref.el : null;
    let rb = box.querySelector('.refb');
    if (!rf) rb?.remove();
    else {
      if (!rb) { rb = mk('<div class="refb"><span class="hl-tag">Reference</span></div>'); box.appendChild(rb); }
      const r = rf.getBoundingClientRect();
      Object.assign(rb.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      rb.querySelector('.hl-tag').classList.toggle('below', r.top < 24);
    }
    // selection boxes while composing
    const sb = [];
    if (S.pop && !isRegionPop()) P.els.forEach((el, i) => sb.push({ k: `s${i}`, el, cur: P.els.length > 1 && el === P.el }));
    for (const n of [...box.querySelectorAll('.selb')]) if (!sb.some((s) => s.k === n.dataset.k)) n.remove();
    for (const s of sb) {
      let n = box.querySelector(`.selb[data-k="${s.k}"]`);
      if (!n) { n = document.createElement('div'); n.className = 'selb'; n.dataset.k = s.k; box.appendChild(n); }
      const r = s.el.getBoundingClientRect();
      n.classList.toggle('cur', !!s.cur);
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
    const list = [];
    // "Outlines: off" hides other notes' drawings, never the marks being drawn or edited now.
    // Saved notes show their selection with outlines and badges; their area-selection boxes are left off.
    if (S.prefs.marks !== 'badges') for (const it of itemsHere()) { if (S.pop?.item?.id === it.id) continue; (it.marks || []).forEach((m) => { if (!m.auto) list.push(m); }); }
    // The dragged area's box marks an empty-area note on the page. When the drag selected elements, their
    // outlines already show the selection, so the box is kept for the marked-up screenshot but not drawn here.
    (P.marks || []).forEach((m) => { if (!m.auto || !P.els.length) list.push(m); });
    if (D.cur) list.push(D.cur);
    for (const s of list) g.appendChild(svgShape(s));
    const selected = D.tool === 'edit' ? P.marks[D.selected] : null;
    if (selected?.t === 'arrow') for (const p of [selected.a, selected.b]) {
      const handle = document.createElementNS(SVGNS, 'circle');
      Object.entries({ cx: p.x, cy: p.y, r: 7, fill: '#fff', stroke: selected.c, 'stroke-width': 2 }).forEach(([k, v]) => handle.setAttribute(k, v));
      g.appendChild(handle);
    }
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
    if (S.prefs.marks !== 'badges') for (const it of itemsHere()) for (const edit of it.elementEdits || []) if (edit.move) draw(BL.query(edit.el.selector), BL.query(edit.move.to.selector), edit.move.position);
    if (S.pop) { rememberElement(); for (const [el, r] of P.edits) if (r.move) draw(el, r.move.toEl, r.move.position); }
  }

  function renderAnn() {
    if (!S.ui) return;
    syncPlaceholder();
    renderGuides();
    renderMarks();
    renderDrawn();
    renderArrows();
    showNoteMeasurement();
    if (T.simEls) renderSim();
    const rg = S.pop?.region;
    if (rg) {
      const r = regionRect({ region: rg });
      const dr = q('.dr');
      dr.hidden = false;
      dr.classList.add('set');
      Object.assign(dr.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      dr.querySelector('.sz').textContent = `${rg.w}×${rg.h}`;
    }
  }

  const ONBOARD = `<b>How it works</b>
    <div class="step"><i>1</i><span>Press <b>Add note</b>, or start from the page with <b>Select element</b> or <b>Select area</b>.</span></div>
    <div class="step"><i>2</i><span>Say what should change. Try values live if you like.</span></div>
    <div class="step"><i>3</i><span>When you have all your notes, press <b>Export prompt</b> and share it with a developer or AI assistant.</span></div>`;

  const MODE_NAME = { shopify: 'a Shopify theme', next: 'a Next.js app', react: 'a React app', html: 'plain HTML/CSS/JS' };

  const uiType = (it) => (BL.TYPES.find((t) => t.id === it.type) || {}).ui || BL.typeLabel(it.type);
  function metaText(it) {
    const where = it.kind === 'region' ? `empty area ${it.region.w}×${it.region.h}` : it.kind === 'page' ? 'whole page' : it.el.label;
    const bits = [`${uiType(it)} · ${where}`];
    if (it.also?.length) bits.push(`+${it.also.length} more`);
    if (it.marks?.some((m) => !m.auto)) bits.push('drawn on');
    if (it.path !== here()) bits.unshift(it.path);
    return bits.join(' · ');
  }

  hooks.afterRender = () => {
    applyPanelPos();
    updateToolbar();
    renderAnn();
    applyAllPreviews();
    const empty = q('.empty');
    if (empty && !empty.dataset.init) { empty.dataset.init = '1'; empty.innerHTML = ONBOARD; }
    const mode = q('.mode');
    if (mode) mode.title = `Blueline detected ${MODE_NAME[BL.modeOf(S.page)]} on this page`;
    const ex = q('[data-act="export"]');
    if (ex) ex.title = 'Build one change request from all your notes, ready to share with a developer or AI assistant';
    for (const li of qa('.list .item')) {
      const it = BL.findItem(li.dataset.id);
      const meta = li.querySelector('.meta');
      if (!it || !meta) continue;
      meta.textContent = metaText(it);
      const note = li.querySelector('.note');
      if (note && !it.note) { note.textContent = noteSummary(it) + (isReference(it) ? ' (reference only)' : ''); note.classList.add('auto-note'); }
    }
  };
  hooks.onSchedule = () => { renderAnn(); applyAllPreviews(); };

  // ------------------------------------------------------------------ drawing on the page

  function startDrawing(tool) {
    setAnnotate(false, true);
    cancelTools();
    D.selected = null; D.drag = null;
    D.tool = D.tool === tool ? null : tool;
    renderDrawn();
    syncDrawUi();
    syncCursor();
    if (D.tool) showBar(D.tool === 'edit' ? 'Click an arrow. Drag either endpoint or its body. Choose a color or Delete selected arrow. Esc ends editing.' : D.tool === 'text' ? 'Click where the text should go. Esc stops drawing.' : 'Drag on the page to draw. Esc stops drawing.'); else hideBar();
  }

  function stopDrawing() {
    if (!D.tool && !D.cur) return;
    D.tool = null;
    if (D.drag && P.marks[D.selected]) P.marks[D.selected] = D.drag.before; // Esc mid-drag puts the arrow back
    D.cur = null; D.selected = null; D.drag = null;
    renderDrawn();
    hideBar();
    syncCursor();
    syncDrawUi();
  }

  function syncDrawUi() {
    setOn('draw-edit', D.tool === 'edit');
    const del = q('[data-x="draw-delete"]'); if (del) del.disabled = !P.marks[D.selected] || D.tool !== 'edit';
    for (const b of qa('[data-draw]')) b.classList.toggle('on', b.dataset.draw === D.tool);
    for (const b of qa('[data-dc]')) b.classList.toggle('on', b.dataset.dc === D.color);
    const custom = q('.draw-custom');
    if (custom) custom.value = /^#[0-9a-f]{6}$/i.test(D.color) ? D.color : GUIDE;
    const s = q('.draw-sum');
    const drawn = P.marks.filter((m) => !m.auto).length;
    if (s) s.textContent = drawn ? `${drawn} drawing${drawn === 1 ? '' : 's'}` : '';
  }

  function drawMouse(e) {
    const p = { x: e.clientX + scrollX, y: e.clientY + scrollY };
    if (D.tool === 'edit') { editArrowPointer(e, p); return; }
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
      if (size > (c.t === 'pen' ? 3 : 6)) { record(); P.marks.push(c); P.marksDirty = true; }
      syncDrawUi();
      renderAnn();
    }
  }

  function arrowHit(mark, p) {
    for (const key of ['a', 'b']) if (Math.hypot(p.x - mark[key].x, p.y - mark[key].y) <= 12) return key;
    const dx = mark.b.x - mark.a.x, dy = mark.b.y - mark.a.y;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((p.x - mark.a.x) * dx + (p.y - mark.a.y) * dy) / len)) : 0;
    return Math.hypot(p.x - mark.a.x - t * dx, p.y - mark.a.y - t * dy) <= 10 ? 'body' : null;
  }
  function editArrowPointer(e, p) {
    if (e.type === 'pointerdown' && e.button === 0) {
      D.selected = null; D.drag = null;
      for (let i = P.marks.length - 1; i >= 0; i--) {
        const mark = P.marks[i];
        if (mark.t !== 'arrow' || mark.auto) continue;
        const part = arrowHit(mark, p);
        if (part) { D.selected = i; D.color = mark.c; D.drag = { part, origin: p, before: JSON.parse(JSON.stringify(mark)), snap: snapshot() }; break; }
      }
    } else if (e.type === 'pointermove' && D.drag) {
      const mark = P.marks[D.selected], d = D.drag;
      const dx = p.x - d.origin.x, dy = p.y - d.origin.y;
      for (const key of ['a', 'b']) if (d.part === key || d.part === 'body') mark[key] = { x: d.before[key].x + dx, y: d.before[key].y + dy };
    } else if (e.type === 'pointercancel' && D.drag) { P.marks[D.selected] = D.drag.before; D.drag = null; }
    else if (e.type === 'pointerup' && D.drag) endArrowDrag();
    syncDrawUi(); renderDrawn();
  }
  // A finished arrow drag is one undo step, recorded only if the arrow actually moved.
  function endArrowDrag() {
    const d = D.drag;
    D.drag = null;
    if (!d) return;
    if (JSON.stringify(P.marks[D.selected]) !== JSON.stringify(d.before)) { pushSnapshot(d.snap); P.marksDirty = true; }
  }
  function setDrawingColor(color) {
    D.color = color;
    if (D.tool === 'edit' && P.marks[D.selected]?.t === 'arrow' && P.marks[D.selected].c !== color) { record('arrow-color'); P.marks[D.selected].c = color; P.marksDirty = true; renderDrawn(); }
    syncDrawUi();
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
      if (ev.key === 'Enter' && inp.value.trim()) { record(); P.marks.push({ t: 'text', c: D.color, p, s: inp.value.trim() }); P.marksDirty = true; kill(); syncDrawUi(); renderAnn(); }
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
      // Saving reloads S.batch from storage, so flag the current copy of the note, not the one passed in.
      const fresh = BL.findItem(it.id) || it;
      fresh.hasMarkup = true;
      fresh.markupPath = undefined;
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
    record();
    P.move = { to: targetInfo(dst.el), toEl: dst.el, position: positionFor(dst) };
    renderStrips();
    renderAnn();
  }

  // ------------------------------------------------------------------ strips (move, match, text, measures, colors, variant)

  // Measurement overlay is deliberately visible only while its note is open.
  function renderMeasurePanel() {
    const box = q('.tool-measure-list');
    if (!box) return;
    const sec = q('.tb-measure');
    if (sec) sec.hidden = !(P.measures.length || T.measureOpen) || !canMeasure();
    const add = q('[data-x="measure-new"]');
    if (add) add.disabled = !canMeasure();
    const pair = q('.measure-pair');
    if (pair) {
      pair.hidden = P.els.length < 3;
      if (!pair.hidden) {
        const cur = Math.max(0, P.els.indexOf(P.el));
        const opts = (sel) => P.els.map((el, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${i + 1}: ${esc(elName(el))}</option>`).join('');
        pair.innerHTML = `<span class="sub">Measure between</span><select class="xin m-from" aria-label="Measure from">${opts(cur)}</select><span class="sub">and</span><select class="xin m-to" aria-label="Measure to">${opts(cur === 0 ? 1 : 0)}</select><button type="button" class="xb" data-x="measure-pair" title="Measure the distance between the two chosen elements">Measure</button>`;
      }
    }
    // One measurement is drawn at a time: the one selected in this list (a new measurement is selected when it is
    // made). Pressing another row draws that one instead. There is no Hide: Toolbox → Hide is for page elements.
    const shownIdx = visibleMeasureIndex ?? P.measures.length - 1;
    box.innerHTML = P.measures.length ? P.measures.map((m, i) => `
      <div class="measure-row${shownIdx === i ? ' current' : ''}">
        <button type="button" class="measure-pick" data-x="measure-show" data-i="${i}" aria-pressed="${shownIdx === i}" title="Show this measurement on the webpage">
          <strong>${i + 1}. ${esc(m.label)}</strong>
          <span class="sub">${esc(m.summary)}</span>
        </button>
        <div class="measure-actions">
          <button type="button" class="xb" data-x="measure-change" data-i="${i}" ${P.el ? '' : 'disabled'} title="Choose another second element without changing the original selected element">Change target</button>
          <button type="button" class="xb" data-x="rm-measure" data-i="${i}" title="Remove this measurement from the note">Remove</button>
        </div>
      </div>`).join('') : `<div class="sub">${P.els.length >= 3 ? 'No measurements yet. Choose two selected elements above.' : 'No measurements yet.'}</div>`;
  }

  function syncToolPanels() {
    if (!S.ui) return;
    for (const btn of qa('.tool-main')) btn.setAttribute('aria-pressed', String(shownTool() === btn.dataset.tool));
    for (const p of qa('[data-tool-panel]')) p.hidden = p.dataset.toolPanel !== shownTool();
    const mb = q('[data-x="tb-measure"]');
    if (mb) {
      if (!mb.dataset.readyTitle) mb.dataset.readyTitle = mb.title;
      mb.disabled = !canMeasure();
      mb.title = mb.disabled ? (isRegionPop() ? 'Measuring needs elements. This note marks an empty area.' : 'Open this note’s page to measure.') : mb.dataset.readyTitle;
    }
    renderMeasurePanel();
    if (activeTool === 'align') { buildAlignRows(); renderAlign(); }
    renderMarks();
  }

  // Keeps `anchor` (the control just pressed, or the ribbon) at the same place on screen while part of the
  // note changes height. Only the note's own scroll is adjusted, never the page. When the new content is
  // shorter, the browser would clamp that scroll and pull everything down, so a spacer at the end of the
  // note holds the height until the next change.
  function holdPosition(anchor, change) {
    const pop = q('.pop');
    const spacer = q('.pop-spacer');
    if (!pop || !anchor || !spacer || pop.hidden) { change(); return; }
    const top = anchor.getBoundingClientRect().top;
    spacer.style.height = '0px';
    change();
    if (!anchor.isConnected) return;
    const want = pop.scrollTop + anchor.getBoundingClientRect().top - top;
    const max = pop.scrollHeight - pop.clientHeight;
    if (want > max) spacer.style.height = `${Math.ceil(want - max)}px`;
    pop.scrollTop = Math.max(0, want);
  }

  // Toolbox is the default mode: no other tool active means the Toolbox shows. Pressing the active tool
  // again goes back to the Toolbox.
  const shownTool = () => activeTool || 'elements';
  function activateTool(name) {
    const next = name === 'elements' || activeTool === name ? null : name;
    if (next !== 'draw') stopDrawing();
    holdPosition(q('.tool-ribbon'), () => { activeTool = next; syncToolPanels(); });
  }

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
    const samples = q('.sampled-colors');
    samples.innerHTML = P.colors.map((c, i) => `<div class="strip"><span><span class="swatch" style="background:${esc(c)}"></span>${esc(c)}</span><button class="xb" data-x="color-copy" data-i="${i}" title="Copy this hex color">Copy</button><button class="xb" data-x="color-remove" data-i="${i}" title="Remove this sampled color">Remove</button></div>`).join('');
    if (P.variant) {
      const v = P.variant;
      const sr = sheet && v.sku ? sheet.rows.find((r) => r.sku === v.sku) : null;
      rows.push(`<div class="strip"><span>Variant <b>${esc(v.title)}</b> · ${esc(v.handle)} · $${v.price.toFixed(2)}${sr ? ` · sheet $${sr.price.toFixed(2)}${Math.abs(sr.price - v.price) >= 0.005 ? ' (differs)' : ''}` : ''}</span>${rm('rm-variant')}</div>`);
    }
    box.innerHTML = rows.join('');
    renderChanges();
  }

  // ------------------------------------------------------------------ event delegation

  function onClick(e) {
    if (e.target.classList && e.target.classList.contains('xmodal')) { e.target.hidden = true; return; }
    if (e.target.closest('[data-act="side"]')) { sessionPos = null; applyPanelPos(); return; }
    const chip = e.target.closest('[data-bp]');
    if (chip) {
      if (chip.dataset.bp === 'all') {
        const all = ['mobile', 'tablet', 'desktop'].every((b) => P.bps.has(b));
        P.bps = new Set(all ? [bpNow()] : ['mobile', 'tablet', 'desktop']);
      } else if (P.bps.has(chip.dataset.bp)) { if (P.bps.size > 1) P.bps.delete(chip.dataset.bp); } else P.bps.add(chip.dataset.bp);
      syncChips();
      return;
    }
    const al = e.target.closest('[data-al-mode],[data-al-method],[data-al-h],[data-al-v]');
    if (al) {
      const U = P.alignUi;
      if (al.dataset.alMode) {
        holdPosition(al, () => { P.alignUi = { ...U, mode: al.dataset.alMode }; renderAlign(); renderMarks(); });
        // Element: with no reference yet, the next click on the page chooses it.
        if (al.dataset.alMode === 'element' && !U.ref?.el?.isConnected && P.els.length && !isRegionPop()) pickAlignRef();
      } else if (al.dataset.alMethod) holdPosition(al, () => setAlignMethod(al.dataset.alMethod));
      else if ('alH' in al.dataset) { if (al.dataset.alH !== U.h) chooseAlign({ ...U, h: al.dataset.alH, hint: '' }); }
      else if (al.dataset.alV !== U.v) chooseAlign({ ...U, v: al.dataset.alV, hint: '' });
      if (S.pop) renderElementEditor();
      return;
    }
    const dt = e.target.closest('[data-draw]');
    if (dt) { startDrawing(dt.dataset.draw); return; }
    const dc = e.target.closest('[data-dc]');
    if (dc) { setDrawingColor(dc.dataset.dc); return; }
    const b = e.target.closest('[data-x]');
    if (!b || b.tagName === 'INPUT') return;
    const x = b.dataset.x;
    switch (x) {
      case 'add-note': if (!S.pop) BL.openPop(null, null, { page: true, els: [] }); q('.pop-note').focus(); setTimeout(revealDescribe, 0); break;
      case 'start-select': case 'sel-element': startSelect(false); break;
      case 'start-area': case 'sel-area': startArea(); break;
      case 'sel-add': startSelect(true); break;
      case 'guides': { const gb = q('.x-guidebox'); gb.hidden = !gb.hidden; setOn('guides', !gb.hidden); break; }
      case 'overlay': toggleOverlayPanel(); break;
      case 'sheet': openSheet(); break;
      case 'previews': S.prefs.previews = S.prefs.previews === false; BL.savePrefs(); applyAllPreviews(); updateToolbar(); break;
      case 'undo': undoAction(); break;
      case 'marks': S.prefs.marks = S.prefs.marks === 'badges' ? 'full' : 'badges'; BL.savePrefs(); updateToolbar(); renderAnn(); break;
      case 'bar-cancel': if (T.pick) endPick(null); else if (D.tool) stopDrawing(); else if (A.on) setAnnotate(false); break;
      case 'g-v': addGuide('x'); break;
      case 'g-h': addGuide('y'); break;
      case 'g-show': S.prefs.guidesHidden = !S.prefs.guidesHidden; BL.savePrefs(); renderAnn(); updateToolbar(); break;
      case 'g-eye': { const g = (S.batch?.guides || []).find((x2) => x2.id === b.dataset.id); if (g) { g.hidden = !g.hidden; BL.saveBatch(); renderAnn(); renderGuideList(); } break; }
      case 'g-del': removeGuide(b.dataset.id); break;
      case 'mk-open': { const it = BL.findItem(b.dataset.id); if (!it) break; if (S.pop) toast('Save or cancel the note you\u2019re editing first.'); else hooksFocus(it); break; }
      case 'sel-clear': clearSelection(); break;
      case 'sel-rm': removeSelected(+b.dataset.i); break;
      case 'sel-rm-missing': removeMissing(+b.dataset.i); break;
      case 'dictate': toggleDictation(); break;
      case 'edittext': startEditText(); break;
      case 'tb-measure': holdPosition(b, () => { T.measureOpen = true; renderMeasurePanel(); }); startMeasureFlow(); break;
      case 'sel-showall': holdPosition(q('.x-sel'), () => { T.selOpen = !T.selOpen; renderSel(); }); break;
      case 'al-pick': pickAlignRef(); break;
      case 'al-clear': clearElementAlign(); break;
      case 'alel-rm': removeElementAlign(b.dataset.axis); break;
      case 'css-rm': removeTweak(b.dataset.prop); break;
      case 'hide': togglePopHide(); break;
      case 'match': startMatch(); break;
      case 'measure-to': case 'measure-new': if (P.el) startMeasureTo(); else startMeasureFlow(); break;
      case 'measure-pair': measureChosenPair(); break;
      case 'tool-draw': activateTool('draw'); break;
      case 'tool-css': activateTool('css'); break;
      case 'tool-align': activateTool('align'); break;
      case 'tool-elements': activateTool('elements'); break;
      case 'measure-show': visibleMeasureIndex = +b.dataset.i; renderMeasurePanel(); renderAnn(); break;
      case 'measure-change': changeMeasureTarget(+b.dataset.i); break;
      case 'pop-color': dropper((hex) => { record(); P.colors.push(hex); copyText(hex); renderStrips(); toast(`${hex} copied`); }); break;
      case 'st-drop': { const row = b.closest('.st'); dropper((hex) => { row.querySelector('.sv').value = hex; styleInput(row, hex); }); break; }
      case 'st-dec': case 'st-inc': { const row = b.closest('.st'); const inp = row.querySelector('.sv'); styleInput(row, stepVal(row.dataset.prop, inp.value || row.dataset.from || row.dataset.base, x === 'st-inc' ? 1 : -1, e.shiftKey)); inp.value = rowValue(row); break; }
      case 'css-add': if (q('.css-add-box').hidden) openAddProp(); else closeAddProp(); break;
      case 'css-add-pick': addCssProp(b.dataset.prop); break;
      case 'css-row-rm': removeAddedRow(b.closest('.st')); break;
      case 'css-rule-pick': chooseRule(b.dataset.key); break;
      case 'style-reset': record(); resetStyles(); realign(); renderAnn(); break;
      case 'snap': snapTo(b.dataset.g, b.dataset.edge); break;
      case 'align-go': snapTo(b.dataset.g, b.closest('.strip').querySelector('.align-edge').value); break;
      case 'align-clear': snapTo(b.dataset.g, P.align[b.dataset.g], true); break;
      case 'edit-element': holdPosition(q('.x-sel'), () => chooseElement(+b.dataset.i)); break;
      case 'move-here': moveHere(); break;
      case 'draw-edit': startDrawing('edit'); break;
      case 'draw-delete': if (D.tool === 'edit' && P.marks[D.selected]) { record(); P.marks.splice(D.selected, 1); D.selected = null; P.marksDirty = true; syncDrawUi(); renderAnn(); } break;
      case 'draw-undo': if (!P.marks.length) break; record(); D.selected = null; P.marks.pop(); P.marksDirty = true; syncDrawUi(); renderAnn(); break;
      case 'draw-clear': if (!P.marks.length) break; record(); D.selected = null; P.marks = []; P.marksDirty = true; syncDrawUi(); renderAnn(); break;
      case 'rm-move': record(); P.move = null; renderStrips(); renderAnn(); break;
      case 'rm-match': record(); P.match = null; renderStrips(); break;
      case 'match-apply': record(); if (q('.match-all')?.checked) applyMatchToAll(); else applyMatchPreview(); realign(); break;
      case 'rm-text': record(); if (P.el && P.textEdit && !P.el.children.length) P.el.textContent = P.textEdit.before; P.textEdit = null; renderStrips(); realign(); break;
      case 'rm-measure': record(); P.measures.splice(+b.dataset.i, 1); visibleMeasureIndex = P.measures.length ? P.measures.length - 1 : null; renderMeasurePanel(); renderAnn(); break;
      case 'color-copy': copyText(P.colors[+b.dataset.i]); toast('Color copied'); break;
      case 'color-remove': record(); P.colors.splice(+b.dataset.i, 1); renderStrips(); break;
      case 'rm-colors': record(); P.colors = []; renderStrips(); break;
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
    if (S.pop) { renderElementEditor(); updatePrerequisites(); }
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
    if (t.classList.contains('draw-custom')) { setDrawingColor(t.value); return; }
    if (t.classList.contains('sv')) { styleInput(t.closest('.st'), t.value); return; }
    if (t.classList.contains('css-add-q')) { renderAddResults(); return; }
    if (t.classList.contains('sw')) { const row = t.closest('.st'); row.querySelector('.sv').value = t.value; styleInput(row, t.value); return; }
    if (t.classList.contains('figma-in')) { P.figma = t.value.trim(); return; }
    if (t.classList.contains('var-q')) { clearTimeout(varT); varT = setTimeout(() => variantSearch(t.value.trim()), 300); return; }
    if (t.dataset.ov) onOverlayInput(t);
  }

  function onChange(e) {
    const t = e.target;
    if (t.classList.contains('element-choice')) { holdPosition(q('.element-editor'), () => chooseElement(+t.value)); return; }
    if (t.classList.contains('css-rule')) { chooseRule(t.value); return; }
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
      styleInput(row, stepVal(row.dataset.prop, t.value || row.dataset.from || row.dataset.base, e.key === 'ArrowUp' ? 1 : -1, e.shiftKey));
      t.value = rowValue(row);
    } else if (t.classList?.contains('css-add-q')) {
      if (e.key === 'Enter') { e.preventDefault(); const first = q('.css-add-opt'); if (first) addCssProp(first.dataset.prop); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAddProp(); q('[data-x="css-add"]').focus({ preventScroll: true }); } else if (e.key === 'ArrowDown') { e.preventDefault(); q('.css-add-opt')?.focus({ preventScroll: true }); }
    } else if (t.classList?.contains('css-add-opt') && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Escape')) {
      e.preventDefault();
      if (e.key === 'Escape') { e.stopPropagation(); closeAddProp(); q('[data-x="css-add"]').focus({ preventScroll: true }); return; }
      const next = e.key === 'ArrowDown' ? t.nextElementSibling : t.previousElementSibling;
      (next || (e.key === 'ArrowUp' ? q('.css-add-q') : null))?.focus({ preventScroll: true });
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
    if (!P.el) { toast('Select an element first.'); return; }
    record();
    P.hide = !P.hide;
    // Showing it again puts back the page's display, then any display value set in Edit CSS.
    if (!P.hide) restoreInline(P.el, 'display');
    paintCss(P.el, P);
    updateHideButton();
    realign();
    renderAnn();
  }

  function startEditText() {
    const el = P.el;
    if (!el || editing) { toast('Select an element first.'); return; }
    if (el.children.length) { toast('This element has other elements inside. Select the text element itself.'); return; }
    const before = P.textEdit ? P.textEdit.before : el.textContent.trim();
    editing = { el, before };
    q('.panel').style.visibility = 'hidden';
    el.contentEditable = 'plaintext-only';
    el.focus({ preventScroll: true });
    const er = el.getBoundingClientRect();
    if (er.bottom < 0 || er.top > innerHeight) el.scrollIntoView({ block: 'nearest' });
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
    if (keep && after && after !== before) { record(); P.textEdit = { before, after }; }
    else { el.textContent = P.textEdit ? P.textEdit.after : before; if (!P.textEdit) P.textEdit = null; }
    realign();
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
    record();
    P.match = { label: info.label, selector: info.selector, src: info.src, diffs: diffs.slice(0, 12) };
    if (q('.match-all')?.checked) for (const el of P.els) visitElement(el, () => {
      const style = getComputedStyle(el);
      P.match = { ...info, diffs: MATCH_PROPS.map((prop) => ({ prop, from: style.getPropertyValue(prop).trim(), to: b.getPropertyValue(prop).trim() })).filter((d) => d.from !== d.to).slice(0, 12) };
    });
    renderStrips();
    toast(diffs.length ? `${diffs.length} difference${diffs.length === 1 ? '' : 's'} found. Tap Preview to try them.` : 'These already look identical.');
  }

  function applyMatchToAll() {
    const reference = P.match;
    const target = reference?.selector ? BL.query(reference.selector) : null;
    if (!target) { toast('Pick a match-style reference element first.'); return; }
    const targetStyle = getComputedStyle(target);
    const values = MATCH_PROPS.map((prop) => ({ prop, to: targetStyle.getPropertyValue(prop).trim() }));
    for (const el of P.els) visitElement(el, () => {
      const style = getComputedStyle(el);
      P.match = { ...reference, diffs: values.map(({ prop, to }) => ({ prop, to, from: style.getPropertyValue(prop).trim() })).filter((d) => d.from !== d.to).slice(0, 12) };
      applyMatchPreview();
    });
    loadCompose();
  }

  function applyMatchPreview() {
    if (!P.match || !P.el) return;
    const tw = BL.stylingOf(P.el).includes('tailwind');
    for (const d of P.match.diffs) {
      if (d.prop === 'margin') continue;
      setInline(P.el, d.prop, d.to);
      P.tweaks[d.prop] = { prop: d.prop, from: d.from, to: d.to, token: tokenHint(d.prop, d.to, tw), via: 'match' };
    }
    buildStyleRows();
  }

  // Changing a measurement target keeps the note's source element unchanged.
  // Escape leaves the previous target and saved measurement intact.
  async function changeMeasureTarget(index) {
    if (!P.el || !P.measures[index]) return;
    const source = P.el;
    const picked = await pickOne('Click a different measurement target. Esc keeps the previous target.',
      (el) => { if (el && el !== source) drawMeasure(source.getBoundingClientRect(), el.getBoundingClientRect()); },
      { tool: 'Measure', step: 'Select the new target' });
    if (!picked || !picked.el || picked.el === source || !S.pop) { renderAnn(); return; }
    record();
    const m = measureRects(source.getBoundingClientRect(), picked.el.getBoundingClientRect());
    const info = targetInfo(picked.el);
    P.measures[index] = { label: info.label, selector: info.selector, ...m, summary: measureText(m) };
    visibleMeasureIndex = index;
    activeTool = null;
    T.measureOpen = true;
    syncToolPanels();
    renderAnn();
  }

  const canMeasure = () => !!S.pop && !isRegionPop() && !(P.item && !P.els.length && !P.cleared);

  // Clicking Measure starts right away, based on what is selected:
  // none → pick the first element, then the second; one → pick the second;
  // two → measure between them; three or more → choose the pair in the panel.
  // While picking, the panel steps aside for a compact "Blueline · Measure" toolbar (Cancel or Esc). Cancelling
  // leaves the note as it was: a first element picked only for this measurement is not kept.
  async function startMeasureFlow() {
    if (!canMeasure()) return;
    if (P.els.length >= 3) { renderMeasurePanel(); toast('Choose which two selected elements to measure between.'); return; }
    if (P.els.length === 2) { measureBetween(P.el, P.els.find((e) => e !== P.el)); return; }
    let before = null;
    if (!P.els.length) {
      const first = await pickOne('Measure: click the first element (1 of 2). Esc cancels.', null, { tool: 'Measure', step: 'Select element 1 of 2' });
      if (!first?.el || !S.pop) { renderAnn(); return; }
      before = { page: S.pop.page, cleared: P.cleared };
      setTarget({ els: [first.el] });
      T.measureOpen = true;
      syncToolPanels();
    }
    const done = await startMeasureTo(true);
    if (!done && before && S.pop) {
      setTarget({ els: [] });
      S.pop.page = before.page;
      P.cleared = before.cleared;
      T.measureOpen = true;
      loadCompose();
    }
  }

  async function startMeasureTo(second) {
    if (!P.el) return false;
    const a = P.el;
    const r = await pickOne(`Measure: ${second ? 'click the second element (2 of 2)' : 'click the element to measure to'}. Hover to preview the distance. Esc cancels.`, (el) => { if (el && el !== a) drawMeasure(a.getBoundingClientRect(), el.getBoundingClientRect()); },
      { tool: 'Measure', step: second ? 'Select element 2 of 2' : 'Select the element to measure to' });
    if (!r || !r.el || r.el === a || !S.pop) { renderAnn(); return false; }
    measureBetween(a, r.el);
    return true;
  }

  // Records a measurement on the "from" element (it becomes the instance being edited).
  function measureBetween(a, b) {
    if (!a || !b || a === b) return;
    if (a !== P.el && P.els.includes(a)) chooseElement(P.els.indexOf(a));
    if (a !== P.el) return;
    const info = targetInfo(b);
    activeTool = null; // the measurement shows in the Toolbox
    T.measureOpen = true;
    const existing = P.measures.findIndex((m) => m.selector === info.selector);
    if (existing >= 0) {
      visibleMeasureIndex = existing;
      syncToolPanels();
      renderAnn();
      toast('Already measured. Showing it on the page.');
      return;
    }
    record();
    const m = measureRects(a.getBoundingClientRect(), b.getBoundingClientRect());
    P.measures.push({ label: info.label, selector: info.selector, ...m, summary: measureText(m) });
    visibleMeasureIndex = P.measures.length - 1;
    renderStrips();
    syncToolPanels();
    renderAnn();
    renderElementEditor();
    // Show the result only if it is out of sight below, and only as far as needed (never the page).
    const pop = q('.pop');
    const strip = q('.tool-measure-list');
    const foot = q('.pop-foot');
    if (pop && strip && foot) {
      const below = strip.getBoundingClientRect().top + 60 - foot.getBoundingClientRect().top;
      if (below > 0) pop.scrollTop += below;
    }
  }

  function measureChosenPair() {
    const from = P.els[+q('.m-from')?.value];
    const to = P.els[+q('.m-to')?.value];
    if (!from || !to || from === to) { toast('Choose two different elements.'); return; }
    measureBetween(from, to);
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
    return { label: BL.label(el), selector: BL.cssPath(el), classes: [...el.classList].filter(BL.isStableClass).join(' ') || undefined, text: textOf(el, 40), size: `${Math.round(el.getBoundingClientRect().width)}×${Math.round(el.getBoundingClientRect().height)}`, rendered: rx?.rendered || null, section: sec ? sec.wrapperId : null };
  }

  hooks.collect = (ps) => {
    const region = !!(ps.region || ps.item?.kind === 'region');
    const f = {
      bps: ['mobile', 'tablet', 'desktop'].filter((b) => P.bps.has(b)), figma: P.figma || undefined,
      colors: P.colors.length ? [...P.colors] : undefined,
      marks: P.marks.length ? P.marks.map((m) => JSON.parse(JSON.stringify(m))) : undefined,
      auto: P.auto ? true : undefined,
    };
    const marks = P.marks.slice();
    const marksDirty = P.marksDirty;
    const history = undoStack;
    if (!region && P.el) {
      f.scope = scopeInfo();
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
      f.elementEdits = elementFields();
      for (const key of ['scope', 'tweaks', 'textEdit', 'hidden', 'match', 'move', 'align', 'measures']) f[key] = undefined;
      // Instances whose element isn't on the page stay in the note. When that includes the note's own element,
      // it stays first, so the note keeps its details and the elements found here all go to "also".
      if (P.missing.length) {
        const own = P.missing.find((m) => m.primary);
        const rest = P.missing.filter((m) => !m.primary).map((m) => m.rec);
        if (own) { f.elementEdits = [own.rec, ...f.elementEdits, ...rest]; f.also = [...P.els.map(alsoInfo), ...rest.map((r) => r.el)]; }
        else { f.elementEdits = [...f.elementEdits, ...rest]; f.also = [...(f.also || []), ...rest.map((r) => r.el)]; }
      }
    }
    // Every element left in the note is one that isn't on this page: what remains of the saved instances is
    // written back as it is, so an element removed on purpose stays removed.
    else if (!region && ps.item && P.missingEdited && !P.els.length && ps.item.kind !== 'page' && P.missing.length) {
      const recs = P.missing.map((m) => m.rec);
      f.elementEdits = recs;
      f.also = recs.length > 1 ? recs.slice(1).map((r) => r.el) : undefined;
      if (recs[0].el.selector !== ps.item.el?.selector) f.el = { ...ps.item.el, ...recs[0].el };
      for (const key of ['scope', 'tweaks', 'textEdit', 'hidden', 'match', 'move', 'align', 'measures']) f[key] = undefined;
    }
    const hasContent = !!(changeBits(f).length || refBits(f).length);
    // Inspect the element as the source has it, without our live previews applied.
    const liveEdits = f.elementEdits || [];
    const around = (fn) => {
      if (!liveEdits.length) return fn();
      const apply = (on) => liveEdits.forEach((edit) => applyItemPreview({ ...edit, path: here() }, on));
      apply(false); applyAllPreviews(true);
      try { return fn(); } finally { applyAllPreviews(); apply(true); }
    };
    // A saved note whose first element changed (Shift-click) gets that element's details refreshed.
    const it0 = ps.item;
    if (it0 && !region && P.els[0] && it0.kind !== 'page' && !P.missing.some((m) => m.primary) && BL.cssPath(P.els[0]) !== it0.el?.selector) {
      try { const d = around(() => BL.describe(P.els[0], it0.type)); f.el = d.el; f.styling = d.styling; } catch { /* keep the old details */ }
    }

    return {
      fields: f, hasContent, around,
      commit: () => { P.committed = true; },
      onSaved: async (it) => {
        rememberHistory(it.id, history);
        BL.savePrefs();
        applyItemPreview(it, S.prefs.previews !== false);
        if (marksDirty) {
          if (marks.length) { await chrome.storage.local.remove(BL.shotKey(it.id) + ':markup'); it.hasMarkup = false; it.markupPath = undefined; await BL.saveBatch(); await captureMarked(it, marks); }
          else { await chrome.storage.local.remove(BL.shotKey(it.id) + ':markup'); it.hasMarkup = false; it.markupPath = undefined; await BL.saveBatch(); }
        }
        updateToolbar();
        renderAnn();
      },
    };
  };

  // ------------------------------------------------------------------ note content without written text
  // Requested changes vs. reference-only content (measurements, sampled colors). Works on collected
  // fields and on saved items, including per-instance elementEdits.

  function editChanges(e) {
    const out = [];
    const css = (e.tweaks || []).filter((t) => !t.snap).map((t) => t.prop);
    if (css.length) out.push(`CSS ${css.join(', ')}`);
    if (e.textEdit) out.push(`text → “${clip(e.textEdit.after, 30)}”`);
    if (e.hidden) out.push('remove the element');
    if (e.match) out.push(`match the style of ${e.match.label}`);
    if (e.move) out.push(`move ${posText[e.move.position]} ${e.move.to.label}`);
    for (const a of e.align || []) out.push(`align ${a.edge} to guide ${a.guide}`);
    for (const axis of ['x', 'y']) { const a = e.alignEl?.[axis]; if (a) out.push(methodOf(a) === 'next' ? `place ${NEXT_WORD[a.edge]} ${a.ref.label}` : `align ${EDGE_WORD[a.edge]} with ${a.ref.label}`); }
    return out;
  }

  function changeBits(it) {
    const out = editChanges(it);
    for (const e of it.elementEdits || []) out.push(...editChanges(e));
    const drawn = (it.marks || []).filter((m) => !m.auto);
    if (drawn.length) out.push(`drawn on the page: ${marksSummary(drawn)}`);
    if (it.variant) out.push(`wire to variant “${it.variant.title}”`);
    return out;
  }

  function refBits(it) {
    const n = (it.measures || []).length + (it.elementEdits || []).reduce((s, e) => s + (e.measures || []).length, 0);
    const out = [];
    if (n) out.push(plural(n, 'reference measurement'));
    if (it.colors?.length) out.push(plural(it.colors.length, 'sampled color'));
    return out;
  }

  const isReference = (it) => !it.note && !changeBits(it).length;
  hooks.isReference = isReference;

  hooks.noteFallback = (it) => {
    const ch = changeBits(it);
    const rf = refBits(it);
    if (ch.length) return `**Note:** none written. The requested change is given by the annotations below: ${ch.join('; ')}.${rf.length ? ` Context only, not changes: ${rf.join(', ')}.` : ''}`;
    return `**Note:** none written. **Reference only** (${rf.join(', ') || 'annotations'}): these record the page as it is now. Don’t change anything for this item; use the values as context for the other items.`;
  };

  // Shown in the note list when no text was written.
  const noteSummary = (it) => [...changeBits(it), ...refBits(it)].join(' · ') || 'No description';

  hooks.popHasWork = () => {
    if (!S.pop) return false;
    if (P.item) return true;
    rememberElement();
    if (P.marks.some((m) => !m.auto) || P.colors.length) return true;
    for (const r of P.edits.values()) if (Object.keys(r.tweaks).length || r.textEdit || r.hide || r.match || r.move || Object.keys(r.align).length || r.alignEl?.x || r.alignEl?.y || r.measures.length) return true;
    return false;
  };

  hooks.onItemDeleted = (it) => { applyItemPreview(it, false); forgetHistory(it.id); };
  hooks.onClear = () => { applyAllPreviews(true); histories.clear(); historyOrder = []; };

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
    if (items.some((i) => [i, ...(i.elementEdits || [])].some((e) => (e.tweaks || []).some((t) => t.rule)))) key.push('**CSS rule** lines name the stylesheet rule the author edited and where it is. Values on the left are the rule\u2019s own; **added** means the rule didn\u2019t declare that property before. Each change was previewed on the selected element only; its **Scope** says how far the real change should reach.');
    if (items.some((i) => (i.tweaks && i.tweaks.some((t) => !t.snap)) || i.textEdit)) key.push('**Previewed** values were tried live in the browser and approved by the author. Treat them as the target, using existing tokens, variables, or utility classes instead of hardcoding.');
    if (items.some((i) => refBits(i).length)) key.push('**Reference measurements** and sampled colors record the page as it is now. They are context, not change requests. Act on them only when the note or another annotation asks for a change. Items marked **(reference only)** need no edits.');
    if (items.some((i) => !i.note)) key.push('Some items have **no written note**. Their requested change is fully described by their annotations (previewed values, moves, alignment, drawings).');
    if (items.some((i) => (i.marks || []).some((m) => !m.auto))) key.push('**Drawn marks** (boxes, arrows, text) show where something belongs. Use the marked-up screenshot together with the text description.');
    if (items.some((i) => i.also && i.also.length)) key.push('**Multiple elements**: when a note lists "also applies to", make the same change to every listed element.');
    if (items.some((i) => i.figma)) key.push('Some items carry **Figma links**. If you can open those frames, use them for exact values before editing.');
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
    // Scopes based on the CSS rule the author edited (v0.7). Older notes keep the wording below.
    if (s.basis === 'rule') {
      const src = s.rule?.source ? ` in ${s.rule.source}${s.rule.context ? ` (${s.rule.context})` : ''}` : '';
      if (s.mode === 'one') return [`- Scope: **this one only**.${s.similar > 1 ? ` The CSS rule ${code(s.selector)}${src} also matches ${s.similar - 1} other element${s.similar === 2 ? '' : 's'} on this page; they must stay unchanged, so don\u2019t change that rule for this.` : ` The CSS rule ${code(s.selector)}${src} matches only this element on this page.`} Change this instance through its own classes, a variant or prop, a more specific selector, or a block/section setting.`];
      if (s.mode === 'group') return [`- Scope: **everything like it inside ${code(s.container)}**: ${matches(s.count)} for the CSS rule ${code(s.selector)}${src}${ex}. Change them together at that level (a scoped rule, wrapper class, or prop). Don\u2019t change the rule for other places. The author previewed the change on this element only.`];
      return [`- Scope: **everywhere**: change the CSS rule ${code(s.selector)}${src} itself, so the values apply wherever it matches: ${matches(s.count)} on this page${ex}. Then check other pages that use it. The author previewed the change on this element only.`];
    }
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

  // Element alignment, described as a relationship: one line per reference, method and alignment action, covering
  // every element aligned with it (a group keeps its spacing). The previewed shifts stay with each instance.
  // Notes saved before the two methods existed have no method and are "Align edges".
  function alignPhrase(axes) {
    const parts = [axes.y, axes.x].filter(Boolean);
    const edges = parts.filter((p) => !/center|middle/.test(p));
    const bits = edges.length ? [`${edges.join(' and ')} edge${edges.length > 1 ? 's' : ''}`] : [];
    for (const p of parts) if (/center|middle/.test(p)) bits.push(EDGE_WORD[p]);
    return `the ${bits.join(' and the ')}`;
  }
  const CORNER = { 'above|left-of': 'top-left', 'above|right-of': 'top-right', 'below|left-of': 'bottom-left', 'below|right-of': 'bottom-right' };
  // Place next to: sides put the group outside the reference; Center and Middle line it up with the reference's
  // center on that axis. Returns the text that goes between the group and the reference's name, and what follows it.
  function nextPhrase(axes, target) {
    const parts = [axes.y, axes.x].filter(Boolean);
    const sides = parts.filter((p) => p !== 'center' && p !== 'middle').map((p) => NEXT_WORD[p]);
    const centers = parts.filter((p) => p === 'center' || p === 'middle').map((p) => (p === 'center' ? 'horizontally' : 'vertically'));
    if (!sides.length) return `${centers.join(' and ')} centered on ${target}, keeping its position on the other axis`;
    const corner = CORNER[`${axes.y}|${axes.x}`];
    return `immediately ${sides.join(' and ')} ${target}${corner ? ` (diagonally, off its ${corner} corner)` : ''}, outside its box and touching it${centers.length ? `, and ${centers.join(' and ')} centered on it` : ''}`;
  }
  const hasCss = (edit) => (edit.tweaks || []).some((t) => !t.snap);
  function elementAlignLines(edits) {
    const groups = new Map();
    for (const edit of edits) for (const axis of ['x', 'y']) {
      const a = edit.alignEl?.[axis];
      if (!a) continue;
      const k = `${a.group?.id || ''}|${a.ref.selector}|${methodOf(a)}`;
      const g = groups.get(k) || { ref: a.ref, method: methodOf(a), members: [], axes: {} };
      if (!g.members.includes(edit)) g.members.push(edit);
      g.axes[axis] = a.edge;
      groups.set(k, g);
    }
    return [...groups.values()].map((g) => {
      const many = g.members.length > 1;
      const names = g.members.map((m) => code(m.el.label)).join(', ');
      const target = ref(g.ref.label, g.ref.selector);
      const keep = `Keep ${code(g.ref.label)} stationary${many ? ', and keep the selected elements in the same positions relative to each other' : ''}.`;
      const css = g.members.some(hasCss) ? ` The CSS changes listed for ${many ? 'these elements' : 'it'} below are part of the same correction: apply them as well${g.method === 'next' && g.members.some((m) => (m.tweaks || []).some((t) => t.prop === 'margin' && !t.snap)) ? '. The space between it and the reference comes from its margin change, not from an extra offset' : ''}.` : '';
      if (g.method === 'next') {
        const who = many ? `these ${g.members.length} selected elements as one group (${names}), using their combined bounding box,` : ref(g.members[0].el.label, g.members[0].el.selector);
        return `Position ${who} ${nextPhrase(g.axes, target)}. ${keep}${css} Build it with the layout (element order in the document flow, or a flex or grid container), not a fixed offset or transform, so it holds at other screen sizes.`;
      }
      const who = many ? `these ${g.members.length} selected elements, taken as one group (${names}) using their combined bounding box,` : ref(g.members[0].el.label, g.members[0].el.selector);
      return `Align ${alignPhrase(g.axes)} of ${who} with ${target}. ${keep}${css} Build it with the layout (a shared container, flex or grid alignment, margins or positioning), not a fixed offset or transform, so it holds at other screen sizes.`;
    });
  }
  const shiftText = (a) => [a.x && a.x.shift ? `${Math.abs(a.x.shift)}px ${a.x.shift > 0 ? 'right' : 'left'}` : '', a.y && a.y.shift ? `${Math.abs(a.y.shift)}px ${a.y.shift > 0 ? 'down' : 'up'}` : ''].filter(Boolean).join(' and ') || 'no shift (already aligned)';

  // CSS changes grouped by the rule they were made in: where it is, then one line per property. "added" means the
  // rule didn't declare the property before; the original value is otherwise the rule's own, as written.
  function cssRuleLines(tweaks) {
    const groups = new Map();
    for (const t of tweaks) { const k = t.rule.key; if (!groups.has(k)) groups.set(k, { rule: t.rule, list: [] }); groups.get(k).list.push(t); }
    const L = [];
    for (const { rule: r, list } of groups.values()) {
      const sel = r.matched || r.selector;
      const head = r.key === 'element'
        ? 'CSS on this element only (not in a stylesheet rule), previewed on it:'
        : `CSS rule ${code(sel)} in ${r.source}${r.context ? ` (${r.context})` : ''}${r.selector && r.selector !== sel ? `, from the selector ${code(r.selector)}` : ''}, previewed on this element only:`;
      const notes = [
        r.notFound ? 'This rule wasn\u2019t found on the page when the note was saved; find it by its selector and source.' : '',
        r.uncertain ? `Its condition couldn\u2019t be checked in the browser, so confirm it applies.` : '',
        r.utility ? 'It is a utility class: change which utility classes the element uses rather than redefining the class.' : '',
      ].filter(Boolean);
      L.push(`- ${head}${notes.length ? ` ${notes.join(' ')}` : ''}`);
      for (const t of list) L.push(`  - ${t.prop}: ${t.declared === false ? 'added' : t.from} → ${t.to}${t.token ? ` (≈ ${t.token})` : ''}${t.important ? ' (the rule declares it !important)' : ''}`);
    }
    return L;
  }

  // A selected element with nothing recorded for it: no CSS, text, hide, match, move, alignment or measurement. It
  // stays in the saved note (selection, undo, reopening); the export only leaves out its own instructions.
  const isEmptyInstance = (e) => !((e.tweaks || []).length || e.textEdit || e.hidden || e.match || e.move || (e.align || []).length || e.alignEl?.x || e.alignEl?.y || (e.measures || []).length);

  hooks.promptItem = (it) => {
    const L = [];
    const add = (s) => L.push(`- ${s}`);
    if (it.elementEdits?.length) {
      const active = it.elementEdits.filter((e) => !isEmptyInstance(e));
      const idle = it.elementEdits.filter(isEmptyInstance);
      if (active.length) {
        add('Selected instances have independent corrections. Apply only the actions recorded under each instance and respect its Scope.');
        L.push(...elementAlignLines(active).map((x) => `- ${x}`));
        for (const edit of active) {
          L.push(`- **Instance ${ref(edit.el.label, edit.el.selector)}**`);
          const details = hooks.promptItem({ ...edit, scope: { ...edit.scope, chosen: true }, path: it.path });
          L.push(...details.filter((line) => line && line !== '**Author\u2019s annotations**').map((line) => `  ${line}`));
        }
      }
      // With a written note or drawings that may refer to them, selected elements without changes of their own are
      // named in one line (no scope, no instructions). Otherwise they are left out.
      if (idle.length && (it.note || (it.marks || []).some((m) => !m.auto))) add(`Also selected, with no changes of their own (nothing to apply to ${idle.length === 1 ? 'it' : 'them'} separately): ${idle.map((e) => ref(e.el.label, e.el.selector)).join(', ')}.`);
    }
    if (!it.elementEdits && it.also?.length) {
      add(`Also applies to ${it.also.length} more element${it.also.length === 1 ? '' : 's'}. Make the same change to each:`);
      it.also.forEach((a) => L.push(`  - ${ref(a.label, a.selector)}${a.text ? ` "${a.text}"` : ''} (${a.size})${a.rendered ? `, rendered at ${code(a.rendered)}` : ''}${a.section ? `, in ${code(a.section)}` : ''}`));
    }
    if (showsScope(it)) L.push(...scopeLines(it));
    const prev = (it.tweaks || []).filter((t) => !t.snap);
    // Changes saved before rules were recorded (and Match style previews) keep their original line.
    const loose = prev.filter((t) => !t.rule);
    if (loose.length) add(`Previewed by the author${it.also?.length ? ' (on all selected elements)' : ''}: ${loose.map((t) => `${t.prop} ${t.from} → ${t.to}${t.token ? ` (≈ ${t.token})` : ''}`).join('; ')}`);
    L.push(...cssRuleLines(prev.filter((t) => t.rule)));
    if (it.textEdit) add(`Copy change: “${it.textEdit.before}” → “${it.textEdit.after}”`);
    if (it.hidden) add('The author hid this element to preview the layout without it. Remove it (or hide it, per the note) and let the layout close up.');
    if (it.match) add(`Make it look like ${ref(it.match.label, it.match.selector)}${it.match.src ? ` (rendered at ${code(it.match.src)})` : ''}. Differences, this → target: ${it.match.diffs.map((d) => `${d.prop} ${d.from} → ${d.to}`).join('; ')}`);
    if (it.move) add(`Move this element **${posText[it.move.position]}** ${ref(it.move.to.label, it.move.to.selector)}${it.move.to.src ? ` (target rendered at ${code(it.move.to.src)})` : ''}. Keep its markup and styles; adjust any layout that depended on its old spot.`);
    for (const a of it.align || []) {
      const dir = a.axis === 'x' ? (a.offset >= 0 ? 'right of' : 'left of') : a.offset >= 0 ? 'below' : 'above';
      add(`Align its ${a.edge}${a.edge === 'center' || a.edge === 'middle' ? '' : ' edge'} to guide ${a.guide} (${a.axis === 'x' ? 'vertical at x' : 'horizontal at y'}=${a.guidePos}px). ${a.offset === 0 ? 'It is already on the guide; keep it there.' : `It is currently ${Math.abs(a.offset)}px ${dir} the guide. The author previewed the snap with a ${a.shift}px translate; implement it with real layout (alignment, margin, grid or flex), not a transform.`}`);
    }
    if (it.alignEl?.x || it.alignEl?.y) add(`Element alignment (described above): previewed by shifting this element ${shiftText(it.alignEl)}${hasCss(it) ? ', with the CSS values above applied' : ''}. The shift is a hint, not the implementation${hasCss(it) ? '; don’t add an offset to make up for the CSS values' : ''}.`);
    for (const m of it.measures || []) add(`Reference measurement to ${ref(m.label, m.selector)} (current layout, not a change by itself): ${m.summary}`);
    if (it.colors?.length) add(`Sampled colors: ${it.colors.map(code).join(', ')}`);
    if (it.auto) add('Selected by dragging a rectangle over an area of the page, so the target was matched automatically. Confirm it against the marked-up screenshot.');
    const drawn = (it.marks || []).filter((m) => !m.auto);
    if (drawn.length) { add(`Drawn on the page: ${marksSummary(drawn)}. See the marked-up screenshot.`); for (const m of drawn.filter((m) => m.t === 'arrow')) add(`Arrow ${m.c}: page coordinates (${rnd(m.a.x)}, ${rnd(m.a.y)}) → (${rnd(m.b.x)}, ${rnd(m.b.y)}).`); }
    if (it.figma) add(`Figma: ${it.figma}`);
    if (it.variant) {
      const v = it.variant;
      add(`Wire to Shopify variant: product ${code(v.handle)}, variant id ${code(v.variantId)} (“${v.title}”${v.sku ? `, SKU ${v.sku}` : ''}, live price $${v.price.toFixed(2)}, ${v.available ? 'in stock' : 'sold out'}). Reference the product or variant by handle or id and render the price with Liquid money filters. Don\u2019t copy the price into the page, and don\u2019t write to the store.`);
    }
    return L.length ? ['', '**Author\u2019s annotations**', ...L] : [];
  };

  // ------------------------------------------------------------------ exports for tests

  BL.toolsApi = {
    elementFields, chooseElement, rememberElement, renderChanges, elKind, previewAlign, realign, layoutRect, holdPosition, restoreElementRecord, visitElement, arrowHit, editArrowPointer, setDrawingColor, applyItemPreview, revertLive, removeGuide, styleInput, togglePopHide, buildAlignRows, emptyPop,
    similarSelector, similar, groupOptions, scopeInfo, tokenHint, spacingClasses, regionContext, measureRects, measureText, parseCSV, sheetFromRows, checkPrices,
    normForVar, stepVal, normInput, priceReportText, scopeLines, marksSummary, snapTo, autoSelect, pointTarget, startSelect, startArea, T, A, D, getP: () => P, setP: (p) => { P = p; }, setAnnotate, setTarget, makeDraggable,
  };

  if (S.ui) hooks.onMount(S.ui.root);
})();
