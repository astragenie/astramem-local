import { describe, it, expect } from 'vitest';
import { classifyDurability, gateDurability } from '../../src/distill/durability-gate.js';

// FEAT-441 AC-1: the memory#659 evidence set — 6 low-durability atoms
// spanning the fixed taxonomy (one extra ephemeral_state sample, per the
// AC's "plus one more of the same class"), plus 1 durable decision-with-
// rationale atom that must classify as null (persists).
const EVIDENCE_SET: Array<{ text: string; expected: ReturnType<typeof classifyDurability> }> = [
  { text: 'Trunk status is green.', expected: 'ephemeral_state' },
  { text: 'A task is currently running.', expected: 'ephemeral_state' }, // "one more of the same class"
  { text: 'Commit a589551 fixed the prod tag deploy blocker.', expected: 'git_derivable' },
  { text: 'No token handling identified in the auth module.', expected: 'vacuous_negative' },
  { text: 'Run memory test', expected: 'bare_todo' },
  { text: 'src/distill/stages/08-embed-index.ts:84', expected: 'path_fragment' },
];

const DURABLE_ATOM =
  'Chose PostgreSQL over MongoDB as the canonical store because of team ACID familiarity and existing tooling — mirrors ADR-001.';

describe('classifyDurability — memory#659 evidence set (AC-1)', () => {
  for (const { text, expected } of EVIDENCE_SET) {
    it(`classifies "${text}" as ${expected}`, () => {
      expect(classifyDurability(text)).toBe(expected);
    });
  }

  it('classifies a durable decision-with-rationale atom as null (persists)', () => {
    expect(classifyDurability(DURABLE_ATOM)).toBeNull();
  });
});

describe('classifyDurability — additional taxonomy coverage', () => {
  it('ephemeral_state: "is passing"', () => {
    expect(classifyDurability('The build is passing.')).toBe('ephemeral_state');
  });

  it('git_derivable: "N files changed"', () => {
    expect(classifyDurability('3 files changed in the last push.')).toBe('git_derivable');
  });

  it('vacuous_negative: "no issues found"', () => {
    expect(classifyDurability('No issues found during the review.')).toBe('vacuous_negative');
  });

  it('bare_todo: imperative with rationale is NOT gated', () => {
    expect(classifyDurability('Run the memory test because the embed dim changed and existing vectors are stale.')).toBeNull();
  });

  it('bare_todo: long imperative sentence is NOT gated (word-count guard)', () => {
    expect(classifyDurability('Update the deployment configuration across all three regions before the next release window closes')).toBeNull();
  });

  it('path_fragment: Windows path', () => {
    expect(classifyDurability('C:\\work\\mega\\astramemory-local\\src\\foo.ts')).toBe('path_fragment');
  });

  it('a path fragment embedded inside a real sentence is NOT gated', () => {
    expect(classifyDurability('The fix lives in src/distill/stages/08-embed-index.ts:84, see the PR.')).toBeNull();
  });

  it('empty/whitespace text is never gated', () => {
    expect(classifyDurability('   ')).toBeNull();
    expect(classifyDurability('')).toBeNull();
  });
});

// 2026-07-09 review HIGH fix: ephemeral_state/git_derivable/vacuous_negative
// were unanchored substring regexes with no rationale-marker exemption or
// length/dominance guard (unlike bare_todo, which had both). A rich,
// rationale-bearing DURABLE atom that merely MENTIONS a commit SHA / status
// word / negative-search phrase in passing must persist (classify null) —
// only a short atom that IS that ephemeral/git/negative statement, with no
// attached "why", should ever gate.
describe('classifyDurability — rationale-bearing durable atoms are never gated (HIGH fix regression)', () => {
  const RATIONALE_BEARING_DURABLE_ATOMS = [
    // The reviewer's exact empirically-reproduced false positive: a
    // postmortem root-cause note mentioning a commit SHA.
    'Root cause: the bug was introduced in commit a589551 which swapped embed models without updating dim validation — always add a preflight check for dim mismatches when swapping models.',
    // ephemeral_state phrase ("is currently green") wrapped in a long
    // because/so-that rationale.
    'The build is currently green because we reverted the flaky test suite that had been blocking CI for two days, so future changes to test-utils should run the flaky-detection script first.',
    // vacuous_negative phrase ("No secrets ... found") wrapped in a long
    // because rationale with an em dash.
    'No secrets were found in the audit because the redaction pipeline strips them before they reach the logs — this confirms the SEC-6 pipeline is working as designed and future audits can skip manual secret scanning.',
    // git_derivable phrase ("commit a589551") with an explicit "reason:"
    // rationale marker, medium length.
    'Commit a589551 is the fix, reason: it swapped the embed model default without a matching dim migration, causing every existing vector to silently become incompatible until reembed-dim runs.',
    // Short atom, but carries an explicit rationale marker ("because") —
    // proves the rationale-marker exemption fires independent of length.
    'Status is green because of the CI fix.',
  ];

  for (const text of RATIONALE_BEARING_DURABLE_ATOMS) {
    it(`persists (classifies null): "${text.slice(0, 60)}..."`, () => {
      expect(classifyDurability(text)).toBeNull();
    });
  }
});

describe('gateDurability — mode semantics', () => {
  it('off: never gates any pattern, regardless of content', () => {
    for (const { text } of EVIDENCE_SET) {
      expect(gateDurability(text, 'off')).toBeNull();
    }
  });

  it('strict: gates every taxonomy reason', () => {
    for (const { text, expected } of EVIDENCE_SET) {
      expect(gateDurability(text, 'strict')).toBe(expected);
    }
  });

  it('lenient: gates ephemeral_state, vacuous_negative, path_fragment', () => {
    expect(gateDurability('Trunk status is green.', 'lenient')).toBe('ephemeral_state');
    expect(gateDurability('No token handling identified in the auth module.', 'lenient')).toBe('vacuous_negative');
    expect(gateDurability('src/distill/stages/08-embed-index.ts:84', 'lenient')).toBe('path_fragment');
  });

  it('lenient: does NOT gate git_derivable or bare_todo (held back per PM pre-mortem)', () => {
    expect(gateDurability('Commit a589551 fixed the prod tag deploy blocker.', 'lenient')).toBeNull();
    expect(gateDurability('Run memory test', 'lenient')).toBeNull();
  });

  it('durable atom is never gated under any mode', () => {
    expect(gateDurability(DURABLE_ATOM, 'off')).toBeNull();
    expect(gateDurability(DURABLE_ATOM, 'lenient')).toBeNull();
    expect(gateDurability(DURABLE_ATOM, 'strict')).toBeNull();
  });
});
