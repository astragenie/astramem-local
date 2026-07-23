# Review Result — Track I: winsorized fusion normalization (score-phase)

- **Branch**: `track/i` (commit `ec2e1071`), base `feat/retrieval-overhaul` (`b2b9f008`)
- **Worktree**: `C:/work/mega/astra-wt/track-i`
- **Reviewer**: independent review (read-only)
- **Verdict**: **PASS**

## Scope of change

- `src/search/fuse.ts` — `normalizeScores(scores, mode = 'minmax')` gains a `'winsorized'` mode: clips each value to its own array's [p5, p95] before min-max. `fuseHits`'s `weights` param gains optional `normalization?: NormalizationMode`, threaded into both `normalizeScores` calls (bm25, cosine).
- `src/config/config.ts` — new `Config['search'].normalization: 'minmax' | 'winsorized'` field (default `'minmax'`), new `applyNormalizationGovernance` (closed-enum fallback), composed into `loadConfig`.
- `src/config/loader.ts` — same governance composed into `loadConfigFromDisk` (the real boot path).
- `src/config/writer.ts` — `configToYaml` emits `normalization` as a sibling scalar to `theta`.
- Tests: `tests/search/fuse.test.ts`, `tests/config/config.test.ts`, `tests/config/defaults-vs-docs.test.ts`, `tests/config/writer.test.ts`.

No other search-dir files touched (`search.ts`/`decompose.ts` untouched, confirmed via `git diff --stat`). Working tree otherwise clean.

## Verification performed (not just read — executed)

1. `bunx tsc --noEmit` → clean, no errors.
2. `npx vitest run tests/search/fuse.test.ts tests/config/config.test.ts tests/config/defaults-vs-docs.test.ts tests/config/writer.test.ts` → **203/203 passed**.
3. `npx vitest run tests/eval/retrieval-eval.test.ts` (ADR-005 harness) → **16/16 passed** — recall@10/NDCG@10 floors hold. Confirms author's claim.
4. Hand-derived the pool-tax repro's arithmetic independently (not just read the assertions) — see below.

## Finding-by-finding

**1. Backward compat (byte-identical default path) — VERIFIED.**
`normalizeScores`: when `mode !== 'winsorized'`, `source = scores` (same reference), and the final line changed from `scores.map(...)` to `source.map(...)` — for the default path these are identical since `source === scores`. The `range === 0` early-return still uses `scores.map(() => 1)` regardless of mode, which is also unaffected. `fuseHits` calls both `normalizeScores` sites with `weights.normalization` (`undefined` for any caller not yet passing it), which correctly falls through to the `mode = 'minmax'` default parameter (JS default params trigger on `undefined`). Explicit test (`fuse.test.ts` "explicit 'minmax' is byte-identical to omitting mode") and an end-to-end `fuseHits` test ("omitting normalization entirely ... behaves exactly like explicit 'minmax'") both pin this. The 16/16 eval-harness pass corroborates no regression on the real ranking floors.

**2. Pool-tax repro test is real — VERIFIED BY INDEPENDENT CALCULATION.**
I hand-computed the `fuseHits` pool-tax test's numbers rather than trusting the assertions:
- Reference (40 fillers 1..40, + a=20/importance 0.3, b=22/importance 0.15, weights α=0.4,γ=0.1): raw(a)=0.22487, raw(b)=0.23038 → b>a. Matches "b outranks a" assertion.
- Same set **+ outlier bm25=2000**, plain minmax: min=1,max=2000,range=1999 → norm(20)=0.009505, norm(22)=0.010505 → raw(a)=0.033802, raw(b)=0.019202 → **a>b**, a genuine inversion driven by the bm25 gap between a/b collapsing to near-nothing while the importance term (0.03 vs 0.015) dominates. Matches the "INVERTING their order" assertion.
- Same set, `'winsorized'`: sorted 43-value array (note fillers already contain 20 and 22 as duplicates of a/b, plus the new outlier) → p5 idx=2.1 → interpolates to 3.1; p95 idx=39.9 → interpolates to 38.9. Clipping to [3.1, 38.9]: norm(20)=0.4721, norm(22)=0.5279 → raw(a)=0.21883, raw(b)=0.22617 → **b>a again**, restoring the reference order. Matches the "restores a meaningful gap" / "b outranks a again" assertions.

