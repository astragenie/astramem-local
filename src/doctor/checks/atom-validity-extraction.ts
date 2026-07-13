import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
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
export function checkAtomValidityExtraction(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Atom validity extraction',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'atom validity extraction: no DB yet' };
      }

      try {
        const db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;

        const recentRow = db
          .prepare('SELECT COUNT(*) AS n FROM memories WHERE created_at >= ?')
          .get(since) as { n: number };
        const recentTotal = recentRow.n;

        if (recentTotal < MEANINGFUL_USAGE_THRESHOLD) {
          db.close();
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
        db.close();

        const ratePct = ((extracted / recentTotal) * 100).toFixed(1);

        if (extracted === 0) {
          return {
            ok: false,
            message:
              `atom validity extraction is wired but 0 of ${recentTotal} recent memories have ` +
              `validity_extracted = 1 — the distill extraction pipeline is likely not writing this ` +
              `field despite real activity (2026-07-13 "built, wired, never invoked" bug class, ` +
              `issue #205).`,
            fix:
              'Confirm src/distill/stages/08-embed-index.ts is passing validity_extracted: true on ' +
              'insertWithCreateEvent calls, and that the running daemon is on a build that includes ' +
              'the issue #205 fix (astramem-local reinstall).',
          };
        }

        return {
          ok: true,
          message:
            `atom validity extraction: ${extracted}/${recentTotal} recent memories (${ratePct}%) have ` +
            `validity_extracted = 1 — see this check's doc comment for why 100% is not expected in a ` +
            `mixed /remember + distill corpus.`,
        };
      } catch (err) {
        // Informational failure mode — never fail doctor over a metric query
        // error, consistent with the other read-only DB checks above. But a
        // check that could not RUN is not a check that PASSED (ADR-015), so
        // it is marked inconclusive rather than reporting a clean bill of
        // health it never actually established.
        return {
          ok: true,
          inconclusive: true,
          message: `atom validity extraction check error (non-fatal): ${err}`,
        };
      }
    },
  };
}
