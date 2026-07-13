/**
 * Stage 5 — Extract (LLM JSON-mode per chunk)
 *
 * Emits typed atoms {type, text, importance, confidence, evidence}.
 * Zod-validates the JSON response. A parse/validation failure throws
 * TransientError — LLM JSON output is stochastic, so the worker retries
 * (with backoff, up to its normal attempt cap) before poisoning the job,
 * rather than dropping a whole session's memories on one bad sample.
 * Throws BudgetExceeded if over cap.
 */

import { z } from 'zod';
import type { LLMProvider, ChatMsg } from '../../contracts/index.js';
import {
  AtomSchema,
  EntityKindSchema,
  RELATION_PREDICATES,
  resolveExtractionPrompt,
  type Atom,
  type ExtractProfile,
} from '../prompts/extract.js';
import { BudgetTracker, BudgetExceeded } from '../../budget/tracker.js';
import { TransientError } from '../../pipeline/errors.js';
import { mapWithConcurrency } from '../concurrency.js';
import { chunkCheckpoints } from '../chunk-checkpoint.js';
import { normalizeEntityName } from '../../entity/normalize.js';
import { childLogger } from '../../log/logger.js';

export type { ExtractProfile };

// FEAT-479 (D3 §3.2): the extraction prompt used to be pinned once at module
// load (`ASTRA_EXTRACT_PROMPT=v2` swaps in the v2 a/b candidate; anything
// else, incl. unset, kept v1). Resolution now happens per pipeline run via
// `resolveExtractionPrompt` (src/distill/prompts/extract.ts) — same env-var
// override semantics, plus the `extractProfile` param threaded below —
// so a caller in one process can run 'engineering' and 'conversational'
// extractions back to back rather than being stuck with whatever the env
// var said at process start.

// Extraction sampling temperature. Default 0.1; `ASTRA_EXTRACT_TEMP=0` makes
// JSON output fully deterministic (a/b lever — may reduce stochastic parse
// failures). Invalid values fall back to 0.1.
const EXTRACT_TEMPERATURE = (() => {
  const raw = process.env.ASTRA_EXTRACT_TEMP;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : 0.1;
})();

/**
 * Lenient wrapper: accepts any objects in the atoms array so that individual
 * bad atoms (short text, unknown type, etc.) don't reject the whole response.
 * Valid atoms are filtered with AtomSchema after JSON parsing.
 */
const LenientExtractionSchema = z.object({ atoms: z.array(z.unknown()) });

export { BudgetExceeded };
export type { Atom };

export interface ExtractResult {
  chunkIndex: number;
  atoms: Atom[];
  usageUsd: number;
  retried: boolean;
  /**
   * FEAT-481 SLICE-430: per-reason drop counts from this chunk's
   * filterAtomRelations pass (design doc §2.2/§2.3) -- 'predicate_invalid',
   * 'missing_fields', 'subject_equals_object', 'no_hallucination_guard'.
   * Empty object when the chunk's atoms had no relations[] to filter, or
   * every triple survived. Never includes reasons with a zero count. See
   * src/storage/relation-guard-log.ts for why this is persisted.
   */
  relationDropCounts: Record<string, number>;
}

/**
 * Extract atoms from a single compacted chunk.
 *
 * Parse / Zod validation failure → throws TransientError. The worker
 * classifies this as transient and retries (with backoff) up to its normal
 * attempt cap before poisoning the job — LLM JSON output is stochastic (the
 * same chunk can parse cleanly on the very next call), so a single flaky
 * sample must not permanently drop a session's memories.
 *
 * Follow-up (not yet wired): EXTRACTION_STRICT_PROMPT already exists as a
 * stricter variant, but no attempt number is threaded from the worker's
 * retry count down into this function, so retries currently reuse the base
 * prompt rather than escalating to it.
 */
