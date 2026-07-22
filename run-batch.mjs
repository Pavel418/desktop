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
import { WorkflowOrchestrator, loadRoles } from './workflow-orchestrator.mjs';
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

let activeRunLogPath = null;

function log(...args) {
  console.log(...args);
  if (activeRunLogPath) {
    fs.appendFile(activeRunLogPath, `${new Date().toISOString()} ${format(...args)}\n`).catch(() => {});
  }
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
  entry, backend, selectors, stateDir, show, timeoutMs, debug = false,
  chatUrl = 'https://chatgpt.com/', newChat = true,
  workflowConfig = DEFAULT_WORKFLOW_CONFIG, makeController = defaultMakeController,
  independentAudit = true
}) {
  const summary = { name: entry.name, pdfs: [], aborted: false };
  const pdfs = await selectPdfs(entry);

  if (pdfs.length === 0) {
    log(`[${entry.name}] no PDFs found under ${entry.pdfDir}`);
    return summary;
  }

  await fs.mkdir(entry.outDir, { recursive: true });
  const maxRetry = Number.isFinite(workflowConfig.maxRetry) ? workflowConfig.maxRetry : 1;

  log(`[${entry.name}] ${pdfs.length} PDF(s); workflow=${entry.workflowDir}; output → ${entry.outDir}`);

  for (let i = 0; i < pdfs.length; i++) {
    const pdf = pdfs[i].path;
    const group = pdfs[i].group;
    const stem = path.basename(pdf, path.extname(pdf));
    const labelBase = `${entry.name}${group ? '/' + group : ''} ${i + 1}/${pdfs.length} ${path.basename(pdf)}`;
    const iterOut = group
      ? path.join(entry.outDir, group)
      : path.join(entry.outDir, `${String(i + 1).padStart(2, '0')}-${stem}`);
    const record = { pdf: path.basename(pdf), group, files: [], error: null, status: null, attempts: 0, gatesPassed: [] };

    let resolved = false;
    for (let attempt = 0; attempt <= maxRetry && !resolved; attempt++) {
      record.attempts = attempt + 1;
      const label = `${labelBase}${attempt > 0 ? ` [retry ${attempt}/${maxRetry}]` : ''}`;
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
          onDebug: debug ? (msg) => log(`[${label}] · ${msg}`) : null,
          onBlocked: (st) =>
            log(`[${label}] ⚠ ChatGPT needs attention (${st?.kind || 'blocked'}) — complete it in the Chrome window; waiting…`),
          onUnblocked: () => log(`[${label}] resolved — continuing`)
        });

        const makeAuditController = independentAudit ? async () => {
          log(`[${label}] opening isolated audit chat for the independent release/final decision`);
          const s = await backend.createSession({ url: chatUrl, show });
          auditSession = s;
          const c = makeController({
            page: s.page,
            selectors,
            stateDir,
            onDebug: debug ? (msg) => log(`[${label}] · (audit) ${msg}`) : null,
            onBlocked: (st) =>
              log(`[${label}] ⚠ (audit) ChatGPT needs attention (${st?.kind || 'blocked'}) — complete it in the Chrome window; waiting…`),
            onUnblocked: () => log(`[${label}] (audit) resolved — continuing`)
          });
          return { controller: c, close: () => s.close().catch(() => {}) };
        } : null;

        const orchestrator = new WorkflowOrchestrator({
          roles: entry.roles,
          config: workflowConfig,
          log: (msg) => log(`[${label}] ${msg}`)
        });

        const res = await orchestrator.run({
          pdf,
          baseGenerator: entry.baseGenerator,
          outDir: iterOut,
          controller,
          timeoutMs,
          newChat,
          runId: `RUN-${String(i + 1).padStart(4, '0')}`,
          makeAuditController
        });

        record.status = res.statusCode;
        record.gatesPassed = res.gatesPassed;
        record.files = res.files.map((f) => f.path);

        // Persist the transcript and issue log (temporary chats aren't saved by ChatGPT).
        await fs.mkdir(iterOut, { recursive: true });
        await fs.writeFile(path.join(iterOut, `${stem}.response.txt`), renderTranscript(res.transcript));
        await fs.writeFile(path.join(iterOut, `${stem}.issues.json`), JSON.stringify(res.issues, null, 2));

        log(`[${label}] status ${res.statusCode} | gates: ${res.gatesPassed.join('→') || 'none'} | ${res.files.length} file(s)`);

        if (res.success) {
          if (res.files.length === 0) log(`[${label}] ⚠ success status but no persistent files captured`);
          resolved = true;
        } else if (attempt < maxRetry) {
          log(`[${label}] status ${res.statusCode} (failed at ${res.failedStage}) → retrying in a fresh chat`);
        } else {
          record.error = `status_${res.statusCode}${res.failedStage ? `@${res.failedStage}` : ''}`;
          log(`[${label}] status ${res.statusCode} → giving up`);
          resolved = true;
        }
      } catch (err) {
        record.error = err?.message || String(err);
        log(`[${label}] ERROR: ${record.error}`);
        if (err?.data) log(`[${label}] ERROR DATA: ${JSON.stringify(err.data)}`);
        if (attempt >= maxRetry) resolved = true;
        else log(`[${label}] → retrying in a fresh chat after error`);
      } finally {
        if (auditSession) await auditSession.close().catch(() => {});
        if (session) await session.close().catch(() => {});
      }
    }

    summary.pdfs.push(record);
  }

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
  activeRunLogPath = path.join(stateDir, 'batch-run.log');
  await fs.writeFile(activeRunLogPath, '');

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
  const selectors = await loadSelectors(stateDir);

  const backend = new ChromeCdpBrowserBackend({
    stateDir,
    executablePath: resolveChromeExecutablePath({ settings: chromeSettings }),
    debugPort: resolveChromeDebugPort({ settings: chromeSettings }),
    profileMode: resolveChromeProfileMode({ settings: chromeSettings }),
    profileName: resolveChromeProfileName({ settings: chromeSettings })
  });

  log(`Config: ${configPath}`);
  log(`Runtime source: ${fileURLToPath(import.meta.url)} | attachment=${ATTACHMENT_RUNTIME_REVISION}`);
  log(`Persistent log: ${activeRunLogPath}`);
  log(`Entries: ${entries.length} | parallel: ${concurrency} | timeout: ${timeoutMs}ms | window: ${show ? 'visible' : 'hidden'} | chat: ${temporaryChat ? 'temporary' : 'regular'}${debug ? ' | debug: ON' : ''}`);
  log(`Workflow: maxRepairRounds=${workflowConfig.maxRepairRounds} | maxRetry=${workflowConfig.maxRetry} | successCode=${workflowConfig.successCode} | release/final audit: ${independentAudit ? 'isolated session' : 'shared chat'}`);
  log('Starting Chrome…');
  await backend.start();

  let summaries;
  try {
    summaries = await runPool(entries, concurrency, (entry) =>
      processEntry({ entry, backend, selectors, stateDir, show, timeoutMs, debug, chatUrl, newChat, workflowConfig, independentAudit }).catch((err) => ({
        name: entry.name,
        pdfs: [],
        aborted: true,
        fatal: err?.message || String(err)
      }))
    );
  } finally {
    await backend.dispose().catch(() => {});
  }

  // ---- Summary ----
  log('\n===== SUMMARY =====');
  let hadError = false;
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
      log(`    ${p.error ? '✗' : '✓'} ${p.group || p.pdf} (${p.pdf}): ${st}${attempts}${gates}${p.error ? ` — ${p.error}` : ` — ${p.files.length} file(s)`}`);
    }
    if (errCount > 0 || s.aborted || s.fatal) hadError = true;
  }
  process.exitCode = hadError ? 1 : 0;
}

const isMain = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    log(`fatal: ${err?.message || err}`);
    process.exitCode = 1;
  });
}
