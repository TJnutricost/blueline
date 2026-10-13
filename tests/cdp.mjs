// Minimal Chrome driver over the DevTools protocol, using Node's built-in WebSocket (Node 22+).
// It offers only what the Blueline tests need (pages, evaluate, real mouse and keyboard input), so the
// tests have no npm dependencies and nothing is installed inside the extension folder. (Chrome refuses
// to load an unpacked extension that contains any file or folder whose name starts with "_".)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Connection {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map(); // sessionId -> fn(method, params)
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ''}`)); else resolve(msg.result);
      } else if (msg.method) this.listeners.get(msg.sessionId || '')?.(msg.method, msg.params);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const MOD = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const KEYS = {
  Shift: { code: 'ShiftLeft', vk: 16 }, Control: { code: 'ControlLeft', vk: 17 }, Alt: { code: 'AltLeft', vk: 18 }, Meta: { code: 'MetaLeft', vk: 91 },
  Escape: { code: 'Escape', vk: 27 }, Enter: { code: 'Enter', vk: 13, text: '\r' },
};
const keyInfo = (key) => KEYS[key] || (key.length === 1 ? { code: /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : '', vk: key.toUpperCase().charCodeAt(0), text: key } : { code: key, vk: 0 });

class Page {
  constructor(conn, sessionId, targetId) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.errors = [];
    this.waiters = [];
    this.mods = 0;
    this.pos = { x: 0, y: 0 };
    this.buttons = 0;
    conn.listeners.set(sessionId, (method, params) => {
      if (method === 'Runtime.exceptionThrown') this.errors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'error');
      this.waiters = this.waiters.filter((w) => !(w.method === method && (w.resolve(params), true)));
    });
    const page = this;
    this.mouse = {
      async move(x, y, { steps = 1 } = {}) {
        const from = { ...page.pos };
        for (let i = 1; i <= steps; i++) {
          page.pos = { x: from.x + ((x - from.x) * i) / steps, y: from.y + ((y - from.y) * i) / steps };
          await page.input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...page.pos, button: page.buttons ? 'left' : 'none', buttons: page.buttons, modifiers: page.mods });
        }
      },
      async down() { page.buttons = 1; await page.input('Input.dispatchMouseEvent', { type: 'mousePressed', ...page.pos, button: 'left', buttons: 1, clickCount: 1, modifiers: page.mods }); },
      async up() { page.buttons = 0; await page.input('Input.dispatchMouseEvent', { type: 'mouseReleased', ...page.pos, button: 'left', buttons: 0, clickCount: 1, modifiers: page.mods }); },
      async click(x, y) { await this.move(x, y); await this.down(); await this.up(); },
    };
    this.keyboard = {
      async down(key) {
        const k = keyInfo(key);
        if (MOD[key]) page.mods |= MOD[key];
        const text = k.text && !(page.mods & (MOD.Control | MOD.Meta)) ? k.text : undefined;
        await page.input('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers: page.mods, ...(text ? { text } : {}) });
      },
      async up(key) {
        const k = keyInfo(key);
        if (MOD[key]) page.mods &= ~MOD[key];
        await page.input('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers: page.mods });
      },
      async press(key) { await this.down(key); await this.up(key); },
    };
  }
  send(method, params) { return this.conn.send(method, params, this.sessionId); }
  input(method, params) { return this.send(method, params); }
  waitFor(method, timeout) {
    return new Promise((resolve, reject) => {
      const w = { method, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error(`timeout waiting for ${method}`)); }, timeout);
    });
  }
  async setViewport({ width, height }) { await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); }
  // waitUntil 'networkidle' approximates puppeteer's networkidle2 with a settle delay after load.
  async goto(url, { timeout = 30000, waitUntil = 'load' } = {}) {
    const loaded = this.waitFor('Page.loadEventFired', timeout);
    await this.send('Page.navigate', { url });
    await loaded;
    if (waitUntil.startsWith('networkidle')) await sleep(1500);
  }
  async evaluate(fn, ...args) {
    const expression = typeof fn === 'function' ? `(${fn})(...${JSON.stringify(args)})` : fn;
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  addScriptTag({ content }) { return this.evaluate(content); }
  async waitForFunction(fn, { timeout = 10000 } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      if (await this.evaluate(fn).catch(() => false)) return;
      if (Date.now() > end) throw new Error('waitForFunction timed out');
      await sleep(50);
    }
  }
  async close() { await this.conn.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {}); }
}

export async function launch({ executablePath, args = [] }) {
  const profile = mkdtempSync(join(tmpdir(), 'blueline-tests-'));
  const proc = spawn(executablePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('Chrome did not start')), 20000);
    proc.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
    proc.on('exit', (code) => reject(new Error(`Chrome exited (${code})`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const conn = new Connection(ws);
  return {
    async newPage() {
      const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
      const page = new Page(conn, sessionId, targetId);
      await page.send('Page.enable');
      await page.send('Runtime.enable');
      return page;
    },
    async close() {
      await conn.send('Browser.close').catch(() => {});
      ws.close();
      await new Promise((r) => { if (proc.exitCode !== null) r(); else { proc.once('exit', r); setTimeout(() => { proc.kill(); r(); }, 3000); } });
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
