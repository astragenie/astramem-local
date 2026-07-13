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

## 7. Review outcomes (architect-review 2026-07-13, approve-with-changes)

Review artifact: `.claude/artifacts/crew/reviews/20260713T100000Z-architect-review-memory-quality-design.md`

1. **Ownership (HIGH, resolved by DEC-015):** FEAT-479 is the CANONICAL ticket
   for all extract.ts prompt work. The conversational-profile plan's S2 and
   this design's §3.2 fold INTO FEAT-479; FEAT-481's triples slice is a
   DEPENDENT of it, not a co-owner. No other ticket may be opened on this
   surface; triage must not create a duplicate.
2. **codex-subscription empty-SSE gate (HIGH):** `parseSseResponse` returning
   `text: ''` as success is the qwen3:8b poison class. Pre-req slice before
   D2 becomes the operator default: empty text under `opts.json === true`
   throws `TransientError`. Small, independently shippable, needs its own
   test.
3. **Type-conditioned richness (MED):** the prompt must STATE the rule
   explicitly (rich shape for `lesson`/`decision`, atomic for
   `fact`/`command`), not imply it via examples. AtomSchema `text.max(500)`
   conflicts with the 300–800ch target → bump cap to 1000 in the same FEAT
   (contract check: DB column is TEXT, no migration).
4. **Budget-cap blindness (MED):** codex-subscription reports `usd: 0`, so
   cost ceilings silently no-op → doctor WARN row when extraction provider
   reports zero-cost usage while a budget cap is configured.
5. **Conversational redaction (MED, operator decision pending):** current
   redaction detects secrets only; the conversational profile deliberately
   extracts personal content (health, relationships, named third parties).
   Recommendation: v1 ships secret-only redaction + explicit wizard/docs
   disclosure for the conversational profile, and a follow-up FEAT for a
   personal-content scrub tier. OPERATOR MUST CONFIRM this posture.
6. **Proof-phase rigor (LOW, adopted):** ≥2 runs per config, blinded
   eyeball pass (configs anonymized), report ranges not points, add
   cost + latency columns per config (that's the actual gpt-5.5 / mini /
   qwen tradeoff being decided).
7. Wizard: nudge/label BYO-cloud when a login is detected; default stays
   Ollama. Fallback chain deferred (retry-then-poison already degrades
   safely). Confidence field: keep in schema, must not drive filtering or
   supersession in v1.
