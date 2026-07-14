---
id: FEAT-491
status: pending
priority: null
category: capture
target_release: null
created: 2026-07-14
updated: 2026-07-14
depends_on: []
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

## Acceptance hints

- Ingest route accepts the caption-transcript payload shape (canonical segment/provenance
  contract from `contracts/`), preserves speaker display-names and meeting metadata into stored
  memories.
- Scope defaults to `private` (ADR-009); caption memories never sync unless promoted.
- One real captured caption transcript → distilled memories retrievable by meeting-scoped recall.

## Notes

Extension scraping fragility is the plugin repo's problem — keep the daemon contract
platform-agnostic. No new capture module needed if the existing ingest route + spool schema guard
can carry the payload; verify `src/ingest/spool-schema-guard.ts` tolerance first (zod-strip
lesson: unknown fields must not be silently dropped).
