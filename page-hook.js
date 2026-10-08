/* Blueline v0.2 — page hook (runs in the page's own JS world)
 * The content script can't see React internals, window.Shopify, or the page's
 * fetch/console, so this tiny hook answers its questions over DOM events.
 * Console and network are only wrapped in tabs where Blueline is on.
 */
(() => {
  if (window.__bluelineHook) return;
  window.__bluelineHook = true;

  const MAX = 40;
  const ARM_KEY = '__blueline_armed';
  const logs = { console: [], network: [], nav: [] };
  let armed = false;

  const push = (arr, item) => {
    item.t = Date.now();
    arr.push(item);
    if (arr.length > MAX) arr.shift();
  };
  const clip = (s, n = 300) => {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  const str = (v) => {
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      try { return JSON.stringify(v); } catch { return Object.prototype.toString.call(v); }
    }
    return String(v);
  };
  const fmt = (args) => {
    const parts = [...args];
    if (typeof parts[0] === 'string' && /%[sdoOifc]/.test(parts[0])) {
      const head = parts.shift().replace(/%[sdoOifc]/g, (m) => {
        if (!parts.length) return m;
        const v = parts.shift();
        return m === '%c' ? '' : str(v);
      });
      parts.unshift(head);
    }
    return clip(parts.map(str).join(' ').replace(/\s+/g, ' '), 500);
  };
  const shortUrl = (u) => {
    try {
      const url = new URL(u, location.href);
      return clip(url.origin === location.origin ? url.pathname + url.search : url.href, 160);
    } catch {
      return clip(u, 160);
    }
  };
  const skipUrl = (u) => /\/_next\/|webpack-hmr|__nextjs|hot-update|__turbopack|sockjs|livereload|^chrome-extension:/.test(u);

  // Uncaught errors are always collected (no side effects on the page).
  window.addEventListener('error', (e) => {
    push(logs.console, { level: 'uncaught', msg: clip(e.error ? str(e.error) : e.message || 'Script error', 500) });
  });
  window.addEventListener('unhandledrejection', (e) => {
    push(logs.console, { level: 'unhandled rejection', msg: clip(str(e.reason), 500) });
  });

  async function recordRequest(method, url, status, t0, res, err, xhr, isAction) {
    if (skipUrl(url)) return;
    const failed = status === 0 || status >= 400;
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (!failed && !mutating) return;
    const entry = { method, url: shortUrl(url), status, ms: Math.round(performance.now() - t0) };
    if (isAction) entry.kind = 'server action';
    if (err) entry.error = clip(str(err), 200);
    push(logs.network, entry);
    if (!failed) return;
    try {
      if (res) {
        const ct = res.headers.get('content-type') || '';
        if (/json|text|html/.test(ct)) entry.body = clip((await res.clone().text()).replace(/\s+/g, ' '), 300);
      } else if (xhr && (xhr.responseType === '' || xhr.responseType === 'text')) {
        entry.body = clip(String(xhr.responseText || '').replace(/\s+/g, ' '), 300);
      }
    } catch {
      /* body unavailable */
    }
  }

  function arm() {
    if (armed) return;
    armed = true;

    ['error', 'warn'].forEach((level) => {
      const orig = console[level];
      console[level] = function (...args) {
        try { push(logs.console, { level, msg: fmt(args) }); } catch { /* ignore */ }
        return orig.apply(this, args);
      };
    });

    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = async function (input, init) {
        const t0 = performance.now();
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        let isAction = false;
        try { isAction = new Headers((init && init.headers) || (input && input.headers) || {}).has('next-action'); } catch { /* ignore */ }
        try {
          const res = await origFetch.apply(this, arguments);
          recordRequest(method, url, res.status, t0, res, null, null, isAction);
          return res;
        } catch (err) {
          recordRequest(method, url, 0, t0, null, err, null, isAction);
          throw err;
        }
      };
    }

    const XO = XMLHttpRequest.prototype.open;
    const XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__bl = { method: String(method || 'GET').toUpperCase(), url: String(url) };
      return XO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const meta = this.__bl;
      if (meta) {
        const t0 = performance.now();
        this.addEventListener('loadend', () => recordRequest(meta.method, meta.url, this.status, t0, null, null, this));
      }
      return XS.apply(this, arguments);
    };

    ['pushState', 'replaceState'].forEach((fn) => {
      const orig = history[fn];
      history[fn] = function () {
        const out = orig.apply(this, arguments);
        try { push(logs.nav, { url: location.pathname + location.search, how: fn === 'pushState' ? 'navigate' : 'replace' }); } catch { /* ignore */ }
        return out;
      };
    });
    window.addEventListener('popstate', () => push(logs.nav, { url: location.pathname + location.search, how: 'back/forward' }));
  }

  // Arm before the app boots when this tab already has Blueline on.
  try { if (sessionStorage.getItem(ARM_KEY)) arm(); } catch { /* storage blocked */ }

  // ---------------------------------------------------------------- React

  const fiberOf = (el) => {
    for (const k in el) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) return el[k];
    }
    return null;
  };
  const isContainer = (el) => {
    for (const k in el) if (k.startsWith('__reactContainer$')) return true;
    return !!el._reactRootContainer;
  };

  function hasReact() {
    const roots = document.querySelectorAll('body, #__next, #root, #app, body > div');
    for (const el of roots) if (isContainer(el) || fiberOf(el)) return true;
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    for (let i = 0; i < Math.min(all.length, 300); i++) if (fiberOf(all[i])) return true;
    return false;
  }

  function nameOf(type) {
    if (!type) return null;
    if (typeof type === 'function') return type.displayName || type.name || null;
    if (typeof type === 'object') {
      if (type.displayName) return type.displayName;
      if (type.render) return nameOf(type.render); // forwardRef
      if (type.type) return nameOf(type.type); // memo
    }
    return null;
  }

  const INTERNAL = /^(InnerLayoutRouter|OuterLayoutRouter|RenderFromTemplateContext|ScrollAndFocusHandler|InnerScrollAndFocusHandler|RedirectBoundary|RedirectErrorBoundary|NotFoundBoundary|NotFoundErrorBoundary|LoadingBoundary|ErrorBoundary|ErrorBoundaryHandler|HTTPAccessFallbackBoundary|HTTPAccessFallbackErrorBoundary|DevRootHTTPAccessFallbackBoundary|HotReload|ReactDevOverlay|AppDevOverlay|AppDevOverlayErrorBoundary|DevOverlay|Router|AppRouter|ServerRoot|Root|ClientPageRoot|ClientSegmentRoot|SegmentViewNode|SegmentStateProvider|MetadataBoundary|ViewportBoundary|OutletBoundary|AppRouterAnnouncer|HistoryUpdater|RuntimeStyles|Head|PathnameContextProviderAdapter|Suspense|StrictMode|Fragment|AppContainer|ReactDevOverlayErrorBoundary|RootErrorBoundary|Primitive|Slot|SlotClone|Slottable|Presence|DismissableLayer|DismissableLayerBranch|FocusScope|Portal|Popper|PopperAnchor|PopperContent|PopperArrow|CollectionProvider|CollectionSlot|CollectionItemSlot|RovingFocusGroup|RovingFocusGroupImpl|RovingFocusGroupItem|VisuallyHidden|RemoveScroll|SideCar|FocusLock|Menu|MenuRoot|MenuContent|MenuPortal|Anonymous)$|(Provider|Consumer|Context|Boundary|Handler|Impl)$|^Primitive\./;
  const MINIFIED = /^[A-Za-z_$][A-Za-z0-9_$]?$/;

  function frameFromStack(stack) {
    const lines = String(stack).split('\n').slice(1);
    for (const line of lines) {
      const m = line.match(/((?:webpack-internal:\/\/\/|https?:\/\/|file:\/\/)\S+?):(\d+):(\d+)\)?\s*$/);
      if (!m) continue;
      const url = m[1];
      if (/node_modules|react-dom|react-server|next\/dist|react-stack|jsx-dev-runtime|jsx-runtime|\/react\/|\[root[- ]of[- ]the[- ]server\]/.test(url)) continue;
      const wi = url.match(/webpack-internal:\/\/\/(?:\([^)]*\)\/)?\.?\/?(.+)$/);
      if (wi) return `${wi[1]}:${m[2]}`;
      const tp = url.match(/\/_next\/static\/chunks\/(?:.*\/)?(.+?)(?:\._)?\.js(?:\?.*)?$/);
      if (tp) return `chunk ${tp[1]}`;
      if (/\/(src|app|components|pages)\//.test(url)) return `${url.replace(/^https?:\/\/[^/]+/, '')}:${m[2]}`;
    }
    return null;
  }

  function srcOf(f) {
    const s = f && f._debugSource;
    if (s && s.fileName) return `${s.fileName}:${s.lineNumber}`;
    const st = f && f._debugStack && f._debugStack.stack;
    return st ? frameFromStack(st) : null;
  }

  function ownerName(f) {
    const o = f && f._debugOwner;
    if (!o) return null;
    return o.type ? nameOf(o.type) : o.name || null;
  }

  function inspect() {
    const el = document.querySelector('[data-blueline-pick]');
    if (!el) return null;
    let node = el;
    let fiber = null;
    while (node && !(fiber = fiberOf(node))) node = node.parentElement;
    if (!fiber) return { react: false };

    const out = { react: true, rendered: srcOf(fiber), owner: ownerName(fiber), components: [], minified: false };
    const seen = new Set();
    let total = 0;
    let short = 0;
    let f = fiber.return;
    let guard = 0;
    while (f && guard++ < 300 && out.components.length < 10) {
      const name = typeof f.type === 'function' || (f.type && typeof f.type === 'object') ? nameOf(f.type) : null;
      if (name) {
        total++;
        if (MINIFIED.test(name)) short++;
        if (!INTERNAL.test(name) && !MINIFIED.test(name)) {
          const src = srcOf(f);
          out.components.push(src ? { name, src } : { name });
        }
      }
      if (Array.isArray(f._debugInfo)) {
        for (const info of f._debugInfo) {
          if (info && info.name && !seen.has(info.name) && !INTERNAL.test(info.name)) {
            seen.add(info.name);
            out.components.push({ name: info.name, server: true });
          }
        }
      }
      f = f.return;
    }
    out.components.reverse();
    out.minified = total > 3 && short / total > 0.5;
    return out;
  }

  // ---------------------------------------------------------------- page info

  function page() {
    const shopify = window.Shopify || {};
    const theme = shopify.theme || null;
    const meta = (window.ShopifyAnalytics && window.ShopifyAnalytics.meta) || {};
    const nd = window.__NEXT_DATA__;
    const isNext = !!(window.next || nd || self.__next_f || document.getElementById('__next') || document.querySelector('script[src*="/_next/"]'));
    return {
      shop: shopify.shop || null,
      theme: theme ? { name: theme.name, id: theme.id, role: theme.role } : null,
      pageType: (meta.page && meta.page.pageType) || null,
      next: isNext
        ? { router: nd ? 'pages' : self.__next_f ? 'app' : null, page: (nd && nd.page) || null, version: (window.next && window.next.version) || null }
        : null,
      react: hasReact(),
      armed,
    };
  }

  // ---------------------------------------------------------------- bridge

  document.addEventListener('blueline:req', (e) => {
    let req;
    try { req = JSON.parse(e.detail); } catch { return; }
    let result = null;
    try {
      if (req.cmd === 'arm') { arm(); result = true; }
      else if (req.cmd === 'page') result = page();
      else if (req.cmd === 'inspect') result = inspect();
      else if (req.cmd === 'logs') result = logs;
    } catch (err) {
      result = { error: String(err && err.message) };
    }
    document.dispatchEvent(new CustomEvent('blueline:res', { detail: JSON.stringify({ id: req.id, result }) }));
  });
})();

//# sourceURL=blueline-hook.js
