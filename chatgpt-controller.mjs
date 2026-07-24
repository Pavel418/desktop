import fs from 'node:fs/promises';
import path from 'node:path';

export const ATTACHMENT_RUNTIME_REVISION = 'active-composer-v3';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// A composer snapshot ({chips, matched, uploading}) only proves EVERY requested file
// attached when its chip/name-match count reaches the expected count — a single chip
// (or match) is not enough when more than one file was requested. Exported so the
// exact boolean the retry loop relies on can be unit-tested without driving real
// browser timing.
export function attachmentsComplete(snapshot, expectedCount) {
  const chips = Number(snapshot?.chips) || 0;
  const matched = Number(snapshot?.matched) || 0;
  return chips >= expectedCount || matched >= expectedCount;
}

// Signature of an attachment snapshot used to detect genuine stalls (no new chip or
// match count between polls), independent of whether any file has attached yet. Two
// snapshots with the same key represent no progress since the last poll.
export function attachmentProgressKey(snapshot) {
  const chips = Number(snapshot?.chips) || 0;
  const matched = Number(snapshot?.matched) || 0;
  const uploading = snapshot?.uploading ? 1 : 0;
  return `${chips}:${matched}:${uploading}`;
}

// A single-file upload attempt succeeds when its filename becomes visible or the
// composer gains a new attachment chip. The chip delta covers UI variants that
// split or truncate filenames so a text match is not always possible.
export function attachmentAttemptComplete(snapshot, { stem = '', baselineChips = 0 } = {}) {
  const matchedStems = Array.isArray(snapshot?.matchedStems) ? snapshot.matchedStems : [];
  const normalizedStem = String(stem || '').toLowerCase();
  return (normalizedStem && matchedStems.includes(normalizedStem)) || (Number(snapshot?.chips) || 0) > baselineChips;
}

export const RESPONSE_COMPLETION_DEFAULTS = Object.freeze({
  idleMs: 5000,
  terminalMs: 5000,
  incompleteTerminalMs: 15000,
  unknownFallbackMs: 60000,
  incompleteFallbackMs: 10 * 60_000
});

// Pure decision boundary for the response waiter. UI idleness alone is deliberately
// insufficient for a response that a caller knows is structurally incomplete: tool
// execution can temporarily remove the stop button while the final answer is only a
// few characters long. A completed semantic envelope can return after ordinary idle
// stabilization; incomplete/unknown content needs a terminal turn control or a much
// longer fail-safe interval.
export function responseCompletionDecision(state, config = RESPONSE_COMPLETION_DEFAULTS) {
  const text = String(state?.text || '');
  if (!state?.started || !text || state?.busy || !state?.stable) return { done: false, reason: null };

  const idleForMs = Number(state?.idleForMs) || 0;
  const terminalForMs = Number(state?.terminalForMs) || 0;
  const semanticState = ['complete', 'incomplete', 'unknown'].includes(state?.semanticState)
    ? state.semanticState
    : 'unknown';

  if (state?.hasError && idleForMs >= config.idleMs) return { done: true, reason: 'terminal_error' };
  if (semanticState === 'complete' && idleForMs >= config.idleMs) {
    return { done: true, reason: 'semantic_complete' };
  }

  if (state?.terminalVisible) {
    const required = semanticState === 'incomplete' ? config.incompleteTerminalMs : config.terminalMs;
    if (idleForMs >= required && terminalForMs >= required) {
      return { done: true, reason: semanticState === 'incomplete' ? 'terminal_incomplete' : 'terminal_ui' };
    }
  }

  const fallbackMs = semanticState === 'incomplete'
    ? config.incompleteFallbackMs
    : config.unknownFallbackMs;
  if (idleForMs >= fallbackMs) return { done: true, reason: `${semanticState}_idle_fallback` };
  return { done: false, reason: null };
}

function jitter(minMs, maxMs) {
  const min = Math.max(0, Number(minMs) || 0);
  const max = Math.max(min, Number(maxMs) || 0);
  return Math.floor(min + Math.random() * (max - min + 1));
}

function blockedTitle(kind) {
  if (kind === 'login') return 'Needs sign-in';
  if (kind === 'captcha') return 'Needs CAPTCHA';
  if (kind === 'blocked') return 'Access blocked';
  if (kind === 'ui') return 'Needs page ready';
  return 'Needs attention';
}

class Mutex {
  #p = Promise.resolve();
  async run(fn) {
    const start = this.#p;
    let release;
    this.#p = new Promise((r) => (release = r));
    await start;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class ChatGPTController {
  constructor({ page, selectors, onBlocked, onUnblocked, stateDir, onDebug = null, stallInspect = null }) {
    this.page = page;
    this.selectors = selectors;
    this.onBlocked = onBlocked;
    this.onUnblocked = onUnblocked;
    this.onDebug = typeof onDebug === 'function' ? onDebug : null;
    this.stateDir = stateDir;
    // Stall-inspection debug mode: when enabled, a suspected "stall" (an idle-fallback with a
    // near-empty reply) does NOT trigger the normal fallback. Instead the controller dumps the
    // full DOM truth + screenshots to stateDir and HOLDS, so we can see whether the reply is
    // genuinely empty on-page or our reader is grabbing the wrong node. { enabled, holdMs, intervalMs }.
    this.stallInspect = stallInspect && stallInspect.enabled
      ? {
          enabled: true,
          holdMs: Number(stallInspect.holdMs) > 0 ? Number(stallInspect.holdMs) : 30 * 60_000,
          intervalMs: Number(stallInspect.intervalMs) > 0 ? Number(stallInspect.intervalMs) : 20_000
        }
      : null;
    this.mutex = new Mutex();
    this.blocked = false;
    this.blockedKind = null;
    this.serverId = null;
    this.mouse = { x: 30, y: 30 };
    this.currentRun = null;
    // Network-layer attachment upload watcher, live from #attachFiles through the send-gate.
    this.uploadWatch = null;
  }

  // Compact one-line summary of the current network upload snapshot for debug logs.
  #uploadSummary() {
    const snap = this.uploadWatch?.snapshot?.();
    if (!snap) return null;
    return (
      `net-uploads: total=${snap.total} inflight=${snap.inflight} finished=${snap.finished} ` +
      `failed=${snap.failed} oldestInflightMs=${snap.oldestInflightMs}`
    );
  }

  #stopUploadWatch() {
    try {
      this.uploadWatch?.off?.();
    } catch {}
    this.uploadWatch = null;
  }

  async runExclusive(fn) {
    return await this.mutex.run(fn);
  }

  async navigate(url) {
    await this.page.navigate(url);
  }

