# Community task-source SDK

The public protocol remains `1.0`. Generate a dependency-free starter without contacting a registry:

```powershell
pnpm build
node dist/packages/create-task-source-plugin/src/bin.js my-source --typescript
node dist/packages/create-task-source-plugin/src/bin.js my-python-source --python
node tools/verify-phase4.mjs
```

The TypeScript SDK exports manifest and plugin interfaces plus `runPluginConformance`. The generator also includes a
Python 3.11 newline-delimited JSON-RPC starter. Conformance is offline and uses fake inputs; it verifies the protocol,
digest pin, bounded capabilities, HTTPS broker origins, reconciliation declaration, health, and required methods.
It never validates real credentials or authorizes a source write.

| SDK / host                       | Protocol | Compatible host | Status                                          |
| -------------------------------- | -------- | --------------- | ----------------------------------------------- |
| TypeScript `@oda/plugin-sdk` 0.4 | 1.0      | O-D-A 0.4       | Canonical, verified                             |
| Python starter 0.4               | 1.0      | O-D-A 0.4       | Framing/conformance verified                    |
| Phase 1–3 connectors             | 1.0      | O-D-A 0.4       | Compatible; pinned runs do not upgrade in place |

A submission includes its manifest, configuration schema, fake fixtures, narrow grant explanation, digest-pinned
image, SBOM, and conformance JSON. Installation remains an explicit local action. A task, model, or webhook cannot
install a package or expand its grants.
