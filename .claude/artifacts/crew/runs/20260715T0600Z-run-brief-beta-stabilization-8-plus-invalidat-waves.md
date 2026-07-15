# Run brief — beta stabilization wave plan (8 items + invalid_at 1-3)

- **Objective:** Complete all 8 stabilization/perf items + the invalid_at measure-plan (steps 1-3), parallelized into worktree-isolated waves respecting file-conflict rules.
- **Owner:** lead (dispatch), crew builders per slice.
- **Repo/branch:** astramemory-local / main. Release in flight: `0.19.0-beta.0` (npm `beta` tag; `latest` still 0.18.0).
- **Mode:** interactive `/crew:build` per slice (NOT the autonomous loop — never both on same branch). Parallel slices run in sibling git worktrees, each with own `.claude/state`.
- **Gate policy:** every code slice → builder → reviewer; validator when behavior changes. Production promotion (#8) requires explicit user approval (constitution).

## Item → file footprint (conflict basis)

| # | Item | Primary files | Notes |
|---|---|---|---|
| 1 | Periodic doctor into serve | `src/cli/serve.ts` (+ doctor entry), maybe `config.ts` (interval field) | serve.ts already has setInterval pattern (consolidate/cleanup/spool-drain/WAL). Add a lite doctor tick. |
| 2 | #261 LLM fetch-abort | `src/providers/llm/ollama.ts` | `combineSignals` already exists — CONFIRM #261 still open on LLM side (embed side already got it) before building. |
| 3 | ONNX embed provider | NEW `src/providers/embed/onnx.ts`, `contracts/embed.ts`, `providers/index.ts`, `config.ts`, doctor probe | Gated on architect design (in flight) + architect-reviewer of that design. Multi-slice S1..S4. Opt-in, NOT default. |
| 4 | FEAT-507 reembed oversize poisons | `src/pipeline/handlers/reembed.ts` (exists) + scanner/enqueuer | Oversize detection lives in `08-embed-index.ts` — SCOPE OUT of the validity-guard region (#7 owns that). |
| 5 | #284 conditional compaction | `src/distill/stages/04-compact.ts`, `distill.ts` | Gate engineering compaction off for conversational content. |
| 6 | Merge PR #340 (k=15) | `src/mcp/server.ts` (already on branch) | Merge only — CI-green check, no build. |
| 7 | invalid_at measure→decide | (read-only measure) → maybe `distill/prompts/extract.ts` + `08-embed-index.ts` guard | ZERO LoCoMo value (harness never sets as_of). Prod-correctness only. Measure-first. |
| 8 | beta→latest promotion | `package.json`, git tag, npm | Sequential, LAST, human-approved. Gated on soak (24h) + clean doctor + drain. |

## Conflict hotspots
- `08-embed-index.ts`: #4 (oversize detect) vs #7 (validity guard) → **serialize**: #4 scoped to `reembed.ts` only; #7 owns the guard region.
- `config.ts`: #3 (config.embedding.*) vs #1 (config.doctor.interval) → different keys, low risk; do in separate commits, second rebases.
- `distill.ts`: #5 owns orchestration edit; #7 scoped to `extract.ts` + guard (not distill.ts) → parallel-safe.

## PLAN REVIEW CORRECTIONS (2026-07-15, verified against live source)

Architect-reviewer + direct verification found 4 corrections — applied below:

1. **#1 doctor→serve is ALREADY BUILT.** `serve.ts:421` calls `startFrequentDoctorSchedule`
   (`src/doctor/schedule.ts`): two-tier — cheap DB-only checks every 15min, LLM/embed probes
   piggyback the 24h cleanup tick. DROPPED from build scope. Replaced by an OPTIONAL micro-item
   (#1'): `extraction-yield.ts` + `memory-health.ts` are `tier:'full'` (24h); promoting to
   `'cheap'` cuts broken-model detection latency to 15min. `spool-quarantine.ts` is already
   `'cheap'`. (An earlier verify-agent grepped only `runChecks` and missed this — CLAUDE.md
   corrected.)
2. **#2 #261 is likely ALREADY FIXED.** `combineSignals` (`llm/ollama.ts:115`, cites #261) is
   passed to `fetch` (`:127`) so the fetch IS aborted on timeout. Downgraded from build slice to
   an AUDIT: hunt any residual `withTimeout` Promise.race path; if none, close #261 with evidence.
3. **#4 vs #7 do NOT collide.** Oversize detection is NOT in `08-embed-index.ts` (grep clean);
   that file holds only the validity guard (#7's turf). #4's scope = `reembed.ts` + scanner.
   Confirmed parallel-safe — serialize-caution relaxed.
4. **invalid_at zero-LoCoMo CONFIRMED.** `answer.mts:9-16` doc comment: LoCoMo has no per-question
   `as_of` anchor (unlike LongMemEval's `question_date`). invalid_at earns zero LoCoMo points —
   prod-correctness only. (It WOULD matter for LongMemEval.)

Net: #1 removed, #2 → audit. Beta is more complete than the original plan assumed.

## Waves (revised)

### Wave 0 — immediate, no worktree
- **#6** merge PR #340: `gh pr checks 340` green → merge to main. Main thread.
- **#7 steps 1-2** (MEASURE + SAMPLE): read-only. Query current dual-pass codex store for `valid_to NOT NULL` count + `validity_guard_drops` + `validity_extracted` provenance (confirm still 0/N). Hand-sample ~20 transcripts that SHOULD invalidate ("used to X now Y", "no longer", "switched from"). Output → decision doc. Dispatch a `crew:researcher` (read-only). No file conflict.
- ONNX architect design already running → feeds Wave 2 B3 gate.

### Wave 1 — parallel, disjoint files (worktree-isolated builders)
- **A1 = #1** doctor→serve (`serve.ts` + doctor entry).
- **A2 = #2** #261 LLM fetch-abort (`llm/ollama.ts`). First step in slice: confirm still-open.
- **A3 = #4** FEAT-507 reembed oversize (`pipeline/handlers/reembed.ts` + enqueuer/scanner; OUT of 08 guard).
Three disjoint areas (serve/doctor, providers/llm, pipeline/reembed) → safe parallel. Each: builder → reviewer (+ validator: #1 behavior=periodic check fires; #2 behavior=orphaned call aborts; #4 behavior=oversize atom re-embedded).

### Wave 2 — parallel, after Wave 1 (or concurrent if disjoint confirmed)
- **B1 = #5** #284 conditional compaction (`04-compact.ts` + `distill.ts`).
- **B2 = #7 step 3** DECIDE + optional prompt slice. Gated on Wave-0 A4 decision:
  - "convos genuinely never invalidate" → CORRECT: no code, add rate-0-expected note, close.
  - "model omits when it should" → prompt gap: 1-2 conservative bounded-invalidation few-shots in `extract.ts` + keep anti-hallucination guard. Behind existing validity guard.
  - Scope B2 to `extract.ts` + `08` guard only (NOT distill.ts) → parallel-safe with B1.
- **B3 = #3** ONNX build S1..S4. Gate: architect design + architect-reviewer PASS on that design first. Own worktree. Coordinate config.ts with A1's field (separate keys). S1 skeleton+tokenizer+dim-assert+tests → S2 startup-preload+health+probe → S3 geometry-parity verification (go/no-go GATE) → S4 docs+opt-in config.

### Wave 3 — release, sequential, HUMAN-APPROVED
- **#8** beta→latest promotion: verify 24h soak complete + clean doctor (documented expected rows) + sync drain done → bump `package.json` 0.19.0 + tag `v0.19.0` same PR (version-tag-parity CI) + push tag + npm publish (standing auth) + verify `npm view dist-tags` latest→0.19.0 + local `reinstall`. **Explicit user approval required** — production promotion is never auto-unlocked.

## Critical path
Wave 0 (#6, #7-measure) ∥ architect(ONNX) → Wave 1 (#1,#2,#4) ∥ → Wave 2 (#5, #7-decide, #3-onnx after design-review) → Wave 3 (#8, gated on soak + all green + approval).

ONNX (#3) is the long pole (~2 days, multi-slice, parity-gated) — it can run its own worktree track in parallel across Waves 1-2 without blocking the others. #8 blocks on soak clock, not on #3.

## Risks
- #261 may already be partially fixed (combineSignals present) — confirm before building or it's a no-op slice.
- ONNX geometry-parity (S3) is a go/no-go GATE — if ONNX-mxbai vectors don't match Ollama-mxbai space, switching an existing install needs a full reembed; v1 stays opt-in regardless.
- #4 vs #7 both eye `08-embed-index.ts` — enforce the scoping split or they merge-conflict.
- #8 gated on external soak clock (~2026-07-15T23:00Z) + human approval — not code-completable.
