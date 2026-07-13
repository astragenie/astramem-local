/**
 * tests/cli/restore.test.ts — A1 fifth-caller fix (PR #224 follow-up).
 *
 * `restoreCommand` used to hand-roll its own PID-alive stop check
 * (`stopDaemon` in src/cli/restore.ts, removed) instead of calling the
 * identity-verified `stopLockHolder` (src/service/instance-lock.ts). That
 * meant `astramem-local restore <snapshot>` could SIGTERM a process whose
 * PID had been recycled after the lock's real owner crashed — the exact bug
 * the A1 identity check exists to prevent, reachable through the one call
 * site the fix didn't cover.
 *
 * This test proves the closed gap: `restoreCommand` now goes through
 * `stopLockHolder`, and when that function refuses to signal (identity
 * unverified — e.g. a recorded start-time that doesn't match the OS-reported
 * one for that PID), restore aborts loudly WITHOUT touching the live
 * database. `stopLockHolder`'s own identity-check branches are exhaustively
 * covered by tests/service/instance-lock.test.ts; this test's job is only to
 * confirm restore.ts is wired to that choke point and honors its refusal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { createSnapshot } from '../../src/backup/snapshot.js';

vi.mock('../../src/service/instance-lock.js', () => ({
  stopLockHolder: vi.fn(),
}));
vi.mock('../../src/config/resolve-runtime.js', () => ({
  resolveRuntimeConfig: vi.fn(),
}));

import { restoreCommand } from '../../src/cli/restore.js';
import { stopLockHolder } from '../../src/service/instance-lock.js';
import { resolveRuntimeConfig } from '../../src/config/resolve-runtime.js';

describe('restoreCommand stop-daemon path (A1 fifth-caller fix)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-restore-'));
    vi.mocked(resolveRuntimeConfig).mockReturnValue({
      // Encryption off so the test never touches the OS credential store —
      // irrelevant to what this test verifies (the stop-daemon call site).
      // embedding.dim matches DEFAULT_EMBED_DIM so the post-swap migrate()
      // call in the "proceeds" test below doesn't reject a mismatched dim.
      cfg: { security: { encryption: { enabled: false } }, embedding: { dim: 1024 } } as never,
      port: 7777,
      dataDir: dir,
      configDir: dir,
      sources: { port: 'default', dataDir: 'default' } as never,
      isolated: true,
    });
    vi.mocked(stopLockHolder).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to restore and aborts (exit 1) when stopLockHolder cannot verify the lock holder\'s identity — a recycled-PID lock must never let restore swap the live DB out from under an unknown process', async () => {
    // A valid snapshot so step 1 (integrity verify) passes and execution
    // actually reaches the stop-daemon step under test.
    const db = openDb(join(dir, 'seed.sqlite'));
    migrate(db);
    const snapPath = join(dir, 'snap.sqlite');
    await createSnapshot(db, snapPath);
    db.close();

    const refusalDetail =
      'refusing to signal pid 4242: process start time mismatch (lock says 2020-01-01T00:00:00.000Z, ' +
      'OS says 2026-07-13T12:00:00.000Z, drift 999999999ms > 60000ms) — likely a recycled PID, not our daemon';
    vi.mocked(stopLockHolder).mockResolvedValue({ ok: false, detail: refusalDetail });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); }) as never;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(restoreCommand([snapPath, '--no-restart'])).rejects.toThrow('exit');

    // The fifth caller must go through stopLockHolder — not a local
    // hand-rolled PID-alive check — so the identity check actually runs.
    expect(stopLockHolder).toHaveBeenCalledTimes(1);
    expect(stopLockHolder).toHaveBeenCalledWith(dir, 7777);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('recycled PID'))).toBe(true);

    // Must never have touched the live DB — the file swap (steps 3/4) never ran.
    expect(existsSync(join(dir, 'memory.sqlite.pre-restore.bak'))).toBe(false);
    expect(existsSync(join(dir, 'memory.sqlite'))).toBe(false);
  });

  it('proceeds past the stop-daemon step when stopLockHolder confirms the daemon is stopped', async () => {
    const db = openDb(join(dir, 'seed.sqlite'));
    migrate(db);
    const snapPath = join(dir, 'snap.sqlite');
    await createSnapshot(db, snapPath);
    db.close();

    vi.mocked(stopLockHolder).mockResolvedValue({ ok: true, detail: 'no daemon.lock — nothing to stop' });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // --no-restart skips the service-adapter step; migrations still run
    // against the swapped-in snapshot, which is the real proof the swap happened.
    await restoreCommand([snapPath, '--no-restart']);

    expect(stopLockHolder).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, 'memory.sqlite'))).toBe(true);
  });
});

describe('restoreCommand --force / --force-unsafe (SLICE E8 escape hatch, regrouped by live-writer risk)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-restore-force-'));
    vi.mocked(resolveRuntimeConfig).mockReturnValue({
      cfg: { security: { encryption: { enabled: false } }, embedding: { dim: 1024 } } as never,
      port: 7777,
      dataDir: dir,
      configDir: dir,
      sources: { port: 'default', dataDir: 'default' } as never,
      isolated: true,
    });
    vi.mocked(stopLockHolder).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedSnapshot(): Promise<string> {
    const db = openDb(join(dir, 'seed.sqlite'));
    migrate(db);
    const snapPath = join(dir, 'snap.sqlite');
    await createSnapshot(db, snapPath);
    db.close();
    return snapPath;
  }

  async function expectAborted(args: string[]) {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); }) as never;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(restoreCommand(args)).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(existsSync(join(dir, 'memory.sqlite.pre-restore.bak'))).toBe(false);
    expect(existsSync(join(dir, 'memory.sqlite'))).toBe(false);
    return { errSpy };
  }

  async function expectProceeded(args: string[]) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await restoreCommand(args);
    expect(existsSync(join(dir, 'memory.sqlite'))).toBe(true);
    return { errSpy };
  }

  // --- weak gate: identity-unverifiable — genuinely unknown risk ---

  it('--force alone bypasses identity-unverifiable (could-not-check) and lets restore proceed', async () => {
    const snapPath = await seedSnapshot();
    const detail =
      'refusing to signal pid 4242: could not verify process identity (unable to determine OS process start time)';
    vi.mocked(stopLockHolder).mockResolvedValue({ ok: false, detail, reason: 'identity-unverifiable' });

    const { errSpy } = await expectProceeded([snapPath, '--no-restart', '--force']);

    expect(stopLockHolder).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('--force') && String(c[0]).includes('bypassing') && !String(c[0]).includes('--force-unsafe'))).toBe(true);
    expect(errSpy.mock.calls.some(c => String(c.join(' ')).includes('genuinely unknown'))).toBe(true);
  });

  it('without --force, identity-unverifiable still aborts', async () => {
    const snapPath = await seedSnapshot();
    vi.mocked(stopLockHolder).mockResolvedValue({
      ok: false,
      detail: 'refusing to signal pid 4242: lock has no valid startedAt to verify identity against',
      reason: 'identity-unverifiable',
    });
    await expectAborted([snapPath, '--no-restart']);
  });

  // --- strong gate: confirmed-wrong-process (low actual live-writer risk, but a positive mismatch finding) ---

  it('--force alone does NOT bypass identity-mismatch — still aborts, names --force-unsafe as the required second flag', async () => {
    const snapPath = await seedSnapshot();
    const detail =
      'refusing to signal pid 4242: process start time mismatch (lock says 2020-01-01T00:00:00.000Z, ' +
      'OS says 2026-07-13T12:00:00.000Z, drift 999999999ms > 60000ms) — likely a recycled PID, not our daemon';
    vi.mocked(stopLockHolder).mockResolvedValue({ ok: false, detail, reason: 'identity-mismatch' });

    const { errSpy } = await expectAborted([snapPath, '--no-restart', '--force']);

    expect(errSpy.mock.calls.some(c => String(c[0]).includes('--force-unsafe'))).toBe(true);
    // Warning text must reflect the ACTUAL risk for this reason: low, not
    // "an unidentified process may still be writing" — PID reuse implies
    // the original holder is already dead.
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('LOW'))).toBe(true);
  });

  it('--force --force-unsafe together bypass identity-mismatch and let restore proceed', async () => {
    const snapPath = await seedSnapshot();
    const detail =
      'refusing to signal pid 4242: process start time mismatch (lock says 2020-01-01T00:00:00.000Z, ' +
      'OS says 2026-07-13T12:00:00.000Z, drift 999999999ms > 60000ms) — likely a recycled PID, not our daemon';
    vi.mocked(stopLockHolder).mockResolvedValue({ ok: false, detail, reason: 'identity-mismatch' });

    const { errSpy } = await expectProceeded([snapPath, '--no-restart', '--force', '--force-unsafe']);

    expect(errSpy.mock.calls.some(c => String(c[0]).includes('--force --force-unsafe') && String(c[0]).includes('bypassing'))).toBe(true);
  });

  // --- strong gate: confirmed-ours-and-still-alive (the two HIGHEST live-writer-risk cases) ---

  it('--force alone does NOT bypass stop-timeout (confirmed ours, alive, did not die in time) — still aborts', async () => {
    const snapPath = await seedSnapshot();
    const detail = 'pid 4242 still serving after 5000ms';
    vi.mocked(stopLockHolder).mockResolvedValue({ ok: false, detail, reason: 'stop-timeout' });

    const { errSpy } = await expectAborted([snapPath, '--no-restart', '--force']);

    expect(errSpy.mock.calls.some(c => String(c[0]).includes('--force-unsafe'))).toBe(true);
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('highest-risk'))).toBe(true);
  });

  it('--force --force-unsafe together bypass stop-timeout and let restore proceed', async () => {
    const snapPath = await seedSnapshot();
    const detail = 'pid 4242 still serving after 5000ms';
    vi.mocked(stopLockHolder).mockResolvedValue({ ok: false, detail, reason: 'stop-timeout' });

    await expectProceeded([snapPath, '--no-restart', '--force', '--force-unsafe']);
  });

  it('--force alone does NOT bypass signal-failed (confirmed ours, alive, never even signaled) — still aborts', async () => {
    const snapPath = await seedSnapshot();
    const detail = 'kill pid 4242 failed: operation not permitted';
    vi.mocked(stopLockHolder).mockResolvedValue({ ok: false, detail, reason: 'signal-failed' });

    const { errSpy } = await expectAborted([snapPath, '--no-restart', '--force']);

    expect(errSpy.mock.calls.some(c => String(c[0]).includes('--force-unsafe'))).toBe(true);
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('highest-risk'))).toBe(true);
  });

  it('--force --force-unsafe together bypass signal-failed and let restore proceed', async () => {
    const snapPath = await seedSnapshot();
    const detail = 'kill pid 4242 failed: operation not permitted';
    vi.mocked(stopLockHolder).mockResolvedValue({ ok: false, detail, reason: 'signal-failed' });

    await expectProceeded([snapPath, '--no-restart', '--force', '--force-unsafe']);
  });
});
