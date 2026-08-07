/**
 * FEAT-476 Phase 0 — the cost ledger's storage layer: `cost_events`
 * (migration 064) persistence + `price_versions` lookup + the read-time
 * dollar-derivation report. See
 * `.claude/artifacts/loop/backlog/pending/FEAT-476.md` for the full spec —
 * this module is the read side described there: dollar amounts are NEVER
 * stored, always derived at query time by joining a `cost_events` row's
 * `captured_at` against the `price_versions` row whose effective window
 * contains it (AC-1).
 *
 * Two ingest paths write into `cost_events` (src/capture/cost-spool.ts's
 * drain worker for the proxy tee, src/capture/otel-ingest.ts for Claude
 * Code's native OTel export) — both funnel through `recordCostEvent` below,
 * which owns the AC-6 dedup/preference contract so neither call site has to
 * reimplement it.
 */
import type { DB } from './db.js';
import { contentHash } from './content-hash.js';
import { attributeSlice, readWorkflowStateWindows, type WorkflowStateWindow } from './slice-attribution.js';

export type CostEventSource = 'proxy' | 'otel';

/** Facts persisted per captured exchange. Every numeric usage field is
 *  `number | null` — `null` means "not present in the captured response"
 *  and must never be coerced to 0 (see migration 064's own doc comment).
 *  Deliberately has NO `slice_id` field: per FEAT-476 AC-7, slice
 *  attribution is a REPORT-TIME join against the CURRENT
 *  `.claude/state/crew/workflow-state.json` (see `attributeSlice`), not a
 *  value fixed at ingest time — `workflow-state.json`'s `recentRuns` window
 *  rotates, so persisting a slice_id here would silently go stale exactly
 *  when it matters (long-lived retrospective reports). */
export interface CostEventInput {
  source: CostEventSource;
  capturedAtMs: number;
  provider: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  stopReason: string | null;
  truncated: boolean;
  sessionKey: string;
  /** Only ever populated from an ingest source that actually carries it
   *  (OTel `agent.name`) — proxy-sourced rows always pass `null` here (see
   *  module doc + FEAT-476 spec's attribution-join-contract section). */
  agentRole: string | null;
}

export interface CostEventRow {
  id: number;
  source: CostEventSource;
  capturedAt: number;
  provider: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  stopReason: string | null;
  truncated: boolean;
  sessionKey: string;
  agentRole: string | null;
  dedupKey: string;
  createdAt: number;
}

type DedupBasisInput = Pick<CostEventInput,
  'provider' | 'model' | 'capturedAtMs' | 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'
>;

const DEDUP_TIME_BUCKET_MS = 5_000;

function dedupField(v: number | null): string {
  return v === null ? 'null' : String(v);
}

function dedupBasis(input: DedupBasisInput, bucket: number): string {
  return [
    input.provider,
    input.model ?? 'null',
    String(bucket),
    dedupField(input.inputTokens),
    dedupField(input.outputTokens),
    dedupField(input.cacheReadInputTokens),
    dedupField(input.cacheCreationInputTokens),
  ].join('|');
}

/** Stable hash across BOTH ingest paths for the SAME physical exchange
 *  (AC-6). Time-bucketed to 5s so the proxy's own capture timestamp and
 *  Claude Code's independently-stamped OTel timestamp for the identical
 *  exchange still collide — the two paths observe the same wall-clock
 *  event but stamp it at slightly different points in their own pipeline.
 *  Token counts and model/provider are the real content-identity signal;
 *  `null` fields are hashed as a literal sentinel (not skipped) so an
 *  "unknown usage" row never collides with a different exchange that
 *  happens to share provider/model/time-bucket.
 *
 *  This is the EXACT-bucket key, used as the value actually stored in
 *  `cost_events.dedup_key` on insert. Existence checks in `recordCostEvent`
 *  do NOT rely on this alone — see `computeDedupKeyCandidates` below for
 *  why a hard floor-bucket boundary is insufficient on its own. */
export function computeDedupKey(input: DedupBasisInput): string {
  const bucket = Math.floor(input.capturedAtMs / DEDUP_TIME_BUCKET_MS);
  return contentHash(dedupBasis(input, bucket));
}

