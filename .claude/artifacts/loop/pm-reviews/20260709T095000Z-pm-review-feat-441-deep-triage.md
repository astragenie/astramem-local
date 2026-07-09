---
kind: pm-review
run: manual-deep-triage
created_at: 2026-07-09T09:50:00Z
feats: [FEAT-441]
supersedes_partial: .claude/artifacts/loop/pm-reviews/20260707T180000Z-pm-review-feat-441.md
note: >
  Per runner:pm agent Boundaries, this agent does not have an Edit tool and
  Write is scoped to exactly this directory — it does NOT rewrite backlog
  FEAT files directly. This artifact is the scoring + AC record. FEAT-441.md
  (.claude/artifacts/loop/backlog/pending/FEAT-441.md) still has
  priority/autonomous_safe: null and no `## Acceptance criteria` heading as
  of this review; the operator or /runner:backlog pm-write step must apply
  the frontmatter patch and AC section below verbatim.
---

# PM Review — FEAT-441 deep triage (2026-07-09)

## Relationship to the 2026-07-07 review

A prior review (`20260707T180000Z-pm-review-feat-441.md`) already did a
thorough pass and landed on `P1` / `autonomous_safe: false` / effort_points
5, with 6 ACs. That review was never applied to FEAT-441.md (still `null`/
`null`, no `## Acceptance criteria` heading), so this is a fresh full pass
per the current task, not a rubber stamp. Independently re-deriving the five
scores landed within 0.05 of every prior number — the two reviews converge.
This pass supersedes it on **one material point**: the grade-history input
to Framework 4 has changed since 2026-07-07 18:00, and that changes the
`autonomousSafe` justification and the AC set (added 3 ACs the prior review
didn't need).

## Pre-reads completed

- FEAT-441.md body + frontmatter in full (`.claude/artifacts/loop/backlog/pending/FEAT-441.md`, lines 1-76).
- Lessons digest: `bun src/scripts/loop.mts lessons recent 5` does not exist in
  this repo's `src/scripts/` (confirmed, same gap as the prior review). Ran it
  from the sibling `runner-plugin` checkout against this repo
  (`cd C:/work/mega/runner-plugin && bun src/scripts/loop.mts lessons recent 5
  --repo C:/work/mega/astramemory-local`), which worked. Last 5 graded slices:
  SLICE-413 (0.893), SLICE-414 (0.907), SLICE-415 (0.886), **SLICE-416 (0.231)**,
  **SLICE-417 (0.346)**. No lesson/followup names distill, durability, or
  recall-gating by domain — `demandEvidence` below is not lesson-sourced.
- **Grade history reconciliation (Framework 4) — this is the material update.**
  `.claude/artifacts/loop/loop-snapshot.md` (dated 2026-07-07, i.e. current)
  reports last-5-grade averages: `architecture_quality: 0.53 ⚠`,
  `reliability: 0.88`, `observability: 0.68 ⚠`, `production_readiness: 0.53 ⚠`,
  `security: 0.52 ⚠`, `test_confidence: 0.878`, `product_completeness: 0.55 ⚠`
  — **5 of 7 dimensions weak (<0.80)**. The prior FEAT-441 review read a
  narrower grade window (SLICE-411..415) and found `observability 0.84`
  lowest, nothing weak. Reconciled by reading the raw grade file directly:
  `.claude/artifacts/loop/grades/20260707T130414Z-feat438-slice417-grade.md`
  scores `architecture_quality: 0, production_readiness: 0, security: 0,
  product_completeness: 0, reliability: 0.80, observability: 0.80,
  test_confidence: 0.82` — SLICE-416/417 (FEAT-438, the release-materialization
  incident slices) crashed the window average once they entered the "last 5."
  **Caveat for the record**: that grade file itself is a partially-unfilled
  template (`# SLICE-417: <fill title>`, `## Lessons` → `bullet 1`/`bullet 2`
  placeholders, `## Surprises` → `bullet`) — the 0.00 scores may be real or
  may be an unreviewed default. Framework 4 says to read the signal, not
  discard it for being inconvenient, so this review treats the 5 weak
  dimensions as live and requires AC coverage for each (see ACs 6-9 below),
  but flags the data-quality caveat so a human can sanity-check it later.
- Cost analogs (Framework 5): checked `.claude/artifacts/crew/cost/*-cost-report-aggregate-*.md`
  — only `20260707T122259Z-cost-report-aggregate-feat438-slice416.md` exists,
  and it's a 6-project-mega-folder aggregate ($467.10, 267M tokens) dominated
  by unrelated repos (dev-team, memory, devops) — not a usable per-slice
  analog for a single-repo distill-pipeline feature. Read
  `20260704T110700Z-cost-report-slice-feat413-slice411.md` (closest domain
  analog: dedup/idempotency stage work) directly — `$0.0000, 0 sessions
  scanned`, unattributed telemetry, unusable. **No cost analog** — effort
  scored from the dimension table.
- Dependency check: `depends_on: []` in frontmatter confirmed. Grepped
  FEAT-437.md (P2, triaged) — one-directional consumer relationship
  ("gate reduces FEAT-437's inflow"), not a blocker either way.
- Blast-radius grounding, read directly: `src/distill/stages/05-extract.ts`
  (159 lines — extract stage, LLM JSON-mode, Zod-validated), `src/distill/stages/07-memory-normalize.ts`
  (78 lines — deterministic normalize + hash, the FEAT's own cited candidate
  gate site), `src/distill/stages/08-embed-index.ts` (127 lines — **actual
  persist call site**: `memRepo.insertWithCreateEvent(...)` at line 84, plus
  the ADR-006 erasure-replay filter at line 80 that runs immediately before
  it). `tests/distill/07-memory-normalize.test.ts` and
  `tests/distill/08-embed-index.test.ts` both exist.
- **Correction to the FEAT body's own Refs section** (same finding as the
  prior review, re-confirmed): it cites `src/server/routes/memory.ts` for
  `/remember`. That file does not contain `/remember`. Confirmed via grep
  that `/remember` lives in `src/server/routes/search.ts:202`
  (`app.post('/remember', ...)`), inserting directly via
  `MemoryRepo.insertWithCreateEvent` — bypassing the distill pipeline
  entirely today, by construction (not via any gate logic). This is good
  news for AC-5: the bypass mostly already exists structurally; the AC is
  about guaranteeing it stays true once a gate module exists that some
  future refactor might be tempted to also wire into `/remember`.
