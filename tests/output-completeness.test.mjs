import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EXPECTED_PERSISTENT_OUTPUTS,
  verifyOutputCompleteness
} from '../observability/output-completeness.mjs';

async function makeTempDir() {
  return fs.mkdtemp(
    path.join(os.tmpdir(), 'output-completeness-')
  );
}

test('complete expected outputs pass verification', async () => {
  const dir = await makeTempDir();
  const files = [];

  for (const name of EXPECTED_PERSISTENT_OUTPUTS) {
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, `content for ${name}`);
    files.push({ path: filePath });
  }

  const result = await verifyOutputCompleteness({ files });

  assert.equal(result.complete, true);
  assert.deepEqual(result.missingFileNames, []);
  assert.deepEqual(result.emptyFileNames, []);
  assert.deepEqual(result.unreadableFileNames, []);
  assert.deepEqual(result.duplicateFileNames, []);
  assert.equal(result.verifiedFileCount, 3);
  assert.ok(result.totalBytes > 0);
});

test('missing expected output is reported', async () => {
  const dir = await makeTempDir();
  const generatorPath = path.join(dir, 'generator.py');
  await fs.writeFile(generatorPath, 'print("ok")');

  const result = await verifyOutputCompleteness({
    files: [{ path: generatorPath }]
  });

  assert.equal(result.complete, false);
  assert.deepEqual(result.missingFileNames, [
    'generator_report.json',
    'manifest.json'
  ]);
});

test('empty output is reported', async () => {
  const dir = await makeTempDir();
  const files = [];

  for (const name of EXPECTED_PERSISTENT_OUTPUTS) {
    const filePath = path.join(dir, name);
    await fs.writeFile(
      filePath,
      name === 'manifest.json' ? '' : 'content'
    );
    files.push({ path: filePath });
  }

  const result = await verifyOutputCompleteness({ files });

  assert.equal(result.complete, false);
  assert.deepEqual(result.emptyFileNames, ['manifest.json']);
});

test('unreadable or missing captured path is reported', async () => {
  const dir = await makeTempDir();
  const files = EXPECTED_PERSISTENT_OUTPUTS.map((name) => ({
    path: path.join(dir, name)
  }));

  const result = await verifyOutputCompleteness({ files });

  assert.equal(result.complete, false);
  assert.deepEqual(
    result.unreadableFileNames,
    [...EXPECTED_PERSISTENT_OUTPUTS].sort()
  );
});

test('duplicate expected names are reported', async () => {
  const dir = await makeTempDir();
  const first = path.join(dir, 'generator.py');
  const secondDir = path.join(dir, 'duplicate');
  await fs.mkdir(secondDir);
  const second = path.join(secondDir, 'generator.py');

  await fs.writeFile(first, 'one');
  await fs.writeFile(second, 'two');

  const result = await verifyOutputCompleteness({
    files: [
      { path: first },
      { path: second }
    ],
    expectedFileNames: ['generator.py']
  });

  assert.equal(result.complete, false);
  assert.deepEqual(result.duplicateFileNames, ['generator.py']);
});

test('extra outputs are recorded but do not make expected outputs incomplete', async () => {
  const dir = await makeTempDir();
  const files = [];

  for (const name of EXPECTED_PERSISTENT_OUTPUTS) {
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, 'content');
    files.push({ path: filePath });
  }

  const extraPath = path.join(dir, 'notes.txt');
  await fs.writeFile(extraPath, 'extra');
  files.push({ path: extraPath });

  const result = await verifyOutputCompleteness({ files });

  assert.equal(result.complete, true);
  assert.deepEqual(result.extraFileNames, ['notes.txt']);
});