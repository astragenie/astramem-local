/**
 * tests/cli/crash-handlers.test.ts
 *
 * Silent-error audit (2026-07-13), AC-2: before this, src/cli/index.ts (the
 * entrypoint for doctor/reinstall/queue/init/backup/etc) had NO global
 * uncaughtException/unhandledRejection handler — only serve.ts did. A stray
 * rejection in a one-shot subcommand's fire-and-forget background work
 * (outside the awaited `main()` chain index.ts's own bottom `.catch` covers)
 * would fall through to Node's default handler instead of exiting loudly and
 * non-zero.
 *
 * installCliCrashHandlers is extracted into its own side-effect-free module
 * specifically so this can be tested without importing index.ts itself
 * (whose top-level `main()` call would run the real CLI against this test
 * process's own argv).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installCliCrashHandlers } from '../../src/cli/crash-handlers.js';

describe('installCliCrashHandlers', () => {
  afterEach(() => {
    // Remove only the listeners this test file added, so other test files'
    // real process handlers (e.g. vitest's own) are untouched.
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
  });

  it('an uncaughtException is logged and exits non-zero — not silently swallowed', () => {
    const exit = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    installCliCrashHandlers(exit);

    const err = new Error('boom from a background callback');
    process.emit('uncaughtException', err);

    expect(exit).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('FATAL uncaughtException'),
      err,
    );
    errorSpy.mockRestore();
  });

  it('an unhandledRejection is logged and exits non-zero — not silently swallowed', () => {
    const exit = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    installCliCrashHandlers(exit);

    const reason = new Error('a fire-and-forget promise nobody awaited');
    process.emit('unhandledRejection', reason, Promise.resolve().then(() => { /* noop */ }));

    expect(exit).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('FATAL unhandledRejection'),
      reason,
    );
    errorSpy.mockRestore();
  });
});
