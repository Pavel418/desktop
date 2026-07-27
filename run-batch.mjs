#!/usr/bin/env node
// Batch driver for the agentic document-generator workflow.
//
// For each "entry directory" of target scanned PDFs, and for each selected PDF, this
// opens one fresh ChatGPT chat (with the PDF and the base generator.py attached) and
// runs the multi-role agentic workflow (workflow-orchestrator.mjs): Controller → Contract
// Auditor → Template Analyst → Template Architect → template QA → background build/review →
// implementation → QA (baseline, fidelity, edge, regression) → Repair loop → package
// (audit phase 2 with a visual-review envelope) → Contract Auditor (release) → Final
// Auditor → Controller finalization. Creation and
// approval are separated, gates are enforced, repairs rerun only what changed, and the
// run ends by downloading the three persistent files (generator.py, manifest.json,
// generator_report.json) and recording the numeric status.
//
//   - Entry directories run in PARALLEL (bounded by `concurrency`).
//   - PDFs WITHIN an entry run STRICTLY SEQUENTIALLY.
//   - Each PDF is its own fresh ChatGPT chat.
//
// Usage:
//   node run-batch.mjs --config batch.config.json [--concurrency N] [--timeout-ms MS] [--show|--headless]
//
// See batch.config.json for the job definitions and README.md for details.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

import { ChromeCdpBrowserBackend } from './chrome-cdp-backend.mjs';
import { ATTACHMENT_RUNTIME_REVISION, ChatGPTController } from './chatgpt-controller.mjs';
import { defaultStateDir } from './state.mjs';
import { WorkflowOrchestrator, loadRoles, humanizeDuration } from './workflow-orchestrator.mjs';
import { ResourceMonitor } from './resource-monitor.mjs';
import { createRunLogger } from './observability/logger.mjs';
import {
  classifyError,
  isRetryableInfraError
} from './observability/error-taxonomy.mjs';
import {
  EXPECTED_PERSISTENT_OUTPUTS,
  verifyOutputCompleteness
} from './observability/output-completeness.mjs';
import {
  captureFailureDiagnostics
} from './observability/failure-diagnostics.mjs';
import {
  buildRunSummary,
  writeRunSummary
} from './observability/run-summary.mjs';
import {
  EXIT_CODES,
  determineRunExitCode,
  getSignalExitCode
} from './observability/exit-codes.mjs';
import {
  resolveChromeExecutablePath,
  resolveChromeDebugPort,
  resolveChromeProfileMode,
  resolveChromeProfileName
} from './browser-backend.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function argFlag(name) {
  return process.argv.includes(name);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

// Error categories and retryability are defined centrally in
// observability/error-taxonomy.mjs. Re-export this helper to preserve the
// existing public API used by tests and other modules.
export { isRetryableInfraError };

// Waits before each provider-side retry: long enough for a brief outage to clear, bounded so a
// hard failure still ends the file promptly.
const INFRA_BACKOFF_MS = Object.freeze([30_000, 120_000, 300_000]);

// The per-run log (kept forever, one file per run) plus a stable `batch-run.log` that always holds
// the current run for convenience. Both receive every line.
let activeRunLogPath = null;
let stableRunLogPath = null;
let activeStructuredLogging = null;
let activeRunSummaryContext = null;

function log(...args) {
  console.log(...args);
  const line = `${new Date().toISOString()} ${format(...args)}\n`;
  for (const target of [activeRunLogPath, stableRunLogPath]) {
    if (target) fs.appendFile(target, line).catch(() => {});
  }
}

function emitStructured(
  logger,
  level,
  event,
  message,
  fields = {}
) {
  if (!logger) return;

  const payload = {
    event,
    ...fields
  };

  if (level === 'error') {
    logger.error(payload, message);
    return;
  }

  if (level === 'warn') {
    logger.warn(payload, message);
    return;
  }

  if (level === 'debug') {
    logger.debug(payload, message);
    return;
  }

  logger.info(payload, message);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

async function loadConfig(configPath) {
  let raw;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch {
    throw new Error(`config_not_found: ${configPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config_invalid_json: ${configPath} (${err.message})`);
  }
  if (!parsed || !Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    throw new Error('config_has_no_entries: expected { "entries": [ ... ] }');
  }
  return parsed;
}

async function normalizeEntry(entry, index, defaults = {}) {
  const name = String(entry.name || `entry-${index + 1}`);
  if (!entry.pdfDir) throw new Error(`entry "${name}" is missing "pdfDir"`);

  const baseGeneratorRaw = entry.baseGenerator || entry.template;
  if (!baseGeneratorRaw) throw new Error(`entry "${name}" is missing "baseGenerator"`);
  if (!entry.workflowDir) throw new Error(`entry "${name}" is missing "workflowDir"`);

  const pdfDir = path.resolve(entry.pdfDir);
  const baseGenerator = path.resolve(baseGeneratorRaw);
  const workflowDir = path.resolve(entry.workflowDir);
  const outDir = entry.outDir ? path.resolve(entry.outDir) : path.join(pdfDir, 'output');
  const randomOne = entry.randomOne ?? defaults.randomOne ?? false;
  const randomPerSubdir = entry.randomPerSubdir ?? defaults.randomPerSubdir ?? false;

  await fs.access(baseGenerator); // fail fast if the base generator is missing
  const roles = await loadRoles(workflowDir); // fail fast if the role prompts are missing
  const stat = await fs.stat(pdfDir).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`entry "${name}": pdfDir is not a directory: ${pdfDir}`);

  return { name, pdfDir, baseGenerator, workflowDir, roles, outDir, randomOne, randomPerSubdir };
}

