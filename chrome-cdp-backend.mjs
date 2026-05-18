import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import net from 'node:net';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findExecutableInPath(names) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await pathExists(candidate)) return candidate;
    }
  }
  return null;
}

export async function findChromeExecutable(explicitPath = null) {
  const requested = String(explicitPath || '').trim();
  if (requested) {
    if (await pathExists(requested)) return requested;
    throw new Error(`chrome_binary_not_found:${requested}`);
  }

  const mac = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ];
  const win = [
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData\\Local'), 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe')
  ];
  for (const candidate of process.platform === 'darwin' ? mac : process.platform === 'win32' ? win : []) {
    if (await pathExists(candidate)) return candidate;
  }

  const names =
    process.platform === 'win32'
      ? ['chrome.exe', 'msedge.exe', 'brave.exe']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge'];
  const fromPath = await findExecutableInPath(names);
  if (fromPath) return fromPath;
  throw new Error('chrome_binary_not_found');
}

function defaultChromeUserDataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  return path.join(os.homedir(), '.config', 'google-chrome');
}

async function readJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`cdp_http_${response.status}`);
  return await response.json();
}

function canListenOnPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

function modifierMask(modifiers = []) {
  let mask = 0;
  for (const modifier of modifiers) {
    const key = String(modifier || '').toLowerCase();
    if (key === 'alt') mask |= 1;
    else if (key === 'control') mask |= 2;
    else if (key === 'meta') mask |= 4;
    else if (key === 'shift') mask |= 8;
  }
  return mask;
}

function keyDescriptor(key) {
  const raw = String(key || '');
  if (/^[a-z]$/i.test(raw)) {
    const upper = raw.toUpperCase();
    return { key: upper, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), nativeVirtualKeyCode: upper.charCodeAt(0) };
  }
  const known = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
  };
  return known[raw] || { key: raw, code: raw, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 };
}

function reusableTargetMatches(targetUrl, requestedUrl) {
  const current = String(targetUrl || '').trim();
  const requested = String(requestedUrl || '').trim() || 'about:blank';
  if (!current || current === 'about:blank') return requested === 'about:blank';
  try {
    const currentUrl = new URL(current);
    const wantUrl = new URL(requested);
    return currentUrl.origin === wantUrl.origin;
  } catch {
    return current === requested;
  }
}

class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.connected = false;
  }

  async connect() {
    if (this.connected && this.ws) return;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error('chrome_cdp_connect_failed'));
      };
      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        this.connected = true;
        resolve();
      }, { once: true });
      ws.addEventListener('error', fail, { once: true });
      ws.addEventListener('message', (event) => this.#handleMessage(event));
      ws.addEventListener('close', () => {
        this.connected = false;
        this.ws = null;
        this.#rejectPending(new Error('chrome_cdp_disconnected'));
      });
    });
  }

  async close() {
    try {
      this.ws?.close?.();
    } catch {}
    this.ws = null;
    this.connected = false;
    this.#rejectPending(new Error('chrome_cdp_disconnected'));
  }

  on(method, handler) {
    const list = this.listeners.get(method) || [];
    list.push(handler);
    this.listeners.set(method, list);
    return () => {
      const next = (this.listeners.get(method) || []).filter((item) => item !== handler);
      if (next.length) this.listeners.set(method, next);
      else this.listeners.delete(method);
    };
  }

  async send(method, params = {}, sessionId = undefined) {
    await this.connect();
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  #handleMessage(event) {
    let msg;
    try {
      msg = JSON.parse(String(event.data || '{}'));
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const error = new Error(String(msg.error.message || 'cdp_error'));
        error.data = msg.error;
        pending.reject(error);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    for (const handler of this.listeners.get(String(msg.method || '')) || []) {
      try {
        handler(msg.params || {}, msg.sessionId || null);
      } catch {}
    }
  }

  #rejectPending(error) {
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const item of pending) item.reject(error);
  }
}

class ChromePageAdapter {
  constructor({ client, targetId, sessionId, windowId = null }) {
    this.client = client;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.windowId = windowId;
    this.closed = false;
    this.minimized = false;
  }

