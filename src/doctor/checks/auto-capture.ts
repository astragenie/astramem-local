import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { openProductionDbReadonly, MEANINGFUL_USAGE_THRESHOLD, SEVEN_DAYS_MS } from './shared.js';

// ─── Check: Auto-capture (FEAT-455 / ADR-012 decision 4) ─────────────────────

/**
 * Visibility row for the hook-tap auto-capture trigger. `ok: true` covers
 * both "off" (default) and "on, working" — unlike `checkServicePointer`'s
 * dev-pinned row (an always-unintended misconfiguration, hence `ok: false`),
 * auto-capture being ON is a deliberate, disclosed, opt-in user choice
 * (ADR-012 decision 4's whole point), so merely being ON is never itself a
 * warning. Mirrors `checkDurabilityGateMode`'s informational-row precedent
 * for that half.
 *
 * `ok: false` (WARN) is reserved for one specific, previously-silent failure
 * mode found live in production 2026-07-12: the hook is turned ON, the
 * daemon has real content in it (>= MEANINGFUL_USAGE_THRESHOLD active
 * memories from ANY source), and yet 0 of them ever came through capture —
 * the trigger is wired but never actually fires. A brand-new install below
 * that floor stays silent (`ok: true`) so day-one users never see a false
 * alarm before they've had a chance to accumulate any activity.
 *
 * 2026-07-12 provenance-mismatch fix: the count below now includes BOTH
 * `capture_source = 'auto_capture'` (the denser-sampling trigger this row is
 * nominally about) AND `'hook_close'` (the ordinary astramem-plugin
 * close-capture hook — the only capture path that actually fires today; see
 * src/cli/capture.ts). Before this fix, a user who enabled auto-capture but
 * never got the (still-unbuilt) denser-sampling trigger would see a
 * permanent false-positive WARN here even though ordinary close-capture was
 * working perfectly — the canary was checking the wrong provenance value,
 * not detecting a real wiring failure.
 *
 * issue #217 (2026-07-13): the count above used to be ALL-TIME (no
 * created_at bound at all) — the third instance of the ADR-015 "measures
 * existence, not rate" bug class (#200, #190 were the first two). Once
 * capture had EVER succeeded even a single time, `count > 0` forever: this
 * row would stay green for the rest of the install's life even if the hook
 * broke completely the next day (stale global CLI shadowing `capture`, a
 * hook config regression, a daemon upgrade). Fix: both queries are now
 * bound to the trailing `SEVEN_DAYS_MS` window (the same recency-window
 * constant `checkRedaction`/`checkAtomValidityExtraction`/etc. already use,
 * chosen over `checkEntityLinkRate`'s COUNT-tail because `capture_source`
 * is legitimately NULL on most non-capture memories — a memory-count tail
 * would put unrelated `/remember` volume in the denominator and dilute a
 * real capture outage). REAL-zero (a quiet week — `totalRecent` below the
 * floor) and BROKEN-zero (real recent activity, but none of it arrived via
 * capture) are kept distinguishable exactly as `MEANINGFUL_USAGE_THRESHOLD`
 * already does for the sibling "Usefulness feedback loop" canary.
 */
export function checkAutoCapture(dataDir: string, autoCaptureEnabled: boolean, encryptionEnabled: boolean): Check {
  return {
    name: 'Auto-capture',
    // Both count queries still ride the same covering indexes as before
    // adding the created_at >= ? bound: idx_memories_capture_source
    // (migration 024, partial WHERE capture_source IS NOT NULL) for the
    // capture_source IN (...) predicate — a partial index over only
    // ever-captured rows, so filtering that further by recency shrinks the
    // scan, never grows it — and idx_memories_archival_candidates (leading
    // columns archived, valid_to) for the active-count query, which was
    // already an unbounded COUNT(*) over the full active set before this
    // fix; the added created_at filter only narrows it. No new unbounded
    // scan is introduced.
    tier: 'cheap',
    async run(): Promise<CheckResult> {
      if (!autoCaptureEnabled) {
        return { ok: true, message: 'auto-capture: off (default)' };
      }

      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'auto-capture is ON — no DB yet, 0 auto-captured memories' };
      }

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;

        const row = db
          .prepare(`SELECT COUNT(*) AS count FROM memories WHERE capture_source IN ('auto_capture', 'hook_close') AND valid_to IS NULL AND created_at >= ?`)
          .get(since) as { count: number } | undefined;
        const totalRow = db
          .prepare(`SELECT COUNT(*) AS count FROM memories WHERE valid_to IS NULL AND archived = 0 AND created_at >= ?`)
          .get(since) as { count: number } | undefined;
        const count = row?.count ?? 0;
        const totalRecent = totalRow?.count ?? 0;

        // REAL-zero vs BROKEN-zero (ADR-015): a quiet 7 days with little or
        // no activity is not a failure and must not warn — only report a
        // rate once there is enough recent volume for "zero of them" to
        // actually mean something.
        if (totalRecent < MEANINGFUL_USAGE_THRESHOLD) {
          return {
            ok: true,
            message:
              `auto-capture is ON — not enough recent activity to judge (${totalRecent} active memories in the ` +
              `last 7d, below the ${MEANINGFUL_USAGE_THRESHOLD} floor)`,
          };
        }

        if (count === 0) {
          return {
            ok: false,
            message:
              `auto-capture is ON but 0 of the ${totalRecent} memories created in the last 7d came through ` +
              `auto-capture or the close-capture hook, despite real recent activity (>= ` +
              `${MEANINGFUL_USAGE_THRESHOLD} threshold — this daemon has seen real activity THIS WEEK, not just ` +
              `historically). The hook is likely wired but never firing (2026-07-12 "built, wired, never invoked" ` +
              `bug class) — or has silently regressed since it last worked (issue #217: an all-time count used to ` +
              `stay green forever once any capture had ever succeeded, even after capture later broke).`,
            fix: 'Verify the capture hook is actually installed and dispatching to this daemon (check the runner-plugin hook config, and daemon logs for incoming /ingest calls tagged capture_source=auto_capture or hook_close). Also check `astramem-local --version` on PATH — a stale global install predating the `capture` subcommand (e.g. 0.3.4) will silently no-op inside the hook.',
          };
        }

        const pct = ((count / totalRecent) * 100).toFixed(1);
        return {
          ok: true,
          message:
            `auto-capture is ON — ${count} of ${totalRecent} memories in the last 7d came through capture ` +
            `(${pct}%)`,
        };
      } catch (err) {
        // The count query itself failed — did not verify auto-capture activity.
        return { ok: true, inconclusive: true, message: `auto-capture is ON — count check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
