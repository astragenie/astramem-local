---
task: SYNC-1
repo: astramemory-local
date: 2026-07-14
operator_approval: on record — merge review-PASS wave lanes + push contracts-v2.3.0 tag
bounds: no force-push, no other tags, no workflow edits
outcome: PASS — all lanes merged, tag published, package verified
---

# Deployment check — SYNC-1 contracts publish ceremony

## Step 1-4: contracts-v2.3.0 (FEAT-496 atom@2 extension)

- **PR:** [#312](https://github.com/astragenie/astramem-local/pull/312) — "feat(contracts): atom@2
  speaker/segment provenance + consent_disclosed (FEAT-496)"
  `wave/l0-1-contract` → `main`, 4 commits (`a159ac1`, `550b177`, `53c9578`, `2b66faa`).
- **Review on record:** PASS —
  `.claude/artifacts/crew/reviews/20260714T163508Z-review-l0-1-atom-v2-consent-disclosed.md`.
  55/55 `contracts:validate`, 186/186 vitest, generated-artifact diff clean.
- **CI:** all 5 checks green (Test self-hosted Bun 1.3, TypeScript type-check, audit,
  cross-repo-roundtrip, auto-merge) — run group starting
  `https://github.com/astragenie/astramem-local/actions/runs/29351062898`.
- **Merge:** repo's own `auto-merge` workflow job fired the instant required checks went green
  (squash, matching repo convention of 1-parent commits). No explicit `gh pr merge` was needed or
  possible — GitHub reported "already merged" on attempt. Merge commit
  `53f4bcd3eb8c087749412d944b591be1d60cdaa3`, confirmed as `origin/main` HEAD before tagging.
- **Tag:** `git tag contracts-v2.3.0 53f4bcd3` → pushed. Only this one tag was created/pushed.
- **Publish workflow:** `contracts publish` run
  [29351165417](https://github.com/astragenie/astramem-local/actions/runs/29351165417) —
  **success**, 12s. Step "Regenerate + validate (fail if generated output is stale)" passed with
  no diff, as the review predicted (regen was already committed in `2b66faa`).
- **Package verification:** publishes to **npmjs.org**, not GitHub Packages (by design — see
  `contracts-publish.yml` header comment: GitHub Packages inherits the private source repo's
  visibility and is billing-gated; npmjs.org lets the package be public independent of repo
  visibility). Queried `https://registry.npmjs.org/@astragenie/astramem-contracts` directly:
  `dist-tags.latest = "2.3.0"`, versions include `2.3.0`, publish time `2026-07-14T16:48:39.093Z`
  — matches the workflow completion time exactly.
  (Note: an initial verification attempt queried GitHub Packages org API and found only versions
  up to 1.2.0 — that was the wrong registry, not a publish failure. Corrected by reading the
  workflow file, then confirmed against npmjs.org.)

## Step 5: other two review-PASS L0 lanes (no tags)

### wave/l0-2-consent-adr (ADR-017, doc-only)

- **PR:** [#313](https://github.com/astragenie/astramem-local/pull/313) — "docs(adr): ADR-017 —
  third-party speaker consent model (FEAT-489/491 gate)". 1 commit (`92d92ca`).
- **Review on record:** RATIFY —
  `.claude/artifacts/crew/reviews/20260714T163515Z-review-result-adr-017-consent-model-ratification.md`.
  Unblocks FEAT-489/491 with no new infra, no contradiction with ADR-009, `consent_disclosed`
  placement verified against the shipped schema. ADR status stays **Proposed** in the doc text —
  product-owner sign-off on three explicitly-scoped open questions is pending; this PR merges the
  doc as-is and does not flip status to Accepted.
- **CI:** all 5 checks green.
- **Merge:** auto-merge fired automatically. Merge commit `3b8e903414b3df3881566443cf94db66a5bebc6a`.

### wave/l0-4-leak-sentinel (FEAT-494)

- **PR:** [#314](https://github.com/astragenie/astramem-local/pull/314) — "feat(doctor):
  memory-leak sentinel via least-squares RSS growth fit (FEAT-494)". 1 commit (`f4a3414`).
- **Review on record:** PASS —
  `.claude/artifacts/crew/reviews/20260714T163459Z-review-l0-4-leak-sentinel.md`. OLS math
  correct with degenerate-input guards, 5 independent WARN gates combined with AND, clean
  doctor-check registration, no silent error-swallowing. 11/11 new tests, 243/243 full doctor
  suite (no regressions), `tsc --noEmit` clean.
- **CI:** all 5 checks green.
- **Merge:** auto-merge fired automatically. Merge commit `57b349838b409ec81dabf74bc233ec4825ba00df`.

## Step 6 (added mid-run): wave/l0-5-pkg-design (docs-only, no tag)

- **PR:** [#315](https://github.com/astragenie/astramem-local/pull/315) — "docs(design): FEAT-489
  whisper.cpp audio add-on packaging design (L0-5)". 2 commits (`8bad77c`, `d7cddc0`).
- **Review on record:** APPROVE —
  `.claude/artifacts/crew/reviews/20260714T163514Z-review-result-feat-489-l0-5-packaging-design-review.md`.
  Rewritten after a withdrawn finding (first pass verified citations against the wrong checkout —
  the main working copy on an unrelated branch, not the `wave/l0-5-pkg-design` worktree; re-verified
  correct on the second pass). Decision block at top is authoritative per team-lead instruction.
- **CI:** all 5 checks green, docs-only change.
- **Merge:** auto-merge fired automatically. Merge commit `145a4d2ed88f80b76bbe2d12114a58f023851edc`.

## Step 7 (added mid-run): wave/l0-3-embcache (FEAT-492, merged LAST per team-lead — known conflict)

- **PR:** [#316](https://github.com/astragenie/astramem-local/pull/316) — "feat(providers):
  document-role embedding cache (FEAT-492)". Base 5 commits + 1 merge-resolution commit + 1
  post-merge fix commit (7 total).
- **Review on record:** PASS —
  `.claude/artifacts/crew/reviews/20260714T164439Z-review-l0-3-embcache-feat-492.md`. Original
  NEEDS_FIX (cache failures could fail the whole distill/reembed job) closed by commit `6f4d0e4`
  before this PR was opened, re-reviewed PASS with 10/10 tests covering both read-throws and
  write-throws directions.
- **Known conflict, resolved as instructed:** merged `origin/main` (already containing PR #314)
  into the branch locally. `src/doctor/checks/index.ts` conflicted exactly as the review predicted
  — both lanes insert a check at the same anchor line after `checkSpoolQuarantine(dataDir),`.
  Resolved by keeping both entries (`checkEmbedCacheHitRate(...)` + `checkMemorySentinel()`),
  additive, no interaction.
- **Second problem, NOT previously flagged, found during the merge:** `migrations/042-embed-cache.sql`
  (this lane) collided with `migrations/042-extraction-yield.sql`, which had landed on `main`
  earlier the same day via an unrelated track (PR #300) — outside the set of lanes the L0-3 review
  checked against ("no collision with wave/l0-1, l0-2, l0-4, or l0-5"). `src/storage/migrate.ts`
  has a hard runtime guard (issue #188) that throws if two migration files share a version number
  — this would have been a guaranteed-fatal collision on first `migrate()` call had it shipped as-is.
  Resolved by renumbering to `migrations/043-embed-cache.sql` (version is derived purely from the
  filename prefix per `migrate.ts:101-102`, so this is a complete fix) and updating doc-comment
  references in `src/doctor/checks/embed-cache.ts`, `src/providers/embed/cache.ts`,
  `src/storage/embed-cache.ts`, `CHANGELOG.md`. Verified post-renumber:
  `tests/storage/migration-renumber.test.ts` (static "no two files share a number" guard) and
  `tests/storage/migrate.test.ts` / `schema-version.test.ts` all pass.
- **Third problem, caught by CI, not local testing:** CI's "TypeScript type-check" job runs
  `bun run typecheck:tests` (`tsc -p tsconfig.tests.json`, which includes `tests/**/*`) — a
  different, stricter config than the `tsc -p .` I (and the original review) had checked, which
  excludes `tests/` entirely. It failed on a pre-existing bug in `tests/providers/embed-cache.test.ts`
  (confirmed present already at commit `6f4d0e4`, predating my merge): two destructured array
  elements (`const [vecA] = await cacheA.embed(...)`) flagged as possibly-undefined (TS18048).
  Fixed with optional chaining on the assertions (`vecA?.length`) — an actually-undefined vector
  still fails the `expect()` since `undefined !== 4/8`, so this doesn't weaken what the test catches.
  Re-verified `npx tsc -p tsconfig.tests.json` clean and `npx vitest run tests/providers/embed-cache.test.ts`
  still 10/10 before pushing the fix commit.
- **Local test verification (as instructed), before first push:**
  `npx vitest run tests/doctor/ tests/providers/embed-cache.test.ts tests/storage/migrate.test.ts
  tests/storage/migration-renumber.test.ts tests/storage/schema-version.test.ts` →
  **344/344 tests, 37 files, all pass.** `npx tsc --noEmit -p .` clean. (One separate vitest file,
  `tests/storage/migration-files-eol.test.ts`, failed locally on migrations 006-041 — confirmed via
  a disposable `origin/main` worktree that this is a stale-CRLF artifact specific to this one
  worktree's checkout history, not the repo or the commit content: the actual git blobs for every
  migration file, verified via `git show HEAD:<path>`, contain zero CR bytes. Did not "fix" by
  rewriting the worktree — CI's fresh `actions/checkout` confirmed this, passing clean.)
- **CI:** first push — TypeScript type-check failed (see above), all others green. Diagnosed root
  cause before touching anything further (not a blind retry), pushed the one-file fix, re-ran CI:
  all 5 checks green on the second pass.
- **Merge:** auto-merge fired automatically after the fix push. Merge commit
  `775a33b1d9af719ee1b060b4598b439c3323b840`.

## Anything red

Yes, on PR #316 only, and diagnosed rather than retried blind: CI's `TypeScript type-check` job
failed on first push, root-caused to a pre-existing bug in the l0-3 lane's own test file that
neither the original builder nor the review's `tsc --noEmit -p .` check could have caught (that
config excludes `tests/`). Fixed with a 2-line, test-only change (see Step 7 above), re-verified
against the exact CI-used config before re-pushing, and the re-run went green. All other checks on
all five PRs were green on first pass.

## Final state

- `main` HEAD includes all five merges, in sequence: `#312` → `#313` → `#314` → `#315` → `#316`.
- Tag `contracts-v2.3.0` points at the `#312` merge commit (`53f4bcd3`), predating `#313`-`#316`
  — correct, since only the contracts lane needed the tag.
- `@astragenie/astramem-contracts@2.3.0` is live and `latest` on npmjs.org.
- `src/doctor/checks/index.ts` on `main` now registers both `checkEmbedCacheHitRate(...)` and
  `checkMemorySentinel()`.
- `migrations/` on `main` has both `042-extraction-yield.sql` and `043-embed-cache.sql` — no
  version collision.
