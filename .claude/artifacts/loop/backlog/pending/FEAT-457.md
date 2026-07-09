---
id: FEAT-457
status: pending
priority: null
category: feature
target_release: null
created: 2026-07-09
updated: 2026-07-09
depends_on: []
slices: []
derived_from: docs/research/2026-07-09-packaging-audit.md
cross_product: [astramem-local]
---
## Description

**Add a LoCoMo benchmark harness** alongside the existing LongMemEval harness, and
publish one honest external number for the OSS launch.

**Why:** The packaging audit (docs/research/2026-07-09-packaging-audit.md) named
"publish one honest external eval number (LongMemEval/LoCoMo)" as the single item
that must happen before an announcement and the biggest lever on the competitive
score. Competitors quote LoCoMo (Zep/Graphiti cite 63.8% — not repo-reproducible per
the gap analysis; mem0 quotes LoCoMo in its paper). A first-party, reproducible
LoCoMo number — run by our own harness, wired to the same isolated-daemon path as
LongMemEval — is a credibility asset no competitor currently ships transparently.

**LoCoMo** = Long Conversational Memory benchmark: multi-session dialogues with QA
across categories (single-hop, multi-hop, temporal reasoning, open-domain,
adversarial/unanswerable). Distinct from LongMemEval's haystack format — needs its
own loader + per-category scoring.

### Scope — LOCAL-ONLY (astramem-local, eval infra)
Mirror the proven `scripts/eval/longmemeval/` structure into `scripts/eval/locomo/`,
reusing the shared lib where possible:
- **Dataset loader** for the LoCoMo JSON schema (multi-session conversations +
  categorized QA) → `.eval-data/locomo/`.
- **Ingest adapter**: reuse `lib/spawn-daemon.ts` (isolated throwaway daemon,
  qwen2.5-coder:7b extraction — NOT qwen3:8b), ingest each conversation's sessions,
  distill-wait.
- **Answer + judge**: reuse the Azure judge path (`lib/config.ts` resolveAzureConfig);
  score per LoCoMo category + overall accuracy; handle unanswerable/abstention.
- **Run manifest + hypotheses.jsonl** in the same layout as longmemeval; a
  `--dry-run-throughput` mode for no-Azure pipeline checks.
- **Reproducibility doc** in docs/eval/ so the published number is auditable
  (dataset version, seed, model, k, date) — this is the whole point.

### Contract / cloud impact
None — eval infrastructure only, no product code path, no wire change.

### Approximate ETA (1 dev)
- Loader + schema + ingest adapter (reuse longmemeval lib): **~1.5–2d**
- Answer/judge + per-category scoring: **~1.5–2d**
- Repro doc + one published run + README badge/number: **~1d**
- **Total ≈ 3–5 days, local only.** Scored runs need the Azure judge key
  (`AZURE_OPENAI_API_KEY`), same as longmemeval; throughput/pipeline check runs
  without it.

## Intake notes
From the 2026-07-09 packaging audit (do-first #3 / product-8→9). Gates the OSS
announcement. Unscored; run `/runner:triage`.
