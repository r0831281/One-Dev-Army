# AGENTS.md: setting up O-D-A from a fresh clone

These are operating instructions for coding agents (Claude Code, Codex, Cursor and similar) that bring up One Developer
Army (O-D-A) locally and test the connected dashboard. The instructions describe what the code does today. Several
design documents in `docs/` describe features that are **not implemented**. When a design document disagrees with this
file, trust this file and the source.

## Ground rules

- **Run every command from the repository root.** The compose file, migrations, dashboard assets and prompt templates
  are all resolved relative to `process.cwd()`. Running from elsewhere fails in confusing ways.
- **Never write secrets into files.** That covers tokens, database passwords and `Authorization` header values. Do not
  put them in `config.yaml`, `.env`, shell profiles, commits or chat output. When a credential is needed, ask the human
  to `export` it in the shell that runs the API.
- **Do not turn on external side effects.** Do not publish, push, merge or tag. Do not make paid model calls or ticket
  writes (see `CONTRIBUTING.md`). Source writes are hard-blocked in code (`CONNECTOR_SCOPE_DENIED`), so do not work
  around that.
- **Do not use the verify scripts as a setup shortcut.** `tools/verify-phase2.mjs` and `tools/verify-phase3*.mjs`
  seed fixture rows into the same default workspace. They also overwrite tracked files under `artifacts/` and
  `apps/worker/fixtures/`. Run them only when you are deliberately verifying, and check `git status` afterwards.
- **Ask before the irreversible steps.** That means the reset procedure (it deletes volumes and Keychain items) and
  anything that touches a real GitHub or Jira account.

## 1. Prerequisites

| Tool    | Required                    | Notes                                                                                 |
| ------- | --------------------------- | ------------------------------------------------------------------------------------- |
| Node.js | 22 (engines: `>=22`)        | Newer majors usually work but are untested. Node 25+ no longer ships Corepack.        |
| pnpm    | 11.25.0 exactly             | `pnpm-workspace.yaml` uses pnpm 11 keys (`allowBuilds`, `minimumReleaseAgeExclude`).  |
| Git     | any recent                  | Checked by `doctor`.                                                                  |
| Docker  | Desktop/Engine + Compose v2 | Linux containers. Pulls digest-pinned Postgres, Temporal, OTel and Prometheus images. |

To install pnpm without relying on Corepack, use either of these:

```bash
npm install -g pnpm@11.25.0
```

```bash
npx --yes pnpm@11.25.0 --version
```

If you use the `npx` form, prefix every `pnpm …` command below with `npx --yes pnpm@11.25.0`.

These host ports must be free on `127.0.0.1`: 4310 (API), 5433 (Postgres), 7233 (Temporal), 4317, 4318 and 9464
(OTel), and 9090 (Prometheus). You can override them with `ODA_API_PORT`, `ODA_POSTGRES_PORT`, `ODA_TEMPORAL_PORT`,
`ODA_OTLP_GRPC_PORT`, `ODA_OTLP_HTTP_PORT`, `ODA_OTEL_METRICS_PORT` and `ODA_PROMETHEUS_PORT`. If you change the
Postgres port, change `ODA_PRODUCT_DATABASE_URL` to match.

## 2. Build

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm build
```

The output goes to `dist/`. Every `node dist/...` command below needs a fresh build after source changes. The `pnpm api`
and `pnpm worker` scripts rebuild automatically.

## 3. Dashboard demo (no database, no Docker)

Use the demo to check that the UI renders before you touch any infrastructure:

```bash
pnpm demo:dashboard
```

Open `http://127.0.0.1:4321/?fixture=demo`. Set `ODA_DASHBOARD_PORT` to change the port. All data is synthetic. Settings
are saved only to `localStorage`, and no backend is called. `?fixture=performance&diagnostic=1` runs the rendering
diagnostic.

## 4. Local stack setup

### 4.1 Choose the data root

| OS      | Default `--root`                           |
| ------- | ------------------------------------------ |
| macOS   | `$HOME/Library/Application Support/O-D-A`  |
| Linux   | `${XDG_DATA_HOME:-$HOME/.local/share}/oda` |
| Windows | `%LOCALAPPDATA%\O-D-A`                     |

```bash
export ODA_ROOT="$HOME/Library/Application Support/O-D-A"
```

### 4.2 Dry run, then setup

```bash
node dist/packages/cli/src/bin.js setup --root "$ODA_ROOT" --repository "$PWD" --dry-run
```

Every probe with `"required": true` must be `"ok": true`. A failed `port:*` probe means something is already listening
on that port. Then run the real setup:

```bash
node dist/packages/cli/src/bin.js setup --root "$ODA_ROOT" --repository "$PWD"
```

Setup does the following:

