import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { buildMemoryHealthFull, distillSessionStats } from '../../server/queries/memory-health.js';
import { openProductionDbReadonly, MEANINGFUL_USAGE_THRESHOLD, POISON_RATE_ALARM } from './shared.js';

// ─── Check: Memory health score (FEAT-444) ────────────────────────────────────

/**
 * FEAT-444 AC-1: memory-health row. Shape is `CheckResult`
 * (src/doctor/types.ts) — the runner (src/doctor/runner.ts's
 * `CheckResultWithName`) adds the `name` field to every check's result, this
 * one included, exactly like every other check here (design-review
 * correction: the FEAT's original AC-1 text cited `CheckResultWithName` as
 * living in types.ts; it actually lives in runner.ts — this check returns
 * plain `CheckResult` like all the others and lets `runChecks()` do the
 * wrapping, same as every check above).
 *
 * Uses buildMemoryHealthFull() (server/queries/memory-health.ts) — the
 * doctor/CLI tier that includes the byType/byScope + staleness breakdown on
 * top of the /health cheap subset. Read-only: no INSERT/UPDATE/DELETE
 * against memories, memory_events, or consolidation_proposals (AC-1/AC-3).
 * Never fails doctor over a metric query error — informational, like the
 * "Recall usefulness" check.
 */
export function checkMemoryHealth(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Memory health',
    async run(): Promise<CheckResult> {
      let db: DB | undefined;
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        if (!existsSync(dbPath)) {
          return { ok: true, message: 'memory health: no DB yet (0 memories — clean slate)' };
        }
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const report = buildMemoryHealthFull(db);
        const distill = distillSessionStats(db);

        // ADR-015 rule 6/2: check the FAILURE RATE before the "0 active =
        // quiet week" short-circuit below. A pipeline that poisons every
        // session never produces an active memory — gating this behind
        // activeCount > 0 would make the exact failure this branch exists
        // to catch report as "no data yet" instead of red. This is the
        // fix for the counterexample ADR-015 names by name: checkMemoryHealth
        // previously had exactly one return path, {ok: true}.
        if (
          distill.terminal >= MEANINGFUL_USAGE_THRESHOLD &&
          distill.poisonRate !== null &&
          distill.poisonRate >= POISON_RATE_ALARM
        ) {
          return {
            ok: false,
            message:
              `memory health: ${distill.poison} of ${distill.terminal} terminal distill sessions ` +
              `(${(distill.poisonRate * 100).toFixed(1)}%) permanently poisoned — at/above the ` +
              `${(POISON_RATE_ALARM * 100).toFixed(0)}% alarm floor. A well-formed but broken ` +
              `extraction pipeline looks identical to a run of genuinely bad transcripts without ` +
              `this counter.`,
            fix:
              'Run `astramem-local doctor` for the LLM chat probe result and `astramem-local queue` to ' +
              'inspect poisoned sessions — a broken model/config produces this shape, not bad transcripts alone.',
          };
        }

        if (report.activeCount === 0) {
          return { ok: true, message: 'memory health: no data yet (0 active memories)' };
        }

        const coverageStr = report.usefulness.coverageRate === null
          ? 'n/a' : `${(report.usefulness.coverageRate * 100).toFixed(1)}%`;
        const correctionStr = report.corrections.rate === null
          ? 'n/a' : `${(report.corrections.rate * 100).toFixed(1)}%`;
        const staleTop = (report.staleness ?? [])
          .map(b => `${b.label}: ${b.count}`)
          .join(', ');

        return {
          ok: true,
          message:
            `memory health: ${report.activeCount} active / ${report.archivedCount} archived — ` +
            `usefulness coverage ${coverageStr}, correction rate ${correctionStr}, ` +
            `${report.poisonDistillSessions} poison-distill session(s) (${distill.poison}/${distill.terminal} ` +
            `terminal), staleness [${staleTop}]`,
        };
      } catch (err) {
        // The query itself failed — did not verify memory health.
        return { ok: true, inconclusive: true, message: `Memory health check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
