import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { latestConsolidationJudgeRun } from '../../storage/consolidation-judge-log.js';
import { openProductionDbReadonly } from './shared.js';

// ─── Check: Consolidation judge telemetry (FEAT-482) ─────────────────────────

/**
 * Informational-only row (`ok: true` always — same "deliberate config choice,
 * never itself a WARN" precedent as `checkDurabilityGateMode`/
 * `checkExtractProfile`). Its whole job is making the contradiction judge's
 * real cost VISIBLE, because it cannot be CAPPED in dollars: both shipped LLM
 * providers (Ollama, codex-subscription) hardcode `usage.usd: 0` (see
 * "Budget cap vs codex-subscription" for the same blind spot on
 * distill/extraction), so `runConsolidation` bounds the judge sweep by call
 * count (`maxPerRun`) and wall-clock time (`maxWallClockMs`) instead
 * (src/consolidate/consolidate.ts, FEAT-482). This row surfaces what the most
 * recent run actually cost in those terms — call count and elapsed time —
 * reading `consolidation_judge_runs` (migration 030,
 * src/storage/consolidation-judge-log.ts), so an operator who later points
 * extraction at a genuinely metered provider has a real number to look at,
 * not a silent gate that can't see it.
 */
export function checkConsolidationJudgeTelemetry(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Consolidation judge',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'consolidation judge: no DB yet' };
      }

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const latest = latestConsolidationJudgeRun(db);

        if (!latest) {
          return {
            ok: true,
            message: 'consolidation judge: never run (contradictionDetection.mode has been off every run so far)',
          };
        }

        const elapsedS = (latest.elapsedMs / 1000).toFixed(1);
        const ageH = ((Date.now() - latest.createdAt) / 3_600_000).toFixed(1);
        const caps = latest.capReached
          ? ' — call-count cap (maxPerRun) reached'
          : latest.wallClockCapReached
            ? ' — wall-clock cap (maxWallClockMs) reached'
            : '';

        // issue #190/#200-shaped check: judgeCalls alone only proves the
        // judge was INVOKED, not that it ever produced a real verdict — a
        // systemically broken provider (wrong model, broken JSON mode,
        // network flakiness) makes every call fall back to 'unrelated' and
        // would otherwise look identical to "genuinely no contradictions
        // found". Flag the all-fallback case explicitly.
        if (latest.judgeCalls > 0 && latest.judgeErrors >= latest.judgeCalls) {
          return {
            ok: false,
            message:
              `consolidation judge: last run ${ageH}h ago (mode: ${latest.mode}) made ${latest.judgeCalls} ` +
              `judge call(s) but ALL of them fell back to 'unrelated' due to errors — the judge is not ` +
              `actually classifying anything; contradiction detection ran blind this pass.`,
            fix: 'Check the configured llm.extraction provider is reachable and returns valid JSON — see contradiction-judge.ts server logs for the specific parse/call failures.',
          };
        }

        const errorNote = latest.judgeErrors > 0 ? `, ${latest.judgeErrors} fell back on error` : '';
        return {
          ok: true,
          message:
            `consolidation judge: last run ${ageH}h ago (mode: ${latest.mode}) — ` +
            `${latest.judgeCalls} judge call(s)${errorNote}, ${elapsedS}s elapsed${caps}`,
        };
      } catch (err) {
        // The query itself failed — did NOT verify judge telemetry is healthy.
        return { ok: true, inconclusive: true, message: `consolidation judge check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
