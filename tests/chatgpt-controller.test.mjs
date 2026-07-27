import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ChatGPTController,
  attachmentAttemptComplete,
  attachmentsComplete,
  attachmentProgressKey,
  responseCompletionDecision,
  RESPONSE_COMPLETION_DEFAULTS
} from '../chatgpt-controller.mjs';

function readyState() {
  return {
    url: 'https://chatgpt.com/',
    title: 'ChatGPT',
    readyState: 'complete',
    blocked: false,
    promptVisible: true,
    kind: null,
    indicators: {
      hasTurnstile: false,
      hasArkose: false,
      hasVerifyButton: false,
      looks403: false,
      loginLike: false,
      rawPromptVisible: true,
      sendVisible: true
    }
  };
}

test('chatgpt-controller: send falls back to requestSubmit on the active composer before Enter', async () => {
  const events = [];
  let waitForSendChecks = 0;

  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes("form.requestSubmit")) {
        events.push('requestSubmit');
        return true;
      }
      if (js.includes('already_generating')) return { ok: true, requestSubmit: true, host: 'chatgpt.com' };
      if (js.includes('sendReady')) return { uploading: false, sendReady: true, hasSend: true };
      if (js.includes('promptLen')) {
        waitForSendChecks += 1;
        // 1st poll: prompt still has text; 2nd poll: composer cleared (send accepted).
        return waitForSendChecks >= 2
          ? { stopVisible: false, promptLen: 0 }
          : { stopVisible: false, promptLen: 7 };
      }
      // #confirmPosted: after a real send a new user turn is present in the thread.
      if (js.includes('const users')) return { users: 1, stop: false };
      // #countUserMessages: baseline user-turn count before the send is zero.
      if (js.includes('author-role="user"')) return 0;
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/';
    },
    async sendKey(key) {
      events.push(`key:${key}`);
    },
    async insertText(text) {
      events.push(`text:${text}`);
    },
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });

  const result = await controller.send({ text: 'agentify', timeoutMs: 5_000 });
  assert.deepEqual(result, { ok: true });
  assert.equal(events.includes('requestSubmit'), true);
  assert.equal(events.includes('key:Enter'), false);
});

// A fake page for the send path. `postsOnAttempt` says which send attempt finally lands a user
// turn — mirroring the live behaviour where ChatGPT accepts nothing while it still holds a file
// upload as pending (verified live: submit button not disabled, spinner + "File upload pending"
// tooltip, click is a no-op), then accepts the identical composer content moments later.
function sendPathPage({ postsOnAttempt = 1, userTurnsDuringWait = null, events = [] } = {}) {
  let sendAttempts = 0;
  let userTurns = 0;
  return {
    events,
    get sendAttempts() { return sendAttempts; },
    get userTurns() { return userTurns; },
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes('form.requestSubmit')) return true;
      if (js.includes('already_generating')) {
        sendAttempts += 1;
        events.push(`sendAttempt:${sendAttempts}`);
        if (sendAttempts >= postsOnAttempt) userTurns = 1;
        return { ok: true, rect: { x: 10, y: 10, w: 20, h: 20 }, requestSubmit: true, host: 'chatgpt.com' };
      }
      if (js.includes('sendReady')) return { uploading: false, sendReady: true, hasSend: true };
      if (js.includes('tipText')) {
        events.push('diagnostics');
        return { tipText: 'File upload pending', sendDisabled: false, sendIcon: 'spinner', chips: 2, promptLen: 12, userTurns };
      }
      if (js.includes('promptLen')) return { stopVisible: false, promptLen: 12 };
      // A send that landed only after #confirmPosted gave up is visible to EVERY posted-check, so
      // both probes below consult the same state — otherwise the fixture would only exercise
      // whichever probe the implementation happened to call.
      if (js.includes('const users')) {
        if (userTurnsDuringWait != null && sendAttempts >= userTurnsDuringWait) userTurns = 1;
        return { users: userTurns, stop: false };
      }
      if (js.includes('author-role="user"')) {
        if (userTurnsDuringWait != null && sendAttempts >= userTurnsDuringWait) userTurns = 1;
        return userTurns;
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() { return 'https://chatgpt.com/'; },
    async sendKey(key) { events.push(`key:${key}`); },
    async insertText() {},
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };
}

function sendPathController(page) {
  return new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });
}

