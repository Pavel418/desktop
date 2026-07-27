# Process exit-code policy

Requirement 7 centralizes and tests the batch runner's process exit codes.

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | The run completed successfully |
| `1` | At least one PDF failed, an entry aborted, a fatal error occurred, or expected outputs were incomplete |
| `130` | Interrupted by `SIGINT` |
| `143` | Interrupted by `SIGTERM` |
| `149` | Interrupted by `SIGBREAK` |

Unknown interruption signals fall back to `130`.

## Success criteria

A normal run exits `0` only when:

- no entry aborted,
- no entry reported a fatal error,
- no PDF recorded an error,
- no PDF had an incomplete expected output set.

This means Requirement 4's output-completeness result now participates in the final exit decision.

## Fatal errors

Fatal startup and top-level failures exit non-zero. The fatal `summary.json` and `run_fatal` structured event use the same exit code as the process.

## Consistency

The following now use the same centralized policy:

- `process.exitCode`
- signal termination
- `summary.json`
- `run_completed`
- `run_fatal`
- `signal_received`
