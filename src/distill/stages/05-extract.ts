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
  EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER,
  type Atom,
  type ExtractProfile,
} from '../prompts/extract.js';
import { BudgetTracker, BudgetExceeded } from '../../budget/tracker.js';
import { TransientError } from '../../pipeline/errors.js';
import { mapWithConcurrency } from '../concurrency.js';
import { chunkCheckpoints } from '../chunk-checkpoint.js';
import { normalizeEntityName } from '../../entity/normalize.js';
import { childLogger } from '../../log/logger.js';
import type { DistillCostCapTracker } from '../cost-cap.js';

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
  /**
   * Issue #207: per-reason drop counts from this chunk's filterAtomEntities
   * pass -- 'too_short', 'bare_issue_ref', 'bare_number', 'missing_name',
   * 'not_an_object'. Same shape/semantics as relationDropCounts above (empty
   * object when nothing was dropped, never a zero-count entry). See
   * src/storage/entity-guard-log.ts for why this is persisted.
   */
  entityDropCounts: Record<string, number>;
  /**
   * FEAT-485: count of whole ATOMS dropped by requireEvidenceForRichTypes
   * (below) because they were type `lesson`/`decision` with no non-empty
   * `evidence` string -- keyed 'lesson' | 'decision'. Empty object when
   * nothing was dropped. See src/storage/evidence-guard-log.ts for why this
   * is persisted (same "distinguish never-emitted from dropped" rationale as
   * relationDropCounts/entityDropCounts, one level up: a whole atom, not a
   * relation triple or an entity).
   */
  evidenceDropCounts: Record<string, number>;
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
  /** Temporal-grounding fix (2026-07-13): the session's observation date as
   * an ISO calendar date (`YYYY-MM-DD`), threaded from the already-computed
   * `PipelineContext.capturedAtMs` (see pipeline.ts's stage-5 call site).
   * When present, `callExtract` prepends an "Observation date: ..." line to
   * the user message so the model can resolve relative time expressions
   * ("yesterday", "last year") to absolute dates directly in atom text —
   * `valid_from` alone earns nothing here, since the LoCoMo/real answerer
   * only ever sees `text` (see prompts/extract.ts's date-grounding rule).
   * `undefined` (the default) is byte-identical to pre-fix behavior — every
   * caller that has no real anchor (legacy v0.0 envelopes, direct
   * `/remember` calls) sees no change. */
  sessionDateIso?: string,
  /** Dual-pass extraction (opt-in): when present, this REPLACES the profile/
   * env-resolved prompt entirely — `extractProfile` is still accepted (so
   * checkpoint variant keying and call signatures stay uniform) but plays no
   * role in prompt selection once this is set. Used by extractSpecifics()
   * below to run the "specifics sweeper" prompt without going through
   * resolveExtractionPrompt's profile/env precedence chain, which is pass-A
   * only by design. `undefined` (the default) is byte-identical to pre-
   * dual-pass behavior for every existing caller. */
  promptOverride?: string,
  /** Opt-in call-count/wall-clock cap (`config.distill.costCap`, see
   *  `src/distill/cost-cap.ts`) — `undefined`/disabled is a pure no-op.
   *  Shares the SAME tracker instance compactChunk() checks, so the budget
   *  is one combined compact()+extract() total per job. Checked BEFORE the
   *  LLM call; when it trips, this chunk contributes zero atoms (same
   *  shape as the empty-text case above) and no `provider.chat()` call is
   *  made. */
  costCap?: DistillCostCapTracker,
): Promise<ExtractResult> {
  if (!text.trim()) {
    return { chunkIndex, atoms: [], usageUsd: 0, retried: false, relationDropCounts: {}, entityDropCounts: {}, evidenceDropCounts: {} };
  }

  if (costCap?.shouldStop()) {
    return { chunkIndex, atoms: [], usageUsd: 0, retried: false, relationDropCounts: {}, entityDropCounts: {}, evidenceDropCounts: {} };
  }

  const activePrompt = promptOverride ?? resolveExtractionPrompt(extractProfile, process.env.ASTRA_EXTRACT_PROMPT);
  const promptChars = activePrompt.length + text.length + (sessionDateIso ? sessionDateIso.length + 20 : 0);
  const estimateUsd = BudgetTracker.estimateUsd(promptChars, 0.000002, 0.000002);

  budget.assertCanSpend(estimateUsd, capUsd);

  const result = await callExtract(text, activePrompt, provider, sessionDateIso);
  costCap?.recordCall();
  budget.record(result.usageUsd);

  const parsed = tryParseAtoms(result.text);
  if (parsed !== null) {
    return {
      chunkIndex,
      atoms: parsed.atoms,
      usageUsd: result.usageUsd,
      retried: false,
      relationDropCounts: parsed.relationDropCounts,
      entityDropCounts: parsed.entityDropCounts,
      evidenceDropCounts: parsed.evidenceDropCounts,
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
  /** See extractChunk's doc comment — prepended as a literal
   * "Observation date: <date>" line so the model has a concrete anchor for
   * the date-grounding rule in the system prompt. Omitted entirely (not an
   * empty line) when there is no real anchor value, so the user message is
   * byte-identical to pre-fix behavior for every caller without one. */
  sessionDateIso?: string,
): Promise<{ text: string; usageUsd: number }> {
  const userContent = sessionDateIso
    ? `Observation date: ${sessionDateIso}\n\nExtract knowledge atoms from this transcript chunk:\n\n${text}`
    : `Extract knowledge atoms from this transcript chunk:\n\n${text}`;
  const messages: ChatMsg[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
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

/**
 * Issue #207: minimum non-whitespace length for an entity name to be kept. A
 * single character ("x") carries no useful identity signal on its own.
 */
const MIN_ENTITY_NAME_LENGTH = 2;

/** A bare GitHub-style issue/PR reference with NO qualifying context at all
 * — e.g. "#110". Meaningless without a repo/subject attached (see the
 * prompt's own workitem-kind wording, updated alongside this guard in
 * prompts/extract.ts) — this is the exact shape issue #207 reported live
 * from production (`{"name":"#110","kind":"repo"}`). */
const BARE_ISSUE_REF_RE = /^#\d+$/;

/** A name that is nothing but digits — e.g. "123". Never a real entity on
 * its own; a version or port number always carries a qualifying word
 * alongside it ("v2", "port 7777") and is unaffected by this check, since
 * THIS regex only matches when the ENTIRE trimmed name is digits. */
const BARE_NUMBER_RE = /^\d+$/;

/**
 * Classify a candidate entity name as junk, or return null if it's fine.
 * Exported so the doctor "Entity name quality" canary (src/doctor/checks.ts)
 * can apply the identical rule to existing `entities` rows and measure the
 * junk rate already sitting in the corpus, not just guard new writes.
 *
 * Deliberately narrow: a name that merely CONTAINS a number ("FEAT-402",
 * "sqlite-vec", "Node 20") or is a short but real word ("Go", "C#") must
 * never trip this — only a name that IS, in its entirety, a bare issue/PR
 * reference, a bare number, or below the length floor.
 */
export function classifyJunkEntityName(name: string, kind?: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'too_short';
  if (BARE_ISSUE_REF_RE.test(trimmed)) return 'bare_issue_ref';
  if (BARE_NUMBER_RE.test(trimmed)) return 'bare_number';

  // Single-character names: KIND-AWARE, not a flat length floor.
  //
  // The original guard was `length < 2 -> too_short`, which silently dropped
  // "C" and "R" — both real, commonly-referenced programming languages. That
  // contradicted this function's own docstring ("a short but real word ...
  // must never trip this") and would have discarded a legitimate fact
  // ("I wrote this in C") permanently, pre-persistence, counting it in the
  // junk-rate metric as though it were noise.
  //
  // The junk we actually observed in prod was `"a"`, `"b"`, `"c"` tagged as
  // kind `repo` — single letters are implausible as a repository, an actor,
  // an org, or a project, but entirely plausible as a `tech`. So gate on the
  // KIND rather than on length alone: a one-character `tech` survives, a
  // one-character anything-else does not.
  //
  // When `kind` is absent (a caller that has only the name — e.g. an older
  // call site), fall back to accepting the letter, since a false ACCEPT here
  // merely leaves one weak entity in the table, while a false REJECT destroys
  // a real fact irrecoverably. Asymmetric costs, asymmetric default.
  if (trimmed.length < MIN_ENTITY_NAME_LENGTH) {
    if (kind !== undefined && kind !== 'tech') return 'too_short';
    if (!/^\p{L}$/u.test(trimmed)) return 'too_short'; // punctuation/symbol, not a letter
  }

  return null;
}

/**
 * Filter an atom's raw `entities[]` BEFORE `AtomSchema.safeParse` runs (issue
 * #207): drop names that are pure issue/PR references, bare numbers, or
 * below the minimum length, instead of letting them become permanent
 * `entities` rows that then poison ζ ranking (src/search/search.ts's
 * entityBonusForQuery) via naked substring matching. This is the code-level
 * backstop for the prompt-level guidance in prompts/extract.ts's workitem-
 * kind wording — the prompt is stochastic and cannot be relied on alone.
 *
 * Deliberately DROPS rather than coerces — mirrors filterAtomRelations, not
 * coerceEntityKinds: there is no safe-narrow value for a bad NAME the way
 * 'other' is for kind (renaming "#110" to some placeholder would still be a
 * meaningless entity, just under a different label).
 *
 * Runs BEFORE filterAtomRelations in the tryParseAtoms chain below, so a
 * relation naming a just-dropped junk entity is caught for free by
 * filterAtomRelations' existing no-hallucination guard (the dropped name is
 * no longer in this atom's surviving entities[]) — no separate check needed
 * here.
 *
 * `dropCounts` (mirrors filterAtomRelations' own param) is mutated in place,
 * one increment per dropped entity, keyed by reason — persisted via
 * src/storage/entity-guard-log.ts so the doctor canary can distinguish "the
 * model/guard have stopped producing new junk" from "the guard is actively
 * catching junk on an ongoing basis," the same distinction relation_guard_
 * drops draws for relations[].
 */
function filterAtomEntities(raw: unknown, dropCounts: Record<string, number>): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const atom = raw as Record<string, unknown>;
  if (!Array.isArray(atom.entities)) return raw;

  const log = childLogger({ stage: 'extract' });
  const bump = (reason: string) => { dropCounts[reason] = (dropCounts[reason] ?? 0) + 1; };
  const entities = atom.entities.filter((entity) => {
    if (entity === null || typeof entity !== 'object' || Array.isArray(entity)) {
      log.debug({ entity }, 'entities[]: dropped non-object entry');
      bump('not_an_object');
      return false;
    }
    const e = entity as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name : null;
    if (!name) {
      log.debug({ entity: e }, 'entities[]: dropped — missing name');
      bump('missing_name');
      return false;
    }
    // Pass `kind` so a one-character `tech` ("C", "R") survives while a
    // one-character repo/actor/org ("a", "b", "c" — the junk actually seen in
    // prod) does not. See classifyJunkEntityName.
    const kind = typeof e.kind === 'string' ? e.kind : undefined;
    const reason = classifyJunkEntityName(name, kind);
    if (reason) {
      log.debug({ name, kind, reason }, 'entities[]: dropped — junk name');
      bump(reason);
      return false;
    }
    return true;
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

/** Atom types FEAT-485 requires a non-empty `evidence` excerpt for — the
 * types whose entire value IS the reasoning (lesson/decision). An uncitable
 * lesson/decision is close to worthless (2026-07-13 live-store audit: 1/10
 * sampled memories carried any evidence at all). fact/command/todo/event/note
 * stay untouched — they're atomic and frequently superseded, so requiring a
 * verbatim quote for them would only shrink coverage without adding value
 * (see FEAT-485's own scope note). */
const EVIDENCE_REQUIRED_TYPES = new Set(['lesson', 'decision']);

/**
 * Drop (not fail) an atom whose type requires evidence but has none — same
 * "log at debug, don't fail the atom/extraction" idiom as filterAtomRelations
 * above, one level up (a whole atom, not one relation triple). Runs AFTER
 * `AtomSchema.safeParse` has already validated shape, so `atom` here is
 * guaranteed a valid `Atom` — this is a POLICY gate, not a schema-shape
 * check (`AtomSchema.evidence` stays optional in the zod shape itself, so the
 * type keeps working for every atom type where evidence is genuinely
 * optional).
 *
 * `dropCounts` (FEAT-485) is mutated in place, keyed by atom type ('lesson' |
 * 'decision') — the doctor "Evidence provenance" canary (src/doctor/
 * checks/evidence-provenance.ts) reads the persisted total to distinguish
 * "the model never emits evidence for this type" (0 drops here, because the
 * pre-FEAT-485 optional field just let the atom through with `evidence:
 * undefined`) from "the model emits atoms of this type without evidence and
 * they get dropped here" (drops > 0) — both would otherwise look identical
 * as a plain evidence-population-rate number computed from `memories` alone.
 * Mirrors `relation-guard-log.ts`'s rationale for `relation_guard_drops` one
 * level up.
 */
function requireEvidenceForRichTypes(atom: Atom, dropCounts: Record<string, number>): boolean {
  if (!EVIDENCE_REQUIRED_TYPES.has(atom.type)) return true;
  if (typeof atom.evidence === 'string' && atom.evidence.trim().length > 0) return true;

  childLogger({ stage: 'extract' }).debug(
    { atom_type: atom.type, text: atom.text.slice(0, 200) },
    'atom dropped — evidence is required for this type but none was provided',
  );
  dropCounts[atom.type] = (dropCounts[atom.type] ?? 0) + 1;
  return false;
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
 *
 * `entityDropCounts` (issue #207) is the same accumulation for
 * filterAtomEntities, applied BEFORE filterAtomRelations so a relation
 * naming an already-dropped junk entity is caught by the relation guard's
 * existing no-hallucination check.
 *
 * `evidenceDropCounts` (FEAT-485) is the same accumulation one level up:
 * whole lesson/decision atoms dropped by requireEvidenceForRichTypes for
 * carrying no evidence — see that function's doc comment. Runs LAST, after
 * AtomSchema.safeParse has already validated shape, since it's a policy gate
 * on an already-valid Atom rather than a pre-parse shape repair.
 */
function tryParseAtoms(raw: string): {
  atoms: Atom[];
  relationDropCounts: Record<string, number>;
  entityDropCounts: Record<string, number>;
  evidenceDropCounts: Record<string, number>;
} | null {
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
    const entityDropCounts: Record<string, number> = {};
    const evidenceDropCounts: Record<string, number> = {};
    const shapeValidAtoms = wrapper.data.atoms
      .map(coerceEntityKinds)
      .map((atom) => filterAtomEntities(atom, entityDropCounts))
      .map((atom) => filterAtomRelations(atom, relationDropCounts))
      .filter((a) => AtomSchema.safeParse(a).success) as Atom[];
    const atoms = shapeValidAtoms.filter((a) => requireEvidenceForRichTypes(a, evidenceDropCounts));
    return { atoms, relationDropCounts, entityDropCounts, evidenceDropCounts };
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
 *
 * `sessionDateIso` (temporal-grounding fix) — see extractChunk's doc
 * comment — is threaded unchanged to every chunk's extractChunk call.
 */
export async function extract(
  chunks: Array<{ index: number; text: string }>,
  provider: LLMProvider,
  budget: BudgetTracker,
  capUsd: number,
  extractProfile: ExtractProfile = 'engineering',
  concurrency = 1,
  jobKey?: string,
  sessionDateIso?: string,
  /** Opt-in call-count/wall-clock cap — see `extractChunk`'s param doc and
   *  `src/distill/cost-cap.ts`. Pass the SAME tracker instance given to
   *  compact() so the two stages share one per-job budget. */
  costCap?: DistillCostCapTracker,
): Promise<ExtractResult[]> {
  if (!jobKey) {
    return mapWithConcurrency(chunks, concurrency, (chk) =>
      extractChunk(chk.index, chk.text, provider, budget, capUsd, extractProfile, sessionDateIso, undefined, costCap),
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
    const result = await extractChunk(chk.index, chk.text, provider, budget, capUsd, extractProfile, sessionDateIso, undefined, costCap);
    chunkCheckpoints.set(jobKey, 'extract', chk.index, result, extractProfile);
    return result;
  });

  return [...cached, ...fresh].sort((a, b) => a.chunkIndex - b.chunkIndex);
}

/**
 * Dual-pass extraction, Pass B ("specifics sweeper") — opt-in via
 * `distill.extractionPasses: 2` (src/config/config.ts). Runs
 * EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER (prompts/extract.ts) over the
 * SAME compacted chunks pass A already processed, on the SAME provider
 * instance — no new provider config, no new budget surface.
 *
 * Mirrors extract()'s chunk-checkpoint contract exactly (same jobKey, same
 * chunk indices) but under its OWN checkpoint variant (`'specifics-sweeper'`)
 * so a collision with pass A's cached results under the same jobKey/index is
 * impossible — see chunk-checkpoint.ts's own doc comment on why `variant`
 * disambiguation is load-bearing, not decoration.
 *
 * Caller contract (pipeline.ts): only invoke this AFTER pass A's `extract()`
 * call has returned successfully for the run — never on a failed/aborted
 * pass A. This is enforced by the CALLER's control flow (pass A's own
 * try/catch already re-throws before this would be reached), not by this
 * function itself.
 */
export async function extractSpecifics(
  chunks: Array<{ index: number; text: string }>,
  provider: LLMProvider,
  budget: BudgetTracker,
  capUsd: number,
  concurrency = 1,
  jobKey?: string,
  sessionDateIso?: string,
): Promise<ExtractResult[]> {
  const variant = 'specifics-sweeper';

  if (!jobKey) {
    return mapWithConcurrency(chunks, concurrency, (chk) =>
      extractChunk(
        chk.index, chk.text, provider, budget, capUsd,
        'engineering', sessionDateIso, EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER,
      ),
    );
  }

  const pending: Array<{ index: number; text: string }> = [];
  const cached: ExtractResult[] = [];
  for (const chk of chunks) {
    const hit = chunkCheckpoints.get<ExtractResult>(jobKey, 'extract', chk.index, variant);
    if (hit !== undefined) cached.push(hit);
    else pending.push(chk);
  }

  const fresh = await mapWithConcurrency(pending, concurrency, async (chk) => {
    const result = await extractChunk(
      chk.index, chk.text, provider, budget, capUsd,
      'engineering', sessionDateIso, EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER,
    );
    chunkCheckpoints.set(jobKey, 'extract', chk.index, result, variant);
    return result;
  });

  return [...cached, ...fresh].sort((a, b) => a.chunkIndex - b.chunkIndex);
}
