#!/usr/bin/env node
// Batch driver: for each "entry directory", run its PDFs through ChatGPT and
// download the files ChatGPT generates.
//
//   - Entry directories run in PARALLEL (bounded by `concurrency`).
//   - PDFs WITHIN an entry run STRICTLY SEQUENTIALLY.
//   - The first PDF of an entry makes ChatGPT emit a "schema" file; that file is
//     then attached to every later PDF in the same entry.
//   - Each PDF is its own fresh ChatGPT chat.
//
// Usage:
//   node run-batch.mjs --config batch.config.json [--concurrency N] [--timeout-ms MS] [--show|--headless]
//
// See batch.config.json for the job definitions and README.md for details.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChromeCdpBrowserBackend } from './chrome-cdp-backend.mjs';
import { ChatGPTController } from './chatgpt-controller.mjs';
import { defaultStateDir } from './state.mjs';
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

function log(...args) {
  console.log(...args);
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

async function resolvePrompt(entry) {
  if (typeof entry.prompt === 'string' && entry.prompt.trim()) return entry.prompt;
  if (typeof entry.promptFile === 'string' && entry.promptFile.trim()) {
    return await fs.readFile(path.resolve(entry.promptFile), 'utf8');
  }
  throw new Error(`entry "${entry.name}" needs a "prompt" or "promptFile"`);
}

async function normalizeEntry(entry, index, defaults = {}) {
  const name = String(entry.name || `entry-${index + 1}`);
  if (!entry.pdfDir) throw new Error(`entry "${name}" is missing "pdfDir"`);
  if (!entry.template) throw new Error(`entry "${name}" is missing "template"`);

  const pdfDir = path.resolve(entry.pdfDir);
  const template = path.resolve(entry.template);
  const outDir = entry.outDir ? path.resolve(entry.outDir) : path.join(pdfDir, 'output');
  const schemaNamePattern = String(entry.schemaNamePattern || 'schema');
  const randomOne = entry.randomOne ?? defaults.randomOne ?? false;
  const randomPerSubdir = entry.randomPerSubdir ?? defaults.randomPerSubdir ?? false;
  const chainSchema = entry.chainSchema ?? defaults.chainSchema ?? false;
  const prompt = await resolvePrompt(entry);

  await fs.access(template); // fail fast if the template file is missing
  const stat = await fs.stat(pdfDir).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`entry "${name}": pdfDir is not a directory: ${pdfDir}`);

  return { name, pdfDir, template, outDir, schemaNamePattern, randomOne, randomPerSubdir, chainSchema, prompt };
}

const CODE_LANG_EXT = {
  python: 'py', py: 'py', json: 'json', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts',
  bash: 'sh', sh: 'sh', shell: 'sh', text: 'txt', markdown: 'md', md: 'md', html: 'html',
  xml: 'xml', csv: 'csv', yaml: 'yaml', yml: 'yaml', sql: 'sql'
};

