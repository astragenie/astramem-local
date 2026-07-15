# Review — stabilization plan (architect-reviewer) — 2026-07-15T16:40Z

**Target:** `.claude/artifacts/crew/handoffs/20260715T1630Z-stabilization-analysis-and-plan-crash-loop-event-loop-stalls.md`
**Verdict: approve_with_notes** (1 BLOCKER, 2 HIGH, 2 MEDIUM, LOW confirmations)

## [BLOCKER] P0.1's stated effect is false as written
Prod `%APPDATA%\Astramem\config.yaml` has `embedding: provider: ollama` **explicitly set**. `loadConfigFromDisk`'s deep-merge preserves explicit on-disk values — the ONNX default flip only applies when the key is omitted. Merging + reinstalling moves ZERO embed calls off Ollama on this box. Required added step: stop daemon → set `embedding.provider: onnx` in config.yaml → verify via doctor's onnx-embed check → start. ADR-019's hard-gate for the flip IS satisfied — Decision-2(d) worker offload is in the branch (`ab38d7c`); `onnx-worker-host.ts` crash handling verified good (fails in-flight requests immediately, lazy respawn, no unbounded restart loop).

## [HIGH] P0.3 reinstall risks reproducing the restart storm
Boot re-enqueues consolidate + orphans against 36k atoms before any P1 protection exists. `ASTRA_SKIP_CONSOLIDATE=1` must be MANDATORY for the P0.3 cutover (boot with consolidate off, confirm /health p99 + zero watchdog kills 30 min, then re-enable), not an interim fallback.

## [HIGH] ADR number collision
`session/beta-stabilization-waves` adds `docs/adr/ADR-019-windows-supervisor-process.md`; main already has `ADR-019-worker-isolation-recall-hang.md`. Renumber supervisor doc to ADR-020 during the P0.2 merge (same failure class as the migration-number collisions).

## [MEDIUM] Merge conflict surface = 4 files
- `config.ts`, `providers/index.ts`: disjoint regions, should merge clean.
- `serve.ts`: both branches edit the shutdown-sequence neighborhood — verify by hand, no silent `--no-edit` merge.
- `docs/adr/ADR-018-onnx-embedding-provider.md`: exists on BOTH branches, different content (416 vs 226 lines) — WILL hard-conflict. Resolve explicitly toward the ONNX branch's canonical version; diff stabilization's copy for anything worth folding in. Never `--ours`/`--theirs` (PR #229 class).

## [MEDIUM] consolidate group-skip is a silent coverage gap
`src/consolidate/consolidate.ts:551-558`: any (repo,type) group > maxGroupSize (500) is skipped ENTIRELY — zero proposals, forever. `summary.groupsSkipped` populated but read nowhere (no doctor/health/log surface). Pair-budget fix must REPLACE the binary skip with top-K-within-group sampling + surface groupsSkipped in doctor/health. Distinct bug from the O(n²) latency issue.

## [LOW] Confirmations
- LLM rate limiter effectively live already: prod config has `llm.rateLimit.callsPerMinute: 20` — plan must state the config KEY is required for fresh boxes, not just the code merge.
- `contradictionDetection.mode: 'off'` confirmed live — judge adds no load today. Do not "correct" it.
- Dual-pass extraction is async/awaited — call-volume amplifier only, not a #347-class hang source.
- ONNX worker crash handling well-built — not a missing failure mode.
- P1.3 addendum: verify worker-liveness `lastTickAt` staleness threshold tolerates legitimate multi-second `TokenBucket.acquire()` waits so busy-but-healthy isn't misread as stalled.
