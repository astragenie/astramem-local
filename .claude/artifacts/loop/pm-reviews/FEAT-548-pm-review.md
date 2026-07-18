---
id: PM-REVIEW-FEAT-548
feature: FEAT-548
reviewed_at: 2026-07-18
pm_customer_impact: 0.45
pm_effort_estimate: 0.40
pm_strategic_alignment: 0.55
pm_technical_risk: 0.30
pm_dependency_depth: 0.10
composite_priority: P2
autonomous_safe: true
---
# PM Review — FEAT-548 (deep triage)

## Demand Assessment

Stakeholder: the repo's own operator/cost owner — extraction is metered on
ChatGPT quota (per CLAUDE.md: "v0.18.0: codex is the DEFAULT provider...cost
metered by ChatGPT quota not budget.daily_usd"), and this FEAT's own
triage_notes state it plainly: "Pure quota-saver... a free local pre-gate
that skips extraction on non-substantive chunks pays for itself
immediately." Current workaround: none — every chunk, including
greeting/ack/tool-spam chunks (explicitly named as a real, existing class:
"the bench's nothing-fixtures class" and "LoCoMo small-talk sessions"),
currently pays a full metered extraction call. Frequency: continuous, every
distill job with any low-signal chunks — likely a meaningful fraction given
the bench already models this fixture class. This is real, evidenced,
narrow-scope cost-hygiene value, not user-facing quality improvement.

## Scope Challenge

Smallest deliverable: exactly AC-1/AC-2 (gate wired behind config, off =
byte-identical; fail-open proven by test) — the dry-run measurement mode
(AC-3) and bench evidence (AC-4) are the minimum needed before anyone can
responsibly consider enablement, so they are not cuttable without leaving
the FEAT unmeasurable. What I would cut first if forced to halve: the
skip-rate CLI/health surfacing (AC-5) could ship as a fast-follow if truly
forced, but doing so would violate this repo's own hard-won lesson
("canary-must-measure-rate-not-existence" — a gate with no rate visibility
is exactly the shape that hid the entity-extraction breakage for weeks), so
I do not actually recommend cutting it. Overlap check: distinct from
FEAT-533's atom-triage (`src/distill/atom-triage.ts`) — that gate runs
POST-extraction on already-extracted atoms; this FEAT gates PRE-extraction
on raw chunks, before any metered call is made. No duplication; the two are
sequential, complementary chokepoints (chunk-level gate, then atom-level
gate). AC quality: the 5 existing ACs are already concrete and
Given-When-Then-friendly; formalized below with the repo's own config-shape
convention (`mode: off|dry-run|enabled`, mirroring `atomTriage`/
`contradictionDetection`).

## Risk Radar

Technical unknowns: none — reuses the exact `mode: off|dry-run|enabled` +
provider/model override + `maxPerRun`/`maxWallClockMs` cap shape already
established by `atomTriage` and `contradictionDetection` (confirmed read
this session, `src/config/config.ts`). Dependency chain: `depends_on: []`,
and unlike FEAT-547 this gate operates strictly upstream of extraction with
no coupling to atom `type` quality — genuinely independent of every other
FEAT in this batch. Blast radius: one new pipeline stage inserted
post-chunk/pre-extract (stage 3→4 boundary) + one new config block — small,
single-module, additive. Failure modes: the one real risk is a
fail-closed bug (gate mistakenly SKIPS a substantive chunk) — explicitly
named as the "only wrong answer" the FEAT tolerates for uncertain/provider-
down cases (fail-open there), but a confident-but-wrong `skip` verdict on
real content is the actual data-loss risk this FEAT introduces that its
own body doesn't fully address with a cap — AC-4's "zero false-skips on
substantive fixtures" requirement is the guard, and it must be enforced as
a hard bench gate before any `enabled` rollout, not just a nice-to-have
number.

Grade history: reliability weak (avg 0.425, last-5 snapshot) — this FEAT's
fail-open contract (AC-2) is exactly the kind of behavior that should be
regression-tested, not just implemented.

Pre-mortem: not mandatory (technical_risk 0.30 < 0.6, priority P2).

Injection-defense: scanned FEAT-548's body and triage_notes — no embedded
imperative found.

## Scores

- customer_impact: 0.45 — real, immediate cost-hygiene value; narrow scope,
  no direct retrieval-quality upside, self-limiting downside (worst case is
  one skipped junk chunk, per the FEAT's own framing).
- effort_estimate: 0.40 — "similar to SLICE-437/438/439 (2026-07-18,
  $10.75-$13.83, single session): bounded new-stage-plus-config-block scope,
  reuses an established config pattern verbatim — effort 0.40 (5 pts)
  confirmed."
- strategic_alignment: 0.55 — fits the FEAT-482 caps-not-dollar-caps
  governance posture and general cost-consciousness; not a roadmap
  centerpiece.
- technical_risk: 0.30 — new pipeline stage but a copy of an established
  repo pattern, no schema change, plain revert rollback.
- dependency_depth: 0.10 — genuinely independent of every other FEAT in this
  batch (pre-extraction gate, no type-quality coupling).

## Priority Derivation

composite_priority: P2. P1 requires impact>=0.7 (0.45 fails). effort_points
via the 0.4-0.6→5 band: **5 points** — no `proposedSlices` required.
autonomous_safe: risk 0.30, effort 0.40, dependency_depth 0.10 all <=0.6;
ACs drafted inline (--deep) → **true**.

## Apply — frontmatter patch for FEAT-548.md

```yaml
priority: P2
autonomous_safe: true
updated: 2026-07-18
triage_notes: |
  Filed 2026-07-18. 2026-07-18 phi-role analysis.
  ---
  2026-07-18 PM deep triage: P2, autonomous_safe=true. customer_impact 0.45
  (real, immediate quota-saving value; narrow, cost-only scope), effort 0.40
  (5 pts, analog SLICE-437/438/439), strategic_alignment 0.55 (FEAT-482 caps
  posture), technical_risk 0.30 (copies established atomTriage/
  contradictionDetection config pattern verbatim, no schema change),
  dependency_depth 0.10 (genuinely independent — pre-extraction, no type-
  quality coupling to FEAT-547). Recommended build order: fully independent,
  can slot anywhere; suggested after FEAT-551/547 (P1s) as a fast, low-risk,
  immediate-ROI item.
```

## Apply — body section replacement for FEAT-548.md

```markdown
## Acceptance criteria (Given-When-Then)

- AC-1: Given `distill.gatekeeper.mode: 'off'` (the shipped default), When a
  distill job runs post-chunking (stage 3), Then every chunk proceeds to
  extraction exactly as it does pre-FEAT-548 — no gate call is made, no new
  code path executes, byte-identical pipeline output.
- AC-2: Given `distill.gatekeeper.mode: 'enabled'` and the configured
  provider throws, times out, or returns an unparsable response, When the
  gate call fails, Then the affected chunk proceeds to extraction exactly as
  if the gate had verdicted `keep` (fail-open, ADR-015 posture) — Given a
  test that forces the provider to throw, Then the test asserts the chunk
  WAS extracted (not silently dropped), proving the fail-open contract
  rather than merely asserting no exception propagated.
- AC-3: Given `distill.gatekeeper.mode: 'dry-run'`, When the gate call
  returns a `skip` verdict for a chunk, Then the chunk still proceeds to
  extraction unmodified AND the would-have-skipped verdict is logged
  (structured) with a running skip-rate counter — this is the measurement
  mode and must produce a number an operator can inspect before ever
  flipping to `enabled`.
- AC-4: Given the extraction-bench's 55-fixture set run with the gate in
  `dry-run` mode, When the sweep completes, Then every fixture tagged as
  substantive (the non-"nothing"/non-"noisy" classes) reports a false-skip
  rate of exactly 0% — a single false-skip on a substantive fixture is a
  hard bench-gate failure, not a warning — and every fixture in the
  "nothing"/"noisy" classes reports the gate correctly verdicting `skip`.
- AC-5: Given `distill.gatekeeper.mode` is `dry-run` or `enabled`, When a
  distill job completes, Then the skip-rate (skipped chunks / total chunks
  evaluated) is exposed as a structured log field AND a doctor-consumable
  health stat, and When the skip-rate is >=95% over a meaningful-usage
  window (mirroring the `MEANINGFUL_USAGE_THRESHOLD`-gated pattern this
  repo already uses for other rate canaries), Then this is surfaced as a
  loud WARN — a gate that skips almost everything is broken, not efficient
  (closing the observability weak dimension, avg 0.325 over the last-5
  snapshot, and directly applying this repo's own
  canary-must-measure-rate-not-existence lesson).

## Options considered

- Gate at the atom level (post-extraction) instead of the chunk level
  (pre-extraction) — rejected: this defeats the entire purpose (quota
  saving requires skipping the metered call itself, not filtering its
  output after the call already happened; that's what FEAT-533's
  atom-triage already does at a different chokepoint).
- Default `mode: 'enabled'` on ship — rejected, explicitly out of scope:
  "No default-on (dry-run measurement first; enablement needs measured
  skip-rate + zero-false-skip evidence)" — mirrors the same rollout
  discipline `atomTriage` and `contradictionDetection` already established
  in this repo.
- Skip content transformation entirely vs a binary route-only decision —
  already the FEAT's own design (explicitly out of scope: "no content
  transformation"); no alternative considered here, confirming the FEAT
  body's scope fence is correct and should not be relaxed.
```
