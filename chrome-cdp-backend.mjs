import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    return {
      key: upper,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      nativeVirtualKeyCode: upper.charCodeAt(0)
    };
  }

  const known = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
  };
  return known[raw] || {
    key: raw,
    code: raw,
    windowsVirtualKeyCode: 0,
    nativeVirtualKeyCode: 0
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function pathCandidatesFromEnv() {
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
}

async function findExecutableInPath(names) {
  for (const dir of pathCandidatesFromEnv()) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await pathExists(candidate)) return candidate;
    }
  }
  return null;
}

export async function findChromeExecutable(explicitPath = null) {
  const userPath = String(explicitPath || '').trim();
  if (userPath) {
    if (await pathExists(userPath)) return userPath;
    throw new Error(`chrome_binary_not_found:${userPath}`);
  }

  const platform = process.platform;
  const macCandidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ];
  const winCandidates = [
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData\\Local'), 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Chromium\\Application\\chrome.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe')
  ];

  const absoluteCandidates =
    platform === 'darwin' ? macCandidates : platform === 'win32' ? winCandidates : [];
  for (const candidate of absoluteCandidates) {
    if (await pathExists(candidate)) return candidate;
  }

  const pathNames =
    platform === 'win32'
      ? ['chrome.exe', 'msedge.exe', 'brave.exe']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge'];
  const fromPath = await findExecutableInPath(pathNames);
  if (fromPath) return fromPath;
  throw new Error('chrome_binary_not_found');
}

export function defaultChromeUserDataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  return path.join(os.homedir(), '.config', 'google-chrome');
}

// Names of cookies that are safe to delete to shrink the Cookie header. Telemetry is always
// disposable. Per-conversation temporary-chat state is disposable only when no other managed chat
// is open; deleting it underneath an active chat could invalidate that conversation.
const PRUNABLE_COOKIE_RE = /^(_dd_s|_dd_r|_dd|__cf_bm|_ga|_gid|_gat|_gcl|ajs_|amp_|amplitude|intercom-|statsig|mp_|__stripe_mid|__stripe_sid)/i;
const STALE_CONVERSATION_COOKIE_RE = /^(conv_key|history_off)_[0-9a-f-]{16,}$/i;
const KEEP_COOKIE_RE = /(session-token|clearance|csrf|__host-|__secure-next-auth|oai-did|auth)/i;

export function isPrunableCookieName(name, { includeConversationState = false } = {}) {
  const value = String(name || '');
  if (!value) return false;
  if (KEEP_COOKIE_RE.test(value)) return false;
  return PRUNABLE_COOKIE_RE.test(value) || (includeConversationState && STALE_CONVERSATION_COOKIE_RE.test(value));
}

export function buildChromeLaunchArgs({ debugPort, userDataDir, profileName = null, startUrl = 'about:blank' } = {}) {
  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-sync',
    startUrl
  ];
  const trimmedProfile = String(profileName || '').trim();
  if (trimmedProfile) args.splice(2, 0, `--profile-directory=${trimmedProfile}`);
  return args;
}

export function chromeSpawnOptions() {
  return { stdio: 'ignore' };
}

async function readJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`cdp_http_${response.status}`);
  }
  return await response.json();
}

export class ChromeCdpConnection {
  constructor(wsUrl, { wsFactory } = {}) {
    this.wsUrl = wsUrl;
    this.wsFactory = typeof wsFactory === 'function' ? wsFactory : (url) => new WebSocket(url);
    this.ws = null;
    this.connectPromise = null;
    this.connectReject = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.connected = false;
  }

  async connect() {
    if (this.connected && this.ws) return;
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }
    let syncFailed = false;
    const pendingConnect = new Promise((resolve, reject) => {
      let ws;
      try {
        ws = this.wsFactory(this.wsUrl);
        this.ws = ws;
      } catch (error) {
        syncFailed = true;
        this.connectPromise = null;
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        this.connectReject = null;
        resolve();
      };
      const settleReject = (error) => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        this.connectReject = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      this.connectReject = settleReject;
      const onOpen = () => {
        if (this.ws !== ws) return;
        this.connected = true;
        settleResolve();
      };
      const onError = (error) => {
        this.connected = false;
        if (this.ws === ws) this.ws = null;
        settleReject(error);
      };
      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });
      ws.addEventListener('message', (event) => this.#handleMessage(event));
      ws.addEventListener('close', () => {
        if (this.ws !== ws) return;
        this.connected = false;
        this.ws = null;
        this.#rejectPending(new Error('chrome_cdp_disconnected'));
        settleReject(new Error('chrome_cdp_disconnected'));
      });
    });
    this.connectPromise = syncFailed ? null : pendingConnect;
    await pendingConnect;
  }

  async close() {
    this.connectPromise = null;
    if (!this.ws) return;
    const rejectConnect = this.connectReject;
    try {
      this.ws.close();
    } catch {}
    this.ws = null;
    this.connected = false;
    rejectConnect?.(new Error('chrome_cdp_disconnected'));
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
    const response = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
    return response;
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

    const handlers = this.listeners.get(String(msg.method || '')) || [];
    for (const handler of handlers) {
      try {
        handler(msg.params || {}, msg.sessionId || null);
      } catch {}
    }
  }

  #rejectPending(error) {
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const item of pending) {
      try {
        item.reject(error);
      } catch {}
    }
  }
}

