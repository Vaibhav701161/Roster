# Orchestration

Direct conversations and single explicit mentions bypass automatic team assignment. Team requests without a single explicit owner use a structured coordinator response with one to six assignments. The coordinator sees compact worker identities and the team objective.

Zod validates the assignment schema. Every owner must exist in the active team; every dependency must reference an earlier assignment. This rejects hallucinated owners, forward edges, and cycles. Invalid output receives one repair attempt, then a meaningful error suggesting an explicit mention.

Each task has one owner. Eligible tasks run up to the configured parallel limit; the same worker or overlapping project folders cannot execute concurrently. Completed dependency output becomes context for the next worker. Failed or cancelled dependencies block downstream execution. Cancellation propagates to dependent work.

All state changes belong to the application. Agents do not spawn new workers themselves. Observable actions are recorded in Activity; user-facing results remain concise. No timers manufacture progress or completion.

An independent review is labeled reviewed. Verified status requires separately recorded evidence. Read the review’s actual findings before considering the work accepted.
