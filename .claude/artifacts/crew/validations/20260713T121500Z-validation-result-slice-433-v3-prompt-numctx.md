---
type: validation
created: 2026-07-13T12:15:00Z
slice: SLICE-433
feature: FEAT-479
result: PASS
validator: lead (evidence from builder live smoke + reviewer rev2 verification runs)
---

# Validation — SLICE-433: v3 rich engineering prompt + dynamic num_ctx

## Behavior evidence

- **Live fx43 smoke against real Ollama (qwen2.5-coder:7b, temp 0.1, maxTokens 2500)**:
  with the num_ctx fix live, v3 extraction produced BOTH gold atoms — a `decision`
  (single-flight lock + shard-file check, 300-800ch rich shape with rationale +
  consequence) and a `lesson` (stale cache-dir false-warm root cause + resolution).
  Recall restored from the earlier 3→1 collapse. Confirms review-433's HIGH diagnosis:
  context truncation (v3 ~15.3k chars ≈ 3.8k tokens > Ollama default num_ctx 4096),
  not prompt phrasing.
- **num_ctx sizing verified by hand** (reviewer rev2): clamp(ceil(input/4 +
  outputBudget + 512), 4096, 16384); realistic extraction call lands at 7637;
  always sent unconditionally.
- **Temperature-clobber regression fix verified against git HEAD**: old double
  `options` spread dropped `temperature` on every production call passing both
  temperature and maxTokens (05-extract, 04-compact, extract-entities). Merged
  options object closes it; merge-fix test asserts temperature=0.1 AND
  num_predict=2500 AND num_ctx in the SAME captured request body.
- Suites: tests/providers/ollama-llm.test.ts 18 pass / 1 skipped (pre-existing
  live-integration skipIf). Touched suites (providers + distill + pipeline
  handlers): 21 files / 325 tests pass. `bunx tsc --noEmit -p .` clean.
- Full-suite run (builder): 2957/2966 pass; 3 failing files are pre-existing
  e2e/process-spawn tests (proxy-capture-purge-live, longmemeval resume, detach)
  under ~95% GPU VRAM contention on this shared box — none reference extract.ts
  or ollama.ts; re-runs in isolation pass.

## Operational note (follow-up, not blocking)

Dynamic num_ctx means Ollama reloads the model whenever the computed value differs
from what is resident; on a VRAM-saturated box that reload can fail loudly
(ECONNRESET + eviction) instead of silently truncating. Loud beats silent, and
fetchWithRetry retries once — but bucketed num_ctx (4096/8192/16384) would avoid
same-bucket reloads. Filed as follow-up candidate for FEAT-479 SLICE-436.

## Reviews

- review-433 (first pass): NEEDS_FIX — 1 HIGH (num_ctx truncation).
  Artifact: .claude/artifacts/crew/reviews/20260713T130000Z-review-slice433-engineering-rich-prompt.md
- review-433-rev2: PASS — HIGH confirmed closed; temperature-clobber fix confirmed
  real and correct.
  Artifact: .claude/artifacts/crew/reviews/20260713T120500Z-review-slice433-rev2-numctx.md
