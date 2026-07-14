import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { openProductionDbReadonly, SEVEN_DAYS_MS } from './shared.js';

// ─── Check: Secret redaction (SEC-6/8) ────────────────────────────────────────

/**
 * FEAT-498: `captureActive` is the same enablement signal
 * `checkProxyCapture`/`checkAutoCapture` (proxy-capture.ts, auto-capture.ts)
 * read — `autoCaptureEnabled || (proxyEnabled && proxyCaptureEnabled)` —
 * computed once by the caller (`checks/index.ts`) and passed in, rather than
 * this check re-deriving it from raw config, so the "what counts as active
 * capture" definition lives in exactly one place.
 *
 * Zero fires over the trailing 7d is ambiguous on its own: it could mean
 * "genuinely no secrets appeared" (the common, healthy case) or "a detector
 * gap is letting real secrets through unredacted" — indistinguishable from
 * inside this check alone. `captureActive` is what turns "zero" from
 * unremarkable into worth a look: zero fires while nothing is being
 * captured is expected (there is no traffic for a detector to fire on), so
 * that case stays `ok: true` exactly as before this FEAT. Zero fires WHILE
 * capture is actively ingesting real transcripts over a full week is the
 * suspicious case — this is the same "measure the rate, not just
 * existence" discipline ADR-015 established for the entity-extraction and
 * auto-capture canaries (né #200/#217).
 */
export function checkRedaction(
  dataDir: string,
  enabled: boolean,
  encryptionEnabled: boolean,
  captureActive: boolean = false,
): Check {
  return {
    name: 'Secret redaction',
    // GROUP BY over a created_at >= ? window rides idx_redaction_log_created
    // (migration 005) — bounded by the 7d window, not table size.
    tier: 'cheap',
    async run(): Promise<CheckResult> {
      if (!enabled) {
        return {
          ok: false,
          message: 'redaction: OFF — secrets are NOT scrubbed before persistence (security.redaction.enabled=false)',
          fix: 'Set security.redaction.enabled=true (default) unless you have a deliberate reason to disable it.',
        };
      }

      let db: DB | undefined;
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        if (!existsSync(dbPath)) {
          return { ok: true, message: 'redaction: on (no DB yet — 0 secrets redacted)' };
        }
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;
        const rows = db
          .prepare('SELECT type, SUM(count) AS n FROM redaction_log WHERE created_at >= ? GROUP BY type ORDER BY n DESC')
          .all(since) as { type: string; n: number }[];

        const total = rows.reduce((sum, r) => sum + r.n, 0);
        if (total === 0) {
          if (captureActive) {
            return {
              ok: false,
              message:
                'redaction: on — 0 secrets redacted in last 7d WHILE capture (auto-capture or proxy capture) is ' +
                'active — either genuinely no secrets appeared in captured traffic (fine) or a detector gap is ' +
                'letting them through silently (indistinguishable from here).',
              fix:
                'Spot-check recent captured transcripts by hand for credential-shaped text the detectors should ' +
                'have caught (see src/redact/detectors.ts PATTERN_DETECTORS). If real secrets are slipping ' +
                'through, that is a pattern-coverage gap, not a config problem.',
            };
          }
          return { ok: true, message: 'redaction: on — 0 secrets redacted in last 7d' };
        }
        const breakdown = rows.map(r => `${r.n} ${r.type}`).join(', ');
        return { ok: true, message: `redaction: on — ${total} secrets redacted (${breakdown}) in last 7d` };
      } catch (err) {
        return { ok: false, message: `Redaction check error: ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
