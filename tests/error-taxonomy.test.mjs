import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ERROR_CATEGORIES,
  RETRY_SCOPES,
  classifyError,
  isRetryableInfraError,
  normalizeErrorCode
} from '../observability/error-taxonomy.mjs';

test('known provider errors are infrastructure-retryable', () => {
  const result = classifyError(new Error('attachment_upload_rejected'));

  assert.equal(result.category, ERROR_CATEGORIES.INFRASTRUCTURE);
  assert.equal(result.code, 'attachment_upload_rejected');
  assert.equal(result.retryable, true);
  assert.equal(result.retryScope, RETRY_SCOPES.INFRASTRUCTURE);
  assert.equal(isRetryableInfraError(new Error('attachment_upload_rejected')), true);
});

test('explicit retryable errors preserve existing infrastructure behavior', () => {
  const err = new Error('provider_changed_message');
  err.retryable = true;

  const result = classifyError(err);

  assert.equal(result.category, ERROR_CATEGORIES.INFRASTRUCTURE);
  assert.equal(result.retryable, true);
  assert.equal(result.retryScope, RETRY_SCOPES.INFRASTRUCTURE);
  assert.equal(isRetryableInfraError(err), true);
});

test('configuration errors are fixed and non-retryable', () => {
  const result = classifyError(
    new Error('config_not_found: /tmp/batch.config.json')
  );

  assert.equal(result.category, ERROR_CATEGORIES.CONFIGURATION);
  assert.equal(result.code, 'config_not_found');
  assert.equal(result.retryable, false);
  assert.equal(result.retryScope, RETRY_SCOPES.NONE);
});

test('workflow status errors use the workflow retry scope', () => {
  const result = classifyError(
    new Error('status_7@template_qa')
  );

  assert.equal(result.category, ERROR_CATEGORIES.WORKFLOW);
  assert.equal(result.code, 'status_7@template_qa');
  assert.equal(result.retryable, true);
  assert.equal(result.retryScope, RETRY_SCOPES.WORKFLOW);
});

test('unknown errors are not automatically retried', () => {
  const result = classifyError(new Error('unexpected_browser_state'));

  assert.equal(result.category, ERROR_CATEGORIES.UNKNOWN);
  assert.equal(result.code, 'unexpected_browser_state');
  assert.equal(result.retryable, false);
  assert.equal(result.retryScope, RETRY_SCOPES.NONE);
  assert.equal(isRetryableInfraError(new Error('unexpected_browser_state')), false);
});

test('normalizeErrorCode handles empty values', () => {
  assert.equal(normalizeErrorCode(null), 'unknown_error');
  assert.equal(normalizeErrorCode(new Error('')), 'unknown_error');
});