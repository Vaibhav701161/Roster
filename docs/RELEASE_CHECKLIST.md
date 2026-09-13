# Roster alpha release checklist

## Install and launch

- [ ] Run `npm ci` from a clean checkout.
- [x] Run `npm run package:win` on Windows and build the NSIS artifact.
- [ ] Run `npm run package:linux` on Linux to produce the AppImage and deb artifacts.
- [x] Validate the Linux unpacked application with `electron-builder --linux --dir`.
- [ ] Produce AppImage and deb artifacts on a Linux host. Windows cannot create the symlinks required by AppImage assembly.
- [x] Launch the packaged Windows app with an isolated data directory and confirm it creates its local database.
- [ ] Choose a workspace using the native folder picker.

## Providers and work

- [ ] Confirm Codex detection and run its connection test.
- [ ] Confirm Claude Code detection and run its connection test when it is installed and signed in.
- [ ] Create, edit, bench, unbench, and safely remove a worker.
- [ ] Complete a direct chat, team task, approval, cancellation, and retry.
- [ ] Send a steering constraint during active work and verify it is recorded.
- [ ] Queue a follow-up while work is running and verify its dependency.
- [ ] Verify an implementation with an independent reviewer.

## Reliability and safety

- [ ] Restart after ordinary chats, completed work, queued work, and a pending approval.
- [ ] Confirm provider failure leaves an understandable retry path.
- [ ] Check light and dark appearance, narrow window layout, keyboard shortcuts, and workspace access prompts.
- [ ] Verify provider credentials never appear in the database, logs, or browser state.

## macOS release

- [ ] Build `npm run package:mac:arm64` on Apple Silicon and `npm run package:mac:x64` on Intel hardware or an architecture-matched runner.
- [ ] Confirm each build contains both a DMG and ZIP with the expected architecture in its name.
- [ ] Use a Developer ID Application identity, Hardened Runtime, and the checked-in minimum entitlements.
- [ ] Notarize each signed artifact, staple its ticket, and record `codesign --verify --deep --strict`, `spctl`, and `xcrun stapler validate` output.
- [ ] Install each DMG by dragging Roster to Applications and launch it from Finder without Node.js or a terminal.
- [ ] Verify normal Dock lifecycle: closing the last window keeps Roster open, Dock activation restores it, and Cmd+Q stops managed work cleanly.
- [ ] Test the native folder picker with spaces, Unicode, and long paths.
- [ ] Verify Keychain-backed compatible-provider secrets survive signed-app restart and update without exposing the key.
- [ ] Verify packaged Codex detection, streaming, approval, cancellation, and resume on both architectures.
- [ ] Verify Finder-launched Claude Code discovery, authentication test, run, cancellation, and resume on both architectures when Claude Code is installed.
- [ ] Inspect the packaged application for signed nested Codex executables and confirm no provider child process remains after cancellation or quit.
