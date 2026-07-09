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

## Amendment (2026-07-09): atom@2 — entities, provenance, scope breaking cut

**Status:** accepted · **Confidence:** High · Ratified as part of the entity-extraction
unification plan (`.claude/artifacts/crew/runs/20260709-entity-extraction-unification-plan.md`
V3 §6, sign-off "A1 wart-sweep").

**Context:** three warts accumulated in `atom.v1.schema.json` since this ADR was written:
`entities` is a flat `string[]` even though every real consumer (astramem-local's own
`harness.ts:137`) already needs a kind, not just a name; `provenance` carries both `repo` and
`project` when cloud only ever keys on one collapsed field; and `scope` still carries the
`'personal'` alias a full release after the `personal`→`private` rename (DEC-048) was supposed to
retire it. Normally each of these would be an additive-then-deprecate cycle per this ADR's own
"Consequences" versioning rule. **This repo currently has zero customers** — the only window
where a breaking bump costs nothing — so the decision is to fix all three in one `atom@2` cut
instead of paying three separate rounds of deprecated-field debt.

**Decision:** ship `astramem/atom@2` as a new major schema, **alongside** (not replacing)
`astramem/atom@1`:

```jsonc
{
  "schema": "astramem/atom@2",
  // ...unchanged fields (id, type, text, evidence, confidence, importance,
  // valid_from, valid_to, superseded_by, derived_from, content_hash,
  // created_at, updated_at) — see atom.v1 shape above...
  "provenance": { "tool": "…", "session_id": "…", "project": "…", "extractor": "…" },  // repo DELETED
  "scope": "private | team | org",   // 'personal' alias DELETED
  "entities": [{ "name": "…", "kind": "actor|team|org|project|product|workitem|decision|tech|tool|concept|event|other", "subtype": "human|ai" }]  // was string[]
}
```

Cutover is **not simultaneous** across the three consuming repos: cloud's sync ingest reader
dual-accepts `atom@1` and `atom@2` during rollout (mirrors the `content ?? text` fallback idiom
from #618), because astramem-local's shipper has a durable offline queue (events with
`synced_at IS NULL`, 15-min backoff, no pre-flight capabilities check) that can deliver
atom@1-shaped events after cloud has already upgraded. Once astramem-local's writer + queue have
drained onto `atom@2`, a follow-up chore commit removes the `atom@1` fallback and flips
`GET /sync/capabilities` to `atom@2`-only; `atom.v1.schema.json` is deleted from this package at
that point, not before. See `contracts/README.md` "Memory atom v2" for the full fixture/test
inventory this cut shipped with.

`retrieval-query.v1.schema.json`'s `filters.repo`/`filters.scope` and
`retrieval-result.v1.schema.json`'s `hits[].scope` get the same `repo`-deletion and
`personal`-alias-deletion treatment in the same commit, **in place** (no `retrieval@2`) — those
are synchronous request/response surfaces with no durable offline queue, so there is no
dual-accept window to coordinate; the daemon/cloud call sites that read `filters.repo` today are
follow-up work tracked in the unification plan, not this schema change.

**Consequences:**
- No SQLite historical migration and no cloud backfill for pre-atom@2 rows — old data is
  disposable in this window (explicit user constraint, not an oversight).
- The `wire.ts` `ENTITY_KINDS`/`ACTOR_KINDS` constants become the canonical entity-kind
  vocabulary cross-repo (cloud gets a mirrored C# constant + parity test as daemon/cloud
  follow-up work, not part of this package change).
- `repo` is retired as both a `provenance` field and an entity `kind` — repo/project identity is
  owned solely by the structural `provenance.project` field; cross-repo mentions land in the
  `product` entity kind instead.