  async initialize({ userAgent } = {}) {
    await this.client.send('Page.enable', {}, this.sessionId);
    await this.client.send('Runtime.enable', {}, this.sessionId);
    await this.client.send('DOM.enable', {}, this.sessionId);
    await this.client.send('Network.enable', {}, this.sessionId).catch(() => {});
    await this.client.send('Emulation.setLocaleOverride', { locale: 'en-US' }, this.sessionId).catch(() => {});
    await this.client.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } }, this.sessionId).catch(() => {});
    const localeScript = [
      "try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}",
      "try { Object.defineProperty(navigator, 'language', { get: () => 'en-US' }); } catch {}",
      "try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch {}"
    ].join('\n');
    await this.client.send('Page.addScriptToEvaluateOnNewDocument', { source: localeScript }, this.sessionId);
    if (userAgent) {
      await this.client.send('Network.setUserAgentOverride', { userAgent, acceptLanguage: 'en-US,en;q=0.9' }, this.sessionId).catch(() => {});
    }
  }

  isClosed() {
    return this.closed;
  }

  markClosed() {
    this.closed = true;
  }

  async navigate(url) {
    await this.client.send('Page.navigate', { url }, this.sessionId);
  }

  async evaluate(js) {
    const result = await this.client.send('Runtime.evaluate', { expression: String(js || ''), awaitPromise: true, returnByValue: true }, this.sessionId);
    return result?.result?.value;
  }

  async getUrl() {
    const value = await this.evaluate('location.href');
    return String(value || '');
  }

  async sendKey(key, { modifiers = [] } = {}) {
    const desc = keyDescriptor(key);
    const modifiersMask = modifierMask(modifiers);
    await this.client.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: modifiersMask, ...desc }, this.sessionId);
    await this.client.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: modifiersMask, ...desc }, this.sessionId);
  }

  async insertText(text) {
    await this.client.send('Input.insertText', { text: String(text || '') }, this.sessionId);
  }

  async moveMouse(x, y) {
    await this.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, this.sessionId);
  }

  async mouseDown(x, y, { button = 'left', clickCount = 1 } = {}) {
    await this.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount }, this.sessionId);
  }

  async mouseUp(x, y, { button = 'left', clickCount = 1 } = {}) {
    await this.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount }, this.sessionId);
  }

  async setFileInputFiles(files) {
    let found = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      const { root } = await this.client.send('DOM.getDocument', { depth: 12, pierce: true }, this.sessionId);
      const q = await this.client.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type="file"]' }, this.sessionId);
      const nodeIds = Array.isArray(q?.nodeIds) ? q.nodeIds : [];
      found = nodeIds.length;
      for (const nodeId of [...nodeIds].reverse()) {
        try {
          await this.client.send('DOM.setFileInputFiles', { nodeId, files }, this.sessionId);
          return;
        } catch {}
      }
      await sleep(180);
    }
    const err = new Error('missing_file_input');
    err.data = { selector: 'input[type=file]', found };
    throw err;
  }

  async setDownloadPath(downloadPath) {
    const targetPath = path.resolve(String(downloadPath || ''));
    await fs.mkdir(targetPath, { recursive: true });
    try {
      await this.client.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: targetPath,
        eventsEnabled: true
      });
      return { ok: true, scope: 'browser', downloadPath: targetPath };
    } catch {
      await this.client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: targetPath
      }, this.sessionId);
      return { ok: true, scope: 'page', downloadPath: targetPath };
    }
  }

  async bringToFront() {
    await this.client.send('Page.bringToFront', {}, this.sessionId).catch(() => {});
    if (this.windowId != null) {
      await this.client.send('Browser.setWindowBounds', { windowId: this.windowId, bounds: { windowState: 'normal' } }).catch(() => {});
      this.minimized = false;
    }
  }

  async minimize() {
    if (this.windowId == null) return false;
    await this.client.send('Browser.setWindowBounds', { windowId: this.windowId, bounds: { windowState: 'minimized' } }).catch(() => {});
    this.minimized = true;
    return true;
  }

  async refreshWindowState() {
    if (this.windowId == null) return this.minimized;
    try {
      const out = await this.client.send('Browser.getWindowBounds', { windowId: this.windowId });
      const state = String(out?.bounds?.windowState || '').toLowerCase();
      if (state) this.minimized = state === 'minimized';
    } catch {}
    return this.minimized;
  }

  async close() {
    if (this.closed) return;
    await this.client.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
    this.closed = true;
  }
}

class ChromePresenter {
  constructor(page) {
    this.page = page;
  }

  isClosed() { return this.page.isClosed(); }
  isMinimized() {
    void this.page.refreshWindowState();
    return this.page.minimized;
  }
  restore() { return this.page.bringToFront(); }
  show() { return this.page.bringToFront(); }
  focus() { return this.page.bringToFront(); }
  minimize() { return this.page.minimize(); }
  isVisible() {
    void this.page.refreshWindowState();
    return !this.page.isClosed() && !this.page.minimized;
  }
  close() { return this.page.close(); }
}

export class ChromeCdpBrowserBackend {
  constructor({ stateDir, userAgent, onChanged, executablePath = null, debugPort = 9222, profileMode = 'agentify', profileName = 'Default' } = {}) {
    this.stateDir = stateDir;
    this.userAgent = typeof userAgent === 'string' && userAgent.trim() ? userAgent.trim() : null;
    this.onChanged = typeof onChanged === 'function' ? onChanged : null;
    this.executablePath = executablePath;
    this.debugPort = Math.floor(Number(debugPort)) || 9222;
    const requestedProfileMode = String(profileMode || '').trim().toLowerCase();
    this.profileMode =
      requestedProfileMode === 'existing' || requestedProfileMode === 'attach' || requestedProfileMode === 'isolated'
        ? requestedProfileMode
        : 'agentify';
    this.profileName = String(profileName || '').trim() || 'Default';
    this.chromeUserDataDir =
      this.profileMode === 'attach'
        ? null
        : this.profileMode === 'existing'
          ? defaultChromeUserDataDir()
          : path.join(this.stateDir, 'chrome-user-data');
    this.chromeProcess = null;
    this.client = null;
    this.started = false;
    this.tabClosers = new Map();
    this.unlistenTargetDestroyed = null;
  }

