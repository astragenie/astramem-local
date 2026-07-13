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
  /**
   * REGRESSION — the extract_profile cache-poisoning bug (found in review
   * 2026-07-13, before ship).
   *
   * jobKey is a sha256 of transcript CONTENT ONLY. SLICE-434 made
   * `extract_profile` a per-transcript-row field, and ingest has no
   * content-based dedup — so two rows with byte-identical content but
   * different profiles are normal. `clear()` only fires on terminal SUCCESS,
   * and a BudgetExceeded job PAUSES indefinitely rather than retrying, so a
   * paused job's chunks linger.
   *
   * Without the profile in the key, job B (conversational) silently reads back
   * job A's (engineering) atoms — extracted under the WRONG prompt. No error,
   * no log line, wrong data persisted. Reachable at the default concurrency=1.
   */
  it('does NOT leak a cached chunk across extract profiles with identical content', () => {
    const store = new ChunkCheckpointStore();
    const sourceHash = 'same-content-hash'; // identical transcript bytes -> identical jobKey

    store.set(sourceHash, 'extract', 0, 'ENGINEERING-atoms', 'engineering');

    // The conversational run MUST NOT see the engineering run's result.
    expect(store.get(sourceHash, 'extract', 0, 'conversational')).toBeUndefined();

    // ...and the engineering run still gets its own back (the fix must not
    // break the actual amplification fix it is guarding).
    expect(store.get(sourceHash, 'extract', 0, 'engineering')).toBe('ENGINEERING-atoms');

    // Both coexist rather than clobbering each other.
    store.set(sourceHash, 'extract', 0, 'CONVERSATIONAL-atoms', 'conversational');
    expect(store.get(sourceHash, 'extract', 0, 'engineering')).toBe('ENGINEERING-atoms');
    expect(store.get(sourceHash, 'extract', 0, 'conversational')).toBe('CONVERSATIONAL-atoms');
  });

  it('clear(jobKey) drops EVERY variant for that job, not just one', () => {
    const store = new ChunkCheckpointStore();
    store.set('job-a', 'extract', 0, 'eng', 'engineering');
    store.set('job-a', 'extract', 0, 'conv', 'conversational');
    store.set('job-a', 'compact', 0, 'compacted'); // no variant
    expect(store.size()).toBe(3);

    store.clear('job-a');

    expect(store.size()).toBe(0);
    expect(store.get('job-a', 'extract', 0, 'engineering')).toBeUndefined();
    expect(store.get('job-a', 'extract', 0, 'conversational')).toBeUndefined();
  });
});
