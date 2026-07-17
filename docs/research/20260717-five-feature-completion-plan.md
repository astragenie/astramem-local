# Completion plan — FEAT-484 / 485 / 486 / 493 / 535 (2026-07-17)

status: PLAN — not yet dispatched. Four of these (484/485/486/493) are `priority: null`
(never PM-triaged; created via free-text intake). This plan folds scope+AC inline so
they're buildable without a separate triage pass, but flag: no formal PM score exists.

Common constraints: branch off origin/main; one owner per file; PRs with `hold` label
(auto-merge is opt-out); do NOT touch `src/cli/serve.ts` / `src/service/instance-lock.ts`
(Lane-A owner) or the prod daemon / overnight LoCoMo GPU.

---

## Grouping (by shared surface, so agents don't collide)

- **Cluster P — Provenance (484 + 485):** both live on the capture-envelope → distill
  provenance path; share an investigation. ONE owner, sequential. Highest correctness
  value (they make memories auditable + recall-reachable).
- **486 Temporal:** standalone, research-first, biggest LoCoMo lever (+4 F1). Needs an
  eval re-run to validate — GPU-gated (blocked while overnight LoCoMo owns the GPU).
- **493 Retention:** standalone platform, disk-artifact axis only. Bounded finish of
  clamped-off deletion. Independent files.
- **535 Ingestions page:** standalone dashboard feature. Independent files.

484+485 must be one lane (shared files). 486 / 493 / 535 are mutually independent and
can each run in parallel with cluster P.

---

## FEAT-484 — Worktree repo-identity provenance bug (issue #177)

**What's wrong:** memories distilled from subagent sessions in git worktrees get stamped
`repo='agent-<hash>'` (the worktree DIRECTORY basename) instead of `astramemory-local`.
Three compounding harms: repo-scoped recall misses them; consolidation groups per
(repo,type) so they never dedupe against main-checkout equivalents; the worktree dir is
deleted so `repo` points at a vanished path. Worsens continuously — worktree agents are
now the standard pattern.

**Plan (bug fix + backfill):**
1. **Locate** where the capture envelope's `repo` is derived — hook side (the capture
   hook that builds the envelope) AND/OR `src/distill` provenance stamping. Trace the
   field from ingest → transcripts row → memory.
