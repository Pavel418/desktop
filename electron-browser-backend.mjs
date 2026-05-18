import { BrowserWindow } from 'electron';

class ElectronPageAdapter {
  constructor(win) {
    this.win = win;
  }

  isClosed() {
    return this.win?.isDestroyed?.() || this.win?.webContents?.isDestroyed?.();
  }

  async navigate(url) {
    await this.win.loadURL(url);
  }

  async evaluate(js) {
    return await this.win.webContents.executeJavaScript(js, true);
  }

  async getUrl() {
    return this.win.webContents.getURL();
  }

  async sendKey(key, { modifiers = [] } = {}) {
    const wc = this.win.webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
    const command = Array.isArray(modifiers) && modifiers.some((m) => m === 'control' || m === 'meta' || m === 'alt');
    if (typeof key === 'string' && key.length === 1 && !command) wc.sendInputEvent({ type: 'char', keyCode: key, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
  }

  async insertText(text) {
    const value = String(text || '');
    if (!value) return;
    if (typeof this.win.webContents.insertText === 'function') return await this.win.webContents.insertText(value);
    this.win.webContents.sendInputEvent({ type: 'char', keyCode: value });
  }

  async moveMouse(x, y) {
    this.win.webContents.sendInputEvent({ type: 'mouseMove', x, y, movementX: 0, movementY: 0 });
  }

  async mouseDown(x, y, { button = 'left', clickCount = 1 } = {}) {
    this.win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount });
  }

  async mouseUp(x, y, { button = 'left', clickCount = 1 } = {}) {
    this.win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount });
  }

  async setFileInputFiles(files) {
    const wc = this.win.webContents;
    const didAttach = !wc.debugger.isAttached();
    try {
      if (didAttach) wc.debugger.attach('1.3');
    } catch {
      const err = new Error('file_upload_unavailable');
      err.data = { reason: 'debugger_attach_failed' };
      throw err;
    }

    try {
      let found = 0;
      for (let attempt = 0; attempt < 10; attempt++) {
        const { root } = await wc.debugger.sendCommand('DOM.getDocument', { depth: 12, pierce: true });
        const q = await wc.debugger.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type="file"]' });
        const nodeIds = Array.isArray(q?.nodeIds) ? q.nodeIds : [];
        found = nodeIds.length;
        for (const nodeId of [...nodeIds].reverse()) {
          try {
            await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files });
            return;
          } catch {}
        }
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
      const err = new Error('missing_file_input');
      err.data = { selector: 'input[type=file]', found };
      throw err;
    } finally {
      try {
        if (didAttach && wc.debugger.isAttached()) wc.debugger.detach();
      } catch {}
    }
  }
}

class ElectronPresenter {
  constructor(win) {
    this.win = win;
  }

  isClosed() {
    return this.win?.isDestroyed?.();
  }

  isMinimized() {
    return !!this.win?.isMinimized?.();
  }

  restore() {
    if (!this.isClosed()) this.win.restore();
  }

  show() {
    if (!this.isClosed()) this.win.show();
  }

  focus() {
    if (!this.isClosed()) this.win.focus();
  }

  minimize() {
    if (!this.isClosed()) this.win.minimize();
  }

  isVisible() {
    return !!this.win?.isVisible?.();
  }

  close() {
    if (!this.isClosed()) this.win.close();
  }
}

export class ElectronBrowserBackend {
  constructor({ windowDefaults, userAgent, popupPolicy, onChanged } = {}) {
    this.windowDefaults = windowDefaults || { width: 1100, height: 800, show: false, title: 'Agentify Desktop' };
    this.userAgent = typeof userAgent === 'string' && userAgent.trim() ? userAgent.trim() : null;
    this.popupPolicy = typeof popupPolicy === 'function' ? popupPolicy : (() => false);
    this.onChanged = typeof onChanged === 'function' ? onChanged : null;
    this.windows = new Set();
    this.quitting = false;
  }

  async start() {
    return { kind: 'electron', managedProfile: true };
  }

  setQuitting(v = true) {
    this.quitting = !!v;
  }

  async createSession({ url, show = false, protectedTab = false, vendorId = null, vendorName = null, onClosed } = {}) {
    let forceClose = false;
    const win = new BrowserWindow({
      ...this.windowDefaults,
      show: !!show,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        ...(this.windowDefaults.webPreferences || {})
      }
    });
    this.windows.add(win);
    if (this.userAgent) {
      try {
        win.webContents.setUserAgent(this.userAgent);
      } catch {}
    }
    win.webContents.setWindowOpenHandler((details) => {
      const openerUrl = String(details?.referrer?.url || win.webContents.getURL?.() || url || '');
      const allow = this.popupPolicy({ url: details?.url || '', frameName: details?.frameName || '', disposition: details?.disposition || '', openerUrl, vendorId: vendorId || 'chatgpt' });
      return allow ? { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 760, show: true, title: 'Agentify Desktop - Sign in' } } : { action: 'deny' };
    });
    const fixedTitle = `Agentify Desktop${vendorName ? ` - ${vendorName}` : ''}`;
    try {
      win.setTitle(fixedTitle);
      win.on('page-title-updated', (event) => {
        event.preventDefault();
        win.setTitle(fixedTitle);
      });
    } catch {}
    win.on('closed', () => {
      this.windows.delete(win);
      onClosed?.();
      this.onChanged?.();
    });
    win.on('close', (event) => {
      if (this.quitting || forceClose || !protectedTab) return;
      event.preventDefault();
      if (!win.isMinimized()) win.minimize();
    });
    await win.loadURL(url);
    this.onChanged?.();
    return {
      page: new ElectronPageAdapter(win),
      presenter: new ElectronPresenter(win),
      isClosed: () => win.isDestroyed?.() || win.webContents?.isDestroyed?.(),
      close: async () => {
        forceClose = true;
        this.windows.delete(win);
        try {
          win.close();
        } catch {}
      }
    };
  }

  async dispose() {
    this.quitting = true;
    const wins = Array.from(this.windows);
    this.windows.clear();
    for (const win of wins) {
      try {
        if (!win?.isDestroyed?.()) win.close();
      } catch {}
    }
  }
}
