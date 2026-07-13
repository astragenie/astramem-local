import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { openProductionDbReadonly, MEANINGFUL_USAGE_THRESHOLD } from './shared.js';

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
 */
export function checkAutoCapture(dataDir: string, autoCaptureEnabled: boolean, encryptionEnabled: boolean): Check {
  return {
    name: 'Auto-capture',
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
        const row = db
          .prepare(`SELECT COUNT(*) AS count FROM memories WHERE capture_source IN ('auto_capture', 'hook_close') AND valid_to IS NULL`)
          .get() as { count: number } | undefined;
        const totalRow = db
          .prepare(`SELECT COUNT(*) AS count FROM memories WHERE valid_to IS NULL AND archived = 0`)
          .get() as { count: number } | undefined;
        const count = row?.count ?? 0;
        const totalActive = totalRow?.count ?? 0;

        if (count === 0 && totalActive >= MEANINGFUL_USAGE_THRESHOLD) {
          return {
            ok: false,
            message:
              `auto-capture is ON but 0 memories have ever come through auto-capture or the close-capture hook, ` +
              `despite ${totalActive} active memories already in the store (>= ${MEANINGFUL_USAGE_THRESHOLD} ` +
              `threshold — this daemon has seen real activity). The hook is likely wired but never firing ` +
              `(2026-07-12 "built, wired, never invoked" bug class).`,
            fix: 'Verify the capture hook is actually installed and dispatching to this daemon (check the runner-plugin hook config, and daemon logs for incoming /ingest calls tagged capture_source=auto_capture or hook_close). Also check `astramem-local --version` on PATH — a stale global install predating the `capture` subcommand (e.g. 0.3.4) will silently no-op inside the hook.',
          };
        }

        return {
          ok: true,
          message: `auto-capture is ON — ${count} auto-captured ${count === 1 ? 'memory' : 'memories'} currently stored`,
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
