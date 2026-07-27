export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  RUN_FAILED: 1,
  FATAL: 1,
  INTERRUPTED: 130
});

const SIGNAL_EXIT_CODES = Object.freeze({
  SIGINT: 130,
  SIGTERM: 143,
  SIGBREAK: 149
});

function pdfFailed(record) {
  if (!record) return true;
  if (record.error) return true;

  return record.outputCompleteness?.complete === false;
}

function entryFailed(summary) {
  if (!summary) return true;
  if (summary.aborted || summary.fatal) return true;

  const pdfs = Array.isArray(summary.pdfs)
    ? summary.pdfs
    : [];

  return pdfs.some(pdfFailed);
}

export function determineRunExitCode(summaries) {
  if (!Array.isArray(summaries)) {
    return EXIT_CODES.RUN_FAILED;
  }

  return summaries.some(entryFailed)
    ? EXIT_CODES.RUN_FAILED
    : EXIT_CODES.SUCCESS;
}

export function getSignalExitCode(signal) {
  return SIGNAL_EXIT_CODES[String(signal || '').toUpperCase()]
    ?? EXIT_CODES.INTERRUPTED;
}