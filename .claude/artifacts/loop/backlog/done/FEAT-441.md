---
id: FEAT-441
status: done
priority: P1
category: platform
target_release: null
created: 2026-07-07
depends_on: []
slices: [SLICE-419]
derived_from: "memory#659 + recall-audit-2026-07-07"
tags: ["concern:recall", "concern:quality", "surface:distill", "surface:ingest", "stack:typescript"]
autonomous_safe: false
relates_to: null
triage_notes: "Daemon-side owner ticket for the cross-repo recall-pollution problem. memory#659 (SaaS) and astramem-plugin#28 (bridge) both exist and both point at THIS repo as the right layer: 'the store is the last line of defense.' 2026-07-07 recall audit (k=50, project=astramemory-local, 45 hits) confirms: large fraction of atoms are ephemeral status ('A task is currently running'), bare commands ('Run memory test'), transcript path fragments. These junk atoms also generate most of the 162 pending consolidation merge proposals (FEAT-437's backlog)."
started_at: 2026-07-09
updated: 2026-07-09
slices_complete: [SLICE-419]
completed_at: 2026-07-09
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

## Acceptance criteria

- AC-1 (happy path, memory#659 evidence set): Given the memory#659 evidence
  set of 7 sample atoms (6 low-durability spanning the FEAT's own taxonomy —
  ephemeral state assertion, git-derivable fact, vacuous negative, bare
  command, transcript path fragment, plus one more of the same class — and 1
  durable decision-with-rationale atom) and `distill.durabilityGate: strict`,
  When the atoms reach the persist call in `src/distill/stages/08-embed-index.ts`
  (the `memRepo.insertWithCreateEvent` call at line 84, not
  `07-memory-normalize.ts`), Then the 6 low-durability atoms are gated with a
  `gatedReason` value from a fixed enum (`ephemeral_state | git_derivable |
  vacuous_negative | bare_todo | path_fragment`) logged per atom and are
  never passed to `insertWithCreateEvent`, and the 1 durable atom persists
  unchanged with a real `memoryId`.
- AC-2 (gate off = byte-identical, safe default): Given
  `distill.durabilityGate: off` (the shipped default per this AC), When the
  same 7-atom evidence set is distilled, Then all 7 atoms persist exactly as
  they do today — 7 rows written, no `gatedReason` field emitted anywhere,
  `normalizedText`/`finalHash` identical to a pre-FEAT-441 baseline run of
  the same input.
- AC-3 (ADR-005 eval regression floor + junk-pollution fixture): Given the
  retrieval eval harness (`tests/eval/retrieval-eval.test.ts`, fixtures at
  `contracts/fixtures/eval/corpus.json` / `queries.json`) run with
  `distill.durabilityGate: strict`, When `recallAtK` and `ndcgAtK` are
  computed against the existing corpus, Then recall@10 stays >= 0.9 and
  NDCG@10 stays >= 0.7 (today's floors, unchanged); AND Given a new
  junk-pollution fixture case is added (a corpus variant seeding several
  ephemeral/vacuous-negative junk atoms alongside the existing durable atoms
  for a shared query), When recall@10 is computed on that fixture both gated
  and ungated, Then gated recall@10 is strictly greater than ungated
  recall@10 on the same fixture.
- AC-4 (observability, gated-out count per job): Given a distill job gates
  out N candidate atoms during a run with `distill.durabilityGate: strict`
  or `lenient`, When the job completes, Then the job's structured log output
  includes a `gatedOutCount` field (integer) and the per-job digest/summary
  artifact surfaces the same count, so gate activity is auditable rather
  than a silent black hole.
- AC-5 (edge case — deliberate /remember never silently dropped): Given a
  `POST /remember` call to `src/server/routes/search.ts:202` with a body
  that would match a low-durability pattern if it arrived via auto-distill
  (e.g. `{ text: "Run memory test", type: <valid MemoryTypeEnum> }`, a "bare
  command"), When the durability gate ships, Then the write is not silently
  gated: `/remember` either bypasses the gate entirely (confirmed by an
  integration test posting a body matching every pattern in AC-1 and
  asserting `{ id, ok: true }` with a real row persisted) or persists with
  an explicit warning-level log line naming the matched pattern — but
  response shape (`{ id, ok: true }`) and persistence outcome must be
  unchanged from pre-FEAT-441 behavior.
- AC-6 (architecture — single choke point, no duplicated logic): Given the
  durability-classification logic is implemented once, When both the
  distill call site (`08-embed-index.ts`) and the `/remember` bypass path
  (`search.ts`) are inspected in review, Then the pattern-matching /
  classification logic exists in exactly one exported module (e.g.
  `src/distill/durability-gate.ts`) with no copy-pasted regex list in a
  second location.
- AC-7 (security — rejected-candidate retention passes through redaction,
  bounded): Given Requested-capability #3's rejected-candidate audit trail
  is implemented as a log line (not a new side table, per this slice's
  scope), When a low-durability atom is gated, Then the logged text has
  already passed through the same Stage-0 redaction path applied at
  `/remember` and ingest (SEC-3/5, per `search.ts`'s existing
  `redactIfEnabled` call) before it reaches any log sink, and the log line
  is subject to the existing `ingest.log` 10MB rotation policy (CLAUDE.md)
  rather than an unbounded or separately-retained sink.
- AC-8 (production readiness — operational visibility of gate mode): Given
  `distill.durabilityGate` is set to any of `strict|lenient|off` in a
  running install, When `node dist/cli/index.js doctor` runs, Then it
  reports the current gate mode as an informational row (not a WARN when
  `off` or `lenient`; informational-only when `strict`, since strict is
  opt-in).
- AC-9 (product completeness — all 5 requested-capability items shipped
  together): Given the FEAT body's 5 numbered Requested-capability items
  (pattern gate, config knob, observability, ADR-005 eval evidence,
  /remember lenient/bypass tier), When the slice implementing this FEAT is
  marked complete, Then all 5 are present in the shipped diff with a
  corresponding AC (1-8 above) satisfied for each — none silently deferred
  to a follow-up without an explicit scopeNotes call-out at slice-start.

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
