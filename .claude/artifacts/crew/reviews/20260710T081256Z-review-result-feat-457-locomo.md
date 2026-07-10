# Review Result — FEAT-457 LoCoMo eval harness

- Branch: `feat/feat-457-locomo` (head `c417bb6`, build commit `480d870` + merge of main)
- Worktree: `C:\work\mega\astramemory-local-worktrees\feat-457-locomo`
- Diff base: `origin/main...origin/feat/feat-457-locomo`
- Reviewer: independent review agent (read-only)
- **Verdict: PASS**

## Surface A — shared/ extraction refactor (highest risk)

Claim: the longmemeval plumbing (spawn-daemon, daemon-client, azure-client, config,
concurrency, shard, ollama-tuning) was moved from `scripts/eval/longmemeval/lib/` to
`scripts/eval/shared/` "verbatim, only path-depth fixes, zero logic changes."

Verified mechanically, file by file:

- `azure-client.ts`, `concurrency.ts`, `config.ts`, `daemon-client.ts`,
  `ollama-tuning.ts`, `shard.ts` — git reports these as **pure renames, 0 line diff**
  (`git diff --stat` shows `| 0` for each). Confirmed byte-identical.
- `spawn-daemon.ts` (the one file git could not auto-detect as a pure rename, 44 lines
  changed) — diffed old blob (`origin/main:scripts/eval/longmemeval/lib/spawn-daemon.ts`)
  against new blob directly. Every changed line is either a doc-comment update (old
  comment said "for the eval harness" / "discovered while building this harness";
  new comment says "shared by every eval harness ... extracted from
  scripts/eval/longmemeval/lib/spawn-daemon.ts to scripts/eval/shared/") or the
  import-path depth fix `../../../../src/config/datadir.js` → `../../../src/config/datadir.js`
  and matching `REPO_ROOT` join (one fewer `'..'`), which is mechanically correct — the
  file moved from a 4-deep path (`scripts/eval/longmemeval/lib/`) to a 3-deep path
  (`scripts/eval/shared/`). **Zero logic changes.**
- All five longmemeval consumer files that had to be repointed at the new import
  paths (`answer.mts`, `ingest.mts`, `judge.mts`, `lib/envelope.ts`, `run-smoke.mts`)
  — diffed each individually. Every hunk is an import-path or in-comment-path edit
  only (e.g. `'./lib/daemon-client.js'` → `'../shared/daemon-client.js'`). No
  logic, no reordering, no behavior change.

**Critical distill-wait sequential-poll fix (f8aa944, 2026-07-09) verified intact in
both harnesses:**
- `scripts/eval/longmemeval/distill-wait.mts` — diff vs main is a one-line import-path
  change only; the fix itself (sequential per-session polling with short-circuit, not
  `Promise.all`, 5s default interval, full incident comment) is untouched, still present
  verbatim.
- `scripts/eval/locomo/distill-wait.mts` (new file) — independently confirmed to carry
  the same fix: sequential `for` loop with short-circuit (`if (!(await isSessionReady(...)))
  { allReady = false; break; }`), 5s default `intervalMs`, and a comment that explicitly
  cross-references the LongMemEval incident and applies the same reasoning ("LoCoMo
  conversations can span dozens of sessions each"). This is not a copy that silently
  regressed — the port-exhaustion fix landed correctly in the new harness too.

Surface A is clean. No findings.

## Surface B — new locomo/ harness

1. **Category mapping** (`lib/types.ts` header, mirrored in `judge/metrics.mts`
   header) — 1=multi-hop, 2=temporal, 3=open-domain, 4=single-hop, 5=adversarial,
   with per-category scoring function cited against the actual upstream
   `evaluation.py` source (not just the paper prose), including the category-3
   `answer.split(';')[0]` truncation and category-5 `adversarial_answer`-only /
   abstention-substring handling. The derivation is well-cited and internally
   consistent between the two files that both need to agree on it.
2. **F1/token-overlap scoring** (`judge/metrics.mts`) — manually recomputed several
   cases by hand against the code: `f1Score('no', 'Likely no')` → precision 1/1,
   recall 1/2, F1 = 2·1·0.5/1.5 = 0.6667, matches the test's `toBeCloseTo(0.6667, 3)`.
   Category 3 truncation (`answerStr.split(';')[0]`), category 1 comma-split
   multi-answer max-per-part averaging, and category 5's binary
   `isAbstentionPhrase` check (`"no information available"` / `"not mentioned"`,
   case-insensitive) all match their respective test assertions and the documented
   upstream behavior.
3. **Porter stemmer** — hand-traced all four classic reference cases through the
   actual step functions rather than trusting the stated 99.93% corpus match:
   - `caresses` → step1a `sses→ss` → `caress` (no further steps fire) ✓
   - `ponies` → step1a `ies→i` → `poni` ✓
   - `relational` → step2 `ational→ate` (`rel`, m=1>0) → `relate` → step4 `ate` suffix
     matches but m(`rel`)=1 fails the `m>1` condition, no-op → step5a strips trailing
     `e` since m(`relat`)=2>1 → `relat` ✓
   - `conflated` → step1b `ed`-strip + `at`-ending re-adds `e` → `conflate` → step4 `ate`
     suffix matches but m(`confl`)=1 fails `m>1`, no-op → step5a strips `e` since
     m(`conflat`)=2>1 → `conflat` ✓
   All four match the classic expected outputs exactly.
4. **Date parsing** (`lib/dates.ts`) — noon (`12:00 pm`→hour 12), midnight
   (`12:09 am`→hour 0), and single-digit day (`8 May, 2023`→`08`) are all covered by
   `dates.test.ts` and match manual recomputation of `parseLocomoDateTime`'s hour
   arithmetic (`hour===12` special-cased before the `isPm` adjustment).
5. **Dataset license handling** — `.eval-data/` is gitignored at the repo root
   (pre-existing entry, shared with LongMemEval); no dataset file is present/tracked
   in the worktree. `scripts/eval/locomo/README.md` has an explicit
   "License — CC BY-NC 4.0, non-commercial, attribution required" section citing the
   upstream `LICENSE.txt` and stating the harness never commits the dataset.
6. **Determinism** — `sample.test.ts` asserts byte-identical file content across two
   separate `runSample` invocations with the same seed (`readFileSync(outA) ===
   readFileSync(outB)`), not merely "runs without crashing." The sampler's PRNG
   (mulberry32, seeded) and stratified-subset logic support this by construction.
7. **Tests are real assertions** — spot-checked `metrics.test.ts`,
   `porter-stemmer.test.ts`, `dates.test.ts`, `sample.test.ts`: all assert specific
   computed values/error messages (`toBeCloseTo`, exact string equality, `toThrow(/regex/)`),
   not snapshots. Edge cases are deliberately exercised (empty-normalization F1=0,
   distill-timeout skip exclusion from scoring, unknown qa_id warn-and-skip,
   category-averaged vs per-QA accuracy divergence).
8. **Full suite** — `npm run build` (tsc) clean. `npm run test` (vitest run):
   195 test files, 2262 tests, 1 failure on first pass
   (`tests/scripts/post-merge-rebuild.test.ts` — 5000ms timeout on a git-fixture
   operation under full-suite parallel load). That file is untouched by this branch
   (last touched by an unrelated FEAT-440/439 commit) and passes cleanly (8/8) when
   re-run in isolation — confirmed flaky-under-load, not a regression introduced by
   this diff. Effective result matches the expected 195/2262/0.

No findings in Surface B either.

## Other checks
- `package.json` diff is three new npm script entries only (`eval:locomo:sample/run/judge`),
  no dependency changes — consistent with the "no new deps, plain fetch" claims in
  `shared/azure-client.ts` and `lib/dataset.ts`.
- `judge.mts`'s `--llm-judge` secondary pass correctly skips category 5 (already
  deterministic) and skips distill-timeout-skipped hypotheses before spending an
  Azure call on them.

## Verdict: PASS

No changes requested.
