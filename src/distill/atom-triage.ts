/**
 * FEAT-533: LLM atom-triage tier — a batched, post-extraction, pre-persist
 * classification call that labels each candidate atom keep|junk|meta-echo|
 * capability-disclaimer|ephemeral|rephrase-of-existing. Layered ON TOP of
 * the existing regex `durability-gate.ts` taxonomy at the SAME insertion
 * point (`src/distill/stages/08-embed-index.ts`'s `embedAndIndex` loop) —
 * the regex gate runs first (free, no LLM call), this tier only ever sees
 * survivors.
 *
 * Batching: a fixed ATOM-COUNT batch (`distill.atomTriage.batchSize`) over
 * the flat post-reduce/post-normalize atom stream for the WHOLE JOB, never
 * per chunk and never one call per atom — see
 * `Config['distill']['atomTriage']`'s doc comment for why (stage 6's
 * `reduce()` destroys chunk identity before this point).
 *
 * Fail-open, mirroring `contradiction-judge.ts`'s posture exactly: a parse
 * failure or a thrown/rejected `chat()` call returns an EMPTY verdict map
 * rather than throwing — the caller (embedAndIndex) treats every atom with
 * no verdict entry as an implicit 'keep' (ADR-015: a broken triage provider
 * must never silently drop real atoms; it must fail loud in the log and
 * fail open in behavior).
 */

import { z } from 'zod';
import type { LLMProvider, ChatMsg } from '../contracts/index.js';

/**
 * Stable marker embedded in the system prompt, mirroring
 * `CONTRADICTION_JUDGE_MARKER` (contradiction-judge.ts) — lets test mock
 * providers route a batched triage call to its own deterministic branch
 * BEFORE the `opts.json === true` extraction-call check would otherwise
 * misclassify it (extraction, the judge, and triage all ask for
 * `json: true`).
 */
export const ATOM_TRIAGE_MARKER = 'astramem-atom-triage-v1';

export const TRIAGE_VERDICT_LABELS = [
  'keep',
  'junk',
  'meta-echo',
  'capability-disclaimer',
  'ephemeral',
  'rephrase-of-existing',
] as const;

export type TriageVerdictLabel = (typeof TRIAGE_VERDICT_LABELS)[number];

export interface TriageVerdict {
  /** The position (in the ORIGINAL, whole-job atom stream) this verdict
   *  applies to — echoed back by the model from the numbered prompt so the
   *  caller can map a possibly-reordered/partial response back to the
   *  right atom. */
  index: number;
  verdict: TriageVerdictLabel;
  confidence: number;
}

const TriageVerdictSchema = z.object({
  index: z.number().int().min(0),
  verdict: z.enum(TRIAGE_VERDICT_LABELS),
  confidence: z.number().min(0).max(1),
});

/** Strict shape — used ONLY to derive the JSON-schema hint sent to the
 *  provider below, never for parsing the response directly (see
 *  `LenientTriageBatchSchema` for why). */
const TriageBatchSchema = z.object({ verdicts: z.array(TriageVerdictSchema) });

/** Lenient at both levels — `verdicts` accepts any array of unknown objects
 *  at parse time, same "don't reject the whole response over one bad
 *  entry" posture `LenientExtractionSchema` uses in 05-extract.ts. Each
 *  element is then individually re-validated against `TriageVerdictSchema`
 *  by the caller below — a single malformed verdict entry (bad label, out-
 *  of-range confidence, missing index) is dropped on its own rather than
 *  discarding every OTHER atom's real verdict in the same batch response. */
const LenientTriageBatchSchema = z.object({ verdicts: z.array(z.unknown()) });

/** JSON-schema mirror of the STRICT `TriageBatchSchema` for providers with
 *  structured outputs (Ollama `format: <schema>`), converted once at module
 *  load — same qwen3.5 duplicate-key-collapse fix EXTRACTION_JSON_SCHEMA
 *  (05-extract.ts) closes, applied here for the same reason: bare
 *  `json: true` alone doesn't constrain shape. The schema HINT sent to the
 *  provider is deliberately strict even though local parsing (above) is
 *  lenient — same split 05-extract.ts uses. */
const TRIAGE_JSON_SCHEMA = z.toJSONSchema(TriageBatchSchema) as Record<string, unknown>;

const SYSTEM_PROMPT = `${ATOM_TRIAGE_MARKER}. You are triaging memory atoms extracted from a conversation
transcript before they are permanently stored in a long-term memory system. For EACH numbered atom below,
classify it into EXACTLY ONE of these labels:
keep = a genuinely durable fact, decision, lesson, or reusable piece of knowledge worth remembering.
junk = low-signal noise with no lasting value (e.g. a bare acknowledgement or filler).
meta-echo = a recall/search-query echo — restates what was searched for or asked, not a fact about the world.
capability-disclaimer = a first-person statement about what the assistant can or cannot do ("I don't have access to...").
ephemeral = true only at the instant it was written — a transient status/state that is stale immediately after.
rephrase-of-existing = a near-duplicate restatement of something another atom in this SAME batch already says.
Respond with a single JSON object: {"verdicts": [{"index": <atom number>, "verdict": "<label>", "confidence": <0..1>}, ...]}
— exactly one entry per numbered atom below, in any order.`;

