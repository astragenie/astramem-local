---
status: PASS
---

# Review Result — SLICE-422 / FEAT-462 slice A+C (eval resume ledger + kill-resilience)

- Worktree: `C:\work\mega\astramemory-local-worktrees\w462a`, branch
  `feat/feat-462a-resume-ledger`, commits `a20db54` (original), `9cfd2f3` (review fix)
  vs `main`/`c947310`
- Reviewer: independent review (read-only, no edits made, worked only in this worktree)
- **Original verdict: NEEDS_FIX** (below) — **Final verdict (after `9cfd2f3`): PASS.**
  See re-review section at the end. Original finding: one MEDIUM-HIGH finding,
  verified concretely: a `--resume`
  invocation with a smaller `--n` than the original run can silently complete with a
  narrower scope than intended (0 failures, looks fully successful), the opposite —
  and more dangerous — failure direction from what the handoff's own risk section
  anticipated. One MEDIUM finding on AC-7's literal-vs-spirit boundary, called out
  explicitly per the review ask. The core exactly-once accounting, torn-tail
  tolerance, kill-test determinism, and the command/pid groundwork are all genuinely
  solid — verified directly, not just trusted from the handoff.

## 1. Exactly-once accounting — verified correct, both by tracing and by testing

Traced `ingestQuestions` (`scripts/eval/longmemeval/ingest.mts:76-86`): `jobs` is built
**once** per invocation from the deterministic sample, and the loop partitions it
disjointly into `replayedOutcomes` (ledger says `ok:true` — no network call at all)
and `toRun` (everything else, including a prior `ok:false` — gets a fresh POST). The
final `outcomes = [...replayedOutcomes, ...freshOutcomes]` always has **exactly one**
entry per job, so a session literally cannot be double-counted in a single manifest —
this isn't a defensive check, it's structural (one job, one partition, one outcome).
The team lead's hypothesized failure ("ledger says ok, resumed run re-ingests anyway")
cannot occur: the code branches on `prior?.ok` before ever reaching the fetch call.

Also confirmed the manifest itself is **not** an "old manifest ∪ new manifest" union
at any layer (`run-smoke.mts`'s `mergeIngestManifests`/`mergeDistillResults` only
merge **this invocation's** per-shard results — there's no read-and-merge of a
previously-written `ingest-manifest.json` from disk anywhere) — the ledger is the
*only* persistent memory across invocations; the manifest is always freshly computed
from the current job list. This is a cleaner design than "merge two manifests" would
imply and avoids an entire class of merge-logic bugs.

**Verified with the real code**, not just by reading: ran the existing
`resume-integration.test.ts` (SIGKILL mid-ingest, respawn, resume) 5x in a row — all
green, consistent ~830ms timing. Its strongest assertion (`finalState.ingestCallCount
=== 6`, a counter incremented by the **fake daemon itself** on every POST it
receives, replay or not) is a genuinely independent, server-side proof that no
already-ok session was ever re-POSTed — I confirmed the fake daemon increments this
counter unconditionally on every `/ingest/transcript` call (`fake-eval-daemon.mjs:112`),
so this isn't a client-side-only bookkeeping claim.

**Failed-entry retry** (the inverse case asked about): confirmed via code tracing that
a job whose latest ledger entry is `ok:false` goes into `toRun` and gets retried; if
that retry succeeds, `appendLedgerEntry` appends a **new** line (the ledger file now
has two lines for that `session_id`), and `ledgerCompletedMap`'s last-write-wins Map
semantics resolve it to the latest (successful) entry — verified directly (see
section 2 below) with a synthetic ok:false-then-ok:true sequence. The CURRENT run's
manifest only ever reflects the current attempt's single outcome per job, regardless
of how many prior ledger lines exist for that session — no double-counting.

## 2. Torn-tail tolerance — verified directly with adversarial constructions

Constructed three cases directly against `readLedger`/`ledgerCompletedMap`, not just
via the shipped unit tests:

- Three complete lines + a deliberately truncated, unparseable trailing line (no
  newline, invalid JSON): `readLedger` returns exactly the 3 complete entries — the
  torn line is dropped, nothing else is lost.