/**
 * The three dedup-key candidates (previous bucket, exact bucket, next
 * bucket) for `input`'s content. A hard `Math.floor` bucket boundary means
 * two timestamps 2ms apart that straddle a boundary (e.g. 4999ms and
 * 5001ms) land in DIFFERENT buckets and would otherwise hash to different
 * keys — silently defeating AC-6 dedup for an exchange whose proxy and OTel
 * timestamps happen to straddle a bucket edge. `recordCostEvent` checks
 * existence against all three candidates (a rolling ±1-bucket window, ~15s
 * total tolerance) rather than the exact bucket alone.
 *
 * Honest tradeoff, not a free lunch: widening the match window slightly
 * increases the (already-accepted, see `computeDedupKey`'s own doc) risk
 * that two genuinely DIFFERENT exchanges sharing identical
 * provider/model/token-counts within ~15s of each other collide and the
 * second is dropped as a false duplicate. Bounded and rare in practice
 * (real exchanges essentially never share exact token counts) — the same
 * risk category the single-bucket design already accepted, not a new one.
 */
export function computeDedupKeyCandidates(input: DedupBasisInput): string[] {
  const bucket = Math.floor(input.capturedAtMs / DEDUP_TIME_BUCKET_MS);
  return [bucket - 1, bucket, bucket + 1].map(b => contentHash(dedupBasis(input, b)));
}

export interface RecordCostEventResult {
  /** True when this call inserted a brand-new row (no prior dedup_key match). */
  inserted: boolean;
  /** True when this call's row is now the one persisted under this
   *  dedup_key — either because it was newly inserted, or because it was an
   *  'otel' row that replaced an existing 'proxy' row (AC-6: OTel preferred
   *  on collision, richer attribution). False when an existing row was left
   *  untouched (idempotent same-source replay, or a later 'proxy' row
   *  arriving after an 'otel' row already won). */
  preferred: boolean;
}

/**
 * Insert (or, on an AC-6 dedup collision, conditionally replace) one
 * cost_events row. Idempotent: re-delivering the identical exchange from
 * the SAME source is always a no-op past the first call. Across sources,
 * the 'otel' row always wins — richer attribution (real session_id,
 * agent_role) — regardless of arrival order.
 */
export function recordCostEvent(db: DB, input: CostEventInput): RecordCostEventResult {
  const dedupKey = computeDedupKey(input);
  // Finding 4 (review): check the rolling ±1-bucket window, not just the
  // exact bucket — see computeDedupKeyCandidates' doc for why the hard
  // floor-bucket boundary alone silently defeats AC-6 dedup for timestamps
  // a few ms apart that straddle a bucket edge. When more than one
  // candidate matches an existing row (a rare multi-collision), the row
  // whose captured_at is CLOSEST to this input's capturedAtMs is treated as
  // the same physical exchange.
  const candidates = computeDedupKeyCandidates(input);
  const matches = db
    .prepare(`SELECT id, source, captured_at FROM cost_events WHERE dedup_key IN (${candidates.map(() => '?').join(',')})`)
    .all(...candidates) as { id: number; source: CostEventSource; captured_at: number }[];
  const existing = matches.length === 0 ? undefined : matches.reduce((closest, row) =>
    Math.abs(row.captured_at - input.capturedAtMs) < Math.abs(closest.captured_at - input.capturedAtMs) ? row : closest
  );

  if (!existing) {
    db.prepare(`
      INSERT INTO cost_events (
        source, captured_at, provider, model, input_tokens, output_tokens,
        cache_read_input_tokens, cache_creation_input_tokens, stop_reason,
        truncated, session_key, slice_id, agent_role, dedup_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `).run(
      input.source, input.capturedAtMs, input.provider, input.model,
      input.inputTokens, input.outputTokens, input.cacheReadInputTokens,
      input.cacheCreationInputTokens, input.stopReason, input.truncated ? 1 : 0,
      input.sessionKey, input.agentRole, dedupKey, Date.now(),
    );
    return { inserted: true, preferred: true };
  }

  if (existing.source === 'proxy' && input.source === 'otel') {
    db.prepare(`
      UPDATE cost_events SET
        source = ?, captured_at = ?, provider = ?, model = ?, input_tokens = ?,
        output_tokens = ?, cache_read_input_tokens = ?, cache_creation_input_tokens = ?,
        stop_reason = ?, truncated = ?, session_key = ?, agent_role = ?
      WHERE id = ?
    `).run(
      input.source, input.capturedAtMs, input.provider, input.model,
      input.inputTokens, input.outputTokens, input.cacheReadInputTokens,
      input.cacheCreationInputTokens, input.stopReason, input.truncated ? 1 : 0,
      input.sessionKey, input.agentRole, existing.id,
    );
    return { inserted: false, preferred: true };
  }

  // Same-source replay (idempotent no-op), or a 'proxy' row arriving after
  // an 'otel' row already claimed this dedup_key — the OTel row keeps
  // priority either way (AC-6).
  return { inserted: false, preferred: false };
}

