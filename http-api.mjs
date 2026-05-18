import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import { writeToken } from './state.mjs';

function isLoopback(remoteAddress) {
  const a = String(remoteAddress || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store, max-age=0',
    'access-control-allow-origin': 'http://127.0.0.1',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  });
  res.end(data);
}

async function parseBody(req, { maxBytes = 2_000_000 } = {}) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) throw new Error('body_too_large');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function authOk(req, token) {
  const hdr = String(req.headers.authorization || '');
  if (!hdr.startsWith('Bearer ')) return false;
  return hdr.slice('Bearer '.length).trim() === token;
}

function mapErrorToHttp(error) {
  const msg = String(error?.message || '');
  if (msg === 'body_too_large') return { code: 413, body: { error: 'body_too_large' } };
  if (msg === 'missing_url') return { code: 400, body: { error: 'missing_url' } };
  if (msg === 'missing_tabId') return { code: 400, body: { error: 'missing_tabId' } };
  if (msg === 'missing_key') return { code: 400, body: { error: 'missing_key' } };
  if (msg === 'key_vendor_mismatch') return { code: 409, body: { error: 'key_vendor_mismatch' } };
  if (msg === 'tab_not_found') return { code: 404, body: { error: 'tab_not_found' } };
  if (msg === 'tab_closed') return { code: 409, body: { error: 'tab_closed' } };
  if (msg === 'default_tab_protected') return { code: 409, body: { error: 'default_tab_protected' } };
  if (msg === 'max_tabs_reached') return { code: 409, body: { error: 'max_tabs_reached' } };
  if (msg === 'rate_limited') return { code: 429, body: { error: 'rate_limited', ...(error?.data || {}) } };
  return null;
}

function getTabIdFromUrl(url) {
  const tabId = String(url.searchParams.get('tabId') || '').trim();
  return tabId || null;
}

function envShowTabsDefault() {
  const v = String(process.env.AGENTIFY_DESKTOP_SHOW_TABS || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function normalizeVendorToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .replace(/[^a-z0-9.]+/g, '');
}

function resolveVendor({ body, vendors = [] } = {}) {
  const raw = String(body?.vendorId || body?.model || '').trim();
  if (!raw) return null;
  const token = normalizeVendorToken(raw);
  return (Array.isArray(vendors) ? vendors : []).find((v) => {
    return token === normalizeVendorToken(v?.id || '') || token === normalizeVendorToken(v?.name || '') || token === normalizeVendorToken(v?.url || '');
  }) || null;
}

function defaultVendor(vendors = []) {
  return (Array.isArray(vendors) ? vendors : []).find((v) => v.id === 'chatgpt') || (Array.isArray(vendors) ? vendors[0] : null) || null;
}

function listedTabMatchesVendor(tab, vendor) {
  if (!vendor) return true;
  const tabVendor = normalizeVendorToken(tab?.vendorId || '');
  const requestedVendor = normalizeVendorToken(vendor?.id || '');
  if (tabVendor && requestedVendor) return tabVendor === requestedVendor;
  const tabUrl = normalizeVendorToken(tab?.url || '');
  const requestedUrl = normalizeVendorToken(vendor?.url || '');
  if (tabUrl && requestedUrl) return tabUrl.startsWith(requestedUrl) || requestedUrl.startsWith(tabUrl);
  return true;
}

async function resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault = false, vendors = [] }) {
  const tabId = (body?.tabId ? String(body.tabId).trim() : '') || getTabIdFromUrl(url) || null;
  const key = (body?.key ? String(body.key).trim() : '') || null;
  const name = (body?.name ? String(body.name).trim() : '') || null;
  if (tabId) return tabId;
  const newWindow = body?.newWindow === true || body?.parallelWindow === true;
  const explicitVendor = resolveVendor({ body, vendors });
  if (key) {
    const existing = (tabs.listTabs?.() || []).find((t) => t?.key === key);
    if (existing?.id) {
      if (explicitVendor && !listedTabMatchesVendor(existing, explicitVendor)) throw new Error('key_vendor_mismatch');
      return existing.id;
    }
    const vendor = explicitVendor || defaultVendor(vendors);
    return await tabs.ensureTab({
      key,
      name,
      show: envShowTabsDefault() || showTabsByDefault,
      newWindow,
      url: vendor?.url,
      vendorId: vendor?.id,
      vendorName: vendor?.name
    });
  }
  if (explicitVendor) {
    const vendorKey = `vendor:${explicitVendor.id}`;
    const existing = (tabs.listTabs?.() || []).find((t) => t?.key === vendorKey);
    if (existing?.id) return existing.id;
    return await tabs.ensureTab({
      key: vendorKey,
      name: explicitVendor.name || explicitVendor.id,
      show: envShowTabsDefault() || showTabsByDefault,
      newWindow,
      url: explicitVendor.url,
      vendorId: explicitVendor.id,
      vendorName: explicitVendor.name
    });
  }
  return defaultTabId;
}

