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

// FEAT-448 AC-1/AC-3: RATIONALE_MARKER_RE was a bare keyword-presence check,
// so an incidental marker exempted genuine junk that has no real causal
// binding to the marker. These 5 examples (FF-1 re-review, FEAT-448.md) must
// now GATE with their correct reason instead of persisting as null.
describe('classifyDurability — incidental (non-causal) markers no longer exempt (FEAT-448 AC-1)', () => {
  it('temporal "since" (a clock time) does not exempt an ephemeral_state atom', () => {
    expect(classifyDurability('The build is currently green since 3pm.')).toBe('ephemeral_state');
  });

  it('temporal "since" ("since last week") does not exempt a git_derivable atom', () => {
    expect(classifyDurability('Commit abc1234 merged since last week.')).toBe('git_derivable');
  });

  it('"because" glued onto a contentless one-word clause does not exempt', () => {
    expect(classifyDurability('It is running because deploy.')).toBe('ephemeral_state');
  });

  it('"because reasons" (self-referential, contentless) does not exempt', () => {
    expect(classifyDurability('Status is red because reasons.')).toBe('ephemeral_state');
  });

  it('a literal "--" from a CLI flag does not exempt (not dash punctuation)', () => {
    expect(classifyDurability('Build is failing --verbose flag set.')).toBe('ephemeral_state');
  });
});

// FEAT-448 fix round (review 20260712T160505Z, HIGH): the because/reason
// contentless check must be scoped per marker OCCURRENCE, not one
// whole-string existential test — otherwise a later throwaway
// "because bug."/"reason: unclear." fragment can suppress the exemption
// already earned by an earlier genuine cause in the same atom.
describe('classifyDurability — multiple because/reason occurrences (FEAT-448 fix-round HIGH)', () => {
  it('an earlier genuine cause persists even with a later contentless "because" fragment', () => {
    expect(classifyDurability('Status is red because deploy broke it because bug.')).toBeNull();
  });

  it('an earlier genuine cause persists even with a later contentless "reason:" fragment', () => {
    expect(classifyDurability('Build is green because tests passed, reason: unclear.')).toBeNull();
  });

  it('an atom where EVERY because/reason occurrence is contentless still gates', () => {
    expect(classifyDurability('Status is red because reasons, reason: stuff.')).toBe('ephemeral_state');
  });
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

  it('lenient: gates ephemeral_state, vacuous_negative, path_fragment, bare_todo', () => {
    expect(gateDurability('Trunk status is green.', 'lenient')).toBe('ephemeral_state');
    expect(gateDurability('No token handling identified in the auth module.', 'lenient')).toBe('vacuous_negative');
    expect(gateDurability('src/distill/stages/08-embed-index.ts:84', 'lenient')).toBe('path_fragment');
    // RECALL-S2: bare_todo moved OUT of the lenient holdback — see module
    // doc comment for the recorded type-carve-out-vs-content-guard decision.
    expect(gateDurability('Run memory test', 'lenient')).toBe('bare_todo');
  });

  it('lenient: does NOT gate git_derivable (held back per PM pre-mortem, unchanged by RECALL-S2)', () => {
    expect(gateDurability('Commit a589551 fixed the prod tag deploy blocker.', 'lenient')).toBeNull();
  });

  it('durable atom is never gated under any mode', () => {
    expect(gateDurability(DURABLE_ATOM, 'off')).toBeNull();
    expect(gateDurability(DURABLE_ATOM, 'lenient')).toBeNull();
    expect(gateDurability(DURABLE_ATOM, 'strict')).toBeNull();
  });
});

