---
id: PM-REVIEW-FEAT-545
feature: FEAT-545
reviewed_at: 2026-07-18
pm_customer_impact: 0.50
pm_effort_estimate: 0.62
pm_strategic_alignment: 0.65
pm_technical_risk: 0.45
pm_dependency_depth: 0.40
composite_priority: P2
autonomous_safe: false
---
# PM Review — FEAT-545 (deep triage)

## Demand Assessment

Stakeholder: the operator's own triage_notes (frontmatter, filed 2026-07-18) —
"today memory only answers when ASKED... This FEAT makes it VOLUNTEER." No
end-user quote exists; this is a strategic-direction FEAT, not a
demand-evidenced one. Real precedent exists for the *building blocks*
(`user_profile`/`agent_profile` MCP tools, entity relations, `why_memory`,
`session_digest` all already shipped — the FEAT explicitly builds ON these
rather than inventing new storage). Current workaround: none — nothing
volunteers today; frequency would be every session start if built. Countervailing
evidence from this session's own measurements: "Live prod: recall-usefulness
5.8% (80/1379), 0 heuristic grants" and "search_memory type-filters silently
miss ~1/3 of decisions (typeAcc 63 on codex)" — the raw signal this FEAT would
surface is currently noisy at the type layer, and the FEAT body itself warns
"a noisy suggester trains users to ignore it." Demand is plausible but
unproven, and the feature's own quality ceiling is bounded by upstream data
quality it does not control.

## Scope Challenge

