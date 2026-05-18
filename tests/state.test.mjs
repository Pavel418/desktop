import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { defaultSettings, ensureToken, normalizeSettings, readToken, writeToken } from '../state.mjs';

async function tempDir() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-desktop-test-'));
  return base;
}

test('state: ensureToken creates and is readable', async () => {
  const dir = await tempDir();
  const token = await ensureToken(dir);
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 20);
  const token2 = await readToken(dir);
  assert.equal(token2, token);
});

test('state: writeToken overrides existing', async () => {
  const dir = await tempDir();
  await writeToken('abc123', dir);
  assert.equal(await readToken(dir), 'abc123');
  await writeToken('def456', dir);
  assert.equal(await readToken(dir), 'def456');
});

test('state: defaults to Chrome CDP backend', async () => {
  const settings = defaultSettings();
  assert.equal(settings.browserBackend, 'chrome-cdp');
  assert.equal(settings.chromeProfileMode, 'agentify');
  assert.equal(settings.allowAuthPopups, true);

  const normalized = normalizeSettings({ browserBackend: 'electron', chromeDebugPort: 9333, chromeProfileMode: 'attach' });
  assert.equal(normalized.browserBackend, 'electron');
  assert.equal(normalized.chromeDebugPort, 9333);
  assert.equal(normalized.chromeProfileMode, 'attach');
  assert.equal(normalizeSettings({ chromeProfileMode: 'persistent' }).chromeProfileMode, 'persistent');
});
