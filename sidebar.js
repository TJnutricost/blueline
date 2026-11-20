/* Blueline — sidebar agent (content script). Lets Blueline's existing panel be shown in Chrome's native Side Panel.
 *
 * Architecture: this content script stays the ONLY implementation of Blueline and the ONLY owner of its state. The side
 * panel (sidepanel.html / sidepanel.js) is a thin remote view: it shows a live copy of the panel part of Blueline's shadow
 * root and sends clicks, typing and keys back here, where they are replayed on the real elements. Nothing is duplicated:
 * every button runs the same handler it runs in floating mode, and everything is saved by the same code to the same
 * chrome.storage keys. The page-anchored parts (selection outline, note pins, annotation layers) stay on the page.
 *
 * Transport: the side panel opens one chrome.tabs.connect() port to THIS tab's top frame. Chrome delivers it only here,
 * so another tab can never see this tab's UI. If the port drops (panel closed, page navigated, extension reloaded) the
 * panel retries and this script reverts to the floating panel when no panel comes back.
 */
(() => {
  const BL = globalThis.__BL;
  if (!BL || BL.sidebar) return;
  const S = BL.S;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const PORT = 'blueline-sidebar';
  const OVERLAYS = ['hl', 'pins', 'x-layers']; // direct children of the shadow root that belong ON the page
  const CONNECT_WAIT = 6000; // after asking for the panel (or after a navigation): how long to wait for it
  const GRACE = 2500; // after the panel's port drops while its tab is visible: how long before returning to floating
  const NARROW = 700; // viewports narrower than this (phone emulation) never get the large floating panel back by themselves
  const SYNC_MS = 250; // control values (typed text, checkboxes) set by code are not DOM mutations, so they are polled

  const SB = {
    mode: 'floating', // 'floating' | 'pending' (docked; waiting for the panel) | 'sidebar' (panel connected)
    port: null, obs: null, poll: 0, timer: 0, busy: false,
    ids: new WeakMap(), nodes: new Map(), known: new Set(), ctl: new Map(), next: 1,
    size: { w: 380, h: 700 }, style: null, patched: null, supported: true, stateKnown: false, compacts: 0, openedAt: 0, resize: 0, resizeT: 0,
  };

  // ---- CSS shared by the hidden real copy and the side panel's copy, so both lay out identically
  const H = ':host([data-sb])';
  const SHARED_CSS = `
    ${H} { --sb-w: 100vw; --sb-h: 100vh; }
    ${H} > .panel { visibility: visible !important; position: fixed !important; top: 0 !important; left: 0 !important; right: auto !important; bottom: auto !important;
      width: var(--sb-w) !important; height: var(--sb-h) !important; max-width: none !important; max-height: none !important;
      border: 0 !important; border-radius: 0 !important; box-shadow: none !important; transform: none !important; }
    ${H} > .panel.collapsed .body, ${H} > .panel.collapsed .foot { display: flex !important; }
    ${H} > .panel > .body { flex: 1 1 auto; min-height: 0; }
    ${H} [data-act="side"], ${H} [data-act="collapse"], ${H} [data-act="sb-dock"] { display: none !important; }
    ${H} .sb-only { display: block !important; }
    ${H} > [class*="modal"] { position: fixed !important; inset: auto !important; top: 0 !important; left: 0 !important;
      width: var(--sb-w) !important; height: var(--sb-h) !important; padding: 8px !important; transform: none !important; }
    ${H} .sheet, ${H} .xsheet { width: 100% !important; max-width: none !important; transform: none !important; }
    ${H} .lib-modal .lib-sheet { position: static !important; width: 100% !important; max-width: none !important; height: 100% !important;
      max-height: none !important; border-radius: 8px !important; transform: none !important; }
    ${H} > .x-bar { max-width: calc(var(--sb-w) - 16px); }
    ${H} .bar.dense .mode { display: inline-block; }
    @media (max-width: 359px) { ${H} .bar .mode { display: none; } }
    @media (max-width: 319px) { ${H} .bar .brand { gap: 4px; } ${H} .bar .dock { padding: 0 6px; } ${H} .tools .icon { width: 28px; height: 28px; line-height: 28px; } }
  `;
  // Only on the page: hide the real copy of everything that is shown in the side panel, but keep its layout (code measures it).
  const HIDE_CSS = `
    ${H} > :not(.hl):not(.pins):not(.x-layers):not(.sb-launch):not(style) { visibility: hidden !important; pointer-events: none !important; }
    ${H} > .sb-launch { position: fixed; right: 12px; bottom: 12px; z-index: 5; display: flex; align-items: center; gap: 2px; padding: 3px;
      border: 1px solid #B9C3FF; border-radius: 18px; background: #fff; box-shadow: 0 4px 14px rgba(30,34,48,.2); pointer-events: auto;
      font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    ${H} > .sb-launch button { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 15px; color: #1A33C7; white-space: nowrap; cursor: pointer; }
    ${H} > .sb-launch button:hover { background: #F5F7FF; }
    ${H} > .sb-launch .sb-launch-float { color: #4A5063; font-weight: 500; padding: 0 10px; }
    ${H} > .sb-launch i { width: 12px; height: 3px; background: #2B4EFF; border-radius: 2px; }
  `;

  // ---- what is mirrored
  const root = () => (S.ui ? S.ui.root : null);
  function topOf(n) {
    const r = root();
    while (n && n.parentNode !== r) n = n.parentNode;
    return n || null;
  }
  const included = (n) => {
    const t = topOf(n);
    return !!t && t.nodeType === 1 && !t.hasAttribute('data-sb-skip') && !OVERLAYS.some((c) => t.classList.contains(c));
  };
  const idOf = (n) => { let i = SB.ids.get(n); if (!i) { i = SB.next++; SB.ids.set(n, i); } return i; };
  const ctlOf = (n) => {
    const t = n.localName;
    if (t === 'input') {
      const ty = n.type;
      if (ty === 'file' || ty === 'button' || ty === 'submit' || ty === 'reset' || ty === 'image') return null;
      return ty === 'checkbox' || ty === 'radio' ? { k: n.checked } : { v: n.value };
    }
    return t === 'textarea' || t === 'select' ? { v: n.value } : null;
  };

  function tree(n) {
    const id = idOf(n);
    SB.known.add(id);
    SB.nodes.set(id, n);
    if (n.nodeType === 3) return { i: id, x: n.data };
    const t = { i: id, n: n.localName, a: {}, c: [] };
    if (n.namespaceURI === SVGNS) t.s = 1;
    for (const a of n.attributes) t.a[a.name] = a.value;
    for (const c of n.childNodes) if (c.nodeType === 1 || c.nodeType === 3) t.c.push(tree(c));
    const c = ctlOf(n);
    if (c) { Object.assign(t, c); SB.ctl.set(id, JSON.stringify(c)); }
    return t;
  }

  function forget(n) {
    const id = SB.ids.get(n);
    if (id) { SB.known.delete(id); SB.nodes.delete(id); SB.ctl.delete(id); }
    for (const c of n.childNodes || []) forget(c);
  }

  const post = (m) => { try { if (SB.port) SB.port.postMessage(m); } catch { /* port closed; onDisconnect handles it */ } };

  function snapshot() {
    SB.known.clear(); SB.nodes.clear(); SB.ctl.clear();
    const top = [...root().childNodes].filter((n) => n.nodeType === 1 && included(n));
    post({ t: 'snapshot', css: SHARED_CSS, nodes: top.map(tree), meta: { host: location.host } });
  }

  // ---- changes: the real DOM is observed; the panel is told the new truth about each touched parent / attribute / text
  function kidsOp(parent, fresh) {
    const p = parent === 0 ? root() : SB.nodes.get(parent);
    if (!p) return null;
    const order = []; const add = {};
    for (const c of p.childNodes) {
      if (!(c.nodeType === 1 || c.nodeType === 3)) continue;
      if (parent === 0 && !(c.nodeType === 1 && included(c))) continue;
      const id = idOf(c);
      order.push(id);
      if (!SB.known.has(id)) { add[id] = tree(c); fresh.add(id); }
    }
    return { k: 'kids', id: parent, order, add };
  }

  function onMutations(recs) {
    if (!SB.port || !S.ui) return;
    const r = root();
    const parents = new Map(); const attrs = new Map(); const texts = new Set(); const removed = [];
    for (const m of recs) {
      if (m.type === 'childList') {
        const id = m.target === r ? 0 : SB.ids.get(m.target);
        if (id === 0 || (id && SB.known.has(id))) parents.set(id, true);
        for (const n of m.removedNodes) removed.push(n);
      } else {
        const id = SB.ids.get(m.target);
        if (!id || !SB.known.has(id)) continue;
        if (m.type === 'attributes') attrs.set(`${id}\0${m.attributeName}`, [id, m.attributeName, m.target]);
        else texts.add(id);
      }
    }
    for (const n of removed) if (!r.contains(n)) forget(n); // moved nodes stay known; only ones that left the UI are dropped
    const ops = []; const fresh = new Set();
    const depth = (id) => { let d = 0; let n = id === 0 ? null : SB.nodes.get(id); while (n && n.parentNode !== r) { n = n.parentNode; d++; } return d; };
    for (const id of [...parents.keys()].sort((a, b) => depth(a) - depth(b))) {
      if (id !== 0 && (fresh.has(id) || !SB.known.has(id))) continue;
      const op = kidsOp(id, fresh);
      if (op) ops.push(op);
    }
    for (const [id, name, el] of attrs.values()) {
      if (fresh.has(id) || !SB.known.has(id)) continue;
      ops.push({ k: 'attr', id, n: name, v: el.getAttribute(name) });
    }
    for (const id of texts) {
      const n = SB.nodes.get(id);
      if (n && !fresh.has(id)) ops.push({ k: 'text', id, v: n.data });
    }
    syncCtl(ops);
    if (ops.length) post({ t: 'ops', ops });
  }

  function flushNow() {
    if (!SB.obs) return;
    const recs = SB.obs.takeRecords();
    if (recs.length) onMutations(recs);
  }

  // Typed text, checkboxes, selects: changed by code (or by a replayed event) without any DOM mutation.
  function syncCtl(into) {
    const ops = into || [];
    for (const [id, last] of SB.ctl) {
      const n = SB.nodes.get(id);
      if (!n) continue;
      const c = ctlOf(n);
      const s = JSON.stringify(c);
      if (c && s !== last) { SB.ctl.set(id, s); ops.push({ k: 'ctl', id, ...c }); }
    }
    if (!into && ops.length) post({ t: 'ops', ops });
  }

  // ---- events coming from the panel, replayed on the real elements (same handlers as floating mode)
  const target = (id) => {
    if (id === 0) return S.ui ? S.ui.host : null;
    const n = SB.nodes.get(id);
    return n && S.ui && S.ui.root.contains(n) ? n : null;
  };
  const mods = (m) => ({ shiftKey: !!m.shift, altKey: !!m.alt, ctrlKey: !!m.ctrl, metaKey: !!m.meta });
  const unb64 = (s) => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  const toFiles = (list) => (list || []).map((f) => new File([unb64(f.b64)], String(f.name || 'file'), { type: f.type || '', lastModified: f.mod || Date.now() }));

  function replay(m) {
    if (!S.ui || !S.active) return;
    const n = target(m.id);
    switch (m.type) {
      case 'click':
      case 'dblclick':
        if (n && n !== S.ui.host) n.dispatchEvent(new MouseEvent(m.type, { bubbles: true, cancelable: true, composed: true, view: window, button: 0, detail: m.detail || 1, ...mods(m) }));
        break;
      case 'input':
      case 'change':
        if (n && typeof m.v === 'string' && ctlOf(n) && 'v' in ctlOf(n)) {
          n.value = m.v;
          SB.ctl.set(m.id, JSON.stringify(ctlOf(n))); // the panel already shows this value; do not echo it back
          n.dispatchEvent(new Event(m.type, { bubbles: true, composed: true }));
        }
        break;
      case 'keydown':
      case 'keyup': {
        const ev = new KeyboardEvent(m.type, { key: String(m.key || ''), code: String(m.code || ''), repeat: !!m.repeat, bubbles: true, cancelable: true, composed: true, ...mods(m) });
        // Same path a key takes in floating mode: from the focused element (so Esc closes a modal, Alt+P picks, Esc cancels
        // picking). With nothing focused in the panel the key goes to the page's document, where those shortcuts also live.
        (n && n !== S.ui.host ? n : document.documentElement).dispatchEvent(ev);
        break;
      }
      case 'mouseover': if (n) n.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true, view: window })); break;
      case 'mouseleave': S.ui.root.dispatchEvent(new MouseEvent('mouseleave', { view: window })); break;
      case 'files': {
        if (!n) break;
        const files = toFiles(m.files);
        const dt = new DataTransfer();
        files.forEach((f) => dt.items.add(f));
        if (m.kind === 'drop') n.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
        else if (n.localName === 'input' && n.type === 'file') { n.files = dt.files; n.dispatchEvent(new Event('change', { bubbles: true, composed: true })); }
        break;
      }
      default: return;
    }
    syncCtl();
  }

  function onPanelMessage(port, m) {
    if (port !== SB.port || !m || typeof m !== 'object') return;
    switch (m.t) {
      case 'ev': replay(m); break;
      case 'size': setSize(m.w, m.h); break;
      case 'resync': if (S.ui) snapshot(); break;
      case 'ping': post({ t: 'pong' }); break;
      default: break;
    }
  }

  // ---- real-copy geometry follows the panel so layout-dependent code (narrow mode, sizes) sees the same width
  function setSize(w, h) {
    w = Math.round(Number(w)); h = Math.round(Number(h));
    if (!(w >= 200 && w <= 4000 && h >= 200 && h <= 4000)) return;
    if (w === SB.size.w && h === SB.size.h) return;
    SB.size = { w, h };
    applySize();
    relayout();
  }
  function applySize() {
    if (S.ui) { S.ui.host.style.setProperty('--sb-w', `${SB.size.w}px`); S.ui.host.style.setProperty('--sb-h', `${SB.size.h}px`); }
  }
  const relayout = () => { try { BL.libraryUi?.relayout?.(); } catch { /* no workspace open */ } };

  // ---- the real UI is hidden (not removed) while docked, so its state, focus-free layout and handlers keep working
  function applyMode() {
    const ui = S.ui;
    if (!ui) return;
    const on = SB.mode !== 'floating';
    if (on) {
      if (!SB.style || !SB.style.isConnected) {
        SB.style = document.createElement('style');
        SB.style.setAttribute('data-sb-skip', '');
        SB.style.textContent = SHARED_CSS + HIDE_CSS;
        ui.root.appendChild(SB.style);
      }
      ui.host.setAttribute('data-sb', '');
      applySize();
    } else {
      ui.host.removeAttribute('data-sb');
      ui.host.style.removeProperty('--sb-w');
      ui.host.style.removeProperty('--sb-h');
      if (SB.style) SB.style.remove();
      SB.style = null;
    }
    relayout();
    try { BL.render?.(); } catch { /* UI not ready */ }
  }

  function patches(on) {
    if (on && !SB.patched) {
      const proto = HTMLElement.prototype;
      const cp = globalThis.Clipboard && Clipboard.prototype;
      const p = { focus: proto.focus, blur: proto.blur, write: cp && cp.writeText };
      SB.patched = p;
      // Focus belongs in the panel: the real (hidden) copy cannot take it.
      // A node created a moment ago (a dialog that focuses its first button) is not in the panel yet: send the pending DOM
      // changes first, so the focus message never arrives before the element it names.
      const mirrored = (el) => {
        if (!SB.port || !SB.obs || !S.ui || !S.ui.root.contains(el)) return 0;
        flushNow();
        const id = SB.ids.get(el);
        return id && SB.known.has(id) ? id : 0;
      };
      proto.focus = function (o) { const id = mirrored(this); if (id) { post({ t: 'focus', id }); return; } return p.focus.call(this, o); };
      proto.blur = function () { const id = mirrored(this); if (id) { post({ t: 'blur', id }); return; } return p.blur.call(this); };
      // The page is not focused while the panel is, so the page may not write the clipboard; the panel does it.
      if (cp) cp.writeText = function (t) { if (SB.port) { post({ t: 'clipboard', text: String(t) }); return Promise.resolve(); } return p.write.call(this, t); };
    } else if (!on && SB.patched) {
      const p = SB.patched;
      HTMLElement.prototype.focus = p.focus;
      HTMLElement.prototype.blur = p.blur;
      if (p.write) Clipboard.prototype.writeText = p.write;
      SB.patched = null;
    }
  }

  function startMirror() {
    stopMirror();
    if (!SB.port || !S.ui) return;
    snapshot();
    SB.obs = new MutationObserver(onMutations);
    SB.obs.observe(S.ui.root, { subtree: true, childList: true, attributes: true, characterData: true });
    SB.poll = setInterval(() => syncCtl(), SYNC_MS);
    patches(true);
  }
  function stopMirror() {
    if (SB.obs) { SB.obs.disconnect(); SB.obs = null; }
    clearInterval(SB.poll); SB.poll = 0;
    patches(false);
    SB.known.clear(); SB.nodes.clear(); SB.ctl.clear();
  }

  // ---- modes
  const clearTimer = () => { clearTimeout(SB.timer); SB.timer = 0; };
  // Nobody came back within `ms`: the panel was closed (or never opened), so show the floating panel again.
  const arm = (ms) => { clearTimer(); SB.timer = setTimeout(() => { SB.timer = 0; if (!SB.port && SB.mode !== 'floating' && SB.mode !== 'launcher') closed(); }, ms); };

  function setMode(m) {
    if (SB.mode === m) return;
    const wasFloating = SB.mode === 'floating';
    SB.mode = m;
    if (wasFloating || m === 'floating') applyMode();
    showLauncher(m === 'launcher');
  }

  // A small page-anchored button (never mirrored) that reopens the sidebar with a click: sidePanel.open needs a user gesture.
  function showLauncher(on) {
    const ui = S.ui;
    if (!ui) return;
    let b = ui.root.querySelector('.sb-launch');
    if (!on) { if (b) b.remove(); return; }
    if (b) return;
    b = document.createElement('div');
    b.className = 'sb-launch';
    b.setAttribute('data-sb-skip', '');
    b.innerHTML = '<button type="button" class="sb-launch-dock" title="Show Blueline in Chrome\u2019s side panel" aria-label="Dock to sidebar"><i></i>Dock to sidebar</button>'
      + '<button type="button" class="sb-launch-float" title="Show the floating panel on the page again" aria-label="Expand to the floating panel">Expand</button>';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = e.target.closest && e.target.closest('button');
      if (!t) return;
      if (t.classList.contains('sb-launch-dock')) dock(); else chooseFloating();
    });
    ui.root.appendChild(b);
  }

  // "Keep it floating" is the user's explicit choice (Expand, or Return to floating panel). It lasts for this tab and site
  // visit (sessionStorage), and stops Blueline from collapsing itself again on a phone-sized page.
  const KEEP = '__blueline_keepfloat';
  const keeping = () => { try { return sessionStorage.getItem(KEEP) === '1'; } catch { return false; } };
  const keep = (on) => { try { if (on) sessionStorage.setItem(KEEP, '1'); else sessionStorage.removeItem(KEEP); } catch { /* storage blocked */ } };

  // A phone-sized page (e.g. DevTools device emulation) must not be covered by the large floating panel: collapse it to the
  // launcher, once. Nothing is lost (the real UI is only hidden) and it never expands by itself, so resizing around the
  // threshold cannot make it flip back and forth. Not while a page selection is in progress (that tool owns the screen).
  function maybeCompact() {
    if (SB.mode !== 'floating' || !S.ui || !S.active || S.retired || !SB.stateKnown || !SB.supported || keeping() || window.innerWidth >= NARROW) return;
    const T = BL.toolsApi;
    if (T && ((T.A && T.A.on) || (T.T && T.T.pick))) return;
    SB.compacts++;
    setMode('launcher');
  }
  function onResize() { clearTimeout(SB.resizeT); SB.resizeT = setTimeout(maybeCompact, 250); }

  // The user closed Chrome's side panel (or it never came back). A phone-sized page must not get the large floating panel
  // back on top of it, so it gets the small launcher instead; a normal window gets the floating panel as before.
  function closed() {
    if (window.innerWidth >= NARROW) { leave(); return; }
    clearTimer();
    const port = SB.port;
    SB.port = null;
    stopMirror();
    if (port) { try { port.disconnect(); } catch { /* gone */ } }
    setMode('launcher');
    BL.send({ type: 'blueline:sb-launcher' });
  }

  // Back to the floating panel: nothing is rebuilt, the real UI is simply shown again with all its state.
  function leave(opts = {}) {
    clearTimer();
    const port = SB.port;
    SB.port = null;
    stopMirror();
    if (port) { try { port.postMessage({ t: 'bye', reason: opts.reason || 'floating' }); } catch { /* gone */ } try { port.disconnect(); } catch { /* gone */ } }
    const was = SB.mode;
    setMode('floating');
    if (was !== 'floating' && opts.notify !== false) BL.send({ type: 'blueline:sb-undock' });
    if (opts.toast) BL.toast?.(opts.toast);
  }

  function dock() {
    if ((SB.mode !== 'floating' && SB.mode !== 'launcher') || SB.busy || !S.ui) return;
    const from = SB.mode;
    keep(false);
    SB.busy = true;
    // chrome.sidePanel.open needs the user's click, so the request is sent synchronously from the click handler.
    const asked = BL.send({ type: 'blueline:sb-dock' });
    setMode('pending'); // before the answer: the panel may connect first
    arm(CONNECT_WAIT);
    asked.then((res) => {
      SB.busy = false;
      if (res && res.ok) return;
      if (from === 'launcher') { closed(); BL.toast?.('Couldn’t open the sidebar.'); } else leave({ notify: false, toast: 'Couldn’t open the sidebar. Blueline stays floating.' });
    });
  }
  // Explicit choice: floating, even on a narrow page, and it stays floating.
  function chooseFloating() { keep(true); leave({ reason: 'floating' }); }
  const undock = chooseFloating;

  function onPortGone(port) {
    if (port !== SB.port) return;
    SB.port = null;
    stopMirror();
    setMode('pending');
    clearTimer();
    // A hidden tab's panel is hidden or unloaded by Chrome; wait for the tab to come back before deciding it was closed.
    if (document.visibilityState === 'visible') arm(GRACE);
  }

  function accept(port) {
    if (port.name !== PORT || S.retired) return;
    if (port.sender && port.sender.id && port.sender.id !== chrome.runtime.id) { port.disconnect(); return; }
    if (!S.active || SB.mode === 'floating') {
      try { port.postMessage({ t: 'bye', reason: S.active ? 'floating' : 'off' }); } catch { /* gone */ }
      try { port.disconnect(); } catch { /* gone */ }
      return;
    }
    if (SB.port && SB.port !== port) {
      const old = SB.port; SB.port = null;
      try { old.postMessage({ t: 'bye', reason: 'replaced' }); old.disconnect(); } catch { /* gone */ }
    }
    SB.port = port;
    clearTimer();
    port.onMessage.addListener((m) => onPanelMessage(port, m));
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; onPortGone(port); });
    setMode('sidebar');
    if (S.ui) startMirror();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && SB.mode === 'pending' && !SB.port && !SB.timer) arm(CONNECT_WAIT);
  });

  // ---- hooks into Blueline's own lifecycle (chained like library-ui.js does)
  const prevMount = BL.hooks.onMount;
  const prevUnmount = BL.hooks.onUnmount;
  BL.hooks.onMount = (r) => {
    prevMount?.(r);
    if (SB.mode !== 'floating') { applyMode(); if (SB.port) startMirror(); showLauncher(SB.mode === 'launcher'); }
    if (!SB.supported) r.host.setAttribute('data-nosb', '');
    if (!SB.resize) { SB.resize = 1; window.addEventListener('resize', onResize); }
    maybeCompact();
  };
  BL.hooks.onUnmount = () => {
    // Blueline is being turned off: tell the panel so it can say so, and drop all docked state.
    if (SB.mode !== 'floating') leave({ reason: 'off' }); else stopMirror();
    if (SB.resize) { SB.resize = 0; window.removeEventListener('resize', onResize); }
    clearTimeout(SB.resizeT);
    prevUnmount?.();
  };

  if (S.ui && !SB.resize) { SB.resize = 1; window.addEventListener('resize', onResize); } // Blueline was already on when this script loaded

  document.addEventListener('blueline:supersede', () => { if (SB.mode !== 'floating') leave({ reason: 'off', notify: false }); });

  BL.sidebar = {
    dock, undock, active: () => SB.mode !== 'floating', mode: () => SB.mode,
    debug: () => ({ mode: SB.mode, port: !!SB.port, observer: !!SB.obs, poll: !!SB.poll, timer: !!SB.timer, known: SB.known.size, patched: !!SB.patched, compacts: SB.compacts, launchers: S.ui ? S.ui.root.querySelectorAll('.sb-launch').length : 0 }),
  };

  // Chrome 142+ tells the background when a side panel closes or opens (sidePanel.onClosed / onOpened); the background
  // forwards it for docked tabs. A close is acted on promptly, but only if the tab is in front and no "opened" followed
  // (tab switches and reconnects must not flash the launcher). Older Chrome never sends these: the grace timer covers it.
  const CLOSE_DELAY = 300;
  try {
    chrome.runtime.onMessage.addListener((m) => {
      if (!m || S.retired) return;
      if (m.type === 'blueline:sb-opened') { SB.openedAt = Date.now(); return; }
      if (m.type !== 'blueline:sb-closed') return;
      const at = Date.now();
      setTimeout(() => {
        if (SB.openedAt >= at || document.visibilityState !== 'visible') return;
        if ((SB.mode === 'sidebar' || SB.mode === 'pending') && S.active) closed();
      }, CLOSE_DELAY);
    });
  } catch { /* no extension context */ }

  // ---- start: listen for the panel, and ask whether this tab was docked before a navigation / reload
  try { if (chrome.runtime.onConnect) chrome.runtime.onConnect.addListener(accept); } catch { /* no extension context */ }
  (async () => {
    const res = await BL.send({ type: 'blueline:sb-state' });
    SB.supported = !!(res && res.supported);
    SB.stateKnown = true;
    if (S.ui && !SB.supported) S.ui.host.setAttribute('data-nosb', '');
    if (res && res.launcher && SB.mode === 'floating' && !S.retired) setMode('launcher');
    else if (res && res.docked && SB.mode === 'floating' && !S.retired) { setMode('pending'); if (document.visibilityState === 'visible') arm(CONNECT_WAIT); }
    else maybeCompact();
  })();
})();
