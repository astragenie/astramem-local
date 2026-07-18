/**
 * FEAT-533 (+ FEAT-547 v2): LLM atom-triage tier — a batched, post-
 * extraction, pre-persist classification call that returns up to THREE
 * verdicts per atom in the SAME call:
 *
 *  1. keep|junk|meta-echo|capability-disclaimer|ephemeral|rephrase-of-
 *     existing (FEAT-533, unchanged labels/semantics).
 *  2. `corrected_type` (FEAT-547, optional): a 7-class re-label, applied
 *     post-triage ONLY when `confidence >= CORRECTED_TYPE_CONFIDENCE_GATE`
 *     — see that constant's doc comment. Absent or under-gate leaves the
 *     atom's original type untouched.
 *  3. `evidence_supported` (FEAT-547, optional): whether an evidence-
 *     bearing atom's quote actually supports its claim (semantic check —
 *     FEAT-542's mechanical quote-verification catches string mismatch;
 *     this catches supported-string/unsupported-claim). Stored as a
 *     queryable flag on the memory row; NEVER deletes or rewrites the atom.
 *
 * Layered ON TOP of the existing regex `durability-gate.ts` taxonomy at the
 * SAME insertion point (`src/distill/stages/08-embed-index.ts`'s
 * `embedAndIndex` loop) — the regex gate runs first (free, no LLM call),
 * this tier only ever sees survivors.
 *
 * Batching: a fixed ATOM-COUNT batch (`distill.atomTriage.batchSize`) over
 * the flat post-reduce/post-normalize atom stream for the WHOLE JOB, never
 * per chunk and never one call per atom — see
 * `Config['distill']['atomTriage']`'s doc comment for why (stage 6's
 * `reduce()` destroys chunk identity before this point). FEAT-547 v2 fuses
 * the two new verdicts into this SAME batched call rather than issuing
 * separate round-trips — a local clerk-role model should make ONE batched
 * judgment call per atom, not multiple (see FEAT-547 spec "Options
 * considered"), and fusing avoids doubling `maxPerRun`/wall-clock budget.
 *
 * Fail-open, mirroring `contradiction-judge.ts`'s posture exactly: a parse
 * failure or a thrown/rejected `chat()` call returns an EMPTY verdict map
 * rather than throwing — the caller (embedAndIndex) treats every atom with
 * no verdict entry as an implicit 'keep' (ADR-015: a broken triage provider
 * must never silently drop real atoms; it must fail loud in the log and
 * fail open in behavior). The SAME fail-open posture applies per-entry: a
 * single verdict entry with an invalid `corrected_type` label or malformed
 * `evidence_supported` value is dropped on its own (see
 * `TriageVerdictSchema` below) without discarding any other real verdict in
 * the same batch response.
 */

import { z } from 'zod';
import type { LLMProvider, ChatMsg, MemoryType } from '../contracts/index.js';

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

/**
 * FEAT-547: 7-class atom-type taxonomy `corrected_type` may re-label an
 * atom into — the SAME closed enum `AtomSchema.type` uses
 * (`src/distill/prompts/extract.ts`), NOT the wider 10-value
 * `MEMORY_TYPES` union (`src/contracts/memory.ts`). A re-typing pass can
 * only assign a label the extractor itself is capable of producing; the 3
 * cloud-only values (`preference`/`task_result`/`summary`) are deliberately
 * excluded, mirroring `extract.ts`'s own out-of-scope note for that same
 * split.
 */
export const CORRECTED_TYPE_LABELS = [
  'decision', 'fact', 'lesson', 'command', 'todo', 'note', 'event',
] as const satisfies readonly MemoryType[];

/**
 * FEAT-547 AC-2: confidence floor a `corrected_type` verdict must clear
 * before `embedAndIndex` overwrites an atom's stored type with it. Named
 * (not a magic number inline) per AC-2's explicit requirement. Measured
 * typeAcc (codex 63%, qwen2.5:7b 25-48%, phi 31-48%) means an ungated apply
 * would introduce as much mis-typing as it fixes for the weaker providers
 * — see FEAT-547 spec "Options considered" for why this gate is required,
 * not optional, and is applied per-atom against ONE shared `confidence`
 * value (the verdict's own, not a separate per-field confidence).
 */
export const CORRECTED_TYPE_CONFIDENCE_GATE = 0.8;

