import { describe, it, expect } from 'vitest';
import { normalizeAtomText, mergeDualPassAtoms } from '../../src/distill/dedup-merge.js';
import type { Atom } from '../../src/distill/prompts/extract.js';

function atom(text: string, type: Atom['type'] = 'fact'): Atom {
  return { type, text, importance: 0.5, confidence: 0.8 };
}

describe('normalizeAtomText', () => {
  it('lowercases and strips punctuation/whitespace', () => {
    expect(normalizeAtomText('Once or twice a year.')).toBe('onceortwiceayear');
    expect(normalizeAtomText('once, or twice a year')).toBe('onceortwiceayear');
  });

  it('collapses case+punctuation variants to the same key', () => {
    const a = normalizeAtomText("Caroline's dog is named Max!");
    const b = normalizeAtomText('carolines dog is named max');
    expect(a).toBe(b);
  });
});

describe('mergeDualPassAtoms', () => {
  it('drops an exact-normalized duplicate, keeping pass A (processed first)', () => {
    const passA = [atom('Melanie goes horseback riding once or twice a year.')];
    const passB = [atom('melanie goes horseback riding once or twice a year')];

    const { merged, dedupedAway } = mergeDualPassAtoms(passA, passB);

    expect(merged.length).toBe(1);
    expect(merged[0]).toBe(passA[0]); // pass A's atom object survives, not pass B's
    expect(dedupedAway).toBe(1);
  });

  it('drops a case/punctuation-variant duplicate the same as an exact one', () => {
    const passA = [atom('The event store used Postgres for six months.')];
    const passB = [atom('the event store used postgres for six months')];

    const { merged, dedupedAway } = mergeDualPassAtoms(passA, passB);

    expect(merged.length).toBe(1);
    expect(dedupedAway).toBe(1);
  });

  it('drops a pass-B atom that is a strict substring of a pass-A atom, keeping the longer pass-A atom', () => {
    const longer = atom('Caroline went horseback riding with her dad every summer growing up in Colorado.');
    const shorter = atom('Caroline went horseback riding with her dad.');

    const { merged, dedupedAway } = mergeDualPassAtoms([longer], [shorter]);

    expect(merged.length).toBe(1);
    expect(merged[0]).toBe(longer);
    expect(dedupedAway).toBe(1);
  });

  it('keeps the longer pass-B atom, replacing a shorter pass-A atom it is a superset of', () => {
    const shorter = atom('Caroline went horseback riding.');
    const longer = atom('Caroline went horseback riding with her dad every summer growing up in Colorado.');

    const { merged, dedupedAway } = mergeDualPassAtoms([shorter], [longer]);

    expect(merged.length).toBe(1);
    expect(merged[0]).toBe(longer);
    expect(dedupedAway).toBe(1);
  });

  it('preserves disjoint atoms from both passes', () => {
    const passA = [atom('Caroline is adopting a child.')];
    const passB = [atom('Melanie goes horseback riding once or twice a year.')];

    const { merged, dedupedAway } = mergeDualPassAtoms(passA, passB);

    expect(merged.length).toBe(2);
    expect(dedupedAway).toBe(0);
    expect(merged).toEqual(expect.arrayContaining([passA[0], passB[0]]));
  });

  it('handles a mix of exact dup, substring dup, and disjoint atoms in one merge', () => {
    const passA = [
      atom('Caroline is adopting a child.'),
      atom('Melanie goes horseback riding.'),
    ];
    const passB = [
      atom('caroline is adopting a child'), // exact dup of passA[0]
      atom('Melanie goes horseback riding once or twice a year.'), // superset of passA[1]
      atom('Caroline saw a sign that said Trans Lives Matter.'), // disjoint
    ];

    const { merged, dedupedAway } = mergeDualPassAtoms(passA, passB);

    expect(dedupedAway).toBe(2);
    expect(merged.length).toBe(3);
    const texts = merged.map((a) => a.text);
    expect(texts).toContain('Caroline is adopting a child.');
    expect(texts).toContain('Melanie goes horseback riding once or twice a year.');
    expect(texts).toContain('Caroline saw a sign that said Trans Lives Matter.');
  });

  it('returns an empty merge for two empty passes', () => {
    const { merged, dedupedAway } = mergeDualPassAtoms([], []);
    expect(merged).toEqual([]);
    expect(dedupedAway).toBe(0);
  });

  it('passes through pass A untouched when pass B is empty', () => {
    const passA = [atom('a fact'), atom('another fact')];
    const { merged, dedupedAway } = mergeDualPassAtoms(passA, []);
    expect(merged).toEqual(passA);
    expect(dedupedAway).toBe(0);
  });
});
