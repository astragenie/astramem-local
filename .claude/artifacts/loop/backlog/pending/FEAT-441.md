---
id: FEAT-441
status: pending
priority: null
category: platform
target_release: null
created: 2026-07-07
depends_on: []
slices: []
derived_from: memory#659 + recall-audit-2026-07-07
tags: [concern:recall, concern:quality, surface:distill, surface:ingest, stack:typescript]
autonomous_safe: null
triage_notes: "Daemon-side owner ticket for the cross-repo recall-pollution problem. memory#659 (SaaS) and astramem-plugin#28 (bridge) both exist and both point at THIS repo as the right layer: 'the store is the last line of defense.' 2026-07-07 recall audit (k=50, project=astramemory-local, 45 hits) confirms: large fraction of atoms are ephemeral status ('A task is currently running'), bare commands ('Run memory test'), transcript path fragments. These junk atoms also generate most of the 162 pending consolidation merge proposals (FEAT-437's backlog)."
---

# FEAT-441: distiller durability quality gate — stop persisting low-signal atoms at the store layer

## Problem

The auto-distillation pipeline persists low-durability fragments alongside real
decisions/lessons: ephemeral state assertions ("Trunk status is green", "A task
is currently running"), git-derivable trivia (commit SHAs, "file X changed"),
vacuous negatives ("no token handling identified"), bare todos/commands with no
rationale, transcript path fragments. They get embedded, indexed, served by
recall, and spawn most consolidation merge-proposal churn. memory#659 documents
a session where only 1 of 7 auto-captured atoms was durable.

The gate belongs here (per #659's own analysis): the plugin can pre-filter, but
the daemon store is the shared choke point for every producer — auto-distiller,
deliberate `/remember`, MCP, future clients.

## Requested capability

A durability gate in the distill write path (and optionally `/remember`):

1. Reject/skip low-durability patterns at atom-persist time:
   - ephemeral state assertions ("X is green/passing/running/present")
   - git-derivable facts (commit SHAs, branch status, file-changed notices)
   - vacuous negatives ("no X identified/found")
   - bare todos/commands with no why/how
   - transcript/path fragments with no proposition
2. Config knob (e.g. `distill.durabilityGate: strict|lenient|off`, default
   preserving current behavior until eval'd — re-triage may choose default-on).
3. Observability: gated-out count per distill job in logs + digest, so the gate
   is auditable rather than a silent black hole; rejected candidates retained in
   a short-TTL side table or log line for tuning.
4. Eval evidence per ADR-005 discipline: recall@10/NDCG@10 harness must not
   regress; add a junk-pollution fixture case demonstrating gated recall beats
   ungated.
5. Deliberate `/remember` writes bypass or get a lenient tier — a human explicit
   save outranks heuristics (matches #659's observation that deliberate
   remembers are the good shape).

## Acceptance (proposed — re-triage)

- Given the #659 evidence set (7 sample atoms), When distilled with the gate on,
  Then the 6 low-durability ones are gated with logged reasons and the 1 durable
  one persists.
- Given the gate is `off`, behavior is byte-identical to today.
- Retrieval eval harness passes with gate on; junk-pollution fixture shows
  improvement.
- Gated-out count visible per job (log + dashboard/digest counter).
- Deliberate `/remember` with explicit content is not silently dropped (lenient
  tier or bypass + warning).

## Refs

- SaaS mirror ticket: astragenie/memory#659 (keep contracts aligned — whatever
  pattern taxonomy lands here should be what SaaS mirrors).
- Bridge pre-filter: astragenie/astramem-plugin#28.
- Consumer symptom: FEAT-437 (162 pending merge proposals, largely junk-atom
  near-duplicates) — gate reduces FEAT-437's inflow.
- Distill pipeline: `src/distill/stages/05-extract.ts` (extract), reduce +
  memory-normalize stages (candidate gate site), `src/server/routes/memory.ts`
  (`/remember`).