// RECALL-S2 (2026-07-13): widened IMPERATIVE_VERB_RE with 10 new task
// verbs found in a live-store audit of task-echo junk that slipped past
// the original 17-verb list, plus a shell-prompt-prefixed command shape
// with no leading English verb at all.
describe('classifyDurability — RECALL-S2 widened imperative verbs (Job 1)', () => {
  const NEW_VERB_JUNK: Array<{ text: string; verb: string }> = [
    { text: "Configure 'capture_source' to 'proxy'.", verb: 'configure' },
    { text: 'Approve production deployment.', verb: 'approve' },
    { text: 'Orchestrate the migration rollout.', verb: 'orchestrate' },
    { text: 'Ensure the pipeline is configured.', verb: 'ensure' },
    { text: 'Address the review comments.', verb: 'address' },
    { text: 'Raise the PR for review.', verb: 'raise' },
    { text: 'Set up the local dev environment.', verb: 'set up' },
    { text: 'Finalize the release notes.', verb: 'finalize' },
    { text: 'Search for secret redaction logic in codebase', verb: 'search' },
    { text: 'Rebuild', verb: 'rebuild' },
  ];

  for (const { text, verb } of NEW_VERB_JUNK) {
    it(`bare_todo: "${verb}" verb classifies "${text}" as bare_todo`, () => {
      expect(classifyDurability(text)).toBe('bare_todo');
    });
  }

  it('bare_todo: shell-prompt-prefixed command echo with no English verb', () => {
    expect(classifyDurability('$ bun run test')).toBe('bare_todo');
  });

  it('bare_todo: "Run full repo test suite (bun run test)." classifies as bare_todo', () => {
    expect(classifyDurability('Run full repo test suite (bun run test).')).toBe('bare_todo');
  });

  it('a new verb wrapped in a genuine rationale is NOT gated (false-positive check)', () => {
    expect(
      classifyDurability(
        "Configure 'capture_source' to 'proxy' because the daemon must distinguish agent-relayed writes from direct API calls — see ADR-012.",
      ),
    ).toBeNull();
    expect(
      classifyDurability(
        'Approve production deployment only after the migration dry-run passes, in order to avoid the FEAT-322 cursor regression.',
      ),
    ).toBeNull();
  });
});

describe('classifyDurability — RECALL-S2 widened git_derivable and ephemeral_state (Job 1)', () => {
  it('git_derivable: "N commits ahead of <branch>" phrasing', () => {
    expect(classifyDurability('There are 2 commits ahead of origin/main.')).toBe('git_derivable');
  });

  it('ephemeral_state: "ready for review" status phrase', () => {
    expect(classifyDurability('PR #485 is now ready for review.')).toBe('ephemeral_state');
  });

  it('ephemeral_state: bracket checkpoint marker', () => {
    expect(classifyDurability('[CHECKPOINT] Self-verify gates pass.')).toBe('ephemeral_state');
  });

  it('ephemeral_state: "gates failed" checkpoint phrasing', () => {
    expect(classifyDurability('Gates failed.')).toBe('ephemeral_state');
  });

  it('a rationale-bearing checkpoint/status atom is NOT gated (false-positive check)', () => {
    expect(
      classifyDurability(
        'Self-verify gates pass because the flaky retry-suite fix landed — this confirms REC-118 is closed, no further action needed.',
      ),
    ).toBeNull();
    expect(
      classifyDurability(
        'There are 2 commits ahead of origin/main because the release branch was cut early to unblock the hotfix, reason: prod incident REC-120.',
      ),
    ).toBeNull();
  });
});

// RECALL-S2 Job 2: the type-aware carve-out for `command`-typed atoms was
// deliberately REJECTED (see module doc comment) — gating stays type-blind
// and relies on content guards (word count, rationale marker) instead.
// These are the exact survive/die pairs from the RECALL-S2 evidence set,
// proving the content-based guard alone gets both right without consulting
// `mem.type`.
describe('classifyDurability — RECALL-S2 Job 2 evidence: command-type survivors vs junk', () => {
  it('SURVIVES: a genuinely reusable command clears the word-count cap', () => {
    expect(
      classifyDurability(
        'Run tests with `bunx tsc --noEmit` for both tsconfig.json and tsconfig.test.json',
      ),
    ).toBeNull();
  });

  it('SURVIVES: a short fact with no imperative-verb prefix', () => {
    expect(classifyDurability('Port 7777 is the default for this project.')).toBeNull();
  });

  it('DIES: a bare content-free command echo ("Rebuild")', () => {
    expect(classifyDurability('Rebuild')).toBe('bare_todo');
  });

  it('DIES: a bare content-free command echo ("$ bun run test")', () => {
    expect(classifyDurability('$ bun run test')).toBe('bare_todo');
  });

  it('DIES: a content-free search-task echo', () => {
    expect(classifyDurability('Search for secret redaction logic in codebase')).toBe('bare_todo');
  });
});