export function startHttpApi({
  host = '127.0.0.1',
  port,
  token,
  tabs,
  defaultTabId,
  serverId,
  stateDir,
  onShow,
  onHide,
  onShutdown,
  getStatus,
  getSettings,
  vendors = []
}) {
  const tokenRef = typeof token === 'string' ? { current: token } : token;

  // Governor state (per-desktop instance).
  const inflight = { queries: 0 };
  const lastQueryAt = new Map(); // tabId -> ms
  let lastAnyQueryAt = 0;
  const bucket = { tokens: null, lastRefillAt: Date.now(), lastCap: null };

  const getGovernor = async () => {
    const s = (await getSettings?.().catch(() => null)) || {};
    const maxInflightQueries = Math.max(1, Number(s.maxInflightQueries || 2) || 2);
    const maxQueriesPerMinute = Math.max(1, Number(s.maxQueriesPerMinute || 12) || 12);
    const minTabGapMs = Math.max(0, Number(s.minTabGapMs || 0) || 0);
    const minGlobalGapMs = Math.max(0, Number(s.minGlobalGapMs || 0) || 0);
    const showTabsByDefault = !!s.showTabsByDefault;
    return { maxInflightQueries, maxQueriesPerMinute, minTabGapMs, minGlobalGapMs, showTabsByDefault };
  };

  const checkAndConsumeQueryBudget = ({ tabId, governor }) => {
    const now = Date.now();
    if (inflight.queries >= governor.maxInflightQueries) {
      const err = new Error('rate_limited');
      err.data = { reason: 'max_inflight', retryAfterMs: 250 };
      throw err;
    }

    const lastTab = lastQueryAt.get(tabId) || 0;
    const tabWait = governor.minTabGapMs - (now - lastTab);
    if (tabWait > 0) {
      const err = new Error('rate_limited');
      err.data = { reason: 'tab_gap', retryAfterMs: tabWait };
      throw err;
    }

    const globalWait = governor.minGlobalGapMs - (now - lastAnyQueryAt);
    if (globalWait > 0) {
      const err = new Error('rate_limited');
      err.data = { reason: 'global_gap', retryAfterMs: globalWait };
      throw err;
    }

    // Token bucket (per minute).
    const cap = governor.maxQueriesPerMinute;
    const ratePerMs = cap / 60_000;
    const elapsed = Math.max(0, now - bucket.lastRefillAt);
    if (bucket.tokens == null) bucket.tokens = cap;
    if (bucket.lastCap == null) bucket.lastCap = cap;
    if (cap !== bucket.lastCap) {
      if (cap > bucket.lastCap) bucket.tokens = Math.min(cap, bucket.tokens + (cap - bucket.lastCap));
      else bucket.tokens = Math.min(cap, bucket.tokens);
      bucket.lastCap = cap;
    }
    bucket.tokens = Math.min(cap, bucket.tokens + elapsed * ratePerMs);
    bucket.lastRefillAt = now;

    if (bucket.tokens < 1) {
      const needed = 1 - bucket.tokens;
      const retryAfterMs = Math.ceil(needed / ratePerMs);
      const err = new Error('rate_limited');
      err.data = { reason: 'qpm', retryAfterMs: Math.max(50, retryAfterMs) };
      throw err;
    }

    bucket.tokens -= 1;
    lastQueryAt.set(tabId, now);
    lastAnyQueryAt = now;
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) return sendJson(res, 403, { error: 'forbidden' });
      if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });

      const url = new URL(req.url || '/', `http://${host}`);
      if (url.pathname === '/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, serverId: serverId || null });

      if (!authOk(req, tokenRef.current)) return sendJson(res, 401, { error: 'unauthorized' });

      const governor = await getGovernor();

      if (url.pathname === '/status' && req.method === 'GET') {
        const tabId = getTabIdFromUrl(url) || defaultTabId;
        const st = await getStatus({ tabId });
        return sendJson(res, 200, st);
      }

      if (url.pathname === '/show' && req.method === 'POST') {
        const body = await parseBody(req);
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, vendors });
        await onShow?.({ tabId });
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === '/hide' && req.method === 'POST') {
        const body = await parseBody(req);
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, vendors });
        await onHide?.({ tabId });
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/tabs' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, tabs: tabs.listTabs(), defaultTabId });
      }
      if (url.pathname === '/tabs/create' && req.method === 'POST') {
        const body = await parseBody(req);
        const key = (body.key ? String(body.key).trim() : '') || null;
        const name = (body.name ? String(body.name).trim() : '') || null;
        const show = typeof body.show === 'boolean' ? body.show : envShowTabsDefault() || governor.showTabsByDefault;
        const newWindow = body.newWindow === true || body.parallelWindow === true;
        const vendor = resolveVendor({ body, vendors }) || defaultVendor(vendors);
        const tabId = key
          ? await tabs.ensureTab({ key, name, show, newWindow, url: vendor?.url, vendorId: vendor?.id, vendorName: vendor?.name })
          : await tabs.createTab({ name, show, newWindow, url: vendor?.url, vendorId: vendor?.id, vendorName: vendor?.name });
        if (show) await onShow?.({ tabId }).catch(() => {});
        return sendJson(res, 200, { ok: true, tabId });
      }
      if (url.pathname === '/tabs/close' && req.method === 'POST') {
        const body = await parseBody(req);
        const tabId = (body.tabId ? String(body.tabId).trim() : '') || null;
        if (!tabId) return sendJson(res, 400, { error: 'missing_tabId' });
        if (tabId === defaultTabId) throw new Error('default_tab_protected');
        await tabs.closeTab(tabId);
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/shutdown' && req.method === 'POST') {
        // Must be authenticated. Best-effort: return OK then let caller quit the app.
        const body = await parseBody(req);
        const scope = String(body.scope || 'app');
        if (scope !== 'app') return sendJson(res, 400, { error: 'invalid_scope' });
        sendJson(res, 200, { ok: true });
        await onHide?.({ tabId: defaultTabId }).catch(() => {});
        await onShutdown?.().catch(() => {});
        return;
      }

      if (url.pathname === '/rotate-token' && req.method === 'POST') {
        if (!stateDir) return sendJson(res, 500, { error: 'misconfigured_stateDir' });
        const next = crypto.randomBytes(24).toString('hex');
        await writeToken(next, stateDir);
        tokenRef.current = next;
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/navigate' && req.method === 'POST') {
        const body = await parseBody(req);
        const to = String(body.url || '').trim();
        if (!to) return sendJson(res, 400, { error: 'missing_url' });
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, vendors });
        const controller = tabs.getControllerById(tabId);
        await controller.navigate(to);
        return sendJson(res, 200, { ok: true, tabId, url: await controller.getUrl() });
      }

      if (url.pathname === '/ensure-ready' && req.method === 'POST') {
        const body = await parseBody(req);
        const timeoutMs = Number(body.timeoutMs || 0) || 10 * 60_000;
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, vendors });
        const controller = tabs.getControllerById(tabId);
        const st = await controller.ensureReady({ timeoutMs });
        return sendJson(res, 200, { ok: true, tabId, state: st });
      }

      if (url.pathname === '/query' && req.method === 'POST') {
        const body = await parseBody(req, { maxBytes: 5_000_000 });
        const timeoutMs = Number(body.timeoutMs || 0) || 10 * 60_000;
        const prompt = String(body.prompt || '');
        const attachments = Array.isArray(body.attachments) ? body.attachments.map(String) : [];
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, vendors });
        checkAndConsumeQueryBudget({ tabId, governor });
        inflight.queries += 1;
        const controller = tabs.getControllerById(tabId);
        try {
          const result = await controller.query({ prompt, attachments, timeoutMs });
          return sendJson(res, 200, { ok: true, tabId, result });
        } finally {
          inflight.queries = Math.max(0, inflight.queries - 1);
        }
      }

      if (url.pathname === '/send' && req.method === 'POST') {
        const body = await parseBody(req, { maxBytes: 5_000_000 });
        const timeoutMs = Number(body.timeoutMs || 0) || 3 * 60_000;
        const text = String(body.text || '');
        const stopAfterSend = !!body.stopAfterSend;
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, vendors });
        // Apply the same governor as /query since it still sends a message.
        checkAndConsumeQueryBudget({ tabId, governor });
        inflight.queries += 1;
        const controller = tabs.getControllerById(tabId);
        try {
          const result = await controller.send({ text, timeoutMs, stopAfterSend });
          return sendJson(res, 200, { ok: true, tabId, result });
        } finally {
          inflight.queries = Math.max(0, inflight.queries - 1);
        }
      }

      if (url.pathname === '/image-gen' && req.method === 'POST') {
        const body = await parseBody(req, { maxBytes: 5_000_000 });
        const timeoutMs = Number(body.timeoutMs || 0) || 10 * 60_000;
        const prompt = String(body.prompt || '');
        const attachments = Array.isArray(body.attachments) ? body.attachments.map(String) : [];
        const maxImages = Number(body.maxImages || 0) || 6;
        const minImages = Number(body.minImages || 0) || 1;
        const postprocess = body.postprocess !== false;
        const postprocessMode = String(body.postprocessMode || 'auto');
        const imageOptions = body.imageOptions && typeof body.imageOptions === 'object' ? body.imageOptions : {};
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, vendors });
        checkAndConsumeQueryBudget({ tabId, governor });
        inflight.queries += 1;
        const controller = tabs.getControllerById(tabId);
        try {
          const result = await controller.generateImages({ prompt, attachments, timeoutMs, maxImages, minImages });
          const files = await controller.downloadLastAssistantImages({ maxImages, postprocess, postprocessMode, imageOptions });
          return sendJson(res, 200, { ok: true, tabId, result, files });
        } finally {
          inflight.queries = Math.max(0, inflight.queries - 1);
        }
      }

      if (url.pathname === '/read-page' && req.method === 'POST') {
        const body = await parseBody(req);
        const maxChars = Number(body.maxChars || 0) || 200_000;
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, vendors });
        const controller = tabs.getControllerById(tabId);
        const text = await controller.readPageText({ maxChars });
        return sendJson(res, 200, { ok: true, tabId, text });
      }

      if (url.pathname === '/inspect-ui' && req.method === 'POST') {
        const body = await parseBody(req);
        const limit = Number(body.limit || 0) || 120;
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, vendors });
        const controller = tabs.getControllerById(tabId);
        const elements = await controller.inspectUi({ limit });
        return sendJson(res, 200, { ok: true, tabId, elements });
      }

      if (url.pathname === '/click-ui' && req.method === 'POST') {
        const body = await parseBody(req);
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, vendors });
        const controller = tabs.getControllerById(tabId);
        const result = await controller.clickUi({
          text: body.text,
          aria: body.aria,
          testId: body.testId,
          role: body.role,
          index: body.index
        });
        return sendJson(res, 200, { ok: true, tabId, result });
      }

      if (url.pathname === '/download-images' && req.method === 'POST') {
        const body = await parseBody(req);
        const maxImages = Number(body.maxImages || 0) || 6;
        const postprocess = body.postprocess !== false;
        const postprocessMode = String(body.postprocessMode || 'auto');
        const imageOptions = body.imageOptions && typeof body.imageOptions === 'object' ? body.imageOptions : {};
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, vendors });
        const controller = tabs.getControllerById(tabId);
        const files = await controller.downloadLastAssistantImages({ maxImages, postprocess, postprocessMode, imageOptions });
        return sendJson(res, 200, { ok: true, tabId, files });
      }

      return sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      const mapped = mapErrorToHttp(error);
      if (mapped) return sendJson(res, mapped.code, mapped.body);
      return sendJson(res, 500, { error: 'internal_error', message: error?.message || String(error), data: error?.data || null });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
