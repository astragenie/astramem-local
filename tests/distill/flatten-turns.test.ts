import { describe, it, expect } from 'vitest';
import { flattenTranscriptContent } from '../../src/distill/flatten-turns.js';
import { chunk } from '../../src/distill/stages/03-chunk.js';

/** Mirrors src/distill/stages/03-chunk.ts TURN_BOUNDARY_RE exactly. */
const TURN_BOUNDARY_RE = /^(user|assistant|system|human|ai)\s*:/i;

describe('flattenTranscriptContent (D-DEF1)', () => {
  it('flattens a canonical JSON turns array into role-attributed "role: text" lines', () => {
    const turns = [
      { role: 'user', text: 'what vector store should we use?' },
      { role: 'assistant', text: 'sqlite-vec — no network dependency.' },
    ];
    const raw = JSON.stringify(turns); // exactly what ingest.ts stores in transcripts.content

    // Reproduce the defect: raw JSON.stringify output is a single line with
    // no role-prefixed boundaries — the pipeline's turn detector never fires.
    const rawLines = raw.split('\n');
    expect(rawLines).toHaveLength(1);
    expect(TURN_BOUNDARY_RE.test(rawLines[0]!)).toBe(false);

    const flattened = flattenTranscriptContent(raw);

    // Fixed output: each turn is its own role-prefixed line.
    const lines = flattened.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('user: what vector store should we use?');
    expect(lines[1]).toBe('assistant: sqlite-vec — no network dependency.');
    expect(TURN_BOUNDARY_RE.test(lines[0]!)).toBe(true);
    expect(TURN_BOUNDARY_RE.test(lines[1]!)).toBe(true);
  });

  it('produces stage-3 chunk input that preserves turn boundaries and role attribution', () => {
    const turns = [
      { role: 'user', text: 'why not pgvector?' },
      { role: 'assistant', text: 'PostgreSQL adds a service dependency we do not want.' },
      { role: 'user', text: 'ok, and the embedding dimension?' },
      { role: 'assistant', text: 'pinned at 1024 system-wide.' },
    ];
    const raw = JSON.stringify(turns);

    // Defect reproduction: feeding the raw JSON straight into stage 3 collapses
    // everything into a single opaque "turn" (no role markers survive).
    const brokenChunks = chunk(raw);
    expect(brokenChunks).toHaveLength(1);
    expect(brokenChunks[0]!.text.startsWith('user:')).toBe(false);

    // Fixed: flatten first, then stage 3 sees 4 distinct role-attributed turns
    // packed into chunk(s) — none of the role markers are lost.
    const flattened = flattenTranscriptContent(raw);
    const fixedChunks = chunk(flattened);
    const joined = fixedChunks.map(c => c.text).join('\n');
    for (const turn of turns) {
      expect(joined).toContain(`${turn.role}: ${turn.text}`);
    }
  });

  it('passes legacy plain-text content through unchanged', () => {
    const legacy = 'user: hi\nassistant: hello';
    expect(flattenTranscriptContent(legacy)).toBe(legacy);
  });

  it('passes through JSON that is not a turns array (defensive fallback)', () => {
    const other = JSON.stringify({ foo: 'bar' });
    expect(flattenTranscriptContent(other)).toBe(other);

    const otherArray = JSON.stringify([{ foo: 'bar' }]);
    expect(flattenTranscriptContent(otherArray)).toBe(otherArray);
  });

  it('passes through an empty turns array unchanged', () => {
    const empty = JSON.stringify([]);
    expect(flattenTranscriptContent(empty)).toBe(empty);
  });
});
