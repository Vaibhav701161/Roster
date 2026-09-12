# Security

The intended trust model is one user running Roster on their own machine. It is not exposed to a LAN or the public internet and does not implement multi-user authentication. The API rejects foreign hosts, cross-site fetches, non-JSON mutations, and untrusted origins. The production frontend has a restrictive content security policy and no remote fonts or telemetry.

All request bodies use allowlisted validation; SQL is parameterized. Reply and pagination references must belong to the selected conversation. File downloads resolve persisted IDs rather than accepting arbitrary host paths. Workers’ project paths must resolve to existing directories. Concurrent access to overlapping workspaces is serialized.

Codex starts read-only with its supported approval policy. The app does not bypass sandbox checks or use unrestricted-access flags. Runtime approval cards show the command, directory, reason, and available file-change information. Unknown permission requests are rejected. The strength and platform-specific behavior of the underlying sandbox remain Codex’s responsibility.

API keys are excluded from SQLite, JSON state, prompts, and logs. Windows keys use DPAPI. Other platforms use session memory or the OpenAI environment variable. Changing endpoint origin does not forward the old endpoint’s credential. No browser cookies or unsupported login tokens are collected.

Conversation attachments and provider responses are untrusted content. Markdown is rendered without raw HTML; external links use isolation attributes. Only readable text attachments are supported. Work-result files contain the actual final response, not arbitrary host file contents.

Data at rest other than keys is ordinary local SQLite. Protect the OS account and use disk encryption if required. Back up the data folder with Roster stopped. Cancellation preserves partial results and never attempts to undo unknown external side effects.
