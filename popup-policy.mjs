const SUPPORTED_VENDOR_IDS = ['chatgpt', 'perplexity', 'claude', 'aistudio', 'gemini', 'grok'];

const AUTH_HOST_ALLOWLIST = [
  'chatgpt.com',
  '.chatgpt.com',
  'openai.com',
  '.openai.com',
  'accounts.google.com',
  'accounts.youtube.com',
  'myaccount.google.com',
  'ogs.google.com',
  '.google.com',
  '.googleusercontent.com',
  'login.live.com',
  '.live.com',
  '.microsoft.com',
  '.microsoftonline.com',
  'appleid.apple.com',
  '.apple.com',
  'github.com',
  '.github.com',
  'x.com',
  '.x.com',
  'twitter.com',
  '.twitter.com',
  'grok.com',
  '.grok.com',
  'perplexity.ai',
  '.perplexity.ai'
];

const VENDOR_HOST_ALLOWLIST = [
  'chatgpt.com',
  '.chatgpt.com',
  'claude.ai',
  '.claude.ai',
  'gemini.google.com',
  '.gemini.google.com',
  'aistudio.google.com',
  '.aistudio.google.com',
  'perplexity.ai',
  '.perplexity.ai',
  'grok.com',
  '.grok.com'
];

function normalizeHostname(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/\.+$/, '');
}

function hostMatchesPattern(hostname, pattern) {
  const h = normalizeHostname(hostname);
  const p = normalizeHostname(pattern);
  if (!h || !p) return false;
  if (p.startsWith('.')) return h === p.slice(1) || h.endsWith(p);
  return h === p;
}

export function isAllowedAuthPopupUrl(url, { vendorId = 'chatgpt' } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const vendor = String(vendorId || 'chatgpt').trim().toLowerCase();
  if (!SUPPORTED_VENDOR_IDS.includes(vendor)) return false;
  return AUTH_HOST_ALLOWLIST.some((pattern) => hostMatchesPattern(parsed.hostname, pattern));
}

function isAllowedBlankAuthPopup({ url, vendorId = 'chatgpt', openerUrl = '', frameName = '', disposition = '' } = {}) {
  const vendor = String(vendorId || 'chatgpt').trim().toLowerCase();
  if (!SUPPORTED_VENDOR_IDS.includes(vendor)) return false;
  if (String(url || '').trim().toLowerCase() !== 'about:blank') return false;

  const frame = String(frameName || '').trim().toLowerCase();
  const disp = String(disposition || '').trim().toLowerCase();
  const looksLikeAuth = frame.includes('oauth') || frame.includes('auth') || frame.includes('signin') || frame.includes('login') || !disp || disp.includes('tab') || disp.includes('window');
  if (!looksLikeAuth) return false;

  let openerHost = '';
  try {
    openerHost = new URL(String(openerUrl || '')).hostname;
  } catch {
    return false;
  }

  return [...VENDOR_HOST_ALLOWLIST, ...AUTH_HOST_ALLOWLIST].some((pattern) => hostMatchesPattern(openerHost, pattern));
}

export function shouldAllowPopup({ url, vendorId = 'chatgpt', allowAuthPopups = true, openerUrl = '', frameName = '', disposition = '' } = {}) {
  if (!allowAuthPopups) return false;
  if (isAllowedAuthPopupUrl(url, { vendorId })) return true;
  return isAllowedBlankAuthPopup({ url, vendorId, openerUrl, frameName, disposition });
}
