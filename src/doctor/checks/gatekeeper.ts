import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { totalChunksEvaluated, gatekeeperSkipRate } from '../../storage/gatekeeper-log.js';
import { openProductionDbReadonly, SEVEN_DAYS_MS, MEANINGFUL_USAGE_THRESHOLD } from './shared.js';

// ─── Check: Ingest gatekeeper (FEAT-548) ─────────────────────────────────────

/**
 * Skip-rate canary for the pre-extraction ingest gatekeeper — FEAT-548 AC-5's
 * own acceptance bar, same "measure a RATE, never existence alone" discipline
 * `extraction-yield.ts`/`atom-triage.ts` document: a gate that skips almost
 * everything is broken, not efficient (canary-must-measure-rate-not-
 * existence — entity extraction was 87% broken for weeks behind a green
 * existence-only check before that lesson was learned — see #200). Unlike
 * `atom-triage.ts`'s dual-bound canary, this one is deliberately ONE-SIDED —
 * a near-zero skip rate just means the corpus is genuinely substantive (or
 * the gate hasn't run enough yet), not a sign of anything broken, since a
 * gate that rarely skips is doing exactly what a mostly-durable corpus should
 * produce.
 *
 * Gated behind MEANINGFUL_USAGE_THRESHOLD chunks evaluated in the window
 * (same floor `checkExtractionYield`/`checkAtomTriage` use) so a fresh/
 * low-activity install with too small a sample never trips the alarm. Silent
 * whenever `mode` is `'off'` (the shipped default) — nothing was ever
 * evaluated, nothing to judge. The alarm applies in BOTH `'dry-run'` and
 * `'enabled'` — a rogue/mistuned gate is exactly as worth catching during the
 * safe `'dry-run'` preview (the whole point of the measurement mode before
 * ever flipping to `'enabled'`) as it is once live.
 */
const SKIP_RATE_ALARM = 0.95;

export function checkGatekeeper(dataDir: string, mode: 'off' | 'dry-run' | 'enabled', encryptionEnabled: boolean): Check {
  return {
    name: 'Ingest gatekeeper',
    // 'full' — gatekeeper_run_log is a corpus-scale table (grows with every
    // gated distill job), same tier rationale checkAtomTriage documents.
    tier: 'full',
    async run(): Promise<CheckResult> {
      if (mode === 'off') {
        return { ok: true, message: "ingest gatekeeper: distill.gatekeeper.mode is 'off' (the shipped default) — nothing to check" };
      }

      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'ingest gatekeeper: no DB yet' };
      }

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;

        const evaluated7d = totalChunksEvaluated(db, since);
        if (evaluated7d < MEANINGFUL_USAGE_THRESHOLD) {
          return {
            ok: true,
            message:
              `ingest gatekeeper: ${evaluated7d} chunk(s) evaluated in last 7d — not enough distill activity yet to ` +
              `judge (below the ${MEANINGFUL_USAGE_THRESHOLD} floor)`,
          };
        }

        const rate = gatekeeperSkipRate(db, since);
        if (rate === null) {
          return { ok: true, message: `ingest gatekeeper: ${evaluated7d} chunk(s) evaluated in last 7d, rate undefined — nothing to judge` };
        }

        if (rate >= SKIP_RATE_ALARM) {
          const skippedWord = mode === 'enabled' ? 'SKIPPED (never reached extraction)' : 'flagged would-skip (dry-run preview, nothing actually skipped)';
          return {
            ok: false,
            message:
              `ingest gatekeeper: ${(rate * 100).toFixed(1)}% of chunks evaluated in the last 7d were ${skippedWord} ` +
              `(mode: '${mode}') — at or above the ${(SKIP_RATE_ALARM * 100).toFixed(0)}% alarm ceiling. A gate that ` +
              'skips almost everything is broken, not efficient — this can mean the gate model went rogue, a model ' +
              'swap regressed gate quality, or the gate is mis-scoped against genuinely substantive traffic.',
            fix:
              'Review recent gatekeeper_skips rows by hand (model/confidence) against the chunks they reference. If ' +
              "the skips look wrong, set distill.gatekeeper.mode: 'dry-run' or 'off' and re-review a false-skip sample " +
              'against the extraction-bench 55-fixture set (FEAT-548 AC-4) before re-enabling.',
          };
        }

        return {
          ok: true,
          message:
            `ingest gatekeeper: ${(rate * 100).toFixed(2)}% skip rate over last 7d (${evaluated7d} chunks evaluated, ` +
            `mode: '${mode}') — within expected bounds`,
        };
      } catch (err) {
        // The query itself failed — did NOT verify the gatekeeper is healthy
        // (same failure shape issue #200 was about: a canary that can report
        // green without having actually checked).
        return { ok: true, inconclusive: true, message: `ingest gatekeeper check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