This is a real, mechanism-accurate repro of the claimed bug (one unbounded outlier compressing an unrelated pair's normalized gap, letting a different fusion component decide instead) and a real fix — not a rigged/tautological test. The standalone `normalizeScores` winsorized-mode tests use the identical 43-value construction and I verified their gap thresholds (`<0.01` for minmax, `>0.03` for winsorized) against the same arithmetic above (minmax gap ≈0.001, winsorized gap ≈0.056 — both comfortably inside the asserted thresholds, not borderline).

**3. Winsorize math — VERIFIED.**
`percentileOfSorted` uses linear interpolation between `floor(idx)`/`ceil(idx)` on a pre-sorted ascending array (`idx = p*(n-1)`), matching numpy's default `linear` interpolation convention. `n===1` short-circuits to the single value. Index bounds are always in `[0, n-1]` since `p ∈ [0,1]` — no out-of-range access, no div-by-zero. Small arrays (n=2,3) degrade as documented: p5/p95 interpolate very close to the array's own min/max (e.g. n=2, p=0.05 → 5% of the way from min to max), so clipping is close to a no-op — matches the doc comment's own caveat, confirmed by direct calculation, not just trusting the comment. `winsorize` is a pure `Array.sort` + `map`, deterministic, no shared mutable state. `deterministic` claim holds (no `Math.random`, no `Date.now`, sort comparator is total order over numbers).

**4. Scope expansions — VERIFIED, both correct.**
- `loader.ts`: `applyNormalizationGovernance` composed into the real `loadConfigFromDisk` boot path, same position/pattern as the existing `applyQueryRewriteGovernance`/`applyFusionGovernance` chain, mirrored in `config.ts`'s `loadConfig`. Both real paths covered.
- `writer.ts`: `configToYaml` now emits `line(1, 'normalization', cfg.search.normalization)` as a sibling of `alpha..theta`. Confirmed the `writer.test.ts` fixture (`buildFullyPopulatedConfig`) sets `normalization: 'winsorized'` — a **non-default** value — so the AC-1 exhaustive round-trip guard genuinely exercises the emitter writing back a hand-set override, not just the default falling through by coincidence. Ran the suite; passes.

**5. Governance loud-fail — VERIFIED.**
`applyNormalizationGovernance` uses a closed `Set` (`VALID_NORMALIZATION_MODES`), falls back to `'minmax'` on any value not in the set, and logs via the same `opts.log ?? console.warn` pattern as every other governance function in the file. Tested: valid default is a no-op (`toEqual(search)`), valid `'winsorized'` override passes through untouched, invalid value (`'winsorised'` typo) falls back to `'minmax'` and the log message includes both the offending key and the bad value. Also tested end-to-end through `loadConfig` (both the invalid-value fallback and the valid-override honor path).

**6. defaults-vs-docs — VERIFIED.**
New row added for `search.normalization`, `documentedDefault: 'minmax'` matches `cfg.search.normalization` from `defaultConfig()`. Consistent with the FEAT-461 doc-drift guard's existing rows.

**7. tsc / scope discipline — VERIFIED.**
`bunx tsc --noEmit` clean. `git diff --stat` confirms `fuse.ts` is the only file touched under `src/search/`; `search.ts`/`decompose.ts` untouched. Traced the real-caller wiring one level further than requested: `src/search/presets.ts`'s `resolvePresetWeights` returns `applyFusionGovernance({ ...base, ... })` (object spread), so the new `normalization` field flows through to both real HTTP/MCP call sites (`src/server/routes/search.ts`, `src/mcp/server.ts`) automatically — no additional plumbing needed, consistent with the η/θ precedent this change explicitly mirrors. `SearchOpts['weights']`'s TS type doesn't declare `normalization` explicitly, but since it's optional on `fuseHits`'s param type, the wider runtime object (`Config['search']`) is still structurally assignable and carries the real value through at runtime — confirmed this isn't just type-checking coincidentally by tracing the actual object flow, not just trusting `tsc --noEmit`.

## Minor / non-blocking observations (no action required)

- The `fuseHits` end-to-end monotonicity test in `fuse.test.ts` only checks adjacent pairs in the constructed array where the raw value strictly increases — it's a real check (and I verified it holds under the actual clipped values) but a stricter version would check all `i<j` pairs rather than just adjacent ones. Given the standalone `normalizeScores` percentile math is independently verified above, this is a coverage nicety, not a correctness gap.
- `Config['search'].normalization` doc comment is long (mirrors the file's existing style for γ/θ/etc.) — consistent with house style, not a defect.

## Conclusion

Backward-compat is structurally guaranteed (not just tested), the pool-tax repro is a genuine, arithmetically-verified reproduction and fix (not tautological), the winsorize math is correct and degrades safely on small inputs, both scope expansions (loader.ts, writer.ts) are correct and necessary, governance follows the established closed-enum loud-fail pattern, and the ADR-005 eval floor holds at 16/16. **PASS.**
