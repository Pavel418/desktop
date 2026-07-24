import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  ChromeCdpBrowserBackend,
  ChromeCdpConnection,
  ChromeCdpPageAdapter,
  chromeSpawnOptions,
  isPrunableCookieName
} from '../chrome-cdp-backend.mjs';

// A minimal CDP client fake: records sends, supports on()/emit, and (optionally) emits a
// top-document Network.responseReceived with `docStatus` in response to Page.navigate.
function fakeNavClient({ docStatus = 200, sessionId = 'session', cookies = null } = {}) {
  const handlers = new Map();
  const calls = [];
  const statuses = Array.isArray(docStatus) ? [...docStatus] : [docStatus];
  let navigationIndex = 0;
  const client = {
    on(method, handler) {
      const list = handlers.get(method) || [];
      list.push(handler);
      handlers.set(method, list);
      return () => handlers.set(method, (handlers.get(method) || []).filter((h) => h !== handler));
    },
    async send(method, params, sid) {
      calls.push({ method, params, sessionId: sid });
      if (method === 'Page.navigate') {
        const status = statuses[Math.min(navigationIndex, statuses.length - 1)];
        navigationIndex += 1;
        for (const h of [...(handlers.get('Network.responseReceived') || [])]) {
          h({ type: 'Document', response: { status } }, sessionId);
        }
      }
      if (method === 'Network.getCookies') return { cookies: cookies || [] };
      return {};
    }
  };
  return { client, calls };
}

test('navigate: a 431 response prunes disposable state, retries, and returns the observed 200', async () => {
  const cookies = [
    { name: 'conv_key_6a5e6840-f4b8-83eb-8993-336f2387c543', domain: 'chatgpt.com', path: '/' },
    { name: 'history_off_6a5e6840-f4b8-83eb-8993-336f2387c543', domain: 'chatgpt.com', path: '/' },
    { name: '_dd_s', domain: '.chatgpt.com', path: '/' },
    { name: '__Secure-next-auth.session-token', domain: '.chatgpt.com', path: '/' }
  ];
  const { client, calls } = fakeNavClient({ docStatus: [431, 200], cookies });
  const page = new ChromeCdpPageAdapter({ client, targetId: 't', sessionId: 'session' });
  const status = await page.navigate('https://chatgpt.com/?temporary-chat=true', {
    pruneConversationStateOn431: true
  });
  assert.equal(status, 200);
  assert.equal(calls.filter((c) => c.method === 'Page.navigate').length, 2);
  assert.equal(calls.filter((c) => c.method === 'Page.reload').length, 0);
  const deleted = calls.filter((c) => c.method === 'Network.deleteCookies').map((c) => c.params.name);
  assert.deepEqual(deleted.sort(), ['_dd_s', 'conv_key_6a5e6840-f4b8-83eb-8993-336f2387c543', 'history_off_6a5e6840-f4b8-83eb-8993-336f2387c543'].sort());
});

test('navigate: a persistent 431 is surfaced after one measured retry', async () => {
  const { client, calls } = fakeNavClient({ docStatus: [431, 431] });
  const page = new ChromeCdpPageAdapter({ client, targetId: 't', sessionId: 'session' });
  await assert.rejects(
    async () => await page.navigate('https://chatgpt.com/?temporary-chat=true'),
    /chatgpt_navigation_http_431/
  );
  assert.equal(calls.filter((c) => c.method === 'Page.navigate').length, 2);
});

test('navigate: a 200 response does not retry', async () => {
  const { client, calls } = fakeNavClient({ docStatus: 200 });
  const page = new ChromeCdpPageAdapter({ client, targetId: 't', sessionId: 'session' });
  const status = await page.navigate('https://chatgpt.com/');
  assert.equal(status, 200);
  assert.equal(calls.filter((c) => c.method === 'Page.navigate').length, 1);
});