// Fake upload watcher so the attach/send gates can be driven without a browser.
function uploadWatchStub(states) {
  let i = 0;
  const base = { total: 0, inflight: 0, finished: 0, failed: 0, httpErrors: 0, httpErrorStatuses: [], completed: 0, created: 0, blobs: 0, requests: [] };
  return {
    off() {},
    snapshot() {
      const state = states[Math.min(i, states.length - 1)];
      i += 1;
      return { ...base, ...state };
    }
  };
}

function attachPage({ watchStates, events = [] }) {
  return {
    events,
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      // #waitForComposerHydration: report an interactive composer immediately.
      if (js.includes('hasSubmit')) return { loaded: true, hasPrompt: true, hasComposer: true, hasInput: true, hasSubmit: true };
      if (js.includes('const stems')) return { matched: 2, matchedStems: ['a', 'generator'], chips: 2, uploading: false };
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes('already_generating')) { events.push('SEND'); return { ok: true, requestSubmit: true, host: 'chatgpt.com' }; }
      if (js.includes('sendReady')) return { uploading: false, sendReady: true, hasSend: true };
      if (js.includes('const users')) return { users: 1, stop: false };
      if (js.includes('author-role="user"')) return 0;
      return true;
    },
    async getUrl() { return 'https://chatgpt.com/'; },
    async sendKey() {}, async insertText() {}, async moveMouse() {}, async mouseDown() {}, async mouseUp() {},
    async setFileInputFiles() { return { found: 1, set: 1, strategy: 'active-composer', nodeId: 1 }; },
    watchUploads() { return uploadWatchStub(watchStates); }
  };
}

test('attach: a file that was selected but never uploaded is refused before any send', async (t) => {
  const originalWait = ChatGPTController.UPLOAD_SEQUENCE_TIMEOUT_MS;
  const originalSettle = ChatGPTController.ATTACH_SETTLE_MS;
  ChatGPTController.UPLOAD_SEQUENCE_TIMEOUT_MS = 50;
  ChatGPTController.ATTACH_SETTLE_MS = 5;
  t.after(() => {
    ChatGPTController.UPLOAD_SEQUENCE_TIMEOUT_MS = originalWait;
    ChatGPTController.ATTACH_SETTLE_MS = originalSettle;
  });
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const dir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'attach-'));
  const f1 = pathMod.join(dir, 'a.pdf');
  const f2 = pathMod.join(dir, 'generator.py');
  await fsp.writeFile(f1, '%PDF-1.4');
  await fsp.writeFile(f2, '# gen');

  // Exactly the observed trace: two chips, three requests, ONE completed sequence, no failures.
  const page = attachPage({ watchStates: [{ total: 3, finished: 3, completed: 1, created: 1, blobs: 1 }] });
  const controller = sendPathController(page);
  await assert.rejects(
    () => controller.query({ prompt: 'hello', attachments: [f1, f2], timeoutMs: 3000 }),
    (err) => {
      assert.equal(err.message, 'attachment_upload_incomplete');
      assert.equal(err.retryable, true);
      assert.equal(err.data.expected, 2);
      assert.equal(err.data.completed, 1);
      return true;
    }
  );
  assert.ok(!page.events.includes('SEND'), 'the prompt is never dispatched with a half-uploaded set');
});

test('attach: two completed sequences for two files proceed to the send', async (t) => {
  const originalWait = ChatGPTController.UPLOAD_SEQUENCE_TIMEOUT_MS;
  const originalSettle = ChatGPTController.ATTACH_SETTLE_MS;
  ChatGPTController.UPLOAD_SEQUENCE_TIMEOUT_MS = 50;
  ChatGPTController.ATTACH_SETTLE_MS = 5;
  t.after(() => {
    ChatGPTController.UPLOAD_SEQUENCE_TIMEOUT_MS = originalWait;
    ChatGPTController.ATTACH_SETTLE_MS = originalSettle;
  });
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const dir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'attach-ok-'));
  const f1 = pathMod.join(dir, 'a.pdf');
  const f2 = pathMod.join(dir, 'generator.py');
  await fsp.writeFile(f1, '%PDF-1.4');
  await fsp.writeFile(f2, '# gen');

  const page = attachPage({ watchStates: [{ total: 6, finished: 6, completed: 2, created: 2, blobs: 2 }] });
  const controller = sendPathController(page);
  // The response wait is not the subject here; a short timeout is enough to prove the send happened.
  await controller.query({ prompt: 'hello', attachments: [f1, f2], timeoutMs: 1500 }).catch(() => {});
  assert.ok(page.events.includes('SEND'), 'a fully uploaded set is dispatched normally');
});

