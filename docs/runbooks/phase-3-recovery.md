# Phase 3 Recovery and Rollback

Stop scheduling new runs before changing workers. Keep product PostgreSQL, Temporal persistence, artifacts, command receipts, usage records, and external-operation journals together.

For a lost provider response, record partial or unknown usage and retry only within the pinned transport and monetary budgets. Never replay a write tool. For a worker death during a sandbox command, look up the original operation ID and reconnect to its running process or terminal receipt before deciding whether any command can run again.

For a missing sandbox, recreate from the immutable manifest, base SHA, and last sealed candidate; rerun tests and review and issue a fresh final gate. Candidate mutation invalidates all earlier execution evidence. Reap only resources bearing the broker's workspace/run labels. A failed cleanup remains a visible leak and is retried finitely.

For a source publication timeout, search for the stable marker. Mark a found operation applied; otherwise retain `REPORT_PENDING` or `UNCERTAIN`. Do not create a new implementation run and do not generate a new operation key.

Rollback deploys only workflow-replay-compatible workers and leaves migration 005 in place. Do not rewrite manifests, profiles, prompt artifacts, usage attempts/adjustments, command receipts, execution evidence, gate decisions, or source-operation records. Remote execution and live providers stay disabled by default.
