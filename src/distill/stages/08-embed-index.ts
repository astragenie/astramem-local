/**
 * Stage 8 — Embed + Index (provider call + DB writes)
 *
 * For each normalized memory:
 * 1. Insert into memories table via MemoryRepo.insert (hash dedup built in)
 * 2. Embed the normalizedText via EmbedProvider
 * 3. Upsert vec row via SqliteVecStore.upsert
 * 4. Update embedding_provider/model/dim on the memories row
 */

import type { EmbedProvider, LLMProvider } from '../../contracts/index.js';
import type { NormalizedMemory } from './07-memory-normalize.js';
import { MemoryRepo } from '../../storage/memories.js';
import { MemoryEventRepo } from '../../storage/memory-events.js';
import { EntityRepo } from '../../storage/entities.js';
import { EntityRelationRepo } from '../../storage/entity-relations.js';
import { JobRepo } from '../../pipeline/job-repo.js';
import { normalizeEntityName } from '../../entity/normalize.js';
import { SqliteVecStore } from '../../vector/sqlite-vec.js';
import type { DB } from '../../storage/db.js';
import type { Config } from '../../config/config.js';
import { defaultConfig } from '../../config/config.js';
import { redactIfEnabled } from '../../redact/index.js';
import { childLogger } from '../../log/logger.js';
import { gateDurability, type DurabilityGateMode, type GatedReason } from '../durability-gate.js';
import { triageBatch, AtomTriageRunTracker, CORRECTED_TYPE_CONFIDENCE_GATE, type TriageVerdict } from '../atom-triage.js';
import { recordRelationGuardDrops } from '../../storage/relation-guard-log.js';
import { recordValidityGuardDrops } from '../../storage/validity-guard-log.js';
import { recordEntityLinkDrops } from '../../storage/entity-link-log.js';
import { recordTriageGuardDrops, recordTriageRunLog, type TriageGuardDropRow } from '../../storage/triage-guard-log.js';
import { recordEvidenceGateDrops, recordEvidenceGateRunLog, EVIDENCE_FUZZY_MATCHED_REASON } from '../../storage/evidence-gate-log.js';
import { checkEvidenceGate, type EvidenceGateDropReason } from '../evidence-gate.js';
import { attributeSpeaker } from '../attribute-speaker.js';

export interface IndexResult {
  memoryId: string;
  created: boolean; // false = deduped (already existed)
}

