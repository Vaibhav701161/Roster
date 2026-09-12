# Architecture

## Boundaries

`electron/` owns the desktop lifecycle and exposes a narrow native bridge. `src/` contains the React/TypeScript desktop renderer. `server/index.mjs` validates internal loopback requests and exposes bounded operations. `server/engine.mjs` owns durable execution state and scheduling. `server/runtime.mjs` owns provider transports, processes, timeouts, and cancellation. `server/store.mjs` owns SQLite migrations and parameterized queries.

The internal service binds only to loopback. The Electron renderer uses same-origin `/api` routes; Vite serves it in development. Production serves the compiled renderer directly. Server-sent events deliver significant state changes and buffered message updates; reconnect reloads authoritative persisted state.

## Persistence

SQLite WAL records workers, teams and membership, conversations, messages, attachments, tasks, dependencies, events, approvals, scoped memory, runtime sessions, settings, work-result artifacts, and rolling conversation summaries. Migrations are numbered and run on startup. A process lock prevents a second service from resetting live work in the same data directory.

Native SQLite avoids exporting an entire database for each streamed message. Text is checkpointed periodically and finalized on completion/failure. Summary lists exclude large task results; details load on demand. Chat history uses bounded keyset pagination. Context construction uses recent turns, scoped memory, dependency outputs, attachments, and a bounded rolling summary.

## Reference

[Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) was inspected for its separation of worker identity, supervision, durable state, and display state. Roster uses its own implementation and messenger UI; no AO source code was copied. The chosen workspace conflict strategy is serialization instead of creating and merging worktrees.
