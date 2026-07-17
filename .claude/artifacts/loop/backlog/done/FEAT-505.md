# FEAT-505 — Caption speaker attribution fails under real LLM (fuzzy evidence match)

- status: done
- source: L2 wave validation 2026-07-14 (artifact:
  .claude/artifacts/crew/validations/20260714T203254Z-l2-final-integration-validation-transcription-memory-beta.md)
- depends_on: FEAT-491 (shipped)

## Problem

Live-reproduced, twice: real caption ingest through the real daemon with the default LLM
(codex-subscription/gpt-5.4-mini) + real embeddings produced 4/4 atoms with
`speaker_label = null`, including a run designed with a maximally quotable single-sentence
utterance. `attribute-speaker.ts` requires the LLM's evidence excerpt to literal-substring-match
a transcript line; the model paraphrases despite the prompt demanding verbatim copy. The FEAT-491
round-trip test is 19/19 green ONLY because its mock LLM hardcodes verbatim evidence — the test
proves wiring, not real-LLM compliance (synthetic-fixtures-lie class, caught at L2).

Consequence: caption atoms carry consent/capture provenance correctly but lose WHO said it — the
headline value of speaker attribution.

## Acceptance criteria (draft)

1. Attribution succeeds on real-LLM output: fuzzy match (normalized token overlap / edit-distance
   band) OR a stricter extraction profile for meeting_captions sources that measurably yields
   verbatim evidence — decide with evidence, not preference.
2. A conformance test that runs the REAL default LLM (env-gated, loud-skip without it) asserting
   non-null speaker_label on a quotable fixture — the test class the mock hid.
3. Misattribution guard: fuzzy matching must not attribute to the WRONG speaker — negative test
   with two similar utterances by different speakers.
4. Attribution rate observable (counter or doctor stat: atoms-with-speaker / caption atoms).

## Notes

- Sync emission of speaker_label (wave/sync-emit-provenance, PR #333) is mechanism-proven and
  waits on this producer fix to carry real values end-to-end.
- segment_start_ms remains producer-less repo-wide (separate, lower-priority gap).

> **Closed 2026-07-17 — reconciled shipped-but-open.** shipped 56964215 (#337)
