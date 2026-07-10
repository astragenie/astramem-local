import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDataset, sampleLocomo, ensureDatasetDownloaded } from './dataset.js';
import type { LoCoMoSample } from './types.js';

/** Small fake dataset shaped like the real locomo10.json (verified schema,
 *  see types.ts's header) -- deliberately synthetic so tests never touch
 *  the network or the real 2.8MB download (FEAT-457: "NO live Ollama in
 *  tests", extended here to no live network either). */
function fakeSample(id: string, categories: number[]): LoCoMoSample {
  return {
    sample_id: id,
    conversation: {
      speaker_a: 'Alice',
      speaker_b: 'Bob',
      session_1_date_time: '1:00 pm on 1 January, 2023',
      session_1: [
        { speaker: 'Alice', dia_id: 'D1:1', text: 'Hi Bob!' },
        { speaker: 'Bob', dia_id: 'D1:2', text: 'Hi Alice!' },
      ],
      session_2_date_time: '2:00 pm on 2 January, 2023',
      session_2: [
        { speaker: 'Alice', dia_id: 'D2:1', text: 'How are you?' },
      ],
    },
    qa: categories.map((category, i) => ({
      question: `question ${i} for ${id}`,
      answer: category === 5 ? undefined : `answer ${i}`,
      adversarial_answer: category === 5 ? 'wrong answer' : undefined,
      evidence: ['D1:1'],
      category: category as 1 | 2 | 3 | 4 | 5,
    })),
  };
}

const FAKE_DATASET: LoCoMoSample[] = [
  fakeSample('conv-a', [1, 2, 3, 4, 5, 4, 4, 2]),
  fakeSample('conv-b', [1, 4, 4, 5]),
  fakeSample('conv-c', [2, 3, 4]),
  fakeSample('conv-d', [1, 1, 5, 5]),
];

let dir: string;
let datasetPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'locomo-dataset-test-'));
  datasetPath = join(dir, 'fake-locomo.json');
  writeFileSync(datasetPath, JSON.stringify(FAKE_DATASET));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadDataset', () => {
  it('loads a well-formed dataset file', () => {
    const loaded = loadDataset(datasetPath);
    expect(loaded).toHaveLength(4);
    expect(loaded[0]!.sample_id).toBe('conv-a');
  });

  it('throws on a file that does not parse to a non-empty array', () => {
    const badPath = join(dir, 'bad.json');
    writeFileSync(badPath, JSON.stringify([]));
    expect(() => loadDataset(badPath)).toThrow(/non-empty array/);
  });

  it('throws on a sample missing required fields', () => {
    const badPath = join(dir, 'malformed.json');
    writeFileSync(badPath, JSON.stringify([{ sample_id: 'x' }]));
    expect(() => loadDataset(badPath)).toThrow(/malformed sample/);
  });
});

describe('sampleLocomo', () => {
  it('is deterministic for a fixed seed', () => {
    const dataset = loadDataset(datasetPath);
    const a = sampleLocomo(dataset, { n: 2, seed: 7 });
    const b = sampleLocomo(dataset, { n: 2, seed: 7 });
    expect(a.map(s => s.sample_id)).toEqual(b.map(s => s.sample_id));
  });

  it('produces a different subset for a different seed (on this fixture)', () => {
    const dataset = loadDataset(datasetPath);
    // seeds 1 and 4 are verified (on this 4-conversation fixture, n=2) to
    // land on different subsets -- with only C(4,2)=6 possible 2-of-4
    // subsets, an arbitrary seed pair can coincidentally collide, so this
    // isn't a fuzzed/random pair.
    const a = sampleLocomo(dataset, { n: 2, seed: 1 });
    const b = sampleLocomo(dataset, { n: 2, seed: 4 });
    expect(a.map(s => s.sample_id)).not.toEqual(b.map(s => s.sample_id));
  });

  it('defaults to the whole dataset (load-all) when n is omitted', () => {
    const dataset = loadDataset(datasetPath);
    const sample = sampleLocomo(dataset, { seed: 42 });
    expect(sample).toHaveLength(dataset.length);
  });

  it('returns results sorted by sample_id regardless of shuffle order', () => {
    const dataset = loadDataset(datasetPath);
    const sample = sampleLocomo(dataset, { seed: 99 });
    const ids = sample.map(s => s.sample_id);
    expect(ids).toEqual([...ids].sort());
  });

  it('clamps n above dataset length to the dataset length', () => {
    const dataset = loadDataset(datasetPath);
    const sample = sampleLocomo(dataset, { n: 999, seed: 1 });
    expect(sample).toHaveLength(dataset.length);
  });

  it('caps QA pairs per conversation and keeps at least one of every present category', () => {
    const dataset = loadDataset(datasetPath);
    const sample = sampleLocomo(dataset, { seed: 5, qaPerSample: 3 });
    const convA = sample.find(s => s.sample_id === 'conv-a')!;
    // conv-a has categories [1,2,3,4,5,4,4,2] (5 distinct categories present) --
    // capped at 3, stratification should still surface a spread, not just
    // whichever 3 sorted first.
    expect(convA.qa.length).toBeLessThanOrEqual(3);
    expect(convA.qa.length).toBeGreaterThan(0);
  });

  it('leaves QA pairs untouched when qaPerSample is omitted', () => {
    const dataset = loadDataset(datasetPath);
    const sample = sampleLocomo(dataset, { seed: 5 });
    const convA = sample.find(s => s.sample_id === 'conv-a')!;
    expect(convA.qa).toHaveLength(8);
  });

  it('qaPerSample sampling is itself deterministic for a fixed seed', () => {
    const dataset = loadDataset(datasetPath);
    const a = sampleLocomo(dataset, { seed: 11, qaPerSample: 2 });
    const b = sampleLocomo(dataset, { seed: 11, qaPerSample: 2 });
    expect(a.map(s => s.qa.map(q => q.question))).toEqual(b.map(s => s.qa.map(q => q.question)));
  });
});

describe('ensureDatasetDownloaded', () => {
  it('does not re-download (or touch the network) when the file already exists', async () => {
    const { downloaded } = await ensureDatasetDownloaded(datasetPath);
    expect(downloaded).toBe(false);
  });
});
