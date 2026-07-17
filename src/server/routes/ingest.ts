import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import { childLogger } from '../../log/logger.js';
import { stableStringify } from '../lib/stable-stringify.js';
import { type Config, defaultConfig } from '../../config/config.js';
import { redactIfEnabled, type RedactionEvent } from '../../redact/index.js';
import { recordRedactionEvents } from '../../storage/redaction-log.js';
import { deriveRepoFromCwd, deriveRepoFromCwdAsync } from '../../tag-hygiene/derive-repo.js';
import { AtomSchema } from '../../distill/prompts/extract.js';

// ---------------------------------------------------------------------------
// FEAT-4a §4.2.3.4 / CHANGELOG v0.2.0 — response-field metadata (read-only,
// no extraction logic here). `ALL_ATOM_TYPES` mirrors the 7-type registry
// distillHandler's LLM extraction stage can emit (src/distill/prompts/
// extract.ts AtomSchema) — used as the "queued" candidate set for the
// transcript-kind path, where real extraction hasn't run yet (async job).
// ---------------------------------------------------------------------------
const ALL_ATOM_TYPES = AtomSchema.shape.type.options;

// ---------------------------------------------------------------------------
// Legacy envelope (v0.0) — original shape; discriminated by presence of `content`
// ---------------------------------------------------------------------------

