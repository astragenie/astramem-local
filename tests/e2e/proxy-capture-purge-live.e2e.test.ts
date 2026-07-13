/**
 * tests/e2e/proxy-capture-purge-live.e2e.test.ts — FEAT-458 S4 live version
 * of `capture proxy disable` (S3, src/cli/capture.ts's `runProxyCaptureDisable`).
 *
 * tests/cli/capture-claude.test.ts already covers this flow at the unit
 * level — real CLI process, but the daemon side is either absent (--keep,
 * which never touches the network) or deliberately unroutable (the --purge
 * failure-path test). This file drives the REAL wire the unit tests can't:
 * a live daemon, a genuine `POST /capture/purge` call, and a genuine
 * `POST /capture/purge/:batchId/restore` call — proving the FEAT-467 purge
 * primitive's bounded restore window is actually reversible for proxy
 * captures, not just for the auto-capture path it was originally built for.
 *
 * Isolation discipline mirrors tests/e2e/auto-capture-close.e2e.test.ts:
 * `makeIsolatedDaemonEnv` (temp APPDATA/HOME/XDG config dirs + dataDir, mock
 * LLM/embed providers, ephemeral --port 0) — never touches the operator's real daemon,
 * config, or credential store. Memory rows are inserted directly via
 * `MemoryRepo` (same technique tests/doctor/proxy-check.test.ts and
 * tests/cli/capture-claude.test.ts already use) rather than routed through
 * the not-yet-built proxy relay itself (src/proxy/**, owned by a sibling
 * track) — what this test proves is the disable -> purge -> restore wire,
 * which only cares that rows carry `capture_source = 'proxy'`, not how they
 * got there.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO_ROOT,
  spawnDaemon,
  killDaemon,
  waitForHealthReachable,
  makeIsolatedDaemonEnv,
  cleanupIsolatedDaemonEnv,
  type DaemonHandle,
  type IsolatedDaemonEnv,
} from '../smoke/helpers/daemon.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { defaultConfig } from '../../src/config/config.js';
import { writeConfig } from '../../src/config/writer.js';

const TOKEN = `e2etok-proxy-purge-${randomUUID()}`;
const CLI_PATH = join(REPO_ROOT, 'dist', 'cli', 'index.js');

/** Insert one memory row with the given capture_source, returning its id. */
function insertAtom(dataDir: string, captureSource: 'proxy' | 'auto_capture' | 'hook_close', label: string): string {
  const db = openDb(join(dataDir, 'memory.sqlite'));
  migrate(db);
  const id = new MemoryRepo(db).insert({
    type: 'fact',
    text: `${label} (${captureSource})`,
    normalized_text: `${label} (${captureSource})`,
    repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
    hash: randomUUID(), source_hash: null,
    capture_source: captureSource,
  });
  db.close();
  return id;
}

function readValidTo(dataDir: string, id: string): number | null {
  const db = openDb(join(dataDir, 'memory.sqlite'));
  const row = db.prepare('SELECT valid_to FROM memories WHERE id = ?').get(id) as { valid_to: number | null };
  db.close();
  return row.valid_to;
}

/** Write proxy.capture.enabled into the isolated config dir's config.yaml,
 *  preserving the encryption:false the sandbox already set up. */
function setProxyCaptureEnabled(configDir: string, enabled: boolean): void {
  const cfg = defaultConfig();
  cfg.security.encryption.enabled = false;
  cfg.proxy.capture.enabled = enabled;
  writeConfig(cfg, join(configDir, 'config.yaml'));
}