export class ChromeCdpPageAdapter {
  constructor({ client, targetId, sessionId, windowId = null }) {
    this.client = client;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.windowId = windowId;
    this.closed = false;
  }

  markClosed() {
    this.closed = true;
  }

  isClosed() {
    return this.closed;
  }

  async initialize({ userAgent } = {}) {
    await this.client.send('Page.enable', {}, this.sessionId);
    await this.client.send('Runtime.enable', {}, this.sessionId);
    await this.client.send('DOM.enable', {}, this.sessionId);
    // Needed for the top-document response status (431 detection) and cookie pruning.
    await this.client.send('Network.enable', {}, this.sessionId).catch(() => {});
    // Force the page to always render as if focused. A backgrounded/unfocused tab has its rendering
    // throttled by Chrome, which leaves ChatGPT's CodeMirror code blocks unpainted — their text
    // never enters the DOM, so reading innerText returns only the streaming fragment and the reply
    // looks permanently "stalled" at a few characters. Emulated focus keeps it painting so reads
    // reflect the real, complete reply. (Confirmed fix: unfocused innerText=19 → focused=593.)
    await this.client.send('Emulation.setFocusEmulationEnabled', { enabled: true }, this.sessionId).catch(() => {});
    await this.client.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `
          try {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          } catch {}
        `
      },
      this.sessionId
    );
    if (userAgent) {
      await this.client.send('Network.setUserAgentOverride', { userAgent }, this.sessionId).catch(() => {});
    }
  }

  async navigate(url, { pruneConversationStateOn431 = false } = {}) {
    const firstStatus = await this._navigateAndGetTopStatus(url);
    if (firstStatus !== 431) return firstStatus;

    // A reload with the same cookie jar simply repeats the oversized request. Remove disposable
    // state, perform a fresh observed navigation, and verify that the server no longer returns 431.
    await this.pruneTelemetryCookies({ includeConversationState: pruneConversationStateOn431 });
    const retryStatus = await this._navigateAndGetTopStatus(url);
    if (retryStatus === 431 || retryStatus == null) {
      const error = new Error(retryStatus === 431
        ? 'chatgpt_navigation_http_431'
        : 'chatgpt_navigation_431_recovery_unverified');
      error.statusCode = retryStatus;
      error.initialStatusCode = 431;
      error.url = url;
      throw error;
    }
    return retryStatus;
  }

  // Navigate and resolve with the top-level document's HTTP status (null if none arrives in time).
  async _navigateAndGetTopStatus(url, timeoutMs = 15000) {
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    const off = this.client.on('Network.responseReceived', (params, sessionId) => {
      if (this.sessionId && sessionId && sessionId !== this.sessionId) return;
      if (params?.type !== 'Document') return; // first main-frame document response
      off();
      settle(Number(params?.response?.status) || null);
    });
    const timer = setTimeout(() => { off(); settle(null); }, timeoutMs);
    try {
      await this.client.send('Page.navigate', { url }, this.sessionId);
    } catch (error) {
      off();
      clearTimeout(timer);
      throw error;
    }
    const status = await done;
    clearTimeout(timer);
    return status;
  }

  // Drop disposable cookies for the ChatGPT/OpenAI origins to keep the Cookie header small.
  // Authentication, CSRF, and Cloudflare clearance are always retained. Per-conversation state is
  // removed only when the caller confirms that no managed chat depends on it.
  async pruneTelemetryCookies({ includeConversationState = false } = {}) {
    let cookies = [];
    try {
      const res = await this.client.send(
        'Network.getCookies',
        { urls: ['https://chatgpt.com/', 'https://openai.com/', 'https://auth.openai.com/'] },
        this.sessionId
      );
      cookies = Array.isArray(res?.cookies) ? res.cookies : [];
    } catch {
      return 0;
    }
    let removed = 0;
    for (const cookie of cookies) {
      if (!isPrunableCookieName(cookie?.name, { includeConversationState })) continue;
      try {
        await this.client.send(
          'Network.deleteCookies',
          { name: cookie.name, domain: cookie.domain, path: cookie.path },
          this.sessionId
        );
        removed += 1;
      } catch {}
    }
    return removed;
  }

  async evaluate(js) {
    const result = await this.client.send(
      'Runtime.evaluate',
      {
        expression: String(js || ''),
        awaitPromise: true,
        returnByValue: true
      },
      this.sessionId
    );
    return result?.result?.value;
  }

  // Capture a PNG screenshot of the page as a Buffer (null on failure). Used by the stall
  // inspector to record what is actually on screen at a suspected-stall moment.
  async screenshot({ fullPage = false } = {}) {
    try {
      const res = await this.client.send(
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: !!fullPage },
        this.sessionId
      );
      return res?.data ? Buffer.from(res.data, 'base64') : null;
    } catch {
      return null;
    }
  }

  async getUrl() {
    const value = await this.evaluate('location.href');
    return String(value || '');
  }

  async sendKey(key, { modifiers = [] } = {}) {
    const desc = keyDescriptor(key);
    const mask = modifierMask(modifiers);
    await this.client.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyDown',
        modifiers: mask,
        key: desc.key,
        code: desc.code,
        windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
        nativeVirtualKeyCode: desc.nativeVirtualKeyCode
      },
      this.sessionId
    );
    await this.client.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyUp',
        modifiers: mask,
        key: desc.key,
        code: desc.code,
        windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
        nativeVirtualKeyCode: desc.nativeVirtualKeyCode
      },
      this.sessionId
    );
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
    const expectedCount = Array.isArray(files) ? files.length : 0;
    let lastFound = 0;
    const diagnostics = [];

    // Open the active composer's attachment menu.
    await this.evaluate(`(() => {
      const visible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      };

      const selectors = [
        '[data-testid="composer-plus-btn"]',
        'button[aria-label*="Attach" i]',
        'button[aria-label*="Add" i]',
        'button[aria-label*="upload" i]'
      ];

      for (const selector of selectors) {
        const button = Array.from(
          document.querySelectorAll(selector)
        ).filter(visible).at(-1);

        if (button) {
          button.click();
          return { clicked: true, selector };
        }
      }

      return { clicked: false };
    })()`).catch(() => null);

    await sleep(400);

    // ChatGPT now uses a two-step attachment UI in some builds:
    // plus button -> menu item -> file input. Select the upload-files menu
    // item before resolving the input, otherwise only stale hidden inputs may
    // exist in the document.
    await this.evaluate(`(() => {
      const visible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      };

      const candidates = Array.from(
        document.querySelectorAll(
          '[role="menuitem"], [role="option"], button, [data-testid]'
        )
      ).filter(visible);

      const uploadItem = candidates.find((node) => {
        const text = [
          node.innerText,
          node.textContent,
          node.getAttribute('aria-label'),
          node.getAttribute('data-testid')
        ].filter(Boolean).join(' ').trim();

        return /(?:upload|attach|add)\\s+(?:from\\s+computer|files?|photos?)/i.test(text) ||
          /upload[-_ ]?file/i.test(text);
      });

      if (uploadItem) {
        uploadItem.click();
        return {
          clicked: true,
          text: (
            uploadItem.innerText ||
            uploadItem.getAttribute('aria-label') ||
            uploadItem.getAttribute('data-testid') ||
            ''
          ).trim()
        };
      }

      return {
        clicked: false,
        visibleItems: candidates.slice(0, 30).map((node) => ({
          tag: node.tagName,
          text: (
            node.innerText ||
            node.getAttribute('aria-label') ||
            node.getAttribute('data-testid') ||
            ''
          ).trim().slice(0, 120)
        }))
      };
    })()`).catch(() => null);

    await sleep(500);

    for (let attempt = 0; attempt < 20; attempt++) {
      const { root } = await this.client.send(
        'DOM.getDocument',
        {
          depth: 20,
          pierce: true
        },
        this.sessionId
      );

      let activeNodeId = null;
      let activeObjectId = null;

      try {
        const active = await this.client.send(
          'Runtime.evaluate',
          {
            expression: `(() => {
              const visible = (node) => {
                if (!node) return false;
                const rect = node.getBoundingClientRect();
                const style = getComputedStyle(node);
                return rect.width > 0 &&
                  rect.height > 0 &&
                  style.visibility !== 'hidden' &&
                  style.display !== 'none';
              };

              const prompts = Array.from(
                document.querySelectorAll(
                  '#prompt-textarea, [contenteditable="true"][role="textbox"]'
                )
              );

              const prompt = prompts.filter(visible).at(-1) || null;
              const composer =
                prompt?.closest('form') ||
                prompt?.closest('[data-testid*="composer" i]') ||
                prompt?.parentElement?.parentElement ||
                null;

              const allInputs = Array.from(
                document.querySelectorAll('input[type="file"]')
              ).filter((node) => node.isConnected && !node.disabled);

              const localInputs = composer
                ? allInputs.filter((node) => composer.contains(node))
                : [];

              const ranked = [
                ...localInputs.filter((node) => node.id === 'upload-files'),
                ...localInputs.filter((node) => node.multiple),
                ...localInputs,
                ...allInputs.filter((node) => node.id === 'upload-files'),
                ...allInputs.filter((node) => node.multiple),
                ...allInputs
              ];

              return ranked.find(Boolean) || null;
            })()`,
            awaitPromise: false,
            returnByValue: false
          },
          this.sessionId
        );

        activeObjectId = active?.result?.objectId || null;

        if (activeObjectId) {
          const requested = await this.client.send(
            'DOM.requestNode',
            { objectId: activeObjectId },
            this.sessionId
          );

          if (
            Number.isFinite(requested?.nodeId) &&
            requested.nodeId > 0
          ) {
            activeNodeId = requested.nodeId;
          }
        }
      } catch {
        activeNodeId = null;
      } finally {
        if (activeObjectId) {
          await this.client.send(
            'Runtime.releaseObject',
            { objectId: activeObjectId },
            this.sessionId
          ).catch(() => {});
        }
      }

      const ordered = activeNodeId ? [activeNodeId] : [];

      for (const selector of [
        'form input[type="file"]#upload-files',
        '[data-testid*="composer" i] input[type="file"]',
        'input[type="file"]#upload-files',
        'input[type="file"][multiple]',
        'form input[type="file"]',
        'input[type="file"]'
      ]) {
        const query = await this.client.send(
          'DOM.querySelectorAll',
          {
            nodeId: root.nodeId,
            selector
          },
          this.sessionId
        );

        for (
          const nodeId of Array.isArray(query?.nodeIds)
            ? query.nodeIds
            : []
        ) {
          if (!ordered.includes(nodeId)) ordered.push(nodeId);
        }
      }

      lastFound = ordered.length;

      if (!ordered.length) {
        await sleep(300);
        continue;
      }

      for (const nodeId of ordered) {
        let objectId = null;

        try {
          const beforeResolved = await this.client.send(
            'DOM.resolveNode',
            { nodeId },
            this.sessionId
          );
          objectId = beforeResolved?.object?.objectId || null;

          let beforeDetail = null;
          if (objectId) {
            const inspected = await this.client.send(
              'Runtime.callFunctionOn',
              {
                objectId,
                functionDeclaration: `function () {
                  const composer =
                    this.closest('form') ||
                    this.closest('[data-testid*="composer" i]');
                  return {
                    connected: this.isConnected,
                    disabled: this.disabled,
                    id: this.id || null,
                    multiple: Boolean(this.multiple),
                    accept: this.accept || null,
                    insideComposer: Boolean(composer),
                    composerVisible: composer
                      ? (() => {
                          const r = composer.getBoundingClientRect();
                          const s = getComputedStyle(composer);
                          return r.width > 0 &&
                            r.height > 0 &&
                            s.display !== 'none' &&
                            s.visibility !== 'hidden';
                        })()
                      : false
                  };
                }`,
                returnByValue: true
              },
              this.sessionId
            );
            beforeDetail = inspected?.result?.value || null;
          }

          await this.client.send(
            'DOM.setFileInputFiles',
            { nodeId, files },
            this.sessionId
          );

          let verification = null;
          if (objectId) {
            verification = await this.client.send(
              'Runtime.callFunctionOn',
              {
                objectId,
                functionDeclaration: `function () {
                  return {
                    connected: this.isConnected,
                    fileCount: this.files?.length || 0,
                    names: Array.from(this.files || []).map(
                      (file) => file.name
                    )
                  };
                }`,
                returnByValue: true
              },
              this.sessionId
            );
          }

          const detail = verification?.result?.value || {};

          diagnostics.push({
            nodeId,
            before: beforeDetail,
            after: detail,
            strategy:
              activeNodeId && nodeId === activeNodeId
                ? 'active-composer'
                : 'fallback'
          });

          if (
            Number(detail.fileCount) === expectedCount &&
            beforeDetail?.insideComposer === true &&
            beforeDetail?.composerVisible === true
          ) {
            // CDP emits the trusted file-input event for the selected node.
            // Do not synthesize a second untrusted event here.
            await sleep(1200);

            return {
              found: ordered.length,
              set: expectedCount,
              nodeId,
              strategy:
                activeNodeId && nodeId === activeNodeId
                  ? 'active-composer'
                  : 'fallback',
              verification: detail,
              diagnostics
            };
          }
        } catch (error) {
          diagnostics.push({
            nodeId,
            error: error?.message || String(error)
          });
        } finally {
          if (objectId) {
            await this.client.send(
              'Runtime.releaseObject',
              { objectId },
              this.sessionId
            ).catch(() => {});
          }
        }
      }

      await sleep(300);
    }

    const error = new Error('file_input_assignment_failed');
    error.data = {
      selector: 'input[type=file]',
      found: lastFound,
      expectedCount,
      diagnostics
    };
    throw error;
  }

  // Watch ChatGPT attachment uploads at the NETWORK layer so a caller can tell a genuine
  // in-flight (or stalled) upload apart from a file that is merely selected/chipped. A chip
  // appears the instant the input's change event fires; the bytes travel afterward over a
  // separate request that can stall server-side. Returns a handle with a live snapshot()
  // ({inflight, finished, failed, oldestInflightMs, requests}) and off() to unsubscribe.
  // onEvent, when supplied, receives compact lifecycle records ({phase, method, url, status,
  // ageMs}) for debug logging. URLs are reduced to origin+path so signed-upload tokens in the
  // query string are never logged.
  watchUploads({ onEvent = null } = {}) {
    const trimUrl = (url = '') => {
      const s = String(url);
      const q = s.indexOf('?');
      return q >= 0 ? s.slice(0, q) : s;
    };
    // Attachment traffic: OpenAI's file-create/complete endpoints, the user-content host,
    // and the backing blob PUT. Restrict generic /files matches to write methods so ordinary
    // GET polling is not counted as an upload.
    const isUpload = (url = '', method = '') => {
      const u = String(url);
      const m = String(method || '').toUpperCase();
      const isWrite = m === 'POST' || m === 'PUT' || m === 'PATCH';
      if (/\bfiles\.oaiusercontent\.com\b/i.test(u)) return true;
      if (/blob\.core\.windows\.net/i.test(u) && (m === 'PUT' || m === 'POST')) return true;
      if (/\/backend-a(?:pi|lt)\/(?:files|conversation\/[^/]+\/attachments)/i.test(u) && isWrite) return true;
      if (/\/(?:files|uploads?)(?:\/|\?|$)/i.test(u) && isWrite) return true;
      return false;
    };
    const requests = new Map(); // requestId -> record
    const mine = (sessionId) => !(this.sessionId && sessionId && sessionId !== this.sessionId);
    const emit = (rec, phase) => {
      if (!onEvent) return;
      try {
        onEvent({
          phase,
          method: rec.method,
          url: rec.url,
          status: rec.status,
          bytes: rec.bytes,
          error: rec.error || null,
          ageMs: (rec.endedAt || Date.now()) - rec.startedAt
        });
      } catch {}
    };

    const offWillSend = this.client.on('Network.requestWillBeSent', (p, sid) => {
      if (!mine(sid)) return;
      const url = p?.request?.url || '';
      const method = p?.request?.method || '';
      if (!isUpload(url, method)) return;
      if (requests.has(p.requestId)) return; // ignore redirect re-fires on the same id
      const rec = {
        id: p.requestId, url: trimUrl(url), method, status: null,
        state: 'inflight', startedAt: Date.now(), endedAt: null, bytes: 0, error: null
      };
      requests.set(p.requestId, rec);
      emit(rec, 'request');
    });
    const offResp = this.client.on('Network.responseReceived', (p, sid) => {
      if (!mine(sid)) return;
      const rec = requests.get(p?.requestId);
      if (!rec) return;
      rec.status = Number(p?.response?.status) || null;
      emit(rec, 'response');
    });
    const offFin = this.client.on('Network.loadingFinished', (p, sid) => {
      if (!mine(sid)) return;
      const rec = requests.get(p?.requestId);
      if (!rec || rec.state !== 'inflight') return;
      rec.endedAt = Date.now();
      rec.bytes = Number(p?.encodedDataLength) || rec.bytes;
      // A server error is a FAILED upload, not a completed one. Chrome fires loadingFinished for
      // any response it received in full, including 4xx/5xx — so classifying by this event alone
      // reported OpenAI's 500/503 upload outages as successful uploads, and the send-gate then
      // dispatched a prompt whose attachments did not exist server-side.
      if (Number(rec.status) >= 400) {
        rec.state = 'http_error';
        rec.error = rec.error || `http_${rec.status}`;
        emit(rec, 'http_error');
        return;
      }
      rec.state = 'finished';
      emit(rec, 'finished');
    });
    const offFail = this.client.on('Network.loadingFailed', (p, sid) => {
      if (!mine(sid)) return;
      const rec = requests.get(p?.requestId);
      if (!rec || rec.state !== 'inflight') return;
      rec.state = p?.canceled ? 'canceled' : 'failed';
      rec.endedAt = Date.now();
      rec.error = p?.errorText || (p?.canceled ? 'canceled' : 'failed');
      emit(rec, rec.state);
    });

    const snapshot = () => {
      const now = Date.now();
      const all = Array.from(requests.values());
      const inflight = all.filter((r) => r.state === 'inflight');
      const httpErrors = all.filter((r) => r.state === 'http_error');
      // A ChatGPT attachment is only real once its whole three-request sequence succeeded:
      // create (POST …/backend-api/files) → blob PUT → POST …/files/process_upload_stream.
      // An attachment chip appears as soon as the file is *selected*, so chips alone say nothing
      // about whether any bytes were uploaded — a file whose sequence never ran leaves the composer
      // wedged on "File upload pending" and every send silently does nothing.
      const ok = all.filter((r) => r.state === 'finished');
      const processed = ok.filter((r) => /\/files\/process_upload_stream$/i.test(r.url)).length;
      const created = ok.filter((r) => /\/backend-a(?:pi|lt)\/files$/i.test(r.url)).length;
      const blobs = ok.filter((r) => r.method === 'PUT').length;
      return {
        total: all.length,
        inflight: inflight.length,
        finished: ok.length,
        // Completed upload sequences — compare against the number of attached files. Keyed on the
        // final process_upload_stream step, the last thing ChatGPT does before an attachment is
        // usable; `created`/`blobs` are kept for diagnosing where a sequence stopped.
        completed: processed,
        processed,
        created,
        blobs,
        // Transport failures, cancellations, AND server-error responses all mean "these bytes did
        // not become an attachment". Callers gate the send on this being zero.
        failed: all.filter((r) => r.state === 'failed' || r.state === 'canceled').length + httpErrors.length,
        httpErrors: httpErrors.length,
        httpErrorStatuses: [...new Set(httpErrors.map((r) => r.status).filter(Boolean))],
        oldestInflightMs: inflight.length ? now - Math.min(...inflight.map((r) => r.startedAt)) : 0,
        requests: all.map((r) => ({
          method: r.method, url: r.url, status: r.status, state: r.state,
          bytes: r.bytes, ageMs: (r.endedAt || now) - r.startedAt, error: r.error
        }))
      };
    };
    let stopped = false;
    const off = () => {
      if (stopped) return;
      stopped = true;
      offWillSend(); offResp(); offFin(); offFail();
    };
    return { off, snapshot };
  }

  // ChatGPT renders generated files as clickable "entity" buttons (aria-label =
  // filename). Clicking one opens a full-screen preview that, once loaded, exposes
  // a "Download" button. For each file: open preview → wait for it to load → click
  // Download → capture the download via CDP → close the preview.
  async downloadEntityFiles({ outDir, previewTimeoutMs = 120_000, downloadTimeoutMs = 60_000, debug = () => {} } = {}) {
    await fs.mkdir(outDir, { recursive: true });
    debug(`downloadPath=${outDir}`);
    try {
      await this.client.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: outDir, eventsEnabled: true });
      debug('setDownloadBehavior ok (allowAndName)');
    } catch (e) {
      debug(`Browser.setDownloadBehavior failed: ${e?.message}; trying Page.setDownloadBehavior`);
      try { await this.client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: outDir }, this.sessionId); } catch {}
    }
    // Diagnostics: log every download event regardless of correlation.
    const offGB = this.client.on('Browser.downloadWillBegin', (p) => debug(`WILLBEGIN guid=${String(p.guid).slice(0, 8)} name=${p.suggestedFilename} url=${String(p.url || '').slice(0, 60)}`));
    const offGP = this.client.on('Browser.downloadProgress', (p) => { if (p.state !== 'inProgress') debug(`PROGRESS ${p.state} guid=${String(p.guid).slice(0, 8)} recv=${p.receivedBytes} total=${p.totalBytes}`); });

    const findLabels = `(() => {
      const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
      const last = nodes[nodes.length - 1];
      if (!last) return [];
      const out = [];
      for (const b of Array.from(last.querySelectorAll('button[aria-label]'))) {
        const label = (b.getAttribute('aria-label') || '').trim();
        const cls = String(b.className || '');
        if (/\\.[A-Za-z0-9]{1,8}$/.test(label) && /behavior-btn|text-token-text-link/.test(cls)) out.push(label);
      }
      return Array.from(new Set(out));
    })()`;
    // The file buttons can render a moment after the reply text settles — poll.
    let labels = [];
    const findStart = Date.now();
    while (Date.now() - findStart < 20_000) {
      labels = await this.evaluate(findLabels);
      if (Array.isArray(labels) && labels.length) break;
      await sleep(1500);
    }
    debug(`found ${Array.isArray(labels) ? labels.length : 0} file button(s): ${JSON.stringify(labels)}`);
    if (!Array.isArray(labels) || !labels.length) { offGB(); offGP(); return []; }

    const closePreview = async () => {
      await this.evaluate(`(() => {
        const b = document.querySelector('[data-testid="close-button"]')
          || Array.from(document.querySelectorAll('[role="dialog"] button,[role="dialog"] [role="button"]')).find(x => /^close$/i.test((x.getAttribute('aria-label')||'').trim()));
        if (b) { b.click(); return true; } return false;
      })()`).catch(() => {});
      await sleep(700);
    };

    const saved = [];
    for (const label of labels) {
      // Open the preview for this file.
      const opened = await this.evaluate(`(() => {
        const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
        const last = nodes[nodes.length - 1];
        if (!last) return false;
        const b = Array.from(last.querySelectorAll('button[aria-label]')).find(x => (x.getAttribute('aria-label') || '').trim() === ${JSON.stringify(label)});
        if (b) { b.click(); return true; } return false;
      })()`);
      if (!opened) { debug(`entity button "${label}" not found`); continue; }

      // Wait for the preview to finish "Preparing preview..." and expose Download.
      let ready = false;
      const startWait = Date.now();
      while (Date.now() - startWait < previewTimeoutMs) {
        await sleep(1200);
        const st = await this.evaluate(`(() => {
          const d = document.querySelectorAll('[role="dialog"]'); const l = d[d.length - 1];
          if (!l) return { none: true };
          const t = (l.innerText || '');
          const hasDownload = Array.from(l.querySelectorAll('button,[role="button"]')).some(b => /^download$/i.test((b.getAttribute('aria-label')||'').trim()));
          return { preparing: /preparing preview/i.test(t), hasDownload };
        })()`);
        if (!st.none && !st.preparing && st.hasDownload) { ready = true; break; }
      }
      if (!ready) { debug(`preview for "${label}" not ready in time`); await closePreview(); continue; }

      // The browser's own download of the file cancels at 0 bytes (the click's
      // context is torn down), but downloadWillBegin still tells us the file's
      // authenticated URL. Capture that URL, then fetch the bytes IN-PAGE with the
      // session cookies and write them ourselves.
      const urlCapture = new Promise((resolve) => {
        const off = this.client.on('Browser.downloadWillBegin', (p) => { off(); resolve({ url: p.url, name: p.suggestedFilename || label }); });
        setTimeout(() => { off(); resolve(null); }, downloadTimeoutMs);
      });
      await this.evaluate(`(() => {
        const d = document.querySelectorAll('[role="dialog"]'); const l = d[d.length - 1]; if (!l) return false;
        const b = Array.from(l.querySelectorAll('button,[role="button"]')).find(x => /^download$/i.test((x.getAttribute('aria-label')||'').trim()));
        if (b) { b.click(); return true; } return false;
      })()`);
      const dl = await urlCapture;
      if (!dl || !dl.url) { debug(`no download URL for "${label}"`); await closePreview(); continue; }

      const fetched = await this.evaluate(`(async () => {
        try {
          const r = await fetch(${JSON.stringify(dl.url)}, { credentials: 'include' });
          if (!r.ok) return { error: 'http_' + r.status };
          const b = await r.blob();
          if (b.size > 50 * 1024 * 1024) return { error: 'too_large_' + b.size };
          const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onerror = () => rej(new Error('reader')); fr.onload = () => res(String(fr.result || '')); fr.readAsDataURL(b); });
          return { dataUrl, size: b.size };
        } catch (e) { return { error: String((e && e.message) || e) }; }
      })()`);
      const m = fetched && fetched.dataUrl ? String(fetched.dataUrl).match(/^data:[^;]*;base64,(.+)$/) : null;
      if (!m) {
        debug(`fetch "${label}" failed: ${fetched?.error || 'no data'}`);
        await closePreview();
        continue;
      }
      const buf = Buffer.from(m[1], 'base64');
      const cleaned = String(dl.name || label).replace(/[\\/:*?"<>|]+/g, '-');
      const parsed = path.parse(cleaned);
      let finalName = cleaned;
      for (let s = 1; s < 1000; s++) {
        try { await fs.access(path.join(outDir, finalName)); finalName = `${parsed.name}-${s}${parsed.ext}`; } catch { break; }
      }
      await fs.writeFile(path.join(outDir, finalName), buf);
      saved.push({ path: path.join(outDir, finalName), name: finalName });
      debug(`saved "${finalName}" (${buf.length} bytes)`);
      await closePreview();
    }
    offGB();
    offGP();
    return saved;
  }

  async bringToFront() {
    await this.client.send('Page.bringToFront', {}, this.sessionId).catch(() => {});
    if (this.windowId != null) {
      await this.client.send('Browser.setWindowBounds', { windowId: this.windowId, bounds: { windowState: 'normal' } }).catch(() => {});
    }
  }

  async minimize() {
    if (this.windowId == null) return false;
    await this.client.send('Browser.setWindowBounds', { windowId: this.windowId, bounds: { windowState: 'minimized' } }).catch(() => {});
    return true;
  }

  async close() {
    if (this.closed) return;
    try {
      await this.client.send('Target.closeTarget', { targetId: this.targetId });
    } catch {}
    this.closed = true;
  }
}

