# ADR-001: Canonical Memory Atom (one schema, two implementations)

**Status:** accepted · **Date:** 2026-07-02 · **Confidence:** High
**Context:** astramem-local (Bun/TS/SQLite) and AstraMem cloud (.NET/Postgres) have diverged:
different schemas, different retrieval, no shared contract. Strategy rules both stay (two
languages, unified by contract — constraint C2). The memory object is the contract of the company.

## Decision

Define **Memory Atom v1** (`astramem/atom@1`) as the single canonical schema both products
implement:

```jsonc
{
  "schema": "astramem/atom@1",
  "id": "uuid",
  "type": "decision | fact | lesson | command | todo",   // registry-extensible, closed by default
  "text": "canonical normalized text",
  "evidence": [{ "transcript_id": "…", "span": [start, end] }],   // receipts — never optional
  "confidence": 0.0-1.0,          // extractor confidence
  "importance": 0.0-1.0,
  "provenance": { "tool": "claude-code|codex|cursor|…", "session_id": "…",
                  "repo": "…", "project": "…", "extractor": "name@version" },
  "valid_from": "ts",             // bitemporal valid time
  "valid_to": "ts|null",          // null = currently valid
  "superseded_by": "uuid|null",
  "derived_from": ["uuid"],       // consolidation lineage (ADR-004 stage 9)
  "scope": "personal | team | org",   // ADR-009; personal is the default
  "content_hash": "sha256",       // dedup + sync idempotency (ADR-003)
  "entities": ["…"],
  "created_at": "ts", "updated_at": "ts"
}
```

Conformance = a versioned JSON Schema + golden fixtures published as a small contracts package;
both implementations validate against it in CI.

## Options considered

1. **Typed atom with bitemporal validity + provenance (chosen).** Matches the formation pipeline's
   existing typed output; carries the audit/validity story; flat enough for SQLite and Postgres alike.
2. **Knowledge-graph-first model (Zep/Graphiti shape).** Rejected: ontology tax on every ingest,
   LLM-heavy edge extraction cost, and it competes where Zep is already verified-strong. Our edge is
   formation + validity, not traversal. Entity/relationship data stays as *fields and side tables*,
   not the primary model.
3. **Free-form document blobs + embeddings.** Rejected: no typed queries, no audit, no supersession
   semantics — it's a vector store, which the market already has too many of.

## Consequences & migration

- local: schema v2 → v3 migration adds `valid_from/valid_to/superseded_by/scope/derived_from`
  (defaults: `valid_from=created_at`, `scope=personal`). Cloud: FEAT-214 already has valid-time;
  needs `type` alignment to the atom registry + `scope`.
- Wire envelope version (`astramem/atom@1`) is the negotiation unit for sync (ADR-003) and
  capture (ADR-008). Schema evolution: additive fields minor-version; breaking = new major with
  dual-read window.
- Rejected-alternative debt: if graph traversal becomes a paid need, edges derive FROM atoms
  (materialized), never replace them.
