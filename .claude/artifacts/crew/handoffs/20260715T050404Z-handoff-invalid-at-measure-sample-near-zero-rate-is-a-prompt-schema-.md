# Task Handoff: invalid_at measure+sample: near-zero rate is a prompt-schema gap, not correct-conservative behavior

- Created: 2026-07-15T05:04:04.434Z
- From: researcher
- To: dispatcher
- Objective: invalid_at now fires at 0.1-0.5% (not literally 0 anymore) but only for date-bearing event spans; dateless used-to/no-longer timeline shifts (drums/guitar/pets/hobbies) never get invalid_at because the prompt requires an ISO-8601 date the source text doesn't provide -- recommend adding dateless-bound few-shots, not declaring rate-0 correct.
- Allowed Scope:
  - Read-only: queried .eval-data/locomo/runs/{fullsuite-ksweep
  - ab-dualpass
  - ac1-validate
  - 20260713-postfix-10pct}/datadir/memory.sqlite for valid_to/validity_guard_drops rates; read src/distill/prompts/extract.ts invalid_at instructions/few-shots; grepped 272 LoCoMo transcripts.content for bounding language (37 hits) and cross-checked resulting atoms in memories table.
- Forbidden Scope: -
- Deliverable: Measured: fullsuite-ksweep (6270 atoms) valid_to NOT NULL=9 (0.14%), validity_guard_drops=1 (invalid_at_before_valid_at). ac1-validate: 2/395 (0.5%). ab-dualpass: 0/482. All 9 bounded rows in fullsuite-ksweep are short event-window bookends with explicit calendar dates, none are life-timeline invalidations. Prompt (extract.ts ~104-114, 368-376, 780-793) requires ISO-8601 date and forbids guessing; only positive few-shot (line 424-428) has an explicit anchor date. Sampled 37 transcript passages with bounding language across 272 LoCoMo sessions: at least 4 unambiguous full-stop cases (John/James used to play drums/guitar but has not in a while - locomo-conv-47-s24; Deborah used to play video games, has not in a while - locomo-conv-48-s19; Joanna used to have dog Tilly, gave her up due to allergy - locomo-conv-42-s24) produced atoms with NO valid_to, because the source text has no literal date to anchor invalid_at to, only used to X no longer Y phrasing. Verdict: MIXED, dominant failure mode is a genuine prompt/schema gap (BUG) not correct abstention.
- Changed Files:
  - src/distill/prompts/extract.ts
  - src/distill/stages/08-embed-index.ts
  - .eval-data/locomo/runs/fullsuite-ksweep/datadir/memory.sqlite
- Confidence: high
- Risks: Only conversational-profile LoCoMo transcripts sampled; engineering-profile section (~780-793) not separately transcript-verified though instruction text is near-identical. The one validity_guard_drops row not deep-dived. RECOMMENDATION (A): add 2-3 few-shots for the dateless used-to-X-no-longer-Y pattern, allowing the atom's own capture/session date as invalid_at anchor when text states unambiguous cessation without a literal date, while keeping the hard rule against inferring bounds from silence/ambiguous continuation. Do NOT mark rate-0 as correct-and-done.
- Suggested Next Handoff: architect/builder to draft few-shot addition to extract.ts (both conversational ~424-431 and engineering ~862-869 sections), then re-run a small LoCoMo slice measuring invalid_at rate change on genuine timeline-shift atoms without regressing validity_guard_drops (invalid_at_implausible / invalid_at_before_valid_at).

