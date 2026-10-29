# 3. Agent Telemetry and Observability

## 3.1 Two complementary data paths

Domain telemetry is durable product data: run transitions, decisions, tool results, usage, and retries. Persist it transactionally with the corresponding product projection and outbox event. Operational telemetry consists of OTel traces, metrics, and redacted logs exported asynchronously. A Collector failure must not block a run; a failure to persist required usage/audit data must block the affected transition.

The [Collector pipeline model](https://opentelemetry.io/docs/collector/architecture/) supports receivers, processors, and exporters. Use OTLP receivers, memory limiting, redaction/filtering, batching, and bounded export queues. Expose a Prometheus scrape endpoint from the metrics pipeline. Optional Jaeger-compatible OTLP export is a separate Compose profile. No external telemetry destination is enabled by default.

## 3.2 Records and correlation

Every event carries `workspaceId`, `taskId`, logical `runId`, optional `stepId`, `attemptId`, and `operationId`. Propagate `traceparent` across API, Activity, RPC, and sandbox-broker requests. Do not force one open span to cover days of human waiting: create linked spans for each execution segment and record gate wait duration separately.

| Record | Fields beyond IDs | Source of truth |
| --- | --- | --- |
| Agent step | agent role/profile revision, state, start/end, duration, outcome | Workflow transition projection |
| Model usage | provider, requested/resolved model, request ID, token categories, completeness, pricing snapshot | Provider result/reconciliation |
| Tool call | tool name, command hash, policy result, status, exit code, duration, artifact refs | Execution broker |
| Retry | cause, loop kind, logical iteration, transport attempt, limit | Workflow/Activity executor |
| Telemetry log | timestamp, kind, severity, measurements, allowlisted attributes, redacted payload | Persisted event |
| Sandbox sample | CPU utilization, memory bytes/limit, elapsed time, unavailable reason | Backend resource API |

Use monotonic time for within-process durations and UTC RFC 3339 timestamps for correlation. Store durations as integer milliseconds. PostgreSQL `numeric(20,9)` stores USD calculations; API amounts are decimal strings to avoid JavaScript float drift. Token counts are nonnegative integers; unknown values are nullable, never coerced to zero.

## 3.3 Cost ledger

Pricing snapshots are immutable and keyed by provider, resolved model, region/tier where relevant, currency, effective time, and a content hash. Store rate categories explicitly: uncached input, cached input read, cache creation, output, and any provider-specific billable units. Provider adapters must declare whether reasoning tokens are included in output totals to prevent double counting.

```text
estimated_cost_usd = sum(billable_category_units * category_rate_usd_per_million / 1_000_000)
```

If a provider reports total input inclusive of cached input, normalize uncached input as total minus cached categories before pricing. Reject impossible negative category totals and retain the raw provider accounting payload as a restricted, redacted artifact. Requested model aliases resolve to a concrete reported model whenever possible.

Each model request creates one logical usage record plus attempt records. Stream estimates are provisional; final provider usage supersedes them through append-only usage adjustments. A retry is a separate billable attempt even when it belongs to the same agent step. Unknown prices produce `pricingStatus=UNPRICED`; incomplete accounting produces `usageStatus=PARTIAL` or `UNKNOWN`. Dashboard totals show known cost and an unpriced/incomplete count.

Default per-run budget: USD 5 estimated known cost, 200,000 aggregate tokens, 60 minutes active execution, and 24 hours sandbox-free gate retention before archival prompts. These are configurable defaults, not billing guarantees. Reserve estimated call output against the budget before dispatch. Unknown prices block paid-provider execution unless the user explicitly permits a token-only budget for that profile. Allow an individual provider call to overshoot a reservation only by its bounded in-flight maximum; display that exposure.

## 3.4 Metrics and tracing

| Metric | Type | Low-cardinality labels |
| --- | --- | --- |
| `oda_agent_step_duration_seconds` | Histogram | role, outcome |
| `oda_model_tokens_total` | Counter | provider, model_family, category, completeness |
| `oda_model_estimated_cost_usd_total` | Counter | provider, pricing_status |
| `oda_tool_calls_total` | Counter | tool, outcome |
| `oda_tool_duration_seconds` | Histogram | tool |
| `oda_retry_iterations_total` | Counter | loop_kind, cause_class |
| `oda_runs_total` | Counter | outcome |
| `oda_active_runs` / `oda_pending_gates` | Gauge | state / gate_kind |
| `oda_event_delivery_lag_seconds` | Histogram | channel |
| `oda_plugin_rpc_duration_seconds` | Histogram | plugin_kind, method, outcome |
| `oda_sandbox_memory_bytes` | Gauge | backend, slot |

Never use task IDs, run IDs, source keys, prompt text, user input, full model identifiers with arbitrary suffixes, or command text as Prometheus labels. Keep high-cardinality detail in PostgreSQL and traces. Metrics are operational aggregates and may be approximate after restarts; ledger queries are authoritative for user cost totals. Histograms use bounded buckets appropriate to tool versus model latency.

Count success at the logical-step level and transport success at the attempt level. Report test repair loops and reviewer rejection loops separately. Mark OTel spans for model requests, plugin RPC, sandbox commands, patch application, and projection writes; attach redacted error classes, not credential-bearing response bodies.

## 3.5 Transactional journal and ordered WebSocket delivery

Use one serialized workspace event sequence in v1. In the same transaction as a product change, lock and increment `workspace_event_counters.last_seq`, insert `outbox_events`, and commit. The counter lock remains held until commit, so assigned sequences follow commit order; a plain PostgreSQL sequence would not provide that guarantee. Rollbacks roll back the counter update. The local workload tolerates this serialization; partition by workspace if tenancy is added later.

`LISTEN/NOTIFY` is only a wake-up hint. Gateways always query committed journal rows and poll once per second if notifications are lost. Never delete an event when a consumer delivers it. Delivery is at least once; clients deduplicate by cursor and apply state revisions monotonically.

```json
{
  "protocolVersion": "1.0",
  "cursor": "1042",
  "type": "gate.opened",
  "occurredAt": "2026-10-26T10:00:00Z",
  "runId": "10000000-0000-4000-8000-000000000001",
  "stateRevision": 12,
  "payload": {
    "gateId": "30000000-0000-4000-8000-000000000001",
    "version": 1,
    "kind": "PLAN_APPROVAL"
  }
}
```

Connect to `/api/v1/events?after=1041`. Cursors are decimal strings and workspace-global. Server replay/live handoff reads the journal continuously after the last delivered sequence, eliminating a separate subscribe race. Run filters may skip cursors; the server emits progress heartbeats so reconnect can advance safely. A client starts with a consistent `/snapshot` response containing `snapshotCursor`, then subscribes after it.

Envelopes use `type=resync.required` and a `resync` object when the cursor precedes retention or belongs to a restored journal epoch. Include `journalEpoch` in the handshake; restoring a backup creates a new epoch. Client fetches snapshot, replaces its projections atomically, then reconnects. Never apply old-epoch events to new state.

Bound each connection to 1 MiB queued data or 1,000 envelopes. If exceeded, close with application code `4008` and reconnect/replay from the last applied cursor. Batch noncritical log chunks up to 16 KiB/100 ms; do not drop persisted gate/state events. JSON event payloads are limited to 64 KiB and reference larger artifacts. Use exponential reconnect backoff from 250 ms to 15 s with jitter and reset after a stable connection.

## 3.6 Logs, retention, and privacy

Capture raw stdout/stderr as 1 MiB immutable chunks with stream offsets and SHA-256 hashes. “Raw” means byte-preserving output, which may contain repository secrets despite best-effort masking: keep it local, encrypted at rest when configured, restricted to the local owner, and outside exported diagnostics. The dashboard receives only streaming redacted text. Never intentionally inject platform credentials into sandbox environment or commands.

Perform stateful streaming redaction across chunk boundaries before persistence of UI logs and before OTel export. Match vault secrets and known credential patterns; cap line length and reject unsafe terminal control sequences. Model prompts/responses are not exported to OTel. A debug prompt archive is explicit opt-in and remains local with separate retention.

| Data | Default retention | Cleanup |
| --- | --- | --- |
| Domain event journal and redacted log events | 7 days | Retain snapshot capability; issue resync on gaps |
| Raw terminal chunks and sandbox scratch | 7 days after run terminal | Delete only after retention; preserve referenced review artifacts |
| Plans, patches, tests, review bundles | 30 days after run terminal | Do not prune while a gate/run references them |
| Usage ledger, decisions, run manifests | 90 days | Export before optional pruning |
| Prometheus local storage | 7 days / 2 GiB | Enforce both limits |
| OTel export queue | Bounded memory/disk | Drop noncritical operational signals with counters |

Cleanup is a deterministic maintenance job with a previewable retention policy. Deletion leaves tombstones for referenced artifact IDs. Database partitions and indexes are introduced after measuring volume; v1 uses indexed timestamp retention batches.

Acceptance checks cover cost category normalization, final/provisional reconciliation, duplicate Activity results, chunk-boundary redaction, counter rollback, concurrent commit order, reconnect races, slow clients, retention gaps, epoch changes, and Collector outage without workflow loss.
