/* global window */

function el(id) {
  const n = document.getElementById(id);
  if (!n) throw new Error(`missing_element:${id}`);
  return n;
}

function fmtTime(ms) {
  try {
    const d = new Date(ms);
    return d.toLocaleString();
  } catch {
    return '';
  }
}

function num(id, fallback) {
  const raw = String(el(id).value || '').trim();
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function setNum(id, value, fallback = '') {
  const n = Number(value);
  el(id).value = Number.isFinite(n) ? String(n) : String(fallback);
}

function setChecked(id, value) {
  el(id).checked = !!value;
}

function setValue(id, value) {
  el(id).value = value == null ? '' : String(value);
}

const DEFAULT_SETTINGS = {
  maxInflightQueries: 2,
  maxQueriesPerMinute: 12,
  minTabGapMs: 1200,
  minGlobalGapMs: 200,
  browserBackend: 'chrome-cdp',
  chromeProfileMode: 'agentify',
  chromeDebugPort: 9222,
  chromeExecutablePath: '',
  showTabsByDefault: false,
  allowAuthPopups: true,
  acknowledgedAt: null
};

const FALLBACK_VENDORS = [
  { id: 'chatgpt', name: 'ChatGPT', status: 'supported' },
  { id: 'perplexity', name: 'Perplexity', status: 'supported' },
  { id: 'claude', name: 'Claude', status: 'supported' },
  { id: 'grok', name: 'Grok', status: 'supported' },
  { id: 'aistudio', name: 'Google AI Studio', status: 'supported' },
  { id: 'gemini', name: 'Gemini', status: 'supported' }
];

function defaultState() {
  return {
    vendors: [...FALLBACK_VENDORS],
    tabs: [],
    defaultTabId: null,
    stateDir: '',
    browserBackend: DEFAULT_SETTINGS.browserBackend,
    requestedBrowserBackend: DEFAULT_SETTINGS.browserBackend,
    browser: {},
    browserStartupError: null,
    runtime: { inflightQueries: 0, activeQueries: [] }
  };
}

function getBridge() {
  return window?.agentifyDesktop || null;
}

async function callApi(name, args, { fallback = null, required = false } = {}) {
  const bridge = getBridge();
  if (typeof bridge?.[name] !== 'function') {
    if (required) throw new Error(`${name} is unavailable in this window. Restart Agentify Desktop after updating.`);
    return fallback;
  }
  try {
    if (typeof args === 'undefined') return await bridge[name]();
    return await bridge[name](args);
  } catch (e) {
    if (required) throw e;
    return fallback;
  }
}

function applySettings(settings) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  setNum('setMaxInflight', s.maxInflightQueries, DEFAULT_SETTINGS.maxInflightQueries);
  setNum('setQpm', s.maxQueriesPerMinute, DEFAULT_SETTINGS.maxQueriesPerMinute);
  setNum('setTabGap', s.minTabGapMs, DEFAULT_SETTINGS.minTabGapMs);
  setNum('setGlobalGap', s.minGlobalGapMs, DEFAULT_SETTINGS.minGlobalGapMs);
  setChecked('setShowTabsDefault', s.showTabsByDefault);
  setValue('setBrowserBackend', s.browserBackend || DEFAULT_SETTINGS.browserBackend);
  setValue('setChromeProfileMode', s.chromeProfileMode || DEFAULT_SETTINGS.chromeProfileMode);
  setNum('setChromeDebugPort', s.chromeDebugPort || DEFAULT_SETTINGS.chromeDebugPort, DEFAULT_SETTINGS.chromeDebugPort);
  setValue('setChromeBinary', s.chromeExecutablePath || '');
  setChecked('setAllowAuthPopups', s.allowAuthPopups !== false);
  setChecked('setAcknowledge', false);
  el('btnSaveSettings').disabled = true;
  el('settingsHint').textContent = s.acknowledgedAt ? `Last acknowledged: ${s.acknowledgedAt}` : 'Using safe defaults until you acknowledge changes.';
  settingsDirty = false;
}

