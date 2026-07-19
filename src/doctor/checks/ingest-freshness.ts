import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { eligibleRunCount, producedAtomsCount } from '../../storage/extraction-yield-log.js';
import { openProductionDbReadonly, SEVEN_DAYS_MS, MEANINGFUL_USAGE_THRESHOLD } from './shared.js';

// ─── Check: Ingest freshness (FEAT-483 SLICE-2) ──────────────────────────────

/**
 * Live-daemon complement to the "Extraction yield" canary (extraction-yield.ts).
 * That check measures a zero-atom-yield RATE over a rolling 7-day window --
 * good for catching a slow-burn degradation, but it can take up to a week to
 * notice a pipeline that died five minutes after boot. This check adds a
 * short-SLA freshness signal: is ingest -> memory flow currently alive on
 * THIS running daemon, right now?
 *
 * Uses the same `extraction_yield` table (migration 042) as a marker-based
 * liveness probe rather than querying `memories` directly for the most-recent
 * row's age -- `memories` has no index with `created_at` as a leading column
 * (every existing index leads with `repo`/`type`/`agent`/`archived` etc., see
 * migrations 001/017/019), so a bare `MAX(created_at)` there would be an
 * unindexed scan of a corpus-scale table, exactly the #226 failure shape
 * CLAUDE.md warns checkMemoryHealth/checkEntityNameQuality already hit.
 * `extraction_yield` is a lean one-row-per-distill-job counter table with
 * `idx_extraction_yield_created` already covering `created_at` -- reusing it
 * keeps every query here an index-range read, not a new scan surface.
 *
 * Distinguishes the two states the AC calls out:
 *   - no ingest activity in the SLA window -> quiet, not alarming (nothing to
 *     distill right now).
 *   - ingest activity in the SLA window but zero of those jobs produced any
 *     atoms -> the live poisoning-class stall: the pipeline is receiving
 *     transcripts and silently failing to turn any of them into memories.
 *
 * Gated behind the SAME `MEANINGFUL_USAGE_THRESHOLD` floor extraction-yield.ts
 * uses, applied to the same 7-day lookback -- a brand-new or low-activity
 * install has too small a history to trust a 5-minute liveness judgment from
 * (a single slow distill job taking a few minutes longer than usual must not
 * read as "stalled" on day one). Once that floor is crossed, the SLA-window
 * check below is what actually gates the RED verdict.
 */
const INGEST_FRESHNESS_SLA_MS = 5 * 60 * 1000; // 5 minutes, per AC

export function checkIngestFreshness(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Ingest freshness',
    // 'cheap' -- every query here is `extraction_yield WHERE created_at >= ?`,
    // the identical index-range shape `eligibleRunCount`/`zeroYieldRate` already
    // use and that extraction-yield.ts documents (with an EXPLAIN QUERY PLAN
    // citation) as resolving via `idx_extraction_yield_created`, not a table
    // scan. No new query shape is introduced by this check.
    tier: 'cheap',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'ingest freshness: no DB yet' };
      }

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const now = Date.now();

        const eligible7d = eligibleRunCount(db, now - SEVEN_DAYS_MS);
        if (eligible7d < MEANINGFUL_USAGE_THRESHOLD) {
          return {
            ok: true,
            message:
              `ingest freshness: ${eligible7d} eligible run(s) (chunks_in > 0) in last 7d — not enough distill ` +
              `activity yet to judge (below the ${MEANINGFUL_USAGE_THRESHOLD} floor)`,
          };
        }

        const slaWindowStart = now - INGEST_FRESHNESS_SLA_MS;
        const slaMinutes = Math.round(INGEST_FRESHNESS_SLA_MS / 60_000);
        const recentIngest = eligibleRunCount(db, slaWindowStart);
        if (recentIngest === 0) {
          return {
            ok: true,
            message: `ingest freshness: no ingest activity in the last ${slaMinutes} min — nothing to distill`,
          };
        }

        const recentYield = producedAtomsCount(db, slaWindowStart);
        if (recentYield === 0) {
          return {
            ok: false,
            message:
              `ingest freshness: ${recentIngest} distill job(s) with chunks in the last ${slaMinutes} min, but ` +
              `ZERO produced any memories — the pipeline appears stalled (ingest is flowing, nothing is coming ` +
              `out). This install has ${eligible7d} eligible run(s) over the last 7d, so this is not a low-` +
              `activity install seeing its first quiet minute.`,
            fix:
              'Check the extraction model/provider is actually responding (num_ctx truncation and dropped ' +
              'temperature have both silently broken extraction before — see CLAUDE.md); run ' +
              '`astramem-local doctor --full` for the LLM chat probe, or tail the daemon log for a stuck ' +
              'distill job.',
          };
        }

        return {
          ok: true,
          message:
            `ingest freshness: ${recentYield}/${recentIngest} distill job(s) in the last ${slaMinutes} min ` +
            `produced at least one memory — pipeline flowing normally`,
        };
      } catch (err) {
        // The query itself failed — did NOT verify the pipeline is flowing,
        // same non-conflation-with-healthy discipline every other check here
        // follows (ADR-015).
        return { ok: true, inconclusive: true, message: `ingest freshness check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