test('send: a blocked send is retried in place and succeeds without failing the turn', async (t) => {
  // Keep the test fast: the real waits are 5s/15s/30s.
  const original = ChatGPTController.SEND_RETRY_WAITS_MS;
  ChatGPTController.SEND_RETRY_WAITS_MS = [1];
  t.after(() => { ChatGPTController.SEND_RETRY_WAITS_MS = original; });

  const page = sendPathPage({ postsOnAttempt: 2 });
  const result = await sendPathController(page).send({ text: 'agentify', timeoutMs: 5_000 });
  assert.deepEqual(result, { ok: true });
  assert.equal(page.sendAttempts, 2, 'the send is retried until a user turn actually appears');
  assert.ok(page.events.includes('diagnostics'), 'each blocked send records why ChatGPT refused');
});

test('send: a send that lands late is never sent twice', async (t) => {
  const original = ChatGPTController.SEND_RETRY_WAITS_MS;
  ChatGPTController.SEND_RETRY_WAITS_MS = [1, 1, 1];
  t.after(() => { ChatGPTController.SEND_RETRY_WAITS_MS = original; });

  // The first attempt posts, but only after #confirmPosted has given up.
  const page = sendPathPage({ postsOnAttempt: 99, userTurnsDuringWait: 1 });
  const result = await sendPathController(page).send({ text: 'agentify', timeoutMs: 5_000 });
  assert.deepEqual(result, { ok: true });
  assert.equal(page.sendAttempts, 1, 'a duplicate prompt must never be posted');
});

test('send: an unsendable composer eventually fails as a retryable send_not_triggered', async (t) => {
  const original = ChatGPTController.SEND_RETRY_WAITS_MS;
  ChatGPTController.SEND_RETRY_WAITS_MS = [1];
  t.after(() => { ChatGPTController.SEND_RETRY_WAITS_MS = original; });

  const page = sendPathPage({ postsOnAttempt: 99 });
  await assert.rejects(
    () => sendPathController(page).send({ text: 'agentify', timeoutMs: 5_000 }),
    (err) => {
      assert.equal(err.message, 'send_not_triggered');
      assert.equal(err.retryable, true, 'the batch driver retries this in a fresh chat');
      assert.equal(err.data.attempts, 2);
      return true;
    }
  );
  assert.equal(page.sendAttempts, 2, 'first attempt plus one per configured wait');
});

// Regression coverage for a real bug: #attachFiles used to consider "at least one
// chip appeared" (its `detected` flag) proof that every requested file attached, so
// a chat could proceed with only the PDF (or only generator.py) actually attached
// while the model was told both were present. attachmentsComplete/attachmentProgressKey
// are the extracted booleans the fixed retry loop relies on; test them directly rather
// than driving the real 20s/6s/8-attempt browser-polling timers.

test('attachmentsComplete: a single chip is NOT enough when more than one file was requested', () => {
  // This is exactly the case the old `detected` flag (chips > 0) wrongly accepted.
  assert.equal(attachmentsComplete({ chips: 1, matched: 1, uploading: false }, 2), false);
  assert.equal(attachmentsComplete({ chips: 0, matched: 0, uploading: false }, 2), false);
});

test('attachmentsComplete: true once chips or matched reach the expected count', () => {
  assert.equal(attachmentsComplete({ chips: 2, matched: 0 }, 2), true);
  assert.equal(attachmentsComplete({ chips: 0, matched: 2 }, 2), true);
  assert.equal(attachmentsComplete({ chips: 3, matched: 3 }, 2), true, 'more than expected still counts as complete');
});

test('attachmentsComplete: a single requested file needs just one chip or match', () => {
  assert.equal(attachmentsComplete({ chips: 1, matched: 0 }, 1), true);
  assert.equal(attachmentsComplete({ chips: 0, matched: 0 }, 1), false);
});

test('attachmentProgressKey: identical snapshots produce the same key (used to detect a stall)', () => {
  const a = attachmentProgressKey({ chips: 1, matched: 1, uploading: false });
  const b = attachmentProgressKey({ chips: 1, matched: 1, uploading: false });
  assert.equal(a, b);
});

test('attachmentProgressKey: changes when chips, matched, or uploading changes', () => {
  const base = attachmentProgressKey({ chips: 1, matched: 1, uploading: false });
  assert.notEqual(attachmentProgressKey({ chips: 2, matched: 1, uploading: false }), base);
  assert.notEqual(attachmentProgressKey({ chips: 1, matched: 2, uploading: false }), base);
  assert.notEqual(attachmentProgressKey({ chips: 1, matched: 1, uploading: true }), base);
});

