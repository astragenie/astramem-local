# Review: SLICE-433 (FEAT-479) — rev2, num_ctx fix

**Date:** 2026-07-13
**Reviewer:** review-433 (re-review pass)
**Scope:** `src/providers/llm/ollama.ts`, `tests/providers/ollama-llm.test.ts`, `src/distill/prompts/extract.ts` (doc-comment only), `src/distill/stages/05-extract.ts` (maxTokens 1500→2500)
**Verdict: PASS**

## Prior HIGH — confirmed closed

The prior review-433 pass found: Ollama provider never set `num_ctx`, so every call ran at Ollama's per-model
default (observed 4096 for qwen2.5:7b). The new ~15.3k-char / ~3.8k-token v3 extraction prompt overflowed that
silently (Ollama truncates/shifts context on overflow rather than erroring), collapsing extraction recall.

Fix verified in `src/providers/llm/ollama.ts:127-152`:

- `num_ctx` is now **always** computed and sent (not conditionally spread — it's a plain key on the `options`
  object built at `ollama.ts:150`, no `opts?.x !== undefined` guard around it).
- Sizing formula: `numCtx = min(NUM_CTX_CAP, max(NUM_CTX_FLOOR, ceil(estimatedInputTokens + outputBudgetTokens + NUM_CTX_SLACK_TOKENS)))`
  with `NUM_CTX_FLOOR=4096`, `NUM_CTX_CAP=16384`, `NUM_CTX_SLACK_TOKENS=512`.
- `estimatedInputTokens = messages.reduce((sum,m) => sum + m.content.length, 0) / CHARS_PER_TOKEN` (`CHARS_PER_TOKEN=4`)
  — sums **all** messages' `content.length`, including the system message, before dividing. Confirmed correct: the
  reduce has no role filter, so a system+user pair both count toward the estimate. This matches the "real
  extraction-shaped call" test, which sums `systemContent.length + userContent.length` on the assertion side too.
- `outputBudgetTokens = opts?.maxTokens ?? DEFAULT_OUTPUT_BUDGET_TOKENS` (512) — correct fallback when a caller
  passes no `maxTokens` (e.g. a tiny health-style call).

Edge cases checked by hand against the formula:
- **maxTokens undefined, tiny prompt** ("hi", ~0.5 tokens): `max(4096, ceil(0.5+512+512)) = max(4096, 1025) = 4096`
  → floors correctly. Matches test 1 and test 4.
- **Huge input hitting the cap** (200,000 chars ≈ 50,000 tokens, maxTokens=4000): raw sum ≈ 54,512 ≫ 16384 →
  clamped to 16384. Matches test 3.
- **Real-shaped call** (15,300 + 3,200 chars ≈ 4,625 tokens, maxTokens=2500): `ceil(4625+2500+512) = 7637`,
  which is `≥ estimatedInputTokens+maxTokens` (7125) and `≤ 16384` — matches test 2's assertion bounds.

`CHARS_PER_TOKEN=4` is intentionally duplicated rather than imported from `src/distill/stages/03-chunk.ts:12` —
documented rationale (provider layer shouldn't import from the distill layer for a one-line heuristic constant) is
sound and matches the project's existing layering discipline.

## Temperature-clobber claim — confirmed real, fix confirmed correct

Read `git show HEAD:src/providers/llm/ollama.ts` (pre-fix): the request body was built with two independent
conditional spreads:

```js
...(opts?.temperature !== undefined ? { options: { temperature: opts.temperature } } : {}),
...(opts?.maxTokens !== undefined ? { options: { num_predict: opts.maxTokens } } : {}),
```

Object spread only merges at the top level of the *outer* object being built — `options` itself is not
deep-merged across the two spreads, so when both conditions are true (every real production call: `05-extract.ts`,
`04-compact.ts` via temperature, `extract-entities.ts` — all pass both `temperature` and `maxTokens`), the second
spread's `{ options: { num_predict } }` **replaces** the first spread's `options` key wholesale. `temperature` was
silently dropped on every one of those calls. Claim confirmed real, not overstated.

Fix (`ollama.ts:150-152`) builds one `options` object by direct assignment instead of spread-merging two
independent partial objects:

```ts
const options: Record<string, number> = { num_ctx: numCtx };
if (opts?.temperature !== undefined) options.temperature = opts.temperature;
if (opts?.maxTokens !== undefined) options.num_predict = opts.maxTokens;
```

This is correct — no key can clobber another since each is a distinct assignment to the same object, and
`options` is always present in `body` (`ollama.ts:160`, unconditional key, no wrapping spread).

## Test run (real output)

`bunx vitest run tests/providers/ollama-llm.test.ts`:
```
Test Files  1 passed (1)
     Tests  18 passed | 1 skipped (19)
```
The 1 skip is `describe.skipIf(!process.env.INTEGRATION_LIVE)('live integration', ...)` — pre-existing, unrelated
to this change (no `INTEGRATION_LIVE` env var set in this shell).

`bunx tsc --noEmit -p .`: clean, zero output, exit clean — no type errors introduced.

The 5 new tests under `describe('num_ctx sizing', ...)` (`tests/providers/ollama-llm.test.ts:365-419`) were read in
full and each asserts what it claims:
1. floors at 4096 for a tiny prompt with no `maxTokens` — asserts `options.num_ctx === 4096`.
2. sizes to cover input+output+slack for a realistic extraction-shaped call — asserts `num_ctx >= est+maxTokens`
   and `<= 16384`.
3. caps at 16384 for a 200k-char synthetic input — asserts `num_ctx === 16384`.
4. always sends `num_ctx` even with neither `temperature` nor `maxTokens` set — asserts `num_ctx` is defined.
5. **merge-fix test** — asserts `options.temperature === 0.1` **and** `options.num_predict === 2500` **and**
   `options.num_ctx` defined, all from the same captured request body, i.e. all three keys present simultaneously
   in one call. This is exactly the regression the temperature-clobber bug would have broken (previously the
   `num_predict` spread would have deleted `temperature` entirely). Correctly targeted.

## Scoped diff sanity

- `src/distill/stages/05-extract.ts`: `maxTokens: 1500 → 2500`, comment accurately describes why (v3's richer
  300-800 char lesson/decision atoms need more output headroom; cost is driven by `usage.usd` not this ceiling, so
  raising it doesn't change budget estimates — true, `BudgetTracker` reads `usageUsd` from the provider response,
  not from `maxTokens`).
- `src/distill/prompts/extract.ts`: only the `resolveExtractionPrompt` doc-comment changed in this pass (numbering
  updated 1-3 → 1-4 to describe the `v1` rollback lever), consistent with the actual function body
  (`envOverride === 'v1'` branch, `extract.ts:55`) which was already in place from the earlier pass. Doc accurately
  describes the precedence chain as implemented.
- No dead code, no naming inconsistencies, no stray console/debug output in the reviewed diff.
- Live Ollama smoke was not re-run per instruction (VRAM-constrained box, builder already verified fx43 smoke
  produced both a decision and a lesson atom post-fix).

## Conclusion

Both the original HIGH (missing `num_ctx`) and the newly-found temperature-clobber bug are real fixes, correctly
implemented, and covered by passing tests. No new issues found in the scoped diff. **PASS.**