1. It creates `$ODA_ROOT/{artifacts,volumes,vault}`, `config.yaml` and `setup-journal.json`.
2. It generates two random database passwords and stores them in the OS vault (on macOS, the Keychain service `oda`,
   accounts `product-database` and `temporal-database`). macOS may show a Keychain prompt; let the human approve it.
3. It runs `docker compose -f infra/compose.yaml up -d --wait`, which starts Postgres, Temporal, the OTel Collector and
   Prometheus.
4. It applies **all** migrations in `packages/persistence/migrations` (currently up to `007`, even though the journal
   label says `migration-head-3`).

The step is idempotent: each operation is journalled. To continue after a failure, use
`setup --root "$ODA_ROOT" --resume <setupId>`. A step that is already applied is skipped. That means migrations added
after a `git pull` are **not** re-applied by a resumed setup. See Troubleshooting.

If the services step failed after some containers started, run `node dist/packages/cli/src/bin.js stop` before
retrying. Otherwise the retry's port probes fail on the ports its own containers are holding.

**Line endings.** `.gitattributes` forces LF for `*.sh`, `*.mjs` and Dockerfiles. If the clone predates that file and
Git has `core.autocrlf=true`, `infra/postgres-init.sh` gets CRLF endings. Postgres then logs `/bin/sh^M: bad
interpreter`, the `oda_product` role is never created, and setup fails with `container ... postgres-1 is unhealthy`.
Re-checkout the file with LF endings. Then either recreate the volume (with the human's approval) or replay the init
script into the running container: `docker exec -i oda-phase1-postgres-1 sh < infra/postgres-init.sh`.

```bash
node dist/packages/cli/src/bin.js doctor --root "$ODA_ROOT"
```

`doctor` exits 0 when it reports `"healthy": true`. It ignores port probes, because the stack is now holding those
ports.

### 4.3 Things `setup` does NOT do (you must do them)

`config.yaml` is written but **never read** by the API or worker. Its `providers.defaultProfile`, `temporal.namespace:
oda` and `databaseSecretRef` values have no effect. The runtime is configured entirely through environment variables
and the database.

**a) Export the product database URL.** The API and worker default to the compose fallback password
`oda-product-local-only`. That password does **not** match the one `setup` generated. Derive the real URL from the vault
with the built CLI. This works on every OS:

```bash
export ODA_PRODUCT_DATABASE_URL="$(node --input-type=module -e '
import { nativeVault } from "./dist/packages/cli/src/index.js";
const secret = await nativeVault(process.env.ODA_ROOT).get("vault://oda/product-database");
process.stdout.write(`postgres://oda_product:${Buffer.from(secret).toString("base64url")}@127.0.0.1:${process.env.ODA_POSTGRES_PORT ?? 5433}/oda_product`);
')"
```

On macOS, `security find-generic-password -a product-database -s oda -w | tr '+/' '-_' | tr -d '='` gives the same
password. Export this variable in **every** shell that runs `pnpm api` or `pnpm worker`. Never print it or save it to a
file.

**b) Seed the workspace and repository rows.** No migration or CLI step creates them. Without them, saving a connector
fails with `REPOSITORY_NOT_FOUND`, and saving spending or assignment settings fails a foreign-key check. Use the IDs
from `config.yaml`:

```bash
docker compose -f infra/compose.yaml exec -T postgres psql -v ON_ERROR_STOP=1 -U oda_product -d oda_product \
  -v repo_path="$PWD" -v repo_name="$(basename "$PWD")" <<'SQL'
INSERT INTO workspaces(id, name)
  VALUES ('00000000-0000-4000-8000-000000000001', 'Local workspace')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO repositories(id, workspace_id, name, local_path, default_branch)
  VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
          :'repo_name', :'repo_path', 'main')
  ON CONFLICT (id) DO NOTHING;
SQL
```

This uses the container's local socket, so no password is needed. If `psql` asks for one anyway, run the same SQL
through `psql "$ODA_PRODUCT_DATABASE_URL"` on the host instead. To manage connectors for other local repositories, add
more `repositories` rows, each with a new UUID and a unique `name`. If you set `ODA_WORKSPACE_ID` to a different value,
use that ID instead.

## 5. Run the API, worker and dashboard

Open two terminals. In both, `cd` to the repo root and export `ODA_ROOT` and `ODA_PRODUCT_DATABASE_URL`.

```bash
pnpm api
```

```bash
pnpm worker
```

- When the API is ready it prints `ODA_API_READY:4310`. It binds to `127.0.0.1` only, and requests from any other
  address get `403 LOCAL_ONLY`.
- The worker connects to Temporal at `ODA_TEMPORAL_ADDRESS`, default `127.0.0.1:7233`, with namespace
  `ODA_TEMPORAL_NAMESPACE`, default `default`, and polls task queue `oda-task-run-v1`. Keep the API and worker on the
  **same** namespace, and do not set it to `oda` unless that namespace exists in Temporal. The settings pages work
  without the worker, but runs only advance while it is running.
- Open the connected dashboard at `http://127.0.0.1:4310/`. Do not add `?fixture=`; that switches to demo data.