export async function extractChunk(
  chunkIndex: number,
  text: string,
  provider: LLMProvider,
  budget: BudgetTracker,
  capUsd: number,
  /** FEAT-479 AC-2: already-precedence-resolved (envelope > config default)
   * by the caller (see PipelineContext.extractProfile / runPipeline) —
   * defaults to 'engineering', the byte-identical pre-FEAT-479 behavior,
   * for callers that don't pass one. `ASTRA_EXTRACT_PROMPT` is applied on
   * top of this, per call, inside resolveExtractionPrompt. */
  extractProfile: ExtractProfile = 'engineering',
): Promise<ExtractResult> {
  if (!text.trim()) {
    return { chunkIndex, atoms: [], usageUsd: 0, retried: false, relationDropCounts: {} };
  }

  const activePrompt = resolveExtractionPrompt(extractProfile, process.env.ASTRA_EXTRACT_PROMPT);
  const promptChars = activePrompt.length + text.length;
  const estimateUsd = BudgetTracker.estimateUsd(promptChars, 0.000002, 0.000002);

  budget.assertCanSpend(estimateUsd, capUsd);

  const result = await callExtract(text, activePrompt, provider);
  budget.record(result.usageUsd);

  const parsed = tryParseAtoms(result.text);
  if (parsed !== null) {
    return {
      chunkIndex,
      atoms: parsed.atoms,
      usageUsd: result.usageUsd,
      retried: false,
      relationDropCounts: parsed.relationDropCounts,
    };
  }

  // Parse / schema failure — LLM JSON output is stochastic, so treat it as
  // transient and let the worker retry (up to its attempt cap) instead of
  // poisoning on a single bad sample.
  throw new TransientError(
    `[extract] chunk ${chunkIndex}: Zod/JSON parse failed — raw: ${result.text.slice(0, 200)}`,
  );
}

