import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import type { Memory, MemoryScope, MemoryType } from '../contracts/index.js';
import type { MemoryEventRepo } from './memory-events.js';

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
   */
  capture_source?: 'auto_capture' | 'hook_close' | 'proxy' | 'meeting_captions' | null;
  /**
   * FEAT-491: display-name/label this atom's `evidence` excerpt was traced
   * back to (src/distill/attribute-speaker.ts), when the source transcript
   * had per-turn speaker labels (meeting captions) AND a match was found.
   * `null`/undefined for every atom from a source with no speaker labels —
   * the overwhelming majority of rows, byte-identical to pre-FEAT-491
   * behavior. This is the storage-side half of contracts'
   * `atom.v2.schema.json` `evidence[].speaker_label` (FEAT-496) — see
   * migrations/048-meeting-captions.sql's doc comment for why there is no
   * live JSON-emission path yet.
   */
  speaker_label?: string | null;
  /**
   * FEAT-491 (ADR-017 decision 6): whether the operator disclosure/opt-in
   * required for capturing a non-user speaker was satisfied at capture time,
   * plumbed straight through from `transcripts.consent_disclosed` the same
   * way `capture_source` already flows. `null`/undefined for every atom from
   * a non-meeting-captions source.
   */
  consent_disclosed?: boolean | null;
}

/** Raw DB row shape — derived_from is stored as a JSON string (hydrated to
 *  string[] | null in get()); archived/validity_extracted/needs_vec_index
 *  are stored as SQLite INTEGER 0/1 (hydrated to boolean). */
type MemoryRow = Omit<Memory, 'derived_from' | 'archived' | 'validity_extracted' | 'needs_vec_index' | 'consent_disclosed'> & {
  derived_from: string | null;
  archived: number;
  validity_extracted: number;
  needs_vec_index: number;
  /** Raw SQLite INTEGER 0/1/NULL — tri-state, unlike the always-0-or-1
   *  boolean columns above, so hydration must preserve NULL distinctly from
   *  `false` (see Memory.consent_disclosed's doc comment). */
  consent_disclosed: number | null;
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
         validity_extracted, speaker_label, consent_disclosed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.type, input.text, input.normalized_text,
      input.repo, input.project, input.branch, input.agent, input.session_id,
      input.importance ?? 0.5, input.confidence ?? 0.5, input.hash,
      input.embedding_provider ?? null, input.embedding_model ?? null, input.embedding_dim ?? null,
      now, now, input.source_hash, input.evidence ?? null, input.valid_from ?? now, input.valid_to ?? null,
      input.scope ?? 'private', input.capture_source ?? null, input.validity_extracted ? 1 : 0,
      input.speaker_label ?? null,
      input.consent_disclosed === undefined || input.consent_disclosed === null ? null : (input.consent_disclosed ? 1 : 0),
    );
    return id;
  }

  get(id: string): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? MemoryRepo.hydrate(row) : null;
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