  async start() {
    if (this.started && this.client?.connected) return this.getState();
    if (this.profileMode === 'attach') {
      const version = await readJson(`http://127.0.0.1:${this.debugPort}/json/version`).catch(() => null);
      if (!version?.webSocketDebuggerUrl) throw new Error('chrome_cdp_attach_unavailable');
      this.client = new CdpConnection(String(version.webSocketDebuggerUrl));
      await this.client.connect();
      this.unlistenTargetDestroyed = this.client.on('Target.targetDestroyed', ({ targetId }) => {
        const closer = this.tabClosers.get(String(targetId || ''));
        if (!closer) return;
        this.tabClosers.delete(String(targetId || ''));
        closer();
        this.onChanged?.();
      });
      this.started = true;
      return this.getState();
    }
    if (this.profileMode === 'isolated' || this.profileMode === 'agentify') await fs.mkdir(this.chromeUserDataDir, { recursive: true });
    else if (!(await pathExists(this.chromeUserDataDir))) throw new Error('existing_chrome_profile_not_found');

    let port = this.debugPort;
    for (let i = 0; i < 40; i++) {
      if (await canListenOnPort(port)) break;
      port += 1;
    }
    if (!(await canListenOnPort(port))) throw new Error('chrome_debug_port_unavailable');
    this.debugPort = port;

    const executable = await findChromeExecutable(this.executablePath);
    const args = [
      `--remote-debugging-port=${this.debugPort}`,
      `--user-data-dir=${this.chromeUserDataDir}`,
      `--profile-directory=${this.profileName}`,
      '--lang=en-US',
      '--accept-lang=en-US,en',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--disable-sync',
      'about:blank'
    ];
    this.chromeProcess = spawn(executable, args, { stdio: 'ignore', shell: process.platform === 'win32' });
    this.chromeProcess.unref?.();

    let version = null;
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      try {
        version = await readJson(`http://127.0.0.1:${this.debugPort}/json/version`);
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!version?.webSocketDebuggerUrl) throw new Error('chrome_cdp_unavailable');

    this.client = new CdpConnection(String(version.webSocketDebuggerUrl));
    await this.client.connect();
    this.unlistenTargetDestroyed = this.client.on('Target.targetDestroyed', ({ targetId }) => {
      const closer = this.tabClosers.get(String(targetId || ''));
      if (!closer) return;
      this.tabClosers.delete(String(targetId || ''));
      closer();
      this.onChanged?.();
    });
    this.started = true;
    return this.getState();
  }

  getState() {
    return {
      kind: 'chrome-cdp',
      debugPort: this.debugPort,
      profileMode: this.profileMode,
      profileName: this.profileName,
      userDataDir: this.chromeUserDataDir
    };
  }

  setQuitting() {}

  async #findReusableTarget(url) {
    const targets = await this.client.send('Target.getTargets').catch(() => null);
    const list = Array.isArray(targets?.targetInfos) ? targets.targetInfos : [];
    return list.find((target) => {
      return target?.type === 'page' && reusableTargetMatches(target.url, url);
    }) || null;
  }

  async createSession({ url, show = false, newWindow = false, reuseExisting = false, onClosed } = {}) {
    if (!this.started) await this.start();
    const reusableTarget = reuseExisting && !newWindow ? await this.#findReusableTarget(url) : null;
    const created = reusableTarget ? null : await this.client.send('Target.createTarget', { url: url || 'about:blank', newWindow: !!newWindow });
    const targetId = String(reusableTarget?.targetId || created?.targetId || '');
    if (!targetId) throw new Error('chrome_cdp_missing_target');
    const attached = await this.client.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = String(attached?.sessionId || '');
    if (!sessionId) throw new Error('chrome_cdp_missing_session');
    let windowId = null;
    try {
      const bounds = await this.client.send('Browser.getWindowForTarget', { targetId });
      windowId = bounds?.windowId ?? null;
    } catch {}
    const page = new ChromePageAdapter({ client: this.client, targetId, sessionId, windowId });
    await page.initialize({ userAgent: this.userAgent });
    if (show) await page.bringToFront();
    this.tabClosers.set(targetId, () => {
      page.markClosed();
      onClosed?.();
    });
    this.onChanged?.();
    return {
      page,
      presenter: new ChromePresenter(page),
      isClosed: () => page.isClosed(),
      close: async () => {
        this.tabClosers.delete(targetId);
        await page.close();
        onClosed?.();
      }
    };
  }

  async dispose() {
    try {
      this.unlistenTargetDestroyed?.();
    } catch {}
    this.unlistenTargetDestroyed = null;
    await this.client?.close?.().catch(() => {});
    this.client = null;
    this.started = false;
    if (this.chromeProcess && !this.chromeProcess.killed) {
      try {
        this.chromeProcess.kill('SIGTERM');
      } catch {}
    }
    this.chromeProcess = null;
  }
}
