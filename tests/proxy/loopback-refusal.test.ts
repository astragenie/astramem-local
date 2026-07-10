/**
 * FEAT-458 S2-AC-2: a non-loopback --host is refused outright, with a pinned
 * stderr string and exit code 1 — ADR-013 review decision 2 (loopback-only
 * bind, no v1 remote-bind mode). Spawns the real built CLI (dist/cli/
 * index.js) rather than calling proxyCommand() in-process, so this exercises
 * the actual argv-parsing + process.exitCode path a user hits.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';

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

  it('accepts 127.0.0.1, localhost, and ::1 (loopback) without the refusal message', async () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      // No real upstream needed to observe the refusal check happening
      // BEFORE any bind attempt — use an obviously-unreachable-but-valid
      // upstream URL and kill the process shortly after; the assertion is
      // only that the loopback-refusal stderr line never appears.
      const proc = spawn('node', ['dist/cli/index.js', 'proxy', 'serve', '--host', host, '--port', '0', '--upstream', 'http://127.0.0.1:1'], {
        env: { ...process.env, ASTRA_MEMORY_ISOLATED: '1' },
        stdio: 'pipe',
      });
      let stderr = '';
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      let stdout = '';
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !stdout.includes('proxy serving on')) {
        await new Promise((r) => setTimeout(r, 100));
      }
      proc.kill('SIGTERM');
      await new Promise((r) => proc.on('exit', r));
      expect(stderr).not.toContain('refusing non-loopback bind');
    }
  }, 30_000);
});
