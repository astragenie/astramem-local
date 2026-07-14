/**
 * Stage 3 — Chunk (deterministic)
 *
 * Token-aware split using word-count proxy (~800 tokens ≈ ~3200 chars).
 * Respects turn boundaries — does not split mid role: block.
 *
 * Turn detection: lines starting with "user:", "assistant:", "system:",
 * "human:", "ai:" (case-insensitive), OR a named-speaker label ("Caroline:",
 * "Nate:") are treated as turn boundaries — see NAMED_SPEAKER_CANDIDATE_RE
 * below for the #271/#273 fix and its false-positive tradeoff.
 */

/** Approximate chars per token (conservative estimate) */
const CHARS_PER_TOKEN = 4;

/**
 * Target tokens per chunk.
 *
 * 800 (3200 chars) was tuned for a cloud model reading an engineering transcript.
 * It is a poor fit for LOCAL inference on conversational content, in two ways
 * measured on 2026-07-13 with qwen3.5:4b:
 *
 * 1. TIMEOUT. A real 2029-char chunk made the model generate ~1200 tokens and
 *    take over a minute — past the (then 60s) chat timeout. Every call aborted,
 *    and the observable was ZERO ATOMS with the job marked completed. A timeout
 *    produced a zero indistinguishable from "the model found nothing" (ADR-015).
 *
 * 2. EXTRACTION DENSITY. Smaller chunks are not merely safer — they are BETTER:
 *
 *      483-char chunk  -> 6 atoms  =  1 atom per  80 chars
 *      2029-char chunk -> 9 atoms  =  1 atom per 225 chars
 *
 *    Given less text, the model extracts ~3x more densely. Given more, it skims.
 *
 * And halving the chunk is FREE, because stage 4 (compaction) no longer runs for
 * conversational content (see 04-compact.ts):
 *
 *      OLD: chunk 3200 -> compact (1 LLM call) -> extract (1 LLM call) = 2 calls
 *      NEW: chunk 1600 -> extract (1 LLM call)                          = 2 calls
 *                                                                        per 3200 chars
 *
 * The SAME number of LLM calls — we just spend them all on extraction instead of
 * half of them on deleting our own facts.
 *
 * Override with ASTRA_CHUNK_TARGET_TOKENS. A cloud extractor with a big context
 * and no latency penalty may legitimately prefer the larger chunk.
 */
const TARGET_TOKENS = Number(process.env.ASTRA_CHUNK_TARGET_TOKENS ?? 800);

/** Default max chars per chunk before we must split even mid-turn.
 *  #273 (WS7): this used to be the only way to size a chunk (short of the
 *  ASTRA_CHUNK_TARGET_TOKENS env override above). Now the default,
 *  overridable per call via `chunk(text, maxChunkChars)`; production callers
 *  resolve the actual value from `config.distill.maxChunkChars` (see
 *  `resolveMaxChunkChars`) so this constant alone still fully determines
 *  behavior when no config override is set. */
export const DEFAULT_MAX_CHUNK_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;

/** Hard bounds for `config.distill.maxChunkChars`, mirroring
 *  `resolveChunkConcurrency`'s [1,8] clamp — a bad/hand-edited config value
 *  must never block a pipeline run. MIN=400 keeps a chunk large enough to
 *  hold a handful of short turns; MAX=8000 is generous headroom above the
 *  historical 3200 default, not a claim that larger is better (see #273 sweep). */
export const MIN_CHUNK_CHARS = 400;
/** Raised 8000 → 16000 (2026-07-19, codex-only tuning): the old ceiling
 * assumed small-local-model context windows. A cloud extractor legitimately
 * runs 12800-char (~3200-token) chunks — BUT the recency-bias hazard the old
 * ceiling encoded (a long chunk approaching the cap loses content from its
 * first ~80%, measured on conv-26/conv-44) is model-independent and still
 * real: do not raise config.distill.maxChunkChars past 8000 without a
 * same-day A/B on the target extractor. The ceiling only bounds what config
 * may ASK for; the default remains DEFAULT_MAX_CHUNK_CHARS. */
export const MAX_CHUNK_CHARS_CEILING = 16000;

/** Fixed-role turn boundary — always a boundary, no ambiguity. */
const ROLE_BOUNDARY_RE = /^(user|assistant|system|human|ai)\s*:/i;

/**
 * Candidate named-speaker label at line start: 1-2 Title-Case words
 * followed by a colon ("Caroline:", "Nate:", "Mary Jane:"). #271/#273 (see
 * their issue text for the full investigation): the original ROLE_BOUNDARY_RE
 * only recognized the fixed "user:"/"assistant:"/etc. prefixes, so a raw
 * named-speaker transcript (a plain chat log pasted by a real user, or any
 * legacy v0.0 envelope content that isn't wrapped in a binary role) never
 * produced a single turn boundary — the whole transcript collapsed into one
 * undifferentiated block before packTurns()'s turn-aware packing ever ran.
 *
 * Deliberately Title Case only (`[A-Z][a-z]*`), not `[A-Z][a-zA-Z]*` — this
 * excludes ALL-CAPS labels like "TODO:"/"NOTE:" (real names are essentially
 * never all-caps) but still lets a single capital letter through ("Q:").
 * It does NOT exclude ordinary capitalized sentence starts that happen to
 * look like a label ("Note:", "Warning:", "However:") — that's what the
 * recurrence gate below is for.
 *
 * Tradeoff, stated plainly: a false-positive boundary here (splitting mid-
 * paragraph on a one-off "Note:") is far less harmful than the status quo
 * false negative (never splitting a real named-speaker transcript at all) —
 * packTurns() just repacks extra turns back together under MAX_CHUNK_CHARS,
 * so an over-split turn costs nothing when the chunk stays under the cap.
 */