async function listPdfs(dir) {
  const names = await fs.readdir(dir);
  return names
    .filter((n) => /\.pdf$/i.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map((n) => path.join(dir, n));
}

async function loadSelectors(stateDir) {
  const defaults = JSON.parse(await fs.readFile(path.join(__dirname, 'selectors.json'), 'utf8'));
  const overridePath = path.join(stateDir, 'selectors.override.json');
  try {
    const override = JSON.parse(await fs.readFile(overridePath, 'utf8'));
    return { ...defaults, ...override };
  } catch {
    return defaults;
  }
}

// Render the multi-turn transcript to a readable text log.
function renderTranscript(transcript) {
  return (transcript || [])
    .map((t, i) => {
      const head = `----- turn ${i + 1}: ${t.role}${t.mode ? '/' + t.mode : ''}${t.reask ? ' (re-ask)' : ''} -----`;
      return `${head}\n${t.text || ''}`;
    })
    .join('\n\n');
}

// Keep the newest `keep` per-run logs and delete older ones, so per-run logs do not grow forever.
export async function pruneOldRunLogs(stateDir, keep = 20) {
  const names = await fs.readdir(stateDir).catch(() => []);
  const logs = names.filter((n) => /^batch-run-.*\.log$/.test(n)).sort();
  for (const name of logs.slice(0, Math.max(0, logs.length - keep))) {
    await fs.rm(path.join(stateDir, name), { force: true }).catch(() => {});
  }
  return logs.length;
}

// Write one attempt's transcript and issue log. Called on the success path AND from the error
// path, because temporary chats are never saved by ChatGPT: a turn that is not written here is
// gone for good. The first try is unsuffixed; later tries get `.attemptN` so nothing overwrites
// an earlier (often longer) attempt.
export async function persistAttempt(outDir, stem, tryIndex, transcript, issues) {
  const turns = Array.isArray(transcript) ? transcript : [];
  const issueList = Array.isArray(issues) ? issues : [];
  if (!turns.length && !issueList.length) return null;
  const suffix = tryIndex > 0 ? `.attempt${tryIndex + 1}` : '';
  await fs.mkdir(outDir, { recursive: true });
  const responsePath = path.join(outDir, `${stem}${suffix}.response.txt`);
  await fs.writeFile(responsePath, renderTranscript(turns));
  await fs.writeFile(path.join(outDir, `${stem}${suffix}.issues.json`), JSON.stringify(issueList, null, 2));
  return responsePath;
}

// ---------------------------------------------------------------------------
// Concurrency pool (no dependencies)
// ---------------------------------------------------------------------------

export async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = clamp(limit, 1, items.length);
  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// PDF selection
// ---------------------------------------------------------------------------

function defaultMakeController(opts) {
  return new ChatGPTController(opts);
}

// Build the list of PDFs (with a `group` label for output foldering) to process.
async function selectPdfs(entry) {
  if (entry.randomPerSubdir) {
    // One random PDF from each immediate subdirectory; skip the rest.
    const subs = (await fs.readdir(entry.pdfDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const picked = [];
    for (const sub of subs) {
      const dir = path.join(entry.pdfDir, sub);
      const pdfs = await listPdfs(dir);
      if (pdfs.length === 0) {
        log(`[${entry.name}/${sub}] no PDFs — skipped`);
        continue;
      }
      const chosen = pdfs[Math.floor(Math.random() * pdfs.length)];
      log(`[${entry.name}/${sub}] randomly selected ${path.basename(chosen)} (of ${pdfs.length})`);
      picked.push({ path: chosen, group: sub });
    }
    return picked;
  }

  const all = await listPdfs(entry.pdfDir);
  if (entry.randomOne && all.length > 0) {
    const chosen = all[Math.floor(Math.random() * all.length)];
    log(`[${entry.name}] randomly selected ${path.basename(chosen)} (of ${all.length} PDF(s))`);
    return [{ path: chosen, group: '' }];
  }
  return all.map((p) => ({ path: p, group: '' }));
}

// ---------------------------------------------------------------------------
// Per-entry processing (sequential inside)
// ---------------------------------------------------------------------------

const DEFAULT_WORKFLOW_CONFIG = {
  maxRepairRounds: 4,
  perTurnTimeoutMs: 900000,
  successCode: 0,
  maxRetry: 1
};

export async function processEntry({
  entry, backend, monitor = null, selectors, stateDir, show, timeoutMs, debug = false,
  chatUrl = 'https://chatgpt.com/', newChat = true,
  workflowConfig = DEFAULT_WORKFLOW_CONFIG, makeController = defaultMakeController,
  independentAudit = true, stallInspect = null,
  logger = null,
  diagnosticsRoot = null
}) {
  const entryLogger = logger?.child({
    entryName: entry.name
  });

  emitStructured(
    entryLogger,
    'info',
    'entry_started',
    'Batch entry started'
  );

  const summary = { name: entry.name, pdfs: [], aborted: false };
  const pdfs = await selectPdfs(entry);

  if (pdfs.length === 0) {
    emitStructured(
      entryLogger,
      'warn',
      'entry_empty',
      'No PDFs found for entry',
      {
        pdfDir: entry.pdfDir
      }
    );

    log(`[${entry.name}] no PDFs found under ${entry.pdfDir}`);
    return summary;
  }

  await fs.mkdir(entry.outDir, { recursive: true });
  const maxRetry = Number.isFinite(workflowConfig.maxRetry) ? workflowConfig.maxRetry : 1;
  // Separate budget for provider-side failures (rejected uploads, silent non-sends, stalled turns),
  // so a transient outage cannot consume the workflow retries meant for real workflow failures.
  const maxInfraRetries = Number.isFinite(workflowConfig.maxInfraRetries) ? workflowConfig.maxInfraRetries : 3;
  const infraBackoffMs = Array.isArray(workflowConfig.infraBackoffMs) && workflowConfig.infraBackoffMs.length
    ? workflowConfig.infraBackoffMs
    : INFRA_BACKOFF_MS;

  log(`[${entry.name}] ${pdfs.length} PDF(s); workflow=${entry.workflowDir}; output → ${entry.outDir}`);

  for (let i = 0; i < pdfs.length; i++) {
    const pdf = pdfs[i].path;
    const group = pdfs[i].group;
    const stem = path.basename(pdf, path.extname(pdf));
    const workflowRunId = `RUN-${String(i + 1).padStart(4, '0')}`;

    const pdfLogger = entryLogger?.child({
      pdfStem: stem,
      pdfName: path.basename(pdf),
      group: group || null,
      pdfIndex: i + 1,
      pdfCount: pdfs.length,
      workflowRunId
    });

    emitStructured(
      pdfLogger,
      'info',
      'pdf_selected',
      'PDF selected for processing',
      {
        pdfPath: pdf
      }
    );

    const labelBase = `${entry.name}${group ? '/' + group : ''} ${i + 1}/${pdfs.length} ${path.basename(pdf)}`;
    const iterOut = group
      ? path.join(entry.outDir, group)
      : path.join(entry.outDir, `${String(i + 1).padStart(2, '0')}-${stem}`);
    const record = {
      pdf: path.basename(pdf), group, files: [], error: null, status: null,
      attempts: 0, infraRetries: 0, gatesPassed: [], outputCompleteness: null
    };
    const fileStarted = Date.now();
    log(`\n───── ${labelBase} ─────${monitor ? `  (${monitor.format()})` : ''}`);

    let resolved = false;
    // `attempt` counts workflow attempts (a run that produced a real, wrong result); `infraRetry`
    // counts provider-side retries, which are budgeted separately. `tryIndex` only names artifacts.
    let attempt = 0;
    let infraRetry = 0;
    let tryIndex = 0;
    while (!resolved) {
      record.attempts = tryIndex + 1;
      const label = `${labelBase}` +
        `${attempt > 0 ? ` [retry ${attempt}/${maxRetry}]` : ''}` +
        `${infraRetry > 0 ? ` [infra retry ${infraRetry}/${maxInfraRetries}]` : ''}`;

      const attemptLogger = pdfLogger?.child({
        attemptNumber: tryIndex + 1,
        workflowRetryNumber: attempt,
        infraRetryNumber: infraRetry
      });

      const attemptStarted = Date.now();

      emitStructured(
        attemptLogger,
        'info',
        'attempt_started',
        'PDF processing attempt started',
        {
          attachmentNames: [
            path.basename(pdf),
            path.basename(entry.baseGenerator)
          ]
        }
      );
      let session = null;
      // The isolated audit session (for the independent release/final decision) is opened
      // lazily by the orchestrator via this factory, and closed in the finally below.
      let auditSession = null;
      try {
        log(`[${label}] opening chat (attachments: ${[pdf, entry.baseGenerator].map((a) => path.basename(a)).join(', ')})`);
        session = await backend.createSession({ url: chatUrl, show });
        const controller = makeController({
          page: session.page,
          selectors,
          stateDir,
          stallInspect,
          onDebug: debug ? (msg) => {
            log(`[${label}] · ${msg}`);
            emitStructured(attemptLogger, 'debug', 'controller_debug', msg, { sessionType: 'workflow' });
          } : null,
          onBlocked: (st) => {
            const blockedKind = st?.kind || 'blocked';
            log(`[${label}] ⚠ ChatGPT needs attention (${blockedKind}) — complete it in the Chrome window; waiting…`);
            emitStructured(attemptLogger, 'warn', 'attention_required', 'ChatGPT requires manual attention', {
              blockedKind,
              sessionType: 'workflow'
            });
          },
          onUnblocked: () => {
            log(`[${label}] resolved — continuing`);
            emitStructured(attemptLogger, 'info', 'attention_resolved', 'ChatGPT manual-attention state resolved', {
              sessionType: 'workflow'
            });
          }
        });

        const makeAuditController = independentAudit ? async () => {
          log(`[${label}] opening isolated audit chat for the independent release/final decision`);
          const s = await backend.createSession({ url: chatUrl, show });
          auditSession = s;
          const c = makeController({
            page: s.page,
            selectors,
            stateDir,
            stallInspect,
            onDebug: debug ? (msg) => {
              log(`[${label}] · (audit) ${msg}`);
              emitStructured(attemptLogger, 'debug', 'controller_debug', msg, { sessionType: 'audit' });
            } : null,
            onBlocked: (st) => {
              const blockedKind = st?.kind || 'blocked';
              log(`[${label}] ⚠ (audit) ChatGPT needs attention (${blockedKind}) — complete it in the Chrome window; waiting…`);
              emitStructured(attemptLogger, 'warn', 'attention_required', 'Audit chat requires manual attention', {
                blockedKind,
                sessionType: 'audit'
              });
            },
            onUnblocked: () => {
              log(`[${label}] (audit) resolved — continuing`);
              emitStructured(attemptLogger, 'info', 'attention_resolved', 'Audit manual-attention state resolved', {
                sessionType: 'audit'
              });
            }
          });
          return { controller: c, close: () => s.close().catch(() => {}) };
        } : null;

        const orchestrator = new WorkflowOrchestrator({
          roles: entry.roles,
          config: workflowConfig,
          log: (msg) => {
            log(`[${label}] ${msg}`);
            emitStructured(attemptLogger, 'info', 'workflow_message', msg);
          }
        });

        const res = await orchestrator.run({
          pdf,
          baseGenerator: entry.baseGenerator,
          outDir: iterOut,
          controller,
          timeoutMs,
          newChat,
          runId: workflowRunId,
          makeAuditController
        });

        record.status = res.statusCode;
        record.gatesPassed = res.gatesPassed;
        record.files = res.files.map((f) => f.path);
        record.outputCompleteness = await verifyOutputCompleteness({
          files: res.files,
          expectedFileNames: EXPECTED_PERSISTENT_OUTPUTS
        });

        emitStructured(
          attemptLogger,
          record.outputCompleteness.complete ? 'info' : 'warn',
          'output_completeness_checked',
          record.outputCompleteness.complete
            ? 'Expected persistent outputs are complete'
            : 'Expected persistent outputs are incomplete',
          record.outputCompleteness
        );

        if (!record.outputCompleteness.complete) {
          log(
            `[${label}] ⚠ output completeness check failed: ` +
            `missing=${record.outputCompleteness.missingFileNames.join(', ') || 'none'} | ` +
            `empty=${record.outputCompleteness.emptyFileNames.join(', ') || 'none'} | ` +
            `unreadable=${record.outputCompleteness.unreadableFileNames.join(', ') || 'none'}`
          );

          const diagnostics = await captureFailureDiagnostics({
            diagnosticsRoot,
            entryName: entry.name,
            pdfStem: stem,
            attemptNumber: tryIndex + 1,
            reason: 'output_incomplete',
            pages: [
              { name: 'workflow', page: session?.page },
              { name: 'audit', page: auditSession?.page }
            ]
          });

          emitStructured(
            attemptLogger,
            diagnostics.captured ? 'warn' : 'debug',
            diagnostics.captured
              ? 'failure_diagnostics_captured'
              : 'failure_diagnostics_unavailable',
            diagnostics.captured
              ? 'Failure diagnostics captured'
              : 'Failure diagnostics were unavailable',
            diagnostics
          );
        }

        // A completed run supersedes any earlier attempt's error, so a file that recovered is not
        // reported as failed in the summary (and does not set a non-zero exit code).
        record.error = null;

        // Persist the transcript and issue log (temporary chats aren't saved by ChatGPT).
        // Suffix retries so a later attempt never overwrites an earlier attempt's transcript —
        // the earlier (often longer) run is exactly what a post-mortem needs.
        await persistAttempt(iterOut, stem, tryIndex, res.transcript, res.issues);

        log(
          `[${label}] status ${res.statusCode} | gates: ${res.gatesPassed.join('→') || 'none'} | ` +
          `${res.files.length} file(s) | took ${humanizeDuration(Date.now() - attemptStarted)}` +
          `${monitor ? ` | ${monitor.format()}` : ''}`
        );

        emitStructured(
          attemptLogger,
          res.success ? 'info' : 'warn',
          'attempt_completed',
          'PDF processing attempt completed',
          {
            success: res.success,
            statusCode: res.statusCode,
            failedStage: res.failedStage || null,
            gatesPassed: res.gatesPassed || [],
            outputFileCount: res.files?.length || 0,
            outputComplete: record.outputCompleteness?.complete ?? false,
            missingOutputFileNames: record.outputCompleteness?.missingFileNames || [],
            emptyOutputFileNames: record.outputCompleteness?.emptyFileNames || [],
            unreadableOutputFileNames: record.outputCompleteness?.unreadableFileNames || [],
            durationMs: Date.now() - attemptStarted
          }
        );

        if (res.success) {
          if (res.files.length === 0) log(`[${label}] ⚠ success status but no persistent files captured`);
          resolved = true;
        } else if (attempt < maxRetry) {
          emitStructured(
            attemptLogger,
            'warn',
            'retry_scheduled',
            'Workflow retry scheduled',
            {
              retryType: 'workflow',
              nextAttemptNumber: tryIndex + 2,
              failedStage: res.failedStage || null,
              statusCode: res.statusCode
            }
          );
          attempt += 1;
          log(`[${label}] status ${res.statusCode} (failed at ${res.failedStage}) → retrying in a fresh chat`);
        } else {
          record.error = `status_${res.statusCode}${res.failedStage ? `@${res.failedStage}` : ''}`;
          log(`[${label}] status ${res.statusCode} → giving up`);
          resolved = true;
        }
      } catch (err) {
        record.error = err?.message || String(err);
        const errorInfo = classifyError(err);

        const diagnostics = await captureFailureDiagnostics({
          diagnosticsRoot,
          entryName: entry.name,
          pdfStem: stem,
          attemptNumber: tryIndex + 1,
          reason: errorInfo.code,
          pages: [
            { name: 'workflow', page: session?.page },
            { name: 'audit', page: auditSession?.page }
          ]
        });

        emitStructured(
          attemptLogger,
          diagnostics.captured ? 'warn' : 'debug',
          diagnostics.captured
            ? 'failure_diagnostics_captured'
            : 'failure_diagnostics_unavailable',
          diagnostics.captured
            ? 'Failure diagnostics captured'
            : 'Failure diagnostics were unavailable',
          diagnostics
        );

        emitStructured(
          attemptLogger,
          'error',
          'attempt_failed',
          'PDF processing attempt failed',
          {
            err,
            rawErrorMessage: record.error,
            errorCategory: errorInfo.category,
            errorCode: errorInfo.code,
            retryable: errorInfo.retryable,
            retryScope: errorInfo.retryScope,
            diagnosticsCaptured: diagnostics.captured,
            diagnosticsDir: diagnostics.diagnosticsDir,
            diagnosticFiles: diagnostics.files,
            durationMs: Date.now() - attemptStarted
          }
        );

        log(`[${label}] ERROR: ${record.error}`);
        if (err?.data) log(`[${label}] ERROR DATA: ${JSON.stringify(err.data)}`);
        // Whatever turns completed before the throw are the most valuable diagnostic there is;
        // the orchestrator attaches them to the error so they survive an aborted run.
        await persistAttempt(iterOut, stem, tryIndex, err?.transcript, err?.issues).catch(() => {});
        if (Array.isArray(err?.gatesPassed) && err.gatesPassed.length) record.gatesPassed = err.gatesPassed;

        if (isRetryableInfraError(err) && infraRetry < maxInfraRetries) {
          const waitMs = infraBackoffMs[Math.min(infraRetry, infraBackoffMs.length - 1)];
          emitStructured(
            attemptLogger,
            'warn',
            'retry_scheduled',
            'Infrastructure retry scheduled',
            {
              retryType: 'infrastructure',
              errorCategory: errorInfo.category,
              errorCode: errorInfo.code,
              nextAttemptNumber: tryIndex + 2,
              nextInfraRetryNumber: infraRetry + 1,
              waitMs
            }
          );
          infraRetry += 1;
          record.infraRetries = infraRetry;
          log(
            `[${label}] provider-side failure (${record.error}) — waiting ${humanizeDuration(waitMs)}, ` +
            `then retrying in a fresh chat without spending a workflow attempt ` +
            `(${infraRetry}/${maxInfraRetries})`
          );
          await sleep(waitMs);
        } else if (attempt < maxRetry) {
          emitStructured(
            attemptLogger,
            'warn',
            'retry_scheduled',
            'Workflow retry scheduled after error',
            {
              retryType: 'workflow',
              errorCategory: errorInfo.category,
              errorCode: errorInfo.code,
              nextAttemptNumber: tryIndex + 2
            }
          );
          attempt += 1;
          log(`[${label}] → retrying in a fresh chat after error`);
        } else {
          resolved = true;
        }
      } finally {
        if (auditSession) await auditSession.close().catch(() => {});
        if (session) await session.close().catch(() => {});
      }
      tryIndex += 1;
    }

    record.durationMs = Date.now() - fileStarted;
    log(`[${labelBase}] ⏱ file total ${humanizeDuration(record.durationMs)} over ${record.attempts} attempt(s)`);

    emitStructured(
      pdfLogger,
      record.error ? 'error' : 'info',
      'pdf_completed',
      'PDF processing completed',
      {
        success: !record.error,
        statusCode: record.status,
        error: record.error,
        attemptCount: record.attempts,
        infraRetryCount: record.infraRetries,
        gatesPassed: record.gatesPassed,
        outputFileCount: record.files.length,
        outputComplete: record.outputCompleteness?.complete ?? false,
        missingOutputFileNames: record.outputCompleteness?.missingFileNames || [],
        emptyOutputFileNames: record.outputCompleteness?.emptyFileNames || [],
        unreadableOutputFileNames: record.outputCompleteness?.unreadableFileNames || [],
        durationMs: record.durationMs
      }
    );

    summary.pdfs.push(record);
  }

  emitStructured(
    entryLogger,
    'info',
    'entry_completed',
    'Batch entry completed',
    {
      pdfCount: summary.pdfs.length,
      successCount: summary.pdfs.filter((record) => !record.error).length,
      failureCount: summary.pdfs.filter((record) => record.error).length
    }
  );

  return summary;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const configPath = path.resolve(argValue('--config', 'batch.config.json'));
  const config = await loadConfig(configPath);
  const stateDir = defaultStateDir();
  await fs.mkdir(stateDir, { recursive: true });
  // One retained log file per run, plus the stable batch-run.log for the current run. Truncating a
  // single shared file at startup used to destroy the previous run's log — including the evidence
  // needed to explain why that run failed.
  const runStartedAt = new Date().toISOString();
  const runStamp = runStartedAt.replace(/[:.]/g, '-');
  const runId = `run-${runStamp}-${process.pid}`;
  const runDir = path.join(stateDir, 'runs', runId);
  await fs.mkdir(runDir, { recursive: true });

  const structuredLogging = createRunLogger({
    runId,
    runDir,
    level: argFlag('--debug') || config.debug === true ? 'debug' : 'info'
  });
  activeStructuredLogging = structuredLogging;
  activeRunSummaryContext = {
    runId,
    runDir,
    runStartedAt,
    configPath
  };
  activeRunLogPath = path.join(stateDir, `batch-run-${runStamp}.log`);
  stableRunLogPath = path.join(stateDir, 'batch-run.log');
  await fs.writeFile(activeRunLogPath, '');
  await fs.writeFile(stableRunLogPath, '');
  await pruneOldRunLogs(stateDir, 20);

  const show = argFlag('--headless') ? false : argFlag('--show') ? true : config.show !== false;
  const timeoutMs = Number(argValue('--timeout-ms', config.timeoutMs || 7_200_000));

  // --only <name>[,<name>...] runs just the named entry directories.
  const onlyArg = argValue('--only', null);
  let selected = config.entries;
  if (onlyArg) {
    const wanted = onlyArg.split(',').map((s) => s.trim()).filter(Boolean);
    selected = config.entries.filter((e, i) => wanted.includes(String(e.name || `entry-${i + 1}`)));
    if (selected.length === 0) {
      const available = config.entries.map((e, i) => e.name || `entry-${i + 1}`).join(', ');
      throw new Error(`no entries matched --only "${onlyArg}" (available: ${available})`);
    }
  }

  const debug = argFlag('--debug') || config.debug === true;
  // Stall-inspection debug mode: on a near-empty idle-fallback, dump the DOM truth + screenshots
  // and HOLD instead of reacting, so we can see whether the reply is genuinely empty or misread.
  // Enable with --stall-inspect or "stallInspect": true (holdMs/intervalMs optionally configurable).
  const stallInspect = (argFlag('--stall-inspect') || config.stallInspect === true)
    ? { enabled: true, holdMs: Number(config.stallInspectHoldMs) || undefined, intervalMs: Number(config.stallInspectIntervalMs) || undefined }
    : null;
  // Temporary chats are never in a project, aren't saved to history, and start fresh.
  const temporaryChat = argFlag('--regular-chat') ? false : config.temporaryChat !== false;
  const chatUrl = temporaryChat ? 'https://chatgpt.com/?temporary-chat=true' : 'https://chatgpt.com/';
  const newChat = !temporaryChat;

  // Run the release + final audits in a fresh, isolated ChatGPT session (independent of the
  // writer chat) by default. Disable with "independentAudit": false or --shared-audit.
  const independentAudit = argFlag('--shared-audit') ? false : config.independentAudit !== false;

  const wf = config.workflow || {};
  const workflowConfig = {
    maxRepairRounds: Number.isFinite(wf.maxRepairRounds) ? wf.maxRepairRounds : DEFAULT_WORKFLOW_CONFIG.maxRepairRounds,
    perTurnTimeoutMs: Number.isFinite(wf.perTurnTimeoutMs) ? wf.perTurnTimeoutMs : timeoutMs,
    successCode: Number.isFinite(wf.successCode) ? wf.successCode : 0,
    maxRetry: Number.isFinite(wf.maxRetry) ? wf.maxRetry : DEFAULT_WORKFLOW_CONFIG.maxRetry,
    // Provider-side retries (rejected uploads, silent non-sends, stalled turns) have their own
    // budget so a transient outage never consumes maxRetry.
    maxInfraRetries: Number.isFinite(wf.maxInfraRetries) ? wf.maxInfraRetries : 3,
    // Re-sends of a single turn that ChatGPT answered with its own error card.
    serverErrorRetries: Number.isFinite(wf.serverErrorRetries) ? wf.serverErrorRetries : 2,
    auditEvidenceInlineMax: Number.isFinite(config.auditEvidenceInlineMax) ? config.auditEvidenceInlineMax : 12_000,
    // Require all 17 individual edge decisions before the visual-review envelope can be built.
    // Default on in production; disable with "enforceEdgeDecisions": false.
    enforceEdgeDecisions: config.enforceEdgeDecisions !== false
  };
  const entryDefaults = {
    randomOne: argFlag('--random-one') ? true : config.randomOne === true,
    randomPerSubdir: config.randomPerSubdir === true
  };
  const entries = [];
  for (let i = 0; i < selected.length; i++) {
    entries.push(await normalizeEntry(selected[i], i, entryDefaults));
  }

  const requestedConcurrency = Number(argValue('--concurrency', config.concurrency || entries.length));
  const concurrency = clamp(Number.isFinite(requestedConcurrency) ? requestedConcurrency : entries.length, 1, entries.length);

  const chromeSettings = config.chrome || {};
  // The resolvers read flat `chromeXxx` keys (with argv > env > settings precedence), but the batch
  // config nests them under `chrome` with unprefixed names. Map both forms so config values such as
  // `chrome.profileMode` actually take effect — previously they were silently ignored and always
  // fell back to the built-in default.
  const chromeResolverSettings = {
    chromeExecutablePath: chromeSettings.executablePath ?? chromeSettings.chromeExecutablePath,
    chromeDebugPort: chromeSettings.debugPort ?? chromeSettings.chromeDebugPort,
    chromeProfileMode: chromeSettings.profileMode ?? chromeSettings.chromeProfileMode,
    chromeProfileName: chromeSettings.profileName ?? chromeSettings.chromeProfileName
  };
  const selectors = await loadSelectors(stateDir);

  const backend = new ChromeCdpBrowserBackend({
    stateDir,
    executablePath: resolveChromeExecutablePath({ settings: chromeResolverSettings }),
    debugPort: resolveChromeDebugPort({ settings: chromeResolverSettings }),
    profileMode: resolveChromeProfileMode({ settings: chromeResolverSettings }),
    profileName: resolveChromeProfileName({ settings: chromeResolverSettings }),
    pruneCookiesOnOpen: chromeSettings.pruneCookiesOnOpen !== false
  });

  structuredLogging.logger.info(
    {
      event: 'run_started',
      runStartedAt,
      configPath,
      runDir,
      structuredLogPath: structuredLogging.logPath,
      runtimeSource: fileURLToPath(import.meta.url),
      attachmentRuntimeRevision: ATTACHMENT_RUNTIME_REVISION,
      entryCount: entries.length,
      concurrency,
      timeoutMs,
      windowMode: show ? 'visible' : 'hidden',
      chatMode: temporaryChat ? 'temporary' : 'regular',
      debug
    },
    'Batch run started'
  );

  log(`Config: ${configPath}`);
  log(`Runtime source: ${fileURLToPath(import.meta.url)} | attachment=${ATTACHMENT_RUNTIME_REVISION}`);
  log(`Persistent log: ${activeRunLogPath}`);
  log(`Entries: ${entries.length} | parallel: ${concurrency} | timeout: ${timeoutMs}ms | window: ${show ? 'visible' : 'hidden'} | chat: ${temporaryChat ? 'temporary' : 'regular'}${debug ? ' | debug: ON' : ''}`);
  log(`Workflow: maxRepairRounds=${workflowConfig.maxRepairRounds} | maxRetry=${workflowConfig.maxRetry} | maxInfraRetries=${workflowConfig.maxInfraRetries} | serverErrorRetries=${workflowConfig.serverErrorRetries} | successCode=${workflowConfig.successCode} | release/final audit: ${independentAudit ? 'isolated session' : 'shared chat'}`);
  if (stallInspect) log(`⏸ STALL INSPECT MODE ON — a near-empty idle-fallback will dump DOM+screenshots and HOLD instead of reacting (kill the run when done inspecting).`);
  log('Starting Chrome…');
  const chromeState = await backend.start();
  const chromePid = chromeState?.chromePid ?? null;

  // Sample RAM/CPU of the script and the whole Chrome process tree throughout the run.
  const resourceIntervalMs = Number(config.resourceSampleMs) || 15_000;
  const monitor = new ResourceMonitor({ chromePid, log, intervalMs: resourceIntervalMs });
  log(`Resource monitor: chrome pid=${chromePid ?? 'n/a'} | sampling every ${Math.round(resourceIntervalMs / 1000)}s | ${monitor.cores} CPU core(s)`);
  monitor.start();

  // Ctrl+C used to kill the process mid-turn with no trace at all: the log simply stopped, leaving
  // no record that the run was interrupted rather than hung, and Chrome outliving the script.
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      const signalExitCode = getSignalExitCode(signal);

      log(`\n⚠ ${signal} received — stopping the run. Turns already completed were written to the ` +
          `output directory; the turn in flight is lost.`);

      structuredLogging.logger.warn(
        {
          event: 'signal_received',
          signal,
          exitCode: signalExitCode
        },
        'Batch run interrupted'
      );

      Promise.allSettled([
        monitor.stop(),
        backend.dispose(),
        structuredLogging.flush()
      ]).then(() => process.exit(signalExitCode));

      // Do not wait forever on a wedged browser.
      setTimeout(
        () => process.exit(signalExitCode),
        10_000
      ).unref();
    });
  }

  const runStarted = Date.now();
  let summaries;
  try {
    summaries = await runPool(entries, concurrency, (entry) =>
      processEntry({
        entry,
        backend,
        monitor,
        selectors,
        stateDir,
        show,
        timeoutMs,
        debug,
        chatUrl,
        newChat,
        workflowConfig,
        independentAudit,
        stallInspect,
        logger: structuredLogging.logger,
        diagnosticsRoot: runDir
      }).catch((err) => ({
        name: entry.name,
        pdfs: [],
        aborted: true,
        fatal: err?.message || String(err)
      }))
    );
  } finally {
    await monitor.stop().catch(() => {});
    await backend.dispose().catch(() => {});
  }
  log(`Total wall-clock: ${humanizeDuration(Date.now() - runStarted)}`);

  // ---- Summary ----
  log('\n===== SUMMARY =====');
  for (const s of summaries) {
    const okCount = s.pdfs.filter((p) => !p.error).length;
    const errCount = s.pdfs.filter((p) => p.error).length;
    const totalFiles = s.pdfs.reduce((n, p) => n + p.files.length, 0);
    log(`• ${s.name}: ${okCount} ok, ${errCount} failed, ${totalFiles} file(s)${s.aborted ? ' [ABORTED]' : ''}`);
    if (s.fatal) log(`    fatal: ${s.fatal}`);
    for (const p of s.pdfs) {
      const st = p.status != null ? `status ${p.status}` : 'no status';
      const attempts = p.attempts > 1 ? `, ${p.attempts} attempts` : '';
      const gates = p.gatesPassed && p.gatesPassed.length ? `, gates ${p.gatesPassed.join('→')}` : '';
      const took = p.durationMs ? `, ${humanizeDuration(p.durationMs)}` : '';
      log(`    ${p.error ? '✗' : '✓'} ${p.group || p.pdf} (${p.pdf}): ${st}${attempts}${gates}${took}${p.error ? ` — ${p.error}` : ` — ${p.files.length} file(s)`}`);
    }
  }

  process.exitCode = determineRunExitCode(summaries);
  const runSucceeded = process.exitCode === EXIT_CODES.SUCCESS;

  const runFinishedAt = new Date().toISOString();
  const runSummary = buildRunSummary({
    runId,
    runStartedAt,
    runFinishedAt,
    durationMs: Date.now() - runStarted,
    exitCode: process.exitCode,
    configPath,
    runDir,
    structuredLogPath: structuredLogging.logPath,
    summaries
  });

  const summaryPath = await writeRunSummary({
    runDir,
    summary: runSummary
  });

  log(`Run summary: ${summaryPath}`);

  structuredLogging.logger.info(
    {
      event: 'run_summary_written',
      summaryPath,
      success: runSummary.success,
      entryCount: runSummary.counts.entries,
      pdfCount: runSummary.counts.pdfs,
      failureCount: runSummary.counts.failedPdfs
    },
    'Run summary written'
  );

  structuredLogging.logger.info(
    {
      event: 'run_completed',
      success: runSucceeded,
      exitCode: process.exitCode,
      durationMs: Date.now() - runStarted,
      entryCount: summaries.length,
      failedEntryCount: summaries.filter(
        (summary) =>
          summary.aborted ||
          summary.fatal ||
          summary.pdfs.some((record) => record.error)
      ).length,
      summaryPath
    },
    'Batch run completed'
  );

  await structuredLogging.flush();
}

