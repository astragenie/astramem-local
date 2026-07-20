import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { openProductionDbReadonly, SEVEN_DAYS_MS, MEANINGFUL_USAGE_THRESHOLD } from './shared.js';

// ─── Check: Capture-chain freshness (FEAT-483 SLICE-7) ──────────────────────

/**
 * Freshness row for the capture chain — the missing dimension the sibling
 * "Auto-capture" canary (`auto-capture.ts`) does not cover. That check
 * answers "what fraction of recent memories came through capture" as a rate
 * over the trailing 7-day window; a chain that fired once on day 1 of that
 * window and then went silent for the following six still reports a
 * nonzero rate there. This check answers the complementary question — "is
 * it STILL breathing right now" — by measuring the AGE of the single
 * most-recent successful capture (either provenance value auto-capture.ts
 * reads: `'auto_capture'` or `'hook_close'`, see that file's
 * provenance-mismatch fix for why both count) against a staleness
 * threshold.
 *
 * This is the canary for the exact incident class named in FEAT-483: "the
 * stale global CLI 0.3.4 silently killed the capture chain for days" — a
 * days-long silent outage that a rate-over-a-week metric alone can mask.
 *
 * `ok: false` (RED) fires only once the box is demonstrably ACTIVE (>=
 * MEANINGFUL_USAGE_THRESHOLD active memories from ANY source in the
 * trailing SEVEN_DAYS_MS window — the same floor auto-capture.ts uses) AND
 * either no capture has EVER been recorded, or the most recent one is older
 * than CAPTURE_STALENESS_THRESHOLD_MS. A quiet box (below the activity
 * floor) stays `inconclusive` rather than RED — mirroring auto-capture.ts's
 * REAL-zero vs BROKEN-zero split so a low-activity install never
 * false-alarms.
 */
const CAPTURE_STALENESS_THRESHOLD_HOURS = 48;
const CAPTURE_STALENESS_THRESHOLD_MS = CAPTURE_STALENESS_THRESHOLD_HOURS * 60 * 60 * 1000;

export function checkCaptureFreshness(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Capture-chain freshness',
    // 'cheap' — MAX(created_at) filtered by capture_source IN (...) rides
    // idx_memories_capture_source (migration 024, partial WHERE
    // capture_source IS NOT NULL) exactly like checkAutoCapture's and
    // checkProxyCapture's COUNT queries over the same index: bounded by the
    // number of ever-captured rows, not the full corpus. The activity-floor
    // query is byte-identical in shape to checkAutoCapture's totalRow query
    // (created_at >= ? over active memories), already an established
    // cheap-tier pattern in this directory.
    tier: 'cheap',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'capture-chain freshness: no DB yet' };
      }

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;

        const totalRow = db
          .prepare(`SELECT COUNT(*) AS count FROM memories WHERE valid_to IS NULL AND archived = 0 AND created_at >= ?`)
          .get(since) as { count: number } | undefined;
        const totalRecent = totalRow?.count ?? 0;

        // REAL-zero vs BROKEN-zero (ADR-015): a quiet box has too small a
        // recent sample for "no capture" to mean anything — only judge
        // freshness once there is enough recent volume that a stale chain
        // would actually be surprising.
        if (totalRecent < MEANINGFUL_USAGE_THRESHOLD) {
          return {
            ok: true,
            inconclusive: true,
            message:
              `capture-chain freshness: not enough recent activity to judge (${totalRecent} active memories in ` +
              `the last 7d, below the ${MEANINGFUL_USAGE_THRESHOLD} floor)`,
          };
        }

        const lastRow = db
          .prepare(
            `SELECT MAX(created_at) AS last_capture FROM memories WHERE capture_source IN ('auto_capture', 'hook_close') AND valid_to IS NULL`,
          )
          .get() as { last_capture: number | null } | undefined;
        const lastCaptureAt = lastRow?.last_capture ?? null;

        if (lastCaptureAt === null) {
          return {
            ok: false,
            message:
              `capture-chain freshness: no capture (auto_capture or hook_close) has EVER been recorded, despite ` +
              `${totalRecent} active memories in the last 7d — the capture chain looks dead, not merely quiet.`,
            fix:
              'Verify the capture hook is actually installed and dispatching to this daemon (check the runner-plugin ' +
              'hook config, and daemon logs for incoming /ingest calls tagged capture_source=auto_capture or ' +
              'hook_close). Also check `astramem-local --version` on PATH — a stale global install predating the ' +
              '`capture` subcommand (e.g. 0.3.4) will silently no-op inside the hook.',
          };
        }

        const ageMs = Date.now() - lastCaptureAt;
        const ageH = (ageMs / 3_600_000).toFixed(1);
        const lastCaptureIso = new Date(lastCaptureAt).toISOString();

        if (ageMs > CAPTURE_STALENESS_THRESHOLD_MS) {
          return {
            ok: false,
            message:
              `capture-chain freshness: last successful capture was ${ageH}h ago (${lastCaptureIso}), exceeding the ` +
              `${CAPTURE_STALENESS_THRESHOLD_HOURS}h staleness threshold, despite ${totalRecent} active memories ` +
              `from other sources in the last 7d — the capture chain has gone silent (the "stale global CLI ` +
              `silently killed the capture chain for days" class, FEAT-483).`,
            fix:
              'Verify the capture hook is actually installed and dispatching to this daemon (check the runner-plugin ' +
              'hook config, and daemon logs for incoming /ingest calls tagged capture_source=auto_capture or ' +
              'hook_close). Also check `astramem-local --version` on PATH — a stale global install predating the ' +
              '`capture` subcommand (e.g. 0.3.4) will silently no-op inside the hook.',
          };
        }

        return {
          ok: true,
          message:
            `capture-chain freshness: last successful capture was ${ageH}h ago (${lastCaptureIso}) — within the ` +
            `${CAPTURE_STALENESS_THRESHOLD_HOURS}h staleness threshold`,
        };
      } catch (err) {
        // The query itself failed — did not verify capture-chain freshness.
        return { ok: true, inconclusive: true, message: `capture-chain freshness check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
