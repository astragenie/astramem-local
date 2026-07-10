# FEAT-451 — Persistent User-Profile Object: Design

Status: proposed (design pass, 2026-07-09) — resolves the 4 open questions flagged
in the 2026-07-09 architecture-review corrections on
`.claude/artifacts/loop/backlog/triaged/FEAT-451.md`. Read that file's corrections
section first; this doc does not re-litigate the facts it already established
(7-type local taxonomy, `preference` cloud-only, no distill-complete event,
single global Bearer with no per-scope authz).

## 1. What populates the profile

**Decision: zero-schema-change v1.** Roll up the profile from the existing 7
local atom kinds (`decision`, `fact`, `lesson`, `command`, `todo`, `note`,
`event` — `src/distill/prompts/extract.ts:28`), reusing the exact same
extraction output the rest of the pipeline already trusts. No new atom kind,
no extraction-prompt change, in v1.

Why not add a `preference`/`identity` atom kind now: `preference` already
exists in the cloud contract (`src/contracts/memory.ts:17-21`) but the local
extractor has never produced it, and this codebase has direct, recent
first-hand evidence that extraction-prompt changes are a live-fire risk, not
a free edit — the qwen3:8b A/B history showed a model regressing to **empty**
extraction output under a prompt/schema change (see repo memory
`qwen3-8b-breaks-distill-extract`). Adding a kind means touching
`EXTRACTION_SYSTEM_PROMPT`/`_V2`, the `AtomSchema` type union, the type
priority list, AND running a fresh prompt A/B before trusting it in
production — real work with real regression risk, disproportionate to a
"roll up what we already have" v1. Zero-schema-change lets FEAT-451 ship
behind a pure aggregation query with no distill-pipeline blast radius at all.

**v1 rollup mapping** (source type → profile section):

| Profile section     | Source atom type(s) | Rationale |
|---|---|---|
| `standing_facts`     | `fact`               | "a verifiable, current property" (extract.ts:69) — exactly what a standing fact is |
| `preferences`        | `note`               | extract.ts's own type-priority doc calls `note` out for "opinions, preferences, or style remarks that don't fit above" (extract.ts:71/186) — this is the closest existing semantic match, not a stretch |
| `recurring_lessons`  | `lesson`             | same query shape as `agent-profile.ts`'s `top_lessons`, generalized across agents |
| `recent_decisions`   | `decision`           | same as `agent-profile.ts`'s `recent_decisions` |
| `known_entities`     | `memory_entities` join, `kind IN ('actor','tech','product','tool')` | grounding context — "what/who does this profile keep coming back to" |

`command`, `todo`, `event` are deliberately excluded from v1 — they're
task-shaped, not identity/preference-shaped, and including them would make
the profile a second inbox rather than a standing summary.

**v2 (spec only, not built now):** add a genuine `preference` atom kind to
the local extractor (mirroring the cloud contract's existing value),
requiring: (a) `AtomSchema`/type-priority-list update in
`src/distill/prompts/extract.ts`, (b) a fresh prompt A/B run before flipping
default (same discipline the repo already uses for `EXTRACTION_SYSTEM_PROMPT`
vs `_V2`), (c) the `memories.type` CHECK constraint already accepts it
(migration 017 already widened this — see `src/contracts/memory.ts:11-16`),
so no new migration is needed for storage, only for the writer surface. This
directly improves precision of the `preferences` section (real preference
atoms instead of the `note` proxy) without changing the profile's shape —
the rollup query just adds `preference` to its source-type list. Sequencing:
v2 is a pure extraction-quality improvement layered on top of v1's live
aggregation, not a prerequisite for it.

## 2. Live-computed vs. persisted

**Decision: live-computed for v1**, following the `GET /agents/:agent/profile`
precedent exactly (`src/server/queries/agent-profile.ts`) — same pattern:
one query module, one exported `build*Profile(db, ...)` function, shared
between the REST route and the MCP tool, no persisted document, no rebuild
step, no cache.

This directly resolves AC-2's "architecture_quality weak dimension" finding
(single choke point) the honest way: there is no "distill run completed"
event to trigger a rebuild from, only per-atom `create` events on
`memory_events` — so instead of inventing a debounce/rebuild trigger against
an event stream that wasn't designed for it, v1 sidesteps the problem
entirely. Every `GET /profile` call is a fresh SQL read against current
state. **AC-2's debounce language is killed for v1** — there is no rebuild
step, staleness is zero by construction, and "one module, no duplicated
rollup logic" is satisfied by construction (there is exactly one query
module and no cache to keep in sync with it).

### GET /profile — SQL shape

New module `src/server/queries/user-profile.ts`, structurally parallel to
`agent-profile.ts`:

