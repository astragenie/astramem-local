/**
 * Stage 4 — Compact (LLM call per chunk)
 *
 * Removes redundancy, repeated thinking, false starts from each chunk.
 * Preserves decisions, file paths, commands, errors, rationale.
 *
 * Budget: checks cap before each call, records after.
 * Throws BudgetExceeded if over cap (caller moves job to paused).
 */

import type { LLMProvider, ChatMsg } from '../../contracts/index.js';
import type { Chunk } from './03-chunk.js';
import { BudgetTracker, BudgetExceeded } from '../../budget/tracker.js';
import { mapWithConcurrency } from '../concurrency.js';
import { chunkCheckpoints } from '../chunk-checkpoint.js';

export { BudgetExceeded };

const COMPACT_SYSTEM = `You are a transcript compressor for AI coding agent sessions.

Compress the provided transcript chunk. Remove:
- Repeated or near-identical lines
- Thinking-out-loud that reaches no conclusion
- False starts and self-corrections that don't change the outcome
- Generic acknowledgment phrases ("Sure!", "Of course!", "I'll help you with that")

PRESERVE:
- All decisions and chosen approaches
- All file paths and commands
- All error messages, stderr output, and permission errors from failed tool
  calls — EVEN IF the failure was never resolved or explained. An unresolved
  failure is still durable knowledge; do not drop it for lack of a fix.
- All error messages and their resolutions
- All rationale and architectural reasoning
- All TODO items and pending work
- Named tools, version numbers, and other named entities (products, repos,
  people, orgs) — keep them verbatim, don't paraphrase away a specific name
  or number

If the chunk covers multiple distinct topics, keep at least one line per
topic — do not compress a multi-topic chunk down to only its most prominent
topic.

Output plain text only. No markdown formatting. No commentary.`;

/**
 * Conversational compaction — the missing half of the conversational profile.
 *
 * THE BUG THIS FIXES (measured 2026-07-13, and it is the largest extraction leak
 * we have found):
 *
 * The conversational EXTRACTION profile shipped. A conversational COMPACTION
 * profile never did. So stage 4 ran the CODING-AGENT compressor above over
 * personal conversations — a prompt whose entire PRESERVE list is "file paths,
 * commands, error messages, stderr", none of which exist in a chat between two
 * people, and whose REMOVE list ("thinking-out-loud", "acknowledgment phrases",
 * "false starts") describes most of what a personal conversation IS.
 *
 * Measured on five real turns:
 *
 *   IN : Caroline: I went to the LGBTQ support group on May 7...
 *        Melanie:  I painted a sunset over the lake last year...
 *        Melanie:  My kids are excited for summer camp in June.
 *        Caroline: Tell Alice I said hi. How is your sister doing after the
 *                  move to Portland?
 *
 *   OUT: "May 7: Attended LGBTQ support group; hearing stories was powerful.
 *         Career consideration: Studying counseling/mental health...
 *         Personal updates: Melanie painted a sunset over lake last year..."
 *
 * DESTROYED, before extraction ever ran: Alice (a named person), the sister (a
 * relationship), Portland (a place), the move (a life event), summer camp in
 * June (a dated plan). And worst of all — THE SPEAKER NAMES. "Caroline:" is
 * gone; the summary says "Attended LGBTQ support group" with no subject.
 *
 * That last one is fatal by construction: the extraction prompt REQUIRES
 * "resolve every pronoun to the actual named person... never emit 'she started
 * her new job'". Compaction had already deleted the names, so extraction could
 * only drop the atom or GUESS — and it guessed wrong, attributing Caroline's
 * support group to Melanie.
 *
 * Nothing errored. A thinner summary yields fewer atoms, and FEWER ATOMS IS NOT
 * AN ERROR — the compactor "succeeded" on every single call. ADR-015 again:
 * success and failure were indistinguishable.
 *
 * So this prompt inverts the posture. For personal conversation, compression is
 * NOT the goal — FACT SURVIVAL is. A conversational transcript is mostly signal;
 * the redundancy an engineering session is full of (repeated tool output, false
 * starts, thinking aloud) barely exists here. When in doubt, KEEP THE LINE.
 */