const LegacyIngestSchema = z.object({
  session_id: z.string().min(1),
  source: z.string().min(1),
  content: z.string().min(1),
  repo: z.string().nullable().optional(),
  project: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Canonical envelope (v1.0) — FEAT-4a SaaS wire format
// Field names and types mirror TranscriptIngestPayloadSchema in wire.ts exactly,
// with the addition of `wire_version` (^v\d+\.\d+$) which is required here even
// though the plugin schema doesn't yet carry it (pending SaaS DTO catch-up).
//
// Discriminated from legacy by presence of `turns` (array, min 1).
// ---------------------------------------------------------------------------

export const TranscriptTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  ts: z.string().optional(), // ISO-8601 if present
  /** FEAT-491: optional display-name/label for who actually said this turn,
   *  as surfaced by a diarized or caption-labeled source (meeting captions
   *  naming each participant). Additive alongside `role`, not a replacement
   *  for it — `role` stays the closed user|assistant discriminator
   *  flatten-turns.ts's line-prefix convention already depends on; a
   *  multi-participant caption transcript cannot be losslessly collapsed
   *  into that binary, so `speaker` carries the real per-turn identity.
   *  Mirrors contracts/schemas/capture-envelope.v1.schema.json's
   *  `turns[].speaker` (contracts 2.4.0). */
  speaker: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// ADR-008 capture@1 `events` kind — pre-typed atom candidates (runner-plugin
// grades/lessons/review verdicts) that skip pipeline stages 1-5 and enter at
// reduce (stage 6). Type enum mirrors the 7-type registry in
// src/distill/prompts/extract.ts (AtomSchema).
// ---------------------------------------------------------------------------

export const CanonicalEventItemSchema = z.object({
  type: z.enum(['decision', 'fact', 'lesson', 'command', 'todo', 'note', 'event']),
  text: z.string().min(1),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.string().optional(),
  occurred_at: z.number().optional(),
});

export const CanonicalIngestSchema = z.object({
  event: z.enum(['pre_compact', 'session_end', 'subagent_stop']),
  session_id: z.string(),
  project_id: z.string(),
  agent_type: z.string().optional(),
  cwd: z.string().optional(),
  captured_at: z.string().datetime({ offset: true }), // ISO-8601 with UTC Z — guards NaN on getTime()
  /** ADR-008 payload kind. Defaults to 'transcript' — existing clients unaffected. */
  kind: z.enum(['transcript', 'events']).optional().default('transcript'),
  turns: z.array(TranscriptTurnSchema).min(1).optional(),
  /** Required (min 1, max 500) when kind === 'events' — see superRefine below. */
  events: z.array(CanonicalEventItemSchema).min(1).max(500).optional(),
  /** Provenance (ADR-008 `tool` field). No default — record what's sent or null. */
  tool: z.string().optional(),
  /** FEAT-455 / ADR-012 decision 4, widened 2026-07-12 (doctor canary
   *  provenance fix): `'auto_capture'` from the hook-tap auto-capture
   *  trigger, `'hook_close'` from the ordinary astramem-plugin close-capture
   *  hook (`buildClaudeEnvelope`'s optional `captureSource` param) — every
   *  other client omits this field and the transcripts/memories rows it
   *  flows into stay NULL (byte-identical). Widened again FEAT-458 S3
   *  (ADR-013): `'proxy'` from the LLM proxy relay's capture fork
   *  (src/proxy/**), which spools envelopes through the SAME durable ingest
   *  spool (src/ingest/spool.ts) drained by src/ingest/spool-drain.ts using
   *  this exact schema instance — an unwidened enum here would silently
   *  quarantine every proxy-captured envelope at drain time. Kept a closed
   *  enum rather than an open string deliberately — an unrecognized value is
   *  a real client bug worth surfacing as 400 on the direct
   *  `/ingest/transcript` path, not something to silently coerce to null.
   *  Widened again FEAT-491 (ADR-017): `'meeting_captions'` from the
   *  astramem-plugin browser extension's Meet/Teams live-caption scraper.
   *  This is the one capture source that also requires `consent_disclosed`
   *  (below) and a runtime config gate (`captureSource.meetingCaptions.
   *  enabled`, checked in `ingestCanonicalTranscript` since zod schemas
   *  can't see runtime config) — see the superRefine block and
   *  `ingestCanonicalTranscript`'s consent-gate check. */
  capture_source: z.enum(['auto_capture', 'hook_close', 'proxy', 'meeting_captions']).optional(),
  /** FEAT-491: capture-session metadata for a meeting-captions envelope —
   *  which platform (open string, e.g. 'google_meet'/'teams') and which
   *  platform-native meeting/call id, when the extension can read one.
   *  Deliberately NOT threaded onto atom.v2.schema.json's `provenance`
   *  (contracts/README.md's FEAT-496 section) — these describe the capture
   *  SESSION, not a single atom/evidence span; atoms correlate back via the
   *  existing `session_id` bridge. Optional on every non-meeting-captions
   *  envelope, byte-identical to today. */
  platform: z.string().optional(),
  meeting_id: z.string().optional(),
  /** ADR-017 decision 6: server-side consent marker. Optional in general
   *  (every capture source with no third-party speaker omits it), but the
   *  superRefine block below hard-rejects a `capture_source:
   *  'meeting_captions'` envelope where this is missing or `false` — the
   *  contract-level backstop for the plugin's client-side opt-in gate.
   *  Mirrors capture-envelope.v1.schema.json's new `allOf` conditional. */
  consent_disclosed: z.boolean().optional(),
  /** FEAT-479 (D3 §3.2) AC-3: optional per-ingest override of
   *  `distill.extractProfile` (src/config/config.ts) for this transcript
   *  only. Additive zod field, no wire break — every client that omits it
   *  leaves `transcripts.extract_profile` NULL and `runPipeline` falls back
   *  to the config default, then 'engineering' (see PipelineContext.
   *  extractProfile, src/distill/pipeline.ts). Kept a closed enum rather
   *  than an open string, same rationale as `capture_source` above — an
   *  unrecognized value is a real client bug worth a 400, not a silent
   *  coercion to null. */
  extract_profile: z.enum(['engineering', 'conversational']).optional(),
  /** FEAT-458 S6 — token/cost telemetry from the LLM proxy capture fork
   *  (`extractUsageMetadata`, src/capture/proxy.ts). Optional: every
   *  non-proxy client omits it and `transcripts.proxy_usage_json` stays
   *  NULL (migration 026, byte-identical to today). `.optional()` alone is
   *  what makes this field survive zod's default STRIP mode instead of
   *  being silently deleted before `ingestCanonicalTranscript` ever sees it
   *  — see that file's own S5 module-doc warning about this exact hazard.
   *  Every numeric field stays `number | null` end-to-end — `null` must
   *  never become `0` (a fabricated zero would silently corrupt cost
   *  aggregation built on this data later, FEAT-476). Cache fields are
   *  Anthropic-only and kept structurally separate from `input_tokens` —
   *  never summed — because they bill at very different rates. */
  proxy_usage: z.object({
    provider: z.enum(['anthropic', 'openai']),
    model: z.string().nullable(),
    input_tokens: z.number().int().nonnegative().nullable(),
    output_tokens: z.number().int().nonnegative().nullable(),
    total_tokens: z.number().int().nonnegative().nullable(),
    cache_creation_input_tokens: z.number().int().nonnegative().nullable(),
    cache_read_input_tokens: z.number().int().nonnegative().nullable(),
    stop_reason: z.string().nullable(),
    truncated: z.boolean(),
  }).optional(),
  /** Aggregate scrub flag — required; still consumed for telemetry. Superseded by client_scrub_hits_by_label for per-label breakdown but not deprecated. */
  client_scrub_applied: z.boolean(),
  /** Aggregate scrub hit count — required; still consumed for telemetry. Superseded by client_scrub_hits_by_label sum for per-label breakdown but not deprecated. */
  client_scrub_hits: z.number().int().nonnegative(),
  client_version: z.string(),
  client_scrub_version: z.string(),
  client_scrub_hits_by_label: z.record(z.string(), z.number().int().nonnegative()).optional(),
  // Regex mirrors SaaS IngestTranscriptRequest.cs:65 per FEAT-4a Phase 3 alignment.
  /** Wire protocol version — must match ^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$ (e.g. "v1.0"). */
  wire_version: z.string().regex(/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/, 'wire_version must match ^v(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)$ (e.g. "v1.0")'),
}).superRefine((data, ctx) => {
  if (data.kind === 'events') {
    if (!data.events || data.events.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'events kind requires a non-empty `events` array', path: ['events'] });
    }
  } else if (!data.turns || data.turns.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'transcript kind requires a non-empty `turns` array', path: ['turns'] });
  }
  // ADR-017 decision 6 / FEAT-491: mirrors capture-envelope.v1.schema.json's
  // allOf conditional — a meeting-captions envelope with no true
  // consent_disclosed is a hard reject at the schema layer, not a silent
  // accept. This is the shape-level half of the gate; the runtime
  // `captureSource.meetingCaptions.enabled` config check (which zod can't
  // see) happens in ingestCanonicalTranscript below.
  if (data.capture_source === 'meeting_captions' && data.consent_disclosed !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "capture_source 'meeting_captions' requires consent_disclosed: true (ADR-017)",
      path: ['consent_disclosed'],
    });
  }
});

// ---------------------------------------------------------------------------
// Combined schema — canonical tried first (has `wire_version`), legacy as fallback
// ---------------------------------------------------------------------------

const IngestSchema = z.union([CanonicalIngestSchema, LegacyIngestSchema]);

type ParsedIngest = z.infer<typeof IngestSchema>;