function rowToCostEvent(row: any): CostEventRow {
  return {
    id: row.id,
    source: row.source,
    capturedAt: row.captured_at,
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadInputTokens: row.cache_read_input_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens,
    stopReason: row.stop_reason,
    truncated: row.truncated === 1,
    sessionKey: row.session_key,
    agentRole: row.agent_role,
    dedupKey: row.dedup_key,
    createdAt: row.created_at,
  };
}

export function listCostEvents(db: DB, opts: { sinceMs?: number } = {}): CostEventRow[] {
  const rows = db
    .prepare('SELECT * FROM cost_events WHERE captured_at >= ? ORDER BY captured_at ASC')
    .all(opts.sinceMs ?? 0) as any[];
  return rows.map(rowToCostEvent);
}

export type PriceTier = 'standard' | 'priority' | 'batch';

export interface PriceVersionRow {
  id: number;
  provider: string;
  model: string;
  tier: PriceTier;
  effectiveFrom: number;
  effectiveTo: number | null;
  inputRate: number;
  outputRate: number;
  cacheReadMultiplier: number;
  cacheWriteMultiplier: number;
  source: 'config' | 'manual-correction';
  createdAt: number;
}

function rowToPriceVersion(row: any): PriceVersionRow {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    tier: row.tier,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    inputRate: row.input_rate,
    outputRate: row.output_rate,
    cacheReadMultiplier: row.cache_read_multiplier,
    cacheWriteMultiplier: row.cache_write_multiplier,
    source: row.source,
    createdAt: row.created_at,
  };
}

/**
 * Resolve the price_versions row covering `atMs` for (provider, model,
 * tier) — PREFIX match on `model` (longest prefix wins when more than one
 * price_versions row's model is a prefix of the queried model id), so a
 * real captured id like `claude-sonnet-5-20260815` still resolves against a
 * seeded `claude-sonnet-5` row without needing an exact-string catalog kept
 * in lockstep with every point release. Returns `null` — never a guessed
 * default — when nothing matches (AC-4).
 *
 * Tie-break on an EQUAL-length prefix match: prefer the row with the
 * GREATEST `effective_from` (the most recently added version). This is
 * defense-in-depth alongside `addPriceVersion`'s own close-the-prior-row
 * behavior (review finding 1) — even if two rows for the identical
 * (provider, model, tier) end up simultaneously "open"
 * (`effective_to IS NULL`) for any reason, the newer one wins rather than
 * whichever SQLite happens to return first.
 *
 * NOTE (Phase 0 tier gap, review finding 3): `tier` defaults to
 * `'standard'` when the caller doesn't pass one, and every call site in
 * this module (`costReport`, below) always omits it — `cost_events` has NO
 * tier column in Phase 0 (the capture layer cannot detect Priority Tier or
 * Batch API usage from body-only/OTel visibility), so EVERY event is priced
 * as standard tier unconditionally. This is a deliberate, loud Phase 0
 * simplification, not a silent one — see `costReport`'s `tierAssumptionNote`
 * (always present in the report output) and migration 064's own doc
 * comment. The seeded `'batch'`-tier price_versions rows exist for a future
 * slice that adds real tier detection; they are inert (never matched) until
 * that lands.
 *
 * Done in JS rather than a SQL `LIKE model || '%'` join deliberately: the
 * `price_versions` table is small (tens of rows), and a JS prefix scan
 * avoids ever having to think about escaping `%`/`_` inside a model id for
 * SQL LIKE semantics.
 */
