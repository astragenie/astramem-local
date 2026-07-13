import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import { openProductionDbReadonly, MEANINGFUL_USAGE_THRESHOLD } from './shared.js';

// ─── Check: Vec-index orphans (issue #209 follow-up) ─────────────────────────

/**
 * "A memory that exists and can never be recalled" canary for the vec-index
 * gap #250 fixed (migrations/041-vec-index-retry.sql). Production had 13 of
 * 18,863 active memories (0.069%) with a committed row but no
 * `memories_vec` entry — permanently invisible to vector search, with a
 * green write response every time. #250 added `memories.needs_vec_index`
 * as a durable REAL-zero/BROKEN-zero marker and a retry path (immediate
 * `reembed` enqueue on write-time failure + the `cleanup` job's 24h sweep,
 * see src/pipeline/handlers/cleanup.ts), but deliberately shipped NO doctor
 * reader — this is that reader.
 *
 * ADR-015 rule 6, applied literally: the denominator is
 * `COUNT(*) WHERE archived = 0` (active memories — archived rows are
 * excluded from recall by design and from migration 041's own backfill, so
 * they don't belong in this rate either); the numerator is
 * `COUNT(*) WHERE archived = 0 AND needs_vec_index = 1`. Both are reported
 * every run, not just on WARN — "0 of N (0.0%)" is itself the healthy
 * signal, not silence.
 *
 * REAL-zero vs BROKEN-zero (ADR-015 rule 1): a fresh `PRAGMA table_info`
 * check runs BEFORE the count query. Zero flagged rows on a DB that
 * predates migration 041 (the column doesn't exist at all) is a
 * completely different fact than zero flagged rows on a DB where the
 * column exists and every write has been clean — the two must not render
 * identically. The former returns `inconclusive: true`; only the latter is
 * a verified `ok: true`.
 *
 * Persistence, named honestly rather than faked: this check has NO way to
 * tell a row flagged ten minutes ago (normal — the write-time enqueue or
 * the 24h sweep hasn't reached it yet) from a row that has been stuck for
 * weeks (the retry path itself is broken — the actual failure this canary
 * exists to catch). `MemoryRepo.markNeedsVecIndex` does not stamp a
 * flagged-at time, and `updated_at` is only touched by the SUCCESS path
 * (`reembedHandler` bumps it when it clears the flag) — there is no column
 * this check can read to compute an age. Rather than inventing a threshold
 * dressed up as an age measurement, the WARN floor below is a plain
 * MAGNITUDE proxy — "this many simultaneously in-flight orphans is
 * implausible given the retry design's speed" — reusing
 * MEANINGFUL_USAGE_THRESHOLD (the repo's existing "is this a real signal or
 * just noise" floor) rather than inventing a new number. It is deliberately
 * NOT claimed to detect "stuck for multiple sweeps" specifically; it
 * detects "too many to be transient." A future flagged-at column would let
 * a follow-up sharpen this into a true age-based check — see the doc
 * comment on `checkAtomValidityExtraction` for the same kind of
 * denominator caveat named up front instead of hidden.
 */
