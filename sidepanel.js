/* Blueline — side panel page. A thin remote view of the Blueline panel running in one tab (see sidebar.js).
 * It holds no workspace state: it draws what the tab's content script sends, and sends clicks / typing / keys back.
 * The tab is fixed by the URL (?tab=ID) that the background worker set for this tab's panel, so it can only ever talk to
 * that tab. If the connection drops it keeps retrying; it stops only when told Blueline is off or back to floating.
 */
(() => {
  'use strict';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const PORT = 'blueline-sidebar';
  const TAB = Number(new URLSearchParams(location.search).get('tab'));
  const BAD_TAG = new Set(['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'frame', 'frameset']);
  const BYE = {
    off: 'Blueline is off on this tab. Turn it on from the toolbar, then dock again.',
    floating: 'Blueline is back in the floating panel on the page.',
    replaced: 'This sidebar was opened somewhere else.',
  };

  const P = { port: null, nodes: new Map(), gone: new Set(), host: null, root: null, css: null, retry: 0, timer: 0, done: false, gotAny: false, hot: 0 };
  const $ = (id) => document.getElementById(id);

  // ---- status line
  function status(text, over) {
    const m = $('msg');
    if (!text) { m.hidden = true; return; }
    m.hidden = false;
    m.classList.toggle('over', !!over);
    m.firstElementChild.textContent = text;
  }
  const freeze = (on) => { const m = $('mount'); if (on) m.setAttribute('inert', ''); else m.removeAttribute('inert'); };

  // ---- the mirror (one shadow host, created once; listeners are attached once)
  function ensureHost() {
    if (P.host) return;
    const host = document.createElement('div');
    host.id = 'bl-host';
    host.setAttribute('data-sb', '');
    host.style.cssText = 'display:block;position:fixed;top:0;left:0;width:100%;height:100%;overflow:hidden;';
    P.root = host.attachShadow({ mode: 'open' });
    P.css = document.createElement('style');
    P.root.appendChild(P.css);
    $('mount').appendChild(host);
    P.host = host;
    wire(P.root);
    // (wire() needs P.host, set just above)
    if (window.ResizeObserver) {
      let t = 0;
      new ResizeObserver(() => { clearTimeout(t); t = setTimeout(sendSize, 80); }).observe(host);
    }
  }

  const safeAttr = (name, value) => !/^on/i.test(name) && !(/^(href|src|xlink:href|action|formaction)$/i.test(name) && /^\s*(javascript|data:text\/html)/i.test(value));

  function build(t) {
    let n;
    if (t.x !== undefined) n = document.createTextNode(t.x);
    else {
      if (BAD_TAG.has(t.n)) { n = document.createComment(''); }
      else {
        n = t.s ? document.createElementNS(SVGNS, t.n) : document.createElement(t.n);
        for (const k of Object.keys(t.a || {})) { if (safeAttr(k, t.a[k])) { try { n.setAttribute(k, t.a[k]); } catch { /* invalid name */ } } }
        for (const c of t.c || []) n.appendChild(build(c));
        if (t.v !== undefined) n.value = t.v;
        if (t.k !== undefined) n.checked = t.k;
      }
    }
    n.__bl = t.i;
    P.nodes.set(t.i, n);
    return n;
  }

  function dropMap(n) {
    if (n.__bl !== undefined) P.nodes.delete(n.__bl);
    for (const c of n.childNodes || []) dropMap(c);
  }

  function clearMirror() {
    for (const c of [...P.root.childNodes]) if (c !== P.css) c.remove();
    P.nodes.clear(); P.gone.clear();
  }

  function applySnapshot(m) {
    ensureHost();
    clearMirror();
    P.css.textContent = String(m.css || '');
    for (const t of m.nodes || []) P.root.appendChild(build(t));
    freeze(false);
    status('');
    sendSize();
  }

  function reconcile(op) {
    const parent = op.id === 0 ? P.root : P.nodes.get(op.id);
    if (!parent) return false;
    const want = [];
    for (const id of op.order) {
      let n;
      if (op.add && op.add[id]) { const old = P.nodes.get(id); if (old) { old.remove(); dropMap(old); } n = build(op.add[id]); }
      else n = P.nodes.get(id);
      if (!n) return false;
      want.push(n);
    }
    const keep = new Set(want);
    for (const c of [...parent.childNodes]) if (c.__bl !== undefined && !keep.has(c)) { c.remove(); P.gone.add(c); }
    let ref = null;
    for (let i = want.length - 1; i >= 0; i--) {
      const n = want[i];
      if (n.parentNode !== parent || n.nextSibling !== ref) parent.insertBefore(n, ref);
      ref = n;
    }
    return true;
  }

  function applyOps(ops) {
    let ok = true;
    for (const op of ops || []) {
      if (op.k === 'kids') { ok = reconcile(op) && ok; continue; }
      const n = P.nodes.get(op.id);
      if (!n) continue;
      if (op.k === 'attr') {
        if (op.v === null) n.removeAttribute(op.n);
        else if (safeAttr(op.n, op.v)) { try { n.setAttribute(op.n, op.v); } catch { /* invalid name */ } }
      } else if (op.k === 'text') n.data = op.v;
      else if (op.k === 'ctl') {
        if ('v' in op && n.value !== op.v) n.value = op.v;
        if ('k' in op && n.checked !== op.k) n.checked = op.k;
      }
    }
    for (const n of P.gone) if (!P.root.contains(n)) dropMap(n);
    P.gone.clear();
    if (!ok) send({ t: 'resync' }); // out of step: take a fresh copy rather than guess
  }

  // ---- panel -> page
  const send = (m) => { try { if (P.port) P.port.postMessage(m); } catch { /* port closed; reconnect handles it */ } };
  function sendSize() {
    if (!P.host) return;
    const r = P.host.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) send({ t: 'size', w: r.width, h: r.height });
  }
  const idOf = (el) => { let n = el; while (n && n.__bl === undefined) n = n.parentNode; return n ? n.__bl : undefined; };
  const isText = (el) => !!el && (el.localName === 'textarea' || el.localName === 'select' || (el.localName === 'input' && !/^(checkbox|radio|button|submit|reset|file)$/.test(el.type)) || el.isContentEditable);
  const isCheck = (el) => !!el && el.localName === 'input' && (el.type === 'checkbox' || el.type === 'radio');
  const fileInput = (el) => {
    if (!el.closest) return null;
    if (el.localName === 'input' && el.type === 'file') return el;
    const lab = el.closest('label');
    const f = lab && (lab.control || lab.querySelector('input[type="file"]'));
    return f && f.type === 'file' ? f : null;
  };
  const b64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  async function pack(list) {
    const out = [];
    for (const f of list) out.push({ name: f.name, type: f.type, mod: f.lastModified, b64: b64(await f.arrayBuffer()) });
    return out;
  }
  const mods = (e) => ({ shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey });

  function wire(root) {
    root.addEventListener('click', (e) => {
      const t = e.target;
      const id = idOf(t);
      if (id === undefined || !(t instanceof Element)) return;
      if (fileInput(t)) return; // the file picker opens here; the chosen file is sent on `change`
      // Checkboxes, radios, labels and <summary> are toggled by the page's real element and echoed back, so the two
      // copies can never disagree (a label click would otherwise toggle twice).
      if (!isText(t) && (isCheck(t) || t.closest('label, summary'))) e.preventDefault();
      send({ t: 'ev', type: 'click', id, detail: e.detail, ...mods(e) });
    });
    root.addEventListener('dblclick', (e) => { const id = idOf(e.target); if (id !== undefined && !isText(e.target)) send({ t: 'ev', type: 'dblclick', id, ...mods(e) }); });
    root.addEventListener('input', (e) => {
      const t = e.target; const id = idOf(t);
      if (id === undefined || isCheck(t) || (t.localName === 'input' && t.type === 'file')) return;
      send({ t: 'ev', type: 'input', id, v: t.value });
    });
    root.addEventListener('change', async (e) => {
      const t = e.target; const id = idOf(t);
      if (id === undefined || isCheck(t)) return;
      if (t.localName === 'input' && t.type === 'file') {
        const files = await pack([...t.files]);
        t.value = ''; // choosing the same file again must fire `change` again
        send({ t: 'ev', type: 'files', kind: 'change', id, files });
        return;
      }
      send({ t: 'ev', type: 'change', id, v: t.value });
    });
    // Keys are caught on the whole panel document, not just inside the mirror: after a modal closes, the focused button is
    // gone and keys (Esc, Alt+P) land on the document body, but they still belong to Blueline.
    const key = (type) => (e) => {
      if (e.isComposing) return;
      const t = e.composedPath()[0];
      const id = t instanceof Element ? idOf(t) : undefined;
      send({ t: 'ev', type, id: id === undefined ? 0 : id, key: e.key, code: e.code, repeat: e.repeat, ...mods(e) });
    };
    document.addEventListener('keydown', key('keydown'));
    document.addEventListener('keyup', key('keyup'));
    // Hovering a note in the list highlights it on the page.
    root.addEventListener('mouseover', (e) => {
      const li = e.target.closest && e.target.closest('.item');
      const id = li ? idOf(li) || 0 : 0;
      if (id === P.hot) return;
      P.hot = id;
      send(id ? { t: 'ev', type: 'mouseover', id } : { t: 'ev', type: 'mouseleave', id: 0 });
    });
    P.host.addEventListener('mouseleave', () => { if (P.hot) { P.hot = 0; send({ t: 'ev', type: 'mouseleave', id: 0 }); } });
    root.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    root.addEventListener('drop', async (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      const id = idOf(e.target);
      if (id === undefined) return;
      send({ t: 'ev', type: 'files', kind: 'drop', id, files: await pack([...e.dataTransfer.files]) });
    });
  }

  // ---- messages from the page
  async function toClipboard(text) {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* nothing more to try */ }
      ta.remove();
    }
  }

  function onMessage(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'snapshot': applySnapshot(m); break;
      case 'ops': if (P.host) applyOps(m.ops); break;
      case 'focus': { const n = P.nodes.get(m.id); if (n && n.focus) n.focus({ preventScroll: true }); break; }
      case 'blur': { const n = P.nodes.get(m.id); if (n && n.blur) n.blur(); break; }
      case 'clipboard': toClipboard(String(m.text || '')); break;
      case 'bye':
        P.done = true;
        clearTimeout(P.timer);
        if (P.host) freeze(true);
        status(BYE[m.reason] || BYE.floating, true);
        break;
      default: break;
    }
  }

  // ---- connection (retries forever until told to stop: the page may navigate, reload, or not be ready yet)
  function connect() {
    clearTimeout(P.timer);
    if (P.done) return;
    let port;
    try { port = P.connect(TAB); } catch { retry(); return; }
    P.port = port;
    P.gotAny = false;
    port.onMessage.addListener((m) => { if (P.port !== port) return; P.gotAny = true; P.retry = 0; onMessage(m); });
    port.onDisconnect.addListener(() => {
      void (globalThis.chrome && chrome.runtime && chrome.runtime.lastError);
      if (P.port !== port) return;
      P.port = null;
      if (P.done) return;
      if (P.host) freeze(true);
      status(P.gotAny ? 'Reconnecting to the page…' : 'Waiting for the page…', !!P.host);
      retry();
    });
    send({ t: 'size', w: window.innerWidth, h: window.innerHeight });
  }
  function retry() {
    clearTimeout(P.timer);
    P.timer = setTimeout(connect, Math.min(2000, 300 * (1 + P.retry++)));
  }

  P.connect = (tabId) => chrome.tabs.connect(tabId, { name: PORT, frameId: 0 });
  globalThis.BluelineSidepanel = { P, connect, onMessage };

  if (!Number.isInteger(TAB) || TAB < 0) status('Open the sidebar from the Blueline panel on a page (Dock to sidebar).');
  else connect();
})();
