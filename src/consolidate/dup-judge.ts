/**
 * FEAT-549: batched LLM dup-judge over PENDING `consolidation_proposals`
 * rows of kind='merge' sitting in the propose band
 * [proposeThreshold, mergeThreshold) — cosine similarity alone cannot tell
 * "same fact paraphrased" from "two distinct facts" at that band's upper
 * edge (documented 0.90-0.92 false-merge risk, issue #190's own audit). The
 * >=mergeThreshold auto-merge tier is untouched by this FEAT — this module
 * only ever looks at proposals ALREADY sitting pending.
 *
 * Batched, not pairwise: mirrors `distill/atom-triage.ts`'s shape exactly
 * (FEAT-549 spec, "Options considered" — reimplementing a bespoke
 * prompt/schema instead of reusing an existing batched-judge pattern was
 * explicitly rejected). Both solve "classify N items in one LLM call,
 * fail-open, capped by count + wall-clock".
 *
 * Fail-open posture mirrors `contradiction-judge.ts` EXACTLY (FEAT-482
 * lesson: never a dollar cap — every shipped LLM provider hardcodes
 * `usage.usd: 0`, so a budget check can never trip; call-count +
 * wall-clock are the real, visible cost signals). A parse failure or a
 * thrown/rejected `chat()` call resolves to an EMPTY verdict Map, never
 * throws — the caller (`consolidate.ts`'s dup-judge sweep) treats every
 * proposal with no verdict entry as unchanged/pending, the same
 * "judge down = today's behavior" contract `contradiction-judge.ts`
 * documents for the contradiction path.
 */

import { z } from 'zod';
import type { LLMProvider, ChatMsg } from '../contracts/index.js';

/**
 * Stable marker embedded in the system prompt, mirroring
 * `CONTRADICTION_JUDGE_MARKER`/`ATOM_TRIAGE_MARKER` — lets a mock provider
 * route a batched dup-judge call to its own deterministic branch BEFORE any
 * `opts.json === true` extraction-call check would otherwise misclassify it
 * (extraction, the contradiction judge, atom-triage, and this all ask for
 * `json: true`).
 */
export const DUP_JUDGE_MARKER = 'astramem-dup-judge-v1';

export const DUP_VERDICT_LABELS = [
  'same-fact-merge',
  'distinct-keep-separate',
  'unclear-leave-pending',
] as const;

export type DupVerdictLabel = (typeof DUP_VERDICT_LABELS)[number];

export interface DupVerdict {
  /** The position (in the ORIGINAL, whole-sweep pending-proposal list) this
   *  verdict applies to — echoed back by the model from the numbered prompt
   *  so the caller can map a possibly-reordered/partial response back to
   *  the right proposal, same convention `TriageVerdict.index` uses. */
  index: number;
  verdict: DupVerdictLabel;
  confidence: number;
}

const DupVerdictSchema = z.object({
  index: z.number().int().min(0),
  verdict: z.enum(DUP_VERDICT_LABELS),
  confidence: z.number().min(0).max(1),
});

/** Strict shape — used ONLY to derive the JSON-schema hint sent to the
 *  provider below, never for parsing the response directly (mirrors
 *  `atom-triage.ts`'s identical strict/lenient split). */
const DupBatchSchema = z.object({ verdicts: z.array(DupVerdictSchema) });

/** Lenient at both levels — a single malformed verdict entry is dropped on
 *  its own rather than discarding every OTHER proposal's real verdict in
 *  the same batch response. */
const LenientDupBatchSchema = z.object({ verdicts: z.array(z.unknown()) });

/** JSON-schema mirror of the STRICT `DupBatchSchema` for providers with
 *  structured outputs (Ollama `format: <schema>`) — same qwen3.5
 *  duplicate-key-collapse fix `EXTRACTION_JSON_SCHEMA`/`TRIAGE_JSON_SCHEMA`
 *  close, applied here for the same reason. */
const DUP_JSON_SCHEMA = z.toJSONSchema(DupBatchSchema) as Record<string, unknown>;

const SYSTEM_PROMPT = `${DUP_JUDGE_MARKER}. You are reviewing PENDING consolidation proposals for a long-term
memory system — pairs of memory statements whose embeddings are similar enough to be candidate duplicates
but not similar enough to auto-merge. For EACH numbered pair below, classify the relationship into EXACTLY
ONE label:
same-fact-merge = both statements describe the SAME fact (paraphrase, alias, or formatting difference only) — safe to merge, no information lost.
distinct-keep-separate = the statements describe DIFFERENT facts that merely resemble each other in wording or topic — merging would lose or corrupt real information.
unclear-leave-pending = you cannot confidently tell which of the above applies — leave this one for human review.
Respond with a single JSON object: {"verdicts": [{"index": <pair number>, "verdict": "<label>", "confidence": <0..1>}, ...]}
— exactly one entry per numbered pair below, in any order.`;