export function checkVecIndex(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Vec-index orphans',
    // 'full' — this is an unindexed scan of `memories`, the single largest,
    // fastest-growing table in the schema (18,863+ rows and counting).
    // `needs_vec_index` (migration 041) has NO index of its own. The one
    // existing index whose leading column is `archived`
    // (idx_memories_archival_candidates, migration 013:
    // `(archived, valid_to, created_at)`) can narrow the `archived = 0`
    // predicate to an index range scan, but `needs_vec_index` is not a
    // column of that index — SQLite still has to read the underlying table
    // row for every archived=0 match (nearly the whole active corpus) to
    // evaluate `needs_vec_index = 1`. Net effect: a near-full-table visit,
    // same shape #226's follow-up audit found in checkEntityRelations and
    // checkAtomValidityExtraction over this same table. Not safe on the
    // 15-minute frequent schedule; belongs on the operator-invoked `doctor`
    // CLI / >=24h piggyback tick only.
    tier: 'full',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'vec-index orphans: no DB yet' };
      }

      let db: Awaited<ReturnType<typeof openProductionDbReadonly>> | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);

        // REAL-zero vs BROKEN-zero (ADR-015 rule 1): confirm the column
        // this whole check depends on actually exists before trusting any
        // count against it. A pre-#250 DB (or one that failed to pick up
        // migration 041 — see migrations/030-evidence-guard-drops.sql's own
        // "silently skipped" precedent, #185) would otherwise report a
        // trivially true "0 orphans" that verified nothing.
        const columns = db.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
        if (!columns.some(c => c.name === 'needs_vec_index')) {
          return {
            ok: true,
            inconclusive: true,
            message:
              'vec-index orphans: cannot determine — this DB predates migration 041 (issue #209 / PR #250); ' +
              '`memories.needs_vec_index` does not exist. Upgrade (git pull && bun run build && ' +
              'astramem-local reinstall) to enable this canary.',
          };
        }

        const totalActiveRow = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE archived = 0').get() as {
          n: number;
        };
        const totalActive = totalActiveRow.n;

        if (totalActive < MEANINGFUL_USAGE_THRESHOLD) {
          return {
            ok: true,
            message:
              `vec-index orphans: not enough active memories yet to judge (${totalActive} active, below the ` +
              `${MEANINGFUL_USAGE_THRESHOLD} floor)`,
          };
        }

        const orphanRow = db
          .prepare('SELECT COUNT(*) AS n FROM memories WHERE archived = 0 AND needs_vec_index = 1')
          .get() as { n: number };
        const orphanCount = orphanRow.n;
        const rate = orphanCount / totalActive;
        const ratePct = (rate * 100).toFixed(3);

        if (orphanCount === 0) {
          return {
            ok: true,
            message: `vec-index orphans: 0 of ${totalActive} active memories (0.000%) flagged needs_vec_index=1.`,
          };
        }

        // Magnitude proxy, not an age measurement — see the file doc
        // comment's "Persistence, named honestly" section for why this
        // check cannot do better than that with the current schema.
        if (orphanCount < MEANINGFUL_USAGE_THRESHOLD) {
          return {
            ok: true,
            message:
              `vec-index orphans: ${orphanCount} of ${totalActive} active memories (${ratePct}%) currently ` +
              `flagged needs_vec_index=1 — below the ${MEANINGFUL_USAGE_THRESHOLD}-row alarm floor and ` +
              `plausibly still in-flight (immediate reembed enqueue on write-time failure, plus the cleanup ` +
              `job's 24h sweep). This check cannot distinguish a row flagged moments ago from one stuck for ` +
              `days — needs_vec_index has no flagged-at timestamp — so this floor is a magnitude proxy, not ` +
              `a persistence measurement.`,
          };
        }

        // At/above the floor: too many to plausibly all be simultaneously
        // in-flight given the retry design's speed. Pull failed/poison
        // reembed job counts as supporting evidence (index-backed via
        // idx_jobs_state(state, created_at) — cheap regardless of this
        // check's own 'full' tier) — not a precise correlation to these
        // specific memory ids, but a real signal about whether the retry
        // mechanism itself is currently failing.
        const stuckJobsRow = db
          .prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'reembed' AND state IN ('failed', 'poison')")
          .get() as { n: number };
        const stuckJobs = stuckJobsRow.n;

        return {
          ok: false,
          message:
            `vec-index orphans: ${orphanCount} of ${totalActive} active memories (${ratePct}%) are flagged ` +
            `needs_vec_index=1 — unrecallable by vector search until the reembed retry drains them. This is ` +
            `at or above the ${MEANINGFUL_USAGE_THRESHOLD}-row floor, too many to plausibly all be transient ` +
            `in-flight rows. ` +
            (stuckJobs > 0
              ? `${stuckJobs} reembed job(s) are currently in a failed/poison state — the retry path itself ` +
                `looks broken (check the embed provider).`
              : `0 reembed jobs are currently failed/poison, so either the sweep hasn't caught up yet or jobs ` +
                `are failing silently outside the job-state model — check daemon logs for [reembed] / [cleanup] ` +
                `lines.`),
          fix:
            'Confirm the embed provider is reachable (astramem-local doctor), check daemon logs for ' +
            '[reembed]/[cleanup] failures, and consider astramem-local rebuild if the backlog does not drain ' +
            'after the next 24h cleanup sweep. See migrations/041-vec-index-retry.sql and ' +
            'src/pipeline/handlers/cleanup.ts.',
        };
      } catch (err) {
        // The query itself failed — did NOT verify vec-index health is
        // healthy (same shape as issue #200: a canary that reports green
        // without having actually checked is worse than no canary).
        return { ok: true, inconclusive: true, message: `vec-index orphans check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
