import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { feedbackLoopSummary } from '../../storage/usefulness.js';
import { buildMemoryHealthCheap } from '../../server/queries/memory-health.js';
import { openProductionDbReadonly, MEANINGFUL_USAGE_THRESHOLD } from './shared.js';

// ─── Check: Usefulness feedback loop canary (2026-07-12 "never fired") ──────

/**
 * WARNs when the ADR-010 usefulness feedback loop has demonstrably NEVER
 * received a POSITIVE signal despite meaningful daemon activity — the bug
 * found live in production 2026-07-12: GET /profile returned 30 entries,
 * every single one pinned at the Laplace prior 0.5 (0 recall_used events,
 * ever). The mechanism itself is sound (see tests/e2e/usefulness-feedback-
 * loop.e2e.test.ts — submit_feedback/mark_memory_used, invalidate_memory/
 * supersede_memory, and usefulnessScores() all work correctly when actually
 * invoked); this check exists because CI cannot catch "wired but nobody
 * calls it" — only live usage data can, and only doctor sees live usage data.
 *
 * issue #190 (2026-07-13): the ORIGINAL version of this check treated
 * `usedDistinct > 0 || correctedDistinct > 0` as "the loop is alive" — which
 * a live daemon satisfied with `(0 used, 854 corrected)` and reported GREEN.
 * Every one of those 854 corrections turned out to be consolidate.ts's own
 * auto-merge superseding its own near-duplicates (`correctionSource:
 * 'consolidation_auto'`, see memory-events.ts) — the system deduplicating
 * itself, not a human or agent saying "this was wrong". A loop that can only
 * ever demote (corrected keeps incrementing) and never promote (used stays
 * frozen at 0) is a one-way punishment term wearing a learning label, and the
 * canary that exists specifically to catch "built, wired, never invoked" was
 * itself fooled by exactly that pattern. Fix: `hasPositiveSignal` below is
 * `usedDistinct > 0` ALONE — corrections, of any source, never count as
 * evidence the loop is alive. correctedDistinct is still surfaced (split by
 * source) for visibility, but no longer gates ok/warn.
 *
 * Reads ALL-TIME totals (feedbackLoopSummary — no sinceMs window), because
 * "has this ever happened even once" is a different question than "what's
 * the 7d rate" (that's checkUsefulness, which stays purely informational).
 * Gated on the same MEANINGFUL_USAGE_THRESHOLD (20) floor checkAutoCapture
 * uses, applied to BOTH active memory count AND distinct atoms actually
 * served from a recall/search surface — a brand-new install, or one whose
 * owner has never recalled anything yet, legitimately has zero feedback and
 * must not warn.
 *
 * Uses buildMemoryHealthCheap() (not ...Full()) — this check only ever reads
 * report.activeCount, and the cheap tier already returns that via an
 * index-backed COUNT(*) (countActiveAndArchived). The full tier's extra
 * byType/byScope group-bys and staleness distribution are O(N) scans this
 * check never uses; checkMemoryHealth already pays that cost once per doctor
 * run for its own reporting, so calling ...Full() here would be a second,
 * redundant full-tier computation for one integer.
 */
export function checkUsefulnessFeedbackLoop(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Usefulness feedback loop',
    // 'full', NOT 'cheap' — independently found during the #226 follow-up
    // audit alongside the two CONFIRMED findings (checkMemoryHealth,
    // checkEntityNameQuality): feedbackLoopSummary() (src/storage/
    // usefulness.ts) computes correctedDistinct/correctedConsolidationDistinct/
    // correctedExternalDistinct/correctedUnknownDistinct via four
    // `event_type = 'usefulness' AND family = 'memory_corrected'` queries
    // with NO covering index — that function's own doc comment says so
    // explicitly ("no partial index covers memory_corrected... that query
    // still scans... accepted unindexed rather than adding a migration for
    // it"), on the reasoning that doctor's canary was operator-invoked. That
    // reasoning stopped holding the moment #226 put this check on a
    // 15-minute unattended schedule: memory_events grows ~1:1 with every
    // recall/search call (one 'recall_served' row per returned atom, see
    // migration 019's own measurement: 21ms -> 1179ms p50 from 1k -> 100k
    // rows for the SAME shape of unindexed query). buildMemoryHealthCheap()
    // (the other half of this check) is genuinely index-backed and would be
    // fine alone — it's feedbackLoopSummary() that forces this to 'full'.
    tier: 'full',
    async run(): Promise<CheckResult> {
      let db: DB | undefined;
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        if (!existsSync(dbPath)) {
          return { ok: true, message: 'usefulness feedback loop: no DB yet' };
        }
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const report = buildMemoryHealthCheap(db);
        const summary = feedbackLoopSummary(db);

        // issue #190 AC-1: corrections — of ANY source — are not positive
        // signal. Only usedDistinct means the loop is actually learning.
        const hasPositiveSignal = summary.usedDistinct > 0;
        const meaningfulUsage =
          report.activeCount >= MEANINGFUL_USAGE_THRESHOLD &&
          summary.servedDistinct >= MEANINGFUL_USAGE_THRESHOLD;
        const correctedBreakdown =
          `${summary.correctedDistinct} corrected (${summary.correctedConsolidationDistinct} consolidation-auto, ` +
          `${summary.correctedExternalDistinct} external` +
          (summary.correctedUnknownDistinct > 0 ? `, ${summary.correctedUnknownDistinct} pre-fix/unclassified` : '') +
          ')';

        if (meaningfulUsage && !hasPositiveSignal) {
          return {
            ok: false,
            message:
              `usefulness feedback loop has NEVER received a POSITIVE signal: ${report.activeCount} active ` +
              `memories, ${summary.servedDistinct} distinct atoms served from recall/search, 0 marked used, ` +
              `${correctedBreakdown} — corrections alone are not evidence the loop is alive (a loop that can ` +
              `only ever demote and never promote silently biases ranking one-way; see issue #190). Every ` +
              `score is still pinned at or below the neutral 0.5 prior.`,
            fix: 'Wire something in the real usage/recall path to call submit_feedback/mark_memory_used for positive signal — today nothing does (ADR-010 v1 shipped the mechanism only; see issue #190 for the missing-caller analysis). Corrections from consolidation auto-merge do not substitute for this.',
          };
        }

        if (!meaningfulUsage) {
          return {
            ok: true,
            message:
              `usefulness feedback loop: not enough activity yet to judge (${report.activeCount} active ` +
              `memories, ${summary.servedDistinct} served) — below the ${MEANINGFUL_USAGE_THRESHOLD}/${MEANINGFUL_USAGE_THRESHOLD} floor`,
          };
        }

        // issue #190 (implicit signal design, phase 5): split the used
        // count by signal so an operator can tell a real client action
        // (explicit) apart from the automatic cross-query-survival grant
        // (heuristic, runImplicitPositivePass) — both flip this canary
        // green (see that function's doc comment), but they are not the
        // same strength of evidence the loop is alive.
        const usedBreakdown =
          `${summary.usedDistinct} used (${summary.usedExplicitDistinct} explicit, ` +
          `${summary.usedHeuristicDistinct} heuristic)`;

        return {
          ok: true,
          message: `usefulness feedback loop: active (${usedBreakdown}, ${correctedBreakdown}, distinct atoms, all-time)`,
        };
      } catch (err) {
        // The query itself failed — this did NOT verify the feedback loop is
        // healthy, so it must not render/count the same as a check that did
        // (this is exactly the shape of bug issue #190 was about: a canary
        // reporting green without having actually confirmed anything).
        return { ok: true, inconclusive: true, message: `usefulness feedback loop check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
