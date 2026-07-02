import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

describe('astra-memory serve', () => {
  it('starts, responds to /health, shuts down on SIGTERM', async () => {
    // Spawn 'node' explicitly, NOT process.execPath: under `bun run test`
    // execPath is the Bun binary, which cannot boot the better-sqlite3 daemon.
    const proc = spawn('node', ['dist/cli/index.js', 'serve', '--port', '17777'], {
      // MOCK_PROVIDERS skips the boot-time Ollama embed preflight — CI runners
      // have no Ollama and the daemon exits 1 without it.
      env: {
        ...process.env,
        ASTRA_MEMORY_DATADIR: ':memory:',
        ASTRA_MEMORY_TOKEN: 'devtok',
        ASTRA_MEMORY_MOCK_PROVIDERS: '1',
      },
      stdio: 'pipe'
    });
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    // Poll instead of a fixed sleep — cold start can exceed 1.5s on Windows
    let res: Response | undefined;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      try {
        res = await fetch('http://127.0.0.1:17777/health');
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
