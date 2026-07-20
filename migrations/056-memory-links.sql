-- 056: deterministic cross-atom links (retrieval-overhaul Phase 6 / P6b).
--
-- Codex architecture review ("Add cross-atom links; do not spend first on
-- more extraction", docs/research/20260720-codex-architecture-reviews.md):
-- `entity_relations` (migration 027) only connects two entities that were
-- BOTH named inside the SAME atom's `relations[]` — too narrow for
-- conversational multi-hop evidence, where the bridge between two facts is
-- often "these two atoms share a person" or "these two atoms are from the
-- same session, minutes apart" rather than an explicit LLM-asserted triple.
--
-- `memory_links` is therefore a SEPARATE, structurally simpler graph from
-- `entity_relations`: atom-to-atom (memory-to-memory), not entity-to-entity,
-- generated DETERMINISTICALLY post-reduce (src/distill/link-atoms.ts, wired
-- at src/distill/pipeline.ts right after stage 6's reduce()) rather than by
-- the LLM. Every row must carry provenance (`evidence` — a short, human-
-- readable reason the link was made, e.g. a shared entity name) per the
-- plan's own "require provenance for every generated edge" rule — never a
-- bare, unexplained edge.
--
-- `memory_id_a`/`memory_id_b` are stored in a CANONICAL ORDER (a < b by
-- plain string comparison — see MemoryLinkRepo.insert) so the same pair
-- can never be stored as two mirrored rows; a link is inherently
-- symmetric (readers walk it in either direction), unlike entity_relations'
-- directional subject/predicate/object shape.
--
-- ON DELETE CASCADE on both memory FKs — same rationale migration 027 gives
-- for entity_relations.evidence_memory_id: erase_memory (ADR-006) is an
-- explicit, user-invoked hard delete, and every other memory-scoped child
-- table (memory_entities, entity_relations) already cascades on it. RESTRICT
-- would make erase_memory fail the moment any link cites the memory.
--
-- No FLOAT[N]/vec0 interaction (CLAUDE.md "Do NOT" section) — plain
-- relational table only.
CREATE TABLE memory_links (
  id TEXT PRIMARY KEY,
  memory_id_a TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  memory_id_b TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  -- 'shared_entity'    — both atoms name the same normalized entity.
  -- 'session_proximity'— both atoms came from the same session, close
  --                       together in extraction/chunk order.
  -- 'possession_family' — a shared-entity link where the linking atom's own
  --                       text also carries a possessive/family qualifier
  --                       binding the two entities (e.g. "Alice's mother
  --                       Priya") — a richer-provenance specialization of
  --                       shared_entity, not a disjoint detection path.
  -- 'event_participant' — both atoms are linked via a shared entity AND at
  --                       least one of the two atoms is type='event'.
  link_type TEXT NOT NULL CHECK (link_type IN (
    'shared_entity', 'session_proximity', 'possession_family', 'event_participant'
  )),
  -- Human-readable reason (e.g. the shared entity's normalized name, or
  -- "same session, chunk 3 -> chunk 4") — the provenance the plan requires
  -- on every generated edge. Never empty.
  evidence TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL,
  -- Canonical-pair dedup guard: the linker may independently propose the
  -- same (a, b, type) triple more than once across a run (e.g. two atoms
  -- sharing TWO entities each independently trigger 'shared_entity') --
  -- collapse to one row rather than one per shared reason. A different
  -- link_type between the same pair is a distinct, meaningful row (e.g.
  -- 'shared_entity' AND 'session_proximity' both legitimately hold).
  UNIQUE (memory_id_a, memory_id_b, link_type)
);

CREATE INDEX idx_memory_links_a ON memory_links(memory_id_a);
CREATE INDEX idx_memory_links_b ON memory_links(memory_id_b);
CREATE INDEX idx_memory_links_type ON memory_links(link_type);
