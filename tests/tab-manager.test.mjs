import test from 'node:test';
import assert from 'node:assert/strict';

import { TabManager } from '../tab-manager.mjs';

function fakeSession() {
  return {
    page: {},
    presenter: {
      isVisible: () => true
    },
    isClosed: () => false,
    close: async () => {}
  };
}

test('tab-manager: show focuses tab without requesting a new browser window by default', async () => {
  const calls = [];
  const tabs = new TabManager({
    browserBackend: {
      createSession: async (args) => {
        calls.push(args);
        return fakeSession();
      }
    },
    createController: async () => ({})
  });

  await tabs.createTab({ key: 'visible-chatgpt', show: true, url: 'https://chatgpt.com/' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].show, true);
  assert.equal(calls[0].newWindow, false);
});

test('tab-manager: new browser windows are explicit opt-in', async () => {
  const calls = [];
  const tabs = new TabManager({
    browserBackend: {
      createSession: async (args) => {
        calls.push(args);
        return fakeSession();
      }
    },
    createController: async () => ({})
  });

  await tabs.createTab({ key: 'parallel-chatgpt', show: true, newWindow: true, url: 'https://chatgpt.com/' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].show, true);
  assert.equal(calls[0].newWindow, true);
});

test('tab-manager: existing browser target reuse is explicit opt-in', async () => {
  const calls = [];
  const tabs = new TabManager({
    browserBackend: {
      createSession: async (args) => {
        calls.push(args);
        return fakeSession();
      }
    },
    createController: async () => ({})
  });

  await tabs.createTab({ key: 'default', show: true, reuseExisting: true, url: 'https://chatgpt.com/' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].reuseExisting, true);
});
