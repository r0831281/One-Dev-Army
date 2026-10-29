# 5. Open-Source Plugin SDK and Dynamic Routing

## 5.1 Distribution and trust boundary

A task-source plugin implements a small, versioned JSON-RPC service. TypeScript is the canonical SDK; Python or another language can implement the same wire protocol. Each installed plugin instance has an immutable package version/image digest, validated configuration, secret references, and a capability policy. Instance changes affect new runs; existing runs retain their routing/plugin snapshot.

The plugin host starts a separate process and communicates over stdio. For community code, that child is `docker run --interactive` with a pinned plugin image and attached stdio: read-only root filesystem, non-root UID, no Docker socket, no host mounts, bounded resources, and `--network=none`. Plugins use host-mediated HTTP requests over the duplex RPC channel. Building an npm-distributed connector into its image is an explicit installation step using a pinned lockfile; never execute a package suggested by a task or model automatically.

Process isolation alone is fault isolation, not a security boundary against code running as the host user. Therefore the default plugin execution wrapper is containerized even though the SDK remains a process/stdio interface. Official and third-party connectors use the same boundary. The supervisor stays on the host to access the credential vault through a constrained broker.

## 5.2 Manifest and interface

```json
{
  "schemaVersion": "1.0",
  "id": "community.github",
  "version": "1.0.0",
  "protocolRange": "^1.0.0",
  "displayName": "GitHub Issues",
  "runtime": "stdio-container",
  "image": "registry.example.org/oda/github@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "capabilities": ["task:read", "task:status", "task:comment"],
  "httpOrigins": ["https://api.github.com"],
  "configSchemaRef": "plugin://community.github/config/1",
  "writeReconciliation": "marker-search"
}
```

The example registry/digest is illustrative and must be replaced by a verified release image. The host intersects manifest capabilities with user-approved instance grants. A connector cannot grant itself permissions by returning a different manifest after startup.

The complete interface and supporting types are in [contracts.ts](reference/contracts.ts). The SDK exposes these methods:

```ts
interface TaskSourcePlugin {
  getManifest(): Promise<PluginManifest>;
  healthCheck(context: PluginContext): Promise<HealthResult>;
  normalizePayload(input: NormalizeInput, context: PluginContext): Promise<SourceTaskRef>;
  fetchTask(ref: SourceTaskRef, context: PluginContext): Promise<TaskContext>;
  updateStatus(input: StatusUpdate, context: PluginContext): Promise<WriteReceipt>;
  postComment(input: SourceComment, context: PluginContext): Promise<WriteReceipt>;
}
```

`normalizePayload` validates an identifier or webhook and extracts a stable source reference. `fetchTask` returns the full canonical task. Repository mappings, local paths, policy, and source instance identity are host-controlled: the host overwrites/checks those fields before admitting a context. Plugins cannot choose an arbitrary local repository from a webhook string.

`healthCheck` reports identity, read/write capability availability, and warnings through a read-only endpoint. `updateStatus` receives the platform status and the instance's explicit source-specific mapping; unsupported mappings return `UNSUPPORTED_STATUS`. `postComment` receives the approved body and a stable operation ID. Both return a remote ID/URL when available and distinguish `APPLIED`, `ALREADY_APPLIED`, and `UNCERTAIN`.

## 5.3 Wire protocol

Use UTF-8 newline-delimited JSON-RPC 2.0. Serialize embedded line breaks as JSON escapes. Stdout contains protocol messages only; stderr contains redacted diagnostic text with a bounded rate. Maximum line size is 1 MiB; invalid JSON, duplicate response IDs, oversized frames, or unknown protocol major versions terminate the process.

```json
{
  "jsonrpc": "2.0",
  "id": "rpc-0001",
  "method": "plugin.fetchTask",
  "params": {
    "protocolVersion": "1.0",
    "instanceId": "60000000-0000-4000-8000-000000000001",
    "operationId": "fetch-123",
    "deadlineAt": "2026-10-26T10:01:00Z",
    "ref": {"externalId": "42", "key": "acme/app#42"}
  }
}
```

