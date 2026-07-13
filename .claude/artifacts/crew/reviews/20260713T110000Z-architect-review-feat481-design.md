---
type: review
created: 2026-07-13T11:00:00Z
author: architect-reviewer (independent, session e08b8f83 fan-out)
subject: docs/specs/FEAT-481-design.md
verdict: approve-with-changes
---

# Architecture review — FEAT-481 design (entity-to-entity relations)

## Verdict: **approve-with-changes**

This is a well-grounded design — §0's discovery that cloud already ships
`EntityRelationshipEntity`/`get_entity_related`/`get_entity_timeline` in
production and using it as the tie-breaker for every naming/shape decision is
the right move, and it's verified against real cloud source
(`EntityRelationshipRepository.cs`, `EntityTools.cs`), not asserted. Slice
breakdown correctly treats SLICE-2 as coordinated-not-parallel work inside
D3's `extract.ts` ownership, which is more disciplined than the parent
memory-quality design doc managed for itself. One real correctness gap needs
closing before SLICE-1 is built: §3.1's invalidate()-cascade claim and §4.1's
literal query contract disagree with each other.

## 1. The invalidate() "zero new code" claim is not actually wired into the query contract it depends on — [HIGH]

§3.1 claims the source-memory `invalidate()` path needs **no new code**
because, at query time, "a relation's effective `valid_to` is
`MIN(entity_relations.valid_to, source_memory.valid_to)`" — explicitly
modeled on FEAT-453's `memoryIdsForEntitiesAsOf`, which does implement
exactly this via a real `JOIN memories m ON m.id = me.memory_id` plus a
`MIN(COALESCE(...), COALESCE(m.valid_to, +inf))` clause
(`src/storage/entities.ts:223-238`, confirmed).

But §4.1's actual retrieval contract for `get_entity_related` never mentions
that join. It states only: *"'Currently valid' default (no `asOf`):
`valid_to IS NULL OR valid_to > now()`, identical semantics to cloud."* That
is a check against `entity_relations.valid_to` alone. A builder implementing
§4.1 literally — which is what a "contract" section is for — gets a query
that has no path to `memories.valid_to` at all, so a relation sourced from an
`invalidate()`d memory keeps reading as currently-valid forever, silently
contradicting §3.1's promise. `invalidate()` itself
(`src/storage/memory-events.ts:218-240`) only ever touches the `memories`
row — it has no knowledge of `entity_relations` and isn't meant to — so the
join is the *only* place this can be enforced, and right now no section
specifies it as part of the actual query.

This is exactly the failure class this design's own SLICE-4 is trying to
guard against ("this repo's dominant failure mode is 'built, wired, never
invoked'") — here it would be "documented as wired, actually isn't."

**Fix**: make §4.1's contract explicit — `getForSubject`/`getForObject`/
`getForEntity` must `JOIN memories m ON m.id = er.source_memory_id` and filter
on the same `MIN(...)`-style composed bound `memoryIdsForEntitiesAsOf` uses,
not on `entity_relations.valid_to` alone. This is cheap (the join key is
already indexed via `idx_entity_relations_source_memory`, and `memories.id`
is the PK) but it is *new code*, not the zero-new-code framing §3.1 currently
gives it — correct the framing along with the query.

## 2. Point 2 (no-hallucination guard): correct call for v1, but the recall trade-off is under-disclosed — not too strict, needs a stated limitation

§2.2's guard (drop a triple whose `subject`/`object` isn't in *this atom's
own* `entities[]`) is presented purely as an anti-hallucination mechanism. It
is that, and it's the right default: because the extraction prompt already
instructs "list every specific named thing the atom is ABOUT," a relation an
atom is genuinely asserting will, in the ordinary case, name both endpoints
in that same atom's entity list — the guard shouldn't over-fire on the common
case.

