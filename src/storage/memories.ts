import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import type { Memory, MemoryScope, MemoryType } from '../contracts/index.js';
import type { MemoryEventRepo } from './memory-events.js';
import { chunkedIn } from './sql-utils.js';

export interface InsertInput {
  type: MemoryType;
  text: string;
  normalized_text: string;
  repo: string | null;
  project: string | null;
  branch: string | null;
  agent: string | null;
  session_id: string | null;
  hash: string;
  source_hash: string | null;
  importance?: number;
  confidence?: number;
  embedding_provider?: string | null;
  embedding_model?: string | null;
  embedding_dim?: number | null;
  evidence?: string | null;
  /** ADR-009 scope. Defaults to 'private'. */
  scope?: MemoryScope;
  /**
   * Bitemporal validity start (epoch ms). Defaults to insertion wall-clock
   * time (`now`) when omitted — the pre-existing behavior. Callers that know
   * the canonical envelope's `captured_at` (distill pipeline, ingest-sourced
   * atoms) should pass it here so `as_of` queries key off when the content
   * was actually true, not when it happened to be (re-)ingested. Direct
   * `/remember` inserts have no `captured_at` and correctly fall back to
   * wall-clock by omitting this field.
   */
  valid_from?: number;
  /**
   * Issue #205 (AC-2): bitemporal validity end (epoch ms), populated ONLY
   * when the extraction stage's own atom-level `invalid_at` hint (AtomSchema,
   * src/distill/prompts/extract.ts) states the source text bounds this
   * atom's claim. `undefined`/`null` (every pre-fix caller, and any atom
   * whose fact is genuinely unbounded) inserts `NULL` — byte-identical to
   * pre-fix behavior; `validityFilterClause()` is untouched by this field.
   * A hallucinated end date is worse than none, so callers must only pass
   * this when the source text actually stated a bound — never a guess.
   */
  valid_to?: number | null;
  /**
   * Issue #205 (AC-2/AC-3) provenance flag — see Memory.validity_extracted's
   * doc comment for the full REAL-zero/BROKEN-zero rationale. `undefined`
   * (every pre-fix caller: `/remember`, MCP `remember`, the eval harness)
   * stores `0` — "extraction never considered this atom's validity," the
   * correct default for a write path that never ran the extractor. Only the
   * distill pipeline's stage-8 write (src/distill/stages/08-embed-index.ts)
   * passes `true`, since that is the one path where AtomSchema's
   * `valid_at`/`invalid_at` fields were actually available to the model.
   */
  validity_extracted?: boolean;
  /**
   * atom@2 typed entities (contracts/schemas/atom.v2.schema.json
   * `entities[]`) declared by the caller for THIS atom, embedded verbatim in
   * the create-event sync payload (see insertWithCreateEvent below) — never
   * persisted on the `memories` row itself (entity persistence stays in
   * EntityRepo/memory_entities, unaffected by this field). `undefined` means
   * "this write path never ran entity extraction" (e.g. direct /remember);
   * an empty array means "extraction ran and found nothing" — the distinction
   * matters for a future cloud enrichment pass deciding whether to extract.
   */
  entities?: Array<{ name: string; kind: string; subtype?: 'human' | 'ai' }>;
  /**
   * FEAT-455 / ADR-012 decision 4, widened 2026-07-12 (doctor canary
   * provenance fix): provenance tag distinguishing capture-hook write paths
   * from every other write path (`/remember`, Codex capture, distill's other
   * producers), which all omit this field and get `NULL` -- byte-identical
   * to pre-FEAT-455 behavior. `'auto_capture'` is set only by the hook-tap
   * auto-capture trigger; `'hook_close'` is set by the ordinary
   * astramem-plugin close-capture hook (every `session_end`/`subagent_stop`
   * capture that does NOT pass `--auto-capture` — the only caller today).
   * See migrations/024-capture-source.sql and
   * docs/specs/FEAT-455-spike-results.md checklist #4. Drives the doctor
   * "Auto-capture" canary's count query (both values count as real capture
   * traffic) and the disable -> purge scoping query (`'auto_capture'` ONLY —
   * `'hook_close'` atoms are never purged by that flow).
   *
   * Widened again FEAT-458 S3 (ADR-013): `'proxy'` is set only by the LLM
   * proxy relay's capture fork (`src/proxy/**`). It is a fully independent
   * provenance value — never counted by the "Auto-capture" canary above
   * (that query stays `IN ('auto_capture', 'hook_close')` deliberately, see
   * src/doctor/checks.ts's `checkAutoCapture`) and never touched by the
   * `capture auto-capture disable` -> purge flow (scoped to `'auto_capture'`
   * ONLY, see src/cli/capture.ts's `runAutoCaptureDisable`). It has its own
   * doctor row (`checkProxyCapture`) and its own disable -> purge flow
   * (`capture proxy disable`, `runProxyCaptureDisable`) scoped to
   * `'proxy'` ONLY — the two provenance values are isolated from each other
   * in both directions by construction, not by a shared runtime check.
   *
   * Widened again FEAT-489 (Slice A): `'audio_transcribe'` from the
   * on-device audio-file transcription pipeline
   * (src/pipeline/handlers/transcribe.ts) — its own doctor row
   * (`checkAudioAddon`) and its own disable/purge story (ADR-017 decision 3),
   * isolated from the other provenance values the same way.
   */
  capture_source?: 'auto_capture' | 'hook_close' | 'proxy' | 'audio_transcribe' | 'meeting_captions' | null;
  /**
   * FEAT-491: display-name/label this atom's `evidence` excerpt was traced
   * back to (src/distill/attribute-speaker.ts), when the source transcript
   * had per-turn speaker labels (meeting captions) AND a match was found.
   * `null`/undefined for every atom from a source with no speaker labels —
   * the overwhelming majority of rows, byte-identical to pre-FEAT-491
   * behavior. This is the storage-side half of contracts'
   * `atom.v2.schema.json` `evidence[].speaker_label` (FEAT-496) — see
   * migrations/049-meeting-captions.sql's doc comment for why there is no
   * live JSON-emission path yet.
   */
  speaker_label?: string | null;
  /**
   * FEAT-489/FEAT-491 (ADR-017 decision 6): whether the operator
   * disclosure/opt-in required for capturing a non-user speaker (everyone
   * in a recorded audio file or meeting-caption session, not just the
   * operator) was satisfied at capture time, plumbed straight through from
   * `transcripts.consent_disclosed` the same way `capture_source` already
   * flows. `null`/undefined for every atom from a source without a
   * third-party-speaker capture source.
   */
  consent_disclosed?: boolean | null;
  /**
   * FEAT-547 (atom-triage v2): tri-state semantic evidence-support flag —
   * see Memory.evidence_supported's doc comment. `undefined`/`null` (every
   * pre-FEAT-547 caller, and any atom the triage batch had no evidence to
   * judge, or triaged in 'dry-run' mode) stores `NULL` — "not evaluated,"
   * never "unsupported." Only the distill pipeline's stage-8 write
   * (src/distill/stages/08-embed-index.ts), in `atomTriageMode: 'enabled'`,
   * ever passes an explicit `true`/`false` here.
   */
  evidence_supported?: boolean | null;
  /**
   * Retrieval-overhaul Phase 5 (storage half, migration 057) — structured
   * source-provenance for `evidence`, computed by
   * src/distill/locate-evidence.ts and passed straight through by stage 8
   * (src/distill/stages/08-embed-index.ts). All four fields travel together
   * — the caller either supplies a full `EvidenceLocation` or omits the
   * whole group; there is no partial-population case. `undefined` (every
   * pre-Phase-5 caller: `/remember`, MCP `remember`, the eval harness, and
   * any distill-pipeline atom whose evidence didn't locate) inserts NULL
   * for all four, byte-identical to pre-Phase-5 behavior. See
   * Memory.evidence_turn_index's doc comment for the full field rationale.
   */
  evidence_turn_index?: number | null;
  evidence_char_start?: number | null;
  evidence_char_end?: number | null;
  evidence_span?: string | null;
}

