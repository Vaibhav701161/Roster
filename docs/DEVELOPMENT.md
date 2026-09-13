# Development

Use Node 24.14+ and the checked-in npm lockfile. `npm ci` installs the exact dependency set. `npm run dev` starts Vite, the loopback service, and Electron. `npm run build` checks TypeScript and creates the packaged renderer assets. `npm start:desktop` starts the packaged desktop app.

Roster is a local desktop runtime. Electron supervises the native CLI and exposes the narrow native folder-picker bridge. The loopback service and renderer are internal implementation layers; do not present or deploy them as a standalone hosted product.

Tests are isolated under temporary directories or ignored `test-results/`. `npm test` covers persistence, routing, dependency validation, failures, approvals, cancellation, restart recovery, and credential storage. Renderer QA checks actual UI interactions with a test adapter. The real-runtime suites separately prove provider and project execution. They consume real provider usage.

Do not add simulated production delays or fake contacts. Fixtures belong only in tests. Do not log provider secrets or private reasoning. Add a numbered migration for persistent schema changes. Keep renderer-facing execution commands narrowly scoped.

Main modules:

- `electron/main.cjs`: Electron lifecycle, secure window, native folder picker, and desktop service bootstrap.
- `src/main.tsx`: desktop renderer shell and messenger.
- `src/panels.tsx`: creation forms, contact details, task details, search.
- `src/workspace.tsx`: roster, teams, work, files, activity, settings.
- `server/index.mjs`: internal loopback API and production renderer serving.
- `server/engine.mjs`: task lifecycle and scheduler.
- `server/runtime.mjs`: Codex, Claude Code, and compatible adapters.
- `server/context.mjs`: bounded context and rolling summaries.
- `server/store.mjs`, `server/vault.mjs`, `server/lock.mjs`: persistence, secrets, ownership.

The desktop application is the acceptance target. Browser automation exists only to exercise the desktop renderer's UI behavior.

## macOS releases

The macOS target is macOS 13 Ventura or newer. Build Apple Silicon and Intel artifacts on macOS with `npm run package:mac:arm64` and `npm run package:mac:x64`. The `macos-release` GitHub Actions workflow uses current architecture-specific macOS runners and signs only when its certificate secrets are present.

Tag pushes and manual workflow runs build Windows x64 and Linux x64 artifacts through the `desktop-release` workflow. It uploads the NSIS installer, AppImage, and deb package as workflow artifacts. The macOS workflow remains separate because its signing and notarization requirements need Apple credentials.

Public direct distribution requires a Developer ID Application certificate and Apple notarization credentials. Set those only in the CI secret store. electron-builder detects Apple API-key notarization credentials from `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`; a missing signing identity intentionally leaves a developer build unsigned. Do not claim Gatekeeper acceptance until the signed DMG has been installed and tested from Finder on that architecture.
