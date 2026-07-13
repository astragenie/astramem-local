# ADR-016: The Junction Invariant

> **Citation policy — read this before chasing any line number in this document.**
>
> This document follows ADR-015's own rule: **anchor on the SYMBOL NAME, not the line
> number.** `docs/adr/ADR-015-loud-failure-invariant.md`'s own footnotes demonstrate why —
> a file it was citing moved under three separate honest readings in one afternoon. This
> ADR's evidence base moved twice while it was being written: `src/doctor/checks.ts` grew
> from 2,167 lines (the count in PR #231's own description, opened 2026-07-13T20:48Z) to
> **2,378 lines** by the time this ADR was drafted, because unrelated work kept landing in
> the same file while the split that removes it as a target sat in review. That is not an
> error in either document. **It is Instance 2, restated by the citation itself.**
>
> Every `file:line`, PR number, and commit SHA below was checked directly against this
> worktree's source and `git log` at write time (base commit `429e99c`). Where a claim
> handed to the author of this ADR could not be verified this way — or was contradicted by
> what the repo actually shows — that is called out explicitly rather than repeated. See
> "Corrections to the record" below.

**Status:** Proposed
**Date:** 2026-07-13 · **Confidence:** High for both instances. Getting here took two
rounds of correction on Instance 2's near-miss anecdote — first an overstated claim
("nothing would have caught it"), then an under-verified rebuttal of it (a commit
timestamp mistaken for a merge-base) — both documented in §4, both directly reproducible
against `git log` and `git merge-base`.
**Context:** Two failures landed in this repo on 2026-07-13, in different subsystems,
authored by different agents, discovered independently — and turned out to be the same
defect wearing two disguises. An architecture review recommended naming the pattern once,
rather than continuing to fix each instance as a one-off, because the underlying shape
recurs anywhere a shared aggregate sits downstream of parallel authors.

## Decision

### 1. The invariant

> **A hand-maintained aggregate over a shared, parallel-authored set is not a subsystem.
> It is a junction — and every parallel author who touches it collides by construction,
> regardless of what they changed.**

Two failure shapes fall out of this, and both hit this repo on the same day:

1. **The aggregate itself is wrong.** A count, a max, or a version is declared as a
   literal instead of derived from the set it describes. Two authors who each add one
   unit to the set (a migration file, a check function) independently believe they also
   own the literal — and they don't, not really, because the literal only has one correct
   value and it is a function of the whole set, computed at the moment someone asks.
2. **The container itself is wrong.** The enumerable set is not file-per-unit — every
   unit lives inside one shared file (a giant `checks.ts`, a giant `routes.ts`), so
   "add one unit" is spelled "edit a file everyone else touching this feature class is
   also editing this week." There is no wrong *value* here, only certain, permanent merge
   contention over one file that was never a coherent subsystem to begin with — it is the
   union of every unit anyone has ever added to it.

Instance 1 (below) is the first shape in its purest form: the file-per-unit structure
already existed, and only the derivation was missing. Instance 2 is the second shape
without the first: no aggregate was wrong, but the container was a single file every
"make this observable" slice had to open.

### 2. How to recognise it — a checklist for a file you have never seen

- **Is an aggregate hand-maintained when it could be derived?** A literal count, max,
  or version number sitting next to (or worse, disconnected from) the enumerable set it
  describes is the tell. If the answer to "what should this number be" is "count the
  files," it must never be typed by hand.
- **Do unrelated parallel changes conflict in this file, regardless of content?** If two
  PRs that touch nothing in common still produce a merge conflict here, the file is not
  gating on content — it is gating on position (line N in an array, a literal that only
  has one correct value).
- **Is this file a junction rather than a subsystem?** A subsystem has a cohesive
  responsibility one author can reason about end to end. A junction is where independent
  slices happen to need to register something. `src/doctor/checks.ts` at 2,378 lines is
  not "the doctor subsystem" — every doctor check that ANY other slice ever added lives
  in one function body (`coreChecks()`) that every one of those slices had to edit.
- **Does the enumerable set already exist, with only the derivation missing?** This is
  the cheap-fix case (Instance 1): if `migrations/033-foo.sql` through `039-bar.sql`
  already exist as files, nothing should ever need to also be told "the count is 39."

### 3. The evidence — two instances, one day

#### Instance 1 — migration numbers (the pure form, both shapes fixed)

The file-per-unit structure already existed (`migrations/NNN-*.sql`). Only the
**derivation** was missing: `SCHEMA_VERSION` was a hardcoded integer literal in **nine**
places — `src/server/lib/wire-meta.ts`'s `SCHEMA_VERSION` constant, plus `toBe(N)` /
`toHaveLength(N)` assertions across eight test files (`migrate`, `upgrade-path`,
`atom-v3`, `entities`, `entity-relations`, `entity-validity`, `version`, `ingest-e2e`).

**Consequence: any two migration-bearing PRs conflicted by construction, regardless of
what they changed.** Measured 2026-07-13, verified against `git log`:

- **PR #216** (issue #205, atom-level validity extraction) was renumbered **four times**
  — `033 → 034 → 035 → 036 → 037` — once for each PR that landed ahead of it while its
  branch was open: `#208`, `#218`, `#212`, `#210`. This is recorded verbatim in
  `src/server/lib/wire-meta.ts`'s own migration-history comment, not reconstructed after
  the fact.
- **PR #212** — the successful, second landing of the fix originally opened as **PR #188**
  ("schema_version content-hash verification — the structural fix for #185/#186," commit
  `0b6ddb1`) — was itself renumbered twice while merging (`033 → 034`, colliding with
  `#208`; `034 → 035`, colliding with `#218` — commits `a991cee` and `3787667`, both
  literally titled "renumber issue #188 fix"). **The bug was eating its own fix**: the PR
  that fixes "migration numbering has no content hash" was renumbered by exactly the
  defect it exists to close.
- **A tenth hardcoded literal** was later found hiding in a `toThrow()` regex in
  `tests/storage/migrate.test.ts` — `/Schema-version constant drift: wire-meta says 999,
  DB says 39/` — invisible to a `toBe(N)`/`toHaveLength(N)` grep because it lives inside a
  string-matched error message, not a numeric assertion. (Verified in the diff of commit
  `cee69b3`; the removed literal's value was **39**, not 37 — the number a five-migrations-
  in-one-afternoon day made stale within hours of being written down, which is its own
  small instance of this ADR's citation-policy point.)

Fixed by **PR #229** (`cee69b3`) + **PR #233** (`429e99c`): `src/storage/schema-version.ts`
derives `SCHEMA_VERSION` as `Math.max()` over the parsed `NNN-` prefixes in
`migrations/*.sql`, with zero internal imports so both the storage layer and the server
layer can import it without a cycle. `wire-meta.ts` now re-exports it instead of declaring
a literal. Verified live: **zero occurrences** of `toBe(3[0-9])`, `toHaveLength(3[0-9])`,
or any other hardcoded schema-version literal remain in `tests/` as of this ADR.

**The tail of Instance 1 is itself part of the lesson and belongs in this ADR.** PR #229
shipped with its test-side half **silently reverted** during two rebases. Per `429e99c`'s
own commit message: conflicts were resolved with `git checkout --ours`, but **during a
`git rebase`, `--ours` means the upstream/base side, not the commits being replayed** —
the inverse of what `--ours` means during a normal merge. Six test-file conflict
resolutions kept upstream's hardcoded-literal bump and silently discarded the
`SCHEMA_VERSION` conversion. **The suite stayed green the entire time**, because the
literal happened to numerically equal the derived value at each point in the rebase — a
test passing for the wrong reason. It took a human ("architecture review," per the
commit message) re-deriving the claim against `origin/main` to notice. This is not a
hypothetical risk this ADR is warning about — **it already happened, in the same PR that
fixes the thing it happened to.**

#### Instance 2 — `src/doctor/checks.ts` (the second shape: no wrong value, a wrong container)

`checks.ts` was 2,167 lines when PR #231 (the split, currently open+draft) was written,
and stands at **2,378 lines** in this worktree's `main` as this ADR is drafted — it kept
growing in the interval, which is itself evidence of the pattern, not a citation error
(see the header note above). Every "make this observable" slice must define a check
function **and register it inside `coreChecks()`** — one function body every parallel
canary-adding slice converges on.

Per PR #231's own description (`gh pr view 231`), **three separate slices collided in
`checks.ts` in a single day**: A3's `checkSpoolQuarantine`, issue #200's
`checkEntityLinkRate` (landed as PR #215), and issue #226's `checkMemoryHealth` red-branch
change. The wave plan's disjointness table (`docs/specs/20260713-stability-wave-plan.md`
§B4) assigns files per subsystem and has no line for `checks.ts` — because it isn't a
subsystem in that table's sense. **It's a junction.** That is the diagnostic tell from
§2 above, stated in the repo's own words before this ADR existed to name it.

The fix — PR #231, `refactor/doctor-checks-registry`, currently **open, draft** — splits
`checks.ts` into `src/doctor/checks/` (one file per check, 35 files, aggregated by
`checks/index.ts`), leaving `checks.ts` as a thin re-export shim so every existing import
site keeps working. Adding a canary now costs one new file plus a two-line touch to
`index.ts`, not an edit inside a shared function body. Not yet merged as of this ADR.

### 4. Corrections to the record — two unverified claims, from two different people, while writing the section about verification

This ADR was commissioned with a specific "near-miss" scenario: that PR #231's
modify/delete conflict, resolved with "keep my version, the split is the whole point,"
would have silently deleted `checkEntityLinkRate` and the atom-validity rate gate,
reverting both to a known-bad `extracted === 0` existence check — and that **nothing in
the repo would have caught it**, because `checkEntityLinkRate` supposedly had no test at
all, and the atom-validity tests supposedly never exercised the `0 < rate < 5%` band where
the two gates disagree.

**Round one (this author's first draft).** `tests/doctor/entity-link-rate-check.test.ts`
exists, has 8 cases, and directly exercises the disagreement band (`'87% of recent
memories unlinked — WARN'`, `'2% of recent memories unlinked — PASS (healthy)'`).
`tests/doctor/atom-validity-extraction-check.test.ts` has a case literally named
**"coverage COLLAPSES to 2% — WARN, not a green 'well, it is not zero'"**, whose own
comment states it is *"THE TEST WHOSE ABSENCE LET THE BUG SHIP"* — this exact gap was
identified and closed in PR #228, the same day. **"Nothing would have caught it" was
false, and stays retracted: both canaries have dedicated boundary-band regression tests
today, and a naive revert would fail loudly.**

But this author then over-corrected, on a second unverified claim: that because PR #231's
commits carry an authored timestamp roughly five hours after PR #215 and PR #228 merged,
"there is no window in which #231 could modify-vs-delete-conflict against a pre-fix
version of these checks." **That reasoning is wrong, and it was never checked before being
written down** — a commit's author-date does not establish what commit its branch forked
from; only `git merge-base` does, and `git rebase` explicitly preserves the original
author-date of a replayed commit while moving it to sit on a different, later parent. This
was caught by direct review, not by this author.

**What direct verification (`git merge-base`, `git show <sha>:path | grep`) actually
shows, reproduced independently for this revision:**

```
$ git show 24f1762:src/doctor/checks.ts | grep -c "checkEntityLinkRate\|VALIDITY_EXTRACTION_WARN_FLOOR"
0
```

`24f1762` is PR #227 ("add B3 + B4 to the wave plan"), merged **15:18:43** — before PR
#215 (15:42) and PR #228 (15:33). At that point in the repo's history, `checks.ts`
genuinely contained neither canary. `24f1762` is an ancestor of PR #231's current branch
tip (`git merge-base --is-ancestor` confirms it), which is consistent with the branch
having been built from a point in history that predated both fixes — **the modify/delete
conflict was real**, not a hypothetical. The branch has since been rebased: its *current*
merge-base against `origin/main` is `7f70ba1` (PR #224, 15:53:26), which already contains
both canaries (5 matches for the same grep), and the branch's own split tree now correctly
contains `src/doctor/checks/entity-link-rate.ts` with the rate-based `ZERO linked
entities` / `MEANINGFUL_USAGE_THRESHOLD` logic intact — restored, not left reverted.

**So the accurate account, verified in both directions, is narrower than either version
that came before it:**

- **The collision: REAL.** At the point the split was built from, `checks.ts` on the
  branch genuinely lacked both canaries that had landed on `main` in the meantime. The
  natural resolution of that modify/delete conflict — take the branch's version, since the
  split *is* the branch's entire point — would have shipped without them.
- **"Silent / nothing would catch it": FALSE, still.** The dedicated boundary-band tests
  for both canaries exist and would fail loudly against a version missing the rate logic.
  Consistent with that: the branch's current state has both correctly restored, not
  dropped.

**This double correction is itself the strongest illustration of rule 5, better than
either single version of events would have been.** Two different people, in the same
session, each asserted a confident negative from a plausible-looking signal — a
reviewer's summarized report, and a commit timestamp — and neither ran the one command
that actually settles it (`git merge-base`, or the grep against the cited SHA) before
writing the claim down. **That is the rule this ADR states, demonstrated twice, inside the
document that states it.** Use this, not a hypothetical, when rule 5 needs a citation.

### 5. The binding rules

1. **Derive aggregates; never declare them.** If a number's only correct value is "count
   (or max, or hash) the enumerable set," it must be computed from that set at the point
   of use, not typed as a literal anywhere — not once, and especially not in nine places
   that are each individually easy to justify in isolation. `src/storage/schema-version.ts`
   is the reference implementation for this repo going forward.
2. **File-per-unit for anything parallel authors extend.** If a class of thing (a
   migration, a doctor check, a route) is added to by more than one slice per week, each
   instance gets its own file. A shared function body that every addition edits is a
   junction, and every future parallel author will collide in it, regardless of what
   discipline the wave plan tries to impose around it.
3. **A shared registry that cannot be split needs an explicit owner or an explicit merge
   order.** Not every aggregate can be made file-per-unit cheaply. Where it can't, name
   who resolves conflicts in it, or fix the order slices land in — silence is what let
   three slices discover the collision by hitting it, not by reading a plan.
4. **A names-and-order diff is not a proof of behavior preservation.** PR #231's own
   "41/41 checks, identical names, identical order" verification is a real and correct
   thing to check — and it is also, by construction, blind to a changed threshold, an
   inverted condition, or a dropped branch inside a function body that kept its name and
   position. For a refactor that claims zero behavior change, pair the names-and-order
   diff with either a byte-range function-body diff against `origin/main`, or — the
   stronger, already-available option in this repo — confirm the existing behavioral test
   suite for the moved code (not just "does it still import") ran and passed both before
   and after. §4 above shows this second check is what actually protects `checks.ts`
   today; rely on it explicitly, not on the order diff alone.
5. **A claim about how the system would fail is a claim about the system, and must be
   verified the same way a claim about success is verified — restated from ADR-015 §5,
   because writing THIS ADR needed the rule twice, from two different authors, in the same
   session (§4 above).** A confident, well-written failure scenario is not evidence until
   it is checked against the actual state of the repo — and neither is a confident,
   well-written *correction* of one. Specifically: a commit's author-date is not its
   branch's fork point; only `git merge-base` (or an ancestry check against the cited SHA)
   establishes what a branch did or didn't contain when it diverged. Run that command
   before asserting either "this would have collided" or "this couldn't have collided."
6. **During a `git rebase`, `--ours` means the upstream/base side, not the commits being
   replayed — the inverse of a normal merge.** This is a rule of its own because it is not
   intuitive, it silently discards the replayed side's real work, and it already produced
   a six-file silent revert in this repo (Instance 1, PR #229/#233) that stayed green the
   entire time it was wrong. Anyone resolving rebase conflicts with `--ours`/`--theirs`
   should say out loud, before running the command, which side each flag actually keeps —
   not rely on merge-flow muscle memory.

### 6. Enforcement

- **Zero-literal grep for schema version.** Verified manually for this ADR
  (`toBe(3[0-9])`, `toHaveLength(3[0-9])`, `/DB says 3[0-9]/` — zero matches in `tests/` as
  of `429e99c`). **This is not yet a standing test.** `tests/hygiene/` already has
  `no-hardcoded-embed-dim.test.ts` as the pattern to follow — a `no-hardcoded-schema-
  version.test.ts` sibling that greps for the same shape does not exist yet and should be
  added; until it is, this rule is enforced by discipline and this ADR, not by CI.
- **The boot-time duplicate-version guard (PR #223) plus the CI-time collision/gap guard
  (`tests/storage/migration-renumber.test.ts`)** are both live and are the concrete
  enforcement for rule 1 in the migrations case specifically — one catches two files
  claiming the same number at boot, the other catches it before merge.
- **For refactors claiming zero behavior change: rule 4's byte-range diff or full
  behavioral-suite-both-sides check**, not a names-and-order diff alone. PR #231 already
  does the stronger version of this (full `tests/doctor/` + `tests/hygiene/` run, both
  sides) — make that the documented bar for this class of PR, not an implicit nice-to-have.
- **Cross-repo: `runner-plugin#508`** (verified open, `astragenie/runner-plugin`), filed
  the same day, names the loop-level half of Instance 1: the dispatcher hands N parallel
  worktrees the same `origin/main` and each independently picks "the next free" value for
  any globally-scarce resource (migration numbers, ports, any monotonic counter) — so N
  agents will always race for the same integer no matter how disciplined any single repo's
  fix is. The repo-side fix (this ADR, and B4's derivation) and the runner-side fix
  (an allocation protocol or a merge-time renumber hook) are independent problems; closing
  one does not close the other.

### 7. The insight that must be stated plainly

**This was latent for the project's entire life. This repo's own throughput is what
turned it into a disaster.** A human team merging two PRs a week hits a migration-number
collision once a year and shrugs it off. This repo merged roughly ten PRs an hour across
a dozen parallel worktrees on 2026-07-13. **The parallel-agent workflow did not create
either defect described above — it converted a rare annoyance into a permanent, daily
tax.** That reclassification — from "occasional nuisance" to "the thing that ate a full
day of merge churn" — is why this earns an ADR instead of two independent bug fixes.

## Prior art

Rails abandoned sequential integer migration IDs for timestamp-prefixed IDs
(`20260713194500_add_x.rb`) specifically because two authors cannot collide on a
timestamp — this is accurate and well established. **Django did not do the same thing**,
and a version of this claim repeated in this repo's own `runner-plugin#508` overstates it:
Django kept **per-app sequential** migration numbers, but pairs them with an explicit
dependency graph and a first-class conflict-detection step (`makemigrations --merge`)
that generates a merge migration when two branches both claim the same next number for
the same app. That is a different solution to the same root problem — detect and
reconcile the collision, rather than choose an ID space where it cannot occur — and it is
closer to what this repo actually did (a boot-time duplicate guard, PR #223, plus a
CI-time collision test) than to Rails' escape into timestamps.

**astramem-local has not adopted timestamp IDs.** It kept sequential integers and added a
loud boot-time duplicate guard (#223) and a CI-time collision/gap check
(`migration-renumber.test.ts`) instead — closer to Django's posture than Rails'. Present
this as the **deliberate trade actually made**, not an oversight: `docs/specs/20260713-
stability-wave-plan.md` §B4 explicitly considered timestamp IDs and chose to derive the
constant now, leaving the timestamp question open ("the migration-039+ numbering is easy
to change now and painful later"). **What would force a revisit:** if the derive-plus-
guard combination stops being sufficient — i.e., if collisions recur even with
`SCHEMA_VERSION` derived and the boot/CI guards in place, which would mean the problem is
purely about the ID *space* being contended (multiple agents grabbing the same next
integer) rather than about a hand-maintained aggregate (which is now fixed). That is
exactly the failure mode `runner-plugin#508` is tracking at the dispatcher level.

## Options considered

1. **Write this ADR now, generalize both failure shapes, require file-per-unit or an
   explicit owner for any shared registry going forward (chosen).** Turns two same-day
   incidents into a rule a reviewer can cite by name, instead of re-deriving "this is the
   same bug as the migration thing" from memory on every future PR that touches a
   registry file.
2. **Leave it as tribal knowledge and keep fixing instances ad hoc.** Rejected — this is
   what already happened between Instance 1 landing and Instance 2 being noticed: the
   same day, the same root cause, and nobody generalized it until an architecture review
   asked for it explicitly.
3. **Force timestamp-based IDs everywhere a monotonic counter exists.** Rejected as this
   ADR's scope — it is a real option (see Prior art) and may be the right call for
   migrations specifically, but it does not generalize to Instance 2's shape (`checks.ts`
   was never a numbering problem; it was a container problem) and should be decided
   deliberately per resource class, not mandated blanket by this document.
4. **A single centralized "registry service" all shared aggregates report into, built
   now.** Rejected for the same reason ADR-015 rejected the analogous centralized-anomaly-
   service option: the reference implementations (`schema-version.ts`'s derivation,
   `checks/`'s file-per-unit split) already exist, are tested, and are cheap to replicate.
   Building an abstraction layer before a third instance exists to generalize from would
   delay concrete fixes to solve an integration problem that isn't there yet.

## Consequences & migration

- **No code changes from this ADR itself.** Instance 1's fix (PRs #229, #233) and
  Instance 2's fix (PR #231) are both independently in flight or landed; this document
  names the pattern they are both instances of and states the binding rules for the next
  one, per rules 1–3 above.
- **Any future PR that adds a shared, parallel-authored aggregate must state, in the PR
  description, whether the aggregate is derived or declared** — a reviewer citing this
  ADR is sufficient grounds to block a PR that declares a literal where derivation was
  available (rule 1).
- **Any future PR that adds to a growing shared-registry file three or more times in a
  rolling window** (the `checks.ts` threshold that actually triggered PR #231) should be
  treated as a signal to split it, not a coincidence to keep absorbing.
- **Any PR resolving rebase conflicts with `--ours`/`--theirs` should say, in the commit
  or PR description, which side each flag kept** — cheap to write, and it is exactly the
  sentence that would have caught Instance 1's six-file silent revert before a human had
  to re-derive it from `origin/main` (rule 6).
- Cross-reference: this ADR's "a claim about failure must be verified like a claim about
  success" (rule 5) is ADR-015 §5's rule, restated because this ADR's own commissioning
  process needed it — see §4 above for the correction it produced.

## References

- `docs/specs/20260713-stability-wave-plan.md` §B4 — the incident record and the fix plan
  this ADR generalizes from (migration numbers).
- `docs/specs/20260713-teardown-remediation-plan.md` — standing verdict (H2: sound core,
  accumulated debt) this ADR's framing is consistent with; this is a debt-class finding,
  not a redesign-gate finding.
- `src/storage/schema-version.ts`, `src/server/lib/wire-meta.ts` — the reference
  derivation for Instance 1.
- `tests/storage/migration-renumber.test.ts`, PR #223 (`1f29b9a`) — the CI-time and
  boot-time collision guards.
- Commits `cee69b3` (PR #229), `429e99c` (PR #233) — the derivation fix and the `--ours`
  rebase-revert correction, including the incident's own account of what went wrong.
- PR #231 (`refactor/doctor-checks-registry`, open/draft as of this ADR) — Instance 2's
  fix; its own description independently names the "junction, not a subsystem"
  diagnostic this ADR generalizes.
- Commits `24f1762` (PR #227, an ancestor of PR #231's branch, predates the two canary
  fixes) and `7f70ba1` (PR #224, PR #231's current merge-base against `origin/main`,
  postdates them) — the `git merge-base` evidence behind §4's second-round correction.
- `tests/doctor/entity-link-rate-check.test.ts`,
  `tests/doctor/atom-validity-extraction-check.test.ts` — the existing boundary-band
  regression coverage that would have caught a silent revert; corrects the "nothing would
  have caught it" half of §4's initiating near-miss claim, not the "there was no real
  collision" half, which independent verification confirmed was real.
- `runner-plugin#508` (`astragenie/runner-plugin`, open) — the dispatcher-level half of
  Instance 1: no allocation protocol for globally-scarce values across parallel
  worktrees. Independent of this ADR's repo-side fixes; both are needed.
- ADR-015 (The Loud Failure Invariant) — sibling document this ADR matches in structure
  and citation policy; §5's "verify a failure claim like a success claim" rule is reused
  directly (rule 5, above), and its own footnote about citations rotting mid-document is
  the same phenomenon this ADR's `checks.ts` line count hit while being drafted.
