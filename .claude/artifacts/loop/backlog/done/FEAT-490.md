---
id: FEAT-490
status: done
priority: null
category: capture
target_release: null
created: 2026-07-14
updated: 2026-07-14
depends_on: [FEAT-489]
slices: []
derived_from: memory repo docs/research/2026-07-14-phase3-oss-repo-archaeology.md
---
# FEAT-490: Hallucination / low-confidence filter on local transcription output

## Description

Filter hallucinated segments (ASR's fluent-junk failure mode on silence/music/faint audio) before
they reach distill. Whisper.cpp/faster-whisper expose the exact fields the reference thresholds
use — Vexa `confidence.ts` (Apache-2.0): drop when `no_speech_prob > 0.6 ∧ avg_logprob < -1.0`,
or `compression_ratio > 2.4`, or `avg_logprob < -1.3`. Unlike cloud (hosted providers, fields
vary), local can apply these verbatim.

## Acceptance hints

- Single chokepoint in the `transcribe` handler output path; thresholds config-tunable with the
  reference values as defaults.
- Silence-only and music-only test fixtures produce zero memories.
- Dropped-segment counts visible (log + stats), never silent.

## Notes

Hours of work once FEAT-489 lands — bundle into the same slice if convenient. Complements the
existing durability gate (junk-ATOM filter) one stage earlier (junk-SEGMENT filter).

> **Closed 2026-07-17 — reconciled shipped-but-open.** shipped inside 4086e767 (#331)
