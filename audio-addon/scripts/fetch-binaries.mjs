#!/usr/bin/env node
/**
 * Downloads the pinned ggml-org/whisper.cpp CPU-only release archive for
 * the current platform (or every manifest platform with --all, used by the
 * publish workflow to bundle both win32-x64 and linux-x64 into one
 * package) into audio-addon/bin/<platform>-<arch>/. Verifies SHA256 against
 * this manifest before extracting — never trust a download it didn't check.
 *
 * bin/ is gitignored (same discipline as fixture audio elsewhere in this
 * repo family) — this script is how a fresh checkout OR the publish
 * workflow populates it before `npm publish` bundles it into the tarball
 * (package.json `files` includes `bin/`).
 *
 * Usage: node scripts/fetch-binaries.mjs [--all]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

// Keep this manifest in lockstep with src/binary-manifest.ts. Duplicated
// (not imported) deliberately — this is a plain Node script run before
// `tsc` has compiled anything, and before any dependency install; it must
// not require a build step to run.
const WHISPER_CPP_RELEASE_TAG = 'v1.9.1';
const BINARY_MANIFEST = {
  'win32-x64': {
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_RELEASE_TAG}/whisper-bin-x64.zip`,
    sha256: '7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539',
    archive: 'zip',
    cliPathInArchive: 'Release/whisper-cli.exe',
    exeName: 'whisper-cli.exe',
    siblingFiles: [
      'Release/ggml.dll', 'Release/ggml-base.dll', 'Release/ggml-cpu-alderlake.dll',
      'Release/ggml-cpu-cannonlake.dll', 'Release/ggml-cpu-cascadelake.dll', 'Release/ggml-cpu-haswell.dll',
      'Release/ggml-cpu-icelake.dll', 'Release/ggml-cpu-sandybridge.dll', 'Release/ggml-cpu-skylakex.dll',
      'Release/ggml-cpu-sse42.dll', 'Release/ggml-cpu-x64.dll', 'Release/whisper.dll',
    ],
  },
  'linux-x64': {
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_RELEASE_TAG}/whisper-bin-ubuntu-x64.tar.gz`,
    sha256: 'f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5',
    archive: 'tar.gz',
    cliPathInArchive: 'whisper-bin-ubuntu-x64/whisper-cli',
    exeName: 'whisper-cli',
    siblingFiles: [
      'whisper-bin-ubuntu-x64/libggml.so', 'whisper-bin-ubuntu-x64/libggml.so.0', 'whisper-bin-ubuntu-x64/libggml.so.0.15.1',
      'whisper-bin-ubuntu-x64/libggml-base.so', 'whisper-bin-ubuntu-x64/libggml-base.so.0', 'whisper-bin-ubuntu-x64/libggml-base.so.0.15.1',
      'whisper-bin-ubuntu-x64/libggml-cpu-sapphirerapids.so', 'whisper-bin-ubuntu-x64/libggml-cpu-cascadelake.so',
      'whisper-bin-ubuntu-x64/libggml-cpu-cooperlake.so', 'whisper-bin-ubuntu-x64/libggml-cpu-icelake.so',
      'whisper-bin-ubuntu-x64/libggml-cpu-skylakex.so', 'whisper-bin-ubuntu-x64/libggml-cpu-alderlake.so',
      'whisper-bin-ubuntu-x64/libggml-cpu-haswell.so', 'whisper-bin-ubuntu-x64/libggml-cpu-ivybridge.so',
      'whisper-bin-ubuntu-x64/libggml-cpu-sandybridge.so', 'whisper-bin-ubuntu-x64/libggml-cpu-sse42.so',
      'whisper-bin-ubuntu-x64/libwhisper.so', 'whisper-bin-ubuntu-x64/libwhisper.so.1', 'whisper-bin-ubuntu-x64/libwhisper.so.1.9.1',
    ],
  },
};

async function fetchAndVerify(url, expectedSha256) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const digest = createHash('sha256').update(buf).digest('hex');
  if (digest !== expectedSha256) {
    throw new Error(`${url}: sha256 mismatch — expected ${expectedSha256}, got ${digest}. Refusing to extract an unverified archive.`);
  }
  return buf;
}

async function extractOne(platformKey, entry) {
  const destDir = join(pkgRoot, 'bin', platformKey);
  const exeDest = join(destDir, entry.exeName);
  if (existsSync(exeDest)) {
    console.log(`[fetch-binaries] ${platformKey}: already present at ${exeDest}, skipping`);
    return;
  }

  console.log(`[fetch-binaries] ${platformKey}: downloading ${entry.url}`);
  mkdirSync(destDir, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'astramem-audio-fetch-'));
  try {
    const buf = await fetchAndVerify(entry.url, entry.sha256);
    const archivePath = join(scratch, entry.archive === 'zip' ? 'archive.zip' : 'archive.tar.gz');
    writeFileSync(archivePath, buf);

    const extractDir = join(scratch, 'extracted');
    mkdirSync(extractDir, { recursive: true });
    if (entry.archive === 'zip') {
      // Git-for-Windows' MSYS `tar` (commonly first on PATH under Git Bash)
      // cannot read .zip. Windows itself has shipped a real bsdtar (which
      // CAN) at this fixed path since 1803 — invoke it directly rather than
      // relying on PATH order. Linux CI only ever extracts .tar.gz (see the
      // `else` branch) so this path is Windows-only.
      const systemTar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
      execFileSync(systemTar, ['-xf', archivePath, '-C', extractDir]);
    } else {
      execFileSync('tar', ['-xzf', archivePath, '-C', extractDir]);
    }

    copyFileSync(join(extractDir, entry.cliPathInArchive), exeDest);
    if (platformKey.startsWith('linux')) chmodSync(exeDest, 0o755);
    for (const rel of entry.siblingFiles) {
      const src = join(extractDir, rel);
      if (existsSync(src)) {
        const destName = rel.split('/').pop();
        copyFileSync(src, join(destDir, destName));
        if (platformKey.startsWith('linux')) chmodSync(join(destDir, destName), 0o755);
      }
    }
    console.log(`[fetch-binaries] ${platformKey}: installed -> ${exeDest}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const all = process.argv.includes('--all');
  const current = `${process.platform}-${process.arch}`;
  const targets = all ? Object.entries(BINARY_MANIFEST) : [[current, BINARY_MANIFEST[current]]];

  for (const [platformKey, entry] of targets) {
    if (!entry) {
      console.log(`[fetch-binaries] no pinned binary for platform '${platformKey}' (v1 supports win32-x64, linux-x64 only) — skipping; the add-on will report "not installed for this platform" there.`);
      continue;
    }
    await extractOne(platformKey, entry);
  }
}

main().catch(err => {
  console.error('[fetch-binaries] FAILED:', err.message);
  process.exit(1);
});
