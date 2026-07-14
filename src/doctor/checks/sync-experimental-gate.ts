import type { Check, CheckResult } from '../types.js';

/**
 * Check: Sync experimental gate (sync-experimental-gate slice).
 *
 * Sync-to-astramem-cloud is currently broken (8868 events failing HTTP 400,
 * not yet root-caused). Before this gate, `astramem-local pair <code>` alone
 * set sync.json's `enabled: true` and that was sufficient to start the
 * shipper — anyone who paired hit the broken path. `sync.experimental` is a
 * second, config.yaml-only, hand-edit opt-in `pair` never touches; see
 * `shouldStartShipper` (src/sync/shipper.ts) and its call site in
 * `cli/serve.ts` for the actual gate this check merely reports on.
 *
 * Deliberately `ok: true` in every state (mirrors `checkProxyCapture`'s
 * posture, src/doctor/checks/proxy-capture.ts) — an operator who never
 * paired, or who paired but hasn't opted into the experimental gate, is not
 * misconfigured. This is a state-visibility row, not a pass/fail gate.
 */
export function checkSyncExperimentalGate(syncEnabled: boolean, syncExperimental: boolean): Check {
  return {
    name: 'Sync experimental gate',
    tier: 'cheap', // pure config read, no I/O
    async run(): Promise<CheckResult> {
      if (!syncEnabled) {
        return { ok: true, message: 'sync: off (not paired — run "astramem-local pair <code>" to enable cloud sync)' };
      }
      if (!syncExperimental) {
        return {
          ok: true,
          message:
            'sync: experimental gate closed (not started) — sync.enabled=true but sync.experimental=false; ' +
            'sync-to-cloud is not yet stable. Set sync.experimental: true in config.yaml to opt in.',
        };
      }
      return { ok: true, message: 'sync: experimental gate open — shipper active (opt-in, sync-to-cloud is not yet stable)' };
    },
  };
}