test('pruneTelemetryCookies deletes telemetry but keeps auth/clearance cookies', async () => {
  const cookies = [
    { name: '_dd_s', domain: '.chatgpt.com', path: '/' },
    { name: '__cf_bm', domain: '.chatgpt.com', path: '/' },
    { name: 'statsig.session_id', domain: '.chatgpt.com', path: '/' },
    { name: '__Secure-next-auth.session-token.0', domain: '.chatgpt.com', path: '/' },
    { name: 'cf_clearance', domain: '.chatgpt.com', path: '/' },
    { name: '__Host-next-auth.csrf-token', domain: 'chatgpt.com', path: '/' }
  ];
  const { client, calls } = fakeNavClient({ cookies });
  const page = new ChromeCdpPageAdapter({ client, targetId: 't', sessionId: 'session' });
  const removed = await page.pruneTelemetryCookies();
  assert.equal(removed, 3);
  const deleted = calls.filter((c) => c.method === 'Network.deleteCookies').map((c) => c.params.name);
  assert.deepEqual(deleted.sort(), ['__cf_bm', '_dd_s', 'statsig.session_id'].sort());
});

test('isPrunableCookieName: telemetry yes, auth/clearance never', () => {
  for (const n of ['_dd_s', '__cf_bm', 'statsig.stable_id', 'amp_abc', 'intercom-session-x', '_ga']) {
    assert.equal(isPrunableCookieName(n), true, `${n} should be prunable`);
  }
  for (const n of ['__Secure-next-auth.session-token.0', 'cf_clearance', '__Host-next-auth.csrf-token', 'oai-did', 'sessionKey']) {
    assert.equal(isPrunableCookieName(n), false, `${n} must be kept`);
  }
  for (const n of ['conv_key_6a5e6840-f4b8-83eb-8993-336f2387c543', 'history_off_6a5e6840-f4b8-83eb-8993-336f2387c543']) {
    assert.equal(isPrunableCookieName(n), false, `${n} must be retained while another managed chat may be active`);
    assert.equal(isPrunableCookieName(n, { includeConversationState: true }), true, `${n} should be pruned with no active managed chat`);
  }
});

class MockWebSocket {
  constructor() {
    this.listeners = new Map();
    queueMicrotask(() => this.#emit('open', {}));
  }

  addEventListener(type, handler, opts = {}) {
    const list = this.listeners.get(type) || [];
    list.push({ handler, once: !!opts?.once });
    this.listeners.set(type, list);
  }

  send(_payload) {}

  close() {
    queueMicrotask(() => this.#emit('close', {}));
  }

  #emit(type, event) {
    const list = [...(this.listeners.get(type) || [])];
    for (const item of list) {
      try {
        item.handler(event);
      } catch {}
    }
    const keep = (this.listeners.get(type) || []).filter((item) => !item.once);
    if (keep.length) this.listeners.set(type, keep);
    else this.listeners.delete(type);
  }
}

class DelayedMockWebSocket {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, handler, opts = {}) {
    const list = this.listeners.get(type) || [];
    list.push({ handler, once: !!opts?.once });
    this.listeners.set(type, list);
  }

  send(_payload) {}

  close() {
    queueMicrotask(() => this.#emit('close', {}));
  }

  open() {
    queueMicrotask(() => this.#emit('open', {}));
  }

  #emit(type, event) {
    const list = [...(this.listeners.get(type) || [])];
    for (const item of list) {
      try {
        item.handler(event);
      } catch {}
    }
    const keep = (this.listeners.get(type) || []).filter((item) => !item.once);
    if (keep.length) this.listeners.set(type, keep);
    else this.listeners.delete(type);
  }
}

test('chrome-cdp-backend: pending commands reject when websocket closes', async () => {
  const ws = new MockWebSocket();
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => ws
  });

  await conn.connect();
  const pending = conn.send('Runtime.evaluate', { expression: '1+1' });
  ws.close();

  await assert.rejects(async () => await pending, /chrome_cdp_disconnected/);
});

test('chrome-cdp-backend: Chrome spawn does not use shell on any platform', () => {
  const opts = chromeSpawnOptions();
  assert.equal(opts.stdio, 'ignore');
  assert.equal(Object.hasOwn(opts, 'shell'), false);
});

test('chrome-cdp-backend: file upload targets the active composer input before stale global matches', async () => {
  const calls = [];
  const client = {
    async send(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'Runtime.evaluate') return { result: { objectId: 'active-input-object' } };
      if (method === 'DOM.requestNode') return { nodeId: 42 };
      if (method === 'Runtime.releaseObject') return {};
      if (method === 'DOM.querySelectorAll') return { nodeIds: [11, 42, 13] };
      if (method === 'DOM.setFileInputFiles') return {};
      throw new Error(`unexpected:${method}`);
    }
  };
  const page = new ChromeCdpPageAdapter({ client, targetId: 'target', sessionId: 'session' });
  const result = await page.setFileInputFiles(['C:\\input\\target.pdf']);
  const setCall = calls.find((call) => call.method === 'DOM.setFileInputFiles');
  assert.equal(setCall.params.nodeId, 42);
  assert.deepEqual(setCall.params.files, ['C:\\input\\target.pdf']);
  assert.equal(result.strategy, 'active-composer');
  assert.equal(result.nodeId, 42);
});

