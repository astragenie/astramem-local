/**
 * FEAT-548: ingest gatekeeper — an optional, chunk-level pre-extraction
 * substantiveness gate. Inserted right after stage 3 (chunk), BEFORE stage 4
 * (compact) and stage 5 (extract) ever run — the opposite chokepoint from
 * `atom-triage.ts` (which filters ATOMS a metered call has already
 * produced). A `skip` verdict here means the metered extraction (and
 * compaction) call for that chunk is never made at all.
 *
 * Batching: a fixed CHUNK-COUNT batch (`distill.gatekeeper.batchSize`) over
 * the whole job's chunk list for the WHOLE JOB, never one call per chunk —
 * same call-count discipline `atom-triage.ts` documents, applied one stage
 * earlier (chunks are already discrete units here, so this batches purely to
 * cap total call count on a session with many chunks, not to work around any
 * loss of identity the way atom-triage's post-`reduce()` batching does).
 *
 * Fail-open, mirroring `atom-triage.ts`/`contradiction-judge.ts`'s posture
 * exactly: a parse failure or a thrown/rejected `chat()` call returns an
 * EMPTY verdict map rather than throwing — the caller (runPipeline) treats
 * every chunk with no verdict entry as an implicit 'keep' (ADR-015: a broken
 * gatekeeper provider must never silently drop a chunk; it must fail loud in
 * the log and fail open in behavior).
 */

import { z } from 'zod';
import type { LLMProvider, ChatMsg } from '../contracts/index.js';
import { RunCapTracker } from '../util/run-cap-tracker.js';

/**
 * Stable marker embedded in the system prompt, mirroring `ATOM_TRIAGE_MARKER`
 * (atom-triage.ts) — lets test mock providers route a batched gatekeeper
 * call to its own deterministic branch BEFORE the `opts.json === true`
 * extraction-call check would otherwise misclassify it (extraction, atom
 * triage, and the gatekeeper all ask for `json: true`).
 */
export const GATEKEEPER_MARKER = 'astramem-gatekeeper-v1';

export const GATEKEEPER_VERDICT_LABELS = ['keep', 'skip'] as const;

export type GatekeeperVerdictLabel = (typeof GATEKEEPER_VERDICT_LABELS)[number];

export interface GatekeeperVerdict {
  /** The position (in the ORIGINAL, whole-job chunk list) this verdict
   *  applies to — echoed back by the model from the numbered prompt so the
   *  caller can map a possibly-reordered/partial response back to the right
   *  chunk. */
  index: number;
  verdict: GatekeeperVerdictLabel;
  confidence: number;
}

const GatekeeperVerdictSchema = z.object({
  index: z.number().int().min(0),
  verdict: z.enum(GATEKEEPER_VERDICT_LABELS),
  confidence: z.number().min(0).max(1),
});

/** Strict shape — used ONLY to derive the JSON-schema hint sent to the
 *  provider below, never for parsing the response directly (see
 *  `LenientGatekeeperBatchSchema` for why). */
const GatekeeperBatchSchema = z.object({ verdicts: z.array(GatekeeperVerdictSchema) });

/** Lenient at both levels — same "don't reject the whole response over one
 *  bad entry" posture `LenientTriageBatchSchema` (atom-triage.ts) uses. Each
 *  element is then individually re-validated against
 *  `GatekeeperVerdictSchema` by the caller below — a single malformed
 *  verdict entry (bad label, out-of-range confidence, missing index) is
 *  dropped on its own rather than discarding every OTHER chunk's real
 *  verdict in the same batch response. */
const LenientGatekeeperBatchSchema = z.object({ verdicts: z.array(z.unknown()) });

/** JSON-schema mirror of the STRICT `GatekeeperBatchSchema`, converted once
 *  at module load — same qwen3.5 duplicate-key-collapse fix
 *  EXTRACTION_JSON_SCHEMA (05-extract.ts) closes, applied here for the same
 *  reason: bare `json: true` alone doesn't constrain shape. */
const GATEKEEPER_JSON_SCHEMA = z.toJSONSchema(GatekeeperBatchSchema) as Record<string, unknown>;

const SYSTEM_PROMPT = `${GATEKEEPER_MARKER}. You are screening chunks of a conversation transcript BEFORE
they are sent to a more expensive extraction model that pulls out durable facts, decisions, and lessons. For
EACH numbered chunk below, classify it into EXACTLY ONE of these labels:
keep = the chunk contains at least one durably memorable fact, decision, lesson, preference, or reusable piece
of knowledge worth extracting.
skip = the chunk is pure noise with nothing durably memorable — greetings, acknowledgements, filler, tool-call
spam, or small talk with no lasting content.
When in doubt, choose keep — a false skip silently loses real information, while a false keep only costs one
extra (cheap, local) extraction call.
Respond with a single JSON object: {"verdicts": [{"index": <chunk number>, "verdict": "<label>", "confidence": <0..1>}, ...]}
— exactly one entry per numbered chunk below, in any order.`;

export interface GateableChunk {
  /** Position in the whole-job chunk list — echoed back in the verdict so
   *  the caller can reassemble a Map keyed by this same index. */
  index: number;
  text: string;
}

/**
 * Classify one batch of chunks in a single LLM call. Never throws — a parse
 * failure or a thrown/rejected `chat()` call is logged and resolves to an
 * EMPTY Map (fail-open: the caller treats every chunk in this batch as an
 * implicit 'keep').
 */