- A retry sequence (`ok:false` then `ok:true` for the same `session_id`, two separate
  `appendLedgerEntry` calls): `ledgerCompletedMap` correctly resolves to the latest
  (`ok:true`) entry; `readLedger`'s raw output still shows both lines on disk (no
  silent overwrite of history, just correct last-write-wins resolution on read).
- A malformed line in the **middle** of an otherwise-valid file (not just the last
  line, which is the shape the code comment specifically describes): both the
  before and after complete entries still parse correctly. The parser's actual
  behavior (per-line try/catch, unconditional) is more general/robust than its own
  doc comment narrowly claims ("a torn line can only ever be the last one") — the
  comment describes how corruption *arises in practice*, but the code tolerates a
  malformed line at any position, which is strictly safer.

## 3. AC-7 byte-compatibility — literal text satisfied; two out-of-scope side effects called out explicitly, per the review ask

**AC-7 as literally written** — the four named files (`ingest-manifest.json`,
`distill-wait-result.json`, `run-manifest.json`, `hypotheses.jsonl`), exit-code
semantics, and `--dry-run-throughput`'s own output shape — **is satisfied**: none of
those four files' schemas changed (`IngestManifest`'s interface is untouched; the new
`ledgerPath`/`resumeCompleted` are input options, not new manifest fields), and exit
codes are unchanged.

**However, two real side effects exist outside that literal scope, on a plain default
invocation with no `--resume`/`--detach` flag**, and I'm calling them out explicitly
as the review asked rather than silently deciding for the team:

