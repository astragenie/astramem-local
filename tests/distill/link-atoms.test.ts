import { describe, it, expect } from 'vitest';
import { linkAtoms } from '../../src/distill/link-atoms.js';
import type { ReducedAtom } from '../../src/distill/stages/06-reduce.js';

function makeAtom(overrides: Partial<ReducedAtom> & { contentHash: string; text: string }): ReducedAtom {
  return {
    type: 'fact',
    importance: 0.5,
    confidence: 0.8,
    ...overrides,
  } as ReducedAtom;
}

describe('linkAtoms', () => {
  it('returns [] for fewer than 2 atoms', () => {
    expect(linkAtoms([])).toEqual([]);
    expect(linkAtoms([makeAtom({ contentHash: 'h1', text: 'solo atom' })])).toEqual([]);
  });

  it('links two atoms that share a normalized entity as shared_entity', () => {
    const atoms: ReducedAtom[] = [
      makeAtom({
        contentHash: 'h1', text: 'Sergey works at Anthropic.',
        entities: [{ name: 'Sergey', kind: 'actor' }, { name: 'Anthropic', kind: 'org' }],
      }),
      makeAtom({
        contentHash: 'h2', text: 'Sergey enjoys hiking on weekends.',
        entities: [{ name: 'sergey', kind: 'actor' }], // different casing — normalized
      }),
    ];
    const links = linkAtoms(atoms);
    const sharedEntity = links.find(l => l.linkType === 'shared_entity');
    expect(sharedEntity).toBeDefined();
    expect(sharedEntity!.evidence).toBe('sergey');
    expect(sharedEntity!.contentHashA === 'h1' || sharedEntity!.contentHashB === 'h1').toBe(true);
    expect(sharedEntity!.contentHashA === 'h2' || sharedEntity!.contentHashB === 'h2').toBe(true);
  });

  it('does NOT link two atoms that share no entities and are not adjacent', () => {
    const atoms: ReducedAtom[] = [
      makeAtom({ contentHash: 'h1', text: 'first atom', entities: [{ name: 'Alice', kind: 'actor' }] }),
      makeAtom({ contentHash: 'h2', text: 'padding atom, no shared entity' }),
      makeAtom({ contentHash: 'h3', text: 'padding atom two, no shared entity' }),
      makeAtom({ contentHash: 'h4', text: 'far atom', entities: [{ name: 'Bob', kind: 'actor' }] }),
    ];
    const links = linkAtoms(atoms);
    const entityLinks = links.filter(l => l.linkType !== 'session_proximity');
    expect(entityLinks).toHaveLength(0);
  });

  it('upgrades a shared-entity link to possession_family when family-relation language is present', () => {
    const atoms: ReducedAtom[] = [
      makeAtom({
        contentHash: 'h1', text: "Sergey's daughter Alice is starting kindergarten in September.",
        entities: [{ name: 'Sergey', kind: 'actor' }, { name: 'Alice', kind: 'actor' }],
      }),
      makeAtom({
        contentHash: 'h2', text: 'Alice attended a Montessori preschool for two years.',
        entities: [{ name: 'Alice', kind: 'actor' }],
      }),
    ];
    const links = linkAtoms(atoms);
    const familyLink = links.find(l => l.contentHashA === 'h1' || l.contentHashB === 'h1')
      && links.find(l => (l.contentHashA === 'h1' || l.contentHashB === 'h1') && (l.contentHashA === 'h2' || l.contentHashB === 'h2'));
    const alicePair = links.find(l => l.evidence === 'alice');
    expect(alicePair).toBeDefined();
    expect(alicePair!.linkType).toBe('possession_family');
  });

  it('upgrades a shared-entity link to event_participant when either atom is type=event', () => {
    const atoms: ReducedAtom[] = [
      makeAtom({
        contentHash: 'h1', type: 'event', text: "Alice's graduation ceremony was held in June.",
        entities: [{ name: 'Alice', kind: 'actor' }],
      }),
      makeAtom({
        contentHash: 'h2', text: 'Alice studied biology in college.',
        entities: [{ name: 'Alice', kind: 'actor' }],
      }),
    ];
    const links = linkAtoms(atoms);
    const alicePair = links.find(l => l.evidence === 'alice');
    expect(alicePair).toBeDefined();
    expect(alicePair!.linkType).toBe('event_participant');
  });

  it('skips a generic entity that appears in more than GENERIC_ENTITY_MAX_OCCURRENCES atoms', () => {
    const atoms: ReducedAtom[] = Array.from({ length: 20 }, (_, i) =>
      makeAtom({
        contentHash: `h${i}`,
        text: `atom number ${i} about Sergey`,
        entities: [{ name: 'Sergey', kind: 'actor' }],
      }));
    const links = linkAtoms(atoms);
    const entityLinks = links.filter(l => l.linkType !== 'session_proximity');
    expect(entityLinks).toHaveLength(0);
  });

  it('links adjacent atoms as session_proximity even with no shared entity', () => {
    const atoms: ReducedAtom[] = [
      makeAtom({ contentHash: 'h1', text: 'first fact, no entities' }),
      makeAtom({ contentHash: 'h2', text: 'second fact, no entities' }),
    ];
    const links = linkAtoms(atoms);
    expect(links).toHaveLength(1);
    expect(links[0]!.linkType).toBe('session_proximity');
    expect(links[0]!.contentHashA).toBe('h1');
    expect(links[0]!.contentHashB).toBe('h2');
  });

  it('does not link non-adjacent atoms as session_proximity (window = 1)', () => {
    const atoms: ReducedAtom[] = [
      makeAtom({ contentHash: 'h1', text: 'atom one' }),
      makeAtom({ contentHash: 'h2', text: 'atom two' }),
      makeAtom({ contentHash: 'h3', text: 'atom three' }),
    ];
    const links = linkAtoms(atoms);
    const proximityPairs = links
      .filter(l => l.linkType === 'session_proximity')
      .map(l => [l.contentHashA, l.contentHashB].sort().join('-'));
    expect(proximityPairs).toContain('h1-h2');
    expect(proximityPairs).toContain('h2-h3');
    expect(proximityPairs).not.toContain('h1-h3');
  });

  it('every candidate carries non-empty provenance and positive confidence', () => {
    const atoms: ReducedAtom[] = [
      makeAtom({ contentHash: 'h1', text: 'atom one', entities: [{ name: 'Alice', kind: 'actor' }] }),
      makeAtom({ contentHash: 'h2', text: 'atom two', entities: [{ name: 'Alice', kind: 'actor' }] }),
    ];
    const links = linkAtoms(atoms);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.evidence.length).toBeGreaterThan(0);
      expect(link.confidence).toBeGreaterThan(0);
    }
  });
});
