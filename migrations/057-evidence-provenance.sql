-- 057: structured per-atom evidence provenance (retrieval-overhaul Phase 5 /
-- P5-storage, storage half only — the recall/search response-shape half is
-- owned by the retrieval-core track in Wave 2, see
-- docs/specs/20260720-retrieval-overhaul-plan.md Phase 5 / Wave 2).
--
-- Codex architecture review: "MemoryRepo stores only an optional evidence
-- string, and recall omits it... the eval's fuzzy back-map proved only 25%
-- match, insufficient." `memories.evidence` (migration 004) already carries
-- the extractor's own (possibly paraphrased) excerpt string and
-- `memories.session_id`/`source_hash` already identify the transcript --
-- what's missing is WHERE in that transcript the evidence actually sits.
--
-- Four additive nullable columns, no table rewrite (same ALTER TABLE ADD
-- COLUMN pattern migrations 024/043/049 used) -- NULL on every existing row
-- and on every future row from a write path that has no source transcript to
-- locate evidence within (/remember, MCP remember, the eval harness, any
-- atom with no `evidence` string at all). Only the distill pipeline's
-- stage-8 write (src/distill/stages/08-embed-index.ts, via
-- src/distill/locate-evidence.ts) ever populates these, and only when
-- `ctx.sourceText` is present AND a match against it is found -- byte-
-- identical to today for every caller/row that doesn't have both.
--
-- `evidence_turn_index` -- 0-based index of the transcript LINE (== turn,
-- per flatten-turns.ts's one-turn-per-line convention) the located evidence
-- span falls in. Paired with `memories.session_id` this is the "turn ID
-- (dia_id)" the plan asks for -- there is no separately-stored turn id
-- anywhere upstream (the canonical envelope's `turns[]` has no id field),
-- so the deterministic line index within this atom's own source transcript
-- IS the stable identifier a future Phase 5 bundler resolves "adjacent
-- turns" against (turn_index - 1 / + 1 against the SAME session_id).
--
-- `evidence_char_start` / `evidence_char_end` -- half-open [start, end)
-- character offsets of the located span within the FULL flattened
-- transcript text (the same string `attribute-speaker.ts` already matches
-- against) -- not offsets within just the one turn/line, so a consumer can
-- slice the transcript directly without also re-deriving line boundaries.
--
-- `evidence_span` -- the EXACT verbatim text found in the transcript at
-- [evidence_char_start, evidence_char_end) -- distinct from `evidence`
-- (migration 004), which is the extractor's own possibly-paraphrased
-- excerpt. When locate-evidence.ts's tier-1 exact-substring match fires,
-- `evidence_span` is byte-identical to `evidence`; when only the tier-2
-- fuzzy fallback fires (real LLM paraphrase, same posture as
-- attribute-speaker.ts's own tier 2), `evidence_span` is the real source
-- line's text, NOT the extractor's paraphrase -- this is the field that
-- fixes the measured 25% fuzzy-back-map match rate, by storing the actual
-- source text at write time instead of re-deriving it later with a lossier
-- match at read time.
ALTER TABLE memories ADD COLUMN evidence_turn_index INTEGER;
ALTER TABLE memories ADD COLUMN evidence_char_start INTEGER;
ALTER TABLE memories ADD COLUMN evidence_char_end INTEGER;
ALTER TABLE memories ADD COLUMN evidence_span TEXT;

-- Partial index: cheap "adjacent turns in this session" lookups (Phase 5's
-- "its exact source turn + adjacent +/-1 turns") without indexing the
-- overwhelming majority of rows that have no located evidence at all.
CREATE INDEX idx_memories_evidence_turn ON memories(session_id, evidence_turn_index)
  WHERE evidence_turn_index IS NOT NULL;