- Insertion-point finding (sharper than the prior review's "no single choke
  point found" note): the actual persist call is
  `08-embed-index.ts:84` (`memRepo.insertWithCreateEvent`), one line after
  the erasure-replay filter (`08-embed-index.ts:80`,
  `if (eventsRepo.isErasedHash(mem.finalHash)) continue;`). The gate should
  sit in that same stage, same ordering position, as a second `continue`-style
  filter — not in `07-memory-normalize.ts` as the FEAT body's Refs section
  suggests (that stage only computes `normalizedText`/`finalHash`, it never
  decides persistence). Flagged as an open architectural note for the build
  phase, not decided here — but the FEAT body's Refs section is imprecise on
  this point and a builder should read `08-embed-index.ts` first.

## Scoring

```json
{
  "featureId": "FEAT-441",
  "scores": {
    "customer_impact": 0.75,
    "effort_estimate": 0.55,
    "strategic_alignment": 0.80,
    "technical_risk": 0.55,
    "dependency_depth": 0.15
  },
  "compositePriority": "P1",
  "autonomousSafe": false,
  "demandEvidence": "Quoted directly from FEAT-441.md triage_notes: 'memory#659 (SaaS) and astramem-plugin#28 (bridge) both exist and both point at THIS repo as the right layer: the store is the last line of defense.' The 2026-07-07 recall audit (k=50, project=astramemory-local, 45 hits) independently confirms the pattern in this repo's own production data, not just the SaaS sample. Downstream cost is quantified, not vibes: FEAT-437.md's own body cites 162 pending consolidation merge proposals, 'largely junk-atom near-duplicates.' Workaround today (FEAT-437 post-hoc consolidation) is not tolerable at that volume — it dedupes after the fact, it does not stop the pollution at the source, and 162 pending proposals is described as backlog, not a solved problem. Frequency is continuous: every auto-distill job run, not an edge case.",
  "scopeNotes": "Weak grade dimensions (Framework 4, see pre-reads): architecture_quality 0.53, observability 0.68, production_readiness 0.53, security 0.52, product_completeness 0.55 (all <0.80 over the last 5 graded slices per .claude/artifacts/loop/loop-snapshot.md, driven by SLICE-416/417's crash scores). ACs 6-9 below target each. No cost analog exists (Framework 5) -- scored effort from the dimension table; pm_effort_estimate 0.55 maps to effort_points=5 (Fibonacci band [0.4,0.6)), below the FEAT-168 decomposition-gate threshold of 8, so no proposed_slices block is required. Config-knob recommendation: default `distill.durabilityGate` to `off` (not `lenient`) so day-one rollout is byte-identical to today (AC-2) -- 'lenient' as a default would still be a behavior change on day one and this repo's config is read once at boot (CLAUDE.md 'Config reload' section), so a bad default can't be hot-patched, only fixed on next restart. Implementation-detail correction for the builder: the FEAT body's Refs section names `07-memory-normalize.ts` as the candidate gate site, but the actual persist call (`memRepo.insertWithCreateEvent`) is in `08-embed-index.ts:84`, immediately after the ADR-006 erasure-replay filter at line 80 -- that's the real insertion point. Requested-capability #3's 'short-TTL side table' for rejected-candidate retention is a NEW SQLite table if implemented literally, which would push technical_risk into the 0.6-0.8 schema-change band and likely bump effort_points to 8 (requiring a proposed_slices decomposition). Recommend log-line-only retention for this slice (rotates with existing ingest.log per CLAUDE.md) and defer a structured side table to a fast-follow if regex-tuning needs richer data -- this keeps the score at technical_risk 0.55 / effort 0.55 as scored above; if a future slice-writer chooses the side-table route instead, re-score before slicing.",
  "risks": [
    "Pre-mortem Q1 (two weeks later, review/validation failure): most likely cause is the pattern-classification heuristic over-firing on a legitimate-but-terse durable atom (a short architectural decision phrased tersely, e.g. 'Chose X over Y for Z reason' truncated by the extract stage's chunking) because the pattern taxonomy was tuned against the 7-atom memory#659 sample rather than a broader corpus -- this fails silently by construction (the atom is simply never persisted) unless AC-4's observability counter and AC-1's fixture-based content assertions are both actually wired, not just the pipeline-shape tests that already exist.",
    "Pre-mortem Q2 (rollback after a bad merge): the CODE rolls back cleanly -- config default `off` + `git revert` restores byte-identical behavior (AC-2), no DB migration needed as long as rejected-candidate retention stays log-line-only per the scopeNotes recommendation (a side-table variant would need a down-migration too). But atoms gated out while the feature was live have NO rollback path at all: they were never written to the store, so there is nothing to restore from the store itself -- the only recovery is the original transcript/session content if it still exists outside the daemon. This asymmetry (omission has zero rollback path, not even a costly one) is why autonomous_safe is false below even though every mechanical threshold (risk 0.55, effort 0.55, dependency 0.15) individually sits under 0.6.",
    "Pre-mortem Q3 (existing test that would NOT catch a regression): `tests/distill/07-memory-normalize.test.ts` and `tests/distill/08-embed-index.test.ts` (both confirmed to exist) validate pipeline stage wiring, hash computation, and insert/dedup mechanics -- neither asserts that a specific atom's CONTENT is or isn't the kind that should be gated. A future extract-stage prompt change producing new phrasing not covered by the pattern list (or an over-broadened pattern) would pass every existing green test while quietly degrading recall. AC-1 and AC-3 are the only things that close this specific gap, and they must be concrete content-classification + eval-corpus assertions, not additional pipeline-shape assertions dressed up as coverage."
  ],
  "reasoning": "P1: customer_impact 0.75>=0.7 AND strategic_alignment 0.80>=0.6. technical_risk banded at 0.55 (upper end of the 0.3-0.5 new-pattern-in-repo band, pulled up by cross-module reach across the distill pipeline stage AND the /remember route, but held below 0.6 by: no new external dependency, no schema/data-shape change assuming log-line-only rejected-candidate retention, and a clean config-flag + git-revert rollback for the code itself). autonomous_safe is a deliberate PM override to false despite all three mechanical thresholds passing (<=0.6): (1) this sits on the daemon's 'last line of defense' write path across every producer with zero rollback for atoms already gated out -- an irrecoverable-omission hazard, not a recoverable-mutation hazard; (2) 5 of 7 grade dimensions are currently weak (<0.80) per Framework 4, requiring the FEAT's AC set to explicitly close each gap (ACs 6-9) before this can run unattended.",
  "acs": [
    "AC-1 (happy path, memory#659 evidence set): Given the memory#659 evidence set of 7 sample atoms (6 low-durability spanning the FEAT's own taxonomy -- ephemeral state assertion, git-derivable fact, vacuous negative, bare command, transcript path fragment, plus one more of the same class -- and 1 durable decision-with-rationale atom) and `distill.durabilityGate: strict`, When the atoms reach the persist call in `src/distill/stages/08-embed-index.ts` (the `memRepo.insertWithCreateEvent` call at line 84, not `07-memory-normalize.ts`), Then the 6 low-durability atoms are gated with a `gatedReason` value from a fixed enum (`ephemeral_state | git_derivable | vacuous_negative | bare_todo | path_fragment`) logged per atom and are never passed to `insertWithCreateEvent`, and the 1 durable atom persists unchanged with a real `memoryId`.",
    "AC-2 (gate off = byte-identical, safe default): Given `distill.durabilityGate: off` (the shipped default per this AC), When the same 7-atom evidence set is distilled, Then all 7 atoms persist exactly as they do today -- 7 rows written, no `gatedReason` field emitted anywhere, `normalizedText`/`finalHash` identical to a pre-FEAT-441 baseline run of the same input.",
    "AC-3 (ADR-005 eval regression floor + junk-pollution fixture): Given the retrieval eval harness (`tests/eval/retrieval-eval.test.ts`, fixtures at `contracts/fixtures/eval/corpus.json` / `queries.json`) run with `distill.durabilityGate: strict`, When `recallAtK` and `ndcgAtK` are computed against the existing corpus, Then recall@10 stays >= 0.9 and NDCG@10 stays >= 0.7 (today's floors, unchanged); AND Given a new junk-pollution fixture case is added (a corpus variant seeding several ephemeral/vacuous-negative junk atoms alongside the existing durable atoms for a shared query), When recall@10 is computed on that fixture both gated and ungated, Then gated recall@10 is strictly greater than ungated recall@10 on the same fixture.",
    "AC-4 (observability, gated-out count per job): Given a distill job gates out N candidate atoms during a run with `distill.durabilityGate: strict` or `lenient`, When the job completes, Then the job's structured log output includes a `gatedOutCount` field (integer) and the per-job digest/summary artifact surfaces the same count, so gate activity is auditable rather than a silent black hole -- targets observability, averaging 0.68 over the last 5 grades per `.claude/artifacts/loop/loop-snapshot.md`.",
    "AC-5 (edge case -- deliberate /remember never silently dropped): Given a `POST /remember` call to `src/server/routes/search.ts:202` with a body that would match a low-durability pattern if it arrived via auto-distill (e.g. `{ text: \"Run memory test\", type: <valid MemoryTypeEnum> }`, a 'bare command'), When the durability gate ships, Then the write is not silently gated: `/remember` either bypasses the gate entirely (confirmed by an integration test posting a body matching every pattern in AC-1 and asserting `{ id, ok: true }` with a real row persisted) or persists with an explicit warning-level log line naming the matched pattern -- but response shape (`{ id, ok: true }`) and persistence outcome must be unchanged from pre-FEAT-441 behavior.",
    "AC-6 (architecture_quality -- single choke point, no duplicated logic): Given the durability-classification logic is implemented once, When both the distill call site (`08-embed-index.ts`) and the `/remember` bypass path (`search.ts`) are inspected in review, Then the pattern-matching/classification logic exists in exactly one exported module (e.g. `src/distill/durability-gate.ts`) with no copy-pasted regex list in a second location -- targets architecture_quality, averaging 0.53 over the last 5 grades, where duplicated logic is exactly the drift class that dimension penalizes.",
    "AC-7 (security -- rejected-candidate retention passes through redaction, bounded): Given Requested-capability #3's rejected-candidate audit trail is implemented as a log line (not a new side table, per this slice's scope), When a low-durability atom is gated, Then the logged text has already passed through the same Stage-0 redaction path applied at `/remember` and ingest (SEC-3/5, per `search.ts`'s existing `redactIfEnabled` call) before it reaches any log sink, and the log line is subject to the existing `ingest.log` 10MB rotation policy (CLAUDE.md) rather than an unbounded or separately-retained sink -- targets security, averaging 0.52 over the last 5 grades.",
    "AC-8 (production_readiness -- operational visibility of gate mode): Given `distill.durabilityGate` is set to any of `strict|lenient|off` in a running install, When `node dist/cli/index.js doctor` runs, Then it reports the current gate mode as an informational row (not a WARN when `off` or `lenient`; informational-only when `strict`, since strict is opt-in) -- consistent with this repo's existing doctor WARN-row pattern for dev-pinned installs -- targets production_readiness, averaging 0.53 over the last 5 grades.",
    "AC-9 (product_completeness -- all 5 requested-capability items shipped together): Given the FEAT body's 5 numbered Requested-capability items (pattern gate, config knob, observability, ADR-005 eval evidence, /remember lenient/bypass tier), When the slice implementing this FEAT is marked complete, Then all 5 are present in the shipped diff with a corresponding AC (1-8 above) satisfied for each -- none silently deferred to a follow-up without an explicit scopeNotes call-out at slice-start -- targets product_completeness, averaging 0.55 over the last 5 grades."
  ]
}
```

## Frontmatter patch (for pm-write / operator to apply verbatim)

```yaml
priority: P1
autonomous_safe: false
relates_to: null
```

(`category` omitted -- title does not match `^(fix|hotfix):\s*`, this is a
`feat`-shaped FEAT. No `relates_to: FEAT-N` line exists in the body, per Fix
Classification rule 2 this is explicit `null`, not omitted.)

## `## Acceptance criteria` section (for pm-write / operator to insert verbatim, replacing/after `## Acceptance (proposed — re-triage)`)

```markdown
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
```

## Summary for downstream write-back

| FEAT | composite_priority | pm_effort_points | autonomous_safe | decomposition gate |
|---|---|---|---|---|
| FEAT-441 | P1 | 5 | false (irrecoverable-omission hazard on the store's last-line-of-defense write path, no rollback for already-gated atoms, PLUS 5/7 grade dimensions currently weak per updated loop-snapshot.md) | n/a (5 < 8) |

`declined_per` not applicable — not scored P4, not declined.

**Ceremony note**: this artifact does not move FEAT-441.md from
`backlog/pending/` to `backlog/triaged/`, and does not write the frontmatter
patch or AC section into the file — per this agent's Boundaries (no Edit
tool; Write scoped to `.claude/artifacts/loop/pm-reviews/` only), that is the
`/runner:triage` skill's or operator's `pm-write` step, using the patch
blocks above verbatim.
