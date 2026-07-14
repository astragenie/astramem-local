import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { zeroYieldCount, zeroYieldRate, eligibleRunCount } from '../../storage/extraction-yield-log.js';
import { openProductionDbReadonly, SEVEN_DAYS_MS, MEANINGFUL_USAGE_THRESHOLD } from './shared.js';

// ─── Check: Extraction yield (ADR-015 headline finding) ─────────────────────

/**
 * Zero-atom-yield canary — closes the ADR-015 headline finding: a
 * well-formed `{"atoms":[]}` extraction completes as SUCCESS at every other
 * layer (not the Zod gate, not the job queue, not the poison counter, which
 * only increments on FAILURE). A broken model that returns an empty atoms
 * array and a genuinely empty transcript are indistinguishable anywhere
 * else in the pipeline — this is the only place that distinction becomes
 * observable, by measuring the zero-yield RATE over a recent window rather
 * than existence of any single row (canary-must-measure-rate-not-existence:
 * entity extraction was 87% broken for weeks behind a green existence-only
 * check before that lesson was learned — see #200).
 *
 * Mirrors checkEntityRelations' gating exactly: silent until
 * MEANINGFUL_USAGE_THRESHOLD eligible runs (chunks_in > 0) have accumulated
 * in the window — a brand-new or low-activity install legitimately has too
 * small a sample to judge a rate from, and must not warn. The floor and the
 * WARN message denominator both count ELIGIBLE runs only (`eligibleRunCount`,
 * chunks_in > 0) — zero-chunk rows (empty/redacted transcripts that never
 * attempted a real extraction) do not count toward either, so they can't
 * inflate the "enough activity to judge" floor while the true eligible
 * sample stays small (#300 review finding).
 *
 * A run with zero atoms out is not automatically a bug — a transcript that
 * genuinely carries nothing memorable is a valid zero. This check does not
 * attempt to tell that case apart from a broken model (that judgment needs a
 * human looking at real transcripts, per the module's own doc caution); it
 * only makes the RATE visible instead of invisible, per the teardown's
 * finding that this class of failure was never even observable before.
 */
const ZERO_YIELD_RATE_ALARM = 0.5;

export function checkExtractionYield(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Extraction yield',
    // 'full' — extraction_yield is a corpus-scale table (grows with every
    // distill job), and this check's window queries are not covered by an
    // index beyond created_at — same tier rationale as checkEntityRelations.
    tier: 'full',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'extraction yield: no DB yet' };
      }

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;

        const eligible7d = eligibleRunCount(db, since);
        if (eligible7d < MEANINGFUL_USAGE_THRESHOLD) {
          return {
            ok: true,
            message:
              `extraction yield: ${eligible7d} eligible run(s) (chunks_in > 0) in last 7d — not enough distill ` +
              `activity yet to judge (below the ${MEANINGFUL_USAGE_THRESHOLD} floor)`,
          };
        }

        const rate = zeroYieldRate(db, since);
        if (rate === null) {
          // Unreachable in normal operation: eligible7d >= MEANINGFUL_USAGE_THRESHOLD (> 0)
          // already guarantees zeroYieldRate has a non-null denominator. Kept as a defensive
          // fallback in case the two reads race against concurrent writes.
          return {
            ok: true,
            message: `extraction yield: ${eligible7d} eligible run(s) in last 7d, none had any input chunks — nothing to judge`,
          };
        }

        const zeroCount = zeroYieldCount(db, since);
        if (rate < ZERO_YIELD_RATE_ALARM) {
          return {
            ok: true,
            message:
              `extraction yield: ${(rate * 100).toFixed(1)}% zero-atom rate over last 7d ` +
              `(${zeroCount}/${eligible7d} eligible runs) — below the ${(ZERO_YIELD_RATE_ALARM * 100).toFixed(0)}% alarm floor`,
          };
        }

        return {
          ok: false,
          message:
            `extraction yield: ${(rate * 100).toFixed(1)}% of runs in the last 7d produced ZERO atoms ` +
            `(${zeroCount}/${eligible7d} eligible runs) — at or above the ${(ZERO_YIELD_RATE_ALARM * 100).toFixed(0)}% alarm ` +
            `floor. This is indistinguishable from a healthy install at every other layer (no Zod failure, no ` +
            `job failure, no poison count) — it can mean the extraction model is broken (empty/truncated ` +
            `output) or that recent transcripts genuinely carried nothing memorable.`,
          fix:
            'Sample a few recent transcripts by hand to judge whether the zero-atom runs are genuine. If not, ' +
            'check the extraction model/provider (num_ctx truncation and dropped temperature have both silently ' +
            'broken extraction before — see CLAUDE.md) or run `astramem-local doctor --full` for the LLM chat probe.',
        };
      } catch (err) {
        // The query itself failed — did NOT verify extraction yield is
        // healthy (same failure shape issue #200 was about: a canary that
        // can report green without having actually checked).
        return { ok: true, inconclusive: true, message: `extraction yield check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
