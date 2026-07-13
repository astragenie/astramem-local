import { ts } from '../log/logger.js';

/**
 * Global crash handlers for the CLI entrypoint (doctor/reinstall/queue/init/
 * backup/etc — every one-shot subcommand except `serve`, which installs its
 * own daemon-appropriate crashExit in serve.ts). Without these, a stray
 * unhandledRejection/uncaughtException in a subcommand's fire-and-forget
 * background work (not on the awaited `main()` chain index.ts's own bottom
 * `.catch` covers) crashes the process via Node's default handler, which can
 * print a bare stack and, depending on platform/timing, still race an exit
 * that isn't reliably non-zero — a command that never actually finished
 * looking like one that passed to a wrapping script or scheduler.
 *
 * Extracted into its own module (exports a function, doesn't call it) so
 * tests can exercise the handler logic directly — importing index.ts itself
 * would trigger its top-level `main()` call against the test process's own
 * argv, which is a side effect no test wants.
 */
export function installCliCrashHandlers(exit: (code: number) => void = process.exit): void {
  const crashExit = (kind: string) => (err: unknown) => {
    console.error(`${ts()} [astramem-local] FATAL ${kind}:`, err);
    exit(1);
  };
  process.on('uncaughtException', crashExit('uncaughtException'));
  process.on('unhandledRejection', crashExit('unhandledRejection'));
}
