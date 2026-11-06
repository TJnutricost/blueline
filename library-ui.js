/* Blueline Product Lists — UI. Mounts a compact modal into Blueline's panel (More tools → Import Product List).
 * All logic lives in library.js; this file only draws it, wires the buttons and saves through chrome.storage.
 * A product list never needs Shopify: a store is optional and only used to verify products afterwards.
 * Read-only toward Shopify: the only network use is GETs of public storefront JSON.
 */
(function () {
  'use strict';
  const BL = globalThis.__BL;
  const Lib = globalThis.BluelineLibrary;
  if (!BL || !Lib || !BL.hooks) return;
  const S = BL.S;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Which workspace this page is. Web pages: their origin. Local files: the file itself, so two unrelated local
  // previews never share a remembered list.
  const pageOrigin = () => (location.protocol === 'file:' ? location.href.split(/[?#]/)[0] : location.origin);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const storage = () => {
    if (BL.runtimeAlive && !BL.runtimeAlive()) throw new Error('Blueline was reloaded. Reload this page to keep working.');
    return chrome.storage.local;
  };
  // 1536 -> "1.5 KB". Display only; the stored size stays an exact byte count.
  const fmtSize = (n) => { const b = Number(n); if (!Number.isFinite(b) || b < 0) return '—'; if (b < 1024) return `${b} B`; const u = ['KB', 'MB', 'GB']; let v = b / 1024; let i = 0; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${u[i]}`; };
  const ACCEPT = /\.(csv|tsv|json|docx)$/i;
  const NEW = '__new';
  const OTHER = '__other';
  const host = (s) => (s ? s.replace(/^https?:\/\//, '') : 'no store');
  const DOCKS = ['right', 'left', 'bottom', 'float'];
  const DOCK_SHOW = ['left', 'right', 'bottom', 'float']; // display order only; Right stays the default
  const DOCK_LABEL = { right: 'Right', left: 'Left', bottom: 'Bottom', float: 'Float' };

  // One state object for the open modal. `lib` is { store ('' = none), campaign (the list's stable id), name, smp, work } (see library.js).
  const L = { root: null, open: false, store: '', listId: null, lists: [], stores: [], lib: null, rows: [], search: '', filter: 'all', busy: '', msg: '', msgKind: '', warnings: [], customFor: null, editFor: null, localForm: false, find: null, pending: null, mgr: null, confirmReplace: false, showStoreInput: false, reading: false, expanded: new Set(), confirmDelete: false, currencyChecked: new Set(), recent: null, scroll: null, provOpen: false, renaming: false, mgrScroll: null, cmpOpen: new Set() };
  const q = (sel) => L.root?.querySelector(sel);

  const CSS = `
    .lib-sheet { width: min(860px, 100%); height: auto; max-height: min(92vh, 900px); } .lib-sheet:focus { outline: none; }
    .lib-sheet.lib-full { height: min(92vh, 900px); }
    .lib-sheet > header { cursor: default; }
    .lib-body { display: contents; }
    .lib-start[hidden], .lib-find[hidden], .lib-body[hidden], .lib-adv[hidden], .lib-find-foot[hidden], .lib-choice[hidden], .lib-find-search [hidden], .lib-local[hidden], [data-lib="store"][hidden], [data-lib="storesel"][hidden] { display: none !important; }
    .lib-cfg, .lib-tools, .lib-filter, .lib-chips { display: flex; flex-wrap: wrap; gap: 6px 8px; }
    .lib-cfg { align-items: end; }
    .lib-cfg label { display: flex; flex-direction: column; gap: 2px; font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #6B7183; flex: 1 1 170px; }
    .lib-cfg label small { font-weight: 500; text-transform: none; letter-spacing: 0; }
    .lib-cfg input, .lib-cfg select, .lib-filter input, .lib-filter select, .lib-find input, .lib-custom input, .lib-edit input, .lib-local input { font: 12.5px inherit; padding: 5px 8px; border: 1px solid #D9DCE4; border-radius: 6px; min-width: 0; box-sizing: border-box; }
    .lib-filter input { flex: 1 1 200px; }
    .lib-msg { font-size: 12px; padding: 5px 8px; border-radius: 6px; background: #F2F4F8; color: #1E2230; }
    .lib-msg:empty { display: none; }
    .lib-msg.bad { background: #FEECEC; color: #B42318; }
    .lib-msg.ok { background: #E8F6EC; color: #176B34; }
    .lib-msg.warn { background: #FFF4D6; color: #8A5A00; }
    .lib-cur { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; text-transform: none; letter-spacing: 0; height: 28px; }
    /* Required actions: blue = the step that moves things forward, green = approve, red = destructive. Secondary buttons stay plain. */
    .lib-sheet .xb.lib-primary, .lib-sheet .xb.lib-go, .lib-sheet .xb.lib-danger { color: #fff; font-weight: 700; }
    .lib-sheet .xb.lib-primary { background: #2B4EFF; border-color: #2B4EFF; }
    .lib-sheet .xb.lib-go { background: #1E7A3E; border-color: #1E7A3E; }
    .lib-sheet .xb.lib-danger, .lib-sheet .ghost.lib-danger { background: #B42318; border-color: #B42318; color: #fff; }
    .lib-sheet .xb.lib-primary:hover, .lib-sheet .xb.lib-primary:focus-visible { background: #1A33C7; }
    .lib-sheet .xb.lib-go:hover, .lib-sheet .xb.lib-go:focus-visible { background: #176B34; }
    .lib-sheet .xb.lib-danger:hover, .lib-sheet .xb.lib-danger:focus-visible { background: #912018; }
    .lib-sheet .xb.lib-primary:focus-visible, .lib-sheet .xb.lib-go:focus-visible, .lib-sheet .xb.lib-danger:focus-visible { outline: 3px solid #1E1E1E; outline-offset: 2px; }
    .lib-repok { font-size: 11.5px; color: #176B34; }
    .lib-mgr { display: none; }
    .lib-mgr[hidden] { display: none !important; }
    .lib-mgr-list { display: flex; flex-direction: column; gap: 6px; overflow: auto; padding: 4px 4px 8px; min-height: 0; flex: 1 1 auto; }
    .lib-lm { border: 1px solid #E2E5EC; border-radius: 8px; padding: 8px 10px; background: #fff; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
    .lib-lm[data-cur="1"] { background: #F1F5FF; border-color: #7C93FF; }
    .lib-lm-main { flex: 1 1 260px; min-width: 0; font-size: 12px; display: flex; flex-direction: column; gap: 2px; }
    .lib-lm-act { display: flex; gap: 5px; }
    .lib-lm-act .xb { padding: 3px 10px; font-size: 11.5px; }
    .lib-lm-more { flex-basis: 100%; font-size: 11.5px; color: #4A5063; display: flex; flex-direction: column; gap: 4px; }
    .lib-lm-more.bad { background: #FEECEC; color: #7A1A12; border-radius: 6px; padding: 6px 8px; }
    .lib-vc { padding: 4px 6px; border-radius: 6px; } .lib-vc .lib-line { gap: 2px 10px; }
    .lib-vc[data-sel="1"] { background: #FFF9E6; }
    .lib-confirm { border: 1px solid #E0A400; background: #FFF9E6; border-radius: 6px; padding: 6px 8px; font-size: 12px; display: flex; flex-direction: column; gap: 4px; }
    .lib-warn { font-size: 11.5px; color: #4A5063; }
    .lib-warn ul { margin: 4px 0 0 16px; padding: 0; }
    .lib-start { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 18px 10px; text-align: center; border: 2px dashed #C9CEDB; border-radius: 10px; }
    .lib-modal.lib-drag .lib-start, .lib-modal.lib-drag .lib-body { outline: 3px dashed #2B4EFF; outline-offset: -3px; background: #F4F6FF; }
    .lib-start h3 { margin: 0; font-size: 15px; }
    .lib-start .xb-file { padding: 8px 20px; font-size: 13px; background: #2B4EFF; color: #fff; border-color: #2B4EFF; }
    .lib-start small, .lib-up small { font-size: 10.5px; color: #6B7183; }
    .lib-choice { border: 1px solid #2B4EFF; border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 5px; background: #F4F6FF; font-size: 12px; }
    .lib-choice label { display: flex; gap: 6px; align-items: flex-start; }
    .lib-choice small { color: #4A5063; display: block; }
    .lib-tools { align-items: flex-start; }
    .lib-tools .xb, .lib-tools .ghost { height: 30px; box-sizing: border-box; display: inline-flex; align-items: center; margin: 0; }
    .lib-up { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 1px; }
    .lib-h { font-size: 13px; }
    .lib-sum { font-size: 12px; color: #4A5063; font-weight: 600; }
    .lib-chips { align-items: center; font-size: 11.5px; color: #4A5063; }
    .lib-chip { all: unset; cursor: pointer; font-size: 11.5px; font-weight: 700; padding: 2px 10px; border-radius: 10px; background: #E8F6EC; color: #176B34; box-sizing: border-box; }
    .lib-chip.all { background: #EEF1FF; color: #1A33C7; }
    .lib-chip.bad { background: #FEECEC; color: #B42318; } .lib-chip.warn { background: #FFF4D6; color: #8A5A00; }
    .lib-chip[aria-pressed="true"] { box-shadow: inset 0 0 0 2px #2B4EFF; }
    .lib-chip:focus-visible { outline: 2px solid #1E1E1E; outline-offset: 1px; } .lib-chip:hover { box-shadow: inset 0 0 0 2px #7C93FF; }
    .lib-list { flex: 1 1 auto; min-height: 120px; overflow: auto; display: flex; flex-direction: column; gap: 6px; padding: 4px 4px 8px; }
    .lib-list:focus-visible { outline: 2px solid #1E1E1E; outline-offset: -2px; }
    .lib-empty { padding: 24px 10px; text-align: center; color: #6B7183; font-size: 12.5px; }
    .lib-row { --acc: #C9CEDB; flex: none; display: flex; gap: 10px; padding: 9px 10px 9px 14px; border: 1px solid #E2E5EC; border-radius: 8px; background: #fff; box-shadow: inset 4px 0 0 var(--acc); }
    .lib-row[data-v="ok"] { --acc: #2E9E5B; } .lib-row[data-v="warn"] { --acc: #E0A400; } .lib-row[data-v="bad"] { --acc: #D92D20; }
    .lib-row[data-pending="1"] { background: #FFFAEB; border-color: #EBC25A; }
    .lib-row[data-editing="1"], .lib-row[data-recent="1"] { --acc: #2B4EFF; border-color: #7C93FF; }
    .lib-row[data-editing="1"]:not([data-pending="1"]), .lib-row[data-recent="1"]:not([data-pending="1"]) { background: #F1F5FF; }
    .lib-top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 2px 10px; }
    .lib-title { font-size: 13.5px; line-height: 1.3; min-width: 0; overflow-wrap: anywhere; }
    .lib-price { display: inline-flex; flex-direction: column; align-items: flex-end; font-size: 14px; font-weight: 700; margin-left: auto; white-space: nowrap; }
    .lib-price i { font-style: normal; font-size: 10px; font-weight: 600; color: #6B7183; letter-spacing: .03em; }
    .lib-need { font-size: 12px; color: #8A5A00; overflow-wrap: anywhere; }
    .lib-req { display: flex; flex-wrap: wrap; gap: 5px; }
    .lib-req .xb { padding: 5px 10px; font-size: 12px; }
    .lib-cmp { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
    .lib-cmp > div { padding: 5px 8px 5px 10px; border-radius: 6px; display: flex; flex-direction: column; gap: 1px; min-width: 0; overflow-wrap: anywhere; }
    .lib-cmp i { font-style: normal; font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #6B7183; }
    .lib-orig { background: #F7F8FA; box-shadow: inset 3px 0 0 #C9CEDB; }
    .lib-prop { background: #F1FAF4; box-shadow: inset 3px 0 0 #2E9E5B; }
    .lib-dtl { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
    .lib-dtl .xb { padding: 4px 9px; font-size: 12px; }
    .lib-dt { border-top: 1px solid #E8EAF0; margin-top: 2px; padding-top: 7px; display: flex; flex-direction: column; gap: 8px; }
    .lib-dt h4 { margin: 0 0 2px; font-size: 10.5px; letter-spacing: .05em; text-transform: uppercase; color: #6B7183; }
    .lib-kv { display: grid; grid-template-columns: minmax(84px, 128px) minmax(0, 1fr); gap: 3px 10px; margin: 0; font-size: 11.5px; color: #1E2230; }
    .lib-kv dt { color: #6B7183; font-weight: 600; } .lib-kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .lib-kv .lib-vid code { font-weight: 700; background: #EEF1FF; }
    .lib-prov { font-size: 11.5px; color: #4A5063; }
    .lib-ok { margin-left: 8px; font-size: 11px; font-weight: 600; color: #176B34; } .lib-df { margin-left: 8px; font-size: 11px; font-weight: 700; color: #8A5A00; background: #FFF4D6; border-radius: 8px; padding: 0 7px; }
    .lib-cmpbtn { display: inline-block; padding: 2px 0; font-size: 12px; font-weight: 600; }
    .lib-cmpbox { margin-top: 5px; display: flex; flex-direction: column; gap: 4px; }
    .lib-cmpt { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 11.5px; }
    .lib-cmpt th, .lib-cmpt td { border: 1px solid #E2E5EC; padding: 4px 6px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    .lib-cmpt thead th { background: #F2F4F8; font-size: 10.5px; letter-spacing: .03em; text-transform: uppercase; color: #4A5063; }
    .lib-cmpt tbody th { width: 22%; background: #FAFBFC; font-weight: 600; color: #4A5063; }
    .lib-cmpt td[data-diff="1"] { background: #FFF4D6; font-weight: 700; color: #6B4500; }
    .lib-img { flex: none; width: 44px; height: 44px; border-radius: 6px; background: #fff; border: 1px solid #E2E5EC; display: flex; align-items: center; justify-content: center; overflow: hidden; color: #9AA3C7; font-size: 10px; box-sizing: border-box; }
    .lib-img img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .lib-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .lib-line { display: flex; flex-wrap: wrap; gap: 2px 12px; align-items: center; font-size: 11.5px; color: #4A5063; }
    .lib-line code { font: 11.5px ui-monospace, Menlo, monospace; background: #F2F4F8; padding: 1px 5px; border-radius: 4px; color: #1E2230; word-break: break-all; }
    .lib-line i { font-style: normal; font-size: 10px; color: #6B7183; font-weight: 700; margin-right: 3px; }
        .lib-cp { all: unset; cursor: pointer; margin-left: 3px; padding: 0 4px; border-radius: 4px; color: #2B4EFF; font-size: 12px; }
    .lib-cp:hover, .lib-cp:focus-visible { background: #EEF1FF; outline: 1px solid #2B4EFF; }
    .lib-opt { background: #EEF1FF; color: #1A33C7; padding: 0 6px; border-radius: 10px; font-size: 11px; font-weight: 600; }
    .lib-prices { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12.5px; }
    .lib-prices span { display: flex; flex-direction: column; min-width: 64px; }
    .lib-prices i { font-style: normal; font-size: 9.5px; letter-spacing: .05em; text-transform: uppercase; color: #6B7183; font-weight: 700; }
    .lib-prices .lib-ap { font-weight: 700; }
    .lib-badges { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
    .lib-badge { font-size: 11px; font-weight: 650; padding: 1px 8px; border-radius: 10px; background: #F2F4F8; color: #4A5063; }
    .lib-badge.ok { background: #E8F6EC; color: #176B34; } .lib-badge.warn { background: #FFF4D6; color: #8A5A00; } .lib-badge.bad { background: #FEECEC; color: #B42318; }
    .lib-actions { display: flex; flex-wrap: wrap; gap: 5px; }
    .lib-actions .xb { padding: 3px 8px; font-size: 11.5px; }
    .lib-custom, .lib-edit, .lib-local { display: flex; gap: 5px 8px; align-items: flex-end; flex-wrap: wrap; font-size: 12px; }
    .lib-custom input { width: 90px; }
    .lib-edit, .lib-local { border: 1px solid #D9DCE4; border-radius: 8px; padding: 8px; background: #FAFBFC; }
    .lib-edit label, .lib-local label { display: flex; flex-direction: column; gap: 2px; font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #6B7183; flex: 1 1 180px; }
    .lib-edit label small { font-weight: 500; text-transform: none; letter-spacing: 0; color: #4A5063; }
    .lib-edit .lib-fld { display: flex; gap: 4px; align-items: center; } .lib-edit .lib-fld input { flex: 1; }
    .lib-cands { display: flex; flex-direction: column; gap: 4px; border-top: 1px dashed #E2E5EC; padding-top: 5px; }
    .lib-cand { display: flex; gap: 8px; align-items: center; font-size: 11.5px; }
    .lib-cand .lib-img { width: 36px; height: 36px; }
    .lib-cand > div { flex: 1; min-width: 0; }
    .lib-cand[data-cur="1"] { background: #EEF1FF; border-radius: 6px; padding: 3px 5px; }
    .lib-vc .lib-img { width: 44px; height: 44px; }
    .lib-find { border: 1px solid #D9DCE4; border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 6px; background: #FAFBFC; }
    .lib-find-id { border-left: 3px solid #2B4EFF; padding-left: 8px; font-size: 12px; }
    .lib-find .xrow input { flex: 1; }
    .lib-find-res { display: flex; flex-direction: column; gap: 5px; max-height: 260px; overflow: auto; padding: 2px 2px 4px; }
    .lib-adv { font-size: 11.5px; } .lib-adv .xrow { margin-top: 4px; }
    .lib-sku-res { display: flex; flex-direction: column; gap: 5px; margin-top: 4px; }
    .lib-places { margin: 2px 0 0 16px; padding: 0; font-size: 11.5px; color: #4A5063; }
    .lib-note { font-size: 11.5px; color: #8A5A00; }
    .lib-promo { font-size: 11.5px; color: #7A4B00; background: #FFF9E6; border-radius: 6px; padding: 3px 7px; }
    .lib-subst { font-size: 11.5px; color: #7A2E00; background: #FFF1E6; border-radius: 6px; padding: 3px 7px; }
    .lib-tg { all: unset; cursor: pointer; color: #1A33C7; font-size: 11.5px; border-radius: 3px; } .lib-tg:hover { text-decoration: underline; } .lib-tg:focus-visible { text-decoration: underline; outline: 2px solid #1E1E1E; outline-offset: 2px; }
    .lib-mainview { display: contents; }
    .lib-sheet.lib-vmode .lib-mainview, .lib-sheet.lib-mmode .lib-mainview { display: none !important; }
    .lib-sheet.lib-mmode .lib-mgr:not([hidden]) { display: flex; flex-direction: column; gap: 10px; flex: 1 1 auto; min-height: 0; }
    .lib-mgr-head { display: flex; gap: 10px; align-items: flex-start; padding-bottom: 8px; border-bottom: 1px solid #E2E5EC; }
    .lib-mgr-head h3 { margin: 0; font-size: 16px; } .lib-mgr-head h3:focus { outline: none; }
    .lib-vv { display: none; }
    .lib-sheet.lib-vmode .lib-vv { display: flex; flex-direction: column; gap: 10px; flex: 1 1 auto; min-height: 0; }
    .lib-vv-head { display: flex; gap: 10px; align-items: flex-start; padding-bottom: 8px; border-bottom: 1px solid #E2E5EC; }
    .lib-vv-head h3 { margin: 0; font-size: 16px; } .lib-vv-prod { font-size: 13px; font-weight: 600; margin-top: 2px; overflow-wrap: anywhere; } .lib-vv-cur { margin-top: 1px; }
    .lib-back { flex: none; font-size: 15px; line-height: 1; padding: 6px 10px; }
    .lib-vv-choose, .lib-vv-review { display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; min-height: 0; }
    .lib-vv-choose[hidden], .lib-vv-review[hidden] { display: none !important; }
    .lib-vv-ctl { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; justify-content: space-between; }
    .lib-vv-ctl input { font: 12.5px inherit; padding: 5px 8px; border: 1px solid #D9DCE4; border-radius: 6px; flex: 1 1 160px; min-width: 0; box-sizing: border-box; }
    .lib-vv-list { flex: 1 1 auto; min-height: 120px; overflow: auto; display: flex; flex-direction: column; gap: 5px; padding: 3px 3px 6px; }
    .lib-vr { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border: 1px solid #E2E5EC; border-radius: 8px; background: #fff; cursor: pointer; }
    .lib-vr:hover { background: #F7F9FF; }
    .lib-vr[data-sel="1"] { background: #F1F5FF; border-color: #7C93FF; }
    .lib-vr:focus-within { outline: 2px solid #1E1E1E; outline-offset: -2px; }
    .lib-vr input { margin: 3px 0 0; flex: none; accent-color: #2B4EFF; }
    .lib-vr-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; font-size: 12px; color: #4A5063; }
    .lib-vr-t { display: flex; flex-wrap: wrap; gap: 2px 8px; align-items: center; font-size: 13px; color: #1E2230; overflow-wrap: anywhere; }
    .lib-vr-id { font-size: 11px; color: #6B7183; overflow-wrap: anywhere; }
    .lib-vv-foot { display: flex; flex-direction: column; gap: 6px; align-items: stretch; padding-top: 4px; border-top: 1px solid #E2E5EC; }
    .lib-vv-foot .xb.lib-wide { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 13px; }
    .lib-vv-foot .xb:disabled { opacity: .45; cursor: not-allowed; }
    .lib-vv-foot .lib-tg { align-self: center; }
    .lib-vv-hint { text-align: center; font-size: 11.5px; color: #6B7183; }
    .lib-vv-hint:empty { display: none; }
    .lib-vv-rvb { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding: 3px 3px 6px; }
    .lib-vv-rvb h4 { margin: 0; font-size: 15px; } .lib-vv-rvb h4:focus { outline: none; }
    .lib-vv-notice { font-size: 12px; padding: 7px 10px; border-radius: 6px; background: #FFF4D6; color: #6B4500; border: 1px solid #EBC25A; }
    .lib-vv-notice.ok { background: #E8F6EC; color: #176B34; border-color: #9BD3AE; }
    .lib-lm-dates { display: flex; flex-wrap: wrap; gap: 0 12px; }
    .lib-nm { display: flex; flex-direction: column; gap: 2px; flex: 1 1 220px; min-width: 0; }
    .lib-nm-l { font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #6B7183; }
    .lib-cfg label.lib-lsel { display: flex; flex-direction: row; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; letter-spacing: 0; text-transform: none; color: #1E2230; flex: 0 0 auto; }
    .lib-listsel { flex: 1 1 auto; min-width: 0; max-width: 100%; font: 600 12.5px inherit; padding: 2px 6px; border: 1px solid #C9CEDB; border-radius: 6px; background: #fff; color: #1E2230; }
    .lib-nm-view { display: flex; align-items: center; gap: 4px; min-width: 0; }
    .lib-nm-t { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; } .lib-nm-t.empty { font-weight: 400; color: #6B7183; }
    .lib-ic { all: unset; cursor: pointer; padding: 3px 6px; border-radius: 5px; color: #4A5063; font-size: 14px; line-height: 1; } .lib-ic:hover { background: #F2F4F8; } .lib-ic:focus-visible { outline: 2px solid #1E1E1E; outline-offset: 1px; }
    .lib-nm-edit { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; } .lib-nm-edit input { flex: 1 1 160px; min-width: 0; font: 12.5px inherit; padding: 5px 8px; border: 1px solid #D9DCE4; border-radius: 6px; box-sizing: border-box; }
    .lib-nm-view[hidden], .lib-nm-edit[hidden] { display: none !important; }
    .lib-manage { align-self: flex-start; }
    .lib-storebox { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: flex-end; flex: 2 1 260px; }
    .lib-storebox label { flex: 1 1 170px; }
    .lib-storebox .xb { height: 28px; box-sizing: border-box; }
    .lib-sheet .xb.lib-primary:disabled { opacity: .45; }
    .lib-vv-head h3:focus { outline: none; }
    /* Selection mode: choosing a product for a card on the page. The footer (the confirming button) never scrolls away. */
    .lib-sel { display: none; }
    .lib-sheet.lib-smode .lib-mainview, .lib-sheet.lib-smode .lib-vv, .lib-sheet.lib-smode .lib-mgr { display: none !important; }
    .lib-sheet.lib-smode .lib-sel { display: flex; flex-direction: column; gap: 10px; flex: 1 1 auto; min-height: 0; }
    .lib-sel-head { display: flex; gap: 10px; align-items: flex-start; padding-bottom: 8px; border-bottom: 1px solid #E2E5EC; }
    .lib-sel-head h3 { margin: 0; font-size: 16px; } .lib-sel-head h3:focus { outline: none; }
    .lib-sel-head [hidden] { display: none !important; }
    .lib-sel-body { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding: 2px 3px 6px; }
    .lib-sel-ctl { display: flex; flex-wrap: wrap; gap: 6px 10px; }
    .lib-sel-ctl label { display: flex; flex-direction: column; gap: 2px; font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #6B7183; flex: 1 1 200px; min-width: 0; }
    .lib-sel-ctl select, .lib-sel-ctl input { font: 12.5px inherit; padding: 6px 8px; border: 1px solid #D9DCE4; border-radius: 6px; min-width: 0; box-sizing: border-box; text-transform: none; letter-spacing: 0; font-weight: 400; color: #1E2230; }
    .lib-sel-results { display: flex; flex-direction: column; gap: 6px; }
    .lib-sel-row { all: unset; box-sizing: border-box; cursor: pointer; display: flex; gap: 10px; align-items: center; padding: 8px 10px; border: 1px solid #E2E5EC; border-radius: 8px; background: #fff; width: 100%; }
    .lib-sel-row:hover { background: #F7F9FF; border-color: #7C93FF; } .lib-sel-row:focus-visible { outline: 2px solid #1E1E1E; outline-offset: -2px; }
    .lib-sel-row[data-cur="1"] { background: #F1F5FF; border-color: #7C93FF; }
    .lib-sel-row > span { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; font-size: 11.5px; color: #4A5063; }
    .lib-sel-row b { font-size: 13px; color: #1E2230; overflow-wrap: anywhere; }
    .lib-sel-prod { display: flex; gap: 12px; align-items: flex-start; }
    .lib-sel-prod .lib-img { width: 72px; height: 72px; }
    .lib-sel-prod > div { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .lib-sel-prod b { font-size: 14px; overflow-wrap: anywhere; }
    .lib-sel-foot { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; align-items: center; padding-top: 8px; border-top: 1px solid #E2E5EC; }
    .lib-sel-foot .xb { padding: 9px 16px; font-size: 13px; }
    .lib-sel-foot .xb:disabled { opacity: .45; cursor: not-allowed; }
    .lib-sel-foot .lib-sel-why { flex: 1 1 100%; font-size: 11.5px; color: #6B7183; text-align: right; } .lib-sel-foot .lib-sel-why:empty { display: none; }
    .lib-sel-one { font-size: 12.5px; font-weight: 600; color: #4A5063; padding: 6px 10px; background: #F2F4F8; border-radius: 6px; }
    .lib-sel-res { border: 1px solid #EBC25A; background: #FFF9E6; border-radius: 6px; padding: 6px 10px; margin: 0; font-size: 12px; display: flex; flex-direction: column; gap: 3px; }
    .lib-sel-res legend { font-weight: 700; padding: 0 4px; }
    .lib-sel-res label { display: flex; gap: 6px; align-items: flex-start; }
    .lib-map { display: none; }
    .lib-sheet.lib-pmode .lib-mainview, .lib-sheet.lib-pmode .lib-vv, .lib-sheet.lib-pmode .lib-mgr { display: none !important; }
    .lib-sheet.lib-pmode:not(.lib-smode) .lib-map { display: flex; flex-direction: column; gap: 10px; flex: 1 1 auto; min-height: 0; }
    .lib-sheet.lib-pmode.lib-smode .lib-map { display: none !important; }
    .lib-map-st { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
    .lib-map-k { font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #6B7183; }
    .lib-map-act { display: flex; flex-wrap: wrap; gap: 6px; }
    .lib-map-shop { border: 1px solid #D9DCE4; border-radius: 6px; padding: 7px 10px; font-size: 12px; display: flex; flex-direction: column; gap: 3px; background: #F7F8FB; }
    .lib-map-shop.ok { border-color: #8BC9A0; background: #F0FAF3; } .lib-map-shop.warn { border-color: #EBC25A; background: #FFF9E6; } .lib-map-shop.bad { border-color: #E6A1A1; background: #FFF1F1; }
    .lib-map-notes { margin: 2px 0 2px 16px; padding: 0; }
    .lib-map-vals { display: flex; flex-direction: column; gap: 8px; }
    .lib-map-f label { display: flex; flex-direction: column; gap: 2px; font-size: 11.5px; font-weight: 600; color: #4A5063; }
    .lib-map-in { display: flex; gap: 6px; } .lib-map-in input { flex: 1; min-width: 0; font: 12.5px inherit; padding: 6px 8px; border: 1px solid #D9DCE4; border-radius: 6px; box-sizing: border-box; color: #1E2230; font-weight: 400; }
    .lib-map-ed { font-style: normal; font-size: 10px; color: #8A5A00; background: #FFF1CC; border-radius: 8px; padding: 0 6px; }
    .lib-map-ferr { color: #B3261E; font-size: 11.5px; }
    .lib-map-els { display: flex; flex-direction: column; gap: 6px; }
    .lib-el { border: 1px solid #D9DCE4; border-radius: 6px; padding: 6px 8px; display: flex; flex-direction: column; gap: 3px; font-size: 12px; background: #fff; }
    .lib-el-t { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
    .lib-el-v { overflow-wrap: anywhere; } .lib-el-v code { font-size: 11px; color: #4A5063; background: #F1F3F8; padding: 0 4px; border-radius: 4px; }
    .lib-el-a { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; } .lib-el-a select { font: 11.5px inherit; max-width: 100%; padding: 3px 4px; border: 1px solid #D9DCE4; border-radius: 6px; }
    .lib-el-diff { color: #8A5A00; }
    .lib-acc { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; padding: 8px 10px; border: 1px solid #B9C4FF; background: #F4F6FF; border-radius: 8px; }
    .lib-sheet .xb.lib-acc-btn { font-size: 13px; padding: 7px 16px; min-height: 34px; }
    .lib-el-unsure { color: #4A5063; }
    .lib-as { display: none; }
    .lib-sheet.lib-amode { position: relative; }
    .lib-sheet.lib-amode .lib-map { display: none !important; }
    .lib-sheet.lib-amode .lib-as { display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; min-height: 0; }
    .lib-as-bar { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; justify-content: space-between; }
    .lib-as-docks { display: inline-flex; gap: 4px; align-items: center; } .lib-as-docks .xb { padding: 3px 9px; } .lib-as-docks .xb[aria-pressed="true"] { background: #2B4EFF; border-color: #2B4EFF; color: #fff; }
    .lib-as-strip { display: flex; gap: 6px; overflow-x: auto; overflow-y: hidden; flex: none; padding: 2px 1px 6px; scroll-snap-type: x proximity; }
    .lib-cchip { flex: none; scroll-snap-align: start; display: flex; flex-direction: row; align-items: center; gap: 6px; min-width: 0; padding: 4px 10px 4px 4px; border: 1.5px solid #2B4EFF; border-radius: 999px; background: #fff; font: inherit; font-size: 11.5px; color: #1E2230; cursor: pointer; text-align: left; transition: background .12s, box-shadow .12s; }
    .lib-cchip:hover { background: #F3F5FF; } .lib-cchip:focus-visible { outline: 2px solid #1E1E1E; outline-offset: 2px; }
    .lib-cchip em { font-style: normal; font-size: 10px; font-weight: 700; color: #6B7183; text-transform: uppercase; letter-spacing: .03em; }
    .lib-cchip b { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background: #2B4EFF; color: #fff; font-size: 12.5px; } .lib-cchip.ok b { background: #1E7A3E; } .lib-cchip.warn b { background: #B7791F; } .lib-cchip.ok { border-color: #1E7A3E; } .lib-cchip.warn { border-color: #B7791F; border-style: dashed; }
    .lib-cchip.sel { box-shadow: 0 0 0 3px rgba(43,78,255,.35); background: #E4EAFF; font-weight: 700; } .lib-cchip.sel.ok { box-shadow: 0 0 0 3px rgba(30,122,62,.3); background: #E6F4EA; } .lib-cchip.sel.warn { box-shadow: 0 0 0 3px rgba(183,121,31,.35); background: #FFF4D6; } .lib-cchip i { display: none; }
    .lib-bk-sl { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 8px; font-size: 12px; padding: 2px 2px 4px; } .lib-bk-sl .lib-bk-a { display: flex; flex-wrap: wrap; gap: 4px; } .lib-bk-sl .xb { padding: 2px 8px; font-size: 11.5px; }
    .lib-bk-more { font-size: 12px; } .lib-bk-more > summary { cursor: pointer; font-weight: 600; }
    .lib-as-cols { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 10px; }
    .lib-as-col { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 6px; border: 1px solid #E2E5EC; border-radius: 8px; padding: 8px; }
    .lib-as-h { margin: -8px -8px 0; padding: 8px 10px; display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; color: #1E2230; background: #EEF1FF; border-bottom: 1px solid #D5DBF5; border-radius: 8px 8px 0 0; } .lib-as-h:focus { outline: none; }
    .lib-ex-btn { margin-left: auto; padding: 1px 9px; font-size: 11.5px; text-transform: none; letter-spacing: 0; } .lib-ex-btn[aria-expanded="true"] { background: #1E2230; color: #fff; } .lib-as-h[data-ex]::after { margin-left: 0; }
    .lib-bk-expanel { margin: 0 0 8px; padding: 6px 8px; border: 1px solid #D5DBF5; border-radius: 8px; background: #FAFBFF; }
    .lib-as-cards .lib-as-h { background: #EAF6EE; border-bottom-color: #CBE5D3; }
    .lib-as-h::after { content: attr(data-count); margin-left: auto; min-width: 22px; padding: 1px 8px; border-radius: 999px; background: #fff; border: 1px solid #C9CEDD; font-size: 11.5px; font-weight: 700; color: #4A5163; text-align: center; letter-spacing: 0; } .lib-as-h[data-count=""]::after { display: none; }
    .lib-as-col { box-shadow: 0 1px 0 rgba(30,34,48,.06); }
    .lib-tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 700; background: #F1F2F6; color: #4A5163; border: 1px dashed #9AA1B2; } .lib-tag.def { background: #E6F4EA; color: #176B34; border: 1px solid #9BD0AB; }
    .lib-bk-actions-note { display: none; }
    .lib-as-cbody { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 2px 3px 6px; }
    .lib-as-pslot { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
    .lib-sheet.lib-amode .lib-as-pslot .lib-sel { display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; min-height: 0; }
    .lib-sheet.lib-amode .lib-as-pslot .lib-sel-head { padding-bottom: 4px; } .lib-sheet.lib-amode .lib-as-pslot .lib-sel-head h3 { font-size: 13px; }
    .lib-sheet.lib-amode .lib-as-pslot .lib-sel-ctl { position: sticky; top: 0; z-index: 1; background: #fff; padding-bottom: 4px; }
    .lib-as-foot { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; align-items: center; padding-top: 8px; border-top: 1px solid #E2E5EC; }
    .lib-as-foot .lib-sel-why { flex: 1 1 100%; font-size: 11.5px; color: #6B7183; text-align: right; }
    /* Too narrow for two columns: Page Cards on TOP as a compact strip, Product Library below, each scrolling on its own. */
    .lib-sheet.lib-narrow .lib-as-cols { grid-template-columns: minmax(0, 1fr); grid-template-rows: fit-content(36%) minmax(0, 1fr); }
    .lib-sheet.lib-narrow .lib-as-cards { order: -1; overflow: hidden; } .lib-sheet.lib-narrow .lib-as-pslot .lib-sel-head h3 { display: none; } .lib-sheet.lib-narrow .lib-as-pslot .lib-sel-ctl label { flex: 1 1 130px; } .lib-sheet.lib-narrow .lib-as-cbody .lib-bk-acts { gap: 4px; } .lib-sheet.lib-narrow .lib-as-cbody .lib-bk-acts .xb { padding: 2px 6px; font-size: 11.5px; }
    /* Extremely small: one scrolling column, the cards strip first, then a fixed-height Product Library. */
    .lib-sheet.lib-tiny .lib-as { overflow: auto; } .lib-sheet.lib-tiny .lib-as-cols { display: flex; flex-direction: column; flex: none; } .lib-sheet.lib-tiny .lib-as-col { flex: none; } .lib-sheet.lib-tiny .lib-as-cards { max-height: none; margin-bottom: 8px; } .lib-sheet.lib-tiny .lib-as-prods { height: 340px; }
    .lib-info { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; border: 1px solid #9AA1B2; color: #4A5163; font-size: 11px; font-weight: 700; cursor: help; }
    .lib-info i { font-style: normal; } .lib-info:focus-visible { outline: 2px solid #2B4BFF; outline-offset: 2px; }
    .lib-tipbox { display: none; position: absolute; left: 0; top: 24px; z-index: 6; width: 230px; padding: 6px 8px; background: #1E2230; color: #fff; border-radius: 6px; font-size: 11.5px; font-weight: 400; line-height: 1.35; box-shadow: 0 6px 18px rgba(30,34,48,.3); }
    .lib-info:hover .lib-tipbox, .lib-info:focus .lib-tipbox { display: block; }
    .lib-assign-row { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; padding-bottom: 6px; border-bottom: 1px solid #E2E5EC; }
    .lib-sheet .lib-assign-row .xb.lib-assign { font-size: 13.5px; padding: 5px 18px; min-height: 30px; }
    .lib-sheet .lib-cfg { display: grid; grid-template-columns: minmax(170px, 1fr) minmax(250px, 2fr); grid-template-rows: auto 30px auto; column-gap: 14px; row-gap: 4px; align-items: start; }
    .lib-sheet .lib-cfg .lib-nm { display: grid; grid-column: 1; grid-row: 1 / 4; grid-template-rows: subgrid; gap: 4px; min-width: 0; flex: none; }
    .lib-sheet .lib-cfg label.lib-lsel { display: grid; grid-row: 1 / 3; grid-template-rows: subgrid; flex: none; gap: 4px; font-size: 11.5px; font-weight: 700; letter-spacing: 0; text-transform: none; color: #4A5063; }
    .lib-sheet .lib-cfg .lib-storebox { display: grid; grid-column: 2; grid-row: 1 / 4; grid-template-rows: subgrid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 8px; row-gap: 4px; min-width: 0; flex: none; }
    .lib-sheet .lib-cfg .lib-storebox > label { display: grid; grid-column: 1; grid-row: 1 / 4; grid-template-rows: subgrid; flex: none; gap: 4px; font-size: 11.5px; font-weight: 700; letter-spacing: 0; text-transform: none; color: #4A5063; min-width: 0; }
    .lib-sheet .lib-cfg .lib-cap { grid-row: 1; align-self: end; line-height: 16px; }
    .lib-sheet .lib-cfg .lib-listsel, .lib-sheet .lib-cfg .lib-store, .lib-sheet .lib-cfg [data-lib="storesel"] { grid-row: 2; height: 30px; box-sizing: border-box; margin: 0; width: 100%; }
    .lib-sheet .lib-cfg .lib-storebox > .xb { grid-column: 2; grid-row: 2; height: 30px; box-sizing: border-box; padding-top: 0; padding-bottom: 0; align-self: start; }
    .lib-sheet .lib-cfg .lib-help { grid-row: 3; font-size: 11px; font-weight: 400; color: #6B7183; }
    .lib-sheet .lib-cfg .lib-manage { grid-row: 3; align-self: start; justify-self: start; }
    @media (max-width: 560px) { .lib-sheet .lib-cfg { display: flex; flex-direction: column; } .lib-sheet .lib-cfg .lib-nm, .lib-sheet .lib-cfg .lib-storebox, .lib-sheet .lib-cfg label.lib-lsel, .lib-sheet .lib-cfg .lib-storebox > label { display: flex; flex-direction: column; } .lib-sheet .lib-cfg .lib-storebox { flex-direction: row; flex-wrap: wrap; align-items: flex-end; } }
    .lib-sheet.lib-amode .lib-as-foot { margin-top: 8px; padding-top: 10px; border-top: 2px solid #C9CEDB; }
    .lib-stage { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 1px solid #B9C4FF; background: #F4F6FF; border-radius: 8px; width: 100%; box-sizing: border-box; }
    .lib-stage-t { font-size: 12px; font-weight: 700; color: #1A33C7; } .lib-stage-a { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .lib-sheet.lib-amode .lib-as-pslot .lib-sel-foot { border-top: 0; padding-top: 4px; }
    .lib-bk-acts { display: flex; flex-wrap: wrap; gap: 6px; } .lib-bk-acts .lib-bk-define { font-weight: 700; }
    .lib-bk-empty { display: flex; flex-direction: column; gap: 4px; padding: 12px; border: 1px dashed #9AA1B2; border-radius: 8px; background: #F7F8FB; }
    .lib-bk-appr { display: flex; flex-direction: column; gap: 6px; border-color: #B7791F; background: #FFF8EB; }
    .lib-repbd { position: fixed; inset: 0; z-index: 12; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(30,34,48,.42); pointer-events: auto; }
    .lib-repbd[hidden] { display: none; }
    .lib-rep { position: relative; width: min(460px, 100%); max-height: 100%; overflow: auto; box-sizing: border-box; background: #fff; border: 2px solid #B7791F; border-radius: 10px; padding: 12px 14px; box-shadow: 0 12px 32px rgba(30,34,48,.35); display: flex; flex-direction: column; gap: 8px; font-size: 12.5px; }
    .lib-rep[hidden] { display: none; } .lib-rep-t { font-weight: 700; font-size: 13.5px; margin: 0; } .lib-rep-k { color: #6B7183; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; } .lib-rep-a { display: flex; gap: 8px; justify-content: flex-end; }
    .lib-ghost { position: fixed; z-index: 20; pointer-events: none; padding: 6px 10px; max-width: 260px; background: #1E7A3E; color: #fff; border-radius: 8px; font: 600 12px/1.3 -apple-system, Segoe UI, sans-serif; box-shadow: 0 8px 22px rgba(30,34,48,.4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lib-ghost[hidden] { display: none; }
    .lib-sheet.lib-amode .lib-sel-row[data-x="lib-sel-pick"] { cursor: grab; touch-action: none; user-select: none; -webkit-user-drag: none; } body.lib-dragging, .lib-sheet.lib-dragging { cursor: grabbing; user-select: none; }
    .lib-as-resize { position: absolute; z-index: 6; background: transparent; touch-action: none; }
    .lib-as-resize[hidden] { display: none; } .lib-as-resize:hover, .lib-as-resize:focus-visible { background: rgba(43,78,255,.35); outline: none; }
    .lib-as-resize[data-side="right"] { left: 0; top: 0; bottom: 0; width: 9px; cursor: ew-resize; }
    .lib-as-resize[data-side="left"] { right: 0; top: 0; bottom: 0; width: 9px; cursor: ew-resize; }
    .lib-as-resize[data-side="bottom"] { top: 0; left: 0; right: 0; height: 9px; cursor: ns-resize; }
    .lib-modal.lib-adock { background: transparent; pointer-events: none; padding: 0; display: block; }
    .lib-modal.lib-adock .lib-sheet { pointer-events: auto; position: fixed; max-height: none; box-sizing: border-box; border-radius: 0; overflow: hidden; box-shadow: 0 0 28px rgba(30,34,48,.3); }
    .lib-modal.lib-d-right .lib-sheet { top: 0; right: 0; bottom: 0; height: auto; } .lib-modal.lib-d-left .lib-sheet { top: 0; left: 0; bottom: 0; height: auto; }
    .lib-modal.lib-d-bottom .lib-sheet { left: 0; right: 0; bottom: 0; width: auto; }
    .lib-modal.lib-d-float .lib-sheet { top: 16px; right: 16px; border-radius: 12px; resize: both; min-width: 360px; min-height: 300px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); }
    .lib-bk-n { flex: none; width: 26px; height: 26px; border-radius: 50%; border: 0; padding: 0; cursor: pointer; background: #1E2230; color: #fff; font: 700 12px/26px -apple-system, Segoe UI, sans-serif; text-align: center; } .lib-bk.sel .lib-bk-n { background: #2B4EFF; }
    .lib-bk[data-x="lib-bk-select"] { cursor: pointer; }
    .lib-asg { display: inline-flex; flex-wrap: wrap; gap: 3px; margin-left: 4px; vertical-align: middle; }
    .lib-asg i { font-style: normal; font: 700 10.5px/1.5 -apple-system, Segoe UI, sans-serif; background: #1E7A3E; color: #fff; border-radius: 4px; padding: 0 5px; min-width: 14px; text-align: center; }
    .lib-bk-list { display: flex; flex-direction: column; gap: 8px; }
    .lib-bk { display: flex; gap: 8px; border: 1px solid #D9DCE4; border-radius: 8px; padding: 8px; background: #fff; }
    .lib-bk.sel { border-color: #2B4EFF; background: #F4F6FF; box-shadow: inset 4px 0 0 #2B4EFF; } .lib-bk.flash { background: #E3E9FF; }
    .lib-bk-off { background: #F7F8FB; }
    .lib-bk-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
    .lib-bk-t { display: flex; gap: 8px; align-items: center; } .lib-bk-t > span:last-child { display: flex; flex-direction: column; min-width: 0; overflow-wrap: anywhere; } .lib-bk-d { display: block; }
    .lib-bk-th { flex: none; width: 40px; height: 40px; border-radius: 6px; background: #EEF0F5; overflow: hidden; display: flex; align-items: center; justify-content: center; font-size: 9px; color: #6B7183; text-align: center; line-height: 1.1; } .lib-bk-th img { width: 100%; height: 100%; object-fit: cover; }
    .lib-bk-prod { overflow-wrap: anywhere; } .lib-bk-prod code { font-size: 11px; background: #F1F3F8; padding: 0 4px; border-radius: 4px; }
    .lib-bk-a { display: flex; flex-wrap: wrap; gap: 5px; } .lib-bk-why { color: #6B7183; }
    .lib-vv-notice.ok { border-color: #8BC9A0; background: #F0FAF3; }
    .lib-alts { display: flex; flex-direction: column; gap: 5px; margin-top: 4px; padding: 6px; background: #F7F8FB; border: 1px solid #E3E6EE; border-radius: 6px; }
    .lib-alt { display: flex; flex-direction: column; gap: 2px; padding: 5px 7px; background: #fff; border: 1px solid #E3E6EE; border-radius: 6px; } .lib-alt .sub code { font-size: 11px; background: #F1F3F8; padding: 0 4px; border-radius: 4px; }
    .lib-disc { border: 1px solid #D9DCE4; border-radius: 6px; padding: 7px 10px; font-size: 12px; background: #F7F8FB; } .lib-disc.bad { border-color: #E6A1A1; background: #FFF1F1; }
    .lib-map-empty { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; padding: 10px 0; }
    .lib-vv-notice.bad { border-color: #E6A1A1; background: #FFF1F1; color: #7A1B14; }
    .lib-sel-h4 { margin: 0; font-size: 10.5px; letter-spacing: .05em; text-transform: uppercase; color: #6B7183; }
    /* Narrow windows: the whole sheet scrolls as one, so the list is never squeezed into a sliver under a tall header. */
    @media (max-width: 560px) {
      .lib-sheet .lib-list { overflow: visible; flex: none; min-height: 0; padding-bottom: 4px; }
      .lib-sheet .lib-mgr-list { overflow: visible; flex: none; }
    }
  `;

  const HTML = `
    <div class="xmodal lib-modal" data-m="library" hidden><div class="xsheet lib-sheet" role="dialog" aria-label="Product Library" tabindex="-1">
      <header><b class="lib-head">Product Library</b><button class="icon" data-x="lib-close" aria-label="Close">✕</button></header>
      <div class="lib-mainview">
      <div class="lib-assign-row" hidden><button class="xb lib-go lib-assign" data-x="lib-assign" title="Give this list’s products to the product cards on this page">Assign Products</button><span class="lib-info" tabindex="0" role="note" aria-label="About Assign Products: give this list’s products to the product cards on the page you are viewing."><i aria-hidden="true">i</i><span class="lib-tipbox" role="tooltip">Give this list’s products to the product cards on the page you are viewing.</span></span></div>
      <div class="lib-cfg">
        <div class="lib-nm">
          <label class="lib-lsel"><span class="lib-cap">List:</span> <select class="lib-listsel" data-lib="listsel" aria-label="List"></select></label>
          <button class="lib-tg lib-manage" data-x="lib-lists" aria-expanded="false" title="Open the list manager">Manage lists</button>
        </div>
        <div class="lib-storebox">
          <label><span class="lib-cap">Shopify store</span>
            <select data-lib="storesel" aria-label="Saved Shopify stores" hidden></select>
            <input class="lib-store" data-lib="store" placeholder="https://your-store.com" autocomplete="off" spellcheck="false" aria-label="Shopify store address (optional)"><small class="lib-help">(optional · only used to verify products)</small></label>
          <button class="xb" data-x="lib-open">Set Store</button>
        </div>
      </div>
      <div class="lib-msg" role="status"></div>
      <div class="lib-warn"></div>
      <div class="lib-choice" hidden>
        <b class="lib-choice-t"></b>
        <label><input type="radio" name="libmode" value="new" checked><span>Create a new list <small>(default) The current list stays exactly as it is.</small></span></label>
        <label><input type="radio" name="libmode" value="add"><span>Add products to the current list <small>Products with a SKU already in the list join it as another placement.</small></span></label>
        <label><input type="radio" name="libmode" value="replace"><span>Replace the current list’s imported content <small>Earlier imports are kept, not deleted. Your corrections stay with products that are still in the list.</small></span></label>
        <div class="xrow"><button class="xb lib-primary" data-x="lib-choice-go">Import</button><button class="xb" data-x="lib-choice-cancel">Cancel</button></div>
      </div>
      <div class="lib-start" hidden>
        <h3>Upload a product list</h3>
        <label class="xb xb-file">Upload File <input type="file" accept=".csv,.tsv,.json,.docx" data-lib="file" hidden></label>
        <small>CSV, JSON, DOCX</small>
        <small>or drop a file here · no Shopify store needed</small>
        <button class="lib-tg" data-x="lib-add-local">or add a product by hand</button>
      </div>
      <div class="lib-local" hidden>
        <label>Name<input data-lib="lp-name" autocomplete="off"></label>
        <label>SKU <small>(optional)</small><input data-lib="lp-sku" autocomplete="off"></label>
        <label>Regular price<input data-lib="lp-price" inputmode="decimal" placeholder="0.00"></label>
        <label>Promotional price <small>(optional)</small><input data-lib="lp-promo" inputmode="decimal" placeholder="0.00"></label>
        <button class="xb lib-primary" data-x="lib-local-save">Add product</button><button class="xb" data-x="lib-local-cancel">Cancel</button>
      </div>
      <div class="lib-find" hidden>
        <div class="lib-find-title sub"></div>
        <div class="lib-find-id" hidden></div>
        <div class="xrow lib-find-search"><input class="lib-fq" data-lib="fq" placeholder="SKU, product name, or product URL" autocomplete="off"><button class="xb" data-x="lib-search">Search</button><button class="xb" data-x="lib-find-close">Close</button></div>
        <div class="lib-find-res"></div>
      </div>
      <div class="lib-body" hidden>
        <div class="lib-h"></div>
        <div class="lib-tools">
          <span class="lib-up"><label class="xb xb-file">Upload File <input type="file" accept=".csv,.tsv,.json,.docx" data-lib="file" hidden></label><small>CSV, JSON, DOCX</small></span>
          <button class="xb" data-x="lib-check">Check in Shopify</button>
          <button class="xb" data-x="lib-add">+ Add Shopify product</button>
          <button class="xb" data-x="lib-add-local">+ Add product by hand</button>
          <button class="xb" data-x="lib-export-full">Export Full List</button>
          <button class="xb" data-x="lib-export">Export Approved Products</button>
          <span style="flex:1"></span>
          <button class="ghost danger" data-x="lib-delete">Delete list</button>
        </div>
        <div class="lib-sum"></div>
        <div class="lib-chips"></div>
        <div class="lib-filter"><input data-lib="search" placeholder="Search name, SKU or variant ID" aria-label="Search products"><select data-lib="filter" aria-label="Filter">
          <option value="all">All</option><option value="review">Needs review</option><option value="promo">Promo warnings</option><option value="novariant">No variant</option><option value="notchecked">Not verified</option><option value="matched">Prices match</option><option value="approved">Approved</option></select></div>
        <div class="lib-list" tabindex="0"></div>
      </div>
      </div>
      <div class="lib-mgr" hidden>
        <div class="lib-mgr-head">
          <button class="xb lib-back" data-x="lib-lists-close" aria-label="Back to the Product Library" title="Back">←</button>
          <div><h3 tabindex="-1">Manage lists</h3><div class="sub lib-mgr-note" hidden>Lists marked “Same source file” were imported from the same document. Nothing is merged or deleted for you. Order is by creation date and never changes when you open or edit a list.</div></div>
          <span style="flex:1"></span><button class="xb lib-primary" data-x="lib-new">New List</button>
        </div>
        <div class="lib-mgr-list"></div>
      </div>
      <div class="lib-vv">
        <div class="lib-vv-head">
          <button class="xb lib-back" data-x="lib-vv-back" aria-label="Back to the Product Library" title="Back">←</button>
          <div><h3 class="lib-vv-h" tabindex="-1">Change Variant</h3><div class="lib-vv-prod"></div><div class="lib-vv-cur sub"></div></div>
        </div>
        <div class="lib-vv-choose">
          <div class="lib-vv-ctl"><b>Choose a variant</b><input class="lib-vvf" data-lib="vv-filter" placeholder="Filter by flavor, size, SKU or ID" aria-label="Filter variants" autocomplete="off"></div>
          <div class="lib-vv-note sub"></div>
          <div class="lib-vv-list" role="radiogroup" aria-label="Choose a variant"></div>
          <details class="lib-adv"><summary>Advanced: search by SKU</summary><div class="xrow"><input class="lib-sq" data-lib="sq" placeholder="Exact SKU" autocomplete="off" aria-label="Exact SKU"><button class="xb" data-x="lib-sku-search">Search SKU</button></div><div class="lib-sku-res"></div></details>
          <div class="lib-vv-foot">
            <button class="xb lib-primary lib-wide" data-x="lib-vv-review" disabled>Review Variant Change</button>
            <div class="lib-vv-hint" role="status"></div>
            <button class="lib-tg" data-x="lib-different">Find a different product…</button>
          </div>
        </div>
        <div class="lib-vv-review" hidden>
          <div class="lib-vv-rvb"></div>
          <div class="lib-vv-foot">
            <button class="xb lib-primary lib-wide" data-x="lib-vv-confirm">Confirm Variant Change</button>
            <button class="xb lib-wide" data-x="lib-vv-tochoose">Back to Variants</button>
          </div>
        </div>
      </div>
      <div class="lib-sel">
        <div class="lib-sel-head">
          <button class="xb lib-back" data-x="lib-sel-back" aria-label="Back to the products" title="Back" hidden>←</button>
          <div><h3 class="lib-sel-h" tabindex="-1">Choose a product</h3><div class="lib-sel-sub sub"></div></div>
        </div>
        <div class="lib-sel-body"></div>
        <div class="lib-sel-foot"></div>
      </div>
      <div class="lib-map">
        <div class="lib-sel-head"><div><h3 class="lib-map-h" tabindex="-1"></h3><div class="lib-map-sub sub"></div></div></div>
        <div class="lib-sel-body lib-map-body"></div>
        <div class="lib-sel-foot lib-map-foot"></div>
      </div>
      <div class="lib-as">
        <div class="lib-as-bar"><span class="lib-as-sum sub" role="status"></span>
          <span class="lib-as-docks" role="group" aria-label="Workspace position"><span class="sub">Dock:</span>${DOCK_SHOW.map((m) => `<button class="xb" data-x="lib-as-dock" data-mode="${m}" aria-pressed="false">${DOCK_LABEL[m]}</button>`).join('')}</span>
        </div>
        <div class="lib-as-cols">
          <section class="lib-as-col lib-as-prods" aria-label="Product Library"><h4 class="lib-as-h" tabindex="-1" data-count="">Product Library</h4><div class="lib-as-pslot"></div></section>
          <section class="lib-as-col lib-as-cards" aria-label="Page Cards"><h4 class="lib-as-h" tabindex="-1" data-count="">Page Cards<button type="button" class="xb lib-ex-btn" data-x="lib-bk-exlist" aria-expanded="false" hidden></button></h4><div class="lib-as-cbody"></div></section>
        </div>
        <div class="lib-as-foot"></div>
        <div class="lib-as-resize" role="separator" tabindex="0" aria-label="Resize the workspace (drag, or use the arrow keys)" title="Drag to resize"></div>
      </div>
    </div><div class="lib-repbd" hidden><div class="lib-rep" role="alertdialog" aria-modal="true" aria-labelledby="lib-rep-t"></div></div><div class="lib-ghost" hidden aria-hidden="true"></div></div>`;

  // ---------------------------------------------------------------- network: GET only, through the page or the worker

  async function fetchJson(url) {
    const u = new URL(url);
    if (u.origin === location.origin) {
      const r = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'omit' });
      if (!r.ok) { const e = new Error(`The store answered ${r.status}.`); e.status = r.status; throw e; }
      return r.json();
    }
    if (BL.runtimeAlive && !BL.runtimeAlive()) throw new Error('Blueline was reloaded. Reload this page and try again.');
    let res = null;
    try { res = await chrome.runtime.sendMessage({ type: 'blueline:fetch-json', url }); } catch { /* handled below */ }
    if (!res) throw new Error('Blueline couldn’t reach the store. Reload the extension and the page, then try again.');
    if (res.error) { const e = new Error(res.error); e.status = res.status; throw e; }
    return res.json;
  }
  const driver = () => Lib.createDriver({ origin: L.store, fetchJson, currency: L.lib?.work.settings.currency || 'USD' });
  const needStore = () => { if (L.store) return false; say('Enter a Shopify store above to verify products. A store is optional and only needed for this.', 'bad'); q('[data-lib="store"]').hidden = false; q('[data-lib="store"]').focus(); return true; };

  // ---------------------------------------------------------------- state

  function say(msg, kind = '') { L.msg = msg; L.msgKind = kind; const m = q('.lib-msg'); if (m) { m.textContent = msg; m.className = `lib-msg ${kind}`; } }

  // An untouched new list is never written to storage; it is saved with its first change.
  async function persist(opts) { if (L.lib && !(Lib.isPristine(L.lib) && !opts?.smpChanged)) { const r = await Lib.saveLibrary(storage(), L.lib, opts); if (r?.name && L.lib.name && L.lib.name !== r.name) L.lib = { ...L.lib, name: r.name }; await refreshLists(); } }
  async function mutate(fn, opts) { L.lib = fn(L.lib); await persist(opts); render(); }

  async function refreshLists() {
    const idx = await Lib.loadIndex(storage());
    L.lists = [...idx.libs].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    L.stores = [...new Set(idx.libs.map((l) => l.store).filter(Boolean))];
    try { BL.hooks.onLibraryLists?.(idx.libs.length); } catch { /* the home button only */ }
  }

  // Loads (or starts) the list `L.listId` of store `L.store` ('' = no store). No id means a new list.
  async function loadCurrent() {
    L.lib = L.listId ? await Lib.loadLibrary(storage(), L.store, L.listId) : Lib.newLibrary(L.store);
    L.listId = L.lib.campaign;
    L.customFor = null; L.editFor = null; L.localForm = false; L.find = null; L.pending = null; L.warnings = []; L.expanded = new Set(); L.filter = 'all'; L.search = ''; L.recent = null; L.scroll = null; L.provOpen = false; L.cmpOpen = new Set();
    q('[data-lib="search"]').value = '';
    await refreshLists();
    await Lib.setActive(storage(), pageOrigin(), L.store, L.listId);
    say('');
    render();
    detectCurrency();
    return true;
  }

  // Best effort: the store's currency from the public /cart.js. Otherwise USD is assumed and the library says so.
  // Opening a list never saves anything by itself: the currency is kept in memory until the list has content.
  async function detectCurrency() {
    const lib = L.lib;
    if (!lib || !lib.store) return;
    const id = `${lib.store}|${lib.campaign}`;
    if (L.currencyChecked.has(id)) return;
    L.currencyChecked.add(id);
    try {
      const c = await driver().detectCurrency();
      if (!c || !L.lib || L.lib.store !== lib.store) return;
      const apply = (l) => ({ ...l, work: { ...l.work, settings: { currency: c, currencySource: 'cart.js' } } });
      if (!Lib.isPristine(L.lib)) await mutate(apply, { touch: false }); else { L.lib = apply(L.lib); render(); }
    } catch { /* keep the assumed currency */ }
  }

  async function init(opts = {}) {
    await Lib.reconcileListNames(storage()); // saved lists never share a visible name
    const idx = await Lib.loadIndex(storage());
    // Only what this page's own workspace last used. Another website starts with a new, empty list.
    const act = idx.active[pageOrigin()];
    const act2 = act && (!opts.existing || idx.libs.some((l) => l.store === act.store && l.campaign === act.campaign)) ? act : null;
    if (act2) { L.store = act2.store; L.listId = act2.campaign; }
    else if (opts.existing && idx.libs.length) { const first = [...idx.libs].sort((a, b) => (a.createdAt || a.updatedAt || 0) - (b.createdAt || b.updatedAt || 0) || (a.campaign < b.campaign ? -1 : 1))[0]; L.store = first.store; L.listId = first.campaign; }
    else { L.store = BL.modeOf?.(S.page) === 'shopify' ? pageOrigin() : ''; L.listId = null; }
    L.showStoreInput = false;
    await refreshLists();
    await loadCurrent();
  }

  // "Use store": the store is optional and only for verification. Setting it on a new or store-less list just
  // attaches it; a list already tied to another store is never re-pointed, a new list is started for the new one.
  async function applyStore() {
    if (!L.lib) return;
    const typed = q('[data-lib="store"]').value;
    const n = Lib.optionalStore(typed);
    if (n.error) { say(n.error, 'bad'); return; }
    if (n.origin === L.lib.store) { say(''); return; }
    if (Lib.isPristine(L.lib)) {
      L.lib = { ...L.lib, store: n.origin }; L.store = n.origin;
      await Lib.setActive(storage(), pageOrigin(), L.store, L.listId);
      say(''); render(); detectCurrency(); return;
    }
    if (!L.lib.store && n.origin) {
      L.lib = await Lib.moveLibrary(storage(), L.lib, n.origin); L.store = n.origin;
      await Lib.setActive(storage(), pageOrigin(), L.store, L.listId);
      await refreshLists(); say(`Store set to ${host(n.origin)}. The list is unchanged; you can now check it in Shopify.`, 'ok'); render(); detectCurrency(); return;
    }
    if (!n.origin) { say(`This list is verified against ${host(L.lib.store)}. To work without a store, start a new list.`); q('[data-lib="store"]').value = L.lib.store; return; }
    L.store = n.origin; L.listId = null;
    await loadCurrent();
    say(`Started a new list for ${host(n.origin)}. Your other list is saved.`, 'ok');
  }

  // ---------------------------------------------------------------- List Manager

  const fmtDate = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown');
  const plainName = (it) => it.name || 'Untitled list';

  async function openMgr() {
    L.mgr = { items: [], renaming: null, deleting: null };
    L.mgrScroll = q('.lib-list').scrollTop;
    q('.lib-mgr').hidden = false; q('.lib-sheet').classList.add('lib-mmode', 'lib-full'); q('[data-x="lib-lists"]').setAttribute('aria-expanded', 'true');
    await reloadMgr();
    if (L.mgr) q('.lib-mgr-head h3')?.focus({ preventScroll: true }); // the button that opened it is now hidden: keep keys (Esc) in the window
  }
  async function reloadMgr() {
    if (!L.mgr) return;
    const items = await Lib.listSummaries(storage());
    // The list on screen that was never saved is shown too (it is not stored until it has content).
    if (L.lib && !items.some((i) => i.store === L.lib.store && i.campaign === L.lib.campaign)) items.push({ store: L.lib.store, campaign: L.lib.campaign, name: Lib.listName(L.lib), createdAt: null, updatedAt: null, products: 0, needsReview: 0, substitutions: 0, hasCorrections: false, corrections: {}, duplicates: [], sameSource: false, firstImported: false, unsaved: true });
    L.mgr.items = items;
    renderMgr();
  }
  function closeMgr() {
    const was = !!L.mgr;
    L.mgr = null; const m = q('.lib-mgr'); if (m) m.hidden = true;
    q('.lib-sheet')?.classList.remove('lib-mmode');
    q('[data-x="lib-lists"]')?.setAttribute('aria-expanded', 'false');
    if (was && L.root && L.mgrScroll != null) { render(); q('.lib-list').scrollTop = L.mgrScroll; }
    if (was && L.open) q('.lib-sheet')?.focus({ preventScroll: true }); // keep keys (Esc) in the window
    L.mgrScroll = null;
  }

  function deleteInfo(it) {
    const c = it.corrections || {};
    const bits = [];
    if (c.approvedPrices) bits.push(plural(c.approvedPrices, 'approved price'));
    if (c.approvedSubstitutions) bits.push(plural(c.approvedSubstitutions, 'approved replacement'));
    if (c.manualChoices) bits.push(plural(c.manualChoices, 'variant you chose by hand'));
    if (c.edits) bits.push(plural(c.edits, 'edited product'));
    if (c.manualProducts) bits.push(plural(c.manualProducts, 'product you added'));
    const dup = it.duplicates?.length ? ` Another list was imported from the same file (${it.duplicates.map((d) => `“${plainName(d)}”`).join(', ')}), but it does not have these corrections.` : '';
    return (bits.length ? `This list holds work that exists nowhere else: ${bits.join(', ')}.` : 'This list has no corrections, edits or approved replacements: only the imported products and Shopify lookups.') + dup + ' Deleting cannot be undone. Original files are never touched.';
  }

  function renderMgr() {
    const box = q('.lib-mgr-list');
    if (!L.mgr || !box) return;
    const note = q('.lib-mgr-note');
    if (note) note.hidden = !L.mgr.items.some((it) => it.sameSource);
    box.innerHTML = L.mgr.items.length ? L.mgr.items.map((it, i) => {
      const cur = L.lib && it.store === L.lib.store && it.campaign === L.lib.campaign;
      const badges = [];
      if (it.needsReview) badges.push(`<span class="lib-badge warn">${it.needsReview} need review</span>`);
      if (it.hasCorrections) badges.push(`<span class="lib-badge">Has your corrections</span>`);
      if (it.substitutions) badges.push(`<span class="lib-badge warn">${plural(it.substitutions, 'replacement')} to approve</span>`);
      if (it.corrections?.approvedSubstitutions) badges.push(`<span class="lib-badge ok">${plural(it.corrections.approvedSubstitutions, 'approved replacement')}</span>`);
      if (it.sameSource) badges.push(`<span class="lib-badge" title="Imported from the same source file as ${it.duplicates.map((d) => `“${esc(plainName(d))}”`).join(', ')}. Nothing is merged or deleted for you.">Same source file</span>`);
      if (it.firstImported) badges.push(`<span class="lib-badge" title="Saved earliest of the lists from this file. That does not make it the most correct one.">First imported</span>`);
      const more = L.mgr.deleting === i ? `<div class="lib-lm-more bad">${esc(deleteInfo(it))}<div class="lib-lm-act"><button class="xb lib-danger" data-x="lib-lm-del-go" data-i="${i}">Delete permanently</button><button class="xb" data-x="lib-lm-cancel">Cancel</button></div></div>` : '';
      const ren = L.mgr.renaming === i ? `<div class="lib-lm-more"><div class="lib-lm-act"><input data-lib="lm-name" value="${esc(it.name || '')}" aria-label="List name" style="flex:1;padding:4px 8px;border:1px solid #D9DCE4;border-radius:6px"><button class="xb lib-primary" data-x="lib-lm-ren-go" data-i="${i}">Save name</button><button class="xb" data-x="lib-lm-cancel">Cancel</button></div></div>` : '';
      return `<div class="lib-lm" data-i="${i}" data-id="${esc(it.campaign)}"${cur ? ' data-cur="1"' : ''}>
        <div class="lib-lm-main"><span><b>${esc(plainName(it))}</b>${cur ? ' <span class="lib-badge ok">Open now</span>' : ''}${it.unsaved ? ' <span class="lib-badge">Not saved yet</span>' : ''}</span>
          <span class="sub lib-lm-dates">${it.unsaved ? '<span>New, empty list</span>' : `<span>Created: ${esc(fmtDate(it.createdAt))}</span><span>Last edited: ${esc(fmtDate(it.updatedAt || it.createdAt))}</span>`}</span>
          <span class="sub">${esc(host(it.store))} · ${plural(it.products, 'product')}${it.products ? ` · ${it.needsReview} need review` : ''}</span>
          ${badges.length ? `<span class="lib-badges">${badges.join('')}</span>` : ''}</div>
        <div class="lib-lm-act"><button class="xb" data-x="lib-lm-open" data-i="${i}"${cur ? ' disabled' : ''}>Open</button><button class="xb" data-x="lib-lm-ren" data-i="${i}"${it.unsaved ? ' disabled' : ''}>Rename</button><button class="xb danger" data-x="lib-lm-del" data-i="${i}"${it.unsaved ? ' disabled' : ''}>Delete</button></div>
        ${ren}${more}</div>`;
    }).join('') : '<div class="lib-empty">No saved lists yet.</div>';
  }

  async function mgrOpen(i) {
    const it = L.mgr?.items[i];
    if (!it) return;
    L.store = it.store; L.listId = it.campaign;
    await loadCurrent();
    closeMgr();
  }
  async function mgrRename(i) {
    const it = L.mgr?.items[i];
    const name = q('[data-lib="lm-name"]')?.value.trim();
    if (!it) return;
    if (!name) { say('Enter a list name.', 'bad'); return; }
    if (name === (it.name || '')) { L.mgr.renaming = null; renderMgr(); return; } // nothing changed: not an edit
    await Lib.renameLibrary(storage(), it.store, it.campaign, name);
    const final = (await Lib.listLabel(storage(), it.store, it.campaign)) || name; // numbered if another list already has this name
    if (L.lib && L.lib.store === it.store && L.lib.campaign === it.campaign) L.lib = { ...L.lib, name: final };
    L.mgr.renaming = null; await refreshLists(); await reloadMgr(); render();
  }
  async function mgrDelete(i) {
    const it = L.mgr?.items[i];
    if (!it) return;
    const wasCurrent = L.lib && it.store === L.lib.store && it.campaign === L.lib.campaign;
    await Lib.deleteLibrary(storage(), it.store, it.campaign);
    L.mgr.deleting = null;
    if (wasCurrent) { L.lib = null; L.listId = null; await loadCurrent(); }
    else await refreshLists();
    say(`Deleted “${plainName(it)}”. Original files were never touched.`);
    await reloadMgr();
  }
  async function mgrNew() {
    L.listId = null;
    await loadCurrent();
    closeMgr();
    say('New list. Upload a file to start it; your other lists are unchanged.');
  }

  async function rename(name) {
    if (!L.lib) return;
    if (name.trim() === (L.lib.name || (Lib.isPristine(L.lib) ? '' : Lib.listName(L.lib)))) return; // nothing changed: not an edit
    L.lib = { ...L.lib, name: name.trim() || null };
    if (!Lib.isPristine(L.lib)) { await Lib.renameLibrary(storage(), L.lib.store, L.lib.campaign, L.lib.name || L.lib.campaign); const final = await Lib.listLabel(storage(), L.lib.store, L.lib.campaign); if (final && L.lib.name) L.lib = { ...L.lib, name: final }; await refreshLists(); }
    render();
  }

  // ---------------------------------------------------------------- importing: pick or drop a file, then (for a list that already has content) choose how

  async function handleFile(file) {
    if (!file) return;
    if (!ACCEPT.test(file.name || '')) { say(`${file.name || 'That file'} can’t be imported. Use a CSV, JSON or DOCX file.`, 'bad'); return; }
    if (file.size === 0) { say(`${file.name} is empty.`, 'bad'); return; }
    L.reading = true; say(`Reading ${file.name}…`); render();
    let imp;
    try { imp = await Lib.importFile(file); } catch (e) { L.reading = false; say(`${file.name}: ${e.message}`, 'bad'); render(); return; }
    L.reading = false;
    if (L.lib.smp.imports.length) {
      // Never silently merge or overwrite: ask. A new list is the default.
      L.pending = { imp, file, name: file.name }; L.confirmReplace = false;
      say(`${file.name} is ready (${plural(imp.placements.length, 'placement')}). Choose how to import it.`);
      render(); return;
    }
    await commitImport(imp, file.name, 'into');
  }

  async function commitImport(imp, fileName, mode) {
    const prods = Lib.smpProducts({ imports: [imp] }).length;
    const summary = `${plural(imp.placements.length, 'placement')} (${plural(prods, 'product')}) from ${fileName}. The original file was only read.`;
    L.warnings = imp.warnings;
    if (mode === 'new') {
      const fresh = Lib.newLibrary(L.lib.store, Lib.defaultListName(fileName));
      L.lib = { ...fresh, smp: Lib.addImport(fresh, imp).lib.smp };
      L.listId = L.lib.campaign; L.customFor = null; L.editFor = null; L.expanded = new Set(); L.filter = 'all';
      await persist({ smpChanged: true, name: L.lib.name || undefined });
      await Lib.setActive(storage(), pageOrigin(), L.store, L.listId);
      say(`Created the list “${Lib.listName(L.lib)}”: ${summary} The previous list is unchanged.`, 'ok');
    } else if (mode === 'replace') {
      L.lib = Lib.replaceImports(L.lib, imp);
      await persist({ smpChanged: true });
      say(`Replaced the list’s imported content with ${summary} The earlier import is kept in storage, and your corrections stay with products that are still listed.`, 'ok');
    } else {
      const added = Lib.addImport(L.lib, imp);
      if (added.duplicate) { say(`${fileName} is already in this list. Nothing changed.`); L.pending = null; render(); return; }
      L.lib = { ...added.lib, name: mode === 'into' ? L.lib.name || Lib.defaultListName(fileName) : L.lib.name };
      await persist({ smpChanged: true, name: L.lib.name || undefined });
      say(`Imported ${summary}`, 'ok');
    }
    L.pending = null; L.confirmReplace = false;
    render();
  }

  async function choiceGo() {
    const p = L.pending;
    if (!p) return;
    const mode = q('[name="libmode"]:checked')?.value || 'new';
    if (mode === 'replace' && !L.confirmReplace) { L.confirmReplace = true; render(); return; }
    await commitImport(p.imp, p.name, mode);
  }

  const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  function onDrag(e) {
    if (!L.open || !isFileDrag(e)) return;
    e.preventDefault(); // without this the browser would open the dropped file and leave the page
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    q('.lib-modal').classList.toggle('lib-drag', e.type !== 'dragleave');
  }
  function onDrop(e) {
    if (!L.open || !isFileDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    q('.lib-modal').classList.remove('lib-drag');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) { say('Nothing to import: the drop contained no file.', 'bad'); return; }
    if (files.length > 1) { say('Drop one file at a time.', 'bad'); return; }
    handleFile(files[0]);
  }

  // ---------------------------------------------------------------- actions

  const checkSummary = (rows) => {
    const s = Lib.summarize(rows);
    return `Checked ${plural(s.total, 'product')}: ${plural(s.variantsResolved, 'variant')} found${s.noVariant ? `, ${s.noVariant} without one` : ''} · ${plural(s.priceMatch, 'price')} match${s.priceMatch === 1 ? 'es' : ''}, ${s.priceDiffer} differ${s.priceDiffer === 1 ? 's' : ''} · ${s.needsReview} need${s.needsReview === 1 ? 's' : ''} review.`;
  };

  async function doCheck() {
    if (!L.lib || needStore()) return;
    L.busy = 'check';
    say('Checking the store…');
    render();
    try {
      const out = await Lib.checkAll(driver(), L.lib, (d, n) => { say(`Checked ${d} of ${n}…`); });
      L.lib = out;
      await persist();
      { const rs = Lib.buildRows(L.lib); say(checkSummary(rs), Lib.summarize(rs).needsReview ? 'warn' : 'ok'); }
    } catch (e) { say(`Check failed: ${e.message}`, 'bad'); }
    L.busy = '';
    render();
  }

  async function checkOne(key) {
    const row = L.rows.find((r) => r.key === key);
    if (!row || needStore()) return;
    L.busy = key; render();
    try {
      const fresh = row.variant ? await Lib.refreshVariant(driver(), row.variant) : await Lib.lookupProduct(driver(), { sku: row.sku, name: row.name, smpCents: row.smp?.originalCents ?? null });
      L.lib = row.variant ? Lib.setRefresh(L.lib, key, fresh) : Lib.setLookup(L.lib, key, fresh); // apply to the latest state, after the await
      await persist();
    } catch (e) { say(`Lookup failed: ${e.message}`, 'bad'); }
    L.busy = ''; render();
  }

  async function decide(key, source, custom) {
    try { await mutate((l) => Lib.decide(l, key, source, custom)); L.customFor = null; render(); } catch (e) { say(e.message, 'bad'); }
  }

  async function copy(text, label) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const t = document.createElement('textarea');
      t.value = text; t.style.cssText = 'position:fixed;opacity:0'; L.root.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch { /* nothing more to try */ }
      t.remove();
    }
    BL.toast?.(`Copied ${label}`);
  }

  function exportJson(scope = 'approved') {
    if (!L.lib) return null;
    const data = Lib.exportList(L.lib, scope);
    const text = JSON.stringify(data, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = `blueline-product-library-${host(L.store).replace(/[^a-z0-9.-]/gi, '-')}-${Lib.slug(Lib.listName(L.lib)) || L.lib.campaign}-${scope}.json`;
    L.root.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    say(scope === 'full'
      ? `Exported the full list: ${plural(data.products.length, 'product')}, including products that are unresolved or not verified.`
      : `Exported ${plural(data.products.length, 'approved product')}${data.needsAttention.length ? `; ${data.needsAttention.length} not approved yet and listed separately` : ''}.`, 'ok');
    return text;
  }

  // ---- the side panel: add a product that wasn't in the list, pick a variant of the linked product, or find another product

  const hideFind = () => { clearTimeout(liveT); liveSeq++; L.find = null; const f = q('.lib-find'); if (f) f.hidden = true; render(); };

  function showFind(mode, key, title, inputPlaceholder) {
    clearTimeout(liveT); liveSeq++;
    L.find = { mode, key: key || null, results: [], busy: false, note: '', product: null, filter: '', skuResults: null, last: null, cache: new Map(), queued: false, pendingIdx: null, pendingSku: false };
    q('.lib-find').hidden = false;
    q('.lib-find-title').textContent = title;
    q('.lib-fq').placeholder = inputPlaceholder;
    q('[data-x="lib-search"]').hidden = false;
    const idn = q('.lib-find-id');
    const row = key ? L.rows.find((r) => r.key === key) : null;
    idn.hidden = !row;
    if (row) idn.innerHTML = `Editing <b>${esc(row.display.title)}</b>${row.origin === 'smp' ? ` · original SKU <code>${esc(row.sku || 'none')}</code>` : ''}${row.variant ? `<br>Currently linked: <b>${esc([row.variant.productTitle, row.variant.variantTitle].filter(Boolean).join(' — '))}</b> · SKU <code>${esc(row.variant.sku || 'none')}</code> · variant ${esc(row.variant.variantId)}` : '<br>No Shopify variant linked yet.'}`;
    render();
  }

  // Search for a product by SKU, name or link. `pick`: choose the variant for an existing row (after a miss, or because
  // the product itself was wrong). `add`: a product that isn't in the list.
  function openFind(mode, key) {
    if (needStore()) return;
    const row = key ? L.rows.find((r) => r.key === key) : null;
    showFind(mode, key, mode === 'pick' ? `Find the product for ${row?.display.title || row?.sku}. Nothing is chosen for you: pick the exact variant.` : 'Search the store. Pick the exact variant to add.', 'SKU, product name, or product URL (searches as you type)');
    q('.lib-fq').value = row ? row.sku || row.name || '' : '';
    renderFind();
    q('.lib-fq').focus();
  }

  // ---- Change Variant: a dedicated view that temporarily replaces the Product Library inside the same modal.
  // Choose (radio list) -> Review (before / after) -> Confirm. Nothing is saved until Confirm. Leaving restores the
  // list's scroll position and keeps the edited product in view.

  const usefulOpts = (v) => (v?.options || []).filter((o) => !(/^title$/i.test(o.name) && /^default title$/i.test(o.value)));
  const optLabel = (v) => {
    const o = usefulOpts(v);
    if (!o.length) return v?.variantTitle && !/^default title$/i.test(v.variantTitle) ? v.variantTitle : 'Default';
    return o.length === 1 ? o[0].value : o.map((x) => `${x.name}: ${x.value}`).join(' · ');
  };
  const vvAll = (f) => [...(f.results || []), ...((f.skuResults?.list || []).filter((v) => !(f.results || []).some((x) => x.variantId === v.variantId)))];

  async function openVariants(key) {
    const row = L.rows.find((r) => r.key === key);
    if (!row?.variant || needStore()) return;
    clearTimeout(liveT); liveSeq++;
    L.recent = null;
    L.scroll = { list: q('.lib-list').scrollTop, sheet: q('.lib-sheet').scrollTop, key };
    L.find = { mode: 'variants', key, results: [], busy: true, note: 'Loading the product’s variants…', product: null, filter: '', skuResults: null, step: 'choose', selId: row.variant.variantId, cache: new Map() };
    q('[data-lib="vv-filter"]').value = ''; q('.lib-sq').value = ''; q('.lib-adv').open = false;
    render();
    q('.lib-vv-h').focus?.();
    try {
      const p = await driver().product(row.variant.handle);
      if (!L.find || L.find.key !== key || L.find.mode !== 'variants') return;
      if (!p) L.find.note = 'This product is no longer in the store. Use “Find a different product…”.';
      else { L.find.product = p; L.find.results = p.variants; L.find.note = ''; }
    } catch (e) { if (L.find?.mode === 'variants') L.find.note = `Couldn’t load the product: ${e.message}`; }
    if (L.find?.mode === 'variants') { L.find.busy = false; renderVariants(); }
  }

  // Back to the Product Library: same scroll position, the edited product kept in view.
  function leaveVariants(key) {
    const sc = L.scroll;
    clearTimeout(liveT); liveSeq++;
    L.find = null;
    render();
    const list = q('.lib-list');
    if (sc) { list.scrollTop = sc.list; q('.lib-sheet').scrollTop = sc.sheet; }
    const el = key ? [...list.querySelectorAll('.lib-row')].find((r) => r.dataset.key === key) : null;
    el?.scrollIntoView({ block: 'nearest' });
    L.scroll = null;
  }

  async function applyVariant() {
    const f = L.find;
    if (!f || f.mode !== 'variants') return;
    const v = vvAll(f).find((x) => x.variantId === f.selId);
    if (!v) return;
    const key = f.key;
    await mutate((l) => Lib.chooseVariant(l, key, v));
    const r = L.rows.find((x) => x.key === key);
    const name = [v.productTitle, v.variantTitle].filter(Boolean).join(' — ');
    if (!r) { leaveVariants(key); return; }
    // The message is written first so the library's layout is final before the edited product is scrolled into view.
    if (r.identity.state === 'substitute-pending') say(`Variant changed — replacement approval required. ${name} (SKU ${v.sku || 'none'}) is not the SKU the list named (${r.sku || 'none'}). Press Approve Replacement to use it.`, 'warn');
    else say(`Now using ${name} (variant ${v.variantId}). Original ${Lib.fmt(r.prices.smpCents, r.prices.currency)} vs Shopify ${Lib.fmt(r.prices.shopifyCents, r.prices.currency)}: ${Lib.STATUS_LABEL[r.verification.status]}.`, 'ok');
    L.recent = key;
    leaveVariants(key);
  }

  const vvMeta = (v, cur) => `SKU: ${esc(v.sku || 'none')} · ${esc(Lib.fmt(v.priceCents, cur))}${v.compareAtCents != null ? ` <s>${esc(Lib.fmt(v.compareAtCents, cur))}</s>` : ''} · ${v.available ? 'Available' : 'Sold out'}`;

  function renderVariants() {
    const f = L.find;
    if (!f || f.mode !== 'variants') return;
    const row = L.rows.find((r) => r.key === f.key);
    const cur = L.lib?.work.settings.currency;
    const curId = row?.variant?.variantId;
    q('.lib-vv-prod').textContent = row ? row.display.title : '';
    q('.lib-vv-cur').textContent = row?.variant ? `Current: ${optLabel(row.variant)}` : '';
    const review = f.step === 'review';
    q('.lib-vv-choose').hidden = review;
    q('.lib-vv-review').hidden = !review;
    const all = vvAll(f);
    const sel = all.find((v) => v.variantId === f.selId);
    if (review) {
      const rv = q('.lib-vv-rvb');
      if (!sel || !row?.variant) { f.step = 'choose'; renderVariants(); return; }
      const c = row.variant;
      const diff = row.origin === 'smp' && !Lib.skuEq(row.sku, sel.sku);
      const back = row.origin === 'smp' && !Lib.skuEq(row.sku, c.sku) && Lib.skuEq(row.sku, sel.sku);
      const block = (title, v, cls) => `<div class="${cls}"><i>${title}</i><b>${esc(optLabel(v))}</b><span>SKU ${esc(v.sku || 'none')}</span><span>${esc(Lib.fmt(v.priceCents, cur))} · ${v.available ? 'Available' : 'Sold out'}</span><span class="lib-vr-id">Variant ID ${esc(v.variantId)}</span></div>`;
      rv.innerHTML = `<h4 tabindex="-1">Review Variant Change</h4><div class="sub"><b>${esc(row.display.title)}</b></div>`
        + `<div class="lib-cmp">${block('Current', c, 'lib-orig')}${block('New', sel, 'lib-prop')}</div>`
        + (diff ? `<div class="lib-vv-notice">This variant has a different SKU than the original imported product${row.sku ? ` (SKU ${esc(row.sku)})` : ''}. Confirming the change will require a separate replacement approval.</div>`
          : back ? '<div class="lib-vv-notice ok">This is the SKU the original list named, so no replacement approval is needed.</div>' : '');
      return;
    }
    q('[data-lib="vv-filter"]').hidden = !f.results.length;
    q('.lib-vv-note').textContent = f.note || (f.product ? `${f.product.title} · ${plural(f.results.length, 'variant')}` : '');
    let list = f.results;
    if (f.filter.trim()) {
      const t = f.filter.trim().toLowerCase();
      list = f.results.filter((v) => [optLabel(v), v.variantTitle, v.sku, v.variantId, ...v.options.map((o) => o.value)].some((x) => String(x || '').toLowerCase().includes(t)));
    }
    const rowHtmlV = (v, showProduct) => {
      const isCur = v.variantId === curId;
      const isSel = v.variantId === f.selId;
      return `<label class="lib-vr" data-id="${esc(v.variantId)}"${isCur ? ' data-cur="1"' : ''}${isSel ? ' data-sel="1"' : ''}><input type="radio" name="lib-vv" value="${esc(v.variantId)}" data-lib="vv-radio"${isSel ? ' checked' : ''}>`
        + `<span class="lib-vr-body"><span class="lib-vr-t">${showProduct ? `<span class="sub">${esc(v.productTitle)} ·</span> ` : ''}<b>${esc(optLabel(v))}</b>${isCur ? '<span class="lib-badge ok">Current</span>' : ''}</span>`
        + `<span class="lib-vr-m">${vvMeta(v, cur)}</span><span class="lib-vr-id">Variant ID ${esc(v.variantId)}${copyBtn('variant ID', v.variantId)}</span></span></label>`;
    };
    q('.lib-vv-list').innerHTML = list.map((v) => rowHtmlV(v, false)).join('') + (f.results.length && !list.length ? '<div class="sub">No variant matches that filter.</div>' : '');
    const sr = f.skuResults;
    q('.lib-sku-res').innerHTML = sr ? (sr.note ? `<div class="sub">${esc(sr.note)}</div>` : '') + sr.list.map((v) => rowHtmlV(v, true)).join('') : '';
    syncVariantSel();
  }

  // Selecting a radio never saves anything: it only enables "Review Variant Change" when it differs from the current one.
  function syncVariantSel() {
    const f = L.find;
    if (!f || f.mode !== 'variants') return;
    const curId = L.rows.find((r) => r.key === f.key)?.variant?.variantId;
    for (const el of L.root.querySelectorAll('.lib-vr')) { if (el.dataset.id === f.selId) el.dataset.sel = '1'; else delete el.dataset.sel; }
    const changed = !!f.selId && f.selId !== curId;
    q('[data-x="lib-vv-review"]').disabled = !changed;
    q('.lib-vv-hint').textContent = f.busy ? '' : changed ? '' : 'Select a different variant to continue.';
  }

  // Live search: waits for typing to pause, needs 3+ characters, never sends the same query twice, runs one request
  // at a time (the newest typed text runs next) and ignores answers that arrive after the text changed.
  let liveT = 0;
  let liveSeq = 0;
  const LIVE_MIN = 3;
  const LIVE_MS = 550;
  function scheduleLive() {
    clearTimeout(liveT);
    const f = L.find;
    if (!f || f.mode === 'variants') return;
    const text = q('.lib-fq').value.trim();
    if (text.length < LIVE_MIN) { if (f.note && !f.busy) { f.note = ''; renderFind(); } return; }
    liveT = setTimeout(() => runFind(false), LIVE_MS);
  }

  async function runFind(manual = true) {
    clearTimeout(liveT);
    const f = L.find;
    const text = q('.lib-fq').value.trim();
    if (!f || !text || f.mode === 'variants' || needStore()) return;
    const key = text.toLowerCase();
    if (f.busy) { f.queued = true; return; } // one request at a time; the latest text runs when this one ends
    if (f.last === key && !manual) return; // the same query is already on screen
    const seq = ++liveSeq;
    f.busy = true; f.queued = false; f.note = 'Searching…'; renderFind();
    try {
      let results = manual ? null : f.cache.get(key);
      if (!results) {
        const d = driver();
        const ref = Lib.parseProductRef(text);
        let products = [];
        if (ref) { const p = await d.product(ref.handle); if (p) products = [p]; if (p && ref.variantId) p.variants = p.variants.filter((v) => v.variantId === ref.variantId); }
        else { for (const h of (await d.suggest(text, { limit: 6 })).slice(0, 6)) { try { const p = await d.product(h.handle); if (p) products.push(p); } catch { /* skip one bad product */ } } }
        const exactSku = (v) => (Lib.skuEq(v.sku, text) ? 0 : 1);
        results = products.flatMap((p) => p.variants).sort((a, b) => exactSku(a) - exactSku(b)).slice(0, 30); // exact SKU matches first
        f.cache.set(key, results);
      }
      if (seq !== liveSeq || L.find !== f) return; // stale: the panel closed or was reopened
      f.last = key; f.results = results;
      f.note = results.length ? '' : 'Nothing found. Try the SKU, a product link, or fewer words.';
    } catch (e) { if (seq === liveSeq && L.find === f) { f.results = []; f.note = `Search failed: ${e.message}`; } }
    if (L.find === f) {
      f.busy = false; renderFind();
      if (f.queued && q('.lib-fq').value.trim().toLowerCase() !== f.last && q('.lib-fq').value.trim().length >= LIVE_MIN) { f.queued = false; runFind(false); }
    }
  }

  // Advanced: an exact SKU anywhere in the store (for someone who does know it).
  async function runSkuSearch() {
    const text = q('.lib-sq').value.trim();
    if (!text || L.find?.mode !== 'variants') return;
    const f = L.find;
    f.skuResults = { note: 'Searching…', list: [] }; renderVariants();
    try {
      const d = driver();
      const found = [];
      for (const h of (await d.suggest(text, { skuOnly: true })).slice(0, 8)) { try { const p = await d.product(h.handle); if (p) found.push(...p.variants.filter((v) => Lib.skuEq(v.sku, text))); } catch { /* skip */ } }
      if (L.find !== f) return;
      f.skuResults = { note: found.length ? '' : `No variant in the store has SKU ${text}.`, list: found };
    } catch (e) { if (L.find === f) f.skuResults = { note: `Search failed: ${e.message}`, list: [] }; }
    if (L.find === f) renderVariants();
  }

  async function chooseFromFind(v, key) {
    await mutate((l) => Lib.chooseVariant(l, key, v));
    hideFind();
    const r = L.rows.find((x) => x.key === key);
    if (!r) return;
    const name = [v.productTitle, v.variantTitle].filter(Boolean).join(' — ');
    if (r.identity.state === 'substitute-pending') {
      // Not a success: a different SKU is linked but not yet accepted. A matching price changes nothing about that.
      say(`Variant changed — replacement approval required. ${name} (SKU ${v.sku || 'none'}) is not the SKU the list named (${r.sku || 'none'}). Press Approve Replacement to use it.`, 'warn');
    } else say(`Now using ${name} (variant ${v.variantId}). SMP ${Lib.fmt(r.prices.smpCents, r.prices.currency)} vs Shopify ${Lib.fmt(r.prices.shopifyCents, r.prices.currency)}: ${Lib.STATUS_LABEL[r.verification.status]}.`, 'ok');
  }

  // Choosing in the picker only selects; nothing changes until the change is confirmed.
  function confirmPick() {
    const f = L.find;
    if (!f || f.pendingIdx === null || f.pendingIdx === undefined) return;
    const v = f.pendingSku ? f.skuResults?.list[f.pendingIdx] : f.results[f.pendingIdx];
    if (v) chooseFromFind(v, f.key);
  }

  async function useFound(i, fromSku) {
    const v = fromSku ? L.find?.skuResults?.list[i] : L.find?.results[i];
    if (!v) return;
    if (L.find.mode === 'pick' || L.find.mode === 'variants') { L.find.pendingIdx = i; L.find.pendingSku = !!fromSku; renderFind(); return; }
    let dup = false;
    await mutate((l) => { const r = Lib.addManualProduct(l, v); dup = r.duplicate; return r.lib; });
    say(dup ? 'That variant is already in the library.' : `Added ${v.productTitle}${v.variantTitle ? ` — ${v.variantTitle}` : ''}.`, dup ? '' : 'ok');
  }

  async function pickCandidate(key, i) {
    const row = L.rows.find((r) => r.key === key);
    const v = row?.match?.candidates?.[i];
    if (v) await mutate((l) => Lib.chooseVariant(l, key, v));
  }

  // ---- Edit Information and products added by hand

  const val = (sel) => q(sel)?.value ?? '';
  async function saveEdit(key) {
    const row = L.rows.find((r) => r.key === key);
    if (!row) return;
    try {
      let lib = L.lib;
      const title = val('[data-lib="ed-title"]').trim();
      if (title && title !== row.display.title) lib = Lib.setEdit(lib, key, 'title', title);
      const price = val('[data-lib="ed-price"]').trim();
      if (price) { const c = Lib.toCents(price); if (c === null) throw new Error('Enter the regular price like 19.97.'); if (c !== row.prices.approvedCents) lib = Lib.decide(lib, key, 'custom', c); }
      const promo = val('[data-lib="ed-promo"]').trim();
      if (promo) { const c = Lib.toCents(promo); if (c === null) throw new Error('Enter the promotional price like 11.99.'); if (c !== row.prices.promoCents) lib = Lib.setEdit(lib, key, 'promoCents', c); }
      const image = val('[data-lib="ed-image"]').trim();
      if (image && image !== row.display.image) lib = Lib.setEdit(lib, key, 'image', image);
      if (row.local) { const sku = val('[data-lib="ed-sku"]').trim(); if (sku !== (row.sku || '')) lib = Lib.setLocalSku(lib, key, sku); }
      L.lib = lib; await persist(); L.editFor = null; say('Saved. The original imported values and the Shopify link are unchanged.', 'ok'); render();
    } catch (e) { say(e.message, 'bad'); }
  }

  async function resetField(key, field) {
    if (field === 'price') await mutate((l) => Lib.clearDecision(l, key));
    else await mutate((l) => Lib.resetEdit(l, key, field));
  }

  async function saveLocal() {
    const name = val('[data-lib="lp-name"]');
    const price = val('[data-lib="lp-price"]').trim();
    const promo = val('[data-lib="lp-promo"]').trim();
    const pc = price ? Lib.toCents(price) : null;
    const sc = promo ? Lib.toCents(promo) : null;
    if ((price && pc === null) || (promo && sc === null)) { say('Enter prices like 19.97.', 'bad'); return; }
    try {
      let key = null;
      await mutate((l) => { const r = Lib.addLocalProduct(l, { name, sku: val('[data-lib="lp-sku"]'), regularCents: pc, promoCents: sc }); key = r.key; return r.lib; });
      L.localForm = false; say(`Added ${name.trim()}. It is not linked to Shopify.`, 'ok'); render();
    } catch (e) { say(e.message, 'bad'); }
  }

  // ---------------------------------------------------------------- drawing

  const optChips = (v) => usefulOpts(v).map((o) => `<span class="lib-opt" title="${esc(o.name)}">${esc(o.name)}: ${esc(o.value)}</span>`).join('');
  const thumb = (src) => `<div class="lib-img">${src && /^https?:/i.test(src) ? `<img src="${esc(src)}" alt="" loading="lazy">` : 'no image'}</div>`;
  const copyBtn = (what, v) => `<button class="lib-cp" data-x="lib-copy" data-what="${what}" data-val="${esc(v)}" title="Copy ${what}" aria-label="Copy ${what}">⧉</button>`;
  const groupLabel = (g) => (g ? [g.label, g.list].filter(Boolean).join(' · ') : 'Ungrouped');

  function visible(r) {
    if (L.recent === r.key) return true; // the product just edited stays on screen whatever the filter says
    const s = L.search.trim().toLowerCase();
    if (s && ![r.name, r.display.title, r.sku, r.variant?.sku, r.variant?.variantId, r.variant?.productTitle, r.variant?.variantTitle].some((x) => String(x || '').toLowerCase().includes(s))) return false;
    switch (L.filter) {
      case 'review': return r.review.needsReview;
      case 'promo': return r.promoWarnings.length > 0;
      case 'novariant': return !r.variant && r.variantState !== 'unchecked';
      case 'notchecked': return r.variantState === 'unchecked';
      case 'matched': return r.verification.status === 'match';
      case 'approved': return r.settled;
      default: return true;
    }
  }

  function tone(r) {
    if (!r.variant) return r.variantState === 'unchecked' ? '' : 'bad';
    if (r.settled) return 'ok';
    if (r.identity.state === 'substitute-pending') return 'warn';
    return r.correction === 'none' ? '' : r.verification.status === 'mismatch' ? 'bad' : 'warn';
  }

  const SRC = { shopify: 'Shopify price', smp: 'SMP price', custom: 'custom price', match: 'matches Shopify' };

  // One variant as a compact text row (no image): options first, then SKU, ID, price and availability.
  function variantCard(v, { cur, act, current, selected, cls = '', showProduct = false }) {
    const f = (c) => Lib.fmt(c, cur);
    const opts = optChips(v) || `<span class="lib-opt">${esc(v.variantTitle || 'Default')}</span>`;
    return `<div class="lib-cand ${cls}"${current ? ' data-cur="1"' : ''}${selected ? ' data-sel="1"' : ''}><div>
      <span class="lib-line">${showProduct ? `<b>${esc(v.productTitle)}</b>` : ''}${opts}<span><b>${f(v.priceCents)}</b>${v.compareAtCents != null ? ` <s class="sub">${f(v.compareAtCents)}</s>` : ''}</span><span class="lib-badge ${v.available ? 'ok' : 'warn'}">${v.available ? 'Available' : 'Sold out'}</span>${current ? '<span class="lib-badge ok">Current</span>' : ''}${selected ? '<span class="lib-badge warn">Selected — not applied yet</span>' : ''}</span>
      <span class="lib-line"><span><i>SKU</i> <code>${esc(v.sku || 'none')}</code>${v.sku ? copyBtn('SKU', v.sku) : ''}</span> <span><i>Variant ID</i> <code>${esc(v.variantId)}</code>${copyBtn('variant ID', v.variantId)}</span></span>
    </div>${act}</div>`;
  }

  function editHtml(r) {
    const f = (c) => Lib.fmt(c, r.prices.currency);
    const fld = (label, hint, input, field, edited) => `<label>${label}<small>${hint}</small><span class="lib-fld">${input}${edited ? `<button class="xb" data-x="lib-ed-reset" data-field="${field}" data-key="${esc(r.key)}" title="Go back to the source value">Reset</button>` : ''}</span></label>`;
    const centsStr = (c) => (c === null || c === undefined ? '' : (c / 100).toFixed(2));
    return `<div class="lib-edit" data-edit="${esc(r.key)}">
      ${fld('Display title', `Original imported: ${esc(r.name || '—')}${r.variant ? ` · Shopify: ${esc(r.variant.productTitle)}${r.variant.variantTitle ? ` — ${esc(r.variant.variantTitle)}` : ''}` : ''}`, `<input data-lib="ed-title" value="${esc(r.display.title)}">`, 'title', r.edits.title !== undefined)}
      ${fld('Approved regular price', `Original: ${f(r.prices.smpCents)} · Shopify: ${f(r.prices.shopifyCents)}${r.approved ? ` · Approved: ${f(r.prices.approvedCents)}` : ''}`, `<input data-lib="ed-price" inputmode="decimal" placeholder="0.00" value="${esc(centsStr(r.prices.approvedCents))}">`, 'price', !!r.approved && r.approved.source === 'custom')}
      ${fld('Promotional price', `Original: ${f(r.prices.promoSourceCents)}${r.edits.promoCents !== undefined ? ` · Edited: ${f(r.edits.promoCents)}` : ''}`, `<input data-lib="ed-promo" inputmode="decimal" placeholder="0.00" value="${esc(centsStr(r.prices.promoCents))}">`, 'promoCents', r.edits.promoCents !== undefined)}
      ${fld('Image', r.edits.image ? 'Custom image address' : r.variant?.image ? 'Using the Shopify image' : 'No image', `<input data-lib="ed-image" placeholder="https://… (leave as is to keep)" value="${esc(r.edits.image || '')}">`, 'image', !!r.edits.image)}
      ${r.local ? `<label>SKU<small>Only products added by hand can change this</small><input data-lib="ed-sku" value="${esc(r.sku || '')}"></label>` : ''}
      <div class="sub" style="flex-basis:100%">These are working values for display. The imported file and the linked Shopify variant are not changed.</div>
      <button class="xb lib-primary" data-x="lib-ed-save" data-key="${esc(r.key)}">Save Changes</button><button class="xb" data-x="lib-ed-cancel">Cancel</button></div>`;
  }

  // One primary status per card. Everything else lives in Details (or is shown only when it needs attention).
  function primary(r) {
    if (r.identity.state === 'substitute-pending') return { label: 'Replacement approval required', kind: 'warn' };
    if (r.review.needsReview) return { label: 'Needs review', kind: 'warn' };
    if (r.identity.state === 'substitute-approved' && r.settled) return { label: 'Replacement approved', kind: 'ok' };
    if (r.settled && r.variant) return { label: 'Verified', kind: 'ok' };
    return { label: 'Not verified', kind: '' };
  }

  const kv = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  const codeCp = (what, val) => (val ? `<code>${esc(val)}</code>${copyBtn(what, val)}` : '—');

  // Details: each fact once. Where the imported, Shopify and approved values agree, the value is shown a single time
  // with a "matches" mark; only differences get separate lines. "Full source comparison" lays every source side by side.
  const sameTxt = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
  const vTitle = (v) => [v.productTitle, v.variantTitle].filter(Boolean).join(' — ');
  const okTag = (t) => `<span class="lib-ok">✓ ${t}</span>`;
  const dfTag = (t) => `<span class="lib-df">${t}</span>`;

  function cmpHtml(r) {
    const f = (c) => Lib.fmt(c, r.prices.currency);
    const v = r.variant;
    const imp = r.origin === 'smp';
    const nameDiff = imp && v && !(sameTxt(r.name, v.productTitle) || sameTxt(r.name, vTitle(v)));
    const skuDiff = imp && v && !Lib.skuEq(r.sku, v.sku);
    const sm = r.prices.smpCents;
    const ap = r.prices.approvedCents;
    const apTxt = ap != null ? `${f(ap)}${r.approved ? ` · ${esc(SRC[r.approved.source] || r.approved.source)}` : ''}` : r.approved?.stale ? 'Out of date' : r.identity.state === 'substitute-pending' ? 'Not approved (replacement pending)' : '—';
    const money = (c) => (c == null ? '—' : f(c));
    const txt = (x) => (x == null || x === '' ? '—' : esc(x));
    // [field, imported, shopify, current, shopifyDiffers, currentDiffers]
    const rows = [
      ['Name', txt(imp ? r.name : null), txt(v ? vTitle(v) : null), txt(r.display.title), nameDiff, false],
      ['SKU', txt(r.sku), txt(v?.sku), txt(v ? v.sku : r.sku), skuDiff, skuDiff],
      ['Regular price', money(sm), money(r.prices.shopifyCents), apTxt, imp && v && sm != null && r.prices.shopifyCents != null && sm !== r.prices.shopifyCents, ap != null && sm != null && ap !== sm],
      ['Promotional price', money(r.prices.promoSourceCents), '—', money(r.prices.promoCents), false, r.prices.promoCents !== r.prices.promoSourceCents],
      ...(r.prices.compareAtCents != null ? [['Compare-at price', '—', money(r.prices.compareAtCents), '—', false, false]] : []),
      ['Availability', '—', v ? (v.available ? 'Available' : 'Sold out') : '—', '—', false, false],
      ['Variant ID', '—', txt(v?.variantId), txt(v?.variantId), false, false],
      ['Product ID', '—', txt(v?.productId), txt(v?.productId), false, false],
    ];
    return `<table class="lib-cmpt"><thead><tr><th scope="col">Field</th><th scope="col">Imported SMP</th><th scope="col">Shopify</th><th scope="col">Approved / Current</th></tr></thead><tbody>${rows.map((x) => `<tr><th scope="row">${x[0]}</th><td>${x[1]}</td><td${x[4] ? ' data-diff="1"' : ''}>${x[2]}</td><td${x[5] ? ' data-diff="1"' : ''}>${x[3]}</td></tr>`).join('')}</tbody></table><div class="sub">Highlighted cells differ from the imported value. Source values are shown exactly as stored; nothing here changes them.</div>`;
  }

  function detailsHtml(r) {
    const f = (c) => Lib.fmt(c, r.prices.currency);
    const v = r.variant;
    const vs = r.verification.status;
    const diff = r.verification.diffCents;
    const sub = r.identity.state === 'substitute-pending';
    const imp = r.origin === 'smp';
    const srcLabel = imp ? 'Original imported' : r.local ? 'Added by hand' : 'Added from Shopify';
    const rows = [];
    if (v) {
      if (imp && !(sameTxt(r.name, v.productTitle) || sameTxt(r.name, vTitle(v)))) rows.push(kv('Imported name', esc(r.name || '—')), kv('Shopify product', `${esc(v.productTitle)}${dfTag('Different name')}`));
      else rows.push(kv('Product', `${esc(v.productTitle)}${imp ? okTag('Matches imported name') : ''}`));
      const vt = optLabel(v);
      if (vt && vt !== 'Default') rows.push(kv('Variant', esc(vt)));
      if (imp && !Lib.skuEq(r.sku, v.sku)) rows.push(kv('Imported SKU', codeCp('SKU', r.sku)), kv('Shopify SKU', `${codeCp('Shopify SKU', v.sku)}${dfTag('Different SKU')}`));
      else rows.push(kv('SKU', `${codeCp('SKU', v.sku)}${imp ? okTag('Matches imported SKU') : ''}`));
      rows.push(`<dt>Variant ID</dt><dd class="lib-vid">${codeCp('variant ID', v.variantId)}</dd>`,
        kv('Product ID', codeCp('product ID', v.productId)),
        kv('Handle / URL', `<a href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">${esc(v.handle)}</a>${copyBtn('handle', v.handle)}${v.url ? copyBtn('product URL', v.url) : ''}`));
    } else {
      rows.push(kv(imp ? 'Imported name' : 'Name', esc(r.name || '—')), kv(imp ? 'Imported SKU' : 'SKU', codeCp('SKU', r.sku)), kv('Shopify variant', esc(r.match?.message || 'Not linked yet')));
    }
    const sm = r.prices.smpCents;
    const sh = r.prices.shopifyCents;
    const ap = r.prices.approvedCents;
    const apNote = r.approved && ap != null ? ` · ${esc(SRC[r.approved.source] || r.approved.source)}${r.approved.acknowledgedRounding ? ' (1¢ acknowledged)' : ''}` : '';
    if (sm != null && sh != null && ap != null && sm === sh && sh === ap) rows.push(kv('Regular price', `<b>${f(ap)}</b>${okTag('Imported, Shopify and approved agree')}`));
    else {
      if (imp || sm != null) rows.push(kv('Imported price', f(sm)));
      if (v) rows.push(kv('Shopify price', `${f(sh)}${diff ? dfTag(`${diff > 0 ? '+' : '−'}${f(Math.abs(diff))} vs imported`) : ''}`));
      rows.push(kv('Approved price', r.approved && r.approved.stale ? 'Out of date' : ap != null ? `<b>${f(ap)}</b>${apNote}` : sub ? 'Not approved: waiting for the replacement to be approved' : 'Not approved yet'));
    }
    rows.push(kv('Promotional price', `${f(r.prices.promoCents)}${r.edits.promoCents !== undefined ? ` (edited; imported ${f(r.prices.promoSourceCents)})` : ''}`));
    if (r.prices.compareAtCents != null) rows.push(kv('Compare-at price', f(r.prices.compareAtCents)));
    if (v) rows.push(kv('Availability', v.available ? 'Available' : 'Sold out'));
    const method = r.match?.method === 'manual' ? 'Chosen by you' : r.match?.method === 'sku+price' ? 'SKU + price' : v ? 'Exact SKU' : '—';
    rows.push(kv('Price check', `${esc(Lib.STATUS_LABEL[vs] || vs)}${v && diff ? ` · Shopify ${diff > 0 ? '+' : '−'}${f(Math.abs(diff))}` : ''}`));
    if (v) rows.push(kv('Matched by', method));
    if (imp && r.identity.state.startsWith('substitute')) rows.push(kv('Replacement', r.identity.state === 'substitute-approved' ? 'Approved' : 'Not approved yet'));
    if (r.display.edited.length) rows.push(kv('Edited', esc(r.display.edited.map((x) => ({ title: 'title', promoCents: 'promo price', image: 'image' }[x])).join(', '))));
    rows.push(kv('Source', esc(srcLabel)));
    const notes = [...(r.match?.warnings || []).filter((w) => !(sub && /SKU differs/.test(w))), ...(r.conflicts || []), ...(!v && r.match?.message ? [r.match.message] : [])];
    const groups = r.placements.length ? `<div><h4>Source placements (${r.placements.length})</h4><ul class="lib-places">${r.placements.map((p) => `<li>${esc(groupLabel(p.group))} · position ${esc(p.position)}${p.originalCents != null ? ` · original ${f(p.originalCents)}` : ''}${p.saleCents != null ? ` · promo ${f(p.saleCents)}` : ''}</li>`).join('')}</ul><div class="sub">Where the source list placed this product. Informational: not a mapping to a web page.</div></div>` : '';
    const cmpOpen = L.cmpOpen.has(r.key);
    const kid = esc(r.key);
    const more = [];
    // Price approvals that aren't currently required still live here.
    if (!priceRequired(r)) {
      if (v && r.correction !== 'auto') {
        more.push(`<button class="xb" data-x="lib-use" data-src="shopify" data-key="${kid}" title="Approve the Shopify price (${f(sh)})">Use Shopify price</button>`);
        if (sm !== null) more.push(`<button class="xb" data-x="lib-use" data-src="smp" data-key="${kid}" title="Approve the imported price (${f(sm)})">Accept SMP price</button>`);
        more.push(`<button class="xb" data-x="lib-custom" data-key="${kid}">Custom price…</button>`);
      } else if (!v && !r.approved) {
        if (sm !== null) more.push(`<button class="xb" data-x="lib-use" data-src="smp" data-key="${kid}" title="Approve the list’s price (${f(sm)})">Accept SMP price</button>`);
        more.push(`<button class="xb" data-x="lib-custom" data-key="${kid}">Custom price…</button>`);
      }
    }
    if (r.identity.state === 'substitute-approved') more.push(`<button class="xb" data-x="lib-ident-revoke" data-key="${kid}">Revoke approval</button>`);
    if (r.approved && r.approved.source !== 'match') more.push(`<button class="xb" data-x="lib-undo" data-key="${kid}">Clear approval</button>`);
    if (v || L.store) more.push(`<button class="xb" data-x="lib-refresh" data-key="${kid}"${L.busy ? ' disabled' : ''}>${v ? 'Refresh' : 'Look up'}</button>`);
    if (v && imp) more.push(`<button class="xb" data-x="lib-pick" data-key="${kid}" title="The product itself is wrong">Find different product…</button>`);
    if (r.origin === 'manual') more.push(`<button class="xb danger" data-x="lib-remove" data-key="${kid}">Remove</button>`);
    return `<div class="lib-dt" id="lib-dt-${kid}"><dl class="lib-kv">${rows.join('')}</dl>
      ${notes.map((n) => `<div class="lib-note">${esc(n)}</div>`).join('')}
      ${groups}
      <div><button class="lib-tg lib-cmpbtn" data-x="lib-cmp" data-key="${kid}" aria-expanded="${cmpOpen}" aria-controls="lib-cmp-${kid}">${cmpOpen ? '▾' : '▸'} Full source comparison</button>${cmpOpen ? `<div class="lib-cmpbox" id="lib-cmp-${kid}">${cmpHtml(r)}</div>` : ''}</div>
      ${more.length ? `<div class="lib-dtl">${more.join('')}</div>` : ''}</div>`;
  }

  // A price decision is required (and so shown on the card, not hidden in Details) only while the variant is found but its price is unresolved.
  const priceRequired = (r) => !!r.variant && ['needs-review', 'stale'].includes(r.correction) && r.identity.state !== 'substitute-pending';

  function rowHtml(r, i) {
    const f = (c) => Lib.fmt(c, r.prices.currency);
    const v = r.variant;
    const vs = r.verification.status;
    const sub = r.identity.state === 'substitute-pending';
    const st = primary(r);
    const open = L.expanded.has(r.key);
    const wp = r.prices.approvedCents ?? r.prices.shopifyCents ?? r.prices.smpCents;
    const wpLabel = r.prices.approvedCents != null ? 'Approved price' : r.prices.shopifyCents != null ? 'Shopify price' : r.prices.smpCents != null ? 'Imported price' : 'No price';
    const reasons = sub ? [] : r.review.reasons;
    const kid = esc(r.key);
    // Required decisions are always on the card: Approve Replacement, or the price approvals while a price is unresolved.
    const req = [];
    if (sub) req.push(`<button class="xb lib-go" data-x="lib-ident" data-key="${kid}" title="Use this different Shopify variant for the product the list named">Approve Replacement</button>`);
    if (priceRequired(r)) {
      req.push(`<button class="xb lib-go" data-x="lib-use" data-src="shopify" data-key="${kid}" title="Approve the Shopify price (${f(r.prices.shopifyCents)})">Use Shopify price</button>`);
      if (r.prices.smpCents !== null) req.push(`<button class="xb lib-go" data-x="lib-use" data-src="smp" data-key="${kid}" title="Approve the imported price (${f(r.prices.smpCents)})">Accept SMP price</button>`);
      req.push(`<button class="xb" data-x="lib-custom" data-key="${kid}">Custom price…</button>`);
      if (vs === 'rounding' && !r.approved) req.push(`<button class="xb lib-go" data-x="lib-use" data-src="smp" data-key="${kid}" title="Keep the imported price and note the one-cent difference">Acknowledge 1¢</button>`);
    }
    const act = [`<button class="xb" data-x="lib-edit" data-key="${kid}">Edit Information</button>`];
    if (v && r.origin === 'smp') act.push(`<button class="xb" data-x="lib-variants" data-key="${kid}" title="Choose a different variant of this product">Change Variant</button>`);
    if (!v && L.store) act.push(`<button class="xb" data-x="lib-pick" data-key="${kid}">Find product…</button>`);
    act.push(`<button class="xb lib-det" data-x="lib-details" data-key="${kid}" aria-expanded="${open}" aria-controls="lib-dt-${kid}">Details ${open ? '▴' : '▾'}</button>`);
    const custom = L.customFor === r.key ? `<div class="lib-custom"><label>Custom price <input data-lib="custom" inputmode="decimal" placeholder="0.00" aria-label="Custom price"></label><button class="xb lib-go" data-x="lib-custom-set" data-key="${kid}">Approve Custom Price</button><button class="xb" data-x="lib-custom-cancel">Cancel</button></div>` : '';
    const edit = L.editFor === r.key ? editHtml(r) : '';
    const cands = !v && r.match?.candidates?.length ? `<div class="lib-cands"><span class="sub">${r.match.status === 'ambiguous' ? 'Which one?' : 'Possible matches (not exact SKU matches):'}</span>${r.match.candidates.map((c, ci) => `<div class="lib-cand">${thumb(c.image)}<div><b>${esc(c.productTitle)}</b>${c.variantTitle ? ` — ${esc(c.variantTitle)}` : ''} · SKU ${esc(c.sku || 'none')} · ${f(c.priceCents)}${c.available ? '' : ' · sold out'}<br><span class="sub">variant ${esc(c.variantId)}</span></div><button class="xb" data-x="lib-cand" data-key="${kid}" data-i="${ci}">Use this variant</button></div>`).join('')}</div>` : '';
    const opts = v ? optChips(v) : '';
    const cmp = sub
      ? `<div class="lib-cmp"><div class="lib-orig"><i>Original (imported)</i><span><b>${esc(r.name || '—')}</b> · SKU ${esc(r.sku || 'none')}</span></div><div class="lib-prop"><i>Proposed replacement (not approved yet)</i><span><b>${esc(v.productTitle)}${v.variantTitle ? ` — ${esc(v.variantTitle)}` : ''}</b> · SKU ${esc(v.sku || 'none')} · ${f(v.priceCents)}</span></div></div>
         <div class="lib-subst"><b>Replacement approval required.</b> The list names SKU ${esc(r.sku || 'none')}, but the selected variant is SKU ${esc(v.sku || 'none')}. A matching price doesn’t make it the same product. Approve it only if this is the product you want.</div>`
      : r.identity.state === 'substitute-approved' ? `<div class="lib-repok">Replacement approved: the list named SKU ${esc(r.sku || 'none')}; this card uses SKU ${esc(v.sku || 'none')}.</div>` : '';
    return `<div class="lib-row" data-v="${tone(r)}" data-key="${kid}" data-i="${i}"${sub ? ' data-pending="1"' : ''}${L.find?.key === r.key && L.find.mode !== 'variants' ? ' data-editing="1"' : ''}${L.recent === r.key ? ' data-recent="1"' : ''}>
      ${thumb(r.display.image)}
      <div class="lib-main">
        <div class="lib-top"><b class="lib-title">${esc(r.display.title)}</b><span class="lib-price">${esc(f(wp))}<i>${wpLabel}</i></span></div>
        ${opts ? `<div class="lib-line">${opts}</div>` : ''}
        <div class="lib-badges"><span class="lib-badge ${st.kind}">${st.label}</span>${r.promoWarnings.length ? '<span class="lib-badge warn">Promo price check</span>' : ''}</div>
        ${reasons.length ? `<div class="lib-need">${esc(reasons.slice(0, 2).join('; '))}</div>` : ''}
        ${cmp}
        ${r.promoWarnings.map((n) => `<div class="lib-promo">Promo price check: ${esc(n)}</div>`).join('')}
        ${req.length ? `<div class="lib-req">${req.join('')}</div>` : ''}
        ${custom}${edit}
        <div class="lib-actions">${act.join('')}</div>
        ${cands}
        ${open ? detailsHtml(r) : ''}
      </div></div>`;
  }

  function renderCfg() {
    const label = L.lib ? L.lib.name || (Lib.isPristine(L.lib) ? '' : Lib.listName(L.lib)) : '';
    // The list chooser: every saved list (oldest first, never reordered by use), plus the unsaved one on screen.
    const sel = q('[data-lib="listsel"]');
    const items = [...(L.lists || [])].sort((a, b) => (a.createdAt || a.updatedAt || 0) - (b.createdAt || b.updatedAt || 0) || (a.campaign < b.campaign ? -1 : a.campaign > b.campaign ? 1 : 0));
    const opts = items.map((it) => ({ store: it.store, campaign: it.campaign, name: it.name || 'Untitled list' }));
    if (L.lib && !opts.some((o) => o.store === L.lib.store && o.campaign === L.lib.campaign)) opts.push({ store: L.lib.store, campaign: L.lib.campaign, name: label || 'New list (not saved yet)' });
    L.listOpts = opts;
    sel.innerHTML = opts.map((o, i) => `<option value="${i}">${esc(o.name)}</option>`).join('');
    const at = L.lib ? opts.findIndex((o) => o.store === L.lib.store && o.campaign === L.lib.campaign) : -1;
    sel.value = String(at < 0 ? 0 : at);
    // Store: a plain selector when stores have been used before, otherwise just the address box. Always optional.
    const ss = q('[data-lib="storesel"]');
    const inp = q('[data-lib="store"]');
    const hasStores = L.stores.length > 0;
    ss.hidden = !hasStores;
    ss.innerHTML = `<option value="">No store</option>${L.stores.map((s) => `<option value="${esc(s)}">${esc(host(s))}</option>`).join('')}${L.store && !L.stores.includes(L.store) ? `<option value="${esc(L.store)}">${esc(host(L.store))}</option>` : ''}<option value="${OTHER}">Another store address…</option>`;
    ss.value = L.showStoreInput ? OTHER : L.store || '';
    inp.hidden = hasStores && !L.showStoreInput;
    if (L.root.activeElement !== inp) inp.value = L.store;
  }

  function renderChoice() {
    const c = q('.lib-choice');
    c.hidden = !L.pending;
    if (!L.pending) return;
    q('.lib-choice-t').textContent = `Import ${L.pending.name} into “${Lib.listName(L.lib)}”?`;
    q('[data-x="lib-choice-go"]').textContent = L.confirmReplace ? 'Click again to replace the imported content' : 'Import';
  }

  function render() {
    if (!L.root) return;
    L.rows = L.lib ? Lib.buildRows(L.lib) : [];
    const rows = L.rows;
    const s = Lib.summarize(rows);
    renderCfg();
    renderChoice();
    if (L.mgr) renderMgr();
    // Empty: one clear call to action. Populated: the Product Library itself.
    const empty = rows.length === 0;
    q('.lib-start').hidden = !empty || !!L.pending;
    q('.lib-body').hidden = empty;
    q('.lib-assign-row').hidden = empty || !L.lib;
    const vmode = L.find?.mode === 'variants';
    q('.lib-sheet').classList.toggle('lib-vmode', vmode);
    q('.lib-sheet').classList.toggle('lib-full', !empty || vmode || !!L.mgr);
    q('.lib-head').textContent = 'Product Library';
    q('.lib-h').hidden = true; // the title above already says Product Library; the list and store are in the toolbar below
    q('.lib-sum').textContent = rows.length
      ? (s.unique ? `${plural(s.unique, 'unique product')} · ${plural(s.placements, 'source placement')}${s.manual ? ` · ${s.manual} added manually` : ''}` : `${plural(s.manual, 'product')} added manually`)
      : '';
    const chip = (f, label, n, kind) => `<button class="lib-chip ${kind}" data-x="lib-show" data-f="${f}" aria-pressed="${L.filter === f}" title="Show these in the list">${label} ${n}</button>`;
    q('.lib-chips').innerHTML = rows.length
      ? `${chip('all', 'All', rows.length, 'all')}${chip('review', 'Needs review', s.needsReview, s.needsReview ? 'bad' : '')}${s.promoWarnings || L.filter === 'promo' ? chip('promo', 'Promo price warnings', s.promoWarnings, s.promoWarnings ? 'warn' : '') : ''}`
        + (L.store && L.lib.work.settings.currencySource === 'assumed' ? ` <span>currency assumed ${L.lib.work.settings.currency}</span>` : '')
      : '';
    const fsel = q('[data-lib="filter"]'); if (fsel.value !== L.filter) fsel.value = L.filter;
    const list = q('.lib-list');
    const keep = list.scrollTop;
    const shown = rows.filter(visible);
    list.innerHTML = shown.length ? shown.map((r) => rowHtml(r, rows.indexOf(r))).join('') : `<div class="lib-empty">${rows.length ? (L.filter === 'all' && !L.search ? 'No products.' : 'Nothing matches this filter or search.') : ''}</div>`;
    list.scrollTop = keep;
    const w = q('.lib-warn');
    const srcs = L.lib?.smp.imports || [];
    w.innerHTML = (L.warnings.length ? `<details><summary>${plural(L.warnings.length, 'note')} from the import</summary><ul>${L.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : '')
      + (srcs.length ? `<div class="sub">Original imported file: <b>${srcs.map((x) => esc(x.source.fileName || x.source.kind)).join(', ')}</b> <button class="lib-tg" data-x="lib-prov" aria-expanded="${L.provOpen}">${L.provOpen ? 'Hide details' : 'Details'}</button></div>`
        + (L.provOpen ? `<dl class="lib-kv lib-prov">${srcs.map((x) => [kv('File', esc(x.source.fileName || x.source.kind)), kv('Type', esc(x.source.kind || '—')), kv('Size', x.source.size != null ? esc(fmtSize(x.source.size)) : '—'), kv('Imported', esc(fmtDate(x.importedAt))), kv('SHA-256', x.source.sha256 ? `<code>${esc(x.source.sha256)}</code>` : '—'), kv('Placements', esc(String(x.placements?.length ?? '—')))].join('')).join('<dt></dt><dd></dd>')}</dl><div class="sub">The original file is only read, never changed; your corrections and edits are saved separately.</div>` : '') : '');
    q('.lib-local').hidden = !L.localForm;
    for (const b of L.root.querySelectorAll('.lib-tools .xb, .lib-tools .ghost')) if (b.dataset.x) b.disabled = !!L.busy;
    q('[data-x="lib-check"]').disabled = !rows.length || !!L.busy;
    q('[data-x="lib-export"]').disabled = !rows.length;
    q('[data-x="lib-export-full"]').disabled = !rows.length;
    const d = q('[data-x="lib-delete"]');
    d.textContent = L.confirmDelete ? 'Click again to delete everything here' : 'Delete list';
    d.classList.toggle('lib-danger', !!L.confirmDelete);
    d.classList.toggle('solid', !!L.confirmDelete);
    q('[data-x="lib-choice-go"]').classList.toggle('lib-danger', !!L.confirmReplace);
    q('[data-x="lib-choice-go"]').classList.toggle('lib-primary', !L.confirmReplace);
    if (vmode) renderVariants();
  }

  function renderFind() {
    const f = L.find;
    const box = q('.lib-find-res');
    const skuBox = q('.lib-sku-res');
    if (!f) { box.innerHTML = ''; skuBox.innerHTML = ''; return; }
    const cur = L.lib?.work.settings.currency;
    const row = L.rows.find((r) => r.key === f.key);
    let list = f.results;
    const idxOf = (v) => f.results.indexOf(v);
    if (f.mode === 'variants' && f.filter.trim()) {
      const t = f.filter.trim().toLowerCase();
      list = f.results.filter((v) => [v.variantTitle, v.sku, v.variantId, ...v.options.map((o) => o.value)].some((x) => String(x || '').toLowerCase().includes(t)));
    }
    const head = f.mode === 'variants' && f.product ? `<div class="sub"><b>${esc(f.product.title)}</b> · ${plural(f.results.length, 'variant')}${list.length !== f.results.length ? ` · ${list.length} shown` : ''}</div>` : '';
    const back = f.mode === 'pick' && row?.variant ? '<div><button class="lib-tg" data-x="lib-back-variants">← Back to this product’s variants</button></div>' : '';
    const pv = f.pendingIdx === null || f.pendingIdx === undefined ? null : f.pendingSku ? f.skuResults?.list[f.pendingIdx] : f.results[f.pendingIdx];
    const confirm = pv ? `<div class="lib-confirm"><span>Change this product to <b>${esc([pv.productTitle, pv.variantTitle].filter(Boolean).join(' — '))}</b> · SKU <code>${esc(pv.sku || 'none')}</code> · variant ${esc(pv.variantId)}?${row && row.origin === 'smp' && !Lib.skuEq(row.sku, pv.sku) ? ` <b>Different SKU from the list’s (${esc(row.sku || 'none')}): it will need a separate replacement approval before it counts.</b>` : ''}</span><span class="lib-lm-act"><button class="xb lib-primary" data-x="lib-confirm">Confirm Variant Change</button><button class="xb" data-x="lib-confirm-cancel">Keep the current one</button></span></div>` : '';
    const isSel = (v, fromSku) => !!pv && v === pv && !!f.pendingSku === fromSku;
    box.innerHTML = confirm + back + (f.note ? `<div class="sub">${esc(f.note)}</div>` : '') + head + list.map((v) => {
      const current = f.mode !== 'add' && row?.variant?.variantId === v.variantId;
      const label = current ? '<button class="xb" disabled>Current</button>' : `<button class="xb" data-x="lib-found" data-i="${idxOf(v)}">${f.mode === 'add' ? 'Add' : 'Select'}</button>`;
      return variantCard(v, { cur, act: label, current, selected: isSel(v, false), cls: 'lib-vc', showProduct: f.mode !== 'variants' });
    }).join('') + (f.mode === 'variants' && f.product && !list.length ? '<div class="sub">No variant matches that filter.</div>' : '');
    const sr = f.skuResults;
    skuBox.innerHTML = sr ? (sr.note ? `<div class="sub">${esc(sr.note)}</div>` : '') + sr.list.map((v, i) => variantCard(v, { cur, act: `<button class="xb" data-x="lib-found-sku" data-i="${i}">Select</button>`, current: row?.variant?.variantId === v.variantId, selected: isSel(v, true), cls: 'lib-vc', showProduct: true })).join('') : '';
    const s = q('[data-x="lib-search"]'); if (s) s.disabled = f.busy;
  }

  // ---------------------------------------------------------------- selection mode
  //
  // The Product card section of a note opens this same window to choose a product (and its exact Shopify variant) for a
  // card. It only reads: lists, products and variants are looked at, nothing in the Library is written, and the Library's
  // own "active list" pointer is left alone. The result goes back to the note as a mapping built from the chosen record
  // (library.js buildSelectionMapping); the note is exactly as it was until the person saves it.
  const selStatus = (r) => (r.identity?.state === 'substitute-pending' ? ['warn', 'Replacement approval required'] : r.identity?.state === 'substitute-approved' ? ['ok', 'Replacement approved'] : Number.isInteger(r.prices?.approvedCents) ? ['ok', 'Approved'] : r.review?.needsReview ? ['warn', 'Needs review'] : r.variant ? ['', 'Not approved'] : ['', 'Not verified']);
  const selFields = { title: 'Title', image: 'Image URL', regularCents: 'Regular price', promoCents: 'Promotional price', url: 'Product link' };
  const selRow = (s) => s.rows.find((r) => r.key === s.key) || null;
  const selSameProduct = (s) => !!s.current && s.current.product?.key === s.key && s.current.list?.id === s.lib?.campaign && (s.current.list?.store || '') === (s.lib?.store || '');

  function selectProduct(opts = {}) {
    if (!L.root) return Promise.resolve(null);
    if (L.sel) closeSel(null);
    return new Promise((resolve) => {
      const s = { resolve, defer: !!opts.defer, current: opts.current || null, card: opts.card || null, mode: opts.mode || 'product', step: 'products', direct: false, lists: [], listKey: '', lib: null, rows: [], q: '', key: null, variants: null, vsel: null, vmsg: '', vbusy: false, res: {}, busy: true, msg: '' };
      L.sel = s;
      L.open = true;
      q('[data-m="library"]').hidden = false;
      q('.lib-sheet').classList.add('lib-smode', 'lib-full');
      if (L.map) q('.lib-head').textContent = 'Product Library';
      selRender();
      q('.lib-sel-h')?.focus(); // keys (Esc) go to this window
      selLoad(s);
    });
  }
  function closeSel(result) {
    const s = L.sel;
    if (!s) return;
    L.sel = null;
    // Opened from the Product Mapping window: go back to it instead of closing everything.
    if (L.map) { L.open = true; if (L.root) { q('.lib-sheet').classList.remove('lib-smode'); q('.lib-head').textContent = 'Card Mapping'; } s.resolve(result || null); return; }
    L.open = false;
    if (L.root) { q('.lib-sheet').classList.remove('lib-smode'); q('[data-m="library"]').hidden = true; }
    s.resolve(result || null);
  }
  async function selLoad(s) {
    try {
      await Lib.reconcileListNames(storage());
      const idx = await Lib.loadIndex(storage());
      s.lists = idx.libs.map((l) => ({ store: l.store, campaign: l.campaign, name: l.name || l.campaign }));
      const cur = s.current;
      const act = idx.active[pageOrigin()];
      const find = (st, id) => s.lists.find((l) => l.store === st && l.campaign === id);
      const want = (s.prefer && find(s.prefer.store, s.prefer.campaign)) || (cur?.list && find(cur.list.store || '', cur.list.id)) || (act && find(act.store, act.campaign)) || s.lists[0] || null;
      s.busy = false;
      if (!s.lists.length) s.msg = 'No Product Library list is saved yet. Close this, open More tools → Import Product List, upload your list, then choose again.';
      else await selSetList(s, want ? `${want.store}|${want.campaign}` : '');
      if (L.sel === s && (s.mode === 'variant' || s.mode === 'approve') && cur) {
        if (s.lib && cur.list?.id === s.lib.campaign && s.rows.some((r) => r.key === cur.product.key)) await selOpenProduct(s, cur.product.key, true);
        else s.msg = 'This card’s product list or product isn’t available any more. Choose the product again.';
      }
    } catch (e) { s.busy = false; s.msg = `Couldn’t read the Product Library: ${e.message}`; }
    if (L.sel === s) selRender();
  }
  async function selSetList(s, key) {
    const l = s.lists.find((x) => `${x.store}|${x.campaign}` === key);
    s.listKey = key; s.key = null; s.variants = null; s.vsel = null;
    if (!l) { s.lib = null; s.rows = []; return; }
    s.lib = await Lib.loadLibrary(storage(), l.store, l.campaign);
    s.rows = Lib.buildRows(s.lib);
    s.msg = s.rows.length ? '' : 'This list has no products yet.';
  }
  async function selOpenProduct(s, key, direct) {
    s.key = key; s.step = 'detail'; s.direct = !!direct; s.res = {}; s.variants = null; s.vmsg = '';
    const row = selRow(s);
    const same = selSameProduct(s);
    s.vsel = same && s.current.variant ? String(s.current.variant.variantId) : row?.variant ? String(row.variant.variantId) : null;
    const handle = row?.variant?.handle || (same && s.current.variant?.handle) || null;
    if (L.sel === s) selRender();
    if (!handle || !s.lib?.store) return;
    s.vbusy = true; selRender();
    try {
      const d = Lib.createDriver({ origin: s.lib.store, fetchJson, currency: s.lib.work?.settings?.currency || 'USD' });
      const p = await d.product(handle);
      if (L.sel !== s || s.key !== key) return;
      s.variants = p ? p.variants : [];
      if (!p) s.vmsg = 'The store no longer has this product.';
      else if (s.variants.length === 1) s.vsel = String(s.variants[0].variantId);
      else if (!s.variants.some((v) => String(v.variantId) === String(s.vsel))) s.vsel = row?.variant ? String(row.variant.variantId) : String(s.variants[0].variantId);
    } catch (e) { if (L.sel === s && s.key === key) s.vmsg = `Couldn’t read the store’s variants (${e.message}). The product can still be used as the list has it.`; }
    if (L.sel === s && s.key === key) { s.vbusy = false; selRender(); }
  }
  const selVariant = (s) => (s.variants && s.vsel ? s.variants.find((v) => String(v.variantId) === String(s.vsel)) || null : null);
  function selPreview(s) {
    if (!s.lib || !s.key) return null;
    try { return Lib.buildSelectionMapping(s.lib, s.key, { variant: selVariant(s), current: s.current, card: s.card }); } catch { return null; }
  }
  // Does choosing this change the card's SKU, or is the chosen variant one the list never approved?
  function selNeedsApproval(s, prev) {
    if (!prev) return false;
    if (Lib.replacementPending(prev)) return true;
    const cur = s.current ? s.current.variant?.sku || s.current.product?.sku : null;
    const now = prev.variant?.sku || prev.product?.sku || null;
    return !!cur && !!now && !Lib.skuEq(cur, now);
  }

  function selRender() {
    const s = L.sel;
    if (!s || !L.root) return;
    const h = q('.lib-sel-h');
    const sub = q('.lib-sel-sub');
    const body = q('.lib-sel > .lib-sel-body');
    const foot = q('.lib-sel > .lib-sel-foot');
    const back = q('[data-x="lib-sel-back"]');
    const forCard = s.card ? `${s.card.index && s.card.count ? `card ${s.card.index} of ${s.card.count}` : 'the card'}${s.card.section?.heading ? ` in “${s.card.section.heading}”` : ''}` : 'the card';
    back.hidden = !(s.step === 'detail' && !s.direct);
    if (s.busy) { h.textContent = 'Choose a product'; sub.textContent = ''; body.innerHTML = '<div class="sub">Loading the Product Library…</div>'; foot.innerHTML = '<button class="xb" data-x="lib-sel-cancel">Cancel</button>'; return; }
    if (s.step === 'products' || !s.key) {
      h.textContent = 'Choose a product'; sub.textContent = s.embedded ? `${s.ctx || ''} · Nothing in the Library changes.` : `For ${forCard}. Nothing in the Library changes.`;
      const opts = s.lists.map((l) => `<option value="${esc(`${l.store}|${l.campaign}`)}"${`${l.store}|${l.campaign}` === s.listKey ? ' selected' : ''}>${esc(l.name)}${l.store ? ` · ${esc(host(l.store))}` : ''}</option>`).join('');
      body.innerHTML = s.lists.length
        ? `${s.msg && !s.lib ? `<div class="lib-vv-notice">${esc(s.msg)}</div>` : ''}<div class="lib-sel-ctl"><label>Product Library list<select data-lib="sel-list" aria-label="Product Library list">${opts}</select></label><label>Search<input data-lib="sel-q" placeholder="Product name, SKU or flavor" aria-label="Search products" value="${esc(s.q)}" autocomplete="off"></label></div>${s.msg && s.lib ? `<div class="sub">${esc(s.msg)}</div>` : ''}<div class="lib-sel-results" role="list"></div>`
        : `<div class="lib-vv-notice">${esc(s.msg)}</div>`;
      selRenderResults();
      foot.innerHTML = s.embedded ? '' : '<button class="xb" data-x="lib-sel-cancel">Cancel</button>';
      return;
    }
    const row = selRow(s);
    const prev = selPreview(s);
    if (!row || !prev) { body.innerHTML = '<div class="lib-vv-notice">That product isn’t available. Go back and choose another.</div>'; foot.innerHTML = '<button class="xb" data-x="lib-sel-cancel">Cancel</button>'; return; }
    const keepFocus = L.root.activeElement?.dataset?.lib === 'sel-v' ? L.root.activeElement.value : null;
    h.textContent = s.mode === 'variant' ? 'Choose a variant' : s.mode === 'approve' ? 'Approve replacement' : 'Review the product';
    sub.textContent = s.embedded ? `${s.ctx || ''} · Nothing in the Library changes.` : `For ${forCard}. Nothing in the Library changes.`;
    const a = prev.approved;
    const cur = a.currency || undefined;
    const money = (c) => (Number.isInteger(c) ? Lib.fmt(c, cur) : null);
    const [tone, stText] = selStatus(row);
    const ms = Lib.mappingStatus(prev);
    const v = prev.variant;
    const listSku = prev.product.sku;
    let html = `<div class="lib-sel-prod">${thumb(a.image)}<div><b>${esc(a.title || prev.product.name || prev.product.key)}</b><div class="lib-badges"><span class="lib-badge ${esc(ms.identity === 'pending' ? 'warn' : tone)}">${esc(ms.identity === 'pending' ? 'Replacement approval required' : ms.identity === 'approved' ? 'Replacement approved' : stText)}</span>${selSameProduct(s) ? '<span class="lib-badge">Current product for this card</span>' : ''}</div><div class="sub">List: ${esc(s.lib.name || Lib.listName(s.lib))}${listSku ? ` · list SKU ${esc(listSku)}` : ''}</div></div></div>`;
    html += `<dl class="lib-kv">${[
      kv('Regular price', money(a.regularCents) ? `${esc(money(a.regularCents))} <span class="lib-ok">approved</span>` : '<span class="lib-df">not approved</span>'),
      kv('Promotional price', money(a.promoCents) ? esc(money(a.promoCents)) : 'none'),
      v && money(prev.reference?.shopifyCents) ? kv('Shopify price', esc(money(prev.reference.shopifyCents))) : '',
      v ? kv('Variant', esc((v.options || []).map((o) => `${o.name}: ${o.value}`).join(' · ') || v.variantTitle || 'Default')) : '',
      v ? kv('Variant SKU', v.sku ? `<code>${esc(v.sku)}</code>` : 'none') : '',
      v ? kv('Variant ID', `<code>${esc(v.variantId)}</code>`) : '',
      v && v.productId ? kv('Product ID', `<code>${esc(v.productId)}</code>`) : '',
    ].join('')}</dl>`;
    // Variants (Shopify lists only). One variant needs no choosing.
    if (!row.variant && !s.variants) html += '<div class="sub">No Shopify variant is linked to this product; its values come from the list. This works without a store.</div>';
    else if (s.vbusy) html += '<div class="sub">Loading the store’s variants…</div>';
    else if (s.variants && s.variants.length > 1) {
      html += `<h4 class="lib-sel-h4">Choose the exact variant</h4><div class="lib-vv-list" role="radiogroup" aria-label="Variants" style="min-height:0;overflow:visible">${s.variants.map((x) => {
        const id = String(x.variantId);
        const lbl = (x.options || []).map((o) => o.value).join(' / ') || x.variantTitle || 'Default';
        const isListed = row.variant && String(row.variant.variantId) === id;
        const isCur = selSameProduct(s) && s.current.variant && String(s.current.variant.variantId) === id;
        return `<label class="lib-vr" data-sel="${id === String(s.vsel) ? 1 : 0}"><input type="radio" name="selv" data-lib="sel-v" value="${esc(id)}"${id === String(s.vsel) ? ' checked' : ''}><span class="lib-vr-body"><span class="lib-vr-t"><b>${esc(lbl)}</b>${isCur ? ' <span class="lib-badge">Current</span>' : ''}${isListed && !isCur ? ' <span class="lib-badge">List’s variant</span>' : ''}</span><span>SKU ${esc(x.sku || 'none')} · ${esc(Lib.fmt(x.priceCents, x.currency || undefined))}${x.available ? '' : ' · sold out'}</span><span class="lib-vr-id">Variant ID ${esc(id)}</span></span></label>`;
      }).join('')}</div>`;
    } else if (s.variants && s.variants.length === 1) html += '<div class="lib-sel-one">Only one variant available</div>';
    if (s.vmsg) html += `<div class="sub">${esc(s.vmsg)}</div>`;
    // A different SKU than the list approved: say so once, and what it means.
    if (Lib.replacementPending(prev)) html += s.defer
      ? `<div class="lib-vv-notice">The list approved SKU ${esc(listSku || 'none')}, not SKU ${esc(v?.sku || 'none')}. You approve it for this card in Product Mapping, where it is saved. The list is not changed. This variant’s regular price isn’t approved, and no sale price is carried over.</div>`
      : `<div class="lib-vv-notice">The list approved SKU ${esc(listSku || 'none')}, not SKU ${esc(v?.sku || 'none')}. Approving applies to this card only; the list is not changed. This variant’s regular price isn’t approved, and no sale price is carried over.</div>`;
    // Page-specific values already set on the card must be resolved before a replacement is approved.
    const conflicts = s.defer ? [] : Lib.overrideConflicts(prev);
    if (conflicts.length) {
      const ev = Lib.effectiveValues(prev);
      const show = (k, val) => (k === 'regularCents' || k === 'promoCents' ? money(val) : val) || 'none';
      html += `<h4 class="lib-sel-h4">Your page-specific values</h4>${conflicts.map((k) => `<fieldset class="lib-sel-res"><legend>${esc(selFields[k] || k)}</legend><label><input type="radio" name="res-${k}" data-lib="sel-res" data-f="${k}" value="keep"${s.res[k] === 'keep' ? ' checked' : ''}><span>Keep mine: ${esc(show(k, ev[k]))}</span></label><label><input type="radio" name="res-${k}" data-lib="sel-res" data-f="${k}" value="default"${s.res[k] === 'default' ? ' checked' : ''}><span>Use the new default: ${esc(show(k, ev.base[k]))}</span></label></fieldset>`).join('')}`;
    }
    body.innerHTML = html;
    const open = conflicts.filter((k) => !s.res[k]);
    const needs = !s.defer && selNeedsApproval(s, prev);
    const same = selSameProduct(s) && s.current.variant && v && String(s.current.variant.variantId) === String(v.variantId) && !Lib.replacementPending(s.current) && s.mode === 'variant';
    const label = needs ? 'Approve Replacement' : s.mode === 'variant' ? 'Use this variant' : 'Use this product';
    const off = open.length > 0 || same;
    foot.innerHTML = `<button class="xb" data-x="lib-sel-cancel">Cancel</button><button class="xb ${needs ? 'lib-go' : 'lib-primary'}" data-x="lib-sel-use"${off ? ' disabled' : ''}>${label}</button><div class="lib-sel-why">${open.length ? 'Choose what to do with your page-specific values above.' : same ? 'That is already this card’s variant.' : ''}</div>`;
    if (s.embedded) {
      foot.innerHTML = `<div class="lib-stage"><div class="lib-stage-t">${esc((s.ctx || '').split(' · Nothing')[0] || 'Selected card')}</div><div class="sub">“Use this product” only stages it for that card. Nothing is saved until you choose Save Assignments below.</div><div class="lib-stage-a"><button class="xb" data-x="lib-sel-cancel">Back to products</button><button class="xb ${needs ? 'lib-go' : 'lib-primary'}" data-x="lib-sel-use"${off ? ' disabled' : ''}>Use this product</button></div></div>`;
    }
    if (keepFocus) q('.lib-sel > .lib-sel-body input[data-lib="sel-v"]:checked')?.focus();
  }
  function selRenderResults() {
    const s = L.sel;
    const box = q('.lib-sel-results');
    if (!s || !box) return;
    const rows = Lib.searchRows(s.rows, s.q, 40);
    if (!rows.length) { box.innerHTML = `<div class="sub">${s.rows.length ? 'No product matches that.' : ''}</div>`; return; }
    box.innerHTML = rows.map((r) => {
      const [tone, text] = selStatus(r);
      const p = r.prices || {};
      const c = p.approvedCents ?? p.smpCents ?? null;
      const isCur = selSameProduct({ ...s, key: r.key });
      const asg = s.embedded && s.asg ? s.asg.get(`${s.lib?.store || ''}|${s.lib?.campaign || ''}|${r.key}`) : null;
      const asgHtml = asg && asg.length ? `<span class="lib-asg" aria-label="Assigned to card${asg.length === 1 ? '' : 's'} ${asg.join(', ')}">${asg.map((n) => `<i>${n}</i>`).join('')}</span>` : '';
      return `<button class="lib-sel-row" role="listitem" data-x="lib-sel-pick" data-key="${esc(r.key)}"${isCur ? ' data-cur="1"' : ''}>${thumb(r.display?.image)}<span><b>${esc(r.display?.title || r.name || r.sku || r.key)}</b>${asgHtml}<span>${r.sku ? `SKU ${esc(r.sku)} · ` : ''}${Number.isInteger(c) ? esc(Lib.fmt(c, p.currency)) : 'no price'}${r.variant?.variantTitle ? ` · ${esc(r.variant.variantTitle)}` : ''}</span></span><span class="lib-badges" style="flex:none"><span class="lib-badge ${tone}">${esc(text)}</span></span></button>`;
    }).join('') + (s.rows.length > rows.length && !s.q ? `<div class="sub">Showing ${rows.length} of ${s.rows.length}. Type to narrow it down.</div>` : '');
  }
  function selUse() {
    const s = L.sel;
    if (!s) return;
    const prev = selPreview(s);
    if (!prev) return;
    try {
      const mapping = Lib.buildSelectionMapping(s.lib, s.key, { variant: selVariant(s), current: s.current, card: s.card, approve: !s.defer && Lib.replacementPending(prev), resolutions: s.res });
      if (s.embedded) { // Assign Products: stage it for the selected card and stay in the workspace
        s.step = 'products'; s.key = null; s.variants = null; s.vsel = null; s.res = {};
        bkStage(s.owner, mapping);
        return;
      }
      closeSel(mapping);
    } catch (e) { const w = q('.lib-sel > .lib-sel-foot .lib-sel-why'); if (w) w.textContent = e.message; }
  }
  function selClick(b) {
    const s = L.sel;
    if (!s) return;
    switch (b.dataset.x) {
      case 'lib-sel-pick': selOpenProduct(s, b.dataset.key, false).then(() => q('.lib-sel-h')?.focus()); break;
      case 'lib-sel-back': s.step = 'products'; s.key = null; selRender(); break;
      case 'lib-sel-cancel': if (s.embedded) { s.step = 'products'; s.key = null; selRender(); } else closeSel(null); break;
      case 'lib-sel-use': if (!b.disabled) selUse(); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- Product Mapping window
  //
  // A card's saved mapping in the same Product Library window: view the product and exact variant, change them with the
  // product picker (which only reads the Library), edit this card's page-specific values, review the required approval,
  // run the read-only Shopify check, and save the whole mapping with ONE primary action. Approval, the Shopify check and
  // saving are separate: a change is "Not saved yet" until the primary action has persisted it, and an approval only
  // exists in what was saved. The window never writes the Library; the caller persists (opts.save) and decides what
  // else the note keeps. Cancel (or an unsaved close the person confirms) throws the pending change away.
  const mapClone = (x) => JSON.parse(JSON.stringify(x));
  const mapSku = (m) => (m ? m.variant?.sku || m.product?.sku || null : null);
  const mapSame = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
  function mapInfo(s) {
    const d = s.draft;
    const dirty = !mapSame(d, s.saved);
    const pending = !!d && Lib.replacementPending(d);
    const productChanged = !!(s.saved && d && (s.saved.product?.key !== d.product?.key || (s.saved.list?.id || '') !== (d.list?.id || '') || String(s.saved.variant?.variantId || '') !== String(d.variant?.variantId || '')));
    // A different SKU needs the person's approval for this card. When a SKU is missing on either side the two can't be
    // shown to be the same, so a different product still asks.
    const sa = s.saved && mapSku(s.saved);
    const sb = d && mapSku(d);
    const skuChanged = !!(s.saved && d && (sa && sb ? !Lib.skuEq(sa, sb) : s.saved.product?.key !== d.product?.key));
    const needsApproval = pending || skuChanged;
    const cta = !d ? 'Map & Save' : needsApproval ? 'Approve & Save Replacement' : productChanged ? 'Replace & Save' : s.saved ? 'Save Mapping' : 'Map & Save';
    const conflicts = pending ? Lib.overrideConflicts(d) : [];
    const open = conflicts.filter((k) => !s.res[k]);
    const can = !!d && !s.saving && (dirty || pending) && !open.length && !Object.keys(s.ferr).length;
    return { d, dirty, pending, needsApproval, productChanged, cta, conflicts, open, can };
  }
  function mapNotify(s) { try { s.opts.onPending?.(!mapSame(s.draft, s.saved) ? s.draft : null, s.saved); } catch { /* the caller's marker only */ } }

  function openMapping(opts = {}) {
    if (!L.root) return Promise.resolve({ action: 'cancel', saved: opts.saved || null });
    if (L.sel) closeSel(null);
    if (L.map) closeMap({ action: 'cancel' });
    return new Promise((resolve) => {
      const saved = opts.saved && Lib.isMapping(opts.saved) ? mapClone(opts.saved) : null;
      const start = opts.draft && Lib.isMapping(opts.draft) ? mapClone(opts.draft) : null;
      const s = { resolve, opts, saved, draft: start || (saved ? mapClone(saved) : null), card: opts.card || null, res: {}, ferr: {}, err: '', saving: false, shop: null, shopBusy: false, adoptBusy: false };
      L.map = s;
      if (L.bulk) { q('.lib-sheet').classList.remove('lib-amode'); asApply(L.bulk); }
      fieldRefresh(s);
      L.open = true;
      q('[data-m="library"]').hidden = false;
      q('.lib-sheet').classList.add('lib-pmode', 'lib-full');
      q('.lib-head').textContent = 'Card Mapping';
      q('.lib-sheet').setAttribute('aria-label', 'Card Mapping');
      mapRender();
      q('.lib-map-h')?.focus();
      mapNotify(s);
      if (opts.autoPick && !start) mapPick(opts.autoPick); // first mapping: go straight to choosing a product
    });
  }
  function closeMap(result) {
    const s = L.map;
    if (!s) return;
    if (L.sel) { const r = L.sel.resolve; L.sel = null; r(null); }
    L.map = null;
    if (L.bulk) { // opened from Assign Products: go back to it, in the same place, with the picker as it was
      try { s.opts.onPending?.(null, s.saved); } catch { /* ignore */ }
      const b = L.bulk;
      if (b.stash) { L.sel = b.stash; b.stash = null; }
      s.resolve({ action: 'cancel', saved: s.saved, ...(result || {}) });
      bkResume(b);
      return;
    }
    L.open = false;
    if (L.root) { q('.lib-sheet').classList.remove('lib-pmode', 'lib-smode'); q('.lib-head').textContent = 'Product Library'; q('.lib-sheet').setAttribute('aria-label', 'Product Library'); q('[data-m="library"]').hidden = true; }
    try { s.opts.onPending?.(null, s.saved); } catch { /* ignore */ }
    s.resolve({ action: 'cancel', saved: s.saved, ...(result || {}) });
  }
  function mapShopLine(s) {
    const r = s.shop;
    if (s.shopBusy) return '<div class="lib-map-shop" role="status" aria-live="polite"><span class="lib-badge">Checking Shopify…</span></div>';
    if (!r) return '';
    const cur = s.draft?.approved?.currency || undefined;
    const at = r.at ? new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    let head;
    let tone;
    if (r.state === 'ok') { tone = 'ok'; head = 'Shopify check complete: no differences'; }
    else if (r.state === 'changed') { tone = 'warn'; head = 'Shopify check complete: differences found'; }
    else if (r.state === 'missing') { tone = 'bad'; head = 'Shopify check complete: variant not found'; }
    else if (r.state === 'error') { tone = 'bad'; head = 'Shopify check failed'; }
    else { tone = ''; head = 'Shopify check skipped'; }
    const found = r.found ? `<div class="sub">Shopify has variant ID <code>${esc(r.found.variantId)}</code>${r.found.sku ? ` · SKU ${esc(r.found.sku)}` : ''}${Number.isInteger(r.found.priceCents) ? ` · ${esc(Lib.fmt(r.found.priceCents, cur))}` : ''} · ${r.found.available ? 'available' : 'sold out'}</div>` : '';
    const notes = (r.notes || []).length ? `<ul class="lib-map-notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
    return `<div class="lib-map-shop ${tone}" role="status" aria-live="polite"><b>${esc(head)}${at ? ` · ${esc(at)}` : ''}</b>${found}${notes}<div class="sub">Read-only: nothing was approved, changed or saved.</div></div>`;
  }
  function mapFieldHtml(s, ev, k) {
    const label = selFields[k];
    const val = k === 'regularCents' || k === 'promoCents' ? (Number.isInteger(ev[k]) ? (ev[k] / 100).toFixed(2) : '') : ev[k] || '';
    const ph = { title: 'Product title', image: 'https://…', regularCents: 'Not approved', promoCents: 'No sale price', url: 'https://…' }[k];
    const edited = ev.edited.includes(k);
    return `<div class="lib-map-f" data-f="${k}"><label><span>${esc(label)}${edited ? ' <i class="lib-map-ed">edited</i>' : ''}</span><span class="lib-map-in"><input data-lib="map-f" data-f="${k}" value="${esc(val)}" placeholder="${esc(ph)}" aria-label="${esc(label)}" autocomplete="off"${k === 'regularCents' || k === 'promoCents' ? ' inputmode="decimal"' : ''}>${edited ? `<button class="xb" data-x="lib-map-reset" data-f="${k}" title="Back to the default">Reset</button>` : ''}</span></label>${s.ferr[k] ? `<div class="lib-map-ferr" role="alert">${esc(s.ferr[k])}</div>` : ''}</div>`;
  }

  // ---- M4: the card's page elements, inside the same window
  // One row per field. A saved assignment (confirmed or "not on this card") lives in the draft and is saved with the mapping;
  // a suggestion lives only in the window until the person accepts it. Showing a suggestion never makes the mapping
  // "changed", so opening a window and closing it again never asks to save. Everything here is about WHICH element; the
  // values themselves stay the approved values and the page-specific values above.
  const fileOf = (u) => { try { return decodeURIComponent(new URL(u, 'http://x').pathname.split('/').pop() || u); } catch { return String(u); } };
  function elVal(k, v, cur) {
    if (!v) return '';
    if (k === 'sale' || k === 'regular') return v.placeholder ? `placeholder ${v.text}` : Number.isInteger(v.cents) ? Lib.fmt(v.cents, cur) : v.text || '';
    if (k === 'image') return v.src ? fileOf(v.src) : v.text ? `placeholder ${v.text}` : 'an image';
    if (k === 'link') return v.placeholder ? `placeholder address “${v.href || ''}”` : v.href || v.text || '';
    return v.text || '';
  }
  const sameText = (a, b) => String(a || '').replace(/\s+/g, ' ').trim().toLowerCase() === String(b || '').replace(/\s+/g, ' ').trim().toLowerCase();
  // What the page shows against what is approved, as plain text. null when there is nothing to compare.
  function elCompare(k, v, ev, cur) {
    if (!v) return null;
    if (k === 'title' && ev.title) return sameText(v.text, ev.title) ? null : `Page says “${v.text}”; approved: “${ev.title}”.`;
    if ((k === 'sale' || k === 'regular') && !v.placeholder) {
      const ap = k === 'sale' ? ev.promoCents : ev.regularCents;
      if (!Number.isInteger(v.cents)) return null;
      if (!Number.isInteger(ap)) return `Page shows ${Lib.fmt(v.cents, cur)}; no approved ${k === 'sale' ? 'sale' : 'regular'} price.`;
      return v.cents === ap ? null : `Page shows ${Lib.fmt(v.cents, cur)}; approved: ${Lib.fmt(ap, cur)}.`;
    }
    if (k === 'link' && v.href && !v.placeholder && ev.url) return String(v.href).replace(/\/$/, '') === String(ev.url).replace(/\/$/, '') ? null : `Page links to ${v.href}; approved: ${ev.url}.`;
    return null;
  }
  function fieldRefresh(s) {
    const f = s.opts.fields;
    if (!f || !s.draft) { s.scan = null; s.fres = null; return; }
    try { s.scan = f.scan(s.draft); s.fres = f.resolve(s.draft); } catch { s.scan = { ok: false, reason: 'The page elements could not be read.', items: {} }; s.fres = { ok: false, items: {} }; }
  }
  function elRow(s, k) {
    const items = Lib.fieldItems(s.draft);
    const a = items[k];
    const sc = s.scan?.items?.[k];
    const rs = s.fres?.items?.[k];
    const r = { k, label: Lib.FIELD_LABELS[k], a, sc, rs, tone: '', badge: '', v: null, why: '', cands: sc?.candidates || [], use: null, can: { accept: false, show: false, clear: true, undo: false } };
    if (a && a.state === 'unmapped') { r.badge = 'Not on this card'; r.can = { accept: false, show: false, clear: false, undo: true }; r.cands = []; return r; }
    if (a) {
      r.v = rs?.value || a.detected || null;
      if (rs && rs.state === 'ok') { r.tone = 'ok'; r.badge = 'Confirmed'; r.can.show = true; r.where = a.ref?.sel || a.ref?.path; }
      else {
        r.tone = 'warn'; r.badge = 'Needs review';
        r.why = rs ? (rs.reasons || []).join('; ') : (s.scan && !s.scan.ok ? s.scan.reason : 'it could not be checked on the page');
        r.cands = rs?.candidates?.length ? rs.candidates : r.cands;
        if (rs && rs.state === 'moved' && rs.candidates.length === 1) r.use = rs.candidates[0];
        r.can.show = !!(rs && rs.candidates.length);
        r.where = a.ref?.sel || a.ref?.path;
      }
      return r;
    }
    if (!sc) { r.badge = s.scan && !s.scan.ok ? 'Card not found' : 'Not checked'; return r; }
    if (sc.status === 'suggested') { r.tone = sc.confidence === 'low' ? 'warn' : ''; r.badge = sc.confidence === 'low' ? 'Suggested · check it' : 'Suggested'; r.v = sc.best.value; r.where = sc.best.where; r.why = sc.best.reasons.join('; '); r.can.accept = true; r.can.show = true; }
    else if (sc.status === 'ambiguous') { r.tone = 'warn'; r.badge = 'Several matches'; r.why = 'More than one element is about equally likely. Nothing was chosen for you.'; r.can.show = sc.candidates.length > 0; }
    else { r.badge = 'Not found'; r.why = 'Nothing in the card looks like this. Pick it on the page, or say it isn’t on this card.'; r.can.clear = true; }
    return r;
  }
  // The other elements this field could be, never the one already shown or chosen. A list is only offered when it has something in it.
  function elAlts(s, r) {
    const now = r.a ? s.fres?.items?.[r.k]?.ek : r.sc?.best?.ek;
    const seen = new Set();
    return (r.cands || []).filter((c) => { const key = c.ek || c.id; if ((now && c.ek === now) || seen.has(key)) return false; seen.add(key); return true; });
  }
  function elAltList(s, r, alts, cur) {
    const k = r.k;
    return `<div class="lib-alts" role="group" aria-label="Other candidates for ${esc(r.label)}">${alts.map((c) => {
      const v = elVal(k, c.value, cur);
      const tagLine = `${c.tag ? `<${c.tag}>` : ''} ${c.where || ''}`.trim();
      return `<div class="lib-alt"><div class="lib-alt-t"><b>${esc(clipTxt(v || 'no text', 60))}</b>${c.visible === false ? ' <span class="lib-badge">hidden</span>' : ''}</div><div class="sub"><code>${esc(clipTxt(tagLine, 60))}</code>${c.reasons?.length ? ` · ${esc(clipTxt(c.reasons[0], 60))}` : ''}</div><div class="lib-el-a"><button class="xb" data-x="lib-el-show" data-k="${k}" data-id="${esc(c.id)}" aria-label="Show this candidate for ${esc(r.label)} on the page">Show</button><button class="xb lib-primary" data-x="lib-el-use" data-k="${k}" data-id="${esc(c.id)}" aria-label="Use this element for ${esc(r.label)}">Use this one</button></div></div>`;
    }).join('')}</div>`;
  }
  function mapFieldsHtml(s, ev, cur) {
    const f = s.opts.fields;
    if (!f) return '';
    const rows = Lib.FIELD_KEYS.map((k) => elRow(s, k));
    const nAcc = rows.filter((r) => r.can.accept).length;
    let h = '<h4 class="lib-sel-h4">Page elements in this card</h4>';
    h += '<div class="sub">Which element on the card holds each part. This changes nothing on the page.</div>';
    // Accepting only stages the suggestions in this window. Blue (not green): nothing is approved or saved yet.
    if (nAcc) h += `<div class="lib-acc"><button class="xb lib-primary lib-acc-btn" data-x="lib-el-accept-all">Accept ${nAcc} suggestion${nAcc === 1 ? '' : 's'}</button><span class="sub">Stages ${nAcc === 1 ? 'it' : 'them'} here. Nothing is saved until you choose Save Mapping.</span></div>`;
    if (s.scan && !s.scan.ok) h += `<div class="lib-vv-notice">${esc(s.scan.reason)}</div>`;
    else {
      // Three different situations, each worded for what it is. "Changed" is only said of something that WAS saved.
      const stale = rows.filter((r) => r.a?.state === 'confirmed' && r.rs && r.rs.state !== 'ok');
      const unsure = rows.filter((r) => !r.a && r.sc && (r.sc.status === 'ambiguous' || r.sc.status === 'none'));
      if (stale.length) h += `<div class="lib-vv-notice"><b>The page changed since ${stale.length === 1 ? 'one element was' : `${stale.length} elements were`} saved:</b> ${esc(stale.map((r) => r.label).join(', '))} ${stale.length === 1 ? 'needs' : 'need'} review. <button class="xb" data-x="lib-el-rescan">Check again</button></div>`;
      if (unsure.length) h += `<div class="sub lib-el-unsure">${unsure.length === 1 ? 'One part' : `${unsure.length} parts`} couldn’t be matched with confidence (${esc(unsure.map((r) => r.label).join(', '))}). Use Pick on page, or mark ${unsure.length === 1 ? 'it' : 'them'} as not on this card.</div>`;
    }
    h += '<div class="lib-map-els">';
    for (const r of rows) {
      const k = r.k;
      const val = r.a && r.a.state === 'unmapped' ? '' : elVal(k, r.v, cur);
      const cmp = r.a?.state === 'confirmed' && r.rs?.state === 'ok' || (!r.a && r.sc?.status === 'suggested') ? elCompare(k, r.v, ev, cur) : null;
      const alts = elAlts(s, r);
      const cta = k === 'cta' && (r.v || r.a?.state === 'confirmed') ? '<div class="sub">Mapped for later: nothing here wires Add to Cart or changes checkout.</div>' : '';
      h += `<div class="lib-el" data-k="${k}"><div class="lib-el-t"><b>${esc(r.label)}</b><span class="lib-badge ${r.tone}">${esc(r.badge)}</span></div>`;
      if (val || r.where) h += `<div class="lib-el-v">${val ? `<span>${esc(clipTxt(val, 70))}</span>` : ''}${r.where ? ` <code>${esc(clipTxt(r.where, 60))}</code>` : ''}</div>`;
      if (r.why) h += `<div class="sub">${esc(r.why)}</div>`;
      if (cmp) h += `<div class="sub lib-el-diff">${esc(cmp)}</div>`;
      h += cta;
      h += '<div class="lib-el-a">';
      if (r.can.accept) h += `<button class="xb lib-primary" data-x="lib-el-accept" data-k="${k}" aria-label="Accept the suggested ${esc(r.label)}">Accept</button>`;
      if (r.use) h += `<button class="xb lib-primary" data-x="lib-el-use" data-k="${k}" data-id="${esc(r.use.id)}" aria-label="Use the look-alike for ${esc(r.label)}">Use this one</button>`;
      if (r.can.show) h += `<button class="xb" data-x="lib-el-show" data-k="${k}" aria-label="Show ${esc(r.label)} on the page">Show</button>`;
      if (!r.can.undo) h += alts.length ? `<button class="xb" data-x="lib-el-choose" data-k="${k}" aria-expanded="${s.choose === k}" aria-label="Choose another element for ${esc(r.label)} (${alts.length} found)">Choose another… (${alts.length})</button>` : `<span class="sub lib-el-noalt" data-k="${k}">No other candidates in this card. Use Pick on page.</span>`;
      h += `<button class="xb" data-x="lib-el-pick" data-k="${k}" aria-label="Pick the ${esc(r.label)} on the page">Pick on page</button>`;
      if (r.can.clear) h += `<button class="xb" data-x="lib-el-clear" data-k="${k}" aria-label="${esc(r.label)} is not on this card">${r.a || r.can.accept ? 'Clear' : 'Not on this card'}</button>`;
      if (r.can.undo) h += `<button class="xb" data-x="lib-el-undo" data-k="${k}" aria-label="Undo: look for ${esc(r.label)} again">Undo</button>`;
      h += '</div>';
      if (s.choose === k && alts.length) h += elAltList(s, r, alts, cur);
      h += '</div>';
    }
    h += '</div>';
    // The discount the approved prices give, and whether the page's own badge agrees.
    const bRes = s.fres?.items?.badge;
    const seen = (bRes && bRes.state === 'ok' ? bRes.value : null) || (!Lib.fieldItems(s.draft).badge ? s.scan?.items?.badge?.best?.value : null) || null;
    const di = Lib.discountInfo(s.draft, seen?.badge || null);
    const ovr = ev.edited.some((x) => x === 'regularCents' || x === 'promoCents');
    h += `<div class="lib-disc${di.discrepancy ? ' bad' : ''}" role="status"><b>Discount</b> ${di.percent !== null ? `${di.percent}% off <span class="sub">(approved regular ${esc(Lib.fmt(di.regularCents, cur))}, sale ${esc(Lib.fmt(di.saleCents, cur))}${ovr ? '; includes this page’s price override' : ''})</span>` : `<span class="sub">not calculated: ${esc(di.why)}</span>`}${di.discrepancy ? `<div class="lib-map-ferr">Mismatch: ${esc(di.discrepancy)}. Correct the badge text on the page, or the approved price above if it is wrong.</div>` : di.badgeNote ? `<div class="sub">${esc(di.badgeNote)}.</div>` : seen?.badge && di.percent !== null ? '<div class="sub">The page badge agrees.</div>' : ''}</div>`;
    return h;
  }
  const clipTxt = (t, n) => { t = String(t ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

  function fieldAssign(s, k, id, source) {
    const f = s.opts.fields;
    const t = f && f.take(id);
    if (!t) { s.err = 'That element is no longer on the page. Use Check again, or pick it.'; mapRender(); return; }
    const cand = [...(s.scan?.items?.[k]?.candidates || []), ...(s.fres?.items?.[k]?.candidates || [])].find((c) => c.id === id);
    try { s.draft = Lib.setFieldAssignment(s.draft, k, { state: 'confirmed', source, how: cand?.how || null, ref: t.ref, detected: t.detected }); } catch (e) { s.err = e.message; mapRender(); return; }
    s.err = ''; s.choose = null;
    fieldRefresh(s); mapRender(); mapNotify(s);
    q(`.lib-el[data-k="${k}"] button`)?.focus();
  }
  // Show on the page: the window steps aside (like Pick on page) so the element is clearly visible, and a small bar offers
  // the way back. Nothing is chosen or changed, and the page's links and buttons are not pressed.
  async function fieldShow(s, k, id) {
    const f = s.opts.fields;
    if (!f || s.picking || s.saving) return;
    const r = elRow(s, k);
    const target = id || (r.a ? (s.fres?.items?.[k]?.id || r.cands?.[0]?.id) : (s.scan?.items?.[k]?.best?.id || r.cands?.[0]?.id));
    const label = r.label.toLowerCase();
    if (!f.peek) { if (target) f.flash(target); else if (r.a?.ref) f.flashRef(k, r.a.ref); return; }
    if (!target && !r.a?.ref) return;
    s.picking = true; L.open = false; q('[data-m="library"]').hidden = true;
    try { if (target) await f.peek(target, label); else await f.peekRef(k, r.a.ref, label); } catch { /* back to the window */ }
    if (L.map !== s) return;
    s.picking = false; L.open = true; q('[data-m="library"]').hidden = false;
    mapRender();
    (q(`.lib-el[data-k="${k}"] [data-x="lib-el-show"]`) || q('.lib-map-h'))?.focus();
  }
  async function fieldPick(s, k) {
    const f = s.opts.fields;
    if (!f || s.picking || s.saving) return;
    s.picking = true; L.open = false; q('[data-m="library"]').hidden = true;
    let r = null;
    try { r = await f.pick(k); } catch { r = null; }
    if (L.map !== s) return;
    s.picking = false; L.open = true; q('[data-m="library"]').hidden = false;
    if (r && r.ref) {
      try { s.draft = Lib.setFieldAssignment(s.draft, k, { state: 'confirmed', source: 'picked', how: 'picked', ref: r.ref, detected: r.detected }); s.err = ''; } catch (e) { s.err = e.message; }
      fieldRefresh(s); mapNotify(s);
    }
    mapRender();
    q(`.lib-el[data-k="${k}"] button`)?.focus();
  }
  function fieldClick(s, b) {
    const k = b.dataset.k;
    const f = s.opts.fields;
    switch (b.dataset.x) {
      case 'lib-el-accept': { const id = s.scan?.items?.[k]?.best?.id; if (id) fieldAssign(s, k, id, 'suggested'); break; }
      case 'lib-el-use': fieldAssign(s, k, b.dataset.id, 'chosen'); break;
      case 'lib-el-accept-all': {
        s.choose = null;
        let n = s.draft;
        for (const key of Lib.FIELD_KEYS) {
          if (Lib.fieldItems(n)[key]) continue;
          const sc = s.scan?.items?.[key];
          const t = sc?.status === 'suggested' && f.take(sc.best.id);
          if (t) n = Lib.setFieldAssignment(n, key, { state: 'confirmed', source: 'suggested', how: sc.best.how, ref: t.ref, detected: t.detected });
        }
        s.draft = n; s.err = ''; fieldRefresh(s); mapRender(); mapNotify(s);
        break;
      }
      case 'lib-el-show': fieldShow(s, k, b.dataset.id || null); break;
      case 'lib-el-choose': s.choose = s.choose === k ? null : k; mapRender(); q(`.lib-el[data-k="${k}"] [data-x="lib-el-choose"]`)?.focus(); break;
      case 'lib-el-pick': fieldPick(s, k); break;
      case 'lib-el-rescan': fieldRefresh(s); mapRender(); break;
      case 'lib-el-clear': s.draft = Lib.setFieldAssignment(s.draft, k, { state: 'unmapped' }); fieldRefresh(s); mapRender(); mapNotify(s); q(`.lib-el[data-k="${k}"] button`)?.focus(); break;
      case 'lib-el-undo': s.draft = Lib.setFieldAssignment(s.draft, k, null); fieldRefresh(s); mapRender(); mapNotify(s); q(`.lib-el[data-k="${k}"] button`)?.focus(); break;
      default: break;
    }
  }

  function mapRender(only) {
    const s = L.map;
    if (!s || !L.root) return;
    const body = q('.lib-map-body');
    const foot = q('.lib-map-foot');
    const sub = q('.lib-map-sub');
    const card = s.card;
    q('.lib-map-h').textContent = card ? `${card.index && card.count ? `Card ${card.index} of ${card.count}` : 'This card'}${card.section?.heading ? ` in ${card.section.heading}` : ''}` : 'This card';
    sub.textContent = 'The Product Library is not changed.';
    const info = mapInfo(s);
    const d = s.draft;
    // The footer first: it is the same in every state.
    foot.innerHTML = `<button class="xb" data-x="lib-map-cancel">Cancel</button><button class="xb ${info.needsApproval && d ? 'lib-go' : 'lib-primary'}" data-x="lib-map-save"${info.can ? '' : ' disabled'}>${s.saving ? 'Saving…' : esc(info.cta)}</button><div class="lib-sel-why" role="status">${s.saving ? 'Saving the mapping…' : !d ? 'Choose a product first.' : info.open.length ? 'Choose what to do with your page-specific values above.' : Object.keys(s.ferr).length ? 'Fix the highlighted value first.' : !info.can && !info.dirty ? 'Nothing to save yet. Change the product, variant or a value.' : ''}</div>`;
    if (only === 'foot') return;
    const err = s.err ? `<div class="lib-vv-notice bad" role="alert"><b>Not saved.</b> ${esc(s.err)} The saved mapping is unchanged.</div>` : '';
    if (!d) {
      body.innerHTML = `${err}<div class="lib-map-empty"><b>No product is mapped to this card yet.</b><div class="sub">Pick one from a saved Product Library list. Nothing is saved until you choose Map &amp; Save.</div><button class="xb lib-primary" data-x="lib-map-product">Choose Product</button></div>`;
      return;
    }
    const ev = Lib.effectiveValues(d);
    const ms = Lib.mappingStatus(d);
    const v = d.variant;
    const cur = d.approved?.currency || undefined;
    const money = (c) => (Number.isInteger(c) ? Lib.fmt(c, cur) : null);
    const opt = v ? (v.options || []).map((o) => `${o.name}: ${o.value}`).join(' · ') || v.variantTitle || 'Default' : '';
    const shop = !!(v && d.list?.store);
    // Three separate facts: approval, the Shopify check (only what really ran) and whether it is saved.
    const approval = info.pending ? ['warn', ms.approval.label] : info.needsApproval ? ['warn', 'Different SKU: approval required'] : [ms.approval.tone, ms.approval.label];
    const sc = s.shopBusy ? ['', 'Checking…'] : s.shop ? (s.shop.state === 'ok' ? ['ok', 'Verified just now'] : s.shop.state === 'changed' ? ['warn', 'Differences found'] : s.shop.state === 'error' ? ['bad', 'Check failed'] : s.shop.state === 'missing' ? ['bad', 'Variant not found'] : ['', 'Skipped']) : ['', shop ? 'Not checked yet' : 'No Shopify store'];
    const sv = info.dirty ? ['warn', 'Not saved yet'] : ['ok', 'Saved'];
    let html = err;
    if (s.opts.openNote) html += '<div><button class="lib-tg" data-x="lib-map-note">Open Note</button></div>';
    html += `<div class="lib-sel-prod">${thumb(ev.image)}<div><b>${esc(ev.title || d.product.name || d.product.key)}</b><div class="sub">${esc(opt)}${d.product.sku ? `${opt ? ' · ' : ''}list SKU ${esc(d.product.sku)}` : ''}${v?.sku && !Lib.skuEq(v.sku, d.product.sku) ? ` · variant SKU ${esc(v.sku)}` : ''}</div><div class="sub">${money(ev.regularCents) ? `Regular ${esc(money(ev.regularCents))}` : 'Regular price not approved'}${money(ev.promoCents) ? ` · Sale ${esc(money(ev.promoCents))}` : ''}</div><div class="sub">${esc(d.list?.name || d.list?.id || '')}${d.list?.store ? ` · ${esc(host(d.list.store))}` : ''}</div>${v ? `<div class="sub">Variant ID <code>${esc(v.variantId)}</code></div>` : ''}</div></div>`;
    html += `<div class="lib-map-st" role="group" aria-label="Status"><span class="lib-badge ${approval[0]}" aria-label="Approval: ${esc(approval[1])}">${esc(approval[1])}</span> <span class="lib-badge ${sc[0]}" aria-label="Shopify check: ${esc(sc[1])}">${esc(sc[1])}</span> <span class="lib-badge ${sv[0]}" aria-label="Saved state: ${esc(sv[1])}">${esc(sv[1])}</span></div>`;
    if (info.needsApproval) {
      const from = mapSku(s.saved) || d.replacement?.fromSku || d.product.sku;
      html += `<div class="lib-vv-notice"><b>Replacement approval</b><div>${info.productChanged && s.saved ? `This card was mapped to SKU ${esc(mapSku(s.saved) || 'none')}; it would now use SKU ${esc(mapSku(d) || 'none')}.` : `The list approved SKU ${esc(from || 'none')}, not SKU ${esc(mapSku(d) || 'none')}.`} Approving applies to this card only; the list is not changed. ${info.pending ? 'This variant’s regular price isn’t approved, and no sale price is carried over.' : ''}</div><div class="sub">${s.saved ? 'Choose Approve &amp; Save Replacement to approve it and save the mapping in one step.' : 'Choose Approve &amp; Save Replacement to approve it and save it.'}</div></div>`;
    }
    if (info.conflicts.length) {
      const show = (k, val) => (k === 'regularCents' || k === 'promoCents' ? money(val) : val) || 'none';
      html += `<h4 class="lib-sel-h4">Your page-specific values</h4>${info.conflicts.map((k) => `<fieldset class="lib-sel-res"><legend>${esc(selFields[k] || k)}</legend><label><input type="radio" name="mres-${k}" data-lib="map-res" data-f="${k}" value="keep"${s.res[k] === 'keep' ? ' checked' : ''}><span>Keep mine: ${esc(show(k, ev[k]))}</span></label><label><input type="radio" name="mres-${k}" data-lib="map-res" data-f="${k}" value="default"${s.res[k] === 'default' ? ' checked' : ''}><span>Use the new default: ${esc(show(k, ev.base[k]))}</span></label></fieldset>`).join('')}`;
    }
    const chk = s.opts.getCheck?.() || null;
    if (chk && chk.state === 'changed' && !info.dirty) html += `<div class="lib-vv-notice"><b>The list changed since this was mapped:</b><ul class="lib-map-notes">${chk.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul><button class="xb" data-x="lib-map-adopt"${s.adoptBusy ? ' disabled' : ''}>Use the list’s current values</button></div>`;
    else if (chk && (chk.state === 'list-missing' || chk.state === 'product-missing')) html += `<div class="lib-vv-notice">${chk.notes.map(esc).join(' ')}</div>`;
    html += `<div class="lib-map-act"><button class="xb" data-x="lib-map-product">Change Product</button>${shop ? '<button class="xb" data-x="lib-map-variant">Change Variant</button>' : ''}${shop ? `<button class="xb" data-x="lib-map-shopify"${s.shopBusy ? ' disabled' : ''}>${s.shopBusy ? 'Checking…' : 'Check Shopify'}</button>` : ''}</div>`;
    html += mapShopLine(s);
    html += `<h4 class="lib-sel-h4">Values for this card on this page${ev.edited.length ? ` <button class="xb" data-x="lib-map-reset-all" style="float:right;text-transform:none;letter-spacing:0">Reset all (${ev.edited.length})</button>` : ''}</h4><div class="lib-map-vals">${['title', 'image', 'regularCents', 'promoCents', 'url'].map((k) => mapFieldHtml(s, ev, k)).join('')}</div><div class="sub">For this card on this page only. The Library isn’t changed, and a displayed price doesn’t change Shopify checkout.</div>`;
    html += mapFieldsHtml(s, ev, cur);
    const ae = L.root.activeElement;
    const keep = ae?.dataset?.f && ae.dataset.lib === 'map-f' ? ae.dataset.f : null;
    // While typing, the text in the focused field is the person's, not the normalised draft value: keep it and the caret.
    const typed = keep && s.live === keep ? { v: ae.value, a: ae.selectionStart, b: ae.selectionEnd } : null;
    const scroll = body.scrollTop;
    body.innerHTML = html;
    body.scrollTop = scroll;
    if (keep) {
      const inp = q(`.lib-map-body input[data-lib="map-f"][data-f="${keep}"]`);
      if (inp) {
        inp.focus();
        if (typed) { inp.value = typed.v; try { inp.setSelectionRange(typed.a, typed.b); } catch { /* not selectable */ } }
      }
    }
  }

  function mapEdit(field, raw, live) {
    const s = L.map;
    if (!s || !s.draft) return;
    s.live = live ? field : null;
    delete s.ferr[field];
    try {
      let next = Lib.setMappingOverride(s.draft, field, raw);
      // Typing a field back to its default is no override at all (so restoring every field to the saved state is "no change").
      if (next.overrides && field in next.overrides) {
        const bare = Lib.setMappingOverride(next, field, '');
        if (Lib.effectiveValues(bare)[field] === Lib.effectiveValues(next)[field]) next = bare;
      }
      s.draft = next;
    } catch (e) { s.ferr[field] = e.message; }
    s.err = '';
    mapRender(); mapNotify(s);
  }
  async function mapPick(mode) {
    const s = L.map;
    if (!s || L.sel) return;
    const cur = s.draft;
    const picked = await selectProduct({ current: cur, card: s.card, mode, defer: true });
    if (L.map !== s) return;
    if (picked) {
      const oldV = cur?.variant?.variantId;
      s.draft = picked; s.err = ''; s.res = {}; s.ferr = {};
      if (String(picked.variant?.variantId || '') !== String(oldV || '')) s.shop = null;
    }
    fieldRefresh(s);
    mapRender(); mapNotify(s);
    q('.lib-map-h')?.focus();
  }
  // Read-only. Says clearly when it finished, what it found, or why it failed. Never changes the mapping.
  async function mapShopify() {
    const s = L.map;
    const d = s?.draft;
    if (!s || !d?.variant || !d.list?.store || !d.variant.handle || s.shopBusy) return;
    const vid = String(d.variant.variantId);
    s.shopBusy = true; s.shop = null; mapRender();
    let res;
    try {
      const drv = Lib.createDriver({ origin: d.list.store, fetchJson, currency: d.approved?.currency || 'USD' });
      res = Lib.shopifyCheck(d, await drv.product(d.variant.handle));
    } catch (e) { res = { state: 'error', notes: [`Couldn’t reach the store (${e.message}).`] }; }
    if (L.map !== s) return;
    s.shopBusy = false;
    if (String(s.draft?.variant?.variantId || '') !== vid) { mapRender(); return; } // the variant changed while checking: that result is not for this one
    s.shop = { ...res, at: Date.now() };
    mapRender();
    q('.lib-map-shop')?.scrollIntoView?.({ block: 'nearest' });
  }
  async function mapAdopt() {
    const s = L.map;
    if (!s?.draft || s.adoptBusy) return;
    s.adoptBusy = true; mapRender();
    try {
      const m = s.draft;
      const idx = await Lib.loadIndex(storage());
      const has = idx.libs.some((l) => l.store === (m.list?.store || '') && l.campaign === m.list?.id);
      const lib = has ? await Lib.loadLibrary(storage(), m.list.store || '', m.list.id) : null;
      if (!lib) throw new Error('That list isn’t saved in this browser any more.');
      if (L.map === s) { s.draft = Lib.adoptListValues(lib, m); s.err = ''; }
    } catch (e) { if (L.map === s) s.err = e.message; }
    if (L.map !== s) return;
    s.adoptBusy = false; mapRender(); mapNotify(s);
  }
  async function mapSave() {
    const s = L.map;
    if (!s || s.saving) return;
    const info = mapInfo(s);
    if (!info.can) return;
    let next = s.draft;
    try {
      if (info.pending) next = Lib.approveMappingReplacement(next, { resolutions: s.res });
      // A different product or SKU the list itself has no replacement record for: the approval is this card's, recorded now.
      else if (info.needsApproval) { next = mapClone(next); next.replacement = { status: 'approved', fromSku: mapSku(s.saved) || null, toSku: mapSku(next) || null, approvedAt: Date.now(), resolved: {} }; }
    }
    catch (e) { s.err = e.message; mapRender(); return; }
    s.saving = true; s.err = ''; mapRender();
    let r;
    try { r = await s.opts.save(mapClone(next)); } catch (e) { r = { ok: false, error: e.message || String(e) }; }
    if (L.map !== s) return;
    s.saving = false;
    // On failure nothing is approved or saved: the working copy stays as it was before the attempt.
    if (!r || !r.ok) { s.err = (r && r.error) || 'The mapping could not be saved.'; mapRender(); return; }
    s.saved = mapClone(r.mapping || next); s.draft = mapClone(s.saved);
    closeMap({ action: 'saved', saved: s.saved });
  }
  function mapClick(b) {
    const s = L.map;
    if (!s) return;
    switch (b.dataset.x) {
      case 'lib-map-cancel': if (!s.saving) closeMap({ action: 'cancel' }); break;
      case 'lib-map-note': if (!s.saving) closeMap({ action: 'note' }); break;
      case 'lib-map-save': if (!b.disabled) mapSave(); break;
      case 'lib-map-product': mapPick('product'); break;
      case 'lib-map-variant': mapPick('variant'); break;
      case 'lib-map-shopify': mapShopify(); break;
      case 'lib-map-adopt': mapAdopt(); break;
      case 'lib-map-reset': mapEdit(b.dataset.f, ''); break;
      case 'lib-map-reset-all': { let m = s.draft; for (const k of Object.keys(m?.overrides || {})) m = Lib.setMappingOverride(m, k, ''); s.draft = m; s.ferr = {}; mapRender(); mapNotify(s); break; }
      default: break;
    }
  }

  // ---------------------------------------------------------------- Assign Products (every product card on the page)
  //
  // One workspace for the page's product cards: LEFT numbered Page Cards (grouped by section), RIGHT the Product Library
  // picker (the same list switching, search, product review, exact variants and replacement rules as everywhere else).
  // Select a card, then a product: the product is only STAGED ("Not saved yet"). Save Assignments is the one action that
  // persists; Cancel, ✕ and Esc throw every staged change away. The numbers are only for looking at the page: what is saved
  // belongs to the card's own identity (see tools.js), never to a number. A card's fields are edited in Card Mapping, and a
  // different-SKU replacement is never saved from here: its row asks for the same Approve & Save Replacement as always.
  // The workspace docks Right (default), Left or Bottom, or floats. Only while it is docked does it reserve space so the page
  // can reflow, and everything is put back when it closes.
  const sameChoice = (a, b) => !!a && !!b && a.product?.key === b.product?.key && (a.list?.id || '') === (b.list?.id || '') && (a.list?.store || '') === (b.list?.store || '') && String(a.variant?.variantId || '') === String(b.variant?.variantId || '');
  const bkPending = (s) => [...new Set([...Object.keys(s.drafts).filter((k) => s.drafts[k]), ...Object.keys(s.removals).filter((k) => s.removals[k])])];
  function bkInfo(s, r) {
    const d = s.drafts[r.key] || null;
    const info = d ? mapInfo({ draft: d, saved: r.mapping, res: {}, ferr: {}, saving: false }) : null;
    const rm = !d && !!s.removals[r.key] && !!r.mapping; // Remove Mapping staged: shown as unassigned until Save Assignments
    return { d, rm, shown: rm ? null : d || r.mapping, needsApproval: !!(info && info.needsApproval) };
  }
  const bkTitle = (m) => Lib.effectiveValues(m).title || m.product?.name || m.product?.key || 'product';

  // ---- the saved docking preference and size (in Blueline's own UI preferences)
  function asPrefs() {
    const p = BL.S.prefs;
    const a = p.assign && typeof p.assign === 'object' ? p.assign : (p.assign = {});
    if (!DOCKS.includes(a.mode)) a.mode = 'right';
    a.size = a.size && typeof a.size === 'object' ? a.size : {};
    for (const [k, v] of Object.entries({ right: 680, left: 680, bottom: 380 })) if (!Number.isFinite(a.size[k])) a.size[k] = v;
    a.float = a.float && typeof a.float === 'object' ? a.float : {};
    if (!Number.isFinite(a.float.w)) a.float.w = 720;
    if (!Number.isFinite(a.float.h)) a.float.h = 560;
    return a;
  }
  const asSave = () => { try { const r = BL.savePrefs(); if (r && r.catch) r.catch(() => {}); } catch { /* the choice is kept for this session */ } };
  const asLimits = (mode) => (mode === 'bottom' ? [220, Math.max(220, Math.round(innerHeight * 0.7))] : [320, Math.max(320, Math.round(innerWidth * 0.85))]);
  const asClamp = (mode, v) => { const [lo, hi] = asLimits(mode); return Math.round(Math.max(lo, Math.min(hi, v))); };

  // ---- layout: where the workspace sits, how much it reserves, and whether it has room for two columns
  // The part of the page the panel leaves free, measured now (the window or the panel may have been resized).
  function asFree() {
    const sh = q('.lib-sheet');
    const r = sh ? sh.getBoundingClientRect() : null;
    const a = asPrefs().mode;
    const vw = document.documentElement.clientWidth || innerWidth;
    if (!r || !q('.lib-modal').classList.contains('lib-adock') || a === 'float') return { left: 0, top: 0, right: vw, bottom: innerHeight };
    return a === 'right' ? { left: 0, top: 0, right: r.left, bottom: innerHeight } : a === 'left' ? { left: r.right, top: 0, right: vw, bottom: innerHeight } : { left: 0, top: 0, right: vw, bottom: r.top };
  }
  function asNarrow(s) {
    const sh = q('.lib-sheet');
    if (!sh || !s || L.bulk !== s) return;
    const r = sh.getBoundingClientRect();
    const narrow = r.width < 600;
    const tiny = narrow && (r.width < 360 || r.height < 440);
    const was = sh.classList.contains('lib-narrow');
    sh.classList.toggle('lib-narrow', narrow);
    sh.classList.toggle('lib-tiny', tiny);
    if (narrow !== was) bkRender(s); // the cards column is a compact strip when narrow
  }
  function asApply(s) {
    if (!s || L.bulk !== s || !L.root) return;
    const a = asPrefs();
    const m = q('.lib-modal');
    const sh = q('.lib-sheet');
    const visible = !L.map && !(L.sel && !L.sel.embedded) && !s.picking;
    m.classList.remove('lib-adock', 'lib-d-right', 'lib-d-left', 'lib-d-bottom', 'lib-d-float');
    for (const k of ['width', 'height', 'transform']) sh.style[k] = '';
    sh._tx = 0; sh._ty = 0;
    const head = q('.lib-sheet header');
    if (!visible) { head?.removeAttribute('data-nodrag'); try { s.api.dock(false); } catch { /* the page side only */ } return; }
    m.classList.add('lib-adock', `lib-d-${a.mode}`);
    L.asSetting = true;
    const docked = a.mode !== 'float';
    if (docked) { if (head) head.setAttribute('data-nodrag', ''); } else head?.removeAttribute('data-nodrag');
    let free = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    if (a.mode === 'right' || a.mode === 'left') {
      const w = asClamp(a.mode, a.size[a.mode]);
      sh.style.width = `${w}px`;
      free = a.mode === 'right' ? { left: 0, top: 0, right: innerWidth - w, bottom: innerHeight } : { left: w, top: 0, right: innerWidth, bottom: innerHeight };
      s.api.reserve(a.mode, w);
    } else if (a.mode === 'bottom') {
      const h = asClamp('bottom', a.size.bottom);
      sh.style.height = `${h}px`;
      free = { left: 0, top: 0, right: innerWidth, bottom: innerHeight - h };
      s.api.reserve('bottom', h);
    } else {
      sh.style.width = `${Math.min(a.float.w, innerWidth - 32)}px`; sh.style.height = `${Math.min(a.float.h, innerHeight - 32)}px`;
      s.api.release();
    }
    try { s.api.setFree(free); s.api.dock(true); } catch { /* the page side only */ }
    for (const b of q('.lib-as-docks').querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === a.mode));
    const rz = q('.lib-as-resize');
    if (rz) { rz.hidden = a.mode === 'float'; rz.dataset.side = a.mode; rz.setAttribute('aria-orientation', a.mode === 'bottom' ? 'horizontal' : 'vertical'); }
    setTimeout(() => { L.asSetting = false; }, 0);
    asNarrow(s);
  }
  function asSetMode(s, mode) {
    if (!DOCKS.includes(mode)) return;
    const a = asPrefs();
    a.mode = mode; asSave();
    asApply(s);
  }
  // Dragging the edge: the size follows the pointer, the page reflows live, and the size is saved when released.
  function asResizeStart(s, e) {
    const a = asPrefs();
    if (a.mode === 'float' || e.button > 0) return;
    e.preventDefault();
    const rz = q('.lib-as-resize');
    try { rz.setPointerCapture(e.pointerId); } catch { /* not supported */ }
    const move = (ev) => {
      const px = a.mode === 'right' ? (document.documentElement.clientWidth || innerWidth) - ev.clientX : a.mode === 'left' ? ev.clientX : innerHeight - ev.clientY;
      a.size[a.mode] = asClamp(a.mode, px);
      asApply(s);
    };
    const end = () => { rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', end); rz.removeEventListener('pointercancel', end); asSave(); };
    rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', end); rz.addEventListener('pointercancel', end);
  }
  function asResizeKey(s, e) {
    const a = asPrefs();
    const step = e.shiftKey ? 48 : 16;
    const grow = { right: 'ArrowLeft', left: 'ArrowRight', bottom: 'ArrowUp' }[a.mode];
    const shrink = { right: 'ArrowRight', left: 'ArrowLeft', bottom: 'ArrowDown' }[a.mode];
    if (!grow || (e.key !== grow && e.key !== shrink)) return;
    e.preventDefault();
    a.size[a.mode] = asClamp(a.mode, a.size[a.mode] + (e.key === grow ? step : -step));
    asApply(s); asSave();
  }
  // A floating workspace that was moved or the window shrank: keep it reachable.
  function asKeepVisible() {
    const s = L.bulk;
    const sh = q('.lib-sheet');
    if (!s || !sh || asPrefs().mode !== 'float' || !q('.lib-modal').classList.contains('lib-adock')) return;
    const r = sh.getBoundingClientRect();
    let dx = 0;
    let dy = 0;
    const cw = document.documentElement.clientWidth || innerWidth;
    if (r.right > cw - 8) dx = cw - 8 - r.right;
    if (r.left + dx < 8) dx = 8 - r.left;
    if (r.bottom > innerHeight - 8) dy = innerHeight - 8 - r.bottom;
    if (r.top + dy < 8) dy = 8 - r.top;
    if (dx || dy) { sh._tx = (sh._tx || 0) + dx; sh._ty = (sh._ty || 0) + dy; sh.style.transform = `translate(${sh._tx}px, ${sh._ty}px)`; }
  }

  // ---- data
  function bkScan(s) {
    const r = s.api.scan();
    s.seeds = !!s.api.hasSeeds?.();
    s.ok = r.ok; s.reason = r.reason || ''; s.rows = r.rows || []; s.review = r.review || []; s.title = r.title || 'All Cards';
    const keys = new Set(s.rows.map((x) => x.key));
    for (const k of Object.keys(s.drafts)) if (!keys.has(k)) delete s.drafts[k];
    for (const k of Object.keys(s.removals)) if (!keys.has(k)) delete s.removals[k];
    for (const k of Object.keys(s.rowErr)) if (!keys.has(k)) delete s.rowErr[k];
    const inc = s.rows.filter((x) => x.included);
    if (!s.sel || !keys.has(s.sel) || !inc.some((x) => x.key === s.sel)) s.sel = inc.length ? inc[0].key : null;
  }
  // Which card numbers each product is assigned to right now (staged choices count; they are what the page would show).
  function bkAssigned(s) {
    const map = new Map();
    for (const r of s.rows) {
      if (!r.included) continue;
      const m = s.removals[r.key] ? null : s.drafts[r.key] || r.mapping;
      if (!m) continue;
      const k = `${m.list?.store || ''}|${m.list?.id || ''}|${m.product?.key}`;
      map.set(k, [...(map.get(k) || []), r.n]);
    }
    return map;
  }
  const bkSel = (s) => s.rows.find((r) => r.key === s.sel) || null;
  function bkMarks(s) {
    const list = [];
    for (const r of s.rows) {
      if (!r.included || r.hidden) continue;
      const x = bkInfo(s, r);
      let state;
      let text;
      let label;
      if (x.rm) {
        state = 'pending'; text = `${r.n} · Will be unassigned · not saved`; label = `Card ${r.n}: the product assignment will be removed when you save.`;
      } else if (x.d) {
        state = x.needsApproval ? 'attn' : 'pending';
        text = x.needsApproval ? `${r.n} · Needs approval · ${clipTxt(bkTitle(x.d), 22)}` : `${r.n} · Proposed · ${clipTxt(bkTitle(x.d), 22)} · not saved`;
        label = `Card ${r.n}: ${x.needsApproval ? 'replacement needs approval' : 'proposed, not saved'}: ${bkTitle(x.d)}.`;
      } else if (r.mapping) {
        const pend = Lib.mappingStatus(r.mapping).identity === 'pending';
        state = pend ? 'attn' : 'mapped';
        text = `${r.n} · ${pend ? 'Mapped · check' : 'Mapped'} · ${clipTxt(bkTitle(r.mapping), 22)}`;
        label = `Card ${r.n}: mapped to ${bkTitle(r.mapping)}.`;
      } else { state = 'unmapped'; text = `${r.n} · Not mapped`; label = `Card ${r.n}: no product assigned.`; }
      list.push({ key: r.key, n: r.n, state, text, label: `${label} Select this card in Assign Products.`, sel: s.sel === r.key });
    }
    try { s.api.marks(list); } catch { /* the page side only */ }
  }

  // ---- left column: the page's cards
  function bkRowHtml(s, r) {
    const x = bkInfo(s, r);
    const m = x.shown;
    let prod;
    if (x.rm) prod = `<div class="lib-bk-prod"><span class="sub">Product will be unassigned when you save</span><div class="sub">Was: ${esc(bkTitle(r.mapping))}</div></div>`;
    else if (m) {
      const ev = Lib.effectiveValues(m);
      const v = m.variant;
      const opt = v ? (v.options || []).map((o) => o.value).filter(Boolean).join(' / ') || v.variantTitle || '' : '';
      const sku = v?.sku || m.product?.sku;
      prod = `<div class="lib-bk-prod"><b>${esc(ev.title || m.product?.name || m.product?.key)}</b><div class="sub">${esc([opt, sku ? `SKU ${sku}` : ''].filter(Boolean).join(' · '))}</div>${v ? `<div class="sub">Variant ID <code>${esc(String(v.variantId))}</code></div>` : ''}${x.d && r.mapping ? `<div class="sub">Was: ${esc(bkTitle(r.mapping))}</div>` : ''}</div>`;
    } else prod = '<div class="lib-bk-prod"><span class="sub">No product assigned</span></div>';
    let badge;
    if (x.rm) badge = ['warn', 'Mapping removal not saved'];
    else if (x.d) badge = x.needsApproval ? ['warn', 'Replacement approval required'] : ['warn', 'Not saved yet'];
    else if (r.mapping) { const ms = Lib.mappingStatus(r.mapping); badge = ms.identity === 'pending' ? ['warn', 'Replacement approval required'] : ['ok', 'Assigned']; }
    else badge = ['', 'Not mapped'];
    const desc = [r.section, r.pos].filter(Boolean).join(' · ');
    const look = r.prices?.length ? r.prices.join(' / ') : '';
    const thumbHtml = r.image && /^https?:/i.test(r.image) ? `<img src="${esc(r.image)}" alt="" loading="lazy">` : `<span>${esc(clipTxt(r.placeholder || '', 14) || 'card')}</span>`;
    let h = `<div class="lib-bk${s.sel === r.key ? ' sel' : ''}" data-x="lib-bk-select" data-key="${esc(r.key)}" role="listitem" aria-label="Card ${r.n}"${s.sel === r.key ? ' aria-current="true"' : ''}><button class="lib-bk-n" data-x="lib-bk-select" data-key="${esc(r.key)}" aria-label="Select card ${r.n}" aria-pressed="${s.sel === r.key}">${r.n}</button><div class="lib-bk-main">`;
    h += `<div class="lib-bk-t"><span class="lib-bk-th">${thumbHtml}</span><span><b>${esc(clipTxt(r.label, 46))}</b>${look ? `<span class="sub"> ${esc(clipTxt(look, 30))}</span>` : ''}<span class="sub lib-bk-d">${esc(desc || 'Product card')}</span></span></div>`;
    h += `${prod}<div class="lib-bk-st"><span class="lib-badge ${badge[0]}">${esc(badge[1])}</span>${r.hidden ? ' <span class="lib-badge">Hidden on the page</span>' : ''}${r.confidence === 'manual' ? ' <span class="lib-badge">Added by you</span>' : ''}${r.defined ? ' <span class="lib-badge">Defined card</span>' : ''} <span class="lib-tag ${r.kind === 'defined' ? 'def' : ''}" title="${r.kind === 'defined' ? 'You confirmed this card boundary' : 'Recognized automatically; not confirmed by you'}">${r.kind === 'defined' ? 'Defined' : 'Detected'}</span></div>`;
    if (r.locked) h += `<div class="sub">${esc(r.locked)}</div>`;
    if (x.needsApproval) h += `<div class="lib-vv-notice lib-bk-appr" role="status"><b>Needs approval.</b> A different SKU is not saved from here. Review it in Card Mapping and press Approve &amp; Save Replacement.<div><button class="xb lib-go" data-x="lib-bk-approve" data-key="${esc(r.key)}">Review &amp; approve replacement</button></div></div>`;
    if (s.rowErr[r.key]) h += `<div class="lib-map-ferr" role="alert">${esc(s.rowErr[r.key])}</div>`;
    h += '<div class="lib-bk-a">';
    h += `<button class="xb" data-x="lib-bk-show" data-key="${esc(r.key)}" data-n="${r.n}"${r.hidden ? ' disabled title="This card is hidden on the page right now"' : ' title="Show this card on the page"'}>Locate</button>`;
    h += bkMapButtons(s, r, x);
    h += bkCardButtons(s, r);
    h += '</div>';
    return `${h}</div></div>`;
  }
  // Remove Mapping (red) unassigns the product from the selected card; a small Discard change shows only while something is unsaved.
  function bkMapButtons(s, r, x) {
    const k = esc(r.key);
    let h = '';
    if (!x.rm && (x.d || r.mapping)) h += `<button class="xb danger lib-bk-unmap" data-x="lib-bk-unmap" data-key="${k}"${r.locked ? ' disabled' : ''} title="Unassign the product from this card. The card, its boundary and the Product Library are not touched. Nothing is saved until Save Assignments.">Remove Mapping</button>`;
    if (x.d || x.rm) h += `<button class="xb lib-bk-discard" data-x="lib-bk-undo" data-key="${k}" title="Discard this unsaved change">Discard change</button>`;
    return h;
  }
  // Card management on every card (detected, defined, assigned or not): fix its boundary, remove it, or say it is not a card.
  function bkCardButtons(s, r) {
    if (!r.included) return '';
    const k = esc(r.key);
    const off = r.locked ? ' disabled' : '';
    let h = `<button class="xb" data-x="lib-bk-boundary" data-key="${k}"${off} title="Outline this card on the page and adjust its boundary with Parent and Child">Edit Card Boundary</button>`;
    if (r.noteId) h += `<button class="xb danger lib-bk-rm" data-x="lib-bk-remove" data-key="${k}"${off} title="Delete this saved card definition and its page assignment. The Product Library is not touched, and the element can be found again later">Remove Card</button>`;
    else h += `<button class="xb danger lib-bk-rm" data-x="lib-bk-remove" data-key="${k}" disabled title="Only a saved (Defined) card can be removed. This one is only Detected, so there is nothing saved to remove. Use Not a card to stop proposing it.">Remove Card</button>`;
    h += `<button class="xb" data-x="lib-bk-exclude" data-key="${k}"${off} title="This is not a product card: stop proposing it on this page">Not a card</button>`;
    return h;
  }
  // Narrow layout: the selected card is one compact line (its state and the actions), not a full row.
  function bkSelLine(s, r) {
    const x = bkInfo(s, r);
    let badge;
    if (x.rm) badge = ['warn', 'Mapping removal not saved'];
    else if (x.d) badge = x.needsApproval ? ['warn', 'Replacement approval required'] : ['warn', 'Not saved yet'];
    else if (r.mapping) badge = Lib.mappingStatus(r.mapping).identity === 'pending' ? ['warn', 'Replacement approval required'] : ['ok', 'Assigned'];
    else badge = ['', 'Not mapped'];
    let h = `<div class="lib-bk-sl" data-key="${esc(r.key)}" aria-label="Selected card ${r.n}"><span class="lib-bk-slt"><b>Card ${r.n}</b> ${esc(clipTxt(r.label, 24))}${r.section ? ` <span class="sub">· ${esc(clipTxt(r.section, 20))}</span>` : ''} <span class="lib-badge ${badge[0]}">${esc(badge[1])}</span></span><span class="lib-bk-a">`;
    h += `<button class="xb" data-x="lib-bk-show" data-key="${esc(r.key)}" data-n="${r.n}"${r.hidden ? ' disabled' : ''}>Locate</button>`;
    h += bkMapButtons(s, r, x);
    h += bkCardButtons(s, r);
    h += '</span></div>';
    if (r.locked) h += `<div class="sub">${esc(r.locked)}</div>`;
    if (x.needsApproval) h += `<div class="lib-vv-notice lib-bk-appr" role="status"><b>Needs approval.</b> Review it in Card Mapping and press Approve &amp; Save Replacement.<div><button class="xb lib-go" data-x="lib-bk-approve" data-key="${esc(r.key)}">Review &amp; approve replacement</button></div></div>`;
    if (s.rowErr[r.key]) h += `<div class="lib-map-ferr" role="alert">${esc(s.rowErr[r.key])}</div>`;
    return h;
  }
  function bkRender(s) {
    if (L.bulk !== s || !L.root) return;
    const body = q('.lib-as-cbody');
    const foot = q('.lib-as-foot');
    const inc = s.rows.filter((r) => r.included);
    const assigned = inc.filter((r) => r.mapping).length;
    q('.lib-as-sum').textContent = s.ok ? `${s.title} · ${inc.length} card${inc.length === 1 ? '' : 's'} · ${assigned} assigned · ${inc.length - assigned} not mapped` : '';
    const pend = bkPending(s);
    const saveable = pend.filter((k) => { const r = s.rows.find((x) => x.key === k); return r && !bkInfo(s, r).needsApproval; });
    const blocked = pend.length - saveable.length;
    foot.innerHTML = `<button class="xb" data-x="lib-bk-cancel">${pend.length ? 'Cancel' : 'Close'}</button><button class="xb lib-primary" data-x="lib-bk-save"${saveable.length && !s.saving ? '' : ' disabled'}>${s.saving ? 'Saving…' : `Save Assignments${saveable.length ? ` (${saveable.length})` : ''}`}</button><div class="lib-sel-why" role="status">${s.saving ? 'Saving the assignments…' : pend.length ? `${pend.length} change${pend.length === 1 ? '' : 's'} not saved. Cancel, ✕ and Esc discard ${pend.length === 1 ? 'it' : 'them'}.${blocked ? ` ${blocked} ${blocked === 1 ? 'needs' : 'need'} a replacement approval first.` : ''}` : 'Select a card, then choose its product on the right.'}</div>`;
    let html = '';
    if (s.err) html += `<div class="lib-vv-notice bad" role="alert">${esc(s.err)}</div>`;
    if (s.msg) html += `<div class="lib-vv-notice ok" role="status">${esc(s.msg)}</div>`;
    if (!s.ok) { body.innerHTML = `${html}<div class="lib-vv-notice">${esc(s.reason)}</div>`; return; }
    const narrow = !!q('.lib-sheet')?.classList.contains('lib-narrow');
    if (!narrow) html += '<div class="sub">Numbers match the markers on the page and are only for looking: what you save stays with the card itself. Nothing is saved until you choose Save Assignments.</div>';
    const empty = !s.rows.length;
    if (empty) html += '<div class="lib-bk-empty" role="status"><b>No product cards defined on this page yet.</b><div class="sub">Press Define Product Card, click a product on the page, check the outline, then press Confirm Card. Blueline will look for the similar cards.</div></div>';
    const clearBtn = s.rows.some((r) => r.noteId || r.excluded) ? '<button class="xb danger lib-bk-clear" data-x="lib-bk-clear" title="Delete every defined card, assignment and exclusion on this page (the Product Library is not touched)">Clear All Cards</button>' : '';
    html += `<div class="xrow lib-bk-acts"><button class="xb lib-primary lib-bk-define" data-x="lib-bk-define"${s.picking ? ' disabled' : ''}>Define Product Card</button><button class="xb" data-x="lib-bk-find"${s.seeds && !s.picking ? '' : ' disabled'} title="${s.seeds ? 'Search the page again for cards built like the ones you defined' : 'Define a product card first'}">Find Similar Cards</button><button class="xb lib-bk-auto" data-x="lib-bk-auto"${s.picking || s.saving || !s.rows.length ? ' disabled' : ''} title="Fill the empty cards in page order with the products of the selected Product Library list, in list order. This is not matching: nothing is saved until Save Assignments">Auto-map products</button>${narrow ? '' : clearBtn}</div>`;
    const chip = (r) => {
      const x = bkInfo(s, r);
      let st; let cls = '';
      if (x.rm) { st = 'Will unassign'; cls = 'warn'; } else if (x.d) { st = x.needsApproval ? 'Needs approval' : 'Not saved'; cls = 'warn'; } else if (r.mapping) { st = Lib.mappingStatus(r.mapping).identity === 'pending' ? 'Approval needed' : 'Assigned'; cls = st === 'Assigned' ? 'ok' : 'warn'; } else st = 'Not mapped';
      const nm = x.shown ? clipTxt(bkTitle(x.shown), 14) : '';
      return `<button class="lib-cchip ${cls}${s.sel === r.key ? ' sel' : ''}" data-x="lib-bk-select" data-key="${esc(r.key)}" role="option" aria-selected="${s.sel === r.key}" aria-label="Card ${r.n}: ${esc(st)}${nm ? `, ${esc(bkTitle(x.shown))}` : ''}" title="Card ${r.n}${r.section ? ` · ${esc(r.section)}` : ''} · ${esc(st)}"><b>${r.n}</b><span>${esc(st)}</span><em>${r.kind === 'defined' ? 'Defined' : 'Detected'}</em>${nm ? `<i>${esc(nm)}</i>` : ''}</button>`;
    };
    const oldStrip = body.querySelector('.lib-as-strip');
    const stripLeft = oldStrip ? oldStrip.scrollLeft : 0;
    if (narrow) {
      html += `<div class="lib-as-strip" role="listbox" aria-label="Page cards">${inc.map(chip).join('')}</div>`;
      const sr = inc.find((r) => r.key === s.sel);
      if (sr) html += bkSelLine(s, sr);
    } else {
      let sec = null;
      html += '<div class="lib-bk-list" role="list">';
      for (const r of inc) {
        if (r.section !== sec) { sec = r.section; html += `<h4 class="lib-sel-h4 lib-bk-sec">${esc(sec || 'Other cards')}</h4>`; }
        html += bkRowHtml(s, r);
      }
      html += '</div>';
    }
    if (!inc.length && s.rows.length) html += '<div class="sub">No product cards are included yet.</div>';
    let extra = narrow && clearBtn ? `<div class="xrow">${clearBtn}</div>` : '';
    const more = s.rows.filter((r) => !r.included && !r.excluded);
    const excl = s.rows.filter((r) => r.excluded);
    let exPanel = '';
    if (!excl.length) s.exOpen = false;
    if (excl.length && s.exOpen) {
      exPanel += `<h4 class="lib-sel-h4 lib-bk-exh">Excluded: not a card (${excl.length})</h4><div class="sub">These are not proposed again on this page until you restore them.</div><div class="lib-bk-list">`;
      for (const r of excl) exPanel += `<div class="lib-bk lib-bk-off lib-bk-ex" data-key="${esc(r.key)}"><div class="lib-bk-main"><div class="lib-bk-t"><span class="lib-bk-th">${r.image && /^https?:/i.test(r.image) ? `<img src="${esc(r.image)}" alt="" loading="lazy">` : `<span>${esc(clipTxt(r.placeholder || '', 14) || 'card')}</span>`}</span><span><b>${esc(clipTxt(r.label, 46))}</b><span class="sub lib-bk-d">${esc([r.section, r.pos].filter(Boolean).join(' · ') || 'Card')}</span></span></div><div class="sub">${r.exclWhy === 'boundary' ? 'Replaced by the boundary you set; this older outline is not a card.' : 'You marked this as not a card.'}</div><div class="lib-bk-a"><button class="xb" data-x="lib-bk-include" data-key="${esc(r.key)}">Restore</button><button class="xb" data-x="lib-bk-show" data-key="${esc(r.key)}" data-n=""${r.hidden ? ' disabled' : ''}>Locate</button></div></div></div>`;
      exPanel += '</div>';
      exPanel = `<div class="lib-bk-expanel" role="region" aria-label="Excluded cards">${exPanel}</div>`;
    }
    if (more.length) {
      extra += `<h4 class="lib-sel-h4">Not included (${more.length})</h4><div class="sub">Blueline is less sure about these, or you removed them. Include one to number it and map it.</div><div class="lib-bk-list">`;
      for (const r of more) extra += `<div class="lib-bk lib-bk-off" data-key="${esc(r.key)}"><div class="lib-bk-main"><div class="lib-bk-t"><span class="lib-bk-th">${r.image && /^https?:/i.test(r.image) ? `<img src="${esc(r.image)}" alt="" loading="lazy">` : `<span>${esc(clipTxt(r.placeholder || '', 14) || 'card')}</span>`}</span><span><b>${esc(clipTxt(r.label, 46))}</b><span class="sub lib-bk-d">${esc([r.section, r.pos].filter(Boolean).join(' · ') || 'Possible card')}</span></span></div><div class="sub">${r.confidence === 'review' ? 'Possible card: built differently from the one you confirmed. Check it before including it.' : 'You marked this as not a card.'}</div><div class="lib-bk-a"><button class="xb" data-x="lib-bk-include" data-key="${esc(r.key)}">Include</button><button class="xb" data-x="lib-bk-show" data-key="${esc(r.key)}" data-n=""${r.hidden ? ' disabled' : ''}>Locate</button></div></div></div>`;
      extra += '</div>';
    }
    if (s.review.length) {
      extra += `<h4 class="lib-sel-h4">Saved mappings that need review (${s.review.length})</h4><div class="lib-vv-notice"><div>Blueline could not tell which card these belong to, so none was linked and nothing was changed. Open the note from the notes list and confirm its card again.</div><ul class="lib-map-notes">${s.review.map((v) => `<li><b>${esc(v.title)}</b>: ${esc(v.reasons[0] || '')}</li>`).join('')}</ul></div>`;
    }
    if (extra) html += narrow ? `<details class="lib-bk-more"><summary>More: Clear All Cards, not included, saved mappings to review</summary>${extra}</details>` : extra;
    if (exPanel) html = exPanel + html;
    const scroll = body.scrollTop;
    body.innerHTML = html;
    body.scrollTop = scroll;
    const strip = body.querySelector('.lib-as-strip');
    if (strip) { strip.scrollLeft = stripLeft; const c = strip.querySelector('.lib-cchip.sel'); if (c) { const l = c.offsetLeft - strip.offsetLeft; if (l < strip.scrollLeft || l + c.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = Math.max(0, l - 8); } }
    const rep = q('.lib-rep');
    const bd = q('.lib-repbd');
    if (rep && bd) { bd.hidden = !s.confirm; rep.innerHTML = s.confirm ? bkConfirmHtml(s) : ''; }
    const hc = q('.lib-as-cards .lib-as-h'); if (hc) hc.dataset.count = s.ok ? String(inc.length) : '';
    const eb = q('.lib-ex-btn');
    if (eb) { const n = s.ok ? excl.length : 0; eb.hidden = !n; eb.textContent = n ? `Excluded (${n})` : ''; eb.setAttribute('aria-expanded', String(!!s.exOpen)); eb.title = s.exOpen ? 'Hide the cards marked not a card' : 'Show the cards marked not a card, to locate or restore them'; if (hc) { if (n) hc.dataset.ex = '1'; else delete hc.dataset.ex; } }
    const hp = q('.lib-as-prods .lib-as-h'); if (hp) hp.dataset.count = L.sel && L.sel.rows ? String(L.sel.rows.length) : '';
    bkRetarget(s);
    bkMarks(s);
  }

  // ---- right column: the Product Library picker, embedded
  function asMountSel() { const slot = q('.lib-as-pslot'); const sel = q('.lib-sel'); if (slot && sel && sel.parentElement !== slot) slot.appendChild(sel); }
  function asUnmountSel() { const sel = q('.lib-sel'); const map = q('.lib-map'); if (sel && map && sel.parentElement !== map.parentElement) map.parentElement.insertBefore(sel, map); }
  // The picker works on the selected card: its current product (for variant / replacement rules) and its identity.
  function bkRetarget(s) {
    const sel = L.sel;
    if (!sel || !sel.embedded || sel.owner !== s) return;
    const r = bkSel(s);
    const moved = sel.cardKey !== (r ? r.key : null);
    sel.cardKey = r ? r.key : null;
    sel.current = r ? (s.removals[r.key] ? null : s.drafts[r.key] || r.mapping || null) : null;
    sel.card = r ? s.api.card(r.key) : null;
    sel.ctx = r ? `Assigning to Card ${r.n}${r.section ? ` · ${r.section}` : ''}${r.label ? ` · ${clipTxt(r.label, 28)}` : ''}` : 'Select a card on the left first.';
    sel.asg = bkAssigned(s);
    if (moved) { sel.step = 'products'; sel.key = null; sel.variants = null; sel.vsel = null; sel.res = {}; }
    if (!sel.busy) { selRender(); }
  }
  function bkOpenPicker(s) {
    const prefer = L.lib ? { store: L.lib.store || '', campaign: L.lib.campaign } : null;
    asMountSel();
    const sel = { resolve: () => {}, embedded: true, owner: s, defer: true, current: null, card: null, mode: 'product', step: 'products', direct: false, lists: [], listKey: '', lib: null, rows: [], q: '', key: null, variants: null, vsel: null, vmsg: '', vbusy: false, res: {}, busy: true, msg: '', ctx: '', asg: new Map(), prefer };
    L.sel = sel;
    bkRetarget(s);
    selLoad(sel);
  }
  // A product was reviewed and confirmed (or dropped on a card): it is staged for that card. Putting a DIFFERENT product on a
  // card that already has one (saved or staged) asks first; the different-SKU approval is a separate, later step in Card Mapping.
  const bkCurrent = (s, r) => (s.removals[r.key] ? null : s.drafts[r.key] || r.mapping || null);
  const bkSameProduct = (a, b) => !!a && !!b && a.product?.key === b.product?.key && (a.list?.id || '') === (b.list?.id || '') && (a.list?.store || '') === (b.list?.store || '');
  function bkApplyStage(s, r, mapping) {
    delete s.removals[r.key];
    if (sameChoice(r.mapping, mapping)) delete s.drafts[r.key]; else s.drafts[r.key] = mapping;
    delete s.rowErr[r.key]; s.err = ''; s.msg = ''; s.confirm = null;
    bkRender(s);
  }
  function bkStage(s, mapping, cardKey) {
    const r = cardKey ? s.rows.find((x) => x.key === cardKey) : bkSel(s);
    if (!r || r.locked) return;
    const cur = bkCurrent(s, r);
    if (cur && !bkSameProduct(cur, mapping)) { s.confirm = { key: r.key, mapping, from: cur }; bkRender(s); q('[data-x="lib-rep-cancel"]')?.focus(); return; }
    bkApplyStage(s, r, mapping);
  }
  function bkAsk(s, o) { s.confirm = { kind: 'ask', ...o }; bkRender(s); q('[data-x="lib-rep-cancel"]')?.focus(); }
  const bkAsgText = (m) => { if (!m) return ''; const v = m.variant; return `<div class="lib-vv-notice"><b>${esc(bkTitle(m))}</b><div class="sub">${esc(v?.sku || m.product?.sku ? `SKU ${v?.sku || m.product?.sku}` : '')}${v ? ` · Variant ID <code>${esc(String(v.variantId))}</code>` : ''}</div></div>`; };
  function bkConfirmHtml(s) {
    const c = s.confirm;
    if (c && c.kind === 'ask') return `<h4 class="lib-rep-t" id="lib-rep-t">${esc(c.title)}</h4>${c.html}<div class="lib-rep-a"><button class="xb" data-x="lib-rep-cancel">Cancel</button><button class="xb ${c.danger ? 'danger solid' : 'lib-primary'}" data-x="lib-rep-ok">${esc(c.ok)}</button></div>`;
    const r = c && s.rows.find((x) => x.key === c.key);
    if (!r) return '';
    const line = (m, staged) => { const ev = Lib.effectiveValues(m); const v = m.variant; return `<b>${esc(ev.title || m.product?.name || m.product?.key)}</b><div class="sub">${esc([v?.sku || m.product?.sku ? `SKU ${v?.sku || m.product?.sku}` : '', staged ? 'staged, not saved' : 'assigned'].filter(Boolean).join(' · '))}${v ? ` · Variant ID <code>${esc(String(v.variantId))}</code>` : ''}</div>`; };
    return `<h4 class="lib-rep-t" id="lib-rep-t">Replace the product assigned to Card #${r.n}?</h4><div><div class="lib-rep-k">Current</div>${line(c.from, !!s.drafts[r.key])}</div><div><div class="lib-rep-k">New</div>${line(c.mapping, true)}</div><div class="sub">This only stages the change. Nothing is saved until Save Assignments, and a different SKU still needs Approve &amp; Save Replacement.</div><div class="lib-rep-a"><button class="xb" data-x="lib-rep-cancel">Cancel</button><button class="xb lib-primary" data-x="lib-rep-ok">Confirm replacement</button></div>`;
  }
  // ---- dragging a product from the Library onto a card on the page (the extension's own pointer handling; the page never sees it)
  let drag = null;
  const overSheet = (x, y) => { const r = q('.lib-sheet')?.getBoundingClientRect(); return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; };
  // The drag is tracked on the window (capture phase), not on the panel: a release over the webpage, a re-render that replaces
  // the dragged row (which drops its pointer capture), or a release outside the window must all still end the drag.
  const dragOn = (on) => {
    const f = on ? 'addEventListener' : 'removeEventListener';
    for (const ev of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) window[f](ev, onDragPointer, true);
    window[f]('keydown', onDragKey, true);
    window[f]('blur', onDragLost);
    document[f]('visibilitychange', onDragLost);
  };
  // Ends the drag completely: no preview, no highlight, no listeners. A drop is decided from where the pointer is released.
  function dragEnd(commit, e) {
    const d = drag;
    if (!d) return;
    drag = null;
    dragOn(false);
    clearInterval(d.timer);
    try { d.row?.releasePointerCapture?.(d.id); } catch { /* already released */ }
    const s = L.bulk;
    const g = q('.lib-ghost');
    if (g) g.hidden = true;
    q('.lib-sheet')?.classList.remove('lib-dragging');
    try { s?.api.dragging(false); } catch { /* the page side only */ }
    if (d.on) { L.dragSuppress = true; setTimeout(() => { L.dragSuppress = false; }, 400); }
    let target = d.target;
    if (commit && d.on && s) {
      const pt = e && Number.isFinite(e.clientX) ? { x: e.clientX, y: e.clientY } : d.last;
      if (pt) { try { target = overSheet(pt.x, pt.y) ? null : s.api.cardAt(pt.x, pt.y) || null; } catch { target = d.target; } }
      if (target) bkDrop(s, target, d.key);
    }
  }
  const dragCancel = () => dragEnd(false);
  function onDragPointer(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (e.type === 'lostpointercapture') {
      // The dragged row was replaced by a re-render while the button was down: Chrome sends the release to the removed row, so
      // the pointerup never arrives anywhere. Its lostpointercapture (button already up) is the release; decide the drop from
      // where the pointer last was. If the capture is taken from a row that is still on screen while the button is held, the
      // drag cannot be trusted and is cancelled.
      if (!drag.on) return;
      if (e.buttons === 0) dragEnd(true); else if (drag.row.isConnected) dragEnd(false);
      return;
    }
    if (e.type === 'pointermove') {
      if (drag.on && e.buttons === 0) { dragEnd(true, e); return; } // the release happened where nothing reported it
      onDragMove(e);
    } else dragEnd(e.type === 'pointerup', e);
  }
  function onDragKey(e) {
    if (!drag || e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    if (drag.on) dragEnd(false); // Esc cancels an active drag; nothing is staged
  }
  const onDragLost = () => { if (drag) dragEnd(false); };
  function dragTick() {
    const s = L.bulk;
    if (!drag || !drag.on || !s || !drag.last) return;
    const free = asFree();
    const { x, y } = drag.last;
    // Near the edge of the part of the page the panel leaves free: scroll, so a card out of view can be reached.
    const dy = y < free.top + 48 ? -16 : y > free.bottom - 48 ? 16 : 0;
    const dx = x < free.left + 48 ? -16 : x > free.right - 48 ? 16 : 0;
    if (dx || dy) window.scrollBy(dx, dy);
    const t = overSheet(x, y) ? null : s.api.cardAt(x, y);
    drag.target = t;
    s.api.dropTarget(t);
  }
  function onDragDown(e) {
    const s = L.bulk;
    if (!s || L.map || e.button > 0 || !L.sel?.embedded || L.sel.step !== 'products') return;
    const row = e.target.closest?.('.lib-sel-row[data-x="lib-sel-pick"]');
    if (!row) return;
    if (drag) dragEnd(false); // never two drags: a stale one is finished first
    try { row.setPointerCapture(e.pointerId); } catch { /* not supported */ }
    drag = { key: row.dataset.key, x0: e.clientX, y0: e.clientY, on: false, row, id: e.pointerId, title: row.querySelector('b')?.textContent || 'product', last: null, target: null, timer: 0 };
    dragOn(true);
  }
  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const s = L.bulk;
    if (!s) { dragEnd(false); return; }
    if (!drag.on) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
      drag.on = true;
      q('.lib-sheet').classList.add('lib-dragging');
      const g = q('.lib-ghost');
      g.textContent = drag.title; g.hidden = false;
      s.api.dragging(true);
      drag.timer = setInterval(dragTick, 40);
    }
    e.preventDefault();
    drag.last = { x: e.clientX, y: e.clientY };
    const g = q('.lib-ghost');
    g.style.left = `${e.clientX + 12}px`; g.style.top = `${e.clientY + 12}px`;
    dragTick();
  }
  function bkDrop(s, cardKey, productKey) {
    const sel = L.sel;
    const r = s.rows.find((x) => x.key === cardKey);
    if (!sel || !sel.embedded || !sel.lib || !r) return;
    s.sel = cardKey; s.err = ''; s.msg = '';
    if (r.locked) { s.err = r.locked; bkRender(s); return; }
    let mapping;
    try { mapping = Lib.buildSelectionMapping(sel.lib, productKey, { variant: null, current: bkCurrent(s, r), card: s.api.card(cardKey) }); }
    catch (err) { s.err = `That product could not be assigned (${err.message}).`; bkRender(s); return; }
    bkStage(s, mapping, cardKey);
    if (!s.confirm) s.msg = `Staged for Card ${r.n}. Not saved yet: choose Save Assignments to keep it.`;
    bkRender(s);
    try { s.api.focus(cardKey); } catch { /* the page side only */ }
  }
  function bkConfirm(s, ok) {
    const c = s.confirm;
    s.confirm = null;
    if (c && c.kind === 'ask') { if (ok) c.run(); else bkRender(s); return; }
    if (ok && c) { const r = s.rows.find((x) => x.key === c.key); if (r) { bkApplyStage(s, r, c.mapping); return; } }
    bkRender(s);
  }
  function bkSelect(s, key, fromPage) {
    if (L.bulk !== s || L.map) return;
    const r = s.rows.find((x) => x.key === key);
    if (!r || !r.included) return;
    s.sel = key; s.confirm = null;
    bkRender(s);
    if (s.tab !== 'cards' && !fromPage) { /* stays on the tab the person is on */ }
    try { s.api.focus(key); } catch { /* the page side only */ }
    const row = q(`.lib-bk[data-key="${key}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
    row?.classList.add('flash');
    setTimeout(() => row?.classList.remove('flash'), 1400);
  }
  // The workspace comes back after Card Mapping or the page picker: same place, fresh page facts.
  function bkResume(s) {
    if (L.bulk !== s || !L.root) return;
    L.open = true;
    q('[data-m="library"]').hidden = false;
    const sh = q('.lib-sheet');
    sh.classList.remove('lib-smode'); sh.classList.add('lib-pmode', 'lib-amode', 'lib-full'); // pmode hides the Library's own main view
    q('.lib-head').textContent = 'Assign Products'; sh.setAttribute('aria-label', 'Assign Products');
    asMountSel();
    if (!L.sel) { bkOpenPicker(s); } else if (L.sel.embedded) { L.sel.owner = s; selRender(); }
    bkScan(s); asApply(s); bkRender(s);
  }
  function openAssign(opts = {}) {
    if (!L.root || !opts.api) return Promise.resolve({ action: 'cancel' });
    if (L.sel) closeSel(null);
    if (L.map) closeMap({ action: 'cancel' });
    if (L.bulk) closeBulk({ action: 'cancel' });
    return new Promise((resolve) => {
      const s = { resolve, api: opts.api, rows: [], review: [], title: 'All Cards', ok: true, reason: '', drafts: {}, removals: {}, rowErr: {}, sel: null, saving: false, err: '', msg: '', picking: false, tab: 'products', confirm: null };
      L.bulk = s;
      L.open = true;
      q('[data-m="library"]').hidden = false;
      const sh = q('.lib-sheet');
      sh.classList.remove('lib-smode');
      sh.classList.add('lib-pmode', 'lib-amode', 'lib-full');
      q('.lib-head').textContent = 'Assign Products'; sh.setAttribute('aria-label', 'Assign Products');
      s.api.onMark = (key) => bkSelect(s, key, true);
      s.api.onChange = () => { if (L.bulk === s && !s.picking && !s.saving) { bkScan(s); bkRender(s); } };
      bkScan(s);
      bkOpenPicker(s);
      asApply(s); bkRender(s);
      q('.lib-as-h')?.focus();
    });
  }
  function closeBulk(result) {
    const s = L.bulk;
    if (!s) return;
    dragEnd(false);
    if (L.sel) { const r = L.sel.resolve; L.sel = null; try { r(null); } catch { /* ignore */ } }
    if (L.map) { const m = L.map; L.map = null; try { m.opts.onPending?.(null, m.saved); } catch { /* ignore */ } m.resolve({ action: 'cancel', saved: m.saved }); }
    L.bulk = null; L.open = false;
    try { s.api.marks([]); s.api.dock(false); s.api.release(); s.api.onMark = null; s.api.onChange = null; } catch { /* the page side only */ }
    if (L.root) {
      asUnmountSel();
      const sh = q('.lib-sheet');
      sh.classList.remove('lib-pmode', 'lib-smode', 'lib-amode', 'lib-narrow', 'lib-tiny'); sh.setAttribute('aria-label', 'Product Library'); q('.lib-head').textContent = 'Product Library';
      for (const k of ['width', 'height', 'transform']) sh.style[k] = '';
      sh._tx = 0; sh._ty = 0;
      q('.lib-sheet header')?.removeAttribute('data-nodrag');
      q('.lib-modal').classList.remove('lib-adock', 'lib-d-right', 'lib-d-left', 'lib-d-bottom', 'lib-d-float');
      q('[data-m="library"]').hidden = true;
    }
    s.resolve({ action: 'cancel', ...(result || {}) });
  }
  // Assign Products (from the Product Library or Home): saved cards are listed at once; with none, Define Product Card starts it.
  async function assignStart() {
    const A = BL.toolsApi?.assign;
    if (!A || !L.root) { say('Assign Products did not load. Reload the page.', 'bad'); return; }
    A.reset();
    A.findSeed(); // saved cards show at once; with none, the workspace starts with Define Product Card
    A.begin();
    await openAssign({ api: A.api }).catch(() => {});
    A.reset();
  }
  const bkFocusRow = (key, x) => (q(`.lib-bk[data-key="${key}"] [data-x="${x}"]:not([disabled])`) || q(`.lib-bk[data-key="${key}"] button:not([disabled])`) || q('.lib-as-h'))?.focus?.({ preventScroll: true });
  async function bkWithoutWindow(s, run) {
    s.picking = true; L.open = false; q('[data-m="library"]').hidden = true;
    let r = null;
    try { r = await run(); } catch { r = null; }
    if (L.bulk !== s) return null;
    s.picking = false; L.open = true; q('[data-m="library"]').hidden = false;
    asApply(s);
    return r;
  }
  // Locate: the workspace stays where it is. The card is selected, scrolled clear of the workspace and outlined in lime for
  // about 1.5 s. A floating workspace steps aside only while it would cover the card, then slides back.
  function bkShow(s, key, n) {
    if (s.picking || s.saving) return;
    const r = bkRowOf(s, key);
    if (!r) return;
    if (s.sel !== key) { s.sel = key; s.confirm = null; bkRender(s); }
    let box = null;
    try { box = s.api.locate(key, n || r.n); } catch { box = null; }
    bkFocusRow(key, 'lib-bk-show');
    const sh = q('.lib-sheet');
    if (!box || !sh || asPrefs().mode !== 'float') return;
    const sr = sh.getBoundingClientRect();
    const over = !(box.right <= sr.left || box.left >= sr.right || box.bottom <= sr.top || box.top >= sr.bottom);
    if (!over) return;
    const keep = sh.style.transform; const keepT = sh.style.transition;
    const mid = (box.left + box.right) / 2;
    const dx = mid < innerWidth / 2 ? innerWidth - 8 - sr.right : 8 - sr.left;
    sh.style.transition = 'transform .25s ease';
    sh.style.transform = `${keep || ''} translateX(${Math.round(dx)}px)`;
    setTimeout(() => { if (L.bulk === s && sh.isConnected) { sh.style.transform = keep; setTimeout(() => { sh.style.transition = keepT; }, 300); } }, 1800);
  }
  // Remove Mapping: unassign the product from the selected card. A saved assignment asks first; an unsaved draft is just cleared.
  function bkUnmap(s, key) {
    if (s.picking || s.saving) return;
    const r = bkRowOf(s, key);
    if (!r) return;
    if (!r.mapping) { delete s.drafts[key]; delete s.rowErr[key]; s.err = ''; s.msg = ''; bkRender(s); bkFocusRow(key, 'lib-bk-show'); return; }
    bkAsk(s, { title: `Remove the product from Card #${r.n}?`, ok: 'Remove Mapping', danger: true, html: `<p class="sub">This unassigns the product from this card once you press Save Assignments. The card and its boundary stay, and your Product Library is not touched. Until you save, Cancel brings the assignment back.</p><div class="lib-rep-k">Assignment that will be removed</div>${bkAsgText(r.mapping)}`, run: () => { delete s.drafts[key]; delete s.rowErr[key]; s.removals[key] = true; s.sel = key; s.err = ''; s.msg = `Mapping removal staged for Card #${r.n}. Press Save Assignments to apply it.`; s.confirm = null; bkRender(s); bkFocusRow(key, 'lib-bk-show'); } });
  }
  async function bkDefine(s) {
    if (s.picking || s.saving) return;
    s.err = ''; s.msg = '';
    const r = await bkWithoutWindow(s, () => s.api.define());
    if (L.bulk !== s || !r) { if (L.bulk === s) { bkScan(s); bkRender(s); } return; }
    if (r.ok) {
      bkScan(s);
      const n = s.rows.filter((x) => x.included).length;
      const found = n > 1 ? ` Blueline found ${n - 1} similar card${n === 2 ? '' : 's'}.` : ' No similar cards were found yet.';
      s.msg = r.already ? `That card is already defined${r.assigned ? ' and has a product assigned' : ''}.${found}` : `Card defined and saved.${found}`;
      if (s.rows.some((x) => x.key === r.key && x.included)) s.sel = r.key;
    } else if (!r.cancelled) s.err = r.msg || 'That card could not be defined.';
    bkRender(s);
    if (r.ok && s.sel) bkSelect(s, s.sel);
  }
  // "Find Similar Cards": search the page again from the cards already defined (nothing saved or removed by this).
  function bkFind(s) {
    if (s.picking || s.saving) return;
    if (!s.api.hasSeeds?.()) { bkDefine(s); return; }
    const before = new Set(s.rows.filter((x) => x.included).map((x) => x.key));
    s.err = ''; s.msg = '';
    bkScan(s);
    const inc = s.rows.filter((x) => x.included);
    const fresh = inc.filter((x) => !before.has(x.key)).length;
    s.msg = fresh ? `Found ${fresh} new card${fresh === 1 ? '' : 's'} (${inc.length} in all).` : `No new cards found (${inc.length} in all).`;
    bkRender(s);
  }

  // ---- Auto-map products: plain sequential bulk assignment (not matching). The selected list's products, in the list's own order,
  // go to the empty cards in page order. A preview comes first; Apply to Draft only stages (Save Assignments is the one save).
  function bkAutoPlan(s) {
    const sel = L.sel;
    if (!sel || !sel.embedded || !sel.lib) return { error: 'Choose a Product Library list on the right first (the products come from the selected list).' };
    const cards = []; const skippedCards = [];
    for (const r of s.rows) {
      if (r.excluded) { skippedCards.push({ n: null, label: r.label, why: 'marked Not a card' }); continue; }
      if (!r.included) continue;
      if (r.locked) { skippedCards.push({ n: r.n, label: r.label, why: 'its note is open in the note editor' }); continue; }
      if (s.removals[r.key]) { skippedCards.push({ n: r.n, label: r.label, why: 'has a staged mapping removal' }); continue; }
      const cur = s.drafts[r.key] || r.mapping;
      if (cur) { skippedCards.push({ n: r.n, label: r.label, why: s.drafts[r.key] ? 'already has a staged product' : 'already assigned (kept as is)' }); continue; }
      cards.push(r);
    }
    for (const v of s.review) skippedCards.push({ n: null, label: v.title, why: 'needs review (stale or ambiguous card), not touched' });
    const prods = []; const skippedProds = [];
    for (const pr of sel.rows || []) {
      if (!pr.variant || pr.variant.variantId == null || pr.variant.variantId === '') skippedProds.push({ name: pr.display?.title || pr.name || pr.sku || pr.key, why: 'no exact Shopify variant in the list (nothing is invented)' });
      else prods.push(pr);
    }
    if (!cards.length) return { error: `There are no empty cards to fill. Every included card already has a product${skippedCards.length ? ' or needs review' : ''}.`, skippedCards };
    if (!prods.length) return { error: 'The selected list has no usable products (each needs an exact Shopify variant).', skippedProds };
    const pairs = [];
    let pi = 0;
    for (const r of cards) {
      while (pi < prods.length) {
        const pr = prods[pi++];
        let m;
        try { m = Lib.buildSelectionMapping(sel.lib, pr.key, { variant: null, current: null, card: s.api.card(r.key) }); } catch (e) { skippedProds.push({ name: pr.display?.title || pr.name || pr.key, why: `could not be assigned (${e.message})` }); continue; }
        if (!m.variant || String(m.variant.variantId || '') === '') { skippedProds.push({ name: pr.display?.title || pr.name || pr.key, why: 'no exact Shopify variant (nothing is invented)' }); continue; }
        pairs.push({ r, pr, m });
        break;
      }
    }
    const used = pairs.length;
    return { cards, pairs, skippedCards, skippedProds, unused: Math.max(0, (sel.rows || []).length - used - skippedProds.length), total: (sel.rows || []).length, unfilled: cards.length - used };
  }
  function bkAutoMap(s) {
    if (s.picking || s.saving || L.map) return;
    s.err = ''; s.msg = '';
    const plan = bkAutoPlan(s);
    if (plan.error) { s.err = plan.error; bkRender(s); return; }
    if (!plan.pairs.length) { s.err = 'None of the products in the selected list could be assigned.'; bkRender(s); return; }
    const li = (x) => `<li>${esc(x)}</li>`;
    const rows = plan.pairs.map(({ r, pr, m }) => `<li><b>Card ${r.n}</b> ← ${esc(bkTitle(m))}<span class="sub"> · ${esc(m.variant?.sku || pr.sku ? `SKU ${m.variant?.sku || pr.sku} · ` : '')}Variant ID <code>${esc(String(m.variant.variantId))}</code></span></li>`).join('');
    let html = `<div class="sub">${plan.cards.length} empty card${plan.cards.length === 1 ? '' : 's'} eligible · ${plan.pairs.length} proposed assignment${plan.pairs.length === 1 ? '' : 's'} · ${plan.unused} Library product${plan.unused === 1 ? '' : 's'} remain unused. Products go to the empty cards in page order, in the list’s order. Existing assignments are not touched.</div>`;
    html += `<ul class="lib-auto-l" style="margin:4px 0;padding-left:18px;max-height:34vh;overflow:auto">${rows}</ul>`;
    if (plan.unfilled > 0) html += `<div class="sub">${plan.unfilled} empty card${plan.unfilled === 1 ? '' : 's'} stay empty: the list has no more usable products.</div>`;
    if (plan.skippedCards.length) html += `<div class="lib-rep-k">Cards skipped</div><ul style="margin:2px 0;padding-left:18px">${plan.skippedCards.slice(0, 20).map((c) => li(`${c.n ? `Card ${c.n}` : clipTxt(c.label || 'Card', 30)}: ${c.why}`)).join('')}</ul>`;
    if (plan.skippedProds.length) html += `<div class="lib-rep-k">Products skipped</div><ul style="margin:2px 0;padding-left:18px">${plan.skippedProds.slice(0, 20).map((c) => li(`${clipTxt(String(c.name), 40)}: ${c.why}`)).join('')}</ul>`;
    html += '<div class="sub">Apply to Draft only stages these. Adjust them with click or drag and drop, then choose Save Assignments to keep them.</div>';
    bkAsk(s, { title: 'Auto-map products', ok: 'Apply to Draft', html, run: () => {
      // Re-plan now: the page or the staged choices may have changed while the preview was open.
      const now = bkAutoPlan(s);
      if (now.error) { s.err = now.error; bkRender(s); return; }
      for (const { r, m } of now.pairs) { delete s.rowErr[r.key]; s.drafts[r.key] = m; }
      s.msg = `Staged ${now.pairs.length} assignment${now.pairs.length === 1 ? '' : 's'} (Card ${now.pairs[0].r.n}${now.pairs.length > 1 ? ` to Card ${now.pairs[now.pairs.length - 1].r.n}` : ''}). Not saved yet: choose Save Assignments to keep them.`;
      bkRender(s);
    } });
  }
  // ---- card management
  const bkRowOf = (s, key) => s.rows.find((x) => x.key === key) || null;
  function bkAfter(s, msg, err) { s.msg = msg || ''; s.err = err || ''; bkScan(s); bkRender(s); q('.lib-as-h')?.focus(); }
  function bkRemove(s, key) {
    const r = bkRowOf(s, key);
    const sv = r && s.api.savedFor(key);
    if (!r || !sv) return;
    bkAsk(s, { title: `Remove Card #${r.n}?`, ok: 'Remove Card', danger: true, html: `<p class="sub">This deletes the saved card definition${sv.mapping ? ' and its assignment and field mapping' : ''} for this page. Your Product Library, other pages and your notes are not touched, and Blueline can find this card again later.</p>${sv.mapping ? `<div class="lib-rep-k">Assignment that will be removed</div>${bkAsgText(sv.mapping)}` : '<div class="sub">It has no product assigned.</div>'}`, run: async () => { delete s.drafts[key]; delete s.removals[key]; const x = await s.api.removeCard(key); if (L.bulk === s) bkAfter(s, x.ok ? `Card #${r.n} removed.` : '', x.ok ? '' : x.msg); } });
  }
  async function bkExclude(s, key) {
    const r = bkRowOf(s, key);
    if (!r) return;
    const sv = s.api.savedFor(key);
    const go = async () => { delete s.drafts[key]; delete s.removals[key]; const x = await s.api.exclude(key); if (L.bulk === s) bkAfter(s, x.ok ? 'Marked as not a card. It will not be proposed again on this page; restore it under Excluded.' : '', x.ok ? '' : x.msg); };
    if (!sv) { await go(); return; }
    bkAsk(s, { title: `Mark Card #${r.n} as not a card?`, ok: 'Mark as not a card', danger: true, html: `<p class="sub">This card is saved. Marking it removes its saved card${sv.mapping ? ', assignment and field mapping' : ''} from this page and stops it being proposed again.</p>${sv.mapping ? bkAsgText(sv.mapping) : ''}`, run: go });
  }
  async function bkIncludeOrRestore(s, key) {
    const r = bkRowOf(s, key);
    if (r && r.excluded) { const x = await s.api.restoreExcluded(key); if (L.bulk !== s) return; bkScan(s); s.msg = x.ok ? 'Restored: it is proposed as a card again.' : ''; s.err = x.ok ? '' : x.msg; if (x.ok) s.sel = key; bkRender(s); if (x.ok) bkSelect(s, key); return; }
    s.api.include(key, true); bkScan(s); s.sel = key; bkRender(s); bkSelect(s, key);
  }
  async function bkBoundary(s, key) {
    if (s.picking || s.saving) return;
    s.err = ''; s.msg = '';
    const draft = s.drafts[key];
    const r = await bkWithoutWindow(s, () => s.api.boundary(key));
    if (L.bulk !== s) return;
    const finish = (x) => {
      if (L.bulk !== s) return;
      if (!x || !x.ok) { bkScan(s); if (x && !x.cancelled) s.err = x.msg || 'The boundary could not be changed.'; bkRender(s); return; }
      if (x.same) { s.msg = 'The boundary is unchanged.'; bkRender(s); return; }
      if (draft) { s.drafts[x.key] = draft; delete s.drafts[key]; }
      if (s.removals[key]) { s.removals[x.key] = true; delete s.removals[key]; }
      bkScan(s);
      s.msg = 'Card boundary saved. The card is now Defined; its product and fields were kept.';
      if (s.rows.some((q2) => q2.key === x.key && q2.included)) s.sel = x.key;
      bkRender(s);
      if (s.sel === x.key) bkSelect(s, x.key);
    };
    if (r && r.ok && r.needsConfirm) {
      bkAsk(s, { title: 'Some fields can’t be found in the new boundary', ok: 'Change boundary and clear those fields', danger: true, html: `<p class="sub">The product stays assigned to this card. These field assignments can’t be found inside the new boundary, so they will be cleared and can be detected again in Card Mapping: <b>${esc(r.lost.join(', '))}</b>.</p>`, run: async () => finish(await r.apply()) });
      return;
    }
    finish(r);
  }
  async function bkEditCard(s, key, draft) {
    if (s.picking || s.saving || L.map) return;
    s.err = ''; s.msg = '';
    // The individual window covers the screen: the picker steps out of the way, and everything comes back afterwards.
    s.stash = L.sel && L.sel.embedded ? L.sel : null;
    L.sel = null;
    asUnmountSel();
    const res = await s.api.edit(key, draft || null);
    if (L.bulk !== s) return;
    if (s.stash) { L.sel = s.stash; s.stash = null; } // the window never opened: put the picker back
    if (res && res.action === 'saved') { const was = !!draft; delete s.drafts[key]; delete s.removals[key]; delete s.rowErr[key]; s.msg = was ? 'Replacement approved and saved. The card is selected below.' : 'Mapping saved.'; }
    s.sel = key;
    bkResume(s);
    bkFocusRow(key, 'lib-bk-edit');
  }
  async function bkSave(s) {
    if (s.saving) return;
    const keys = bkPending(s).filter((k) => { const r = s.rows.find((x) => x.key === k); return r && !bkInfo(s, r).needsApproval; });
    if (!keys.length) return;
    s.saving = true; s.err = ''; s.msg = ''; bkRender(s);
    let ok = 0;
    let removed = 0;
    let failed = 0;
    for (const k of keys) {
      let r;
      const rm = !!s.removals[k] && !s.drafts[k];
      try { r = rm ? await s.api.removeMapping(k) : await s.api.save(k, mapClone(s.drafts[k])); if (rm && r && !r.ok) r.error = r.msg; } catch (e) { r = { ok: false, error: e.message || String(e) }; }
      if (L.bulk !== s) return;
      if (r && r.ok) { delete s.drafts[k]; delete s.removals[k]; delete s.rowErr[k]; if (rm) removed++; else ok++; } else { s.rowErr[k] = (r && r.error) || 'The assignment could not be saved.'; failed++; }
    }
    s.saving = false;
    s.msg = [ok ? `Saved ${ok} assignment${ok === 1 ? '' : 's'}.` : '', removed ? `Removed ${removed} mapping${removed === 1 ? '' : 's'}.` : ''].filter(Boolean).join(' ');
    if (failed) s.err = `${failed} assignment${failed === 1 ? ' was' : 's were'} not saved. Nothing was changed for ${failed === 1 ? 'it' : 'them'}; the choice is still waiting below.`;
    bkScan(s); bkRender(s);
  }
  function bkClick(b) {
    const s = L.bulk;
    if (!s || L.map) return;
    const key = b.dataset.key;
    switch (b.dataset.x) {
      case 'lib-bk-exlist': s.exOpen = !s.exOpen; bkRender(s); if (s.exOpen) { const cb = q('.lib-as-cbody'); if (cb) cb.scrollTop = 0; } break;
      case 'lib-bk-cancel': if (!s.saving) closeBulk({ action: 'cancel' }); break;
      case 'lib-bk-save': if (!b.disabled) bkSave(s); break;
      case 'lib-bk-select': if (key !== s.sel) bkSelect(s, key); break;
      case 'lib-bk-approve': bkEditCard(s, key, s.drafts[key]); break;
      case 'lib-bk-show': bkShow(s, key, +b.dataset.n || null); break;
      case 'lib-bk-undo': delete s.drafts[key]; delete s.removals[key]; delete s.rowErr[key]; s.sel = key; bkRender(s); bkFocusRow(key, 'lib-bk-show'); break;
      case 'lib-bk-unmap': if (!b.disabled) bkUnmap(s, key); break;
      case 'lib-bk-exclude': bkExclude(s, key); break;
      case 'lib-bk-include': bkIncludeOrRestore(s, key); break;
      case 'lib-bk-boundary': if (!b.disabled) bkBoundary(s, key); break;
      case 'lib-bk-remove': if (!b.disabled) bkRemove(s, key); break;
      case 'lib-bk-clear': if (!s.picking && !s.saving) s.api.clearCards(); break;
      case 'lib-bk-define': bkDefine(s); break;
      case 'lib-bk-find': if (!b.disabled) bkFind(s); break;
      case 'lib-bk-auto': if (!b.disabled) bkAutoMap(s); break;
      default: break;
    }
  }
  function asClick(b) {
    const s = L.bulk;
    if (!s) return;
    switch (b.dataset.x) {
      case 'lib-as-dock': asSetMode(s, b.dataset.mode); break;
      case 'lib-rep-cancel': bkConfirm(s, false); bkFocusRow(s.sel, 'lib-bk-edit'); break;
      case 'lib-rep-ok': bkConfirm(s, true); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- events

  function onClick(e) {
    if (e.target.classList?.contains('lib-repbd') && L.bulk?.confirm) { bkConfirm(L.bulk, false); bkFocusRow(L.bulk.sel, 'lib-bk-edit'); return; }
    const b = e.target.closest?.('[data-x^="lib"]');
    if (!b) return;
    const x = b.dataset.x;
    const key = b.dataset.key;
    if (x === 'lib-sel-pick' && L.dragSuppress) { L.dragSuppress = false; return; }
    if (x === 'lib-assign') { assignStart(); return; }
    if (x.startsWith('lib-bk')) { bkClick(b); return; }
    if (x.startsWith('lib-as-') || x.startsWith('lib-rep-')) { asClick(b); return; }
    if (x.startsWith('lib-sel')) { selClick(b); return; }
    if (x.startsWith('lib-el-')) { if (L.map) fieldClick(L.map, b); return; }
    if (x.startsWith('lib-map')) { mapClick(b); return; }
    if (x !== 'lib-delete' && L.confirmDelete) { L.confirmDelete = false; render(); }
    if (L.recent && key !== L.recent && x !== 'lib-copy' && x !== 'lib-prov' && !x.startsWith('lib-vv')) L.recent = null; // the highlight lasts until the next thing you do
    switch (x) {
      case 'library': openLibrary(); break;
      case 'lib-close': closeLibrary(); break;
      case 'lib-open': applyStore(); break;
      case 'lib-lists': if (L.mgr) closeMgr(); else openMgr(); break;
      case 'lib-lists-close': closeMgr(); break;
      case 'lib-new': mgrNew(); break;
      case 'lib-lm-open': mgrOpen(+b.dataset.i); break;
      case 'lib-lm-ren': L.mgr.renaming = +b.dataset.i; L.mgr.deleting = null; renderMgr(); q('[data-lib="lm-name"]')?.focus(); break;
      case 'lib-lm-ren-go': mgrRename(+b.dataset.i); break;
      case 'lib-lm-del': L.mgr.deleting = +b.dataset.i; L.mgr.renaming = null; renderMgr(); break;
      case 'lib-lm-del-go': mgrDelete(+b.dataset.i); break;
      case 'lib-lm-cancel': L.mgr.renaming = null; L.mgr.deleting = null; renderMgr(); break;
      case 'lib-confirm': confirmPick(); break;
      case 'lib-confirm-cancel': if (L.find) { L.find.pendingIdx = null; renderFind(); } break;
      case 'lib-check': doCheck(); break;
      case 'lib-add': openFind('add'); break;
      case 'lib-add-local': L.localForm = true; render(); q('[data-lib="lp-name"]').focus(); break;
      case 'lib-local-save': saveLocal(); break;
      case 'lib-local-cancel': L.localForm = false; render(); break;
      case 'lib-export': exportJson('approved'); break;
      case 'lib-export-full': exportJson('full'); break;
      case 'lib-choice-go': choiceGo(); break;
      case 'lib-choice-cancel': L.pending = null; L.confirmReplace = false; say('Import cancelled. Nothing changed.'); render(); break;
      case 'lib-delete':
        if (!L.confirmDelete) { L.confirmDelete = true; render(); setTimeout(() => { L.confirmDelete = false; render(); }, 4000); break; }
        L.confirmDelete = false;
        Lib.deleteLibrary(storage(), L.store, L.listId).then(() => { L.lib = null; L.listId = null; return loadCurrent(); }).then(() => say('List deleted. The original files were never touched.'));
        break;
      case 'lib-copy': copy(b.dataset.val, b.dataset.what); break;
      case 'lib-use': decide(key, b.dataset.src); break;
      case 'lib-undo': mutate((l) => Lib.clearDecision(l, key)); break;
      case 'lib-ident': mutate((l) => Lib.approveSubstitution(l, key)).then(() => say('Replacement approved. This variant now counts for this product.', 'ok')); break;
      case 'lib-ident-revoke': mutate((l) => Lib.revokeSubstitution(l, key)); break;
      case 'lib-custom': L.customFor = key; L.editFor = null; render(); q('[data-lib="custom"]')?.focus(); break;
      case 'lib-custom-cancel': L.customFor = null; render(); break;
      case 'lib-custom-set': {
        const c = Lib.toCents(q('[data-lib="custom"]')?.value);
        if (c === null) { say('Enter a price like 19.97.', 'bad'); break; }
        decide(key, 'custom', c);
        break;
      }
      case 'lib-edit': L.editFor = key; L.customFor = null; render(); q('[data-lib="ed-title"]')?.focus(); break;
      case 'lib-ed-save': saveEdit(key); break;
      case 'lib-ed-cancel': L.editFor = null; render(); break;
      case 'lib-ed-reset': resetField(key, b.dataset.field); break;
      case 'lib-refresh': checkOne(key); break;
      case 'lib-variants': openVariants(key); break;
      case 'lib-pick': openFind('pick', key); break;
      case 'lib-different': { const k = L.find?.key; if (k) { if (L.find.mode === 'variants') leaveVariants(k); openFind('pick', k); } break; }
      case 'lib-back-variants': if (L.find?.key) openVariants(L.find.key); break;
      case 'lib-cand': pickCandidate(key, +b.dataset.i); break;
      case 'lib-remove': mutate((l) => Lib.removeManualProduct(l, key)); break;
      case 'lib-details': if (L.expanded.has(key)) L.expanded.delete(key); else L.expanded.add(key); render(); break;
      case 'lib-cmp': if (L.cmpOpen.has(key)) L.cmpOpen.delete(key); else L.cmpOpen.add(key); render(); break;
      case 'lib-prov': L.provOpen = !L.provOpen; render(); break;
      case 'lib-vv-back': if (L.find?.step === 'review') { L.find.step = 'choose'; renderVariants(); } else leaveVariants(L.find?.key); break;
      case 'lib-vv-review': if (L.find && !b.disabled) { L.find.step = 'review'; renderVariants(); q('.lib-vv-rvb h4')?.focus(); } break;
      case 'lib-vv-tochoose': if (L.find) { L.find.step = 'choose'; renderVariants(); } break;
      case 'lib-vv-confirm': applyVariant(); break;
      case 'lib-show': L.recent = null; L.filter = L.filter === b.dataset.f ? 'all' : b.dataset.f; L.search = ''; q('[data-lib="search"]').value = ''; render(); q('.lib-list').scrollTop = 0; break;
      case 'lib-search': runFind(true); break;
      case 'lib-sku-search': runSkuSearch(); break;
      case 'lib-find-close': hideFind(); break;
      case 'lib-found': useFound(+b.dataset.i); break;
      case 'lib-found-sku': useFound(+b.dataset.i, true); break;
      default: break;
    }
  }

  function onInput(e) {
    const t = e.target;
    if (t.dataset?.lib === 'map-f') { mapEdit(t.dataset.f, t.value, true); return; }
    if (t.dataset?.lib === 'sel-q') { if (L.sel) { L.sel.q = t.value; selRenderResults(); } return; }
    if (t.dataset?.lib === 'search') { L.search = t.value; L.recent = null; render(); }
    else if (t.dataset?.lib === 'vv-filter') { if (L.find?.mode === 'variants') { L.find.filter = t.value; renderVariants(); } }
    else if (t.dataset?.lib === 'fq') { if (L.find?.mode === 'variants') { L.find.filter = t.value; renderFind(); } else scheduleLive(); }
  }
  function onChange(e) {
    const t = e.target;
    if (t.dataset?.lib === 'sel-list') { const s0 = L.sel; if (s0) { s0.q = ''; selSetList(s0, t.value).then(() => { if (L.sel === s0) selRender(); }); } return; }
    if (t.dataset?.lib === 'listsel') { const o = L.listOpts?.[+t.value]; if (o && !(L.lib && o.store === L.lib.store && o.campaign === L.lib.campaign)) { L.store = o.store; L.listId = o.campaign; loadCurrent().then(() => q('[data-lib="listsel"]')?.focus()); } return; }
    if (t.dataset?.lib === 'map-f') { mapEdit(t.dataset.f, t.value); return; }
    if (t.dataset?.lib === 'map-res') { if (L.map) { L.map.res[t.dataset.f] = t.value; mapRender(); q('.lib-map-body input[data-lib="map-res"]:checked')?.focus(); } return; }
    if (t.dataset?.lib === 'sel-v') { if (L.sel) { L.sel.vsel = t.value; selRender(); } return; }
    if (t.dataset?.lib === 'sel-res') { if (L.sel) { L.sel.res[t.dataset.f] = t.value; selRender(); q('.lib-sel > .lib-sel-body input[data-lib="sel-res"]:checked')?.focus(); } return; }
    if (t.dataset?.lib === 'file') { const f = t.files[0]; t.value = ''; handleFile(f); }
    else if (t.dataset?.lib === 'vv-radio') { if (L.find?.mode === 'variants') { L.find.selId = t.value; syncVariantSel(); } }
    else if (t.dataset?.lib === 'filter') { L.filter = t.value; L.recent = null; render(); }
    else if (t.dataset?.lib === 'storesel') {
      if (t.value === OTHER) { L.showStoreInput = true; render(); q('[data-lib="store"]').focus(); }
      else { L.showStoreInput = false; q('[data-lib="store"]').value = t.value; applyStore(); }
    } else if (t.dataset?.lib === 'store') applyStore();
  }
  function onKey(e) {
    if (!L.open) return;
    if (e.target.classList?.contains('lib-as-resize') && L.bulk) { asResizeKey(L.bulk, e); return; }
    if (L.bulk && L.bulk.confirm && e.key === 'Tab') {
      const order = [...q('.lib-rep').querySelectorAll('button:not(:disabled)')];
      const at = L.root.activeElement;
      if (order.length && (!order.includes(at) || (e.shiftKey && at === order[0]) || (!e.shiftKey && at === order[order.length - 1]))) { e.preventDefault(); (e.shiftKey ? order[order.length - 1] : order[0]).focus(); }
      return;
    }
    if (L.sel && L.sel.embedded) {
      if (e.key === 'Escape' && !L.map) {
        e.preventDefault(); e.stopPropagation();
        if (drag && drag.on) dragCancel();
        else if (L.bulk.confirm) { bkConfirm(L.bulk, false); bkFocusRow(L.bulk.sel, 'lib-bk-edit'); }
        else if (L.sel.step === 'detail') { L.sel.step = 'products'; L.sel.key = null; selRender(); } else if (!L.bulk.saving) closeBulk({ action: 'cancel' });
      }
      return;
    }
    if (L.sel) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (L.sel.step === 'detail' && !L.sel.direct) { L.sel.step = 'products'; L.sel.key = null; selRender(); } else closeSel(null); } return; }
    if (L.map) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!L.map.saving) closeMap({ action: 'cancel' }); }
      else if (e.key === 'Enter' && e.target.dataset?.lib === 'map-f') { e.preventDefault(); e.target.blur(); }
      return;
    }
    const t = e.target;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (L.find?.mode === 'variants') { if (L.find.step === 'review') { L.find.step = 'choose'; renderVariants(); } else leaveVariants(L.find.key); } else if (L.mgr) closeMgr(); else if (L.pending) { L.pending = null; render(); } else if (L.customFor || L.editFor || L.localForm) { L.customFor = null; L.editFor = null; L.localForm = false; render(); } else if (L.find) hideFind(); else closeLibrary(); return; }
    if (e.key !== 'Enter' || !t.dataset?.lib) return;
    e.preventDefault();
    if (t.dataset.lib === 'fq') runFind(true);
    else if (t.dataset.lib === 'sq') runSkuSearch();
    else if (t.dataset.lib === 'store') applyStore();
    else if (t.dataset.lib === 'lm-name') { const i = L.mgr?.renaming; if (i !== null && i !== undefined) mgrRename(i); }
    else if (t.dataset.lib === 'custom') { const c = Lib.toCents(t.value); if (c === null) say('Enter a price like 19.97.', 'bad'); else decide(L.customFor, 'custom', c); }
    else if (t.dataset.lib.startsWith('ed-') && L.editFor) saveEdit(L.editFor);
  }

  async function openLibrary(opts) {
    if (!L.root) return;
    L.open = true;
    q('[data-m="library"]').hidden = false;
    try { await init(opts && opts.existing ? { existing: true } : {}); } catch (e) { say(e.message, 'bad'); }
    if (!L.map && !L.sel && !L.mgr) q('.lib-sheet')?.focus({ preventScroll: true }); // keys (Esc) go to the window
  }
  function closeLibrary() { if (L.sel && L.sel.embedded && L.bulk && !L.map) { closeBulk({ action: 'cancel' }); return; } if (L.sel) { closeSel(null); return; } if (L.map) { closeMap({ action: 'cancel' }); return; } if (L.bulk) { closeBulk({ action: 'cancel' }); return; } closeMgr(); L.open = false; clearTimeout(liveT); liveSeq++; L.find = null; L.recent = null; L.scroll = null; if (L.root) { q('.lib-sheet').classList.remove('lib-vmode'); q('[data-m="library"]').hidden = true; q('.lib-find').hidden = true; q('.lib-modal').classList.remove('lib-drag'); } }

  function mount(root) {
    if (!root || root.querySelector('[data-m="library"]')) return;
    L.root = root;
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    const t = document.createElement('template');
    t.innerHTML = HTML.trim();
    const modal = t.content.firstElementChild;
    root.appendChild(modal);
    const acts = root.querySelector('[data-d="aids"] .acts');
    const btn = document.createElement('template');
    btn.innerHTML = '<button class="act" data-x="library" title="Upload a product list (CSV, JSON or DOCX). A Shopify store is optional."><b>Import Product List</b><span>Upload a list; optionally verify it in Shopify</span></button>';
    acts?.insertBefore(btn.content.firstElementChild, acts.firstChild);
    BL.toolsApi?.makeDraggable?.(root.querySelector('.lib-sheet'), root.querySelector('.lib-sheet header'), { translate: true });
    root.addEventListener('pointerdown', (e) => { if (L.bulk && e.target.closest?.('.lib-as-resize')) asResizeStart(L.bulk, e); else onDragDown(e); });
    root.addEventListener('dragstart', (e) => { if (L.bulk) e.preventDefault(); });
    root.querySelector('.lib-sheet header')?.addEventListener('pointerup', () => setTimeout(asKeepVisible, 0));
    if (globalThis.ResizeObserver) {
      new ResizeObserver(() => {
        const b = L.bulk;
        if (!b) return;
        asNarrow(b);
        const a = asPrefs();
        const sh = q('.lib-sheet');
        if (a.mode === 'float' && !L.asSetting && sh && q('.lib-modal').classList.contains('lib-adock')) { const r = sh.getBoundingClientRect(); if (r.width > 100) { a.float.w = Math.round(r.width); a.float.h = Math.round(r.height); asSave(); } }
      }).observe(root.querySelector('.lib-sheet'));
    }
    window.addEventListener('resize', () => { if (L.bulk) { asApply(L.bulk); asKeepVisible(); } });
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', onKey, true);
    // A dropped file must be imported here, never opened by the browser (which would leave the page).
    for (const ev of ['dragenter', 'dragover', 'dragleave']) modal.addEventListener(ev, onDrag);
    modal.addEventListener('drop', onDrop);
  }

  // Blueline builds its panel when it is switched on; mount into it each time, and now if it already exists.
  const prevMount = BL.hooks.onMount;
  const prevUnmount = BL.hooks.onUnmount;
  BL.hooks.onMount = (root) => { prevMount?.(root); mount(root); };
  BL.hooks.onUnmount = () => { if (L.bulk) closeBulk({ action: 'cancel' }); if (L.sel) { const r = L.sel.resolve; L.sel = null; r(null); } if (L.map) { const m = L.map; L.map = null; try { m.opts.onPending?.(null, m.saved); } catch { /* ignore */ } m.resolve({ action: 'cancel', saved: m.saved }); } L.open = false; L.root = null; L.find = null; clearTimeout(liveT); prevUnmount?.(); };
  if (S.ui) mount(S.ui.root);

  async function openManager() { await openLibrary({ existing: true }); await openMgr(); q('.lib-mgr-head h3')?.focus(); } // keys (Esc) go to the window
  // After "Reset all Blueline work": whatever list the window had cached is dropped; the next open reads storage again.
  function afterReset() { L.lib = null; L.rows = []; L.listId = null; L.store = ''; L.pending = null; L.find = null; }
  function refreshWorkspace() { const s = L.bulk; if (s) { s.drafts = {}; s.removals = {}; s.rowErr = {}; s.sel = null; s.msg = 'Cleared. Press Define Product Card to start again.'; bkScan(s); bkRender(s); } }
  BL.libraryUi = { refreshWorkspace, afterReset, fmtSize, L, selectProduct, openMapping, openAssign, openCards: openAssign, assignStart, openManager, open: openLibrary, close: closeLibrary, importFile: handleFile, exportJson, check: doCheck, render, fetchJson };
})();
