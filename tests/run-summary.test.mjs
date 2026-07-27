import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildRunSummary,
  writeRunSummary
} from '../observability/run-summary.mjs';

test('buildRunSummary aggregates entries, PDFs, retries, and outputs', () => {
  const summary = buildRunSummary({
    runId: 'run-123',
    runStartedAt: '2026-07-27T10:00:00.000Z',
    runFinishedAt: '2026-07-27T10:01:00.000Z',
    durationMs: 60_000,
    exitCode: 1,
    configPath: '/tmp/config.json',
    runDir: '/tmp/run-123',
    structuredLogPath: '/tmp/run-123/run.jsonl',
    summaries: [
      {
        name: 'cmr',
        aborted: false,
        pdfs: [
          {
            pdf: 'one.pdf',
            group: '',
            files: [
              '/tmp/generator.py',
              '/tmp/manifest.json'
            ],
            error: null,
            status: 0,
            attempts: 2,
            infraRetries: 1,
            durationMs: 5000,
            gatesPassed: ['template'],
            outputCompleteness: {
              complete: true,
              expectedFileNames: [
                'generator.py',
                'manifest.json'
              ],
              observedFileNames: [
                'generator.py',
                'manifest.json'
              ],
              missingFileNames: [],
              emptyFileNames: [],
              unreadableFileNames: [],
              duplicateFileNames: [],
              extraFileNames: [],
              verifiedFileCount: 2,
              totalBytes: 100
            }
          },
          {
            pdf: 'two.pdf',
            group: '',
            files: [],
            error: 'send_failed',
            status: null,
            attempts: 1,
            infraRetries: 0,
            durationMs: 1000,
            gatesPassed: [],
            outputCompleteness: null
          }
        ]
      }
    ]
  });

  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.success, false);
  assert.equal(summary.counts.entries, 1);
  assert.equal(summary.counts.pdfs, 2);
  assert.equal(summary.counts.successfulPdfs, 1);
  assert.equal(summary.counts.failedPdfs, 1);
  assert.equal(summary.counts.attempts, 3);
  assert.equal(summary.counts.infrastructureRetries, 1);
  assert.equal(summary.counts.outputFiles, 2);
  assert.equal(summary.entries[0].pdfs[0].success, true);
  assert.equal(summary.entries[0].pdfs[1].success, false);
});

test('successful empty run summary uses exit code zero', () => {
  const summary = buildRunSummary({
    runId: 'run-empty',
    runStartedAt: '2026-07-27T10:00:00.000Z',
    runFinishedAt: '2026-07-27T10:00:01.000Z',
    durationMs: 1000,
    exitCode: 0,
    runDir: '/tmp/run-empty',
    summaries: []
  });

  assert.equal(summary.success, true);
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.counts.entries, 0);
});

test('fatal error is serialized into the summary', () => {
  const error = new Error('fatal test');
  error.code = 'fatal_code';

  const summary = buildRunSummary({
    runId: 'fatal-run',
    runStartedAt: '2026-07-27T10:00:00.000Z',
    runFinishedAt: '2026-07-27T10:00:02.000Z',
    durationMs: 2000,
    exitCode: 1,
    runDir: '/tmp/fatal-run',
    fatalError: error
  });

  assert.equal(summary.success, false);
  assert.equal(summary.fatalError.type, 'Error');
  assert.equal(summary.fatalError.message, 'fatal test');
  assert.equal(summary.fatalError.code, 'fatal_code');
});

test('writeRunSummary writes valid JSON atomically', async () => {
  const runDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'run-summary-')
  );

  const summary = buildRunSummary({
    runId: 'write-run',
    runStartedAt: '2026-07-27T10:00:00.000Z',
    runFinishedAt: '2026-07-27T10:00:03.000Z',
    durationMs: 3000,
    exitCode: 0,
    runDir,
    summaries: []
  });

  const summaryPath = await writeRunSummary({
    runDir,
    summary
  });

  const parsed = JSON.parse(
    await fs.readFile(summaryPath, 'utf8')
  );

  assert.equal(
    summaryPath,
    path.join(runDir, 'summary.json')
  );
  assert.equal(parsed.runId, 'write-run');
  assert.equal(parsed.success, true);

  await assert.rejects(
    fs.access(`${summaryPath}.tmp`)
  );
});