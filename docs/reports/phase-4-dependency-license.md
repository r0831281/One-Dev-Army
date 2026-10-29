# Phase 4 dependency, license, and vulnerability review

Review date: 2026-10-28. The lockfile contains 549 policy-checked entries. `pnpm audit --prod --audit-level
high` reported no known vulnerabilities. This is time-bounded registry evidence, not a guarantee that no vulnerability
exists.

`pnpm licenses list --prod --json` reported Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Unlicense,
CC-BY-4.0, and `Apache-2.0 AND MIT`; these are compatible with the repository's Apache-2.0 distribution when their
notices and attribution requirements are retained. `unionfs@4.6.0` omitted its SPDX field and appeared as `Unknown`;
its installed `LICENSE` is the Unlicense text, so it is reviewed as Unlicense rather than unresolved. No copyleft or
noncommercial production dependency was found.

The Phase 4 CycloneDX SBOM is generated from the exact pnpm lock keys and signed release manifest. Container image
digests remain the Phase 3 pinned values because Phase 4 adds no runtime container. `LICENSE` remains Apache-2.0 and
`NOTICE` remains the repository notice. Any dependency or image update requires regenerating the SBOM, repeating
this review, rerunning the audit, and exercising the affected real-service boundary.
