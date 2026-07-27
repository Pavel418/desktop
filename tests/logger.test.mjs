import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRunLogger } from '../observability/logger.mjs';

test('logger writes valid JSON lines', async () => {
  const runDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'logger-test-')
  );

  const { logger, logPath, flush } = createRunLogger({
    runId: 'test-run',
    runDir
  });

  logger.info(
    {
      event: 'test_event'
    },
    'Logger works'
  );

  await flush();

  const lines = fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n');

  assert.equal(lines.length, 1);

  const record = JSON.parse(lines[0]);

  assert.equal(record.level, 'info');
  assert.equal(record.runId, 'test-run');
  assert.equal(record.event, 'test_event');
  assert.equal(record.msg, 'Logger works');
});

test('child loggers inherit correlation context', async () => {
  const runDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'logger-context-test-')
  );

  const { logger, logPath, flush } = createRunLogger({
    runId: 'run-123',
    runDir
  });

  const attemptLogger = logger
    .child({ entryName: 'cmr' })
    .child({ pdfStem: 'file_1978' })
    .child({ attemptNumber: 2 });

  attemptLogger.info(
    {
      event: 'attempt_started'
    },
    'Attempt started'
  );

  await flush();

  const record = JSON.parse(
    fs.readFileSync(logPath, 'utf8').trim()
  );

  assert.equal(record.runId, 'run-123');
  assert.equal(record.entryName, 'cmr');
  assert.equal(record.pdfStem, 'file_1978');
  assert.equal(record.attemptNumber, 2);
  assert.equal(record.event, 'attempt_started');
});

test('logger serializes errors', async () => {
  const runDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'logger-error-test-')
  );

  const { logger, logPath, flush } = createRunLogger({
    runId: 'error-run',
    runDir
  });

  logger.error(
    {
      event: 'attempt_failed',
      err: new Error('test failure')
    },
    'Attempt failed'
  );

  await flush();

  const record = JSON.parse(
    fs.readFileSync(logPath, 'utf8').trim()
  );

  assert.equal(record.level, 'error');
  assert.equal(record.event, 'attempt_failed');
  assert.equal(record.err.type, 'Error');
  assert.equal(record.err.message, 'test failure');
  assert.match(record.err.stack, /test failure/);
});