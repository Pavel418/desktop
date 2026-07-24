# pdf-chatgpt-batch

A headless Node script that adapts a synthetic-document generator to directories of
scanned template PDFs by driving an **agentic, role-separated workflow** through ChatGPT
in your own signed-in browser session, and downloads the generated files.

It drives a real Chrome window over the Chrome DevTools Protocol — no API keys,
no MCP server, no GUI. You stay logged into ChatGPT in an isolated Chrome profile.

## How it works

You define one or more **entry directories** in `batch.config.json`. Each entry has its
own target PDFs, one base generator (`baseGenerator`), and the agentic workflow to run
(`workflowDir`).

- **Entry directories run in parallel** (bounded by `concurrency`); PDFs within an entry
  run **sequentially**.
- PDF selection per entry:
  - default: process every PDF in the directory sequentially;
  - `randomOne`: pick ONE random PDF from the directory;
  - `randomPerSubdir`: pick ONE random PDF from **each immediate subdirectory**
    (output is grouped by subdirectory name).
- Each PDF is processed in its **own chat** (a **temporary chat** by default — never in a
  project, not saved to ChatGPT history), with the target PDF and the base `generator.py`
  attached.
- Instead of one monolithic prompt, `run-batch.mjs` runs the multi-role workflow in
  `workflow/` via **`workflow-orchestrator.mjs`**. The orchestrator sequences the model
  through the roles as conversation turns, enforces the stage gates, tracks an
  append-only issue log, and drives targeted repair reruns:

  ```
  Controller (start; base generator verified by byte-hash) → Template Analyst → Template Architect →
  QA Auditor (template) → Generator Engineer (background) →
  QA Auditor (background) → Generator Engineer (implementation) →
  QA Auditor (baseline → fidelity → edge → regression) →
  Repair loop (targeted reruns) → Generator Engineer (package → status 0) →
  Orchestrator builds + validates the visual-review envelope →
  Contract Auditor (release) → Final Auditor → Controller (finalize)
  ```

  Creation and approval are separated (a role that writes an artifact never approves it),
  and each role ends its turn with a hash-bound structured JSON handoff the orchestrator routes on.
- Memory-heavy generator checks run as **isolated machine stages** with stage reports and
  checkpoints. There are two visual-review envelopes with deliberately different schema identities.
  The **model's in-sandbox machine-review envelope** is what
  `generator.py`'s `audit_generator` validates (11 checks + 17 edge cases + writer≠reviewer) to
  return machine status 0. Separately, the **orchestrator builds its own envelope** from the
  independent QA reviews — six gates, the 17 individual edge decisions, reviewer identity distinct
  from every writer — computes real SHA-256 of the three persistent files, and cross-checks the
  downloaded `generator_report.json`. That orchestrator envelope is fed to the release and final
  auditors, so the release decision can never rest on the writer's own say-so. Status 0 is therefore
  impossible without a genuine, independent, hash-bound review. See
  [workflow/WORKFLOW.md](workflow/WORKFLOW.md).
