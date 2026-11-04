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
      <div class="lib-cfg">
        <div class="lib-nm">
          <label class="lib-lsel">List: <select class="lib-listsel" data-lib="listsel" aria-label="List"></select></label>
          <button class="lib-tg lib-manage" data-x="lib-lists" aria-expanded="false" title="Open the list manager">Manage lists</button>
        </div>
        <div class="lib-storebox">
          <label>Shopify store <small>(optional · only used to verify products)</small>
            <select data-lib="storesel" aria-label="Saved Shopify stores" hidden></select>
            <input class="lib-store" data-lib="store" placeholder="https://your-store.com" autocomplete="off" spellcheck="false" aria-label="Shopify store address (optional)"></label>
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
    </div></div>`;

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
    if (L.map) { L.open = true; if (L.root) { q('.lib-sheet').classList.remove('lib-smode'); q('.lib-head').textContent = 'Product Mapping'; } s.resolve(result || null); return; }
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
      const want = (cur?.list && find(cur.list.store || '', cur.list.id)) || (act && find(act.store, act.campaign)) || s.lists[0] || null;
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
    const body = q('.lib-sel-body');
    const foot = q('.lib-sel-foot');
    const back = q('[data-x="lib-sel-back"]');
    const forCard = s.card ? `${s.card.index && s.card.count ? `card ${s.card.index} of ${s.card.count}` : 'the card'}${s.card.section?.heading ? ` in “${s.card.section.heading}”` : ''}` : 'the card';
    back.hidden = !(s.step === 'detail' && !s.direct);
    if (s.busy) { h.textContent = 'Choose a product'; sub.textContent = ''; body.innerHTML = '<div class="sub">Loading the Product Library…</div>'; foot.innerHTML = '<button class="xb" data-x="lib-sel-cancel">Cancel</button>'; return; }
    if (s.step === 'products' || !s.key) {
      h.textContent = 'Choose a product'; sub.textContent = `For ${forCard}. Nothing in the Library changes.`;
      const opts = s.lists.map((l) => `<option value="${esc(`${l.store}|${l.campaign}`)}"${`${l.store}|${l.campaign}` === s.listKey ? ' selected' : ''}>${esc(l.name)}${l.store ? ` · ${esc(host(l.store))}` : ''}</option>`).join('');
      body.innerHTML = s.lists.length
        ? `${s.msg && !s.lib ? `<div class="lib-vv-notice">${esc(s.msg)}</div>` : ''}<div class="lib-sel-ctl"><label>Product Library list<select data-lib="sel-list" aria-label="Product Library list">${opts}</select></label><label>Search<input data-lib="sel-q" placeholder="Product name, SKU or flavor" aria-label="Search products" value="${esc(s.q)}" autocomplete="off"></label></div>${s.msg && s.lib ? `<div class="sub">${esc(s.msg)}</div>` : ''}<div class="lib-sel-results" role="list"></div>`
        : `<div class="lib-vv-notice">${esc(s.msg)}</div>`;
      selRenderResults();
      foot.innerHTML = '<button class="xb" data-x="lib-sel-cancel">Cancel</button>';
      return;
    }
    const row = selRow(s);
    const prev = selPreview(s);
    if (!row || !prev) { body.innerHTML = '<div class="lib-vv-notice">That product isn’t available. Go back and choose another.</div>'; foot.innerHTML = '<button class="xb" data-x="lib-sel-cancel">Cancel</button>'; return; }
    const keepFocus = L.root.activeElement?.dataset?.lib === 'sel-v' ? L.root.activeElement.value : null;
    h.textContent = s.mode === 'variant' ? 'Choose a variant' : s.mode === 'approve' ? 'Approve replacement' : 'Review the product';
    sub.textContent = `For ${forCard}. Nothing in the Library changes.`;
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
    if (keepFocus) q('.lib-sel-body input[data-lib="sel-v"]:checked')?.focus();
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
      return `<button class="lib-sel-row" role="listitem" data-x="lib-sel-pick" data-key="${esc(r.key)}"${isCur ? ' data-cur="1"' : ''}>${thumb(r.display?.image)}<span><b>${esc(r.display?.title || r.name || r.sku || r.key)}</b><span>${r.sku ? `SKU ${esc(r.sku)} · ` : ''}${Number.isInteger(c) ? esc(Lib.fmt(c, p.currency)) : 'no price'}${r.variant?.variantTitle ? ` · ${esc(r.variant.variantTitle)}` : ''}</span></span><span class="lib-badges" style="flex:none"><span class="lib-badge ${tone}">${esc(text)}</span></span></button>`;
    }).join('') + (s.rows.length > rows.length && !s.q ? `<div class="sub">Showing ${rows.length} of ${s.rows.length}. Type to narrow it down.</div>` : '');
  }
  function selUse() {
    const s = L.sel;
    if (!s) return;
    const prev = selPreview(s);
    if (!prev) return;
    try {
      const mapping = Lib.buildSelectionMapping(s.lib, s.key, { variant: selVariant(s), current: s.current, card: s.card, approve: !s.defer && Lib.replacementPending(prev), resolutions: s.res });
      closeSel(mapping);
    } catch (e) { const w = q('.lib-sel-why'); if (w) w.textContent = e.message; }
  }
  function selClick(b) {
    const s = L.sel;
    if (!s) return;
    switch (b.dataset.x) {
      case 'lib-sel-pick': selOpenProduct(s, b.dataset.key, false).then(() => q('.lib-sel-h')?.focus()); break;
      case 'lib-sel-back': s.step = 'products'; s.key = null; selRender(); break;
      case 'lib-sel-cancel': closeSel(null); break;
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
      const s = { resolve, opts, saved, draft: saved ? mapClone(saved) : null, card: opts.card || null, res: {}, ferr: {}, err: '', saving: false, shop: null, shopBusy: false, adoptBusy: false };
      L.map = s;
      L.open = true;
      q('[data-m="library"]').hidden = false;
      q('.lib-sheet').classList.add('lib-pmode', 'lib-full');
      q('.lib-head').textContent = 'Product Mapping';
      mapRender();
      q('.lib-map-h')?.focus();
      mapNotify(s);
      if (opts.autoPick) mapPick(opts.autoPick); // first mapping: go straight to choosing a product
    });
  }
  function closeMap(result) {
    const s = L.map;
    if (!s) return;
    if (L.sel) { const r = L.sel.resolve; L.sel = null; r(null); }
    L.map = null; L.open = false;
    if (L.root) { q('.lib-sheet').classList.remove('lib-pmode', 'lib-smode'); q('.lib-head').textContent = 'Product Library'; q('[data-m="library"]').hidden = true; }
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

  function mapRender(only) {
    const s = L.map;
    if (!s || !L.root) return;
    const body = q('.lib-map-body');
    const foot = q('.lib-map-foot');
    const sub = q('.lib-map-sub');
    const card = s.card;
    q('.lib-map-h').textContent = card ? `${card.index && card.count ? `Card ${card.index} of ${card.count}` : 'This card'}${card.section?.heading ? ` in “${card.section.heading}”` : ''}` : 'This card';
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

  // ---------------------------------------------------------------- events

  function onClick(e) {
    const b = e.target.closest?.('[data-x^="lib"]');
    if (!b) return;
    const x = b.dataset.x;
    const key = b.dataset.key;
    if (x.startsWith('lib-sel')) { selClick(b); return; }
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
    if (t.dataset?.lib === 'sel-res') { if (L.sel) { L.sel.res[t.dataset.f] = t.value; selRender(); q('.lib-sel-body input[data-lib="sel-res"]:checked')?.focus(); } return; }
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
  function closeLibrary() { if (L.sel) { closeSel(null); return; } if (L.map) { closeMap({ action: 'cancel' }); return; } closeMgr(); L.open = false; clearTimeout(liveT); liveSeq++; L.find = null; L.recent = null; L.scroll = null; if (L.root) { q('.lib-sheet').classList.remove('lib-vmode'); q('[data-m="library"]').hidden = true; q('.lib-find').hidden = true; q('.lib-modal').classList.remove('lib-drag'); } }

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
  BL.hooks.onUnmount = () => { if (L.sel) { const r = L.sel.resolve; L.sel = null; r(null); } if (L.map) { const m = L.map; L.map = null; try { m.opts.onPending?.(null, m.saved); } catch { /* ignore */ } m.resolve({ action: 'cancel', saved: m.saved }); } L.open = false; L.root = null; L.find = null; clearTimeout(liveT); prevUnmount?.(); };
  if (S.ui) mount(S.ui.root);

  async function openManager() { await openLibrary({ existing: true }); await openMgr(); q('.lib-mgr-head h3')?.focus(); } // keys (Esc) go to the window
  BL.libraryUi = { fmtSize, L, selectProduct, openMapping, openManager, open: openLibrary, close: closeLibrary, importFile: handleFile, exportJson, check: doCheck, render, fetchJson };
})();