export interface TriageVerdict {
  /** The position (in the ORIGINAL, whole-job atom stream) this verdict
   *  applies to — echoed back by the model from the numbered prompt so the
   *  caller can map a possibly-reordered/partial response back to the
   *  right atom. */
  index: number;
  verdict: TriageVerdictLabel;
  confidence: number;
  /** FEAT-547: optional re-label into the 7-class taxonomy above. Applied
   *  by the caller (embedAndIndex) only when `confidence >=
   *  CORRECTED_TYPE_CONFIDENCE_GATE`; absent (the overwhelming majority of
   *  verdicts — most atoms are typed correctly on first pass) leaves the
   *  atom's original type untouched. */
  corrected_type?: MemoryType;
  /** FEAT-547: optional semantic evidence-support flag — only meaningful
   *  for an atom whose `evidence` quote was included in this verdict's
   *  input (see `TriageableAtom.evidence` below); the model is instructed
   *  to omit this field for an atom with no evidence quote to judge.
   *  `false` flags a queryable mismatch (evidence present but does not
   *  actually support the claim) — the caller NEVER deletes or rewrites
   *  the atom for this, only sets a flag. */
  evidence_supported?: boolean;
}

const TriageVerdictSchema = z.object({
  index: z.number().int().min(0),
  verdict: z.enum(TRIAGE_VERDICT_LABELS),
  confidence: z.number().min(0).max(1),
  // FEAT-547 AC-1/AC-6: both optional — a response omitting either (or
  // both) parses successfully with the field(s) left `undefined` (backward-
  // compatible with the pre-v2 single-verdict shape), and a PRESENT-but-
  // invalid value (bad type label, non-boolean) fails THIS entry's parse
  // only — the caller's existing per-entry safeParse loop already drops a
  // single malformed entry without discarding the rest of the batch.
  corrected_type: z.enum(CORRECTED_TYPE_LABELS).optional(),
  evidence_supported: z.boolean().optional(),
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

Additionally, for each atom, OPTIONALLY include:
corrected_type = one of decision|fact|lesson|command|todo|note|event, ONLY when you are confident the atom is
mis-typed and this is a better label. Omit this field entirely when you are not confident, or the atom's
current framing already fits.
evidence_supported = true or false, ONLY for an atom shown below with an "[evidence: ...]" quote attached —
true when that quote genuinely supports the atom's claim, false when it does not (e.g. the quote is present but
unrelated or contradicts the claim). Omit this field entirely for any atom with no evidence quote shown.

Respond with a single JSON object: {"verdicts": [{"index": <atom number>, "verdict": "<label>", "confidence": <0..1>,
"corrected_type": "<optional type>", "evidence_supported": <optional true|false>}, ...]}
— exactly one entry per numbered atom below, in any order. Omit corrected_type/evidence_supported keys entirely
rather than guessing when unsure.`;

export interface TriageableAtom {
  /** Position in the whole-job atom stream — echoed back in the verdict so
   *  the caller can reassemble a Map keyed by this same index. */
  index: number;
  text: string;
  /** FEAT-547: this atom's evidence quote (if any), shown alongside its
   *  text so the model has something to judge `evidence_supported`
   *  against. Omitted for an atom with no evidence — the prompt instructs
   *  the model to omit `evidence_supported` for those, never guess. */
  evidence?: string;
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

  // FEAT-547: an atom carrying an evidence quote shows it inline (parsed
  // back out by the `[index] text [evidence: "..."]` shape the daemon-side
  // test mock and this same builder agree on) so the model has something
  // concrete to judge `evidence_supported` against — an atom with no quote
  // omits the suffix entirely, matching the prompt's "omit for atoms with no
  // evidence shown" instruction.
  const userContent = atoms
    .map((a) => `[${a.index}] ${a.text}${a.evidence ? ` [evidence: "${a.evidence}"]` : ''}`)
    .join('\n');
  const messages: ChatMsg[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  try {
    const chatResult = await llm.chat(messages, {
      temperature: 0,
      json: true,
      jsonSchema: TRIAGE_JSON_SCHEMA,
      // FEAT-547: bumped per-atom budget (40 -> 70) — v2 verdicts can carry
      // two additional fields (corrected_type/evidence_supported) per atom.
      maxTokens: 200 + atoms.length * 70,
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
