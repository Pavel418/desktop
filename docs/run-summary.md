# Per-run summary.json

Requirement 6 writes a machine-readable summary for every batch run after a run directory has been created.

## Location

```text
~/.agentify-desktop/runs/<runId>/summary.json
```

The file is written atomically through a temporary file and rename, preventing partially written JSON from appearing as the final summary.

## Contents

The summary contains:

- schema version
- run ID
- success and exit code
- start, finish, and duration
- config, run-directory, JSONL-log, and summary paths
- entry, PDF, attempt, retry, output, and failure counts
- per-entry status
- per-PDF status, error, duration, attempts, retries, gates, and output paths
- output-completeness results from Requirement 4
- fatal error details when the run fails outside normal entry processing

## Structured logging

A successful summary write emits:

```text
run_summary_written
```

The existing `run_completed` and `run_fatal` events include the summary path.

## Behavior

Summary generation does not change:

- workflow execution,
- retry decisions,
- browser interactions,
- downloads,
- existing status interpretation,
- process exit-code selection.
