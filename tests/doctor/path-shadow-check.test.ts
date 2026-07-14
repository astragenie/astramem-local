/**
 * tests/doctor/path-shadow-check.test.ts
 *
 * Issue #308: a stale bun-global install shadowed the current npm-global
 * install whenever the bun bin dir preceded the npm bin dir on PATH — the
 * shell silently resolved the old binary (which predated `reinstall`) with
 * no hint a newer install existed elsewhere. `checkPathShadow` warns when
 * more than one `astramem-local` binary is reachable on PATH.
 *
 * Both PATH and the per-directory existence probe are injected (see
 * `PathShadowOverrides` in src/doctor/checks/path-shadow.ts) so every case
 * here is deterministic and never touches the real filesystem or the
 * runner's real PATH.
 */
import { describe, it, expect } from 'vitest';
import { checkPathShadow } from '../../src/doctor/checks/path-shadow.js';

describe('checkPathShadow (issue #308)', () => {
  it('PASS: zero astramem-local binaries on PATH', async () => {
    const result = await checkPathShadow({
      path: ['C:\\Windows\\System32', 'C:\\Tools\\other'].join(';'),
      platformId: 'win32',
      exists: () => false,
    }).run();

    expect(result.ok).toBe(true);
    expect(result.message).toContain('no astramem-local found');
  });

  it('PASS: exactly one astramem-local binary on PATH', async () => {
    const npmDir = 'C:\\Users\\dev\\AppData\\Roaming\\npm';
    const result = await checkPathShadow({
      path: ['C:\\Windows\\System32', npmDir].join(';'),
      platformId: 'win32',
      exists: (p) => p === `${npmDir}\\astramem-local.cmd`,
    }).run();

    expect(result.ok).toBe(true);
    expect(result.message).toContain('single astramem-local on PATH');
    expect(result.message).toContain(npmDir);
  });

  it('WARN: two astramem-local binaries on PATH (win32) — names both, identifies the first (winning) one', async () => {
    const bunDir = 'C:\\Users\\dev\\.bun\\bin';
    const npmDir = 'C:\\Users\\dev\\AppData\\Roaming\\npm';
    // bunDir listed FIRST, matching issue #308's exact reproduction shape.
    const result = await checkPathShadow({
      path: [bunDir, 'C:\\Windows\\System32', npmDir].join(';'),
      platformId: 'win32',
      exists: (p) => p === `${bunDir}\\astramem-local.exe` || p === `${npmDir}\\astramem-local.cmd`,
    }).run();

    expect(result.ok).toBe(false);
    expect(result.message).toContain('2 astramem-local binaries found');
    expect(result.message).toContain(`${bunDir}\\astramem-local.exe`);
    expect(result.message).toContain(`${npmDir}\\astramem-local.cmd`);
    // First match on PATH is the one the shell actually resolves.
    expect(result.message).toContain(`resolves "${bunDir}\\astramem-local.exe"`);
    expect(result.fix).toBeDefined();
  });

  it('WARN: two astramem-local binaries on PATH (posix)', async () => {
    const bunDir = '/home/dev/.bun/bin';
    const npmDir = '/usr/local/bin';
    const result = await checkPathShadow({
      path: [bunDir, npmDir].join(':'),
      platformId: 'linux',
      exists: (p) => p === `${bunDir}/astramem-local` || p === `${npmDir}/astramem-local`,
    }).run();

    expect(result.ok).toBe(false);
    expect(result.message).toContain('2 astramem-local binaries found');
    expect(result.message).toContain(`${bunDir}/astramem-local`);
    expect(result.message).toContain(`${npmDir}/astramem-local`);
  });

  it('does not double-count a dir that has both .exe and .cmd variants of the same binary', async () => {
    const dir = 'C:\\Tools\\astramem';
    const result = await checkPathShadow({
      path: dir,
      platformId: 'win32',
      exists: (p) => p === `${dir}\\astramem-local.exe` || p === `${dir}\\astramem-local.cmd`,
    }).run();

    expect(result.ok).toBe(true);
    expect(result.message).toContain('single astramem-local on PATH');
  });

  it('ignores empty PATH entries (e.g. a trailing/duplicate separator)', async () => {
    const result = await checkPathShadow({
      path: ';;C:\\Windows\\System32;',
      platformId: 'win32',
      exists: () => false,
    }).run();

    expect(result.ok).toBe(true);
  });

  it('defaults never touch the real filesystem when overrides are supplied — deterministic on any machine/PATH', async () => {
    // Same inputs, run twice — must be stable regardless of the host's
    // actual PATH or installed binaries, since exists() is fully injected.
    const opts = {
      path: 'C:\\a;C:\\b',
      platformId: 'win32' as const,
      exists: (p: string) => p.endsWith('astramem-local.exe'),
    };
    const r1 = await checkPathShadow({ ...opts, exists: () => true }).run();
    const r2 = await checkPathShadow({ ...opts, exists: () => true }).run();
    expect(r1.ok).toBe(r2.ok);
    expect(r1.message).toBe(r2.message);
  });
});
