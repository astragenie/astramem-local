# Silent-error audit — 2026-07-13

Repo: `astramemory-local`. Branch: `fix/silent-error-swallowing`. Scope: every `catch` block, `.catch()`, and fail-open/best-effort comment in `src/`, triaged into LEGITIMATE / DANGEROUS / UNCLEAR, per the team's brief.

This repo's dominant, repeated failure mode is **a swallowed error that lets the caller proceed as if it succeeded — producing wrong data, a wrong metric, or a green status that should be red.** Three instances of exactly this shape were already fixed elsewhere before this audit started: entity extraction silently failing on ~87% of memories while doctor stayed green (issue #200), the feedback-loop canary counting corrections as positive signal (issue #190), and two migrations sharing a number so one was silently skipped (issue #185). This audit's job was to find the *next* instances of the same class — and it found several, including two brand-new ones in code this audit's own fixes had to touch.

## DANGEROUS findings, ranked by blast radius

### 1. Nine doctor checks return `ok: true` when the check's own query fails to run — not when it ran and found things healthy

**Files:** `src/doctor/checks.ts` (9 sites: Recall usefulness, Usefulness feedback loop, Memory health, Crash loop, Entity relations extraction, Consolidation judge, Auto-capture, Proxy capture, Schema drift), `src/doctor/gpu-checks.ts` (1 site: Orphaned llama-server processes).

Every one of these checks does the same thing: `try { ...query the DB or a probe...; return {ok:true, message:'<real result>'} } catch (err) { return {ok:true, message:'<name> check error (non-fatal): '+err} }`. The `CheckResult` type is a strict boolean — there was no way to distinguish "I checked and it's fine" from "I never managed to check." `formatJson`'s `summary.ok` count and `formatTable`'s ✓ icon treated both identically. This is the **exact bug class** issues #190 and #200 were about — a query that throws (schema drift, a locked DB, a corrupt row, a missing table) produces a plausible green row instead of surfacing that the check itself is blind. Worse: for the "Usefulness feedback loop" and "Entity relations extraction" checks specifically, this is the residual, unfixed half of the *same* two issues — the #190/#200 fixes corrected the *logic* of what counts as positive signal, but the *exception path* around that same logic still silently reported green.

**Fix:** added a real third state. `CheckResult` gained an `inconclusive?: boolean` field (`src/doctor/types.ts`). `formatTable` now renders `⚠` instead of `✓` for an inconclusive result; `formatJson`'s summary splits `{ok, inconclusive, fail}` instead of folding `inconclusive` into `ok` (`src/doctor/runner.ts`); `cli/doctor.ts`'s human-readable summary line does the same. All 10 catch sites now return `inconclusive: true` alongside `ok: true`. `ok` itself is deliberately left `true` — doctor's exit-code gate (`hasFailures = results.some(r => !r.ok)`) is unchanged, preserving the legitimate "don't hard-fail a whole doctor run over one transient query error" design — but the row can no longer be mistaken for a verified-healthy result by anything that reads `.ok`/`summary.ok` alone.

**Bonus finding surfaced by fixing this:** every one of these 10 functions opened a readonly DB handle (`openProductionDbReadonly`) and closed it *inline*, immediately after the query — meaning if the query itself threw (the exact case this fix targets), `db.close()` was never reached and the connection leaked. This is a real resource leak on every single inconclusive result, and on Windows it reproduced as a stuck file lock that broke a subsequent `rmSync` in this audit's own test cleanup. Fixed uniformly: each function now declares `let db: DB | undefined` before the `try`, and closes it exactly once in a `finally` block, regardless of which path was taken.

### 2. Consolidation judge telemetry counted invocation, not success — a systemically broken judge would look identical to "no contradictions found"

**Files:** `src/consolidate/contradiction-judge.ts`, `src/consolidate/consolidate.ts`, `src/storage/consolidation-judge-log.ts`, `migrations/033-consolidation-judge-errors.sql`, `src/doctor/checks.ts` ("Consolidation judge" check).