/** Raw DB row shape — derived_from is stored as a JSON string (hydrated to
 *  string[] | null in get()); archived/validity_extracted/needs_vec_index
 *  are stored as SQLite INTEGER 0/1 (hydrated to boolean). */
type MemoryRow = Omit<Memory, 'derived_from' | 'archived' | 'validity_extracted' | 'needs_vec_index' | 'consent_disclosed' | 'evidence_supported'> & {
  derived_from: string | null;
  archived: number;
  validity_extracted: number;
  needs_vec_index: number;
  /** Raw SQLite INTEGER 0/1/NULL — tri-state, unlike the always-0-or-1
   *  boolean columns above, so hydration must preserve NULL distinctly from
   *  `false` (see Memory.consent_disclosed's doc comment). */
  consent_disclosed: number | null;
  /** Raw SQLite INTEGER 0/1/NULL — same tri-state convention as
   *  consent_disclosed above (see Memory.evidence_supported's doc comment). */
  evidence_supported: number | null;
};

export interface FtsHit {
  id: string;
  text: string;
  type: MemoryType;
  bm25: number;
}

export class MemoryRepo {
  constructor(private db: DB) {}

  insert(input: InsertInput): string {
    const existing = this.db.prepare('SELECT id FROM memories WHERE hash = ?').get(input.hash) as {id: string} | undefined;
    if (existing) return existing.id;
    return this.insertRow(input);
  }