test('chrome-cdp-backend: connect rejects if websocket closes before open', async () => {
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => ({
      addEventListener(type, handler) {
        if (type === 'close') queueMicrotask(() => handler({}));
      },
      close() {}
    })
  });

  await assert.rejects(async () => await conn.connect(), /chrome_cdp_disconnected/);
});

test('chrome-cdp-backend: async connect error clears stale websocket before retry', async () => {
  let calls = 0;
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => {
      calls += 1;
      if (calls === 1) {
        return {
          addEventListener(type, handler) {
            if (type === 'error') queueMicrotask(() => handler(new Error('ws_async_failed')));
          },
          close() {}
        };
      }
      return new MockWebSocket();
    }
  });

  await assert.rejects(async () => await conn.connect(), /ws_async_failed/);
  assert.equal(conn.ws, null);
  await conn.connect();
  assert.equal(calls, 2);
});

test('chrome-cdp-backend: concurrent connect calls share one websocket', async () => {
  let created = 0;
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => {
      created += 1;
      return new MockWebSocket();
    }
  });

  await Promise.all([conn.connect(), conn.connect(), conn.connect()]);
  assert.equal(created, 1);
});

test('chrome-cdp-backend: synchronous websocket constructor failure does not poison future retries', async () => {
  let calls = 0;
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => {
      calls += 1;
      if (calls === 1) throw new Error('ws_ctor_failed');
      return new MockWebSocket();
    }
  });

  await (async () => {
    try {
      await conn.connect();
      assert.fail('expected first connect to fail');
    } catch (error) {
      assert.match(String(error?.message || error), /ws_ctor_failed/);
    }
  })();
  await conn.connect();
  assert.equal(calls, 2);
});

test('chrome-cdp-backend: close cancels an in-flight connect before open', async () => {
  const ws = new DelayedMockWebSocket();
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => ws
  });

  const pending = conn.connect();
  await conn.close();
  await assert.rejects(async () => await pending, /chrome_cdp_disconnected/);
});

test('chrome-cdp-backend: late open after cancel does not resurrect connection state', async () => {
  const ws = new DelayedMockWebSocket();
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => ws
  });

  const pending = conn.connect();
  await conn.close();
  ws.open();
  await assert.rejects(async () => await pending, /chrome_cdp_disconnected/);
  assert.equal(conn.connected, false);
  assert.equal(conn.ws, null);
});

test('chrome-cdp-backend: stale socket close does not tear down a newer healthy connection', async () => {
  const first = new DelayedMockWebSocket();
  let second = null;
  let calls = 0;
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => {
      calls += 1;
      if (calls === 1) return first;
      second = new MockWebSocket();
      return second;
    }
  });

  const pendingFirst = conn.connect();
  await conn.close();
  await assert.rejects(async () => await pendingFirst, /chrome_cdp_disconnected/);

  await conn.connect();
  assert.equal(conn.connected, true);
  assert.equal(conn.ws, second);

  first.close();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(conn.connected, true);
  assert.equal(conn.ws, second);
});

test('chrome-cdp-backend: createSession closes target if initialization fails', async () => {
  const calls = [];
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: true,
    ws: {},
    send: async (method, params = {}, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') return { targetId: 'target-1' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (method === 'Page.enable') throw new Error('page_enable_failed');
      if (method === 'Target.closeTarget') return { success: true };
      return {};
    }
  };

  await assert.rejects(
    async () => await backend.createSession({ url: 'https://chatgpt.com/' }),
    /page_enable_failed/
  );

  assert.equal(calls.some((item) => item.method === 'Target.closeTarget' && item.params?.targetId === 'target-1'), true);
});