export interface EmbedIndexContext {
  db: DB;
  embed: EmbedProvider;
  sessionId: string | null;
  repo: string | null;
  project: string | null;
  branch: string | null;
  agent: string | null;
  sourceHash: string | null;
  /**
   * Canonical envelope's `captured_at` (epoch ms), when the ingest route
   * received one (v1.0 envelope only — legacy v0.0 has no such field).
   * Becomes each new memory's `valid_from` so bitemporal `as_of` queries key
   * off when the content was true, not when this distill job happened to
   * run. `null`/omitted falls back to MemoryRepo's insert-time wall-clock
   * default — the pre-existing behavior for legacy envelopes and any
   * pre-fix rows (no migration backfills those; see distill.ts/distill-events.ts).
   */
  capturedAtMs?: number | null;
  /**
   * FEAT-455 / ADR-012 decision 4, widened 2026-07-12: provenance tag
   * carried on the transcripts row this distill run's atoms were extracted
   * from — `'auto_capture'` when captured by the hook-tap auto-capture
   * trigger, `'hook_close'` when captured by the ordinary close-capture
   * hook, `null`/omitted for every other producer (byte-identical default).
   * Passed straight through to `MemoryRepo.insertWithCreateEvent`'s
   * `capture_source` so every atom formed from a captured transcript is
   * itself scoped for the doctor "Auto-capture" canary's count query and the
   * disable -> purge query. Widened again FEAT-458 S3 (ADR-013): `'proxy'`
   * when captured by the LLM proxy relay's capture fork — scoped for its own
   * "LLM proxy" doctor canary and its own disable -> purge query, isolated
   * from the auto-capture ones above. Widened again FEAT-489 (Slice A):
   * `'audio_transcribe'` when captured by the on-device audio-file
   * transcription pipeline — its own "Audio add-on" doctor row.
   */
  captureSource?: 'auto_capture' | 'hook_close' | 'proxy' | 'audio_transcribe' | 'meeting_captions' | null;
  /** FEAT-491: the flattened transcript text (flatten-turns.ts output) this
   *  batch's atoms were extracted from — used to recover per-atom speaker
   *  attribution via `attributeSpeaker` below. `undefined` for any caller
   *  that doesn't have it (e.g. distill-events.ts's atom-to-memory path,
   *  which has no source transcript at all) — every atom then gets
   *  `speaker_label: null`, byte-identical to pre-FEAT-491 behavior. */
  sourceText?: string;
  /**
   * FEAT-489/FEAT-491 (ADR-017 decision 6): whether the operator
   * disclosure/opt-in required for capturing a non-user speaker was
   * satisfied at capture time, carried on the transcripts row this distill
   * run's atoms were extracted from. Passed straight through to
   * `MemoryRepo.insertWithCreateEvent`'s `consent_disclosed` so a memory
   * produced from a third-party recording can self-identify as such even if
   * its source transcript is later pruned by retention (FEAT-493)
   * independently. `null`/omitted for every producer without a
   * third-party-speaker capture source.
   */
  consentDisclosed?: boolean | null;
  /**
   * FEAT-441: durability quality gate mode. Undefined/omitted behaves as
   * 'off' — every pre-FEAT-441 caller (and the existing test suite) that
   * never sets this field is byte-identical (AC-2): `gateDurability` short
   * circuits to `null` for 'off' without even running the classifier.
   */
  durabilityGateMode?: DurabilityGateMode;
  /**
   * Config used to redact a gated atom's text before it reaches the log
   * sink (AC-7 — same Stage-0 `redactIfEnabled` choke point `/remember`
   * and ingest use). Only consulted when a gate actually fires (mode !==
   * 'off' and a candidate matches); falls back to `defaultConfig()`
   * (redaction ON by default) if omitted so a caller that turns the gate on
   * without also threading its config still redacts rather than silently
   * skipping redaction.
   */
  redactConfig?: Config;
  /**
   * FEAT-441 AC-4 observability out-param: when provided, `.count` is
   * incremented once per atom gated out during this call. Mutated in place
   * (rather than folded into the return value) so the `IndexResult[]`
   * return contract every existing caller already depends on stays
   * unchanged — callers read `.count` back after the call resolves.
   */
  gatedOutCounter?: { count: number };
  /**
   * FEAT-533: LLM atom-triage tier mode. Undefined/omitted behaves as
   * 'off' — every pre-FEAT-533 caller (and the existing test suite) that
   * never sets this field is byte-identical: the triage batch loop below
   * is skipped entirely whenever this resolves to 'off'.
   */
  atomTriageMode?: 'off' | 'dry-run' | 'enabled' | 'repair-only';
  /**
   * Provider for the triage batch call — only consulted when
   * `atomTriageMode !== 'off'`. Real callers (distill/pipeline.ts) always
   * set this from `ProviderSet.llm.atomTriage`, which `getProviders`
   * itself always populates (identity default to `llm.extraction`) — see
   * that field's doc comment. A caller that sets a non-'off' mode without
   * also supplying this is a no-op (no triage call is ever made) rather
   * than a throw, same tolerant-default posture `durabilityGateMode`'s
   * omission gets.
   */
  llmAtomTriage?: LLMProvider;
  /** Fixed atom-count batch size for the triage sweep — see
   *  `Config['distill']['atomTriage'].batchSize`'s doc comment for why
   *  this batches the whole job's flat post-reduce/post-normalize atom
   *  stream rather than per chunk. Falls back to 20 when omitted. */
  atomTriageBatchSize?: number;
  /** Call-count cap on the triage sweep for this job — falls back to 200
   *  when omitted. See `AtomTriageRunTracker`. */
  atomTriageMaxPerRun?: number;
  /** Wall-clock cap (ms) on the triage sweep for this job — falls back to
   *  300000 (5 min) when omitted. See `AtomTriageRunTracker`. */
  atomTriageMaxWallClockMs?: number;
  /**
   * FEAT-551: evidence-gated sweeper. Undefined/omitted behaves as `false`
   * — every pre-FEAT-551 caller (and the existing test suite) that never
   * sets this field is byte-identical (AC-2): the gate check below is
   * skipped entirely, so a `NormalizedMemory` tagged
   * `extractionSource: 'passB'` is admitted exactly like any other atom.
   * Real callers (distill/pipeline.ts's `runPipeline`) resolve this from
   * `config.distill.extractionPassB.evidenceGate`, defaulting to `true`
   * exactly when passB's resolved provider differs from pass A's (the
   * mixed-provider case FEAT-551's own measurement targeted) — see
   * `runPipeline`'s `evidenceGateEnabled` local for the exact precedence.
   * When `true`, every atom with `extractionSource === 'passB'` must carry
   * an `evidence` quote that mechanically verifies (whitespace-normalized)
   * against `sourceText`, or it is dropped pre-index (never embedded, never
   * indexed) — see `checkEvidenceGate` (../evidence-gate.js). Pass-A atoms
   * (or any atom with no `extractionSource` tag, e.g. a single-pass run)
   * are NEVER gated regardless of this setting.
   */
  evidenceGateEnabled?: boolean;
}

/**
 * Embed and index all normalized memories.
 * Returns one IndexResult per input atom (some may be deduped by hash).
 */