- `ACTIVE_CLAUSE` predicate: `valid_to IS NULL AND archived = 0` (same
  "currently valid" predicate every other read surface uses), plus a scope
  filter (see §3) — no `agent = ?` filter, since this profile is
  daemon-wide, not per-agent (see §3 for why that's the correct default for
  a single-tenant local daemon).
- `standing_facts` / `preferences` / `recurring_lessons`: same shape as
  `queryTopLessons()` — pull active rows of the source type, score via the
  existing `usefulnessScores()` (ADR-010 Laplace-smoothed `(used+1)/(used+
  corrected+2)`, `src/storage/usefulness.ts`), sort by
  `usefulness DESC, importance DESC`, cap at a fixed N per section (default
  10, mirrors `TOP_LESSONS_CAP`). Explicit tie-break on `usefulness` then
  `importance` (both already present) keeps ordering deterministic when
  scores tie — required for §5's eval-gate determinism.
- `recent_decisions`: same shape as `agent-profile.ts`'s
  `queryRecentDecisions()` — `ORDER BY created_at DESC LIMIT 5`, no
  usefulness scoring (matches existing precedent).
- `known_entities`: `GROUP BY memory_entities.name, kind` over active
  memories' entity links, `ORDER BY COUNT(*) DESC`, capped at 10.
- Provenance per field: each returned item carries `id` + `evidence` (the
  atom's own `evidence` column, same "verbatim excerpt" contract
  `why_memory` already uses) — no new provenance plumbing is invented; this
  reuses the same atom-level fields `why_memory` reads, just surfaced
  inline instead of via a separate lookup. This directly satisfies the
  corrections section's flag that "rollup provenance is new work, not reuse
  of why_memory plumbing" — it's true there's no N:1 merge-and-cite (no
  field is synthesized text merging multiple atoms), but per-item
  attribution IS a straight reuse of existing per-atom fields, which is as
  much provenance as v1 needs since no field is a blended/summarized string.

### GET /profile response JSON sketch

```json
{
  "scope": "private",
  "generated_at": 1752029400000,
  "standing_facts": [
    { "id": "atom_...", "text": "...", "importance": 0.7, "usefulness": 0.67, "evidence": "...", "created_at": 1751900000000 }
  ],
  "preferences": [
    { "id": "atom_...", "text": "...", "importance": 0.5, "usefulness": 0.5, "evidence": null, "created_at": 1751900000000 }
  ],
  "recurring_lessons": [
    { "id": "atom_...", "text": "...", "importance": 0.8, "usefulness": 0.75, "evidence": "...", "created_at": 1751900000000 }
  ],
  "recent_decisions": [
    { "id": "atom_...", "text": "...", "importance": 0.7, "created_at": 1751990000000 }
  ],
  "known_entities": [
    { "name": "astramem-local", "kind": "project", "mention_count": 42 }
  ],
  "counts": { "fact": 12, "note": 4, "lesson": 9, "decision": 21 },
  "total": 46
}
```

### MCP tool

`user_profile` — no required args (mirrors `agent_profile`'s shape but
daemon-wide, so no `agent` arg); optional `scope` arg matching the REST
query param (§3). Returns the identical JSON shape as the REST route, built
from the same `buildUserProfile(db, scope)` call — same "shared module, two
transports" pattern `agent_profile` already establishes
(`src/mcp/server.ts:478-492`, `src/server/routes/agents.ts`).

### v2 (spec only): persisted/materialized variant

A new table (e.g. `user_profile_cache`: `scope TEXT PRIMARY KEY, payload_json
TEXT, generated_at INTEGER, atom_count INTEGER`) populated by a background
pass, not a live query. Rebuild trigger has to work around the same "no
distill-complete event" gap AC-2 originally assumed away: the honest design
is a **poll-based debounce**, not an event-subscriber — a periodic pass
(same shape as `runArchivalPass()` in `src/storage/archival.ts`, likely
invoked from the same interval-driven daemon loop `src/cli/serve.ts` already
runs archival from) that checks whether `memory_events.seq` has advanced
past the high-water mark recorded at the last rebuild, and if so, rebuilds
after a minimum debounce interval (e.g. 60s) has elapsed since the last
rebuild — never on every single atom create. Migration cost: one new table +
migration file, one new interval job wired into the existing serve loop, and
a cache-invalidation path for AC-3 (a supersede/invalidate on a
profile-contributing atom must not wait for the next poll tick if the user
immediately re-reads — either accept read-after-write staleness up to the
debounce window, or fall back to a live check-and-rebuild-if-stale on read,
which erodes most of the "persisted" benefit). This is real net-new
complexity for a benefit (avoiding a repeated SQL aggregation on every read)
that has not been shown to matter yet at this daemon's scale — the
`agent-profile.ts` precedent's own perf note (migrations 019/020) shows the
team already tunes live-query plans to stay fast at 100k-row scale rather
than reaching for a cache. Recommend deferring v2 until GET /profile read
volume or aggregation cost is actually measured to be a problem.

