# Contributing

Use Node.js 22, pnpm 11.25, Git, and Docker with Linux containers. Keep changes compatible with retained Temporal
histories and expand-only database migrations. Never rewrite immutable manifests, usage facts, decision provenance,
candidate evidence, command identities, or external-operation markers.

Before proposing a change, run `pnpm check`, `pnpm lint`, `pnpm format`, and the phase-specific verifier. Changes to
plugins must also run `pnpm verify:phase4`; changes to the dashboard must run
`node tools/verify-phase4-dashboard.mjs`. Security-boundary changes require Docker integration evidence.

Issues and changes should state scope, threat-boundary impact, compatibility impact, exact verification commands,
and known limitations. Keep source writes, paid providers, remote execution, publication, merge, push, and tags off
unless a test explicitly supplies the existing consent flag and uses a disposable target.

Community connectors need a manifest, configuration schema, fake fixtures, grant explanation, digest-pinned image,
SBOM, and passing conformance report. They must not require core source changes.