But there is a real, distinct failure mode the design doesn't name: a chunk
that splits into two atoms (e.g. one about Alice's decision, one about Bob's
event) where a relation between Alice and Bob is real but each half is only
named in its own atom's entity list — that relation is silently dropped,
with the same "corroborating evidence, no complaint" behavior as a
hallucination that never should have been asserted. Given v1's own framing
("deliberately modest," matching cloud's "out of scope" posture elsewhere),
dropping true cross-atom relations is the right trade for a first ship
(precision over recall on a brand-new surface), but §2.2 should say so
explicitly as a named v1 limitation, not only as an anti-hallucination
property — the same honesty standard the design already applies to
supersession (§3) and confidence (§6). Low severity, cheap to fix: one
sentence.

## 3. Query-time supersession, once fixed per finding 1, has no special index and doesn't need one — informational, not blocking

Once the §4.1 query correctly joins to `memories` for the effective-`valid_to`
computation, that computed `MIN(...)`-style filter is not sargable by a plain
B-tree index (same as the FEAT-453 precedent it mirrors, which also has no
dedicated index for its own analogous join-and-compare). This is consistent
with existing practice in this codebase, not a regression, and at
single-user/local scale (a few thousand relation rows at most) an index-driven
join on `idx_entity_relations_source_memory` down to a per-row filter is fine.
No action needed beyond noting it so a future reviewer doesn't mistake it for
an oversight.

## 4. Write-time dedup guard: race-safe as specified, contingent on staying one statement — pass, with an implementation caution

The `INSERT INTO entity_relations (...) SELECT ... WHERE NOT EXISTS (...)`
guard (§3.4) is a single atomic SQL statement, which is the load-bearing
property: SQLite serializes writers regardless of process count (single
writer lock, WAL or rollback journal), so even two independent daemon/worker
processes racing on the same tuple are safe as long as the check-and-insert
is genuinely one prepared statement executed under that lock — the second
writer's `NOT EXISTS` subquery only ever runs after the first writer's
commit is visible. The design correctly avoids a naive two-round-trip
"SELECT to check, then INSERT" pattern, which would reopen exactly this race.
**Caution for the builder**: this property only holds if `EntityRelationRepo`
actually issues one `db.prepare(...).run(...)` call for the whole
insert-with-guard — a well-intentioned refactor into "check with `.get()`,
then `.run()` the insert" would silently reintroduce the TOCTOU race. Worth a
one-line comment in the implementation, not a design change.

## 5. MCP manifest owner flip (`cloud` → `both`) and the cross-repo-roundtrip gate — does NOT block on cloud, confirmed from both the workflow and the manifest's own documented scope

Answering the team lead's specific question directly: **no, flipping the
owner does not block on a cloud acknowledgment, and does not risk
`cross-repo-roundtrip.yml`.**

- `cross-repo-roundtrip.yml` (read in full) checks out `astramem-plugin` and
  runs its `test:smoke` against this repo's built `dist/` — it exercises the
  capture → ingest → distill → recall path (transcripts/atoms), and never
  touches `contracts/manifests/mcp-tools.v1.json` or MCP tool registration at
  all. Unrelated surface.
- `tests/contracts/mcp-tool-manifest-parity.test.ts` (the actual gate on this
  manifest) is **purely local**: it spins up this repo's own `McpServer`
  in-process, calls a real `tools/list`, and diffs the result against
  `contracts/manifests/mcp-tools.v1.json` as checked into *this* repo. It
  never contacts cloud. `contracts/README.md`'s own words confirm the scope:
  *"Cloud's half (asserting its own registered names against this same file)
  and the plugin's half... are out of this repo's build."*
- Because `get_entity_related`/`get_entity_timeline` already exist in this
  repo's manifest as `owner: "cloud"` (verified against the file, §0's
  citation checks out), flipping to `"both"` requires nothing from cloud —
  cloud already implements these tools today; this repo is only now also
  implementing the same names and updating a metadata field to say so. This
  is the identical operation `search_memory`/`remember`/`invalidate_memory`/
  `submit_feedback` already went through (all `owner: "both"` today per the
  manifest and the README's SLICE-B history) — established, low-risk
  precedent, not a first-of-its-kind move.
- The design is correct to land the manifest flip in the **same slice**
  (SLICE-3) as the actual tool registration (§5) — flipping the JSON first
  without registering the tools would fail the local parity test's "every
  manifest local/both entry has a matching registered tool" assertion. As
  sequenced, it's fine.

**One soft, non-blocking risk worth a note, not a gate**: this repo's copy of
`mcp-tools.v1.json` is described as "ships in-repo" with a *prospective*
GitHub-Packages consumption path for cloud that the README itself flags as
"NOT verified live." There is no automated check that cloud's own
independent copy of this manifest (if one exists on that side) gets updated
to also say `"both"` — that's a documentation-sync risk, not a CI-enforced
one. Recommend a one-line follow-up (a message to whoever owns the cloud
repo, or a tracked chore) so the two copies don't silently diverge on
ownership metadata, but this should not block SLICE-3.

## 6. Everything else checked and confirmed sound

- **Migration 027 numbering**: confirmed `026-proxy-usage.sql` is the latest
  on `main` today — `027` is genuinely free, no collision.
- **Stage-8-not-stage-5 resolution timing** (§2.3): confirmed against
  `src/distill/stages/05-extract.ts:122-189` — stage 5 only validates/coerces
  atom shape (e.g. `coerceEntityKinds`) by name, entity **ids** don't exist
  until stage 8's `entityRepo.upsert` calls
  (`08-embed-index.ts:212-218`). The design's reasoning for why relation
  resolution can't happen at stage 5 is accurate, not asserted.
- **`parseAsOf` reuse** (§4.1): confirmed real,
  `src/mcp/server.ts:55,168,271` already imports and uses it for search's
  `as_of` — no new date-parsing code needed, as claimed.
- **FK/cascade reasoning** (§1): the entity-merge dead-code caveat is
  self-flagged already, which is exactly right — no gap to add here.
- **Confidence field decision** (§6): consistent with the parent
  memory-quality design review's own answer to the same open question (keep
  the field, don't let it drive filtering/ranking in v1) — this design goes
  further by grounding it in cloud's actual shipped default (`0.5`,
  `NOT NULL`, clamped) rather than an abstract argument, which is a stronger
  basis. No change needed.
- **§7 deviations**: all three (tool naming, relation_type case-as-normalization-
  not-constraint, confidence keep) are well-justified and consistent with
  cloud's actual shipped shape. No objection.

## Summary of severities

| Sev | Finding |
|---|---|
| HIGH | §3.1 vs §4.1 — the invalidate()-cascade "zero new code" claim depends on a `JOIN memories` in the retrieval query that §4.1's literal contract never specifies; as written, a builder following §4.1 produces a query that doesn't honor §3.1's promise |
| LOW | §2.2 — dropping cross-atom relations (both endpoints real, but split across two atoms) is the right v1 trade-off, but should be named as an explicit limitation, not folded silently into the anti-hallucination framing |
| INFO | §4.1 (post-fix) — the joined effective-valid_to filter isn't index-sargable, consistent with the existing FEAT-453 precedent; no action needed |
| INFO | §3.4 — the dedup guard is race-safe as a single atomic statement; flag for the builder not to split it into a check-then-insert pattern |
| INFO | §4.1 manifest flip — confirmed non-blocking on both `cross-repo-roundtrip.yml` and the local parity test; only a soft, non-CI documentation-sync risk with any independent cloud-side copy of the manifest |