test('chrome-cdp-backend: createSession propagates persistent 431 and closes the failed target', async () => {
  const calls = [];
  const handlers = new Map();
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: true,
    ws: {},
    on(method, handler) {
      const list = handlers.get(method) || [];
      list.push(handler);
      handlers.set(method, list);
      return () => handlers.set(method, (handlers.get(method) || []).filter((item) => item !== handler));
    },
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') return { targetId: 'target-431' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-431' };
      if (method === 'Browser.getWindowForTarget') return { windowId: 8 };
      if (method === 'Network.getCookies') return { cookies: [] };
      if (method === 'Page.navigate') {
        for (const handler of [...(handlers.get('Network.responseReceived') || [])]) {
          handler({ type: 'Document', response: { status: 431 } }, 'session-431');
        }
      }
      return {};
    }
  };

  await assert.rejects(
    async () => await backend.createSession({ url: 'https://chatgpt.com/?temporary-chat=true' }),
    /chatgpt_navigation_http_431/
  );
  assert.equal(calls.filter((item) => item.method === 'Page.navigate').length, 2);
  assert.equal(calls.some((item) => item.method === 'Target.closeTarget' && item.params?.targetId === 'target-431'), true);
});

test('chrome-cdp-backend: session close is best-effort when closeTarget fails', async () => {
  let closedCalls = 0;
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: true,
    ws: {},
    send: async (method, params = {}, sessionId) => {
      void params;
      void sessionId;
      if (method === 'Target.createTarget') return { targetId: 'target-1' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (method === 'Target.closeTarget') throw new Error('chrome_cdp_disconnected');
      return {};
    }
  };

  const session = await backend.createSession({
    url: 'about:blank',
    onClosed: () => {
      closedCalls += 1;
    }
  });

  await session.close();
  assert.equal(session.isClosed(), true);
  assert.equal(closedCalls, 1);
});

test('chrome-cdp-backend: start cleans up spawned chrome process when CDP connect fails', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-chrome-start-fail-'));
  let executablePath = process.execPath;
  if (process.platform !== 'win32') {
    executablePath = path.join(tmpDir, 'fake-chrome.sh');
    await fs.writeFile(executablePath, '#!/bin/sh\nsleep 30\n', { encoding: 'utf8', mode: 0o755 });
  }

  const backend = new ChromeCdpBrowserBackend({
    stateDir: tmpDir,
    executablePath,
    debugPort: 45999
  });

  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) throw new Error('port_not_in_use');
    return {
      ok: true,
      async json() {
        return { webSocketDebuggerUrl: 'ws://127.0.0.1:45999/devtools/browser/test' };
      }
    };
  };
  globalThis.WebSocket = class {
    constructor() {
      queueMicrotask(() => {
        this._error?.(new Error('ws_connect_failed'));
      });
    }
    addEventListener(type, handler) {
      if (type === 'error') this._error = handler;
    }
    close() {}
  };

  try {
    await assert.rejects(async () => await backend.start(), /ws_connect_failed/);
    assert.equal(backend.client, null);
    assert.equal(backend.started, false);
    assert.equal(backend.chromeProcess, null);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
  }
});

test('chrome-cdp-backend: dispose resets started state and clears stale tab closers', async () => {
  let clientClosed = 0;
  let processKilled = 0;
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    close: async () => {
      clientClosed += 1;
    }
  };
  backend.chromeProcess = {
    killed: false,
    kill: () => {
      processKilled += 1;
    }
  };
  backend.tabClosers.set('tab-1', () => {});
  backend.boundTargetDestroyed = () => {};

  await backend.dispose();

  assert.equal(clientClosed, 1);
  assert.equal(processKilled, 1);
  assert.equal(backend.started, false);
  assert.equal(backend.tabClosers.size, 0);
  assert.equal(backend.client, null);
  assert.equal(backend.chromeProcess, null);
  assert.equal(backend.boundTargetDestroyed, null);
});

test('chrome-cdp-backend: start does not reuse a disconnected client as healthy state', async () => {
  let connectCalls = 0;
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: false,
    ws: null,
    close: async () => {}
  };
  backend.chromeProcess = {
    killed: false,
    kill: () => {}
  };
  backend.boundTargetDestroyed = () => {};

  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) throw new Error('port_not_in_use');
    return {
      ok: true,
      async json() {
        return { webSocketDebuggerUrl: 'ws://127.0.0.1:45998/devtools/browser/test' };
      }
    };
  };
  globalThis.WebSocket = class {
    constructor() {}
    addEventListener(type, handler) {
      if (type === 'open') {
        connectCalls += 1;
        queueMicrotask(() => handler({}));
      }
    }
    close() {}
  };

  try {
    await backend.start();
    assert.equal(connectCalls, 1);
    assert.equal(backend.started, true);
    assert.equal(backend.client?.connected, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
    await backend.dispose();
  }
});

