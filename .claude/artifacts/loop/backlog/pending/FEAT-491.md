---
id: FEAT-491
status: pending
priority: null
category: capture
target_release: null
created: 2026-07-14
updated: 2026-07-14
depends_on: [FEAT-496, FEAT-497]
slices: []
derived_from: memory repo docs/research/2026-07-14-competitor-matrix-and-newer-projects.md
---
# FEAT-491: Accept meeting-caption transcripts as a capture source (bot-free, zero-ASR)

## Description

Daemon-side acceptance for meeting transcripts scraped from Google Meet / Teams native live
captions by the browser extension (astramem-plugin repo owns the scraping): a caption-sourced
transcript arrives via the existing ingest route with source=`meeting-captions`, platform,
meeting id, and caption speaker labels, and flows through the normal distill pipeline. Cheapest
meeting-memory path — no audio, no ASR, works today on any hardware. Conceptual steal from
Bluedot's extension capture; sibling of cloud FEAT-516.

> **Arch review 2026-07-14 (NEEDS-CHANGES, applied):** the "no new capture module needed if the
> existing route can carry it" claim was FALSE, verified against `src/server/routes/ingest.ts`
> (CanonicalIngestSchema, lines 67-147): (1) `capture_source` is a CLOSED enum
> `['auto_capture','hook_close','proxy']` whose doc comment argues for staying closed — adding
> `meeting-captions` is a deliberate schema decision, not reuse; (2) `TranscriptTurnSchema` has
> role=user|assistant only — no speaker-name, platform, or meeting_id fields anywhere; collapsing
> speakers into `assistant` destroys this FEAT's own AC; (3) no `.passthrough()` — zod SILENTLY
> STRIPS unknown keys at parse (the known zod-as-filter trap, confirmed not hypothetical).
> Also: `spool-schema-guard.ts` exists on `main` (c55403f), not older branches — build on a
> post-c55403f branch. Consent gate FEAT-497 applies (ADR-008 rejected file-watching capture as
> "consent-ambiguous" — same shape).

## Acceptance hints

- Real schema work, not route reuse: widen `capture_source` (or add a new discriminator), extend
  `TranscriptTurnSchema` with an optional speaker field, add `platform`/`meeting_id` envelope
  fields — coordinated with FEAT-496 so speaker labels reach stored atom provenance, not just the
  wire.
- Unknown-field handling decided explicitly (error or preserve — never silent strip) for the new
  fields.
- Preserves speaker display-names and meeting metadata end-to-end into stored memories.
- Scope defaults to `private` (ADR-009); caption memories never sync unless promoted.
- One real captured caption transcript → distilled memories retrievable by meeting-scoped recall.

## Notes

Extension scraping fragility is the plugin repo's problem — keep the daemon contract
platform-agnostic. (Original "no new capture module needed, verify guard tolerance" note refuted
by arch review — see the review block above; the schema work is real and enumerated in the
acceptance hints.)