async function callExtract(
  text: string,
  systemPrompt: string,
  provider: LLMProvider,
): Promise<{ text: string; usageUsd: number }> {
  const messages: ChatMsg[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Extract knowledge atoms from this transcript chunk:\n\n${text}` },
  ];

  const result = await provider.chat(messages, {
    temperature: EXTRACT_TEMPERATURE,
    json: true,
    // FEAT-479 (SLICE-433): bumped 1500 -> 2500. The v3 engineering prompt's
    // 300-800 char rich shape for lesson/decision atoms (vs v1/v2's ~500
    // char cap applied uniformly) makes a full 2-6 atom chunk with a couple
    // of rich atoms noticeably larger JSON than before; 1500 tokens left
    // little headroom before truncating mid-atom into an unparseable
    // response (which the caller can only see as a TransientError retry,
    // not a clear cause). Cost is driven by the provider's actual usage.usd,
    // not this ceiling, so raising it does not change the per-call budget
    // estimate above.
    maxTokens: 2500,
  });

  return { text: result.text, usageUsd: result.usage.usd };
}

/**
 * Coerce an out-of-enum entities[].kind to 'other' instead of letting one bad
 * entity sink the whole atom under AtomSchema's nested validation. Mirrors
 * the cloud-side safe-narrow in AstraMemory.Domain/EntityKinds.Normalize() —
 * an unrecognized kind (stale local build, newer contract value this build
 * doesn't know yet, LLM hallucination) must not cause silent atom loss.
 * Only the `kind` field is touched; every other atom/entity field passes
 * through unchanged for AtomSchema to validate normally.
 */
function coerceEntityKinds(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const atom = raw as Record<string, unknown>;
  if (!Array.isArray(atom.entities)) return raw;

  const entities = atom.entities.map((entity) => {
    if (entity === null || typeof entity !== 'object' || Array.isArray(entity)) return entity;
    const e = entity as Record<string, unknown>;
    if (EntityKindSchema.safeParse(e.kind).success) return entity;
    return { ...e, kind: 'other' };
  });

  return { ...atom, entities };
}

/** Closed predicate vocabulary (design doc §2.4/AC-6): the 10 cloud-parity
 * values plus the local-only 'other' bucket — exact, case-sensitive match. */
const VALID_RELATION_PREDICATES = new Set<string>([...RELATION_PREDICATES, 'other']);

/**
 * Filter an atom's raw `relations[]` BEFORE `AtomSchema.safeParse` runs, so a
 * malformed or hallucinated triple is dropped silently rather than sinking
 * the whole atom (AC-6/AC-7 — "log at debug, don't fail the atom"). Mirrors
 * `coerceEntityKinds` above, but DROPS instead of coercing: an out-of-enum
 * predicate has no safe-narrow fallback here (unlike entity `kind` -> 'other'
 * — 'other' is already a real value in the predicate enum, so silently
 * remapping an invalid string to it would misrepresent the model's actual,
 * unusable output as a deliberate 'other' choice).
 *
 * Guards enforced (design doc §2.2/§2.3):
 * 1. `predicate` must be one of the 11 exact lowercase values.
 * 2. `subject`/`object` must be non-empty strings and `subject !== object`.
 * 3. No-hallucination (AC-7): `subject`/`object` (name/whitespace-normalized
 *    via the shared `normalizeEntityName` seam) must each match a name in
 *    this SAME atom's own `entities[]` list — scoped to this atom only, per
 *    the named v1 limitation in the design doc.
 *
 * `dropCounts` (FEAT-481 SLICE-430) is mutated in place — one increment per
 * dropped triple, keyed by reason — so the caller can persist a per-run
 * total via relation-guard-log.ts. This is the ONLY signal that
 * distinguishes "the model never emitted a relation" from "the model
 * emitted relations but every one was dropped here" once persisted:
 * `entity_relations` itself is a zero row count either way. Debug logging
 * stays alongside the counter (not replaced by it) — the log line still
 * carries the subject/object/predicate detail a live debugging session
 * needs; the counter carries only what's cheap and safe to keep long-term.
 */
function filterAtomRelations(raw: unknown, dropCounts: Record<string, number>): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const atom = raw as Record<string, unknown>;
  if (!Array.isArray(atom.relations)) return raw;

  const entityNames = new Set(
    (Array.isArray(atom.entities) ? atom.entities : [])
      .map((e) => (e && typeof e === 'object' && typeof (e as Record<string, unknown>).name === 'string'
        ? normalizeEntityName((e as Record<string, unknown>).name as string)
        : null))
      .filter((n): n is string => n !== null),
  );

  const log = childLogger({ stage: 'extract' });
  const bump = (reason: string) => { dropCounts[reason] = (dropCounts[reason] ?? 0) + 1; };
  const relations = atom.relations.filter((relation) => {
    if (relation === null || typeof relation !== 'object' || Array.isArray(relation)) {
      log.debug({ relation }, 'relations[]: dropped non-object entry');
      bump('not_an_object');
      return false;
    }
    const r = relation as Record<string, unknown>;
    const subject = typeof r.subject === 'string' ? r.subject : null;
    const object = typeof r.object === 'string' ? r.object : null;
    const predicate = typeof r.predicate === 'string' ? r.predicate : null;

    if (!subject || !object || !predicate) {
      log.debug({ relation: r }, 'relations[]: dropped — missing subject/object/predicate');
      bump('missing_fields');
      return false;
    }
    if (!VALID_RELATION_PREDICATES.has(predicate)) {
      log.debug({ predicate }, 'relations[]: dropped — predicate not in closed enum');
      bump('predicate_invalid');
      return false;
    }
    if (subject === object) {
      log.debug({ subject }, 'relations[]: dropped — subject === object');
      bump('subject_equals_object');
      return false;
    }
    if (!entityNames.has(normalizeEntityName(subject)) || !entityNames.has(normalizeEntityName(object))) {
      log.debug(
        { subject, object },
        'relations[]: dropped — no-hallucination guard, subject/object not in this atom\'s own entities[]',
      );
      bump('no_hallucination_guard');
      return false;
    }
    return true;
  });

  return { ...atom, relations };
}

/**
 * Try to parse the LLM response into an Atom[].
 * Strips markdown fences if present.
 *
 * Returns an Atom[] (possibly empty) when the JSON is structurally valid and
 * contains an `atoms` array — even if individual atoms are malformed (they
 * are silently dropped via AtomSchema filtering). An out-of-enum entity kind
 * is coerced to 'other' before that filtering runs, so it no longer sinks
 * the atom (see coerceEntityKinds above).
 *
 * Returns null only when the raw text is not parseable JSON or is missing the
 * top-level `atoms` key — this is the signal for a TransientError (see
 * extractChunk above).
 *
 * `relationDropCounts` (FEAT-481 SLICE-430) accumulates filterAtomRelations'
 * per-reason drop counts across every atom in this chunk's response — always
 * present (possibly `{}`) on a non-null return, absent (never populated) on
 * a null return since nothing was parsed to drop anything from.
 */
function tryParseAtoms(raw: string): { atoms: Atom[]; relationDropCounts: Record<string, number> } | null {
  try {
    let text = raw.trim();

    // Strip markdown code fences
    text = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    // Find the outermost JSON object
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;

    const jsonStr = text.slice(start, end + 1);
    const parsed: unknown = JSON.parse(jsonStr);

    // Use the lenient schema — only requires `atoms` to be an array
    const wrapper = LenientExtractionSchema.safeParse(parsed);
    if (!wrapper.success) return null;

    // Filter atoms individually: drop those that fail strict AtomSchema
    // (short text, unknown type, out-of-range numbers, etc.) — but first
    // repair a recoverable per-entity issue (unknown kind) so it doesn't
    // take the whole atom down with it.
    const relationDropCounts: Record<string, number> = {};
    const atoms = wrapper.data.atoms
      .map(coerceEntityKinds)
      .map((atom) => filterAtomRelations(atom, relationDropCounts))
      .filter((a) => AtomSchema.safeParse(a).success) as Atom[];
    return { atoms, relationDropCounts };
  } catch {
    return null;
  }
}

/**
 * Extract atoms from all compacted chunks, up to `concurrency` at a time
 * (FEAT-487).
 *
 * Stops dispatching further chunks at the first BudgetExceeded (or any other
 * error, e.g. a TransientError parse failure) — results stay in chunk-index
 * order regardless of completion order. See src/distill/concurrency.ts for
 * the full invariant contract `mapWithConcurrency` provides.
 *
 * `concurrency` defaults to 1 — BYTE-IDENTICAL to the pre-FEAT-487
 * sequential `for…of await` loop this replaces. Production callers resolve
 * the real value from config via `resolveChunkConcurrency`
 * (src/distill/pipeline.ts).
 *
 * `jobKey` (chunk-retry-amplification fix) opts into per-chunk
 * checkpointing — same contract as compact()'s `jobKey` param (see
 * 04-compact.ts's doc comment for the full rationale): a chunk whose result
 * is already cached under `jobKey` is skipped rather than re-dispatched, and
 * every fresh success is cached before extract() returns. Omitted (the
 * default), behavior is byte-identical to pre-fix — no cache lookup, no
 * cache write, every call re-dispatches every chunk.
 */
export async function extract(
  chunks: Array<{ index: number; text: string }>,
  provider: LLMProvider,
  budget: BudgetTracker,
  capUsd: number,
  extractProfile: ExtractProfile = 'engineering',
  concurrency = 1,
  jobKey?: string,
): Promise<ExtractResult[]> {
  if (!jobKey) {
    return mapWithConcurrency(chunks, concurrency, (chk) =>
      extractChunk(chk.index, chk.text, provider, budget, capUsd, extractProfile),
    );
  }

  // `extractProfile` MUST be part of the checkpoint key. jobKey is a hash of
  // transcript CONTENT ONLY, and the same content can legitimately be extracted
  // under a different profile (a different prompt → different atoms). Keying on
  // content alone lets a paused job's chunks be reused by a same-content job on
  // the OTHER profile — silently wrong atoms, no error. See chunk-checkpoint.ts.
  const pending: Array<{ index: number; text: string }> = [];
  const cached: ExtractResult[] = [];
  for (const chk of chunks) {
    const hit = chunkCheckpoints.get<ExtractResult>(jobKey, 'extract', chk.index, extractProfile);
    if (hit !== undefined) cached.push(hit);
    else pending.push(chk);
  }

  const fresh = await mapWithConcurrency(pending, concurrency, async (chk) => {
    const result = await extractChunk(chk.index, chk.text, provider, budget, capUsd, extractProfile);
    chunkCheckpoints.set(jobKey, 'extract', chk.index, result, extractProfile);
    return result;
  });

  return [...cached, ...fresh].sort((a, b) => a.chunkIndex - b.chunkIndex);
}