/**
 * Parse an ingest body and, on failure, report an error a human can ACT on.
 *
 * `z.union([Canonical, Legacy]).safeParse(bad)` collapses both branches'
 * failures into a single useless outer issue. `.flatten()` on that yields
 * literally:
 *
 *     { formErrors: ["Invalid input"], fieldErrors: {} }
 *
 * No field. No path. No reason. That is what was being logged and returned to
 * clients — a rejected ingest was undiagnosable from either end. (Observed on
 * the operator's box: 2 of 4 ingest rejections carried exactly this and could
 * not be explained; the one that WAS diagnosable came from a different path.)
 *
 * `z.discriminatedUnion` is not usable here: `CanonicalIngestSchema` carries a
 * `.superRefine()` (so it is a ZodEffects, which discriminatedUnion rejects),
 * and the discriminator is the PRESENCE of `wire_version`, not a literal value.
 *
 * So: route on the same signal `isCanonical` already uses — `wire_version` is
 * required on canonical and absent from the legacy envelope — and then report
 * the errors of the branch the caller was actually aiming at. A canonical
 * envelope with a bad `captured_at` now says so, instead of "Invalid input".
 *
 * The success path is unchanged: same schemas, same parsed shape. Only the
 * FAILURE path gets better, so a valid payload behaves byte-identically.
 */
function parseIngestBody(
  body: unknown,
): { success: true; data: ParsedIngest } | { success: false; error: z.ZodError } {
  const looksCanonical =
    body !== null && typeof body === 'object' && !Array.isArray(body) && 'wire_version' in body;

  const schema = looksCanonical ? CanonicalIngestSchema : LegacyIngestSchema;
  const result = schema.safeParse(body);
  if (result.success) return { success: true, data: result.data as ParsedIngest };

  // The body was aimed at `schema` and missed. Report THAT schema's issues —
  // they name the offending field. Do not fall back to the union's blind error.
  return { success: false, error: result.error };
}

function isCanonical(data: ParsedIngest): data is z.infer<typeof CanonicalIngestSchema> {
  // `turns` is now optional on the canonical schema (events kind omits it),
  // so discriminate on `wire_version` instead — required on canonical,
  // absent from the legacy envelope.
  return 'wire_version' in data;
}

// ---------------------------------------------------------------------------
// FEAT-449 — shared canonical-transcript ingest path. Extracted so the
// durable ingest-spool drain worker (src/ingest/spool-drain.ts) can run
// spooled Claude-capture envelopes through the EXACT SAME redact -> session
// upsert -> transcript insert -> distill-job-enqueue -> idempotency logic the
// HTTP route below uses, in-process, without re-POSTing to itself over the
// network. The route's transcript-kind branch is now a thin wrapper: call
// this, map the result (or a thrown sentinel error) to an HTTP response.
// Handles the transcript-kind canonical envelope only — events-kind stays
// inline in the route (captures never produce it).
// ---------------------------------------------------------------------------

export class IdempotentReplayError extends Error {
  constructor(public readonly replayId: string) {
    super('idempotent_replay');
    this.name = 'IdempotentReplayError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super('idempotency_conflict');
    this.name = 'IdempotencyConflictError';
  }
}

/**
 * ADR-017 decision 3 / FEAT-491: a meeting-captions envelope is rejected
 * unless the OPERATOR RUNNING THIS DAEMON has also explicitly opted in
 * (`captureSource.meetingCaptions.enabled: true`, default `false`) —
 * defense-in-depth on top of the plugin's own client-side opt-in gate and
 * the schema-level `consent_disclosed` requirement (zod superRefine above,
 * which zod cannot cross-reference runtime config for). Thrown, not a zod
 * issue, because config is only available here, not inside the pure schema.
 */
export class MeetingCaptionsDisabledError extends Error {
  constructor() {
    super('meeting_captions_capture_disabled');
    this.name = 'MeetingCaptionsDisabledError';
  }
}

export interface CanonicalTranscriptIngestResult {
  transcriptId: string;
  jobId: string;
  /** Server-side redaction hit count (SEC-3/5) — surfaced in the HTTP
   *  response's scrub_hits.server field. */
  serverRedactionHits: number;
}

/**
 * Insert one canonical transcript-kind envelope: stage-0 redact -> session
 * upsert -> transcripts insert -> distill job enqueue, honoring the same
 * Idempotency-Key semantics `POST /ingest/transcript` applies (D-B1/B2/B3).
 *
 * Throws `IdempotentReplayError` when `idempotencyKey` already resolved to a
 * still-live transcript/memory with a matching body hash (valid replay), and
 * `IdempotencyConflictError` when the same key was reused with a DIFFERENT
 * body. Callers decide how to surface those — the HTTP route maps them to
 * 200/409; the spool drain worker (src/ingest/spool-drain.ts) treats a
 * replay as a successful drain (delete the spool file, move on) and a
 * conflict as a quarantine reason (a spooled envelope's key is a content
 * hash, so a genuine conflict means the row was independently created with a
 * different body under the same key — not self-healing via retry).
 *
 * Statements are prepared per call rather than hoisted like the route's
 * factory-scoped ones (D-B6) — this path runs once per HTTP request (already
 * dominated by redaction + a DB transaction) or once per spool-drain tick
 * (seconds-scale cadence), never in a tight loop, so the prepare cost is
 * immaterial; the SQL text below is a direct mirror of the route's own
 * statements (single source of truth for the shape).
 */
