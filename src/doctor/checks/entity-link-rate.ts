import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { totalEntityLinkDrops } from '../../storage/entity-link-log.js';
import { queryEntityLinkage } from '../../server/queries/dashboard.js';
import { openProductionDbReadonly, MEANINGFUL_USAGE_THRESHOLD } from './shared.js';

// ─── Check: Entity link rate (issue #200) ────────────────────────────────────

/**
 * Tail window (by created_at DESC, not a calendar-time cutoff) the "Entity
 * link rate" canary below judges. A COUNT-based tail is deliberate, not an
 * oversight: issue #200's own postmortem shows why a calendar window is the
 * wrong tool here — its first-filed (and later retracted) "still 49.4%
 * broken" claim came from a 24h bucket that straddled the exact hour the
 * fix landed, averaging ~87% broken with ~4% healthy into a number that
 * looked like an ongoing incident. A tail of the N most-recent memories has
 * no such straddling failure mode: the moment a fix ships and N more
 * memories accumulate, the window is entirely post-fix and the rate reads
 * true, regardless of how long the prior breakage lasted or how much
 * calendar time it spanned. It is also what a human would do by hand (the
 * issue's own correction comment did exactly this: "most recent 300
 * memories: 4 unlinked (1.3%)").
 */
const RECENT_MEMORY_WINDOW = 100;

/**
 * WARN threshold for the fraction of the tail window with zero linked
 * entities. Chosen with a wide margin on both sides of the documented data
 * points (issue #200): healthy runs measured ~0-5% unlinked; the broken
 * period measured ~65-89% unlinked across every memory type, and even the
 * misleading straddled-bucket calculation was 49.4%. 25% sits comfortably
 * above the healthy ceiling and comfortably below every observed broken
 * reading (including the worst-case straddled one), so it fires on the
 * broken state and stays quiet on the healthy one with room to spare.
 */
const UNLINKED_RATE_WARN_THRESHOLD = 0.25;

/**
 * issue #200: the "Entity relations extraction" canary (checks/entity-
 * relations.ts) reported GREEN for weeks while ~87% of memories were
 * receiving zero entities, because it only asked "do relation rows exist at
 * all" — a question the ~13% that DID work could always answer yes to. This
 * check asks the question that check never did: what FRACTION of memories
 * are actually getting linked, right now.
 *
 * Deliberately windowed on the most recent `RECENT_MEMORY_WINDOW` memories
 * (see that constant's doc comment for why COUNT-tail, not calendar-time),
 * NOT the all-time unlinked total `queryEntityLinkage` (dashboard.ts)
 * computes. The store has 11,032 historical unlinked memories the operator
 * has explicitly ruled out backfilling ("before it was mostly trash",
 * issue #200 correction comment) — an all-time rate would stay permanently
 * red on a perfectly healthy install and train the operator to ignore this
 * row exactly the way the old canary trained them to trust a green one.
 * The all-time count is still surfaced in the message (via
 * `queryEntityLinkage`) for context, but never gates ok/warn.
 *
 * Gated on the same MEANINGFUL_USAGE_THRESHOLD (20) floor every other
 * "built, wired, never invoked" canary in this file uses — a brand-new or
 * low-activity install legitimately has too few recent memories for a
 * percentage to mean anything and must not warn (ADR-015: "a rolling rate
 * crossing a floor is the signal, not any individual zero").
 *
 * On WARN, reads `entity_link_drops` (migration 036,
 * src/storage/entity-link-log.ts) over the same window's time span as a
 * tie-breaker — mirrors `checkEntityRelations`'s use of
 * `relation_guard_drops`: drops > 0 means entities ARE being emitted and a
 * write is failing; drops == 0 too means the model itself is emitting
 * nothing for these atoms (issue #200's actual root cause — num_ctx
 * truncation + a dropped temperature option starving extraction of the
 * entities[] array entirely).
 */
export function checkEntityLinkRate(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Entity link rate',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'entity link rate: no DB yet' };
      }

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);

        const rows = db
          .prepare(`
            SELECT
              m.created_at AS createdAt,
              EXISTS (SELECT 1 FROM memory_entities me WHERE me.memory_id = m.id) AS linked
            FROM memories m
            WHERE m.valid_to IS NULL AND m.archived = 0
            ORDER BY m.created_at DESC
            LIMIT ?
          `)
          .all(RECENT_MEMORY_WINDOW) as { createdAt: number; linked: 0 | 1 }[];

        const total = rows.length;

        if (total < MEANINGFUL_USAGE_THRESHOLD) {
          return {
            ok: true,
            message:
              `entity link rate: not enough recent memories yet to judge (${total} in the most-recent-` +
              `${RECENT_MEMORY_WINDOW} window, below the ${MEANINGFUL_USAGE_THRESHOLD} floor)`,
          };
        }

        const unlinked = rows.filter(r => r.linked === 0).length;
        const rate = unlinked / total;
        const pct = (rate * 100).toFixed(1);
        const { unlinkedMemoryCount: allTimeUnlinked } = queryEntityLinkage(db);
        const historicalNote =
          ` (${allTimeUnlinked} all-time unlinked memories are pre-existing debt, intentionally not ` +
          `backfilled — see issue #200 — and are excluded from this rate)`;

        if (rate < UNLINKED_RATE_WARN_THRESHOLD) {
          return {
            ok: true,
            message:
              `entity link rate: ${pct}% unlinked (${unlinked}/${total}) in the most recent ${total} ` +
              `memories — healthy${historicalNote}`,
          };
        }

        // Oldest row in the window anchors the guard-drop lookup to roughly
        // the same period this rate was computed over.
        const oldestInWindow = rows.length > 0 ? rows[rows.length - 1]!.createdAt : Date.now();
        const drops = totalEntityLinkDrops(db, oldestInWindow);

        return {
          ok: false,
          message:
            `${pct}% of the most recent ${total} memories have ZERO linked entities (${unlinked}/${total}) ` +
            `— the extraction/linkage pipeline is degraded for CURRENT activity, not just historical debt` +
            `${historicalNote}. ${drops} entity-link guard-drop event(s) recorded in the same window — ` +
            (drops > 0
              ? 'entities ARE being emitted and a write is failing for some of them.'
              : 'the model itself is emitting no entities[] for these atoms.'),
          fix:
            'Check the extraction model config (num_ctx large enough for the prompt, temperature not ' +
            "dropped by an `options` spread — see issue #200's root cause) and debug logs for " +
            '"entity link: upsert/link failed" lines (src/distill/stages/08-embed-index.ts).',
        };
      } catch (err) {
        // The query itself failed — this did NOT verify the entity link rate
        // is healthy, so it must not render/count the same as a check that
        // did (ADR-015: a canary that reports green when it cannot run is
        // worse than no canary — the exact bug this check exists to catch,
        // now closed in its own exception path too).
        return {
          ok: true,
          inconclusive: true,
          message: `entity link rate: CHECK FAILED TO RUN (not a clean bill of health): ${err}`,
        };
      } finally {
        db?.close();
      }
    },
  };
}