function setFooter(state, tabs, orch) {
  const runtime = state?.runtime || {};
  const activeQueries = Array.isArray(runtime.activeQueries) ? runtime.activeQueries : [];
  const inflight = Number(runtime.inflightQueries || activeQueries.length || 0);
  const runningOrchestrators = Array.isArray(orch?.running) ? orch.running : [];
  const backend = state?.browserBackend || state?.browser?.kind || DEFAULT_SETTINGS.browserBackend;
  const debugPort = state?.browser?.debugPort ? `:${state.browser.debugPort}` : '';
  const activity = activeQueries.length
    ? activeQueries.map((item) => `${item.tabId || 'tab'} ${String(item.phase || 'working').replace(/_/g, ' ')}`).join(' • ')
    : runningOrchestrators.length
      ? `Orchestrator: ${runningOrchestrators.map((item) => item.key || `pid ${item.pid}`).join(', ')}`
    : inflight
      ? `${inflight} request${inflight === 1 ? '' : 's'} in flight`
      : 'Idle';
  el('statusLine').innerHTML = `<span class="activityLabel">Activity:</span> ${activity} • Backend: ${backend}${debugPort} • Tabs: ${tabs.length}`;
}

function showStatus(message, tone = 'info') {
  const line = el('messageLine');
  line.textContent = message;
  line.classList.toggle('isWarn', tone === 'warn');
  line.classList.toggle('isError', tone === 'error');
  line.classList.toggle('isMuted', tone === 'muted');
}

let lastState = defaultState();
let chromeCdpWarningShown = false;
let settingsDirty = false;

function updateSaveEnabled() {
  el('btnSaveSettings').disabled = !settingsDirty || !el('setAcknowledge').checked;
}

function markSettingsDirty() {
  settingsDirty = true;
  updateSaveEnabled();
  el('settingsHint').textContent = 'Unsaved changes.';
}

function sanitizeIntegerField(input, { clamp = false } = {}) {
  const digits = String(input.value || '').replace(/[^\d]/g, '');
  input.value = digits;
  if (!clamp || !digits) return;
  const min = Number(input.dataset.min || 0);
  const max = Number(input.dataset.max || Number.MAX_SAFE_INTEGER);
  const next = Math.max(min, Math.min(max, Number(digits)));
  input.value = String(next);
}

function syncTabToggleButton() {
  const button = el('btnToggleTabs');
  const tabs = Array.isArray(lastState.tabs) ? lastState.tabs : [];
  const known = tabs.filter((tab) => typeof tab.visible === 'boolean');
  const allHidden = known.length > 0 && known.every((tab) => !tab.visible);
  button.classList.toggle('tabsAreHidden', allHidden);
  button.setAttribute('aria-pressed', allHidden ? 'true' : 'false');
  button.setAttribute('aria-label', allHidden ? 'Show all managed tabs' : 'Hide all managed tabs');
  button.title = allHidden ? 'Show all managed tabs' : 'Hide all managed tabs';
}

function closeDialog(dialog) {
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', 'open');
}

function currentSettingsPayload(overrides = {}) {
  return {
    maxInflightQueries: num('setMaxInflight', DEFAULT_SETTINGS.maxInflightQueries),
    maxQueriesPerMinute: num('setQpm', DEFAULT_SETTINGS.maxQueriesPerMinute),
    minTabGapMs: num('setTabGap', DEFAULT_SETTINGS.minTabGapMs),
    minGlobalGapMs: num('setGlobalGap', DEFAULT_SETTINGS.minGlobalGapMs),
    browserBackend: String(el('setBrowserBackend').value || DEFAULT_SETTINGS.browserBackend),
    chromeProfileMode: String(el('setChromeProfileMode').value || DEFAULT_SETTINGS.chromeProfileMode),
    chromeDebugPort: num('setChromeDebugPort', DEFAULT_SETTINGS.chromeDebugPort),
    chromeExecutablePath: String(el('setChromeBinary').value || '').trim() || null,
    allowAuthPopups: !!el('setAllowAuthPopups').checked,
    showTabsByDefault: !!el('setShowTabsDefault').checked,
    acknowledge: !!el('setAcknowledge').checked,
    ...overrides
  };
}