### Authentication

There is no login. Every `/api/v1/*` request except webhooks needs `Authorization: Bearer <session>`. Every POST also
needs `x-csrf-token: <csrf>` and `content-type: application/json`. The defaults are `phase2-local-session` and
`phase2-local-csrf`, and the dashboard uses those same defaults, so with the default environment it just works.

If you set `ODA_SESSION_TOKEN` or `ODA_CSRF_TOKEN` for the API, also set them in the browser console on the dashboard
origin:

```js
localStorage.setItem("oda-session", "<ODA_SESSION_TOKEN>");
localStorage.setItem("oda-csrf", "<ODA_CSRF_TOKEN>");
```

For scripted checks, use these headers:

```bash
export ODA_API="http://127.0.0.1:4310/api/v1"
export ODA_AUTH="authorization: Bearer ${ODA_SESSION_TOKEN:-phase2-local-session}"
export ODA_CSRF="x-csrf-token: ${ODA_CSRF_TOKEN:-phase2-local-csrf}"
```

```bash
curl -fsS -H "$ODA_AUTH" "$ODA_API/configuration"
```

`GET /configuration` returns `repositories`, which should include the row you seeded, plus `connectors`, `profiles`,
`assignments` and `readiness`.

## 6. Connectors (task sources)

### What exists

| Provider | Origin                                      | Identifier format    | Credential env value              |
| -------- | ------------------------------------------- | -------------------- | --------------------------------- |
| `github` | exactly `https://api.github.com/` (no GHES) | `owner/repo#42`      | `Bearer <token>`                  |
| `jira`   | `https://<site>.atlassian.net/`             | `PROJ-42`            | `Basic <base64(email:api_token)>` |
| `odoo`   | `https://<customer host>/` (root path)      | `ABC-1233`, `X-Y-62` | the **raw** Odoo API key          |
| Tempo    | fixed `https://api.tempo.io` (Jira option)  | none: discovers work | `Bearer <tempo_api_token>`        |

- There is no Linear or GitLab connector.
- The in-memory `fake` connector is used only by `pnpm demo` and the tests. The API does not accept it.
- Connectors run **in-process** inside the API. You do not need to build connector container images to use the
  dashboard. The `pnpm release:connectors` images are release artifacts only.
- **Every connector is read-only.** All outbound requests pass `assertConnectorRequest`
  (`packages/connectors/src/policy.ts`) before any credential is attached:
  - GitHub, Jira and Tempo may only make GET requests to their origin.
  - Odoo may only POST `search_read` on `project.task`: `/json/2/project.task/search_read` for JSON-2, or
    `/jsonrpc` with `common.login` or `object.execute_kw(project.task, search_read)` for JSON-RPC.
  - Anything else is `CONNECTOR_SCOPE_DENIED`.
- Access each connector needs:
  - **GitHub:** read access to that repository's issues. A fine-grained PAT with **Issues: read-only** is enough.
    Pull-request numbers are rejected.
  - **Jira:** browse access to the project's issues, plus to every issue planned in Tempo, so their summaries can be
    read.
  - **Odoo:** the API user needs read access to `project.task`.

### Example: Tempo planning, Jira helpdesk, Odoo tasks

This is the intended production layout. It needs **one Jira connector** with Tempo planning enabled, and **one Odoo
connector per Odoo database**. Each sync, every 30 min or on **Refresh fetched tasks**, does this:

