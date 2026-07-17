# FEAT-506 — meeting_captions ingest should default extract_profile='conversational'

- status: done
- source: FEAT-505 build + review adjudication, 2026-07-14 (reviews:
  20260714T235049Z-review-result-feat-505-fuzzy-speaker-attribution.md)

## Problem

A meeting-captions capture client that omits the optional `extract_profile` envelope field gets
the 'engineering' profile (config.ts:1042 default → pipeline.ts:184 fallback), which runs stage-4
LLM compaction BEFORE extraction. 04-compact.ts's own doc comment (and FEAT-505's live debugging)
confirms compaction on conversational content destroys facts including speaker names — degrading
attribution AND fact fidelity regardless of the (now-fixed) matching algorithm. FEAT-505's live
test passes only because it explicitly sets the field.

## Scope options (decide at triage)

A. Route-layer default: when capture_source='meeting_captions' and extract_profile absent,
   resolve to 'conversational' (server-side, protects every client). Preferred by both the
   builder and reviewer.
B. Capture-client fix only: always send the field explicitly (leaves other clients exposed).

## Also fold in (same neighborhood, from the same review, non-blocking)

Tier-1 exact-substring speaker match (pre-FEAT-505 code) has no ambiguity check — first match
wins on a literal collision between two speakers' lines. Add the same best-vs-runner-up
discipline or route ties to null.

## ACs (draft)

1. Envelope WITHOUT extract_profile + capture_source='meeting_captions' → conversational profile
   used (test through the real ingest route, not the pipeline directly).
2. Explicit extract_profile in the envelope still wins (override preserved).
3. Other capture sources unaffected (engineering default pinned by test).

> **Closed 2026-07-17 — reconciled shipped-but-open.** both parts LIVE on main via other commits (route default ingest.ts:355 ~#344, tier-1 ambiguity attribute-speaker.ts); stranded branch 20a59ac6 superseded
