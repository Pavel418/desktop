#!/usr/bin/env node
import { app, Notification, BrowserWindow, ipcMain, shell, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import {
  createBrowserBackend,
  resolveBrowserBackend,
  resolveChromeDebugPort,
  resolveChromeExecutablePath,
  resolveChromeProfileMode,
  resolveChromeProfileName
} from './browser-backend.mjs';
import { ChatGPTController } from './chatgpt-controller.mjs';
import { startHttpApi } from './http-api.mjs';
import { TabManager } from './tab-manager.mjs';
import { defaultStateDir, ensureToken, readSettings, writeSettings, defaultSettings, writeState } from './state.mjs';
import { getWorkspace, setWorkspace } from './orchestrator/storage.mjs';
import { logPath as orchestratorLogPath } from './orchestrator/logging.mjs';
import { shouldAllowPopup } from './popup-policy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let bootLogPath = null;

async function bootLog(message, extra = null) {
  try {
    const stateDir = argValue('--state-dir') || defaultStateDir();
    const logDir = path.join(stateDir, 'logs');
    await fs.mkdir(logDir, { recursive: true });
    bootLogPath = bootLogPath || path.join(logDir, 'desktop.current.log');
    const line = `${new Date().toISOString()} ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`;
    await fs.appendFile(bootLogPath, line, 'utf8');
  } catch {}
}

function bootLogSync(message, extra = null) {
  try {
    const stateDir = argValue('--state-dir') || defaultStateDir();
    const logDir = path.join(stateDir, 'logs');
    fsSync.mkdirSync(logDir, { recursive: true });
    bootLogPath = bootLogPath || path.join(logDir, 'desktop.current.log');
    const line = `${new Date().toISOString()} ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`;
    fsSync.appendFileSync(bootLogPath, line, 'utf8');
  } catch {}
}

process.on('uncaughtException', (error) => {
  bootLogSync('uncaughtException', { message: String(error?.message || error), stack: String(error?.stack || '') });
  // eslint-disable-next-line no-console
  console.error('[agentify-desktop] uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
  bootLogSync('unhandledRejection', { message: String(reason?.message || reason), stack: String(reason?.stack || '') });
  // eslint-disable-next-line no-console
  console.error('[agentify-desktop] unhandledRejection', reason);
});

process.on('exit', (code) => {
  bootLogSync('process.exit', { code });
});

function argFlag(name) {
  return process.argv.includes(name);
}

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
}

function buildChromeUserAgent() {
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  const chromeVersion = process.versions?.chrome || '120.0.0.0';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

async function loadSelectors(stateDir) {
  const defaults = JSON.parse(await fs.readFile(path.join(__dirname, 'selectors.json'), 'utf8'));
  const overridePath = path.join(stateDir, 'selectors.override.json');
  try {
    const override = JSON.parse(await fs.readFile(overridePath, 'utf8'));
    if (override && typeof override === 'object') {
      const cleaned = {};
      for (const [k, v] of Object.entries(override)) {
        if (!Object.prototype.hasOwnProperty.call(defaults, k)) continue;
        if (typeof v !== 'string' || !v.trim()) continue;
        cleaned[k] = v.trim();
      }
      return { ...defaults, ...cleaned };
    }
  } catch {}
  return defaults;
}

async function loadVendors() {
  const raw = await fs.readFile(path.join(__dirname, 'vendors.json'), 'utf8');
  const parsed = JSON.parse(raw || '{}');
  const vendors = Array.isArray(parsed?.vendors) ? parsed.vendors : [];
  const cleaned = [];
  for (const v of vendors) {
    if (!v || typeof v !== 'object') continue;
    const id = String(v.id || '').trim();
    const name = String(v.name || '').trim();
    const url = String(v.url || '').trim();
    const status = String(v.status || 'planned').trim();
    if (!id || !name || !url) continue;
    cleaned.push({ id, name, url, status });
  }
  return cleaned;
}

async function main() {
  await bootLog('main.start', { argv: process.argv.slice(2), cwd: process.cwd() });
  let browserBackend = null;
  const stateDir = argValue('--state-dir') || defaultStateDir();
  const basePort = Number(argValue('--port') || process.env.AGENTIFY_DESKTOP_PORT || 0);
  const startMinimized = argFlag('--start-minimized');

  // Reduce obvious automation fingerprints (best-effort).
  try {
    app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
  } catch {}
  try {
    app.userAgentFallback = buildChromeUserAgent();
  } catch {}
  try {
    process.title = 'Agentify Desktop';
  } catch {}

  app.setName('Agentify Desktop');
  app.setPath('userData', path.join(stateDir, 'electron-user-data'));
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    await bootLog('single_instance_lock_failed');
    app.quit();
    return;
  }

  let pendingSecondInstanceFocus = false;
  let focusDefaultTab = null;
  app.on('second-instance', () => {
    if (typeof focusDefaultTab === 'function') focusDefaultTab();
    else pendingSecondInstanceFocus = true;
  });

  await app.whenReady();
  await bootLog('app.ready');

  const token = await ensureToken(stateDir);
  const selectors = await loadSelectors(stateDir);
  const vendors = await loadVendors();
  let settings = await readSettings(stateDir);
  const requestedBrowserBackendKind = resolveBrowserBackend({ settings });
  let browserBackendKind = requestedBrowserBackendKind;
  const chromeExecutablePath = resolveChromeExecutablePath({ settings });
  const chromeDebugPort = resolveChromeDebugPort({ settings });
  const chromeProfileMode = resolveChromeProfileMode({ settings });
  const chromeProfileName = resolveChromeProfileName({ settings });
  const serverId = crypto.randomUUID();
  let browserStartupError = null;
  await bootLog('settings.loaded', {
    requestedBrowserBackendKind,
    chromeDebugPort,
    chromeProfileMode,
    chromeProfileName,
    showTabsByDefault: settings?.showTabsByDefault
  });

  const notify = (body) => {
    try {
      const n = new Notification({ title: 'Agentify Desktop', body });
      n.show();
    } catch {}
  };

  const onNeedsAttention = async ({ reason }) => {
    if (reason === 'all_clear') return;
    if (reason?.kind === 'login') notify('Agentify needs attention. Please sign in to the target site.');
    else if (reason?.kind === 'ui') notify('Agentify is stuck. Please bring the target site to a ready state (UI changed, blocked, or needs a click).');
    else notify('Agentify needs a human check. Please solve the CAPTCHA.');
  };

  const describeBrowserStartupError = (error) => {
    const message = String(error?.message || error || 'browser_start_failed');
    const code = message.includes(':') ? message.split(':')[0] : message;
    return {
      requestedBackend: requestedBrowserBackendKind,
      fallbackBackend: 'electron',
      code,
      message
    };
  };

  let controlWin = null;
  let quitting = false;
  const orchestrators = new Map(); // key -> { child, pid, startedAt }
  const orchestratorHistory = new Map(); // key -> { pid, startedAt, exitedAt, exitCode, signal, logPath }
  const emitTabsChanged = () => {
    try {
      if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('agentify:tabsChanged');
    } catch {}
  };
  const showControlCenter = async () => {
    if (controlWin && !controlWin.isDestroyed()) {
      if (controlWin.isMinimized()) controlWin.restore();
      controlWin.show();
      controlWin.focus();
      return;
    }
    controlWin = new BrowserWindow({
      width: 520,
      height: 720,
      show: !startMinimized,
      title: 'Agentify Desktop',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'ui', 'preload.cjs')
      }
    });
    controlWin.setMenuBarVisibility(false);
    controlWin.on('close', (e) => {
      if (quitting) return;
      try {
        e.preventDefault();
        controlWin.hide();
      } catch {}
    });
    await controlWin.loadFile(path.join(__dirname, 'ui', 'control-center.html'));
  };

  const makeBrowserBackend = async (kind) =>
    await createBrowserBackend({
      kind,
      stateDir,
      windowDefaults: { width: 1100, height: 800, show: !startMinimized, title: 'Agentify Desktop' },
      userAgent: app.userAgentFallback,
      onChanged: emitTabsChanged,
      popupPolicy: ({ url, vendorId, openerUrl, frameName, disposition }) =>
        shouldAllowPopup({ url, vendorId, openerUrl, frameName, disposition, allowAuthPopups: settings?.allowAuthPopups !== false }),
      chromeExecutablePath,
      chromeDebugPort,
      chromeProfileMode,
      chromeProfileName
    });

  browserBackend = await makeBrowserBackend(browserBackendKind);
  let browserState = null;
  try {
    await bootLog('browser.start.begin', { browserBackendKind });
    browserState = await browserBackend.start();
    await bootLog('browser.start.ok', browserState);
  } catch (e) {
    await bootLog('browser.start.error', { message: String(e?.message || e), stack: String(e?.stack || '') });
    if (browserBackendKind !== 'chrome-cdp') throw e;
    browserStartupError = describeBrowserStartupError(e);
    if (String(process.env.AGENTIFY_DESKTOP_ALLOW_ELECTRON_FALLBACK || '').trim().toLowerCase() !== 'true') {
      throw e;
    }
    try {
      await browserBackend.dispose?.();
    } catch {}
    browserBackendKind = 'electron';
    notify('Chrome CDP is unavailable. Agentify is using Electron browser fallback.');
    browserBackend = await makeBrowserBackend(browserBackendKind);
    browserState = await browserBackend.start();
  }

  const tabs = new TabManager({
    browserBackend,
    maxTabs: Number(process.env.AGENTIFY_DESKTOP_MAX_TABS || 12),
    onNeedsAttention,
    userAgent: app.userAgentFallback,
    onChanged: emitTabsChanged,
    windowDefaults: { width: 1100, height: 800, show: !startMinimized, title: 'Agentify Desktop' },
    createController: async ({ tabId, page }) => {
      const controller = new ChatGPTController({
        page,
        selectors,
        stateDir,
        onBlocked: async (st) => {
          await tabs.needsAttention(tabId, st);
        },
        onUnblocked: async () => {
          await tabs.resolvedAttention(tabId);
        }
      });
      controller.serverId = serverId;
      return controller;
    }
  });

  // Default tab for legacy callers (no tabId).
  const defaultVendor =
    vendors.find((v) => v.id === 'chatgpt') ||
    vendors[0] || { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', status: 'supported' };
  const defaultTabId = await tabs.createTab({
    key: 'default',
    name: 'default',
    url: defaultVendor.url,
    show: !startMinimized,
    reuseExisting: browserBackendKind === 'chrome-cdp',
    protectedTab: true,
    vendorId: defaultVendor.id,
    vendorName: defaultVendor.name
  });
  await bootLog('default_tab.created', { defaultTabId });

  focusDefaultTab = () => {
    try {
      const win = tabs.getWindowById(defaultTabId);
      if (win.isMinimized?.()) win.restore?.();
      win.show?.();
      win.focus?.();
    } catch {}
  };
  if (pendingSecondInstanceFocus) focusDefaultTab();

  const buildMenu = () => {
    const template = [
      {
        label: 'Agentify Desktop',
        submenu: [
          { label: 'Control Center', accelerator: 'CmdOrCtrl+Shift+A', click: () => showControlCenter().catch(() => {}) },
          { label: 'Show Default Tab', accelerator: 'CmdOrCtrl+Shift+D', click: () => focusDefaultTab?.() },
          { type: 'separator' },
          { label: 'Quit', role: 'quit' }
        ]
      },
      {
        label: 'Tabs',
        submenu: [
          {
            label: 'New ChatGPT Tab',
            click: async () => {
              try {
                await tabs.createTab({ url: defaultVendor.url, vendorId: defaultVendor.id, vendorName: defaultVendor.name, show: true });
              } catch {}
            }
          }
        ]
      }
    ];
    try {
      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    } catch {}
  };
  buildMenu();
  try {
    if (process.platform === 'darwin' && app.dock) {
      const dockMenu = Menu.buildFromTemplate([
        { label: 'Control Center', click: () => showControlCenter().catch(() => {}) },
        { label: 'Show Default Tab', click: () => focusDefaultTab?.() }
      ]);
      app.dock.setMenu(dockMenu);
    }
  } catch {}

  ipcMain.handle('agentify:getState', async () => {
    return {
      ok: true,
      vendors,
      tabs: tabs.listTabs(),
      defaultTabId,
      stateDir,
      browserBackend: browserBackendKind,
      requestedBrowserBackend: requestedBrowserBackendKind,
      browser: browserState,
      browserStartupError
    };
  });

  ipcMain.handle('agentify:getSettings', async () => {
    settings = await readSettings(stateDir);
    return settings;
  });

  ipcMain.handle('agentify:setSettings', async (_evt, args) => {
    if (args?.reset) {
      settings = await writeSettings(defaultSettings(), stateDir);
      return settings;
    }
    const next = {
      ...settings,
      maxInflightQueries: args?.maxInflightQueries,
      maxQueriesPerMinute: args?.maxQueriesPerMinute,
      minTabGapMs: args?.minTabGapMs,
      minGlobalGapMs: args?.minGlobalGapMs,
      showTabsByDefault: args?.showTabsByDefault,
      browserBackend: args?.browserBackend ?? settings.browserBackend,
      chromeDebugPort: args?.chromeDebugPort ?? settings.chromeDebugPort,
      chromeExecutablePath: args?.chromeExecutablePath ?? settings.chromeExecutablePath,
      chromeProfileMode: args?.chromeProfileMode ?? settings.chromeProfileMode,
      chromeProfileName: args?.chromeProfileName ?? settings.chromeProfileName,
      allowAuthPopups: args?.allowAuthPopups ?? settings.allowAuthPopups
    };
    if (args?.acknowledge) next.acknowledgedAt = new Date().toISOString();
    settings = await writeSettings(next, stateDir);
    return settings;
  });

  ipcMain.handle('agentify:createTab', async (_evt, args) => {
    const vendorId = String(args?.vendorId || '').trim() || 'chatgpt';
    const vendor = vendors.find((v) => v.id === vendorId) || vendors.find((v) => v.id === 'chatgpt') || vendors[0];
    if (!vendor) throw new Error('missing_vendor');
    const key = args?.key ? String(args.key).trim() : '';
    const name = args?.name ? String(args.name).trim() : '';
    const show = !!args?.show;

    const tabId = key
      ? await tabs.ensureTab({ key, name: name || null, url: vendor.url, vendorId: vendor.id, vendorName: vendor.name })
      : await tabs.createTab({ name: name || null, show: false, url: vendor.url, vendorId: vendor.id, vendorName: vendor.name });

    if (show) {
      const win = tabs.getWindowById(tabId);
      if (win.isMinimized?.()) win.restore?.();
      win.show?.();
      win.focus?.();
    }
    return { ok: true, tabId };
  });

  ipcMain.handle('agentify:showTab', async (_evt, args) => {
    const tabId = String(args?.tabId || '').trim();
    if (!tabId) throw new Error('missing_tabId');
    const win = tabs.getWindowById(tabId);
    if (win.isMinimized?.()) win.restore?.();
    win.show?.();
    win.focus?.();
    emitTabsChanged();
    return { ok: true };
  });

  ipcMain.handle('agentify:hideTab', async (_evt, args) => {
    const tabId = String(args?.tabId || '').trim();
    if (!tabId) throw new Error('missing_tabId');
    const win = tabs.getWindowById(tabId);
    win.minimize?.();
    emitTabsChanged();
    return { ok: true };
  });

  const setTabsVisible = async (visible) => {
    const tabList = tabs.listTabs();
    let changed = 0;
    for (const tab of tabList) {
      const win = tabs.getWindowById(tab.id);
      if (visible) {
        if (win.isMinimized?.()) win.restore?.();
        win.show?.();
        win.focus?.();
      } else {
        win.minimize?.();
      }
      changed += 1;
    }
    emitTabsChanged();
    return { ok: true, visible: !!visible, changed, tabs: tabs.listTabs() };
  };

  ipcMain.handle('agentify:setTabsVisible', async (_evt, args) => {
    return await setTabsVisible(!!args?.visible);
  });

  ipcMain.handle('agentify:showAllTabs', async () => {
    return await setTabsVisible(true);
  });

  ipcMain.handle('agentify:hideAllTabs', async () => {
    return await setTabsVisible(false);
  });

  ipcMain.handle('agentify:closeTab', async (_evt, args) => {
    const tabId = String(args?.tabId || '').trim();
    if (!tabId) throw new Error('missing_tabId');
    if (tabId === defaultTabId) throw new Error('default_tab_protected');
    await tabs.closeTab(tabId);
    return { ok: true };
  });

  ipcMain.handle('agentify:openStateDir', async () => {
    const error = await shell.openPath(stateDir);
    if (error) throw new Error(error);
    return { ok: true };
  });

  ipcMain.handle('agentify:getOrchestrators', async () => {
    const running = [];
    for (const [k, v] of orchestrators.entries()) {
      if (!v?.child) continue;
      running.push({ key: k, pid: v.pid, startedAt: v.startedAt, logPath: orchestratorLogPath(stateDir, k) });
    }
    const recent = [];
    for (const [k, v] of orchestratorHistory.entries()) {
      recent.push({ key: k, ...v });
    }
    // show most recent first
    recent.sort((a, b) => String(b.exitedAt || '').localeCompare(String(a.exitedAt || '')));
    return { ok: true, running, recent: recent.slice(0, 10) };
  });

  ipcMain.handle('agentify:setWorkspaceForKey', async (_evt, args) => {
    const key = String(args?.key || '').trim();
    const workspace = String(args?.workspace || '').trim();
    if (!key) throw new Error('missing_key');
    if (!workspace) throw new Error('missing_workspace');
    const resolved = path.resolve(workspace);
    const st = await fs.stat(resolved);
    if (!st.isDirectory()) throw new Error('workspace_not_directory');
    if (resolved === path.parse(resolved).root) throw new Error('workspace_cannot_be_filesystem_root');
    await setWorkspace(stateDir, { key, workspace: { root: resolved, allowRoots: [resolved] } });
    return { ok: true };
  });

  ipcMain.handle('agentify:getWorkspaceForKey', async (_evt, args) => {
    const key = String(args?.key || '').trim();
    if (!key) throw new Error('missing_key');
    const ws = await getWorkspace(stateDir, { key });
    return { ok: true, workspace: ws };
  });

  ipcMain.handle('agentify:startOrchestrator', async (_evt, args) => {
    const key = String(args?.key || '').trim();
    if (!key) throw new Error('missing_key');
    if (orchestrators.has(key)) return { ok: true, alreadyRunning: true };

    const ws = await getWorkspace(stateDir, { key });
    const cwd = path.resolve(ws?.root || process.cwd());
    const entry = path.join(__dirname, 'orchestrator.mjs');
    const child = spawn(process.execPath, [entry, '--state-dir', stateDir, '--key', key], {
      cwd,
      stdio: 'ignore',
      env: { ...process.env, AGENTIFY_DESKTOP_STATE_DIR: stateDir }
    });
    const startedAt = new Date().toISOString();
    orchestrators.set(key, { child, pid: child.pid, startedAt });
    child.on('exit', (code, signal) => {
      orchestrators.delete(key);
      orchestratorHistory.set(key, {
        pid: child.pid,
        startedAt,
        exitedAt: new Date().toISOString(),
        exitCode: typeof code === 'number' ? code : null,
        signal: signal || null,
        logPath: orchestratorLogPath(stateDir, key)
      });
      try {
        if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('agentify:tabsChanged');
      } catch {}
    });
    return { ok: true, pid: child.pid };
  });

  ipcMain.handle('agentify:stopOrchestrator', async (_evt, args) => {
    const key = String(args?.key || '').trim();
    if (!key) throw new Error('missing_key');
    const cur = orchestrators.get(key);
    if (!cur?.child) return { ok: true, notRunning: true };
    try {
      cur.child.kill('SIGTERM');
    } catch {}
    orchestrators.delete(key);
    return { ok: true };
  });

  ipcMain.handle('agentify:stopAllOrchestrators', async () => {
    for (const [k, v] of orchestrators.entries()) {
      try {
        v?.child?.kill?.('SIGTERM');
      } catch {}
      orchestrators.delete(k);
    }
    return { ok: true };
  });

  await showControlCenter()
    .then(() => bootLog('control_center.shown'))
    .catch((error) => bootLog('control_center.error', { message: String(error?.message || error), stack: String(error?.stack || '') }));

  let server = null;
  let port = basePort;
  const tries = port === 0 ? 1 : 20;
  for (let i = 0; i < tries; i++) {
    try {
      await bootLog('http.start.begin', { port });
      server = await startHttpApi({
        port,
        token,
        tabs,
        defaultTabId,
        vendors,
        serverId,
        stateDir,
        getSettings: async () => settings,
        onShow: async ({ tabId }) => {
          const win = tabs.getWindowById(tabId || defaultTabId);
          if (win.isMinimized?.()) win.restore?.();
          win.show?.();
          win.focus?.();
        },
        onHide: async ({ tabId }) => {
          const win = tabs.getWindowById(tabId || defaultTabId);
          win.minimize?.();
        },
        onShutdown: async () => {
          try {
            server?.close?.();
          } catch {}
          app.quit();
        },
        getStatus: async ({ tabId }) => {
          const controller = tabId ? tabs.getControllerById(tabId) : tabs.getControllerById(defaultTabId);
          const url = await controller.getUrl().catch(() => '');
          const challenge = await controller.detectChallenge().catch(() => null);
          return {
            ok: true,
            tabId: tabId || defaultTabId,
            url,
            blocked: !!challenge?.blocked,
            promptVisible: !!challenge?.promptVisible,
            kind: challenge?.kind || null,
            indicators: challenge?.indicators || null,
            tabs: tabs.listTabs()
          };
        }
      });
      try {
        port = server.address().port;
      } catch {}
      await bootLog('http.start.ok', { port });
      break;
    } catch (e) {
      await bootLog('http.start.error', { port, message: String(e?.message || e), code: e?.code || null });
      if (e?.code === 'EADDRINUSE') {
        port += 1;
        continue;
      }
      throw e;
    }
  }
  if (!server) throw new Error('http_api_start_failed');

  await writeState({ ok: true, port, pid: process.pid, serverId, startedAt: new Date().toISOString() }, stateDir);
  await bootLog('state.written', { port, pid: process.pid, serverId });

  app.on('before-quit', () => {
    bootLogSync('app.before-quit');
    quitting = true;
    for (const v of orchestrators.values()) {
      try {
        v?.child?.kill?.('SIGTERM');
      } catch {}
    }
    tabs.setQuitting(true);
    Promise.resolve(browserBackend?.dispose?.()).catch(() => {});
  });

  process.on('SIGINT', () => {
    try {
      server.close();
    } catch {}
    app.quit();
  });

  app.on('activate', () => {
    bootLogSync('app.activate');
    showControlCenter().catch(() => {});
  });

  app.on('window-all-closed', () => {
    bootLogSync('app.window-all-closed', { platform: process.platform });
    if (process.platform !== 'darwin') app.quit();
  });
}

main().catch((e) => {
  bootLogSync('main.fatal', { message: String(e?.message || e), stack: String(e?.stack || '') });
  // eslint-disable-next-line no-console
  console.error('[agentify-desktop] fatal', e);
  process.exit(1);
});
