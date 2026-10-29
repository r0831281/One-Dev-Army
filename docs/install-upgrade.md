# Install and upgrade

Use Node.js 22, pnpm 11.25, Git, and Docker configured for Linux containers. Clone the repository, then use the same
locked build on every platform:

```text
pnpm install --frozen-lockfile
pnpm build
node dist/packages/cli/src/bin.js setup --root <local-data-root> --repository <repository>
node dist/packages/cli/src/bin.js doctor --root <local-data-root>
```

| Platform   | Local data root example                           | Container prerequisite           | Phase 4 evidence                 |
| ---------- | ------------------------------------------------- | -------------------------------- | -------------------------------- |
| Windows 11 | `%LOCALAPPDATA%\O-D-A`                            | Docker Desktop, Linux containers | Verified reference machine       |
| macOS 14+  | `$HOME/Library/Application Support/O-D-A`         | Docker Desktop                   | Documented, not locally executed |
| Linux      | `$XDG_STATE_HOME/oda` or `$HOME/.local/state/oda` | Docker Engine + Compose v2       | Documented, not locally executed |

On macOS/Linux, replace PowerShell environment syntax with the shell-native path. The CLI stores secrets only in the
native vault or explicitly selected encrypted fallback; do not put secret values in config files.

Before upgrading, quiesce scheduling and run the Phase 4 backup and restore drill. Install the new locked dependencies,
build, run all contract and replay checks, then start the compatible worker/API bundle. This release stays at migration
head 5 and supports workflow versions 1 and 2, so no contraction or history rewrite is allowed. Roll back application
assets only; keep the database and retained artifacts. See the Phase 4 recovery runbook for the exact health gate.
