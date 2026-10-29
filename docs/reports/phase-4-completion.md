# Phase 4 completion report

Date: 2026-10-28. Release slice: `0.4.0-phase.4`.

Phase 4 implements dashboard composition and operational states, truthful usage/resource presentation, accessibility
and bounded rendering, configuration inspection, public community SDK starters/conformance, backup/restore and safe
diagnostics, governance, and local signed release artifacts. It does not add a migration or workflow version and does
not enable live providers, remote execution, source writes, publication, merge, push, or tags.

## Versions and artifacts

| Item                                | Phase 4 value                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| Product migration head              | 5 (`005_phase3_execution.sql`; no Phase 4 migration)                           |
| Contract / event / plugin protocols | `1.0` / `1.0` / `1.0`                                                          |
| Workflow                            | `TaskRunWorkflow` versions 1 and 2                                             |
| Task queue                          | `oda-task-run-v1`                                                              |
| Temporal service / SDK              | 1.28.1 / 1.25.0                                                                |
| Release                             | `0.4.0-phase.4`, local-only and unpublished                                    |
| Runtime images                      | Unchanged digest-pinned Phase 3 images in `infra/phase3-release-manifest.json` |

Release artifacts include the three-zone dashboard, public TypeScript plugin SDK, TypeScript/Python starter generator,
offline conformance, real Edge performance verifier, backup/restore and safe-diagnostic tooling, install/upgrade and
recovery documentation, security and contributor governance, issue templates, dependency/license review,
549-component CycloneDX SBOM, Ed25519-signed local manifest, and machine-readable verification record.

## Passed evidence

Exact commands executed on the Windows x64 reference machine:

```powershell
pnpm install --lockfile-only
pnpm check:markdown
pnpm check:docs
pnpm check:contracts
pnpm check:phase2-artifacts
pnpm check:phase3-artifacts
pnpm check:phase4-artifacts
pnpm lint
pnpm format
pnpm check
pnpm verify:phase4
docker compose -f infra/compose.yaml up -d --wait --wait-timeout 180
node tools/verify-postgres.mjs
node tools/verify-phase3-postgres.mjs
node tools/verify-phase3-temporal.mjs
node tools/phase4-operations.mjs drill --output .validation/phase4-drill
node tools/phase4-operations.mjs diagnostics --output .validation/phase4-diagnostics
pnpm audit --prod --audit-level high
pnpm licenses list --prod --json
node tools/release-phase4.mjs
```

The final aggregate gate passed 32/32 tests and all three retained Temporal replay histories. Real PostgreSQL checks
preserved migration head 5, immutable contexts and ledgers, command recovery, and external-write reconciliation. The
real 187-event version-2 Temporal workflow survived a worker restart at the exact final gate and retained sealed
candidate, test, review, usage, and fake-source report evidence. The restore drill restored product and Temporal dumps
into scoped temporary databases, found 37 Temporal tables, verified 16 artifact hashes, rotated the event epoch,
reconnected both vault-reference names, required all four services healthy before resume, and removed the temporary
databases.

Microsoft Edge 156 processed the Phase 4 fixture with 100 graph nodes, 10,000 buffered terminal lines, 3,000 events,
and only 60 terminal DOM rows. Reduced motion and keyboard-focusable graph parity passed. TypeScript and Python
starters passed protocol `1.0` conformance with networking disabled and no core source changes. Production dependency
audit reported no known vulnerabilities; the license review resolved the only missing package SPDX field from its
installed Unlicense text.

## Corrected failures

- The managed pnpm wrapper initially failed workspace `realpath`; the installed compiler passed, and every canonical
  pnpm gate was rerun with explicit local access.
- The first dashboard test found missing legacy Phase 2 static vocabulary and a whitespace-sensitive new assertion.
  Compatibility vocabulary and the assertion were corrected; the final suite passed 32/32.
- The first SDK verifier found that the compiled scaffolder looked for templates under `dist`. Template resolution was
  made explicit for the monorepo build; TypeScript, Python, and browser verification then passed.
- The repository-wide format check identified the generated Phase 3 history JSON. Its bytes were not reformatted; the
  generated replay artifact was excluded from formatting, and the final format gate passed.

Machine-readable details are in `artifacts/phase-4/verification.json`; restore evidence is in
`.validation/phase4-drill/restore-drill.json`; migration/workflow/schema/image versions and hashes are in
`artifacts/phase-4/release-manifest.json`. Recovery is in `docs/runbooks/phase-4-recovery.md`.

## Recovery

Quiesce scheduling, preserve product/Temporal dumps and artifacts together, rotate the journal epoch on restore,
reconnect the named vault references, and resume only after migration, Temporal, artifact, and four-service health
checks. Keep migration 005 and compatible workers; never down-migrate, rewrite immutable facts, reset Temporal history,
or retry an uncertain external operation under a new identity.

## Unverified and non-actions

Known limitations: the dashboard uses the existing local API and a framework-free bounded DOM renderer instead of
React Flow/xterm; it provides the specified graph/step-list and terminal behaviors without adding those dependencies.
The Windows reference machine is verified locally; macOS/Linux install behavior remains unverified in this evidence
set. Live credentials, paid calls, E2B, real source publication, package/image publication, transparency logging, and
public signing identity were not authorized or tested.

No source checkout write, real comment/status write, remote execution, package/image publication, merge, push, tag,
or public release occurred. Post-v1 team RBAC, organizations, Kubernetes, hosted control plane, autonomous branch
publication/merge, and remote collaboration were not started.
