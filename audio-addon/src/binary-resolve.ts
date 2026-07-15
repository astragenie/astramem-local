import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentPlatformKey, getBinaryManifestEntry } from './binary-manifest.js';

/**
 * Resolves the whisper.cpp CLI binary BUNDLED INSIDE this installed
 * package (`<package root>/bin/<platform>-<arch>/whisper-cli[.exe]`) —
 * populated at build/publish time by `scripts/fetch-binaries.mjs`, shipped
 * inside the npm tarball via `package.json`'s `files` array (design doc
 * decision 4: "ship prebuilt binaries", not a runtime download — unlike the
 * GGML model, which IS a first-use download, see model-cache.ts).
 *
 * Never throws for an unbuilt platform — returns `null` so the caller can
 * produce the design doc's graceful-degradation message ("astramem-audio
 * not installed for this platform") instead of a crash.
 */
export interface ResolvedBinary {
  platformKey: string;
  cliPath: string;
}

function packageRoot(): string {
  // dist/binary-resolve.js -> package root is one level up from dist/.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..');
}

export function resolveWhisperCli(): ResolvedBinary | null {
  const platformKey = currentPlatformKey();
  const entry = getBinaryManifestEntry(platformKey);
  if (!entry) return null;

  const exeName = platformKey.startsWith('win32') ? 'whisper-cli.exe' : 'whisper-cli';
  const cliPath = join(packageRoot(), 'bin', platformKey, exeName);
  if (!existsSync(cliPath)) return null;

  return { platformKey, cliPath };
}

export function describeMissingBinary(): string {
  const platformKey = currentPlatformKey();
  const entry = getBinaryManifestEntry(platformKey);
  if (!entry) {
    return (
      `astramem-audio has no prebuilt whisper.cpp binary for this platform (${platformKey}) in v1 — ` +
      'linux-x64 and win32-x64 are the only platforms with a pinned build today ' +
      '(docs/research/2026-07-14-audio-addon-packaging.md decision 4, v1 platform-scope fallback). ' +
      'Audio capture is unavailable here; every other astramem-local feature is unaffected.'
    );
  }
  return (
    `astramem-audio is installed but its whisper.cpp binary for ${platformKey} is missing — ` +
    'run `bun run fetch-binaries` in the audio-addon package (or reinstall from a published ' +
    'version, which bundles it) before transcribing.'
  );
}
