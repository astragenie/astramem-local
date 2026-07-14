/**
 * tests/doctor/audio-addon-check.test.ts
 *
 * FEAT-489 Slice A / ADR-017. Three things this check reports, tested in
 * the same priority order the check itself uses: (1) the disclosure-
 * acknowledgment gate (ADR-017 decision 3 v1 enforcement surface — needs_fix
 * review follow-up), checked before anything about the add-on; (2) the
 * presence/version probe (packaging design pass decisions 1-2), exercised
 * end-to-end via getChecks() since no real `astramem-audio` package is
 * installed in this test environment; (3) the ADR-017 every-run-while-
 * active disclosure WARN, which needs an injected importer to simulate a
 * present, version-matched add-on (checkAudioAddon called directly).
 */
import { describe, it, expect } from 'vitest';
import { getChecks } from '../../src/doctor/checks.js';
import { checkAudioAddon } from '../../src/doctor/checks/audio-addon.js';
import { AUDIO_ADDON_API_VERSION } from '../../src/audio/addon-contract.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

const CHECK_NAME = 'Audio add-on';

describe('doctor "Audio add-on" check', () => {
  it('defaults to ok:true / off when audioMode is omitted', async () => {
    const result = await findCheck(getChecks({}), CHECK_NAME).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('off');
  });

  it('audioMode: off — ok:true regardless of disclosure-acknowledgment or add-on presence', async () => {
    const result = await findCheck(getChecks({ audioMode: 'off' }), CHECK_NAME).run();
    expect(result.ok).toBe(true);
  });

  it('audioMode: enabled, disclosureAcknowledged omitted (defaults false) — ok:false naming the exact config key to set, checked BEFORE the probe', async () => {
    const result = await findCheck(getChecks({ audioMode: 'enabled' }), CHECK_NAME).run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('audio.disclosureAcknowledged');
    expect(result.fix).toContain('disclosureAcknowledged: true');
    // Must not fall through to the probe-absent message — the disclosure
    // gate is unconditional and checked first.
    expect(result.message.toLowerCase()).not.toContain('not installed');
  });

  it('audioMode: dry-run, disclosureAcknowledged false — same gate fires', async () => {
    const result = await findCheck(getChecks({ audioMode: 'dry-run', audioDisclosureAcknowledged: false }), CHECK_NAME).run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('audio.disclosureAcknowledged');
  });

  it('audioMode: enabled, disclosureAcknowledged true, add-on genuinely absent — ok:false with install instruction', async () => {
    const result = await findCheck(getChecks({ audioMode: 'enabled', audioDisclosureAcknowledged: true }), CHECK_NAME).run();
    expect(result.ok).toBe(false);
    expect(result.message.toLowerCase()).toContain('not installed');
    expect(result.fix).toContain('npm install astramem-audio');
  });

  it('audioMode: dry-run, disclosureAcknowledged true, add-on absent — still ok:false (same probe failure)', async () => {
    const result = await findCheck(getChecks({ audioMode: 'dry-run', audioDisclosureAcknowledged: true }), CHECK_NAME).run();
    expect(result.ok).toBe(false);
    expect(result.message.toLowerCase()).toContain('not installed');
  });

  it('add-on present + version mismatch (acknowledged) — ok:false with a distinct message from "not installed"', async () => {
    const check = checkAudioAddon('enabled', true, async () => ({
      ASTRAMEM_AUDIO_ADDON_API_VERSION: 999,
      transcribe: async () => [],
    }));
    const result = await check.run();
    expect(result.ok).toBe(false);
    expect(result.message.toLowerCase()).toContain('unsupported');
    expect(result.message).not.toContain('not installed');
  });

  it('add-on present + version OK + acknowledged, mode enabled — genuine every-run WARN (ADR-017 disclosure), not a health failure', async () => {
    const check = checkAudioAddon('enabled', true, async () => ({
      ASTRAMEM_AUDIO_ADDON_API_VERSION: AUDIO_ADDON_API_VERSION,
      transcribe: async () => [],
    }));
    const result = await check.run();
    expect(result.ok).toBe(false);
    expect(result.message.toLowerCase()).toContain('consent');
    expect(result.message).not.toContain('not installed');
    expect(result.message.toLowerCase()).not.toContain('unsupported');
  });

  it('add-on present + version OK + acknowledged, mode dry-run — same disclosure WARN fires', async () => {
    const check = checkAudioAddon('dry-run', true, async () => ({
      ASTRAMEM_AUDIO_ADDON_API_VERSION: AUDIO_ADDON_API_VERSION,
      transcribe: async () => [],
    }));
    const result = await check.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("'dry-run'");
  });
});
