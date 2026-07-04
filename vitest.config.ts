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
  },
});
