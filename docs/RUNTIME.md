# Runtime

## Codex

The pinned native CLI uses [Codex App Server](https://learn.chatgpt.com/docs/app-server) over stdin/stdout JSON-RPC. Roster performs the initialization handshake, starts or resumes a thread, starts a turn, forwards agent message deltas, records observable tool events, and resolves runtime approvals. It ignores reasoning events.

The installed version is the protocol authority. Its `thread/start` sandbox enum is `read-only` even where newer documentation examples use another spelling. Roster detects sign-in with the supported `login status` command and never parses the credential file. Native package paths avoid broken WSL wrappers.

Direct conversational runs preserve thread IDs. Work runs receive explicit persisted context and dependency outputs. If a saved thread cannot be resumed, Roster records the recovery and rebuilds context from application data.

Requests are bounded by RPC timeouts and a 15-minute execution deadline. Cancellation interrupts the turn and terminates the owned process tree. Pending approvals expire when their run ends. Restart marks interrupted work recoverably failed and preserves messages.

On Unix, Roster starts Codex and Claude Code in an owned process group, then terminates that group on cancellation or app quit. This avoids leaving provider descendants behind without touching unrelated user processes.

## Claude Code discovery and permissions

On macOS, Roster resolves Claude Code in this order: `ROSTER_CLAUDE_BIN`, the native installer location under `~/.local/bin`, Apple Silicon Homebrew, Intel Homebrew, `/usr/bin`, then the Finder-inherited `PATH`. Each candidate is validated by `claude --version`; detection never consumes model usage. A missing executable is shown as unavailable and an installed executable still needs an explicit connection test before it is considered connected.

Read-only operations start Claude Code in its supported `plan` permission mode. Mutable tasks do not pass a broad bypass flag; provider-native permission behavior remains constrained by the CLI and Roster's own approval boundary. Roster never uses `--dangerously-skip-permissions`.

## Compatible HTTP endpoint

The adapter uses streaming `/chat/completions`, handles chunk boundaries and Unicode, supports cancellation, and reports HTTP failures without exposing keys. It can run text tasks and coordinator prompts but has no local filesystem or command tool implementation.

Configured endpoint credentials are bound to their origin. An environment `OPENAI_API_KEY` is sent only to the official OpenAI API origin. Windows desktop keys use Electron safe storage (DPAPI); other desktop platforms use their OS-backed secure storage when available.

## Approval limits

Command and file-change requests become durable approval cards. Accepting or declining resolves the exact outstanding RPC request. Unknown tool-input requests and broad permission requests are denied, not silently accepted. Roster does not expose an arbitrary shell endpoint through its desktop renderer.

## Protected MCP servers

Roster discovers protected-resource metadata before starting a connection. When a remote server requires authorization, the desktop app opens the server's authorization page and uses an authorization-code flow with PKCE S256 and a loopback callback. It dynamically registers a public client only when the authorization server exposes a registration endpoint. Roster does not request every scope a server advertises. The callback verifies its state and issuer before exchanging the code, then keeps access and refresh tokens in a named local vault entry rather than the workspace database. Authorization servers that do not support PKCE S256 or dynamic registration remain unavailable until they offer a compatible connection method.

## Native integration credentials

Sentry, Linear, Slack, and Notion use a token entered in Settings. The token is saved under a provider-specific name in the desktop credential vault, never in SQLite, application state, logs, or a GET response. Roster performs a small read-only account probe when the connection is saved or refreshed. A rejected token is shown as requiring authentication, and a network failure is shown as unavailable; neither state is treated as evidence of completed work.
