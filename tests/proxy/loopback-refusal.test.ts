/**
 * FEAT-458 S2-AC-2: a non-loopback --host is refused outright, with a pinned
 * stderr string and exit code 1 — ADR-013 review decision 2 (loopback-only
 * bind, no v1 remote-bind mode). Spawns the real built CLI (dist/cli/
 * index.js) rather than calling proxyCommand() in-process, so this exercises
 * the actual argv-parsing + process.exitCode path a user hits.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../src/config/config.js';
import { configToYaml } from '../../src/config/writer.js';

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn('node', ['dist/cli/index.js', ...args], {
      env: { ...process.env, ASTRA_MEMORY_ISOLATED: '1' },
      stdio: 'pipe',
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('exit', (code) => resolve({ stdout, stderr, code }));
  });
}

describe('proxy serve — loopback-only bind refusal', () => {
  it('refuses a non-loopback --host with the exact pinned message and exit code 1', async () => {
    const { stderr, code } = await runCli([
      'proxy', 'serve', '--host', '0.0.0.0', '--port', '0', '--upstream', 'http://127.0.0.1:1',
    ]);
    expect(stderr).toContain('proxy: refusing non-loopback bind (0.0.0.0) — v1 is loopback-only per ADR-013');
    expect(code).toBe(1);
  }, 15_000);

  it('refuses a non-loopback hostname the same way', async () => {
    const { stderr, code } = await runCli([
      'proxy', 'serve', '--host', 'example.com', '--port', '0', '--upstream', 'http://127.0.0.1:1',
    ]);
    expect(stderr).toContain('proxy: refusing non-loopback bind (example.com) — v1 is loopback-only per ADR-013');
    expect(code).toBe(1);
  }, 15_000);

  describe('with proxy.experimental: true (release no-go gate opted in)', () => {
    // The gate (src/cli/proxy.ts) refuses to start the listener at all
    // unless proxy.experimental is true, so the process no longer stays
    // alive long enough to reach "proxy serving on" under the isolated-mode
    // default (proxy.experimental: false) — this block sandboxes a real
    // config.yaml with the opt-in set, same technique as
    // tests/proxy/experimental-gate.test.ts, so the loopback check itself
    // (this file's actual subject) can still be observed in a live process.
    let configParent: string;
    let dataDir: string;

    afterEach(() => {
      if (configParent) rmSync(configParent, { recursive: true, force: true });
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    });

    it('accepts 127.0.0.1, localhost, and ::1 (loopback) without the refusal message', async () => {
      configParent = mkdtempSync(join(tmpdir(), 'astramem-loopback-cfg-'));
      dataDir = mkdtempSync(join(tmpdir(), 'astramem-loopback-data-'));
      const configDir = join(configParent, 'Astramem');
      mkdirSync(configDir, { recursive: true });
      const cfg = defaultConfig();
      cfg.proxy.experimental = true;
      writeFileSync(join(configDir, 'config.yaml'), configToYaml(cfg), 'utf8');

      for (const host of ['127.0.0.1', 'localhost', '::1']) {
        // No real upstream needed to observe the refusal check happening
        // BEFORE any bind attempt — use an obviously-unreachable-but-valid
        // upstream URL and kill the process shortly after; the assertion is
        // only that the loopback-refusal stderr line never appears.
        const proc = spawn('node', ['dist/cli/index.js', 'proxy', 'serve', '--host', host, '--port', '0', '--upstream', 'http://127.0.0.1:1'], {
          env: {
            ...process.env,
            APPDATA: configParent,
            LOCALAPPDATA: configParent,
            ASTRA_MEMORY_DATADIR: dataDir,
          },
          stdio: 'pipe',
        });
        let stderr = '';
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
        let stdout = '';
        proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && !stdout.includes('proxy serving on') && proc.exitCode === null) {
          await new Promise((r) => setTimeout(r, 100));
        }
        // Only wait for 'exit' if the process is genuinely still alive — an
        // already-exited process never re-fires 'exit' for a listener
        // registered after the fact, which would hang this await forever.
        if (proc.exitCode === null) {
          proc.kill('SIGTERM');
          await new Promise((r) => proc.on('exit', r));
        }
        expect(stderr).not.toContain('refusing non-loopback bind');
      }
    }, 30_000);
  });
});
