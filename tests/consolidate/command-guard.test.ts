// FEAT-552 sub-scope C (AC-C1): command-token merge guard unit tests.
// Measured basis: 2026-07-18 prod audit — phi false-merged `git checkout
// A.ts` vs `B.ts` at cosine similarity 1.00.

import { describe, it, expect } from 'vitest';
import { tokenizeCommandSurface, commandGuardBlocksMerge, COMMAND_GUARD_REASON } from '../../src/consolidate/command-guard.js';

describe('tokenizeCommandSurface', () => {
  it('splits on whitespace and drops empty tokens', () => {
    expect(tokenizeCommandSurface('git   checkout   A.ts')).toEqual(new Set(['git', 'checkout', 'A.ts']));
  });

  it('normalizes backslash path separators to forward slashes', () => {
    expect(tokenizeCommandSurface('type C:\\repo\\A.ts')).toEqual(new Set(['type', 'C:/repo/A.ts']));
  });

  it('strips a single layer of surrounding quotes from each token', () => {
    expect(tokenizeCommandSurface(`git commit -m "fix bug"`)).toEqual(new Set(['git', 'commit', '-m', 'fix', 'bug']));
  });
});

describe('commandGuardBlocksMerge (AC-C1)', () => {
  it('never blocks a pair where NEITHER atom is type=command', () => {
    expect(commandGuardBlocksMerge(
      { type: 'fact', text: 'git checkout A.ts' },
      { type: 'fact', text: 'git checkout B.ts' },
    )).toBe(false);
  });

  it('blocks a command pair with the same verb but a different file argument (the measured incident)', () => {
    expect(commandGuardBlocksMerge(
      { type: 'command', text: 'git checkout A.ts' },
      { type: 'command', text: 'git checkout B.ts' },
    )).toBe(true);
  });

  it('does NOT block a command pair whose tokens are identical (byte-identical / reordered)', () => {
    expect(commandGuardBlocksMerge(
      { type: 'command', text: 'git checkout A.ts' },
      { type: 'command', text: 'git checkout A.ts' },
    )).toBe(false);
  });

  it('token-set equality ignores incidental token order (not a sequence match)', () => {
    expect(commandGuardBlocksMerge(
      { type: 'command', text: 'git checkout -- A.ts' },
      { type: 'command', text: 'git checkout A.ts --' },
    )).toBe(false);
  });

  it('blocks when only ONE atom is type=command and the other differs in tokens', () => {
    expect(commandGuardBlocksMerge(
      { type: 'command', text: 'npm run build' },
      { type: 'note', text: 'npm run test' },
    )).toBe(true);
  });

  it('exposes a stable reason string', () => {
    expect(COMMAND_GUARD_REASON).toBe('command-token-mismatch');
  });
});
