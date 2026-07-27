import fs from 'node:fs/promises';
import path from 'node:path';

function normalizeError(error) {
  if (!error) return null;

  return {
    type: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code || null,
    stack: error?.stack || null
  };
}

function normalizePdfRecord(record) {
  const completeness = record?.outputCompleteness || null;

  return {
    pdf: record?.pdf || null,
    group: record?.group || '',
    success: !record?.error,
    statusCode: record?.status ?? null,
    error: record?.error || null,
    attempts: Number(record?.attempts) || 0,
    infrastructureRetries: Number(record?.infraRetries) || 0,
    durationMs: Number(record?.durationMs) || 0,
    gatesPassed: Array.isArray(record?.gatesPassed)
      ? record.gatesPassed
      : [],
    outputFiles: Array.isArray(record?.files)
      ? record.files
      : [],
    outputCompleteness: completeness
      ? {
          complete: completeness.complete === true,
          expectedFileNames:
            completeness.expectedFileNames || [],
          observedFileNames:
            completeness.observedFileNames || [],
          missingFileNames:
            completeness.missingFileNames || [],
          emptyFileNames:
            completeness.emptyFileNames || [],
          unreadableFileNames:
            completeness.unreadableFileNames || [],
          duplicateFileNames:
            completeness.duplicateFileNames || [],
          extraFileNames:
            completeness.extraFileNames || [],
          verifiedFileCount:
            Number(completeness.verifiedFileCount) || 0,
          totalBytes:
            Number(completeness.totalBytes) || 0
        }
      : null
  };
}

function normalizeEntrySummary(summary) {
  const pdfs = Array.isArray(summary?.pdfs)
    ? summary.pdfs.map(normalizePdfRecord)
    : [];

  return {
    name: summary?.name || null,
    aborted: summary?.aborted === true,
    fatal: summary?.fatal || null,
    success:
      summary?.aborted !== true &&
      !summary?.fatal &&
      pdfs.every((pdf) => pdf.success),
    counts: {
      pdfs: pdfs.length,
      successfulPdfs: pdfs.filter((pdf) => pdf.success).length,
      failedPdfs: pdfs.filter((pdf) => !pdf.success).length,
      attempts: pdfs.reduce(
        (total, pdf) => total + pdf.attempts,
        0
      ),
      infrastructureRetries: pdfs.reduce(
        (total, pdf) =>
          total + pdf.infrastructureRetries,
        0
      ),
      outputFiles: pdfs.reduce(
        (total, pdf) =>
          total + pdf.outputFiles.length,
        0
      ),
      incompleteOutputs: pdfs.filter(
        (pdf) =>
          pdf.outputCompleteness &&
          !pdf.outputCompleteness.complete
      ).length
    },
    pdfs
  };
}

export function buildRunSummary({
  runId,
  runStartedAt,
  runFinishedAt,
  durationMs,
  exitCode,
  configPath,
  runDir,
  structuredLogPath,
  summaries = [],
  fatalError = null
}) {
  const entries = Array.isArray(summaries)
    ? summaries.map(normalizeEntrySummary)
    : [];

  const counts = {
    entries: entries.length,
    successfulEntries: entries.filter(
      (entry) => entry.success
    ).length,
    failedEntries: entries.filter(
      (entry) => !entry.success
    ).length,
    pdfs: entries.reduce(
      (total, entry) => total + entry.counts.pdfs,
      0
    ),
    successfulPdfs: entries.reduce(
      (total, entry) =>
        total + entry.counts.successfulPdfs,
      0
    ),
    failedPdfs: entries.reduce(
      (total, entry) =>
        total + entry.counts.failedPdfs,
      0
    ),
    attempts: entries.reduce(
      (total, entry) =>
        total + entry.counts.attempts,
      0
    ),
    infrastructureRetries: entries.reduce(
      (total, entry) =>
        total + entry.counts.infrastructureRetries,
      0
    ),
    outputFiles: entries.reduce(
      (total, entry) =>
        total + entry.counts.outputFiles,
      0
    ),
    incompleteOutputs: entries.reduce(
      (total, entry) =>
        total + entry.counts.incompleteOutputs,
      0
    )
  };

  const normalizedExitCode =
    Number.isInteger(exitCode) ? exitCode : 1;

  return {
    schemaVersion: 1,
    runId,
    success:
      normalizedExitCode === 0 &&
      !fatalError &&
      counts.failedEntries === 0 &&
      counts.failedPdfs === 0,
    exitCode: normalizedExitCode,
    startedAt: runStartedAt,
    finishedAt: runFinishedAt,
    durationMs: Math.max(
      0,
      Number(durationMs) || 0
    ),
    paths: {
      runDir: runDir || null,
      configPath: configPath || null,
      structuredLogPath:
        structuredLogPath || null,
      summaryPath: runDir
        ? path.join(runDir, 'summary.json')
        : null
    },
    counts,
    fatalError: normalizeError(fatalError),
    entries
  };
}

export async function writeRunSummary({
  runDir,
  summary
}) {
  if (!runDir) {
    throw new Error('writeRunSummary requires runDir');
  }

  const summaryPath = path.join(
    runDir,
    'summary.json'
  );

  const temporaryPath = `${summaryPath}.tmp`;

  await fs.mkdir(runDir, {
    recursive: true
  });

  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8'
  );

  await fs.rename(
    temporaryPath,
    summaryPath
  );

  return summaryPath;
}