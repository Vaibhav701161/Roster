# Security policy

## Supported version

Security fixes are applied to the current development branch and the latest published release when one exists.

## Reporting a vulnerability

Please do not open a public GitHub issue for a suspected vulnerability. Until GitHub private vulnerability reporting is enabled for this repository, contact the maintainer through the repository owner's GitHub profile with:

- a clear description of the issue
- affected versions and platforms
- reproduction steps or a minimal proof of concept
- the security impact you observed

Do not include provider keys, private repository contents, personal data, or destructive payloads.

We will acknowledge a report, assess the impact, work on a fix, and coordinate disclosure when appropriate.

## Security model

Roster is designed for a single user on a local machine. Read the detailed [security architecture](docs/SECURITY.md) for local API boundaries, provider approvals, workspace constraints, and credential handling. The optional [private phone companion](docs/MOBILE_REMOTE.md) uses Tailscale Serve, one-time pairing, identity-bound sessions, and a server-enforced mobile API allowlist.
