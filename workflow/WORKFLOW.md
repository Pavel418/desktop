# Agentic Workflow for Adapting the Scanned-Document Generator

## Purpose

This directory defines an external, role-separated workflow for adapting the stable
single-file generator (`generator.py`) to a new scanned template PDF. It reduces missed
details, confirmation bias, incomplete labels, unnatural placement, weak edge coverage,
and false success reports.

The runtime stays one `generator.py`. The agentic workflow is external: the JS
orchestrator (`../workflow-orchestrator.mjs`) sequences the roles as turns inside one
ChatGPT chat per PDF, enforces the gates, routes issues, and computes reruns. Nothing in
this workflow becomes a persisted runner inside `generator.py`.

## Files

| File | Purpose |
|---|---|
| `generator.py` | The base generator = the machine backbone the roles drive (not edited here; per-template edits happen at runtime in the model's sandbox) |
| `roles/00_SHARED_CONTRACT.txt` | Rules inherited by every role (incl. handoff + issue + envelope schemas) |
| `roles/01_CONTROLLER.txt` | Control policy (implemented mechanically by the JS orchestrator) |
| `roles/02_CONTRACT_AUDITOR.txt` | Preflight + release contract checks |
| `roles/03_TEMPLATE_ANALYST.txt` | Scan inspection and region classification |
| `roles/04_TEMPLATE_ARCHITECT.txt` | Geometry, fields, semantics → EDIT-ZONE plan |
| `roles/05_GENERATOR_ENGINEER.txt` | Background, implementation, repair, packaging (only writer of `generator.py`) |
| `roles/06_QA_AUDITOR.txt` | Template/background/baseline/edge/regression validation + builds the visual-review envelope |
| `roles/07_REPAIR_ENGINEER.txt` | Root-cause fixes and dependency-based reruns |
| `roles/08_FINAL_AUDITOR.txt` | Independent final release decision |

## Design principles

1. **Rendered pixels are the only visual truth.** OCR and PDF text extraction are forbidden.
2. **Creation and approval are separated.** A role that writes an artifact cannot approve it.
3. **Validation is machine and visual.** Bounding-box containment alone is insufficient.
4. **Failures are evidence-driven.** Missing evidence is not a pass.
5. **Repair is targeted.** Only affected checks rerun during iteration, then one clean full regression.
6. **The final package stays minimal.** Only `generator.py`, `manifest.json`, `generator_report.json` persist.

## The generator is the machine backbone

`generator.py` already implements the runtime contract; the roles drive its CLI
(`describe | schema | list-fields | self-test | assess | propose-missing |
make-weird-data | render | edge-cases | audit | validate-output`). Each command exits
with its numeric `status_code`.

Adapting a template = editing only the **GPT TEMPLATE EDIT ZONE** (metadata, coordinates,
`FIELD_CATALOG`, `ERASE_SPECS`, `STATIC_TEXT_CATALOG`, sample data), then validating with
the CLI. The stable runtime below the edit zone is reused, never rewritten.

### Two-phase audit + visual-review envelope

A Python program can't judge its own renders, so `audit` is two-phase:

- **Phase 1** — `audit --pdf P --output-dir O --seed 0`: runs all machine checks, writes
  reviewable artifacts under `O/_audit_artifacts/`, and returns **status 60** on purpose.
- **Visual review** — QA/Final roles open those artifacts at full resolution and, only
  if everything truly passes, emit a **visual-review envelope** (schema in
  `roles/00_SHARED_CONTRACT.txt`): 7 required checks + all 17 edge cases true,
  `reviewed_artifacts` as `{path, sha256}` covering every required artifact, `issues: []`.
- **Phase 2** — `audit ... --visual-review envelope.json`: reuses the byte-verified
  artifacts, validates the envelope, writes `manifest.json` + `generator_report.json`,
  cleans `_audit_artifacts/`, and returns **0** only if the envelope is complete,
  current, and passing. A stale or partial envelope yields 60. Status 0 is therefore
  impossible without a genuine external visual review.

## Execution sequence

```text
1.  Orchestrator opens one chat per PDF (target PDF + generator.py attached).
2.  Contract Auditor (preflight): CLI/API/manifest/self-test.
3.  Template Analyst: scan inventory.
4.  Template Architect: EDIT-ZONE plan (template_spec.json).
5.  Generator Engineer (implementation): writes the edit zone (geometry, fields,
    ERASE_SPECS, static text); runs self-test; runs audit phase 1 — one pass produces
    master_overlay, reconstructed_background, normal/stress samples, all 17 edges.
6.  QA Auditor (template): master_overlay vs scan.
7.  QA Auditor (background): reconstructed_background before generated text is trusted.
8.  QA Auditor (baseline): normal + fully populated stress samples.
9.  Repair loop until template/background/baseline pass (targeted reruns).
10. QA Auditor (edge): all 17 cases individually.
11. Repair loop until all cases pass.
12. QA Auditor (regression): clean full run; then builds the visual-review envelope.
13. Generator Engineer (package): audit phase 2 with the envelope → expects status 0.
14. Contract Auditor (release): manifest/report/CLI/PDF/cleanup/persistent files.
15. Final Auditor: independent decision that status 0 is envelope-backed.
16. Orchestrator downloads the 3 persistent files and emits the numeric status.
```

The Generator Engineer's "background mode" (reconstruction-focused edits) and
"implementation mode" (field placement) are two emphases of one edit-zone pass: because
`audit` renders the background, samples, and edges together, a single phase-1 run
produces every artifact the QA gates below review.

## Stage gates

- **Preflight** — base runtime, edit zone, public API, and CLI understood; `self-test` passes.
- **Template** — master overlay correctly represents tables, cells, fields, keys, containers, layout, semantic images, reconstruction regions.
- **Background** — cleaned background has no source value, damaged label, broken grid line, seam, or inappropriate blank patch.
- **Baseline** — normal + stress samples pass machine validation, label validation, complete visible-text coverage, and full-resolution review.
- **Edge** — all 17 edge cases generated and inspected individually; expected failures fail for the correct reason and code.
- **Regression** — the full suite runs from a clean temporary directory with no repairs during the run.
- **Release** — manifest, reports, CLI status, PDF output, cleanup, and persistent files satisfy the contract; phase-2 audit returns 0.
- **Final** — the independent Final Auditor confirms every mandatory check is supported by current evidence.

## Required edge cases

`normal_random_placement`, `top_left_placement`, `bottom_right_placement`,
`wide_glyph_pressure`, `narrow_glyph_pressure`, `long_unbroken_strings`, `punctuation`,
`multilingual_text`, `dense_multiline_text`, `minimum_font_size`,
`maximum_permitted_character_length`, `low_dpi`, `high_dpi`, `text_near_field_edges`,
`shared_collision_groups`, `expected_max_chars_failure`, `expected_impossible_fit_failure`.

Each case has its own result. A contact sheet is navigation only and cannot replace
full-resolution review.

## Communication

Roles exchange structured handoffs (see `roles/00_SHARED_CONTRACT.txt`), artifact paths
with hashes, concise issue records, and rerun requirements — not long narratives or
hidden reasoning. Issue states: `open`, `fixed`, `verified`, `blocked`. A Repair Engineer
may mark an issue `fixed`; only an independent auditor may mark it `verified`.

## Repair and rerun strategy

Escalate only as needed: parameter → field → cell → region → section → full form.
Do not weaken checks, shorten test values, disable edge cases, suppress errors, or change
labels to agree with an incorrect render. After targeted repairs pass, always run one
clean full regression. Any edit invalidates the previous envelope (hashes change), so a
fresh QA review + envelope is always required before release. The full rerun dependency
map is in `roles/07_REPAIR_ENGINEER.txt` and is enforced by the orchestrator's `RERUN_MAP`.

## Final output contract

After success, persist only:

```text
generator.py
manifest.json
generator_report.json
```

The final response links only those files and ends with the exact line
`STATUS_CODE: <n>` (nothing after it), matching the numeric status the orchestrator
records.
