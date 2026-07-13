---
type: handoff
created: 2026-07-13T12:43:13Z
author: locomo-10pct (dispatched agent)
objective: LoCoMo 10% rerun is fully prepped and paste-ready — HELD by operator decision until SLICE-434 lands on main
status: held-ready-for-pickup
---

# Handoff — LoCoMo 10% rerun, prepped and held

Everything below is verified against real code/commits as of 2026-07-13, not
inferred. **Do not run the eval until the precondition in §1 is satisfied.**

## 0. Why this exists / why it's held

The only prior scored LoCoMo run (`.claude/artifacts/crew/runs/20260713T020500Z-locomo-first-scored-run.md`)
measured **overall F1 0.2362**, but 1,857/1,986 answers were the abstention
"no information available". The real number underneath it: only **136
memories extracted from 272 sessions (~0.5 atoms/session)**. That run
measured extraction collapse, not retrieval quality, and predates several
fixes (compaction-stage JSON forcing removed, query-embedding instruction
prefix fix, durability/contradiction gates, v3 extraction prompt). A 10%
rerun was prepped to get a fresh number — but **SLICE-434 (conversational
extraction profile + few-shots) is the actual fix for the 0.5 atoms/session
collapse and is still in flight on main as of this writing.** Running before
it lands would measure the wrong build and produce a second dead number.
Operator decision: hold.

## 1. PRECONDITION — do this before anything else in this doc

**Re-cut the worktree off main AFTER SLICE-434 lands.** The prepped worktree
below (`astramemory-local-wt-locomo2`) is at commit `c61bc79` on branch
`eval/locomo-20260713`, based on main `d751403` (chore: close SLICE-433).
SLICE-434's artifacts were still uncommitted/untracked on the live main
checkout at prep time — this worktree predates it and its extraction
profile fix is NOT in this worktree's build.

Once SLICE-434 merges to main:
```powershell
cd C:\work\mega\astramemory-local
git fetch origin main   # or just check local main is current
git worktree add ..\astramemory-local-wt-locomo3 main -b eval/locomo-20260713-v2
cd ..\astramemory-local-wt-locomo3
git cherry-pick c61bc79   # brings the model-pin fix (§3) forward — do NOT redo it from scratch
bun install
bun run build
```
If the cherry-pick conflicts (unlikely — it only touches `scripts/eval/`),
resolve and continue; the fix is additive and self-contained. Do not skip
the cherry-pick — without it you're back to the `qwen2.5:7b` drift bug this
whole prep exists to close.

## 2. Hard safety constraint — read before running anything

`docs/eval/locomo-methodology.md` in this repo states, verbatim:

> This doc is written to be executed by a human operator directly, not a
> coding agent... Verified live (2026-07-08): a coding-agent's sandboxed
> shell silently reaped a spawned eval daemon mid-run and destroyed a
> 40-minute run, with no trace anywhere in the daemon's own logs, no OS
> crash dump, no application-error event.

**Run the command in §5 from a plain PowerShell/cmd window you opened
yourself — never from inside a coding agent's shell tool.** `--detach`
means you can close that window afterward; the run survives.

## 3. What's already done (committed on `eval/locomo-20260713`, commit `c61bc79`)

The isolated eval sandbox (`makeIsolatedEvalEnv` in
`scripts/eval/shared/spawn-daemon.ts`) silently inherited `defaultConfig()`'s
hardcoded `qwen2.5:7b` — not the operator's real `qwen3:8b` config — because
the sandbox deliberately never reads the real `config.yaml` (sync.json
isolation fix, 2026-07-08). The prior run's wrong-model deviation was only
discoverable in postmortem because nothing recorded what model it ran with.
Fixed, additively:

- `makeIsolatedEvalEnv(prefix, opts?)` takes an optional
  `{ models?: { extraction?, compaction? } }`. Omitting it reproduces the
  old config.yaml byte-for-byte — verified, and LongMemEval (which shares
  this file) is unaffected: its 71 tests still pass.
- New `resolveEvalModels()` is the single source of truth for
  override-or-default resolution, used by both the sandbox writer and the
  manifest writer so they can't drift apart from each other.
- `run.mts` gets `--extraction-model` / `--compaction-model` flags,
  threaded through both the real-run and `--dry-run-throughput` paths.
- `run-manifest.json` and `throughput-dry-run.json` now always record
  `config.models` — pulled from an actually-booted shard's resolved
  values, falling back to the pure resolution only if every shard failed
  before boot. **A published number is now checkable against its own
  manifest, not against anyone's memory of what flags were passed.**

`defaultConfig()` in `src/config/config.ts` was deliberately left untouched
— that's a shipped product default and a separate operator decision, out of
scope for this eval-prep work.

Verification done: rebuilt clean; typechecked under the repo's real strict
`tsc` settings via a scratch config (neither `tsconfig.json` nor
`tsconfig.tests.json` actually cover `scripts/eval/**`, discovered during
this work — 0 errors on the changed files); LoCoMo shared/lib suite
(114/114) and LongMemEval suite (71/71) both green.

## 4. Sample already drawn and inspected