  /**
   * Insert + append a 'create' memory_event (ADR-002) in the SAME
   * transaction. Dedup-aware like insert(): if a memory with this hash
   * already exists, no row is inserted and no event is appended — matches
   * insert()'s existing dedup semantics, so a re-ingest never fabricates a
   * duplicate create event for an atom that already has one.
   */
  insertWithCreateEvent(input: InsertInput, events: MemoryEventRepo): { id: string; created: boolean } {
    const tx = this.db.transaction((): { id: string; created: boolean } => {
      const existing = this.db.prepare('SELECT id FROM memories WHERE hash = ?').get(input.hash) as {id: string} | undefined;
      if (existing) return { id: existing.id, created: false };
      const id = this.insertRow(input);
      // Ship the content + materialization metadata in the create-event
      // payload so cloud-replicated atoms are non-empty and searchable
      // (astramem-local#80 / memory#618). The cloud materializer reads
      // text/type/scope/importance/confidence/repo from this payload; a
      // null payload previously landed atoms with empty content. Private
      // atoms never ship (the shipper scope-filters), so this only leaves
      // the machine for team/org scope. valid_from is omitted — the cloud
      // falls back to the event's created_at.
      //
      // atom@2: `entities` (typed {name, kind, subtype?} objects — see
      // InsertInput.entities doc) is embedded only when the caller declared
      // it, so cloud can distinguish "declared, possibly empty" from "never
      // extracted" (the field is entirely absent from payload_json in the
      // latter case, matching the atom@2 dual-read/enrichment-cursor
      // architecture). shipper.ts ships this payload verbatim.
      //
      // FEAT-496 provenance (astramemory-local#... / memory C2-2): this is
      // the live JSON-emission path migration 049's doc comment said didn't
      // exist yet. `evidence` (atom@2 structured-receipt array form) is
      // included ONLY when the caller supplied `speaker_label` — the one
      // FEAT-496 evidence-level field this storage layer actually has data
      // for (`segment_start_ms` has no producer anywhere in the local
      // pipeline today — attribute-speaker.ts does line-level substring
      // matching, not span/timing tracking — so it is never emitted; wiring
      // it here would fabricate a value with no source of truth). The
      // array item's `transcript_id` (required by atom.v2.schema.json) uses
      // `source_hash` — the sha256(transcript content) identifier already
      // threaded through the distill pipeline (see EmbedIndexContext /
      // chunk-checkpoint.ts) — falling back to the atom's own content hash
      // only for the theoretical case a caller sets speaker_label without a
      // source_hash, so the field is never empty (schema minLength: 1).
      // `provenance.consent_disclosed` is tri-state by KEY PRESENCE, not by
      // shipping a JSON `null`: the cloud reader (ReadCaptionProvenanceJson,
      // SyncIngestService.cs) treats absence and `null` identically as "not
      // recorded", so the key is added only for an explicit true/false
      // determination — undefined/null (every pre-FEAT-489/491 caller)
      // stays byte-identical to today (no `evidence`/`provenance` keys at
      // all).
      events.append({
        event_type: 'create',
        atom_id: id,
        content_hash: input.hash,
        payload: {
          text: input.text,
          type: input.type,
          scope: input.scope ?? 'private',
          importance: input.importance ?? 0.5,
          confidence: input.confidence ?? 0.5,
          repo: input.repo ?? input.project ?? '',
          ...(input.entities !== undefined ? { entities: input.entities } : {}),
          ...(input.speaker_label != null
            ? { evidence: [{ transcript_id: input.source_hash ?? input.hash, speaker_label: input.speaker_label }] }
            : {}),
          ...(input.consent_disclosed === true || input.consent_disclosed === false
            ? { provenance: { consent_disclosed: input.consent_disclosed } }
            : {}),
        },
      });
      return { id, created: true };
    });
    return tx();
  }