export interface TriageableAtom {
  /** Position in the whole-job atom stream — echoed back in the verdict so
   *  the caller can reassemble a Map keyed by this same index. */
  index: number;
  text: string;
}

/**
 * Classify one batch of atoms in a single LLM call. Never throws — a parse
 * failure or a thrown/rejected `chat()` call is logged and resolves to an
 * EMPTY Map (fail-open: the caller treats every atom in this batch as an
 * implicit 'keep').
 */
export async function triageBatch(
  llm: LLMProvider,
  atoms: TriageableAtom[],
  opts: { log?: (message: string) => void } = {},
): Promise<Map<number, TriageVerdict>> {
  const log = opts.log ?? ((message: string) => console.warn(message));
  const result = new Map<number, TriageVerdict>();
  if (atoms.length === 0) return result;

  const userContent = atoms.map((a) => `[${a.index}] ${a.text}`).join('\n');
  const messages: ChatMsg[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  try {
    const chatResult = await llm.chat(messages, {
      temperature: 0,
      json: true,
      jsonSchema: TRIAGE_JSON_SCHEMA,
      maxTokens: 200 + atoms.length * 40,
    });
    const parsed = LenientTriageBatchSchema.safeParse(JSON.parse(chatResult.text));
    if (!parsed.success) {
      log(`[atom-triage] unparsable batch response — failing open (batch of ${atoms.length} atoms kept): ${parsed.error.message}`);
      return result;
    }
    for (const raw of parsed.data.verdicts) {
      const verdict = TriageVerdictSchema.safeParse(raw);
      // A single malformed entry is dropped on its own — every OTHER real
      // verdict in this batch response still lands in the Map. The dropped
      // atom's index never appears here, so the caller's "no entry ->
      // implicit keep" convention fails it open individually, same as a
      // provider error would for the whole batch.
      if (verdict.success) result.set(verdict.data.index, verdict.data);
    }
    return result;
  } catch (err) {
    log(
      `[atom-triage] batch call failed — failing open (batch of ${atoms.length} atoms kept): ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }
}

export interface AtomTriageCaps {
  /** Cap on triage LLM calls (batches, not atoms) for a SINGLE embedAndIndex
   *  call. Mirrors `contradictionDetection.maxPerRun`. */
  maxPerRun: number;
  /** Wall-clock cap (ms) on the entire triage sweep within a single
   *  embedAndIndex call. Mirrors `contradictionDetection.maxWallClockMs` —
   *  bounds worst-case duration against a slow/rate-limited provider, which
   *  maxPerRun alone cannot (FEAT-482 lesson). */
  maxWallClockMs: number;
}

/**
 * Per-job call-count + wall-clock tracker for the triage batch sweep.
 * Mirrors `DistillCostCapTracker` (src/distill/cost-cap.ts) exactly, minus
 * the `enabled` toggle — a caller only ever constructs this when
 * `distill.atomTriage.mode !== 'off'`, so there is no disabled state to
 * represent here (unlike the opt-in cost cap, which ships off by default
 * and needs to no-op).
 *
 * `shouldStop()` is checked BEFORE each batch's LLM call; once it trips,
 * every remaining un-triaged atom in this job falls through un-triaged —
 * the caller's "no verdict entry means keep" fail-open convention means
 * this is a graceful degrade to "persist unfiltered", never a
 * drop-by-timeout (FEAT-482 lesson, restated for this cap).
 */
export class AtomTriageRunTracker {
  private callsThisJob = 0;
  private readonly startedAt = Date.now();
  private capReached = false;
  private wallClockCapReached = false;
  private loggedTrip = false;

  constructor(
    private readonly caps: AtomTriageCaps,
    private readonly log: (message: string) => void = (m) => console.warn(m),
  ) {}

  shouldStop(): boolean {
    if (this.callsThisJob >= this.caps.maxPerRun) {
      this.capReached = true;
      this.logTripOnce('call-count', `${this.callsThisJob}/${this.caps.maxPerRun} calls`);
      return true;
    }
    const elapsed = Date.now() - this.startedAt;
    if (elapsed >= this.caps.maxWallClockMs) {
      this.wallClockCapReached = true;
      this.logTripOnce('wall-clock', `${elapsed}ms/${this.caps.maxWallClockMs}ms`);
      return true;
    }
    return false;
  }

  recordCall(): void {
    this.callsThisJob++;
  }

  state(): { callsExecuted: number; capReached: boolean; wallClockCapReached: boolean } {
    return {
      callsExecuted: this.callsThisJob,
      capReached: this.capReached,
      wallClockCapReached: this.wallClockCapReached,
    };
  }

  private logTripOnce(kind: 'call-count' | 'wall-clock', detail: string): void {
    if (this.loggedTrip) return;
    this.loggedTrip = true;
    this.log(
      `[atom-triage] ${kind} cap reached (${detail}) — skipping further triage calls for this job; ` +
      "remaining atoms fall through un-triaged (treated as 'keep', persist unfiltered — never drop-by-timeout).",
    );
  }
}
