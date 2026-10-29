# 4. Agent-Driven Onboarding and Setup

## 4.1 User experience and execution model

`npx create-auto-dev` launches a terminal wizard that detects the machine, proposes a configuration, validates connections, and opens the local dashboard. The bootstrap package is small and pinned by release; it explains the exact container images and directories it will use before starting services. `--dry-run` emits a redacted proposal without changing files, vault entries, or services. `--non-interactive --config <path>` supports reproducible installation using pre-existing secret references.

`SetupOnboardingAgent` is a constrained assistant over deterministic probes and commands. It translates findings into explanations and suggests source/routing/profile choices. It cannot run arbitrary shell commands, change permissions, install Docker, inspect unrelated directories, or receive plaintext secret input. A deterministic form flow remains available without a model connection.

Implement the wizard with a terminal prompt library, a persisted setup state machine, typed probe results, and an action journal. Every mutation has a stable operation ID and a compensating action when safe. Resume through `auto-dev setup --resume <setupId>` after interruption; no successful credential entry or migration is repeated blindly.

## 4.2 Probe matrix and failure handling

| Probe | Check | Failure behavior |
| --- | --- | --- |
| OS/runtime | Supported OS/architecture; active Node LTS for development | Link to supported installation instructions |
| Docker | Daemon connectivity, Linux container mode, image pull, limits support | Block local execution setup; allow configuration-only mode |
| Git | Executable and supported version; repository readability | Request explicit repository selection |
| Repository | Root path, commit, remotes, size, submodules, dirty status | Display findings; never stash/reset user changes |
| Resources | Default recommendation: 4 logical CPUs, 8 GiB RAM, 10 GiB free disk | Offer lower concurrency and show insufficient capacity |
| Ports | Selected loopback API and private service port collisions | Allocate alternate local port and persist it |
| Vault | Native credential store availability and roundtrip | Offer encrypted-file fallback explicitly |
| Source | Authenticated identity and least-required read/write scopes | Explain missing scope without printing tokens |
| Provider | Model availability, capability probe, optional bounded test call | Allow local model or skip until configured |
| Network | Selected endpoints reachable using certificate verification | Return endpoint/error class; never disable TLS verification |

Connection tests default to read-only requests. A model inference test displays the maximum token/cost budget before running. Source write tests use a user-selected test issue and explicit confirmation; they are never disguised as health checks. No arbitrary provider request is made by environment discovery.

## 4.3 Setup steps and generated state

1. Create a setup journal and select an application data root using OS conventions: `%LOCALAPPDATA%/O-D-A`, `~/Library/Application Support/O-D-A`, or `$XDG_DATA_HOME/oda` with the standard fallback.
2. Run capability probes and present a redacted installation proposal, including disk use, image digests, selected ports, and outgoing services.
3. Collect repository mappings, task-source instances, and provider profiles. Credentials use hidden terminal prompts directly connected to the vault service.
4. Store credentials in the vault and record only opaque references. Start the pinned local bundle and wait for health probes with finite deadlines.
5. Apply product migrations under an advisory lock. Initialize Temporal namespace/task queues and the artifact root.
6. Validate source and provider connectivity. Seed one workspace, a local actor, role-specific agent profiles, default budgets, and explicit routing rules.
7. Show a routing preview with example identifiers. Ambiguous matches prevent completion until corrected.
8. Run a synthetic fake-source workflow that opens a sample gate without model charges or source writes.
9. Write the finalized configuration atomically, mark setup complete, and open the dashboard via a one-time bootstrap token.

```yaml
schemaVersion: "1.0"
workspaceId: "50000000-0000-4000-8000-000000000001"
api:
  host: "127.0.0.1"
  port: 4310
temporal:
  address: "127.0.0.1:7233"
  namespace: "oda-local"
storage:
  databaseSecretRef: "vault://oda/product-database"
  artifactRoot: "./artifacts"
sandbox:
  defaultBackend: "docker"
  maxConcurrent: 2
providers:
  defaultProfile: "planner-default"
  credentialRef: "vault://oda/provider/default"
```

Resolve relative artifact paths against the application data root, never against the current shell directory. Keep `config.yaml`, `release-manifest.json`, setup journal, `artifacts/`, and service volumes under that root. A workspace file in a repository may select mappings/profiles but cannot grant tools, load secrets, or override global policy.

## 4.4 Secret vault interface

```ts
interface SecretVault {
  probe(): Promise<{ available: boolean; backend: string }>;
  put(input: { scope: string; label: string; value: Uint8Array }): Promise<string>;
  withSecret<T>(ref: string, use: (value: Uint8Array) => Promise<T>): Promise<T>;
  delete(ref: string): Promise<void>;
  listMetadata(): Promise<Array<{ ref: string; label: string; createdAt: string }>>;
}
```

Use Windows Credential Manager, macOS Keychain, or Linux Secret Service through maintained platform adapters. The application data directory has owner-only permissions. A `vault://` reference is not a bearer credential and is insufficient without authorization to the local broker.

The encrypted-file fallback uses a random per-vault salt, Argon2id key derivation, and authenticated encryption with unique nonces (AES-256-GCM). Store the KDF algorithm/parameters, salt, nonce, ciphertext, and format version in the encrypted envelope. Calibrate KDF parameters on the machine with a minimum policy; never store the passphrase or derived key. The process starts locked after reboot and requires interactive unlock. Avoid impossible promises of erasing secrets in a garbage-collected runtime; keep them short-lived, out of strings where practical, and out of model-visible data.

Provider adapters and the source HTTP broker resolve secrets only for a permitted request. AWS Bedrock supports the standard AWS credential chain as a vault-backed credential mode; do not persist temporary session credentials in profile documents. Ollama has no required API secret when used on its configured local endpoint.

## 4.5 Rollback, repair, and diagnostics

If setup fails, retain a redacted journal and offer resume or rollback. Rollback stops only services created by this setup, removes only its unreferenced secret entries, and restores only configuration files for which the journal recorded the prior hash/content. It never deletes a repository, pre-existing Docker volumes, shared images, or pre-existing secrets. Failed migrations require a documented forward repair; destructive down-migrations are not automatic.

`auto-dev doctor` verifies service health, schema compatibility, vault references, disk quotas, source scopes, routing conflicts, Temporal workers, and artifact hash spot checks. Diagnostics include versions, redacted configuration, health results, error classes, and selected operational logs. Exclude raw terminal chunks, source descriptions, prompts, patches, tokens, and database dumps by default; provide an explicit itemized export preview.

`auto-dev backup` quiesces new runs, drains active Activities or records a consistent stopped snapshot, backs up product and Temporal stores, and copies referenced artifacts with checksums. `restore` verifies manifest versions and hashes before replacing application state, rotates the journal epoch, and starts paused pending a doctor check. Secret export is a separate vault-native operation controlled by the user.

Acceptance scenarios include clean installs on all three platforms, missing Docker, daemon permissions, port collisions, locked Linux keyring, wrong credentials, rate limits, offline setup, interrupted migration, partial secret creation, rerun/resume idempotency, and rollback with pre-existing resources.
