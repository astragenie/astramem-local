import { describe, it, expect } from 'vitest';
import { detectDuplicateKey, salvageTruncatedAtoms } from '../../../src/distill/stages/parse-salvage.js';

describe('detectDuplicateKey (FEAT-552 AC-A2)', () => {
  // The measured 2026-07-16 qwen3.5 collapse shape: valid JSON whose
  // last-key-wins JSON.parse silently drops "A" and keeps only "B".
  it('detects the measured duplicate-key collapse shape {"text":"A","text":"B"}', () => {
    expect(detectDuplicateKey('{"text":"A","text":"B"}')).toBe('text');
  });

  it('returns null for ordinary JSON with no duplicate keys', () => {
    expect(detectDuplicateKey('{"atoms":[{"type":"fact","text":"hello world"}]}')).toBeNull();
  });

  it('does not false-positive on the same key name repeating at DIFFERENT nesting levels', () => {
    // Both the outer atom and the nested entity legitimately have a "name"-ish
    // key here ("type" at atom level, "kind" at entity level) — but to
    // specifically probe same-name-different-scope, use "name" at two levels.
    const nested = '{"atoms":[{"name":"outer","entities":[{"name":"inner"}]}]}';
    expect(detectDuplicateKey(nested)).toBeNull();
  });

  it('does not false-positive on a key name that also appears as a STRING VALUE elsewhere', () => {
    // "text" appears once as a key and once as a value — only key-position
    // repeats count.
    expect(detectDuplicateKey('{"text":"the word text appears here too"}')).toBeNull();
  });

  it('detects a duplicate key nested inside an atoms array entry', () => {
    const raw = '{"atoms":[{"type":"fact","text":"A","text":"B","importance":0.5,"confidence":0.5}]}';
    expect(detectDuplicateKey(raw)).toBe('text');
  });

  it('handles escaped quotes inside string values without misreading key boundaries', () => {
    expect(detectDuplicateKey('{"text":"she said \\"hi\\""}')).toBeNull();
  });
});

describe('salvageTruncatedAtoms (FEAT-552 AC-A1)', () => {
  it('recovers N-1 atoms from JSON truncated mid-object (maxTokens cutoff)', () => {
    // Three atoms intended; the response was cut off mid-way through the
    // third atom's "text" value — exactly the maxTokens mid-JSON shape.
    const truncated =
      '{"atoms":[' +
      '{"type":"fact","text":"first fact recovered cleanly","importance":0.5,"confidence":0.5},' +
      '{"type":"fact","text":"second fact recovered cleanly","importance":0.5,"confidence":0.5},' +
      '{"type":"fact","text":"third fact got cut off mid-wa';

    const result = salvageTruncatedAtoms(truncated);
    expect(result).not.toBeNull();
    expect(result!.recoveredCount).toBe(2);
    expect(result!.lostCount).toBe(1);
    expect(result!.atoms).toHaveLength(2);
    expect((result!.atoms[0] as { text: string }).text).toBe('first fact recovered cleanly');
    expect((result!.atoms[1] as { text: string }).text).toBe('second fact recovered cleanly');
  });

  it('returns null when there is no "atoms" key to anchor on', () => {
    expect(salvageTruncatedAtoms('{"something_else": [1, 2, 3')).toBeNull();
  });

  it('returns null when nothing at all could be recovered (truncated before the first complete atom)', () => {
    expect(salvageTruncatedAtoms('{"atoms":[{"type":"fact","text":"cut off before finishi')).toBeNull();
  });

  it('excludes an individual atom object containing a duplicate key rather than silently collapsing it (AC-A2 interplay)', () => {
    const raw =
      '{"atoms":[' +
      '{"type":"fact","text":"clean atom one","importance":0.5,"confidence":0.5},' +
      '{"type":"fact","text":"A","text":"B","importance":0.5,"confidence":0.5},' + // duplicate key
      '{"type":"fact","text":"clean atom two","importance":0.5,"confidence":0.5}' +
      ']}';

    const result = salvageTruncatedAtoms(raw);
    expect(result).not.toBeNull();
    expect(result!.recoveredCount).toBe(2);
    expect(result!.lostCount).toBe(1); // the duplicate-keyed atom, not silently collapsed
    expect(result!.atoms).toHaveLength(2);
    expect((result!.atoms[0] as { text: string }).text).toBe('clean atom one');
    expect((result!.atoms[1] as { text: string }).text).toBe('clean atom two');
  });

  it('lostCount is 0 when the array closes cleanly and every atom parses (no truncation, no duplicates)', () => {
    const clean =
      '{"atoms":[' +
      '{"type":"fact","text":"one","importance":0.5,"confidence":0.5},' +
      '{"type":"fact","text":"two","importance":0.5,"confidence":0.5}' +
      ']}';
    const result = salvageTruncatedAtoms(clean);
    expect(result).not.toBeNull();
    expect(result!.recoveredCount).toBe(2);
    expect(result!.lostCount).toBe(0);
  });
});