export interface DupJudgeablePair {
  /** Position in the whole-sweep pending-proposal list — echoed back in the
   *  verdict so the caller can reassemble a Map keyed by this same index. */
  index: number;
  winnerText: string;
  loserText: string;
}

/**
 * Classify one batch of pending merge-proposal pairs in a single LLM call.
 * Never throws — a parse failure or a thrown/rejected `chat()` call is
 * logged and resolves to an EMPTY Map (fail-open: the caller treats every
 * proposal in this batch as unresolved/pending, same as if it had never
 * been judged at all).
 */
export async function dupJudgeBatch(
  llm: LLMProvider,
  pairs: DupJudgeablePair[],
  opts: { log?: (message: string) => void } = {},
): Promise<Map<number, DupVerdict>> {
  const log = opts.log ?? ((message: string) => console.warn(message));
  const result = new Map<number, DupVerdict>();
  if (pairs.length === 0) return result;

  const userContent = pairs
    .map((p) => `[${p.index}] A: ${p.winnerText}\nB: ${p.loserText}`)
    .join('\n');
  const messages: ChatMsg[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  try {
    const chatResult = await llm.chat(messages, {
      temperature: 0,
      json: true,
      jsonSchema: DUP_JSON_SCHEMA,
      maxTokens: 200 + pairs.length * 40,
    });
    const parsed = LenientDupBatchSchema.safeParse(JSON.parse(chatResult.text));
    if (!parsed.success) {
      log(
        `[dup-judge] unparsable batch response — leaving batch of ${pairs.length} proposals ` +
        `pending: ${parsed.error.message}`,
      );
      return result;
    }
    for (const raw of parsed.data.verdicts) {
      const verdict = DupVerdictSchema.safeParse(raw);
      // A single malformed entry is dropped on its own — every OTHER real
      // verdict in this batch response still lands in the Map. The dropped
      // proposal's index never appears here, so the caller's "no entry ->
      // stays pending" convention fails it open individually, same as a
      // provider error would for the whole batch.
      if (verdict.success) result.set(verdict.data.index, verdict.data);
    }
    return result;
  } catch (err) {
    log(
      `[dup-judge] batch call failed — leaving batch of ${pairs.length} proposals pending: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }
}

export interface DupJudgeCaps {
  /** Cap on dup-judge LLM calls (batches, not proposals) for a SINGLE sweep
   *  (one `runConsolidation()` call). Mirrors
   *  `contradictionDetection.maxPerRun`/`atomTriage.maxPerRun`. */
  maxPerRun: number;
  /** Wall-clock cap (ms) on the entire dup-judge sweep within a single
   *  `runConsolidation()` call. Mirrors `contradictionDetection
   *  .maxWallClockMs`/`atomTriage.maxWallClockMs` — bounds worst-case
   *  duration against a slow/rate-limited provider, which `maxPerRun` alone
   *  cannot (FEAT-482 lesson). */
  maxWallClockMs: number;
}

/**
 * Per-sweep call-count + wall-clock tracker, mirroring
 * `AtomTriageRunTracker` (src/distill/atom-triage.ts) exactly.
 *
 * `shouldStop()` is checked BEFORE each batch's LLM call; once it trips,
 * every remaining un-judged pending proposal in this sweep falls through
 * un-judged — stays `pending`, the fail-open contract this whole module
 * documents (never an auto-resolve-by-timeout).
 */
export class DupJudgeRunTracker {
  private callsThisRun = 0;
  private readonly startedAt = Date.now();
  private capReached = false;
  private wallClockCapReached = false;
  private loggedTrip = false;

  constructor(
    private readonly caps: DupJudgeCaps,
    private readonly log: (message: string) => void = (m) => console.warn(m),
  ) {}

  shouldStop(): boolean {
    if (this.callsThisRun >= this.caps.maxPerRun) {
      this.capReached = true;
      this.logTripOnce('call-count', `${this.callsThisRun}/${this.caps.maxPerRun} calls`);
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
    this.callsThisRun++;
  }

  state(): { callsExecuted: number; capReached: boolean; wallClockCapReached: boolean } {
    return {
      callsExecuted: this.callsThisRun,
      capReached: this.capReached,
      wallClockCapReached: this.wallClockCapReached,
    };
  }

  private logTripOnce(kind: 'call-count' | 'wall-clock', detail: string): void {
    if (this.loggedTrip) return;
    this.loggedTrip = true;
    this.log(
      `[dup-judge] ${kind} cap reached (${detail}) — skipping further dup-judge calls this sweep; ` +
      'remaining pending proposals stay pending (never auto-resolved by timeout).',
    );
  }
}
