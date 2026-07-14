import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { totalEvidenceGuardDrops } from '../../storage/evidence-guard-log.js';
import { openProductionDbReadonly, SEVEN_DAYS_MS, MEANINGFUL_USAGE_THRESHOLD } from './shared.js';

// ─── Check: Evidence provenance (FEAT-485) ───────────────────────────────────

/**
 * Minimum acceptable fraction of recent lesson/decision memories carrying a
 * non-empty `evidence` excerpt. Set deliberately low — 2026-07-13 live-store
 * measurement found the PRE-FEAT-485 baseline near 0% (model rarely complied
 * with an optional field) and even a real qwen3:8b run against the
 * extraction-bench fixtures with the requirement enforced does not yet
 * reliably clear a high bar (see scripts/eval/extraction-bench/
 * measure-evidence.mts output referenced from FEAT-485's slice notes) — a
 * floor tuned to "was ever properly measured above zero" rather than an
 * aspirational target, to avoid a permanent false-positive WARN on every
 * install the way an over-tuned floor caused for the Auto-capture canary
 * (2026-07-12).
 */
const EVIDENCE_POPULATION_FLOOR = 0.3;

/**
 * Live-store audit 2026-07-13: 1/10 sampled memories carried an `evidence`
 * excerpt at all; entity extraction (a comparably-optional field) worked
 * fine (12 entities across 4 memories). Mirrors `checkEntityRelations`'s
 * shape exactly — same MEANINGFUL_USAGE_THRESHOLD gate, same 7-day window,
 * same "split by guard-drop counter" idiom — one level up: a whole
 * lesson/decision atom either has evidence or (post-FEAT-485) never reaches
 * `memories` at all.
 *
 * `ok: false` (WARN) below the population floor is split two ways using
 * `evidence_guard_drops` (migration 030, written by requireEvidenceForRichTypes
 * in src/distill/stages/05-extract.ts):
 *   - drops > 0 in the window: the model DOES emit lesson/decision atoms, but
 *     omits evidence often enough that the FEAT-485 guard is actively
 *     dropping them — a real prompt-compliance gap, not silence.
 *   - drops == 0: either the low-evidence rows predate FEAT-485 (the
 *     requirement wasn't enforced yet when they were created) or they were
 *     never distill-sourced at all (e.g. the `remember`/memory-tool direct-
 *     insert paths, which have no transcript context to quote from by
 *     design — ADR-009 "born-at-scope") — not a pipeline failure.
 */
export function checkEvidenceProvenance(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Evidence provenance',
    // 'full' — same unindexed corpus-scale scan over `memories` that
    // checkEntityRelations is on this tier for (see its own comment).
    tier: 'full',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'evidence provenance: no DB yet' };
      }

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;

        const richTypeRow = db
          .prepare(`SELECT COUNT(*) AS n FROM memories WHERE created_at >= ? AND type IN ('lesson', 'decision')`)
          .get(since) as { n: number };
        const richTypeRecent = richTypeRow.n;

        if (richTypeRecent < MEANINGFUL_USAGE_THRESHOLD) {
          return {
            ok: true,
            message:
              `evidence provenance: only ${richTypeRecent} lesson/decision memories in last 7d, below the ` +
              `${MEANINGFUL_USAGE_THRESHOLD} floor — not enough activity to judge yet`,
          };
        }

        const withEvidenceRow = db
          .prepare(
            `SELECT COUNT(*) AS n FROM memories WHERE created_at >= ? AND type IN ('lesson', 'decision') ` +
              `AND evidence IS NOT NULL AND TRIM(evidence) != ''`,
          )
          .get(since) as { n: number };
        const rate = withEvidenceRow.n / richTypeRecent;
        const dropsRecent = totalEvidenceGuardDrops(db, since);

        const pct = (rate * 100).toFixed(1);
        if (rate >= EVIDENCE_POPULATION_FLOOR) {
          return {
            ok: true,
            message: `evidence provenance: ${withEvidenceRow.n}/${richTypeRecent} (${pct}%) of recent lesson/decision memories carry evidence`,
          };
        }

        return {
          ok: false,
          message:
            `evidence provenance: only ${withEvidenceRow.n}/${richTypeRecent} (${pct}%) of recent lesson/decision ` +
            `memories carry an evidence excerpt (floor ${(EVIDENCE_POPULATION_FLOOR * 100).toFixed(0)}%), ` +
            `${dropsRecent} atom(s) dropped by the evidence guard in the same window — ` +
            (dropsRecent > 0
              ? 'the model IS emitting lesson/decision atoms without evidence and the guard is actively dropping them.'
              : 'these rows predate the FEAT-485 evidence requirement, or came from a non-distill path ' +
                '(remember()/memory-tool direct-insert has no transcript to quote from by design).') +
            ')',
          fix:
            'Check debug logs for "atom dropped — evidence is required" lines (src/distill/stages/05-extract.ts) ' +
            'to confirm the guard is firing, or wait for older pre-FEAT-485 rows to age out of the 7-day window.',
        };
      } catch (err) {
        // Informational failure mode — never fail doctor over a metric query
        // error, consistent with the other read-only DB checks in this
        // registry (see checkEntityRelations).
        return { ok: true, inconclusive: true, message: `evidence provenance check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
