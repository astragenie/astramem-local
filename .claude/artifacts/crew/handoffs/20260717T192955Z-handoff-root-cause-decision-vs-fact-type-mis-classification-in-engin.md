# Task Handoff: Root cause: decision-vs-fact type mis-classification in engineering extraction prompt

- Created: 2026-07-17T19:29:55.839Z
- From: researcher
- To: dispatcher
- Objective: The type-priority rule (decision before fact) is textually correct, but the ONLY few-shot example teaching 'decision' is a live-dialogue deliberation, not a retrospective declarative statement, so the model pattern-matches settled-choice sentences like 'X was chosen over Y' onto the fact definition's 'verifiable, current property' framing instead.
- Allowed Scope:
  - Read-only investigation of src/distill/prompts/extract.ts (AtomSchema
  - EXTRACTION_SYSTEM_PROMPT type-priority list + engineering few-shot examples) and src/distill/stages/05-extract.ts (temperature/maxTokens call site). No files edited.
- Forbidden Scope: -
- Deliverable: Root cause + exact prompt diff (rule 4 tense-invariance clause, rule 6 exclusion clause, new contrastive few-shot example 6) returned inline to requester; verification command specified (bun scripts/eval/extraction-bench/run-bench.mts --runs 5, plus conversational-fixture pass).
- Changed Files:
  - src/distill/prompts/extract.ts (read only
  - lines 133-234)
  - src/distill/stages/05-extract.ts (read only
  - lines 44-51
  - 218
  - 244)
- Confidence: medium
- Risks: Root cause is inferred from prompt structure + one smoking-gun fixture (fx01), not from re-running the model with instrumented reasoning traces — no direct evidence of the model's internal rationale, only the input/output pair. fx14-secrets was not independently read to confirm the same mechanism applies. Proposed fix is unverified until re-measured; judge noise is ~7 F1 pts so a single run is not conclusive. Adding a contrastive example could shift emphasis and cause the model to under-extract fact in favor of decision on truly ambiguous inputs — needs the recall/precision delta checked, not just typeAccuracy.
- Suggested Next Handoff: Dispatch crew:fullstack-dev (or dev-lite, since this is a ~15-line prompt-only diff) to apply the exact diff below to extract.ts, then dispatch a bench re-run (bun scripts/eval/extraction-bench/run-bench.mts --runs 5) before merging.

