/**
 * tests/e2e/auto-capture-close.e2e.test.ts — Tier-1 CI-safe smoke for the
 * 2026-07-12 doctor-canary provenance fix.
 *
 * Verified bug: the astramem-plugin close-capture hook calls
 * `astramem-local capture claude <path> --event subagent_stop` WITHOUT
 * `--auto-capture` — every close-capture memory got `capture_source = NULL`,
 * and the doctor "Auto-capture" canary (src/doctor/checks.ts) permanently
 * WARNed once auto-capture was enabled, even though ordinary close-capture
 * was working perfectly. The fix stamps `capture_source = 'hook_close'` on
 * every non-`--auto-capture` invocation and widens the canary's count query
 * to include it alongside `'auto_capture'`.
 *
 * This test drives the FULL wire the unit tests miss: the REAL CLI process
 * (`node dist/cli/index.js capture claude ...`) -> durable ingest spool ->
 * daemon boot-time drain -> distill (mock LLM/embed, no live Ollama) ->
 * memory row -> doctor check, mirroring tests/ingest/spool-drain.test.ts's
 * AC-8 pattern (capture happens with no daemon up yet) and
 * tests/e2e/plugin-flow.test.ts's daemon-spawn/search-poll harness.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  REPO_ROOT,
  spawnDaemon,
  killDaemon,
  waitForHealthReachable,
  pollSearchHits,
  makeIsolatedDaemonEnv,
  cleanupIsolatedDaemonEnv,
  type DaemonHandle,
  type IsolatedDaemonEnv,
} from '../smoke/helpers/daemon.js';
import { listSpoolFiles } from '../../src/ingest/spool.js';
import { openDb } from '../../src/storage/db.js';
import { getChecks } from '../../src/doctor/checks.js';

const TOKEN = `e2etok-autocapture-close-${randomUUID()}`;
const CLI_PATH = join(REPO_ROOT, 'dist', 'cli', 'index.js');

describe('Auto-capture close e2e — CLI capture claude -> spool -> drain -> distill -> memory -> doctor', () => {
  let daemon: DaemonHandle | null = null;
  let isolated: IsolatedDaemonEnv | null = null;
  let fixtureDir: string | null = null;

  afterAll(async () => {
    if (daemon) await killDaemon(daemon, 'SIGTERM', 3_000);
    if (isolated) cleanupIsolatedDaemonEnv(isolated);
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  it(
    'close-capture hook path: fixture survives deletion, drains, distills, and clears the doctor canary with capture_source=hook_close',
    async () => {
      isolated = makeIsolatedDaemonEnv('auto-capture-close-e2e');

      // ── 1. Fixture Claude Code transcript — distinctive content the mock
      //    extraction vocab recognizes ("sqlite-vec" -> a 'decision' atom,
      //    same trigger tests/e2e/plugin-flow.test.ts and
      //    tests/ingest/spool-drain.test.ts already rely on). ────────────────
      fixtureDir = mkdtempSync(join(tmpdir(), 'auto-capture-close-src-'));
      const fixturePath = join(fixtureDir, 'agent-hookclose.jsonl');
      const sessionSuffix = randomUUID().slice(0, 8);
      writeFileSync(
        fixturePath,
        [
          JSON.stringify({
            type: 'user',
            sessionId: `sess-hc-${sessionSuffix}`,
            cwd: '/home/u/proj-hookclose',
            message: { role: 'user', content: 'what vector store should we use for v1?' },
          }),
          JSON.stringify({
            type: 'assistant',
            sessionId: `sess-hc-${sessionSuffix}`,
            cwd: '/home/u/proj-hookclose',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Use sqlite-vec for v1 storage — no network dependency.' }],
            },
          }),
        ].join('\n'),
      );

      // ── 2. Run the REAL CLI exactly as the astramem-plugin close-capture
      //    hook does — no --auto-capture. ─────────────────────────────────────
      const result = spawnSync(
        process.execPath,
        [CLI_PATH, 'capture', 'claude', fixturePath, '--event', 'subagent_stop'],
        { cwd: REPO_ROOT, env: { ...process.env, ...isolated.env }, encoding: 'utf8' },
      );
      expect(
        result.status,
        `capture claude exited nonzero.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      ).toBe(0);

      const spooled = listSpoolFiles(isolated.dataDir);
      expect(spooled).toHaveLength(1);

      // ── 3. Delete the fixture immediately — proves the ephemeral-transcript
      //    race fix (FEAT-449): the spool already holds the content, so a
      //    since-deleted source file cannot starve distillation. ─────────────
      unlinkSync(fixturePath);

      // ── 4. Boot the daemon against the SAME data dir. serve.ts's
      //    runSpoolDrain() runs once synchronously at boot (AC-8) before the
      //    30s periodic timer, so no daemon restart or extra wait is needed
      //    to pick up the file spooled in step 2. ────────────────────────────
      daemon = await spawnDaemon({ port: 0, token: TOKEN, env: isolated.env });
      daemon.proc.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(`[daemon] ${chunk.toString()}`);
      });
      await waitForHealthReachable(daemon.baseUrl);
      expect(daemon.exitInfo().code, 'daemon should still be running').toBeNull();

      // ── 5. Wait for the distill worker to turn the drained transcript into
      //    a searchable memory. ────────────────────────────────────────────────
      const hits = await pollSearchHits(
        daemon.baseUrl,
        TOKEN,
        'sqlite',
        found => found.filter(h => h.text.toLowerCase().includes('sqlite-vec')),
        {
          label: `GET ${daemon.baseUrl}/search?q=sqlite to return a memory containing 'sqlite-vec'`,
          timeoutMs: 30_000,
        },
      );
      expect(hits.length).toBeGreaterThan(0);

      // ── 6. Stop the daemon before touching its sqlite file directly — no
      //    concurrent-writer race with the still-running process. ────────────
      await killDaemon(daemon, 'SIGTERM', 3_000);
      daemon = null;

      // ── 7. The actual bug: every memory produced from this transcript must
      //    carry capture_source='hook_close' (previously NULL). ──────────────
      const dbPath = join(isolated.dataDir, 'memory.sqlite');
      const db = openDb(dbPath);
      const rows = db
        .prepare(`SELECT capture_source FROM memories WHERE valid_to IS NULL`)
        .all() as { capture_source: string | null }[];
      db.close();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(r => r.capture_source === 'hook_close')).toBe(true);

      // ── 8. Doctor's "Auto-capture" canary, invoked directly against this
      //    same data dir (mirrors tests/doctor/auto-capture-check.test.ts) —
      //    would have been a permanent false-positive WARN before this fix
      //    (0 rows tagged 'auto_capture' despite real close-capture traffic);
      //    now ok:true because the canary's count query includes
      //    'hook_close'. ────────────────────────────────────────────────────
      const checks = getChecks({ dataDir: isolated.dataDir, encryptionEnabled: false, autoCaptureEnabled: true });
      const autoCaptureCheck = checks.find(c => c.name === 'Auto-capture');
      expect(autoCaptureCheck).toBeDefined();
      const checkResult = await autoCaptureCheck!.run();
      expect(checkResult.ok).toBe(true);
    },
    60_000,
  );
});