Handshake: spawn → `plugin.getManifest` → protocol/capability/config validation → `plugin.healthCheck` → ready. The host supplies deadlines and correlation metadata. Default deadlines: 5 s handshake, 10 s health, 30 s reads, 30 s writes. Two requests may be in flight per plugin instance; serialize writes to the same task. `$/cancelRequest` is best effort; an unknown write outcome still requires reconciliation.

RPC errors use JSON-RPC `-32600/-32601/-32602/-32603` for protocol failures and application codes in `error.data.code`: `AUTH_REQUIRED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, `VALIDATION_FAILED`, `UNSUPPORTED_STATUS`, `SOURCE_UNAVAILABLE`, `POLICY_DENIED`, `WRITE_UNCERTAIN`, `PROTOCOL_MISMATCH`. Include safe `retryable`, `retryAfterMs`, and `operationId` fields; never expose a credential-bearing upstream request.

## 5.4 Capability-scoped HTTP broker

Plugins call `host.http.request` over the reverse RPC channel. A grant specifies origin, methods, path templates, repository/project scope, credential binding, response size, and deadline. The host constructs headers and authenticates the request; raw tokens never cross into the plugin. Deny credential/Host headers supplied by the plugin, deny redirects by default, validate TLS, and resolve DNS with private/loopback/link-local destinations blocked except explicitly configured enterprise endpoints.

Allowing an origin alone is insufficient: GitHub access is restricted to configured `/repos/{owner}/{repo}/issues/...` paths and a read-only repository health endpoint; Jira access is restricted to configured projects/issues plus a read-only identity health endpoint. The broker authorizes target identifiers against the run and instance scope, applies rate limits, and redacts secret-bearing responses. Plugins cannot ask the broker to send provider credentials or arbitrary local HTTP requests. Attachments use a separate approved downloader with MIME/size limits and no automatic execution.

Default process limits: 256 MiB RAM, 0.5 CPU, 64 PIDs, 64 MiB tmpfs, 2 MiB response body, and 100 stderr lines/minute. Restart at most three times in five minutes; then open the instance circuit breaker and surface a configuration alert. Reads can retry; writes reconcile their operation IDs first.

## 5.5 Deterministic routing

`RoutingRules` contain enabled state, signed integer priority, match kind, pattern, plugin instance, repository mapping, and revision. Resolve using the immutable rule set observed at ingestion:

1. Validate the input and any webhook signature before rule matching. Signature verification uses the raw bytes and selected route instance, never a model.
2. Collect enabled matching rules. Exact matches and prefix matches are case-sensitive unless the rule declares normalization. Source-specific canonicalization happens after resolution.
3. Sort by descending explicit priority, then descending specificity: `webhook=4`, `exact=3`, `prefix=3`, `regex=2`, `fallback=1`.
4. For tied prefix rules, longer prefix wins; an exact match outranks a prefix of the same normalized identifier. These sub-ranks are part of specificity and appear in route previews.
5. If two top rules retain identical priority/specificity, return `ROUTE_AMBIGUOUS`, including safe rule IDs. Do not use insertion order or plugin ID as a tiebreaker.
6. If no rule matches, return `ROUTE_NOT_FOUND`. A fallback is explicit and cannot compensate for malformed or unsigned input.
7. Persist winning rule ID/revision, evaluated identifier, plugin instance revision, and repository mapping in the task/run manifest.

Use RE2-compatible regular expressions with pattern length ≤512 characters and identifier length ≤2,048 characters. Reject unsupported backreferences/lookarounds at rule creation. Limit a workspace to 1,000 active rules and route evaluation to 50 ms. A rule test endpoint evaluates examples without fetching source data or writing state.

```text
priority 100, webhook /hooks/github/acme      -> github-acme / app-repo
priority  50, exact acme/app#42               -> github-acme / app-repo
priority  50, prefix acme/app#                -> github-acme / app-repo
priority  40, regex ^APP-[0-9]+$              -> jira-main   / app-repo
priority -10, fallback                       -> manual      / app-repo
```

Ingestion deduplicates `(instance_id, delivery_id)` for webhooks and `(instance_id, external_id, source_revision)` for context refresh. A new run needs an explicit command or policy; an edited issue does not silently replace an already approved context.

## 5.6 Reference connectors

[reference-connectors.ts](reference/reference-connectors.ts) provides complete SDK-level GitHub, Jira, and in-memory fake implementations against a typed broker. HTTP transport, runtime input validation, vault handling, and container supervision are host SDK responsibilities.

| Operation | GitHub Issues | Jira Cloud |
| --- | --- | --- |
| Health | Read configured repository | Read authenticated identity |
| Fetch | `GET /repos/{owner}/{repo}/issues/{number}` | `GET /rest/api/3/issue/{key}` |
| Normalize | `owner/repo#number` or signed issue webhook | `PROJECT-number` or signed issue webhook |
| Status | `PATCH` issue `state`; labels for configured intermediate states | Read available transitions; `POST .../transitions` using explicit mapping |
| Comment | `POST .../issues/{number}/comments` | `POST .../issue/{key}/comment` with ADF body |
| Reconcile comment | Paginate comments and find operation marker | Paginate comments and find operation marker |