export function ingestCanonicalTranscript(
  db: DB,
  config: Config,
  data: z.infer<typeof CanonicalIngestSchema>,
  idempotencyKey: string | null,
  // FEAT-484 review fix (PR #405, HIGH): the HTTP route resolves this via
  // `deriveRepoFromCwdAsync` BEFORE calling in, hoisted above this
  // function's `db.transaction()` — a sync git spawn inside a
  // better-sqlite3 transaction callback would block the daemon's single
  // event loop for up to GIT_TIMEOUT_MS (see CLAUDE.md "Daemon event-loop
  // saturation triad"). `undefined` (the param omitted) means the caller
  // hasn't been updated to pre-resolve — falls back to the sync heuristic
  // below, preserving existing behavior for those callers (spool-drain,
  // tests) unchanged. `null` is a valid pre-resolved "git couldn't answer"
  // result and is NOT re-resolved.
  resolvedRepo?: string | null,
): CanonicalTranscriptIngestResult {
  if (data.kind === 'events' || !data.turns || data.turns.length === 0) {
    throw new Error('ingestCanonicalTranscript: requires a non-empty `turns` array (transcript kind only)');
  }

  // ADR-017 decision 3 / FEAT-491 runtime gate — see MeetingCaptionsDisabledError.
  // Schema-level consent_disclosed is already guaranteed true by superRefine
  // above (config can't be checked there); this is the second, independent
  // gate the config default (false) protects against a client that sends a
  // well-formed, consent-stamped envelope to a daemon whose operator never
  // opted in locally.
  if (data.capture_source === 'meeting_captions' && !config.captureSource.meetingCaptions.enabled) {
    throw new MeetingCaptionsDisabledError();
  }

  // FEAT-506: route-layer default. A meeting-captions envelope that omits
  // `extract_profile` used to leave the column NULL, which runPipeline
  // resolves to the 'engineering' default (pipeline.ts:184) — 'engineering'
  // runs stage-4 LLM compaction BEFORE extraction, and compaction on
  // conversational content destroys facts including speaker names (FEAT-505
  // live debugging). Defaulting here, not in the pipeline, protects every
  // client that omits the field without touching the explicit-override path
  // below. Same schema instance covers both the HTTP route and spool-drain
  // (see the capture_source/extract_profile comments further down), so both
  // paths get this default for free.
  const resolvedExtractProfile =
    data.extract_profile ?? (data.capture_source === 'meeting_captions' ? 'conversational' : null);

  const stmtSelectIdempotency = db.prepare<[string], { body_hash: string; summary_memory_id: string | null }>(
    'SELECT body_hash, summary_memory_id FROM ingest_idempotency WHERE key = ?',
  );
  const stmtUpsertSession = db.prepare<[string, string | null, string | null, string | null, string | null, number]>(`
    INSERT INTO sessions (id, repo, project, branch, agent, cwd, started_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      repo    = COALESCE(excluded.repo, repo),
      project = COALESCE(excluded.project, project),
      agent   = COALESCE(excluded.agent, agent),
      cwd     = COALESCE(excluded.cwd, cwd)
  `);
  const stmtInsertTranscript = db.prepare<[
    string, string, string, string, number,
    string, number, number, number,
    string | null, string | null,
    string | null, string, string | null,
    string | null, string | null,
    string,
    string | null, string | null, number | null,
  ]>(`
    INSERT INTO transcripts (
      id, session_id, source, content, ingested_at,
      event, captured_at, client_scrub_applied, client_scrub_hits,
      client_scrub_version, client_scrub_hits_by_label_json,
      client_version, wire_version, capture_source, proxy_usage_json,
      extract_profile, captured_at_local_date,
      platform, meeting_id, consent_disclosed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtInsertJob = db.prepare<[string, string, number, number]>(`
    INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at)
    VALUES (?, 'distill', ?, 'pending', 0, ?, ?)
  `);
  const stmtInsertIdempotency = db.prepare<[string, string, string, number]>(`
    INSERT INTO ingest_idempotency (key, body_hash, summary_memory_id, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `);
  const stmtCheckTranscriptExists = db.prepare<[string], { id: string } | undefined>(
    'SELECT id FROM transcripts WHERE id = ?',
  );
  const stmtCheckMemoryExists = db.prepare<[string], { id: string } | undefined>(
    'SELECT id FROM memories WHERE id = ?',
  );
  const stmtDeleteIdempotency = db.prepare<[string]>(
    'DELETE FROM ingest_idempotency WHERE key = ?',
  );

  const turns = data.turns;
  const redactionEvents: RedactionEvent[] = [];
  const redactedTurns = turns.map(turn => {
    const { text, events } = redactIfEnabled(turn.text, config);
    redactionEvents.push(...events);
    return { ...turn, text };
  });

  const bodyHash = createHash('sha256').update(stableStringify(data)).digest('hex');
  const now = Date.now();
  const capturedAtMs = new Date(data.captured_at).getTime();
  // 2026-07-13 timezone-offset bugfix: the wire string's own YYYY-MM-DD
  // prefix IS the correct local calendar date at capture (that's what an
  // offset-bearing ISO-8601 datetime means) — captured BEFORE the string is
  // collapsed to the bare epoch above, which discards the offset entirely.
  // CanonicalIngestSchema's `z.string().datetime({ offset: true })` already
  // guarantees this 10-char prefix is well-formed. A legacy `...Z` envelope
  // (no real offset — pre-fix client) still slices out a valid date here;
  // it's simply the UTC one, byte-identical to the old fallback pipeline.ts
  // now uses when this column is NULL for even-older rows.
  const capturedAtLocalDate = data.captured_at.slice(0, 10);

  let transcriptId!: string;
  let jobId!: string;

  // Hoisted above the transaction — see the `resolvedRepo` param doc above.
  const sessionRepo = resolvedRepo !== undefined ? resolvedRepo : deriveRepoFromCwd(data.cwd);

  const tx = db.transaction(() => {
    if (idempotencyKey !== null) {
      stmtInsertIdempotency.run(idempotencyKey, bodyHash, '__pending__', now);
      const existing = stmtSelectIdempotency.get(idempotencyKey);

      if (existing && existing.summary_memory_id !== '__pending__') {
        if (existing.body_hash !== bodyHash) {
          throw new IdempotencyConflictError(idempotencyKey);
        }

        const stillExists = existing.summary_memory_id != null
          ? (stmtCheckTranscriptExists.get(existing.summary_memory_id)
              ?? stmtCheckMemoryExists.get(existing.summary_memory_id))
          : undefined;
        if (!stillExists) {
          stmtDeleteIdempotency.run(idempotencyKey);
          stmtInsertIdempotency.run(idempotencyKey, bodyHash, '__pending__', now);
        } else {
          throw new IdempotentReplayError(String(existing.summary_memory_id));
        }
      }
    }

    stmtUpsertSession.run(data.session_id, sessionRepo, data.project_id, data.agent_type ?? null, data.cwd ?? null, now);

    transcriptId = randomUUID();
    stmtInsertTranscript.run(
      transcriptId,
      data.session_id,
      `claude-code-${data.event}`,
      JSON.stringify(redactedTurns),
      now,
      data.event,
      capturedAtMs,
      data.client_scrub_applied ? 1 : 0,
      data.client_scrub_hits ?? 0,
      data.client_scrub_version ?? null,
      data.client_scrub_hits_by_label != null
        ? JSON.stringify(data.client_scrub_hits_by_label)
        : null,
      data.client_version ?? null,
      data.wire_version,
      // Same schema instance runs on the HTTP route and the spool-drain
      // worker (src/ingest/spool-drain.ts) — CanonicalIngestSchema.safeParse
      // already rejected anything outside the enum above before this runs.
      data.capture_source ?? null,
      // FEAT-458 S6 — verbatim JSON serialization of the zod-validated
      // proxy_usage object (numeric fields already nullable at the schema
      // boundary above, so JSON.stringify preserves `null` as JSON null,
      // never coerces it to 0). Absent on every non-proxy envelope -> NULL.
      data.proxy_usage != null ? JSON.stringify(data.proxy_usage) : null,
      // FEAT-479 (D3 §3.2) AC-3: same "schema instance covers both the HTTP
      // route and spool-drain" note as capture_source above applies here too.
      // FEAT-506: resolvedExtractProfile applies the meeting_captions ->
      // 'conversational' route-layer default computed above when the client
      // omitted the field — an explicit client value always wins.
      resolvedExtractProfile,
      capturedAtLocalDate,
      // FEAT-491 (ADR-017): platform/meeting_id describe the capture
      // session (null on every non-meeting-captions envelope, byte-identical
      // to today). consent_disclosed is guaranteed true here whenever
      // capture_source is 'meeting_captions' (superRefine + the runtime gate
      // above both already refused anything else) — stored as 0/1/NULL so
      // distillHandler can thread it onto every atom this transcript
      // produces (src/pipeline/handlers/distill.ts).
      data.platform ?? null,
      data.meeting_id ?? null,
      data.consent_disclosed === undefined ? null : (data.consent_disclosed ? 1 : 0),
    );

    recordRedactionEvents(db, redactionEvents, data.session_id);

    jobId = randomUUID();
    stmtInsertJob.run(
      jobId,
      JSON.stringify({ transcript_id: transcriptId, session_id: data.session_id }),
      now,
      now,
    );

    if (idempotencyKey !== null) {
      stmtDeleteIdempotency.run(idempotencyKey);
      stmtInsertIdempotency.run(idempotencyKey, bodyHash, transcriptId, now);
    }
  });

  tx();

  return { transcriptId, jobId, serverRedactionHits: redactionEvents.length };
}

// ---------------------------------------------------------------------------
// Route factory statements — FEAT-537: prepared LAZILY (on first request),
// not at route-registration time. `buildApp()` (which calls `ingestRoute()`)
// runs BEFORE `migrate()` in the reordered boot sequence (src/cli/serve.ts) —
// binding the port ahead of migration so /health answers `starting` and
// every authed route 503s via the readiness gate while the DB catches up.
// Preparing these statements eagerly, at factory-call time, threw
// `SqliteError: no such table: ingest_idempotency` against a fresh,
// unmigrated DB, which made buildApp() itself unusable before a single route
// was reachable. Deferred here and memoized (prepared exactly ONCE, on the
// first request that needs them, same "prepare once" cost as before) — a
// prepare failure (bad SQL, genuinely missing table) still throws loudly on
// that first request rather than being swallowed (ADR-015).
// ---------------------------------------------------------------------------

function prepareIngestStatements(db: DB) {
  return {
    // ---- Canonical path statements ----
    stmtSelectIdempotency: db.prepare<[string], { body_hash: string; summary_memory_id: string | null }>(
      'SELECT body_hash, summary_memory_id FROM ingest_idempotency WHERE key = ?',
    ),

    // cwd (FEAT-403 / migration 009) is stored so the tag-hygiene backfill can
    // still catch stragglers, but FEAT-423 also derives `repo` from it
    // synchronously here — the canonical envelope never sends `repo` directly,
    // so without this the `repo` column (and anything preferring it, e.g.
    // deriveProject) would sit NULL until the async backfill runs.
    stmtUpsertSession: db.prepare<[string, string | null, string | null, string | null, string | null, number]>(`
      INSERT INTO sessions (id, repo, project, branch, agent, cwd, started_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        repo    = COALESCE(excluded.repo, repo),
        project = COALESCE(excluded.project, project),
        agent   = COALESCE(excluded.agent, agent),
        cwd     = COALESCE(excluded.cwd, cwd)
    `),

    stmtInsertTranscript: db.prepare<[
      string, string, string, string, number,
      string, number, number, number,
      string | null, string | null,
      string | null, string,
    ]>(`
      INSERT INTO transcripts (
        id, session_id, source, content, ingested_at,
        event, captured_at, client_scrub_applied, client_scrub_hits,
        client_scrub_version, client_scrub_hits_by_label_json,
        client_version, wire_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

    stmtInsertJob: db.prepare<[string, string, number, number]>(`
      INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at)
      VALUES (?, 'distill', ?, 'pending', 0, ?, ?)
    `),

    // ADR-008 events kind — same transcripts-row shape as the transcript path
    // (reuses stmtInsertTranscript), but enqueues a distinct job kind so the
    // worker routes it to distillEventsHandler instead of distillHandler.
    stmtInsertDistillEventsJob: db.prepare<[string, string, number, number]>(`
      INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at)
      VALUES (?, 'distill-events', ?, 'pending', 0, ?, ?)
    `),

    stmtInsertIdempotency: db.prepare<[string, string, string, number]>(`
      INSERT INTO ingest_idempotency (key, body_hash, summary_memory_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO NOTHING
    `),

    // Used for D-B3 dangling-row check on replay. `summary_memory_id` starts
    // out as the transcript id (placeholder, written at ingest time) and may
    // later be backfilled to a real `memories.id` once distillation completes
    // (D-DEF2, see storage/ingest-idempotency.ts) — so "does this id still
    // resolve to something" has to check both tables.
    stmtCheckTranscriptExists: db.prepare<[string], { id: string } | undefined>(
      'SELECT id FROM transcripts WHERE id = ?',
    ),
    stmtCheckMemoryExists: db.prepare<[string], { id: string } | undefined>(
      'SELECT id FROM memories WHERE id = ?',
    ),

    // Used for D-B3 invalidation of dangling idempotency row
    stmtDeleteIdempotency: db.prepare<[string]>(
      'DELETE FROM ingest_idempotency WHERE key = ?',
    ),

    // ---- Legacy path statements ----
    stmtUpsertSessionLegacy: db.prepare<[string, string | null, string | null, string | null, string | null, number]>(`
      INSERT INTO sessions (id, repo, project, branch, agent, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        repo = COALESCE(excluded.repo, repo),
        project = COALESCE(excluded.project, project),
        branch = COALESCE(excluded.branch, branch),
        agent = COALESCE(excluded.agent, agent)
    `),

    stmtInsertTranscriptLegacy: db.prepare<[string, string, string, string, number]>(`
      INSERT INTO transcripts (id, session_id, source, content, ingested_at)
      VALUES (?, ?, ?, ?, ?)
    `),

    stmtInsertJobLegacy: db.prepare<[string, string, number, number]>(`
      INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at)
      VALUES (?, 'distill', ?, 'pending', 0, ?, ?)
    `),
  };
}

type IngestStatements = ReturnType<typeof prepareIngestStatements>;

export function ingestRoute(db: DB, config: Config = defaultConfig()) {
  // Memoized — prepared on the first request that needs them, cached for
  // every request after. See the module-doc comment above for why this
  // can no longer happen eagerly at factory-call time.
  let cachedStmts: IngestStatements | null = null;
  function getStmts(): IngestStatements {
    if (!cachedStmts) cachedStmts = prepareIngestStatements(db);
    return cachedStmts;
  }

  // ---------------------------------------------------------------------
  // Shared idempotency-key handling (D-B1/D-B2/D-B3) — extracted so the
  // events-kind branch can reuse the exact same claim/replay/conflict/
  // dangling-row semantics as the transcript-kind path without duplicating
  // the logic inline. MUST be called from inside a db.transaction().
  // ---------------------------------------------------------------------

  /**
   * Attempt to claim the idempotency slot for `key`. Throws a sentinel error
   * (`_isReplay` or `_isIdempotencyConflict`) to signal the caller's
   * transaction should abort and the route should return early — mirrors
   * the inline logic in the transcript-kind path.
   */
  function claimIdempotencySlot(key: string, bodyHash: string, now: number): void {
    const { stmtInsertIdempotency, stmtSelectIdempotency, stmtCheckTranscriptExists, stmtCheckMemoryExists, stmtDeleteIdempotency } = getStmts();
    stmtInsertIdempotency.run(key, bodyHash, '__pending__', now);
    const existing = stmtSelectIdempotency.get(key);

    if (existing && existing.summary_memory_id !== '__pending__') {
      if (existing.body_hash !== bodyHash) {
        throw Object.assign(new Error('idempotency_conflict'), { _isIdempotencyConflict: true });
      }

      // D-B3: guard against a dangling row (summary_memory_id may point at
      // either a transcript or a backfilled memory — check both).
      const stillExists = existing.summary_memory_id != null
        ? (stmtCheckTranscriptExists.get(existing.summary_memory_id)
            ?? stmtCheckMemoryExists.get(existing.summary_memory_id))
        : undefined;
      if (!stillExists) {
        stmtDeleteIdempotency.run(key);
        stmtInsertIdempotency.run(key, bodyHash, '__pending__', now);
      } else {
        throw Object.assign(new Error('idempotent_replay'), {
          _isReplay: true,
          _replayId: existing.summary_memory_id,
        });
      }
    }
  }

  /** Update the idempotency placeholder with the real transcript id once the insert has happened. */
  function finalizeIdempotencySlot(key: string, bodyHash: string, transcriptId: string, now: number): void {
    const { stmtDeleteIdempotency, stmtInsertIdempotency } = getStmts();
    stmtDeleteIdempotency.run(key);
    stmtInsertIdempotency.run(key, bodyHash, transcriptId, now);
  }

  return async (app: FastifyInstance) => {
    app.post('/ingest/transcript', async (req, reply) => {
      // Prepare-once-and-cache (FEAT-537): first request pays the prepare
      // cost, every request after reuses the memoized statements — same
      // per-process cost as the old eager-at-registration prepare, just
      // deferred past the readiness gate instead of ahead of migrate().
      const {
        stmtSelectIdempotency, stmtUpsertSession, stmtInsertTranscript,
        stmtInsertDistillEventsJob, stmtUpsertSessionLegacy,
        stmtInsertTranscriptLegacy, stmtInsertJobLegacy,
      } = getStmts();
      const requestId = (req as unknown as Record<string, unknown>)['requestId'] as string | undefined;
      const parsed = parseIngestBody(req.body);
      if (!parsed.success) {
        const log = childLogger({ request_id: requestId ?? 'unknown' });
        const flat = parsed.error.flatten();
        // `envelope` tells the reader WHICH schema the body was judged against —
        // without it, a `fieldErrors.turns` message is ambiguous between the two.
        const envelope =
          req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) &&
          'wire_version' in (req.body as object)
            ? 'canonical'
            : 'legacy';
        log.warn({ envelope, details: flat }, 'ingest validation failed');
        return reply.code(400).send({ error: 'invalid', envelope, details: flat });
      }

      const data = parsed.data;

      // ------------------------------------------------------------------
      // Canonical path — real insert (FEAT-4a Phase 2 stage 3)
      // ------------------------------------------------------------------
      if (isCanonical(data)) {
        const log = childLogger({ request_id: requestId ?? 'unknown', session_id: data.session_id });

        // ------------------------------------------------------------------
        // ADR-008 events kind — pre-typed atom candidates (runner-plugin
        // grades/lessons/review verdicts). Redact, store as a transcripts
        // row, enqueue 'distill-events' (skips pipeline stages 1-5, enters
        // at reduce/stage 6 — see src/pipeline/handlers/distill-events.ts).
        // ------------------------------------------------------------------
        if (data.kind === 'events') {
          const events = data.events!; // superRefine guarantees non-empty for kind === 'events'

          // ---- Stage-0 secret redaction (SEC-3/5) applies to events too ----
          const redactionEventsForEvents: RedactionEvent[] = [];
          const redactedEvents = events.map(ev => {
            const { text, events: textRedactions } = redactIfEnabled(ev.text, config);
            redactionEventsForEvents.push(...textRedactions);
            let evidence = ev.evidence;
            if (evidence !== undefined) {
              const { text: redactedEvidence, events: evidenceRedactions } = redactIfEnabled(evidence, config);
              evidence = redactedEvidence;
              redactionEventsForEvents.push(...evidenceRedactions);
            }
            return { ...ev, text, evidence };
          });

          const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? null;
          const bodyHash = createHash('sha256').update(stableStringify(data)).digest('hex');
          const now = Date.now();
          const capturedAtMs = new Date(data.captured_at).getTime();
          const sourceLabel = data.tool ? `${data.tool}-events` : 'events';

          let transcriptId!: string;
          let jobId!: string;

          // FEAT-484 review fix (PR #405, HIGH): resolved async, hoisted
          // above the sync `db.transaction()` below — see the doc comment
          // on `resolveRepoIdentityAsync`.
          const sessionRepo = await deriveRepoFromCwdAsync(data.cwd);

          try {
            const tx = db.transaction(() => {
              if (idempotencyKey !== null) claimIdempotencySlot(idempotencyKey, bodyHash, now);

              stmtUpsertSession.run(data.session_id, sessionRepo, data.project_id, data.agent_type ?? null, data.cwd ?? null, now);

              transcriptId = randomUUID();
              stmtInsertTranscript.run(
                transcriptId,
                data.session_id,
                sourceLabel,
                JSON.stringify(redactedEvents),
                now,
                data.event,
                capturedAtMs,
                data.client_scrub_applied ? 1 : 0,
                data.client_scrub_hits ?? 0,
                data.client_scrub_version ?? null,
                data.client_scrub_hits_by_label != null
                  ? JSON.stringify(data.client_scrub_hits_by_label)
                  : null,
                data.client_version ?? null,
                data.wire_version,
              );

              // SEC-6: one redaction_log row per distinct type found in this ingest.
              recordRedactionEvents(db, redactionEventsForEvents, data.session_id);

              jobId = randomUUID();
              stmtInsertDistillEventsJob.run(
                jobId,
                JSON.stringify({ transcript_id: transcriptId, session_id: data.session_id }),
                now,
                now,
              );

              if (idempotencyKey !== null) finalizeIdempotencySlot(idempotencyKey, bodyHash, transcriptId, now);
            });

            tx();
          } catch (err) {
            const e = err as Record<string, unknown>;

            if (e['_isReplay'] === true) {
              log.info({ idempotency_key: idempotencyKey }, 'idempotent replay (events)');
              return reply.code(200).send({
                ok: true,
                summary_memory_id: e['_replayId'],
                session_id: data.session_id,
                idempotent: true,
              });
            }

            if (e['_isIdempotencyConflict'] === true) {
              log.warn({ idempotency_key: idempotencyKey }, 'idempotency key reused with different body (events)');
              return reply.code(409).send({
                error: 'idempotency_conflict',
                idempotency_key: idempotencyKey,
                detail: 'key reused with different body',
              });
            }

            if (
              typeof e['code'] === 'string' &&
              (e['code'] === 'SQLITE_CONSTRAINT_PRIMARYKEY' || e['code'] === 'SQLITE_CONSTRAINT_UNIQUE')
            ) {
              log.warn({ idempotency_key: idempotencyKey, err: String(err) }, 'sqlite constraint on idempotency insert — treating as replay (events)');
              const existing = stmtSelectIdempotency.get(idempotencyKey ?? '');
              return reply.code(200).send({
                ok: true,
                summary_memory_id: existing?.summary_memory_id ?? null,
                session_id: data.session_id,
                idempotent: true,
              });
            }

            throw err;
          }

          log.info(
            { job_id: jobId, transcript_id: transcriptId, wire_version: data.wire_version, event: data.event, event_count: events.length, tool: data.tool ?? null },
            'events ingested, distill-events job enqueued',
          );

          // ADR-008 events kind: each event already carries its own atom
          // `type` (no LLM extraction stage — distillEventsHandler maps
          // events straight to atoms, see distill-events.ts stage 6+).
          // Queued types are therefore the exact distinct types posted,
          // in first-seen order, not the full registry.
          const queuedExtractionTypesForEvents = [...new Set(events.map(ev => ev.type))];

          return reply.code(200).send({
            ok: true,
            summary_memory_id: transcriptId,
            session_id: data.session_id,
            idempotent: false,
            extraction_job_id: jobId,
            // Extraction runs asynchronously off the job queue — not yet run
            // at response time, so these are stubbed per CHANGELOG v0.2.0.
            extracted_count: 0,
            failed_atom_count: 0,
            scrub_hits: { client: data.client_scrub_hits, server: redactionEventsForEvents.length },
            queued_extraction_types: queuedExtractionTypesForEvents,
          });
        }

        // ---- Idempotency-key handling ----
        // D-B1: ingestCanonicalTranscript uses stableStringify on the
        //        Zod-parsed object so key order differences between clients
        //        don't produce different body hashes.
        const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? null;

        // FEAT-484 review fix (PR #405, HIGH): resolved async here — the
        // route handler is already `async` — and passed in pre-resolved so
        // `ingestCanonicalTranscript`'s internal `db.transaction()` never
        // spawns `git` synchronously. See `resolveRepoIdentityAsync`'s doc
        // comment.
        const resolvedRepo = await deriveRepoFromCwdAsync(data.cwd);

        // D-B2/D-B3/FEAT-449: the claim -> insert -> finalize sequence (and
        // the dangling-row / replay / conflict semantics) now live in the
        // shared ingestCanonicalTranscript — this route is a thin wrapper
        // that maps its result or thrown sentinel error to an HTTP response.
        try {
          const result = ingestCanonicalTranscript(db, config, data, idempotencyKey, resolvedRepo);

          log.info(
            { job_id: result.jobId, transcript_id: result.transcriptId, wire_version: data.wire_version, event: data.event },
            'canonical transcript ingested, distill job enqueued',
          );

          return reply.code(200).send({
            ok: true,
            summary_memory_id: result.transcriptId,
            session_id: data.session_id,
            idempotent: false,
            extraction_job_id: result.jobId,
            // Extraction runs asynchronously off the job queue (distillHandler,
            // stages 4-5 LLM extraction) — not yet run at response time, so
            // these are stubbed per CHANGELOG v0.2.0 ("full job queue in
            // v0.3.0+"). Not fabricated: the real values genuinely don't
            // exist yet when this response is built.
            extracted_count: 0,
            failed_atom_count: 0,
            scrub_hits: { client: data.client_scrub_hits, server: result.serverRedactionHits },
            // Full LLM extraction hasn't run yet, so which types will actually
            // be produced is unknown — report the full candidate registry the
            // distill pipeline can emit (see ALL_ATOM_TYPES above).
            queued_extraction_types: ALL_ATOM_TYPES,
          });
        } catch (err) {
          if (err instanceof IdempotentReplayError) {
            log.info({ idempotency_key: idempotencyKey }, 'idempotent replay');
            return reply.code(200).send({
              ok: true,
              summary_memory_id: err.replayId,
              session_id: data.session_id,
              idempotent: true,
            });
          }

          if (err instanceof IdempotencyConflictError) {
            log.warn({ idempotency_key: idempotencyKey }, 'idempotency key reused with different body');
            return reply.code(409).send({
              error: 'idempotency_conflict',
              idempotency_key: idempotencyKey,
              detail: 'key reused with different body',
            });
          }

          // ADR-017 decision 3 / FEAT-491: this daemon's operator has not
          // opted into meeting-captions capture (captureSource.
          // meetingCaptions.enabled, default false) — reject rather than
          // silently accept a well-formed, consent-stamped envelope from a
          // client whose plugin-side opt-in the daemon has no way to verify
          // is the SAME operator's own choice.
          if (err instanceof MeetingCaptionsDisabledError) {
            log.warn({ session_id: data.session_id }, 'meeting-captions capture rejected — captureSource.meetingCaptions.enabled is false');
            return reply.code(400).send({
              error: 'meeting_captions_capture_disabled',
              detail: 'captureSource.meetingCaptions.enabled is false on this daemon — enable it before sending meeting-captions envelopes (ADR-017)',
            });
          }

          // Belt-and-suspenders: catch SQLite UNIQUE constraint errors that
          // weren't handled by ON CONFLICT DO NOTHING (shouldn't happen, but
          // guard just in case).
          const e = err as Record<string, unknown>;
          if (
            typeof e['code'] === 'string' &&
            (e['code'] === 'SQLITE_CONSTRAINT_PRIMARYKEY' || e['code'] === 'SQLITE_CONSTRAINT_UNIQUE')
          ) {
            log.warn({ idempotency_key: idempotencyKey, err: String(err) }, 'sqlite constraint on idempotency insert — treating as replay');
            const existing = stmtSelectIdempotency.get(idempotencyKey ?? '');
            return reply.code(200).send({
              ok: true,
              summary_memory_id: existing?.summary_memory_id ?? null,
              session_id: data.session_id,
              idempotent: true,
            });
          }

          throw err;
        }
      }

      // ------------------------------------------------------------------
      // Legacy path — unchanged insert logic, plus stage-0 redaction (SEC-3/5)
      // ------------------------------------------------------------------
      const { session_id, source, content, repo, project, branch, agent } = data;
      const now = Date.now();

      const { text: redactedContent, events: redactionEventsLegacy } = redactIfEnabled(content, config);

      let transcriptId!: string;
      let jobId!: string;

      const tx = db.transaction(() => {
        stmtUpsertSessionLegacy.run(session_id, repo ?? null, project ?? null, branch ?? null, agent ?? null, now);

        transcriptId = randomUUID();
        stmtInsertTranscriptLegacy.run(transcriptId, session_id, source, redactedContent, now);

        // SEC-6: one redaction_log row per distinct type found in this ingest.
        recordRedactionEvents(db, redactionEventsLegacy, session_id);

        jobId = randomUUID();
        stmtInsertJobLegacy.run(
          jobId,
          JSON.stringify({ transcript_id: transcriptId, session_id }),
          now,
          now,
        );
      });
      tx();

      // Bind session_id + transcript_id to log context for this ingest
      const log = childLogger({
        request_id: requestId ?? 'unknown',
        session_id,
        transcript_id: transcriptId,
      });
      log.info({ job_id: jobId, source }, 'transcript ingested, distill job enqueued');

      return { ok: true };
    });
  };
}