## 3. Authz

**Decision: honest single-Bearer model, no per-scope caller authorization.**
The daemon has exactly one global `Bearer` token (`MEMORY_BEARER`) checked in
one `preHandler` hook (`src/server/app.ts:111-124`) — there is no concept of
"caller identity" beyond "has the token or doesn't." `GET /profile` adds **no
route-local auth check**, identical to `/agents/:agent/profile` and every
other authenticated route (`agents.ts:7-8`: "Bearer auth is enforced by the
existing global preHandler... no route-local auth here").

"Private-by-default filtering by scope column" means: `GET /profile`
defaults to `scope = 'private'` in its `WHERE` clause (ADR-009's own default)
— NOT a caller-identity check, since there is no second caller to
distinguish from. An optional `?scope=team|org|all` query param widens the
filter for a caller who already holds the one valid Bearer token (the same
token that can already read team/org atoms via `/search`, `/recall`, etc. —
this introduces no new exposure). Default stays `private` so a bare
`GET /profile` doesn't surprise-widen beyond what a user would expect their
"own" profile to include.

### AC-4 (rewritten)

> Given the daemon's single global Bearer-token auth model (no per-scope or
> per-caller authorization primitive exists), When `GET /profile` is called
> without a valid Bearer token, Then the response is `401` with body
> `{ "error": "unauthorized" }` — identical to every other authenticated
> route's failure shape — leaking no profile data, field names, or section
> names. Per-scope authorization (rejecting an authenticated-but-wrong-scope
> caller) is explicitly NOT a claimable behavior under today's auth model;
> it is a dependency on a future scoped-auth primitive and is tracked as a
> non-goal (§6), not a 403 path this FEAT delivers.

## 4. Local-only vs. cross-product

v1 ships local-only (`cross_product: [astramem-local]`, already set in the
FEAT frontmatter) — no wire envelope, no cloud endpoint. Future wire-shape
sketch, for when cloud parity is proposed: a `UserProfile` envelope would
follow the same `wire_version` convention the ingest contract already uses
(`^v(?:0|[1-9][0-9]*)\.[0-9]+$`, `src/contracts` + plugin `wire.ts:106`),
e.g. `{ wire_version: "v1.0", scope, generated_at, standing_facts[],
preferences[], recurring_lessons[], recent_decisions[], known_entities[] }`
— structurally identical to the local REST response, just wrapped with a
version tag and (eventually) a real per-caller scope/tenant identity once
the cloud side's multi-tenant authz model — which the local daemon
deliberately does not have — is the thing doing the scoping instead of a
static default. Not designing further than this paragraph until the
extraction-schema (v2 `preference` kind) and any persisted-storage decision
(§2 v2) are actually made, since either would change what ships over the
wire.

## 5. Determinism note (ADR-005 eval gate)

`GET /profile` / `buildUserProfile()` is pure SQL aggregation over existing
DB state — no embedding call, no LLM re-summarization, in the read path.
This makes it naturally deterministic under the ADR-005 fake-embedder
harness (`tests/eval/retrieval-eval.test.ts`) with zero special-casing
needed, PROVIDED every ranked section has an explicit, total tie-break order
(not just "sort by usefulness" — ties are common with the neutral-0.5
Laplace default on freshly-distilled atoms with no usefulness signal yet).
§2's SQL shape specifies `usefulness DESC, importance DESC` for the three
scored sections; add `id ASC` as a final tie-break in the actual
implementation so two atoms with identical usefulness AND importance still
sort in a stable, test-reproducible order. The profile-build path does not
touch `src/search/fuse.ts` or the retrieval path at all, so `recall@10` /
`NDCG@10` floors are structurally unaffected — no shared code path exists
between them.

## 6. Non-goals (v1)

- No new vector table, no graph engine (per FEAT's own scope note).
- No new atom kind / extraction-prompt change (§1 — v2).
- No persisted/materialized profile document, no rebuild job, no debounce
  (§2 — v2).
- No per-scope/per-caller authorization — blocked on a scoped-auth primitive
  that does not exist anywhere in this daemon today (§3).
- No cloud wire contract / sync of the profile object (§4 — future, pending
  §1/§2 v2 decisions).
- No LLM call anywhere in the `GET /profile` path (§5 — this is load-bearing
  for the eval-gate determinism guarantee, not just a v1 simplification).
- No N:1 merge-and-cite / synthesized narrative text — every profile field
  is a ranked list of existing atom texts with per-item provenance, not a
  blended summary paragraph.

## 7. Rewritten acceptance criteria (Given-When-Then)

- **AC-1 (happy path):** Given a set of active, durable atoms of type `fact`,
  `note`, `lesson`, or `decision` already persisted via typed distillation
  for scope `private` (no new atom kind or tagging step required), When
  `GET /profile` is called, Then the response returns a profile document
  with `standing_facts`, `preferences`, `recurring_lessons`,
  `recent_decisions`, and `known_entities` sections, each item carrying its
  source atom `id` and `evidence` (verbatim excerpt) for provenance.
- **AC-2 (single choke point, corrected):** Given a new memory is distilled
  and produces additional profile-eligible atoms landing on `memory_events`
  as per-atom `create` events (there is no "distill run completed" event),
  When `GET /profile` is next called, Then the response reflects the new
  atom immediately with no rebuild step or staleness window, because v1 is
  live-computed; the aggregation logic lives in exactly one module
  (`src/server/queries/user-profile.ts`) shared by the REST route and the
  MCP tool, with no duplicated rollup logic elsewhere. (Debounced
  batch-rebuild language is dropped for v1 — see §2.)
- **AC-3 (lifecycle correctness, corrected):** Given a profile-contributing
  atom is later superseded or invalidated through the existing lifecycle
  verbs, When `GET /profile` is next called, Then the retracted atom no
  longer appears, because it fails the same `valid_to IS NULL AND archived
  = 0` predicate every other live read surface already enforces — no new
  `memory_events` entry is needed for the profile itself, since the
  underlying `invalidate`/`supersede` event (already recorded on the atom)
  remains independently explainable via the existing `why_memory` path.
- **AC-4 (authz, corrected):** see §3 above verbatim.
- **AC-5 (observability):** Given a `GET /profile` request completes, When
  the response is returned, Then a structured log line records
  `duration_ms`, `atom_count_consumed` (rows read across all sections
  before capping), and per-section result counts, at the same log level and
  via the same logger the daemon already uses for other request-scoped
  observability — no "staleness" metric is needed in v1 (every read is
  fresh by construction), so this AC is scoped to build-cost observability
  only, not freshness.
- **AC-6 (eval-gate determinism):** Given the ADR-005 CI eval gate running
  under the deterministic fake embedder, When a profile-build test exercises
  `buildUserProfile()` inside that harness, Then the output ordering is
  byte-stable across repeated runs against the same fixture DB (via the
  explicit `usefulness DESC, importance DESC, id ASC` tie-break, §5), no LLM
  or embedding call occurs anywhere in the path, and `recall@10 >= 0.9` /
  `NDCG@10 >= 0.7` are unaffected because the profile path shares no code
  with `src/search/fuse.ts`.

## 8. Slice cut

**Slice 1 — `GET /profile` + `user_profile` MCP tool (live-computed, v1
scope).** Points: 5 (M, matches the FEAT's own effort estimate; single new
query module closely modeled on an existing precedent, one new route, one
new MCP tool, no schema/migration change).

Deliverables:
- `src/server/queries/user-profile.ts` — `buildUserProfile(db, scope)`,
  structurally parallel to `agent-profile.ts`.
- `src/server/routes/profile.ts` — `GET /profile` (optional `?scope=`),
  registered alongside `agents.ts` in `app.ts`, no route-local auth (relies
  on the existing global preHandler).
- MCP `user_profile` tool in `src/mcp/server.ts`, same shared-module pattern
  as `agent_profile`.
- Observability log line (AC-5).
- Eval-gate profile-build determinism test (AC-6) — a fixture-DB test
  asserting stable ordering, not a full retrieval-eval regression (that
  suite already covers `recall@10`/`NDCG@10` independently).
- Unit tests for the lifecycle-correctness predicate (AC-3: superseded/
  invalidated atoms excluded) and the scope-default behavior (AC-4: no
  Bearer → 401, private-by-default filtering).

**Slice 2 (deferred, NOT cut now) — `preference` atom kind (§1 v2).**
Extraction-prompt change + A/B run before flip, plus wiring `preference`
into `user_profile.ts`'s `preferences` section source-type list. Explicitly
sequenced after Slice 1 ships and is stable — this is a precision
improvement on top of a working v1, not a blocker for it. Not pointed here;
size depends on the A/B run's outcome (repo history shows these can surface
model-specific regressions that expand scope — see
`qwen3-8b-breaks-distill-extract`).

Persisted/materialized profile (§2 v2) and cloud wire parity (§4) are
explicitly NOT slice candidates yet — both are blocked on data (§2: measured
read cost/volume; §4: the §1/§2 decisions actually landing) this design
doc's own analysis doesn't have yet.
