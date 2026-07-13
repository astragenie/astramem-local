---
type: validation
created: 2026-07-13T12:58:00Z
slice: SLICE-434
feature: FEAT-479
result: PASS
validator: lead (evidence from builder live smoke + reviewer worktree runs)
---

# Validation — SLICE-434: conversational profile + few-shots + redaction-posture disclosure

## Behavior evidence

- **Live fx44 smoke (real Ollama, qwen2.5-coder:7b, worktree)**: conversational
  profile extracted 4 personal atoms (Marcus moving out next week + sentiment,
  Priya starting new school in fall + sentiment) with proper nouns preserved
  and small-talk filler excluded (banned-abstractions held). Engineering
  profile on the SAME fixture returned `[]` — correct profile divergence,
  positive→negative pair, not an empty-store false pass. No VRAM eviction
  this run (~31s/~33s per call).
- Context budget verified independently by reviewer from built dist:
  conversational prompt 9910 chars ≈ 2477 tokens; estimated total 6289.5
  tokens vs 16384 NUM_CTX_CAP.
- Precedence intact: SLICE-432 byte-identity pin still green (engineering
  default unchanged by object identity); _PENDING tripwire replaced by a
  3-way divergence assertion.
- Suites: worktree tsc clean; 4 touched/new suites 61/61; builder's full run
  247 files / 2972 pass / 0 fail.
- AC-10: `git diff -- src/redact/` empty; disclosure consistent across
  config.ts comment, docs/configuration.md, README, and doctor
  checkExtractProfile informational row (always ok, no double-warn).

## Known v1 limitations (documented, non-blocking)

- qwen2.5-coder:7b partially honors possessor-qualification and 15-80-word
  rules on real prose — expected to improve with the codex/BYO extraction
  flip; SLICE-436 proof phase measures it.
- Relative-date grounding is conditional: capturedAtMs is never threaded into
  extractChunk (recorded in the prompt doc comment; follow-up FEAT
  candidate: thread the anchor into the extraction call).

## Reviews

- review-434: PASS, no blocking findings.
  Artifact: .claude/artifacts/crew/reviews/20260713T125500Z-review-slice434-conversational.md
