# Memory quality design — BYO frontier extraction + rich prompts + entity relations

- **Date:** 2026-07-13
- **Author:** lead (session e08b8f83, Fable) — brainstorm output, operator-steered
- **Status:** draft for architect + architect-reviewer
- **Related:** `.claude/artifacts/crew/handoffs/20260713T090000Z-memory-quality-master-plan.md` (four measured causes; W1/W2 already merged), `.claude/artifacts/loop/plans/20260713-conversational-extraction-profile-plan.md` (LoCoMo/conversational axis), FEAT-479 (richer memories), FEAT-481 (entity relations), competitor research 2026-07-13 (mem0/supermemory/Graphiti/Letta/LangMem, LoCoMo score audit).

## 1. Problem

Stored memories are trivia-grade even for engineering content ("Re-verify the fix
before committing", "A reinstall occurred during the deployment process") while
Claude-authored MEMORY.md files on the same machine are dense, anchored, and
reusable. Retrieval-side causes (missing query prefix, junk gate) are measured and
already merged by the parallel session (+30.5 MRR combined). This design addresses
the remaining authorship and shape causes, and the competitive positioning they
unlock.

## 2. Decisions (operator-confirmed)

- **D1 — Authorship: BYO frontier LLM, not local-7B-only and not tail-call.**
  Extraction/compaction run on the LLM the user configures. All four providers
  already exist and are wizard-selectable (`ollama` default; `azure-openai`;
  `openai-compatible` — any OpenAI-shaped key; `codex-subscription` — Codex CLI
  OAuth, offered only when a Codex login is detected). Users bring their own key;
  we never proxy or pay for their extraction. The earlier "tail-call
  distillation" concept is dead — superseded by this simpler path.
- **D2 — Operator box runs codex-subscription** for extraction + compaction
  (model chosen from live `models_cache.json`; A/B `gpt-5.5` vs `gpt-5.4-mini`
  during the proof phase). This also retires master-plan C3 (live-config
  qwen2.5-coder drift).
- **D3 — One merged extraction-prompt FEAT** (single prompt surface, single
  builder): FEAT-479/W5 rich shape (300–800 chars; claim + rationale +
  consequence + provenance) × profile axis `engineering | conversational` (from
  the conversational plan) × relation triples (FEAT-481). Few-shot examples
  rewritten per profile — the examples are the spec.
- **D4 — Supersession tension resolved as option (a)** (master plan §3-W5):
  rich multi-claim shape allowed for `lesson`/`decision` (rarely superseded);
  `fact`/`command` stay atomic (frequently superseded). No structured-claim
  schema change in this round.
- **D5 — Proxy per-request injection: parked** behind FEAT-458 bake + post-fix
  recall numbers. Capture (FEAT-458 S3–S7) is shipped and orthogonal.
- **D6 — Ship-default stays local-first**: Ollama remains the zero-config
  default; wizard/docs state the quality trade plainly. BYO cloud is an explicit
  user choice with a privacy disclosure line.

## 3. Components

### 3.1 Provider posture (mostly shipped — polish only)
- Wizard copy: one honest line on the trade ("local 7B: free/private, weaker
  memories; your own key: MEMORY.md-grade quality, transcripts go to your LLM
  account").
- Doctor: existing codex-subscription + openai-compatible probes stay the
  health surface. Optional: WARN when live config pins a model the in-repo A/B
  bench rates worse (C3-class drift canary).

### 3.2 Merged extraction FEAT (D3) — the core work
- Prompt architecture: shared skeleton; per-profile definitions + few-shots;
  richness rules (self-contained, pronouns resolved, proper nouns preserved,
  relative dates grounded to observation date — mem0 patterns); possessor
  qualification + banned-abstractions negative list (Graphiti patterns).
- Output schema: existing 7 types unchanged (zero wire/schema migration);
  relation triples added per FEAT-481.
- Config: `distill.extractProfile: 'engineering' | 'conversational'`
  (default engineering) + optional per-ingest `extract_profile` envelope field
  (additive zod, no wire break). Replaces module-load env-var prompt selection
  with per-run resolution (`ASTRA_EXTRACT_PROMPT` kept as override).
- Coordination: master plan is under adversarial review in a parallel session;
  its W5 and this FEAT are the same work item — merge, do not land twice.
  Same file (`src/distill/prompts/extract.ts`), one owner.

### 3.3 Entity relations — FEAT-481 (filed, PM-scoring in flight)
- `entity_relations` table: subject_entity_id, relation_type
  (SCREAMING_SNAKE_CASE), object_entity_id, valid_from, valid_to,
  source_memory_id, confidence. Migration ~027.
- Triples emitted by the same extraction call (no extra LLM call, no key
  requirement beyond the configured tier; precision improves with BYO tier).
- Edge supersession reuses existing valid-time machinery.
- v1 retrieval: `entity_graph` MCP tool (neighbors + timeline); optional 1-hop
  recall expansion. OUT of v1: graph algebra, path queries, communities.

### 3.4 Proof phase (gates the default recommendation)
Re-distill ~10 real transcripts under 4 configs — qwen/old-prompt (baseline),
qwen/new-prompt, codex-mini/new, codex-5.5/new. Judge: operator eyeball vs
Claude-authored MEMORY.md + recall-quality harness MRR (instrument:
`scripts/eval/recall-quality/`, per its W7 hardening — report ranges, not point
estimates). LoCoMo rerun (conversational profile, Ollama-only, isolated
worktree) after the prompt FEAT lands.

## 4. Sequencing & dependencies

1. Master-plan W1/W2 — **landed** (merged + pushed, CI green).
2. Master-plan adversarial review completes → merge its W5 verdict into D3
   scope (blocking for 3.2 start; not for 3.1/D2 config flip).
3. D2 operator config flip + smoke (same day; independent).
4. 3.2 merged extraction FEAT (~2–3 days) → 3.4 proof (~1 day).
5. FEAT-481 (~4–6 days; can overlap 3.2's later slices — same prompt surface
   means its extraction slice lands inside 3.2's builder scope).
6. LoCoMo rerun; stable-promotion language update with metric-matched table.

## 5. Failure modes

- BYO endpoint down / quota exhausted → distill jobs retry then poison; spool
  preserves content; doctor probes surface. Optional hardening: fallback
  provider chain (not in v1).
- 7B triple hallucination (keyless users) → Graphiti-pattern negative lists +
  confidence field + edge supersession; accept noisier graph at the free tier.
- Prompt-FEAT collision with parallel session → single-owner rule (§3.2).

## 6. Competitive positioning unlocked (research-backed)

Context-anchored memories (repo/branch/agent/session — hooks + proxy, neither
mem0 nor supermemory can see lifecycle), privacy-absolute (127.0.0.1 +
SQLCipher + BYO key; supermemory's architecture cannot offer this), typed
lifecycle with rationale-carrying memories (vs mem0's untyped sentence pile),
learning ranker (usefulness loop — unique, pending its producer), honest
reproducible benchmarks (23.6 F1 today vs original-paper F1 column; target
>41.4 post-fix; never compare to vendor LLM-judge numbers), and with FEAT-481
an honest "knowledge graph" claim at Graphiti's structural starting point.

## 7. Open questions for review

1. Should the wizard RECOMMEND BYO-cloud when a key/login is detected, or stay
   Ollama-first? (Quality vs local-first brand tension.)
2. Fallback provider chain: worth a v1 slice, or hardening-later?
3. FEAT-481 confidence field: float 0-1 from the model, or drop it (models
   are poorly calibrated; Graphiti doesn't persist one)?
4. Does the conversational profile change redaction posture? (Personal content
   → stricter scrub defaults?)