const NAMED_SPEAKER_CANDIDATE_RE = /^([A-Z][a-z]*(?:\s[A-Z][a-z]*)?)\s*:/;

/**
 * Minimum number of times a candidate named-speaker label must recur in the
 * same transcript before it's trusted as a real turn boundary. This is the
 * actual false-positive guard: a genuine speaker label appears repeatedly
 * across a conversation; a one-off capitalized sentence opener ("Note:",
 * "Warning:", "However:") almost never does. Two-line transcripts (or a
 * label that truly appears only once) fall back to being treated as normal
 * content — see isTurnBoundary below.
 */
const NAMED_SPEAKER_MIN_RECURRENCE = 2;

export interface Chunk {
  index: number;
  text: string;
}

/**
 * Resolve stage 3's per-chunk character cap from config, clamped to
 * [MIN_CHUNK_CHARS, MAX_CHUNK_CHARS_CEILING]. Non-finite/non-positive/
 * non-numeric values fall back to DEFAULT_MAX_CHUNK_CHARS rather than
 * throwing.
 */
export function resolveMaxChunkChars(config: { distill?: { maxChunkChars?: number } }): number {
  const raw = config.distill?.maxChunkChars;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_CHUNK_CHARS;
  const truncated = Math.trunc(raw);
  return Math.min(MAX_CHUNK_CHARS_CEILING, Math.max(MIN_CHUNK_CHARS, truncated));
}

/**
 * Split text into chunks respecting turn boundaries.
 *
 * Algorithm:
 * 1. Split into "turns" — sequences of lines starting with a role: prefix.
 * 2. Pack turns into chunks until maxChunkChars would be exceeded.
 * 3. If a single turn exceeds maxChunkChars, split it by paragraph then by line.
 *
 * `maxChunkChars` defaults to DEFAULT_MAX_CHUNK_CHARS when omitted — every
 * pre-#273 caller that doesn't pass it gets identical behavior.
 */
export function chunk(text: string, maxChunkChars: number = DEFAULT_MAX_CHUNK_CHARS): Chunk[] {
  const turns = splitIntoTurns(text);
  return packTurns(turns, maxChunkChars);
}

interface Turn {
  text: string;
}

function splitIntoTurns(text: string): Turn[] {
  const lines = text.split('\n');

  // First pass: count how many times each candidate named-speaker label
  // recurs across the whole transcript — see NAMED_SPEAKER_MIN_RECURRENCE.
  const labelCounts = new Map<string, number>();
  for (const line of lines) {
    const m = NAMED_SPEAKER_CANDIDATE_RE.exec(line);
    if (m) {
      const label = m[1]!;
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
  }

  const isTurnBoundary = (line: string): boolean => {
    if (ROLE_BOUNDARY_RE.test(line)) return true;
    const m = NAMED_SPEAKER_CANDIDATE_RE.exec(line);
    if (!m) return false;
    return (labelCounts.get(m[1]!) ?? 0) >= NAMED_SPEAKER_MIN_RECURRENCE;
  };

  const turns: Turn[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (isTurnBoundary(line) && current.length > 0) {
      turns.push({ text: current.join('\n') });
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    const t = current.join('\n').trim();
    if (t) turns.push({ text: t });
  }

  return turns;
}

function packTurns(turns: Turn[], maxChunkChars: number): Chunk[] {
  const chunks: Chunk[] = [];
  let current = '';
  let idx = 0;

  for (const turn of turns) {
    const turnText = turn.text.trim();
    if (!turnText) continue;

    // If this single turn is too large, flush current and split the turn
    if (turnText.length > maxChunkChars) {
      if (current.trim()) {
        chunks.push({ index: idx++, text: current.trim() });
        current = '';
      }
      // Split the oversized turn by paragraph
      const subChunks = splitLargeTurn(turnText, idx, maxChunkChars);
      for (const sc of subChunks) {
        chunks.push({ index: idx++, text: sc.text });
      }
      continue;
    }

    // Would adding this turn exceed the limit?
    const candidate = current ? current + '\n\n' + turnText : turnText;
    if (candidate.length > maxChunkChars && current.trim()) {
      chunks.push({ index: idx++, text: current.trim() });
      current = turnText;
    } else {
      current = candidate;
    }
  }

  if (current.trim()) {
    chunks.push({ index: idx, text: current.trim() });
  }

  // Edge case: empty input
  if (chunks.length === 0) {
    return [{ index: 0, text: '' }];
  }

  return chunks;
}

/**
 * Split a single turn that exceeds maxChunkChars into sub-chunks.
 * First tries paragraph boundaries, then line-by-line as fallback.
 */
function splitLargeTurn(text: string, startIdx: number, maxChunkChars: number): Chunk[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: Chunk[] = [];
  let current = '';
  let idx = startIdx;

  for (const para of paragraphs) {
    if (!para.trim()) continue;

    if (para.length > maxChunkChars) {
      // Split by line
      if (current.trim()) {
        chunks.push({ index: idx++, text: current.trim() });
        current = '';
      }
      const lines = para.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const cand = current ? current + '\n' + line : line;
        if (cand.length > maxChunkChars && current.trim()) {
          chunks.push({ index: idx++, text: current.trim() });
          current = line;
        } else {
          current = cand;
        }
      }
    } else {
      const cand = current ? current + '\n\n' + para : para;
      if (cand.length > maxChunkChars && current.trim()) {
        chunks.push({ index: idx++, text: current.trim() });
        current = para;
      } else {
        current = cand;
      }
    }
  }

  if (current.trim()) {
    chunks.push({ index: idx, text: current.trim() });
  }

  return chunks;
}
