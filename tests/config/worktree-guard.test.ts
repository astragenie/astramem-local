/**
 * Issue #187 — a linked git worktree must not operate on the PRODUCTION datadir.
 *
 * This is the test that would have caught the 2026-07-13 outage: an agent in a
 * worktree applied an uncommitted migration to the live prod DB, prod went to a
 * schema version that existed on no branch, and the daemon stopped booting.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertNotProdDatadirFromWorktree,
  findLinkedWorktreeRoot,
  ProdDatadirFromWorktreeError,
} from '../../src/config/worktree-guard.js';

const PROD = 'C:\\Users\\someone\\AppData\\Local\\Astramem';

let tmp: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wtguard-'));
});

afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(tmp, { recursive: true, force: true });
});

/** A linked worktree: `.git` is a FILE containing a `gitdir:` pointer. */
function makeLinkedWorktree(): string {
  const wt = join(tmp, 'wt');
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, '.git'), 'gitdir: /main/.git/worktrees/wt\n');
  return wt;
}

/** A primary checkout: `.git` is a DIRECTORY. */
function makePrimaryCheckout(): string {
  const co = join(tmp, 'primary');
  mkdirSync(join(co, '.git'), { recursive: true });
  return co;
}

describe('findLinkedWorktreeRoot', () => {
  it('detects a linked worktree (.git is a FILE)', () => {
    const wt = makeLinkedWorktree();
    expect(findLinkedWorktreeRoot(wt)).toBe(wt);
  });

  it('detects it from a NESTED subdirectory, not just the root', () => {
    const wt = makeLinkedWorktree();
    const nested = join(wt, 'src', 'deep', 'nested');
    mkdirSync(nested, { recursive: true });
    expect(findLinkedWorktreeRoot(nested)).toBe(wt);
  });

  it('returns null for a primary checkout (.git is a DIRECTORY)', () => {
    expect(findLinkedWorktreeRoot(makePrimaryCheckout())).toBeNull();
  });

  it('returns null when there is no git repo at all (npm-installed user)', () => {
    const plain = join(tmp, 'no-git');
    mkdirSync(plain, { recursive: true });
    expect(findLinkedWorktreeRoot(plain)).toBeNull();
  });
});

describe('assertNotProdDatadirFromWorktree', () => {
  const inWorktree = <T>(fn: () => T): T => {
    const wt = makeLinkedWorktree();
    const prev = process.cwd();
    process.chdir(wt);
    try {
      return fn();
    } finally {
      process.chdir(prev);
    }
  };

  it('THROWS: linked worktree + default (production) datadir — the outage case', () => {
    inWorktree(() => {
      expect(() =>
        assertNotProdDatadirFromWorktree({
          dataDir: PROD,
          dataDirSource: 'default',
          defaultDataDir: PROD,
          isolated: false,
        }),
      ).toThrow(ProdDatadirFromWorktreeError);
    });
  });

  it('THROWS with an actionable message naming the escapes', () => {
    inWorktree(() => {
      let msg = '';
      try {
        assertNotProdDatadirFromWorktree({
          dataDir: PROD, dataDirSource: 'default', defaultDataDir: PROD, isolated: false,
        });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain('ASTRA_MEMORY_DATADIR');
      expect(msg).toContain('ASTRA_MEMORY_ISOLATED');
      expect(msg).toContain('ASTRA_ALLOW_PROD_DATADIR');
      expect(msg).toContain(PROD);
    });
  });

  it('allows :memory: from a worktree', () => {
    inWorktree(() => {
      expect(() =>
        assertNotProdDatadirFromWorktree({
          dataDir: ':memory:', dataDirSource: 'default', defaultDataDir: PROD, isolated: false,
        }),
      ).not.toThrow();
    });
  });

  it('allows an explicit ASTRA_MEMORY_DATADIR (source=env) from a worktree', () => {
    inWorktree(() => {
      expect(() =>
        assertNotProdDatadirFromWorktree({
          dataDir: join(tmp, 'isolated'), dataDirSource: 'env', defaultDataDir: PROD, isolated: false,
        }),
      ).not.toThrow();
    });
  });

  it('allows an explicit --data-dir (source=cli) from a worktree', () => {
    inWorktree(() => {
      expect(() =>
        assertNotProdDatadirFromWorktree({
          dataDir: join(tmp, 'x'), dataDirSource: 'cli', defaultDataDir: PROD, isolated: false,
        }),
      ).not.toThrow();
    });
  });

  it('allows isolated mode from a worktree', () => {
    inWorktree(() => {
      expect(() =>
        assertNotProdDatadirFromWorktree({
          dataDir: PROD, dataDirSource: 'default', defaultDataDir: PROD, isolated: true,
        }),
      ).not.toThrow();
    });
  });

  it('allows the explicit ASTRA_ALLOW_PROD_DATADIR=1 opt-in from a worktree', () => {
    inWorktree(() => {
      process.env.ASTRA_ALLOW_PROD_DATADIR = '1';
      expect(() =>
        assertNotProdDatadirFromWorktree({
          dataDir: PROD, dataDirSource: 'default', defaultDataDir: PROD, isolated: false,
        }),
      ).not.toThrow();
    });
  });

  it('allows the PRIMARY checkout to use the production datadir — it IS the install source', () => {
    const co = makePrimaryCheckout();
    const prev = process.cwd();
    process.chdir(co);
    try {
      expect(() =>
        assertNotProdDatadirFromWorktree({
          dataDir: PROD, dataDirSource: 'default', defaultDataDir: PROD, isolated: false,
        }),
      ).not.toThrow();
    } finally {
      process.chdir(prev);
    }
  });

  it('allows an npm-installed user (no git repo anywhere) to use the production datadir', () => {
    const plain = join(tmp, 'npm-user');
    mkdirSync(plain, { recursive: true });
    const prev = process.cwd();
    process.chdir(plain);
    try {
      expect(() =>
        assertNotProdDatadirFromWorktree({
          dataDir: PROD, dataDirSource: 'default', defaultDataDir: PROD, isolated: false,
        }),
      ).not.toThrow();
    } finally {
      process.chdir(prev);
    }
  });

  it('does not protect a NON-default datadir from config.yaml — already a deliberate choice', () => {
    inWorktree(() => {
      expect(() =>
        assertNotProdDatadirFromWorktree({
          dataDir: join(tmp, 'custom'), dataDirSource: 'config.yaml', defaultDataDir: PROD, isolated: false,
        }),
      ).not.toThrow();
    });
  });
});
