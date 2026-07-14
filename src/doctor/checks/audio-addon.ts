import type { Check, CheckResult } from '../types.js';
import { probeAudioAddon, describeProbeFailure, type AddonImporter } from '../../audio/addon-probe.js';
import { AUDIO_ADDON_API_VERSION } from '../../audio/addon-contract.js';

// ─── Check: Audio add-on (FEAT-489 Slice A / ADR-017) ─────────────────────────

/**
 * Two concerns folded into one row, deliberately:
 *
 * 1. Presence/version probe (packaging design pass decision 1 — mirrors
 *    `checkSqliteVec`/`checkFts5`'s lazy dynamic-import-in-try/catch shape).
 *    Only runs when `audio.mode !== 'off'` — an absent add-on with audio
 *    off is not a misconfiguration, it's the shipped default.
 * 2. ADR-017 decision 3's "doctor gets a WARN row per surface when enabled"
 *    disclosure requirement — a genuine, every-run reminder while the
 *    surface is active, same posture `checkDevNoAuth` already established
 *    for `auth.devNoAuth` (an ongoing, disclosed risk the operator should
 *    see on every single `doctor` run for as long as it stays on, NOT a
 *    one-shot wiring canary, and NOT gated on whether the feature happens
 *    to be working correctly today). This is why a healthy, present,
 *    version-matched add-on with `mode !== 'off'` still reports `ok: false`
 *    here — third-party consent visibility, not health.
 */
export function checkAudioAddon(mode: 'off' | 'dry-run' | 'enabled', importer?: AddonImporter): Check {
  return {
    name: 'Audio add-on',
    tier: 'cheap', // dynamic import + in-memory constant comparison only, no I/O beyond module resolution
    async run(): Promise<CheckResult> {
      if (mode === 'off') {
        return { ok: true, message: 'audio: off (default)' };
      }

      const result = await probeAudioAddon(importer);
      if (result.status !== 'ok') {
        return {
          ok: false,
          message: `audio.mode is '${mode}' but ${describeProbeFailure(result, AUDIO_ADDON_API_VERSION)}`,
          fix:
            result.status === 'absent'
              ? 'npm install astramem-audio'
              : 'npm install astramem-audio@latest (or pin a version matching this astramem-local build)',
        };
      }

      // ADR-017 decision 3: WARN every run while this third-party-capturing
      // surface is live — distinct from (and independent of) the presence
      // probe succeeding just above.
      return {
        ok: false,
        message:
          `audio capture is '${mode}' — this surface transcribes and stores everything said in captured audio, ` +
          'including other participants’ voices, not just the operator’s own. Recording or transcribing ' +
          'someone without their knowledge is restricted or illegal in many places; turning this on does not make ' +
          'it legal — the operator is responsible for informing other participants and obtaining consent where ' +
          'required (ADR-017). Disable via audio.mode: \'off\' in config.yaml if this was not an intentional, ' +
          'disclosed choice.',
      };
    },
  };
}
