/**
 * tests/audio/addon-probe.test.ts — FEAT-489 Slice A, packaging design pass
 * decisions 1-2 (presence probe + version handshake). Injects a fake
 * importer rather than relying on a real `astramem-audio` install.
 */
import { describe, it, expect } from 'vitest';
import { probeAudioAddon, describeProbeFailure } from '../../src/audio/addon-probe.js';
import { AUDIO_ADDON_API_VERSION } from '../../src/audio/addon-contract.js';

describe('probeAudioAddon', () => {
  it('resolves "absent" when the import throws (package not installed) — never throws itself', async () => {
    const result = await probeAudioAddon(async () => {
      throw new Error('Cannot find package \'astramem-audio\'');
    });
    expect(result.status).toBe('absent');
  });

  it('resolves "absent" when the module is present but malformed (missing exports)', async () => {
    const result = await probeAudioAddon(async () => ({ someOtherExport: true }));
    expect(result.status).toBe('absent');
  });

  it('resolves "version-mismatch" when the handshake constant is unsupported', async () => {
    const result = await probeAudioAddon(async () => ({
      ASTRAMEM_AUDIO_ADDON_API_VERSION: 999,
      transcribe: async () => [],
    }));
    expect(result.status).toBe('version-mismatch');
    if (result.status === 'version-mismatch') {
      expect(result.installedVersion).toBe(999);
    }
  });

  it('resolves "ok" with the module when the handshake matches', async () => {
    const fakeModule = { ASTRAMEM_AUDIO_ADDON_API_VERSION: AUDIO_ADDON_API_VERSION, transcribe: async () => [] };
    const result = await probeAudioAddon(async () => fakeModule);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.module).toBe(fakeModule);
    }
  });

  it('supports a `default` export wrapper (either ESM convention probes correctly)', async () => {
    const fakeModule = { ASTRAMEM_AUDIO_ADDON_API_VERSION: AUDIO_ADDON_API_VERSION, transcribe: async () => [] };
    const result = await probeAudioAddon(async () => ({ default: fakeModule }));
    expect(result.status).toBe('ok');
  });
});

describe('describeProbeFailure', () => {
  it('produces a distinct message for absent vs version-mismatch', () => {
    const absentMsg = describeProbeFailure({ status: 'absent', error: new Error('x') }, AUDIO_ADDON_API_VERSION);
    const mismatchMsg = describeProbeFailure({ status: 'version-mismatch', installedVersion: 7 }, AUDIO_ADDON_API_VERSION);
    expect(absentMsg).toContain('not installed');
    expect(mismatchMsg).toContain('unsupported');
    expect(absentMsg).not.toBe(mismatchMsg);
  });
});
