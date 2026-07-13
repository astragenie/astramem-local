---
id: FEAT-486
status: pending
priority: null
category: feature
target_release: null
created: 2026-07-13
updated: 2026-07-13
depends_on: []
slices: []
derived_from: null
---
## Description

Temporal questions score 12.4 F1 — the bitemporal layer is built but the answer/recall path never uses it. MEASURED 2026-07-13 in the LoCoMo 10% run (n=199 questions, codex gpt-5.4-mini extraction + qwen3:8b compaction, conversational profile): overall token-F1 45.4 (up from 23.62 baseline), but the per-category breakdown exposes one collapsing category — temporal (LoCoMo category 2, 16.2% of all questions, 321 of 1986): F1 12.4. Every other category is healthy: adversarial 83.0, single-hop 44.4, multi-hop 35.4, open-domain 33.7. Temporal is scoring near the floor while the rest of the system works. Root hypothesis (needs confirmation, do not assume): we HAVE the machinery and nothing calls it. entity_relations carries valid_from/valid_to/invalidated_by (SLICE-427); memory_events gives every atom a bitemporal history; the MCP tools get_entity_related and get_entity_timeline accept an asOf anchor (SLICE-429); §4.1 JOIN semantics exclude relations whose evidence memory was invalidated as of a timestamp. But the recall/answer path (search -> fuse -> recall pack) has no temporal reasoning at all: it retrieves by hybrid similarity and hands flat text to the answerer, which is then asked questions like 'how long ago did X happen' or 'what was true when Y' with no time anchoring. This is the repo's signature failure mode (built, wired, never invoked) with a hard number attached: 16% of questions scoring 12 F1. Scope to investigate then build: (1) confirm the diagnosis — inspect what the answerer actually receives for temporal questions and whether dates present in retrieved atoms are even usable; (2) surface each memory's own valid-time/observed-time to the recall pack so the answerer can reason over dates rather than guess; (3) consider an as_of-aware retrieval path (the cloud engine and get_entity_timeline already model this) for questions that presuppose a point in time; (4) LoCoMo's temporal category asks about date relationships WITHIN retrieved content ('how long ago was X'), not as-of-knowledge — so the first win may simply be making sure dates survive extraction and reach the answerer intact, which is cheaper than a full as-of retrieval mode; check that before building the expensive thing. Acceptance: re-run the LoCoMo 10% sample and show temporal F1 materially above 12.4 with the other four categories not regressing (especially adversarial 83.0, which must not fall — a system that starts guessing at dates could lose its abstention discipline). Value: temporal is 16.2% of LoCoMo; lifting it from 12 to even 35 (the multi-hop level) is roughly +4 points of overall F1 on its own, the single largest measured lever we have.

## Intake notes

Created via free-text intake (`/runner:intake "<text>"`). Priority is
unset — this FEAT has not been scored yet. Run `/runner:triage`
(PM scoring + `backlog pm-apply`) to score it before slicing.