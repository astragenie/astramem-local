import { describe, it, expect } from 'vitest';
import { normalizeAtomText, mergeDualPassAtoms, gatePassBAtoms } from '../../src/distill/dedup-merge.js';
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

describe('gatePassBAtoms', () => {
  function atomWithEntities(text: string, entities: Atom['entities']): Atom {
    return { ...atom(text), entities };
  }

  it('keeps an atom with a non-empty entities[]', () => {
    const a = atomWithEntities('Caroline talked about her plans.', [{ name: 'Caroline', kind: 'actor', subtype: 'human' }]);
    const { kept, dropped } = gatePassBAtoms([a]);
    expect(kept).toEqual([a]);
    expect(dropped).toEqual([]);
  });

  it('keeps an atom whose text contains a digit', () => {
    const a1 = atom('Caroline saved $200 for the trip.');
    const a2 = atom('Melanie has been riding for 7 years.');
    const { kept, dropped } = gatePassBAtoms([a1, a2]);
    expect(kept).toEqual([a1, a2]);
    expect(dropped).toEqual([]);
  });

  it('keeps an atom whose text contains a quoted phrase', () => {
    const a1 = atom('Melanie said "I finally feel ready" about the adoption.');
    const a2 = atom("Caroline described it as 'the best decision' she made.");
    const { kept, dropped } = gatePassBAtoms([a1, a2]);
    expect(kept).toEqual([a1, a2]);
    expect(dropped).toEqual([]);
  });

  it('does not treat a lone possessive apostrophe as a quoted phrase', () => {
    const a = atom("Caroline's dog is named Max and likes to run around the yard a lot.");
    const { kept, dropped } = gatePassBAtoms([a]);
    expect(dropped).toEqual([a]);
    expect(kept).toEqual([]);
  });

  it('keeps an atom whose text contains a month name or weekday (no digits present)', () => {
    const a1 = atom("Melanie's son visited during July for the holidays.");
    const a2 = atom('Caroline is going hiking last Friday with her sister.');
    const { kept, dropped } = gatePassBAtoms([a1, a2]);
    expect(kept).toEqual([a1, a2]);
    expect(dropped).toEqual([]);
  });

  it('drops a fully generic narrative atom with no entities, digits, quotes, or date words', () => {
    const a = atom('Melanie enjoyed the conversation and felt supported.');
    const { kept, dropped } = gatePassBAtoms([a]);
    expect(kept).toEqual([]);
    expect(dropped).toEqual([a]);
  });

  it('filters a mixed list, preserving kept-atom order', () => {
    const keepsEntities = atomWithEntities('Priya talked about her job search.', [
      { name: 'Priya', kind: 'actor', subtype: 'human' },
    ]);
    const keepsDigit = atom('The trip lasted 7 years.');
    const dropsGeneric = atom('Everyone had a nice time and felt relaxed.');
    const keepsQuote = atom('She said "it changed everything" about the move.');

    const { kept, dropped } = gatePassBAtoms([keepsEntities, keepsDigit, dropsGeneric, keepsQuote]);

    expect(kept).toEqual([keepsEntities, keepsDigit, keepsQuote]);
    expect(dropped).toEqual([dropsGeneric]);
  });

  it('returns an empty gate result for an empty input', () => {
    const { kept, dropped } = gatePassBAtoms([]);
    expect(kept).toEqual([]);
    expect(dropped).toEqual([]);
  });

  // Review findings, 2026-07-14 (b4c390d review, NEEDS_FIX) — three
  // counterexamples confirmed against the shipped predicate, fixed below.

  it('[review #1, HIGH] keeps the sweeper prompt\'s own worked example — a spelled-out frequency with no entity/digit/quote/date', () => {
    // Verbatim from EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER's few-shot
    // example 1 output (extract.ts) — the exact atom the review confirmed
    // the pre-fix predicate silently dropped.
    const a = atom("Caroline said they don't go often — usually only once or twice a year.");
    const { kept, dropped } = gatePassBAtoms([a]);
    expect(kept).toEqual([a]);
    expect(dropped).toEqual([]);
  });

  it('keeps other spelled-out cardinal/frequency/duration signals', () => {
    const cardinal = atom('Melanie has been riding for about seven years now.');
    const dozen = atom('Caroline baked a dozen cookies for the party.');
    const quantifier = atom('They have talked about it several times already.');
    const manyTimes = atom('Melanie brought it up many times during the call.');
    const cadence = atom('Caroline checks in with her sister weekly.');

    const { kept, dropped } = gatePassBAtoms([cardinal, dozen, quantifier, manyTimes, cadence]);

    expect(kept).toEqual([cardinal, dozen, quantifier, manyTimes, cadence]);
    expect(dropped).toEqual([]);
  });

  it('does not treat a bare "many" (without "times") as a signal on its own', () => {
    const a = atom('Many people feel this way about the topic in general.');
    const { kept, dropped } = gatePassBAtoms([a]);
    expect(dropped).toEqual([a]);
    expect(kept).toEqual([]);
  });

  it('[review #2, MEDIUM] drops an atom where "may" is used as a modal verb, not the month', () => {
    const a = atom('She may go to the store tomorrow.');
    const { kept, dropped } = gatePassBAtoms([a]);
    expect(dropped).toEqual([a]);
    expect(kept).toEqual([]);
  });

  it('drops "march"/"august" used as a non-month verb/adjective, keeps them capitalized as the month', () => {
    const marchVerb = atom('The team will march forward with the plan regardless.');
    const augustAdj = atom('The room had an august, dignified feel to it.');
    const marchMonth = atom('Melanie is due to give birth in March next year.');
    const augustMonth = atom('Caroline started her new job back in August.');

    const dropped1 = gatePassBAtoms([marchVerb, augustAdj]);
    expect(dropped1.kept).toEqual([]);
    expect(dropped1.dropped).toEqual([marchVerb, augustAdj]);

    const kept2 = gatePassBAtoms([marchMonth, augustMonth]);
    expect(kept2.kept).toEqual([marchMonth, augustMonth]);
    expect(kept2.dropped).toEqual([]);
  });

  it('[review #3, LOW] does not treat two independent possessives as a quoted phrase', () => {
    const a = atom('Caroline\'s dog and Melanie\'s cat are friends and get along great outdoors.');
    const { kept, dropped } = gatePassBAtoms([a]);
    // No quote signal, and no other signal (no entities/digit/spelled
    // number/date word) in this sentence either — dropped on the merits,
    // not falsely kept via a phantom quoted span between the possessives.
    expect(dropped).toEqual([a]);
    expect(kept).toEqual([]);
  });
});
