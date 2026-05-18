# Agentify Desktop

Agentify Desktop is a local-first desktop app that lets AI coding tools drive your **existing web subscriptions** through a real, logged-in browser session on your machine.

It exposes an **MCP server** so tools like Codex can:
- Send prompts to the web UI and read back the response
- Run multiple parallel jobs via separate “tabs” (separate windows; shared login session by default)
- Upload local files (best-effort; depends on the target site UI)
- Download generated images (best-effort; supports `<img>` and `canvas` render paths)

## Example prompts after MCP setup
Once Agentify Desktop is running and registered as an MCP server, you can ask Codex for workflows like:

- “Use Agentify to ask ChatGPT for a second opinion on this bug, then compare its answer with your own analysis.”
- “Open a Perplexity tab with key `research-auth-flow` and research current OAuth best practices for desktop apps.”
- “Send this implementation plan to Claude in a separate Agentify tab and summarize any risks it finds.”
- “Use Agentify to generate three logo concepts in ChatGPT, then download the images into this project.”
- “Use Agentify to generate three UI concept images for this feature and save the downloaded files in the project.”
- “Open Grok and ChatGPT in separate Agentify tabs, ask both to review this API design, then compare the tradeoffs.”
- “Create separate Agentify tabs for `frontend-review` and `backend-review`, run both prompts in parallel, and merge the useful feedback.”
- “Read the current ChatGPT page through Agentify and turn the conversation into actionable TODOs.”

## Supported sites
The automation controller uses shared selector fallbacks across supported AI web apps. Site UIs change often, so some actions are still best-effort.

**Supported**
- `chatgpt.com`
- `perplexity.ai`
- `claude.ai`
- `gemini.google.com`
- `aistudio.google.com`
- `grok.com`

## CAPTCHA policy (human-in-the-loop)
Agentify Desktop does **not** attempt to bypass CAPTCHAs or use third-party solvers. If a human verification appears, the app pauses automation, brings the relevant window to the front, and waits for you to complete the check manually.

## Install
Requirements:
- Node.js 20+ (22 recommended)

## Install from source
From anywhere:
```bash
git clone git@github.com:agentify-sh/desktop.git
cd desktop
./scripts/quickstart.sh
```

To make newly-created tab windows visible by default (debug-friendly):
```bash
./scripts/quickstart.sh --show-tabs
```

Install dependencies:
```bash
npm i
```

## Install from npm
```bash
npm install -g @agentify/desktop
agentify-desktop
```

Or run without installing globally:
```bash
npx @agentify/desktop
```

## Run
Start the desktop app:
```bash
npm run start
```

The **Agentify Control Center** opens. Use it to:
- Show/hide tabs (each tab is a separate window)
- Create tabs for supported vendors
- Choose the browser backend
- Tune automation safety limits (governor)

Sign in to the target site in the tab window.

## Browser backend
Agentify defaults to **Chrome CDP**, which launches and drives a real Chrome-family browser through the Chrome DevTools Protocol. This is the recommended engine because Google and other SSO providers frequently block embedded Electron/WebView login flows.

Default backend:
- Browser backend: `chrome-cdp`
- Chrome profile mode: `agentify`
- User data directory: `~/.agentify-desktop/chrome-user-data/`
- Language/locale: forced to English (`en-US`) at Chrome launch and CDP session level

Electron remains available for local testing, but Agentify no longer silently falls back from Chrome CDP to Electron. If Chrome CDP fails, startup fails loudly so agents do not accidentally use an embedded browser for logged-in provider workflows. To intentionally allow fallback, set `AGENTIFY_DESKTOP_ALLOW_ELECTRON_FALLBACK=true`.
```bash
agentify-desktop --browser-backend electron
```

Chrome backend options:
```bash
agentify-desktop --browser-backend chrome-cdp
agentify-desktop --chrome-binary "/path/to/chrome"
agentify-desktop --chrome-debug-port 9222
agentify-desktop --chrome-profile-mode agentify
agentify-desktop --chrome-profile-mode existing
agentify-desktop --chrome-profile-mode attach
agentify-desktop --chrome-profile-mode isolated
```

Environment equivalents:
```bash
AGENTIFY_DESKTOP_BROWSER_BACKEND=chrome-cdp
AGENTIFY_DESKTOP_CHROME_BIN=/path/to/chrome
AGENTIFY_DESKTOP_CHROME_DEBUG_PORT=9222
AGENTIFY_DESKTOP_CHROME_PROFILE_MODE=agentify
```

Use `agentify` profile mode for normal operation. It uses a dedicated persistent Chrome profile under `~/.agentify-desktop/chrome-user-data/`, so you sign in to ChatGPT or another provider once in the Agentify Chrome window and Agentify keeps that session for future runs. This is the default because Chrome no longer allows remote debugging against the normal default profile without a separate `--user-data-dir`.

Use `existing` only for advanced/manual debugging with a normal Chrome user data directory. This can fail when Chrome refuses remote debugging on the default profile or when your regular Chrome is already running.

Use `attach` profile mode when a Chrome-family browser is already open with remote debugging enabled and you want Agentify to reuse that browser session instead of launching a new one. Example:
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.agentify-desktop/chrome-user-data" \
  --lang=en-US