2. **Fix:** resolve repo identity from `git rev-parse --git-common-dir` (a worktree's
   common-dir points at the main checkout's `.git`) or the `origin` remote URL, NOT the
   working-directory basename. A worktree then resolves to the same identity as its
   main checkout.
3. **Backfill migration:** one-shot re-stamp of existing `agent-*` repo rows to the
   resolved identity (many already exist on this box). Idempotent; dry-run first.
   MIGRATION HAZARD: re-stamping changes consolidation grouping keys — verify it doesn't
   collide/merge unrelated memories; test on a copy.
4. **Canary (AC):** ingest from a worktree, assert the memory carries the project repo
   name, not the worktree basename.

**Owner:** builder. **Files:** capture-hook repo derivation + `src/distill` provenance;
a new migration for backfill. **Gate:** review + the canary test + backfill dry-run
evidence. **Risk:** backfill (data migration — "verify, don't migrate" lesson; accept
both forms, PAST-anchored fixtures).

---

## FEAT-485 — Evidence/source provenance population (partial; guard+canary #291 shipped)

**What's wrong:** provenance machinery is complete but the DATA is missing. Live sample
(2026-07-13, ~14k memories): evidence excerpt 1/10, transcript_ref 0/10, session 0/10.
An older memory (53211546, repo=runner) DID carry them → this is a path-dependent gap or
REGRESSION, not never-worked. Consequence: can't answer "where did this come from?" for
~90% of memories; hallucinated/inverted facts can't be traced.

**Plan (investigate-first — there may be a regression):**
1. **Find the drop point:** why do today's ingests lose transcript_ref/session while an
   older one kept them? Compare hook-built envelopes vs direct wire callers vs the spool
   drain path. This is a git-archaeology + live-trace task — likely a regression in one
   ingest path. Fix it so the fields are populated at write time.
2. **Make the evidence requirement bite:** measure evidence-population RATE per
   profile/model; consider making `evidence` non-optional for lesson/decision atoms
   (the types whose value IS the reasoning).
3. **Doctor canary:** mirror `checkEntityRelations` (SLICE-430) — WARN when recent
   distill activity exists but evidence-population rate < floor, splitting "model never
   emits evidence" from "pipeline drops it" (rate canary, not existence — ADR-015).
4. **Dashboard/why surface:** click a memory → see its source excerpt.
5. **Canary (AC):** ingest a transcript, assert the memory carries BOTH an evidence
   excerpt AND a resolvable transcript_ref + session (not merely that columns exist).

**Owner:** SAME as 484 (shared provenance path — sequential, not parallel). **Files:**
ingest provenance path (overlaps 484's investigation), `src/distill`, a doctor check,
dashboard why. **Gate:** review + the live canary + a before/after population-rate number.
**Sequence:** do 484 first (repo identity) then 485 (other provenance fields) — same lane.

---

## FEAT-486 — Temporal answer path (biggest LoCoMo lever)

**What's wrong:** temporal category scores F1 12.4 (16.2% of LoCoMo questions) while every
other category is healthy (adversarial 83, single-hop 44). Bitemporal machinery exists
(entity_relations valid_from/to, memory_events history, get_entity_timeline asOf) but the
recall/answer path never uses time — it retrieves by hybrid similarity and hands flat text
to the answerer. Lifting temporal 12→35 is ~+4 overall F1, the single largest measured lever.

**Plan (RESEARCH-FIRST — cheap win may precede the expensive one):**
1. **Confirm the diagnosis:** inspect what the answerer actually RECEIVES for temporal
   questions — are dates in the retrieved atoms even present/usable? (Do NOT assume.)
2. **Cheap win first:** LoCoMo temporal asks about date relationships WITHIN retrieved
   content ("how long ago was X"), not as-of-knowledge. So the first lever is likely
   just making sure dates SURVIVE extraction and reach the answerer intact — much cheaper
   than an as-of retrieval mode. Check this before building the expensive thing.
3. **If needed:** surface each memory's valid-time/observed-time to the recall pack; then
   consider an as_of-aware retrieval path (cloud engine + get_entity_timeline already model it).
4. **Validate (AC):** re-run the LoCoMo 10% sample, show temporal F1 materially above 12.4
   with the other four categories NOT regressing — especially adversarial 83 (a system that
   starts guessing dates could lose abstention discipline).

**Owner:** researcher (steps 1-2) → builder (3). **GPU-GATED:** validation needs a LoCoMo
re-run — blocked until the overnight qwen3:8b run frees the GPU, OR run the diagnosis
(steps 1-2, no eval) now and defer the validated build. **Files:** `src/search` recall
pack, extraction date-survival, answerer prompt. **Gate:** the LoCoMo re-run number.
**Note:** highest value of the five; also the most uncertain (research-first).

---

## FEAT-493 — Tiered retention, disk-artifact axis (partial; scaffolding #317, deletion clamped OFF)

**What's wrong:** three-tier retention (Media/Lean/All) was scaffolded (#317) but real
tiered deletion is clamped off. Users have no dial for disk growth (the always-on-daemon
complaint) beyond keep-or-wipe.

**Plan (finish the clamped-off deletion):**
1. **Mode enum + per-tier delete scope:** `Media` = keep all DB rows searchable, reclaim
   heavy binary artifacts on disk; `Lean` = also strip heavy derived payloads (keep
   distilled memories + transcripts searchable — actually shrinks DB); `All` = wipe past cutoff.
2. **Un-clamp deletion** behind the config gate, with a dry-run mode that reports what
   WOULD be reclaimed first. Sane default window + sanity ceiling on the days value.
3. **BOUNDARY (arch review 2026-07-14):** `src/storage/archival.ts` (FEAT-404) owns the
   MEMORY-ROW axis. FEAT-493 owns the DISK-ARTIFACT axis ONLY — never touch memory rows,
   don't entangle with archival.ts. Distilled memories are NEVER deleted by Media/Lean.
4. **Doctor stat:** disk usage by category + last sweep result.
5. **AC:** dry-run correctness + Media/Lean preserve distilled memories + a live sweep
   reclaims disk without touching memory rows.

**Owner:** builder. **Files:** `src/storage/retention.ts` (+ config, a doctor stat).
Independent of clusters. **Gate:** review + dry-run evidence + "distilled memories
survive" test. **Risk:** deletion is irreversible — dry-run + the archival.ts boundary
are the guardrails.

---

## FEAT-535 — Dashboard Ingestions page (scoped, not built)

**What it is:** a dashboard page listing every ingestion with source navigation (view
stored transcript / audio / document), re-extract action, project + time filters,
reusing the existing jobs table + dashboard page pattern. Full feasibility scan already
in the FEAT file (data + infra exist: `transcripts` table, `capture_source` enum,
`sessions.project` + `captured_at`, `dashboard-jobs-html.ts` pattern, `cli/rebuild.ts`
re-extract path).

**Plan:**
1. `GET /dashboard/ingestions` — paginated list (one row per transcripts/distill job),
   columns: time, project, agent, source type, atom yield, source-availability.
   Index-backed LIMIT/OFFSET (transcripts grows unbounded).
2. Filters: project, agent, time-range (reuse search dashboard's date control), source-type.
3. Row → source view: text renders stored transcript; audio/document serves the
   `<dataDir>/artifacts/<kind>/<file>` via a SAFE path-scoped route (no traversal, inherit
   dashboard auth). Gate on source-availability.
4. Row → re-extract: enqueue a fresh distill job on the retained source (reuse jobs table;
   surface on the jobs page). Dedup: a re-extract must supersede/dedupe prior atoms from
   that session, not double-store — check the consolidation/idempotency path.
5. **RESOLVE FIRST (risk in the FEAT):** does retention (now FEAT-493!) PRUNE
   transcripts/artifacts? If yes, re-extract is impossible for pruned rows — the page MUST
   show source-available vs source-pruned per row and disable re-extract when gone.
   → 535 has a soft dependency on 493's retention semantics; sequence 493 before (or
   coordinate with) 535's re-extract gating.

**Owner:** frontend/fullstack builder. **Files:** new `dashboard-ingestions-html.ts` +
nav entry + a file-serve route; reuse jobs/distill enqueue. Independent of clusters.
**Gate:** review + validation (list renders, filters work, re-extract enqueues + dedupes,
file route is traversal-safe). **Out of scope v1:** editing source, bulk re-extract.

---

## Recommended sequencing

Parallel lanes (respecting file ownership):
- **Lane P (serial):** 484 → 485 (shared provenance path, one owner).
- **Lane R (research now, build/validate GPU-gated):** 486 diagnosis (steps 1-2) can start
  immediately read-only; the validated build waits for GPU (post-LoCoMo).
- **Lane D:** 493 (retention) — independent, bounded, buildable now.
- **Lane U:** 535 (Ingestions page) — independent; but coordinate re-extract gating with
  493's prune semantics (do 493 first or stub the availability check).

Value order if picking one at a time: **486** (biggest measured F1 lever, but research-first
+ GPU-gated) → **484+485** (correctness/auditability, growing problem) → **493** (user-facing
disk dial) → **535** (net-new UX, depends on 493's prune semantics).

Dependencies to honor: 535 ↔ 493 (retention prune vs re-extract availability); 484 before
485 (same lane); 486 build ↔ GPU free.
