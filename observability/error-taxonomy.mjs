const INFRASTRUCTURE_ERROR_CODES = Object.freeze([
  'chatgpt_server_error',
  'attachment_upload_rejected',
  'attachment_upload_incomplete',
  'attachment_not_registered',
  'send_not_triggered',
  'response_stalled_no_output',
  'timeout_waiting_for_response',
  'already_generating',
  'send_failed',
  'type_failed'
]);

const CONFIGURATION_ERROR_CODES = Object.freeze([
  'config_not_found',
  'config_invalid_json',
  'config_has_no_entries',
  'entry_missing_pdf_dir',
  'entry_missing_base_generator',
  'entry_missing_workflow_dir',
  'entry_pdf_dir_invalid',
  'no_entries_matched'
]);

const INTERRUPTED_ERROR_CODES = Object.freeze([
  'sigint',
  'sigterm',
  'sigbreak',
  'interrupted'
]);

const INFRASTRUCTURE_ERROR_SET = new Set(INFRASTRUCTURE_ERROR_CODES);
const CONFIGURATION_ERROR_SET = new Set(CONFIGURATION_ERROR_CODES);
const INTERRUPTED_ERROR_SET = new Set(INTERRUPTED_ERROR_CODES);

export const ERROR_CATEGORIES = Object.freeze({
  INFRASTRUCTURE: 'infrastructure',
  WORKFLOW: 'workflow',
  CONFIGURATION: 'configuration',
  INTERRUPTED: 'interrupted',
  UNKNOWN: 'unknown'
});

export const RETRY_SCOPES = Object.freeze({
  INFRASTRUCTURE: 'infrastructure',
  WORKFLOW: 'workflow',
  NONE: 'none'
});

export const ERROR_TAXONOMY = Object.freeze({
  infrastructure: INFRASTRUCTURE_ERROR_CODES,
  configuration: CONFIGURATION_ERROR_CODES,
  interrupted: INTERRUPTED_ERROR_CODES
});

function messageOf(err) {
  if (!err) return '';
  if (typeof err === 'string') return err.trim();
  return String(err.code || err.message || '').trim();
}

function normalizedToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

export function normalizeErrorCode(err) {
  const raw = messageOf(err);
  const token = normalizedToken(raw);

  if (!token) return 'unknown_error';

  if (INFRASTRUCTURE_ERROR_SET.has(token)) return token;
  if (CONFIGURATION_ERROR_SET.has(token)) return token;
  if (INTERRUPTED_ERROR_SET.has(token)) return token;

  if (token.startsWith('config_not_found')) return 'config_not_found';
  if (token.startsWith('config_invalid_json')) return 'config_invalid_json';
  if (token.startsWith('config_has_no_entries')) return 'config_has_no_entries';
  if (token.startsWith('no_entries_matched')) return 'no_entries_matched';

  if (token.startsWith('entry_') && token.includes('missing_pdfdir')) {
    return 'entry_missing_pdf_dir';
  }
  if (token.startsWith('entry_') && token.includes('missing_basegenerator')) {
    return 'entry_missing_base_generator';
  }
  if (token.startsWith('entry_') && token.includes('missing_workflowdir')) {
    return 'entry_missing_workflow_dir';
  }
  if (token.startsWith('entry_') && token.includes('pdfdir_is_not_a_directory')) {
    return 'entry_pdf_dir_invalid';
  }

  if (token.startsWith('status_')) return token;
  return token;
}

export function classifyError(err) {
  const code = normalizeErrorCode(err);

  if (err?.retryable === true || INFRASTRUCTURE_ERROR_SET.has(code)) {
    return Object.freeze({
      category: ERROR_CATEGORIES.INFRASTRUCTURE,
      code,
      retryable: true,
      retryScope: RETRY_SCOPES.INFRASTRUCTURE
    });
  }

  if (CONFIGURATION_ERROR_SET.has(code)) {
    return Object.freeze({
      category: ERROR_CATEGORIES.CONFIGURATION,
      code,
      retryable: false,
      retryScope: RETRY_SCOPES.NONE
    });
  }

  if (INTERRUPTED_ERROR_SET.has(code)) {
    return Object.freeze({
      category: ERROR_CATEGORIES.INTERRUPTED,
      code,
      retryable: false,
      retryScope: RETRY_SCOPES.NONE
    });
  }

  if (code.startsWith('status_')) {
    return Object.freeze({
      category: ERROR_CATEGORIES.WORKFLOW,
      code,
      retryable: true,
      retryScope: RETRY_SCOPES.WORKFLOW
    });
  }

  return Object.freeze({
    category: ERROR_CATEGORIES.UNKNOWN,
    code,
    retryable: false,
    retryScope: RETRY_SCOPES.NONE
  });
}

export function isRetryableInfraError(err) {
  if (!err) return false;
  return classifyError(err).retryScope === RETRY_SCOPES.INFRASTRUCTURE;
}