/**
 * tests/cli/reinstall.test.ts
 *
 * FEAT-438 SLICE-417 review HIGH finding: `reinstallCommand` repoints
 * current.json at a freshly-materialized release BEFORE it has proven
 * itself healthy. Every failure branch that can occur after that repoint
 * (install-service throw, start-service throw, health-check timeout, a
 * served-version mismatch, and a /version fetch throw) MUST restore the
 * prior pointer — otherwise the keepalive/restart policy restarts against a
 * broken pointer forever (the exact silent-daemon-down outage class this
 * command exists to close).
 *
 * `reinstallCommand` itself is not practically unit-testable in isolation
 * (it drives real installServiceFlow/the OS scheduler, real fetch, real
 * process exit) — per the review's own note, the fix is to extract the one
 * piece that IS the restore *decision*: `restorePriorPointer(priorPointer,
 * pointerPath)`. Every failure branch in reinstallCommand now calls this
 * exact function (see src/cli/reinstall.ts), so exhaustively testing its
 * behavior here covers the restore outcome for all five failure branches —
 * they differ only in *which* trigger fired, never in what "restore" means
 * once triggered.
 *
 * FEAT-443 SLICE-1: `restorePriorPointer` used to early-return on non-win32
 * (current.json indirection was Windows-only). It is now cross-platform —
 * the function no longer takes a `platform` parameter at all, and restores
 * identically regardless of host OS. The win32-labeled scenarios below are
 * unchanged in behavior/messages (byte-identical); the former
 * "non-Windows platform: no-op" test is replaced with linux/darwin restore
 * scenarios that now mirror the win32 ones.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restorePriorPointer, selectRollbackTarget, healthTimeoutMs, versionVerifyBudgetMs, finish, type StepResult } from '../../src/cli/reinstall.js';
import { shimPaths, writePointer, type ShimPointer } from '../../src/service/shim.js';
import type { ReleaseListEntry } from '../../src/service/release.js';

describe('restorePriorPointer (FEAT-438 SLICE-417 review HIGH fix)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-reinstall-restore-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('version-mismatch scenario: a valid prior pointer is restored (win32-shaped paths)', () => {
    const paths = shimPaths(dir);
    const prior: ShimPointer = { nodeBin: 'node', entryJs: 'C:\\releases\\1.0.0+abc\\dist\\cli\\index.js', port: 7777 };
    writePointer(prior, paths.pointerPath);
    // Simulate reinstall having already repointed current.json at the new
    // (unproven) release before the version check ran.
    writePointer({ nodeBin: 'node', entryJs: 'C:\\releases\\2.0.0+def\\dist\\cli\\index.js', port: 7777 }, paths.pointerPath);

    const detail = restorePriorPointer(prior, paths.pointerPath);

    expect(detail).toContain('prior pointer restored');
    expect(detail).toContain(prior.entryJs);
    const restored = JSON.parse(readFileSync(paths.pointerPath, 'utf8')) as ShimPointer;
    expect(restored).toEqual(prior);
  });

  it('install-service-throw scenario: restores the prior pointer identically to the mismatch case', () => {
    const paths = shimPaths(dir);
    const prior: ShimPointer = { nodeBin: 'node', entryJs: 'old-entry.js', port: 1 };
    writePointer(prior, paths.pointerPath);
    writePointer({ nodeBin: 'node', entryJs: 'new-entry.js', port: 1 }, paths.pointerPath);

    const detail = restorePriorPointer(prior, paths.pointerPath);

    expect(detail).toContain('prior pointer restored → old-entry.js');
    const restored = JSON.parse(readFileSync(paths.pointerPath, 'utf8')) as ShimPointer;
    expect(restored.entryJs).toBe('old-entry.js');
  });

  it('start-service-throw scenario: restores the prior pointer identically to the mismatch case', () => {
    const paths = shimPaths(dir);
    const prior: ShimPointer = { nodeBin: 'node', entryJs: 'known-good.js', port: 2 };
    writePointer(prior, paths.pointerPath);
    writePointer({ nodeBin: 'node', entryJs: 'unverified.js', port: 2 }, paths.pointerPath);

    const detail = restorePriorPointer(prior, paths.pointerPath);

    expect(detail).toContain('prior pointer restored → known-good.js');
    const restored = JSON.parse(readFileSync(paths.pointerPath, 'utf8')) as ShimPointer;
    expect(restored.entryJs).toBe('known-good.js');
  });

  it('health-timeout scenario: restores the prior pointer identically to the mismatch case', () => {
    const paths = shimPaths(dir);
    const prior: ShimPointer = { nodeBin: 'node', entryJs: 'last-healthy.js', port: 3 };
    writePointer(prior, paths.pointerPath);
    writePointer({ nodeBin: 'node', entryJs: 'never-answered.js', port: 3 }, paths.pointerPath);

    const detail = restorePriorPointer(prior, paths.pointerPath);

    expect(detail).toContain('prior pointer restored → last-healthy.js');
    const restored = JSON.parse(readFileSync(paths.pointerPath, 'utf8')) as ShimPointer;
    expect(restored.entryJs).toBe('last-healthy.js');
  });

  it('no-prior-pointer (first install) scenario: no-ops cleanly and reports honestly', () => {
    const paths = shimPaths(dir);
    // Nothing was ever written — pointerPath does not exist.
    expect(existsSync(paths.pointerPath)).toBe(false);

    const detail = restorePriorPointer(null, paths.pointerPath);

    expect(detail).toBe('no prior pointer to restore (first install or unreadable current.json)');
    // Must not have fabricated a pointer file as a side effect.
    expect(existsSync(paths.pointerPath)).toBe(false);
  });

  it('linux-shaped paths: prior pointer is restored identically to the win32 scenarios (FEAT-443 SLICE-1)', () => {
    const paths = shimPaths(dir);
    const prior: ShimPointer = { nodeBin: '/usr/bin/node', entryJs: '/home/user/.local/share/astra-memory/releases/1.0.0+abc/dist/cli/index.js', port: 7777 };
    writePointer(prior, paths.pointerPath);
    writePointer({ nodeBin: '/usr/bin/node', entryJs: '/home/user/.local/share/astra-memory/releases/2.0.0+def/dist/cli/index.js', port: 7777 }, paths.pointerPath);

    const detail = restorePriorPointer(prior, paths.pointerPath);

    expect(detail).toContain('prior pointer restored');
    expect(detail).toContain(prior.entryJs);
    const restored = JSON.parse(readFileSync(paths.pointerPath, 'utf8')) as ShimPointer;
    expect(restored).toEqual(prior);
  });

  it('darwin-shaped paths: prior pointer is restored identically to the win32 scenarios (FEAT-443 SLICE-1)', () => {
    const paths = shimPaths(dir);
    const prior: ShimPointer = { nodeBin: '/usr/local/bin/node', entryJs: '/Users/jane/Library/Application Support/astra-memory/releases/1.0.0+abc/dist/cli/index.js', port: 7777 };
    writePointer(prior, paths.pointerPath);
    writePointer({ nodeBin: '/usr/local/bin/node', entryJs: '/Users/jane/Library/Application Support/astra-memory/releases/2.0.0+def/dist/cli/index.js', port: 7777 }, paths.pointerPath);

    const detail = restorePriorPointer(prior, paths.pointerPath);

    expect(detail).toContain('prior pointer restored');
    expect(detail).toContain(prior.entryJs);
    const restored = JSON.parse(readFileSync(paths.pointerPath, 'utf8')) as ShimPointer;
    expect(restored).toEqual(prior);
  });

  it('restore-failure path: a writePointer error is surfaced, not swallowed', () => {
    const prior: ShimPointer = { nodeBin: 'node', entryJs: 'good.js', port: 7777 };

    // Force writePointer's mkdirSync(dirname(pointerPath), {recursive:true})
    // to throw by making a PATH SEGMENT a plain file instead of a directory
    // (ENOTDIR) — portable across win32/posix, no chmod/permission games.
    const blockerFile = join(dir, 'blocker');
    writeFileSync(blockerFile, 'not a directory', 'utf8');
    const unwritablePointerPath = join(blockerFile, 'nested', 'current.json');

    const detail = restorePriorPointer(prior, unwritablePointerPath);

    expect(detail).toContain('restore FAILED');
    expect(detail).toContain('fix manually');
  });
});

describe('healthTimeoutMs (bug #2: configurable verify-health budget)', () => {
  const ENV_KEY = 'ASTRA_MEMORY_REINSTALL_HEALTH_TIMEOUT_MS';
  const original = process.env[ENV_KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('defaults to 90s when unset', () => {
    delete process.env[ENV_KEY];
    expect(healthTimeoutMs()).toBe(90_000);
  });

  it('honors a valid positive override', () => {
    process.env[ENV_KEY] = '120000';
    expect(healthTimeoutMs()).toBe(120_000);
  });

  it('falls back to the default on a non-numeric override', () => {
    process.env[ENV_KEY] = 'not-a-number';
    expect(healthTimeoutMs()).toBe(90_000);
  });

  it('falls back to the default on a zero/negative override', () => {
    process.env[ENV_KEY] = '0';
    expect(healthTimeoutMs()).toBe(90_000);
    process.env[ENV_KEY] = '-5000';
    expect(healthTimeoutMs()).toBe(90_000);
  });
});

describe('versionVerifyBudgetMs (configurable verify-version budget)', () => {
  const ENV_KEY = 'ASTRA_MEMORY_REINSTALL_VERSION_TIMEOUT_MS';
  const original = process.env[ENV_KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('defaults to 90s when unset', () => {
    delete process.env[ENV_KEY];
    expect(versionVerifyBudgetMs()).toBe(90_000);
  });

  it('honors a valid positive override', () => {
    process.env[ENV_KEY] = '180000';
    expect(versionVerifyBudgetMs()).toBe(180_000);
  });

  it('falls back to the default on a non-numeric override', () => {
    process.env[ENV_KEY] = 'not-a-number';
    expect(versionVerifyBudgetMs()).toBe(90_000);
  });

  it('falls back to the default on a zero/negative override', () => {
    process.env[ENV_KEY] = '0';
    expect(versionVerifyBudgetMs()).toBe(90_000);
    process.env[ENV_KEY] = '-5000';
    expect(versionVerifyBudgetMs()).toBe(90_000);
  });
});

describe('selectRollbackTarget (FEAT-438 SLICE-418 AC-3)', () => {
  function entry(id: string): ReleaseListEntry {
    return { id, dir: `/releases/${id}`, createdAt: '2026-01-01T00:00:00.000Z' };
  }

  it('picks the newest release whose id differs from currentId', () => {
    // listReleases() ordering is newest-first — selection must just take the
    // first non-matching entry, not re-sort or search for a "second" newest.
    const releases = [entry('3.0.0+c'), entry('2.0.0+b'), entry('1.0.0+a')];
    const target = selectRollbackTarget(releases, '3.0.0+c');
    expect(target?.id).toBe('2.0.0+b');
  });

  it('falls back to the newest release overall when currentId is null (dev-pinned / missing pointer)', () => {
    const releases = [entry('3.0.0+c'), entry('2.0.0+b')];
    const target = selectRollbackTarget(releases, null);
    expect(target?.id).toBe('3.0.0+c');
  });

  it('returns null when the only release present IS the current one', () => {
    const releases = [entry('1.0.0+only')];
    const target = selectRollbackTarget(releases, '1.0.0+only');
    expect(target).toBeNull();
  });

  it('returns null when there are no releases at all', () => {
    expect(selectRollbackTarget([], null)).toBeNull();
    expect(selectRollbackTarget([], '1.0.0+x')).toBeNull();
  });

  it('skips past a stale/unknown currentId to the newest available release', () => {
    // currentId doesn't match ANY entry (e.g. current.json points at a
    // release dir that was since pruned) — every release is a valid
    // rollback candidate, so the newest wins.
    const releases = [entry('2.0.0+b'), entry('1.0.0+a')];
    const target = selectRollbackTarget(releases, '9.9.9+gone');
    expect(target?.id).toBe('2.0.0+b');
  });
});

// Silent-error audit (2026-07-13): prune-releases used to report
// `ok: true` even when it threw, specifically so it would never gate the
// run — but that means a `--json` consumer (or any future automated check)
// reading `steps` would see a green row for a step that actually failed,
// indistinguishable from a real success. `soft: true` now lets a step be
// honestly `ok: false` while still being excluded from the pass/fail gate.
describe('finish() soft-failure gating (silent-error audit, 2026-07-13)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('a soft-failed step does not trigger process.exit(1) and is not counted in --json ok', () => {
    const steps: StepResult[] = [
      { step: 'resolve-config', ok: true },
      { step: 'prune-releases', ok: false, soft: true, detail: 'skipped (error: disk full)' },
    ];
    finish(steps, /* jsonMode */ true);

    expect(exitSpy).not.toHaveBeenCalled();
    const printed = JSON.parse((logSpy.mock.calls[0]?.[0] as string) ?? '{}');
    expect(printed.ok).toBe(true);
    // The step itself is still reported honestly as failed ...
    const pruneStep = printed.steps.find((s: StepResult) => s.step === 'prune-releases');
    expect(pruneStep.ok).toBe(false);
    expect(pruneStep.soft).toBe(true);
  });

  it('a hard-failed (non-soft) step DOES trigger process.exit(1)', () => {
    const steps: StepResult[] = [
      { step: 'resolve-config', ok: true },
      { step: 'start-service', ok: false, detail: 'daemon did not start' },
    ];
    finish(steps, true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('a soft failure alongside a hard failure still exits 1 — soft only excuses itself, not other steps', () => {
    const steps: StepResult[] = [
      { step: 'prune-releases', ok: false, soft: true, detail: 'skipped (error: disk full)' },
      { step: 'start-service', ok: false, detail: 'daemon did not start' },
    ];
    finish(steps, true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
