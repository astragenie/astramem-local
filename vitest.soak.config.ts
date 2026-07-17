import { defineConfig } from 'vitest/config';

// Soak/load lane — the counterpart to vitest.config.ts, which EXCLUDES
// tests/soak/** so the blocking PR/main gate stays deterministic. This config
// runs ONLY the soak suite and is invoked by `bun run test:soak` from the
// nightly lane (.github/workflows/nightly-live.yml). These tests are timing-
// and host-scheduling-sensitive by design (they assert on worker-throttle
// behaviour under induced embed saturation), so a transient over/undershoot is
// a nightly signal to investigate, not a merge blocker.
export default defineConfig({
  test: {
    include: ['tests/soak/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/**',
    ],
    // Same native-warmup rationale as the main config — see
    // tests/setup/native-warmup.globalsetup.ts.
    globalSetup: ['./tests/setup/native-warmup.globalsetup.ts'],
  },
});
