/* Blueline v0.6 — content script (core; the annotation tools live in tools.js)
 * Pick elements, note what should change, export a webpage change request for a developer or any AI coding assistant.
 * Modes: Shopify/Shogun, Next.js/React, plain HTML/CSS/JS (detected per page).
 * All UI lives in a shadow root so site CSS can't touch it.
 */
(() => {
  if (window.__bluelineLoaded) return;
  window.__bluelineLoaded = true;
  if (window.top !== window) return;
  const BL = (globalThis.__BL = { hooks: {} });

  const BATCH_KEY = 'blueline:batch';
  const PREFS_KEY = 'blueline:prefs';
  const ARM_KEY = '__blueline_armed';
  const shotKey = (id) => `blueline:shot:${id}`;
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch { return '?'; } })();
  const INK = '#2B4EFF';
  const TYPES = [
    { id: 'bug', label: 'Bug', ui: 'Broken', tip: 'Something is broken or behaves wrongly' },
    { id: 'polish', label: 'Polish', ui: 'Looks off', tip: 'Spacing, size, color or alignment needs adjusting' },
    { id: 'copy', label: 'Copy', ui: 'Change text', tip: 'Wording, labels or messages need changing' },
    { id: 'feature', label: 'Feature', ui: 'Add something', tip: 'Something new that does not exist yet' },
  ];
  const TYPE_RANK = { bug: 0, polish: 1, copy: 2, feature: 3 };
  const typeLabel = (id) => (TYPES.find((t) => t.id === id) || TYPES[1]).label;

  const S = {
    active: false,
    picking: false,
    page: {},
    batch: null,
    prefs: { side: 'right', collapsed: false, saveShots: true, lastType: 'polish', previews: true },
    hoverEl: null,
    trail: [],
    lastPoint: { x: 0, y: 0 },
    lockPoint: null,
    pop: null,
    popType: 'polish',
    ui: null,
    raf: 0,
    timer: 0,
    toastT: 0,
    clearArmed: 0,
  };

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  const currentPath = () => location.pathname + location.search + (/^#[/!]/.test(location.hash) ? location.hash.split('?')[0] : '');
  const findItem = (id) => (S.batch?.items || []).find((i) => i.id === id);
  const uid = () => Math.random().toString(36).slice(2, 10);
  const frames = (n) => new Promise((r) => { const step = () => (n-- <= 0 ? r() : requestAnimationFrame(step)); step(); });
  const query = (sel) => { try { return document.querySelector(sel); } catch { return null; } };
  const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const px = (v) => Math.round(parseFloat(v) || 0);

  // ---------------------------------------------------------------- page hook bridge

  function hook(cmd) {
    const id = uid();
    let out = null;
    const onRes = (e) => {
      try { const d = JSON.parse(e.detail); if (d.id === id) out = d.result; } catch { /* ignore */ }
    };
    document.addEventListener('blueline:res', onRes);
    document.dispatchEvent(new CustomEvent('blueline:req', { detail: JSON.stringify({ id, cmd }) }));
    document.removeEventListener('blueline:res', onRes);
    return out;
  }

  function inspectReact(el) {
    el.setAttribute('data-blueline-pick', '');
    try { return hook('inspect'); } finally { el.removeAttribute('data-blueline-pick'); }
  }

  function modeOf(page) {
    if (page?.shop || page?.theme) return 'shopify';
    if (page?.next) return 'next';
    if (page?.react) return 'react';
    return 'html';
  }
  const MODE_LABEL = { shopify: 'Shopify', next: 'Next.js', react: 'React', html: 'HTML' };

  // ---------------------------------------------------------------- breadcrumbs (always on, memory only)

  const crumbs = [];
  function pushCrumb(kind, what) {
    crumbs.push({ kind, what, path: currentPath(), t: Date.now() });
    if (crumbs.length > 30) crumbs.shift();
  }
  function crumbLabel(el) {
    if (!(el instanceof Element)) return 'page';
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const name = el.getAttribute('aria-label') || (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim() ||
      el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || el.getAttribute('alt') || '';
    return `${role || tag}${name ? ` "${clip(name, 40)}"` : ''}`;
  }
  const fromUI = (e) => !!S.ui && e.composedPath().includes(S.ui.host);
  const CLICKABLE = 'a,button,[role=button],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[role=link],input,select,label,summary,[data-slot]';

  document.addEventListener('click', (e) => {
    if (S.picking || fromUI(e) || !(e.target instanceof Element)) return;
    pushCrumb('click', crumbLabel(e.target.closest(CLICKABLE) || e.target));
  }, true);
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (fromUI(e) || !(el instanceof Element)) return;
    const field = el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || el.id || el.tagName.toLowerCase();
    if (el.tagName === 'SELECT') pushCrumb('select', `"${clip(el.selectedOptions[0]?.text || '', 40)}" in ${field}`);
    else if (el.type === 'checkbox' || el.type === 'radio') pushCrumb('toggle', `${field} ${el.checked ? 'on' : 'off'}`);
    else if (/^(date|time|datetime-local|month|week|number|range|color)$/.test(el.type)) pushCrumb('set', `${field} = ${clip(el.value, 30)}`);
    else if (el.type !== 'password') pushCrumb('type', `into ${field}`);
  }, true);
  document.addEventListener('submit', (e) => { if (!fromUI(e)) pushCrumb('submit', crumbLabel(e.target)); }, true);
  document.addEventListener('keydown', (e) => {
    if (fromUI(e) || S.picking || !['Enter', 'Escape'].includes(e.key)) return;
    pushCrumb('key', `${e.key} on ${crumbLabel(e.target)}`);
  }, true);

  // ---------------------------------------------------------------- element identity

  const STATE_CLASS = /^(is-|has-|js-|active$|open$|opened$|selected$|current$|hover|focus|animate|aos|visible$|hidden$|loaded$|lazyload|swiper-slide-(active|next|prev|visible)|slick-(active|current|cloned))/;
  const HASHED_CLASS = /^(css-|sc-|jsx-|svelte-)|__(?=[a-zA-Z0-9_-]*\d)[a-zA-Z0-9_-]{5}$|_(?=[a-z0-9]*\d)[a-z0-9]{6,}$|-module__/;
  const GEN_ID = /^(ember\d|:r|«r|radix-|headlessui-|react-|mui-|swiper-wrapper-)|[0-9a-f]{10,}/i;

  const isStableClass = (c) => c.length <= 40 && !STATE_CLASS.test(c) && !HASHED_CLASS.test(c);
  const isStableId = (id) => (/^shopify-(section|block)-/.test(id) ? true : !GEN_ID.test(id) && !/^\d/.test(id) && !/[:«»]/.test(id));
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };

  function decodeModule(c) {
    let m = c.match(/^([A-Za-z0-9-]+?)-module__[A-Za-z0-9_-]+?__([A-Za-z0-9-]+)$/); // Turbopack
    if (m) return { file: `${m[1]}.module.css`, cls: m[2] };
    m = c.match(/^([A-Za-z0-9-]+)_([A-Za-z0-9-]+)__[A-Za-z0-9_-]{5}$/); // webpack
    if (m) return { file: `${m[1]}.module.css`, cls: m[2] };
    return null;
  }

  function label(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id && isStableId(el.id) && !/^shopify-/.test(el.id)) return `${tag}#${el.id}`;
    const cls = [...el.classList].filter(isStableClass).slice(0, 2);
    if (!cls.length) {
      const mod = [...el.classList].map(decodeModule).find(Boolean);
      if (mod) return `${tag}.${mod.cls}`;
      const slot = el.getAttribute('data-slot');
      if (slot) return `${tag}[data-slot=${slot}]`;
    }
    return tag + cls.map((c) => '.' + c).join('');
  }

  function segmentFor(node) {
    if (node.id && isStableId(node.id)) return '#' + CSS.escape(node.id);
    const tag = node.tagName.toLowerCase();
    const testid = node.getAttribute('data-testid') || node.getAttribute('data-test');
    if (testid) return `${tag}[data-testid="${CSS.escape(testid)}"]`;
    let seg = tag;
    const name = node.getAttribute('name');
    if (name && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(node.tagName)) seg += `[name="${CSS.escape(name)}"]`;
    const cls = [...node.classList].filter(isStableClass).slice(0, 2);
    const mod = cls.length ? null : [...node.classList].find(decodeModule);
    if (cls.length) seg += cls.map((c) => '.' + CSS.escape(c)).join('');
    else if (mod) {
      // CSS module hashes change between builds; match on the stable prefix instead.
      const stem = mod.includes('-module__') ? mod.slice(0, mod.indexOf('-module__') + 9) : mod.replace(/__[A-Za-z0-9_-]{5}$/, '__');
      seg += `[class*="${stem}"]`;
    } else if (node.getAttribute('data-slot')) seg += `[data-slot="${CSS.escape(node.getAttribute('data-slot'))}"]`;
    const parent = node.parentElement;
    if (parent) {
      const sameTag = [...parent.children].filter((c) => c.tagName === node.tagName);
      const sameSeg = [...parent.children].filter((c) => { try { return c.matches(seg); } catch { return false; } });
      if (sameSeg.length > 1) seg += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    return seg;
  }

  function cssPath(el) {
    const segs = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      const seg = segmentFor(node);
      segs.unshift(seg);
      const sel = segs.join(' > ');
      if (unique(sel)) return sel;
      if (seg.startsWith('#') && segs.length > 1) {
        const loose = seg + ' ' + segs.slice(1).join(' > ');
        if (unique(loose)) return loose;
      }
      node = node.parentElement;
    }
    return segs.join(' > ');
  }

  // ---------------------------------------------------------------- Shopify specifics

  function findSection(el) {
    const wrap = el.closest('[id^="shopify-section-"]');
    if (!wrap) return null;
    const raw = wrap.id.slice('shopify-section-'.length);
    let m;
    let source = 'static';
    let key = raw;
    if ((m = raw.match(/^template--\d+__(.+)$/))) { source = 'template'; key = m[1]; }
    else if ((m = raw.match(/^sections--\d+__(.+)$/))) { source = 'group'; key = m[1]; }
    const gm = String(wrap.getAttribute('class') || '').match(/shopify-section-group-([\w-]+)/);
    return { wrapperId: wrap.id, source, key, group: gm ? gm[1] : null };
  }
  const sectionShort = (sec) => (!sec ? 'no section' : sec.source === 'group' ? `${sec.group || 'group'} › ${sec.key}` : `section ${sec.key}`);
  const findBlock = (el) => el.closest('[id^="shopify-block-"]')?.id || null;

  function flagsFor(el) {
    const flags = [];
    if (el.closest('.shogun-root, [class^="shg-"], [class*=" shg-"]')) flags.push('shogun');
    if (el.closest('.shopify-app-block')) flags.push('app-block');
    return flags;
  }

  // ---------------------------------------------------------------- styling detection

  const TW = /^(?:[a-z0-9-]+:)*!?-?(?:flex|grid|block|inline|hidden|contents|p[xytrbl]?|m[xytrbl]?|gap|space-[xy]|w|h|min-w|min-h|max-w|max-h|size|text|font|leading|tracking|bg|border|rounded|shadow|ring|outline|items|justify|self|content|place|col|row|top|left|right|bottom|inset|z|opacity|overflow|truncate|underline|uppercase|lowercase|capitalize|transition|duration|ease|cursor|line-clamp|aspect|object|fill|stroke|whitespace|break|shrink|grow|basis|order|divide|sr-only|absolute|relative|fixed|sticky|translate|scale|rotate|animate|pointer-events|select)(?:-|$)/;
  const SHADCN_TOKENS = /(^|:)(bg-primary|bg-background|bg-popover|bg-card|bg-muted|bg-accent|text-foreground|text-muted-foreground|text-primary-foreground|border-input|ring-offset-background|ring-ring)$/;

  function stylingOf(el) {
    const classes = [];
    let n = el;
    for (let i = 0; n && i < 4; i++, n = n.parentElement) classes.push(...n.classList);
    const out = [];
    if (classes.filter((c) => TW.test(c)).length >= 3) out.push('tailwind');
    if (el.closest('[data-slot]') || classes.some((c) => SHADCN_TOKENS.test(c))) out.push('shadcn/ui');
    if (classes.some(decodeModule)) out.push('css-modules');
    if (classes.some((c) => /^sc-/.test(c))) out.push('styled-components');
    if (classes.some((c) => /^css-[a-z0-9]{5,}/.test(c))) out.push('emotion');
    return out;
  }

  // ---------------------------------------------------------------- inspection (DevTools-style)

  function snippet(el) {
    if (el.tagName === 'IMG') return el.alt ? `alt="${el.alt}"` : '';
    const t = (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const kids = el.children.length;
    if (kids > 4 || t.length > 200) return clip(t, 40) + (kids > 4 ? ` … (container, ${kids} children)` : ' …');
    return clip(t, 90);
  }

  function openingTag(el) {
    const tag = el.tagName.toLowerCase();
    const attrs = [...el.attributes]
      .filter((a) => !['srcset', 'sizes'].includes(a.name) && !(a.name === 'style' && (!a.value.trim() || a.value.length > 80)) && !(a.name === 'class' && a.value.length > 240))
      .map((a) => (a.value === '' ? a.name : `${a.name}="${clip(a.value, 80)}"`));
    let out = `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
    if (out.length > 320) out = out.slice(0, 317) + '…>';
    return out;
  }

  const STYLE_PROPS = [
    'display', 'position', 'width', 'height', 'max-width', 'gap', 'flex-direction', 'justify-content', 'align-items',
    'grid-template-columns', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align',
    'text-transform', 'color', 'background-color', 'border-radius', 'box-shadow', 'opacity',
  ];
  const STYLE_SKIP = new Set(['none', 'normal', 'auto', '0px', 'static', 'start', 'stretch', 'row', 'flex-start', '1', 'rgba(0, 0, 0, 0)']);
  const LAYOUT_ONLY = ['gap', 'flex-direction', 'justify-content', 'align-items'];

  function styleSummary(el) {
    const cs = getComputedStyle(el);
    const out = [];
    for (const p of STYLE_PROPS) {
      let v = (cs.getPropertyValue(p) || '').trim();
      if (!v || (p !== 'display' && STYLE_SKIP.has(v))) continue;
      if (p === 'font-family') v = v.split(',')[0].replace(/["']/g, '').trim();
      if (p === 'grid-template-columns' && !/grid/.test(cs.display)) continue;
      if (LAYOUT_ONLY.includes(p) && !/flex|grid/.test(cs.display)) continue;
      if (p === 'width' || p === 'height') {
        const n = parseFloat(v);
        if (Number.isNaN(n)) continue;
        v = `${Math.round(n)}px`;
      }
      out.push(`${p}: ${clip(v, 90)}`);
    }
    return out.join('; ');
  }

  function boxModel(el) {
    const cs = getComputedStyle(el);
    const side = (pre, suf = '') => ['top', 'right', 'bottom', 'left'].map((s) => px(cs.getPropertyValue(`${pre}-${s}${suf}`)));
    const f = (a) => (a.every((v) => v === a[0]) ? `${a[0]}` : a[0] === a[2] && a[1] === a[3] ? `${a[0]} ${a[1]}` : a.join(' '));
    const m = side('margin');
    const b = side('border', '-width');
    const p = side('padding');
    const r = el.getBoundingClientRect();
    const cw = Math.max(0, Math.round(r.width - b[1] - b[3] - p[1] - p[3]));
    const ch = Math.max(0, Math.round(r.height - b[0] - b[2] - p[0] - p[2]));
    return `margin ${f(m)} | border ${f(b)} | padding ${f(p)} | content ${cw}×${ch}`;
  }

  function layoutContext(el) {
    const cs = getComputedStyle(el);
    const parts = [];
    const parent = el.parentElement;
    if (parent) {
      const ps = getComputedStyle(parent);
      if (/flex/.test(ps.display)) {
        parts.push(`flex item in a ${ps.flexDirection} flex parent (gap ${ps.gap}, justify ${ps.justifyContent}, align ${ps.alignItems}${ps.flexWrap !== 'nowrap' ? ', wraps' : ''}); flex: ${cs.flexGrow} ${cs.flexShrink} ${cs.flexBasis}`);
      } else if (/grid/.test(ps.display)) {
        parts.push(`grid item (parent columns: ${clip(ps.gridTemplateColumns, 80)}, gap ${ps.gap}); column ${cs.gridColumnStart} / ${cs.gridColumnEnd}`);
      }
    }
    if (/flex/.test(cs.display)) parts.push(`is a ${cs.flexDirection} flex container (gap ${cs.gap})`);
    else if (/grid/.test(cs.display)) parts.push(`is a grid container (columns: ${clip(cs.gridTemplateColumns, 80)}, gap ${cs.gap})`);
    if (cs.position && cs.position !== 'static') {
      const off = ['top', 'right', 'bottom', 'left'].filter((s) => cs[s] && cs[s] !== 'auto').map((s) => `${s} ${cs[s]}`).join(', ');
      parts.push(`position: ${cs.position}${off ? ` (${off})` : ''}`);
    }
    if (cs.zIndex && cs.zIndex !== 'auto') parts.push(`z-index ${cs.zIndex}`);
    if ((cs.overflowX && cs.overflowX !== 'visible') || (cs.overflowY && cs.overflowY !== 'visible')) parts.push(`overflow ${cs.overflowX} / ${cs.overflowY}`);
    if (cs.transform && cs.transform !== 'none') parts.push('has a transform');
    return parts;
  }

  // Colors in any CSS format (incl. oklch from Tailwind v4) → sRGB via canvas.
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  function rgba(color) {
    const m = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4] };
    if (!cx) return null;
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = '#000';
    cx.fillStyle = color;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  }
  const blend = (top, base) => ({
    r: top.r * top.a + base.r * (1 - top.a),
    g: top.g * top.a + base.g * (1 - top.a),
    b: top.b * top.a + base.b * (1 - top.a),
    a: 1,
  });
  const lum = (c) => {
    const ch = [c.r, c.g, c.b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  function contrastOf(el) {
    const layers = [];
    let assumed = true;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; // gradient or image: can't judge
      const c = rgba(cs.backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) { assumed = false; break; }
      }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of layers.reverse()) base = blend(layer, base);
    let fg = rgba(getComputedStyle(el).color);
    if (!fg) return null;
    if (fg.a < 1) fg = blend(fg, base);
    const [hi, lo] = [lum(fg), lum(base)].sort((a, b) => b - a);
    return { ratio: (hi + 0.05) / (lo + 0.05), fg: hex(fg), bg: hex(base), assumed };
  }

  function accessibleName(el) {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
      return (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.labels?.[0]?.textContent ||
        el.getAttribute('placeholder') || el.getAttribute('title') || (/^(submit|button|reset)$/.test(el.type) ? el.value : '') || '').trim();
    }
    return (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') ||
      (el.innerText ?? el.textContent ?? '').trim() || el.querySelector('img[alt]:not([alt=""]), svg title')?.textContent || el.querySelector('img[alt]')?.alt || '').trim();
  }

  function overflowCulprits(W) {
    const out = [];
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    for (let i = 0; i < Math.min(all.length, 6000); i++) {
      const el = all[i];
      if (S.ui && el === S.ui.host) continue;
      const r = el.getBoundingClientRect();
      if (r.right <= W + 1 || r.width === 0) continue;
      const pr = el.parentElement?.getBoundingClientRect();
      if (pr && pr.right > W + 1) continue; // parent already overflows: report the outermost
      if (getComputedStyle(el).position === 'fixed') continue;
      out.push({ el, by: Math.round(r.right - W) });
    }
    return out.sort((a, b) => b.by - a.by).slice(0, 3).map((o) => `${label(o.el)} (+${o.by}px)`);
  }

  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],[role=menuitem],[role=option]';

  function detectIssues(el) {
    const issues = [];
    const add = (kind, text) => issues.push({ kind, text });
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const W = document.documentElement.clientWidth || window.innerWidth;
    const mobile = window.innerWidth < 750;
    const fs = parseFloat(cs.fontSize) || 16;

    if (cs.display === 'none' || cs.visibility === 'hidden' || (cs.opacity !== '' && +cs.opacity === 0)) add('hidden', 'Not visible (display, visibility, or opacity)');
    if (r.width > 0 && r.right > W + 1) add('offscreen', `Extends ${Math.round(r.right - W)}px past the right edge of the viewport`);
    if (r.width > 0 && r.left < -1) add('offscreen', `Starts ${Math.round(-r.left)}px left of the viewport`);

    if (cs.maxWidth && cs.maxWidth !== 'none' && el.parentElement && r.width > 0) {
      const mw = parseFloat(cs.maxWidth);
      const pr = el.parentElement.getBoundingClientRect();
      const pcs = getComputedStyle(el.parentElement);
      const avail = pr.width - px(pcs.paddingLeft) - px(pcs.paddingRight);
      const free = Math.round(avail - r.width);
      if (!Number.isNaN(mw) && Math.abs(r.width - mw) < 2 && free > 48) {
        const ml = r.left - pr.left - px(pcs.paddingLeft);
        const centered = ml > 8 && Math.abs(ml - free / 2) < 3;
        add('width-cap', `Capped by max-width ${cs.maxWidth} while its parent has ${Math.round(avail)}px available: ${centered ? `centered, about ${Math.round(free / 2)}px of empty space on each side` : ml < 8 ? `left-aligned, ${free}px of empty space on the right` : `${free}px unused`}`);
      }
    }

    const pageOver = document.documentElement.scrollWidth - W;
    if (pageOver > 1) {
      const culprits = overflowCulprits(W);
      add('page-overflow', `Page scrolls sideways by ${pageOver}px${culprits.length ? `. Widest offenders: ${culprits.join(', ')}` : ''}`);
    }

    const ox = el.scrollWidth - el.clientWidth;
    const oy = el.scrollHeight - el.clientHeight;
    if (el.clientWidth > 0 && ox > 1) {
      if (/hidden|clip/.test(cs.overflowX) || cs.textOverflow === 'ellipsis') {
        add('clipped', `Content clipped horizontally (${ox}px hidden)${cs.textOverflow === 'ellipsis' ? ', text truncated with an ellipsis' : ''}`);
      } else if (cs.overflowX === 'visible') {
        add('overflow', `Content overflows its box by ${ox}px`);
      }
    }
    if (el.clientHeight > 0 && oy > 1 && /hidden|clip/.test(cs.overflowY)) add('clipped', `Content clipped vertically (${oy}px hidden)`);

    const tap = el.closest(INTERACTIVE);
    if (tap && getComputedStyle(tap).display !== 'inline') {
      const tr = tap.getBoundingClientRect();
      if (tr.width > 0 && (tr.width < 44 || tr.height < 44)) {
        add('tap', `Tap target ${Math.round(tr.width)}×${Math.round(tr.height)}px${tap !== el ? ` (the ${label(tap)} around it)` : ''}, under the 44×44 recommended for touch`);
      }
    }
    if (tap && !accessibleName(tap)) add('a11y', `${label(tap)} has no accessible name (icon-only? add aria-label)`);

    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (ownText) {
      const c = contrastOf(el);
      const large = fs >= 24 || (fs >= 18.66 && (parseInt(cs.fontWeight, 10) || 400) >= 700);
      const need = large ? 3 : 4.5;
      if (c && c.ratio < need) {
        add('contrast', `Text contrast ${c.ratio.toFixed(2)}:1 (${c.fg} on ${c.bg}${c.assumed ? ', assuming a white page' : ''}), below WCAG AA ${need}:1`);
      }
      if (mobile && fs < 12) add('small-text', `Text is ${cs.fontSize} on a mobile viewport`);
    }

    if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && fs < 16 && !/^(checkbox|radio|range|color|button|submit)$/.test(el.type || '')) {
      add('input-zoom', `Input font-size is ${cs.fontSize}; iOS Safari zooms the page on focus below 16px`);
    }

    if (el.tagName === 'IMG' && el.naturalWidth && r.width > 0) {
      const dpr = window.devicePixelRatio || 1;
      const need = r.width * dpr;
      const dims = `file ${el.naturalWidth}×${el.naturalHeight}, shown at ${Math.round(r.width)}×${Math.round(r.height)}`;
      if (el.naturalWidth < need * 0.75) add('image', `Image upscaled (${dims} on a ${dpr}x screen), likely blurry`);
      else if (el.naturalWidth > need * 3 && el.naturalWidth > 800) add('image', `Image oversized (${dims})`);
      const nr = el.naturalWidth / el.naturalHeight;
      const rr = r.width / r.height;
      if (cs.objectFit === 'fill' && Math.abs(nr - rr) / nr > 0.03) add('image', 'Image stretched: its aspect ratio doesn\u2019t match the box (object-fit: fill)');
      if (!el.hasAttribute('alt')) add('a11y', 'Image has no alt attribute');
    }

    if (r.width > 0 && r.height > 0 && typeof document.elementFromPoint === 'function') {
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight) {
        const top = document.elementFromPoint(x, y);
        if (top && (!S.ui || top !== S.ui.host) && top !== el && !el.contains(top) && !top.contains(el)) {
          add('covered', `Covered at its center by ${label(top)} (check z-index and positioning)`);
        }
      }
    }
    return issues;
  }

  function compactDecl(text) {
    const parts = [];
    let depth = 0;
    let cur = '';
    for (const ch of String(text)) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ';' && depth === 0) { if (cur.trim()) parts.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    let out = '';
    for (const p of parts) {
      const c = clip(p, 110);
      if (out.length + c.length > 900) { out += '; …'; break; }
      out += (out ? '; ' : '') + c;
    }
    return out;
  }

  const RESET_SEL = /^(\*|html|body|:root|:host)$/;
  const isResetSel = (sel) => sel.split(',').every((x) => RESET_SEL.test(x.trim()) || /^\*?::/.test(x.trim()));

  // Same-origin CSS rules that match the element, in cascade order (DevTools "Styles" lite).
  function matchedRules(el, skipUtilities) {
    const found = [];
    let blocked = 0;
    let budget = 20000;
    const visit = (rules, file, media, parent) => {
      for (const r of rules) {
        if (--budget < 0) return;
        if (r instanceof CSSStyleRule) {
          let sel = r.selectorText || '';
          if (parent) sel = sel.includes('&') ? sel.replace(/&/g, `:is(${parent})`) : `${parent} ${sel}`;
          if (!sel || isResetSel(sel)) continue;
          let hit = false;
          try { hit = el.matches(sel); } catch { hit = false; }
          if (hit && skipUtilities) {
            const one = sel.match(/^\.((?:\\.|[^\s.,>+~:[\]()#])+)(?::[a-z-]+(?:\([^)]*\))?)*$/);
            if (one && el.classList.contains(one[1].replace(/\\(.)/g, '$1'))) hit = false;
          }
          if (hit) found.push({ sel: clip(sel, 120), file, media, decl: compactDecl(r.style.cssText) });
          if (r.cssRules && r.cssRules.length) visit(r.cssRules, file, media, sel);
        } else if (r.cssRules) {
          const cond = r.conditionText || r.media?.mediaText || '';
          if (r instanceof CSSMediaRule && cond && window.matchMedia && !matchMedia(cond).matches) continue;
          const tag = r instanceof CSSMediaRule ? `@media ${cond}` : r instanceof CSSSupportsRule ? null : r.constructor?.name === 'CSSContainerRule' ? `@container ${cond}` : null;
          visit(r.cssRules, file, tag || media, parent);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      if (sheet.ownerNode && sheet.ownerNode.id === 'blueline-cursor') continue;
      let rules;
      try { rules = sheet.cssRules; } catch { blocked++; continue; }
      if (!rules) continue;
      if (rules.length === 1 && rules[0].selectorText === 'html, body, body *' && /crosshair/.test(rules[0].cssText || '')) continue; // Blueline's own cursor rule
      const file = sheet.href ? sheet.href.split('?')[0].split('/').pop() : 'inline <style>';
      visit(rules, file, null, null);
    }
    return { rules: found.slice(-8), blocked };
  }

  // ---------------------------------------------------------------- describe

  function describe(el, type) {
    S.page = hook('page') || S.page || {};
    const mode = modeOf(S.page);
    const r = el.getBoundingClientRect();
    const styling = stylingOf(el);
    const react = mode === 'next' || mode === 'react' ? inspectReact(el) : null;
    const modules = [];
    for (let n = el, i = 0; n && i < 3; n = n.parentElement, i++) {
      for (const c of n.classList) {
        const m = decodeModule(c);
        if (m && !modules.some((x) => x.file === m.file && x.cls === m.cls)) modules.push({ ...m, depth: i });
      }
    }
    const tailwind = styling.includes('tailwind');
    const classes = tailwind ? clip([...el.classList].join(' '), 260) : '';
    const matched = matchedRules(el, tailwind);

    const since = Date.now() - 3 * 60 * 1000;
    const wantSteps = type === 'bug' || type === 'feature';
    const logs = wantSteps ? hook('logs') || {} : {};
    const steps = wantSteps
      ? [...crumbs.filter((c) => c.t > since), ...(logs.nav || []).filter((n) => n.t > since).map((n) => ({ kind: 'nav', what: `${n.how} to ${n.url}`, t: n.t }))]
          .sort((a, b) => a.t - b.t).slice(-8).map(({ kind, what, path }) => ({ kind, what, path }))
      : [];
    const consoleLogs = type === 'bug' ? (logs.console || []).filter((c) => c.t > since).slice(-6).map(({ t, ...rest }) => rest) : [];
    const network = wantSteps ? (logs.network || []).filter((n) => n.t > since).slice(-6).map(({ t, ...rest }) => rest) : [];

    return {
      type,
      url: location.href,
      path: currentPath(),
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      page: S.page,
      mode,
      styling,
      el: {
        label: label(el),
        selector: cssPath(el),
        text: snippet(el),
        markup: openingTag(el),
        styles: styleSummary(el),
        box: boxModel(el),
        layout: layoutContext(el),
        size: `${Math.round(r.width)}×${Math.round(r.height)}`,
        issues: detectIssues(el),
        classes,
        modules,
        rules: matched.rules,
        blockedSheets: matched.blocked,
        react,
        section: mode === 'shopify' ? findSection(el) : null,
        block: mode === 'shopify' ? findBlock(el) : null,
        flags: flagsFor(el),
        src: el.closest('[data-blueline-src]')?.getAttribute('data-blueline-src') || null,
      },
      steps,
      console: consoleLogs,
      network,
      armed: !!S.page.armed,
    };
  }

  // ---------------------------------------------------------------- prompt

  const bp = (w) => (w < 750 ? 'mobile' : w < 990 ? 'tablet' : 'desktop');
  const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const DYN = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{12,}|[A-Za-z0-9_-]{20,}|(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]{6,})$/i;
  const ISSUE_LABEL = {
    tap: 'small tap target', contrast: 'low contrast', 'page-overflow': 'sideways page scroll', overflow: 'overflowing box',
    clipped: 'clipped content', image: 'image sizing', 'input-zoom': 'iOS input zoom', 'small-text': 'small text',
    a11y: 'missing accessible name/alt', covered: 'covered element', hidden: 'hidden element', offscreen: 'off-screen element', 'width-cap': 'width cap',
  };

  function routeGuess(it) {
    const next = it.page?.next;
    if (!next) return null;
    if (next.router === 'pages' && next.page) return { file: `pages${next.page === '/' ? '/index' : next.page}.*`, exact: true };
    const segs = it.path.split('#')[0].split('?')[0].split('/').filter(Boolean).map((s) => (DYN.test(s) ? '[id]' : s));
    return { file: `app/${segs.length ? segs.join('/') + '/' : ''}page.*`, exact: false };
  }

  function bestSource(it) {
    const e = it.el || {};
    const rx = e.react || {};
    if (rx.rendered && !/^chunk /.test(rx.rendered)) return rx.rendered.replace(/:\d+$/, '');
    const comp = (rx.components || []).filter((c) => !c.server).slice(-1)[0];
    if (comp) return comp.src && !/^chunk /.test(comp.src) ? comp.src.replace(/:\d+$/, '') : comp.name;
    if (e.modules?.length) return e.modules[0].file;
    if (e.section) return `${e.section.key} section`;
    if (e.rules?.length) return e.rules[e.rules.length - 1].file;
    return e.label;
  }

  function sectionLine(sec, pageType) {
    if (!sec) return 'Section: none found. Likely `layout/theme.liquid`, a snippet rendered outside sections, or app-injected markup.';
    const w = code(sec.wrapperId);
    if (sec.source === 'template') return `Section: ${w}. Key ${code(sec.key)} in \`templates/${pageType || '<page type>'}*.json\` gives the section type.`;
    if (sec.source === 'group') return `Section: ${w}. Key ${code(sec.key)} in \`sections/${sec.group || '<group>'}.json\` gives the section type.`;
    return `Section: ${w}. Static section, likely \`sections/${sec.key}.liquid\`.`;
  }

  const GUIDE = {
    shopify: [
      '**Finding source (Shopify theme):** wrapper ids look like `shopify-section-template--<id>__<key>`. Find `<key>` in the matching JSON template (or section group JSON), read its `type`, then edit `sections/<type>.liquid` and the blocks or snippets it renders.',
      'Items flagged Shogun or app block are not theme code. Describe the fix for those instead of editing.',
    ],
    next: [
      '**Finding source (Next.js/React):** "Rendered at" is where the element\u2019s JSX lives, read from the dev build. Trust it over the selector. A `chunk` value is a Turbopack chunk name: underscores stand in for slashes and dots.',
      'Components run outermost to innermost; "(server)" marks server components. The route file is a guess from the URL: check `src/app`, route groups like `(dashboard)`, and the real dynamic segment names.',
      'CSS module classes are decoded as `File.module.css → .class`. With Tailwind, change utility classes at the call site.',
    ],
    react: [
      '**Finding source (React):** "Rendered at" is where the element\u2019s JSX lives, read from the dev build. Trust it over the selector. Components run outermost to innermost.',
    ],
    html: [
      '**Finding source (static HTML/CSS/JS):** search the source for the element\u2019s id, distinctive classes, or visible text. "Matched rules" lists the stylesheet rules that currently apply, last one wins. Edit those rules rather than stacking overrides.',
    ],
  };

  function buildPrompt(batch) {
    const items = batch?.items || [];
    const pages = new Set(items.map((i) => i.path));
    const modes = [...new Set(items.map((i) => i.mode || 'shopify'))];
    const lead = items[0] || {};
    const p = (items.find((i) => i.page?.theme || i.page?.shop || i.page?.next) || lead).page || {};
    const styling = [...new Set(items.flatMap((i) => i.styling || []))];
    const L = [];

    L.push('# Webpage Change Request');
    L.push(`${plural(items.length, 'item')} on ${plural(pages.size, 'page')}.`);
    L.push('', '## Page');
    try { L.push(`- Site: ${new URL(lead.url).origin}`); } catch { /* ignore */ }
    L.push(`- ${pages.size === 1 ? 'Page' : 'Pages'}: ${[...pages].map((x) => code(x)).join(', ')}`);
    if (lead.title) L.push(`- Title: ${lead.title}`);
    const stack = [];
    if (modes.includes('shopify')) stack.push(`Shopify theme${p.theme ? ` "${p.theme.name}" (${p.theme.role}, id ${p.theme.id})` : ''}${p.shop ? ` on ${p.shop}` : ''}`);
    if (modes.includes('next')) {
      const n = p.next || {};
      stack.push(`Next.js${n.version ? ` ${n.version}` : ''}${n.router ? `, ${n.router === 'app' ? 'App' : 'Pages'} Router` : ''}`);
    }
    if (modes.includes('react')) stack.push('React app');
    if (modes.includes('html')) stack.push('static HTML/CSS/JS');
    if (styling.length) stack.push(`styling looks like ${styling.join(' + ')}`);
    L.push(`- Detected technology (from the live page, may be incomplete): ${stack.join('; ')}`);
    if (items.some((i) => i.el?.react?.minified)) L.push('- Component names look minified (captured from a production build), so component sources may be inexact.');

    L.push('', '## How to read this request');
    L.push('1. Each numbered item is one request about the page and element(s) it names. Items marked **(reference only)** document the page and need no change.');
    L.push('2. Find each element in the source using its selector, visible text, and any source hints. Confirm it is the right element before changing it.');
    L.push('3. Suggested order: bugs, then polish, then copy, then features.');
    L.push('4. Polish and copy items are visual or text only. Don\u2019t change logic or data for them.');
    L.push('5. Before changing something shared (a component, template, or style rule), check where else it is used. Prefer a change scoped to the item, and note which you chose.');
    L.push('6. Limit layout changes to the screen size noted unless the item says otherwise.');
    L.push('7. "Detected" lines come from automated checks. Fix them when they relate to the item; otherwise just mention them.');
    L.push('8. When reporting back, list each item number with what changed, and call out anything skipped, not found, or interpreted.');
    L.push('', '## Finding the source', 'Hints based on the technology detected on the page:');
    for (const m of modes) L.push(...GUIDE[m].map((g) => `- ${g}`));

    // ---- overview
    L.push('', '## Overview');
    const counts = TYPES.map((t) => [t, items.filter((i) => (i.type || 'polish') === t.id).length]).filter(([, n]) => n);
    L.push(`- Types: ${counts.map(([t, n]) => `${n} ${t.label.toLowerCase()}`).join(', ')}`);
    const groups = new Map();
    items.forEach((it, i) => {
      const k = bestSource(it);
      groups.set(k, [...(groups.get(k) || []), i + 1]);
    });
    L.push(`- Likely sources: ${[...groups].map(([k, ns]) => `${code(k)} (item${ns.length > 1 ? 's' : ''} ${ns.join(', ')})`).join('; ')}`);
    const compUse = new Map();
    items.forEach((it, i) => {
      for (const c of (it.el?.react?.components || []).filter((c) => !c.server).slice(-2)) {
        compUse.set(c.name, new Set([...(compUse.get(c.name) || []), i + 1]));
      }
    });
    const shared = [...compUse].filter(([, s]) => s.size > 1);
    if (shared.length) L.push(`- Shared components: ${shared.map(([n, s]) => `${code(n)} in items ${[...s].join(', ')}`).join('; ')}. Change these once, deliberately.`);
    const uiPrims = items.map((it, i) => [it, i + 1]).filter(([it]) => /components\/ui\//.test(JSON.stringify(it.el?.react || {})));
    if (uiPrims.length) L.push(`- ${uiPrims.length === 1 ? 'Item' : 'Items'} ${uiPrims.map(([, n]) => n).join(', ')} ${uiPrims.length === 1 ? 'touches' : 'touch'} \`components/ui/*\` primitives. Use a variant or className at the call site, not the primitive itself.`);
    const issueCounts = {};
    items.forEach((it) => (it.el?.issues || []).forEach((x) => { issueCounts[x.kind] = (issueCounts[x.kind] || 0) + 1; }));
    const ic = Object.entries(issueCounts);
    if (ic.length) L.push(`- Detected: ${ic.map(([k, n]) => `${n}× ${ISSUE_LABEL[k] || k}`).join(', ')}`);
    const order = items.map((it, i) => ({ n: i + 1, rank: (it.priority === 'nice' ? 10 : 0) + (TYPE_RANK[it.type || 'polish'] ?? 1) })).sort((a, b) => a.rank - b.rank || a.n - b.n).map((o) => o.n);
    L.push(`- Suggested order: ${order.join(', ')}`);

    if (BL.hooks.promptHeader) L.push(...BL.hooks.promptHeader(items, batch));

    // ---- items
    items.forEach((it, i) => {
      const e = it.el || {};
      const v = it.viewport || {};
      const rx = e.react;
      L.push('', '---', '');
      L.push(`## ${i + 1}. ${typeLabel(it.type || 'polish')}${it.kind && it.kind !== 'element' ? ' · ' + it.kind : ''}${it.priority === 'nice' ? ' (nice to have)' : ''}${BL.hooks.isReference?.(it) ? ' (reference only)' : ''}: ${it.path}  (${it.bps && it.bps.length ? (it.bps.length === 3 ? 'all breakpoints' : it.bps.join(' + ')) : bp(v.w)}, ${v.w}×${v.h})`);
      L.push(it.note ? `**Note:** ${it.note}` : BL.hooks.noteFallback ? BL.hooks.noteFallback(it) : '**Note:** none written. See the annotations below.');
      if ((it.kind === 'region' || it.kind === 'page') && BL.hooks.promptRegion) {
        L.push(...BL.hooks.promptRegion(it));
        if (BL.hooks.promptItem) L.push(...BL.hooks.promptItem(it, i, items));
        if (it.shotPath) L.push('', `Screenshot: ${it.shotPath}`);
        if (it.markupPath) L.push(`Marked-up screenshot: ${it.markupPath}`);
        return;
      }

      L.push('', '**Where**');
      if (rx?.react) {
        if (rx.rendered) L.push(`- Rendered at: ${code(rx.rendered)}${rx.owner ? ` (inside ${code(rx.owner)})` : ''}`);
        if (rx.components?.length) L.push(`- Components: ${rx.components.map((c) => c.name + (c.server ? ' (server)' : '')).join(' › ')}`);
        const withSrc = (rx.components || []).filter((c) => c.src).slice(-3);
        if (withSrc.length) L.push(`- Component sources: ${withSrc.map((c) => `${c.name} ${code(c.src)}`).join('; ')}`);
      }
      const route = routeGuess(it);
      if (route) L.push(`- Route file${route.exact ? '' : ' (guess)'}: ${code(route.file)}`);
      if (it.mode === 'shopify') {
        L.push(`- ${sectionLine(e.section, it.page?.pageType)}`);
        if (e.block) L.push(`- Block: ${code(e.block)}`);
      }
      if (e.src) L.push(`- Source file (marked in the page): ${code(e.src)}`);
      if (e.flags?.includes('shogun')) L.push(e.src ? `- Shogun custom HTML mapped to ${code(e.src)}: edit that file.` : '- Flag: Shogun Page Builder content. Fix it in Shogun, not the theme.');
      if (e.flags?.includes('app-block')) L.push('- Flag: app block. Fix with app settings or a scoped CSS override.');
      if (e.modules?.length) L.push(`- CSS modules: ${e.modules.map((m) => `${code(m.file)} → ${code('.' + m.cls)}${m.depth ? ` (${m.depth === 1 ? 'parent' : 'grandparent'})` : ''}`).join('; ')}`);
      L.push(`- Element: ${code(e.label)}${e.text ? ` with text "${e.text}"` : ''} (${e.size})`);
      L.push(`- Selector: ${code(e.selector)}`);

      L.push('', '**Inspection**');
      if (e.issues?.length) {
        L.push('- Detected:');
        e.issues.forEach((x) => L.push(`  - ${x.text}`));
      }
      if (e.box) L.push(`- Box: ${e.box}`);
      if (e.layout?.length) L.push(`- Layout: ${e.layout.join('; ')}`);
      if (e.styles) L.push(`- Computed: ${code(e.styles)}`);
      if (e.classes) L.push(`- Classes: ${code(e.classes)}`);
      if (e.rules?.length) {
        L.push('- Matched rules (cascade order):');
        e.rules.forEach((r) => L.push(`  - ${code(r.sel)} in ${r.file}${r.media ? ` ${r.media}` : ''}: ${code(r.decl)}`));
      }
      if (e.blockedSheets && it.mode !== 'next' && it.mode !== 'react') L.push(`- ${plural(e.blockedSheets, 'cross-origin stylesheet')} couldn\u2019t be inspected.`);
      if (e.markup) L.push(`- Markup: ${code(e.markup)}`);

      if (it.steps?.length) {
        L.push('', '**Steps before the note** (oldest first)');
        it.steps.forEach((s, k) => L.push(`${k + 1}. ${s.kind} ${s.what}${s.path && s.path !== it.path ? ` on ${s.path}` : ''}`));
      }
      if (it.console?.length) {
        L.push('', '**Console** (last 3 min)');
        it.console.forEach((c) => L.push(`- ${c.level}: ${code(c.msg)}`));
      }
      if (it.network?.length) {
        L.push('', '**Requests** (failed or writes, last 3 min)');
        it.network.forEach((n) => L.push(`- ${n.method} ${code(n.url)}${n.kind ? ` (${n.kind})` : ''} → ${n.status || 'network error'} in ${n.ms}ms${n.error ? `: ${n.error}` : ''}${n.body ? `. Body: ${code(n.body)}` : ''}`));
      } else if ((it.type === 'bug' || it.type === 'feature') && !it.armed) {
        L.push('', '_Console and network weren\u2019t being recorded yet. Reload the page with Blueline on to capture them._');
      }
      if (BL.hooks.promptItem) L.push(...BL.hooks.promptItem(it, i, items));
      if (it.shotPath) L.push('', `Screenshot: ${it.shotPath}`);
      if (it.markupPath) L.push(`Marked-up screenshot: ${it.markupPath}`);
    });
    return L.join('\n');
  }

  // ---------------------------------------------------------------- storage

  async function loadState() {
    const r = await chrome.storage.local.get([BATCH_KEY, PREFS_KEY]);
    S.batch = r[BATCH_KEY] || null;
    S.prefs = { ...S.prefs, ...(r[PREFS_KEY] || {}) };
  }
  const saveBatch = () => (S.batch ? chrome.storage.local.set({ [BATCH_KEY]: S.batch }) : chrome.storage.local.remove(BATCH_KEY));
  const savePrefs = () => chrome.storage.local.set({ [PREFS_KEY]: S.prefs });

  function ensureBatch() {
    if (!S.batch) {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      S.batch = { id: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`, createdAt: Date.now(), items: [] };
    }
    return S.batch;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !S.active || !changes[BATCH_KEY]) return;
    S.batch = changes[BATCH_KEY].newValue || null;
    render();
  });

  // ---------------------------------------------------------------- screenshots

  function loadImg(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function captureElement(el) {
    if (!el || !el.isConnected || !S.ui) return null;
    S.ui.host.style.visibility = 'hidden';
    await frames(2);
    const r = el.getBoundingClientRect();
    const res = await send({ type: 'blueline:capture' });
    if (S.ui) S.ui.host.style.visibility = '';
    if (!res?.dataUrl) return null;
    try {
      const img = await loadImg(res.dataUrl);
      const scale = window.devicePixelRatio || img.naturalWidth / window.innerWidth;
      const pad = 24;
      const x0 = Math.max(0, r.left - pad);
      const y0 = Math.max(0, r.top - pad);
      const x1 = Math.min(window.innerWidth, r.right + pad);
      const y1 = Math.min(window.innerHeight, r.bottom + pad);
      const w = x1 - x0;
      const h = y1 - y0;
      if (w < 4 || h < 4) return null;
      const k = scale * Math.min(1, 1400 / (Math.max(w, h) * scale));
      const c = document.createElement('canvas');
      c.width = Math.round(w * k);
      c.height = Math.round(h * k);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, x0 * scale, y0 * scale, w * scale, h * scale, 0, 0, c.width, c.height);
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(2, 2 * k);
      ctx.strokeRect((r.left - x0) * k, (r.top - y0) * k, r.width * k, r.height * k);
      return c.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- UI

  const STYLES = `
    :host { all: initial; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1E2230; }
    button, input, textarea, select { font-family: inherit; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    [hidden] { display: none !important; }
    .panel, .pop, .modal, .toast, .pin, .hl-tag {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px; line-height: 1.4; color: #1E2230; -webkit-font-smoothing: antialiased;
    }
    button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
    button:focus-visible, textarea:focus-visible, input:focus-visible, li:focus-visible { outline: 2px solid ${INK}; outline-offset: 2px; }
    code, kbd, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }

    .hl { position: fixed; pointer-events: none; border: 2px solid ${INK}; background: rgba(43,78,255,.08); border-radius: 2px; }
    .hl.locked { background: rgba(43,78,255,.14); box-shadow: 0 0 0 9999px rgba(30,34,48,.16); }
    .hl-tag { position: absolute; left: -2px; bottom: 100%; margin-bottom: 3px; background: ${INK}; color: #fff;
      padding: 2px 6px; border-radius: 3px; font: 500 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: nowrap; max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
    .hl-tag.below { bottom: auto; top: 100%; margin: 3px 0 0; }

    .pin { position: fixed; width: 22px; height: 22px; border-radius: 50%; background: ${INK}; color: #fff;
      font-weight: 700; font-size: 11px; line-height: 22px; text-align: center; pointer-events: auto;
      box-shadow: 0 0 0 2px #fff, 0 2px 6px rgba(30,34,48,.35); }
    .pin.bug { background: #D6336C; }
    .pin:hover { transform: scale(1.12); }

    .panel { position: fixed; bottom: 16px; right: 16px; width: 330px; max-height: min(70vh, 580px);
      display: flex; flex-direction: column; background: #fff; border: 1px solid #D9DCE4; border-radius: 10px;
      box-shadow: 0 12px 32px rgba(30,34,48,.18); overflow: hidden; pointer-events: auto; }
    .panel.left { right: auto; left: 16px; }
    .panel.collapsed .body, .panel.collapsed .foot { display: none; }
    .bar { display: flex; align-items: center; justify-content: space-between; padding: 6px 6px 6px 12px; border-bottom: 1px solid #EDEFF3; }
    .panel.collapsed .bar { border-bottom: 0; }
    .brand { display: flex; align-items: center; gap: 8px; font-weight: 650; padding: 4px 0; }
    .mark { width: 14px; height: 3px; background: ${INK}; border-radius: 2px; }
    .count { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: #EEF1FF; color: #1A33C7;
      font-size: 11px; font-weight: 700; line-height: 18px; text-align: center; }
    .count:empty { display: none; }
    .mode { font-size: 11px; font-weight: 500; color: #6B7183; border: 1px solid #E2E5EC; border-radius: 4px; padding: 0 5px; line-height: 16px; }
    .tools { display: flex; gap: 2px; }
    .icon { width: 26px; height: 26px; border-radius: 6px; color: #6B7183; font-size: 13px; line-height: 26px; text-align: center; }
    .icon:hover { background: #F2F3F7; color: #1E2230; }

    .body { padding: 10px 12px; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
    .pick { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 10px; border: 1.5px dashed #B9C3FF;
      border-radius: 8px; color: #1A33C7; font-weight: 600; text-align: left; }
    .pick:hover { background: #F5F7FF; }
    .pick.on { border-style: solid; border-color: ${INK}; background: ${INK}; color: #fff; }
    .pick-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
    .pick.on .pick-dot { animation: pulse 1.2s ease-in-out infinite; }
    .pick-label { flex: 1; }
    .pick kbd { font-size: 11px; opacity: .7; }
    .pick-hint, .empty { font-size: 12px; color: #6B7183; }

    .list { list-style: none; display: flex; flex-direction: column; }
    .item { display: flex; gap: 10px; align-items: flex-start; padding: 8px 4px; border-top: 1px solid #F0F1F5; cursor: pointer; border-radius: 6px; }
    .item:first-child { border-top: 0; }
    .item:hover { background: #F7F8FB; }
    .num { flex: none; width: 20px; height: 20px; border-radius: 50%; background: ${INK}; color: #fff;
      font-size: 11px; font-weight: 700; line-height: 20px; text-align: center; margin-top: 1px; }
    .item.bug .num { background: #D6336C; }
    .item.away .num { background: #fff; color: ${INK}; box-shadow: inset 0 0 0 1.5px ${INK}; }
    .item.away.bug .num { color: #D6336C; box-shadow: inset 0 0 0 1.5px #D6336C; }
    .txt { flex: 1; min-width: 0; }
    .note { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; word-break: break-word; }
    .meta { margin-top: 2px; color: #6B7183; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .warn { color: #A15C00; }
    .go { margin-top: 4px; color: #1A33C7; font-size: 12px; font-weight: 600; }
    .go:hover { text-decoration: underline; }
    .item .del { opacity: 0; flex: none; }
    .item:hover .del, .item:focus-within .del { opacity: 1; }

    .foot { display: flex; justify-content: space-between; gap: 8px; padding: 10px 12px; border-top: 1px solid #EDEFF3; background: #FAFBFC; }
    .primary { background: ${INK}; color: #fff; font-weight: 600; padding: 7px 12px; border-radius: 7px; }
    .primary:hover { background: #1A33C7; }
    .primary:disabled { background: #C9D0F5; cursor: default; }
    .ghost { padding: 7px 10px; border-radius: 7px; color: #4A5063; font-weight: 500; }
    .ghost:hover { background: #F2F3F7; }
    .ghost:disabled { opacity: .4; cursor: default; }
    .ghost.armed, .ghost.danger { color: #C62F2F; }

    .pop { position: fixed; width: 320px; background: #fff; border: 1px solid #D9DCE4; border-radius: 10px;
      box-shadow: 0 12px 32px rgba(30,34,48,.22); padding: 10px; pointer-events: auto; display: flex; flex-direction: column; gap: 8px; }
    .pop-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
    .pop-el { color: #1A33C7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pop-sec { color: #6B7183; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; }
    .types { display: flex; gap: 4px; }
    .type { flex: 1; padding: 4px 0; border: 1px solid #D9DCE4; border-radius: 6px; font-size: 12px; font-weight: 600; color: #4A5063; }
    .type:hover { background: #F5F7FF; }
    .type[aria-pressed="true"] { background: ${INK}; border-color: ${INK}; color: #fff; }
    .type.bug[aria-pressed="true"] { background: #D6336C; border-color: #D6336C; }
    .issues { list-style: none; display: flex; flex-direction: column; gap: 2px; font-size: 11.5px; color: #A15C00;
      background: #FFF8EC; border-radius: 6px; padding: 6px 8px; }
    .issues li::before { content: "! "; font-weight: 700; }
    .pop-note { width: 100%; min-height: 76px; resize: vertical; border: 1px solid #D9DCE4; border-radius: 7px; padding: 8px;
      font: inherit; color: #1E2230; background: #fff; }
    .pop-note:focus { outline: none; border-color: ${INK}; box-shadow: 0 0 0 3px rgba(43,78,255,.15); }
    .pop-note.need { border-color: #C62F2F; }
    .pop-foot { display: flex; align-items: center; gap: 4px; }
    .hint { flex: 1; color: #8A90A2; font-size: 11px; }

    .modal { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(30,34,48,.4);
      display: flex; align-items: center; justify-content: center; padding: 24px; pointer-events: auto; }
    .sheet { width: min(800px, 100%); max-height: 100%; display: flex; flex-direction: column; background: #fff;
      border-radius: 12px; box-shadow: 0 24px 60px rgba(30,34,48,.3); overflow: hidden; }
    .sheet-head { display: flex; justify-content: space-between; align-items: center; padding: 12px 12px 8px 16px; }
    .sheet-head h2 { font-size: 15px; font-weight: 650; }
    .opt { display: flex; gap: 8px; align-items: center; padding: 0 16px 10px; color: #4A5063; font-size: 12.5px; cursor: pointer; }
    .out { flex: 1; min-height: 360px; margin: 0 16px; border: 1px solid #D9DCE4; border-radius: 8px; padding: 10px;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #1E2230; background: #FAFBFC; resize: none; }
    .sheet-foot { display: flex; align-items: center; gap: 8px; padding: 12px 16px; }
    .status { flex: 1; color: #6B7183; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #1E2230; color: #fff;
      padding: 8px 14px; border-radius: 8px; font-size: 12.5px; pointer-events: none; box-shadow: 0 8px 24px rgba(30,34,48,.3); }

    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
    @media (prefers-reduced-motion: reduce) { .pick.on .pick-dot { animation: none; } .pin:hover { transform: none; } }
  `;

  const HTML = `
    <style>${STYLES}</style>
    <div class="hl" hidden><span class="hl-tag"></span></div>
    <div class="pins"></div>
    <section class="panel" aria-label="Blueline QC">
      <header class="bar">
        <button class="brand" data-act="expand" title="Blueline"><span class="mark"></span>Blueline <span class="count"></span><span class="mode"></span></button>
        <div class="tools">
          <button class="icon" data-act="side" title="Move panel to the other side" aria-label="Move panel">⇆</button>
          <button class="icon" data-act="collapse" title="Minimize" aria-label="Minimize">–</button>
          <button class="icon" data-act="close" title="Turn off Blueline (Alt+Shift+Q)" aria-label="Turn off">✕</button>
        </div>
      </header>
      <div class="body">
        <button class="pick" data-act="pick"><span class="pick-dot"></span><span class="pick-label">Pick an element</span><kbd>Alt+P</kbd></button>
        <p class="pick-hint" hidden>Click to add a note. ↑ ↓ to jump to the parent or child, Enter to select, Esc to stop. Open a menu or modal first, then press Alt+P to pick inside it.</p>
        <div class="x-tools"></div>
        <ol class="list"></ol>
        <p class="empty">Click Pick, then click anything on the page and say what should change. Notes stay in this batch as you move between pages.</p>
      </div>
      <footer class="foot">
        <button class="ghost" data-act="clear">Clear batch</button>
        <button class="primary" data-act="export">Export prompt</button>
      </footer>
    </section>
    <div class="pop" hidden role="dialog" aria-label="Note">
      <div class="pop-head"><code class="pop-el"></code><span class="pop-sec"></span></div>
      <div class="x-sel"></div>
      <div class="x-step2"></div>
      <div class="types" role="group" aria-label="Note type">
        ${TYPES.map((t) => `<button class="type ${t.id}" data-type="${t.id}" aria-pressed="false" title="${t.tip}">${t.ui || t.label}</button>`).join('')}
      </div>
      <div class="x-typehint"></div>
      <textarea class="pop-note" rows="3" placeholder="What should change?"></textarea>
      <div class="x-top"></div>
      <ul class="issues" hidden></ul>
      <div class="x-more"></div>
      <div class="pop-foot">
        <button class="ghost danger" data-act="pop-delete" hidden>Delete</button>
        <span class="hint">${IS_MAC ? '⌘↵' : 'Ctrl+Enter'} to save</span>
        <button class="ghost" data-act="pop-cancel">Cancel</button>
        <button class="primary" data-act="pop-save">Save note</button>
      </div>
    </div>
    <div class="modal" hidden>
      <div class="sheet" role="dialog" aria-label="Export prompt">
        <header class="sheet-head"><h2>Webpage change request</h2><button class="icon" data-act="modal-close" aria-label="Close">✕</button></header>
        <label class="opt"><input type="checkbox" class="opt-shots"> Save screenshots to Downloads and add their paths</label>
        <textarea class="out" readonly spellcheck="false"></textarea>
        <footer class="sheet-foot">
          <span class="status"></span>
          <button class="ghost" data-act="save-md">Save as .md</button>
          <button class="primary" data-act="copy">Copy prompt</button>
        </footer>
      </div>
    </div>
    <div class="toast" hidden></div>
  `;

  function mount() {
    if (S.ui) return;
    const host = document.createElement('blueline-ui');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1E2230;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = HTML;
    document.documentElement.appendChild(host);
    S.ui = { host, root, $: (sel) => root.querySelector(sel) };
    wireUI(root);
    if (BL.hooks.onMount) BL.hooks.onMount(root);
  }

  function unmount() {
    if (!S.ui) return;
    if (BL.hooks.onUnmount) BL.hooks.onUnmount();
    S.ui.host.remove();
    S.ui = null;
  }

  function wireUI(root) {
    // Keep the app's menus, dialogs, and focus traps from reacting to our UI.
    ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'focusin', 'focusout', 'keyup', 'input'].forEach((t) =>
      root.addEventListener(t, (e) => e.stopPropagation()));

    root.addEventListener('click', (e) => {
      const pin = e.target.closest('.pin');
      if (pin) {
        const it = findItem(pin.dataset.id);
        if (it) openPop(pin._el || null, it);
        return;
      }
      const typeBtn = e.target.closest('.type');
      if (typeBtn) { setPopType(typeBtn.dataset.type); return; }
      const actEl = e.target.closest('[data-act]');
      const li = e.target.closest('.item');
      // A minimized panel expands from a click anywhere on its title bar except the other header buttons.
      if (S.prefs.collapsed && e.target.closest('.bar') && (!actEl || actEl.dataset.act === 'expand') && !e.target.closest('.tools button')) {
        S.prefs.collapsed = false; savePrefs(); render(); return;
      }
      switch (actEl?.dataset.act) {
        case 'expand': return;
        case 'pick': setPicking(!S.picking); return;
        case 'side': S.prefs.side = S.prefs.side === 'left' ? 'right' : 'left'; savePrefs(); render(); return;
        case 'collapse': S.prefs.collapsed = !S.prefs.collapsed; savePrefs(); render(); return;
        case 'close': send({ type: 'blueline:toggle', on: false }); return;
        case 'export': openExport(); return;
        case 'clear': clearBatch(actEl); return;
        case 'del': if (li) deleteItem(li.dataset.id); return;
        case 'go': { const it = li && findItem(li.dataset.id); if (it) location.href = it.url; return; }
        case 'pop-save': savePop(); return;
        case 'pop-cancel': closePop(); return;
        case 'pop-delete': { const id = S.pop?.item?.id; closePop(); if (id) deleteItem(id); return; }
        case 'modal-close': closeModal(); return;
        case 'copy': copyOut(); return;
        case 'save-md': saveMd(); return;
        default: break;
      }
      if (e.target.classList.contains('modal')) { closeModal(); return; }
      if (li) focusItem(li.dataset.id);
    });

    root.addEventListener('change', (e) => {
      if (e.target.classList.contains('opt-shots')) {
        S.prefs.saveShots = e.target.checked;
        savePrefs();
        refreshExport();
      }
    });

    root.addEventListener('keydown', (e) => {
      if (S.pop && e.target.classList?.contains('pop-note')) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); savePop(); }
        // Esc never throws away annotations: it only closes a note that has nothing in it yet.
        else if (e.key === 'Escape') { e.preventDefault(); if (e.target.value.trim() || BL.hooks.popHasWork?.()) e.target.blur(); else closePop(); }
      } else if (e.key === 'Escape' && !S.ui.$('.modal').hidden) {
        closeModal();
      } else if (e.key === 'Enter' && e.target.classList?.contains('item')) {
        focusItem(e.target.dataset.id);
      }
      e.stopPropagation();
    });
  }

  function render() {
    if (!S.ui) return;
    const $ = S.ui.$;
    const items = S.batch?.items || [];
    const here = currentPath();

    const panel = $('.panel');
    panel.classList.toggle('left', S.prefs.side === 'left');
    panel.classList.toggle('collapsed', !!S.prefs.collapsed);
    const min = $('.tools [data-act="collapse"]');
    min.title = S.prefs.collapsed ? 'Expand' : 'Minimize';
    min.setAttribute('aria-label', min.title);
    $('.brand').title = S.prefs.collapsed ? `Expand Blueline ${VERSION}` : `Blueline ${VERSION}`;
    $('.count').textContent = items.length || '';
    $('.mode').textContent = MODE_LABEL[modeOf(S.page)];
    $('.empty').hidden = items.length > 0;
    $('[data-act="export"]').disabled = !items.length;
    $('[data-act="clear"]').disabled = !items.length;
    $('.pick').classList.toggle('on', S.picking);
    $('.pick-label').textContent = S.picking ? 'Picking. Esc to stop' : 'Pick an element';
    $('.pick-hint').hidden = !S.picking;

    const list = $('.list');
    list.textContent = '';
    items.forEach((it, i) => {
      const onPage = it.path === here;
      const li = document.createElement('li');
      li.className = `item ${it.type || 'polish'}${onPage ? '' : ' away'}`;
      li.dataset.id = it.id;
      li.tabIndex = 0;
      li.innerHTML = '<span class="num"></span><div class="txt"><p class="note"></p><p class="meta mono"></p></div><button class="icon del" data-act="del" title="Delete note" aria-label="Delete note">✕</button>';
      li.querySelector('.num').textContent = i + 1;
      li.querySelector('.note').textContent = it.note;
      const issues = it.el?.issues?.length ? `  ${it.el.issues.length} detected` : '';
      const meta = li.querySelector('.meta');
      meta.textContent = `${typeLabel(it.type)}${it.kind && it.kind !== 'element' ? ' · ' + it.kind : ''}${it.priority === 'nice' ? ' · nice' : ''}  ${onPage ? it.el.label : `${it.path}  ${it.el.label}`}`;
      if (issues) { const w = document.createElement('span'); w.className = 'warn'; w.textContent = issues; meta.appendChild(w); }
      if (!onPage) {
        const go = document.createElement('button');
        go.className = 'go';
        go.dataset.act = 'go';
        go.textContent = 'Open page';
        li.querySelector('.txt').appendChild(go);
      }
      list.appendChild(li);
    });
    renderPins();
    if (BL.hooks.afterRender) BL.hooks.afterRender();
  }

  function renderPins() {
    if (!S.ui || BL.docked) return;
    const box = S.ui.$('.pins');
    box.textContent = '';
    const here = currentPath();
    (S.batch?.items || []).forEach((it, i) => {
      if (it.path !== here || it.kind === 'region') return;
      const pin = document.createElement('button');
      pin.className = `pin ${it.type || 'polish'}`;
      pin.textContent = i + 1;
      pin.title = it.note;
      pin.dataset.id = it.id;
      pin.dataset.sel = it.el.selector;
      pin._el = query(it.el.selector);
      box.appendChild(pin);
    });
    positionPins();
  }

  function positionPins() {
    if (!S.ui) return;
    for (const pin of S.ui.root.querySelectorAll('.pin')) {
      if (!pin._el || !pin._el.isConnected) pin._el = query(pin.dataset.sel); // hot reload swapped the node
      const el = pin._el;
      if (!el) { pin.hidden = true; continue; }
      const r = el.getBoundingClientRect();
      pin.hidden = r.bottom < 0 || r.top > window.innerHeight || (r.width === 0 && r.height === 0);
      pin.style.left = Math.max(4, Math.min(window.innerWidth - 26, r.left - 10)) + 'px';
      pin.style.top = Math.max(4, r.top - 10) + 'px';
    }
  }

  function schedule() {
    if (S.raf) return;
    S.raf = requestAnimationFrame(() => {
      S.raf = 0;
      positionPins();
      if (BL.hooks.onSchedule) BL.hooks.onSchedule();
      if (S.pop?.el && !BL.docked) drawHL(S.pop.el, true);
      else if (S.picking && S.hoverEl) drawHL(S.hoverEl);
    });
  }

  function whereShort(el) {
    const mode = modeOf(S.page);
    if (mode === 'shopify') return sectionShort(findSection(el));
    const mod = [...el.classList].map(decodeModule).find(Boolean);
    return mod ? mod.file : '';
  }

  function drawHL(el, locked = false) {
    if (!S.ui || !el?.isConnected) return;
    const hl = S.ui.$('.hl');
    const r = el.getBoundingClientRect();
    hl.hidden = false;
    hl.classList.toggle('locked', locked);
    hl.style.left = r.left + 'px';
    hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px';
    hl.style.height = r.height + 'px';
    const tag = S.ui.$('.hl-tag');
    const where = whereShort(el);
    tag.textContent = `${label(el)}  ${Math.round(r.width)}×${Math.round(r.height)}${where ? '  ' + where : ''}`;
    tag.classList.toggle('below', r.top < 24);
  }

  function hideHL() {
    if (!S.ui) return;
    const hl = S.ui.$('.hl');
    hl.hidden = true;
    hl.classList.remove('locked');
  }

  function toast(msg) {
    const t = S.ui?.$('.toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(S.toastT);
    S.toastT = setTimeout(() => { t.hidden = true; }, 2600);
  }

  function cursorStyle(on) {
    let st = document.getElementById('blueline-cursor');
    if (on && !st) {
      st = document.createElement('style');
      st.id = 'blueline-cursor';
      st.textContent = 'html, body, body * { cursor: crosshair !important; user-select: none !important; -webkit-user-select: none !important; }';
      (document.head || document.documentElement).appendChild(st);
    } else if (!on && st) {
      st.remove();
    }
  }

  // ---------------------------------------------------------------- picking

  function setPicking(on) {
    if (on && BL.hooks.cancelTools) BL.hooks.cancelTools();
    S.picking = on;
    S.hoverEl = null;
    S.trail = [];
    S.lockPoint = null;
    if (!S.pop) hideHL();
    cursorStyle(on && !S.pop);
    render();
  }

  const isEditable = (e) => {
    const t = e.composedPath()[0];
    return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
  };

  function onMove(e) {
    S.lastPoint = { x: e.clientX, y: e.clientY };
    if (!S.picking || S.pop) return;
    if (fromUI(e)) { hideHL(); return; }
    if (S.lockPoint) {
      if (Math.hypot(e.clientX - S.lockPoint.x, e.clientY - S.lockPoint.y) < 8) return;
      S.lockPoint = null;
    }
    const el = e.target;
    if (!(el instanceof Element) || el === document.body || el === document.documentElement) {
      S.hoverEl = null;
      hideHL();
      return;
    }
    if (el !== S.hoverEl) { S.hoverEl = el; S.trail = []; }
    drawHL(el);
  }

  function onBlock(e) {
    if (!S.picking || fromUI(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (S.pop) return;
    if (e.type === 'click' && e.button === 0) {
      const el = S.hoverEl || e.target;
      if (el instanceof Element && el !== document.body && el !== document.documentElement) openPop(el);
    }
  }

  // Focus leaving the app for our note box shouldn't close its menus or trip focus traps.
  function onFocusGuard(e) {
    if (S.ui && e.relatedTarget === S.ui.host) e.stopImmediatePropagation();
  }

  function onKey(e) {
    if (!S.active) return;
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyP' && !isEditable(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (BL.hooks.toggleAnnotate) BL.hooks.toggleAnnotate(); else setPicking(!S.picking);
      return;
    }
    if (fromUI(e) || !S.picking || S.pop) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      setPicking(false);
      return;
    }
    if (!S.hoverEl) return;
    if (e.key === 'ArrowUp') {
      const p = S.hoverEl.parentElement;
      if (p && p !== document.body && p !== document.documentElement) { S.trail.push(S.hoverEl); S.hoverEl = p; }
    } else if (e.key === 'ArrowDown') {
      const c = S.trail.pop() || S.hoverEl.firstElementChild;
      if (c) S.hoverEl = c;
    } else if (e.key === 'Enter') {
      openPop(S.hoverEl);
    } else {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    S.lockPoint = { ...S.lastPoint };
    if (!S.pop) drawHL(S.hoverEl);
  }

  const BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick'];

  function attach() {
    window.addEventListener('mousemove', onMove, true);
    BLOCKED.forEach((t) => window.addEventListener(t, onBlock, true));
    ['focusout', 'blur'].forEach((t) => window.addEventListener(t, onFocusGuard, true));
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    window.addEventListener('popstate', render);
    S.timer = setInterval(() => { schedule(); if (S.ui && S.lastRenderPath !== currentPath()) { S.lastRenderPath = currentPath(); render(); } }, 800);
  }

  function detach() {
    window.removeEventListener('mousemove', onMove, true);
    BLOCKED.forEach((t) => window.removeEventListener(t, onBlock, true));
    ['focusout', 'blur'].forEach((t) => window.removeEventListener(t, onFocusGuard, true));
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('popstate', render);
    clearInterval(S.timer);
  }

  // ---------------------------------------------------------------- notes

  function setPopType(type) {
    S.popType = type;
    for (const b of S.ui.root.querySelectorAll('.type')) b.setAttribute('aria-pressed', String(b.dataset.type === type));
  }

  function openPop(el, item = null, extra = null) {
    if (!S.ui) return;
    if (S.pop) closePop();
    S.pop = { el, item, ...(extra || {}) };
    cursorStyle(false);
    const $ = S.ui.$;
    $('.pop-el').textContent = el ? label(el) : item?.el?.label || '';
    $('.pop-sec').textContent = el ? whereShort(el) : item ? bestSource(item) : '';
    setPopType(item?.type || S.prefs.lastType || 'polish');

    const issues = el ? detectIssues(el) : item?.el?.issues || [];
    const ul = $('.issues');
    ul.textContent = '';
    issues.slice(0, 3).forEach((x) => { const li = document.createElement('li'); li.textContent = x.text; ul.appendChild(li); });
    if (issues.length > 3) { const li = document.createElement('li'); li.textContent = `${issues.length - 3} more in the export`; ul.appendChild(li); }
    ul.hidden = !issues.length;

    const ta = $('.pop-note');
    ta.value = item?.note || '';
    ta.classList.remove('need');
    ta.placeholder = 'What should change?';
    $('[data-act="pop-delete"]').hidden = !item;
    $('[data-act="pop-save"]').textContent = item ? 'Update note' : 'Save note';
    $('.pop').hidden = false;
    if (el) drawHL(el, true); else hideHL();
    if (BL.hooks.onPopOpen) BL.hooks.onPopOpen(el, item);
    placePop(el);
    setTimeout(() => ta.focus(), 0);
  }

  function placePop(el) {
    if (BL.docked) return;
    const $ = S.ui.$;
    const pop = $('.pop');
    const pw = pop.offsetWidth || 320;
    const ph = pop.offsetHeight || 220;
    const m = 8;
    const W = window.innerWidth;
    const H = window.innerHeight;
    let top;
    let left;
    if (el) {
      const r = el.getBoundingClientRect();
      left = Math.min(Math.max(m, r.left), W - pw - m);
      if (r.bottom + m + ph <= H) top = r.bottom + m;
      else if (r.top - m - ph >= 0) top = r.top - m - ph;
      else {
        top = H - ph - 16;
        left = S.prefs.side === 'left' ? W - pw - 16 : 16;
      }
    } else {
      const pr = $('.panel').getBoundingClientRect();
      left = Math.min(Math.max(m, pr.left), W - pw - m);
      top = Math.max(m, pr.top - ph - m);
    }
    top = Math.max(m, Math.min(top, H - Math.min(ph, H - 2 * m) - m));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function closePop() {
    if (!S.ui) { S.pop = null; return; }
    if (BL.hooks.onPopClose) BL.hooks.onPopClose();
    S.pop = null;
    S.ui.$('.pop').hidden = true;
    hideHL();
    cursorStyle(S.picking);
  }

  async function savePop() {
    if (!S.pop) return;
    const ta = S.ui.$('.pop-note');
    const popState = S.pop;
    const extra = BL.hooks.collect ? BL.hooks.collect(popState) : { fields: {} };
    const blocked = BL.hooks.blockSave?.();
    if (blocked) { toast(blocked); return; }
    const note = ta.value.trim();
    // Annotations (measurements, drawings, alignment, CSS, element actions) can stand on their own.
    if (!note && !extra.hasContent) {
      ta.classList.add('need');
      ta.placeholder = 'Describe the change, or add an annotation first';
      ta.focus();
      return;
    }
    const { el, item } = popState;
    const type = S.popType;
    S.prefs.lastType = type;
    savePrefs();
    if (extra.commit) extra.commit();
    closePop();

    if (item) {
      const it = findItem(item.id);
      if (it) { it.note = note; it.type = type; it.updatedAt = Date.now(); Object.assign(it, extra.fields || {}); }
      await saveBatch();
      if (it && extra.onSaved) await extra.onSaved(it);
      render();
      toast('Note updated');
      return;
    }

    ensureBatch();
    let info;
    if ((popState.region || popState.page) && BL.hooks.describeRegion) {
      info = BL.hooks.describeRegion(popState, type);
    } else {
      try {
        info = extra.around ? extra.around(() => describe(el, type)) : describe(el, type);
      } catch (err) {
        info = { type, url: location.href, path: currentPath(), viewport: { w: innerWidth, h: innerHeight }, page: S.page, mode: modeOf(S.page), el: { label: label(el), selector: cssPath(el), size: '' } };
        console.warn('Blueline: inspection failed', err);
      }
    }
    const it = { id: uid(), note, createdAt: Date.now(), ...info, ...(extra.fields || {}) };
    S.batch.items.push(it);
    await saveBatch();
    if (extra.onSaved) await extra.onSaved(it);
    render();

    const shot = popState.region && BL.hooks.captureRegion ? await BL.hooks.captureRegion(popState.region) : popState.page ? null : await captureElement(el);
    if (shot) {
      await chrome.storage.local.set({ [shotKey(it.id)]: shot });
      const fresh = findItem(it.id);
      if (fresh) { fresh.hasShot = true; await saveBatch(); }
    }
  }

  function focusItem(id) {
    const it = findItem(id);
    if (!it) return;
    if (it.kind === 'region' && BL.hooks.focusRegion) { BL.hooks.focusRegion(it); return; }
    if (it.kind === 'page') { openPop(null, it); return; }
    if (it.path !== currentPath()) { openPop(null, it); return; }
    const el = query(it.el.selector);
    if (!el) {
      openPop(null, it);
      toast('That element isn\u2019t on the page anymore. Edit or delete the note.');
      return;
    }
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    setTimeout(() => openPop(el, it), smooth ? 380 : 0);
  }

  async function deleteItem(id) {
    if (!S.batch) return;
    const gone = findItem(id);
    if (gone && BL.hooks.onItemDeleted) BL.hooks.onItemDeleted(gone);
    S.batch.items = S.batch.items.filter((i) => i.id !== id);
    chrome.storage.local.remove([shotKey(id), shotKey(id) + ':markup']);
    if (!S.batch.items.length) S.batch = null;
    await saveBatch();
    render();
    toast('Note deleted');
  }

  async function clearBatch(btn) {
    if (!S.clearArmed) {
      btn.textContent = 'Click again to clear';
      btn.classList.add('armed');
      S.clearArmed = setTimeout(() => {
        S.clearArmed = 0;
        btn.textContent = 'Clear batch';
        btn.classList.remove('armed');
      }, 3000);
      return;
    }
    clearTimeout(S.clearArmed);
    S.clearArmed = 0;
    btn.textContent = 'Clear batch';
    btn.classList.remove('armed');
    const keys = (S.batch?.items || []).flatMap((i) => [shotKey(i.id), shotKey(i.id) + ':markup']);
    if (keys.length) chrome.storage.local.remove(keys);
    if (BL.hooks.onClear) BL.hooks.onClear();
    S.batch = null;
    await saveBatch();
    render();
    toast('Batch cleared');
  }

  // ---------------------------------------------------------------- export

  async function openExport() {
    if (!S.batch?.items.length) return;
    if (S.picking) setPicking(false);
    S.ui.$('.modal').hidden = false;
    S.ui.$('.opt-shots').checked = !!S.prefs.saveShots;
    await refreshExport();
    S.ui.$('[data-act="copy"]').focus();
  }

  function closeModal() {
    if (S.ui) S.ui.$('.modal').hidden = true;
  }

  async function refreshExport() {
    const $ = S.ui.$;
    const status = $('.status');
    status.textContent = '';
    if (S.prefs.saveShots && S.batch) {
      const todo = [];
      S.batch.items.forEach((i, idx) => {
        const n = String(idx + 1).padStart(2, '0');
        if (i.hasShot && !i.shotPath) todo.push({ it: i, field: 'shotPath', key: shotKey(i.id), name: `${n}-${i.id.slice(0, 4)}.png` });
        if (i.hasMarkup && !i.markupPath) todo.push({ it: i, field: 'markupPath', key: shotKey(i.id) + ':markup', name: `${n}-${i.id.slice(0, 4)}-markup.png` });
      });
      if (todo.length) {
        status.textContent = `Saving ${plural(todo.length, 'image')}…`;
        const data = await chrome.storage.local.get(todo.map((t) => t.key));
        const files = todo.filter((t) => data[t.key]).map((t) => ({ id: t.key, name: t.name, dataUrl: data[t.key] }));
        const res = await send({ type: 'blueline:download', folder: `blueline/${S.batch.id}`, files });
        for (const { id, path } of res?.paths || []) {
          const t = todo.find((x) => x.key === id);
          if (t && path) t.it[t.field] = path;
        }
        await saveBatch();
        status.textContent = res?.error ? `Images not saved: ${res.error}` : '';
      }
      const any = S.batch.items.map((i) => i.shotPath || i.markupPath).find(Boolean);
      if (any && !status.textContent) status.textContent = `Images saved in ${any.replace(/[\\/][^\\/]*$/, '')}`;
    }
    const batch = S.prefs.saveShots ? S.batch : { ...S.batch, items: S.batch.items.map((i) => ({ ...i, shotPath: null, markupPath: null })) };
    $('.out').value = buildPrompt(batch);
  }

  async function copyOut() {
    const ta = S.ui.$('.out');
    try {
      await navigator.clipboard.writeText(ta.value);
    } catch {
      ta.focus();
      ta.select();
      document.execCommand('copy');
    }
    const cb = S.ui.$('[data-act="copy"]');
    if (cb) {
      const old = cb.dataset.label || cb.textContent;
      cb.dataset.label = old;
      cb.textContent = 'Copied to clipboard ✓';
      cb.classList.add('done');
      clearTimeout(S.copyT);
      S.copyT = setTimeout(() => { cb.textContent = old; cb.classList.remove('done'); }, 2400);
    }
    S.ui.$('.status').textContent = 'Copied to clipboard ✓';
    toast('Copied to clipboard.');
  }

  async function saveMd() {
    const text = S.ui.$('.out').value;
    const res = await send({
      type: 'blueline:download',
      folder: `blueline/${S.batch.id}`,
      files: [{ id: 'prompt', name: 'prompt.md', dataUrl: 'data:text/markdown;charset=utf-8,' + encodeURIComponent(text) }],
    });
    const path = res?.paths?.[0]?.path;
    if (path) {
      S.ui.$('.status').textContent = `Saved ${path}`;
      toast('Saved prompt.md');
    } else {
      toast(res?.error ? `Couldn\u2019t save: ${res.error}` : 'Couldn\u2019t save the file');
    }
  }

  // ---------------------------------------------------------------- lifecycle

  async function setActive(on) {
    if (on && !S.active) {
      S.active = true;
      try { sessionStorage.setItem(ARM_KEY, '1'); } catch { /* storage blocked */ }
      hook('arm');
      S.page = hook('page') || {};
      S.lastRenderPath = currentPath();
      await loadState();
      S.prefs.collapsed = false; // turning Blueline on always opens it expanded
      console.info(`Blueline ${VERSION} on`);
      mount();
      attach();
      render();
    } else if (!on && S.active) {
      S.active = false;
      try { sessionStorage.removeItem(ARM_KEY); } catch { /* storage blocked */ }
      closePop();
      S.picking = false;
      cursorStyle(false);
      detach();
      unmount();
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'blueline:set-active' && !S.retired) setActive(msg.on);
  });

  // After the extension is reloaded, Chrome leaves the old scripts running in open tabs and may inject
  // the new ones next to them. The newest copy announces itself; any older copy shuts down completely,
  // so stale code can never keep handling clicks on the page.
  document.dispatchEvent(new CustomEvent('blueline:supersede'));
  document.addEventListener('blueline:supersede', () => {
    if (S.retired) return;
    S.retired = true;
    setActive(false);
  });

  Object.assign(BL, {
    S, send, hook, uid, query, clip, plural, code, bp, label, cssPath, describe, detectIssues, findSection, sectionLine,
    routeGuess, bestSource, modeOf, inspectReact, decodeModule, isStableClass, stylingOf, rgba, hex, fromUI, openPop, closePop,
    setPicking, cursorStyle, render, saveBatch, savePrefs, ensureBatch, findItem, currentPath, toast, frames, loadImg,
    TYPES, typeLabel, shotKey, placePop, whereShort, drawHL, hideHL, setPopType, INK,
  });

  if (globalThis.__BLUELINE_TEST__) {
    globalThis.__BLUELINE_TEST__.api = { cssPath, describe, buildPrompt, findSection, decodeModule, stylingOf, routeGuess, detectIssues, contrastOf, label, hook, S, setActive, matchedRules, compactDecl, snippet };
  }

  (async () => {
    const res = await send({ type: 'blueline:hello' });
    if (res?.active) setActive(true);
  })();
})();
