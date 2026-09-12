# Contributing to Roster

Thank you for contributing. Roster is a local-first desktop project, and the best contributions make agent work clearer, safer, and easier to verify.

## Before you start

1. Read the [README](README.md), [architecture](docs/ARCHITECTURE.md), and [security policy](SECURITY.md).
2. Search existing issues and pull requests before opening a new one.
3. For a substantial change, open an issue first so the intended behavior and scope are clear.

## Development setup

```sh
npm ci
npm run dev:desktop
```

Run the relevant checks before opening a pull request:

```sh
npm test
npm run test:ui
npm run lint
npm run format:check
npm run build
```

Do not commit provider credentials, local data, packaged artifacts, screenshots containing private content, or generated handoff archives.

## Pull requests

Keep each pull request focused. Explain the user-visible behavior, the technical approach where it helps review, and the validation you performed. Add or update meaningful tests when behavior changes.

Roster should not claim verification, provider support, security guarantees, or platform support that has not been demonstrated. Preserve the local-first model, narrow desktop bridge, and explicit approval boundaries.

## Reporting issues

Use a bug report for reproducible defects and a feature request for a concrete user need. Security vulnerabilities must follow [SECURITY.md](SECURITY.md), not public issue threads.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
