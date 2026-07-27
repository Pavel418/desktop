# Agentic workflow for scanned-document generator adaptation

## Goal

Adapt a stable single-file generator to one selected page of an image-only scanned PDF. Generated documents should strongly resemble the source through accurate table geometry, static structure, text anchors, alignment, baselines, font metrics, color, and line spacing.

The workflow never uses OCR or PDF text extraction and never adds artificial scan degradation.

## Package contents

| File | Purpose |
|---|---|
| `00_SHARED_CONTRACT.txt` | Rules inherited by every role |
| `01_CONTROLLER.txt` | Stage order, gates, issue routing, and reruns |
| `02_CONTRACT_AUDITOR.txt` | Isolated release validation |
| `03_TEMPLATE_ANALYST.txt` | Visual scan inventory and template lock |
| `04_TEMPLATE_ARCHITECT.txt` | Tables, cells, static text, fields, semantics, and reconstruction plan |
| `05_GENERATOR_ENGINEER.txt` | Background, implementation, repair application, and package writing |
| `06_QA_AUDITOR.txt` | Template, background, baseline, fidelity, edge, and regression review |
| `07_REPAIR_ENGINEER.txt` | Root-cause repair planning and rerun dependencies |
| `08_FINAL_AUDITOR.txt` | Independent release decision |

## Prompt order

1. **Shared Contract** is supplied to every role. It carries a static BASE GENERATOR MAP (edit-zone
   markers, public API, defaults) so roles do not need to rediscover the fixed base runtime.
2. **Controller** opens the run and enforces ownership and gates. The base generator's soundness is
   asserted mechanically by the orchestrator (byte-hash identity gate), not by an LLM audit.
3. **Template Analyst** creates the scan inventory and locks the target page by rendered-pixel hash.
4. **Template Architect** creates the complete template specification and master overlay. `template_spec.json` follows the pinned key schema in `04_TEMPLATE_ARCHITECT.txt`, and every pass condition is backed by a measured counter in `evidence_counters` — the auditor validates those exact key names and reopens any condition asserted without its measurement.
5. **QA Auditor, template** reviews all geometry, fields, cells, keys, static text, images, and reconstruction masks.
6. **Generator Engineer, background** creates the clean hybrid background.
7. **QA Auditor, background** checks source-value removal, static structure, seams, and preserved pixels.
8. **Generator Engineer, implementation** adapts generator.py and creates normal and stress samples with all labels.
9. **QA Auditor, baseline** performs complete machine, visual, and visible-text coverage audits.
10. **QA Auditor, fidelity** compares source structure and generated placement conventions.
11. **Repair loop** repeats Generator Engineer or Template Architect changes, QA verification, and dependency-based reruns until baseline and fidelity pass.
12. **QA Auditor, edge** runs and reviews all 17 cases one by one.
13. **Repair loop** repeats only affected tests, followed by the complete edge suite.
14. **QA Auditor, regression** runs all clean machine stages from isolated directories.
15. **Generator Engineer, package** writes manifest.json and generator_report.json and cleans temporary outputs.
16. **Controller** assembles and validates the visual-review envelope from the retained QA reviews (six gates, 17 individual edge decisions, reviewer identity distinct from every writer, model-claimed artifact hashes), computes real SHA-256 of the three persistent files, and cross-checks generator_report.json (`checks.visual_quality`) — failing closed if incomplete. This envelope is what the release and final auditors receive.
17. **Contract Auditor, release** checks runtime and package correctness against that envelope.
18. **Final Auditor** independently approves or rejects release.
19. **Controller** emits the final result.

## Why stages are isolated

Image rendering, high-DPI tests, exhaustive per-field fitting probes, overlays, and PDF checks can consume substantial memory. Run heavy machine phases in separate clean invocations and merge their stage reports afterward. This prevents stale state, memory pressure, and one long monolithic call from hiding which stage failed.

Recommended machine stage sequence:

```text
self-test
-> template/background stage
-> normal and stress stage
-> edge-case stage
-> edge overlay stage
-> determinism/canonical/PDF regression stage
-> artifact manifest
-> independent visual review
-> package
```

The Controller may retry one isolated stage without rerunning unrelated passed stages. After all targeted repairs, it must run one clean complete regression.

## Gates and loops

### Base generator identity gate

The base generator is a fixed, known-good, single file the orchestrator attaches itself. Rather than
pay an LLM to re-inventory and re-validate it every run (which re-derived the same static facts and
could hallucinate defects into a clean file), the orchestrator verifies its SHA-256 mechanically
before any model turn:

```text
orchestrator computes sha256(generator.py)
-> logs it (auditable run record)
-> if config.expectedGeneratorSha256 is set and differs -> fail fast, status 20, no model turns
```

The static facts the old preflight produced (edit-zone location, public API, defaults) now live in
the BASE GENERATOR MAP inside the Shared Contract, so roles start already oriented.

### Template loop

```text
Template Analyst
-> Template Architect
-> QA template review
-> geometry/static/semantic repair
-> repeat until passed or blocked
```

### Background loop

```text
Generator Engineer background
-> QA background review
-> reconstruction repair
-> repeat until passed or blocked
```

### Baseline and fidelity loop

```text
Generator implementation
-> normal/stress machine validation
-> baseline visual and label coverage review
-> fidelity review
-> root-cause repair
-> rerun affected checks
-> repeat
```

### Edge loop

Each edge case is an independent sub-run. Do not batch-approve.

```text
render one case
-> output-contract validation
-> full-resolution document review
-> field/glyph overlay review
-> label review
-> case decision
-> repair and rerun when needed
```

Expected-failure cases pass only when they fail for the specified reason and leave no successful or stale document.

### Final loop

```text
clean regression
-> package
-> release contract audit
-> independent final audit
```

A final-audit finding reopens the owning earlier stage.

## Review artifacts

The minimum review set includes:

- scan inventory overlay
- master table/cell/field overlay
- reconstruction mask and background
- normal and stress documents
- baseline field/glyph, layout, and table-cell overlays
- complete baseline labels and reports
- every edge document and report
- a field/glyph overlay for every visually sensitive edge case
- all edge labels
- per-field max-length and minimum-font probe reports
- regression reports
- artifact manifest with hashes

Do not repeatedly regenerate invariant table and layout overlays for every edge case. Review them once through the approved master/baseline overlays, then validate edge label files programmatically and use case-specific field/glyph overlays.

## Communication

Agents exchange structured handoffs and append-only issue records. Passing stages return compact evidence. Failures return exact issue codes, artifacts, fields/tables/cells, and required reruns. Do not transmit narrative reasoning when structured evidence is sufficient.

## Status policy

Only the Controller and Final Auditor assign the global status. The first causal failure determines the code; all secondary errors remain in the report. Status 0 requires the authoritative set defined under "STATUS 0 DEFINITION" in the shared contract: the six QA gates passed, all 17 individual edge decisions resolved, reviewer identity distinct from every writer, current orchestrator-verified package hashes, independent release and final approval, and exact final cleanup.

## Final persistent outputs

After successful validation, retain only:

```text
generator.py
manifest.json
generator_report.json
```
