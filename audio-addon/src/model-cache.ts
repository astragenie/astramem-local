import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { modelsDir } from './cache-dir.js';
import { DEFAULT_MODEL_ID, getModelManifestEntry } from './model-manifest.js';

export interface ModelFetchProgress {
  modelId: string;
  sizeBytes: number;
}

/** Optional confirm-gate hook — the design doc's "reuse the existing
 *  confirm-gate pattern in src/cli/init.ts (confirmMissingBinary)" applies
 *  at the astramem-local CLI layer, which is out of this package's scope to
 *  author. This add-on exposes the same SHAPE (show size before
 *  downloading, resolve/reject to proceed) so that base-repo wiring is a
 *  thin pass-through, not a redesign. Defaults to always-proceed so the
 *  add-on is directly callable/testable without a CLI attached. */
export type ConfirmDownload = (progress: ModelFetchProgress) => boolean | Promise<boolean>;

const alwaysConfirm: ConfirmDownload = () => true;

export function defaultModelPath(modelId: string = DEFAULT_MODEL_ID): string {
  const entry = getModelManifestEntry(modelId);
  return join(modelsDir(), entry.filename);
}

/**
 * Ensure the given model is present and checksum-verified in the cache
 * dir, downloading it on first use if absent (design doc decision 4:
 * "Model download UX: on first use, not on add-on install"). Idempotent —
 * a second call with the same model id that already passed verification is
 * a no-op file-exists check, no re-download, no re-hash.
 *
 * Never leaves a partially-downloaded or checksum-mismatched file at the
 * final path: downloads to `<path>.download` and only renames into place
 * after SHA256 verification passes.
 */
export async function ensureModel(
  modelId: string = DEFAULT_MODEL_ID,
  confirm: ConfirmDownload = alwaysConfirm,
): Promise<string> {
  const entry = getModelManifestEntry(modelId);
  const finalPath = join(modelsDir(), entry.filename);
  if (existsSync(finalPath)) return finalPath;

  const proceed = await confirm({ modelId, sizeBytes: entry.sizeBytes });
  if (!proceed) {
    throw new Error(`Model '${modelId}' download declined — audio transcription cannot proceed without it.`);
  }

  mkdirSync(modelsDir(), { recursive: true });
  const tmpPath = `${finalPath}.download`;

  const res = await fetch(entry.url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download model '${modelId}' from ${entry.url}: HTTP ${res.status}`);
  }

  const hash = createHash('sha256');
  const nodeStream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  nodeStream.on('data', (chunk: Buffer) => hash.update(chunk));

  try {
    await pipeline(nodeStream, createWriteStream(tmpPath));
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw new Error(`Failed to download model '${modelId}': ${(err as Error).message}`);
  }

  const digest = hash.digest('hex');
  if (digest !== entry.sha256) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw new Error(
      `Downloaded model '${modelId}' failed checksum verification — expected sha256 ${entry.sha256}, got ${digest}. ` +
      'Deleted the corrupt download; re-run to retry (a mismatch here means either a corrupted transfer or the ' +
      'upstream file changed — do not silently trust it either way).',
    );
  }

  renameSync(tmpPath, finalPath);
  return finalPath;
}
