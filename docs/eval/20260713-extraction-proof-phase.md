# FEAT-479 SLICE-436 — hardened proof phase (2026-07-13)

**Status: LIVE RUN COMPLETE.** This report presents a bounded, blinded,
multi-run comparison of 4 extraction configurations plus a recall-quality
(MRR) regression guard, per architect-review item 6 (design doc
`docs/superpowers/specs/2026-07-13-memory-quality-design.md` §3.4/§7).

## TL;DR

- 4 configs compared over 5 fixtures, 2 runs each, judged BLIND (labels
  A-D revealed only below). All 40 fixture-runs completed, zero retries
  needed.
- Quality is reported as a **range across runs**, not a point estimate — see
  "Known limitations" for why even that range should be read cautiously.
- Clearest finding: **codex-subscription produces relation triples more
  frequently and consistently than qwen2.5-coder:7b** (14.5-17 vs 0-2.5 per
  run) — a frequency/well-formedness count, NOT a correctness measurement
  (no fixture has relation ground truth; see "Reading these numbers
  honestly"). Atom-level F1 did not show a clean v1-vs-v3 win on this small
  sample.
- **THE MOST IMPORTANT RESULT: on `fx43`, the flagship rich-lesson fixture
  this entire FEAT exists to serve, NONE of the 4 configs reliably captured
  the `lesson` gold atom** — every config that extracted anything (qwen+v1,
  codex-mini, qwen+v3) matched ONLY the shallow `decision` atom and missed
  the `lesson` atom outright in every run; gpt-5.5 extracted 0/2 gold atoms
  in both runs. This is not buried in a table — see its own section below,
  "Flagship fixture result: fx43 (rich lesson)."
- **AC-14 recall MRR guard measured FAIL (0.483 vs 0.637 baseline), but with
  confounds large enough that this should be read as "not measured cleanly,"
  not "confirmed regression"** — see that section for the full honest
  breakdown and the follow-up needed to get a clean answer.
- AC-15 (budget-cap doctor WARN) and AC-16 (CLAUDE.md wording proposal) are
  covered at the end; AC-15 shipped as code+tests, AC-16 is a proposal only.

## Methodology

### Configs

| Label (revealed below) | Model | Prompt | Provider path |
|---|---|---|---|
| ? | qwen2.5-coder:7b | OLD (v1 rollback, `ASTRA_EXTRACT_PROMPT=v1`) | local Ollama |
| ? | qwen2.5-coder:7b | NEW (v3, current default, no override) | local Ollama |
| ? | gpt-5.4-mini | v3 (default) | codex-subscription (ChatGPT quota) |
| ? | gpt-5.5 | v3 (default) | codex-subscription (ChatGPT quota) |

Compaction is held constant at `ollama/qwen2.5-coder:7b` for every config —
this bench's own established methodology (`scripts/eval/extraction-bench/README.md`)
isolates "which extraction model/prompt" as the one variable under test.
All 4 configs run through the identical in-process direct pipeline
(`lib/pipeline-direct.ts`'s `runDirectPipeline` — stages 1-7, the real
production code path minus the HTTP/job-queue/storage layer), not a mix of
the daemon-HTTP path and the direct path, so atom/relation counts and
wall-clock are directly comparable across all 4 configs.

### Fixtures (bounded subset, not the full 44)

A full sweep (44 fixtures x 2 runs x 4 configs = 352 extraction calls, 176 of
them against the operator's metered ChatGPT quota) was explicitly out of
budget per the dispatch's "keep total codex calls bounded" instruction. This
run used 5 fixtures chosen to span the dimensions the proof phase actually
needs to see, not a random sample:

- `fx43-rich-lesson-embed-cache-stampede` — the SLICE-433 richness
  regression guard (rich lesson+decision, the exact 300-800-char
  claim+rationale+tradeoff+provenance shape this FEAT exists to produce).
- `fx44-conversational-marcus-priya-life-updates` (new fixture, this slice —
  lives in `scripts/eval/extraction-bench/fixtures-conversational/`,
  deliberately NOT the default `fixtures/` directory; see that file's own
  header comment) — personal/conversational content evaluated under the
  ENGINEERING profile (all 4 configs here run the engineering profile) —
  an over-extraction-restraint check, `gold_atoms: []`.
- `fx13-entity-rich` — many named products/orgs/people in one session
  (relation-bearing).
- `fx01-clean-decision` — a clean baseline decision, the simplest control.
- `fx09-nothing-worth-remembering` — zero gold atoms, precision/restraint
  check (technical-noise analogue of fx44's personal-chatter restraint
  check).

Judging: `lib/judge.ts`'s existing Azure gpt-5-mini semantic judge
(`reasoning_effort: low`), unmodified. It receives only `{type, text}` atom
pairs and the fixture's gold atoms — it never receives a config/model
identifier, so it is structurally blind by construction, independent of this
harness's own blinding.

### Blinding implementation

`scripts/eval/extraction-bench/run-proof-phase.mts` assigns each of the 4
configs a random letter (A-D) at process start. Every console line and the
raw per-run results object (`raw-blinded-results.json`) during the run use
only that letter — the real config identity is held in a `Map` that is never
printed until the reveal step, which runs after every run for every config
has already been scored. This is a structural property of the code (the
mapping variable is genuinely out of scope for every function that runs
during scoring), not a discipline promise.

### Ranges, not points

Each config's `F1`/`recall`/`precision` is reported as
`min–max across the N runs` (N=2 here), reusing
`lib/report.ts`'s existing `combineRuns`/`aggregateFixtureScores`
aggregation (already used by `run-bench.mts`) rather than reinventing the
math — the `runs[]` field it retains is exactly the per-run raw values a
range needs.

## Results (blind reveal)

Live run, 2026-07-13, `bun scripts/eval/extraction-bench/run-proof-phase.mts --runs 2`
(no `--fixtures`/`--configs` override — the full intended 4-config x 5-fixture
x 2-run matrix). Raw evidence:
`scripts/eval/extraction-bench/results/proof-phase-2026-07-13/{raw-blinded-results.json,reveal-mapping.json,final-table.md,run.log}`.

| Config | F1 range | Recall range | Precision range | Atoms (avg) | Relations (avg) | Cost (total) | Latency (avg/session) |
|---|---|---|---|---|---|---|---|
| **qwen2.5-coder:7b + OLD prompt (v1 rollback)** | 66%–66% | 58%–58% | 75%–75% | 11.0 | 0.0 | $0.0000 | 28.3s |
| **codex-subscription gpt-5.4-mini + v3** | 78%–80% | 67%–67% | 94%–100% | 9.0 | 17.0 | $0.0000 | 18.3s |
| **codex-subscription gpt-5.5 + v3** | 59%–67% | 42%–50% | 100%–100% | 9.5 | 14.5 | $0.0000 | 19.3s |
| **qwen2.5-coder:7b + NEW prompt (v3, current default)** | 64%–71% | 58%–67% | 70%–75% | 10.0 | 2.5 | $0.0000 | 28.5s |

(Blind letters A/B/C/D were assigned randomly at run start and revealed only
after every config finished scoring; the mapping printed by the harness at
reveal time was: A=qwen+v1, B=codex-mini+v3, C=codex-5.5+v3, D=qwen+v3 — shown
here already resolved to real names for readability.)

### Flagship fixture result: fx43 (rich lesson) — the single most important result in this run

`fx43-rich-lesson-embed-cache-stampede` has 2 gold atoms: gold[0] is the
**lesson** (the durable "why" — the cache-warm-check root cause and its
consequence, authored in the 300-800-char rich shape this whole FEAT exists
to produce), gold[1] is the **decision** (the fix). Per-config judge
verdicts, taken directly from `raw-blinded-results.json`:

| Config | Atoms extracted | Gold matched | Gold missed |
|---|---|---|---|
| qwen2.5-coder:7b + OLD (v1) | 1 (`decision`: "Add a 10-second timeout on the lock wait.") | gold[1] (decision) | **gold[0] (lesson)** |
| codex-subscription gpt-5.4-mini + v3 | 1 (`todo`, same text, wrong type) | gold[1] (decision) | **gold[0] (lesson)** |
| codex-subscription gpt-5.5 + v3 | 0 (both runs) | none | **gold[0] AND gold[1]** |
| qwen2.5-coder:7b + NEW (v3) | 1 (`command`, same text, wrong type) | gold[1] (decision) | **gold[0] (lesson)** |

**Every config that extracted anything captured only a narrow sub-detail of
the decision ("add a 10-second timeout") — none captured the actual
`lesson` atom** (the cache-warm-check root-cause narrative), in EITHER run,
for ANY config, including the new v3 prompt this FEAT built specifically to
produce that shape. gpt-5.5 captured nothing at all, in both of its runs.
This is confirmed from the persisted last-run JSON for every config; `run.log`
confirms identical atom counts (1 for A/B/D, 0 for C) in the OTHER run too
for this fixture, so the finding held across both runs, not just the
persisted one.

**Say what this means honestly — two competing hypotheses, not one flattering
one:**

1. **The prompt still doesn't reliably elicit the rich `lesson` shape.**
   v3 was built to produce claim+rationale+consequence+provenance lessons,
   and on the ONE fixture purpose-built to test exactly that, it didn't —
   not even once, across 2 runs, on the model it was tuned against
   (qwen2.5-coder:7b) or either codex tier.
2. **The judge/matcher can't recognize a rich lesson when one IS
   produced.** `lib/judge.ts` does semantic matching per atom against gold,
   but if a model instead folds the lesson's content INTO a richer decision
   atom (rather than emitting it as a separate `lesson`-typed atom), the
   judge's one-atom-to-one-gold-atom matching could plausibly under-credit
   it as "gold[0] unmatched" even though the durable content partially
   survived elsewhere. This bench's methodology was not designed to detect
   that failure mode, so it cannot be ruled out from this data alone.

This proof phase does not have enough information to pick between these two
— and picking one without evidence would be exactly the "flattering
interpretation" this section exists to avoid. Both should be treated as live
until a follow-up (e.g. manually inspecting each config's compacted-chunk
input to fx43, and each raw extraction response before parsing — see Known
limitations) narrows it down.

### Reading these numbers honestly

- **F1 did not clearly improve from v1 -> v3 on this 5-fixture sample**
  (qwen+v1: 66% flat vs qwen+v3: 64-71%, ranges overlap) — atom-level
  recall/precision on this bench's judge is noisy at n=2 runs / 5 fixtures
  (see "Known limitations"), so this proof phase does NOT show a clean
  atom-quality win for v3 over v1. What v3 unambiguously adds is **relation
  extraction**: v1 (which predates the relations[] schema addition) produced
  **zero** relations across both runs and all 5 fixtures; v3 produced 2.5 on
  average, on the SAME model. This is the one place the two qwen configs
  differ sharply and consistently, not the atom F1.
- **codex-subscription produces relation triples more frequently and
  consistently than qwen2.5-coder:7b** — 14.5-17 relations/run vs 0-2.5 for
  qwen, both under the identical v3 prompt. This is the clearest, most
  consistent count-level signal in the whole run (held across both codex
  tiers and both qwen runs). **Relation CORRECTNESS was not measured** — no
  fixture in this run carries relation ground truth (`gold_atoms` only
  specifies `type`/`text`; `lib/judge.ts` never scores `relations[]`), so
  this is a raw frequency/well-formedness count (did the model emit
  well-formed subject/predicate/object triples at all), not evidence that
  codex's relations are more ACCURATE than qwen's. A model that emits many
  fabricated relations would score identically to one emitting many correct
  ones under this measurement.
- **gpt-5.4-mini (cheap tier) scored equal-or-better than gpt-5.5 on this
  sample** (F1 78-80% vs 59-67%, recall 67% flat vs 42-50%) — surprising
  given `gpt-5.5` is the more capable/expensive model in the Codex catalog.
  Precision was 100% for gpt-5.5 in both runs (no junk), vs 94-100% for
  gpt-5.4-mini — so gpt-5.5 is more conservative (fewer, more confident
  atoms) while gpt-5.4-mini extracts more of the gold content. Sample size
  (5 fixtures, 2 runs) is too small to trust this ranking as a general
  claim; it is reported as observed, not as a recommendation to prefer the
  cheaper tier.
- **Cost: $0.0000 for every config.** qwen is genuinely free (local
  inference). codex-subscription reporting $0 is NOT free — see AC-15 below;
  it means the ChatGPT subscription quota was spent (16 extraction calls per
  codex config in this run) with no dollar figure this tool can see.
- **Latency: codex configs were ~35% faster wall-clock per session** (18-19s
  vs 28s for qwen) despite codex's own extraction call latency varying
  widely per call (1.3s-17.5s observed in raw logs) — qwen's compaction call
  (held constant across all 4 configs) dominates qwen configs' wall-clock,
  while codex configs still pay that same local compaction cost plus a
  (usually faster) remote extraction call.
- **No VRAM-eviction retries observed.** All 40 extraction-pipeline
  fixture-runs (4 configs x 2 runs x 5 fixtures) completed on the first
  attempt — `retriedFixtures` was empty for every config in
  `raw-blinded-results.json`. Ollama calls ranged ~2.6s-36s per call with no
  ECONNRESET observed this run (unlike SLICE-433's prior VRAM contention).

## AC-14 — recall MRR guard

**Measured MRR: 0.483. Baseline: 0.637. Verdict as literally computed: FAIL
(below baseline).** Full command output:
`bun scripts/eval/recall-quality/run-mrr-guard.mts`.

```
plain-English   found in top-5: 6/10   MRR 0.483
literal-keyword found in top-5: 7/10   MRR 0.700
junk rate in plain-English results: 0/50 (0%)
```

**This FAIL should NOT be read as "the v3 prompt regresses recall."** Two
confounds specific to this guard's proxy-store methodology are large enough
to plausibly explain the whole gap on their own:

1. **This measurement round-trips through the REAL extraction pipeline; the
   0.637 baseline did not.** The master-plan's 0.637 number was measured
   against memories already resident in the real 13,350-memory store — their
   exact wording is whatever the historical extraction/authoring produced.
   This guard instead builds 10 brand-new 2-turn synthetic sessions from
   `ground-truth.json`'s own `known_memory` strings and runs them through the
   REAL v3 extraction pipeline live. Two things can go wrong that have
   nothing to do with retrieval: (a) a short synthetic 2-turn exchange may
   extract a **paraphrase** that doesn't literally contain the tuned marker
   substrings (e.g. the extracted text read "capture.enabled defaults **to**
   false", but the case's markers are "default false" / "defaults false" —
   an exact-substring miss on a semantically correct hit), and (b) a short
   synthetic session may not trigger extraction at all, or may extract
   something else, if the real extractor judges the content differently
   than the original (unknown, real) conversation that produced the
   baseline's memories.
2. **2 of 10 sessions (`spool-drain-poison`, `latency-budget`) never reached
   `ready`/`partial` within this script's 3-minute poll window** (see the
   WARNING line in the captured output above) — `latency-budget`'s own
   memory was very likely never stored in time, guaranteeing a MISS for
   that case regardless of prompt quality; `spool-drain-poison` DID show a
   correct top-1 hit in the results table despite the warning, suggesting
   its digest became ready in the few seconds between the warning firing and
   `run.mjs` actually querying — a benign timing race in this guard script,
   not a distillation failure.

**Net: this specific measurement cannot cleanly separate "prompt regression"
from "synthetic-proxy extraction/marker-matching noise."** The honest
conclusion is **not measured cleanly, not a confirmed regression** — a
follow-up that either (a) re-runs this exact guard against a snapshot/copy
of the real store (never touching the live one), or (b) writes the 10
synthetic memories directly via MCP `remember` instead of through the
extraction pipeline (matching the ORIGINAL 0.637 measurement's own
methodology, which also bypassed extraction), is needed before this AC can
be called PASS or FAIL with confidence. Filed as a caveat, not silently
rounded to a pass.

## AC-15 — budget-cap doctor WARN

Shipped as code, not just measured: `src/doctor/checks.ts`'s new
`checkBudgetCapCodexBlind` (registered adjacent to the existing `checkBudget`
check, away from the entity-relations canary region another builder is
adding this slice) fires a WARN whenever `codexSubscriptionInUse` is true
(either `llm.compaction.provider` or `llm.extraction.provider` is
`'codex-subscription'`) and a daily budget cap is configured
(`dailyBudgetUsd > 0`). `src/cli/doctor.ts` now wires both
`dailyBudgetUsd: cfg.budget.daily_usd` and `codexSubscriptionInUse` from the
real resolved config into `getChecks()` — previously `doctorCommand` never
passed `dailyBudgetUsd` at all (silently defaulting `checkBudget` itself to
a hardcoded 10 regardless of the operator's real `config.yaml` value), so
this also closes a real (if narrow) pre-existing gap in the existing budget
check, not just adds the new one. Tests:
`tests/doctor/budget-cap-codex-blind-check.test.ts` (4 cases: default
ok:true, explicitly off ok:true, genuine WARN with both message+fix
populated, and a `dailyBudgetUsd <= 0` no-false-alarm case).

This slice's own live run above is direct evidence for *why* the check
matters: every codex-subscription call logged `usd: 0` (see raw logs), so a
budget cap watching `budget_spend.usd_total` would show "$0.00 / $10.00,
0%" — all-green — for the entire live proof-phase run's codex spend, which
is exactly the blind spot this WARN surfaces.

## AC-16 — CLAUDE.md "write memories SHORT" correction (PROPOSAL ONLY)

**Not applied.** `CLAUDE.md` in this repo (`astramemory-local`'s own root
`CLAUDE.md`) does not contain this rule verbatim — the "write memories
SHORT... ~2,000 characters is diluted" wording is quoted inside
`.claude/artifacts/crew/handoffs/20260713T090000Z-memory-quality-master-plan.md`
§2 as an existing operator-facing memory-authoring convention; a brief
search of this repo and its immediate sibling repos under `C:\work\mega`
did not turn up the literal live source file within this slice's time
budget. **The operator should locate the actual file this convention lives
in (most likely a sibling repo's CLAUDE.md, an MCP `remember`-tool usage
doc, or global `~/.claude/CLAUDE.md`) before applying the wording below** —
this section is the proposed TEXT, not a verified diff.

### Evidence this proposal is based on (AC-0, already measured, not re-run
by this slice)

Per the master-plan handoff §2 (measured 2026-07-13, before this slice):
after RECALL-S1 (query-side embedding prefix), two long, real, prose
memories written via MCP `remember` retrieved at **rank #1** for the plain
English question they answered:

```
zod strip-mode lesson  (684 chars):  bare #2  ->  prefixed #1
cherry-pick lesson     (536 chars):  bare #2  ->  prefixed #1
```

The prior "diluted past ~2,000 chars" diagnosis was a misattribution: the
actual defect was a missing query-side embedding instruction prefix (fixed
by RECALL-S1), not vector dilution — a long memory that failed retrieval
pre-fix was retrievable **only** by literal-keyword FTS, which is the
signature of a broken query-side embedding call, not an overlong vector.
**Tested up to ~700 chars. The ~1,500-2,000-char range is untested, not
disproven** — no memory of that length has been measured in the real store.

### Proposed corrected wording

> **Memory shape: write a complete, self-contained claim — not padded, but
> not artificially truncated either.**
>
> Target for `lesson`/`decision` memories: 300-800 characters, carrying
> claim + rationale + tradeoff/consequence + provenance. This range is
> **tested**: real memories at 536 and 684 characters both retrieved at rank
> #1 for the plain-English question they answered (2026-07-13, post
> query-side-embedding-prefix fix).
>
> The earlier rule ("write memories SHORT — one fact per memory, ~2,000
> characters dilutes the embedding") was based on a misdiagnosis: the
> observed symptom (a long memory findable only by literal keywords, not by
> a plain-English question) was a missing query-side embedding instruction
> prefix, not vector dilution. That bug is fixed; the rule it justified no
> longer applies.
>
> **Caution, explicitly labeled**: memories in the ~1,500-2,000-character
> range are **UNTESTED** — not disproven, just never measured. Do not assume
> they behave the same as the tested 300-800-char range. If you need a
> memory that long, measure it with `scripts/eval/recall-quality/run.mjs`
> (or an equivalent plain-English-question probe) before relying on it.

## Known limitations / honest caveats

- **The temperature-clobber bug invalidates every pre-SLICE-433 quality
  number as a baseline for THIS report.** `05-extract.ts`'s
  `EXTRACT_TEMPERATURE` handling and the SLICE-433 num_ctx fix both post-date
  the original 15-fixture `~7.1 F1 stdev` noise measurement
  (FEAT-450/README "Statistical reliability"); none of that prior noise
  characterization is carried forward as a floor for the ranges reported
  here — the ranges above are this run's own measured min-max, nothing is
  compared against an old noise floor.
- **5 fixtures, 2 runs is a SMOKE-SCALE proof, not a publishable benchmark.**
  It answers "does the new prompt + codex tier obviously regress or obviously
  win," not "what is the true population F1." A wider `--runs` and the full
  44-fixture set (run through `run-bench.mts`, not this script) is the right
  instrument for a publishable number — see extraction-bench's own
  "Statistical reliability" section for why single-digit fixture counts and
  N=2 runs still carry real noise.
- **codex-subscription cost is genuinely unmeasurable via this tool.**
  `usage.usd: 0` on every call is not a rounding artifact — the provider has
  no per-token price to report (AC-15 exists because of exactly this). Any
  apples-to-apples $ comparison against qwen (also $0, but for the opposite
  reason — free local inference) is not meaningful; latency and quality are
  the only comparable axes for codex configs here.
- **fx44 was authored for this slice, not the original SLICE-434 smoke.**
  It reproduces the SCENARIO described in SLICE-434's validation artifact
  (`.claude/artifacts/crew/validations/20260713T125800Z-validation-result-slice-434-conversational.md`)
  but that validation ran ad hoc content that was never committed as a
  fixture file; this file is a faithful reconstruction, not the byte-for-byte
  original transcript.
- **AC-14's MRR guard runs against an isolated, reconstructed proxy store,
  not the real 13,350-memory production store** — the real post-RECALL-S1
  baseline (0.637) was measured against that real store, which this harness
  must never touch (prod datadir/port 7777 off-limits per hard rules). See
  the MRR section above for the full methodology note and its own caveats.
- **Relation-extraction FREQUENCY differed sharply and consistently between
  qwen2.5-coder:7b and codex-subscription across every run in this proof
  phase** (see the reveal table) — but relation CORRECTNESS was never
  measured (no fixture has relation ground truth), so this is not evidence
  either provider's relations are more accurate, only that codex emits more
  of them. Worth a dedicated correctness measurement once FEAT-481's own
  eval surface exists (gold relation triples per fixture), rather than
  over-indexing on this bench's frequency-only, 5-fixture sample.
- **The harness persists NO raw pre-parse LLM text** — not in
  `raw-blinded-results.json`, not in `run.log` (which logs token counts and
  latency, but never the response body). `05-extract.ts`'s `tryParseAtoms`
  either returns a fully-parsed atom list or `null` (triggering a retry at a
  layer this direct-pipeline harness doesn't go through the same way), and
  individual atoms that fail strict `AtomSchema` validation are silently
  dropped with no logged reason (`filterAtomRelations`/`coerceEntityKinds`
  and the per-atom `.filter()` in `05-extract.ts`) — so **silent
  schema-rejection cannot be ruled out** as an explanation for any
  zero-atom result in this report. This matters most for gpt-5.5 on fx43:
  it returned `status: 'ready'` with 0 atoms in BOTH runs, while spending
  MORE output tokens (163, 150) than gpt-5.4-mini's SUCCESSFUL 1-atom
  extraction on the identical fixture (80, 81 — see `run.log`). More output
  tokens for zero surviving atoms is at least as consistent with "produced
  content that got silently filtered/failed to parse" as with "the model
  judged nothing worth extracting" — this report cannot distinguish those
  two cases with the data it captured, and does not claim to. **Recommended
  follow-up**: extend the harness to dump raw pre-parse LLM text (and the
  parse/filter outcome for each candidate atom) so a zero-atom result can be
  attributed to model judgment vs. schema/parse failure instead of guessed
  at after the fact.

## Raw data

All under `scripts/eval/extraction-bench/results/proof-phase-2026-07-13/`:

- `raw-blinded-results.json` — full per-run, per-fixture atom/relation/judge
  detail, letter-keyed (written progressively, after each config, per the
  harness's own crash-safety convention).
- `reveal-mapping.json` — letter -> config key mapping.
- `final-table.md` — the same table as "Results" above, as its own file.
- `run.log` — full captured stdout of the live 4-config run (every
  extraction call's latency/tokens, every fixture's atom+relation count).
- `mrr-guard.log` — full captured stdout of the AC-14 MRR guard run.
