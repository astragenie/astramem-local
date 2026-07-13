import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import { totalValidityGuardDrops } from '../../storage/validity-guard-log.js';
import { openProductionDbReadonly, SEVEN_DAYS_MS, MEANINGFUL_USAGE_THRESHOLD } from './shared.js';

// ─── Check: Atom validity extraction (issue #205) ────────────────────────────

/**
 * The ADR-015-compliant canary shape for issue #205: a RATE, not an
 * existence check. `entity_relations` taught the lesson this check applies —
 * a canary that only asks "does at least one row exist?" reports green while
 * 99% of the pipeline is silently producing nothing (issue #200's exact
 * mistake). Here the equivalent trap would be "does at least one memory have
 * validity_extracted = 1?" — instead this reports the actual percentage of
 * recent memories where extraction considered validity at all, so a
 * regression that makes 05-extract.ts/08-embed-index.ts stop setting the
 * flag shows up as the rate dropping toward 0%, not as a check flipping from
 * green to red at some arbitrary threshold.
 *
 * Denominator caveat, stated plainly rather than hidden: "recent memories"
 * counts EVERY write path (`/remember`, MCP `remember`, the eval harness),
 * not just the distill extraction pipeline — those non-extraction paths
 * never set `validity_extracted` and correctly stay at 0 forever (see
 * InsertInput.validity_extracted's doc comment). A repo that leans heavily
 * on direct `/remember` calls will show a rate well below 100% even with a
 * perfectly healthy extraction pipeline; this canary cannot (and does not
 * try to) separate the two populations without a discriminator column that
 * doesn't exist. What it DOES reliably catch, mirroring `checkAutoCapture`'s
 * "wired but zero" precedent: real recent distill activity (>=
 * MEANINGFUL_USAGE_THRESHOLD memories) producing a flat 0% — that specific
 * combination is only possible if the extraction write path itself broke.
 */

/**
 * Floor for the "Atom validity extraction" canary. Deliberately LOW (not ~95%):
 * `validity_extracted` is set unconditionally by the distill write path, but
 * `/remember`, the MCP `remember` tool, and the eval harness all bypass that
 * path and legitimately leave it 0. So a healthy mixed corpus is nowhere near
 * 100%, and a high floor would just be a permanently-red canary nobody reads.
 *
 * The point of a floor at all is to catch a REGRESSION — the distill path
 * silently stopping — which shows up as the rate collapsing toward zero. The
 * previous gate was `extracted === 0`, which only fires when literally nothing
 * works; a drop from 100% to 3% read as healthy. That is the exact "green while
 * ~87% broken" shape issue #200 exists to kill.
 */
const VALIDITY_EXTRACTION_WARN_FLOOR = 0.05;

export function checkAtomValidityExtraction(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Atom validity extraction',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'atom validity extraction: no DB yet' };
      }

      // `let db` OUTSIDE the try + close in `finally` — the canonical shape
      // from PR #208. Declared INSIDE the try (as this check originally was),
      // a thrown query never reaches db.close() and leaks the readonly handle.
      let db: Awaited<ReturnType<typeof openProductionDbReadonly>> | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;

        const recentRow = db
          .prepare('SELECT COUNT(*) AS n FROM memories WHERE created_at >= ?')
          .get(since) as { n: number };
        const recentTotal = recentRow.n;

        if (recentTotal < MEANINGFUL_USAGE_THRESHOLD) {
          return {
            ok: true,
            message:
              `atom validity extraction: not enough recent activity to judge (${recentTotal} ` +
              `memories in last 7d, below the ${MEANINGFUL_USAGE_THRESHOLD} floor)`,
          };
        }

        const extractedRow = db
          .prepare('SELECT COUNT(*) AS n FROM memories WHERE created_at >= ? AND validity_extracted = 1')
          .get(since) as { n: number };
        const extracted = extractedRow.n;

        const rate = extracted / recentTotal;
        const ratePct = (rate * 100).toFixed(1);
        const guardDrops = totalValidityGuardDrops(db, since);

        // RATE, not existence. The original gate here was `extracted === 0` —
        // i.e. it only went red when NOTHING worked. A pipeline regression that
        // dropped coverage from 100% to 3% would have reported ok:true forever,
        // which is precisely the "green while ~87% broken" failure that issue
        // #200 exists to kill. Rebuilding it inside the fix for #205 would have
        // been the third time this repo shipped this exact shape.
        //
        // ADR-015, strengthened: a canary MUST measure the RATE of the failure,
        // not the EXISTENCE of a success.
        if (rate < VALIDITY_EXTRACTION_WARN_FLOOR) {
          // A true zero and a collapse are BOTH red, but they are different
          // diagnoses and the message says which: zero means the write path
          // never ran at all ("built, wired, never invoked" — this repo's
          // signature failure); a low-but-nonzero rate means it ran and mostly
          // stopped, which the old `=== 0` gate reported as perfectly healthy.
          const neverInvoked = extracted === 0;
          return {
            ok: false,
            message:
              `atom validity extraction: only ${extracted}/${recentTotal} recent memories (${ratePct}%) ` +
              `have validity_extracted = 1 — below the ${(VALIDITY_EXTRACTION_WARN_FLOOR * 100).toFixed(0)}% floor. ` +
              (neverInvoked
                ? `NOT ONE recent memory carries it: the distill write path is built, wired, never invoked ` +
                  `(issue #205's own bug class).`
                : `The distill write path sets this unconditionally, so a rate this low means it ran and ` +
                  `then largely STOPPED — a regression, not a mixed corpus.`),
            fix:
              'Confirm src/distill/stages/08-embed-index.ts passes validity_extracted: true on ' +
              'insertWithCreateEvent, and that the running daemon is on a build including the ' +
              'issue #205 fix (astramem-local reinstall).',
          };
        }

        // A high extraction rate with a high guard-drop rate is NOT health: it
        // means the pipeline is looking, the model IS stating end-dates, and
        // every one of them is being refused as implausible. Without this, that
        // state is indistinguishable from "the model states no end dates."
        if (guardDrops > 0) {
          return {
            ok: true,
            message:
              `atom validity extraction: ${extracted}/${recentTotal} recent memories (${ratePct}%) have ` +
              `validity_extracted = 1, but the validity guard REFUSED ${guardDrops} implausible bound(s) ` +
              `in the same window — the model is emitting end-dates that fail the plausibility check ` +
              `(see guardValidTo in src/distill/stages/08-embed-index.ts). Atoms were kept; only the ` +
              `bounds were dropped, so this is quality loss, not data loss.`,
          };
        }

        return {
          ok: true,
          message:
            `atom validity extraction: ${extracted}/${recentTotal} recent memories (${ratePct}%) have ` +
            `validity_extracted = 1, 0 guard drops — see this check's doc comment for why 100% is not ` +
            `expected in a mixed /remember + distill corpus.`,
        };
      } catch (err) {
        // INCONCLUSIVE, not ok:true. A check whose own query threw has NOT
        // observed a healthy system — it has observed nothing.
        return {
          ok: true,
          inconclusive: true,
          message: `atom validity extraction: CHECK FAILED TO RUN (not a clean bill of health): ${err}`,
        };
      } finally {
        db?.close();
      }
    },
  };
}
