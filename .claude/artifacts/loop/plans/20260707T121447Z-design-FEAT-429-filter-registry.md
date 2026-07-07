---
kind: architect-design-note
feat: FEAT-429
run: runner:architect
created_at: 2026-07-07T12:14:47Z
status: read-only-design -- no source edited
---

# Design: filter-descriptor registry -- collapse the N-file shotgun edit (FEAT-429)

## Problem
Adding one search/recall filter signal historically meant hand-editing the
same pattern across ~8 files in lockstep (fuse weight, SearchFilters
field, SQL clause, route parse, CLI flag, MCP schema, config weight,
dashboard debug string). Missing one silently degrades a surface -- the exact
class of drift FEAT-424 documented for agent. Critical finding before
any further design: this problem is already half-solved in trunk.
PR #105 (c3a81ea, "feat(recall): filter-descriptor registry (FEAT-429)",
merged 2026-07-06) landed a FilterDescriptor registry and migrated project,
agent, entity onto it. The FEAT-429 backlog doc (status: triaged) and
today's PM triage batch (.claude/artifacts/loop/pm-reviews/20260707T160000Z-pm-review-triage-batch.md)
both score this FEAT as if the architectural choice were still open. It is
not open -- the registry approach was chosen, built, and merged with its own
test suite a day before this design note was requested. The real remaining
work is a narrower, already-scoped increment, not a green-field architecture
decision.

