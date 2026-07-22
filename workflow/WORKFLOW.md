# Agentic workflow for scanned-document generator adaptation

## Goal

Adapt a stable single-file generator to one selected page of an image-only scanned PDF. Generated documents should strongly resemble the source through accurate table geometry, static structure, text anchors, alignment, baselines, font metrics, color, and line spacing.

The workflow never uses OCR or PDF text extraction and never adds artificial scan degradation.

## Package contents

| File | Purpose |
|---|---|
| `00_SHARED_CONTRACT.txt` | Rules inherited by every role |
| `01_CONTROLLER.txt` | Stage order, gates, issue routing, and reruns |
| `02_CONTRACT_AUDITOR.txt` | Runtime preflight and release validation |
| `03_TEMPLATE_ANALYST.txt` | Visual scan inventory and template lock |
| `04_TEMPLATE_ARCHITECT.txt` | Tables, cells, static text, fields, semantics, and reconstruction plan |
| `05_GENERATOR_ENGINEER.txt` | Background, implementation, repair application, and package writing |
| `06_QA_AUDITOR.txt` | Template, background, baseline, fidelity, edge, and regression review |
| `07_REPAIR_ENGINEER.txt` | Root-cause repair planning and rerun dependencies |
| `08_FINAL_AUDITOR.txt` | Independent release decision |

## Prompt order

1. **Shared Contract** is supplied to every role.
2. **Controller** opens the run and enforces ownership and gates.
3. **Contract Auditor, preflight** inventories the base runtime and identifies permitted edits.
4. **Template Analyst** creates the scan inventory and locks the target page by rendered-pixel hash.
5. **Template Architect** creates the complete template specification and master overlay.
6. **QA Auditor, template** reviews all geometry, fields, cells, keys, static text, images, and reconstruction masks.
7. **Generator Engineer, background** creates the clean hybrid background.
8. **QA Auditor, background** checks source-value removal, static structure, seams, and preserved pixels.
9. **Generator Engineer, implementation** adapts generator.py and creates normal and stress samples with all labels.
10. **QA Auditor, baseline** performs complete machine, visual, and visible-text coverage audits.
11. **QA Auditor, fidelity** compares source structure and generated placement conventions.
12. **Repair loop** repeats Generator Engineer or Template Architect changes, QA verification, and dependency-based reruns until baseline and fidelity pass.
13. **QA Auditor, edge** runs and reviews all 17 cases one by one.
14. **Repair loop** repeats only affected tests, followed by the complete edge suite.
15. **QA Auditor, regression** runs all clean machine stages from isolated directories.
16. **Generator Engineer, package** writes manifest.json and generator_report.json and cleans temporary outputs.
17. **Contract Auditor, release** checks runtime and package correctness.
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

### Preflight repair loop

Target-specific placeholders and a mismatched starter document family are expected
adaptation work and do not fail preflight. Genuine reusable-runtime defects are repaired
before scan analysis:

```text
Contract Auditor preflight
-> Repair Engineer plan
-> Generator Engineer runtime repair
-> Contract Auditor preflight re-audit
```

The workflow stops only when the reusable runtime cannot be repaired within the configured
round limit.

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

Only the Controller and Final Auditor assign the global status. The first causal failure determines the code; all secondary errors remain in the report. Status 0 requires every mandatory machine gate, all 17 individual edge decisions, current artifact hashes, independent visual approval, and exact final cleanup.

## Final persistent outputs

After successful validation, retain only:

```text
generator.py
manifest.json
generator_report.json
```
