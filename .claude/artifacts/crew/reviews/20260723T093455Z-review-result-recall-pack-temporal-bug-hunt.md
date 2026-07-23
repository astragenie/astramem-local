# Adversarial QA — recall-pack assembly + temporal/date-surfacing

**Scope:** `src/recall/pack.ts`, `src/recall/policy.ts`, `src/server/routes/recall.ts`,
`src/distill/ground-dates.ts` (the file named `src/distill/temporal-grounding.ts` in the
dispatch brief / CLAUDE.md does not exist in this worktree — see finding 0).
**Mode:** read-only inspection + targeted vitest repro (temp test files written, run, then
deleted — `git status` on `tests/` shows no trace). No source edited. Baseline suite
(`tests/recall/pack.test.ts`, `tests/recall/policy.test.ts`, `tests/distill/ground-dates.test.ts`)
run first: **92/92 green**, so everything below is an *additional* gap the existing suite
doesn't cover, not a regression of what's already tested.

Most severe first.

---

## 🟡 pack.ts::selectPack | `branch` filter is a complete no-op → silent cross-branch bleed
**Break case:** `PackOptions.branch` (and `PackRequestSchema.branch` on the wire) is accepted
and even persisted at write time (`memories.branch` column, `src/storage/memories.ts:12,266,274`),
but `selectPack`'s SQL (`pack.ts:76-82`) only filters on `project` and `valid_to IS NULL` —
`opts.branch` is never read anywhere in the function body.
**Observed vs expected:** requesting `branch: 'main'` returns memories from every branch of the
project, including a branch that doesn't even exist in the DB. Expected: branch-scoped results
(or the parameter removed from the public surface if it's aspirational).
**Repro (reproduced, not static):** seeded one `main`-branch and one `feature/xyz`-branch
memory in the same project; `selectPack(db, { repo:'r1', branch:'main' })` returned **both**
(length 2), and `selectPack(db, { repo:'r1', branch:'does-not-exist' })` also returned both.
Test passed confirming the bug (i.e. the "buggy" expectation held).

## 🟡 recall.ts::recallRoute + policy.ts::decideInjection | explicit `project` is silently dropped whenever `prompt` is present (worktree scope leak)
**Break case:** the legacy (no-`prompt`) branch of `POST /recall/pack` forwards `project` and
`branch` into `selectPack` (`recall.ts:63`). The Wave-4d branch (`prompt` present) instead calls
`decideInjection(db, config, { repo, prompt, budgetTokens })` (`recall.ts:42-46`) — `PolicyInput`
(`policy.ts:41-47`) has **no `project` or `branch` field at all**, and every `selectPack` call
inside `decideInjection` (`policy.ts:75, 103`) passes only `repo`. Per `pack.ts`'s own
`projectFilter = opts.project ?? opts.repo` precedence comment (worktree-scoped memories are
supposed to group with their worktree, not bleed across every worktree of the same repo), this
means: the moment a caller also supplies `prompt`, worktree-scoping silently reverts to
repo-wide — the opposite of pack.ts's documented intent, and inconsistent with its own sibling
code path 20 lines away in the same file.
**Observed vs expected:** a request with `{repo:'memory', project:'memory-worktree-A', prompt:'...'}`
should find the worktree-scoped memory (the no-`prompt` request with identical repo/project
does find it). Instead it returns `decision.reason: 'no-eligible-memories'` — the memory is
invisible.
**Repro (reproduced):** seeded a memory with `repo:'memory'`, `project:'memory-worktree-A'`.
`POST /recall/pack {repo, project}` (no prompt) → pack contains the memory. Same body **plus**
`prompt: 'refactor the storage layer...'` → `decision.reason === 'no-eligible-memories'`,
pack empty. Confirmed via failing assertion output (actual reason was exactly
`'no-eligible-memories'`).
**Practical blast radius:** the only shipped caller today (`src/cli/hook-install.ts`'s
SessionStart hook) sends `{repo}` only — never `project`, never `prompt` — so this exact
combination isn't hit by the one caller wired into `init`/`reinstall` today. It's a live code
defect on the public route/API surface, not (yet) a field incident; it will start being an
incident the moment any caller (a smarter UserPromptSubmit hook, or a future direct API
integration) combines worktree-aware `project` with the `prompt`-driven policy gate.

## 🟡 pack.ts::renderPack | type-grouping can bury a higher-scored memory below a lower-scored one
**Break case:** `renderPack` groups memories into a `Map<type, PackMemory[]>` keyed by
**first-seen type in score-descending order** (`pack.ts:121-126`), then emits sections in
Map-insertion order. If the 1st-best and 3rd-best share a type, and the 2nd-best is a
*different* type, the whole first-seen type's section (1st AND 3rd) renders before the
2nd-best's section — the 2nd-highest-scored memory ends up displayed **after** a memory that
objectively scored lower than it.
**Observed vs expected:** `selectPack`'s own returned array order is correctly score-sorted
(`['FACT-HIGH'(0.70), 'DECISION-MID'(0.50), 'FACT-LOW'(0.42)]`), but `renderPack`'s rendered
Markdown order is `FACT-HIGH, FACT-LOW, DECISION-MID` — the objectively 2nd-best item (score
0.50) prints last, after an item that scored lower (0.42). For an answerer/reader that
weights "earlier in the injected context = more important" (typical for an LLM prompt), this
silently demotes a genuinely higher-confidence memory.
**Repro (reproduced):** three memories seeded with controlled type-weight×importance products
(0.70 / 0.50 / 0.42); `selectPack` order matched the score ranking, `renderPack`'s output index
of `'DECISION-MID'` was greater than `'FACT-LOW'`'s index. Test passed confirming the bug.
**Note:** this is arguably "working as designed" (the module doc says "grouped Markdown" by
type on purpose) — flagging because it's a genuine, reproducible ordering inversion relative
to the pack's own selection ranking, worth a conscious accept/reject decision rather than an
implicit one.

## 🟡 pack.ts::selectPack | tight token budget drops a whole date-bearing atom (no truncation, but a real date-drop)
**Break case:** the budget loop (`pack.ts:93-104`) is whole-atom in/out — it never truncates
mid-text (good: no corruption), but it has **zero awareness of temporal content**. A
low-importance/lower-type-weight atom that happens to carry the one absolute date relevant to
a question can be excluded entirely while higher-scoring but temporally-irrelevant "noise"
consumes the whole budget.
**Observed vs expected:** with a budget sized to fit exactly one high-scoring noise atom, the
date-bearing atom (`'Melanie started her new job on 2 July 2023.'`, type `note`,
importance 0.2) is dropped completely; the noise atom (`type decision`, importance 0.9) is
kept. Expected (if this pack fed a temporal-QA path): the date should survive somehow — it
doesn't.
**Repro (reproduced):** built exactly this two-atom scenario, budget = noise atom's token cost
+ 2; `pack.some(m => m.text.includes('2 July 2023'))` was `false`, noise atom present. Test
passed confirming the bug.
**Scope caveat — important:** see finding 0. This module is **not** on the LoCoMo
answer path, so this specific repro does not explain the temporal 12.4 F1 score. It's a real,
reproduced gap in the KF-B/Wave-4d *repo-memory-pack* subsystem on its own terms (a coding-agent
SessionStart pack could just as easily drop a date-carrying "decided to migrate off Postgres
on 2 July 2023" fact under budget pressure).

## 🟡 ground-dates.ts::hasUnresolvedRelativeDate | detector has no coverage for FUTURE-oriented relative phrases
**Break case:** `RELATIVE_DATE_DETECT_RE` (`ground-dates.ts:127-151`) is built entirely from
past-anchored patterns (`…ago/back`, `last/this/next <unit>`, named weekdays, seasons,
"recently/lately"). There is no pattern for future-distance phrasing ("in two weeks", "N
months from now", "two weeks from now").
**Observed vs expected:** these atoms never become grounding-retry candidates — the relative
phrase survives into the atom's stored text forever, silently (no log, no canary — the module's
`fired`/`resolved`/`errors` counters never even see these atoms, so they don't show up in any
existing measurement either).
**Repro (reproduced):** `hasUnresolvedRelativeDate` returned `false` for all 5 of: "The launch
is in two weeks.", "She starts in three months.", "The deadline is two weeks from now.", "We
meet again in a year.", "It ships in a couple of days." Test passed confirming the gap.

## 🟡 ground-dates.ts::groundAtomDates | no wall-clock cap, only a call-count cap (missing the sibling safety pattern)
**Break case:** `GroundDatesOptions.maxCalls` (default 50, `ground-dates.ts:188`) bounds call
*count* only. Unlike `consolidate.ts`'s contradiction-judge pairing (CLAUDE.md: `maxPerRun:
200` **+** `maxWallClockMs: 300_000`, added specifically because the FEAT-482 incident showed a
call-count cap alone still let ~245 sequential calls wedge the worker lane for 10+ minutes),
`groundAtomDates` has no independent wall-clock cap. Calls also run **strictly sequentially**
(`for (const atom of atoms) { … await resolveOne(...) }`, `ground-dates.ts:216-250`), so worst
case is `maxCalls × (that provider's own per-call timeout)` — bounded, not infinite (both
`ollama.ts` and `codex-subscription.ts` do enforce their own `AbortSignal` timeouts per call),
but with no code-level guard against a degraded-but-not-dead provider stacking up 50 slow calls
in a row during a single pipeline run.
**Static (not live-reproduced — would require a hanging/slow mock provider and a real pipeline
run, out of this task's box-safety bounds: no metered LLM, no long-running daemon).** Read
directly off `ground-dates.ts`'s own module doc comment (line 41-43, explicitly discusses
`maxCalls` bounding call count as "the real scarce resource" but never mentions wall-clock) and
confirmed against `contradiction-judge.ts`'s doc comment, which explicitly defers its
wall-clock cap to `consolidate.ts`. `ground-dates.ts` has no equivalent second cap anywhere in
the pipeline (`pipeline.ts:668` calls it with no extra options beyond the default).

---

## Finding 0 (scope/documentation correction, not a code bug)
`src/recall/pack.ts` / `src/recall/policy.ts` / `src/server/routes/recall.ts` are the **KF-B /
Wave-4d coding-agent repo-memory-injection** subsystem — wired to exactly one shipped caller,
the `SessionStart` hook installed by `src/cli/hook-install.ts` (confirmed by reading it: the
hook body is always `{repo: <cwd basename>}`, nothing else). This is a **different subsystem**
from the LoCoMo conversational retrieval/answerer path, which lives in `src/search/**` +
`src/distill/**`. The dispatch brief's landmine #1 ("does the recall pack preserve absolute
dates all the way to the answerer... temporal 12.4 F1 root") does not actually route through
this code — grepped `selectPack`/`recall/pack`/`recallRoute`/`decideInjection` across
`src/`: only the 8 files already read, none of them touch the search/distill/answerer path.
Treat the date-drop finding above as real-but-scoped-to-the-repo-memory-pack-feature, not as an
explanation for the LoCoMo temporal score.

Also: `src/distill/temporal-grounding.ts` and its `addMonthsUtc` function (both named in
CLAUDE.md and in this task's brief) **do not exist** in this worktree (`grep -r
"setUTCMonth|setMonth|addMonths" src/` → 0 matches anywhere in `src/`). The current
architecture (`src/distill/ground-dates.ts`) replaced all code-side month/week/year arithmetic
with an LLM call — the "GRANULARITY BUG" in that file's own doc comment is the direct successor
incident to the old `addMonthsUtc` overflow class. Worth noting: the current design has **zero
code-side verification** that the LLM's returned arithmetic is actually correct — the response
schema (`RetryResponseSchema`, `ground-dates.ts:110`) only checks `resolved_text` is a non-empty
string, nothing checks e.g. that "the week before 15 July 2023" is chronologically sane, or that
a resolved month is really the calendar month immediately before `sessionDateIso`'s month. The
adversarial-case coverage that exists (`tests/distill/ground-dates.test.ts`) pins *plumbing*
behavior against a scripted mock model, not real arithmetic correctness — the doc comment is
explicit that real-model verification only happened via a one-off manual eval script
(`scripts/eval/date-grounding-retry-adversarial.mts`), not a standing regression gate.

## Negative results (checked, not reproduced — stated so they aren't re-investigated)
- **No hangs found** in `pack.ts` / `policy.ts` / `recall.ts`: `selectPack`'s SQL is bounded by
  `CANDIDATE_LIMIT = 500` and a plain synchronous `better-sqlite3` `.all()`; the budget loop is
  bounded by the candidate array length; `MEMORY_REFERENCE_RE` / `SMALLTALK_RE` in `policy.ts`
  are simple anchored/alternation regexes with no nested quantifiers (no ReDoS risk even at the
  64,000-char `prompt` max from `PackRequestSchema`); no recursion anywhere in this surface.
- **No mid-atom truncation/corruption**: `selectPack`'s budget loop is strictly whole-atom
  in/out (`pack.ts:95-104`) — it never slices `m.text`. The only text mutation anywhere in this
  surface is `renderPack`'s `\s+` → single-space collapse (whitespace-only, not content loss).
- **Degenerate budgets don't crash**: budget smaller than the single best memory still returns
  exactly that one memory (`pack.ts:98-99`, and pinned by the existing test
  `tests/recall/pack.test.ts:80-84`); zero candidates → `[]` / `''`, well-formed at every layer
  (SQL row set, `selectPack`, `renderPack`, and the wire response), confirmed both by the
  existing green suite and by re-running it as this task's baseline (92/92 pass).
- **`evidence` is never touched** by `ground-dates.ts` — confirmed by the existing pinned test
  suite (`tests/distill/ground-dates.test.ts`'s "never touches atom.evidence" and "evidence is
  untouched across all six pinned cases" blocks, both green in the baseline run).
- The `addMonthsUtc` month-overflow class itself cannot be re-probed because the function no
  longer exists (see Finding 0) — not "fixed and confirmed", genuinely inapplicable to current
  code.

## Repro method note
All four `pack.ts`/`policy.ts`/`recall.ts` repros and the one `ground-dates.ts` repro were
written as temporary vitest files (`tests/tmp-qa-recall-repro.test.ts`,
`tests/tmp-qa-grounddates-repro.test.ts`), run via `bun run test -- <file>` against an
in-memory (`:memory:`) SQLite DB on ephemeral Fastify `.inject()` calls (no network listener, no
daemon, no port), then deleted — `git status --porcelain tests/` shows no residue from this
session. No source file was edited.
