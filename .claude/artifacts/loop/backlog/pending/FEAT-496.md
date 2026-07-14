---
id: FEAT-496
status: pending
priority: null
category: contracts
target_release: null
created: 2026-07-14
updated: 2026-07-14
depends_on: []
slices: []
derived_from: .claude/artifacts/crew/reviews/20260714-arch-review-feat-489-495.md
---
# FEAT-496: atom@2 additive extension — transcript speaker/segment provenance fields

## Description

The contract work FEAT-489/491 (and cloud's 2-week WS-B + FEAT-516) all depend on but nobody
owned (arch-review finding). Smaller than assumed: `atom.v2.schema.json` already carries
`evidence[].transcript_id` + `span` (lines 37-51) — most of segment-level provenance exists.
Missing: optional `speaker_label` and `segment_start_ms` (+ any meeting/platform envelope fields
the caption source needs, coordinated with FEAT-491's ingest-schema widen). Legitimate
additive/minor change per `contracts/README.md:272-283` — new optional fields, schema stays `@2`.
Note `additionalProperties: false` at top level AND inside `provenance` (lines 7, 68): every
field must be an explicit schema edit, no passthrough.

## Acceptance hints

- Schema edit + goldens + `contracts:generate` + `contracts:validate` green.
- Published via `contracts-v*` tag — merge ≠ publish; downstream (cloud WS-B/FEAT-516,
  FEAT-489/491) blocked until the TAG exists, not the merge.
- Cloud + plugin adopt generated types; no competing shapes authored anywhere.

## Notes

Slice-0-sized (≤1 day). Consider reserving the Screenpipe-inspired provenance triple field names
(`worker` compute-tier / `model` / `attestation`) in the same edit — nearly free now, additive
later (screenpipe deep-dive §6).