`judgeContradiction()` deliberately falls back to `{verdict:'unrelated', confidence:0}` on a parse failure or a thrown/rejected `chat()` call — a documented, correct design so a bad LLM response never blocks a consolidation run. But `consolidation_judge_runs` (migration 031, written by `recordConsolidationJudgeRun`) only ever recorded `judgeCalls` — how many times the judge was *invoked* — never how many of those calls actually produced a real verdict versus silently defaulting. A judge pointed at a broken model, a provider returning malformed JSON, or a flaky network would make **every single call** fall back to `'unrelated'`, and `consolidation_judge_runs` would show a healthy-looking non-zero `judgeCalls` count with zero way to tell that apart from a working judge that genuinely found no contradictions. This is the same shape as issues #190 and #200, in a newer feature (FEAT-482, shipped after both those fixes).

**Fix:** `judgeContradiction` takes an optional `onFallback` callback, invoked exactly on the fallback path. `consolidate.ts` tallies fallbacks into a `judgeErrorsThisRun` counter and persists it via a new `judgeErrors` column (migration 033, additive `DEFAULT 0`, `SCHEMA_VERSION` bumped 32→33). The "Consolidation judge" doctor check now flags the case `judgeErrors >= judgeCalls` (judgeCalls > 0) as a genuine `ok: false` — "the judge is not actually classifying anything" — and surfaces a partial-failure count in the informational message otherwise.

### 3. `/remember` (REST) and MCP `remember` both swallow an embed/vec-upsert failure and return `ok: true` unconditionally

**Files:** `src/server/routes/search.ts`, `src/mcp/server.ts`.

Both entry points do the same thing: insert the memory (durable, FTS-searchable), then `try { embed + vecStore.upsert } catch (err) { log.warn(...) }`, then return `{id, ok: true}` **no matter what happened in the catch**. A caller — an agent calling the MCP `remember` tool, or any REST client — has no way to know the memory it just saved is vector-search-blind until it notices recall isn't finding something it should, or an operator manually runs `rebuild`. The existing code comment even says "vec will be populated on reembed" — but nothing enqueues a reembed job; the memory stays unindexed until someone remembers to run that command by hand.

**Fix:** both routes now track whether the embed/upsert step actually succeeded and add `vec_indexed: false` to the response when it didn't (omitted — implicitly true — on the happy path, so the change is additive and doesn't affect existing consumers reading just `.ok`/`.id`). Enqueuing an automatic reembed job was considered and deliberately **not** done in this PR — wiring `JobRepo` into these two route modules is a real dependency-injection change touching `app.ts`'s construction path, out of proportion to a silent-error audit; flagged below as a natural follow-up.

## UNCLEAR → resolved with a narrow, low-risk fix

### 4. `backup/retention.ts`: any `readdirSync` error (not just "directory doesn't exist") was reported as "nothing to prune"

The catch's own comment said "Directory does not exist yet" but the code caught every error class — a permissions failure or a transient I/O error on the backups directory would silently return `{kept:[], deleted:[]}`, indistinguishable from a legitimately-empty, healthy prune. Blast radius is low (this only skips pruning already-taken backups; it doesn't touch the backup just written or lose data), but the mismatch between the comment's stated intent and the code's actual behavior is exactly the kind of thing this audit is supposed to catch. **Fix:** narrowed to `err.code === 'ENOENT'`; anything else now propagates.

### 5. `cli/reinstall.ts`: the `prune-releases` step reported `ok: true` specifically *because* it failed

The step's own comment explained the intent correctly — "a prune failure is a SOFT step: it is never allowed to flip the overall run to failed" — but the *implementation* achieved that by mislabeling a thrown error as `ok: true`. `reinstallCommand`'s own gate (`finish()`) computes `failed = steps.filter(s => !s.ok)`; relabeling to `true` was the only way this step avoided tripping it. That means a `--json` consumer (or any future automated check) reading `steps` sees a green row for a step that actually threw — the same "mislabeled failure" shape as finding #1 above, just in a CLI step list instead of a doctor check list. **Fix:** added a `soft?: boolean` field to `StepResult`. The step now reports honestly (`ok: false, soft: true`), and `finish()`'s gate excludes `soft` steps from the pass/fail count instead of relying on the step lying about its own outcome. Same non-goal-respecting principle as finding #1: the "never fail the run over this" behavior is unchanged, only the honesty of the intermediate signal.

