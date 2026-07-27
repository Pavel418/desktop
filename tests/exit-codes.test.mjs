import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXIT_CODES,
  determineRunExitCode,
  getSignalExitCode
} from '../observability/exit-codes.mjs';

test('successful run exits zero', () => {
  const exitCode = determineRunExitCode([
    {
      name: 'entry',
      aborted: false,
      fatal: null,
      pdfs: [
        {
          error: null,
          outputCompleteness: {
            complete: true
          }
        }
      ]
    }
  ]);

  assert.equal(exitCode, EXIT_CODES.SUCCESS);
});

test('PDF error exits non-zero', () => {
  const exitCode = determineRunExitCode([
    {
      name: 'entry',
      aborted: false,
      pdfs: [
        {
          error: 'send_failed'
        }
      ]
    }
  ]);

  assert.equal(exitCode, EXIT_CODES.RUN_FAILED);
});

test('aborted or fatal entry exits non-zero', () => {
  assert.equal(
    determineRunExitCode([
      {
        name: 'entry',
        aborted: true,
        pdfs: []
      }
    ]),
    EXIT_CODES.RUN_FAILED
  );

  assert.equal(
    determineRunExitCode([
      {
        name: 'entry',
        fatal: 'fatal error',
        pdfs: []
      }
    ]),
    EXIT_CODES.RUN_FAILED
  );
});

test('incomplete expected outputs exit non-zero', () => {
  const exitCode = determineRunExitCode([
    {
      name: 'entry',
      aborted: false,
      pdfs: [
        {
          error: null,
          outputCompleteness: {
            complete: false
          }
        }
      ]
    }
  ]);

  assert.equal(exitCode, EXIT_CODES.RUN_FAILED);
});

test('missing summaries are treated as failure', () => {
  assert.equal(
    determineRunExitCode(null),
    EXIT_CODES.RUN_FAILED
  );
});

test('signal exit codes follow 128 plus signal convention', () => {
  assert.equal(getSignalExitCode('SIGINT'), 130);
  assert.equal(getSignalExitCode('SIGTERM'), 143);
  assert.equal(getSignalExitCode('SIGBREAK'), 149);
  assert.equal(
    getSignalExitCode('UNKNOWN'),
    EXIT_CODES.INTERRUPTED
  );
});