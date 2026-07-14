import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { getCacheStats } from '../../storage/embed-cache.js';
import { openProductionDbReadonly, MEANINGFUL_USAGE_THRESHOLD } from './shared.js';

// ─── Check: Embed cache hit rate (FEAT-492) ──────────────────────────────────

/**
 * Purely informational — surfaces `embed_cache_stats`' cumulative hit/miss
 * counters (migration 042, src/storage/embed-cache.ts) so an operator can
 * SEE the cache doing its job (or not) instead of taking "it's wired" on
 * faith. Never fails doctor (`ok` is always `true` once it can run): a low
 * hit rate is expected and correct on a fresh install or right after a
 * model/dim swap (every embed is a first-time miss by construction), so
 * there is no threshold here that would mean "broken" the way, say,
 * checkEntityLinkRate's rate does.
 *
 * Gated on the same MEANINGFUL_USAGE_THRESHOLD floor as the other "not
 * enough activity yet to say anything" checks in this directory.
 */
export function checkEmbedCacheHitRate(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Embed cache hit rate',
    tier: 'cheap', // single-row read of a small counters table
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'embed cache: no DB yet' };
      }

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const { hits, misses } = getCacheStats(db);
        const total = hits + misses;

        if (total < MEANINGFUL_USAGE_THRESHOLD) {
          return {
            ok: true,
            message:
              `embed cache: not enough distill/reembed activity yet to report a rate ` +
              `(${total} document embed calls recorded, below the ${MEANINGFUL_USAGE_THRESHOLD} floor)`,
          };
        }

        const pct = ((hits / total) * 100).toFixed(1);
        return {
          ok: true,
          message: `embed cache: ${pct}% hit rate (${hits} hits / ${misses} misses, ${total} total document embed calls)`,
        };
      } catch (err) {
        // Same posture as checkEntityLinkRate: a check that couldn't run
        // must not render identically to one that verified a clean bill of
        // health (ADR-015).
        return {
          ok: true,
          inconclusive: true,
          message: `embed cache: CHECK FAILED TO RUN (not a clean bill of health): ${err}`,
        };
      } finally {
        db?.close();
      }
    },
  };
}
