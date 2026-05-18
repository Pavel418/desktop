import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeLcdInkGrid, removeCheckerboardBackground, removeChromaKeyBackground } from './image-postprocess.mjs';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(minMs, maxMs) {
  const min = Math.max(0, Number(minMs) || 0);
  const max = Math.max(min, Number(maxMs) || 0);
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function sleepWithJitter(ms, j = 40) {
  await sleep(ms + jitter(0, j));
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
  constructor({ page = null, webContents = null, loadURL = null, selectors, onBlocked, onUnblocked, stateDir }) {
    this.page = page;
    this.webContents = webContents;
    this.loadURL = loadURL;
    this.selectors = selectors;
    this.onBlocked = onBlocked;
    this.onUnblocked = onUnblocked;
    this.stateDir = stateDir;
    this.mutex = new Mutex();
    this.blocked = false;
    this.blockedKind = null;
    this.serverId = null;
    this.mouse = { x: 30, y: 30 };
  }

  async navigate(url) {
    if (this.page?.navigate) return await this.page.navigate(url);
    await this.loadURL(url);
  }

  async #eval(js) {
    if (this.page?.evaluate) return await this.page.evaluate(js);
    return await this.webContents.executeJavaScript(js, true);
  }

  async getUrl() {
    if (this.page?.getUrl) return await this.page.getUrl();
    return this.webContents.getURL();
  }

  async readPageText({ maxChars = 200_000 } = {}) {
    const text = await this.#eval(`(() => {
      const el = document.querySelector('main') || document.body;
      return (el?.innerText || document.body?.innerText || '').slice(0, ${maxChars});
    })()`);
    return String(text || '');
  }

  async inspectUi({ limit = 120 } = {}) {
    return await this.#eval(`(() => {
      const visible = (n) => {
        if (!n) return false;
        const r = n.getBoundingClientRect();
        const s = getComputedStyle(n);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      return Array.from(document.querySelectorAll('button, a, [role="button"], [aria-label], [data-testid]'))
        .filter(visible)
        .slice(0, ${Number(limit) || 120})
        .map((n) => {
          const r = n.getBoundingClientRect();
          return {
            tag: n.tagName,
            text: (n.innerText || n.textContent || '').trim().slice(0, 120),
            aria: String(n.getAttribute('aria-label') || ''),
            role: String(n.getAttribute('role') || ''),
            testId: String(n.getAttribute('data-testid') || ''),
            href: String(n.getAttribute('href') || ''),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
          };
        });
    })()`);
  }

  async clickUi({ text = '', aria = '', testId = '', role = '', index = 0 } = {}) {
    const res = await this.#eval(`(() => {
      const q = {
        text: ${JSON.stringify(String(text || '').trim().toLowerCase())},
        aria: ${JSON.stringify(String(aria || '').trim().toLowerCase())},
        testId: ${JSON.stringify(String(testId || '').trim().toLowerCase())},
        role: ${JSON.stringify(String(role || '').trim().toLowerCase())},
        index: ${Number(index) || 0}
      };
      const visible = (n) => {
        if (!n) return false;
        const r = n.getBoundingClientRect();
        const s = getComputedStyle(n);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const hay = (n) => ({
        text: (n.innerText || n.textContent || '').trim(),
        aria: String(n.getAttribute('aria-label') || ''),
        testId: String(n.getAttribute('data-testid') || ''),
        role: String(n.getAttribute('role') || ''),
      });
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], [aria-label], [data-testid]'))
        .filter(visible)
        .filter((n) => {
          const h = hay(n);
          return (!q.text || h.text.toLowerCase().includes(q.text))
            && (!q.aria || h.aria.toLowerCase().includes(q.aria))
            && (!q.testId || h.testId.toLowerCase().includes(q.testId))
            && (!q.role || h.role.toLowerCase().includes(q.role));
        });
      const target = candidates[Math.max(0, q.index)] || null;
      if (!target) return { ok:false, error:'missing_click_target', count: candidates.length };
      const r = target.getBoundingClientRect();
      return {
        ok:true,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        target: hay(target)
      };
    })()`);
    if (!res?.ok) {
      const err = new Error(res?.error || 'click_ui_failed');
      err.data = res;
      throw err;
    }
    const cx = Math.round(res.rect.x + res.rect.w / 2);
    const cy = Math.round(res.rect.y + res.rect.h / 2);
    await this.#clickAt(cx, cy);
    await sleep(350);
    return res;
  }

  async #clickVisibleElementByText({
    text,
    aria = '',
    testId = '',
    role = '',
    selector = 'button, a, [role="button"], [role="menuitem"], [role="option"], [aria-label], [data-testid]',
    index = 0
  } = {}) {
    const res = await this.#eval(`(() => {
      const q = {
        text: ${JSON.stringify(String(text || '').trim().toLowerCase())},
        aria: ${JSON.stringify(String(aria || '').trim().toLowerCase())},
        testId: ${JSON.stringify(String(testId || '').trim().toLowerCase())},
        role: ${JSON.stringify(String(role || '').trim().toLowerCase())},
        selector: ${JSON.stringify(String(selector || 'button, a, [role="button"], [role="menuitem"], [role="option"], [aria-label], [data-testid]'))},
        index: ${Number(index) || 0}
      };
      const visible = (n) => {
        if (!n) return false;
        const r = n.getBoundingClientRect();
        const s = getComputedStyle(n);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const hay = (n) => ({
        text: (n.innerText || n.textContent || '').trim(),
        aria: String(n.getAttribute('aria-label') || ''),
        testId: String(n.getAttribute('data-testid') || ''),
        role: String(n.getAttribute('role') || ''),
      });
      const candidates = Array.from(document.querySelectorAll(q.selector))
        .filter(visible)
        .filter((n) => {
          const h = hay(n);
          return (!q.text || h.text.toLowerCase().includes(q.text))
            && (!q.aria || h.aria.toLowerCase().includes(q.aria))
            && (!q.testId || h.testId.toLowerCase().includes(q.testId))
            && (!q.role || h.role.toLowerCase().includes(q.role));
        });
      const target = candidates[Math.max(0, q.index)] || null;
      if (!target) return { ok:false, error:'missing_click_target', count: candidates.length };
      const r = target.getBoundingClientRect();
      return {
        ok:true,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        target: hay(target)
      };
    })()`);
    if (!res?.ok) {
      const err = new Error(res?.error || 'click_text_failed');
      err.data = { ...res, text, aria, testId, role };
      throw err;
    }
    const cx = Math.round(res.rect.x + res.rect.w / 2);
    const cy = Math.round(res.rect.y + res.rect.h / 2);
    await this.#clickAt(cx, cy);
    await sleepWithJitter(350);
    return res;
  }

  async #enableCreateImageMode() {
    // ChatGPT image generation now lives behind the composer plus menu.
    // Do this by text/ARIA selectors, not screenshots or hard-coded pixels.
    await this.#clickVisibleElementByText({
      aria: 'Add files and more',
      testId: 'composer-plus-btn',
      selector: 'button, [role="button"], [aria-label], [data-testid]'
    });
    await sleepWithJitter(250);
    await this.#clickVisibleElementByText({
      text: 'Create image',
      selector: '[role="menuitem"], button, [role="button"], [aria-label], [data-testid]'
    });
    await sleepWithJitter(500);
  }

  async #waitForNewDownload(downloadDir, knownNames, { timeoutMs = 120_000 } = {}) {
    const start = Date.now();
    const known = new Set(Array.isArray(knownNames) ? knownNames : []);
    let lastCandidate = null;
    while (Date.now() - start < timeoutMs) {
      const entries = await fs.readdir(downloadDir, { withFileTypes: true }).catch(() => []);
      const files = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (known.has(entry.name)) continue;
        if (/\.crdownload$|\.download$|\.tmp$/i.test(entry.name)) continue;
        const file = path.join(downloadDir, entry.name);
        const stat = await fs.stat(file).catch(() => null);
        if (!stat || stat.size <= 0) continue;
        files.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
      }
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const candidate = files[0] || null;
      if (candidate) {
        if (lastCandidate?.file === candidate.file && lastCandidate?.size === candidate.size) return candidate.file;
        lastCandidate = candidate;
      }
      await sleep(500);
    }
    return null;
  }

  async #downloadImagesViaShareUi({ maxImages = 1, timeoutMs = 120_000 } = {}) {
    if (!this.page?.setDownloadPath) return [];
    const downloadDir = path.join(this.stateDir, 'downloads', `native-${Date.now()}`);
    await fs.mkdir(downloadDir, { recursive: true });
    await this.page.setDownloadPath(downloadDir);
    const knownNames = await fs.readdir(downloadDir).catch(() => []);
    const saved = [];

    for (let i = 0; i < Math.max(1, maxImages); i++) {
      await this.#eval(`(() => {
        const candidates = [
          ...Array.from(document.querySelectorAll('[data-testid="image-gen-overlay-actions"]')),
          ...Array.from(document.querySelectorAll('button[aria-label="Edit image"]')),
          ...Array.from(document.querySelectorAll('button')).filter((b) => /^edit$/i.test((b.innerText || b.textContent || '').trim()))
        ];
        const target = candidates[candidates.length - 1] || null;
        target?.scrollIntoView?.({ block: 'center', inline: 'center' });
        return !!target;
      })()`).catch(() => false);
      await sleepWithJitter(500);
      const shareTarget = await this.#eval(`(() => {
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const s = getComputedStyle(n);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const label = (n) => ((n.getAttribute('aria-label') || '') + ' ' + (n.innerText || n.textContent || '') + ' ' + (n.getAttribute('data-testid') || '')).trim();
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, [aria-label], [data-testid]')).filter(visible);
        const edits = buttons.filter((b) => /^edit$/i.test((b.innerText || b.textContent || '').trim()));
        const edit = edits[edits.length - 1] || null;
        if (!edit) return { ok: false, error: 'missing_edit_button', buttonCount: buttons.length };
        const er = edit.getBoundingClientRect();
        const explicit = buttons
          .map((b, index) => ({ b, index, r: b.getBoundingClientRect(), label: label(b) }))
          .filter((x) => /share/i.test(x.label) && Math.abs((x.r.y + x.r.height / 2) - (er.y + er.height / 2)) < 72)
          .sort((a, b) => Math.abs((a.r.y + a.r.height / 2) - (er.y + er.height / 2)) - Math.abs((b.r.y + b.r.height / 2) - (er.y + er.height / 2)))[0];
        const sameRow = buttons
          .map((b, index) => ({ b, index, r: b.getBoundingClientRect(), label: label(b) }))
          .filter((x) => x.b !== edit && Math.abs((x.r.y + x.r.height / 2) - (er.y + er.height / 2)) < 24 && x.r.x > er.x - 12)
          .sort((a, b) => b.r.x - a.r.x);
        const target = explicit || sameRow[0] || null;
        if (!target) return { ok: false, error: 'missing_share_button_near_edit', edit: { x: er.x, y: er.y, w: er.width, h: er.height } };
        return {
          ok: true,
          rect: { x: target.r.x, y: target.r.y, w: target.r.width, h: target.r.height },
          target: { label: target.label, index: target.index }
        };
      })()`);
      if (!shareTarget?.ok) break;
      await this.#clickAt(
        Math.round(shareTarget.rect.x + shareTarget.rect.w / 2),
        Math.round(shareTarget.rect.y + shareTarget.rect.h / 2)
      );
      await sleepWithJitter(700);

      const downloadTarget = await this.#eval(`(() => {
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const s = getComputedStyle(n);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const label = (n) => ((n.getAttribute('aria-label') || '') + ' ' + (n.innerText || n.textContent || '') + ' ' + (n.getAttribute('data-testid') || '')).trim();
        const candidates = Array.from(document.querySelectorAll('[role="dialog"] button, [role="dialog"] a, [role="menu"] [role="menuitem"], button, a, [role="button"], [aria-label], [data-testid]'))
          .filter(visible)
          .map((b, index) => ({ b, index, r: b.getBoundingClientRect(), label: label(b) }))
          .filter((x) => /download/i.test(x.label));
        const target = candidates[candidates.length - 1] || null;
        if (!target) return { ok: false, error: 'missing_download_button', labels: candidates.map((x) => x.label).slice(-10) };
        return {
          ok: true,
          rect: { x: target.r.x, y: target.r.y, w: target.r.width, h: target.r.height },
          target: { label: target.label, index: target.index }
        };
      })()`);
      if (!downloadTarget?.ok) break;
      await this.#clickAt(
        Math.round(downloadTarget.rect.x + downloadTarget.rect.w / 2),
        Math.round(downloadTarget.rect.y + downloadTarget.rect.h / 2)
      );
      const file = await this.#waitForNewDownload(downloadDir, knownNames, { timeoutMs });
      if (!file) break;
      knownNames.push(path.basename(file));
      saved.push({
        path: file,
        rawPath: null,
        alt: '',
        mime: file.toLowerCase().endsWith('.png') ? 'image/png' : file.toLowerCase().endsWith('.webp') ? 'image/webp' : file.toLowerCase().endsWith('.jpg') || file.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : null,
        source: 'chatgpt_share_download',
        postprocess: null
      });
      await sleepWithJitter(500);
    }
    return saved;
  }

  async #postprocessDownloadedImage(file, { postprocess = true, postprocessMode = 'auto', imageOptions = {} } = {}) {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!postprocess || ext !== 'png') return null;

    const mode = String(postprocessMode || 'auto').toLowerCase();
    let processed = null;
    let alphaProcessed = null;

    if (mode === 'chroma-key' || imageOptions?.chromaKey) {
      const chroma = typeof imageOptions?.chromaKey === 'string'
        ? imageOptions.chromaKey
        : imageOptions?.chromaKey?.hex || '#FF00FF';
      const outputPath = file.replace(/\.png$/i, '.alpha.png');
      const result = await removeChromaKeyBackground(file, {
        outputPath,
        chromaKey: chroma,
        tolerance: imageOptions?.chromaTolerance,
        alphaCutoff: imageOptions?.alphaCutoff
      });
      if (result.ok) {
        processed = result;
        alphaProcessed = result;
      }
    }

    if (!processed && mode !== 'chroma-key') {
      const outputPath = file.replace(/\.png$/i, '.alpha.png');
      const result = await removeCheckerboardBackground(file, { outputPath });
      if (result.ok) {
        processed = result;
        alphaProcessed = result;
      }
    }

    if (mode === 'lcd-ink') {
      const inkInputPath = alphaProcessed?.outputPath || file;
      const inkOutputPath = file.replace(/\.png$/i, '.lcd-ink.png');
      const inkResult = await normalizeLcdInkGrid(inkInputPath, {
        outputPath: inkOutputPath,
        columns: imageOptions?.columns,
        rows: imageOptions?.rows,
        cellSize: imageOptions?.cellSize,
        inkThreshold: imageOptions?.inkThreshold,
        alphaThreshold: imageOptions?.alphaThreshold
      });
      processed = {
        ...inkResult,
        kind: 'lcd_ink_grid',
        alpha: alphaProcessed
      };
    }

    return processed;
  }

  #postprocessSummary(processed) {
    if (!processed) return null;
    return {
      kind: processed.kind || 'checkerboard_to_alpha',
      outputPath: processed.outputPath,
      chromaKey: processed.chromaKey || null,
      chromaPixels: processed.chromaPixels || null,
      transparentPixels: processed.transparentPixels,
      totalPixels: processed.totalPixels || (processed.width && processed.height ? processed.width * processed.height : null),
      transparentRatio: processed.transparentRatio,
      columns: processed.columns || null,
      rows: processed.rows || null,
      cellSize: processed.cellSize || null,
      palette: processed.palette || null,
      alphaPath: processed.alpha?.outputPath || null
    };
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

      const hasTurnstile = iframeSrcs.some(s => /turnstile/i.test(s)) || !!document.querySelector('iframe[src*=\"turnstile\" i]');
      const hasArkose = iframeSrcs.some(s => /arkoselabs|arkose/i.test(s)) || !!document.querySelector('iframe[src*=\"arkose\" i], iframe[src*=\"arkoselabs\" i]');
      const hasVerifyButton = Array.from(document.querySelectorAll('button, a'))
        .some(b => /verify you are human|human verification|i am human/i.test((b.textContent || '').trim()));

      const looks403 = /\\b403\\b|access denied|forbidden|unusual traffic|verify/i.test(bodyText) && !/prompt/i.test(bodyText);
      const loginLike = !!document.querySelector('input[type=\"password\"], input[name=\"password\"], input[autocomplete=\"current-password\"]')
        || /log in|sign in|continue with/i.test(bodyText);

      const promptVisible = (() => {
        const el = document.querySelector(${JSON.stringify(this.selectors.promptTextarea)});
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      })();

      const blocked = hasTurnstile || hasArkose || hasVerifyButton || looks403 || (loginLike && !promptVisible);
      const kind = (hasTurnstile || hasArkose || hasVerifyButton) ? 'captcha' : (loginLike ? 'login' : (looks403 ? 'blocked' : null));
      return {
        url, title, readyState,
        blocked,
        promptVisible,
        kind,
        indicators: { hasTurnstile, hasArkose, hasVerifyButton, looks403, loginLike }
      };
    })()`);

    return result;
  }

  async waitForPromptVisible({ timeoutMs = 10 * 60_000, pollMs = 500 } = {}) {
    const start = Date.now();
    let activeElapsed = 0;
    let lastTick = Date.now();
    while (activeElapsed < timeoutMs) {
      const now = Date.now();
      const delta = now - lastTick;
      lastTick = now;
      if (!this.blocked) activeElapsed += delta;

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
      await this.onBlocked?.(st);
    }
  }

  async #exitBlockedStateIfNeeded() {
    if (this.blocked) {
      this.blocked = false;
      this.blockedKind = null;
      await this.onUnblocked?.();
    }
  }

  async #sendKey(key, { modifiers = [] } = {}) {
    if (this.page?.sendKey) return await this.page.sendKey(key, { modifiers });
    const wc = this.webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
    // Only send a char event for printable single-character keys.
    const hasCommandModifier = Array.isArray(modifiers) && modifiers.some((m) => m === 'control' || m === 'meta' || m === 'alt');
    if (typeof key === 'string' && key.length === 1 && !hasCommandModifier) {
      wc.sendInputEvent({ type: 'char', keyCode: key, modifiers });
    }
    wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
  }

  async #typeHuman(text) {
    if (this.page?.insertText) {
      await this.page.insertText(String(text));
      return;
    }
    const wc = this.webContents;
    for (const ch of String(text)) {
      wc.sendInputEvent({ type: 'char', keyCode: ch });
      await sleep(jitter(12, 45));
    }
  }

  async #moveMouseTo(x, y) {
    const from = { ...this.mouse };
    const steps = Math.max(6, Math.min(22, Math.floor(Math.hypot(x - from.x, y - from.y) / 35)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const nx = Math.round(from.x + (x - from.x) * t + jitter(-2, 2));
      const ny = Math.round(from.y + (y - from.y) * t + jitter(-2, 2));
      if (this.page?.moveMouse) await this.page.moveMouse(nx, ny);
      else this.webContents.sendInputEvent({ type: 'mouseMove', x: nx, y: ny, movementX: 0, movementY: 0 });
      await sleep(jitter(6, 18));
      this.mouse = { x: nx, y: ny };
    }
  }

  async #clickAt(x, y) {
    await this.#moveMouseTo(x, y);
    if (this.page?.mouseDown) await this.page.mouseDown(x, y, { button: 'left', clickCount: 1 });
    else this.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(jitter(20, 60));
    if (this.page?.mouseUp) await this.page.mouseUp(x, y, { button: 'left', clickCount: 1 });
    else this.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }

  async #typePrompt(prompt) {
    const sel = JSON.stringify(this.selectors.promptTextarea);
    const ok = await this.#eval(`(() => {
      const pickPrompt = () => {
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const s = getComputedStyle(n);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const nodes = Array.from(document.querySelectorAll(${sel}));
        return nodes.find(visible) || nodes[0] || null;
      };
      const el = pickPrompt();
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

    await this.#eval(`(() => {
      const pickPrompt = () => {
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const s = getComputedStyle(n);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const nodes = Array.from(document.querySelectorAll(${sel}));
        return nodes.find(visible) || nodes[0] || null;
      };
      const el = pickPrompt();
      if (!el) return false;
      el.focus();
      if ('value' in el) {
        el.value = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        return true;
      }
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false, null);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      return true;
    })()`);

    const isMac = process.platform === 'darwin';
    await sleep(jitter(80, 140));
    await this.#sendKey('A', { modifiers: [isMac ? 'meta' : 'control'] });
    await sleep(jitter(15, 50));
    await this.#sendKey('Backspace');
    await sleep(jitter(25, 80));
    await this.#typeHuman(prompt);
  }

  async #clickSend() {
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const stopSel = JSON.stringify(this.selectors.stopButton);
    const res = await this.#eval(`(() => {
      const stop = document.querySelector(${stopSel});
      if (stop) return { ok:false, error:'already_generating' };
      const visible = (n) => {
        if (!n) return false;
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const disabled = (n) => !!n.disabled || String(n.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
      const prompt = document.querySelector(${JSON.stringify(this.selectors.promptTextarea)}) || document.activeElement;
      const form = prompt?.closest?.('form') || null;
      const candidates = [
        ...(form ? Array.from(form.querySelectorAll(${sendSel})) : []),
        ...Array.from(document.querySelectorAll(${sendSel})),
        ...(form ? Array.from(form.querySelectorAll('button, [role="button"]')) : [])
      ];
      const seen = new Set();
      const btn = candidates.find((n) => {
        if (!n || seen.has(n)) return false;
        seen.add(n);
        const label = ((n.getAttribute('aria-label') || '') + ' ' + (n.textContent || '')).trim();
        if (/stop|cancel|retry|sign in|login/i.test(label)) return false;
        return visible(n) && !disabled(n);
      });
      if (!btn) return { ok:false, error:'missing_send_button' };
      const r = btn.getBoundingClientRect();
      return { ok:true, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
    })()`);
    if (!res?.ok) {
      const err = new Error(res?.error || 'send_failed');
      err.data = res;
      throw err;
    }

    const sendAccepted = async () =>
      await this.#eval(`(() => {
        const stop = document.querySelector(${stopSel});
        if (stop) return true;
        const mainText = (document.querySelector('main')?.innerText || document.body?.innerText || '').slice(-4000);
        if (/\\b(generating|creating image|thinking|reasoning|stop generating)\\b/i.test(mainText)) return true;
        const pickPrompt = () => {
          const visible = (n) => {
            if (!n) return false;
            const r = n.getBoundingClientRect();
            const s = getComputedStyle(n);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          };
          const nodes = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
          return nodes.find(visible) || nodes[0] || null;
        };
        const el = pickPrompt();
        const text = (el?.innerText || el?.value || el?.textContent || '').trim();
        return text.length === 0;
      })()`);

    const clickSendInDom = async () =>
      await this.#eval(`(() => {
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const disabled = (n) => !!n.disabled || String(n.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
        const candidates = Array.from(document.querySelectorAll(${sendSel}));
        const btn = candidates.find((n) => visible(n) && !disabled(n));
        if (!btn) return false;
        btn.click();
        return true;
      })()`);

    if (res?.rect?.w > 0 && res?.rect?.h > 0) {
      const cx = Math.round(res.rect.x + res.rect.w / 2);
      const cy = Math.round(res.rect.y + res.rect.h / 2);
      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(attempt === 0 ? 300 : 900);
        if (attempt === 0) await clickSendInDom();
        else await this.#clickAt(cx, cy);
        await sleep(700);
        if (await sendAccepted()) return;
        await this.#sendKey('Enter');
        await sleep(700);
        if (await sendAccepted()) return;
        await this.#sendKey('Enter', { modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
        await sleep(900);
        if (await sendAccepted()) return;
      }
      const err = new Error('send_not_accepted');
      err.data = { reason: 'prompt_still_visible_after_send_attempts' };
      throw err;
    }

    // Fallback
    await this.#eval(`(() => { const btn = document.querySelector(${sendSel}); if (btn) btn.click(); })()`);
    await sleep(350);
    await this.#sendKey('Enter');
  }

  async #attachFiles(files) {
    if (!files?.length) return;
    const absFiles = files.map((p) => path.resolve(p));
    for (const f of absFiles) await fs.access(f);

    // Best-effort: click the paperclip/attach UI, then set <input type=file> via DevTools protocol.
    await this.#eval(`(() => {
      const candidates = Array.from(document.querySelectorAll('button, [role=\"button\"]'));
      const attach = candidates.find(b => /attach|upload|paperclip/i.test((b.getAttribute('aria-label')||'') + ' ' + (b.textContent||'')));
      if (attach) attach.click();
      return true;
    })()`);

    if (this.page?.setFileInputFiles) {
      for (let attempt = 0; attempt < 10; attempt++) {
        await this.#eval(`(() => {
          const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
          const attach = candidates.find(b => /attach|upload|paperclip/i.test((b.getAttribute('aria-label')||'') + ' ' + (b.textContent||'')));
          if (attach) attach.click();
          return true;
        })()`).catch(() => null);
        try {
          await this.page.setFileInputFiles(absFiles);
          return;
        } catch (error) {
          if (attempt === 9) throw error;
          await sleepWithJitter(180);
        }
      }
    }

    const wc = this.webContents;
    const didAttach = !wc.debugger.isAttached();
    try {
      if (didAttach) wc.debugger.attach('1.3');
    } catch {
      // If debugger attach fails, we can't reliably set file input.
      const err = new Error('file_upload_unavailable');
      err.data = { reason: 'debugger_attach_failed' };
      throw err;
    }

    try {
      let lastNodeIds = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        const { root } = await wc.debugger.sendCommand('DOM.getDocument', { depth: 12, pierce: true });
        const q = await wc.debugger.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type="file"]' });
        const nodeIds = Array.isArray(q?.nodeIds) ? q.nodeIds : [];
        lastNodeIds = nodeIds;
        if (!nodeIds.length) {
          await sleepWithJitter(180);
          continue;
        }

        let lastErr = null;
        // Prefer last input (often the real one appended to the DOM).
        const tryIds = [...nodeIds].reverse();
        for (const nodeId of tryIds) {
          try {
            await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: absFiles });
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
          }
        }
        if (!lastErr) return;
        await sleepWithJitter(180);
      }

      const err = new Error('missing_file_input');
      err.data = { selector: 'input[type=file]', found: lastNodeIds.length };
      throw err;
    } finally {
      try {
        if (didAttach && wc.debugger.isAttached()) wc.debugger.detach();
      } catch {}
    }
  }

  async #waitForAssistantStable({ timeoutMs = 5 * 60_000, stableMs = 1500, pollMs = 400 } = {}) {
    const assistantSel = JSON.stringify(this.selectors.assistantMessage);
    const stopSel = JSON.stringify(this.selectors.stopButton);
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const start = Date.now();
    let last = '';
    let lastChange = Date.now();
    let stopGoneAt = null;
    let continueClicks = 0;

    while (Date.now() - start < timeoutMs) {
      const snap = await this.#eval(`(() => {
        const stop = !!document.querySelector(${stopSel});
        const send = document.querySelector(${sendSel});
        const sendEnabled = !!send && !send.disabled;
        const nodes = Array.from(document.querySelectorAll(${assistantSel}));
        const lastNode = nodes[nodes.length - 1];
        const txt = (lastNode?.innerText || '').trim();
        const hasContinue = Array.from(document.querySelectorAll('button, a')).some(b => /continue generating/i.test((b.textContent||'').trim()));
        const hasRegenerate = Array.from(document.querySelectorAll('button, a')).some(b => /regenerate/i.test((b.textContent||'').trim()));
        const hasError = /something went wrong|try again|error/i.test(txt) && txt.length < 500;
        return { stop, sendEnabled, txt, count: nodes.length, hasError, hasContinue, hasRegenerate };
      })()`);

      const txt = String(snap?.txt || '');
      if (txt !== last) {
        last = txt;
        lastChange = Date.now();
      }

      if (snap?.stop) stopGoneAt = null;
      else if (stopGoneAt == null) stopGoneAt = Date.now();

      const dynamicStableMs = Math.max(stableMs, txt.length > 8000 ? 3000 : txt.length > 2000 ? 2200 : stableMs);
      const stable = Date.now() - lastChange >= dynamicStableMs;
      const stopGoneLongEnough = stopGoneAt != null && Date.now() - stopGoneAt >= 800;

      if (!snap?.stop && snap?.hasContinue && continueClicks < 3) {
        continueClicks += 1;
        await this.#eval(`(() => {
          const btn = Array.from(document.querySelectorAll('button, a')).find(b => /continue generating/i.test((b.textContent||'').trim()));
          if (btn) btn.click();
        })()`);
        await sleep(250);
        continue;
      }

      const done = !snap?.stop && stopGoneLongEnough && snap?.sendEnabled && stable && txt.length > 0;
      if (done) {
        const extra = await this.#eval(`(() => {
          const nodes = Array.from(document.querySelectorAll(${assistantSel}));
          const lastNode = nodes[nodes.length - 1];
          const codes = Array.from(lastNode?.querySelectorAll('pre code') || []).map(c => {
            const cls = String(c.className || '');
            const lang = (cls.match(/language-([a-z0-9_-]+)/i) || [])[1] || null;
            return { language: lang, text: (c.innerText || '').trim() };
          }).filter(c => c.text);
          return { codeBlocks: codes };
        })()`);
        return { text: txt, codeBlocks: extra?.codeBlocks || [], meta: { count: snap?.count || 0, hasError: !!snap?.hasError } };
      }

      await sleep(pollMs);
    }

    const err = new Error('timeout_waiting_for_response');
    err.data = { last };
    throw err;
  }

  async query({ prompt, attachments = [], timeoutMs = 10 * 60_000 } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('missing_prompt');
    if (prompt.length > 200_000) throw new Error('prompt_too_large');

    return await this.mutex.run(async () => {
      await this.ensureReady({ timeoutMs });
      await this.#attachFiles(attachments);
      await this.#typePrompt(prompt);
      await this.#clickSend();
      const result = await this.#waitForAssistantStable({ timeoutMs: Math.min(timeoutMs, 8 * 60_000) });
      return result;
    });
  }

  async send({ text, timeoutMs = 3 * 60_000, stopAfterSend = false } = {}) {
    const prompt = String(text || '');
    if (!prompt.trim()) throw new Error('missing_prompt');
    if (prompt.length > 200_000) throw new Error('prompt_too_large');

    return await this.mutex.run(async () => {
      await this.ensureReady({ timeoutMs });
      await this.#typePrompt(prompt);
      await this.#clickSend();

      if (stopAfterSend) {
        const stopSel = JSON.stringify(this.selectors.stopButton);
        const start = Date.now();
        while (Date.now() - start < 2500) {
          const clicked = await this.#eval(`(() => {
            const stop = document.querySelector(${stopSel});
            if (!stop) return false;
            try { stop.click(); return true; } catch { return false; }
          })()`);
          if (clicked) break;
          await sleep(120);
        }
      }

      return { ok: true };
    });
  }

  async waitForImages({ maxImages = 6, minImages = 1, timeoutMs = 10 * 60_000, pollMs = 1500 } = {}) {
    const start = Date.now();
    let lastImages = [];
    while (Date.now() - start < timeoutMs) {
      lastImages = await this.getLastAssistantImages({ maxImages }).catch(() => []);
      const editReady = await this.#eval(`(() => {
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const s = getComputedStyle(n);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
        return buttons.some((b) => /^edit$/i.test((b.innerText || b.textContent || '').trim()));
      })()`).catch(() => false);
      if (lastImages.length >= minImages && editReady) {
        return { images: lastImages, elapsedMs: Date.now() - start };
      }
      await sleep(pollMs);
    }
    const err = new Error('timeout_waiting_for_images');
    err.data = { count: lastImages.length, images: lastImages.map((img) => ({ src: img.src || null, alt: img.alt || '' })) };
    throw err;
  }

  async generateImages({ prompt, attachments = [], timeoutMs = 10 * 60_000, maxImages = 6, minImages = 1 } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('missing_prompt');
    if (prompt.length > 200_000) throw new Error('prompt_too_large');

    return await this.mutex.run(async () => {
      await this.ensureReady({ timeoutMs });
      await this.#enableCreateImageMode();
      await this.#attachFiles(attachments);
      await this.#typePrompt(prompt);
      await this.#clickSend();
      return await this.waitForImages({ maxImages, minImages, timeoutMs: Math.min(timeoutMs, 12 * 60_000) });
    });
  }

  async getLastAssistantImages({ maxImages = 6 } = {}) {
    const assistantSel = JSON.stringify(this.selectors.assistantMessage);
    const out = await this.#eval(`(async () => {
      const nodes = Array.from(document.querySelectorAll(${assistantSel}));
      const main = document.querySelector('main') || document.body;
      const last = nodes[nodes.length - 1] || main;
      if (!last && !main) return [];
      const generating = /\\b(generating|creating image|hang tight|thinking)\\b/i.test((main?.innerText || document.body?.innerText || '').slice(-2500));
      const results = [];
      const seen = new Set();
      const push = (item) => {
        const key = String(item.dataUrl || item.src || '');
        if (!key || seen.has(key)) return;
        seen.add(key);
        results.push(item);
      };
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width >= 64 && r.height >= 64 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const scoreImage = (img) => {
        const r = img.getBoundingClientRect();
        const src = img.currentSrc || img.src || '';
        const alt = img.alt || '';
        let score = Math.round(r.width * r.height);
        if (/Generated image/i.test(alt)) score += 10_000_000;
        if (/backend-api\\/estuary\\/content|\\/files\\//i.test(src)) score += 5_000_000;
        if (/avatar|icon|logo|emoji|asset|thumbnail/i.test((img.className || '') + ' ' + alt) && r.width < 160 && r.height < 160) score -= 2_000_000;
        return score;
      };
      const collectRoot = (root) => {
        const imgs = Array.from(root?.querySelectorAll?.('img') || []).filter((img) => {
          const src = img.currentSrc || img.src || '';
          return src && visible(img);
        });
        return imgs;
      };
      const imgs = [...collectRoot(last), ...collectRoot(main), ...collectRoot(document.body)]
        .sort((a, b) => scoreImage(b) - scoreImage(a));
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

      const canvases = generating ? [] : Array.from((main || last).querySelectorAll('canvas')).filter(visible);
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
        const bgEls = Array.from((main || last).querySelectorAll('*')).filter(el => {
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

  async downloadLastAssistantImages({ maxImages = 6, postprocess = true, postprocessMode = 'auto', imageOptions = {} } = {}) {
    const nativeDownloads = await this.#downloadImagesViaShareUi({
      maxImages,
      timeoutMs: 120_000
    }).catch(() => []);
    if (nativeDownloads.length) {
      const processedDownloads = [];
      for (const item of nativeDownloads) {
        let processed = null;
        try {
          processed = await this.#postprocessDownloadedImage(item.path, { postprocess, postprocessMode, imageOptions });
        } catch {}
        processedDownloads.push({
          ...item,
          path: processed?.outputPath || item.path,
          rawPath: processed?.outputPath ? item.path : item.rawPath,
          postprocess: this.#postprocessSummary(processed)
        });
      }
      return processedDownloads;
    }

    const imgs = await this.getLastAssistantImages({ maxImages });
    const outDir = path.join(this.stateDir, 'downloads');
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
      let processed = null;
      try {
        processed = await this.#postprocessDownloadedImage(file, { postprocess, postprocessMode, imageOptions });
      } catch {}
      saved.push({
        path: processed?.outputPath || file,
        rawPath: processed?.outputPath ? file : null,
        alt: img.alt || '',
        mime: mime || null,
        source: img.src || null,
        postprocess: this.#postprocessSummary(processed)
      });
    }

    return saved;
  }
}
