// Optional live-site sanity sweep (needs network; results change as sites change; not part of npm test).
// For every visible text element on each page, compares the browser's raw hit target at the text's
// centre with Blueline's pointTarget, and times pointTarget.
//
// Usage: npm run sweep -- <url> [<url> ...]
//        node sweep.mjs <url> [<url> ...]        (EXT_DIR=<dir> to test another copy of the extension)
import { launch } from './cdp.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(process.env.EXT_DIR || join(here, '..'));
const urls = process.argv.slice(2);
if (!urls.length) { console.error('Usage: node sweep.mjs <url> [<url> ...]'); process.exit(2); }
const CHROME = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p));
if (!CHROME) { console.error('Chrome not found. Set CHROME_PATH.'); process.exit(2); }
const src = (f) => readFileSync(join(ext, f), 'utf8');
const STUB = `window.chrome = { runtime: { getManifest: () => ({ version: 'test' }), sendMessage: async (m) => (m && m.type === 'blueline:hello' ? { active: true } : null), onMessage: { addListener() {} } }, storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {} } } };`;

const browser = await launch({ executablePath: CHROME });
for (const url of urls) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  try { await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 }); } catch (e) { console.log(`${url}: load issue (${e.message}), continuing`); }
  await page.evaluate(STUB);
  for (const f of ['page-hook.js', 'content.js', 'tools.js']) await page.evaluate(src(f));
  await page.waitForFunction(() => window.__BL?.toolsApi?.pointTarget && window.__BL.S.ui, { timeout: 10000 });
  const rep = await page.evaluate(async () => {
    const pt = __BL.toolsApi.pointTarget;
    const host = __BL.S.ui.host;
    const own = (e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 2);
    const lab = (e) => (e ? e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '') : 'null');
    const out = { checked: 0, before: 0, now: 0, gained: new Set(), lost: new Set(), times: [] };
    for (let y = 0; y < Math.min(document.documentElement.scrollHeight, 9000); y += 800) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
      for (const el of document.querySelectorAll('body *')) {
        if (host.contains(el) || !own(el) || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        const rg = document.createRange(); rg.selectNodeContents(el); const r = rg.getBoundingClientRect();
        if (r.width < 4 || r.height < 4 || r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) continue;
        const x = r.left + r.width / 2; const yy = r.top + r.height / 2;
        const old = document.elementFromPoint(x, yy);
        if (!old || host.contains(old)) continue;
        const t0 = performance.now(); const now = pt(x, yy); out.times.push(performance.now() - t0);
        const ok = (e) => !!e && (e === el || el.contains(e));
        out.checked++; if (ok(old)) out.before++; if (ok(now)) out.now++;
        if (!ok(old) && ok(now) && out.gained.size < 10) out.gained.add(`${lab(el)} (was ${lab(old)})`);
        if (ok(old) && !ok(now) && out.lost.size < 10) out.lost.add(`${lab(el)} (now ${lab(now)})`);
      }
    }
    const t = out.times.sort((a, b) => a - b);
    return { checked: out.checked, before: out.before, now: out.now, gained: [...out.gained], lost: [...out.lost], ms: { median: +t[t.length >> 1].toFixed(2), max: +t[t.length - 1].toFixed(2) } };
  });
  console.log(`\n${url}\n  visible text checked: ${rep.checked}; targeted correctly by raw hit: ${rep.before}; by Blueline: ${rep.now}; pointTarget ms median ${rep.ms.median}, max ${rep.ms.max}`);
  if (rep.gained.length) console.log('  now correct (sample):\n    ' + rep.gained.join('\n    '));
  console.log('  now wrong where the raw hit was right: ' + (rep.lost.length ? '\n    ' + rep.lost.join('\n    ') : 'none'));
  console.log('  (review "now correct" samples by eye: text hidden under a solid layer is correctly left unselected.)');
  await page.close();
}
await browser.close();
