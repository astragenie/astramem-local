#!/usr/bin/env node
/**
 * Standalone CLI wrapper around the same download+verify logic as
 * src/model-cache.ts's `ensureModel()`, duplicated here (not imported) so
 * it runs as a plain Node script with no build step — same rationale as
 * fetch-binaries.mjs. Prints the model size before downloading (design doc
 * decision 4: "Show model size before download, checksum-verify after").
 *
 * Usage: node scripts/fetch-model.mjs [modelId=tiny.en]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, unlinkSync, createWriteStream } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const MODEL_MANIFEST = {
  'tiny.en': {
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
    sizeBytes: 39_206_912,
    sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
    filename: 'ggml-tiny.en.bin',
  },
};

function addonCacheDir() {
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'astramem-audio');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'astramem-audio');
    default:
      return join(process.env.XDG_CACHE_HOME ?? join(home, '.cache'), 'astramem-audio');
  }
}

async function main() {
  const modelId = process.argv[2] ?? 'tiny.en';
  const entry = MODEL_MANIFEST[modelId];
  if (!entry) {
    console.error(`Unknown model id '${modelId}' — known ids: ${Object.keys(MODEL_MANIFEST).join(', ')}`);
    process.exit(1);
  }

  const modelsDir = join(addonCacheDir(), 'models');
  const finalPath = join(modelsDir, entry.filename);
  if (existsSync(finalPath)) {
    console.log(`[fetch-model] '${modelId}' already present at ${finalPath}`);
    return;
  }

  console.log(`[fetch-model] downloading '${modelId}' (${(entry.sizeBytes / 1e6).toFixed(1)} MB) from ${entry.url}`);
  mkdirSync(modelsDir, { recursive: true });
  const tmpPath = `${finalPath}.download`;

  const res = await fetch(entry.url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching ${entry.url}`);

  const hash = createHash('sha256');
  const nodeStream = Readable.fromWeb(res.body);
  nodeStream.on('data', chunk => hash.update(chunk));
  await pipeline(nodeStream, createWriteStream(tmpPath));

  const digest = hash.digest('hex');
  if (digest !== entry.sha256) {
    unlinkSync(tmpPath);
    throw new Error(`sha256 mismatch for '${modelId}' — expected ${entry.sha256}, got ${digest}. Deleted the corrupt download.`);
  }

  renameSync(tmpPath, finalPath);
  console.log(`[fetch-model] '${modelId}' verified and installed -> ${finalPath}`);
}

main().catch(err => {
  console.error('[fetch-model] FAILED:', err.message);
  process.exit(1);
});