export class ChromeCdpBrowserBackend {
  constructor({ stateDir, userAgent, onChanged, executablePath = null, debugPort = 9222, profileMode = 'isolated', profileName = 'Default', pruneCookiesOnOpen = true } = {}) {
    this.stateDir = stateDir;
    this.userAgent = typeof userAgent === 'string' && userAgent.trim() ? userAgent.trim() : null;
    this.onChanged = typeof onChanged === 'function' ? onChanged : null;
    this.executablePath = executablePath;
    this.debugPort = Math.floor(Number(debugPort)) || 9222;
    this.profileMode = String(profileMode || '').trim().toLowerCase() === 'existing' ? 'existing' : 'isolated';
    this.profileName = String(profileName || '').trim() || 'Default';
    // Drop telemetry cookies before each navigation to keep the Cookie header small (431 mitigation).
    this.pruneCookiesOnOpen = pruneCookiesOnOpen !== false;
    this.chromeProcess = null;
    this.client = null;
    this.started = false;
    this.tabClosers = new Map();
    this.chromeUserDataDir =
      this.profileMode === 'existing' ? defaultChromeUserDataDir() : path.join(this.stateDir, 'chrome-user-data');
    this.boundTargetDestroyed = null;
  }

  async start() {
    if (this.started && this.client?.connected && this.client?.ws) {
      return this.getState();
    }

    if (this.profileMode === 'isolated') {
      await fs.mkdir(this.chromeUserDataDir, { recursive: true });
    } else if (!(await pathExists(this.chromeUserDataDir))) {
      const err = new Error('existing_chrome_profile_not_found');
      err.data = { userDataDir: this.chromeUserDataDir, profileName: this.profileName };
      throw err;
    }

    let portOccupied = false;
    try {
      await readJson(`http://127.0.0.1:${this.debugPort}/json/version`);
      portOccupied = true;
    } catch {
      portOccupied = false;
    }
    if (portOccupied) {
      const err = new Error('chrome_debug_port_in_use');
      err.data = {
        debugPort: this.debugPort,
        reason: 'refusing_to_attach_to_existing_browser'
      };
      throw err;
    }

    try {
      const executable = await findChromeExecutable(this.executablePath);
      const args = buildChromeLaunchArgs({
        debugPort: this.debugPort,
        userDataDir: this.chromeUserDataDir,
        profileName: this.profileName,
        startUrl: 'about:blank'
      });
      this.chromeProcess = spawn(executable, args, chromeSpawnOptions());
      this.chromeProcess.unref?.();

      let version;
      const start = Date.now();
      while (Date.now() - start < 15_000) {
        try {
          version = await readJson(`http://127.0.0.1:${this.debugPort}/json/version`);
          break;
        } catch {
          await sleep(250);
        }
      }
      if (!version) {
        const err = new Error('chrome_cdp_unavailable');
        err.data =
          this.profileMode === 'existing'
            ? {
                profileMode: this.profileMode,
                profileName: this.profileName,
                userDataDir: this.chromeUserDataDir,
                hint: 'close_regular_chrome_and_retry'
              }
            : { profileMode: this.profileMode, userDataDir: this.chromeUserDataDir };
        throw err;
      }

      const wsUrl = String(version?.webSocketDebuggerUrl || '').trim();
      if (!wsUrl) throw new Error('chrome_cdp_missing_ws_url');
      this.client = new ChromeCdpConnection(wsUrl);
      await this.client.connect();
      this.boundTargetDestroyed = this.client.on('Target.targetDestroyed', ({ targetId }) => {
        const closer = this.tabClosers.get(String(targetId || ''));
        if (!closer) return;
        this.tabClosers.delete(String(targetId || ''));
        try {
          closer();
        } catch {}
        this.onChanged?.();
      });
      this.started = true;
      return this.getState();
    } catch (error) {
      try {
        this.boundTargetDestroyed?.();
      } catch {}
      this.boundTargetDestroyed = null;
      try {
        await this.client?.close?.();
      } catch {}
      this.client = null;
      this.started = false;
      if (this.chromeProcess && !this.chromeProcess.killed) {
        try {
          this.chromeProcess.kill('SIGTERM');
        } catch {}
      }
      this.chromeProcess = null;
      throw error;
    }
  }