## LEGITIMATE (representative, not exhaustive)

The other ~170 fail-open/best-effort sites surveyed were, with the two narrow exceptions above, doing what their comments said:

- **Crash-path cleanup** — `try { lock?.release() } catch {}` / `try { dbForCrash?.close() } catch {}` in `serve.ts`'s `crashExit`, and the equivalent in `reinstall.ts`'s git-hooks-activation catch. Nothing downstream reads these; they exist purely so a second failure during a fatal exit can't mask the first.
- **Retry-then-rethrow** — every LLM/embed provider (`ollama.ts`, `azure-openai.ts`, `openai-compatible.ts`, `codex-subscription.ts`) retries once on a transient network error and rethrows a typed error after exhausting retries. The error always surfaces to the caller; nothing is silently absorbed.
- **Explicit `{error}`/`{ok:false}` result shapes** — `memory-tool/adapter.ts` ("Never throws... every failure path comes back as `{error}`"), MCP tool error mapping (`MemoryNotFoundError`, `ProposalNotFoundError`, `PresetValidationError` → explicit typed responses), `backup/verify.ts`, `cli/backup.ts`, `cli/restore.ts`, `cli/capture.ts` (per-item `status: 'error: ...'` aggregated into a summary that also sets a non-zero exit code).
- **Deliberately-designed degrade-and-log** — `search/rerank.ts` and `search/decompose.ts` fall back to un-reranked/single-pass results on a stage timeout, but log a `log.warn` naming the fallback every time; never silent.
- **Config governance "never block a run on a bad value" pattern** — `resolveAutoAcceptThreshold`, `resolveContradictionDetection` in `consolidate.ts`, `resolveChunkConcurrency` in `distill/concurrency.ts`: an invalid config value disables the feature for that run and logs why, rather than crashing a scheduled job over an operator typo.
- **`service/shim.ts`'s crash-log/history-log writers** — explicitly commented "swallowed on purpose," and confirmed these only affect *diagnostic* logging; the daemon's actual exit code and the scheduler's respawn decision never pass through them.
- **`recordRelationGuardDrops`-style fail-open counters** — per the brief's own explicit non-goal, left untouched; these are a counter write that must not itself take down a distill job, and they're already the *fix* for a past instance of this bug class, not a new instance of it.

One judgment call worth naming explicitly: **`contradiction-judge.ts`'s fallback-to-`'unrelated'`** on a bad LLM response is itself LEGITIMATE and correctly documented (matches the repo's established "never block a run on a bad LLM response" pattern used by `estimateLlmJudgedJunk` and the config-governance functions above). What was DANGEROUS was that the fallback rate was *never counted* — see finding #2. The fallback behavior itself was not changed.

`distill/concurrency.ts`'s `mapWithConcurrency` was flagged for review during triage (a stop-on-error dispatcher is easy to get wrong) and confirmed LEGITIMATE: `if (hasError) throw firstError;` propagates the exact original error once every in-flight call settles — no swallowing.

## AC-2 — CLI global exception handler

`src/cli/index.ts` (the entrypoint for `doctor`, `reinstall`, `queue`, `init`, `backup`, etc.) had no `uncaughtException`/`unhandledRejection` handler — only `serve.ts` did. The existing `main().catch(e => {...})` at the bottom only covers a rejection on the awaited `main()` promise chain; it does nothing for a stray exception in fire-and-forget background work outside that chain.

