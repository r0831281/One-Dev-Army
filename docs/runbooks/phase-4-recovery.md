# Phase 4 backup, restore, and rollback

Quiesce new runs and let in-flight Activities reach a safe boundary. Keep PostgreSQL, Temporal, artifacts, vault
references, and the event epoch together. Create a local backup with:

```powershell
node tools/phase4-operations.mjs backup --output .validation/phase4-backup
node tools/phase4-operations.mjs drill --output .validation/phase4-drill
node tools/phase4-operations.mjs diagnostics --output .validation/phase4-diagnostics
```

The drill restores product and Temporal dumps into exact temporary database names, verifies migration head 5,
checks Temporal tables and artifact hashes, rotates the journal epoch, verifies vault-reference names, and permits
resume only after every Compose service reports healthy. It then drops only the two temporary drill databases. The
diagnostic bundle excludes raw logs, prompts, source payloads, credentials, and vault values.

For a real replacement, stop workers and API, restore both dumps and artifacts to a clean compatible bundle, retain
the manifest-provided new epoch, reconnect the two named vault references, start services, and run health, migration,
Temporal replay, and artifact hash checks before resuming scheduling. Never restore product data without matching
Temporal state, reset history, down-migrate, retry an uncertain write under a new operation ID, or silently reuse the
old journal epoch.

Rollback uses the previous compatible dashboard/SDK bundle while leaving migration 005 and all Phase 1–3 durable
records in place. Dashboard assets are stateless; rollback must not rewrite gates, feedback, usage, evidence, or
external operations.
