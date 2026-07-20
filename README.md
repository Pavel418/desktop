# pdf-chatgpt-batch

A headless Node script that batch-processes directories of PDFs through ChatGPT
in your own signed-in browser session, and downloads the files ChatGPT generates.

It drives a real Chrome window over the Chrome DevTools Protocol — no API keys,
no MCP server, no GUI. You stay logged into ChatGPT in an isolated Chrome profile.

## How it works

You define one or more **entry directories** in `batch.config.json`. Each entry
has its own PDFs, its own static Python template, and its own prompt.

- **Entry directories run in parallel** (bounded by `concurrency`).
- PDF selection per entry:
  - default: process every PDF in the directory sequentially;
  - `randomOne`: pick ONE random PDF from the directory;
  - `randomPerSubdir`: pick ONE random PDF from **each immediate subdirectory**
    (output is grouped by subdirectory name).
- Each PDF is processed in its **own chat** (a **temporary chat** by default — never
  in a project, not saved to ChatGPT history), with the PDF and Python template
  attached.
- Generated files are captured by **clicking each file button ChatGPT shows, opening
  its preview, and clicking Download** (captured via CDP). Real `<a>` download links
  and fenced code blocks are also saved as fallbacks.
- Each chat's **full reply text** is saved to `<pdf>.response.txt` (temporary chats
  aren't saved by ChatGPT, so we log them ourselves).
- The reply is expected to end with a **`STATUS_CODE: N`** line, which drives
  continue/retry handling (see **Status handling**).
- Optional **schema chaining** (`chainSchema`, multi-PDF entries only): the first
  PDF's generated schema file is attached to every later PDF in that entry.

## Requirements

- Node.js 20 or newer
- Google Chrome (or Chromium / Brave / Edge) installed

## Configure

Copy and edit `batch.config.json`:

```jsonc
{
  "concurrency": 1,            // max entry directories in parallel
  "timeoutMs": 900000,         // per-PDF timeout (also covers thinking + first-run sign-in)
  "show": true,                // show the Chrome windows
  "temporaryChat": true,       // use temporary chats (no project, no history)
  "randomPerSubdir": true,     // one random PDF from each subdirectory of pdfDir
  "status": {
    "successCode": 0,          // STATUS_CODE that means "done"
    "continueCodes": [70, 80], // codes that trigger a "continue" nudge in the same chat
    "continueMessage": "continue",
    "maxContinue": 3,          // max "continue" nudges per chat
    "maxRetry": 1              // max fresh-chat retries for other non-zero codes
  },
  "chrome": { "profileMode": "isolated" },
  "entries": [
    {
      "name": "coo",
      "pdfDir": "C:\\data\\coo_merged_output",  // parent folder; each subdir has PDFs
      "template": "C:\\data\\generator.py",
      "promptFile": "C:\\data\\prompt.txt",     // or "prompt": "...inline..."
      "outDir": "C:\\data\\output"              // optional; default <pdfDir>/output
    }
  ]
}
```

## Status handling

The script reads the last `STATUS_CODE: N` line in each reply and acts on it:

- **`0`** (or any code in `successCode`) → success; save the generated files.
- codes in **`continueCodes`** (default `70`, `80`) → send `"continue"` in the **same
  chat** to finish, up to `maxContinue` times.
- any other **non-zero** code → **retry** the whole prompt in a **fresh chat**, up to
  `maxRetry` times.
- if the reply has **no** `STATUS_CODE`, outputs are saved anyway (with a warning).

Exhausted attempts are logged as failures with the final status code; the batch
continues to the next PDF.

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

- the downloaded generated files (e.g. `generator.py`, `manifest.json`, …),
- `<pdf>.response.txt` — the chat's full reply text (including any `continue` turns).

At the end the script prints a per-entry summary listing each chat's `STATUS_CODE`,
attempt count, and file count. Exit code is non-zero if any PDF failed.

## Notes

- A first-PDF failure (or no download matching `schemaNamePattern`) aborts **that
  entry only**; other entries keep running. A later-PDF failure is logged and the
  entry continues.
- ChatGPT DOM selectors live in `selectors.json`. If ChatGPT's UI changes, drop a
  `selectors.override.json` in `~/.agentify-desktop/` to patch them without editing
  the file.
- Automating a logged-in ChatGPT session may be subject to rate limits; keep
  `concurrency` modest.

## License

`MPL-2.0`. See `LICENSE`. Trademarks are not included in that license — see
`TRADEMARKS.md`.