- On success only **`generator.py`**, **`manifest.json`**, and **`generator_report.json`**
  are downloaded (captured via file buttons / links over CDP). The full multi-turn
  transcript is saved to `<pdf>.response.txt` and the issue log to `<pdf>.issues.json`
  (temporary chats aren't saved by ChatGPT, so we log them ourselves).

## Requirements

- Node.js 20 or newer
- Google Chrome (or Chromium / Brave / Edge) installed

## Configure

Copy and edit `batch.config.json`:

```jsonc
{
  "concurrency": 1,            // max entry directories in parallel
  "timeoutMs": 7200000,        // per-turn response timeout (2 hours)
  "show": true,                // show the Chrome windows
  "temporaryChat": true,       // use temporary chats (no project, no history)
  "randomPerSubdir": true,     // one random PDF from each subdirectory of pdfDir
  "workflow": {
    "maxRepairRounds": 4,      // repair→rerun rounds allowed per recoverable QA gate
    "perTurnTimeoutMs": 7200000,// timeout per role turn (defaults to timeoutMs)
    "successCode": 0,          // final status that means "done"
    "maxRetry": 1              // max whole-workflow retries in a fresh chat on failure
  },
  "chrome": { "profileMode": "isolated" },
  "entries": [
    {
      "name": "coo",
      "pdfDir": "C:\\data\\coo_merged_output",     // parent folder; each subdir has PDFs
      "baseGenerator": "C:\\repo\\workflow\\generator.py", // base template to adapt
      "workflowDir": "C:\\repo\\workflow",         // dir with WORKFLOW.md + roles/*.txt
      "outDir": "C:\\data\\output"                 // optional; default <pdfDir>/output
    }
  ]
}
```

## Status handling

Each role turn ends with a structured handoff (`stage_status` +
`recommended_status_code` + issues + required reruns). The orchestrator, not a
`STATUS_CODE` line, decides routing:

- An **auditor** turn that reports `stage_status: "passed"` (with no unresolved
  critical/major issue) opens its gate.
- A recoverable **QA gate** failure (template, background, baseline, fidelity, edge, regression)
  triggers a **repair loop**: the Repair Engineer plans the smallest root-cause fix,
  the owning Template Architect or Generator Engineer applies it, and only the affected
  QA modes rerun (dependency map in
  [workflow/roles/07_REPAIR_ENGINEER.txt](workflow/roles/07_REPAIR_ENGINEER.txt)), up to
  `maxRepairRounds`.
- A non-recoverable stage failure (release, final) or an exhausted repair loop
  ends the PDF with the **causal** status code (from the failing stage / most-severe
  issue), matching `generator.py`'s codes (`10` input, `20` impl/import, `30`
  schema/API/manifest/self-test, `40` rendering, `50` annotation/coordinate/OTSL, `60`
  visual quality, `70` persistent output, `80` partial, `99` internal).
- The whole workflow is retried in a **fresh chat** up to `maxRetry` times on failure.

Status **0** requires the full set in the shared contract's authoritative "STATUS 0 DEFINITION": the
six QA gates passed, all 17 edge decisions resolved, reviewer≠writer, current orchestrator-verified
package hashes, the orchestrator's envelope built, and independent release + final approval, with the
Controller finalizing. Exhausted attempts are logged as failures; the batch continues to the next PDF.

## Run

```bash
node run-batch.mjs --config batch.config.json --show
# or
npm run batch -- --config batch.config.json
```

Flags (override the config): `--concurrency N`, `--timeout-ms MS`, `--show`,
`--headless`, `--regular-chat` (use normal chats instead of temporary), `--debug`.

Run just one (or a few) of the entry directories by `name`:

```bash
node run-batch.mjs --config batch.config.json --only invoices
node run-batch.mjs --config batch.config.json --only invoices,receipts
```

Chrome overrides via env: `AGENTIFY_DESKTOP_CHROME_BIN`,
`AGENTIFY_DESKTOP_CHROME_DEBUG_PORT`, `AGENTIFY_DESKTOP_CHROME_PROFILE_MODE`,
`AGENTIFY_DESKTOP_CHROME_PROFILE_NAME`.

### First run

A Chrome window opens on `chatgpt.com`. Sign in once. The session is stored in an
isolated profile under `~/.agentify-desktop/chrome-user-data` and reused on later
runs, so you only sign in again when it expires.

## Output

Per PDF, outputs go to `<outDir>/<subdir>/` (with `randomPerSubdir`) or
`<outDir>/NN-<pdfname>/` otherwise:

- the downloaded persistent files: `generator.py`, `manifest.json`, `generator_report.json`,
- `<pdf>.response.txt` — the full multi-turn workflow transcript (every role turn),
- `<pdf>.issues.json` — the append-only issue log from the run.

At the end the script prints a per-entry summary listing each PDF's final status, the
gates it passed, attempt count, and file count. Exit code is non-zero if any PDF failed.

## Notes

- A per-PDF failure is logged and the entry continues to the next PDF; entries are
  independent and run in parallel.
- ChatGPT must have code-interpreter + image viewing available: the roles run
  `generator.py`'s CLI in the chat sandbox and review the rendered artifacts visually.
- ChatGPT DOM selectors live in `selectors.json`. If ChatGPT's UI changes, drop a
  `selectors.override.json` in `~/.agentify-desktop/` to patch them without editing
  the file.
- Automating a logged-in ChatGPT session may be subject to rate limits; keep
  `concurrency` modest. The agentic workflow issues many turns per PDF, so runs are
  slower than a single-shot prompt.

## License

`MPL-2.0`. See `LICENSE`. Trademarks are not included in that license — see
`TRADEMARKS.md`.
