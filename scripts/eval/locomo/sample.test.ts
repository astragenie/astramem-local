import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSample } from './sample.mts';
import type { LoCoMoSample } from './lib/types.js';

function fakeSample(id: string): LoCoMoSample {
  return {
    sample_id: id,
    conversation: {
      speaker_a: 'A', speaker_b: 'B',
      session_1_date_time: '1:00 pm on 1 January, 2023',
      session_1: [{ speaker: 'A', dia_id: 'D1:1', text: 'hi' }],
    },
    qa: [
      { question: 'q0', answer: 'a0', evidence: [], category: 1 },
      { question: 'q1', answer: 'a1', evidence: [], category: 4 },
    ],
  };
}

let dir: string;
let datasetPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'locomo-sample-test-'));
  datasetPath = join(dir, 'fake-locomo.json');
  writeFileSync(datasetPath, JSON.stringify([fakeSample('c1'), fakeSample('c2'), fakeSample('c3')]));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runSample', () => {
  it('writes a deterministic sample file without touching the network (dataset already on disk)', async () => {
    const outPath = join(dir, 'sample.json');
    const logs: string[] = [];
    await runSample({ datasetPath, seed: 42, outPath, log: m => logs.push(m) });

    expect(existsSync(outPath)).toBe(true);
    const written = JSON.parse(readFileSync(outPath, 'utf8')) as LoCoMoSample[];
    expect(written).toHaveLength(3);
    expect(logs.some(l => l.includes('not re-downloaded'))).toBe(true);
  });

  it('respects --n and produces the same file content on repeat runs (same seed)', async () => {
    const outA = join(dir, 'sample-a.json');
    const outB = join(dir, 'sample-b.json');
    await runSample({ datasetPath, n: 2, seed: 7, outPath: outA });
    await runSample({ datasetPath, n: 2, seed: 7, outPath: outB });
    expect(readFileSync(outA, 'utf8')).toBe(readFileSync(outB, 'utf8'));
    expect(JSON.parse(readFileSync(outA, 'utf8'))).toHaveLength(2);
  });
});
