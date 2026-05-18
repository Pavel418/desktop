import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { markHandled, isHandled, writeJson, handledPath } from '../orchestrator/storage.mjs';

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-storage-'));
}

test('storage: stale started entry is treated as not handled', async () => {
  const dir = await tempDir();
  const key = 'k';
  const id = '11111111-1111-4111-8111-111111111111';
  await markHandled(dir, { key, id, status: 'started' });

  // Rewrite timestamp far in the past.
  const p = handledPath(dir);
  const data = JSON.parse(await fs.readFile(p, 'utf8'));
  data.keys[key][id].at = new Date(Date.now() - 10 * 60 * 60_000).toISOString();
  await writeJson(p, data);

  const handled = await isHandled(dir, { key, id });
  assert.equal(handled, false);
});
