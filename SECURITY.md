# Security policy

## Supported releases

Security fixes are provided for the latest Phase 4 compatible release line. Pre-Phase 4 snapshots are retained for
workflow replay and recovery, but should not be exposed beyond the documented loopback-only local deployment.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Send a private report to the repository owner's security
contact and include the affected version, reproduction, impact, and any suggested mitigation. If no private contact
is configured for a fork, use the hosting provider's private security-advisory feature. Maintainers should acknowledge
within five working days, preserve reporter credit preferences, coordinate a fix and disclosure date, and publish a
security advisory after supported users have a reasonable upgrade path.

Never include credentials, source payloads, prompts, raw terminal artifacts, or customer repository content in a
report. Use `node tools/phase4-operations.mjs diagnostics` for the local-only redacted diagnostic bundle.

## Trust boundaries

The local dashboard is loopback-only. Community plugins and code sandboxes remain digest-pinned, non-root,
network-disabled containers; external HTTP is allowed only through explicit broker grants. Live provider calls,
remote execution, source writes, publication, merge, push, and tags are opt-in. A signed local manifest proves which
bytes were reviewed; it does not claim public transparency-log inclusion or publisher identity.