describe('Proxy capture disable -> purge -> restore, live (FEAT-458 S4)', () => {
  let daemon: DaemonHandle | null = null;
  let isolated: IsolatedDaemonEnv | null = null;

  afterAll(async () => {
    if (daemon) await killDaemon(daemon, 'SIGTERM', 3_000);
    if (isolated) cleanupIsolatedDaemonEnv(isolated);
  });

  it(
    '--purge: proxy atoms purged + genuinely restorable; auto_capture/hook_close atoms untouched throughout',
    async () => {
      isolated = makeIsolatedDaemonEnv('proxy-capture-purge-e2e');
      setProxyCaptureEnabled(isolated.configDir, true);

      // ── 1. Seed real capture_source='proxy' rows, plus one of each OTHER
      //    provenance — the isolation guarantee this test exists to prove. ──
      const proxyId1 = insertAtom(isolated.dataDir, 'proxy', 'proxy atom one');
      const proxyId2 = insertAtom(isolated.dataDir, 'proxy', 'proxy atom two');
      const autoCaptureId = insertAtom(isolated.dataDir, 'auto_capture', 'auto-capture atom');
      const hookCloseId = insertAtom(isolated.dataDir, 'hook_close', 'hook-close atom');

      // ── 2. Boot a real daemon against the same data dir. ─────────────────
      daemon = await spawnDaemon({ port: 0, token: TOKEN, env: isolated.env });
      daemon.proc.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(`[daemon] ${chunk.toString()}`);
      });
      await waitForHealthReachable(daemon.baseUrl);
      expect(daemon.exitInfo().code, 'daemon should still be running').toBeNull();

      // ── 3. Run the REAL CLI's `capture proxy disable --purge --json`,
      //    pointed at the live daemon via ASTRA_MEMORY_URL/TOKEN. ──────────
      const disableResult = spawnSync(
        process.execPath,
        [CLI_PATH, 'capture', 'proxy', 'disable', '--purge', '--json'],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            ...isolated.env,
            ASTRA_MEMORY_URL: daemon.baseUrl,
            ASTRA_MEMORY_TOKEN: TOKEN,
          },
          encoding: 'utf8',
        },
      );
      expect(
        disableResult.status,
        `capture proxy disable --purge exited nonzero.\nstdout: ${disableResult.stdout}\nstderr: ${disableResult.stderr}`,
      ).toBe(0);
      const disableBody = JSON.parse(disableResult.stdout) as {
        disabled: boolean; was_enabled: boolean; proxy_captured_count: number;
        purge: string; purged: number; batch_id: string | null;
      };
      expect(disableBody.disabled).toBe(true);
      expect(disableBody.was_enabled).toBe(true);
      expect(disableBody.proxy_captured_count).toBe(2);
      expect(disableBody.purge).toBe('completed');
      expect(disableBody.purged).toBe(2);
      expect(disableBody.batch_id).toBeTruthy();
      const batchId = disableBody.batch_id!;

      // ── 4. Config flag actually flipped on disk. ─────────────────────────
      const written = readFileSync(join(isolated.configDir, 'config.yaml'), 'utf8') as string;
      const captureSection = written.slice(written.indexOf('capture:', written.indexOf('proxy:')));
      expect(captureSection).toContain('enabled: false');

      // ── 5. Both proxy atoms are now soft-purged (valid_to set); the OTHER
      //    provenance atoms are completely untouched — the whole point of
      //    the second enum value's isolation. ──────────────────────────────
      expect(readValidTo(isolated.dataDir, proxyId1)).not.toBeNull();
      expect(readValidTo(isolated.dataDir, proxyId2)).not.toBeNull();
      expect(readValidTo(isolated.dataDir, autoCaptureId)).toBeNull();
      expect(readValidTo(isolated.dataDir, hookCloseId)).toBeNull();

      // ── 6. The bounded restore window is genuinely reversible: call the
      //    real HTTP restore route against the still-live daemon. ──────────
      const restoreRes = await fetch(`${daemon.baseUrl}/capture/purge/${batchId}/restore`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const restoreText = await restoreRes.text();
      expect(restoreRes.status, restoreText).toBe(200);
      const restoreBody = JSON.parse(restoreText) as { restored: number };
      expect(restoreBody.restored).toBe(2);

      // ── 7. Stop the daemon before touching sqlite directly (no concurrent
      //    writer race), then confirm the restore actually cleared valid_to
      //    on both proxy atoms — and, again, never touched the other two. ──
      await killDaemon(daemon, 'SIGTERM', 3_000);
      daemon = null;

      expect(readValidTo(isolated.dataDir, proxyId1)).toBeNull();
      expect(readValidTo(isolated.dataDir, proxyId2)).toBeNull();
      expect(readValidTo(isolated.dataDir, autoCaptureId)).toBeNull();
      expect(readValidTo(isolated.dataDir, hookCloseId)).toBeNull();
    },
    60_000,
  );

  it(
    '--keep: config flips, proxy atom is declined-not-purged and stays valid — no daemon required',
    async () => {
      const keepEnv = makeIsolatedDaemonEnv('proxy-capture-keep-e2e');
      try {
        setProxyCaptureEnabled(keepEnv.configDir, true);
        const proxyId = insertAtom(keepEnv.dataDir, 'proxy', 'kept proxy atom');

        const result = spawnSync(
          process.execPath,
          [CLI_PATH, 'capture', 'proxy', 'disable', '--keep', '--json'],
          { cwd: REPO_ROOT, env: { ...process.env, ...keepEnv.env }, encoding: 'utf8' },
        );
        expect(
          result.status,
          `capture proxy disable --keep exited nonzero.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
        ).toBe(0);
        const body = JSON.parse(result.stdout) as {
          disabled: boolean; was_enabled: boolean; proxy_captured_count: number; purge: string;
        };
        expect(body.disabled).toBe(true);
        expect(body.was_enabled).toBe(true);
        expect(body.proxy_captured_count).toBe(1);
        expect(body.purge).toBe('declined');

        const written = readFileSync(join(keepEnv.configDir, 'config.yaml'), 'utf8') as string;
        const captureSection = written.slice(written.indexOf('capture:', written.indexOf('proxy:')));
        expect(captureSection).toContain('enabled: false');

        expect(readValidTo(keepEnv.dataDir, proxyId)).toBeNull();
      } finally {
        cleanupIsolatedDaemonEnv(keepEnv);
      }
    },
    30_000,
  );
});