export function findPriceVersion(
  db: DB,
  opts: { provider: string; model: string; tier?: PriceTier; atMs: number },
): PriceVersionRow | null {
  const tier = opts.tier ?? 'standard';
  const rows = db
    .prepare(`
      SELECT * FROM price_versions
      WHERE provider = ? AND tier = ?
        AND effective_from <= ?
        AND (effective_to IS NULL OR effective_to > ?)
    `)
    .all(opts.provider, tier, opts.atMs, opts.atMs) as any[];

  let best: PriceVersionRow | null = null;
  for (const raw of rows) {
    const candidate = rowToPriceVersion(raw);
    if (!opts.model.startsWith(candidate.model)) continue;
    if (!best) { best = candidate; continue; }
    if (candidate.model.length > best.model.length) { best = candidate; continue; }
    if (candidate.model.length === best.model.length && candidate.effectiveFrom > best.effectiveFrom) { best = candidate; }
  }
  return best;
}

/**
 * Add a genuine NEW price version — a real provider price change effective
 * from `effectiveFrom` onward. Historical `cost_events` before that date
 * are provably unaffected (AC-2, second half): `findPriceVersion`'s window
 * filter simply never selects this new row for an older `atMs`.
 *
 * Review finding 1 fix: BEFORE inserting, close any prior row for the same
 * exact (provider, model, tier) that is still open (`effective_to IS NULL`)
 * and predates this one, by setting its `effective_to` to this row's
 * `effective_from`. Without this, two open rows for the identical
 * coordinates could both match `findPriceVersion`'s window filter for the
 * same `atMs` — the OLD (stale) row winning depended on undefined query
 * result order, not on anything principled. Only ever closes an EXACT
 * model-string match (not a prefix relationship) — adding a new sibling
 * model row (e.g. `claude-opus-5` alongside an existing `claude-sonnet-5`)
 * must never touch an unrelated model's open window.
 */
export function addPriceVersion(db: DB, row: Omit<PriceVersionRow, 'id' | 'createdAt' | 'source'>): number {
  db.prepare(`
    UPDATE price_versions
    SET effective_to = ?
    WHERE provider = ? AND model = ? AND tier = ?
      AND effective_to IS NULL
      AND effective_from < ?
  `).run(row.effectiveFrom, row.provider, row.model, row.tier, row.effectiveFrom);

  const info = db.prepare(`
    INSERT INTO price_versions (
      provider, model, tier, effective_from, effective_to, input_rate, output_rate,
      cache_read_multiplier, cache_write_multiplier, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'config', ?)
  `).run(
    row.provider, row.model, row.tier, row.effectiveFrom, row.effectiveTo,
    row.inputRate, row.outputRate, row.cacheReadMultiplier, row.cacheWriteMultiplier, Date.now(),
  );
  return Number(info.lastInsertRowid);
}

/**
 * Correct an EXISTING price_versions row IN PLACE — a data-entry fix for a
 * rate that was always wrong for that window, not a new price taking
 * effect. Every historical `cost_events` figure computed against this
 * window immediately reflects the corrected rate on the report's next run
 * (AC-2, first half) because the report never caches a derived dollar
 * figure — it re-joins from raw facts every time. Tagged
 * `source: 'manual-correction'` so a report (or a future audit) can tell
 * "we corrected a typo" apart from "the provider changed the price".
 */