A second thing this note must correct: FEAT-429's depends_on: [] in
frontmatter implies no upstream dependency, but the arch-review that spawned
it (arch-review-FEAT-426-2026-07-05) also spawned FEAT-428 (fusion-model
governance), and the task brief asked me to flag a FEAT-428/429 collision on
src/search/*. That collision is also already resolved: FEAT-428
(188c586, PR #104, "fusion-model governance -- component ceiling + eta
eval-gate") merged into src/config/config.ts + src/search/fuse.ts +
src/eval/eval-evidence.ts before FEAT-429's registry PR touched
src/search/search.ts + src/server/routes/search.ts + src/mcp/server.ts
+ src/contracts/*. The two PRs' file sets barely overlap, and they landed
sequentially without conflict. There is no live sequencing risk to manage
going forward -- this is a retrospective confirmation, not a forward-looking
blocker.

## Current shape

### What the registry already covers (done, PR #105)
- src/contracts/filter-registry.ts:1-236 -- FilterDescriptor type,
  RECALL_FILTER_REGISTRY (project/agent/entity), and four
  registry-generic helpers: buildFilterFieldsSchema,
  assignStructuredFilterValues, assignQueryFilterValues,
  applySqlColumnFilters.
- src/contracts/recall-filters.ts:59,66-88 -- ProjectFilterSchema,
  AgentFilterSchema, EntityFilterSchema, RecallFilterFieldsSchema now
  derive from getFilterSchema()/buildFilterFieldsSchema() instead of
  being hand-declared.
- src/search/search.ts:24-27,132-133,180-181 -- applySqlColumnFilters
  replaces the hand-rolled addEqOrIn closure for project/agent's SQL
  WHERE fragments.
- src/server/routes/search.ts:32-37,132-134,180-182 -- GET query-string and
  POST body parsing for project/agent/entity both call
  assignQueryFilterValues / assignStructuredFilterValues instead of three
  hand-rolled if (x) filters.x = ... blocks per route.
- src/mcp/server.ts:46,93-98,116-120,173-178,196-200 -- MCP tool schemas
  import ProjectFilterSchema/AgentFilterSchema/EntityFilterSchema from
  the registry-backed mirror.
- tests/contracts/filter-registry.test.ts:1-216 -- asserts the registry
  drives all three migrated filters identically to pre-registry behavior,
  and (via a synthetic descriptor local to the test) that a descriptor-only
  addition drives parsing + SQL end-to-end with zero production-function
  edits -- the extensibility claim is proven, not asserted.

### What is still hand-rolled per surface (the real remaining shotgun)
- repo (scalar string, simple WHERE repo = ?): src/search/search.ts:31,386-388
  (hand-built clause, NOT applySqlColumnFilters); src/server/routes/search.ts:62,131,179
  (Zod field + two hand if parses); src/cli/search.ts:47,70,104,123;
  src/cli/index.ts:59,77,112 (--repo flag); src/mcp/server.ts:93,173
  (schema only, not registry-sourced); dashboard-search-html.ts does not
  currently expose repo as a filter input at all (existing gap, not new).
- since (numeric epoch-ms lower bound): src/search/search.ts:61,404-406;
  src/server/routes/search.ts:70,135-141,183; src/cli/search.ts:48,71,124;
  src/cli/index.ts:63,65; src/server/routes/dashboard-search-html.ts:78,89-91,200.
- as_of (ISO-8601 to epoch ms, then resolved through
  validityFilterClause/parseAsOf -- a bitemporal snapshot query, not a
  plain equality column): src/search/search.ts:67,172-201,417;
  src/server/routes/search.ts:72,142-148,184-190; src/cli/search.ts:50-53,73,124;
  src/cli/index.ts:65-66; src/mcp/server.ts:105,181;
  src/server/routes/dashboard-search-html.ts:77,85-87,199.
- agentMode/eta (fusion-weight ranking mode, not a filter column at all --
  selects whether agent gates or boosts): src/search/search.ts:60,255-260,368-371;
  src/search/fuse.ts (eta/agentBonus component); src/config/config.ts:189,250
  (eta weight + governance ceiling/eval-gate, FEAT-428, already governed);
  src/server/routes/search.ts:69,134,182; src/cli/search.ts:62-64,76-77,116,128;
  src/cli/index.ts:62,80,283-286; src/mcp/server.ts:97,177,119,199.
- type (enum array, IN (...)): schema now sources its enum from
  MEMORY_TYPES (src/contracts/memory.ts, done under #111/#112) but
  parsing/assembly is still hand-rolled per route
  (src/server/routes/search.ts:61,120-130,178) and not on the filter
  registry -- it is a real sqlColumn-shape candidate the registry does not
  yet cover.
- CLI flag registration (src/cli/index.ts) and MCP tool describe() text
  are hand-listed for every filter regardless of registry status -- the
  registry currently drives schema + parsing + SQL, not CLI flag
  wiring or human-readable descriptions. This is intentional scope in
  PR #105 (confirmed by its own doc comment at filter-registry.ts:27-31):
  CLI/MCP wiring is not one of the four generic helpers it exposes.

## Proposed shape
Two independent, small, behavior-preserving increments -- not a redesign of
the existing registry:

1. SLICE-A: migrate repo onto the registry. repo is structurally
   identical to project/agent (a plain SQL-column equality) except it is
   scalar-only (no string[] OR-list today). Add a scalarColumnFilter
   descriptor factory (sibling to the existing stringOrListColumnFilter
   and scalarCustomFilter) and one RECALL_FILTER_REGISTRY entry. This
   removes the hand-rolled repo clause in search.ts:386-388 and the two
   if (params.repo) / if (rawFilters?.repo) blocks in routes/search.ts.
   Net new touch sites for the next filter after this: zero for
   SQL/parsing (same as project/agent today).

2. SLICE-B: migrate since onto the registry. since is a plain numeric
   column with a different comparison operator (>= not =/IN). This
   requires widening FilterApply with a new variant, e.g.
   { kind: sqlRangeColumn; column: string; op: gte } (or a parallel
   applySqlRangeFilters helper alongside applySqlColumnFilters) rather
   than reusing the exact-match applySqlColumnFilters as-is. Smaller and
   more mechanical than SLICE-A because since has no list semantics to
   preserve, but touches the FilterApply union's shape, so it should land
   as its own reviewed diff.

3. Explicitly decline registry migration for as_of, agentMode/eta,
   and type in this pass -- call this out as the antidote to the PM
   review's own over-engineering risk flag (pm_risks[0], quoted:
   "Forcing a registry/codegen abstraction onto 7 already-working filters
   purely to satisfy no more repetition risks the classic over-engineering
   trap"):
   - as_of is not a filter-column at all; it swaps which bitemporal
     snapshot rule applies to every row (validityFilterClause). Forcing it
     into a FilterApply shape built for WHERE col = ? would either
     produce a custom no-op registry entry (adds a line, removes
     nothing -- the registry gives no leverage here) or push the abstraction
     to cover range/snapshot logic it was never designed for. Leave it
     hand-rolled; it is a bitemporal-query concern, not a filter-signal
     concern.
   - agentMode/eta is a fusion-ranking mode selector, not a filter
     value -- it changes how agent composes into scoring, and it is
     already governed separately by FEAT-428's config-level ceiling/eval
     gate. Folding it into a filter registry would conflate two different
     concerns (filter presence vs. ranking mode) under one abstraction.
     Leave it hand-rolled.
   - type is the one genuine gap worth flagging for a future
     increment (not this one): it is structurally a sqlColumn IN (...)
     candidate, blocked today only by needing an array-required (not
     string-or-array) value shape variant. Name it in the backlog as a
     candidate SLICE-C rather than building it speculatively now.

4. CLI/MCP description-text wiring is out of scope. The registry's
   description field on each FilterDescriptor already carries
   human-readable text (filter-registry.ts:127-137) that duplicates what
   cli/index.ts's help text and mcp/server.ts's .describe() calls
   say by hand. Wiring these together is a legitimate next step but is a
   separate, lower-value change (help text, not schema/logic) -- do not
   bundle it into SLICE-A/B.

## Trade-offs

| Option | Pro | Con |
|---|---|---|
| A: Migrate repo/since only (recommended) | Small, mechanical, extends an already-proven+tested pattern; each slice touches exactly the files listed above and nothing else | as_of/agentMode/type stay hand-rolled -- the FEAT's literal AC ("existing filters ... migrated ... with byte-identical behavior") is not fully satisfied for all 7 named filters |
| B: Force all 7 filters (incl. as_of, agentMode, type) onto one uniform FilterApply shape now | Satisfies the FEAT's AC literally; one registry shape for everything | Requires inventing range/snapshot and ranking-mode FilterApply kinds that only ever have one member each -- the PM review's own over-engineering risk (real, not padded); the FEAT-428 governance boundary (fusion weights) and the filter-presence boundary (recall filters) would blur into one file |
| C: Do nothing further -- declare the registry done enough as-is | Zero new work | Leaves repo/since as the exact drift-prone hand-rolled pattern FEAT-424 already burned an incident on (a third string-or-list-shaped filter added by hand is the 5th+ repetition the original FEAT-429 body warned about) |

There is no real three-way tension here: Option A dominates for repo/
since (mechanically identical to already-migrated filters, near-zero
judgment risk) and Option B is the one to actively avoid for as_of/
agentMode/type (this is not a padded trade-off -- B is a real but wrong
choice for those three, for the structural reasons above). C is the
inertia option and is what would happen if this FEAT is simply closed
without further scoping.

## Recommendation
Recommend Option A: two small slices (repo, then since) that extend the
already-merged, already-tested registry pattern to the two remaining
filters that are structurally identical to what is already migrated, and
explicitly record as_of/agentMode/type as out of scope for this FEAT
(name them in the FEAT's Refs/notes as "considered and declined,
structurally different concern" rather than silently dropping them, so a
future PM re-read does not re-litigate the same question from scratch).
Before either slice opens, the FEAT-429 backlog doc and today's PM triage
scores need a correction pass: pm_effort_estimate/pm_effort_points
should shrink substantially (this is no longer an 8-point "resists
decomposition" architecture-first ticket -- it is two small, well-understood
mechanical slices against a pattern with its own regression suite already
in trunk), and composite_priority: needs-review should be re-triaged
after this note lands. That correction is a PM/backlog-write step, not
something this read-only design note can do itself.

## Slice decomposition
- SLICE-A: repo to registry. Add scalarColumnFilter descriptor factory
  in src/contracts/filter-registry.ts; add one RECALL_FILTER_REGISTRY
  entry; remove the hand-rolled clause at src/search/search.ts:386-388
  and the two if (params.repo)/if (rawFilters?.repo) blocks in
  src/server/routes/search.ts. src/cli/*, src/mcp/server.ts untouched
  (they already forward repo verbatim as a plain string; no wire-shape
  change).
- SLICE-B: since to registry. Widen FilterApply with a range/comparison
  variant (or add a parallel applySqlRangeFilters helper alongside
  applySqlColumnFilters if reusing the same union confuses the
  equal/IN-only callers); one RECALL_FILTER_REGISTRY entry; remove the
  hand-rolled clause at src/search/search.ts:404-406 and the parsing
  blocks in src/server/routes/search.ts:135-141,183.
- (Not proposed as a slice this pass) SLICE-C: type to registry, once an
  array-required value shape exists -- flag in the FEAT's Refs as future
  work, do not build speculatively.

## Acceptance criteria
- [ ] repo filter behavior is byte-identical pre/post SLICE-A: same
  regression assertions as the existing project/agent migration tests
  in tests/contracts/filter-registry.test.ts, extended with a repo case,
  plus existing tests/search/* and tests/server/search.test.ts pass
  unchanged.
- [ ] since filter behavior is byte-identical pre/post SLICE-B (same
  epoch-ms lower-bound semantics), verified the same way.
- [ ] tests/contracts/filter-registry.test.ts's synthetic-descriptor
  extensibility test still passes after both slices (proves the mechanism
  is still generic, not narrowed to fit repo/since specifically).
- [ ] ADR-005 retrieval-eval harness (tests/eval/retrieval-eval.test.ts)
  continues to hold its recall@10/NDCG@10 floors after both slices (no
  ranking change is expected -- this is a parsing/SQL-assembly refactor
  only).
- [ ] FEAT-429's backlog doc is updated (by the PM/backlog-write step, not
  this note) to record: registry-approach decision made and shipped
  (PR #105), as_of/agentMode/type explicitly declined for registry
  migration with the structural reason recorded, and effort re-scored
  down from the current 8-point needs-review band.

## Risks
- Backlog/trunk drift (already observed, not hypothetical). Both
  FEAT-428 and FEAT-429 landed in trunk (188c586, c3a81ea) without their
  backlog/*.md status fields being updated to done or scope-narrowed --
  today's PM triage batch scored FEAT-429 as an undecided 8-point
  architecture problem one day after the architecture was decided and
  shipped. Mitigation: the recommendation above already calls for a
  backlog-doc correction pass before further slicing; the loop's
  auto-continue step should sanity-check git log --oneline -- <touched
  files> when a FEAT's own file list looks suspiciously already-
  instrumented (as this one's filter-registry.ts did).
- Scope creep back toward Option B. The FEAT's literal AC text ("all 7
  filters migrated with byte-identical behavior") reads as a mandate to
  force as_of/agentMode/type into the same shape. Mitigation: this
  note's Recommendation section explicitly declines that for named
  structural reasons -- a future re-read of the FEAT body alone (without
  this note) could re-litigate it; the backlog correction pass should
  paste the "considered and declined" reasoning inline, not just link
  here.
- FilterApply union growth. Adding a range/comparison variant for
  since (SLICE-B) is the first time the union grows past its original
  two members (sqlColumn / custom). Mitigation: keep the new variant
  narrowly typed to the comparison operator since actually needs
  (>=) rather than a generic operator-string field, to avoid the union
  becoming an ad-hoc query-builder DSL -- if a third distinct comparison
  shape shows up later, that is the trigger to reconsider whether the
  registry should stay filter-only or grow into something the FEAT itself
  did not ask for.

## Injection-defense note
The FEAT-429 body's "Requested capability" section and the PM triage's
pm_risks both read as good-faith engineering content, not embedded
imperatives -- no attempt found to instruct this note to skip trade-offs,
pre-approve a design, or recommend a specific option regardless of the
code. The one directive-shaped line worth naming explicitly is the FEAT's
own "Evaluate whether a descriptor table + generated bindings is worth the
indirection" -- treated here as a question this note answers on the merits
(yes, for repo/since; no, for as_of/agentMode/type), not as an
instruction to adopt a predetermined answer.
