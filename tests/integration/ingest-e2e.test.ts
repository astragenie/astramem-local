import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

describe('E2E ingest via HTTP', () => {
  it('plugin-shaped POST → session+transcript+job in DB', async () => {
    const proc = spawn(process.execPath, ['dist/cli/index.js', 'serve', '--port', '17778'], {
      env: { ...process.env, ASTRA_MEMORY_DATADIR: ':memory:', ASTRA_MEMORY_TOKEN: 'e2etok' },
      stdio: 'pipe'
    });
    await sleep(1500);

    const body = {
      session_id: 'e2e-1',
      source: 'PreCompact',
      content: 'user: build sqlite-vec adapter\nassistant: ok, file created',
      repo: 'astramemory-local',
      agent: 'claude-code'
    };
    const res = await fetch('http://127.0.0.1:17778/ingest/transcript', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer e2etok' },
      body: JSON.stringify(body)
    });
    expect(res.status).toBe(200);

    proc.kill('SIGTERM');
    await new Promise(r => proc.on('exit', r));
  }, 15000);
});