// A CDP client fake that lets a test drive Network.* lifecycle events into the page's
// upload watcher and observe what it filters and tracks.
function fakeEventClient() {
  const handlers = new Map();
  const on = (method, handler) => {
    const list = handlers.get(method) || [];
    list.push(handler);
    handlers.set(method, list);
    return () => handlers.set(method, (handlers.get(method) || []).filter((h) => h !== handler));
  };
  const emit = (method, params, sessionId = 'session') => {
    for (const h of [...(handlers.get(method) || [])]) h(params, sessionId);
  };
  const handlerCount = () => [...handlers.values()].reduce((n, list) => n + list.length, 0);
  return { client: { on, async send() { return {}; } }, emit, handlerCount };
}

test('watchUploads: tracks upload requests, ignores unrelated traffic, and strips query tokens', () => {
  const { client, emit } = fakeEventClient();
  const page = new ChromeCdpPageAdapter({ client, targetId: 't', sessionId: 'session' });
  const events = [];
  const watch = page.watchUploads({ onEvent: (e) => events.push(e) });

  // An attachment create (POST /backend-api/files) and its backing blob PUT are uploads.
  emit('Network.requestWillBeSent', { requestId: 'up1', request: { url: 'https://chatgpt.com/backend-api/files', method: 'POST' } });
  emit('Network.requestWillBeSent', { requestId: 'up2', request: { url: 'https://files.oaiusercontent.com/file-abc?sig=SECRET-TOKEN', method: 'PUT' } });
  // A plain conversation GET and a GET to /files are NOT uploads (write-methods only).
  emit('Network.requestWillBeSent', { requestId: 'x1', request: { url: 'https://chatgpt.com/backend-api/conversation/1', method: 'GET' } });
  emit('Network.requestWillBeSent', { requestId: 'x2', request: { url: 'https://chatgpt.com/files/list', method: 'GET' } });

  let snap = watch.snapshot();
  assert.equal(snap.total, 2, 'only the two write uploads are tracked');
  assert.equal(snap.inflight, 2);
  // The signed-URL token must never be retained in the tracked/logged URL.
  const blob = snap.requests.find((r) => r.method === 'PUT');
  assert.equal(blob.url, 'https://files.oaiusercontent.com/file-abc');
  assert.ok(!blob.url.includes('SECRET-TOKEN'));

  // Finish one upload, fail the other.
  emit('Network.responseReceived', { requestId: 'up1', response: { status: 200 } });
  emit('Network.loadingFinished', { requestId: 'up1', encodedDataLength: 1234 });
  emit('Network.loadingFailed', { requestId: 'up2', errorText: 'net::ERR_CONNECTION_RESET' });

  snap = watch.snapshot();
  assert.equal(snap.inflight, 0);
  assert.equal(snap.finished, 1);
  assert.equal(snap.failed, 1);
  assert.equal(snap.requests.find((r) => r.method === 'POST').bytes, 1234);
  assert.equal(snap.requests.find((r) => r.method === 'PUT').error, 'net::ERR_CONNECTION_RESET');
  assert.ok(events.some((e) => e.phase === 'finished'));
  assert.ok(events.some((e) => e.phase === 'failed'));
});

test('watchUploads: ignores events from other sessions and stops after off()', () => {
  const { client, emit, handlerCount } = fakeEventClient();
  const page = new ChromeCdpPageAdapter({ client, targetId: 't', sessionId: 'session' });
  const watch = page.watchUploads();

  // An event from a different session must not be counted.
  emit('Network.requestWillBeSent', { requestId: 'other', request: { url: 'https://chatgpt.com/backend-api/files', method: 'POST' } }, 'other-session');
  assert.equal(watch.snapshot().total, 0);

  emit('Network.requestWillBeSent', { requestId: 'mine', request: { url: 'https://chatgpt.com/backend-api/files', method: 'POST' } }, 'session');
  assert.equal(watch.snapshot().total, 1);

  assert.ok(handlerCount() >= 4, 'four Network.* listeners are registered while watching');
  watch.off();
  assert.equal(handlerCount(), 0, 'off() unsubscribes every listener');

  // Emitting after off() has no effect on the frozen snapshot.
  emit('Network.loadingFinished', { requestId: 'mine', encodedDataLength: 10 });
  assert.equal(watch.snapshot().finished, 0);
});