Added `src/cli/crash-handlers.ts` exporting `installCliCrashHandlers(exit = process.exit)`, called once at the top of `index.ts`. Logs `FATAL <kind>: <error>` and exits non-zero on either event — modeled on `serve.ts`'s `crashExit`, adapted for a one-shot command (no lock/DB to release). Extracted into its own module specifically so it's unit-testable without importing `index.ts` itself, whose top-level `main()` call would otherwise execute the real CLI against the test process's own argv.

## Tests added

- `tests/cli/crash-handlers.test.ts` — both events log + exit(1).
- `tests/server/search.test.ts`, `tests/mcp/server.test.ts` — embed/vec-upsert failure surfaces `vec_indexed: false`; memory row still persists, vec row does not.
- `tests/doctor/runner.test.ts` — `inconclusive` renders `⚠` not `✓`; `formatJson` splits it out of `summary.ok`.
- `tests/doctor/{usefulness-feedback-loop,entity-relations,memory-health,auto-capture,proxy-check,schema-drift}-check.test.ts`, `tests/doctor/gpu-checks.test.ts` — each check's own query/probe failure now returns `inconclusive: true`, not a bare `ok: true`.
- `tests/consolidate/contradiction-judge-onfallback.test.ts` (new, fake-provider unit test — no real Ollama) — `onFallback` fires exactly on the parse-failure and thrown-call paths, never on a genuine verdict.
- `tests/consolidate/consolidate.test.ts` — a judge provider that always throws produces `judgeErrors === judgeCalls` in the persisted run row.
- `tests/doctor/consolidation-judge-check.test.ts` — all-fallback → `ok:false`; partial fallback → informational with the count visible; omitted `judgeErrors` (older callers) stays backward compatible.
- `tests/backup/retention.test.ts` — a non-ENOENT `readdirSync` error now throws instead of returning an empty result.
- `tests/cli/reinstall.test.ts` — `finish()`'s soft-failure gating: a `soft` step doesn't trip `process.exit(1)` or inflate `--json`'s `ok`, but is still reported honestly as `ok: false`; a hard failure alongside a soft one still exits 1.

## Verification

- `bunx tsc --noEmit` — clean.
- `bun run build` — clean.
- `bunx vitest run` (excluding `tests/consolidate/contradiction-e2e.test.ts` and `tests/providers/llm-contract-conformance.test.ts`'s live describe block — both make real calls against a local Ollama, which per this session's explicit safety directive was under heavy concurrent load from sibling agents and must not be driven further) — **264 test files, 3295 tests passed, 6 pre-existing skips, 0 failures.**
- Bumping `SCHEMA_VERSION` 32→33 (migration 033) required updating hardcoded `32` literals in `tests/storage/{atom-v3,entities,entity-relations,entity-validity,migrate,upgrade-path}.test.ts`, `tests/server/version.test.ts`, and `tests/integration/ingest-e2e.test.ts` — mechanical fallout of the version bump, not a behavior change.

## Non-goals honored

- Did not touch `recordRelationGuardDrops` or any other site the brief named as deliberately fail-open by design.
- Did not mass-rewrite the ~170 LEGITIMATE fail-open sites found during triage.
- Did not wire an automatic reembed-job enqueue into the `/remember`/MCP-remember fix (finding #3) — that's a DI change beyond this audit's scope; `vec_indexed: false` makes the degraded state visible to the caller, which satisfies AC-3's "make the failure visible in the caller's result" without the larger refactor.
- Did not run any LLM-dependent test or eval against the shared, contended local Ollama instance.

## Suggested follow-ups (not done here)

1. Enqueue an automatic `reembed` job (the handler already exists, `src/pipeline/handlers/reembed.ts`) when `/remember`/MCP `remember`'s embed/vec-upsert fails, so `vec_indexed: false` self-heals instead of requiring a manual `rebuild` run — needs `JobRepo` threaded into both route modules' construction.
2. The same DB-handle-leak-on-error-path pattern this audit fixed in `doctor/checks.ts` is worth a targeted grep across the rest of the codebase (anywhere a DB/file handle is opened in a `try` and closed inline rather than in a `finally`) — this audit only found it because fixing the `inconclusive` finding forced a second look at these specific 11 sites.
