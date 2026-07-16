import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { buildModelFetchPlan, curlRecipe } from '../../src/cli/model.js';
import {
  DEFAULT_ONNX_HF_MODEL_ID,
  DEFAULT_ONNX_REVISION,
  ONNX_MODEL_REGISTRY,
} from '../../src/providers/embed/onnx.js';

// `model fetch` exists so offline/air-gapped installs (and boxes whose local
// TLS filtering breaks node fetch but not curl — the 2026-07-16 outage class)
// have a documented seed path instead of tribal knowledge. These tests pin
// the plan/URL shape; the download itself is a DI seam.
describe('cli model — buildModelFetchPlan()', () => {
  const CACHE = join('C:', 'data', 'models', 'onnx');

  it('defaults to the registry default model, dtype, and pinned revision', () => {
    const plan = buildModelFetchPlan({ cacheDir: CACHE });
    expect(plan.modelLabel).toBe('mxbai-embed-large-v1');
    expect(plan.hfRepo).toBe(DEFAULT_ONNX_HF_MODEL_ID);
    expect(plan.revision).toBe(DEFAULT_ONNX_REVISION);
    expect(plan.dtype).toBe('q8');
    expect(plan.snapshotDir).toBe(join(CACHE, DEFAULT_ONNX_HF_MODEL_ID, DEFAULT_ONNX_REVISION));
  });

  it('URLs use the pinned revision and POSIX separators even for the onnx/ subpath', () => {
    const plan = buildModelFetchPlan({ cacheDir: CACHE });
    const model = plan.files.find((f) => f.file.endsWith('.onnx'))!;
    expect(model.file).toBe('onnx/model_quantized.onnx');
    expect(model.url).toBe(
      `https://huggingface.co/${DEFAULT_ONNX_HF_MODEL_ID}/resolve/${DEFAULT_ONNX_REVISION}/onnx/model_quantized.onnx`,
    );
    // No backslash may ever leak into a URL on win32.
    for (const f of plan.files) expect(f.url).not.toContain('\\');
  });

  it('covers exactly the 4 files the daemon-side resolver requires', () => {
    const plan = buildModelFetchPlan({ cacheDir: CACHE });
    expect(plan.files.map((f) => f.file).sort()).toEqual(
      ['config.json', 'onnx/model_quantized.onnx', 'tokenizer.json', 'tokenizer_config.json'].sort(),
    );
  });

  it('dtype flag switches the artifact filename', () => {
    const plan = buildModelFetchPlan({ cacheDir: CACHE, dtype: 'fp16' });
    expect(plan.files.some((f) => f.file === 'onnx/model_fp16.onnx')).toBe(true);
  });

  it('precedence: explicit --model beats config model beats default; unregistered config model falls back to default', () => {
    expect(buildModelFetchPlan({ cacheDir: CACHE, model: 'bge-m3', configModel: 'mxbai-embed-large-v1' }).hfRepo).toBe(
      ONNX_MODEL_REGISTRY['bge-m3']!.hfRepo,
    );
    expect(buildModelFetchPlan({ cacheDir: CACHE, configModel: 'bge-m3' }).modelLabel).toBe('bge-m3');
    // config.embedding.model may name an OLLAMA model (e.g. the label used
    // before an onnx switch) — must not throw, must fall back to the default.
    expect(buildModelFetchPlan({ cacheDir: CACHE, configModel: 'nomic-embed-text' }).modelLabel).toBe(
      'mxbai-embed-large-v1',
    );
  });

  it('--dest overrides the config cache dir', () => {
    const plan = buildModelFetchPlan({ cacheDir: CACHE, dest: join('X:', 'seed') });
    expect(plan.snapshotDir).toBe(join('X:', 'seed', DEFAULT_ONNX_HF_MODEL_ID, DEFAULT_ONNX_REVISION));
  });

  it('throws on an unknown explicit --model (never silently substitutes)', () => {
    expect(() => buildModelFetchPlan({ cacheDir: CACHE, model: 'no-such-model' })).toThrow(/registered models/);
  });

  it('throws when no cache dir resolves at all', () => {
    expect(() => buildModelFetchPlan({})).toThrow(/--dest/);
  });

  it('rejects an invalid --dtype loudly (never a silent "model undefined.onnx" URL)', () => {
    expect(() => buildModelFetchPlan({ cacheDir: CACHE, dtype: 'q4' })).toThrow(/invalid --dtype "q4"/);
  });

  // #363-review 🔴: when config.onnxEmbed.modelPath is set, the daemon
  // consults ONLY modelPath — the seed MUST target it, or fetch prints a
  // false green while daemon boot throws.
  it('config modelPath beats cacheDir as the seed root (matches daemon exclusivity)', () => {
    const mp = join('D:', 'airgap');
    const plan = buildModelFetchPlan({ cacheDir: CACHE, configModelPath: mp });
    expect(plan.snapshotDir).toBe(join(mp, DEFAULT_ONNX_HF_MODEL_ID, DEFAULT_ONNX_REVISION));
  });

  it('--dest still beats config modelPath (explicit CLI override)', () => {
    const plan = buildModelFetchPlan({
      cacheDir: CACHE,
      configModelPath: join('D:', 'airgap'),
      dest: join('E:', 'seed'),
    });
    expect(plan.snapshotDir).toBe(join('E:', 'seed', DEFAULT_ONNX_HF_MODEL_ID, DEFAULT_ONNX_REVISION));
  });
});

describe('cli model — curlRecipe()', () => {
  it('emits one self-contained curl per file (works verbatim in PowerShell and POSIX shells)', () => {
    const plan = buildModelFetchPlan({ cacheDir: join('C:', 'data', 'models', 'onnx') });
    const lines = curlRecipe(plan);
    expect(lines).toHaveLength(plan.files.length);
    for (const line of lines) {
      expect(line).toMatch(/^curl -L --fail --create-dirs -o ".+" "https:\/\/huggingface\.co\/.+"$/);
    }
  });
});