- **A new file (`ingest-ledger.jsonl`) always appears in the run dir**, per-shard, on
  every invocation — confirmed via diff (`run-smoke.mts`'s `runShard` now
  unconditionally computes `ledgerPath` and passes it to `ingestQuestions`, which
  unconditionally calls `appendLedgerEntry` whenever `ledgerPath` is set — there is no
  `if (resume)` gate on the *write* side, only on the *read* side). This is genuinely
  new run-dir content compared to `main`. **My call: acceptable-additive** — it's a
  new file, not a changed one, cheap, and directly serves the stated goal ("any run
  dir can later be resumed even if `--resume` wasn't anticipated at launch"). If the
  team's bar is "byte-identical run-dir contents, not just the four named files," this
  would need a flag to suppress the ledger write entirely on non-resume runs.
- **A new, narrow failure surface**: `appendLedgerEntry`'s call site
  (`ingest.mts:103-112`) sits **outside** the per-job `try/catch` that wraps the
  network request — if the ledger write itself throws (disk full, permissions,
  antivirus lock on Windows — a real possibility for `.eval-data/` run dirs), the
  exception propagates up through `mapWithConcurrency`'s `Promise.all`, is caught by
  `runShard`'s own try/catch, logged, and re-thrown — which `Promise.allSettled` in
  `runSmoke()` then correctly treats as a shard failure (not an uncaught crash of the
  whole harness; degrades into the *existing* `failedShards` reporting path). **My
  call: not blocking** — it degrades gracefully into an already-modeled failure mode
  rather than corrupting output or crashing catastrophically — but it is a genuinely
  *new* way for an otherwise-healthy default run to fail that didn't exist pre-462.
  Recommend wrapping the `appendLedgerEntry` call in its own try/catch (log-and-continue,
  matching this repo's own "never let auxiliary bookkeeping crash the real work"
  pattern used elsewhere, e.g. the redaction custom-pattern try/catch) as a cheap
  follow-up, not a blocker.

## 4. Kill-test determinism — assessed on the actual assertion shape, not just the `<1s` claim

Examined the specific assertions rather than trusting the "generous margins" framing:
`expect(firstManifest.ok_count).toBeGreaterThan(0)` and `expect(okAfterKill)
.toBeLessThan(6)` are **range-based**, not exact-count assertions — the test does not
require precisely 2 of 6 jobs to complete before the kill fires. This means CI
contention would have to be severe enough to shift the outcome to one of two extremes
(either the 200ms kill timer fires before even the *first* 80ms-delayed job
completes, or `killDaemon` itself takes upward of ~280ms longer than normal to
actually land) before the test could flake — both comfortably outside normal CI
jitter for an 80ms/200ms scale. Ran the file 5 times consecutively locally:
consistent ~830ms total, 2/2 passing every time, no observed variance. **Assessment:
CI-safe as designed** — the range-based assertions are the reason this is more robust
than a naive reading of "generous margins" would suggest; not just trusting the
builder's own claim.

## 5. Flag-mismatch degradation — MEDIUM-HIGH finding, verified concretely: silent scope-narrowing, not just wasted work

The handoff's own "Risks/open questions" section already discloses that `--resume`
with mismatched flags has no runtime guard, but frames the failure mode as
"degrading gracefully to 'resume found nothing to skip'" — i.e., wasteful (re-ingests
everything) but ultimately correct. **I verified this is not the only, or the worst,
failure direction.**

`sampleStratified` (`scripts/eval/longmemeval/lib/dataset.ts:75-113`) computes
per-type quotas from `n` via `apportion`, then does a **seeded shuffle of each type's
full pool** (size determined by the dataset, not by `n`) and **slices** the first
`quota` items. Because the PRNG is a single stateful generator consumed sequentially
across per-type shuffle calls, and each type's *pool size* (not its quota) determines
how many random draws that type's shuffle consumes, the shuffle **order** for a given
type/seed is invariant to `n` — only the slice boundary changes. I verified this
directly with a synthetic dataset (6 question types, 100 questions each, mixed
abstention flags): `sampleStratified(dataset, {n: 30, seed: 42})`'s 30 questions are
a **strict subset** (30/30 overlap) of `sampleStratified(dataset, {n: 50, seed: 42})`'s
50 questions.

**Consequence**: a `--resume` invocation launched with a **smaller** `--n` than the
original run (a plausible typo, or an operator copy-pasting an earlier command by
habit) re-derives a sample whose sessions are *already* present and `ok:true` in the
ledger from the larger original run. Every job gets replayed, zero fresh POSTs, zero
failures — the run completes looking **fully successful**, with `run-manifest.json`'s
`counts.sampled` correctly reflecting the smaller number, but nothing in the harness
warns that this doesn't match the original invocation's scope. This is the *opposite*
and more dangerous direction from "nothing to skip": it's "everything matches, scope
silently narrowed" — exactly the "worst case for an honest number" the review
flagged, and directly contrary to this FEAT's own stated purpose (producing a
trustworthy published eval result). A careful operator diffing `run-manifest.json`'s
`counts.sampled` against their intended `n` would catch it, but nothing in the tool
itself surfaces the mismatch.

**Recommendation**: persist the original `--dataset/--seed/--n/--shards` values to
the run dir on first invocation (a small JSON file, e.g. `run-config.json`), and on
`--resume`, compare the re-derived values against it — WARN loudly (or refuse to
proceed without an explicit override flag) on any mismatch. This is a scoped,
cheap addition relative to the risk it closes, and it directly strengthens the
disclosed-but-mischaracterized risk in the handoff rather than leaving the more
dangerous direction unaddressed. Recommend closing before this tooling is trusted for
an unattended overnight run whose output will be published.

## 6. `spawn-daemon` command override / `pid` groundwork — confirmed inert, production path byte-identical

Confirmed via direct diff (`spawn-daemon.ts`): `command?: string[]` defaults to
exactly the original hardcoded `['dist/cli/index.js', 'serve', '--port', ...]` when
omitted — every real call site (`run-smoke.mts`, `run.mts`) never passes `command`,
so the production daemon-spawn path is byte-identical to `main`. `pid: proc.pid` is a
purely additive field on `DaemonHandle` — not written or consumed anywhere in this
slice's diff (confirmed by grepping for `.pid` usage outside `spawn-daemon.ts`
itself and the test files) — genuinely inert groundwork for slice B, zero behavior
change.

## 7. Gates — re-run independently, matches builder's numbers

