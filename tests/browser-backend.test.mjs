import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveChromeDebugPort,
  resolveChromeExecutablePath,
  resolveChromeProfileMode,
  resolveChromeProfileName
} from '../browser-backend.mjs';
import { buildChromeLaunchArgs, defaultChromeUserDataDir } from '../chrome-cdp-backend.mjs';

test('browser-backend: argv overrides env and settings for chrome binary', () => {
  const value = resolveChromeExecutablePath({
    argv: ['node', 'run-batch.mjs', '--chrome-binary', '/opt/chrome'],
    env: { AGENTIFY_DESKTOP_CHROME_BIN: '/tmp/chrome' },
    settings: { chromeExecutablePath: '/settings/chrome' }
  });
  assert.equal(value, '/opt/chrome');
});

test('browser-backend: resolves chrome debug port and binary path', () => {
  assert.equal(
    resolveChromeDebugPort({
      argv: ['node', 'run-batch.mjs'],
      env: { AGENTIFY_DESKTOP_CHROME_DEBUG_PORT: '9333' },
      settings: { chromeDebugPort: 9444 }
    }),
    9333
  );
  assert.equal(
    resolveChromeExecutablePath({
      argv: ['node', 'run-batch.mjs'],
      env: { AGENTIFY_DESKTOP_CHROME_BIN: '/tmp/chrome' },
      settings: {}
    }),
    '/tmp/chrome'
  );
  assert.equal(
    resolveChromeProfileMode({
      argv: ['node', 'run-batch.mjs'],
      env: { AGENTIFY_DESKTOP_CHROME_PROFILE_MODE: 'existing' },
      settings: {}
    }),
    'existing'
  );
  assert.equal(
    resolveChromeProfileName({
      argv: ['node', 'run-batch.mjs'],
      env: { AGENTIFY_DESKTOP_CHROME_PROFILE_NAME: 'Profile 3' },
      settings: {}
    }),
    'Profile 3'
  );
});

test('browser-backend: builds chrome launch args with managed profile', () => {
  const args = buildChromeLaunchArgs({
    debugPort: 9222,
    userDataDir: '/tmp/agentify-chrome',
    profileName: 'Default',
    startUrl: 'https://chatgpt.com/'
  });
  assert.ok(args.includes('--remote-debugging-port=9222'));
  assert.ok(args.includes('--user-data-dir=/tmp/agentify-chrome'));
  assert.ok(args.includes('--profile-directory=Default'));
  assert.ok(args.includes('https://chatgpt.com/'));
});

test('browser-backend: default chrome user data dir is non-empty', () => {
  const p = defaultChromeUserDataDir();
  assert.equal(typeof p, 'string');
  assert.ok(p.length > 0);
});
