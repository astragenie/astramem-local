---
id: FEAT-448
status: pending
priority: P2
category: platform
target_release: null
created: 2026-07-09
depends_on: [FEAT-441]
blocks: ["FEAT-441 default-on (distill.durabilityGate: lenient|strict)"]
slices: []
derived_from: SLICE-419 grade FF-1 (durability-gate re-review MEDIUM)
autonomous_safe: true
tags: [concern:recall, concern:quality, surface:distill, stack:typescript, followup:FEAT-441]
triage_notes: "Fast-follow from SLICE-419 (FEAT-441). The durability gate's RATIONALE_MARKER_RE is a bare keyword-presence check — `since`/`because`/`reason`/`--` anywhere in an atom exempts it from gating, so junk with an incidental marker slips through (false-negative). Inert today (gate defaults off) and in the SAFE direction per PM under-gate>over-gate bias, but this MUST be tightened before distill.durabilityGate is ever defaulted to lenient|strict in any environment, else the gate silently under-performs. Bounded regex + test change, reversible, well-covered by existing both-directions test harness — autonomous_safe."
---

# FEAT-448: tighten RATIONALE_MARKER_RE — require causal proximity, not bare keyword presence

## Problem

SLICE-419 fixed a HIGH classifier false-positive by giving `ephemeral_state` /
`git_derivable` / `vacuous_negative` the same rationale-marker exemption +
length/dominance guard that `bare_todo` already had. The re-review confirmed
the fix works but flagged that `RATIONALE_MARKER_RE` is a **bare
keyword-presence** check with no proximity/semantic requirement, so an
incidental marker exempts genuine junk. Empirically (classify from built dist):

```
"The build is currently green since 3pm."     -> null   (should be ephemeral_state)
"Commit abc1234 merged since last week."       -> null   (should be git_derivable)
"It is running because deploy."                -> null   (should be ephemeral_state)
"Status is red because reasons."               -> null   (should be ephemeral_state)
"Build is failing --verbose flag set."          -> null   (should be ephemeral_state; `--` from a CLI flag)
"Trunk status is green." (control, no marker)  -> ephemeral_state  (correctly gated)
```

`since` used temporally, a literal `--` from a CLI flag, or `because`/`reason`
glued onto a contentless clause all trip the exemption.

This is inert while `distill.durabilityGate` defaults to `off`, and it errs in
the safe direction (a durable atom is never dropped). But the whole point of
FEAT-441 is to eventually enable the gate — at which point this
under-gating quietly defeats the feature. **FEAT-448 gates FEAT-441 default-on.**

## Requested capability

Tighten the exemption so a rationale marker only exempts an atom when it is in
**causal proximity to the trigger clause** (binds the junk statement as its
cause/consequence), not merely present somewhere in the atom:

- Require the marker to connect to the matched junk span (e.g. same clause /
  within N tokens of the trigger match / the connective grammatically binds the
  trigger), not bare presence anywhere in the text.
- Exclude non-causal uses that currently leak: temporal `since` (`since 3pm`,
  `since last week`), the literal `--` CLI-flag double-dash, and
  `because`/`reason` attached to a contentless clause.
- Keep it a single-module change in `src/distill/durability-gate.ts` (AC-6 of
  FEAT-441 — no duplicated logic).

## Acceptance criteria

- AC-1 (close the false-negatives): Given the 5 FF-1 leak examples above and
  `distill.durabilityGate: strict`, When classified, Then each is GATED with
  its correct `gatedReason` (the incidental marker no longer exempts).
- AC-2 (no HIGH regression): Given SLICE-419's 5 rationale-bearing durable
  regression atoms (root-cause note citing a SHA, em-dash-rationale ephemeral
  phrase, "because"-wrapped vacuous negative, "reason:"-wrapped git phrase,
  "Status is green because of the CI fix."), When classified strict, Then all 5
  still persist (`null`) — the original HIGH false-positive stays fixed.
- AC-3 (both-directions corpus): the 5 FF-1 examples are added to
  `tests/distill/durability-gate.test.ts` as gated cases and the 5 durable
  atoms remain as persist cases, so the harness pins both directions.
- AC-4 (eval floors hold): ADR-005 recall@10 >= 0.9 / NDCG@10 >= 0.7 unchanged;
  the junk-pollution fixture still shows gated recall > ungated.
- AC-5 (still single choke point): the tightened logic lives only in
  `src/distill/durability-gate.ts` — no duplicated marker/proximity logic.

## Refs

- Parent: FEAT-441 (`.claude/artifacts/loop/backlog/done/FEAT-441.md`), SLICE-419.
- Grade FF-1: `.claude/artifacts/loop/grades/20260709T110626Z-feat441-slice419-grade.md`.
- Re-review MEDIUM: `.claude/artifacts/crew/reviews/20260709T110029Z-review-result-slice-419-feat-441-durability-gate-targeted-re-review.md`.
- Site: `src/distill/durability-gate.ts` (`RATIONALE_MARKER_RE`, `classifyDurability`).