- `bunx tsc --noEmit`: clean, no output.
- `bun vitest run scripts/eval/shared/resume-ledger.test.ts scripts/eval/longmemeval/ingest.resume.test.ts scripts/eval/longmemeval/resume-integration.test.ts scripts/eval/locomo/ingest.resume.test.ts`:
  **4 files / 12 tests passed, 0 failed.**
- `bun run test` (full suite, in-worktree): **202 files / 2372 tests passed, 6
  skipped, 0 failed** — matches the builder's claimed numbers exactly.

## Recommendation

Fix Finding 5 (flag-mismatch silent scope-narrowing) before this harness is trusted
for an unattended overnight run whose result will be published — the mitigation
(persist + compare original sampling flags, warn/refuse on mismatch) is cheap
relative to the risk of quietly publishing a scope-reduced "honest" number. Finding 3
(AC-7's two out-of-scope side effects) is explicitly called out per the review's own
ask — my call is the new file is acceptable-additive and the new failure surface is
non-blocking (degrades into an existing, already-modeled failure path) but both
deserve the team's sign-off rather than my silent judgment alone, given AC-7's
literal text doesn't cover either. Everything else — the exactly-once accounting
(both by code structure and by the strongest available test, the daemon-side POST
counter), torn-tail tolerance under adversarial construction, kill-test determinism
under its actual (range-based, not exact) assertions, and the command/pid groundwork
— is genuinely solid, verified directly rather than trusted from the handoff.

---

## Re-review — fix commit `9cfd2f3`

### Fix shape, confirmed by diff

`git diff a20db54..9cfd2f3`: new shared module `scripts/eval/shared/run-params.ts`.
`writeRunParams` persists `{datasetPath, datasetHash (sha256 of file bytes), seed, n,
shards, (+qaPerSample for LoCoMo)}` to `run-params.json` on the first (non-resume)
invocation. `evaluateResumeGuard` is the single decision point both CLIs call:
non-resume always writes params and proceeds; resume with a missing file refuses
("predates resume support"); resume with any mismatch refuses, naming every
differing param as `key: original=X, current=Y`; resume with matching params
proceeds without rewriting the file. Finding 2 (ledger write failures) is fixed by
wrapping the `appendLedgerEntry` call itself in a `try/catch` that logs and
continues, in both harnesses' `ingest.mts`.

### 1. Wiring honesty — confirmed by reading both call sites, not just the unit tests

Read `run-smoke.mts`'s and `run.mts`'s diffs directly. Both place the guard
immediately after `mkdirSync(runDir)` (and, for LoCoMo, after
`ensureDatasetDownloaded` — a benign prerequisite needed only to make the dataset
file *exist* so it can be hashed, with no ingest/daemon-spawn side effects) and
**before** `loadDataset`, `sampleStratified`/`sampleLocomo`, and any shard/daemon
spawning in both files. On `refuse`, both print the message via `console.error` and
`return` after setting `process.exitCode = 1` — confirmed no code path between the
guard and the `return` that could start real work. `writeRunParams` for the
proceed-fresh case happens *inside* `evaluateResumeGuard` itself, so calling the
guard is sufficient — there's no separate call site that could be skipped.

### 2. Original repro re-run at the actual CLI subprocess level — confirmed live, not just via unit test

This is the one check worth doing as a real subprocess, so I ran it: created a
throwaway 1-byte dataset file (just needs to exist to be hashed; `loadDataset`
choking on it afterward doesn't matter since the guard runs first), then:

```
$ bun scripts/eval/longmemeval/run-smoke.mts --dataset ./fake.json --n 50 --seed 42 --run-dir <tmp>
Run dir: <tmp>
Loading dataset from ./fake.json...
error: dataset at ./fake.json did not parse to a non-empty array   <- expected, unrelated to the guard
$ cat <tmp>/run-params.json
{ "datasetHash": "...", "datasetPath": "./fake.json", "n": 50, "seed": 42, "shards": 1 }
  <- confirms run-params.json is written before the (unrelated, later) crash

$ bun scripts/eval/longmemeval/run-smoke.mts --dataset ./fake.json --n 30 --seed 42 --resume <tmp>
Resuming run dir: <tmp> (ledger-driven skip of already-ingested sessions)
--resume <tmp>: refusing to resume -- these params differ from the original invocation
(resuming anyway could silently narrow or change the run's scope):
  n: original=50, current=30
Start a fresh run dir if you intend different params.
$ echo $?
1
```

Exactly the fix's claimed shape: non-zero exit, the differing param named with both
values, and the failure happens before any dataset-content parsing, sampling, or
daemon spawn. Also confirmed the positive case: re-running with the *matching* `--n
50` on `--resume` correctly proceeds past the guard (and only then fails later on
the intentionally-empty fake dataset, proving the guard doesn't false-positive on a
real match).

### 3. `datasetHash` / path consistency — behavior matches what's tested and documented; one worth-noting (not blocking) strictness

Confirmed `currentParams` includes both the raw `--dataset` string as `datasetPath`
*and* `datasetHash` (sha256 of the file's actual bytes, read fresh each invocation) —
so the hash is always of the dataset file actually pointed at by *this* invocation's
`--dataset` flag, not a cached/stale value.

**Checked the specific edge case asked about**: a dataset file *moved* between
invocations (identical bytes, different path string). Since `checkRunParams` diffs
every key by strict equality, including `datasetPath` as a plain string, this
scenario would refuse on `datasetPath` mismatch even though `datasetHash` matches —
confirmed no test exercises this exact combination (moved-but-identical), but the
behavior is consistent with what's documented: both READMEs explicitly list
"`--dataset` path + a content hash" as compared fields, and describe the guard as
refusing on *any* mismatch with no override — so comparing the path string too,
not just the hash, is the stated design, not an accidental side effect. This is the
stricter of the two defensible choices the re-check flagged (hash-only would let a
moved file resume silently) — it fails toward "refuse a possibly-legitimate resume"
rather than "quietly accept a re-pointed file," which is the correct bias given this
guard's whole purpose is erring toward refusal over silent scope drift. Not a
blocker; worth a one-line README/test addition if the team wants that specific
combination pinned explicitly, but current behavior is intentional and documented,
not a gap.

### 4. Ledger try/catch scoping — confirmed correct, and confirmed with a real (not mocked) fs failure

Read both `ingest.mts` diffs directly: the new `try/catch` wraps **only** the
`appendLedgerEntry(...)` call, placed *after* the job's own try/catch (which
constructs `outcome` from the actual network request) has already fully resolved —
there is no way for the ledger-write catch to swallow or reinterpret the job's own
network/ingest result, since that's already a settled value by the time the ledger
`try` block begins. Confirmed the two new "review fix (finding 2)" tests inject a
**genuine filesystem failure**, not a mock: they write a plain file at a path
component where `appendLedgerEntry`'s internal `mkdirSync(dirname(...), {recursive:
true})` needs a directory, forcing a real `ENOTDIR` from the OS. Both tests assert
the job still reports `ok_count` matching every session actually POSTed (the ledger
failure is invisible to the outcome), with a `console.error` warning fired.

### 5. Gates, re-run independently

- `bunx tsc --noEmit`: clean, no output.
- `bunx vitest run scripts/eval/`: **13 files / 110 tests passed, 0 failed** —
  matches the builder's claimed `scripts/eval 110/110` exactly.
- `bun run test` (full suite, in-worktree): **203 files / 2390 tests passed, 6
  skipped, 0 failed** — matches the builder's claimed numbers exactly.

### Final status: PASS

Both findings from the original review are genuinely closed. Finding 1 (silent
scope-narrowing) is fixed with a hard, no-override refusal verified at the real CLI
subprocess level, not just unit tests — confirmed both the negative (refuses,
correct exit code, correct named param) and positive (matching params proceed) cases
live. Finding 2 (ledger-write failure surface) is fixed with correct try/catch
scoping, verified against a genuine filesystem failure rather than a mock. No new
issues found. **462a is ready for validation** (kill+resume live run via the fake
daemon) as the next step, per the stated plan.
