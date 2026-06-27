import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

describe('astra-memory serve', () => {
  it('starts, responds to /health, shuts down on SIGTERM', async () => {
    const proc = spawn(process.execPath, ['dist/cli/index.js', 'serve', '--port', '17777'], {
      env: { ...process.env, ASTRA_MEMORY_DATADIR: ':memory:', ASTRA_MEMORY_TOKEN: 'devtok' },
      stdio: 'pipe'
    });
    await sleep(1500);
    const res = await fetch('http://127.0.0.1:17777/health');
    expect(res.status).toBe(200);
    proc.kill('SIGTERM');
    await new Promise(r => proc.on('exit', r));
  }, 10000);
});