`--n 1 --seed 42` (deterministic, same dataset+seed+n always reproduces
this) selects **conversation `conv-26`: 19 sessions (7.0% of the 272-session
baseline), 199 QA pairs**. Conversation-level is the sampler's only
granularity — there's no sub-conversation unit, so an exact 10%/27-session
cut isn't achievable; 19 sessions was chosen as closer to 10% than the
next-smallest option (`--n 2` → 49 sessions, 18.0%).

Dataset re-verified at prep time: sha256
`79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`,
2,805,274 bytes — matches the pinned hash in the methodology doc, no
upstream drift.

**Before trusting the eventual result**, read the run dir's own emitted
`sample.json` (written early, before distill finishes) and confirm it
actually shows `sample_id: conv-26` with 19 sessions — don't just trust
that `--n 1 --seed 42` determinism held. This file's own re-derivation
logic was already found to differ from a naive assumption once during prep
(a draft `--sample-file` flag turned out not to exist), which is exactly
the class of assumption worth re-checking rather than trusting blind.

## 5. Paste-ready command (plain terminal only — see §2)

```powershell
cd C:\work\mega\astramemory-local-wt-locomo3   REM or wherever you re-cut per §1
bun scripts/eval/locomo/run.mts --n 1 --seed 42 --extraction-model qwen3:8b --compaction-model qwen3:8b --distill-timeout-ms 3600000 --detach
```

Poll:
```powershell
bun scripts/eval/locomo/run.mts --status .eval-data/locomo/runs/<timestamp>
```

Score (once status shows `phase: completed`):
```powershell
bun scripts/eval/locomo/judge.mts --hyp .eval-data/locomo/runs/<timestamp>/hypotheses.jsonl --ref .eval-data/locomo/runs/<timestamp>/sample.json
```

Output lands in `.eval-data/locomo/runs/<ISO-timestamp>/`:
- `sample.json` — verify per §4 before trusting anything downstream
- `run-manifest.json` — **check `config.models.extraction` and
  `config.models.compaction` both read `qwen3:8b` before citing any number
  from this run**
- `hypotheses.jsonl`, then `hypotheses.jsonl.metrics.json` after judging

**Expected wall-clock**: ~14-19 min distill (19 sessions × 45-60s/session,
this repo's own measured local-Ollama rate) + answer/judge overhead, call
it 20-30 min total. This box runs 3 sibling agents sharing the same Ollama
instance — expect the slow end of that range; that's expected contention,
not a fault, don't "fix" it.

**Cost**: not inventing a number here. 199 QA calls against Azure
`gpt-5-mini` (`reasoning_effort: minimal`, ~300-completion-token cap) is a
small token volume — check the Azure cost dashboard after the run rather
than trusting any pre-run estimate.

## 6. Headline instruction for whoever reads the result

**Report atoms/session first. F1 second, and only with the caveat above
attached.** Baseline was ~0.5 atoms/session (136 memories / 272 sessions).
If SLICE-434 landed and this number hasn't moved meaningfully, **say so
plainly**: the F1 score is still measuring extraction collapse dressed up
as a retrieval result, not a retrieval-quality result, and must not be
reported as one. Only treat F1 as informative about retrieval once
atoms/session shows the extraction fix actually took.

## Changed files / evidence
- `scripts/eval/shared/spawn-daemon.ts`, `scripts/eval/locomo/run.mts` —
  committed on `eval/locomo-20260713`, commit `c61bc79`, in worktree
  `C:\work\mega\astramemory-local-wt-locomo2` (superseded per §1 once
  SLICE-434 lands — cherry-pick `c61bc79` forward, don't redo).
- Sample preview files (not committed, gitignored `.eval-data/`):
  `.eval-data/locomo/sample-10pct.json` (recommended, n=1) and
  `.eval-data/locomo/sample-10pct-n2.json` (alternative, n=2) in the same
  worktree — regenerate after re-cutting per §1, these don't survive a
  fresh worktree.

## Confidence
High on the code fix (tested, typechecked, both eval suites green). Medium
on timing — SLICE-434's landing date is outside this handoff's knowledge;
whoever picks this up should check current main state before assuming §1
is satisfied.

## Risks or open questions
- If SLICE-434 lands with a different extraction-profile flag surface than
  expected, double-check `run.mts` still has no conflicting flag names
  before pasting §5's command.
- `sample-10pct.json`/`sample-10pct-n2.json` previews were generated in the
  now-stale worktree and won't exist in a freshly re-cut one — regenerate
  with `bun scripts/eval/locomo/sample.mts --n 1 --seed 42 --out
  .eval-data/locomo/sample-10pct.json` if you want to preview before
  running `run.mts` itself (which re-derives its own sample internally
  regardless).

## Suggested next handoff
Once SLICE-434 lands and this run executes: a scored-run handoff following
this repo's existing pattern (see
`.claude/artifacts/crew/runs/20260713T020500Z-locomo-first-scored-run.md`
for the prior one's shape), containing the atoms/session figure, F1 table,
and the `config.models` confirmation from `run-manifest.json`.
