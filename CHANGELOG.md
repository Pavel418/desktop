# Changelog

## Unreleased

### Changed
- Replaced the single-shot prompt mode with an **agentic, role-separated workflow**. For each PDF the driver now runs one ChatGPT chat through a fixed sequence of roles — Contract Auditor (preflight) → Template Analyst → Template Architect → Generator Engineer → QA Auditor (template, background, baseline, edge, regression) → Repair loop → package (audit phase 2 with a visual-review envelope) → Contract Auditor (release) → Final Auditor — with creation and approval separated, evidence-driven stage gates, targeted repair reruns, and the two-phase `audit` + visual-review-envelope contract of `generator.py`.
- Added `workflow-orchestrator.mjs` (the mechanical Controller: gate state machine, structured-handoff parsing, append-only issue log, rerun dependency map, causal status-code selection) and rewrote `run-batch.mjs` to drive it.
- The agentic workflow documents are now tracked in the repo under `workflow/` (`WORKFLOW.md`, `roles/*.txt`, and the base `generator.py`).
- `batch.config.json` now takes `baseGenerator` + `workflowDir` (instead of `template` + `promptFile`) and a `workflow` block (`maxRepairRounds`, `perTurnTimeoutMs`, `successCode`, `maxRetry`).

### Removed
- Removed the monolithic single prompt (`input/prompt.txt`), the `continueCodes`/`continueMessage`/`maxContinue` "continue" nudging, the fresh-chat status-code retry policy, and schema chaining (`chainSchema`). Only the agentic workflow remains.

## 0.3.0 - 2026-07-20

### Changed
- Repurposed the project into a single headless batch script (`run-batch.mjs`): walk directories of PDFs, send each PDF + a per-directory Python template into its own ChatGPT chat, chain a generated schema file across a directory's PDFs, and download the generated files. Entry directories run in parallel; PDFs within a directory run sequentially.
- Configuration is now a `batch.config.json` describing the entry directories.

### Removed
- Removed the MCP server, the Codex orchestrator, the Electron GUI / Control Center, the local HTTP API, the Electron browser backend, and the context-packer / bundle-store / artifact-store / watch-folder features. Only the Chrome-CDP browser backend and the ChatGPT controller are retained.
- Dropped all npm dependencies (`electron`, `@modelcontextprotocol/sdk`, `zod`, `electron-builder`); the tool now runs on Node built-ins only.

## 0.2.4 - 2026-05-17

### Fixed
- Fixed Windows Chrome CDP startup by spawning the Chrome/Edge/Brave executable directly without a shell.
- Added a regression test to keep Chrome CDP spawn options shell-free on every platform.

## 0.2.3 - 2026-05-17

### Fixed
- Fixed the Windows npm/global GUI launcher path by running Electron through its package CLI with Node instead of the Windows `.cmd` shim.
- Applied the same safer Electron launch resolution to MCP desktop auto-start.

### Changed
- Added Windows CI coverage for install/test and the npm CLI help path.
- Added README Windows notes for Chrome CDP and explicit browser executable configuration.

## 0.2.2 - 2026-05-17

### Fixed
- Restored the full governor UI from the prepared release work: digit-only inputs, narrow two-column layout, safe default values, and protection against live refresh wiping unsaved edits.
- Added the missing risk-disclaimer modal linked from the governor acknowledgement text.
- Restored the compact two-line footer with activity summary and color-coded status messages.
- Added bulk tab visibility bridge methods so the header show/hide-all control can use one desktop IPC call when available.
- Made Chrome CDP the first browser backend option in the Control Center.

### Verified
- Control Center script syntax check passed.
- Public package dry-run excludes private workflows.

## 0.2.1 - 2026-05-17

### Fixed
- Restored the intended icon-only Control Center header controls for opening the default tab, watch folder, artifacts folder, state folder, and refresh.
- Added the missing show/hide-all managed tabs toggle in the Control Center header.
- Kept the Orchestrator UI hidden from the Control Center public surface.

### Verified
- Control Center script syntax check passed.
- Public package dry-run excludes private workflows.

## 0.2.0 - 2026-05-17

### Added
- First npm-ready public package flow for `@agentify/desktop`, including npx/global CLI entrypoints for the desktop app and MCP server.
- Chrome CDP browser backend as the recommended path for real signed-in provider sessions, with Electron kept available as an explicit fallback.
- Agentify Control Center for managing vendor tabs, showing/hiding browser windows, inspecting activity, opening local state, and tuning runtime settings.
- Multi-vendor MCP workflow coverage for ChatGPT, Claude, Perplexity, Gemini, Google AI Studio, and Grok.
- Stable tab keys so parallel agent jobs can reuse the right browser session without mixing project context.
- Artifact workflows for saving generated files/images locally and reattaching them in follow-up prompts.
- Context packing and bundle workflows so agents can send selected repo/file context to a web AI session without manual copy/paste.
- Watch-folder support for indexing local output folders and making generated files easier to reuse.
- Governor safety controls for reducing accidental high-rate automation, including concurrency and pacing limits.
- README prompt examples for common MCP workflows after Agentify is installed.
- Explicit `.gitignore` protection for local-only private workflows.

### Changed
- Chrome CDP is the documented default browser engine because embedded Electron login flows are often blocked by SSO providers.
- README examples now focus on generic browser automation, artifact saving, context packing, and multi-vendor review workflows.
- MCP/tooling language is clearer about multi-vendor AI web UI automation instead of implying ChatGPT-only behavior.
- Control Center stale bridge errors now explain that the desktop app may need to be restarted after updating.
- Release packaging now keeps public npm contents focused on the generic desktop/MCP tool rather than domain-specific internal workflows.
- Removed private/domain-specific workflow language from public docs and package guidance.
- Updated package version from 0.1.2 to 0.2.0.

### Fixed
- MCP desktop auto-start resolves the bundled Electron binary relative to the Agentify package instead of the caller's current working directory.
- Package tests no longer assume the checkout directory is literally named `desktop`.
- Public README links now use repo-relative paths instead of local machine paths.

### Verified
- Published `@agentify/desktop@0.2.0` to npm with `latest` dist-tag.
- GitHub release `v0.2.0` published from the merged main branch.
- GitHub Actions CI passed for the release PR.
- Local test suite passed: 162/162 tests.
- Public package dry-run excludes private workflows.
- Public source scan excludes private workflow tool and module references.
