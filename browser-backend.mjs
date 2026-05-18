export const SUPPORTED_BROWSER_BACKENDS = ['chrome-cdp', 'electron'];

export function normalizeBrowserBackend(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'chrome-cdp';
  if (raw === 'chrome' || raw === 'chrome_cdp' || raw === 'cdp') return 'chrome-cdp';
  if (SUPPORTED_BROWSER_BACKENDS.includes(raw)) return raw;
  return 'chrome-cdp';
}

function argValue(argv, name) {
  const idx = Array.isArray(argv) ? argv.indexOf(name) : -1;
  if (idx === -1) return null;
  return argv[idx + 1] || null;
}

export function resolveBrowserBackend({ argv = process.argv, env = process.env, settings = {} } = {}) {
  return normalizeBrowserBackend(argValue(argv, '--browser-backend') || env.AGENTIFY_DESKTOP_BROWSER_BACKEND || settings.browserBackend);
}

export function resolveChromeExecutablePath({ argv = process.argv, env = process.env, settings = {} } = {}) {
  const raw = argValue(argv, '--chrome-binary') || env.AGENTIFY_DESKTOP_CHROME_BIN || settings.chromeExecutablePath || '';
  return String(raw || '').trim() || null;
}

export function resolveChromeDebugPort({ argv = process.argv, env = process.env, settings = {} } = {}) {
  const port = Math.floor(Number(argValue(argv, '--chrome-debug-port') || env.AGENTIFY_DESKTOP_CHROME_DEBUG_PORT || settings.chromeDebugPort));
  if (!Number.isFinite(port) || port < 1024 || port > 65535) return 9222;
  return port;
}

export function resolveChromeProfileMode({ argv = process.argv, env = process.env, settings = {} } = {}) {
  const raw = String(argValue(argv, '--chrome-profile-mode') || env.AGENTIFY_DESKTOP_CHROME_PROFILE_MODE || settings.chromeProfileMode || '').trim().toLowerCase();
  if (raw === 'agentify' || raw === 'persistent') return 'agentify';
  if (raw === 'existing') return 'existing';
  if (raw === 'attach') return 'attach';
  if (raw === 'isolated') return 'isolated';
  return 'agentify';
}

export function resolveChromeProfileName({ argv = process.argv, env = process.env, settings = {} } = {}) {
  const raw = String(argValue(argv, '--chrome-profile-name') || env.AGENTIFY_DESKTOP_CHROME_PROFILE_NAME || settings.chromeProfileName || '').trim();
  return raw || 'Default';
}

export async function createBrowserBackend({
  kind,
  stateDir,
  windowDefaults,
  userAgent,
  popupPolicy,
  onChanged,
  chromeExecutablePath,
  chromeDebugPort,
  chromeProfileMode,
  chromeProfileName
} = {}) {
  if (normalizeBrowserBackend(kind) === 'electron') {
    const { ElectronBrowserBackend } = await import('./electron-browser-backend.mjs');
    return new ElectronBrowserBackend({ windowDefaults, userAgent, popupPolicy, onChanged });
  }

  const { ChromeCdpBrowserBackend } = await import('./chrome-cdp-backend.mjs');
  return new ChromeCdpBrowserBackend({
    stateDir,
    userAgent,
    onChanged,
    executablePath: chromeExecutablePath,
    debugPort: chromeDebugPort,
    profileMode: chromeProfileMode,
    profileName: chromeProfileName
  });
}
