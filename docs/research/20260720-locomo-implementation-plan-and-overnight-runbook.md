# LoCoMo implementation plan + overnight runbook

Companion to `20260720-locomo-improvement-v2-post-crossreview.md` (the re-scoped
plan). This is the concrete, ordered, cost-annotated execution — what to run,
what needs code first, and what's running tonight.

## Cost model (READ before running anything)
- **Distill (extraction) = metered codex-subscription** (personal ChatGPT quota). One conv-1 (`--n 1`) ≈ one conversation's sessions distilled ≈ bounded but real.
- **Answer + judge = Azure gpt-5-mini** (cheap, separate).
- **`--resume` re-answers WITHOUT re-distilling** → answer-stage A/Bs (answerer effort, k) are cheap. Retrieval/server-config A/Bs (multiHop) need a fresh daemon on the store, not a bare re-answer.
- **Every run uses an isolated sandbox daemon** (`makeIsolatedEvalEnv`, ephemeral port + datadir). NEVER touches prod `:7777`.
- **Scope discipline:** conv-1 (n=199) for iteration; full-suite (n=1986) only at the Phase-3 gate. Same-day controls mandatory (codex ±6pt/day).

## Overnight (2026-07-20, unattended)
| # | Experiment | Status | Cost | Needs |
|---|---|---|---|---|
| 0 | **Baseline conv-1** (`--n 1 --seed 42 --k 15 --extract-profile conversational`) | **RUNNING** (bg `bvmv8kbci`) | 1 distill | — |
| 1 | **Precision-term analysis** on baseline `hypotheses.jsonl` | queued (after #0) | **FREE** (no LLM) | #0's hypotheses.jsonl |
| 2 | **multiHop A/B** | **BLOCKED on code** | 1 distill or resume | harness `multiHop` override (below) |
| 3 | **Answerer effort A/B** (minimal→low + budget) | queued | resume (cheap) | `answer.mts` edit (below) |

On #0 completion: archive via `archive-run.mts`, run #1, then decide #2/#3. Leave a morning summary at `docs/eval-runs/20260720-overnight-summary.md`.

## Code changes needed (do these before the blocked experiments)

### C1 — harness `multiHop` override (unblocks experiment #2)
`makeIsolatedEvalEnv` (`scripts/eval/shared/spawn-daemon.ts`) already takes
`crossEncoder`, `extractProfile`, etc. overrides and writes them into the isolated
daemon's `config.yaml`. Add a `multiHop` field the SAME way (mirror the
`crossEncoder` override exactly — README §347 documents that pattern), and a
`--multihop` flag in `run.mts` that sets it. This flips `search.multiHop.enabled`
(config.ts, OFF by default) for the sandbox only. Small, additive, review-gated —
do NOT hand-run the A/B until this lands + a reviewer confirms the override
actually reaches the daemon's config (verify via the daemon's `/config` or a
decompose log line, else the "A/B" silently re-runs baseline).

### C2 — answerer effort A/B knobs (unblocks experiment #3)
`scripts/eval/locomo/answer.mts`: `reasoningEffort: 'minimal'` (line ~204) and
`ANSWER_MAX_COMPLETION_TOKENS = 150` (line ~36). Make both env-overridable
(`ASTRA_LOCOMO_ANSWER_EFFORT`, `ASTRA_LOCOMO_ANSWER_MAX_TOKENS`) so an A/B doesn't
need a code edit per variant. **Critical:** raising effort WITHOUT raising the
token budget truncates answers to empty (the 150 budget is shared between hidden
reasoning and the visible answer) — FEAT-450 precedent. A/B `low` + `~400` tokens
vs the `minimal`/`150` control, same store via `--resume`.

## The phased plan (from v2, for reference)
- **Phase 0** — free/cheap: precision analysis (#1), multiHop A/B (#2), answerer effort A/B (#3).
- **Phase 1** — oracle factorial: answer from gold-source / gold-atom / retrieved-atom / retrieved-source × current/canonical answerer. Measures the true per-stage ceiling. Settles single-hop honestly (extraction vs retrieval vs sufficiency vs answer vs scoring).
- **Phase 2** — attack the binding constraint (prior: extraction completeness — repair-only atom triage, measured recall 78→80.1 / typeAcc +9, currently disabled).
- **Phase 3** — full-suite n=1986, ≥3-run, conversation-level baseline + variance-lock. Only here is a 0.62/0.70 number claimable.

## Guardrails (do not skip)
- Freeze the metric; report `--llm-judge` alongside F1 always.
- Extend `archive-run.mts` to persist per-question scores (enables post-hoc CIs; perf-eng finding).
- No rejected mechanisms (entity-graph, FTS-as-ceiling-raise, chunk/temp/maxTokens/sweeper-v1).
- Every run → `docs/eval-runs/` LEDGER row; run dirs now tracked in git (dataset excluded).

## Success = stable full-suite 0.62, not lucky-day 0.70.