test('attachmentAttemptComplete: accepts only the current file name or a new chip', () => {
  const before = { chips: 1, matchedStems: ['first'] };
  assert.equal(attachmentAttemptComplete(before, { stem: 'second', baselineChips: 1 }), false);
  assert.equal(
    attachmentAttemptComplete({ chips: 1, matchedStems: ['first', 'second'] }, { stem: 'second', baselineChips: 1 }),
    true
  );
  assert.equal(attachmentAttemptComplete({ chips: 2, matchedStems: ['first'] }, { stem: 'second', baselineChips: 1 }), true);
});

test('attachmentAttemptComplete: does not mistake an existing chip for a new file', () => {
  assert.equal(attachmentAttemptComplete({ chips: 2, matchedStems: [] }, { stem: 'third', baselineChips: 2 }), false);
});

test('response completion: tool-phase idle does not complete a truncated handoff', () => {
  const partial = {
    text: 'JSON\n{',
    started: true,
    busy: false,
    stable: true,
    idleForMs: 60_000,
    terminalVisible: false,
    terminalForMs: 0,
    hasError: false,
    semanticState: 'incomplete'
  };
  assert.equal(responseCompletionDecision(partial).done, false);
});

test('response completion: a complete handoff returns after normal UI stabilization', () => {
  const result = responseCompletionDecision({
    text: '{"stage_status":"passed"}',
    started: true,
    busy: false,
    stable: true,
    idleForMs: 5_000,
    terminalVisible: false,
    terminalForMs: 0,
    hasError: false,
    semanticState: 'complete'
  });
  assert.deepEqual(result, { done: true, reason: 'semantic_complete' });
});

test('response completion: sustained terminal controls release a genuinely truncated final reply', () => {
  const result = responseCompletionDecision({
    text: 'JSON\n{',
    started: true,
    busy: false,
    stable: true,
    idleForMs: 15_000,
    terminalVisible: true,
    terminalForMs: 15_000,
    hasError: false,
    semanticState: 'incomplete'
  });
  assert.deepEqual(result, { done: true, reason: 'terminal_incomplete' });
});

test('response completion: a busy turn with zero output stalls out instead of burning the timeout', () => {
  // The observed failure: stop button visible, 0 characters, for two full hours. `busy` resets the
  // idle clock forever, so only the per-turn timeout ended the turn.
  const stalled = {
    text: '',
    started: false,
    busy: true,
    stable: false,
    idleForMs: 0,
    terminalVisible: false,
    terminalForMs: 0,
    hasError: false,
    semanticState: 'unknown',
    elapsedMs: RESPONSE_COMPLETION_DEFAULTS.noOutputMs
  };
  const result = responseCompletionDecision(stalled);
  assert.equal(result.done, false, 'a stall is not a completion');
  assert.equal(result.stalled, true);
  assert.equal(result.reason, 'no_output_stall');
});

test('response completion: zero output before the stall deadline keeps waiting', () => {
  const result = responseCompletionDecision({
    text: '',
    started: false,
    busy: true,
    stable: false,
    idleForMs: 0,
    terminalVisible: false,
    terminalForMs: 0,
    semanticState: 'unknown',
    elapsedMs: RESPONSE_COMPLETION_DEFAULTS.noOutputMs - 1000
  });
  assert.equal(result.done, false);
  assert.ok(!result.stalled, 'a slow-but-live turn is never declared stalled early');
});

test('response completion: a long turn that produced text is never declared stalled', () => {
  // Legitimate heavy turns in this workflow think and run tools for many minutes; the watchdog
  // must only fire when there is literally nothing.
  const result = responseCompletionDecision({
    text: 'Analyzing the scan…',
    started: true,
    busy: true,
    stable: false,
    idleForMs: 0,
    terminalVisible: false,
    terminalForMs: 0,
    semanticState: 'incomplete',
    elapsedMs: RESPONSE_COMPLETION_DEFAULTS.noOutputMs * 3
  });
  assert.equal(result.done, false);
  assert.ok(!result.stalled);
});

test('response completion: busy UI always wins over semantic completeness', () => {
  const result = responseCompletionDecision({
    text: '{"stage_status":"passed"}',
    started: true,
    busy: true,
    stable: true,
    idleForMs: 20_000,
    terminalVisible: true,
    terminalForMs: 20_000,
    semanticState: 'complete'
  });
  assert.equal(result.done, false);
});