  async #eval(js) {
    return await this.page.evaluate(js);
  }

  async #emitProgress(patch) {
    if (!this.currentRun?.onProgress || !patch || typeof patch !== 'object') return;
    try {
      await this.currentRun.onProgress({ ...patch });
    } catch {}
  }

  async getUrl() {
    return await this.page.getUrl();
  }

  async readPageText({ maxChars = 200_000 } = {}) {
    const text = await this.#eval(`(() => {
      const cap = ${maxChars};
      const clean = (s) => String(s || '').replace(/\\u0000/g, '').replace(/\\s+\\n/g, '\\n').trim();
      const root = document.querySelector('main') || document.body || document.documentElement;

      let txt = clean(root?.innerText) || clean(document.body?.innerText) || clean(document.documentElement?.innerText);
      if (!txt) txt = clean(root?.textContent) || clean(document.body?.textContent) || clean(document.documentElement?.textContent);

      // Last fallback for heavily client-rendered/shell pages where innerText may be empty pre-hydration.
      if (!txt) {
        const hints = Array.from(document.querySelectorAll('button, a, input, textarea, [role=\"button\"], [aria-label], [placeholder]'))
          .slice(0, 400)
          .map((n) => [n.getAttribute('aria-label'), n.getAttribute('placeholder'), n.textContent].filter(Boolean).join(' ').trim())
          .filter(Boolean);
        txt = clean(hints.join('\\n'));
      }

      return txt.slice(0, cap);
    })()`);
    return String(text || '');
  }

  async detectChallenge() {
    const result = await this.#eval(`(() => {
      const url = location.href || '';
      const title = document.title || '';
      const readyState = document.readyState || '';
      const bodyText = (document.body?.innerText || '').slice(0, 5000);
      const iframeSrcs = Array.from(document.querySelectorAll('iframe'))
        .map(f => String(f.getAttribute('src') || ''))
        .filter(Boolean);
      const visible = (n) => {
        if (!n) return false;
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };

      const hasTurnstile = iframeSrcs.some(s => /turnstile/i.test(s)) || !!document.querySelector('iframe[src*=\"turnstile\" i]');
      const hasArkose = iframeSrcs.some(s => /arkoselabs|arkose/i.test(s)) || !!document.querySelector('iframe[src*=\"arkose\" i], iframe[src*=\"arkoselabs\" i]');
      const hasVerifyButton = Array.from(document.querySelectorAll('button, a'))
        .some(b => /verify you are human|human verification|i am human/i.test((b.textContent || '').trim()));

      const looks403 = /\\b403\\b|access denied|forbidden|unusual traffic|verify/i.test(bodyText) && !/prompt/i.test(bodyText);
      const loginLike = !!document.querySelector('input[type=\"password\"], input[name=\"password\"], input[autocomplete=\"current-password\"]')
        || /log in|sign in|continue with/i.test(bodyText);

      const rawPromptVisible = (() => {
        const pickPrompt = (nodes) => {
          const editable = (n) => {
            if (!n) return false;
            if (!visible(n)) return false;
            if (n.matches('textarea')) return !n.disabled && !n.readOnly;
            if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
            return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
          };
          const score = (n) => {
            const r = n.getBoundingClientRect();
            const label = [
              n.getAttribute('aria-label') || '',
              n.getAttribute('placeholder') || '',
              n.getAttribute('name') || '',
              n.getAttribute('id') || '',
              n.getAttribute('data-testid') || ''
            ].join(' ').toLowerCase();
            let s = 0;
            if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
            if (n.matches('textarea')) s += 50;
            if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
            if (n.getAttribute('role') === 'textbox') s += 25;
            if (r.width >= 260 && r.height >= 26) s += 20;
            s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
            s += Math.max(0, r.y / 8);
            return s;
          };
          let best = null;
          let bestScore = -Infinity;
          for (const n of nodes) {
            if (!editable(n)) continue;
            const s = score(n);
            if (s > bestScore) {
              bestScore = s;
              best = n;
            }
          }
          return best;
        };

        const base = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const uniq = [];
        const seen = new Set();
        for (const n of [...base, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          uniq.push(n);
        }
        return !!pickPrompt(uniq);
      })();

      const sendVisible = (() => {
        const labelOf = (n) =>
          [
            n.getAttribute('aria-label') || '',
            n.getAttribute('title') || '',
            n.getAttribute('data-testid') || '',
            n.textContent || ''
          ]
            .join(' ')
            .replace(/\\s+/g, ' ')
            .trim()
            .toLowerCase();
        return Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.sendButton)})).some((n) => {
          if (!visible(n)) return false;
          const label = labelOf(n);
          if (/stop|cancel|retry|signin|sign in|log in|login|continue with|google|microsoft|apple/.test(label)) return false;
          return /send|submit|run|go|ask|reply/.test(label) || n.matches('[data-testid=\"send-button\"], [aria-label=\"Send prompt\"], [aria-label=\"Send\"]');
        });
      })();
      const promptVisible = rawPromptVisible && (!loginLike || sendVisible);

      const blocked = hasTurnstile || hasArkose || hasVerifyButton || looks403 || (loginLike && !promptVisible);
      const kind = (hasTurnstile || hasArkose || hasVerifyButton) ? 'captcha' : (loginLike ? 'login' : (looks403 ? 'blocked' : null));
      return {
        url, title, readyState,
        blocked,
        promptVisible,
        kind,
        indicators: { hasTurnstile, hasArkose, hasVerifyButton, looks403, loginLike, rawPromptVisible, sendVisible }
      };
    })()`);

    return result;
  }

  async waitForPromptVisible({ timeoutMs = 10 * 60_000, pollMs = 500 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      const st = await this.detectChallenge().catch(() => null);
      if (st?.blocked) await this.#enterBlockedState(st);
      if (st?.promptVisible) return st;

      const elapsed = Date.now() - start;
      if (!this.blocked && elapsed > 5000 && st?.readyState === 'complete') {
        await this.#enterBlockedState({ ...(st || {}), blocked: true, kind: 'ui' });
      }
      await sleep(pollMs);
    }
    const last = await this.detectChallenge().catch(() => null);
    const err = new Error('timeout_waiting_for_prompt');
    err.data = last;
    throw err;
  }

  async ensureReady({ timeoutMs = 10 * 60_000 } = {}) {
    await this.#emitProgress({ phase: 'waiting_for_ready', blocked: false, blockedKind: null, blockedTitle: null });
    const st = await this.detectChallenge().catch(() => null);
    if (st?.blocked) {
      await this.#enterBlockedState(st);
    }
    const ready = await this.waitForPromptVisible({ timeoutMs });
    await this.#exitBlockedStateIfNeeded();
    return ready;
  }

  async #enterBlockedState(st) {
    if (!this.blocked) {
      this.blocked = true;
      this.blockedKind = st?.kind || null;
      await this.#emitProgress({
        phase: 'awaiting_user',
        blocked: true,
        blockedKind: this.blockedKind || 'blocked',
        blockedTitle: blockedTitle(this.blockedKind)
      });
      await this.onBlocked?.(st);
    }
  }

  async #exitBlockedStateIfNeeded() {
    if (this.blocked) {
      this.blocked = false;
      this.blockedKind = null;
      await this.#emitProgress({ blocked: false, blockedKind: null, blockedTitle: null });
      await this.onUnblocked?.();
    }
  }

  async #sendKey(key, { modifiers = [] } = {}) {
    await this.page.sendKey(key, { modifiers });
  }

  #throwIfStopRequested() {
    if (!this.currentRun?.requested) return;
    const err = new Error('query_aborted');
    err.data = {
      reason: this.currentRun.reason || 'user_stop',
      requestedAt: this.currentRun.requestedAt || null
    };
    throw err;
  }

  async #clickVisibleStop() {
    const stopSel = JSON.stringify(this.selectors.stopButton);
    return await this.#eval(`(() => {
      const visible = (n) => {
        if (!n) return false;
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const stop = Array.from(document.querySelectorAll(${stopSel})).find(visible);
      if (!stop) return false;
      try {
        stop.click();
        return true;
      } catch {
        return false;
      }
    })()`);
  }

  async requestStop({ reason = 'user_stop' } = {}) {
    if (this.currentRun) {
      this.currentRun.requested = true;
      this.currentRun.requestedAt = Date.now();
      this.currentRun.reason = reason || 'user_stop';
    }
    const clicked = await this.#clickVisibleStop().catch(() => false);
    return { ok: true, requested: !!this.currentRun || !!clicked, clicked };
  }

  async #typeHuman(text) {
    // Insert per line. A raw "\n" fed to the composer is interpreted as Enter and
    // SENDS the message, so newlines must be soft breaks (Shift+Enter). Inserting a
    // whole line at once also keeps large prompts fast (one call per line, not per char).
    const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      this.#throwIfStopRequested();
      if (i > 0) {
        await this.#sendKey('Enter', { modifiers: ['shift'] });
        await sleep(jitter(8, 24));
      }
      if (lines[i].length) {
        await this.page.insertText(lines[i]);
        await sleep(jitter(8, 24));
      }
    }
  }

  async #moveMouseTo(x, y) {
    const from = { ...this.mouse };
    const steps = Math.max(6, Math.min(22, Math.floor(Math.hypot(x - from.x, y - from.y) / 35)));
    for (let i = 1; i <= steps; i++) {
      this.#throwIfStopRequested();
      const t = i / steps;
      const nx = Math.round(from.x + (x - from.x) * t + jitter(-2, 2));
      const ny = Math.round(from.y + (y - from.y) * t + jitter(-2, 2));
      await this.page.moveMouse(nx, ny);
      await sleep(jitter(6, 18));
      this.mouse = { x: nx, y: ny };
    }
  }

  async #clickAt(x, y) {
    await this.#moveMouseTo(x, y);
    await this.page.mouseDown(x, y, { button: 'left', clickCount: 1 });
    await sleep(jitter(20, 60));
    await this.page.mouseUp(x, y, { button: 'left', clickCount: 1 });
  }

  async #typePrompt(prompt) {
    await this.#emitProgress({ phase: 'typing_prompt' });
    const sel = JSON.stringify(this.selectors.promptTextarea);
    const ok = await this.#eval(`(() => {
      const visible = (n) => {
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const editable = (n) => {
        if (!n) return false;
        if (!visible(n)) return false;
        if (n.matches('textarea')) return !n.disabled && !n.readOnly;
        if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
        return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
      };
      const score = (n) => {
        const r = n.getBoundingClientRect();
        const label = [
          n.getAttribute('aria-label') || '',
          n.getAttribute('placeholder') || '',
          n.getAttribute('name') || '',
          n.getAttribute('id') || '',
          n.getAttribute('data-testid') || ''
        ].join(' ').toLowerCase();
        let s = 0;
        if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
        if (n.matches('textarea')) s += 50;
        if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
        if (n.getAttribute('role') === 'textbox') s += 25;
        if (r.width >= 260 && r.height >= 26) s += 20;
        s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
        s += Math.max(0, r.y / 8); // lower on page is more likely the composer
        return s;
      };
      const base = Array.from(document.querySelectorAll(${sel}));
      const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
      const candidates = [];
      const seen = new Set();
      for (const n of [...base, ...fallback]) {
        if (!n || seen.has(n)) continue;
        seen.add(n);
        candidates.push(n);
      }
      let el = null;
      let best = -Infinity;
      for (const n of candidates) {
        if (!editable(n)) continue;
        const s = score(n);
        if (s > best) {
          best = s;
          el = n;
        }
      }
      if (!el) return { ok:false, error:'missing_prompt_textarea' };
      el.focus();
      const r = el.getBoundingClientRect();
      return { ok:true, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
    })()`);
    if (!ok?.ok) {
      const err = new Error(ok?.error || 'type_failed');
      err.data = ok;
      throw err;
    }

    // Human-like click + select-all + type.
    if (ok?.rect?.w > 0 && ok?.rect?.h > 0) {
      const cx = Math.round(ok.rect.x + Math.min(ok.rect.w - 6, 18));
      const cy = Math.round(ok.rect.y + Math.min(ok.rect.h - 6, 18));
      await this.#clickAt(cx, cy);
    }

    const isMac = process.platform === 'darwin';
    await sleep(jitter(25, 80));
    await this.#sendKey('A', { modifiers: [isMac ? 'meta' : 'control'] });
    await sleep(jitter(15, 50));
    await this.#sendKey('Backspace');
    await sleep(jitter(25, 80));
    await this.#typeHuman(prompt);
  }

  async #waitForSendSignal({ timeoutMs = 1800, pollMs = 120 } = {}) {
    const stopSel = JSON.stringify(this.selectors.stopButton);
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const promptSel = JSON.stringify(this.selectors.promptTextarea);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      const snap = await this.#eval(`(() => {
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const stopVisible = Array.from(document.querySelectorAll(${stopSel})).some(visible);
        const send = Array.from(document.querySelectorAll(${sendSel})).find(visible);
        const sendDisabled = !!send && !!send.disabled;

        const promptCandidates = Array.from(document.querySelectorAll(${promptSel}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const uniq = [];
        const seen = new Set();
        for (const n of [...promptCandidates, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          uniq.push(n);
        }
        let promptLen = -1;
        for (const n of uniq) {
          if (!visible(n)) continue;
          if (n.matches('textarea, input')) {
            promptLen = String(n.value || '').trim().length;
            break;
          }
          if (n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox') {
            promptLen = String(n.innerText || n.textContent || '').trim().length;
            break;
          }
        }
        return { stopVisible, sendDisabled, promptLen };
      })()`);

      if (snap?.stopVisible || snap?.sendDisabled || snap?.promptLen === 0) return true;
      await sleep(pollMs);
    }
    return false;
  }

  // Before sending, wait out any in-flight upload: ChatGPT keeps the send button
  // disabled while attachments upload, so we hold until it is enabled (or uploads
  // clear). Prevents firing the prompt before files finish attaching.
  async #waitForUploadsToSettle({ timeoutMs = 120_000, pollMs = 400, stableMs = 600 } = {}) {
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const start = Date.now();
    let readySince = null;
    let lastNetKey = null;
    let lastDomKey = null;
    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      const snap = await this.#eval(`(() => {
        const visible = (n) => { if (!n) return false; const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
        const disabled = (n) => !!n.disabled || String(n.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
        // Resolve the ACTIVE composer from the LAST visible prompt. ChatGPT keeps stale
        // composers mounted, and their send buttons stay permanently disabled — evaluating
        // the first global match reports a disabled button that will never enable.
        const prompts = Array.from(document.querySelectorAll('#prompt-textarea, [contenteditable="true"][role="textbox"]'));
        const prompt = prompts.filter(visible).at(-1) || prompts.at(-1) || null;
        const composer = prompt?.closest('form') || prompt?.closest('[data-testid*="composer" i]') || null;
        const root = composer || document.querySelector('main') || document.body;
        const uploadEl = root.querySelector('progress, [role="progressbar"], [class*="uploading" i], [aria-label*="uploading" i], [class*="progress" i][role]');
        const uploading = !!uploadEl;
        const promptLen = String(prompt?.innerText || prompt?.textContent || prompt?.value || '').trim().length;
        const allSends = Array.from(document.querySelectorAll(${sendSel}));
        const visibleSends = allSends.filter(visible);
        // Prefer the send button INSIDE the active composer; fall back to first visible global.
        const scopedSend = composer ? Array.from(composer.querySelectorAll(${sendSel})).find(visible) : null;
        const globalSend = visibleSends[0] || null;
        const send = scopedSend || globalSend;
        const disabledReason = !send ? 'no-send' : (send.disabled ? 'prop-disabled'
          : (String(send.getAttribute('aria-disabled') || '').toLowerCase() === 'true' ? 'aria-disabled' : 'enabled'));
        // Distinguish "editor never registered the text" from "attachment still pending":
        // count chips still showing a spinner/processing state within the active composer.
        const pendingChips = composer
          ? Array.from(composer.querySelectorAll('[class*="uploading" i], [aria-label*="uploading" i], [aria-label*="processing" i], [data-testid*="attachment" i] svg[class*="spin" i], progress, [role="progressbar"]')).filter(visible).length
          : 0;
        const sendHtml = send ? String(send.outerHTML || '').replace(/\\s+/g, ' ').slice(0, 240) : null;
        return {
          uploading, sendReady: !!send && !disabled(send), hasSend: !!send,
          disabledReason, promptLen, scopedInComposer: !!scopedSend,
          visiblePrompts: prompts.filter(visible).length,
          sendTotal: allSends.length, sendVisible: visibleSends.length,
          globalDisabled: globalSend ? disabled(globalSend) : null,
          scopedDisabled: scopedSend ? disabled(scopedSend) : null,
          pendingChips, sendHtml,
          uploadHint: uploadEl ? String(uploadEl.getAttribute('class') || uploadEl.getAttribute('aria-label') || uploadEl.tagName).slice(0, 80) : null
        };
      })()`);

      // Log the network upload picture whenever it changes, so a send button that stays
      // disabled can be attributed to a still-in-flight (or stalled) upload rather than a
      // DOM heuristic miss. This is what tells GPT-side stalls apart from wiring bugs.
      const netSnap = this.uploadWatch?.snapshot?.();
      if (netSnap) {
        const netKey = `${netSnap.inflight}:${netSnap.finished}:${netSnap.failed}`;
        if (netKey !== lastNetKey) {
          lastNetKey = netKey;
          this.#debug(
            `send-gate: net-uploads inflight=${netSnap.inflight} finished=${netSnap.finished} ` +
            `failed=${netSnap.failed} oldestInflightMs=${netSnap.oldestInflightMs} ` +
            `(domUploading=${snap.uploading}, sendReady=${snap.sendReady})`
          );
        }
      }

      // Log the composer/send DOM state whenever it changes. Because uploads finish long
      // before the timeout, the net picture goes quiet — this is the signal that shows what
      // is actually holding the gate (disabled send, empty prompt, or a stuck upload hint).
      const domKey = `${snap.uploading}:${snap.hasSend}:${snap.sendReady}:${snap.disabledReason}:${snap.promptLen}:${snap.scopedInComposer}`;
      if (domKey !== lastDomKey) {
        lastDomKey = domKey;
        this.#debug(
          `send-gate: dom uploading=${snap.uploading} hasSend=${snap.hasSend} sendReady=${snap.sendReady} ` +
          `send=${snap.disabledReason} scoped=${snap.scopedInComposer} promptLen=${snap.promptLen} ` +
          `prompts=${snap.visiblePrompts} sends=${snap.sendVisible}/${snap.sendTotal} ` +
          `globalDisabled=${snap.globalDisabled} scopedDisabled=${snap.scopedDisabled} pendingChips=${snap.pendingChips}` +
          (snap.uploadHint ? ` uploadHint="${snap.uploadHint}"` : '') +
          (snap.sendHtml ? `\n  send: ${snap.sendHtml}` : '')
        );
      }

      if (!snap.uploading && (snap.sendReady || !snap.hasSend)) {
        if (readySince == null) readySince = Date.now();
        else if (Date.now() - readySince >= stableMs) {
          this.#debug(
            `send-gate: ready after ${Date.now() - start}ms (sendReady=${snap.sendReady}, hasSend=${snap.hasSend}` +
            `${netSnap ? `, netInflight=${netSnap.inflight}, netFailed=${netSnap.failed}` : ''})`
          );
          return;
        }
      } else {
        readySince = null;
      }
      await sleep(pollMs);
    }
    // Timed out. Dump both the composer/send DOM state and the full network picture so the
    // cause is unambiguous: a stuck upload (inflight/failed request) vs a send button that
    // stays disabled after uploads already finished (a UI-state/selector issue on our side).
    this.#debug(`send-gate: timed out after ${timeoutMs}ms waiting for send to become ready (last dom: ${lastDomKey})`);

    // One-time rich capture of why the send button is disabled: the accessibility tooltip
    // it points at (ChatGPT states the reason there), whether the disabled attribute is set,
    // any spinning/animated indicators in the composer, and the attachment chips' markup.
    const stuck = await this.#eval(`(() => {
      const clip = (s, n) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
      const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const prompts = Array.from(document.querySelectorAll('#prompt-textarea, [contenteditable="true"][role="textbox"]'));
      const prompt = prompts.filter(visible).at(-1) || prompts.at(-1) || null;
      const composer = prompt?.closest('form') || prompt?.closest('[data-testid*="composer" i]') || document.querySelector('main') || document.body;
      const send = document.querySelector('#composer-submit-button, button[data-testid="send-button"]')
        || (composer && composer.querySelector('button[data-testid="send-button"], button[aria-label*="send" i]'));
      // Resolve the tooltip/popover the button describes itself with — the disabled reason.
      const ref = send && (send.getAttribute('aria-describedby') || send.getAttribute('interestfor'));
      const tip = ref ? document.getElementById(ref) : null;
      // Any spinning/loading indicator anywhere in the composer (broad — Tailwind animate-spin,
      // role=progressbar, svg with spinner classes, aria-busy).
      const spinners = composer ? Array.from(composer.querySelectorAll(
        '[class*="animate-spin" i], [class*="spinner" i], [class*="loading" i], [aria-busy="true"], [role="progressbar"], progress, svg[class*="spin" i]'
      )).filter(visible).map((n) => clip(n.getAttribute('class') || n.getAttribute('aria-label') || n.tagName, 60)) : [];
      // Attachment chips: the region just above the prompt that holds file previews.
      const chipNodes = composer ? Array.from(composer.querySelectorAll(
        '[data-testid*="attachment" i], [data-testid*="file" i], [class*="attachment" i]'
      )).filter(visible) : [];
      const chips = chipNodes.slice(0, 4).map((n) => clip(n.outerHTML, 300));
      return {
        sendDisabledAttr: send ? send.hasAttribute('disabled') : null,
        sendHtml: send ? clip(send.outerHTML, 600) : null,
        tipText: tip ? clip(tip.innerText || tip.textContent, 200) : (ref ? '(describedby target not found)' : '(no describedby)'),
        spinners,
        chipCount: chipNodes.length,
        chips
      };
    })()`).catch((e) => ({ error: String(e?.message || e) }));
    this.#debug(
      `send-gate: stuck-state — disabledAttr=${stuck?.sendDisabledAttr} ` +
      `spinners=${JSON.stringify(stuck?.spinners || [])} chipCount=${stuck?.chipCount}\n` +
      `  tooltip: ${stuck?.tipText}\n` +
      `  send: ${stuck?.sendHtml}` +
      (stuck?.chips?.length ? '\n  chips:\n' + stuck.chips.map((c) => `    · ${c}`).join('\n') : '') +
      (stuck?.error ? `\n  (capture error: ${stuck.error})` : '')
    );

    const finalNet = this.uploadWatch?.snapshot?.();
    if (finalNet) {
      this.#debug(
        `send-gate: final ${this.#uploadSummary()}` +
        (finalNet.requests.length
          ? '\n' + finalNet.requests
              .map((r) => `  · ${r.state} ${r.method} ${r.url} status=${r.status ?? '-'} ` +
                `bytes=${r.bytes} age=${r.ageMs}ms${r.error ? ` error=${r.error}` : ''}`)
              .join('\n')
          : ' (no upload requests observed — file may have been selected without a network POST)')
      );
    }
  }

  async #clickSend() {
    await this.#emitProgress({ phase: 'sending_prompt' });
    await this.#waitForUploadsToSettle();
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const stopSel = JSON.stringify(this.selectors.stopButton);
    const res = await this.#eval(`(() => {
      const stop = Array.from(document.querySelectorAll(${stopSel})).find((n) => {
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
      if (stop) return { ok:false, error:'already_generating' };
      const host = location.hostname || '';
      const visible = (n) => {
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const disabled = (n) => !!n.disabled || String(n.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
      const editable = (n) => {
        if (!n) return false;
        if (!visible(n)) return false;
        if (n.matches('textarea')) return !n.disabled && !n.readOnly;
        if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
        return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
      };
      const labelOf = (n) =>
        [
          n.getAttribute('aria-label') || '',
          n.getAttribute('title') || '',
          n.getAttribute('data-testid') || '',
          n.textContent || ''
        ]
          .join(' ')
          .replace(/\\s+/g, ' ')
          .trim()
          .toLowerCase();
      const promptScore = (n) => {
        const r = n.getBoundingClientRect();
        const label = [
          n.getAttribute('aria-label') || '',
          n.getAttribute('placeholder') || '',
          n.getAttribute('name') || '',
          n.getAttribute('id') || '',
          n.getAttribute('data-testid') || ''
        ].join(' ').toLowerCase();
        let s = 0;
        if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
        if (n.matches('textarea')) s += 50;
        if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
        if (n.getAttribute('role') === 'textbox') s += 25;
        if (r.width >= 260 && r.height >= 26) s += 20;
        s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
        s += Math.max(0, r.y / 8);
        return s;
      };
      const pickPrompt = () => {
        const base = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const candidates = [];
        const seen = new Set();
        for (const n of [...base, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          candidates.push(n);
        }
        let best = null;
        let bestScore = -Infinity;
        for (const n of candidates) {
          if (!editable(n)) continue;
          const s = promptScore(n);
          if (s > bestScore) {
            bestScore = s;
            best = n;
          }
        }
        return best;
      };
      const prompt = pickPrompt();
      const composerRoot =
        prompt?.closest('form') ||
        prompt?.closest('[data-testid*=\"composer\" i], [data-testid*=\"prompt\" i], [data-testid*=\"chat-input\" i], [aria-label*=\"message\" i], [aria-label*=\"prompt\" i]') ||
        prompt?.closest('main') ||
        null;
      const promptRect = prompt ? prompt.getBoundingClientRect() : null;
      const score = (n) => {
        const r = n.getBoundingClientRect();
        const label = labelOf(n);
        let s = 0;
        if (n.matches(${sendSel})) s += 120;
        if (/send|submit|run|go|ask|reply/.test(label)) s += 90;
        if (/stop|cancel|retry|signin|sign in|log in|google/.test(label)) s -= 140;
        if (n.getAttribute('type') === 'submit') s += 35;
        if (composerRoot && composerRoot.contains(n)) s += 160;
        if (r.width >= 16 && r.height >= 16) s += 10;
        s += Math.max(0, r.y / 10);
        s += Math.max(0, r.x / 20);
        if (promptRect) {
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          const dx = Math.abs(cx - (promptRect.x + promptRect.width));
          const dy = Math.abs(cy - (promptRect.y + promptRect.height / 2));
          s += Math.max(0, 140 - dx / 6 - dy / 4);
        }
        return s;
      };
      const pool = [];
      const seen = new Set();
      const localPool = composerRoot ? [...composerRoot.querySelectorAll(${sendSel}), ...composerRoot.querySelectorAll('button, [role=\"button\"]')] : [];
      for (const n of [...localPool, ...document.querySelectorAll(${sendSel}), ...document.querySelectorAll('button, [role=\"button\"]')]) {
        if (!n || seen.has(n)) continue;
        seen.add(n);
        pool.push(n);
      }
      let btn = null;
      let best = -Infinity;
      for (const n of pool) {
        if (!visible(n) || disabled(n)) continue;
        const s = score(n);
        if (s > best) {
          best = s;
          btn = n;
        }
      }
      if (!btn) return { ok:true, fallbackEnter:true, requestSubmit: !!prompt?.closest('form'), host };
      const r = btn.getBoundingClientRect();
      return {
        ok:true,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        requestSubmit: !!prompt?.closest('form'),
        host
      };
    })()`);
    if (!res?.ok) {
      const err = new Error(res?.error || 'send_failed');
      err.data = res;
      throw err;
    }

    let sent = false;
    if (res?.rect?.w > 0 && res?.rect?.h > 0) {
      this.#throwIfStopRequested();
      const cx = Math.round(res.rect.x + res.rect.w / 2);
      const cy = Math.round(res.rect.y + res.rect.h / 2);
      await this.#clickAt(cx, cy);
      sent = await this.#waitForSendSignal({ timeoutMs: 2200, pollMs: 120 });
    }

    if (!sent && !res?.fallbackEnter) {
      this.#throwIfStopRequested();
      await this.#eval(`(() => {
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const disabled = (n) => !!n.disabled || String(n.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
        const editable = (n) => {
          if (!n) return false;
          if (!visible(n)) return false;
          if (n.matches('textarea')) return !n.disabled && !n.readOnly;
          if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
          return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
        };
        const promptCandidates = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const uniq = [];
        const seen = new Set();
        for (const n of [...promptCandidates, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          uniq.push(n);
        }
        const prompt = uniq.find(editable) || document.activeElement;
        const form = prompt?.closest?.('form') || null;
        if (form && typeof form.requestSubmit === 'function') {
          const submitBtn = Array.from(form.querySelectorAll(${sendSel})).find((n) => visible(n) && !disabled(n));
          form.requestSubmit(submitBtn || undefined);
          return true;
        }
        const submitBtn = form
          ? Array.from(form.querySelectorAll(${sendSel})).find((n) => visible(n) && !disabled(n))
          : document.querySelector(${sendSel});
        if (submitBtn) {
          submitBtn.click();
          return true;
        }
        return false;
      })()`);
      sent = await this.#waitForSendSignal({ timeoutMs: 1400, pollMs: 120 });
    }

    if (!sent) {
      const host = String(res?.host || '');
      const isMac = process.platform === 'darwin';
      const combos = [];
      if (host.includes('aistudio.google.com')) {
        combos.push(['Enter', ['alt']]);
        combos.push(['Enter', [isMac ? 'meta' : 'control']]);
        combos.push(['Enter', []]);
      } else if (host.includes('grok.com')) {
        combos.push(['Enter', [isMac ? 'meta' : 'control']]);
        combos.push(['Enter', []]);
      } else {
        combos.push(['Enter', []]);
        combos.push(['Enter', [isMac ? 'meta' : 'control']]);
        combos.push(['Enter', ['alt']]);
      }

      for (const [key, modifiers] of combos) {
        this.#throwIfStopRequested();
        await sleep(jitter(25, 90));
        await this.#sendKey(key, { modifiers });
        sent = await this.#waitForSendSignal({ timeoutMs: 1500, pollMs: 120 });
        if (sent) break;
      }
    }

    if (!sent) {
      const err = new Error('send_not_triggered');
      err.data = { host: res?.host || null };
      throw err;
    }
  }

  #debug(msg) {
    try {
      this.onDebug?.(String(msg));
    } catch {}
  }

  // Force a fresh top-level chat (outside any project) by clicking ChatGPT's
  // "New chat" control, so batch runs never inherit a project context.
  async #startNewChat() {
    const clicked = await this.#eval(`(() => {
      const a = document.querySelector('a[data-testid="create-new-chat-button"]')
        || Array.from(document.querySelectorAll('a,button,[role="button"]')).find(e => /new chat/i.test(((e.getAttribute('aria-label')||'') + ' ' + (e.textContent||'')).trim()));
      if (a) { a.click(); return true; }
      return false;
    })()`);
    this.#debug(`newchat: create-new-chat control ${clicked ? 'clicked' : 'NOT found'}`);
    if (clicked) {
      await sleep(800);
      await this.ensureReady({ timeoutMs: 30_000 }).catch(() => {});
    }
  }

  async #attachFiles(files) {
    if (!files?.length) return;
    await this.#emitProgress({ phase: 'uploading_files' });
    const absFiles = files.map((p) => path.resolve(p));
    for (const f of absFiles) await fs.access(f);
    const baseNames = absFiles.map((f) => path.basename(f));
    this.#debug(`attach: uploading ${absFiles.length} file(s): ${baseNames.join(', ')}`);

    // Start watching the network layer so we can distinguish "chip appeared" (file selected)
    // from "bytes actually uploaded". Kept alive until the send-gate settles (#clickSend).
    this.#stopUploadWatch();
    if (typeof this.page.watchUploads === 'function') {
      this.uploadWatch = this.page.watchUploads({
        onEvent: (e) => {
          const tail = e.status != null ? ` status=${e.status}` : '';
          const bytes = e.bytes ? ` bytes=${e.bytes}` : '';
          const err = e.error ? ` error=${e.error}` : '';
          this.#debug(`attach: net ${e.phase} ${e.method} ${e.url}${tail}${bytes}${err} (age=${e.ageMs}ms)`);
        }
      });
    }

    // Give React time to wire the hidden input's change handler before setting it.
    await this.#eval(`(() => { const e = document.querySelector('#prompt-textarea, [contenteditable="true"][role="textbox"]'); if (e) e.focus(); return true; })()`).catch(() => {});
    await sleep(1200);

    // Upload files independently. Re-sending a whole partially successful batch can
    // replace the input selection or trigger duplicate-file handling in ChatGPT.
    let settle = await this.#readAttachmentSnapshot(baseNames);
    const maxAttemptsPerFile = 5;
    for (let fileIndex = 0; fileIndex < absFiles.length; fileIndex++) {
      const file = absFiles[fileIndex];
      const fileName = baseNames[fileIndex];
      const stem = String(fileName).replace(/\.[^.]+$/, '').toLowerCase();
      let registered = false;

      for (let attempt = 1; attempt <= maxAttemptsPerFile && !registered; attempt++) {
        const before = await this.#readAttachmentSnapshot(baseNames);
        const baselineChips = Number(before.chips) || 0;
        let info = null;
        try {
          info = await this.page.setFileInputFiles([file]);
        } catch (firstError) {
          const revealed = await this.#revealFileInput();
          this.#debug(
            `attach: ${fileName} attempt ${attempt} found no input (${firstError?.message}); ` +
              `attachment UI ${revealed ? `opened (${revealed})` : 'NOT found'}`
          );
          if (!revealed) {
            await sleep(500);
            continue;
          }
          try {
            info = await this.page.setFileInputFiles([file]);
          } catch (secondError) {
            this.#debug(`attach: ${fileName} attempt ${attempt} still has no input (${secondError?.message})`);
            await sleep(500);
            continue;
          }
        }

        this.#debug(
          `attach: ${fileName} set attempt ${attempt} (inputs found=${info?.found ?? '?'}, set=${info?.set ?? '?'}, ` +
            `strategy=${info?.strategy ?? '?'}, node=${info?.nodeId ?? '?'})`
        );
        settle = await this.#waitForAttachments({
          baseNames,
          targetStem: stem,
          baselineChips,
          timeoutMs: 20_000,
          maxQuietMs: 6000
        });
        registered = attachmentAttemptComplete(settle, { stem, baselineChips });
        this.#debug(
          `attach: ${fileName} attempt ${attempt} -> registered=${registered} matchedNames=${settle.matched}/${baseNames.length} ` +
            `chips=${settle.chips} uploading=${settle.uploading} waitedMs=${settle.waitedMs}`
        );
        if (!registered) {
          const revealed = await this.#revealFileInput().catch(() => null);
          this.#debug(
            `attach: ${fileName} attempt ${attempt} silently dropped; attachment UI ` +
              `${revealed ? `refreshed (${revealed})` : 'refresh control NOT found'}`
          );
          await this.#eval(`(() => { const e = document.querySelector('#prompt-textarea, [contenteditable="true"][role="textbox"]'); if (e) e.focus(); return true; })()`).catch(() => {});
          await sleep(900);
        }
      }

      if (!registered) {
        const err = new Error('attachment_not_registered');
        err.data = { file: fileName, files: baseNames, ...settle, expected: baseNames.length };
        throw err;
      }
    }

    settle = await this.#waitForAttachments({ baseNames, timeoutMs: 20_000, maxQuietMs: 6000 });
    if (!attachmentsComplete(settle, baseNames.length)) {
      if (this.onDebug) {
        const dump = await this.#eval(
          `(() => { const p = document.querySelector('#prompt-textarea, [contenteditable="true"][role="textbox"]'); const f = p?.closest('form') || p?.closest('[data-testid*="composer" i]') || document.querySelector('main'); return f ? f.outerHTML.slice(0, 4000) : '(no composer/main)'; })()`
        );
        this.#debug(`attach: composer HTML (truncated):\n${dump}`);
      }
      const err = new Error('attachment_not_registered');
      err.data = { files: baseNames, ...settle, expected: baseNames.length };
      throw err;
    }

    // Chips are present. Report the network picture: if the upload requests have not
    // finished here, the file is selected but its bytes are still in flight (or stalled)
    // and the send-gate is what will actually wait them out.
    const summary = this.#uploadSummary();
    if (summary) this.#debug(`attach: chips settled; ${summary}`);
  }

  // Some ChatGPT variants hide the file input behind a two-stage "+" menu. Open
  // the composer menu, then choose its file-upload item. Keep the menu open until
  // CDP sets the input; pressing Escape here used to close it too early.
  async #revealFileInput() {
    const clickMatching = async (kind) =>
      this.#eval(`(() => {
        const visible = (n) => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
        const label = (n) => ((n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('title') || '') + ' ' + (n.getAttribute('data-testid') || '') + ' ' + (n.textContent || '')).trim();
        const prompt = document.querySelector('#prompt-textarea, [contenteditable="true"][role="textbox"]');
        const composer = prompt?.closest('form') || prompt?.closest('[data-testid*="composer" i]');
        const all = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"]')).filter(visible);
        const local = composer ? all.filter((n) => composer.contains(n)) : [];
        const direct = /upload from computer|upload files?|add photos?\\s*(?:&|and)\\s*files?|photos? and files?|files? from computer/i;
        const trigger = /attach|paperclip|add files?|add photos?|upload|composer[-_ ]?plus|plus[-_ ]?button/i;
        const rx = ${kind === 'direct' ? 'direct' : 'trigger'};
        const pool = ${kind === 'direct' ? 'all' : '[...local, ...all]'};
        const hit = pool.find((n) => rx.test(label(n)));
        if (!hit) return null;
        hit.click();
        return label(hit).slice(0, 100) || ${JSON.stringify(kind)};
      })()`);

    let clicked = await clickMatching('direct');
    if (clicked) {
      await sleep(350);
      return clicked;
    }
    clicked = await clickMatching('trigger');
    if (!clicked) return null;
    await sleep(350);
    const item = await clickMatching('direct');
    await sleep(350);
    return item ? `${clicked} -> ${item}` : clicked;
  }

  async #readAttachmentSnapshot(baseNames = []) {
    const stems = baseNames.map((n) => String(n).replace(/\.[^.]+$/, '').toLowerCase());
    const stemsJson = JSON.stringify(stems);
    const snap = await this.#eval(`(() => {
      const stems = ${stemsJson};
      const prompt = document.querySelector('#prompt-textarea, [contenteditable="true"][role="textbox"]');
      const root = prompt?.closest('form') || prompt?.closest('[data-testid*="composer" i]') || document.querySelector('main') || document.body;
      const text = (root.innerText || '').toLowerCase();
      const matchedStems = stems.filter((n) => n && text.includes(n));
      const removeButtons = root.querySelectorAll('button[aria-label*="remove file" i], button[aria-label*="remove attachment" i]');
      const previewNodes = root.querySelectorAll('[data-testid="file-upload-preview"], [data-testid="attachment"]');
      const chips = removeButtons.length || previewNodes.length;
      const uploading = !!root.querySelector('progress, [role="progressbar"], [class*="uploading" i], [aria-label*="uploading" i]');
      return { matched: matchedStems.length, matchedStems, chips, uploading };
    })()`);
    return {
      detected: (Number(snap?.chips) || 0) > 0 || (Number(snap?.matched) || 0) > 0,
      matched: Number(snap?.matched) || 0,
      matchedStems: Array.isArray(snap?.matchedStems) ? snap.matchedStems : [],
      chips: Number(snap?.chips) || 0,
      uploading: !!snap?.uploading,
      waitedMs: 0
    };
  }

  // Poll the actual composer until its attachment state reaches the requested gate.
  async #waitForAttachments({
    baseNames = [],
    targetStem = '',
    baselineChips = 0,
    timeoutMs = 120_000,
    stableMs = 800,
    pollMs = 400,
    maxQuietMs = 8000
  } = {}) {
    const start = Date.now();
    const expected = baseNames.length;
    let quietSince = null;
    let lastProgressKey = null;
    let last = { detected: false, matched: 0, matchedStems: [], chips: 0, uploading: false, waitedMs: 0 };

    while (Date.now() - start < timeoutMs) {
      const snap = await this.#readAttachmentSnapshot(baseNames);
      const detected = snap.chips >= expected || snap.matched >= expected || snap.chips > 0;
      last = {
        detected,
        matched: snap.matched,
        matchedStems: snap.matchedStems,
        chips: snap.chips,
        uploading: !!snap.uploading,
        waitedMs: Date.now() - start
      };

      const enough = targetStem
        ? attachmentAttemptComplete(snap, { stem: targetStem, baselineChips })
        : attachmentsComplete(snap, expected);
      if (enough && !snap.uploading) {
        await sleep(stableMs);
        last.waitedMs = Date.now() - start;
        return last;
      }

      const progressKey = attachmentProgressKey(snap);
      if (progressKey !== lastProgressKey) {
        lastProgressKey = progressKey;
        quietSince = null;
      } else if (!snap.uploading) {
        if (quietSince == null) quietSince = Date.now();
        else if (Date.now() - quietSince > maxQuietMs) return last;
      }
      await sleep(pollMs);
    }
    return last;
  }

  async #waitForAssistantStable({
    timeoutMs = 2 * 60 * 60_000,
    stableMs = 2000,
    pollMs = 500,
    responseState = null
  } = {}) {
    await this.#emitProgress({ phase: 'waiting_for_response', blocked: false, blockedKind: null, blockedTitle: null });
    const assistantSel = JSON.stringify(this.selectors.assistantMessage);
    const stopSel = JSON.stringify(this.selectors.stopButton);
    const start = Date.now();
    let last = '';
    let lastActivityKey = '';
    let lastChange = Date.now();
    let sawActivity = false;
    let idleSince = null;
    let terminalSince = null;
    let continueClicks = 0;
    let lastSemanticState = 'unknown';
    let lastSnap = null;
    // High-water mark of the reply length; growth means active streaming (see the idle logic).
    let maxTxtLen = 0;

    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      // ChatGPT can remove its stop button between thinking, tool execution, and final
      // streaming. Capture independent busy and terminal signals, then combine them
      // with caller-provided semantic completeness below.
      const snap = await this.#eval(`(() => {
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const nodes = Array.from(document.querySelectorAll(${assistantSel}));
        const lastNode = nodes[nodes.length - 1];
        const turnRoot = lastNode?.closest(
          'article, [data-testid^="conversation-turn"], [data-testid*="conversation-turn"]'
        ) || lastNode;
        const txt = (lastNode?.innerText || '').trim();
        const codeCount = lastNode ? lastNode.querySelectorAll('pre code').length : 0;
        const allControls = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const labelOf = (n) => [
          n.getAttribute('aria-label') || '',
          n.getAttribute('title') || '',
          n.getAttribute('data-testid') || '',
          n.textContent || ''
        ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
        const configuredStops = Array.from(document.querySelectorAll(${stopSel}));
        const fallbackStops = allControls.filter((n) => /stop (?:generating|responding|streaming)|stop-button/.test(labelOf(n)));
        const stopVisible = [...configuredStops, ...fallbackStops].some(visible);
        const hasContinue = allControls.some((n) => visible(n) && /continue generating/.test(labelOf(n)));
        const busySelector =
          '[aria-busy="true"], [data-is-streaming="true"], [data-streaming="true"], ' +
          '[data-testid*="streaming" i], [class~="result-streaming"]';
        const localBusy = turnRoot
          ? (turnRoot.matches(busySelector) && visible(turnRoot))
            || Array.from(turnRoot.querySelectorAll(busySelector)).some(visible)
          : false;
        const terminalVisible = turnRoot
          ? Array.from(turnRoot.querySelectorAll('button, [role="button"]')).some((n) => {
              if (!visible(n)) return false;
              return /copy-turn-action|good-response-turn-action|bad-response-turn-action|read aloud|copy response/.test(labelOf(n));
            })
          : false;
        const hasError = /something went wrong|try again|error generating/i.test(txt) && txt.length < 500;
        const htmlLength = turnRoot ? turnRoot.innerHTML.length : 0;
        return {
          stopVisible, busyVisible: stopVisible || localBusy, terminalVisible,
          txt, count: nodes.length, codeCount, htmlLength, hasContinue, hasError
        };
      })()`);

      const txt = String(snap?.txt || '');
      const activityKey = [
        txt, Number(snap?.count) || 0, Number(snap?.codeCount) || 0,
        Number(snap?.htmlLength) || 0, snap?.busyVisible ? 1 : 0,
        snap?.terminalVisible ? 1 : 0, snap?.hasContinue ? 1 : 0
      ].join('\u0000');
      if (activityKey !== lastActivityKey) {
        lastActivityKey = activityKey;
        last = txt;
        lastChange = Date.now();
      }
      // Reply text grew since the previous poll → still actively streaming, so this is not idle.
      // (Length only — not HTML churn — so a blinking cursor can't stop us from ever settling, and
      // text length is monotone-bounded so it can never wedge the wait open indefinitely.) The
      // actual render bug (unfocused tab → CodeMirror never paints → innerText frozen) is fixed at
      // the CDP layer via Emulation.setFocusEmulationEnabled in the page adapter.
      const grew = txt.length > maxTxtLen;
      if (grew) maxTxtLen = txt.length;
      if (snap?.busyVisible || snap?.hasContinue || grew) {
        sawActivity = true;
        idleSince = null;
        terminalSince = null;
      } else {
        if (idleSince == null) idleSince = Date.now();
        if (snap?.terminalVisible) {
          if (terminalSince == null) terminalSince = Date.now();
        } else {
          terminalSince = null;
        }
      }

      // Click "continue generating" if it appears while not actively streaming.
      if (!snap?.stopVisible && snap?.hasContinue && continueClicks < 3) {
        continueClicks += 1;
        await this.#eval(`(() => {
          const btn = Array.from(document.querySelectorAll('button, a')).find(b => /continue generating/i.test((b.textContent||'').trim()));
          if (btn) btn.click();
        })()`);
        await sleep(300);
        idleSince = null;
        terminalSince = null;
        continue;
      }

      const dynamicStableMs = Math.max(stableMs, txt.length > 8000 ? 3500 : txt.length > 2000 ? 2500 : stableMs);
      const stable = Date.now() - lastChange >= dynamicStableMs;
      const started = sawActivity || (txt.length > 0 && Date.now() - start > 5000);
      let semanticState = 'unknown';
      if (typeof responseState === 'function' && txt) {
        try {
          const classified = responseState(txt);
          if (['complete', 'incomplete', 'unknown'].includes(classified)) semanticState = classified;
        } catch {}
      }
      lastSemanticState = semanticState;
      lastSnap = snap;
      const decision = responseCompletionDecision({
        text: txt,
        started,
        busy: !!snap?.busyVisible || !!snap?.hasContinue,
        stable,
        idleForMs: idleSince == null ? 0 : Date.now() - idleSince,
        terminalVisible: !!snap?.terminalVisible,
        terminalForMs: terminalSince == null ? 0 : Date.now() - terminalSince,
        hasError: !!snap?.hasError,
        semanticState
      });
      if (decision.done) {
        // Stall-inspection: a near-empty idle-fallback is the exact case under suspicion (is the
        // reply really empty, or are we reading the wrong node?). Instead of accepting it, dump the
        // DOM truth + screenshots and hold. If the content actually grew while held, the idle
        // detection was premature — resume with the grown text rather than the near-empty read.
        if (this.stallInspect && /_idle_fallback$/.test(decision.reason)) {
          const held = await this.#runStallInspector({ reason: decision.reason, semanticState, currentText: txt });
          if (held?.grew) {
            last = held.text;
            lastChange = Date.now();
            idleSince = null;
            terminalSince = null;
            continue;
          }
        }
        const extra = await this.#eval(`(() => {
          const nodes = Array.from(document.querySelectorAll(${assistantSel}));
          const lastNode = nodes[nodes.length - 1];
          const codes = Array.from(lastNode?.querySelectorAll('pre code') || []).map(c => {
            const cls = String(c.className || '');
            const pre = c.closest('pre');
            const lang = (cls.match(/language-([a-z0-9_-]+)/i) || [])[1]
              || (String(pre?.querySelector('[class*="language-"]')?.className || '').match(/language-([a-z0-9_-]+)/i) || [])[1]
              || null;
            return { language: lang, text: (c.innerText || '').trim() };
          }).filter(c => c.text);
          return { codeBlocks: codes };
        })()`);
        this.#debug(
          `response-gate: ${decision.reason} after ${Date.now() - start}ms ` +
          `(chars=${txt.length}, semantic=${semanticState}, terminal=${!!snap?.terminalVisible})`
        );
        return {
          text: txt,
          codeBlocks: extra?.codeBlocks || [],
          meta: {
            count: snap?.count || 0,
            hasError: !!snap?.hasError,
            completionReason: decision.reason,
            semanticState
          }
        };
      }

      await sleep(pollMs);
    }

    const err = new Error('timeout_waiting_for_response');
    err.data = { last, semanticState: lastSemanticState, snapshot: lastSnap };
    throw err;
  }

  // Rich DOM truth-dump used by the stall inspector. The point is to compare what our reader
  // sees (the LAST assistant node's innerText) against the LARGEST assistant node and the code
  // blocks — so a "near-empty stall" that is really a wrong-node read is immediately obvious.
  async #captureStallDom() {
    const assistantSel = JSON.stringify(this.selectors.assistantMessage);
    return await this.#eval(`(() => {
      const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
      const vis = (n) => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      const nodes = Array.from(document.querySelectorAll(${assistantSel}));
      const info = nodes.map((n, i) => ({
        i, tag: n.tagName,
        id: n.getAttribute('data-message-id') || null,
        role: n.getAttribute('data-message-author-role') || null,
        streaming: n.getAttribute('data-is-streaming') || null,
        textLen: (n.innerText || '').length,
        head: norm(n.innerText).slice(0, 160),
        visible: vis(n)
      }));
      const last = nodes[nodes.length - 1] || null;
      const byMax = nodes.slice().sort((a, b) => (b.innerText || '').length - (a.innerText || '').length)[0] || null;
      const codeInLast = last ? Array.from(last.querySelectorAll('pre code')).map((c) => ({ len: (c.innerText || '').length, head: norm(c.innerText).slice(0, 200) })) : [];
      const codeAll = Array.from(document.querySelectorAll('pre code')).map((c) => (c.innerText || '').length);
      return {
        url: location.href,
        count: nodes.length,
        lastTextLen: last ? (last.innerText || '').length : 0,
        lastText: last ? (last.innerText || '') : null,
        maxLenTextLen: byMax ? (byMax.innerText || '').length : 0,
        maxLenText: byMax ? (byMax.innerText || '') : null,
        maxLenIsLast: byMax === last,
        lastOuterHTML: last ? last.outerHTML.slice(0, 30000) : null,
        nodes: info,
        codeBlocksInLast: codeInLast,
        allCodeBlockLens: codeAll
      };
    })()`);
  }

  // On a suspected stall: dump the DOM truth + screenshots to <stateDir>/stall-inspect, then HOLD
  // (re-dumping periodically) instead of reacting, so a human can inspect the live window and we
  // can see whether the reply is genuinely empty or still growing. Returns the best text seen.
  async #runStallInspector({ reason, semanticState, currentText }) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(this.stateDir || '.', 'stall-inspect');
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const writePng = async (name) => {
      if (typeof this.page.screenshot !== 'function') return;
      const png = await this.page.screenshot({ fullPage: false }).catch(() => null);
      if (png) await fs.writeFile(path.join(dir, name), png).catch(() => {});
    };

    const dump0 = await this.#captureStallDom().catch((e) => ({ error: String(e?.message || e) }));
    const jsonPath = path.join(dir, `stall-${ts}.json`);
    await fs.writeFile(
      jsonPath,
      JSON.stringify({ reason, semanticState, readerText: currentText, readerLen: currentText.length, ...dump0 }, null, 2)
    ).catch(() => {});
    await writePng(`stall-${ts}-0.png`);

    this.#debug(
      `⏸ STALL INSPECTOR fired: reason=${reason} readerLen=${currentText.length} ` +
      `lastNodeLen=${dump0.lastTextLen} maxNodeLen=${dump0.maxLenTextLen} maxIsLast=${dump0.maxLenIsLast} ` +
      `assistantNodes=${dump0.count} codeLens=${JSON.stringify(dump0.allCodeBlockLens || [])} — ` +
      `dumped ${jsonPath}; HOLDING up to ${Math.round(this.stallInspect.holdMs / 1000)}s (inspect the Chrome window; DOM+PNG under ${dir})`
    );

    const holdStart = Date.now();
    let shot = 1;
    let bestText = currentText;
    while (Date.now() - holdStart < this.stallInspect.holdMs) {
      this.#throwIfStopRequested();
      await sleep(this.stallInspect.intervalMs);
      const d = await this.#captureStallDom().catch(() => null);
      if (!d) continue;
      await writePng(`stall-${ts}-${shot}.png`);
      this.#debug(
        `⏸ STALL held ${Math.round((Date.now() - holdStart) / 1000)}s — ` +
        `lastNodeLen=${d.lastTextLen} maxNodeLen=${d.maxLenTextLen} maxIsLast=${d.maxLenIsLast} nodes=${d.count} (shot ${shot})`
      );
      if ((d.maxLenTextLen || 0) > bestText.length) bestText = d.maxLenText || bestText;
      shot += 1;
    }
    this.#debug(`⏸ STALL INSPECTOR hold elapsed; resuming (bestLen=${bestText.length}, grew=${bestText.length > currentText.length})`);
    return { text: bestText, grew: bestText.length > currentText.length };
  }

  async query({
    prompt,
    attachments = [],
    timeoutMs = 2 * 60 * 60_000,
    onProgress = null,
    newChat = false,
    responseState = null
  } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('missing_prompt');
    if (prompt.length > 200_000) throw new Error('prompt_too_large');
    const run = { kind: 'query', requested: false, requestedAt: null, reason: null, onProgress };
    this.currentRun = run;
    try {
      await this.ensureReady({ timeoutMs });
      if (newChat) await this.#startNewChat();
      await this.#attachFiles(attachments);
      await this.#typePrompt(prompt);
      await this.#clickSend();
      return await this.#waitForAssistantStable({
        timeoutMs: Math.min(timeoutMs, 2 * 60 * 60_000),
        responseState
      });
    } finally {
      this.#stopUploadWatch();
      if (this.currentRun === run) this.currentRun = null;
    }
  }

  // Send a follow-up message in the CURRENT chat (no new chat, no attachments) and
  // wait for the assistant's reply. Used for "continue" nudges.
  async followUp({ text, timeoutMs = 2 * 60 * 60_000, onProgress = null, responseState = null } = {}) {
    const prompt = String(text || '');
    if (!prompt.trim()) throw new Error('missing_prompt');
    const run = { kind: 'query', requested: false, requestedAt: null, reason: null, onProgress };
    this.currentRun = run;
    try {
      await this.ensureReady({ timeoutMs });
      await this.#typePrompt(prompt);
      await this.#clickSend();
      return await this.#waitForAssistantStable({
        timeoutMs: Math.min(timeoutMs, 2 * 60 * 60_000),
        responseState
      });
    } finally {
      this.#stopUploadWatch();
      if (this.currentRun === run) this.currentRun = null;
    }
  }

  async send({ text, timeoutMs = 3 * 60_000, stopAfterSend = false, onProgress = null } = {}) {
    const prompt = String(text || '');
    if (!prompt.trim()) throw new Error('missing_prompt');
    if (prompt.length > 200_000) throw new Error('prompt_too_large');

    return await this.mutex.run(async () => {
      const run = { kind: 'send', requested: false, requestedAt: null, reason: null, onProgress };
      this.currentRun = run;
      try {
        await this.ensureReady({ timeoutMs });
        await this.#typePrompt(prompt);
        await this.#clickSend();

        if (stopAfterSend) {
          const start = Date.now();
          while (Date.now() - start < 2500) {
            this.#throwIfStopRequested();
            const clicked = await this.#clickVisibleStop();
            if (clicked) break;
            await sleep(120);
          }
        }

        return { ok: true };
      } finally {
        this.#stopUploadWatch();
        if (this.currentRun === run) this.currentRun = null;
      }
    });
  }

  async getLastAssistantImages({ maxImages = 6 } = {}) {
    const assistantSel = JSON.stringify(this.selectors.assistantMessage);
    const out = await this.#eval(`(async () => {
      const nodes = Array.from(document.querySelectorAll(${assistantSel}));
      const last = nodes[nodes.length - 1] || document.querySelector('main') || document.body;
      if (!last) return [];
      const results = [];
      const seen = new Set();
      const push = (item) => {
        const key = String(item.dataUrl || item.src || '');
        if (!key || seen.has(key)) return;
        seen.add(key);
        results.push(item);
      };
      const collectRoot = (root) => Array.from(root.querySelectorAll('img')).filter((img) => {
        const r = img.getBoundingClientRect();
        const src = img.currentSrc || img.src || '';
        return src && r.width >= 64 && r.height >= 64;
      });
      const imgs = [...collectRoot(last), ...collectRoot(document.querySelector('main') || document.body)];
      for (const img of imgs) {
        if (results.length >= ${maxImages}) break;
        const src = img.currentSrc || img.src || '';
        const alt = img.alt || '';
        if (!src) continue;
        if (src.startsWith('blob:') || src.startsWith('https://') || src.startsWith('http://')) {
          try {
            const r = await fetch(src);
            const b = await r.blob();
            if (b.size > 15 * 1024 * 1024) { push({ src, alt }); continue; }
            const dataUrl = await new Promise((resolve, reject) => {
              const fr = new FileReader();
              fr.onerror = () => reject(new Error('file_reader_error'));
              fr.onload = () => resolve(String(fr.result || ''));
              fr.readAsDataURL(b);
            });
            push({ src, alt, dataUrl });
            continue;
          } catch {}
        }
        push({ src, alt });
      }

      const canvases = Array.from(last.querySelectorAll('canvas'));
      for (let i = 0; i < canvases.length && results.length < ${maxImages}; i++) {
        const c = canvases[i];
        try {
          const dataUrl = c.toDataURL('image/png');
          if (dataUrl && dataUrl.startsWith('data:image/')) {
            push({ src: 'canvas:' + (i + 1), alt: 'canvas', dataUrl });
          }
        } catch {}
      }

      if (results.length < ${maxImages}) {
        const bgEls = Array.from((document.querySelector('main') || last).querySelectorAll('*')).filter(el => {
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s && s.backgroundImage && s.backgroundImage.includes('url(') && r.width >= 64 && r.height >= 64;
        }).slice(0, 50);
        for (const el of bgEls) {
          if (results.length >= ${maxImages}) break;
          const s = getComputedStyle(el).backgroundImage || '';
          const m = s.match(/url\\([\"']?([^\"')]+)[\"']?\\)/i);
          const src = m?.[1] || '';
          if (src && (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('blob:'))) push({ src, alt: 'background-image' });
        }
      }

      if (results.length < ${maxImages}) {
        const links = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
          const href = String(a.href || '');
          return /\\.(png|jpe?g|webp)(\\?|#|$)/i.test(href) || /download|image|generated/i.test((a.textContent || '') + ' ' + (a.getAttribute('aria-label') || ''));
        });
        for (const a of links) {
          if (results.length >= ${maxImages}) break;
          const src = String(a.href || '');
          if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('blob:')) push({ src, alt: (a.textContent || '').trim() || 'link' });
        }
      }
      return results;
    })()`);
    return Array.isArray(out) ? out : [];
  }

  async downloadLastAssistantImages({ maxImages = 6, outDir = path.join(this.stateDir, 'downloads') } = {}) {
    const imgs = await this.getLastAssistantImages({ maxImages });
    await fs.mkdir(outDir, { recursive: true });
    const saved = [];

    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      let dataUrl = img.dataUrl || null;
      let mime = null;
      let buf = null;

      if (dataUrl && /^data:/i.test(dataUrl)) {
        const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/i);
        if (m) {
          mime = m[1];
          buf = Buffer.from(m[2], 'base64');
        }
      }

      if (!buf && img.src && /^https?:\/\//i.test(img.src)) {
        const r = await fetch(img.src);
        if (!r.ok) continue;
        mime = r.headers.get('content-type') || 'application/octet-stream';
        buf = Buffer.from(await r.arrayBuffer());
      }

      if (!buf) continue;

      const ext =
        mime?.includes('png') ? 'png' : mime?.includes('jpeg') || mime?.includes('jpg') ? 'jpg' : mime?.includes('webp') ? 'webp' : 'bin';
      const name = `agentify-${Date.now()}-${String(i + 1).padStart(2, '0')}.${ext}`;
      const file = path.join(outDir, name);
      await fs.writeFile(file, buf);
      saved.push({ path: file, alt: img.alt || '', mime: mime || null, source: img.src || null });
    }

    return saved;
  }

  // Download ChatGPT "entity" file buttons (generated files rendered as clickable
  // filename buttons with no href). Requires the CDP backend's download capture.
  async downloadLastAssistantEntities({ outDir = path.join(this.stateDir, 'downloads') } = {}) {
    if (typeof this.page.downloadEntityFiles !== 'function') return [];
    try {
      return await this.page.downloadEntityFiles({ outDir, debug: (m) => this.#debug(`entity: ${m}`) });
    } catch (e) {
      this.#debug(`entity-download failed: ${e?.message}`);
      return [];
    }
  }

  async getLastAssistantDownloads({ maxFiles = 6 } = {}) {
    const assistantSel = JSON.stringify(this.selectors.assistantMessage);
    const out = await this.#eval(`(async () => {
      const nodes = Array.from(document.querySelectorAll(${assistantSel}));
      const last = nodes[nodes.length - 1];
      if (!last) return [];
      const anchors = Array.from(last.querySelectorAll('a[href], a[download]'));
      const results = [];
      const seen = new Set();
      for (const a of anchors) {
        if (results.length >= ${maxFiles}) break;
        const href = String(a.href || a.getAttribute('href') || '').trim();
        const download = String(a.getAttribute('download') || '').trim();
        const text = String(a.textContent || '').trim();
        const title = String(a.getAttribute('title') || '').trim();
        const rawName = download || text || title || '';
        if (!href || seen.has(href)) continue;
        if (
          !/^blob:|^data:|^https?:/i.test(href) &&
          !/(download|export|attachment|file|csv|json|zip|pdf|doc|sheet|image)/i.test(rawName)
        ) {
          continue;
        }
        seen.add(href);
        const item = { href, name: rawName || null };
        if (/^blob:|^data:/i.test(href)) {
          try {
            const r = await fetch(href);
            const b = await r.blob();
            if (b.size <= 25 * 1024 * 1024) {
              const dataUrl = await new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onerror = () => reject(new Error('file_reader_error'));
                fr.onload = () => resolve(String(fr.result || ''));
                fr.readAsDataURL(b);
              });
              item.dataUrl = dataUrl;
            }
            item.mime = b.type || null;
            item.size = b.size || null;
          } catch {}
        }
        results.push(item);
      }
      return results;
    })()`);
    return Array.isArray(out) ? out : [];
  }

  async downloadLastAssistantFiles({ maxFiles = 6, outDir = path.join(this.stateDir, 'downloads') } = {}) {
    const items = await this.getLastAssistantDownloads({ maxFiles });
    await fs.mkdir(outDir, { recursive: true });
    const saved = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let mime = item.mime || null;
      let buf = null;

      if (item.dataUrl && /^data:/i.test(item.dataUrl)) {
        const m = String(item.dataUrl).match(/^data:([^;]+);base64,(.+)$/i);
        if (m) {
          mime = mime || m[1];
          buf = Buffer.from(m[2], 'base64');
        }
      }

      if (!buf && item.href && /^https?:\/\//i.test(item.href)) {
        const r = await fetch(item.href);
        if (!r.ok) continue;
        mime = mime || r.headers.get('content-type') || 'application/octet-stream';
        buf = Buffer.from(await r.arrayBuffer());
      }

      if (!buf) continue;

      const nameHint = String(item.name || '').trim();
      const urlName = (() => {
        try {
          const u = new URL(String(item.href || ''));
          return path.basename(u.pathname || '');
        } catch {
          return '';
        }
      })();
      const extFromMime =
        mime?.includes('json') ? 'json' :
        mime?.includes('csv') ? 'csv' :
        mime?.includes('pdf') ? 'pdf' :
        mime?.includes('zip') ? 'zip' :
        mime?.includes('markdown') ? 'md' :
        mime?.includes('plain') ? 'txt' :
        mime?.includes('png') ? 'png' :
        mime?.includes('jpeg') || mime?.includes('jpg') ? 'jpg' :
        mime?.includes('webp') ? 'webp' :
        'bin';
      const baseName = (nameHint || urlName || `chatgpt-file-${Date.now()}-${String(i + 1).padStart(2, '0')}`).replace(/[\\/:*?"<>|]+/g, '-');
      const nameWithExt = path.extname(baseName) ? baseName : `${baseName}.${extFromMime}`;
      const parsed = path.parse(nameWithExt);
      let finalName = nameWithExt;
      for (let suffix = 1; suffix < 1000; suffix++) {
        try {
          await fs.access(path.join(outDir, finalName));
          finalName = `${parsed.name}-${suffix}${parsed.ext}`;
        } catch {
          break;
        }
      }
      const file = path.join(outDir, finalName);
      await fs.writeFile(file, buf);
      saved.push({ path: file, name: finalName, mime: mime || null, source: item.href || null });
    }

    return saved;
  }
}