const COMPACT_SYSTEM_CONVERSATIONAL = `You are preparing a personal conversation transcript for fact extraction. Your job is NOT to summarize it. Your job is to pass the durable content through with as little loss as possible.

This is a conversation between real people — about their lives, families, jobs, plans, feelings, and history. It is NOT a coding session. There are no file paths, no commands, no error messages.

ALWAYS PRESERVE — these are the facts a downstream extractor must be able to see:
- EVERY SPEAKER LABEL. Keep the "Name:" prefix on every line you keep. Never merge two speakers' lines. Never drop a name. A fact whose owner is unknown is worthless — the extractor is required to attribute every fact to a named person and CANNOT recover a name you deleted.
- Every named person, place, organization, school, employer, product, or pet — including people who are only mentioned in passing ("tell Alice I said hi", "my sister in Portland"). A passing mention IS a durable fact.
- Every date, time, age, duration, or timeframe — absolute or relative ("last year", "in June", "three weeks ago").
- Every stated plan, intention, decision, or scheduled event.
- Every stated preference, opinion, aversion, habit, or feeling about something recurring.
- Every relationship, life event, job, move, illness, or milestone — anyone's, mentioned by anyone.
- Every question that reveals a fact ("how is your sister doing after the move to Portland?" tells you there IS a sister, and that she MOVED, and WHERE).

REMOVE ONLY these, and only when you are certain:
- Verbatim duplicate lines.
- Pure greetings and sign-offs that carry no information ("hi", "talk soon").
- Pure backchannel with no content ("mhm", "haha", "that's so cool") — but KEEP any reaction that states an opinion, preference, or feeling about something durable.

WHEN IN DOUBT, KEEP THE LINE. A personal conversation is mostly signal. Dropping one line can permanently destroy the only mention of a person, a place, or a plan — nothing downstream can recover it. Over-keeping costs almost nothing; under-keeping is irreversible.

Do not rewrite lines into a summary style. Do not turn dialogue into bullet points or headings. Keep the speaker-labelled, line-by-line shape of the original.

Output plain text only. No markdown formatting. No commentary.`;

/** Which compaction posture to use. Mirrors ExtractProfile — and MUST be threaded
 *  from the same source, or conversational transcripts get the coding-agent
 *  compressor (the bug documented above). */
export type CompactProfile = 'engineering' | 'conversational';

export function compactSystemPrompt(profile: CompactProfile | null | undefined): string {
  return profile === 'conversational' ? COMPACT_SYSTEM_CONVERSATIONAL : COMPACT_SYSTEM;
}

export interface CompactResult {
  index: number;
  text: string;
  usageUsd: number;
}

/**
 * Compact a single chunk via LLM.
 * Returns the compressed text and actual USD cost.
 */
export async function compactChunk(
  chk: Chunk,
  provider: LLMProvider,
  budget: BudgetTracker,
  capUsd: number,
  profile?: CompactProfile | null,
): Promise<CompactResult> {
  if (!chk.text.trim()) {
    return { index: chk.index, text: '', usageUsd: 0 };
  }

  const system = compactSystemPrompt(profile);

  const messages: ChatMsg[] = [
    { role: 'system', content: system },
    { role: 'user', content: chk.text },
  ];

  // Estimate cost: prompt = system + user text chars
  const promptChars = system.length + chk.text.length;
  // For Ollama providers, usd=0 always — use a negligible estimate to pass budget check
  // For Azure, pricing is handled after the call via usage.usd
  const estimateUsd = BudgetTracker.estimateUsd(promptChars, 0.000002, 0.000002);

  budget.assertCanSpend(estimateUsd, capUsd);

  const result = await provider.chat(messages, {
    temperature: 0.1,
    maxTokens: 2000,
  });

  // Record actual cost (0 for Ollama, real for Azure)
  budget.record(result.usage.usd);

  return {
    index: chk.index,
    text: result.text.trim(),
    usageUsd: result.usage.usd,
  };
}

