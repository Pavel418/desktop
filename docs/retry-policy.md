# Error taxonomy and retry policy

This document defines the fixed error categories used by the batch runner. It documents the behavior already implemented by the runner; it does not add new retries or change workflow decisions.

## Categories

| Category | Meaning | Retry scope |
|---|---|---|
| `infrastructure` | Provider, upload, send, browser-session, or response-delivery failure | Infrastructure retry budget |
| `workflow` | The workflow completed but returned a failing status or gate result | Workflow retry budget |
| `configuration` | Invalid or missing configuration, paths, entries, or required files | No retry |
| `interrupted` | The process received a termination signal or was intentionally stopped | No retry |
| `unknown` | An error that does not match a fixed known code | No automatic infrastructure retry |

## Infrastructure error codes

The following codes use the existing infrastructure retry budget:

- `chatgpt_server_error`
- `attachment_upload_rejected`
- `attachment_upload_incomplete`
- `attachment_not_registered`
- `send_not_triggered`
- `response_stalled_no_output`
- `timeout_waiting_for_response`
- `already_generating`
- `send_failed`
- `type_failed`

An error object carrying `retryable: true` is also treated as an infrastructure error. This preserves the runner's previous behavior.

## Retry budgets

### Infrastructure retries

Infrastructure failures do not consume the workflow retry budget.

The existing default infrastructure budget is three retries. The existing default waits are:

1. 30 seconds
2. 120 seconds
3. 300 seconds

Configuration may override the infrastructure retry count and backoff list.

### Workflow retries

A completed workflow with a failing status, or a non-infrastructure thrown error handled by the existing workflow retry branch, consumes the workflow retry budget.

The existing default workflow retry budget is one retry.

### No retry

Configuration, interruption, and unknown errors are not automatically classified as infrastructure-retryable.

The runner's existing control flow remains authoritative. The taxonomy records and explains the decision; it does not introduce a new retry branch.

## Structured log fields

Failure and retry events include:

- `errorCategory`
- `errorCode`
- `retryable`
- `retryScope`

These fields appear alongside the correlation fields introduced in Requirement 1:

- `runId`
- `entryName`
- `pdfStem`
- `attemptNumber`
