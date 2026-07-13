import { describe, it, expect } from 'vitest';
import { ChunkCheckpointStore } from '../../src/distill/chunk-checkpoint.js';

describe('ChunkCheckpointStore', () => {
  it('returns undefined for a key that was never set', () => {
    const store = new ChunkCheckpointStore();
    expect(store.get('job-a', 'compact', 0)).toBeUndefined();
  });

  it('round-trips a value by (jobKey, stage, index)', () => {
    const store = new ChunkCheckpointStore();
    store.set('job-a', 'compact', 3, { text: 'compacted chunk 3' });
    expect(store.get('job-a', 'compact', 3)).toEqual({ text: 'compacted chunk 3' });
  });

  it('does not leak across different jobKeys', () => {
    const store = new ChunkCheckpointStore();
    store.set('job-a', 'compact', 0, { text: 'a' });
    expect(store.get('job-b', 'compact', 0)).toBeUndefined();
  });

  it('does not leak across different stages for the same job/index', () => {
    const store = new ChunkCheckpointStore();
    store.set('job-a', 'compact', 0, { text: 'compact result' });
    expect(store.get('job-a', 'extract', 0)).toBeUndefined();
  });

  it('clear(jobKey) removes only that job\'s entries', () => {
    const store = new ChunkCheckpointStore();
    store.set('job-a', 'compact', 0, { text: 'a0' });
    store.set('job-a', 'extract', 0, { atoms: [] });
    store.set('job-b', 'compact', 0, { text: 'b0' });

    store.clear('job-a');

    expect(store.get('job-a', 'compact', 0)).toBeUndefined();
    expect(store.get('job-a', 'extract', 0)).toBeUndefined();
    expect(store.get('job-b', 'compact', 0)).toEqual({ text: 'b0' });
  });

  it('evicts the oldest entry (FIFO) once the entry cap is exceeded', () => {
    const store = new ChunkCheckpointStore({ maxEntries: 3 });
    store.set('job-a', 'compact', 0, 'first');
    store.set('job-a', 'compact', 1, 'second');
    store.set('job-a', 'compact', 2, 'third');
    expect(store.size()).toBe(3);

    // Fourth insert must evict the oldest (index 0) rather than growing past the cap.
    store.set('job-a', 'compact', 3, 'fourth');

    expect(store.size()).toBe(3);
    expect(store.get('job-a', 'compact', 0)).toBeUndefined();
    expect(store.get('job-a', 'compact', 1)).toBe('second');
    expect(store.get('job-a', 'compact', 3)).toBe('fourth');
  });
});
