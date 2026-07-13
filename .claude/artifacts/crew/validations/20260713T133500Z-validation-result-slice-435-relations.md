---
type: validation
created: 2026-07-13T13:35:00Z
slice: SLICE-435
feature: FEAT-479
related_feature_slice: FEAT-481 SLICE-428 (rides this slice)
result: PASS
validator: lead (evidence from builder live smoke + reviewer worktree runs)
---

# Validation — SLICE-435: relations[] additive extraction output, wired to entity_relations

## Behavior evidence

- **Live smoke (real Ollama, qwen2.5-coder:7b, worktree)**:
  - Relation-bearing transcript → decision atom with 4 entities and 3 VALID
    relations: astramemory-local uses SQLite (0.9), uses sqlite-vec (0.9),
    replaces Postgres (0.7). Subject/object all present in the atom's own
    entities[]; predicates from the closed enum. Money assertion satisfied.
  - fx43 naturalistic fixture → relations: [] — honest negative: the model
    named the lock only in prose, not as an entity, so the no-hallucination
    guard correctly had nothing to attach. 7B generalization limit, deferred
    to SLICE-436's codex-flip comparison by design.
- **Guard coverage**: 9 targeted tests (unknown predicate dropped-not-coerced,
  hallucinated subject, hallucinated object, self-relation, mixed
  valid+invalid in one atom, 'other' accepted, normalization cases) all pass.
- **Wiring**: stage 5 and stage 8 share the SAME normalizeEntityName import
  (zero mismatch risk); entity-id map reused from the upsert loop;
  EntityRelationRepo dedup path untouched; supersede cascade already deletes
  relations by evidence_memory_id (memory-events.ts:307, untouched).
- **Additive compatibility**: absent relations[] proven byte-identical;
  conversational prompt untouched (asserted by test).
- **Context budget**: v3 now ~18.4k chars / ~4.6k est tokens; total ~8.4k vs
  16384 NUM_CTX_CAP; live tripwire test computes from the real prompt string.
- Suites: worktree tsc clean; scoped 14 files / 235 tests pass; builder full
  run 3002 pass / 1 pre-existing detach.test.ts flake (10/10 standalone).

## Reviews

- review-435: PASS, no HIGH/MEDIUM; two non-blocking observations (confidence
  fallback prefers atom confidence over schema default — endorsed; budget-test
  constants duplicated — pre-existing style).
  Artifact: .claude/artifacts/crew/reviews/20260713T133000Z-review-slice435-relations.md