function uuidv4() {
  // RFC4122 v4, from crypto.getRandomValues (browser-safe).
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function refresh() {
  const state = { ...defaultState(), ...((await callApi('getState', undefined, { fallback: defaultState() })) || {}) };
  const settings = { ...DEFAULT_SETTINGS, ...((await callApi('getSettings', undefined, { fallback: DEFAULT_SETTINGS })) || {}) };
  const orch = (await callApi('getOrchestrators', undefined, { fallback: { running: [], recent: [] } })) || { running: [], recent: [] };
  lastState = state;
  syncTabToggleButton();

  const vendorSelect = el('vendorSelect');
  const prevVendor = String(vendorSelect.value || '').trim();
  vendorSelect.innerHTML = '';
  const vendors = Array.isArray(state.vendors) && state.vendors.length ? state.vendors : FALLBACK_VENDORS;
  for (const v of vendors) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = `${v.name}${v.status && v.status !== 'supported' ? ` (${v.status})` : ''}`;
    if (prevVendor ? v.id === prevVendor : v.id === 'chatgpt') opt.selected = true;
    vendorSelect.appendChild(opt);
  }

  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  const list = el('tabsList');
  const empty = el('tabsEmpty');
  list.innerHTML = '';
  empty.style.display = tabs.length ? 'none' : 'block';

  for (const t of tabs) {
    const row = document.createElement('div');
    row.className = 'tab';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = t.name || t.key || t.id;

    const sub = document.createElement('div');
    sub.className = 'sub';
    const vendorLabel = t.vendorName ? `${t.vendorName}` : 'Unknown vendor';
    const keyLabel = t.key ? `key=${t.key}` : 'no key';
    const used = t.lastUsedAt ? fmtTime(t.lastUsedAt) : '';
    sub.textContent = `${vendorLabel} • ${keyLabel}${used ? ` • used ${used}` : ''}`;

    meta.appendChild(title);
    meta.appendChild(sub);

    const controls = document.createElement('div');
    controls.className = 'controls';

    const btnShow = document.createElement('button');
    btnShow.className = 'btn secondary';
    btnShow.textContent = 'Show';
    btnShow.onclick = async () => {
      try {
        await callApi('showTab', { tabId: t.id }, { required: true });
        showStatus(`Opened tab: ${t.name || t.key || t.id}`);
      } catch (e) {
        showStatus(`Show tab failed: ${e?.message || String(e)}`);
      }
    };

    const btnHide = document.createElement('button');
    btnHide.className = 'btn secondary';
    btnHide.textContent = 'Hide';
    btnHide.onclick = async () => {
      try {
        await callApi('hideTab', { tabId: t.id }, { required: true });
        showStatus(`Hid tab: ${t.name || t.key || t.id}`);
      } catch (e) {
        showStatus(`Hide tab failed: ${e?.message || String(e)}`);
      }
    };

    const btnClose = document.createElement('button');
    btnClose.className = 'btn secondary';
    btnClose.textContent = 'Close';
    btnClose.onclick = async () => {
      if (t.protectedTab) return;
      try {
        await callApi('closeTab', { tabId: t.id }, { required: true });
        showStatus(`Closed tab: ${t.name || t.key || t.id}`);
        await refresh();
      } catch (e) {
        showStatus(`Close tab failed: ${e?.message || String(e)}`);
      }
    };

    if (t.protectedTab) btnClose.disabled = true;
    controls.appendChild(btnShow);
    controls.appendChild(btnHide);
    controls.appendChild(btnClose);

    row.appendChild(meta);
    row.appendChild(controls);
    list.appendChild(row);
  }

  setFooter(state, tabs, orch);

  // Settings UI.
  if (!settingsDirty) applySettings(settings);
  const browser = state.browser || {};
  const startupError = state.browserStartupError || null;
  el('browserHint').textContent = startupError
    ? `Chrome CDP unavailable (${startupError.code || startupError.message || 'startup failed'}). Active fallback: ${state.browserBackend || browser.kind || 'electron'}. Install Chrome/Chromium/Brave/Edge, then restart Agentify.`
    : `Active: ${state.browserBackend || browser.kind || 'chrome-cdp'}${browser.debugPort ? ` on port ${browser.debugPort}` : ''}. Restart Agentify after changing backend settings.`;
  if (startupError && !chromeCdpWarningShown) {
    chromeCdpWarningShown = true;
    el('chromeCdpReason').textContent =
      `Agentify could not start ${state.requestedBrowserBackend || 'Chrome CDP'} (${startupError.message || startupError.code || 'startup failed'}), so it opened with the Electron fallback.`;
    openDialog(el('chromeCdpModal'));
  }

  // Orchestrator status.
  const running = Array.isArray(orch?.running) ? orch.running : [];
  const recent = Array.isArray(orch?.recent) ? orch.recent : [];
  const statusLine =
    running.length === 0
      ? 'No orchestrators running.'
      : `Running: ${running.map((r) => `${r.key} (pid ${r.pid})`).join(', ')}`;
  el('orchStatus').textContent = statusLine;
  if (running.length === 1 && running[0].logPath) el('orchWorkspaceHint').textContent = `Log: ${running[0].logPath}`;
  else if (recent.length) el('orchWorkspaceHint').textContent = `Last exit: ${recent[0].key} code=${recent[0].exitCode ?? 'null'} signal=${recent[0].signal || 'null'}`;
  else el('orchWorkspaceHint').textContent = '';
}