export async function gatekeeperBatch(
  llm: LLMProvider,
  chunks: GateableChunk[],
  opts: { log?: (message: string) => void } = {},
): Promise<Map<number, GatekeeperVerdict>> {
  const log = opts.log ?? ((message: string) => console.warn(message));
  const result = new Map<number, GatekeeperVerdict>();
  if (chunks.length === 0) return result;

  const userContent = chunks.map((c) => `[${c.index}] ${c.text}`).join('\n');
  const messages: ChatMsg[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  try {
    const chatResult = await llm.chat(messages, {
      temperature: 0,
      json: true,
      jsonSchema: GATEKEEPER_JSON_SCHEMA,
      maxTokens: 200 + chunks.length * 40,
    });
    const parsed = LenientGatekeeperBatchSchema.safeParse(JSON.parse(chatResult.text));
    if (!parsed.success) {
      log(`[gatekeeper] unparsable batch response — failing open (batch of ${chunks.length} chunks kept): ${parsed.error.message}`);
      return result;
    }
    for (const raw of parsed.data.verdicts) {
      const verdict = GatekeeperVerdictSchema.safeParse(raw);
      // A single malformed entry is dropped on its own — every OTHER real
      // verdict in this batch response still lands in the Map. The dropped
      // chunk's index never appears here, so the caller's "no entry ->
      // implicit keep" convention fails it open individually, same as a
      // provider error would for the whole batch.
      if (verdict.success) result.set(verdict.data.index, verdict.data);
    }
    return result;
  } catch (err) {
    log(
      `[gatekeeper] batch call failed — failing open (batch of ${chunks.length} chunks kept): ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }
}

export interface GatekeeperCaps {
  /** Cap on gatekeeper LLM calls (batches, not chunks) for a SINGLE
   *  runPipeline call. Mirrors `AtomTriageCaps.maxPerRun`. */
  maxPerRun: number;
  /** Wall-clock cap (ms) on the entire gatekeeper sweep within a single
   *  runPipeline call. Mirrors `AtomTriageCaps.maxWallClockMs` — bounds
   *  worst-case duration against a slow/rate-limited provider, which
   *  maxPerRun alone cannot (FEAT-482 lesson). */
  maxWallClockMs: number;
}

/**
 * Per-job call-count + wall-clock tracker for the gatekeeper batch sweep.
 * Mirrors `AtomTriageRunTracker` (src/distill/atom-triage.ts) exactly — see
 * that class's doc comment for the full rationale, restated here for the
 * chunk-level gate.
 *
 * `shouldStop()` is checked BEFORE each batch's LLM call; once it trips,
 * every remaining un-gated chunk in this job falls through un-gated — the
 * caller's "no verdict entry means keep" fail-open convention means this is
 * a graceful degrade to "extract unfiltered", never a drop-by-timeout
 * (FEAT-482 lesson, restated for this cap).
 */
export class GatekeeperRunTracker extends RunCapTracker {
  constructor(caps: GatekeeperCaps, log: (message: string) => void = (m) => console.warn(m)) {
    super(
      caps,
      {
        tag: 'gatekeeper',
        skipping: 'further gate calls for this job',
        fallthrough:
          "remaining chunks fall through un-gated (treated as 'keep', extract unfiltered — never drop-by-timeout).",
      },
      log,
    );
  }
}

export interface GatekeeperSweepResult {
  /** Verdict for every chunk the sweep actually classified (successfully
   *  parsed responses only) — a chunk with no entry is implicitly 'keep'. */
  verdicts: Map<number, GatekeeperVerdict>;
  /** Count of chunks ATTEMPTED (sent in a batch), regardless of whether that
   *  batch's response was parseable — mirrors atom-triage's
   *  atomsTriagedCount: a provider that fails open on every call still
   *  consumed real job volume, and the rate denominator must reflect that
   *  (canary-must-measure-rate-not-existence). */
  chunksEvaluated: number;
}

/**
 * Run the full batched gatekeeper sweep over one job's chunk list. Returns
 * immediately with an empty result (no LLM call) when `chunks` is empty or
 * no provider is supplied — same no-op convention `atom-triage.ts`'s caller
 * loop (08-embed-index.ts) uses for `llmAtomTriage`.
 */
export async function runGatekeeperSweep(
  chunks: GateableChunk[],
  llm: LLMProvider | undefined,
  opts: {
    batchSize: number;
    caps: GatekeeperCaps;
    log?: (message: string) => void;
  },
): Promise<GatekeeperSweepResult> {
  const verdicts = new Map<number, GatekeeperVerdict>();
  let chunksEvaluated = 0;
  if (!llm || chunks.length === 0) return { verdicts, chunksEvaluated };

  const log = opts.log ?? ((message: string) => console.warn(message));
  const tracker = new GatekeeperRunTracker(opts.caps, log);

  for (let start = 0; start < chunks.length; start += opts.batchSize) {
    // Cap reached — every remaining chunk falls through un-gated (no verdict
    // entry -> implicit 'keep' below): fail OPEN, never drop-by-timeout
    // (FEAT-482 lesson, restated for this cap).
    if (tracker.shouldStop()) break;
    const batch = chunks.slice(start, start + opts.batchSize);
    tracker.recordCall();
    const batchVerdicts = await gatekeeperBatch(llm, batch, { log });
    for (const [index, verdict] of batchVerdicts) verdicts.set(index, verdict);
    // Count every ATTEMPTED chunk (not just successfully-classified ones)
    // toward the rate denominator — see GatekeeperSweepResult.chunksEvaluated.
    chunksEvaluated += batch.length;
  }

  return { verdicts, chunksEvaluated };
}