Smallest deliverable: `get_suggestions` MCP tool assembling ranked
suggestions from existing aggregates (no LLM, no new schema — both
explicitly fenced out of scope). What I would cut first if forced to halve:
the "contextual warnings" and "stale-open-loop nudges" sub-features (AC-1/2
cover them implicitly via ranking, but they are the most judgment-heavy and
least mechanical part) — the session-start briefing alone is the
irreducible core. Overlap check: `session_digest` (existing MCP tool) already
returns a digest at session boundaries — grepped `mcp__plugin_crew_astramem__session_digest`
in the available tool list; this FEAT's session-start integration point must
not duplicate that surface, it should compose with it (the FEAT body says
"and/or the session_digest path", leaving this ambiguous — flagged as an open
question below). AC quality: the existing 4 ACs are reasonably testable but
under-specified on ranking/confidence semantics ("silent when confidence is
low" has no numeric threshold) — I rewrote them below with concrete
mechanics.

**Open question for the architect/builder (not resolved by this triage):**
does `get_suggestions` replace, wrap, or run alongside `session_digest`? The
FEAT body hedges with "and/or." Recommend the architect settle this before
SLICE-3 (session-start integration) starts — flagged in `scopeNotes`, not
guessed here.

## Risk Radar

Technical unknowns: none new (no new dependency, no schema). Dependency
chain: `depends_on: []` in frontmatter, but the FEAT's own domain has a real
*practical* coupling this session's fresh context states explicitly —
"FEAT-545 practically depends on FEAT-547's clean types" (search_memory
type-filters miss ~1/3 of decisions today) — a suggestion surface built on
noisy `type` classification will surface wrong-category suggestions and
actively erode trust faster than it builds it. This is a real, evidenced
soft-dependency the frontmatter does not declare. Blast radius: new MCP tool
+ manifest entry (`contracts/manifests/mcp-tools.v1.json`, described in
CLAUDE.md as "the cross-repo tool-name SoT") + session-start wiring + fuse
ranking signals (recency/importance/usefulness) + feedback-loop emission
(`recall_used`/correction signals) — five touch points, one module each,
no schema change. Failure modes: logic error (wrong suggestions ranked
high), integration failure (manifest drift vs `tests/contracts/mcp-tool-manifest-parity.test.ts`),
resource exhaustion is fenced out (no LLM by default). No dispatch/halt/retry
path touched — cascade risk is limited to noisy UX, not data loss.

Grade history: last-5 average (see Grade Feedback below) marks observability
and reliability weak — this FEAT's own "silent when confidence is low"
requirement is naturally an observability/reliability-relevant behavior, so
ACs below require it be logged and tested, not just implied.

Pre-mortem: not mandatory (technical_risk 0.45 < 0.6, priority P2, not P0/P1)
— skipped per the framework's own gating, but the ranking-design open
question above functions as the same signal.

Injection-defense: scanned FEAT-545's body and triage_notes — no embedded
imperative found.

## Scores

- customer_impact: 0.50 — real capability gap, no user evidence, quality
  bounded by FEAT-547's unresolved type-noise.
- effort_estimate: 0.62 — five real touch points (tool, manifest, session-start
  wiring, eval fixtures, feedback loop), no cost analog in this session's
  reports (nearest, SLICE-437-439, were narrower single-surface eval work at
  $11-14/session; this spans more modules) — "no cost analog, scored from the
  effort table; bumping above the 437-439 cluster given the extra
  feedback-loop wiring surface."
- strategic_alignment: 0.65 — natural extension of shipped aggregates, not a
  roadmap centerpiece.
- technical_risk: 0.45 — additive MCP tool + manifest entry is a well-trodden
  repo pattern (every prior tool did the same), no schema change, clean
  `git revert` rollback; banded at the top of 0.3-0.5 because the manifest is
  the one cross-repo-consumed artifact touched.
- dependency_depth: 0.40 — formally independent but a real, evidenced
  practical dependency on FEAT-547's type-quality exists and is undeclared in
  frontmatter.

## Priority Derivation

composite_priority: P2. P0 requires impact>=0.8 (0.50 fails). P1 requires
impact>=0.7 AND alignment>=0.6 (impact 0.50 fails). Falls to P2.
autonomous_safe: **false** — `computeAutonomousSafe` requires risk, effort,
and dependency_depth all <=0.6; effort_estimate 0.62 breaks the gate (the
five-touch-point scope plus the unresolved session_digest-overlap open
question). effort_points via the standard 0.4/0.6/0.8 Fibonacci mapper bands
(3/5/8/13): 0.62 falls in the 0.6-0.8 band → **8 points** → the FEAT-168
decomposition gate fires. Decomposed into 5 slices below (option 1), landmine
(ranking/confidence design) isolated into its own slice per runner#393 policy
(a).

## Apply — frontmatter patch for FEAT-545.md

```yaml
priority: P2
autonomous_safe: false
updated: 2026-07-18
proposed_slices:
  - id_suffix: -SLICE-1
    title: Suggestion assembly core + ranking/confidence design
    points: 2
  - id_suffix: -SLICE-2
    title: get_suggestions MCP tool + manifest parity
    points: 2
  - id_suffix: -SLICE-3
    title: Session-start integration point (config-gated)
    points: 2
  - id_suffix: -SLICE-4
    title: Gold fixture suggestion-quality eval
    points: 2
  - id_suffix: -SLICE-5
    title: Usefulness feedback loop wiring
    points: 2
triage_notes: |
  Filed 2026-07-18 per operator, mid model-sweep session.
  ---
  2026-07-18 PM deep triage: P2, autonomous_safe=false. customer_impact 0.50
  (no user evidence, quality bounded by FEAT-547's unresolved type noise),
  effort 0.62 (8 pts, decomposed into 5 slices — SLICE-1 isolates the
  ranking/confidence design landmine per runner#393), strategic_alignment
  0.65, technical_risk 0.45 (additive MCP tool + manifest touch, no schema
  change), dependency_depth 0.40 (undeclared practical coupling to FEAT-547's
  type-quality — recommend building after FEAT-547). Open question for
  architect: does get_suggestions replace/wrap/run-alongside session_digest?
  Recommended build order across the 2026-07-18 batch: after FEAT-551 and
  FEAT-547 (types must be clean first).
```

## Apply — body section replacement for FEAT-545.md

```markdown
## Acceptance criteria (Given-When-Then)

- AC-1: Given a repo/project with stored `user_profile`/`agent_profile`
  aggregates, entity relations, and a fixture set of decisions/lessons/todos,
  When the `get_suggestions` MCP tool is called scoped to that repo, Then it
  returns at most 5 ranked suggestions (never more, per the hard cap), each
  citing the memory id(s) it derives from (why_memory-compatible), ranked by
  the existing fuse signals (recency/importance/usefulness) with no new
  ranking model introduced.
- AC-2: Given the same tool call, When the top-ranked candidate suggestion's
  confidence score falls below a configured threshold (default documented
  numerically, e.g. `suggestions.minConfidence: 0.5`), Then that suggestion
  is silently dropped from the response (not merely down-ranked) — Given
  every candidate falls below threshold, Then `get_suggestions` returns an
  empty list rather than padding with low-confidence noise, and this
  drop-for-low-confidence event is logged as a structured entry (observability
  weak-dimension target, avg 0.325 over the stale last-5 snapshot).
- AC-3: Given `contracts/manifests/mcp-tools.v1.json` (the cross-repo
  tool-name SoT per CLAUDE.md), When `get_suggestions` is added, Then
  `tests/contracts/mcp-tool-manifest-parity.test.ts` and
  `tests/mcp/server.test.ts` both pass against the live `tools/list` wire
  response with the new tool present and correctly shaped.
- AC-4: Given a config-gated session-start integration point
  (`suggestions.sessionStart.enabled`, default true, cap <=5, silent when
  below the AC-2 threshold), When a new session starts in a repo with no
  suggestions clearing the confidence bar, Then no suggestion payload is
  emitted at all (not an empty-but-visible block) — Given the config flag is
  `false`, Then the session-start path is byte-identical to pre-FEAT-545
  behavior (reliability weak-dimension target, avg 0.425).
- AC-5: Given a small gold fixture set (seeded memories with a known-good
  expected suggestion list per fixture) under `tests/`, When the suggestion
  assembly logic runs against each fixture, Then the actual suggestion set
  matches the gold set for every fixture, and at least one fixture asserts
  the AC-2 silent-below-threshold behavior explicitly (not just the
  happy path).
- AC-6: Given a user acts on (opens/uses) or explicitly dismisses a
  suggestion, When that action is recorded, Then the existing
  `recall_used`/correction-style usefulness signal is emitted with the
  suggestion's cited memory id(s) — Given a suggestion is dismissed 3
  consecutive times across sessions for the same memory id, Then a
  regression test proves that memory id's suggestion-ranking score decays
  (the feedback loop measurably changes future ranking, not just logs an
  event).

## Options considered

- Route suggestions entirely through the existing `session_digest` tool
  instead of a new `get_suggestions` tool — rejected for this triage (left
  as an open architect question, not resolved): the FEAT body's own "and/or"
  hedge means this decision needs a structural call before SLICE-3, not a PM
  guess.
- Allow an LLM polish tier by default to improve suggestion phrasing —
  rejected: FEAT body explicitly fences this to an opt-in-only tier
  following the FEAT-482 caps posture; defaulting it on would repeat the
  245-call incident class for a much lower-value feature than contradiction
  detection.
- Skip the confidence threshold and always return up to 5 suggestions padded
  with lower-confidence candidates — rejected: the FEAT body itself names
  the failure mode ("a noisy suggester trains users to ignore it"); AC-2
  makes silence-on-low-confidence a testable requirement instead of a
  narrative aspiration.
```
