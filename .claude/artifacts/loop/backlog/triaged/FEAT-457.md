---
id: FEAT-457
status: triaged
priority: P2
category: feature
target_release: null
created: 2026-07-09
updated: 2026-07-10
depends_on: []
slices: []
derived_from: docs/research/2026-07-09-packaging-audit.md
cross_product: [astramem-local]
pm_customer_impact: 0.4
pm_effort_estimate: 0.45
pm_strategic_alignment: 0.55
pm_technical_risk: 0.35
pm_dependency_depth: 0.15
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-07-10
autonomous_safe: false
triage_notes: "P2 via formula (default branch): impact 0.40 < 0.70 so the (impact>=0.7 AND alignment>=0.6) P1 branch does not fire; alignment 0.55 < 0.80 so the (alignment>=0.8 AND effort<=0.4) P1 branch does not fire; effort 0.45 < 0.70 so P3 (effort>=0.7 AND impact<=0.3) does not fire. composite_score = 0.40*0.35 + 0.55*0.30 + (1-0.45)*0.20 + (1-0.35)*0.10 + (1-0.15)*0.05 = 0.5225. autonomousSafe=false: all three mechanical thresholds individually pass (risk 0.35, effort 0.45, dependency 0.15 all <=0.6) but no AC/spec exists on the body and P2-with-no-flag means inline AC drafting is not triggered -- forced false by the missing-AC branch, not a risk-threshold override. Moderate-priority eval-infra item, exactly as the coordinator framed it: the FEAT's own sequencing section is the load-bearing reason this isn't scored higher despite genuine external-credibility value."
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
Mirror the proven `scripts/eval/longmemeval/` structure into `scripts/eval/locomo/`.
Reuse is split by kind, not uniform:
- **Extract-share the plumbing tier** (mechanical, unmodified) into
  `scripts/eval/lib/`: `spawn-daemon` (encodes the `sync.json` prod-pairing safety
  fix — do NOT fork this, share it), `daemon-client`, `concurrency`, `shard`,
  `config`, `azure-client`, `ollama-tuning`.
- **Copy-and-adapt** everything dataset-shaped, since LoCoMo's shape differs from
  LongMemEval's: types, date handling (LoCoMo's date format differs from
  LongMemEval's), the dataset loader (LoCoMo is 10 conversations total — load-all,
  not LongMemEval's stratified sample), the envelope, and the ingest/answer
  drivers.
- **Dataset loader** for the LoCoMo JSON schema (multi-session conversations +
  categorized QA) → `.eval-data/locomo/`.
- **Ingest adapter**, built on the shared `spawn-daemon.ts` (isolated throwaway
  daemon, qwen2.5-coder:7b extraction — NOT qwen3:8b). **Data-model inversion vs
  LongMemEval:** LoCoMo is conversation-centric (one conversation → many QA pairs),
  the opposite of LongMemEval's question-centric isolation model
  (`lib/envelope.ts:8-16`, one isolated daemon per question). LoCoMo's adapter must
  ingest once per conversation and fan out questions against that single ingest,
  not isolate per question.
- **Judge layer is new authorship, not reuse.** Expect the same
  fork-upstream-and-discover-incompatibilities work LongMemEval's judge took
  (`judge.mts:1-18`) — some LoCoMo categories score by F1/token-overlap rather than
  an LLM-judge boolean, which LongMemEval's judge does not do at all.
- **Answer + judge**: reuse the Azure judge path (`lib/config.ts`
  `resolveAzureConfig`) for the categories that use an LLM judge; score per LoCoMo
  category + overall accuracy; handle unanswerable/abstention.
- **Temporal category: RESOLVED, one verification step remains.** The
  `as_of`/temporal daemon gap documented at
  `scripts/eval/longmemeval/README.md:357-399` was FIXED in 0.9.0 (population-side:
  distill threads envelope `captured_at` → `valid_from`, `distill.ts:108-113`,
  terminal write `memories.ts:130`) — the README section is stale; the "verified
  live" test ran against a not-yet-reinstalled daemon 31s after the fix commit
  (2026-07-09 investigation). Before publishing a temporal score, re-verify
  end-to-end against a freshly-reinstalled ≥0.10.0 daemon; then temporal
  categories are fully valid to include.