GitHub uses configured `Accept` and a pinned supported API-version header; tokens remain broker-side. The connector rejects issue payloads that represent pull requests unless the instance explicitly supports PR tasks. Jira descriptions/comments use Atlassian Document Format (ADF); preserve raw ADF as an artifact and normalize text without executing embedded content. Tempo time tracking is an optional extension capability and is not conflated with Jira issue transitions.

The local API also ships a read-only Odoo connector and a Tempo planning source. Tempo Planner (`GET /4/plans/user/{accountId}`) lists the planned Jira issues for the work-horizon window. Helpdesk issues in the Jira connector's project are fetched from Jira. Any other planned issue names an Odoo task key in its summary; that task is fetched from Odoo `project.task`, which owns the description. Planned dates are carried in the `community.tempo.planning` extension and take precedence over the Jira due date. Odoo access is limited to `search_read` on `project.task`, through JSON-2 (Odoo 19 and later) or JSON-RPC `execute_kw` (Odoo 18 and earlier). The API injects the key after the request policy check, so connector code never holds it. See `AGENTS.md` for configuration.

Source APIs do not provide a universal exactly-once comment primitive. The host write journal serializes each operation, searches the operation marker before retries, and records remote receipts. After a timeout with no reliable reconciliation, return `UNCERTAIN` rather than risk a duplicate. GitHub marker comments are hidden HTML markers; Jira markers are visible plain text identifiers because ADF does not imply hidden HTML support.

API behavior references: [GitHub issues](https://docs.github.com/en/rest/issues/issues), [GitHub comments](https://docs.github.com/en/rest/issues/comments), [Jira issues and transitions](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/), and [Jira comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/).

## 5.7 Compatibility and conformance

Wire protocol major changes require explicit reinstall/upgrade. Minor additions are optional fields/capabilities; callers ignore unknown response fields but reject unknown required capabilities. Public schemas use semantic versions and release a compatibility matrix. Running plugin images stay pinned until their runs finish.

SDK conformance covers all required methods, TypeScript/Python cross-language framing, newline escaping, malformed frames, deadlines, cancellation, plugin crashes, scoped broker denials, pagination, auth expiry, webhook replay, status mapping, rate limits, uncertain writes, and read/write idempotency. The fake plugin supports deterministic fault injection without internet credentials. Community submission requires a manifest, schema, fixtures, scope explanation, image digest, SBOM, and passing conformance report.
