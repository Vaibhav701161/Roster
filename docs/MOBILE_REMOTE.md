# Mobile remote companion

Roster runs agents and retains project access on the desktop. The phone is a private companion for observing work, sending a follow-up, stopping or retrying a task, and answering an approval while away from the computer.

## Design

Roster uses the browser workspace as an installable PWA. It does not run an agent on the phone and it does not create a public control endpoint.

The desktop service continues to bind only to `127.0.0.1`. When private remote access is enabled, Roster asks Tailscale Serve to reverse-proxy that loopback endpoint over HTTPS inside the owner's tailnet. The desktop remains the execution authority and the only device with provider credentials, local files, Git worktrees, integrations, MCP connections, and settings.

## Setup

1. Install Tailscale on the desktop and phone, then sign both into the same tailnet.
2. In Roster desktop, open **Settings** and enable **Private phone companion**.
3. Choose **Pair a phone**. Roster copies a one-time pairing link that expires in 15 minutes.
4. Open the link on the phone. The pairing secret is in the URL fragment, so it is not sent with the initial browser request. Roster exchanges it over the private HTTPS connection for a device-bound, secure session cookie and removes it from the address bar.
5. Use the browser's install action to add Roster to the phone's home screen.

Turn off access from desktop Settings to remove the Tailscale Serve route and invalidate every phone pairing and session.

## Phone permissions

A paired phone can:

- read chats, worker availability, work status, receipts, and bounded task details
- receive live workspace updates
- send messages and reactions in an existing conversation
- stop or retry a task
- resolve a pending approval
- mark an existing conversation read, pinned, archived, or muted

A phone cannot create or edit workers or teams, change settings, reveal provider or integration configuration, access stored credentials, run MCP tools, inspect local paths, publish code, alter project environments, or enable remote access. The server enforces this allowlist even if a modified phone client calls it directly.

## Security properties

- The route is private to the tailnet. Roster does not use Tailscale Funnel or open a LAN listener.
- Requests arriving through Tailscale Serve must carry the authenticated `Tailscale-User-Login` identity header.
- Pairing secrets are 256-bit random values, retained only as SHA-256 hashes, valid for 15 minutes, and consumed after one use.
- Remote session secrets are 256-bit random values, retained only as SHA-256 hashes, bound to the Tailscale identity, delivered only in a `Secure`, `HttpOnly`, `SameSite=Strict` cookie, and expire after 30 days.
- The remote snapshot excludes provider status, credentials, integration records, MCP connections, project profiles, worker instructions, and local workspace paths.
- Disabling access clears all outstanding pairings and sessions before returning control to the desktop.

## Operational limits

The desktop must remain powered on, running Roster, and connected to Tailscale. This companion intentionally does not support public sharing, multiple independent users, offline task execution, or phone-controlled access to desktop configuration. Those require a separate multi-user authorization and hosted relay design.

## References

Roster uses the documented Tailscale Serve private HTTPS proxy model: [Tailscale Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve) and [Tailscale Serve overview](https://tailscale.com/docs/features/tailscale-serve).