export async function embedAndIndex(
  memories: NormalizedMemory[],
  ctx: EmbedIndexContext,
): Promise<IndexResult[]> {
  if (memories.length === 0) return [];

  const memRepo = new MemoryRepo(ctx.db);
  const eventsRepo = new MemoryEventRepo(ctx.db);
  const entityRepo = new EntityRepo(ctx.db);
  const relationRepo = new EntityRelationRepo(ctx.db);
  const vecStore = new SqliteVecStore(ctx.db, ctx.embed.dim);
  const jobRepo = new JobRepo(ctx.db);

  // Batch embed all texts at once for efficiency
  const texts = memories.map(m => m.normalizedText);
  const vectors = await ctx.embed.embed(texts);

  const results: IndexResult[] = [];
  // FEAT-481 SLICE-430: counts the defensive "unresolvable at write" skip
  // below (should not happen post-stage-5 filterAtomRelations — see that
  // function's doc comment) under its own guard-drop reason, so it's
  // distinguishable from a stage-5 drop if it ever actually fires. Recorded
  // once after the loop, not per relation, to keep this a single cheap write.
  let unresolvableRelationDrops = 0;
  const validityDrops: Record<ValidityDropReason, number> = {
    invalid_at_implausible: 0,
    invalid_at_before_valid_at: 0,
  };
  // issue #200 AC-3: counts a per-entity upsert/link write that throws
  // (see the try/catch around entityRepo.upsert/linkWithValidity below) —
  // the only point after extraction where an entity the model DID emit can
  // still fail to reach `memory_entities`. Distinguishes "the model emitted
  // no entities[] for this atom" (a real zero — this counter stays 0) from
  // "the model emitted entities but a write attempt failed" (a broken zero
  // — this counter is > 0), same shape as unresolvableRelationDrops above.
  let entityLinkWriteDrops = 0;
  // Issue #209: counts a vec-upsert attempt that threw for this batch — see
  // the try/catch around vecStore.upsert below. Logged (not written to a
  // guard-drop table — needs_vec_index on the memories row is already the
  // durable REAL-zero/BROKEN-zero marker; a doctor canary reading it is
  // Lane 1 / E1b, deliberately out of scope here to avoid colliding with
  // PR #231's checks.ts split).
  let vecUpsertDrops = 0;
  // FEAT-551: counts + reasons for the evidence-gated sweeper below.
  // `passBAtomsAttempted` is the RATE denominator (canary-must-measure-rate-
  // not-existence) — only incremented for atoms actually tagged
  // `extractionSource: 'passB'` while the gate is enabled, so it means
  // exactly "passB atoms the gate evaluated," never "atoms in this batch."
  let passBAtomsAttempted = 0;
  const evidenceGateDrops: Record<EvidenceGateDropReason, number> = {
    'no-evidence-field': 0,
    'evidence-not-found': 0,
  };
  // FEAT-552 sub-scope C (AC-C2): passB atoms admitted via the fuzzy
  // token-window tier (not exact substring) — a PASS, never added to
  // evidenceGateDrops/atomsDropped, but counted+logged separately so the
  // gate's integrity stays observable (canary-must-measure-rate-not-
  // existence: a rising fuzzy-match rate is its own signal).
  let passBFuzzyMatched = 0;

  // ─── Phase A: erasure-replay filter + regex durability gate ─────────────
  // Same two "last line of defense, never persisted" checks the original
  // single loop always ran, just split out so the LLM atom-triage tier
  // below (Phase B) only ever sees SURVIVORS of the free regex gate — per
  // FEAT-533's architect-pinned ordering ("regex gate runs first, free; LLM
  // triage sees survivors"). Nothing about the erasure/durability-gate
  // LOGIC changed, only where the loop boundary sits.
  interface Survivor { originalIndex: number; mem: NormalizedMemory; vec: Float32Array }
  const survivors: Survivor[] = [];
  for (let i = 0; i < memories.length; i++) {
    const mem = memories[i];
    const vec = vectors[i];

    if (!mem) continue;
    if (!vec || vec.length !== ctx.embed.dim) {
      throw new Error(
        `embed provider returned dim=${vec?.length ?? 0} for memory ${i}, expected ${ctx.embed.dim}. ` +
        `This is a provider invariant violation — check config.embedding.provider and model.`
      );
    }

    // Erasure replay filter (ADR-006 W5): an erased content hash must never
    // be resurrected by re-distillation — erasure wins over replay.
    if (eventsRepo.isErasedHash(mem.finalHash)) continue;

    // Durability quality gate (FEAT-441): second continue-style filter, same
    // ordering position as the erasure-replay filter above — a second "last
    // line of defense" check every producer's atoms pass through before
    // insertWithCreateEvent. 'off' (the shipped default) never calls the
    // classifier at all (AC-2 byte-identical guarantee).
    //
    // The whole classify→redact→log block is wrapped so a classifier (or
    // redaction/logging) error FAILS OPEN rather than poisoning the whole
    // distill job or silently dropping an atom that was never actually
    // judged low-durability (2026-07-09 review MEDIUM fix — the generic
    // catch in distill.ts would otherwise turn a durability-gate bug into a
    // job-level failure). `gatedForReason` is only ever set after the log
    // line below has been emitted, so `gatedOutCounter` and the
    // persisted-atom-count stay consistent even when a mid-block throw
    // forces a fail-open persist.
    let gatedForReason: GatedReason | null = null;
    try {
      const reason = gateDurability(mem.text, ctx.durabilityGateMode ?? 'off');
      if (reason) {
        // AC-7: rejected-candidate text passes through the same Stage-0
        // redaction choke point as /remember and ingest before it reaches
        // any log sink, and rides the existing pino/ingest.log 10MB
        // rotation policy rather than an unbounded or separately-retained
        // sink — a single structured log line, no side table.
        const { text: redactedText } = redactIfEnabled(mem.text, ctx.redactConfig ?? defaultConfig());
        childLogger({ session_id: ctx.sessionId ?? undefined, stage: 'embed-index' }).warn(
          { gatedReason: reason, atom_type: mem.type, text: redactedText.slice(0, 500) },
          'durability gate: atom rejected — never passed to insertWithCreateEvent',
        );
        gatedForReason = reason;
      }
    } catch (err) {
      childLogger({ session_id: ctx.sessionId ?? undefined, stage: 'embed-index' }).warn(
        { error_message: err instanceof Error ? err.message : String(err) },
        'durability gate: classifier/redaction/log error — failing open, atom will be persisted',
      );
      gatedForReason = null;
    }

    if (gatedForReason) {
      if (ctx.gatedOutCounter) ctx.gatedOutCounter.count += 1;
      continue;
    }

    // Evidence-gated sweeper (FEAT-551): third continue-style "last line of
    // defense" filter, same ordering position as the two above. `false`/
    // omitted (AC-2) skips this block entirely — checkEvidenceGate is never
    // even called, so an atom tagged `extractionSource: 'passB'` is admitted
    // exactly like pre-FEAT-551 behavior. Only ever gates a passB atom
    // (checkEvidenceGate's own bypass for every other atom) — see that
    // function's doc comment for the full mixed-provider-junk-crowding
    // rationale this gate exists to close.
    if (ctx.evidenceGateEnabled) {
      if (mem.extractionSource === 'passB') passBAtomsAttempted++;
      const gateResult = checkEvidenceGate(mem, ctx.sourceText);
      if (!gateResult.admitted) {
        const reason = gateResult.reason as EvidenceGateDropReason;
        evidenceGateDrops[reason] += 1;
        const { text: redactedText } = redactIfEnabled(mem.text, ctx.redactConfig ?? defaultConfig());
        childLogger({ session_id: ctx.sessionId ?? undefined, stage: 'embed-index' }).warn(
          { reason, atom_type: mem.type, text: redactedText.slice(0, 500) },
          'evidence gate: passB atom rejected — never passed to insertWithCreateEvent',
        );
        continue;
      }
      // FEAT-552 sub-scope C (AC-C2): admitted, but via the fuzzy tier
      // rather than an exact substring match — count it distinctly.
      if (gateResult.matchTier === 'fuzzy') passBFuzzyMatched++;
    }

    survivors.push({ originalIndex: i, mem, vec });
  }

  // ─── Phase B: LLM atom-triage tier (FEAT-533) ────────────────────────────
  // Batched over ALL regex-gate survivors for the WHOLE job (fixed
  // atom-count batches, not per chunk — see Config['distill']['atomTriage']
  // for why). 'off' (the shipped default) short-circuits before any LLM
  // call — byte-identical to pre-FEAT-533 behavior. A caller with a
  // non-'off' mode but no `llmAtomTriage` provider is also a no-op (never a
  // throw) — see EmbedIndexContext.llmAtomTriage's doc comment.
  const atomTriageMode = ctx.atomTriageMode ?? 'off';
  const triageVerdicts = new Map<number, TriageVerdict>();
  const triageDropRows: TriageGuardDropRow[] = [];
  let atomsTriagedCount = 0;
  let atomsDroppedByTriage = 0;
  if (atomTriageMode !== 'off' && ctx.llmAtomTriage && survivors.length > 0) {
    const batchSize = ctx.atomTriageBatchSize ?? 20;
    const triageLog = (message: string) =>
      childLogger({ session_id: ctx.sessionId ?? undefined, stage: 'embed-index' }).warn({}, message);
    const tracker = new AtomTriageRunTracker(
      {
        maxPerRun: ctx.atomTriageMaxPerRun ?? 200,
        maxWallClockMs: ctx.atomTriageMaxWallClockMs ?? 300_000,
      },
      triageLog,
    );
    for (let start = 0; start < survivors.length; start += batchSize) {
      // Cap reached — every remaining survivor falls through un-triaged
      // (no verdict entry -> implicit 'keep' below): fail OPEN, never
      // drop-by-timeout (FEAT-482 lesson, restated for this cap).
      if (tracker.shouldStop()) break;
      const batch = survivors.slice(start, start + batchSize);
      tracker.recordCall();
      const verdicts = await triageBatch(
        ctx.llmAtomTriage,
        // FEAT-547: thread each survivor's evidence quote (when it has one)
        // so the batched call can also judge `evidence_supported` — an atom
        // with no evidence omits the field, same as TriageableAtom.evidence's
        // doc comment describes.
        batch.map((s) => ({ index: s.originalIndex, text: s.mem.text, evidence: s.mem.evidence })),
        { log: triageLog },
      );
      for (const [index, verdict] of verdicts) triageVerdicts.set(index, verdict);
      // Count every ATTEMPTED atom (not just successfully-classified ones)
      // toward the rate denominator — a provider that fails open on every
      // call still consumed real job volume, and the doctor "Atom triage"
      // canary needs that reflected in the rate, not silently excluded
      // (canary-must-measure-rate-not-existence: a systemically broken
      // judge and a genuinely quiet job must not look identical).
      atomsTriagedCount += batch.length;
    }
  }

  // ─── Phase C: insert survivors, honoring the triage verdict ─────────────
  for (const survivor of survivors) {
    const { originalIndex: i, mem, vec } = survivor;
    const verdict = triageVerdicts.get(i);
    const isNonKeepVerdict = atomTriageMode !== 'off' && verdict !== undefined && verdict.verdict !== 'keep';

    if (isNonKeepVerdict && atomTriageMode === 'enabled') {
      // 'enabled': actually drop — never reaches insertWithCreateEvent, so
      // there is no memory_id to record (memoryId: null — see
      // triage-guard-log.ts's doc comment). corrected_type/evidence_supported
      // are recorded too (raw, not "applied" — a dropped atom is never
      // persisted, so there is nothing to apply either to) purely so the
      // manually reviewed agreement sample can see what the model proposed.
      atomsDroppedByTriage++;
      triageDropRows.push({
        reason: verdict!.verdict,
        memoryId: null,
        model: ctx.llmAtomTriage?.model ?? 'unknown',
        confidence: verdict!.confidence,
        mode: 'enabled',
        sessionId: ctx.sessionId,
        correctedType: verdict!.corrected_type ?? null,
        evidenceSupported: verdict!.evidence_supported ?? null,
      });
      childLogger({ session_id: ctx.sessionId ?? undefined, stage: 'embed-index' }).warn(
        { triageVerdict: verdict!.verdict, confidence: verdict!.confidence, atom_type: mem.type },
        'atom triage: atom rejected — never passed to insertWithCreateEvent',
      );
      continue;
    }

    // FEAT-547 (atom-triage v2): corrected_type / evidence_supported are
    // only ever APPLIED in 'enabled' mode — 'dry-run' logs but rewrites
    // nothing (AC-5), same "safe-rollout mode" posture the junk/keep verdict
    // itself already has. Gate placement mirrors AC-2 exactly:
    //  - corrected_type overrides the stored type ONLY when its OWN verdict
    //    confidence clears CORRECTED_TYPE_CONFIDENCE_GATE; under-gate or
    //    absent keeps the atom's original type untouched.
    //  - evidence_supported is only ever stored for an atom that actually
    //    HAS an evidence quote (defense in depth — the triage prompt is
    //    already instructed to omit it otherwise, this guards against a
    //    provider ignoring that instruction) and is never itself gated by
    //    confidence (AC-2 states no confidence floor for this flag, only
    //    for corrected_type) — a queryable flag, never a rewrite.
    // 'repair-only' (2026-07-18): applies the v2 signals exactly like
    // 'enabled' while the drop branch above stays 'enabled'-gated — the
    // measured verdict split (55fx: every clerk's discard verdict costs
    // recall, phi −40 / 4b −36 / ministral −17, while ministral's typing
    // raises typeAcc 43→52) gets a mode that keeps the half that earns.
    const appliesV2Signals = atomTriageMode === 'enabled' || atomTriageMode === 'repair-only';
    const correctedTypeApplied =
      appliesV2Signals &&
      verdict?.corrected_type !== undefined &&
      verdict.confidence >= CORRECTED_TYPE_CONFIDENCE_GATE;
    const evidenceSupportedApplied =
      appliesV2Signals &&
      verdict?.evidence_supported !== undefined &&
      !!mem.evidence;

    // Validity bounds (issue #205): parse, then GUARD. An implausible
    // `invalid_at` is refused and the atom kept unbounded rather than being
    // persisted with a `valid_to` that would make it permanently unretrievable.
    // See guardValidTo — the asymmetry (imprecise atom vs. vanished atom) is
    // what makes "keep the atom, drop the bound" the only safe default.
    const validFromMs = parseIsoToMs(mem.valid_at) ?? ctx.capturedAtMs ?? null;
    const { validTo, dropped: validityDropped } = guardValidTo(
      parseIsoToMs(mem.invalid_at),
      validFromMs,
      ctx.capturedAtMs ?? Date.now(),
    );
    if (validityDropped !== null) {
      validityDrops[validityDropped] += 1;
      childLogger({ session_id: ctx.sessionId ?? undefined, stage: 'embed-index' }).warn(
        { reason: validityDropped, invalid_at: mem.invalid_at, valid_at: mem.valid_at },
        'validity guard refused an implausible invalid_at — atom kept, bound dropped',
      );
    }

    // Insert + append a 'create' memory_event (ADR-002) in one transaction.
    // Dedup-aware: `created` is false when this hash already existed.
    const { id: memoryId, created } = memRepo.insertWithCreateEvent({
      // FEAT-547 AC-2: overwrite the stored type with the triage verdict's
      // corrected_type only when correctedTypeApplied gated it in — every
      // other case (mode 'off'/'dry-run', no verdict, absent field, or
      // under-gate confidence) keeps the atom's own extracted type,
      // byte-identical to pre-FEAT-547 behavior.
      type: correctedTypeApplied ? verdict!.corrected_type! : mem.type,
      text: mem.text,
      normalized_text: mem.normalizedText,
      hash: mem.finalHash,
      importance: mem.importance,
      confidence: mem.confidence,
      session_id: ctx.sessionId,
      repo: ctx.repo,
      project: ctx.project,
      branch: ctx.branch,
      agent: ctx.agent,
      source_hash: ctx.sourceHash,
      embedding_provider: ctx.embed.name,
      embedding_model: ctx.embed.model,
      embedding_dim: ctx.embed.dim,
      evidence: mem.evidence ?? null,
      scope: 'private',
      // Issue #205 (AC-1/AC-2): the atom's own valid_at, when the source text
      // bounded this atom's START, refines the fallback capture-time anchor —
      // parseIsoToMs returns `null` (not undefined) for an absent/unparseable
      // hint, so `?? ctx.capturedAtMs ?? undefined` preserves the exact
      // pre-fix default (capture time, then insert-time wall-clock) whenever
      // the model didn't (or couldn't) state a start bound — the overwhelming
      // majority of atoms today, since this is a new optional field.
      valid_from: parseIsoToMs(mem.valid_at) ?? ctx.capturedAtMs ?? undefined,
      // invalid_at is ONLY ever set by the model when the source text stated
      // an end bound (see the prompt's "omit by default" rule) — `null` here
      // means "unbounded," never "expire it," matching parseIsoToMs's
      // contract and InsertInput.valid_to's doc comment.
      //
      // GUARDED: an implausible bound is refused and the atom kept unbounded,
      // because a bad `valid_to` makes the memory permanently unretrievable
      // (see guardValidTo's doc comment). Refusals are counted, not swallowed.
      valid_to: validTo,
      // FEAT-547 AC-2: queryable evidence-support flag, applied ONLY when
      // evidenceSupportedApplied gated it in (mode 'enabled', a verdict
      // actually judged this atom's evidence). `null` (every other case —
      // including 'dry-run', which never applies) means "not evaluated,"
      // never "unsupported" — see Memory.evidence_supported's doc comment.
      evidence_supported: evidenceSupportedApplied ? verdict!.evidence_supported! : null,
      // Every atom reaching this stage passed through AtomSchema, which now
      // carries valid_at/invalid_at for every extraction profile (issue
      // #205 AC-3) — so this write path always "looked," regardless of
      // whether the model found an actual bound. `true` here is what lets
      // the doctor "Atom validity extraction" canary distinguish this
      // pipeline's atoms from legacy rows and non-extraction write paths
      // (/remember, MCP remember, the eval harness), which never pass this
      // field and correctly default to `false`.
      validity_extracted: true,
      capture_source: ctx.captureSource ?? null,
      // FEAT-491: best-effort, deterministic line-level match (see
      // attribute-speaker.ts's doc comment for why this isn't full span
      // tracking) — null whenever ctx.sourceText is absent, no turn in it
      // carries a speaker marker, or this atom's evidence doesn't literally
      // appear in a labeled turn's utterance.
      speaker_label: ctx.sourceText ? attributeSpeaker(ctx.sourceText, mem.evidence) : null,
      consent_disclosed: ctx.consentDisclosed ?? null,
      // atom@2: stage 5 always runs entity extraction as part of this same
      // atom's LLM call, so every atom from this pipeline has "declared"
      // entities even when it found none — default to [] (not undefined)
      // so the sync payload signals "tried, found nothing" rather than
      // "extraction never ran" (see InsertInput.entities doc).
      entities: mem.entities ?? [],
    }, eventsRepo);

    // FEAT-402 AC-1 / FEAT-453 §4: link entities emitted in the same
    // extraction call, carrying each entity's stated fact-level validity
    // hint (if any) through to memory_entities. Idempotent — linkWithValidity
    // silently no-ops a duplicate open-window insert for the same pair (see
    // its doc comment), so this is safe to run on a deduped hit too, exactly
    // like the linkEntitiesForMemory() call it replaces here. valid_at/
    // invalid_at are parsed from the extractor's ISO-8601 strings to epoch
    // ms; a missing or unparseable hint resolves to `null` — "no stated
    // fact-level start/end," never "now" — so it falls back to the parent
    // memory's own valid_from at query time (design doc §3.1), not baked in
    // here.
    // Name -> entities.id map for THIS atom, built alongside the upsert loop
    // above — reused immediately below to resolve FEAT-481 relation triples.
    // Keyed by normalizeEntityName so a relation's subject/object (validated
    // against the same atom's entities[] names at stage 5, see
    // filterAtomRelations in 05-extract.ts) always resolves here without a
    // second DB round trip per name.
    const entityIdByName = new Map<string, string>();
    for (const entity of mem.entities ?? []) {
      // issue #200 AC-3: one entity's upsert/link failing (e.g. a locked or
      // busy DB handle) must never sink this atom's insert, its other
      // entities, or its relations — same "never let one item sink the
      // whole memory" posture as the relation write loop below. Skipped
      // entities are counted (entityLinkWriteDrops) rather than silently
      // lost, so a future write-time regression here is distinguishable
      // from the model simply emitting no entities[] at all.
      try {
        const entityId = entityRepo.upsert(entity.name, entity.kind);
        entityIdByName.set(normalizeEntityName(entity.name), entityId);
        entityRepo.linkWithValidity(memoryId, entityId, {
          validAt: parseIsoToMs(entity.valid_at),
          invalidAt: parseIsoToMs(entity.invalid_at),
        });
      } catch (err) {
        entityLinkWriteDrops++;
        childLogger({ session_id: ctx.sessionId ?? undefined, stage: 'embed-index' }).warn(
          { error_message: err instanceof Error ? err.message : String(err), entity_kind: entity.kind },
          'entity link: upsert/link failed for one entity — skipped, atom otherwise persisted',
        );
      }
    }

    // FEAT-481 (SLICE-2/SLICE-435): persist entity-to-entity relation triples
    // this atom asserted. Stage 5's filterAtomRelations already dropped any
    // triple whose predicate wasn't in the closed enum or whose subject/
    // object wasn't in this atom's own entities[] (no-hallucination guard),
    // so this is name->id resolution + write only — a triple somehow still
    // unresolvable here (defensive; should not happen post-stage-5) is
    // skipped rather than thrown, same "never let one relation sink the
    // whole memory insert" posture as the rest of this loop.
    const relationValidFrom = ctx.capturedAtMs ?? Date.now();
    for (const relation of mem.relations ?? []) {
      const subjectId = entityIdByName.get(normalizeEntityName(relation.subject));
      const objectId = entityIdByName.get(normalizeEntityName(relation.object));
      if (!subjectId || !objectId) { unresolvableRelationDrops++; continue; }

      relationRepo.insert({
        subjectEntityId: subjectId,
        predicate: relation.predicate,
        objectEntityId: objectId,
        evidenceMemoryId: memoryId,
        // design doc §2.1/§1: falls back to the atom's own evidence, then a
        // truncated text, so entity_relations.source_excerpt (NOT NULL) is
        // always satisfiable without a nullable escape hatch.
        sourceExcerpt: relation.evidence ?? mem.evidence ?? mem.text.slice(0, 500),
        confidence: relation.confidence ?? mem.confidence,
        validFrom: parseIsoToMs(relation.valid_at) ?? relationValidFrom,
        validTo: parseIsoToMs(relation.invalid_at),
      });
    }

    // Always upsert vec (may update if the memory already existed but had no vec).
    // Issue #209: this used to be unguarded — one atom's vec-write failure
    // (e.g. a dim mismatch mid provider-swap, SQLITE_BUSY, disk pressure)
    // threw straight out of the loop, aborting every atom after it in this
    // same batch even though their inserts had already committed. Now a
    // failure here is caught, durably recorded on the memory row
    // (needs_vec_index = 1 — ADR-015 REAL-zero/BROKEN-zero marker, not just
    // an in-memory flag), and a `reembed` job is enqueued so the worker
    // retries it independently of this job's own outcome — never let one
    // atom's vec failure sink the rest of the batch, same posture as the
    // entity/relation write loops above.
    try {
      await vecStore.upsert(memoryId, vec);
      // Update embedding metadata on the memories row (in case it pre-existed
      // without it) — only once the vec write actually succeeded; on failure
      // this would claim an embedding_provider/model/dim that isn't backed by
      // a real memories_vec row.
      ctx.db
        .prepare(`
          UPDATE memories
          SET embedding_provider = ?, embedding_model = ?, embedding_dim = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(ctx.embed.name, ctx.embed.model, ctx.embed.dim, Date.now(), memoryId);
    } catch (err) {
      vecUpsertDrops++;
      memRepo.markNeedsVecIndex(memoryId);
      try {
        jobRepo.enqueue('reembed', { kind: 'reembed', memory_id: memoryId });
      } catch (enqueueErr) {
        // Best-effort — the `cleanup` job's 24h sweep (src/pipeline/handlers/
        // cleanup.ts) also drains every still-flagged needs_vec_index row, so
        // a failed enqueue here does not strand the memory permanently.
        childLogger({ session_id: ctx.sessionId ?? undefined, stage: 'embed-index' }).warn(
          { error_message: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr), memory_id: memoryId },
          'vec index: retry-job enqueue failed after vec upsert failure — needs_vec_index still set, cleanup sweep will catch it',
        );
      }
      childLogger({ session_id: ctx.sessionId ?? undefined, stage: 'embed-index' }).warn(
        { error_message: err instanceof Error ? err.message : String(err), memory_id: memoryId },
        'vec index: upsert failed — memory persisted but NOT vector-indexed; needs_vec_index set, reembed job enqueued',
      );
    }

    // FEAT-533/FEAT-547: post-insert triage observability. `memoryId` is
    // known here (unlike the early 'enabled'+non-'keep' drop branch above),
    // so it rides along in every row this block writes:
    //  - 'dry-run': a non-'keep' verdict OR either v2 signal (corrected_type/
    //    evidence_supported) is logged so the manually reviewed agreement
    //    sample this FEAT's own eval gate depends on has something to
    //    compare against — dry-run APPLIES neither signal (AC-5); this row
    //    is diagnostic only, never a record of a real mutation.
    //  - 'enabled': only a 'keep' verdict that ALSO carried a v2 signal ever
    //    reaches this point (a non-'keep' 'enabled' verdict was already
    //    dropped-and-logged by the early branch above and never falls
    //    through to here) — logged as the audit trail of what was actually
    //    APPLIED to the persisted row (correctedTypeApplied/
    //    evidenceSupportedApplied above decided that already; this is
    //    observability, not a second gate).
    const hasV2Signal = verdict?.corrected_type !== undefined || verdict?.evidence_supported !== undefined;
    if (atomTriageMode !== 'off' && verdict !== undefined && (isNonKeepVerdict || hasV2Signal)) {
      // Reachable for 'dry-run' AND 'repair-only' (both keep the atom): the
      // counter records IGNORED discard verdicts — would-drops, not drops.
      if (isNonKeepVerdict) atomsDroppedByTriage++;
      triageDropRows.push({
        reason: verdict.verdict,
        memoryId,
        model: ctx.llmAtomTriage?.model ?? 'unknown',
        confidence: verdict.confidence,
        mode: atomTriageMode,
        sessionId: ctx.sessionId,
        correctedType: verdict.corrected_type ?? null,
        evidenceSupported: verdict.evidence_supported ?? null,
      });
    }

    results.push({ memoryId, created });
  }

  // Diagnostic counter write, deliberately isolated in its own try/catch: it
  // runs after every real stage-8 write for this call has already succeeded
  // (results is fully populated above), so a failure here (SQLITE_BUSY under
  // contention, disk full) must never surface as if stage 8 itself failed —
  // that would discard already-persisted memories/relations on retry purely
  // because a diagnostic counter couldn't be written (review finding, this
  // slice).
  if (unresolvableRelationDrops > 0) {
    try {
      recordRelationGuardDrops(
        ctx.db,
        [{ reason: 'unresolvable_at_write', count: unresolvableRelationDrops }],
        ctx.sessionId,
      );
    } catch (err) {
      childLogger({ session_id: ctx.sessionId ?? undefined, stage: 'embed-index' }).warn(
        { error_message: err instanceof Error ? err.message : String(err) },
        'relation guard-drop counter write failed (non-fatal, diagnostic only — embed-index already succeeded)',
      );
    }
  }

  // Same isolation, same reasoning as the relation counter above: every real
  // write already succeeded, so a diagnostic-counter failure must never look
  // like a stage-8 failure and discard persisted memories on retry.
  const validityDropRows = (Object.entries(validityDrops) as Array<[ValidityDropReason, number]>)
    .map(([reason, count]) => ({ reason, count }));
  if (validityDropRows.some(r => r.count > 0)) {
    try {
      recordValidityGuardDrops(ctx.db, validityDropRows, ctx.sessionId);
    } catch (err) {
      childLogger({ session_id: ctx.sessionId ?? undefined, stage: 'embed-index' }).warn(
        { error_message: err instanceof Error ? err.message : String(err) },
        'validity guard-drop counter write failed (non-fatal, diagnostic only — embed-index already succeeded)',
      );
    }
  }

  // issue #200 AC-3: same fail-open, isolated-try/catch posture as the
  // relation guard-drop write above — this is a diagnostic counter write
  // running after every real stage-8 write for this call has already
  // succeeded, so a failure here must never surface as if stage 8 itself
  // failed.
  if (entityLinkWriteDrops > 0) {
    try {
      recordEntityLinkDrops(
        ctx.db,
        [{ reason: 'link_write_error', count: entityLinkWriteDrops }],
        ctx.sessionId,
      );
    } catch (err) {
      childLogger({ session_id: ctx.sessionId ?? undefined, stage: 'embed-index' }).warn(
        { error_message: err instanceof Error ? err.message : String(err) },
        'entity link-drop counter write failed (non-fatal, diagnostic only — embed-index already succeeded)',
      );
    }
  }

  // Issue #209: this batch's vec-upsert failures are already durably
  // recorded per-row (needs_vec_index) and retried (reembed job enqueued)
  // above — this is purely a summary log line, same "never let a diagnostic
  // fail the batch" posture as the counters above, just with nothing to
  // write since there's no separate guard-drop table for this one.
  if (vecUpsertDrops > 0) {
    childLogger({ session_id: ctx.sessionId ?? undefined, stage: 'embed-index' }).warn(
      { vecUpsertDrops },
      'vec index: one or more atoms in this batch failed vec upsert — flagged needs_vec_index, reembed jobs enqueued',
    );
  }

  // FEAT-533: same isolation, same reasoning as the diagnostic writes above
  // — every real stage-8 write for this call already succeeded, so a
  // failure here must never surface as if stage 8 itself failed. Only
  // written when triage actually ran this call (atomTriageMode !== 'off'):
  // a job with zero triaged atoms IS a real zero (mode 'off', or 'off' by
  // omission) and must not pollute the doctor "Atom triage" canary's rate
  // denominator with a phantom 0/0 row for every ordinary call.
  if (atomTriageMode !== 'off') {
    try {
      recordTriageGuardDrops(ctx.db, triageDropRows);
      recordTriageRunLog(ctx.db, {
        sessionId: ctx.sessionId,
        atomsTriaged: atomsTriagedCount,
        atomsDropped: atomsDroppedByTriage,
      });
    } catch (err) {
      childLogger({ session_id: ctx.sessionId ?? undefined, stage: 'embed-index' }).warn(
        { error_message: err instanceof Error ? err.message : String(err) },
        'atom-triage counter write failed (non-fatal, diagnostic only — embed-index already succeeded)',
      );
    }
  }

  // FEAT-551: same isolation, same reasoning, same "only written when the
  // gate actually ran this call" posture as the atom-triage write directly
  // above — a call with the gate off (the shipped default) IS a real zero
  // and must not pollute the evidence_gate_run_log rate denominator with a
  // phantom 0/0 row for every ordinary call. This is the persistence step
  // that was MISSING before this fix (review finding): passBAtomsAttempted/
  // evidenceGateDrops were computed above but never written, so
  // evidence_gate_drops/evidence_gate_run_log stayed permanently empty
  // regardless of real gate activity — exactly the built-wired-never-
  // invoked class this repo's own doctor canaries exist to catch.
  if (ctx.evidenceGateEnabled) {
    try {
      recordEvidenceGateDrops(
        ctx.db,
        [
          ...(Object.entries(evidenceGateDrops) as Array<[EvidenceGateDropReason, number]>)
            .map(([reason, count]) => ({ reason, count })),
          // FEAT-552 sub-scope C (AC-C2): PASS-tier row, not a drop — see
          // evidence-gate-log.ts's module doc comment for why this rides
          // the same table/column. recordEvidenceGateDrops already no-ops
          // rows with count === 0.
          { reason: EVIDENCE_FUZZY_MATCHED_REASON, count: passBFuzzyMatched },
        ],
        ctx.sessionId,
      );
      recordEvidenceGateRunLog(ctx.db, {
        sessionId: ctx.sessionId,
        atomsAttempted: passBAtomsAttempted,
        atomsDropped: evidenceGateDrops['no-evidence-field'] + evidenceGateDrops['evidence-not-found'],
      });
    } catch (err) {
      childLogger({ session_id: ctx.sessionId ?? undefined, stage: 'embed-index' }).warn(
        { error_message: err instanceof Error ? err.message : String(err) },
        'evidence-gate counter write failed (non-fatal, diagnostic only — embed-index already succeeded)',
      );
    }
  }

  return results;
}

/**
 * Parse an extractor-emitted ISO-8601 valid_at/invalid_at hint (FEAT-453 §4)
 * to epoch ms. Returns `null` — not `undefined`, not `Date.now()` — for a
 * missing or unparseable value: `linkWithValidity`'s `null` means "no stated
 * fact-level bound," which is the correct fallback whether the extractor
 * omitted the hint entirely or emitted a malformed date string.
 */
function parseIsoToMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * How far from the atom's own capture time an extracted validity bound may sit
 * before the guard refuses it. Generous on purpose — the job is to catch
 * year-9999 and year-0002, not to second-guess a plausible business date.
 * A 25-year contract, a decade-old employment history, a birth year: all fine.
 */
const VALIDITY_BOUND_MAX_SKEW_MS = 50 * 365.25 * 24 * 60 * 60 * 1000; // ~50 years

export type ValidityDropReason =
  | 'invalid_at_implausible'
  | 'invalid_at_before_valid_at';

/**
 * Decide whether an extracted `invalid_at` may be persisted as `valid_to`.
 *
 * Why this guard exists — the stakes are asymmetric and that asymmetry decides
 * every judgment call here:
 *
 *   * accepting a slightly-wrong bound leaves one atom with a slightly wrong
 *     validity window. Recoverable, low blast radius.
 *   * accepting a GARBAGE bound (a past date, or year 9999 wrapping to a past
 *     epoch, or an interval that ends before it starts) sets `valid_to` to a
 *     value that makes the atom fail `validityFilterClause`'s default
 *     `(valid_to IS NULL OR valid_to > now)` predicate — i.e. the memory is
 *     PERMANENTLY INVISIBLE to every normal recall. The row is on disk, the
 *     write returned success, nothing errored, no canary went red. It is
 *     silent, irreversible data loss caused by one bad token from a 7B model.
 *
 * So: when a bound is implausible, we KEEP THE ATOM and DROP THE BOUND. Never
 * the atom. An unbounded atom is merely imprecise; a wrongly-bounded atom is
 * gone.
 *
 * Returns the ms value to persist (or `null` for "unbounded"), plus the reason
 * it was refused, so the caller can COUNT the refusal. A guard that discards
 * silently is just a quieter version of the bug it is fixing (ADR-015: measure
 * the RATE of the failure, not the existence of a success).
 */
export function guardValidTo(
  invalidAtMs: number | null,
  validFromMs: number | null,
  anchorMs: number,
): { validTo: number | null; dropped: ValidityDropReason | null } {
  if (invalidAtMs === null) return { validTo: null, dropped: null };

  // An interval that ends before it starts is empty — the atom would be
  // invisible even to an `as_of` query. Always garbage, never intentional.
  if (validFromMs !== null && invalidAtMs <= validFromMs) {
    return { validTo: null, dropped: 'invalid_at_before_valid_at' };
  }

  if (Math.abs(invalidAtMs - anchorMs) > VALIDITY_BOUND_MAX_SKEW_MS) {
    return { validTo: null, dropped: 'invalid_at_implausible' };
  }

  return { validTo: invalidAtMs, dropped: null };
}
