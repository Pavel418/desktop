import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBrowserBackend, resolveBrowserBackend, resolveChromeProfileMode } from '../browser-backend.mjs';

test('browser-backend: Chrome CDP is default', () => {
  assert.equal(normalizeBrowserBackend(''), 'chrome-cdp');
  assert.equal(normalizeBrowserBackend('chrome'), 'chrome-cdp');
  assert.equal(normalizeBrowserBackend('electron'), 'electron');
  assert.equal(resolveBrowserBackend({ argv: [], env: {}, settings: {} }), 'chrome-cdp');
});

test('browser-backend: settings and args resolve backend/profile mode', () => {
  assert.equal(resolveBrowserBackend({ argv: [], env: {}, settings: { browserBackend: 'electron' } }), 'electron');
  assert.equal(resolveBrowserBackend({ argv: ['node', 'main', '--browser-backend', 'chrome'], env: {}, settings: { browserBackend: 'electron' } }), 'chrome-cdp');
  assert.equal(resolveChromeProfileMode({ argv: [], env: {}, settings: {} }), 'agentify');
  assert.equal(resolveChromeProfileMode({ argv: [], env: {}, settings: { chromeProfileMode: 'agentify' } }), 'agentify');
  assert.equal(resolveChromeProfileMode({ argv: [], env: {}, settings: { chromeProfileMode: 'persistent' } }), 'agentify');
  assert.equal(resolveChromeProfileMode({ argv: [], env: {}, settings: { chromeProfileMode: 'existing' } }), 'existing');
  assert.equal(resolveChromeProfileMode({ argv: [], env: {}, settings: { chromeProfileMode: 'attach' } }), 'attach');
  assert.equal(resolveChromeProfileMode({ argv: [], env: {}, settings: { chromeProfileMode: 'isolated' } }), 'isolated');
  assert.equal(resolveChromeProfileMode({ argv: ['node', 'main', '--chrome-profile-mode', 'attach'], env: {}, settings: {} }), 'attach');
  assert.equal(resolveChromeProfileMode({ argv: [], env: {}, settings: { chromeProfileMode: 'weird' } }), 'agentify');
});