AGENTIFY_DESKTOP_BROWSER_BACKEND=chrome-cdp \
AGENTIFY_DESKTOP_CHROME_PROFILE_MODE=attach \
AGENTIFY_DESKTOP_CHROME_DEBUG_PORT=9222 \
agentify-desktop
```

Use `isolated` only as a legacy alias for a separate Agentify-only browser profile. Prefer `agentify` unless you intentionally need a disposable or alternate profile.

## Connect from Codex (MCP)
Add the MCP server:
```bash
codex mcp add agentify-desktop -- node mcp-server.mjs
```

For npm/global installs:
```bash
codex mcp add agentify-desktop -- agentify-desktop mcp
```

Then use tools like `agentify_query` and pass a stable `key` (e.g. your repo name) to run parallel jobs without mixing contexts. Pass `vendorId` when creating a non-ChatGPT tab, for example `perplexity` or `grok`.

If you already had Codex open, restart it (or start a new session) so it reloads MCP server config. You can confirm registration via `codex mcp list`.

## How to use (practical)
- **Use a site normally (manual):** open the tab, write a plan/spec in the UI, then in Codex call `agentify_read_page` to pull the transcript into your workflow.
- **Drive a site from Codex:** call `agentify_ensure_ready`, then `agentify_query` with a `prompt`. Use a stable `key` per project to keep parallel jobs isolated.
- **Create a vendor tab:** use `agentify_tab_create` with `vendorId` such as `chatgpt`, `perplexity`, `claude`, `gemini`, `aistudio`, or `grok`.
- **Generate/download images:** use `agentify_image_gen` where the vendor supports it, or generate them manually in the UI and then call `agentify_download_images`.
- For image generation, prefer the default `agentify` Chrome profile mode so Agentify uses the persistent provider session in `~/.agentify-desktop/chrome-user-data/`. Use `attach` only when you intentionally launched a CDP-enabled browser yourself. Do not use Electron fallback for provider workflows.

## Image Generation
`agentify_image_gen` sends an image prompt to the selected provider web UI, waits for the generated images, and downloads them to local files. `agentify_download_images` is useful when you generated images manually in the browser and only need Agentify to collect the latest image outputs.

Optional post-processing modes:
- Default/`auto`: converts connected fake checkerboard backgrounds into real PNG alpha and keeps the original as `rawPath`.
- `chroma-key`: removes a flat keyed background color, controlled by `chromaKey`.
- `lcd-ink`: normalizes a fixed-grid monochrome image into transparent + black ink. Pass `columns`, `rows`, and `cellSize`.
- `none`: downloads the original images without post-processing.

MCP example:
```json
{
  "vendorId": "chatgpt",
  "key": "product-mockups",
  "prompt": "Create three clean product mockup images for a compact desktop developer tool, neutral background, no text.",
  "maxImages": 3,
  "postprocessMode": "auto"
}
```

## Tool names and visibility
- Tool names are `agentify_*` (for example: `agentify_query`, `agentify_ensure_ready`, `agentify_tabs`).
- For debugging, you can make newly-created tab windows visible by default by running:
  - `./scripts/quickstart.sh --show-tabs`
- If you register manually, pass the flag through to the MCP command:
  - `codex mcp add agentify-desktop -- node mcp-server.mjs --show-tabs`

## Governor (anti-spam)
Agentify Desktop includes a built-in “governor” to reduce accidental high-rate automation:
- Limits concurrent in-flight queries.
- Limits queries per minute (token bucket).
- Enforces minimum gaps between queries (per tab + globally).

You can adjust these limits in the Control Center **Settings (governor)** section after acknowledging the disclaimer.

## Single-chat emulator (experimental)
Agentify Desktop can optionally run a local “orchestrator” that watches a ChatGPT thread for fenced JSON tool requests like:
```json
{"agentify_tool":"codex.run","id":"<uuid>","key":"my-project","mode":"interactive","args":{"prompt":"Implement X and run tests."}}
```

It then runs Codex CLI locally and posts back a result block + a bounded “review packet” diff. This remains experimental and is not shown in the Control Center by default.

## Limitations / robustness notes
- **File upload selectors:** `input[type=file]` selection is best-effort; if ChatGPT changes the upload flow, update `selectors.json` or `~/.agentify-desktop/selectors.override.json`.
- **Completion detection:** waiting for “stop generating” to disappear + text stability works well, but can mis-detect on very long outputs or intermittent streaming pauses.
- **Image downloads:** scans the latest assistant message first, then visible page images, canvases, background images, and image-like links. This is still best-effort for sites such as Grok that change generated-image markup.
- **Parallelism model:** “tabs” are separate browser targets/windows; they can run in parallel without stealing focus unless a human check is required.
- **Security knobs:** default is loopback-only + bearer token; token rotation and shutdown are supported via MCP tools.

## Build installers (unsigned)
```bash
npm run dist
```
Artifacts land in `dist/`.

## Security and data
- Control API binds to `127.0.0.1` on an ephemeral port by default.
- Auth uses a local bearer token stored under `~/.agentify-desktop/`.
- Chrome CDP `agentify` mode stores persistent profile data under `~/.agentify-desktop/chrome-user-data/` and forces English locale for launched sessions.
- Chrome CDP `existing` mode targets your normal Chrome profile and is advanced/manual only because modern Chrome may reject remote debugging on the default user data directory.
- Chrome CDP `attach` mode uses whatever profile and locale the already-running browser was launched with.
- Electron fallback session data is stored under `~/.agentify-desktop/electron-user-data/`.

See `SECURITY.md`.

## Trademarks
Forks/derivatives may not use Agentify branding. See `TRADEMARKS.md`.
