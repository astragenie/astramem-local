/**
 * `astramem-local model fetch [--model <label>] [--dtype q8|fp16|fp32] [--dest <dir>] [--print-urls] [--force]`
 * `astramem-local model status [--model <label>] [--dtype ...] [--dest <dir>]`
 *
 * Offline-install companion to the ONNX embed provider (#363): pre-seeds the
 * stable snapshot cache (`<dataDir>/models/onnx/<hfRepo>/<revision>/`) so the
 * daemon's first boot never needs the HF hub. Exists because the 2026-07-16
 * outage showed "the daemon downloads on first run" is not a given — a box
 * that filters node.exe's TLS (curl fine, node hung) can never complete that
 * first download from inside the daemon.
 *
 * `--print-urls` prints copy-pastable `curl` commands instead of downloading
 * — the escape hatch for exactly that box class (curl's TLS path was not
 * filtered), and the documented recipe for air-gapped installs (run the
 * curls elsewhere, carry the 4 files over, point `config.onnxEmbed.modelPath`
 * or drop them into the default cache).
 *
 * Download failures always end with the curl recipe, never a bare stack —
 * the fallback IS the feature (ADR-015: fail loudly with the next step).
 */
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  ONNX_MODEL_REGISTRY,
  requiredSnapshotFiles,
  resolveLocalSnapshotDir,
  type OnnxDType,
} from '../providers/embed/onnx.js';
import { DEFAULT_MODEL_LABEL } from '../providers/embed/onnx-registry.js';
import { resolveOnnxCacheDir } from '../providers/index.js';
import { resolveRuntimeConfig } from '../config/resolve-runtime.js';

const HF_HOST = 'https://huggingface.co';

/** Per-file download budget. The q8 artifact is ~337MB — generous, but
 * bounded: a filtered-TLS box hangs after TCP connect with no error, and
 * without a deadline `model fetch` would sit silent forever (the exact
 * failure mode this command exists to route around). */
const FETCH_TIMEOUT_MS = 15 * 60 * 1000;

export interface ModelFetchPlanFile {
  /** Snapshot-relative file (posix separators — doubles as the URL tail). */
  file: string;
  url: string;
  dest: string;
}

export interface ModelFetchPlan {
  modelLabel: string;
  hfRepo: string;
  revision: string;
  dtype: OnnxDType;
  snapshotDir: string;
  files: ModelFetchPlanFile[];
}

export interface ModelFetchPlanOpts {
  /** Registry label (NOT the HF repo id). Defaults to config.embedding.model
   * when that names a registered ONNX model, else DEFAULT_MODEL_LABEL. */
  model?: string;
  dtype?: OnnxDType;
  /** Cache ROOT override (snapshot lands at <dest>/<hfRepo>/<revision>/). */
  dest?: string;
  /** From config: embedding.model / onnxEmbed overrides / resolved cache dir. */
  configModel?: string;
  configDtype?: OnnxDType;
  configRevision?: string;
  cacheDir?: string;
}

/** Pure plan builder — everything `fetch`/`status`/`--print-urls` needs,
 * with no I/O, so tests can pin URL shape and precedence without touching
 * the network or a real config. */
export function buildModelFetchPlan(opts: ModelFetchPlanOpts): ModelFetchPlan {
  const modelLabel =
    opts.model ??
    (opts.configModel && ONNX_MODEL_REGISTRY[opts.configModel] ? opts.configModel : DEFAULT_MODEL_LABEL);
  const entry = ONNX_MODEL_REGISTRY[modelLabel];
  if (!entry) {
    throw new Error(
      `unknown onnx model "${modelLabel}" — registered models: ${Object.keys(ONNX_MODEL_REGISTRY).join(', ')}`,
    );
  }
  const dtype = opts.dtype ?? opts.configDtype ?? entry.defaultDtype;
  const revision = opts.configRevision ?? entry.defaultRevision;
  const cacheRoot = opts.dest ?? opts.cacheDir;
  if (!cacheRoot) {
    throw new Error('no cache directory resolved — pass --dest or configure a real dataDir');
  }
  const snapshotDir = join(cacheRoot, entry.hfRepo, revision);
  const files = requiredSnapshotFiles(dtype).map((f) => {
    const posix = f.replaceAll('\\', '/');
    return {
      file: posix,
      url: `${HF_HOST}/${entry.hfRepo}/resolve/${revision}/${posix}`,
      dest: join(snapshotDir, f),
    };
  });
  return { modelLabel, hfRepo: entry.hfRepo, revision, dtype, snapshotDir, files };
}

/** The copy-pastable fallback recipe. Uses `curl -L --fail --create-dirs`
 * so it works verbatim in both PowerShell (curl.exe ships with Windows
 * 10+) and any POSIX shell, with no separate mkdir step. */