- **Run manifest + hypotheses.jsonl** in the same layout as longmemeval; a
  `--dry-run-throughput` mode for no-Azure pipeline checks.
- **Reproducibility doc** in docs/eval/ so the published number is auditable. Must
  pin, in addition to dataset version/seed/model/k/date: the daemon package
  version + git SHA, the judge model's actual snapshot id (not a deployment
  alias), the full effective `config.yaml`, and the dataset's sha256.
- **Licensing:** LoCoMo is CC BY-NC 4.0. `.eval-data/` is gitignored so there is no
  redistribution risk, but attribution is still required in the reproducibility
  doc.

### Sequencing consideration
LongMemEval has NEVER produced a published number from this repo
(docs/eval/methodology.md:91-95). Running LongMemEval's existing non-temporal
~58% may be the faster path to the packaging audit's actual goal (one honest
published number) than building LoCoMo first. LoCoMo can follow afterward with
its conversation-centric design — this FEAT does not need to block on being
first.

### Contract / cloud impact
None — eval infrastructure only, no product code path, no wire change.

### Approximate ETA (1 dev)
- Extract-shared plumbing tier + loader + schema + ingest adapter (conversation-
  centric fan-out): **~1.5–2d**
- Judge layer (new authorship) + per-category scoring (LLM-judge + F1/token-overlap
  categories): **~2–2.5d**
- Repro doc (with the expanded pin list) + one published run + README badge/number:
  **~1d**
- **Total ≈ 4–5.5 days, local only.** Scored runs need the Azure judge key
  (`AZURE_OPENAI_API_KEY`), same as longmemeval; throughput/pipeline check runs
  without it.

## Intake notes
From the 2026-07-09 packaging audit (do-first #3 / product-8→9). Gates the OSS
announcement. Unscored; run `/runner:triage`.

## Architecture review corrections (2026-07-09)

1. **Lib reuse is split, not uniform.** Extract-share the plumbing tier
   (spawn-daemon — which encodes the sync.json prod-pairing safety fix, do not
   fork it — daemon-client, concurrency, shard, config, azure-client,
   ollama-tuning) into `scripts/eval/lib/`. Copy-and-adapt everything
   dataset-shaped (types, dates, dataset loader, envelope, ingest/answer drivers)
   since LoCoMo's shape genuinely differs.
2. **Judge layer is new authorship, not reuse.** Expect the same
   fork-upstream-and-discover-incompatibilities work LongMemEval's judge took
   (judge.mts:1-18); some LoCoMo categories score by F1/token-overlap, not an
   LLM-judge boolean.
3. **Data-model inversion.** LoCoMo is conversation-centric (1 conversation → many
   QA), the opposite of LongMemEval's question-centric isolation
   (lib/envelope.ts:8-16) — ingest once per conversation, fan out questions.
4. **Cross-cutting gap RESOLVED (2026-07-09 investigation).** The as_of/temporal
   daemon gap at scripts/eval/longmemeval/README.md:357-399 was fixed in 0.9.0 —
   that README section is stale (its "verified live" test ran against a
   pre-reinstall daemon 31s after the fix commit). Re-verify once against a
   freshly-reinstalled ≥0.10.0 daemon, then temporal categories are valid.
5. **Repro manifest must additionally pin:** daemon package version + git SHA,
   the judge model's actual snapshot id (not a deployment alias), the full
   effective config.yaml, and the dataset's sha256.
6. **Licensing:** LoCoMo is CC BY-NC 4.0 — `.eval-data/` is gitignored so no
   redistribution risk, but attribution is required in the repro doc.
7. **Sequencing:** LongMemEval has never produced a published number
   (docs/eval/methodology.md:91-95) — publishing its non-temporal ~58% may be the
   faster path to the packaging-audit goal; LoCoMo can follow with its
   conversation-centric design rather than being the first number shipped.
