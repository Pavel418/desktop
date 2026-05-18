# Changelog

## 0.2.0 - 2026-05-17

### Added
- Chrome CDP browser backend with a persistent Agentify Chrome profile.
- npm CLI entrypoints for launching the desktop app and MCP server.
- Control Center actions for refreshing state, opening the state folder, and showing or hiding managed tabs.
- Generic image generation/download support with optional PNG post-processing for checkerboard, chroma-key, and fixed-grid monochrome outputs.
- Governor settings UI for concurrency and pacing limits.
- Tests for browser backend selection, MCP launch behavior, HTTP safety limits, image post-processing, tab behavior, and orchestrator storage.

### Changed
- Chrome CDP is now the default browser engine; Electron is available only when explicitly requested or fallback is explicitly enabled.
- MCP tool descriptions and README examples now describe multi-vendor browser automation instead of ChatGPT-only usage.
- Vendor-only calls reuse a stable vendor tab instead of opening a new tab for every request.
- Control Center status messages are clearer when the desktop bridge is stale or unavailable.
- The experimental orchestrator remains available in code but is hidden from the Control Center by default.

### Fixed
- MCP auto-start now resolves Electron from the package root instead of the caller's current working directory.
- Refreshing Control Center state no longer silently wipes unsaved governor edits.
- Chrome CDP tab visibility uses browser window bounds when available.
- State folder and tab visibility controls report actionable restart/update messages when the preload bridge is stale.

### Security
- Added visible governor defaults and an acknowledgement gate before changing automation rate limits.
- Kept private/domain-specific image workflows out of the public package.
