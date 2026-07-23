import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { proxyCorrelationSummary } from '../../storage/proxy-turn-correlation.js';
import { openProductionDbReadonly, MEANINGFUL_USAGE_THRESHOLD } from './shared.js';

// ─── Check: Proxy-turn correlation (FEAT-477) ───────────────────────────────

/**
 * Informational sibling to "Usefulness feedback loop" — surfaces how much of
 * the served-atom population `src/storage/proxy-turn-correlation.ts`'s
 * SECOND implicit signal (proxy-captured-turn text correlation) has managed
 * to corroborate, all-time. Deliberately modeled on `checkUsefulness`
 * (src/doctor/checks/usefulness.ts), NOT on `checkUsefulnessFeedbackLoop` or
 * `checkExtractionYield`: this is a noisy, best-effort text-overlap
 * heuristic — an agent can genuinely USE a served memory's information
 * without ever repeating its exact wording in a later captured turn, so a
 * low or zero correlation rate is not evidence of a bug the way a
 * never-fired EXPLICIT channel or a high zero-yield extraction rate is.
 * This check therefore NEVER returns `ok: false`; it only makes the rate
 * visible (rate-not-existence, same canary precedent as
 * `checkExtractionYield`), so an operator can judge for themselves rather
 * than the mechanism being invisible.
 *
 * FEAT-477 AC — "handle proxy off gracefully, never a false signal":
 * `proxyCorrelationSummary` checks for `capture_source = 'proxy'` activity
 * FIRST and reports `proxyActivityAbsent` explicitly when there is none.
 * This check surfaces that as its own calm, distinct message rather than
 * folding it into a printed 0% rate — a 0% rate reads as "measured and
 * found lacking"; "no proxy activity yet" reads as "nothing to measure".
 */
export function checkProxyTurnCorrelation(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Proxy-turn correlation',
    // 'full' — same tier rationale as checkUsefulnessFeedbackLoop's sibling
    // queries: no partial index covers the 'memory_corrected'/'recall_used'
    // family/basis predicates (small volume relative to recall_served, so
    // accepted unindexed rather than adding a migration for it), plus this
    // check's own unconditional `SELECT 1 FROM memories WHERE
    // capture_source = 'proxy'` existence probe.
    tier: 'full',
    async run(): Promise<CheckResult> {
      let db: DB | undefined;
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        if (!existsSync(dbPath)) {
          return { ok: true, message: 'proxy-turn correlation: no DB yet' };
        }
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const summary = proxyCorrelationSummary(db);

        if (summary.proxyActivityAbsent) {
          return {
            ok: true,
            message:
              'proxy-turn correlation: no proxy-captured activity yet (proxy off, or on but nothing captured) ' +
              '— nothing to correlate against',
          };
        }

        if (summary.servedDistinct < MEANINGFUL_USAGE_THRESHOLD) {
          return {
            ok: true,
            message:
              `proxy-turn correlation: ${summary.servedDistinct} distinct atom(s) served, all-time — not enough ` +
              `activity yet to judge (below the ${MEANINGFUL_USAGE_THRESHOLD} floor)`,
          };
        }

        const rate = summary.proxyCorrelatedDistinct / summary.servedDistinct;
        return {
          ok: true,
          message:
            `proxy-turn correlation: ${(rate * 100).toFixed(1)}% (${summary.proxyCorrelatedDistinct}/` +
            `${summary.servedDistinct} distinct served atoms, all-time) corroborated by a later proxy-captured ` +
            `turn — a noisy heuristic lower bound on real usage, not a strict rate (an agent can use a memory ` +
            `without ever repeating its wording).`,
        };
      } catch (err) {
        // The query itself failed — did NOT verify anything, must not
        // render/count the same as a check that did (same ADR-015 posture
        // every other check in this directory follows).
        return { ok: true, inconclusive: true, message: `proxy-turn correlation check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
