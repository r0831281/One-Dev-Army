# Dependency policy

Runtime dependencies are kept small, pinned exactly, and reviewed for license, maintenance, provenance, and
known vulnerabilities before release. `pnpm-lock.yaml` is the only authoritative lockfile. Container images are
pinned by digest in `infra/release-manifest.json`; updating a digest requires exercising the Phase 1 integration
tests. Native modules are avoided in the bootstrap path. Development dependencies are also exact-pinned.

Use `pnpm install --frozen-lockfile` in CI and `pnpm audit` as advisory input. An audit result does not replace
threat analysis of the plugin broker, vault, webhook, and persistence boundaries.
