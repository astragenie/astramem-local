---
id: FEAT-497
status: pending
priority: null
category: governance
target_release: null
created: 2026-07-14
updated: 2026-07-14
depends_on: []
slices: []
derived_from: .claude/artifacts/crew/reviews/20260714-arch-review-feat-489-495.md
---
# FEAT-497: Consent/disclosure ADR for capturing non-user speakers (gates FEAT-489/491)

## Description

Arch-review load-bearing finding: ADR-009's threat model covers only the astramem USER's own
data; nothing gates "a non-consenting third party's voice/words were captured by this user's
daemon." Audio ingestion (FEAT-489) records everyone in a meeting; caption scraping (FEAT-491)
captures what other participants say. Two-party/all-party consent recording law is real exposure
in several US states and other jurisdictions. This repo's own precedent (ADR-012: every new
capture-surface tier got a dedicated risk ADR with default-OFF, explicit opt-in, disclosure copy,
and an acceptance-note sign-off BEFORE build dispatch) applies with more force here, since the
risk delta is larger than either MCP-tap or LLM-proxy.

Deliverable: an ADR-009 amendment or new ADR mirroring ADR-012's shape — threat-model rows for
non-user speakers, default OFF, explicit opt-in, in-product disclosure copy requirements,
per-jurisdiction guidance posture, and what (if anything) the plugin-side caption scraper must
display. Governance spans both repos (plugin does the scraping) — state the cross-repo binding
explicitly.

## Acceptance hints

- ADR lands with the ADR-012-style decision table + acceptance-note sign-off.
- FEAT-489 and FEAT-491 acceptance criteria updated to reference the ADR's requirements
  (disclosure copy, opt-in flow) once ratified.
- Explicitly dispositions: is caption scraping (already-displayed text) different in kind from
  audio recording? Decide, don't assume.

## Notes

Blocks FEAT-489 and FEAT-491 slice 1. Small doc effort; the value is deciding BEFORE building —
same gate ADR-012 imposed on itself.