// Persist each fenced code block from a reply as its own file.
async function writeCodeBlocks(codeBlocks, outDir, stem) {
  const written = [];
  for (let c = 0; c < codeBlocks.length; c++) {
    const cb = codeBlocks[c] || {};
    const ext = CODE_LANG_EXT[String(cb.language || '').toLowerCase()] || 'txt';
    const name = codeBlocks.length === 1 ? `${stem}.${ext}` : `${stem}-${c + 1}.${ext}`;
    const p = path.join(outDir, name);
    await fs.writeFile(p, String(cb.text || ''));
    written.push({ path: p, name });
  }
  return written;
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
// Per-entry processing (sequential inside; schema threaded forward)
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

// Extract the last "STATUS_CODE: N" from a reply. Returns null if absent.
export function parseStatusCode(text) {
  const all = String(text || '').match(/STATUS_CODE:\s*(\d+)/gi);
  if (!all || !all.length) return null;
  const n = Number((all[all.length - 1].match(/(\d+)/) || [])[1]);
  return Number.isFinite(n) ? n : null;
}

const DEFAULT_STATUS_POLICY = {
  successCode: 0,
  continueCodes: new Set([70, 80]),
  continueMessage: 'continue',
  maxContinue: 3,
  maxRetry: 1
};

export async function processEntry({ entry, backend, selectors, stateDir, show, timeoutMs, debug = false, chatUrl = 'https://chatgpt.com/', newChat = true, statusPolicy = DEFAULT_STATUS_POLICY, makeController = defaultMakeController }) {
  const summary = { name: entry.name, schema: null, pdfs: [], aborted: false };
  const pdfs = await selectPdfs(entry);

  if (pdfs.length === 0) {
    log(`[${entry.name}] no PDFs found under ${entry.pdfDir}`);
    return summary;
  }

  await fs.mkdir(entry.outDir, { recursive: true });
  const schemaRe = new RegExp(entry.schemaNamePattern, 'i');
  const chainSchema = entry.chainSchema && pdfs.length > 1;
  let schemaPath = null;

  log(`[${entry.name}] ${pdfs.length} PDF(s); output → ${entry.outDir}${chainSchema ? ' (schema chaining ON)' : ''}`);

  for (let i = 0; i < pdfs.length; i++) {
    const pdf = pdfs[i].path;
    const group = pdfs[i].group;
    const stem = path.basename(pdf, path.extname(pdf));
    const labelBase = `${entry.name}${group ? '/' + group : ''} ${i + 1}/${pdfs.length} ${path.basename(pdf)}`;
    const iterOut = group
      ? path.join(entry.outDir, group)
      : path.join(entry.outDir, `${String(i + 1).padStart(2, '0')}-${stem}`);
    const record = { pdf: path.basename(pdf), group, files: [], error: null, status: null, attempts: 0 };
    const attachments = [pdf, entry.template, ...(chainSchema && schemaPath ? [schemaPath] : [])];

    let resolved = false; // success OR a final (non-retryable) outcome
    for (let attempt = 0; attempt <= statusPolicy.maxRetry && !resolved; attempt++) {
      record.attempts = attempt + 1;
      const label = `${labelBase}${attempt > 0 ? ` [retry ${attempt}/${statusPolicy.maxRetry}]` : ''}`;
      let session = null;
      const texts = [];
      try {
        log(`[${label}] opening chat (attachments: ${attachments.map((a) => path.basename(a)).join(', ')})`);
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

        const result = await controller.query({ prompt: entry.prompt, attachments, timeoutMs, newChat });
        texts.push(String(result?.text || ''));
        let status = parseStatusCode(result?.text);
        log(`[${label}] STATUS_CODE ${status ?? 'none'} (${String(result?.text || '').length} chars)`);

        // "continue" nudges in the SAME chat while the status is a continue code.
        let continues = 0;
        while (status != null && statusPolicy.continueCodes.has(status) && continues < statusPolicy.maxContinue) {
          continues += 1;
          log(`[${label}] STATUS_CODE ${status} → sending "${statusPolicy.continueMessage}" (${continues}/${statusPolicy.maxContinue})`);
          const cont = await controller.followUp({ text: statusPolicy.continueMessage, timeoutMs });
          texts.push(`\n----- continue ${continues} -----\n${String(cont?.text || '')}`);
          const s2 = parseStatusCode(cont?.text);
          if (s2 != null) status = s2;
          log(`[${label}] after continue ${continues}: STATUS_CODE ${status ?? 'none'}`);
        }
        record.status = status;

        // Always log the full chat text (temp chats are not saved by ChatGPT).
        await fs.mkdir(iterOut, { recursive: true });
        await fs.writeFile(path.join(iterOut, `${stem}.response.txt`), texts.join('\n'));

        // status 0 (success) or absent → save outputs; a retry code → retry.
        if (status === statusPolicy.successCode || status == null) {
          const entities = await controller.downloadLastAssistantEntities({ outDir: iterOut });
          const files = await controller.downloadLastAssistantFiles({ maxFiles: 20, outDir: iterOut });
          const written = await writeCodeBlocks(Array.isArray(result?.codeBlocks) ? result.codeBlocks : [], iterOut, stem);
          const savedNames = [...entities, ...files, ...written].map((f) => ({ path: f.path, name: f.name }));
          record.files = savedNames.map((s) => s.path);
          log(`[${label}] STATUS_CODE ${status ?? 'none'} → saved ${entities.length} file button(s) + ${files.length} link(s) + ${written.length} code block(s) → ${iterOut}`);
          if (status == null) log(`[${label}] ⚠ no STATUS_CODE in reply — saved outputs anyway`);
          if (savedNames.length === 0) log(`[${label}] ⚠ reply produced no files`);

          if (chainSchema && i === 0) {
            const schema = savedNames.find((f) => schemaRe.test(f.name));
            if (!schema) {
              record.error = `schema_not_found_in_first_iteration (got: ${savedNames.map((f) => f.name).join(', ') || 'nothing'})`;
              summary.aborted = true;
              log(`[${entry.name}] aborting entry (first iteration produced no schema to chain)`);
            } else {
              schemaPath = path.join(entry.outDir, `schema${path.extname(schema.name) || '.json'}`);
              await fs.copyFile(schema.path, schemaPath);
              summary.schema = schemaPath;
              log(`[${label}] schema identified → ${schemaPath}`);
            }
          }
          resolved = true;
        } else if (attempt < statusPolicy.maxRetry) {
          log(`[${label}] STATUS_CODE ${status} → retrying in a fresh chat`);
          // loop continues with a new attempt
        } else {
          // Retries exhausted (or a continue code that never reached success):
          // keep whatever files were produced, record the failing status.
          const entities = await controller.downloadLastAssistantEntities({ outDir: iterOut }).catch(() => []);
          record.files = entities.map((f) => f.path);
          record.error = `status_${status}`;
          log(`[${label}] STATUS_CODE ${status} → giving up (saved ${entities.length} file(s))`);
          resolved = true;
        }
      } catch (err) {
        record.error = err?.message || String(err);
        log(`[${label}] ERROR: ${record.error}`);
        try {
          if (texts.length) { await fs.mkdir(iterOut, { recursive: true }); await fs.writeFile(path.join(iterOut, `${stem}.response.txt`), texts.join('\n')); }
        } catch {}
        if (attempt >= statusPolicy.maxRetry) {
          if (chainSchema && i === 0) { summary.aborted = true; log(`[${entry.name}] aborting entry (first iteration failed)`); }
          resolved = true;
        } else {
          log(`[${label}] → retrying in a fresh chat after error`);
        }
      } finally {
        if (session) await session.close().catch(() => {});
      }
    }

    summary.pdfs.push(record);
    if (summary.aborted) break;
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const configPath = path.resolve(argValue('--config', 'batch.config.json'));
  const config = await loadConfig(configPath);

  const show = argFlag('--headless') ? false : argFlag('--show') ? true : config.show !== false;
  const timeoutMs = Number(argValue('--timeout-ms', config.timeoutMs || 600000));

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
  // Temporary chats are never in a project, aren't saved to history, and start
  // fresh each time — so no "New chat" click is needed.
  const temporaryChat = argFlag('--regular-chat') ? false : config.temporaryChat !== false;
  const chatUrl = temporaryChat ? 'https://chatgpt.com/?temporary-chat=true' : 'https://chatgpt.com/';
  const newChat = !temporaryChat;

  const sc = config.status || {};
  const statusPolicy = {
    successCode: Number.isFinite(sc.successCode) ? sc.successCode : 0,
    continueCodes: new Set((Array.isArray(sc.continueCodes) ? sc.continueCodes : [70, 80]).map(Number)),
    continueMessage: typeof sc.continueMessage === 'string' ? sc.continueMessage : 'continue',
    maxContinue: Number.isFinite(sc.maxContinue) ? sc.maxContinue : 3,
    maxRetry: Number.isFinite(sc.maxRetry) ? sc.maxRetry : 1
  };
  const entryDefaults = {
    randomOne: argFlag('--random-one') ? true : config.randomOne === true,
    randomPerSubdir: config.randomPerSubdir === true,
    chainSchema: config.chainSchema === true
  };
  const entries = [];
  for (let i = 0; i < selected.length; i++) {
    entries.push(await normalizeEntry(selected[i], i, entryDefaults));
  }

  const requestedConcurrency = Number(argValue('--concurrency', config.concurrency || entries.length));
  const concurrency = clamp(Number.isFinite(requestedConcurrency) ? requestedConcurrency : entries.length, 1, entries.length);

  const chromeSettings = config.chrome || {};
  const stateDir = defaultStateDir();
  const selectors = await loadSelectors(stateDir);

  const backend = new ChromeCdpBrowserBackend({
    stateDir,
    executablePath: resolveChromeExecutablePath({ settings: chromeSettings }),
    debugPort: resolveChromeDebugPort({ settings: chromeSettings }),
    profileMode: resolveChromeProfileMode({ settings: chromeSettings }),
    profileName: resolveChromeProfileName({ settings: chromeSettings })
  });

  log(`Config: ${configPath}`);
  log(`Entries: ${entries.length} | parallel: ${concurrency} | timeout: ${timeoutMs}ms | window: ${show ? 'visible' : 'hidden'} | chat: ${temporaryChat ? 'temporary' : 'regular'}${debug ? ' | debug: ON' : ''}`);
  log('Starting Chrome…');
  await backend.start();

  let summaries;
  try {
    summaries = await runPool(entries, concurrency, (entry) =>
      processEntry({ entry, backend, selectors, stateDir, show, timeoutMs, debug, chatUrl, newChat, statusPolicy }).catch((err) => ({
        name: entry.name,
        schema: null,
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
    log(
      `• ${s.name}: ${okCount} ok, ${errCount} failed, ${totalFiles} file(s)` +
        `${s.schema ? `, schema=${path.basename(s.schema)}` : ''}` +
        `${s.aborted ? ' [ABORTED]' : ''}`
    );
    if (s.fatal) log(`    fatal: ${s.fatal}`);
    for (const p of s.pdfs) {
      const st = p.status != null ? `STATUS_CODE ${p.status}` : 'no status';
      const attempts = p.attempts > 1 ? `, ${p.attempts} attempts` : '';
      log(`    ${p.error ? '✗' : '✓'} ${p.group || p.pdf} (${p.pdf}): ${st}${attempts}${p.error ? ` — ${p.error}` : ` — ${p.files.length} file(s)`}`);
    }
    if (errCount > 0 || s.aborted || s.fatal) hadError = true;
  }
  process.exitCode = hadError ? 1 : 0;
}

const isMain = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`fatal: ${err?.message || err}`);
    process.exitCode = 1;
  });
}
