import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { waitForBoundPort } from '../smoke/helpers/daemon.js';

describe('astra-memory serve', () => {
  it('starts, responds to /health, shuts down on SIGTERM', async () => {
    // devops#69: `--port 0` asks the OS for an ephemeral port instead of the
    // previously-hardcoded 17777, which collided with the shared self-hosted
    // runner VM's persistent TEI container on :8080 and with neighbor CI
    // jobs' own spawned daemons. Token is unique per run for the same
    // defense-in-depth reason — an accidental cross-connect should fail
    // closed (401), not silently reuse a neighbor's shared 'devtok' literal.
    const token = `devtok-${randomUUID()}`;
    // Spawn 'node' explicitly, NOT process.execPath: under `bun run test`
    // execPath is the Bun binary, which cannot boot the better-sqlite3 daemon.
    const proc = spawn('node', ['dist/cli/index.js', 'serve', '--port', '0'], {
      // MOCK_PROVIDERS skips the boot-time Ollama embed preflight — CI runners
      // have no Ollama and the daemon exits 1 without it.
      env: {
        ...process.env,
        ASTRA_MEMORY_DATADIR: ':memory:',
        ASTRA_MEMORY_TOKEN: token,
        ASTRA_MEMORY_MOCK_PROVIDERS: '1',
      },
      stdio: 'pipe'
    });
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('exit', (code, signal) => { exitCode = code; exitSignal = signal; });

    const port = await waitForBoundPort(
      () => stdout,
      () => stderr,
      () => ({ code: exitCode, signal: exitSignal }),
    );

    // Poll instead of a fixed sleep — cold start can exceed 1.5s on Windows
    let res: Response | undefined;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      try {
        res = await fetch(`http://127.0.0.1:${port}/health`);
        break;
      } catch {
        await sleep(200);
      }
    }
    expect(res?.status, `daemon never came up; stderr:\n${stderr}`).toBe(200);
    proc.kill('SIGTERM');
    await new Promise(r => proc.on('exit', r));
  }, 30_000);
});
