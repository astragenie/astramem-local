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

/** Stable hash across BOTH ingest paths for the SAME physical exchange
 *  (AC-6). Time-bucketed to 5s so the proxy's own capture timestamp and
 *  Claude Code's independently-stamped OTel timestamp for the identical
 *  exchange still collide — the two paths observe the same wall-clock
 *  event but stamp it at slightly different points in their own pipeline.
 *  Token counts and model/provider are the real content-identity signal;
 *  `null` fields are hashed as a literal sentinel (not skipped) so an
 *  "unknown usage" row never collides with a different exchange that
 *  happens to share provider/model/time-bucket. */
export function computeDedupKey(input: Pick<CostEventInput,
  'provider' | 'model' | 'capturedAtMs' | 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'
>): string {
  const TIME_BUCKET_MS = 5_000;
  const bucket = Math.floor(input.capturedAtMs / TIME_BUCKET_MS);
  const field = (v: number | null): string => (v === null ? 'null' : String(v));
  const basis = [
    input.provider,
    input.model ?? 'null',
    String(bucket),
    field(input.inputTokens),
    field(input.outputTokens),
    field(input.cacheReadInputTokens),
    field(input.cacheCreationInputTokens),
  ].join('|');
  return contentHash(basis);
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
  const existing = db
    .prepare('SELECT id, source FROM cost_events WHERE dedup_key = ?')
    .get(dedupKey) as { id: number; source: CostEventSource } | undefined;

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
    if (!best || candidate.model.length > best.model.length) best = candidate;
  }
  return best;
}

/**
 * Add a genuine NEW price version — a real provider price change effective
 * from `effectiveFrom` onward. Historical `cost_events` before that date
 * are provably unaffected (AC-2, second half): `findPriceVersion`'s window
 * filter simply never selects this new row for an older `atMs`.
 */
export function addPriceVersion(db: DB, row: Omit<PriceVersionRow, 'id' | 'createdAt' | 'source'>): number {
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

export type CostRowStatus = 'priced' | 'unknown-usage' | 'unpriced';

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
  /** model id (or '(unknown model)') -> count of turns priced-less because
   *  no price_versions row matched. */
  unpricedModels: Record<string, number>;
  longContextWarningCount: number;
}

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
  const unpricedModels: Record<string, number> = {};
  let longContextWarningCount = 0;

  for (const row of events) {
    if (row.truncated) truncatedCount++;

    const attribution = attributeSlice(windows, row.capturedAt, nowMs);
    const isUnknownUsage = row.inputTokens === null && row.outputTokens === null;
    const longContextWarning = (row.inputTokens ?? 0) >= LONG_CONTEXT_INPUT_TOKEN_THRESHOLD;
    if (longContextWarning) longContextWarningCount++;

    if (isUnknownUsage) {
      unknownUsageCount++;
      rows.push({
        row, status: 'unknown-usage',
        inputCostUsd: null, outputCostUsd: null, cacheReadCostUsd: null, cacheWriteCostUsd: null, totalCostUsd: null,
        sliceBucket: attribution.bucket, sliceId: attribution.sliceId, ambiguousCandidates: attribution.candidates,
        longContextWarning,
      });
      continue;
    }

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
    unpricedModels,
    longContextWarningCount,
  };
}
