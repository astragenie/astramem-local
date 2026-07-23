# Adversarial bug-hunt: multi-hop decompose + query-rewrite path

Scope: `src/search/decompose.ts`, `src/search/query-rewrite.ts`, `multiHop`/`search.queryRewrite`
config wiring (`src/config/config.ts`, `src/config/loader.ts`), fan-out wiring in
`src/search/search.ts`, `tests/search/decompose*.test.ts`. Read-only investigation +
targeted repro (mock/fake providers only, in-memory DB, own-PID, no LLM/network). No source
edited.

Format: `path.ts::symbol | severity | break-case → observed vs expected | repro`. Most severe
first.

---

## 🔴 `search.ts::search` (lines 872-891, 909-917) — decompose/rewrite fan-out is a SEQUENTIAL
loop with NO per-call timeout; `multiHop.timeoutMs`/`queryRewrite.timeoutMs` only bounds the
decomposer's/rewriter's OWN call, not what happens after it returns

**Break-case:** the decomposer/rewriter itself can return instantly (well inside its timeout
budget) and the fan-out is still slow, because each sub-query/variant's `gatherCandidates()`
call — its own `embed.embed()` round-trip — runs one at a time in a plain `for...await` loop
with no `AbortSignal`, no race, nothing. The per-call ceiling actually in effect is whatever
the embed **provider's own internal, unrelated timeout** happens to be (`EMBED_TIMEOUT_MS =
15_000` in `src/providers/embed/ollama.ts:6`), not `multiHop.timeoutMs` (default 800ms,
`config.ts:1575`) or `queryRewrite.timeoutMs` (default 1500ms, `config.ts:1553`).

**Observed vs expected:** the module doc comment in `decompose.ts` (lines 31-40) advertises
`timeoutMs` as a "hard per-call budget" that bounds decomposition's cost, framing it as one of
three levers gating "a per-recall LLM call on a hot, latency-sensitive path." In practice that
budget only covers the JSON-array LLM call. With the shipped default `maxSubQueries: 3`, a
degraded-but-not-hung embed provider (slow GPU, contention, network hiccup — not even a full
hang) can add up to `3 × 15_000ms = 45s` to ONE `search()` call, sequentially, invisible to the
"800ms budget" an operator reading the config would reasonably assume caps this feature's
worst case. `queryRewrite`'s variant loop (search.ts:909-917) has the identical shape. There is
no outer wall-clock cap anywhere in the call chain either — `src/server/routes/search.ts` and
`src/mcp/server.ts` both call `search()` directly with no timeout wrapper, so nothing backstops
this at the HTTP/MCP layer.

**Repro (reproduced, not static):** in-memory DB, no LLM, a fixed instant-resolving mock
decomposer (`decompose: async () => [3 sub-queries]`, `timeoutMs: 5000` — generous, never
trips) plus a fake embed provider that sleeps 250ms per call. Ran via a temporary vitest test
(written, executed, deleted — not left in the repo):

```
{"embedCallCount":4,"elapsed_ms":1043,"expected_if_sequential_ms":1000,"expected_if_parallel_ms":250}
```

4 embed calls (1 primary + 3 sub-queries) cost ~4× one call's latency — confirms the fan-out is
strictly sequential and confirms the decomposer's own near-zero latency (logged
`"latency_ms":0"` for the decompose stage itself) did nothing to protect total request latency
from the downstream gather loop. Swap the fake 250ms sleep for a real degraded/slow Ollama
embed endpoint and the same shape reproduces against a live daemon — not exercised here per the
box-safety local-only constraint, but the mechanism is fully generic (it's the same
`gatherCandidates()` every sub-query calls).

---

## 🔴 `src/config/config.ts::applyMultiHopGovernance` / `applyQueryRewriteGovernance` — only
the enum fields and `supplementalWeight` are validated; `maxSubQueries`, `maxSupplemental`,
`minQueryWords`, `timeoutMs` (multiHop) and `maxVariants`, `timeoutMs`, `maxCandidates`
(queryRewrite) pass through a hand-edited `config.yaml` completely unchecked