1. It reads the Tempo plan of the configured Atlassian account for **today through the work-horizon cutoff**.
2. It resolves each planned Jira issue's key and summary through the Jira connector.
3. It decides where each task's content comes from:
   - **`HELP-*`** (the Jira connector's project) is a helpdesk ticket, ingested from Jira.
   - **Any other planned issue** must carry an Odoo key in its summary, for example `ABC-1233 Fix invoice report`.
     That task is ingested from **Odoo**, which owns the title and description. Odoo matches the key on
     `project.task.project_key_display`, or on the configured key field.
   - **No key in the summary:** the issue is counted under `unlinked` in the sync status, and in the dashboard
     planner header. Nothing is guessed.
4. It stores the Tempo dates in `extensions["community.tempo.planning"]`. `plannedFor` is the earliest planned day in
   the window, and it takes precedence over the Jira due date for the planner and for work-horizon gating. A moved plan
   creates a new task context revision. When a complete sync no longer finds a task in the plan, its Tempo planning is
   cleared.

Routing needs no configuration:

- The Jira connector gets prefix rule `HELP-`.
- Each Odoo connector gets regex rule `^[A-Z][A-Z0-9-]*-[1-9][0-9]*$`.
- A prefix outranks a regex, so `HELP-*` always goes to Jira.
- **Two enabled Odoo connectors would make every Odoo key ambiguous**, so only one can be active at a time today.
  Routing to several Odoo databases by key prefix is not implemented.

### Credentials

Credentials are **environment-variable references**, not vault entries. A connector stores `credentialEnv`, for
example `ODA_GITHUB_AUTH`. On every request, the API sends `process.env[credentialEnv]` **verbatim** as the
`Authorization` header, so the variable must hold the complete header value.

Ask the human to export the variable in the API's shell, then restart `pnpm api`:

```bash
export ODA_GITHUB_AUTH="Bearer <github_pat>"
```

```bash
export ODA_JIRA_AUTH="Basic $(printf '%s' 'me@example.com:<jira_api_token>' | base64)"
```

```bash
export ODA_TEMPO_AUTH="Bearer <tempo_api_token>"
```

```bash
export ODA_ODOO_ACME_KEY="<odoo_api_key>"
```

Odoo is the exception to the full-header rule: the variable holds only the API key. The API sends it as
`Authorization: bearer <key>` for JSON-2, or places it in the password argument for JSON-RPC. Connector code never
sees it. Use one variable per Odoo database.

### Create a connector

You can create a connector in the dashboard: **Settings → Task connectors**. Fill in Name, Provider, Repository,
Pinned repository commit SHA, API origin, owner and repository (GitHub) or project key (Jira), the credential
environment variable, and Enabled. You can also call the API directly:

```bash
curl -fsS -X POST "$ODA_API/connectors" -H "$ODA_AUTH" -H "$ODA_CSRF" -H 'content-type: application/json' -d "{
  \"name\": \"My GitHub issues\",
  \"provider\": \"github\",
  \"repositoryId\": \"00000000-0000-4000-8000-000000000002\",
  \"origin\": \"https://api.github.com/\",
  \"owner\": \"<owner>\",
  \"repository\": \"<repo>\",
  \"project\": \"\",
  \"credentialEnv\": \"ODA_GITHUB_AUTH\",
  \"enabled\": true,
  \"baseSha\": \"$(git rev-parse HEAD)\"
}"
```

Jira with Tempo planning: add a `tempo` object. The account ID is the Atlassian account ID of the developer whose plan
is read.

```json
{
  "provider": "jira",
  "project": "HELP",
  "tempo": { "accountId": "<atlassian account id>", "credentialEnv": "ODA_TEMPO_AUTH" }
}
```

Odoo: set `apiVersion` to `jsonrpc` for Odoo 18 and earlier, or `json2` for Odoo 19 and later. JSON-RPC needs
`database` and the API user's `login`; JSON-2 needs `database` only on multi-database hosts.

```json
{
  "provider": "odoo",
  "origin": "https://customer.example.invalid/",
  "credentialEnv": "ODA_ODOO_ACME_KEY",
  "odoo": {
    "apiVersion": "jsonrpc",
    "database": "<db>",
    "login": "<api user login>",
    "keyField": "project_key_display"
  }
}
```

Both snippets show only the provider-specific fields; send them together with the common fields from the GitHub
example (`name`, `repositoryId`, `baseSha`, `enabled`, and so on).

Validation rules:

- `credentialEnv` must match `^[A-Z_][A-Z0-9_]{0,100}$`.
- Odoo `origin` must be `https` with a host name (not an IP address), no port and root path. `keyField` must match
  `^[a-z_][a-z0-9_]*$`. A `tempo` object is only accepted on Jira connectors.
- `baseSha` must be 40 or 64 hex characters, and is required. Take it from `git -C <repo> rev-parse HEAD`.
- Jira `project` must match `^[A-Z][A-Z0-9_]*$`. For Jira, send `owner` and `repository` as `""`.
- To update a connector, re-POST with its `id`.

### Check the connector, then ingest

1. In `GET /configuration`, the connector must show `credentialPresent: true` and `ready: true`. This is the only
   "connection test"; it does not contact GitHub or Jira.
2. Route preview (read-only):

   ```bash
   curl -fsS -X POST "$ODA_API/routing-rules/resolve-preview" -H "$ODA_AUTH" -H "$ODA_CSRF" \
     -H 'content-type: application/json' -d '{"kind":"identifier","value":"<owner>/<repo>#1"}'
   ```

3. Ingest a real issue. This is the first call that actually contacts the source:

   ```bash
   curl -fsS -X POST "$ODA_API/tasks/ingest" -H "$ODA_AUTH" -H "$ODA_CSRF" \
     -H 'content-type: application/json' -d '{"identifier":"<owner>/<repo>#1"}'
   ```

   In the dashboard, use **Fetch task by identifier**. The task should then appear in the task list.

### Routing, sync and webhooks

- Routing rules cannot be configured. Each enabled, ready connector gets one in-memory rule with priority 100:
  - GitHub: prefix `owner/repo#`.
  - Jira: prefix `PROJ-`.
  - Odoo: the task-key regex.

  Two connectors with the same prefix, or two Odoo connectors, produce `AMBIGUOUS_ROUTE`. The `routing_rules` table
  is not used.

- Every 30 minutes, and from **Refresh fetched tasks** (`POST /connectors/sync`), the API runs one cycle:
  1. Tempo discovery, when a Jira connector has `tempo` set.
  2. A re-fetch of every other task it already holds.

  Without Tempo, new issues are never discovered; each must be ingested by identifier. The sync response and
  `GET /tasks` → `sync` report:
  - `planned`, `ingested` and `unlinked` (Jira keys without an Odoo key in the summary);
  - `failures` (`{identifier, code}` only, never payloads);
  - `checked`, `updated` and `failed` for the refresh.

- Webhooks (`/api/v1/webhooks/*`) are **not functional** in the running server: no webhook secret or webhook route is
  wired. Do not set them up.

## 7. Agent profiles and models

### What runs live

**Live analysis (workflow version 3)** uses Anthropic Claude for two roles only, `context-reviewer` and `planner`. The
other four roles (implementer, tester, reviewer, reporter) still run the deterministic fake backend. Live
implementation needs a real sandbox, which is not built yet.

**Starting a run.** Click **Analyse with agents** on a task, or call `POST /api/v1/tasks/<taskId>/analyse` with an
optional `idempotency-key` header. The API builds the v3 manifest itself. Then:

1. **Context review.** The context reviewer reads the task and, read-only, the repository that claims the task's key
   prefix. If it has questions, a **clarification gate** opens:
   - **Send answers:** the review runs again with your answers.
   - **Accept assumptions:** the proposed assumptions are adopted and the run moves on to planning.
2. **Planning.** The planner writes a plan and a **plan gate** opens:
   - **Request changes:** you get a new plan revision.
   - **Approve:** the run ends `COMPLETED` with the approved plan stored.
3. **Failures.** A refusal, invalid output after the repair turns, a hit call limit or an exhausted budget opens a
   **recovery gate**. Retry runs the failed step again; cancel ends the run.

**Work environments.** Environments are discovered by convention; nothing needs registering:

- **Layout.** Each environment is a folder `<root>/odoo-<version>-<customer>/` (default root `~/odoo`, set in
  **Settings → Work environments**) containing:
  - `addons/`: a git checkout;
  - `odoo/.odoorc`: the database host, port and user.
- **Main database copy.** It has the same name as the folder (`odoo-<version>-<customer>`), unless `db_name` is set
  in `.odoorc`.
- **Scratch copies.** Databases named `codex_*`, `claude_*` or `oda_*` that contain the customer name.
- **Choosing at Analyse time.** **Analyse with agents** preselects the environment that matches the task's Odoo
  customer, its Jira title or an explicit key-prefix mapping (**Settings → Repositories**, now only an override).
  Customer names must match as whole words, so "Parkside" never matches `ark`. You can change the environment, the
  branch (default: the local `staging` branch) and the database copy.
- **Repository access.** Agents read the chosen branch through `git show`, `git grep` and `git ls-tree`, at the
  commit pinned when the run starts. The working tree is never touched. Without an environment, the run uses the
  task text only.
- **Data access.** Off by default; tick **Let agents query this database** to turn it on for one run. The agents then
  get `db_query` (`packages/sandboxes/src/db-read.ts`):
  - only a single `SELECT` or `WITH` statement, run in a `READ ONLY` transaction that is always rolled back;
  - a 5 s timeout, at most 100 rows, results capped at 40 KB;
  - credentials come from the environment's `.odoorc` inside the worker;
  - query results are sent to Anthropic.
- **Restoring a copy.** Each environment in **Settings → Work environments** can be restored from an odoo.sh backup
  `.zip` in the downloads folder. This runs your restore script with `-f <zip> -d <db> -c odoo/.odoorc --drop`, after
  you type the database name to confirm.
- **Deleting scratch copies.** The same section can delete scratch copies, also after a typed confirmation. A
  database with open connections is refused.

**Credentials.** The worker reads `ANTHROPIC_API_KEY` from the Keychain through
`~/Library/Application Support/O-D-A/run-worker.sh`. The API never holds the key; it learns only the variable name
through `ODA_WORKER_CREDENTIALS`, set by `run-api.sh`.

**Data egress.** Task text, your answers and the repository excerpts the agent reads are sent to Anthropic. Nothing
else is sent.

**Cost.** Every call reserves its worst-case cost against **Settings → Spending** before it runs, then records the
real tokens and USD per step. `unpricedPolicy: "block"` refuses models without a price entry
(`packages/providers/src/anthropic.ts`).

**Other providers.** Profiles for other providers can be saved, but they still hold runs with `EXECUTION_BACKEND`.

**Test without spending.** `node tools/verify-live-analysis.mjs` drives a v3 run through real Temporal and Postgres
with a scripted model. It needs `ODA_PRODUCT_DATABASE_URL`.

### Profile shape

Use the dashboard's built-in template (**Settings → Agent profiles**), or the JSON below. **Do not use
`docs/reference/agent-profile.example.json`**: its `templateId: "planner-v1"` fails with `UNSUPPORTED_TEMPLATE`.

```json
{
  "schemaVersion": "1.0",
  "id": "<uuid>",
  "name": "Local planner",
  "revision": 1,
  "role": "planner",
  "provider": "fake",
  "model": "fixture",
  "credentialRef": null,
  "providerOptions": {},
  "limits": { "maxInputTokens": 12000, "maxOutputTokens": 4000, "timeoutMs": 30000, "maxModelCalls": 10 },
  "tools": [],
  "prompt": {
    "templateId": "system-v1",
    "templateRevision": 1,
    "intent": "Follow the approved task and pinned constraints.",
    "compiledArtifactId": null
  },
  "outputSchemaRef": "oda.agent.result.v1",
  "retryPolicy": { "transportAttempts": 2, "structuredOutputRepairs": 1 },
  "fallbackProfileIds": [],
  "localOnly": true
}
```

- `role` is one of `context-reviewer`, `planner`, `implementer`, `tester`, `reviewer`, `reporter` or
  `setup-onboarding`.
- `credentialRef` must be `null` or `env:VAR_NAME`. `vault://` refs are rejected with
  `CREDENTIAL_ENV_REFERENCE_REQUIRED`. For a non-fake provider, the human exports `VAR_NAME` in the API's shell. As with
  connectors, never write the value anywhere.
- `localOnly: true` only allows `fake` or `ollama`. Set it to `false` for any other provider.
- `tools` must be a subset of the role's allowed tools, otherwise you get `CAPABILITY_DENIED`. Leaving it as `[]` is
  always valid.
- Profiles are **immutable revisions**. To edit one, POST the same `id` with `revision + 1`. A gap or a duplicate
  revision is rejected.

### Create and assign

```bash
curl -fsS -X POST "$ODA_API/profiles" -H "$ODA_AUTH" -H "$ODA_CSRF" -H 'content-type: application/json' \
  -d @/path/to/profile.json
```

```bash
curl -fsS -X POST "$ODA_API/assignments" -H "$ODA_AUTH" -H "$ODA_CSRF" -H 'content-type: application/json' \
  -d '{"context-reviewer":"<id>","planner":"<id>","implementer":"<id>","tester":"<id>","reviewer":"<id>","reporter":"<id>"}'
```

- Assigning is how a profile is "activated". The profile's `role` must match the key, otherwise you get
  `PROFILE_ROLE_MISMATCH`.
- `readiness.agentsConfigured` becomes `true` once all six non-onboarding roles are assigned.
- For a working end-to-end run, create one `fake` profile per role and assign them all.

### Spending and operations

`GET` and `POST /operations` (dashboard: **Settings → Spending**) take this body:

```json
{
  "dailyLimitUsd": null,
  "taskLimitUsd": null,
  "reservationUsd": 0.5,
  "maxConcurrentRuns": 3,
  "paused": false,
  "unpricedPolicy": "allow",
  "timezone": "Europe/Brussels"
}
```

Runs are gated in this order: paused, then unpriced usage, then task budget, then daily budget, then capacity. Fake
runs record unpriced usage, so with `"unpricedPolicy": "block"` the second fake run of the day waits. Keep `"allow"`
for testing.

The work horizon setting is `GET` and `POST /work-horizon` with body `{ "days": 7, "timezone": "..." }`. A task with
no due date is outside the horizon, and its runs are `DEFERRED` until you add a per-task override:
`POST /tasks/<taskId>/work-horizon` with `{ "allowed": true, "reason": "..." }`.

## 8. Run a task end to end (fake provider)

The dashboard has **no "start run" button**. Start runs through the API, and the API, worker and Temporal must all be
running. This script reads the task context and approves the work horizon. It then pins the manifest's profile
revisions to the current assignments and starts a full v2 run (implement → test → review):

```bash
TASK_ID=<task uuid from GET /tasks> node --input-type=module <<'EOF'
import { createHash, randomUUID } from "node:crypto";
import { createRunManifest } from "./dist/apps/api/src/control.js";

const base = `http://127.0.0.1:${process.env.ODA_API_PORT ?? 4310}/api/v1`;
const headers = {
  authorization: `Bearer ${process.env.ODA_SESSION_TOKEN ?? "phase2-local-session"}`,
  "x-csrf-token": process.env.ODA_CSRF_TOKEN ?? "phase2-local-csrf",
  "content-type": "application/json",
};
async function call(method, path, body, extra = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...headers, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

const taskId = process.env.TASK_ID;
const context = await call("GET", `/tasks/${taskId}`);
await call("POST", `/tasks/${taskId}/work-horizon`, { allowed: true, reason: "Local dashboard test run" });

const configuration = await call("GET", "/configuration");
const latest = {};
for (const p of configuration.profiles) latest[p.id] = Math.max(latest[p.id] ?? 0, p.revision);
const profileRevisions = { "context-reviewer": 1, planner: 1, implementer: 1, tester: 1, reviewer: 1, reporter: 1 };
for (const [role, id] of Object.entries(configuration.assignments)) profileRevisions[role] = latest[id];

const manifest = createRunManifest({
  taskId,
  contextRevision: context.revision,
  repositoryId: context.repository.id,
  baseSha: context.repository.baseSha,
  policyHash: createHash("sha256").update("local-test-policy").digest("hex"),
  profileRevisions,
  workflowVersion: 2,
});
const result = await call(
  "POST",
  `/tasks/${taskId}/runs`,
  { manifest, context, repositoryRoot: process.cwd() },
  { "idempotency-key": randomUUID() },
);
console.log(JSON.stringify(result, null, 2));
EOF
```

- `status: "PENDING"` means the API dispatcher (every 250 ms) will start the workflow. `DEFERRED` means a gate is
  holding it; see Troubleshooting.
- In the dashboard, the run walks through `CONTEXT_REVIEW`, the **clarification** gate, `PLANNING`, the **plan
  approval** gate, then `IMPLEMENTING`, `TESTING`, `REVIEWING`, the **final approval** gate, `REPORTING` and
  `COMPLETED`. Approve each gate in the dashboard. All agent work is deterministic fake output.

## 9. Lifecycle

| Action                                         | Command                                                   |
| ---------------------------------------------- | --------------------------------------------------------- |
| Service status                                 | `node dist/packages/cli/src/bin.js status`                |
| Stop services (keep data)                      | `node dist/packages/cli/src/bin.js stop`                  |
| Start services again (injects vault passwords) | `node dist/packages/cli/src/bin.js up --root "$ODA_ROOT"` |
| Stop and keep volumes, config and secrets      | `node dist/packages/cli/src/bin.js rollback`              |

Always use `up` to restart services, **not** a plain `docker compose up`. A plain `docker compose up` does not pass
the vault passwords. On an existing volume this is harmless, but on a new volume it would create the role with the
fallback password.

**Full reset.** This is destructive, so ask the human first. The Postgres role password is set only when the volume is
first created, so the volume, the Keychain items and the data root must be reset **together**:

```bash
docker compose -f infra/compose.yaml down -v
```

```bash
security delete-generic-password -a product-database -s oda; security delete-generic-password -a temporal-database -s oda
```

```bash
rm -rf "$ODA_ROOT"
```

The second command is macOS only. On Linux, use `secret-tool clear service oda key <name>`. On Windows, deleting
`$ODA_ROOT` also removes the DPAPI vault files.

## 10. Troubleshooting

| Symptom / code                                          | Cause and fix                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm: command not found`                               | Install pnpm 11.25.0 (section 1).                                                                                                                                                                                                               |
| `SETUP_PROBE_FAILED:port:NNNN`                          | Port in use. Free it or set the matching `ODA_*_PORT` variable.                                                                                                                                                                                 |
| API exits with `password authentication failed`         | `ODA_PRODUCT_DATABASE_URL` is not exported, or is stale (section 4.3a).                                                                                                                                                                         |
| API fails on startup with `relation ... does not exist` | Migrations not applied. Re-run setup with a new journal (`rm "$ODA_ROOT/setup-journal.json"`, then `setup`); the steps are idempotent.                                                                                                          |
| `REPOSITORY_NOT_FOUND`, or empty Repository dropdown    | Seed rows missing (section 4.3b).                                                                                                                                                                                                               |
| `REQUEST_FAILED` on spending/assignments                | No `workspaces` row (section 4.3b).                                                                                                                                                                                                             |
| Connector `ready: false`                                | Disabled, missing `baseSha`, missing repository row, or env var not set in the API shell. Restart the API after exporting.                                                                                                                      |
| `CONNECTOR_CREDENTIAL_MISSING`                          | The `credentialEnv` variable is unset in the API process.                                                                                                                                                                                       |
| `CONNECTOR_HTTP_401` / `_403` / `_404`                  | Wrong header value (must start with the `Bearer` or `Basic` scheme), insufficient token scope, or wrong owner/repo/key.                                                                                                                         |
| `POLICY_DENIED` on ingest                               | Identifier does not match `owner/repo#N` / `PROJ-N`.                                                                                                                                                                                            |
| `NO_ROUTE` / `CONNECTOR_NOT_CONFIGURED`                 | No enabled, ready connector matches the identifier prefix.                                                                                                                                                                                      |
| `AMBIGUOUS_SOURCE_KEY` (Odoo)                           | More than one `project.task` has that key value. Fix the data in Odoo or point `keyField` at a unique field.                                                                                                                                    |
| Odoo `NOT_FOUND`                                        | No task with that key, or `keyField` is not searchable. A non-stored computed field without a search method cannot be used in a domain.                                                                                                         |
| Odoo `CONNECTOR_HTTP_401` / `_403`                      | Wrong API key or login, wrong `database`, or the user cannot read `project.task`.                                                                                                                                                               |
| `CONNECTOR_REMOTE_ERROR` (Odoo JSON-RPC)                | Odoo returned an RPC error. Check the field name in `keyField` and the Odoo version/`apiVersion` match.                                                                                                                                         |
| Planned items in `unlinked`                             | Their Jira summary has no Odoo key, and they are not in the helpdesk project. Put the key in the summary.                                                                                                                                       |
| `planned: 0` but Tempo shows work                       | The account ID is not the planned person, the window (today to the horizon cutoff) holds no plans, or the Tempo response shape differs from what the parser expects. `failures` stays empty in that last case, so compare against the Tempo UI. |
| `failures` contains `tempo:<account>`                   | The planning cycle failed: Tempo token missing or invalid (`ODA_TEMPO_AUTH`), wrong account ID, or the Jira credential cannot search issues. Existing planning is left unchanged.                                                               |
| `AMBIGUOUS_ROUTE`                                       | Two connectors share a prefix.                                                                                                                                                                                                                  |
| `UNSUPPORTED_TEMPLATE`                                  | Profile `prompt.templateId` must be `system-v1`, revision 1.                                                                                                                                                                                    |
| `CREDENTIAL_ENV_REFERENCE_REQUIRED`                     | `credentialRef` must be `null` or `env:NAME`.                                                                                                                                                                                                   |
| `PROFILE_REVISION_EXISTS` / `_GAP`                      | Profile revisions must increase by exactly 1.                                                                                                                                                                                                   |
| `PROFILE_REVISION_CONFLICT` on run start                | Manifest `profileRevisions` ≠ latest revision of an assigned profile. Use the section 8 script.                                                                                                                                                 |
| Run stuck, command reason `EXECUTION_BACKEND`           | An assigned profile is not `fake`. Only `fake` executes today.                                                                                                                                                                                  |
| Run stuck, reason `PROVIDER_UNAVAILABLE`                | Profile missing, or its `env:` credential is unset in the API shell.                                                                                                                                                                            |
| Run `DEFERRED`                                          | Work horizon (add a task override), paused, budget or capacity (section 7).                                                                                                                                                                     |
| API logs `DISPATCH_FAILED` / runs never start           | Temporal not reachable, or the worker isn't running or is on a different namespace.                                                                                                                                                             |
| Dashboard `401`                                         | Custom session/CSRF tokens not mirrored into `localStorage` (section 5).                                                                                                                                                                        |
| Dashboard 404 for assets                                | API not started from the repo root.                                                                                                                                                                                                             |

## 11. Documented but not implemented (do not chase)

- Vault-backed connector or provider credentials. The vault holds only the two database passwords.
- Any CLI command to store secrets. Also `npx create-auto-dev`, `auto-dev setup`, and the onboarding agent wizard
  described in `docs/04-onboarding.md`.
- `config.yaml` being read at runtime.
- Live model execution beyond analysis and planning (implementation, tests, review), and any provider other than Anthropic.
- Routing-rule create, read, update and delete (CRUD), and the `/plugins` endpoints in `docs/06-data-contracts.md`.
- Webhook ingestion.
- Running connectors as plugin containers via `packages/plugin-host`.
- `apps/sandbox-broker`, which is a placeholder image, and Docker sandbox execution in the worker.
- Source writes: status updates and comments on GitHub, Jira or Odoo.
- Routing Odoo keys to several Odoo databases at once (one Odoo connector may be enabled).

## 12. Verification gates (when changing code)

Before proposing changes, run `pnpm check`, `pnpm lint` and `pnpm format`. If you changed the dashboard, also run
`node tools/verify-phase4-dashboard.mjs`. That verifier defaults to a Windows Edge path; elsewhere set `ODA_CHROMIUM_PATH`, for example `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` on macOS. Dashboard files are hash-pinned in the signed Phase 4 release (`artifacts/phase-4`), so changing them makes `pnpm check` fail until `pnpm release:phase4` regenerates that record, which needs the maintainer's approval. If you changed plugins, also run `pnpm verify:phase4`. Read
`CONTRIBUTING.md` for compatibility rules: expand-only migrations, and no rewriting of immutable records.
