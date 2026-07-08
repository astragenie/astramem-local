---
findings: "🔴:0,🟡:1,❓:2"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-07T12:20:39.005Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: materializeRelease() is atomic, structurally correct for AC-1/2/3, and --version boot-verify genuinely exercises native module loading (traced import chain + corroborated by validator's live smoke test); one MEDIUM finding on idempotent-reuse trust-without-reverify.
- Evidence Checked:
  - Full read of src/service/release.ts (243 lines) + tests/service/release.test.ts (174 lines); ran bunx vitest run tests/service/release.test.ts -> 5/5 pass; ran bun run build (tsc -p .) -> clean; git status confirms both files untracked/new
  - no other files touched
  - no commit made; traced cli/index.ts static import chain via subagent (serve.js -> storage/db.js -> better-sqlite3-multiple-ciphers + sqlite-vec
  - eager top-level ESM import) confirming --version is NOT a pure console.log -- it does force-load native modules before the switch-case runs
  - closing the builder-flagged 'boot-verify gap' concern; cross-checked against validator artifact 20260707T121453Z which independently ran a live materializeRelease() against the real checkout and confirmed doctor (20/20) loads sqlite-vec + better-sqlite3 SQLCipher fork from the materialized node_modules with zero errors.
- Files Reviewed:
  - src/service/release.ts
  - tests/service/release.test.ts
- Test Adequacy: 5/5 tests pass covering AC-1 (layout+manifest), AC-2 (boot-verify from outside checkout, checkout deleted first -- strong self-containment proof), AC-3 x2 (broken package.json and boot-verify-mismatch both quarantine + leave current.json untouched), plus an extra idempotent-reuse test; fixtures deliberately avoid real native deps for speed, so native-module ABI coverage is closed by the validator's separate live smoke test rather than this unit suite alone.
- Risks: MEDIUM: idempotent-reuse path (release.ts:226-234) trusts an existing finalDir's on-disk release.json without re-running boot-verify against it -- it fully rebuilds+reverifies into a fresh tmp dir first, then discards that verified build in favor of the pre-existing one purely by directory-name match. If a previously-valid release degrades post-creation (AV quarantine of a .node file, disk corruption, manual interference), a later reuse would silently trust it. Not required by the AC/plan (builder addition); harmless in this slice since nothing yet points current.json at these dirs, but becomes load-bearing once SLICE-2 wires repointing. LOW: no defensive guard/warning if releasesRoot resolves under a system temp dir -- node-gyp/MSBuild fails native compiles there (MSB8029/C1083, confirmed empirically by validator); failure is NOT silent (captured stdout/stderr surfaces in the thrown error) so this is a documentation/UX gap, not a masked bug. LOW: existsSync(finalDir)-then-renameSync is not a single atomic check-then-act; two concurrent materializeRelease() calls for the identical version+sha could race (renameSync would throw ENOTEMPTY on the loser, which gets quarantined+thrown) -- unlikely under current single-caller usage, not wired for concurrency in this slice.
- Required Follow-up: Before SLICE-2 wires current.json repointing: decide whether reuse should re-run (or at minimum re-stat/re-read) boot-verify against the existing finalDir rather than trusting release.json alone, or explicitly document why creation-time verification is considered sufficient for the lifetime of the dir. Otherwise no blocking follow-up -- materialization module itself is sound.