**Break-case:** `applyMultiHopGovernance` (config.ts:2534-2560) checks `provider ∈
{'mock','llm'}` and clamps `supplementalWeight` to `[0,1]` — and nothing else.
`applyQueryRewriteGovernance` (config.ts:2578-2598) checks `mode ∈ {'off','enabled'}` and
`provider ∈ {'mock','llm'}` — and nothing else. Both are wired into the real boot path
(`loadConfigFromDisk`, `src/config/loader.ts:333,354` — verified, not just the
zero-production-caller `loadConfig()` sandbox path). Neither the `LlmQueryDecomposer` nor
`LlmQueryRewriter` system prompt's requested `jsonSchema` (`decompose.ts:140`,
`query-rewrite.ts:122`) declares a `maxItems` — it's `{ type: 'array', items: { type: 'string'
} }`, no upper bound on array length either.

**Observed vs expected:** combined with the fan-out finding above, a single fat-fingered
config.yaml value — `multiHop.maxSubQueries: 99` instead of `9`, or a copy-pasted `timeoutMs:
80000` meant to be `800` — sails straight through governance with zero warning, and (given a
compliant model) can turn into up to `N` sequential embed+FTS+vec round-trips per `search()`
call. Every other numeric knob in this codebase that has a governance function at all clamps
its numeric fields defensively (e.g. `dupJudge.batchSize` must be a positive integer,
`dupJudge.minConfidence` must be in `[0,1]`, config.ts:2502-2515) — `multiHop`/`queryRewrite`'s
governance functions only defend the ONE field (`supplementalWeight`) that already has a
narrower defensive clamp at `resolveDecomposeOpts` (decompose.ts:230-232) too. The four/three
other numeric fields have no floor, no ceiling, no integer check, and no NaN check anywhere in
the config pipeline.

**Repro:** static — read `applyMultiHopGovernance`/`applyQueryRewriteGovernance` in full
(config.ts:2519-2598) side by side with `applyDupJudgeGovernance`'s numeric checks a few dozen
lines above it in the same file; the asymmetry is direct code comparison, not inference.

---

## 🟡 `search.ts:997` — `supplementalFused.slice(0, opts.decompose.maxSupplemental)`: a
negative `maxSupplemental` (never rejected by governance) INVERTS the safety cap instead of
disabling it

**Break-case:** `maxSupplemental` is meant to be "cap on how many NEW ids the merge step may
add" (decompose.ts:185-187, "regardless of how many sub-queries ran"). It's plumbed straight
into `Array.prototype.slice(0, maxSupplemental)` with no `Math.max(0, ...)` guard. JS's
negative-index slice semantics mean a negative value does **not** mean "cap to fewer" — it
means "drop the last `|n|` elements," i.e. keep almost everything.

**Observed vs expected:** expected — a misconfigured/negative `maxSupplemental` degrades toward
"cap tighter" or at worst is a no-op. Observed — verified via direct semantics check:

```
maxSupplemental=-1 -> keeps 4 of 5 (all but the last)
maxSupplemental=0  -> keeps 0 of 5 (correctly empty)
maxSupplemental=-5 -> keeps 0 of 5 (coincidence: -5 == -length here)
```

So `maxSupplemental: -1` — the kind of typo that's one keystroke away from the intended `1` —
doesn't shrink the dilution bound, it nearly removes it: almost every supplemental candidate
the sub-queries found gets merged into the final ranked pool instead of at most 1. This is the
exact invariant the module's own "dilution bound" doc comment (decompose.ts:18-29) promises the
stage can never violate, defeated by a single off-by-sign config value that no governance
function catches.

**Repro:** reproduced the slice-semantics claim directly (`node -e`, not simulated) — did not
re-run through `search()` itself since the array-slice behavior is the entire mechanism and is
unconditional (no code path re-clamps `maxSupplemental` between config and this call site).

---

## 🟡 `decompose.ts::getSubQueries` / `withAbortableTimeout` — `timeoutMs ≤ 0` (or `NaN` from a
bad YAML parse) is a silent, permanent, provider-dependent no-op with no aggregate canary

**Break-case:** Node's `setTimeout(fn, ms)` clamps `ms ≤ 0` (and `NaN`) to effectively 0-1ms.
For `provider: 'llm'`, every real call is a network round-trip to Ollama/Azure — it can never
beat even a 1ms timer, so `getSubQueries` always takes the timeout branch, forever, the instant
this misconfiguration exists. For `provider: 'mock'` this does NOT reproduce: `MockQueryDecomposer.decompose`
resolves synchronously (no `await` inside it reaches real I/O), and a synchronously-resolving
promise's `.then()` callback runs as a microtask, which always drains before the timer's
macrotask fires — so the mock provider is accidentally immune to this exact misconfiguration
while the real provider is not. Neither `resolveDecomposeOpts` nor
`applyMultiHopGovernance` validates `timeoutMs` at all (see the governance finding above), so
this reaches production unchecked.

**Observed vs expected:** `getSubQueries`'s catch block DOES log
(`log.warn({outcome:'timeout',...})`, decompose.ts:284-289) — so this is not fully silent in the
ADR-015 sense of "success and failure look identical." But there is no aggregate canary the way
`src/doctor/checks/extraction-yield.ts` tracks a rolling zero-yield rate for the structurally
identical "built, wired, quietly never fires" failure class CLAUDE.md already documents for
extraction. An operator who sets `multiHop.enabled: true` and a bad `timeoutMs` sees a
config that claims decomposition is on, gets zero decomposition value ever, and the only
tell is a per-call debug-level-adjacent warn log line — this generalizes the already-known
LEDGER note ("codex latency >800ms blows the budget") from "a slow provider can exceed the
budget" to "any non-positive/NaN timeoutMs value, from any cause, produces the identical
undetectable-except-by-log-tailing degradation," and it's asymmetric by provider in a way
nothing in the code or docs calls out.

**Repro:** static (Node `setTimeout` clamp semantics are spec/doc-verified, not
empirically re-derived) + confirmed by reading `withAbortableTimeout`'s microtask-vs-macrotask
race directly (util/abortable-timeout.ts:34-45) and cross-checking `MockQueryDecomposer.decompose`
has no `await` before its `return` (decompose.ts:77-84).

---

## 🟡 `decompose.ts::getSubQueries` doc/code mismatch — the "fewer than 2 usable sub-queries
means nothing to add" contract is documented but not enforced

**Break-case:** the module doc comment (decompose.ts:31-40) and `getSubQueries`'s own doc
comment (decompose.ts:250-256) both say "fewer than 2 usable sub-queries" degrades to
single-pass. The actual implementation (decompose.ts:258-291) has no such floor — it returns
`cleaned` at whatever length survives dedup/cleanup, including exactly 1.

**Observed vs expected:** a decomposer/LLM that produces exactly one clean, non-echoing
sub-query is NOT treated as "nothing to add" — it passes straight through and triggers one
extra `gatherCandidates()` call in `search.ts` (line 877's loop has no `subQueries.length < 2`
guard either). Not independently harmful (one extra gather call, correctly damped/capped
downstream), but it means the documented safety invariant a future maintainer would read and
trust — "single-hop-shaped output never reaches the merge step" — is not actually true, and
nothing in the test suite (`tests/search/decompose.test.ts`) exercises the exactly-1-sub-query
case to catch the drift.

**Repro:** static — direct comparison of the doc comment prose against the implementation; no
length check exists to find.

---

## Confirmed-by-design, not a new bug (LEDGER-documented pool-tax mechanism)

`search.ts:992-1004` (`rankedFused = [...fused, ...capped].sort((a,b) => b.score - a.score)`):
supplemental (decompose) hits ARE merged into the same array that determines the final top-K
cutoff, even though they're normalized in a separate `fuseHits()` call and damped by
`supplementalWeight`. Damping bounds a supplemental hit's score relative to an EQUALLY-STRONG
primary hit (it can never outscore one) — it does **not** prevent a supplemental hit from
displacing a WEAKER primary hit from the final `limit`-sized result set. This is exactly the
mechanism behind the already-recorded LEDGER finding that decompose helps multi-hop while
taxing single-hop/open-domain/adversarial categories (net wash) — confirmed here by reading the
merge line directly, not a new finding, just the concrete code citation for an effect already
measured empirically elsewhere in this repo.

## Negative results (verified, no bug found)

- `MockQueryDecomposer.decompose` regex split (`\b(?:who|which|whom|that|and)\b`,
  decompose.ts:78-84): no-delimiter input → `[]`; all-delimiter input (e.g. `"who which that
  and"`) → every split segment trims to empty → `[]`; very long input → no crash, just more
  regex work. Unicode: `\b` uses ASCII `\w` only regardless of flags, so word boundaries around
  non-ASCII letters can land in unintuitive places — but this only ever produces a worse (or
  identical) split, never a crash or an unbounded result.