export function curlRecipe(plan: ModelFetchPlan): string[] {
  return plan.files.map((f) => `curl -L --fail --create-dirs -o "${f.dest}" "${f.url}"`);
}

function fileState(dest: string): 'missing' | 'empty' | 'present' {
  if (!existsSync(dest)) return 'missing';
  return statSync(dest).size > 0 ? 'present' : 'empty';
}

/** DI seam for tests — real impl streams the response body to `dest` via a
 * tmp-file + rename so an aborted download can never leave a truncated file
 * that `resolveLocalSnapshotDir` would count as a complete snapshot. */
export type FileDownloader = (url: string, dest: string) => Promise<void>;

const defaultDownloader: FileDownloader = async (url, dest) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const tmp = `${dest}.part`;
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(tmp));
    await rename(tmp, dest);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

function printStatus(plan: ModelFetchPlan): boolean {
  console.log(`model    : ${plan.modelLabel} (${plan.hfRepo}@${plan.revision.slice(0, 12)}, dtype ${plan.dtype})`);
  console.log(`snapshot : ${plan.snapshotDir}`);
  let complete = true;
  for (const f of plan.files) {
    const state = fileState(f.dest);
    if (state !== 'present') complete = false;
    console.log(`  ${state === 'present' ? '✓' : '✗'} ${f.file}  (${state})`);
  }
  console.log(
    complete
      ? '✓ snapshot complete — the daemon will load it fully offline.'
      : '✗ snapshot incomplete — run `astramem-local model fetch` (or `--print-urls` for the curl recipe).',
  );
  return complete;
}

export async function modelCommand(
  args: string[],
  downloader: FileDownloader = defaultDownloader,
): Promise<void> {
  const sub = args[0];
  if (sub !== 'fetch' && sub !== 'status') {
    console.log('usage: astramem-local model <fetch|status> [--model <label>] [--dtype q8|fp16|fp32] [--dest <dir>] [--print-urls] [--force]');
    process.exitCode = sub ? 1 : 0;
    return;
  }
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const { cfg } = resolveRuntimeConfig();
  const plan = buildModelFetchPlan({
    model: flag('--model'),
    dtype: flag('--dtype') as OnnxDType | undefined,
    dest: flag('--dest'),
    configModel: cfg.embedding.model,
    configDtype: cfg.onnxEmbed?.dtype,
    cacheDir: resolveOnnxCacheDir(cfg),
  });

  if (sub === 'status') {
    process.exitCode = printStatus(plan) ? 0 : 1;
    return;
  }

  if (args.includes('--print-urls')) {
    console.log(`# offline seed for ${plan.modelLabel} (${plan.dtype}) — run anywhere curl works, or carry the files to:`);
    console.log(`#   ${plan.snapshotDir}`);
    for (const line of curlRecipe(plan)) console.log(line);
    return;
  }

  const force = args.includes('--force');
  mkdirSync(join(plan.snapshotDir, 'onnx'), { recursive: true });
  let failed = false;
  for (const f of plan.files) {
    if (!force && fileState(f.dest) === 'present') {
      console.log(`· ${f.file} — already present, skipping (--force to re-download)`);
      continue;
    }
    console.log(`↓ ${f.file} ← ${f.url}`);
    try {
      await downloader(f.url, f.dest);
      console.log(`✓ ${f.file}`);
    } catch (err) {
      failed = true;
      console.error(`✗ ${f.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failed) {
    console.error('');
    console.error('Download failed. If curl works on this box but node does not (a known');
    console.error('local-TLS-filtering failure mode — see the 2026-07-16 outage), run:');
    for (const line of curlRecipe(buildModelFetchPlan({
      model: plan.modelLabel,
      dtype: plan.dtype,
      dest: flag('--dest'),
      cacheDir: resolveOnnxCacheDir(cfg),
    }))) {
      console.error(`  ${line}`);
    }
    process.exitCode = 1;
    return;
  }

  // Verify with the SAME resolver the daemon boots with — a green fetch that
  // the provider would not actually resolve is a lie (ADR-016: derive, don't
  // re-declare).
  const resolved = resolveLocalSnapshotDir(
    { hfModelId: plan.hfRepo, revision: plan.revision, dtype: plan.dtype, cacheDir: flag('--dest') ?? resolveOnnxCacheDir(cfg) },
  );
  if (resolved) {
    console.log(`✓ snapshot complete at ${resolved} — the daemon will load it fully offline.`);
  } else {
    console.error('✗ files downloaded but the provider does not resolve the snapshot — layout mismatch, please report this.');
    process.exitCode = 1;
  }
}
