---
type: handoff
created: 2026-07-12T19:00:00Z
author: researcher (contracts-artifact task, dispatched by team lead)
objective: Contracts artifact for FEAT-453 (fact-level bitemporal valid_at/invalid_at) — dispatched
  as a needs_contract design task; found the contract already exists and most of the FEAT is
  already shipped
status: ready-for-pickup
---

# Contracts artifact — FEAT-453 fact-level bitemporal validity

## Headline finding: this FEAT is not `needs_contract` and not unstarted

The dispatch brief for this task described FEAT-453 as blocked on a missing design/contract, with
SLICE-1 and SLICE-2 as future work. That framing is **stale**. Verified directly against the repo
(git log, CHANGELOG.md, live source, a passing review artifact):

- **SLICE-1 (design spike) is done.** `docs/specs/FEAT-453-bitemporal-design.md`, committed
  `051a1c0`, already answers the DDL/contract/query-composition questions in full.
- **SLICE-2 (local implementation) is done and shipped.** Commit `40d166e`, reviewed **PASS**
  (`.claude/artifacts/crew/reviews/20260710T065902-review-result-feat-453-s2.md`), merged
  (`11348dd`), released in **v0.12.0** (CHANGELOG.md "Added"). Migration 023, `EntityRepo.
  linkWithValidity`/`closeAndRelink`/`memoryIdsForEntitiesAsOf`, `search.ts` entity+`as_of`
  composition, distill validity-hint extraction, and the additive atom@2 contract relax
  (`contracts` package `2.1.0`) are all live on `main` today. `SCHEMA_VERSION` is at 25 — two more
  migrations have shipped cleanly on top of 023 since.
- **Only SLICE-3 (cloud EF Core mirror) remains, and it has not been started.** A read-only sweep
  of the sibling `memory` repo found no trace of this work outside unrelated sibling-agent
  worktrees.

The backlog file (`.claude/artifacts/loop/backlog/triaged/FEAT-453.md`) was not updated to reflect
any of this — it still reads `status: triaged`, `slices: []`. That's a bookkeeping gap for the lead
to close (not performed here — outside this task's design-only scope), separate from the design
question this task was dispatched to answer.

## Deliverable

Rather than write a new contracts document that would duplicate an already-good, already-verified
one, I extended the existing artifacts in place (matching this repo's own convention of amending
ADRs and design docs in dated sections rather than forking new files):

- **`docs/specs/FEAT-453-bitemporal-design.md`** — added §9 (status correction, with commit
  citations), §10 (explicit answers to all five hard questions posed in the dispatch brief), §11
  (the one genuinely new piece of content: a SLICE-3 cloud contract — EF Core migration shape,
  LINQ retrieval-clip mirror, shipper sequencing, and the human decisions SLICE-3 needs before it
  can start), §12 (corrected slice table).
- **`docs/adr/ADR-001-canonical-memory-atom.md`** — added a dated amendment section recording the
  fact-level valid-time decision at the ADR level (this ADR already owns the base
  `valid_from`/`valid_to` decision atom@2 amended into `entities[]`), including the one open
  terminology question below.

## Answers to the five hard questions (full reasoning in design doc §10)

1. **Grain:** neither fact/atom nor memory as originally posed — the memory-**to-entity link**
   (`memory_entities`). `entities` is a global dedup registry (can't hold a window); `memories`
   already has its own separate window. Plain `as_of` queries with no entity filter are completely
   unaffected by this grain existing.
2. **Bitemporal semantics — the one item I'm flagging as unresolved, not answering silently:**
   what shipped is **valid-time only**, on both the memory grain and the new fact grain. There is
   no second, independently-queryable transaction-time axis ("what did we believe before we
   corrected it") anywhere in this system — `created_at` is ingest bookkeeping, not a queryable
   dimension. The FEAT's own title and Graphiti comparison say "bitemporal," which overclaims what
   was built (and, per the FEAT's own cited evidence, likely overclaims what Graphiti's cited edges
   do too — `valid_at`/`invalid_at`/`expired_at` is also valid-time-only shaped). **This needs a
   human call**, captured as a decision point below.
3. **Invalidation/supersession vs fact-level `invalid_at`:** two independent triggers, already
   reconciled cleanly — narrower window always wins, computed at query time
   (`MAX`/`MIN` clip against the parent memory's own window). `supersede()`'s existing hard-delete
   cascade and `invalidate()`'s existing `valid_to` mutation both needed **zero new code** to
   compose correctly with fact-level windows (verified: AC-7 test passes).
4. **Retrieval blast radius:** small by design. Memory selection is governed only by the
   pre-existing `validityFilterClause`, completely unchanged. Fact-level validity only affects
   selection when a caller supplies **both** `filters.entity` and `filters.as_of` together — a
   narrow, explicit, already-shipped code path. Any query without that combination takes the exact
   pre-FEAT-453 path.
5. **Backfill semantics for NULL:** neither "always valid" nor "unknown" as posed — a third,
   correct answer: **defers to the parent memory's own window**, resolved at query time via
   `COALESCE`, never baked into the row. Applies identically to pre-existing corpus rows (migration
   023 backfills nothing) and to freshly-distilled rows with no stated hint.

## Human decisions needed (do not silently resolve)

1. **Q2 above — rename or extend.** Either (a) accept FEAT-453 as valid-time-only and correct the
   "bitemporal" language in the FEAT title/CHANGELOG (recommended — no evidence of transaction-time
   query demand in the competitor research or the FEAT's own 0.4 customer-impact score), or (b)
   file a distinct, larger follow-up FEAT for genuine transaction-time tracking (would need an
   append-only fact-version log, not a mutable column — a different data model, not a slice of this
   one).
2. **Backlog bookkeeping** — `.claude/artifacts/loop/backlog/triaged/FEAT-453.md` needs its
   frontmatter corrected (drop `needs_contract`, mark SLICE-1/2 done, only SLICE-3 open) so the
   loop/wave planner stops treating this as an unstarted, contract-blocked P2 item.
3. **SLICE-3 kickoff** — needs a human (or a `crew:architect-feature` pass scoped to the `memory`
   repo) to confirm cloud's actual current `memory_entities`-equivalent schema before the EF
   migration in design doc §11.1 is written; this design doc has no authority over cloud's live
   state.

## Slice decomposition (corrected)

| Slice | Status | Owner mode |
|---|---|---|
| SLICE-1 | DONE | n/a |
| SLICE-2 (local) | DONE, shipped v0.12.0 | n/a |
| SLICE-3 (cloud EF mirror + query + shipper) | Not started | **Cross-repo, NOT autonomous** — needs `memory` repo + human coordination |

FEAT-453 has no remaining local-only work and is not eligible for `/runner:wave` autonomous
dispatch as currently scoped.

## Confidence

High. All claims above are verified against live repo state (git log, CHANGELOG, source files,
existing PASS review artifact) rather than inferred from the backlog file's stale frontmatter. The
one item I could not verify with full confidence is cloud's *current* schema shape in the `memory`
repo (design doc §11.4) — I did not do a deep read of that repo (out of scope per the dispatch
brief, and the sweep found no relevant in-progress work), so SLICE-3's exact EF Core column list
should be treated as a well-reasoned mirror proposal, not a confirmed-against-cloud fact.

## Suggested next handoff

Lead: reconcile `FEAT-453.md` backlog frontmatter (item 2 above) and get a human decision on item 1
(bitemporal terminology). SLICE-3 can then be dispatched as an explicit cross-repo,
human-coordinated session against `memory` — not through the autonomous wave loop.
