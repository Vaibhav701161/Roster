# Product

Roster is a messenger for persistent AI workers. The primary surface is Chats; Roster manages people-like identities; Teams collect workers around a shared objective; Work shows execution; Files holds attachments and completed results; Activity shows observable actions.

The initial database is empty. The four templates are creation shortcuts, not invented contacts or fake conversations. Creating a worker immediately opens its real, persisted direct chat.

The desktop app uses the supplied logo geometry, a restrained green theme, a familiar list/conversation layout, message bubbles, avatars, search, archive, pins, and a compact composer. It adapts to narrow desktop windows and supports light, dark, and system appearance.

Normal conversation does not display a task card. Actionable requests create visible work. Agents’ working and approval states come from actual execution facts. Internal reasoning is not forwarded to the frontend.

Completion is intentionally separated from verification: a finished runtime turn is completed; an independent reviewer must provide a structured verdict; a verified outcome has recorded evidence. The product does not infer successful tests from confident prose.

Git-backed coding tasks receive a task-scoped worktree. The task records its repository, starting revision, branch, and worktree path, and Roster does not silently merge a worker branch into the user's checkout. The Work view shows outcome criteria and evidence. Needs You aggregates approvals, unavailable compatible runtimes, failed verification, and exhausted repair cycles.
