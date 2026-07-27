# Browser and download failure diagnostics

Requirement 5 captures browser evidence when an attempt throws or when the persistent output set is incomplete.

## Artifact location

```text
~/.agentify-desktop/runs/<runId>/
  entries/
    <entryName>/
      <pdfStem>/
        attempt-<number>/
          <reason>/
            workflow.png
            workflow.html
            audit.png
            audit.html
            diagnostics.json
```

Audit artifacts are written only when an isolated audit page exists.

## Capture triggers

Diagnostics are attempted for:

- thrown browser, provider, upload, response, or workflow errors,
- missing, empty, duplicate, or unreadable persistent outputs.

## Structured events

The JSONL run log emits one of:

- `failure_diagnostics_captured`
- `failure_diagnostics_unavailable`

The event records the diagnostic directory, files, capture errors, reason, and page count.

## Behavior

Diagnostic capture is best-effort and monitoring-only:

- screenshot failure does not prevent HTML capture,
- HTML failure does not prevent screenshot capture,
- diagnostic failure does not replace the original error,
- retries, workflow status, downloads, and exit behavior are unchanged.