- Malformed LLM decompose output (non-JSON, JSON scalar, echo of the original query, 0-length
  array): all correctly degrade to `[]` per `extractSubQueries` (decompose.ts:162-176) and the
  dedup/echo-drop logic in `getSubQueries` — matches the existing test coverage in
  `tests/search/decompose.test.ts`.
- Timeout **cancellation** (not just the timeout race) is real, not advisory: traced
  `withAbortableTimeout` → `LlmQueryDecomposer`/`LlmQueryRewriter` → `provider.chat({signal})` →
  `OllamaLLMProvider.chat`'s `combineSignals`/`AbortSignal.any` → the actual `fetch()` call
  (`src/providers/llm/ollama.ts:92-104,227-236`). A signal that's already aborted makes a
  subsequent `fetch()` reject synchronously without opening a connection, so
  `fetchWithRetry`'s catch-and-retry-once (line ~121) does NOT cause a second real network
  dispatch on timeout — confirmed by reading the retry loop against WHATWG fetch's documented
  "already-aborted signal" behavior.
- `expand` (query-rewrite's per-call opt-in gate) defaults to `false` in both the HTTP route
  (`src/server/routes/search.ts:340`) and the MCP server (`src/mcp/server.ts:245,360`) — the
  "config alone never triggers this on the hot path" design claim in `query-rewrite.ts`'s doc
  comment actually holds; nothing flips it on by default.
