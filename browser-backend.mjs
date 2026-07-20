// Chrome launch configuration resolvers (argv > env > settings).
// The batch script drives Chrome over CDP directly via ChromeCdpBrowserBackend
// (chrome-cdp-backend.mjs); these helpers just resolve the executable, debug
// port, and profile from CLI flags / environment variables.

export function resolveChromeExecutablePath({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--chrome-binary') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  const raw = argValue || env.AGENTIFY_DESKTOP_CHROME_BIN || settings.chromeExecutablePath || '';
  const trimmed = String(raw || '').trim();
  return trimmed || null;
}

export function resolveChromeDebugPort({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--chrome-debug-port') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  const raw = argValue || env.AGENTIFY_DESKTOP_CHROME_DEBUG_PORT || settings.chromeDebugPort;
  const port = Math.floor(Number(raw));
  if (!Number.isFinite(port) || port < 1024 || port > 65535) return 9222;
  return port;
}

export function resolveChromeProfileMode({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--chrome-profile-mode') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  const raw = String(argValue || env.AGENTIFY_DESKTOP_CHROME_PROFILE_MODE || settings.chromeProfileMode || '').trim().toLowerCase();
  return raw === 'existing' ? 'existing' : 'isolated';
}

export function resolveChromeProfileName({
  argv = process.argv,
  env = process.env,
  settings = {}
} = {}) {
  const idx = Array.isArray(argv) ? argv.indexOf('--chrome-profile-name') : -1;
  const argValue = idx >= 0 ? argv[idx + 1] : null;
  const raw = String(argValue || env.AGENTIFY_DESKTOP_CHROME_PROFILE_NAME || settings.chromeProfileName || '').trim();
  return raw || 'Default';
}