async function main() {
  applySettings(DEFAULT_SETTINGS);

  el('btnRefresh').onclick = () => refresh().catch((e) => showStatus(`Refresh failed: ${e?.message || String(e)}`));
  el('btnOpenState').onclick = async () => {
    try {
      const bridge = getBridge();
      const method = typeof bridge?.openStateDir === 'function' ? 'openStateDir' : typeof bridge?.openStateFolder === 'function' ? 'openStateFolder' : null;
      if (!method) {
        showStatus('State folder is unavailable in this window. Restart Agentify Desktop after updating.', 'warn');
        return;
      }
      await callApi(method, undefined, { required: true });
      showStatus('Opened state folder.');
    } catch (e) {
      showStatus(`State folder failed: ${e?.message || String(e)}`, 'error');
    }
  };
  const setAllTabsVisible = async (visible) => {
    const bridge = getBridge();
    if (typeof bridge?.getState !== 'function') {
      showStatus('Tab controls are unavailable in this window. Restart Agentify Desktop after updating.', 'warn');
      return;
    }
    const freshState = await callApi('getState', undefined, { fallback: lastState });
    lastState = { ...defaultState(), ...(freshState || {}) };
    const tabs = Array.isArray(lastState.tabs) ? lastState.tabs : [];
    if (!tabs.length) {
      showStatus('No managed tabs are currently open.', 'muted');
      return;
    }
    if (typeof bridge?.setTabsVisible === 'function') {
      const out = await callApi('setTabsVisible', { visible }, { required: true });
      showStatus(`${visible ? 'Showed' : 'Hid'} ${out?.changed ?? tabs.length} managed tab${(out?.changed ?? tabs.length) === 1 ? '' : 's'}.`);
      await refresh();
      return;
    }
    const bulkName = visible ? 'showAllTabs' : 'hideAllTabs';
    if (typeof bridge?.[bulkName] === 'function') {
      const out = await callApi(bulkName, undefined, { required: true });
      showStatus(`${visible ? 'Showed' : 'Hid'} ${out?.changed ?? tabs.length} managed tab${(out?.changed ?? tabs.length) === 1 ? '' : 's'}.`);
      await refresh();
      return;
    }
    if (typeof bridge?.showTab !== 'function' || typeof bridge?.hideTab !== 'function') {
      showStatus('Tab controls are unavailable in this window. Restart Agentify Desktop after updating.', 'warn');
      return;
    }
    const apiName = visible ? 'showTab' : 'hideTab';
    let changed = 0;
    for (const tab of tabs) {
      try {
        await callApi(apiName, { tabId: tab.id }, { required: true });
        changed += 1;
      } catch (e) {
        showStatus(`${visible ? 'Show' : 'Hide'} all stopped at ${tab.name || tab.key || tab.id}: ${e?.message || String(e)}`);
        await refresh();
        return;
      }
    }
    showStatus(`${visible ? 'Showed' : 'Hid'} ${changed} managed tab${changed === 1 ? '' : 's'}.`);
    await refresh();
  };
  el('btnToggleTabs').onclick = () => {
    const tabs = Array.isArray(lastState.tabs) ? lastState.tabs : [];
    const known = tabs.filter((tab) => typeof tab.visible === 'boolean');
    const allHidden = known.length > 0 && known.every((tab) => !tab.visible);
    setAllTabsVisible(allHidden).catch((e) => showStatus(`${allHidden ? 'Show' : 'Hide'} all failed: ${e?.message || String(e)}`));
  };
  el('btnShowDefault').onclick = async () => {
    try {
      const bridge = getBridge();
      if (typeof bridge?.getState !== 'function' || typeof bridge?.showTab !== 'function') {
        showStatus('Default tab control is unavailable in this window. Restart Agentify Desktop after updating.', 'warn');
        return;
      }
      const st = (await callApi('getState', undefined, { fallback: defaultState() })) || defaultState();
      if (!st.defaultTabId) throw new Error('missing_default_tab');
      await callApi('showTab', { tabId: st.defaultTabId }, { required: true });
      showStatus(`Opened default tab: ${st.defaultTabId}`);
    } catch (e) {
      showStatus(`Open default tab failed: ${e?.message || String(e)}`, 'error');
    }
  };

  const riskModal = el('riskModal');
  el('btnRiskDetails').onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    openDialog(riskModal);
  };
  el('btnCloseRiskModal').onclick = () => {
    closeDialog(riskModal);
  };
  riskModal.addEventListener('click', (event) => {
    if (event.target === riskModal) el('btnCloseRiskModal').click();
  });

  const chromeCdpModal = el('chromeCdpModal');
  el('btnCloseChromeCdpModal').onclick = () => closeDialog(chromeCdpModal);
  el('btnChromeCdpContinueElectron').onclick = () => {
    closeDialog(chromeCdpModal);
    showStatus('Continuing with Electron fallback for this session.');
  };
  el('btnChromeCdpUseElectron').onclick = async () => {
    try {
      await callApi('setSettings', currentSettingsPayload({ browserBackend: 'electron', acknowledge: false }), { required: true });
      setValue('setBrowserBackend', 'electron');
      closeDialog(chromeCdpModal);
      showStatus('Electron saved as the default browser backend. Restart Agentify to apply cleanly.');
    } catch (e) {
      showStatus(`Could not save Electron default: ${e?.message || String(e)}`);
    }
  };
  el('btnChromeCdpKeepChrome').onclick = () => {
    closeDialog(chromeCdpModal);
    showStatus('Install Chrome, Chromium, Brave, or Edge, then restart Agentify Desktop with Chrome CDP selected.');
  };
  chromeCdpModal.addEventListener('click', (event) => {
    if (event.target === chromeCdpModal) el('btnCloseChromeCdpModal').click();
  });

  el('btnCreate').onclick = async () => {
    const vendorId = String(el('vendorSelect').value || '').trim();
    const key = String(el('tabKey').value || '').trim() || null;
    const name = String(el('tabName').value || '').trim() || null;
    const show = !!el('tabShow').checked;
    el('createHint').textContent = '';
    try {
      const out = await callApi('createTab', { vendorId, key, name, show }, { required: true });
      el('createHint').textContent = `Created tab ${out.tabId || ''}`;
      await refresh();
    } catch (e) {
      el('createHint').textContent = `Create failed: ${e?.message || String(e)}`;
    }
  };

  const orchRefresh = async () => {
    await refresh();
  };
  el('btnOrchRefresh').onclick = () => orchRefresh().catch(() => {});

  el('btnOrchStart').onclick = async () => {
    const key = String(el('orchKey').value || '').trim();
    const workspace = String(el('orchWorkspace').value || '').trim();
    if (!key) {
      el('orchStatus').textContent = 'Enter a project key.';
      return;
    }
    try {
      if (workspace) await callApi('setWorkspaceForKey', { key, workspace }, { required: true });
      await callApi('startOrchestrator', { key }, { required: true });
      await orchRefresh();
    } catch (e) {
      el('orchStatus').textContent = `Start failed: ${e?.message || String(e)}`;
    }
  };

  el('btnOrchStop').onclick = async () => {
    const key = String(el('orchKey').value || '').trim();
    if (!key) {
      el('orchStatus').textContent = 'Enter a project key.';
      return;
    }
    try {
      await callApi('stopOrchestrator', { key }, { required: true });
      await orchRefresh();
    } catch (e) {
      el('orchStatus').textContent = `Stop failed: ${e?.message || String(e)}`;
    }
  };

  el('btnOrchStopAll').onclick = async () => {
    try {
      await callApi('stopAllOrchestrators', undefined, { required: true });
      await orchRefresh();
    } catch (e) {
      el('orchStatus').textContent = `Stop all failed: ${e?.message || String(e)}`;
    }
  };

  el('btnOrchCopy').onclick = async () => {
    const key = String(el('orchKey').value || '').trim();
    if (!key) {
      el('orchStatus').textContent = 'Enter a project key first.';
      return;
    }
    const tool = String(el('orchTool').value || 'codex.run').trim();
    const obj =
      tool === 'codex.run'
        ? { agentify_tool: tool, id: uuidv4(), key, mode: 'interactive', args: { prompt: 'Describe the task for Codex here.' } }
        : tool === 'fs.read'
          ? { agentify_tool: tool, id: uuidv4(), key, mode: 'batch', args: { path: 'relative/path/to/file.txt', maxBytes: 50000 } }
        : { agentify_tool: tool, id: uuidv4(), key, mode: 'batch', args: {} };
    const text = `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
    try {
      await navigator.clipboard.writeText(text);
      el('orchStatus').textContent = 'Copied tool JSON to clipboard. Paste it into the ChatGPT thread.';
    } catch {
      el('orchStatus').textContent = 'Copy failed. Your browser may block clipboard access; select and copy manually: ' + text;
    }
  };

  el('orchKey').onchange = async () => {
    const key = String(el('orchKey').value || '').trim();
    if (!key) return;
    try {
      const ws = await callApi('getWorkspaceForKey', { key }, { required: true });
      const root = ws?.workspace?.root || '';
      if (root) {
        el('orchWorkspace').value = root;
        el('orchWorkspaceHint').textContent = `Saved workspace: ${root}`;
      } else {
        el('orchWorkspaceHint').textContent = 'No saved workspace for this key yet.';
      }
    } catch {}
  };

  el('setAcknowledge').onchange = updateSaveEnabled;
  for (const id of ['setMaxInflight', 'setQpm', 'setTabGap', 'setGlobalGap']) {
    const input = el(id);
    input.addEventListener('input', () => {
      sanitizeIntegerField(input);
      markSettingsDirty();
    });
    input.addEventListener('blur', () => {
      sanitizeIntegerField(input, { clamp: true });
      markSettingsDirty();
    });
  }
  for (const id of ['setShowTabsDefault', 'setAllowAuthPopups', 'setBrowserBackend', 'setChromeProfileMode', 'setChromeDebugPort', 'setChromeBinary']) {
    const input = el(id);
    input.addEventListener('input', markSettingsDirty);
    input.addEventListener('change', markSettingsDirty);
  }

  el('btnResetSettings').onclick = async () => {
    el('settingsHint').textContent = '';
    try {
      await callApi('setSettings', { reset: true }, { required: true });
      settingsDirty = false;
      el('settingsHint').textContent = 'Reset to defaults.';
      await refresh();
    } catch (e) {
      el('settingsHint').textContent = `Reset failed: ${e?.message || String(e)}`;
    }
  };

  el('btnSaveSettings').onclick = async () => {
    el('settingsHint').textContent = '';
    try {
      const payload = currentSettingsPayload();
      const out = await callApi('setSettings', payload, { required: true });
      settingsDirty = false;
      el('settingsHint').textContent = `Saved. Acknowledged: ${out.acknowledgedAt || 'no'}`;
      await refresh();
    } catch (e) {
      el('settingsHint').textContent = `Save failed: ${e?.message || String(e)}`;
    }
  };

  const bridge = getBridge();
  if (typeof bridge?.onTabsChanged === 'function') {
    try {
      bridge.onTabsChanged(() => {
        refresh().catch(() => {});
      });
    } catch (e) {
      showStatus(`Live updates unavailable: ${e?.message || String(e)}. Refresh still works.`, 'warn');
    }
  } else {
    showStatus('Live updates unavailable in this window. Refresh still works.', 'warn');
  }

  await refresh();
}

main().catch((e) => {
  applySettings(DEFAULT_SETTINGS);
  showStatus(`Control Center error: ${e?.message || String(e)}`);
});
