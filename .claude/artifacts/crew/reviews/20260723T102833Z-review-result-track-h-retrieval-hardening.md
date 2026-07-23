# Review Result — Track H: retrieval hardening (governance / deadlines / mode passthrough)

**Branch**: `track/h` (worktree `C:/work/mega/astra-wt/track-h`), base `feat/retrieval-overhaul` @ b2b9f008
**Commit reviewed**: 8755f371 "fix(retrieval): close validation/deadline/silent-no-op gaps (Track H)"
**Reviewer**: independent review (read-only)
**Decision**: **PASS**

## Scope reviewed
`src/config/config.ts` (governance fns), `src/config/loader.ts`, `src/search/decompose.ts`,
`src/search/search.ts`, `src/server/routes/search.ts`, `src/mcp/server.ts`, plus tests under
`tests/config/`, `tests/search/`, `tests/server/`, `tests/mcp/`. 13 files, 764 insertions / 19
deletions (18 of the 19 deletions are the two `return` statements each governance fn replaced;
no `defaultConfig()` literal was touched — confirmed by diff and by direct grep of the base's
`defaultConfig()` `crossEncoder` entry, unchanged).

## 1. Governance clamps — loud-fail verified
`clampPositiveField` (`config.ts`, new shared helper) is NaN-safe both ways: `Number.isFinite(value) && value > 0` and `Number.isInteger(value) && value > 0` both evaluate `false` for `NaN` (neither `isFinite` nor `isInteger` accept NaN) — no `x < 1`-style comparison that NaN would silently slip through. Verified in `tests/config/config.test.ts` via `it.each([0, -1, NaN, 2.5])` (and `it.each([0, -1, NaN])` for the `timeoutMs` duration fields, correctly *not* rejecting `2.5` since a fractional ms budget is legitimate — confirmed by the dedicated "positive fractional timeoutMs is accepted" test). Every clamp path calls `log(...)` before falling back; a valid value takes the `if (valid) return value` branch before any log call is reached, so no spurious warn on a compliant config (confirmed by reading the code path directly — the "leaves a valid config byte-identical" tests assert output equality but don't additionally assert zero warn-calls; **low-severity test-coverage nit**, not a functional gap).

Three governance fns now clamp: `applyMultiHopGovernance` (maxSubQueries/maxSupplemental int, timeoutMs duration), `applyQueryRewriteGovernance` (maxVariants/maxCandidates int, timeoutMs duration), new `applyCrossEncoderGovernance` (provider enum + topK int/timeoutMs duration). All three correctly early-return before touching the new fields when the block is missing or the enum (provider/mode) is invalid — so `qr.maxVariants` etc. is never read off a `qr` that's `undefined` at that point in the invalid-provider branch.

## 2. loader.ts scope expansion — correct, no double-apply
`applyCrossEncoderGovernance` is now composed at both `loadConfig` (`config.ts:2722`) and `loadConfigFromDisk` (`loader.ts:361`), matching the composition shape every sibling governance fn already has in both places (`applyMultiHopGovernance` was already dual-wired; `crossEncoder` had zero composition points before this pass — confirmed via `git show feat/retrieval-overhaul:...` grep, only the raw `defaultConfig()` literal existed). Each site calls it exactly once on its own `merged`/`cfg` — no double-apply. `defaultConfig()`'s literal `crossEncoder: { enabled: false, provider: 'onnx', topK: 40, timeoutMs: 1500 }` is untouched (confirmed: zero diff lines against that block).

## 3. `Math.max(0, maxSupplemental)` in search.ts (issue #8)
`search.ts:1046` — `slice(0, Math.max(0, opts.decompose.maxSupplemental))`. A negative value now floors to `0` (disabled), not the pre-fix "negative index inverts the cap, keeps everything" behavior. Proven directly against `search()` in `tests/search/decompose-integration.test.ts`'s new "issue #8" test: `maxSupplemental: -1` added via a hand-built `SearchOpts.decompose` (bypassing config governance on purpose, since this is exactly the defense-in-depth case — a caller can hand-build `SearchOpts` without ever calling `applyMultiHopGovernance`) → asserts `addedCount === 0` against 4 candidate ids that would otherwise have been added.

## 4. `MAX_FANOUT_WALL_CLOCK_MS` (5s hardcoded, issue #6)
Bounds both loops: the WS6 sub-query loop (`search.ts` ~897) and the FEAT-550 rewrite-variant loop (~942), each with its own independent deadline (`Date.now() + MAX_FANOUT_WALL_CLOCK_MS` computed fresh per loop) rather than sharing one budget across both stages. Both break early on `Date.now() >= deadline`, log a structured warn via `childLogger` (consistent with the existing `childLogger({stage: ...})` convention used in `decompose.ts`/`query-rewrite.ts`/`rerank.ts` — not a new logging idiom), and — critically — keep whatever was already pushed into the accumulator arrays rather than discarding it (confirmed by reading the loop bodies: `break` exits the `for` loop after the deadline check, before the `gatherCandidates` call for that iteration, with no rollback of prior iterations' pushes).

Both integration tests (`decompose-integration.test.ts`, `query-rewrite-integration.test.ts`) use `vi.useFakeTimers()` + `vi.setSystemTime(Date.now() + 6_000)` triggered from inside a mocked `embed()` call between the first and second sub-query/variant — a real assertion that the loop's deadline check fires and breaks early (first item's hit present, second item's hit absent), not a real multi-second sleep. Both have `afterEach(() => vi.useRealTimers())`.

**Hardcoded/non-config-surfaced decision**: reasonable as flagged, not blocking. It's a safety ceiling in the same class as the pre-existing `MAX_EVIDENCE_EXCERPT_CHARS` a few lines above it (also hardcoded), and the stated rationale (avoiding a `defaultConfig()` collision / new governance surface for a single constant) is a legitimate scope call for a P2 hardening pass — a config knob can be added later without any migration cost since it only ever narrows behavior further.

## 5. `src/server/routes/search.ts` — `withDeadline` on GET /search
Wrapped in `withDeadline('GET /search', reply, async () => {...})` using the same `DEFAULT_HANDLER_DEADLINE_MS = 30_000` default POST /recall already uses (`deadline.ts:37`), not the 60s Fastify connection-level `requestTimeout`. Confirmed via a live-daemon test using `vi.useFakeTimers({ shouldAdvanceTime: true })` + a never-resolving `embed()` stub + `vi.advanceTimersByTimeAsync(30_000)` → asserts `504` with `error: 'handler_deadline_exceeded'` and the honest non-#347-claiming message. Happy path is unchanged — every other GET /search test in the 288-test run below still returns 200 with identical bodies to pre-diff behavior (nothing in the diff touches the response-shaping code inside the wrapped closure beyond moving it inside the closure verbatim).

## 6. Mode passthrough (retrieval-query@1 contract, issue #2)
- **GET /search**: `RetrievalModeEnum` (`z.enum(['keyword','semantic','hybrid'])`, pre-existing at `search.ts:99`, previously read into the `RecallBodySchema` but never read for the querystring) now parsed from `params.mode` with `.safeParse` → 400 with `{error:'invalid', details}` on failure, same shape as the pre-existing `type`/`preset` query-param validation just above it. Threaded into `SearchOpts.mode`. Proven against the live route: `mode=keyword` vs `mode=hybrid` return measurably different id sets (an FTS-only-reachable atom vs. a vec-only-reachable atom), omitted-mode is byte-identical to explicit `mode=hybrid`, and `mode=bogus` is a clean 400 — not a silent fallback to hybrid.
- **MCP `search_memory` + `recall_memory`**: both gained an identical `mode: z.enum([...]).optional()` zod field, threaded as `mode: args.mode ?? 'hybrid'` into `SearchOpts`. A bad enum value is rejected by the MCP framework's own zod validation before the handler runs (structurally equivalent to the REST 400 case — confirmed no manual re-validation was needed/added, matching how every other enum arg on these tools already behaves). Proven with a real live-server round trip (`tests/mcp/search-parity.test.ts`, `describe.each(['search_memory','recall_memory'])`) using the identical FTS-only/vec-only fixture pattern as the REST test.
- **Contract shape match**: `retrievalMode` on GET /search is the same three-value union already accepted by POST /recall's `RecallBodySchema.mode` and by the MCP tools — no shape drift introduced.

## 7. ADR-005 floor gate
Ran `tests/eval/retrieval-eval.test.ts` directly: **16/16 passed** (recall@10/NDCG@10 floors intact).

## 8. Build/test evidence (ran myself, not just author-reported)
- `bunx tsc --noEmit` → clean, zero output.
- Targeted suites (`tests/config/config.test.ts`, `tests/config/loader.test.ts`, `tests/search/decompose.test.ts`, `tests/search/decompose-integration.test.ts`, `tests/search/query-rewrite-integration.test.ts`, `tests/server/search.test.ts`, `tests/mcp/search-parity.test.ts`) → **288/288 passed**.
- Full suite (`bunx vitest run`): **404/404 test files passed, 5384 passed | 1 expected fail | 19 skipped** — notably the "2 pre-existing schedule.test.ts timeout failures under contention" the author flagged did **not** reproduce in this run (0 failures observed). Not this diff's concern either way (`doctor/**` is untouched by the Track H diff — confirmed via file list), and a flaky-under-contention failure that didn't fire this run doesn't change the PASS verdict.

## 9. Base discipline
- Main checkout (`C:/work/mega/astramem-local`) has no Track H changes — only unrelated pre-existing `.claude/state/` and `CLAUDE.md` housekeeping from other concurrent session activity, nothing source-code related.
- `git diff feat/retrieval-overhaul..track/h -- src/search/fuse.ts src/search/onnx-cross-encoder.ts` → empty. Both untouched.
- `scripts/eval/consolidation-bench/results/latest-run.json` — not present in the reviewed diff at all; nothing to ignore.

## Findings summary
No blocking findings. One low-severity note:

- **[low][test-coverage nit]** `tests/config/config.test.ts` / `tests/config/loader.test.ts`: the "leaves a valid config byte-identical" / "compliant config.yaml boots unchanged" tests assert output equality but don't additionally assert the log/warn spy received zero calls. Functionally verified correct by reading `clampPositiveField` (the `if (valid) return value` branch returns before any `log(...)` call is reached), so this is a coverage gap, not a behavior bug. Optional follow-up, not blocking.

## Verdict: PASS
Governance clamps are loud-fail and NaN-safe, correctly composed on both config paths, the negative-index slice-inversion class (issues #6/#8/#9) is closed with real fake-timer proof (not simulated assumptions), GET /search now shares POST /recall's deadline and mode-passthrough behavior with matching contract shape, and the ADR-005 floor plus full suite are green. Approved to proceed.