  getState() {
    return {
      kind: 'chrome-cdp',
      debugPort: this.debugPort,
      userDataDir: this.chromeUserDataDir,
      profileMode: this.profileMode,
      profileName: this.profileName,
      managedProfile: this.profileMode !== 'existing',
      launchedByAgentify: !!this.chromeProcess,
      // PID of the launched Chrome browser process (root of its process tree), so callers can
      // monitor the browser's RAM/CPU. Null when attached to an existing browser we did not spawn.
      chromePid: this.chromeProcess?.pid ?? null
    };
  }

  async createSession({ url, show = false, onClosed } = {}) {
    await this.start();

    // Open the tab blank first so we can attach, prune telemetry cookies, and navigate through the
    // 431-aware path — Target.createTarget with the real URL would fire the (possibly 431-ing)
    // request before we could observe or trim it.
    let target;
    try {
      target = await this.client.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    } catch {
      target = await this.client.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    }
    const targetId = String(target?.targetId || '').trim();
    if (!targetId) throw new Error('chrome_cdp_target_create_failed');
    try {
      const attach = await this.client.send('Target.attachToTarget', { targetId, flatten: true });
      const sessionId = String(attach?.sessionId || '').trim();
      if (!sessionId) throw new Error('chrome_cdp_attach_failed');

      let windowId = null;
      try {
        const browserWindow = await this.client.send('Browser.getWindowForTarget', { targetId });
        if (browserWindow && Number.isFinite(browserWindow.windowId)) windowId = browserWindow.windowId;
      } catch {}

      const page = new ChromeCdpPageAdapter({ client: this.client, targetId, sessionId, windowId });
      await page.initialize({ userAgent: this.userAgent });
      const mayPruneConversationState = this.tabClosers.size === 0;
      if (this.pruneCookiesOnOpen) {
        await page.pruneTelemetryCookies({ includeConversationState: mayPruneConversationState }).catch(() => {});
      }
      if (url && url !== 'about:blank') {
        await page.navigate(url, { pruneConversationStateOn431: mayPruneConversationState });
      }
      if (show) await page.bringToFront().catch(() => {});
      else await page.minimize().catch(() => {});

      this.tabClosers.set(targetId, () => {
        page.markClosed();
        onClosed?.();
      });
      this.onChanged?.();

      return {
        page,
        close: async () => {
          this.tabClosers.delete(targetId);
          try {
            await page.close();
          } catch {}
          onClosed?.();
        },
        isClosed: () => page.isClosed()
      };
    } catch (error) {
      try {
        await this.client.send('Target.closeTarget', { targetId });
      } catch {}
      throw error;
    }
  }

  async dispose() {
    try {
      this.boundTargetDestroyed?.();
    } catch {}
    this.boundTargetDestroyed = null;
    try {
      await this.client?.close?.();
    } catch {}
    this.client = null;

    if (this.chromeProcess && !this.chromeProcess.killed) {
      try {
        this.chromeProcess.kill('SIGTERM');
      } catch {}
    }
    this.chromeProcess = null;
    this.started = false;
    this.tabClosers.clear();
  }
}