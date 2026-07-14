/**
 * Pinned whisper.cpp CLI binary manifest (FEAT-489 Slice B, packaging design
 * pass decision 4). Source: ggml-org/whisper.cpp's OWN GitHub Releases CI
 * (https://github.com/ggml-org/whisper.cpp/releases) — MIT licensed, same
 * "upstream project's own release CI builds the platform binary" pattern
 * `sqlite-vec` already uses in this repo (see design doc decision 4's "v1
 * platform-scope fallback" note).
 *
 * CPU-ONLY IS THE WHOLE POINT (design doc decision 4 — pinned, not a
 * preference, per the FEAT-485 VRAM-incident lesson). `whisper-bin-x64.zip`
 * / `whisper-bin-ubuntu-x64.tar.gz` are ggml-org's dedicated CPU-only build
 * targets — verified directly by inspecting the extracted archive contents
 * during Slice B's build: only `ggml-cpu-*.{dll,so}` variants are present,
 * zero CUDA/cublas/Vulkan artifacts. Do NOT repoint these URLs at
 * `whisper-cublas-*` or `whisper-blas-*` assets without re-reading that
 * decision's reasoning first.
 *
 * `sha256` values were computed from a REAL download of each archive during
 * Slice B's build (see the Slice B handoff for the exact command), not
 * copied from a release-notes page.
 */
export interface BinaryManifestEntry {
  /** Public URL of the platform archive on GitHub Releases. */
  url: string;
  /** Expected SHA256 of the downloaded archive, lowercase hex. */
  sha256: string;
  /** Archive format — determines how fetch-binaries.mjs extracts it. */
  archive: 'zip' | 'tar.gz';
  /** Path of the CLI executable inside the extracted archive. */
  cliPathInArchive: string;
  /** Every file (relative to the archive root) that must be copied
   *  alongside the CLI executable for it to run (shared libs / DLLs). */
  siblingFiles: string[];
}

const WHISPER_CPP_RELEASE_TAG = 'v1.9.1';

export const BINARY_MANIFEST: Record<string, BinaryManifestEntry> = {
  'win32-x64': {
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_RELEASE_TAG}/whisper-bin-x64.zip`,
    sha256: '7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539',
    archive: 'zip',
    cliPathInArchive: 'Release/whisper-cli.exe',
    siblingFiles: [
      'Release/ggml.dll',
      'Release/ggml-base.dll',
      'Release/ggml-cpu-alderlake.dll',
      'Release/ggml-cpu-cannonlake.dll',
      'Release/ggml-cpu-cascadelake.dll',
      'Release/ggml-cpu-haswell.dll',
      'Release/ggml-cpu-icelake.dll',
      'Release/ggml-cpu-sandybridge.dll',
      'Release/ggml-cpu-skylakex.dll',
      'Release/ggml-cpu-sse42.dll',
      'Release/ggml-cpu-x64.dll',
      'Release/whisper.dll',
    ],
  },
  'linux-x64': {
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_RELEASE_TAG}/whisper-bin-ubuntu-x64.tar.gz`,
    sha256: 'f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5',
    archive: 'tar.gz',
    cliPathInArchive: 'whisper-bin-ubuntu-x64/whisper-cli',
    siblingFiles: [
      'whisper-bin-ubuntu-x64/libggml.so',
      'whisper-bin-ubuntu-x64/libggml.so.0',
      'whisper-bin-ubuntu-x64/libggml.so.0.15.1',
      'whisper-bin-ubuntu-x64/libggml-base.so',
      'whisper-bin-ubuntu-x64/libggml-base.so.0',
      'whisper-bin-ubuntu-x64/libggml-base.so.0.15.1',
      'whisper-bin-ubuntu-x64/libggml-cpu-sapphirerapids.so',
      'whisper-bin-ubuntu-x64/libggml-cpu-cascadelake.so',
      'whisper-bin-ubuntu-x64/libggml-cpu-cooperlake.so',
      'whisper-bin-ubuntu-x64/libggml-cpu-icelake.so',
      'whisper-bin-ubuntu-x64/libggml-cpu-skylakex.so',
      'whisper-bin-ubuntu-x64/libggml-cpu-alderlake.so',
      'whisper-bin-ubuntu-x64/libggml-cpu-haswell.so',
      'whisper-bin-ubuntu-x64/libggml-cpu-ivybridge.so',
      'whisper-bin-ubuntu-x64/libggml-cpu-sandybridge.so',
      'whisper-bin-ubuntu-x64/libggml-cpu-sse42.so',
      'whisper-bin-ubuntu-x64/libwhisper.so',
      'whisper-bin-ubuntu-x64/libwhisper.so.1',
      'whisper-bin-ubuntu-x64/libwhisper.so.1.9.1',
    ],
  },
};

/** `${process.platform}-${process.arch}` for the two v1-supported targets;
 *  anything else (darwin-*, win32-ia32, ...) is NOT in this manifest —
 *  callers must treat a missing key as "not installed for this platform"
 *  (design doc decision 4's graceful-degradation clause), never a crash. */
export function currentPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function getBinaryManifestEntry(platformKey: string): BinaryManifestEntry | undefined {
  return BINARY_MANIFEST[platformKey];
}
