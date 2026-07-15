import { describe, it, expect } from 'vitest';
import { BINARY_MANIFEST, currentPlatformKey, getBinaryManifestEntry } from '../src/binary-manifest.js';
import { getModelManifestEntry, DEFAULT_MODEL_ID } from '../src/model-manifest.js';
import { describeMissingBinary, resolveWhisperCli } from '../src/binary-resolve.js';

describe('binary-manifest', () => {
  it('has exactly the v1-supported platforms (win32-x64, linux-x64) — no silent matrix growth', () => {
    expect(Object.keys(BINARY_MANIFEST).sort()).toEqual(['linux-x64', 'win32-x64']);
  });

  it('every entry has a 64-hex-char sha256 (a manifest typo would produce the wrong length)', () => {
    for (const entry of Object.values(BINARY_MANIFEST)) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('returns undefined (not a throw) for an unsupported platform', () => {
    expect(getBinaryManifestEntry('darwin-arm64')).toBeUndefined();
  });

  it('currentPlatformKey matches process.platform/arch', () => {
    expect(currentPlatformKey()).toBe(`${process.platform}-${process.arch}`);
  });
});

describe('model-manifest', () => {
  it('DEFAULT_MODEL_ID resolves to a real manifest entry', () => {
    const entry = getModelManifestEntry(DEFAULT_MODEL_ID);
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.sizeBytes).toBeGreaterThan(0);
  });

  it('throws a listing-known-ids error for an unknown model id (no silent undefined)', () => {
    expect(() => getModelManifestEntry('nonexistent-model')).toThrow(/known ids/);
  });
});

describe('binary-resolve', () => {
  it('resolveWhisperCli never throws — returns null when the binary is not yet fetched', () => {
    // In CI/unit-test context bin/ is not populated (fetch-binaries is a
    // separate, explicit step) — this must degrade gracefully, not throw.
    expect(() => resolveWhisperCli()).not.toThrow();
  });

  it('describeMissingBinary always returns a non-crashing, actionable string', () => {
    const msg = describeMissingBinary();
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });
});