  /** Raw insert — no dedup check (caller has already decided to insert). */
  private insertRow(input: InsertInput): string {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO memories
        (id, type, text, normalized_text, repo, project, branch, agent, session_id,
         importance, confidence, hash, embedding_provider, embedding_model, embedding_dim,
         created_at, updated_at, source_hash, evidence, valid_from, valid_to, scope, capture_source,
         validity_extracted, speaker_label, consent_disclosed, evidence_supported,
         evidence_turn_index, evidence_char_start, evidence_char_end, evidence_span)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.type, input.text, input.normalized_text,
      input.repo, input.project, input.branch, input.agent, input.session_id,
      input.importance ?? 0.5, input.confidence ?? 0.5, input.hash,
      input.embedding_provider ?? null, input.embedding_model ?? null, input.embedding_dim ?? null,
      now, now, input.source_hash, input.evidence ?? null, input.valid_from ?? now, input.valid_to ?? null,
      input.scope ?? 'private', input.capture_source ?? null, input.validity_extracted ? 1 : 0,
      input.speaker_label ?? null,
      input.consent_disclosed === undefined || input.consent_disclosed === null ? null : (input.consent_disclosed ? 1 : 0),
      input.evidence_supported === undefined || input.evidence_supported === null ? null : (input.evidence_supported ? 1 : 0),
      input.evidence_turn_index ?? null, input.evidence_char_start ?? null,
      input.evidence_char_end ?? null, input.evidence_span ?? null,
    );
    return id;
  }

  get(id: string): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? MemoryRepo.hydrate(row) : null;
  }

  /**
   * Batched sibling of `get()` — one (or, past chunkedIn's batch size, a
   * few) `IN (...)` query instead of one `SELECT` per id, for callers
   * resolving a whole id set at once (e.g. MCP `get_entity_timeline`, which
   * used to `.map(mid => memRepo.get(mid))` over every linked memory id —
   * an N+1 on a hot read path). Order is NOT guaranteed to match `ids` —
   * callers that need a specific order (e.g. newest-first) must sort the
   * result themselves. Rows that don't exist are silently omitted, same as
   * `get()` returning `null` for a missing id.
   */
  getMany(ids: string[]): Memory[] {
    if (ids.length === 0) return [];
    const rows = chunkedIn(ids, (batch, ph) =>
      this.db.prepare(`SELECT * FROM memories WHERE id IN (${ph})`).all(...batch) as MemoryRow[],
    );
    return rows.map(MemoryRepo.hydrate);
  }

  /** Parse the JSON-stored derived_from column into a string[] | null. */
  private static hydrate(row: MemoryRow): Memory {
    return {
      ...row,
      derived_from: row.derived_from ? (JSON.parse(row.derived_from) as string[]) : null,
      archived: row.archived === 1,
      validity_extracted: row.validity_extracted === 1,
      needs_vec_index: row.needs_vec_index === 1,
      consent_disclosed: row.consent_disclosed === null ? null : row.consent_disclosed === 1,
      evidence_supported: row.evidence_supported === null ? null : row.evidence_supported === 1,
    };
  }

  /**
   * Issue #209: durably mark a memory as vector-search-blind after its vec
   * upsert failed. Called from the write-time catch sites (08-embed-index,
   * POST /remember, MCP remember) instead of letting the failure live only
   * in an ephemeral response field. Idempotent (repeat failures are a no-op
   * past the first).
   */
  markNeedsVecIndex(id: string): void {
    this.db.prepare('UPDATE memories SET needs_vec_index = 1 WHERE id = ?').run(id);
  }

  /**
   * Issue #209: clear the retry marker once a vec upsert for this memory
   * succeeds (inline or via the `reembed` retry drain). Idempotent — a row
   * that was never flagged is unaffected.
   */
  clearNeedsVecIndex(id: string): void {
    this.db.prepare('UPDATE memories SET needs_vec_index = 0 WHERE id = ?').run(id);
  }

  /**
   * Issue #209: memory ids currently flagged `needs_vec_index = 1`, oldest
   * first. Used by the `cleanup` job's 24h sweep to enqueue a `reembed` job
   * for any row whose write-time retry-enqueue didn't happen or didn't
   * stick — the durable safety net behind the immediate enqueue.
   */
  listNeedingVecIndex(limit: number): string[] {
    const rows = this.db.prepare(
      'SELECT id FROM memories WHERE needs_vec_index = 1 ORDER BY updated_at ASC LIMIT ?',
    ).all(limit) as { id: string }[];
    return rows.map(r => r.id);
  }

  /**
   * FEAT-507: the subset of `listNeedingVecIndex` that is ALSO oversize
   * (text longer than `maxChars` — the embed model's context budget, see
   * `src/pipeline/oversize.ts`). Used by the dedicated oversize-repair scan
   * (`src/pipeline/oversize-scanner.ts`) to find memories the reembed
   * handler's truncate-before-embed fix can actually repair, on a shorter
   * cadence than the generic 24h vec-index sweep — production was observed
   * accumulating oversize poisons at ~16/hr, too fast to wait a full day.
   * A memory that never got flagged (already vector-indexed) is left alone
   * even if its text happens to be long, since re-indexing it would just be
   * wasted embed budget for no observable gain.
   */
  listOversizeNeedingVecIndex(maxChars: number, limit: number): string[] {
    const rows = this.db.prepare(
      'SELECT id FROM memories WHERE needs_vec_index = 1 AND LENGTH(text) > ? ORDER BY updated_at ASC LIMIT ?',
    ).all(maxChars, limit) as { id: string }[];
    return rows.map(r => r.id);
  }

  searchFts(query: string, limit: number): FtsHit[] {
    const rows = this.db.prepare(`
      SELECT m.id, m.text, m.type, bm25(memories_fts) AS bm25
      FROM memories_fts
      JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ?
      ORDER BY bm25 LIMIT ?
    `).all(query, limit) as FtsHit[];
    return rows;
  }
}
