import { describe, it, expect } from 'vitest';
import { buildFullSuiteArgs, FULL_SUITE_DEFAULT_FLAGS } from './full-suite.mts';

describe('buildFullSuiteArgs', () => {
  it('with no overrides, emits every default flag and never sets --n/--qa-per-sample', () => {
    const args = buildFullSuiteArgs([]);
    for (const [flag, value] of FULL_SUITE_DEFAULT_FLAGS) {
      const i = args.indexOf(flag);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(args[i + 1]).toBe(value);
    }
    expect(args).not.toContain('--n');
    expect(args).not.toContain('--qa-per-sample');
  });

  it('an extraArg naming a default REPLACES its value, without duplicating the flag', () => {
    const args = buildFullSuiteArgs(['--k', '10']);
    const occurrences = args.filter(a => a === '--k').length;
    expect(occurrences).toBe(1);
    expect(args[args.indexOf('--k') + 1]).toBe('10');
  });

  it('an extraArg not naming a default is appended verbatim, alongside every default', () => {
    const args = buildFullSuiteArgs(['--shards', '2']);
    expect(args).toContain('--shards');
    expect(args[args.indexOf('--shards') + 1]).toBe('2');
    // Defaults are untouched.
    expect(args[args.indexOf('--k') + 1]).toBe('15');
  });

  it('a boolean-style extraArg (no value) is appended and does not swallow the next default', () => {
    const args = buildFullSuiteArgs(['--cross-encoder']);
    expect(args).toContain('--cross-encoder');
    expect(args[args.indexOf('--k') + 1]).toBe('15');
  });

  it('mixes an override with unrelated passthrough flags correctly', () => {
    const args = buildFullSuiteArgs(['--seed', '7', '--shards', '3', '--diagnose']);
    expect(args.filter(a => a === '--seed').length).toBe(1);
    expect(args[args.indexOf('--seed') + 1]).toBe('7');
    expect(args).toContain('--shards');
    expect(args).toContain('--diagnose');
    // Every other default still present.
    expect(args[args.indexOf('--k') + 1]).toBe('15');
    expect(args[args.indexOf('--extract-profile') + 1]).toBe('conversational');
  });
});