export function correctPriceVersion(
  db: DB,
  id: number,
  patch: Partial<Pick<PriceVersionRow, 'inputRate' | 'outputRate' | 'cacheReadMultiplier' | 'cacheWriteMultiplier'>>,
): void {
  const existing = db.prepare('SELECT id FROM price_versions WHERE id = ?').get(id);
  if (!existing) throw new Error(`correctPriceVersion: no price_versions row with id ${id}`);

  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.inputRate !== undefined) { sets.push('input_rate = ?'); params.push(patch.inputRate); }
  if (patch.outputRate !== undefined) { sets.push('output_rate = ?'); params.push(patch.outputRate); }
  if (patch.cacheReadMultiplier !== undefined) { sets.push('cache_read_multiplier = ?'); params.push(patch.cacheReadMultiplier); }
  if (patch.cacheWriteMultiplier !== undefined) { sets.push('cache_write_multiplier = ?'); params.push(patch.cacheWriteMultiplier); }
  if (sets.length === 0) return;
  sets.push("source = 'manual-correction'");
  params.push(id);

  db.prepare(`UPDATE price_versions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

// --- Report ----------------------------------------------------------------

/** 'partial-usage' (review finding 2): exactly ONE of inputTokens/outputTokens
 *  is null while the other is a real number — e.g. an SSE stream aborted
 *  after `message_start` but before `message_delta` ever carried the output
 *  count. Distinct from 'unknown-usage' (BOTH null) because it is a
 *  different, more specific failure shape worth diagnosing separately, and
 *  distinct from 'priced' because computing a dollar figure from only HALF
 *  the real usage would silently coerce the missing side to 0 — exactly the
 *  anti-pattern migration 064's own doc comment forbids. Never priced,
 *  never summed into totals, always visibly counted. */
export type CostRowStatus = 'priced' | 'unknown-usage' | 'partial-usage' | 'unpriced';

export interface PricedCostRow {
  row: CostEventRow;
  status: CostRowStatus;
  /** Only set when status === 'priced'. */
  inputCostUsd: number | null;
  outputCostUsd: number | null;
  cacheReadCostUsd: number | null;
  cacheWriteCostUsd: number | null;
  totalCostUsd: number | null;
  /** AC-7 attribution bucket, re-derived every report run against the
   *  CURRENT workflow-state.json (see module doc — never persisted). */
  sliceBucket: 'slice' | 'unattributed' | 'ambiguous';
  sliceId: string | null;
  ambiguousCandidates: number | null;
  /** Named-gap flag (FEAT-476 accuracy-trap checklist, "long-context
   *  repricing" row) — never excludes the row from totals, just marks it as
   *  possibly under-priced. Threshold matches the 200k-token point at which
   *  Claude's long-context tier engages. */
  longContextWarning: boolean;
}

export interface CostReportBucket {
  usd: number;
  count: number;
}

export interface CostReport {
  rows: PricedCostRow[];
  totalUsd: number;
  bySlice: Record<string, CostReportBucket>;
  byModel: Record<string, CostReportBucket>;
  byAgentRole: Record<string, CostReportBucket>;
  cache: {
    readCostUsd: number;
    writeCostUsd: number;
    /** Fraction (0..1) of eligible input tokens served from cache, or
     *  `null` when no row in the window carries cache token data at all
     *  (undefined, not 0 — AC-8 pairs with the same "rate is undefined, not
     *  0" convention gatekeeper-log.ts already uses). */
    hitRatio: number | null;
  };
  truncatedCount: number;
  unknownUsageCount: number;
  /** Review finding 2: exactly one of input/output tokens absent — a
   *  distinct, honest bucket, never coerced to a $0-priced row. See
   *  `CostRowStatus`'s doc for the exact SSE-abort scenario this guards
   *  against. Excluded from totals, same as unknownUsageCount. */
  partialUsageCount: number;
  /** model id (or '(unknown model)') -> count of turns priced-less because
   *  no price_versions row matched. */
  unpricedModels: Record<string, number>;
  longContextWarningCount: number;
  /** Review finding 3: ALWAYS present, loud Phase 0 tier-gap disclosure —
   *  `cost_events` has no tier column, so every priced turn above assumes
   *  standard-tier billing. A turn actually billed at Anthropic's Priority
   *  Tier or either provider's Batch API is silently priced as standard in
   *  Phase 0 (accuracy-trap checklist gap, see migration 064 +
   *  `findPriceVersion`'s doc). Surfaced here so no report consumer can miss
   *  it by not reading source comments. */
  tierAssumptionNote: string;
}

export const TIER_ASSUMPTION_NOTE =
  'All events priced as standard tier — Priority Tier and Batch API usage are not detected in Phase 0 ' +
  '(cost_events has no tier column); a turn actually billed at a non-standard tier is priced as standard here.';

const LONG_CONTEXT_INPUT_TOKEN_THRESHOLD = 200_000;

export interface CostReportOpts {
  sinceMs?: number;
  /** Injectable for tests — defaults to reading
   *  `.claude/state/crew/workflow-state.json` under `repoRoot`. */
  workflowStateWindows?: WorkflowStateWindow[];
  repoRoot?: string;
  nowMs?: number;
}

function bucketKeyForSlice(row: PricedCostRow): string {
  if (row.sliceBucket === 'slice') return row.sliceId ?? 'unattributed';
  if (row.sliceBucket === 'ambiguous') return `ambiguous (${row.ambiguousCandidates ?? 0} candidates)`;
  return 'unattributed';
}

function bucketKeyForAgentRole(row: CostEventRow): string {
  if (row.agentRole) return row.agentRole;
  return row.source === 'proxy' ? 'role unknown (proxy-only capture)' : 'role unknown';
}

function addToBucket(map: Record<string, CostReportBucket>, key: string, usd: number): void {
  const existing = map[key] ?? { usd: 0, count: 0 };
  existing.usd += usd;
  existing.count += 1;
  map[key] = existing;
}

/**
 * The read-time derivation FEAT-476 AC-1/AC-2/AC-3/AC-4/AC-7/AC-8 describe.
 * Never mutates `cost_events`/`price_versions` — a pure query over whatever
 * is currently persisted, so re-running it after a `correctPriceVersion`
 * call (AC-2) or after `.claude/state/crew/workflow-state.json` has moved
 * on (AC-7's ambiguous/unattributed buckets shift as history rotates) is
 * always safe and always reflects current ground truth.
 */
export function costReport(db: DB, opts: CostReportOpts = {}): CostReport {
  const events = listCostEvents(db, { sinceMs: opts.sinceMs });
  const windows = opts.workflowStateWindows
    ?? readWorkflowStateWindows(opts.repoRoot);
  const nowMs = opts.nowMs ?? Date.now();

  const rows: PricedCostRow[] = [];
  let totalUsd = 0;
  const bySlice: Record<string, CostReportBucket> = {};
  const byModel: Record<string, CostReportBucket> = {};
  const byAgentRole: Record<string, CostReportBucket> = {};
  let cacheReadCostUsd = 0;
  let cacheWriteCostUsd = 0;
  let cacheReadTokenSum = 0;
  let nonCacheInputTokenSum = 0;
  let sawAnyCacheData = false;
  let truncatedCount = 0;
  let unknownUsageCount = 0;
  let partialUsageCount = 0;
  const unpricedModels: Record<string, number> = {};
  let longContextWarningCount = 0;

  for (const row of events) {
    if (row.truncated) truncatedCount++;

    const attribution = attributeSlice(windows, row.capturedAt, nowMs);
    const inputMissing = row.inputTokens === null;
    const outputMissing = row.outputTokens === null;
    // AC-3: usage entirely absent from the provider response.
    const isFullUnknownUsage = inputMissing && outputMissing;
    // Review finding 2: usage HALF-present — e.g. an SSE stream that got
    // message_start (input_tokens) but never a message_delta
    // (output_tokens stays null). Computing a dollar figure from only the
    // present side would silently treat the missing side as 0 tokens —
    // exactly the coercion migration 064's own doc comment forbids. A
    // distinct, honestly-counted, never-priced bucket.
    const isPartialUnknownUsage = !isFullUnknownUsage && (inputMissing || outputMissing);
    const longContextWarning = (row.inputTokens ?? 0) >= LONG_CONTEXT_INPUT_TOKEN_THRESHOLD;
    if (longContextWarning) longContextWarningCount++;

    if (isFullUnknownUsage) {
      unknownUsageCount++;
      rows.push({
        row, status: 'unknown-usage',
        inputCostUsd: null, outputCostUsd: null, cacheReadCostUsd: null, cacheWriteCostUsd: null, totalCostUsd: null,
        sliceBucket: attribution.bucket, sliceId: attribution.sliceId, ambiguousCandidates: attribution.candidates,
        longContextWarning,
      });
      continue;
    }

    if (isPartialUnknownUsage) {
      partialUsageCount++;
      rows.push({
        row, status: 'partial-usage',
        inputCostUsd: null, outputCostUsd: null, cacheReadCostUsd: null, cacheWriteCostUsd: null, totalCostUsd: null,
        sliceBucket: attribution.bucket, sliceId: attribution.sliceId, ambiguousCandidates: attribution.candidates,
        longContextWarning,
      });
      continue;
    }

    // Phase 0 tier gap (review finding 3): `tier` is deliberately omitted
    // here — it defaults to 'standard' inside findPriceVersion. cost_events
    // carries no tier column (the capture layer cannot detect Priority
    // Tier / Batch API usage), so this ALWAYS prices as standard tier. See
    // findPriceVersion's doc + CostReport.tierAssumptionNote (always
    // present in the report output, not just here in a source comment).
    const price = row.model ? findPriceVersion(db, { provider: row.provider, model: row.model, atMs: row.capturedAt }) : null;
    if (!price) {
      const modelKey = row.model ?? '(unknown model)';
      unpricedModels[modelKey] = (unpricedModels[modelKey] ?? 0) + 1;
      rows.push({
        row, status: 'unpriced',
        inputCostUsd: null, outputCostUsd: null, cacheReadCostUsd: null, cacheWriteCostUsd: null, totalCostUsd: null,
        sliceBucket: attribution.bucket, sliceId: attribution.sliceId, ambiguousCandidates: attribution.candidates,
        longContextWarning,
      });
      continue;
    }

    const nonCacheInput = row.inputTokens ?? 0;
    const output = row.outputTokens ?? 0;
    const cacheRead = row.cacheReadInputTokens ?? 0;
    const cacheWrite = row.cacheCreationInputTokens ?? 0;

    const inputCostUsd = nonCacheInput * price.inputRate;
    const outputCostUsd = output * price.outputRate;
    const cacheReadCost = cacheRead * price.inputRate * price.cacheReadMultiplier;
    const cacheWriteCost = cacheWrite * price.inputRate * price.cacheWriteMultiplier;
    const totalCostUsd = inputCostUsd + outputCostUsd + cacheReadCost + cacheWriteCost;

    totalUsd += totalCostUsd;
    cacheReadCostUsd += cacheReadCost;
    cacheWriteCostUsd += cacheWriteCost;

    if (row.cacheReadInputTokens !== null || row.cacheCreationInputTokens !== null) {
      sawAnyCacheData = true;
      cacheReadTokenSum += cacheRead;
      nonCacheInputTokenSum += nonCacheInput;
    }

    const priced: PricedCostRow = {
      row, status: 'priced',
      inputCostUsd, outputCostUsd, cacheReadCostUsd: cacheReadCost, cacheWriteCostUsd: cacheWriteCost, totalCostUsd,
      sliceBucket: attribution.bucket, sliceId: attribution.sliceId, ambiguousCandidates: attribution.candidates,
      longContextWarning,
    };
    rows.push(priced);

    addToBucket(bySlice, bucketKeyForSlice(priced), totalCostUsd);
    addToBucket(byModel, row.model ?? '(unknown model)', totalCostUsd);
    addToBucket(byAgentRole, bucketKeyForAgentRole(row), totalCostUsd);
  }

  return {
    rows,
    totalUsd,
    bySlice,
    byModel,
    byAgentRole,
    cache: {
      readCostUsd: cacheReadCostUsd,
      writeCostUsd: cacheWriteCostUsd,
      hitRatio: sawAnyCacheData && (cacheReadTokenSum + nonCacheInputTokenSum) > 0
        ? cacheReadTokenSum / (cacheReadTokenSum + nonCacheInputTokenSum)
        : null,
    },
    truncatedCount,
    unknownUsageCount,
    partialUsageCount,
    unpricedModels,
    longContextWarningCount,
    tierAssumptionNote: TIER_ASSUMPTION_NOTE,
  };
}