const isMain = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(async (err) => {
    log(`fatal: ${err?.message || err}`);

    try {
      const errorInfo = classifyError(err);
      let summaryPath = null;

      if (activeRunSummaryContext) {
        const runFinishedAt = new Date().toISOString();
        const fatalSummary = buildRunSummary({
          runId: activeRunSummaryContext.runId,
          runStartedAt: activeRunSummaryContext.runStartedAt,
          runFinishedAt,
          durationMs:
            Date.parse(runFinishedAt) -
            Date.parse(activeRunSummaryContext.runStartedAt),
          exitCode: EXIT_CODES.FATAL,
          configPath: activeRunSummaryContext.configPath,
          runDir: activeRunSummaryContext.runDir,
          structuredLogPath: activeStructuredLogging?.logPath || null,
          summaries: [],
          fatalError: err
        });

        summaryPath = await writeRunSummary({
          runDir: activeRunSummaryContext.runDir,
          summary: fatalSummary
        });
      }

      activeStructuredLogging?.logger.error(
        {
          event: 'run_fatal',
          err,
          errorCategory: errorInfo.category,
          errorCode: errorInfo.code,
          retryable: errorInfo.retryable,
          retryScope: errorInfo.retryScope,
          exitCode: EXIT_CODES.FATAL,
          summaryPath
        },
        'Batch run failed fatally'
      );

      await activeStructuredLogging?.flush();
    } catch {
      // Never hide the original fatal error because logging failed.
    }

    process.exitCode = EXIT_CODES.FATAL;
  });
}