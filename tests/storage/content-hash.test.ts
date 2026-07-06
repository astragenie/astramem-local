// astramem-local#84: single source of truth for the content-hash digest
// used as the memories dedup key and mirrored into memory_events.content_hash.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { contentHash } from '../../src/storage/content-hash.js';

describe('contentHash', () => {
  it('returns a full 64-char lowercase-hex sha256 digest', () => {
    const h = contentHash('hello world');
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it('matches crypto.createHash sha256 hex over utf8, unmodified', () => {
    const text = 'astramem-local#84: canonical content hash';
    const expected = createHash('sha256').update(text, 'utf8').digest('hex');
    expect(contentHash(text)).toBe(expected);
  });

  it('is deterministic for the same input', () => {
    expect(contentHash('same text')).toBe(contentHash('same text'));
  });

  it('differs for different input (no truncation collisions expected)', () => {
    expect(contentHash('text A')).not.toBe(contentHash('text B'));
  });

  it('is NOT the legacy 32-char truncation some call sites used before #84', () => {
    const text = 'legacy call site text';
    const legacy32 = createHash('sha256').update(text).digest('hex').slice(0, 32);
    const h = contentHash(text);
    expect(h).not.toBe(legacy32);
    expect(h.length).toBe(64);
    // the legacy 32-char value IS the leading prefix of the canonical hash —
    // this is the dedup-safety property migrations/015 relies on.
    expect(h.startsWith(legacy32)).toBe(true);
  });
});
