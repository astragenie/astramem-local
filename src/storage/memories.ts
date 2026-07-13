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
  capture_source?: 'auto_capture' | 'hook_close' | 'proxy' | null;
}

/** Raw DB row shape — derived_from is stored as a JSON string (hydrated to
 *  string[] | null in get()); archived/validity_extracted are stored as
 *  SQLite INTEGER 0/1 (hydrated to boolean). */
type MemoryRow = Omit<Memory, 'derived_from' | 'archived' | 'validity_extracted'> & {
  derived_from: string | null;
  archived: number;
  validity_extracted: number;
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
         validity_extracted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.type, input.text, input.normalized_text,
      input.repo, input.project, input.branch, input.agent, input.session_id,
      input.importance ?? 0.5, input.confidence ?? 0.5, input.hash,
      input.embedding_provider ?? null, input.embedding_model ?? null, input.embedding_dim ?? null,
      now, now, input.source_hash, input.evidence ?? null, input.valid_from ?? now, input.valid_to ?? null,
      input.scope ?? 'private', input.capture_source ?? null, input.validity_extracted ? 1 : 0
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
    };
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
