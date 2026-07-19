---
id: FEAT-545
status: pending
priority: P2
category: feature
target_release: null
created: 2026-07-18
updated: 2026-07-18
depends_on: []
slices: []
derived_from: operator request 2026-07-18 (mid model-sweep session)
cross_product: [astramem-local, astramem-plugin]
autonomous_safe: false
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
---
## Description

**Proactive suggestions from profile + project memory.**

Memory currently answers questions; it never volunteers. Build a suggestion surface that
combines the existing `user_profile` / `agent_profile` aggregates with per-project memory
(decisions, lessons, todos, entity relations) to proactively surface:

- **Session-start briefing**: "Last session in this repo you decided X, left TODO Y open,
  and the lesson Z applies to what you're about to touch" — a ranked, small (≤5) list,
  deliverable via a new MCP tool (`get_suggestions`) and/or the session_digest path.
- **Contextual warnings**: when current work touches an entity with a stored lesson or
  superseded decision ("you reverted this approach on 2026-06-30 — see DEC-048").
- **Stale-open-loop nudges**: todos/commitments past their implied window.

Grounding rules: every suggestion cites its memory ids (why_memory-compatible), ranked by
the existing fuse signals (recency/importance/usefulness), hard-capped count, and silent
when confidence is low — a noisy suggester trains users to ignore it.

## Explicitly out of scope

- No LLM calls in the suggestion path by default (assemble from stored aggregates; an
  optional LLM polish tier must follow the FEAT-482 caps posture).
- No new storage schema — reads existing tables/profiles only.

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
