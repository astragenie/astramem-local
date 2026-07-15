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
import { inflateRawSync } from 'node:zlib';
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

/**
 * audio-v0.2.0 postmortem: this used to shell out to `tar -xf` for .zip too
 * (with a Windows-only bsdtar special case), on the assumption that "Linux
 * CI only ever extracts .tar.gz." That assumption broke the very first
 * publish run: `--all` (used by prepublishOnly / audio-publish.yml to bundle
 * BOTH platform binaries into one tarball) fetches the win32-x64 .zip even
 * when running on the Linux runner, and GNU tar cannot read zip
 * ("This does not look like a tar archive"). It passed locally on Windows
 * only because Windows' bsdtar reads zip transparently.
 *
 * Fixed by parsing the zip container format directly with Node's built-in
 * `node:zlib` (DEFLATE/STORE only — whisper.cpp's release zips use one of
 * these; ZIP64 is explicitly rejected below rather than silently
 * mis-parsed) instead of shelling out to ANY external archiver for zip.
 * This is a deliberate zero-new-dependency choice, not just a convenience:
 * `audio-publish.yml` runs on the bare self-hosted fleet (no `container:`
 * block, unlike install-smoke.yml's node-slim container job), so it is NOT
 * running as root and cannot reliably `apt-get install unzip` — and this
 * package's whole design (see model-manifest.ts / binary-manifest.ts
 * comments) already treats "no unpinned/unverifiable external tool in the
 * chain" as load-bearing. One code path now handles zip on every platform;
 * .tar.gz keeps using the system `tar` (GNU tar and Windows' bsdtar both
 * handle gzip correctly — that was never the bug).
 */
function extractZip(buf, destDir) {
  const EOCD_SIG = 0x06054b50;
  const CDFH_SIG = 0x02014b50;
  const LFH_SIG = 0x04034b50;

  // EOCD is the last fixed 22 bytes plus an optional up-to-64KiB comment —
  // scan backward from the end for the signature rather than assuming no
  // comment is present.
  let eocdOffset = -1;
  const searchStart = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('extractZip: End Of Central Directory record not found — not a valid zip file');

  const cdEntryCount = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  if (cdEntryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('extractZip: ZIP64 sentinel values found — this archive needs ZIP64 support, which is intentionally not implemented (unexpected for whisper.cpp release assets at this size).');
  }

  let pos = cdOffset;
  for (let i = 0; i < cdEntryCount; i++) {
    if (buf.readUInt32LE(pos) !== CDFH_SIG) throw new Error(`extractZip: central directory entry ${i} has a bad signature at offset ${pos}`);
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry, nothing to write

    // Local file header repeats name/extra with possibly different extra
    // length than the central directory copy — read its own lengths rather
    // than assuming they match.
    if (buf.readUInt32LE(localHeaderOffset) !== LFH_SIG) throw new Error(`extractZip: local file header for '${name}' has a bad signature`);
    const lfhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) {
      data = compressed; // stored, no compression
    } else if (method === 8) {
      data = inflateRawSync(compressed);
    } else {
      throw new Error(`extractZip: '${name}' uses unsupported compression method ${method} (only STORE=0 and DEFLATE=8 are handled)`);
    }
    if (data.length !== uncompressedSize) {
      throw new Error(`extractZip: '${name}' decompressed to ${data.length} bytes, expected ${uncompressedSize} — corrupt archive or parser bug`);
    }

    const outPath = join(destDir, name);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, data);
  }
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

    const extractDir = join(scratch, 'extracted');
    mkdirSync(extractDir, { recursive: true });
    if (entry.archive === 'zip') {
      // See extractZip's doc comment: pure-Node, cross-platform, no
      // external archiver dependency (this is the audio-v0.2.0 publish fix).
      // Extracted straight from the verified in-memory buffer — no need to
      // round-trip through a temp file first.
      extractZip(buf, extractDir);
    } else {
      // .tar.gz was never the bug — GNU tar (Linux) and Windows' bsdtar
      // both handle gzip-compressed tar correctly. `tar` still needs a real
      // file on disk (no stdin-pipe here, to keep this branch's behavior
      // unchanged from before the fix).
      const archivePath = join(scratch, 'archive.tar.gz');
      writeFileSync(archivePath, buf);
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
