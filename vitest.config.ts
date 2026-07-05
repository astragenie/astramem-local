import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exclude nested git worktrees (.claude/worktrees/<agent>/ carries a full
    // repo copy incl. tests/) — without this, vitest discovers and runs the
    // same suites twice, and spawned-daemon tests collide on their pinned ports.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/**',
    ],
    // FEAT-431 (class B): pay the better-sqlite3-multiple-ciphers + sqlite-vec
    // native-addon cold-load cost once, up front, in an untimed setup phase —
    // see tests/setup/native-warmup.globalsetup.ts for the full rationale.
    // This is intentionally NOT a global testTimeout bump; it removes the
    // cause of the cold-start cost instead of widening the window around it.
    globalSetup: ['./tests/setup/native-warmup.globalsetup.ts'],
  },
});
