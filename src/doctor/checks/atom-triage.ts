import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { totalAtomsTriaged, triageDropRate } from '../../storage/triage-guard-log.js';
import { openProductionDbReadonly, SEVEN_DAYS_MS, MEANINGFUL_USAGE_THRESHOLD } from './shared.js';

// ─── Check: Atom triage (FEAT-533) ───────────────────────────────────────────

/**
 * Drop-rate canary for the LLM atom-triage tier — alarms on BOTH extremes
 * per FEAT-533's acceptance criteria, the same "measure a RATE, never
 * existence alone" discipline `extraction-yield.ts` documents:
 *
 *   - near-ZERO drop rate while `mode: 'enabled'` is the built-wired-
 *     never-invoked class (canary-must-measure-rate-not-existence: entity
 *     extraction was 87% broken for weeks behind a green existence-only
 *     check before that lesson was learned — see #200). A judge that is
 *     wired but never actually flags anything looks IDENTICAL to a
 *     genuinely clean corpus without this canary.
 *   - a HIGH drop rate (judge gone rogue, or a model swap regressed
 *     triage quality) is the opposite failure — real atoms silently never
 *     reaching persistence.
 *
 * Gated behind MEANINGFUL_USAGE_THRESHOLD atoms triaged in the window (same
 * floor `checkExtractionYield` uses) so a fresh/low-activity install with
 * too small a sample never trips either bound. Silent whenever `mode` is
 * `'off'` (the shipped default) — nothing was ever triaged, nothing to
 * judge. The HIGH-rate bound applies in BOTH `'dry-run'` and `'enabled'` —
 * a rogue/regressed judge is exactly as worth catching during the safe
 * `'dry-run'` preview (the whole point of the review gate before ever
 * flipping to `'enabled'`) as it is once live. The near-zero-rate bound is
 * scoped to `'enabled'` ONLY — a near-zero `'dry-run'` rate just means the
 * corpus is clean or the model hasn't run enough yet, not
 * built-wired-never-invoked, since `'dry-run'` never gates persistence in
 * the first place.
 */
const NEAR_ZERO_RATE_FLOOR = 0.02;
const HIGH_RATE_ALARM = 0.5;

export function checkAtomTriage(dataDir: string, mode: 'off' | 'dry-run' | 'enabled' | 'repair-only', encryptionEnabled: boolean): Check {
  return {
    name: 'Atom triage',
    // 'full' — triage_run_log is a corpus-scale table (grows with every
    // triaged distill job), same tier rationale as checkExtractionYield.
    tier: 'full',
    async run(): Promise<CheckResult> {
      if (mode === 'off') {
        return { ok: true, message: "atom triage: distill.atomTriage.mode is 'off' (the shipped default) — nothing to check" };
      }

      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'atom triage: no DB yet' };
      }

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;

        const triaged7d = totalAtomsTriaged(db, since);
        if (triaged7d < MEANINGFUL_USAGE_THRESHOLD) {
          return {
            ok: true,
            message:
              `atom triage: ${triaged7d} atom(s) triaged in last 7d — not enough distill activity yet to judge ` +
              `(below the ${MEANINGFUL_USAGE_THRESHOLD} floor)`,
          };
        }

        const rate = triageDropRate(db, since);
        if (rate === null) {
          return { ok: true, message: `atom triage: ${triaged7d} atom(s) triaged in last 7d, rate undefined — nothing to judge` };
        }

        if (rate >= HIGH_RATE_ALARM) {
          const droppedWord = mode === 'enabled' ? 'DROPPED' : 'flagged for drop (dry-run preview, nothing actually dropped)';
          return {
            ok: false,
            message:
              `atom triage: ${(rate * 100).toFixed(1)}% of atoms triaged in the last 7d were ${droppedWord} ` +
              `(mode: '${mode}') — at or above the ${(HIGH_RATE_ALARM * 100).toFixed(0)}% alarm ceiling. This can ` +
              'mean the triage judge went rogue or a model swap regressed triage quality — real atoms may be (or, ' +
              'if this flips to \'enabled\', would be) silently failing to persist.',
            fix:
              'Review recent triage_guard_drops rows by hand (reason/model/confidence) against the atoms they ' +
              "reference. If the drops look wrong, set distill.atomTriage.mode: 'dry-run' or 'off' and re-review " +
              'the FEAT-533 dry-run agreement sample before re-enabling.',
          };
        }

        if (mode === 'enabled' && rate < NEAR_ZERO_RATE_FLOOR) {
          return {
            ok: false,
            message:
              `atom triage: ${(rate * 100).toFixed(2)}% drop rate over the last 7d (${triaged7d} atoms triaged) while ` +
              "mode is 'enabled' — near-zero despite real triage volume is indistinguishable from a wired-but-" +
              "never-invoked tier (canary-must-measure-rate-not-existence). If the corpus is genuinely clean this " +
              'is a false alarm; verify triage_guard_drops has non-zero rows before dismissing it.',
            fix:
              'Sample a few recent atoms by hand to confirm the triage judge is actually being called and ' +
              'returning varied verdicts (check triage_guard_drops for any rows in the window). If it is silently ' +
              'always returning \'keep\' (or failing open every call), check the triage provider/model config and ' +
              'run `astramem-local doctor --full` for the LLM chat probe.',
          };
        }

        return {
          ok: true,
          message:
            `atom triage: ${(rate * 100).toFixed(2)}% drop rate over last 7d (${triaged7d} atoms triaged, mode: '${mode}') ` +
            '— within expected bounds',
        };
      } catch (err) {
        // The query itself failed — did NOT verify atom triage is healthy
        // (same failure shape issue #200 was about: a canary that can
        // report green without having actually checked).
        return { ok: true, inconclusive: true, message: `atom triage check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
