# Phase 4 release notes

Release slice: `0.4.0-phase.4`. This release adds the stable three-zone local dashboard, bounded terminal and event
rendering, reduced-motion and low-power modes, configuration inspection, public TypeScript/Python task-source
starters and offline conformance, backup/restore and safe diagnostics, governance, SBOM, and a signed local release
manifest.

There is no new product migration or workflow version. Migration head remains 5, contract/event/plugin protocols
remain `1.0`, `TaskRunWorkflow` versions 1 and 2 remain on `oda-task-run-v1`, and retained histories remain replayable.
Upgrade by replacing application assets and workers only after the Phase 3 replay gate passes. Existing plugins and
runs stay pinned to their recorded image/profile/prompt/policy revisions.

Supported install documentation covers Windows 11 with Docker Desktop, macOS with Docker Desktop, and Linux with
Docker Engine. This release was executed on the Windows reference machine; macOS and Linux install commands are
documented but are not claimed as executed in this local evidence set.

No package, image, comment, status, branch, merge, push, tag, or public release was published. The Ed25519 signature
is a local integrity artifact with an adjacent public key, not an identity-backed public signature.
