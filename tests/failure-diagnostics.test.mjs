import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  captureFailureDiagnostics
} from '../observability/failure-diagnostics.mjs';

async function makeTempDir() {
  return fs.mkdtemp(
    path.join(os.tmpdir(), 'failure-diagnostics-')
  );
}

test('captures screenshot, HTML, and metadata', async () => {
  const diagnosticsRoot = await makeTempDir();

  const page = {
    async screenshot({ path: screenshotPath }) {
      await fs.writeFile(screenshotPath, 'png-data');
    },
    async content() {
      return '<html><body>failure</body></html>';
    }
  };

  const result = await captureFailureDiagnostics({
    diagnosticsRoot,
    entryName: 'cmr',
    pdfStem: 'file_1978',
    attemptNumber: 2,
    reason: 'send_failed',
    pages: [
      {
        name: 'workflow',
        page
      }
    ]
  });

  assert.equal(result.captured, true);
  assert.equal(result.pageCount, 1);
  assert.equal(result.errors.length, 0);
  assert.match(
    result.diagnosticsDir,
    /entries[/\\]cmr[/\\]file_1978[/\\]attempt-2[/\\]send_failed$/
  );

  const names = result.files
    .map((filePath) => path.basename(filePath))
    .sort();

  assert.deepEqual(names, [
    'diagnostics.json',
    'workflow.html',
    'workflow.png'
  ]);
});

test('captures HTML when screenshot fails', async () => {
  const diagnosticsRoot = await makeTempDir();

  const page = {
    async screenshot() {
      throw new Error('screenshot failed');
    },
    async content() {
      return '<html>still available</html>';
    }
  };

  const result = await captureFailureDiagnostics({
    diagnosticsRoot,
    entryName: 'entry',
    pdfStem: 'pdf',
    attemptNumber: 1,
    reason: 'browser_failure',
    pages: [
      {
        name: 'workflow',
        page
      }
    ]
  });

  assert.equal(result.captured, true);
  assert.ok(
    result.files.some(
      (filePath) => filePath.endsWith('workflow.html')
    )
  );
  assert.ok(
    result.errors.some(
      (item) => item.artifactType === 'screenshot'
    )
  );
});

test('returns unavailable when no page exists', async () => {
  const diagnosticsRoot = await makeTempDir();

  const result = await captureFailureDiagnostics({
    diagnosticsRoot,
    entryName: 'entry',
    pdfStem: 'pdf',
    attemptNumber: 1,
    reason: 'failure',
    pages: []
  });

  assert.equal(result.captured, false);
  assert.equal(result.diagnosticsDir, null);
  assert.deepEqual(result.files, []);
});

test('deduplicates the same page object', async () => {
  const diagnosticsRoot = await makeTempDir();
  let screenshotCalls = 0;

  const page = {
    async screenshot({ path: screenshotPath }) {
      screenshotCalls += 1;
      await fs.writeFile(screenshotPath, 'png');
    },
    async content() {
      return '<html></html>';
    }
  };

  const result = await captureFailureDiagnostics({
    diagnosticsRoot,
    entryName: 'entry',
    pdfStem: 'pdf',
    attemptNumber: 1,
    pages: [
      { name: 'workflow', page },
      { name: 'duplicate', page }
    ]
  });

  assert.equal(result.pageCount, 1);
  assert.equal(screenshotCalls, 1);
});