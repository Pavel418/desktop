# Output and download completeness monitoring

Requirement 4 verifies the three persistent workflow outputs after each orchestrator attempt returns:

- `generator.py`
- `manifest.json`
- `generator_report.json`

The check confirms that every expected file:

1. was reported by the workflow,
2. exists at the reported path,
3. is a regular file,
4. is not empty.

It also records duplicate expected names and unexpected extra outputs.

## Structured event

Each completed attempt emits:

```text
output_completeness_checked
```

The event contains:

- `complete`
- `expectedFileNames`
- `observedFileNames`
- `missingFileNames`
- `emptyFileNames`
- `unreadableFileNames`
- `duplicateFileNames`
- `extraFileNames`
- `verifiedFileCount`
- `totalBytes`
- `fileDetails`

The same high-level completeness fields are included in `attempt_completed` and `pdf_completed`.

## Behavior

This requirement is monitoring-only:

- it does not alter browser behavior,
- it does not add retries,
- it does not alter workflow status codes,
- it does not change the existing process exit decision.

An incomplete output set is written as a warning in both the human-readable log and the structured JSON log. Later requirements may use this information in `summary.json` or exit-code policy.
