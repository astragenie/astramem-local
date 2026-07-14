import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { openProductionDbReadonly } from './shared.js';

// ─── Check: LLM proxy (FEAT-458 S1-AC-2, ADR-013) ─────────────────────────────

/**
 * Visibility row for the LLM proxy relay (`astramem-local proxy serve`,
 * src/proxy/server.ts). Same `ok: true`-in-every-state posture as
 * `checkAutoCapture` above — proxy-enabled-and-running (with or without
 * capture) is a deliberate opt-in per ADR-013 §5, never itself a
 * misconfiguration, so this never reports `ok: false` on its own.
 *
 * S2 ships zero capture code (docs/specs/FEAT-458-S1-design.md §2.3): the
 * `capture_source = 'proxy'` count is always 0 until FEAT-458 S3 lands the
 * capture fork, but the row is still worth shipping now — it gives
 * visibility into "the proxy is configured on" even before any capture
 * write path exists, matching the S2/S3 split. There is deliberately no
 * live reachability probe here (unlike `checkDaemonReachable`): S2's proxy
 * has no HTTP control-plane route (src/cli/proxy.ts's own doc comment — no
 * `/status`, no `/config`) and its one route transparently forwards
 * whatever it's sent to `upstream`, so a doctor-side fetch would either hit
 * a real (possibly billed) upstream or hang on an unreachable one. This
 * check is config-state-only by design.
 *
 * Release no-go hard gate: leads with `proxy.experimental` state, ahead of
 * `proxy.enabled` — `experimental !== true` is what actually determines
 * whether `astramem-local proxy serve` will start at all (src/cli/proxy.ts),
 * independent of whatever `proxy.enabled` says.
 */
export function checkProxyCapture(
  dataDir: string,
  proxyEnabled: boolean,
  proxyExperimental: boolean,
  captureEnabled: boolean,
  encryptionEnabled: boolean,
): Check {
  return {
    name: 'LLM proxy',
    // capture_source = 'proxy' rides idx_memories_capture_source (migration
    // 024) — an index range scan bounded by proxy-captured row count.
    tier: 'cheap',
    async run(): Promise<CheckResult> {
      // Release no-go hard gate (src/cli/proxy.ts): `proxy.experimental` is
      // what actually decides whether `proxy serve` will run at all — it is
      // checked FIRST and independently of `proxy.enabled`, which the CLI
      // subcommand never reads as a start gate (see that file's module doc
      // comment). Never `ok: false` — being gated is the shipped default,
      // not a misconfiguration.
      if (!proxyExperimental) {
        return {
          ok: true,
          message: 'proxy: experimental (not for production) — set proxy.experimental: true to opt in; `proxy serve` refuses to start otherwise',
        };
      }
      if (!proxyEnabled) {
        return { ok: true, message: 'proxy: off (default)' };
      }
      if (!captureEnabled) {
        return { ok: true, message: 'proxy is ON — capture is off (transparent forward only)' };
      }

      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'proxy capture is ON — no DB yet, 0 proxy-captured memories' };
      }

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const row = db
          .prepare(`SELECT COUNT(*) AS count FROM memories WHERE capture_source = 'proxy' AND valid_to IS NULL`)
          .get() as { count: number } | undefined;
        const count = row?.count ?? 0;

        return {
          ok: true,
          message: `proxy capture is ON — ${count} proxy-captured ${count === 1 ? 'memory' : 'memories'} currently stored`,
        };
      } catch (err) {
        // The count query itself failed — did not verify proxy capture activity.
        return { ok: true, inconclusive: true, message: `proxy capture is ON — count check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
