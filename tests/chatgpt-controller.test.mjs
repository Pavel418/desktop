import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ChatGPTController,
  attachmentAttemptComplete,
  attachmentsComplete,
  attachmentProgressKey,
  responseCompletionDecision
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
        return waitForSendChecks >= 2
          ? { stopVisible: false, sendDisabled: true, promptLen: 0 }
          : { stopVisible: false, sendDisabled: false, promptLen: 7 };
      }
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