/**
 * Compact all chunks, up to `concurrency` at a time (FEAT-487).
 *
 * Stops dispatching further chunks at the first BudgetExceeded (or any other
 * error) — caller catches and pauses job. Results stay in chunk-index order
 * regardless of completion order. See src/distill/concurrency.ts for the
 * full invariant contract `mapWithConcurrency` provides.
 *
 * `concurrency` defaults to 1 — BYTE-IDENTICAL to the pre-FEAT-487
 * sequential `for…of await` loop this replaces. Production callers resolve
 * the real value from config via `resolveChunkConcurrency`
 * (src/distill/pipeline.ts).
 *
 * `jobKey` (chunk-retry-amplification fix) opts into per-chunk
 * checkpointing: chunks whose result is already cached under `jobKey` (from
 * an earlier call — i.e. a worker-level job retry re-invoking compact() from
 * scratch) are skipped entirely rather than re-dispatched, and every fresh
 * success is cached before compact() returns. Omitted (the default), this
 * function is byte-identical to its pre-fix behavior — no cache lookup, no
 * cache write, every call re-dispatches every chunk. Production callers pass
 * `ctx.sourceHash` (see pipeline.ts) — stable across retries of the same job
 * because it's derived from transcript content, not a per-attempt id.
 */
export interface CompactOpts {
  profile?: CompactProfile | null;
  /** 'auto' (default): run for engineering, SKIP for conversational.
   *  'never': skip always. 'always': run always (pre-fix behavior). */
  mode?: 'auto' | 'always' | 'never';
}

/**
 * Should stage 4 actually call an LLM at all?
 *
 * Compaction shrinks a payload — a BANDWIDTH concern from when transcripts were
 * assumed to be shipped to a SaaS backend. Locally there is no payload, and stage
 * 3 has already capped chunks at MAX_CHUNK_CHARS (3200, ~800 tokens) against an
 * extraction num_ctx sized up to 16384. So compaction saves a few hundred tokens
 * out of a budget twenty times larger — while costing ONE LLM CALL PER CHUNK and,
 * on conversational content, DESTROYING FACTS (see COMPACT_SYSTEM_CONVERSATIONAL's
 * doc comment for the measured example: it deleted a named person, a relationship,
 * a place, a life event, a dated plan, and every speaker name).
 */
export function shouldCompact(opts?: CompactOpts): boolean {
  const mode = opts?.mode ?? 'auto';
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return opts?.profile !== 'conversational';
}

export async function compact(
  chunks: Chunk[],
  provider: LLMProvider,
  budget: BudgetTracker,
  capUsd: number,
  concurrency = 1,
  jobKey?: string,
  opts?: CompactOpts,
): Promise<CompactResult[]> {
  // SKIP PATH. The pipeline already falls back to the raw chunk when a compact
  // result is empty (`r.text || chunks[r.index]?.text`, pipeline.ts) — so the
  // passthrough is not new machinery, it is a path that already existed and was
  // simply never reachable. Returning empty text here means extraction reads the
  // ORIGINAL chunk, with every speaker label and every passing mention intact.
  if (!shouldCompact(opts)) {
    return chunks.map(chk => ({ index: chk.index, text: '', usageUsd: 0 }));
  }

  if (!jobKey) {
    return mapWithConcurrency(chunks, concurrency, (chk) => compactChunk(chk, provider, budget, capUsd, opts?.profile));
  }

  const pending: Chunk[] = [];
  const cached: CompactResult[] = [];
  for (const chk of chunks) {
    const hit = chunkCheckpoints.get<CompactResult>(jobKey, 'compact', chk.index);
    if (hit !== undefined) cached.push(hit);
    else pending.push(chk);
  }

  const fresh = await mapWithConcurrency(pending, concurrency, async (chk) => {
    const result = await compactChunk(chk, provider, budget, capUsd, opts?.profile);
    chunkCheckpoints.set(jobKey, 'compact', chk.index, result);
    return result;
  });

  return [...cached, ...fresh].sort((a, b) => a.index - b.index);
}
