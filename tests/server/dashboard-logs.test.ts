import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import { defaultConfig } from '../../src/config/config.js';
import type { DB } from '../../src/storage/db.js';

const TOKEN = 'testtoken';
const AUTH = { authorization: `Bearer ${TOKEN}` };

// New /dashboard/logs page: renders the tail of the newest rotated daemon
// log (or daemon-stdout.log as fallback) as a readable HTML table. Mirrors
// dashboard-jobs.test.ts's structure.
describe('GET /dashboard/logs — render internals', () => {
  let db: DB;
  let dataDir: string;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    dataDir = mkdtempSync(join(tmpdir(), 'astra-dashboard-logs-test-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function buildTestApp() {
    const config = { ...defaultConfig(), dataDir };
    return buildApp({ db, token: TOKEN, config });
  }

  it('AC-4: 401 with no Authorization header and no cookie', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard/logs' });
    expect(res.statusCode).toBe(401);
  });

  it('200 with an empty state when no logs dir / log file exists', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard/logs', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('No log lines available yet');
  });

  it('parses pino JSON lines from the newest daemon.*.log, tolerates a non-JSON line, and shows level/context/msg', async () => {
    const logsDir = join(dataDir, 'logs');
    mkdirSync(logsDir, { recursive: true });

    const now = Date.now();
    const infoLine = JSON.stringify({ level: 30, time: now, msg: 'request complete', method: 'GET', path: '/health', status: 200 });
    const errorLine = JSON.stringify({ level: 50, time: now, msg: 'DISTILL_JOB_FAILED_MARKER', job_kind: 'distill' });
    const garbageLine = 'not json at all, a raw boot banner line';

    // Older rotated file — must NOT be the one read.
    writeFileSync(join(logsDir, 'daemon.1.log'), JSON.stringify({ level: 30, time: now - 10_000, msg: 'STALE_SHOULD_NOT_APPEAR' }) + '\n');
    // Newest rotated file.
    const newestPath = join(logsDir, 'daemon.2.log');
    writeFileSync(newestPath, [infoLine, errorLine, garbageLine].join('\n') + '\n');
    // Ensure mtime ordering is unambiguous even on fast filesystems.
    const past = new Date(now - 60_000);
    const present = new Date(now);
    utimesSync(join(logsDir, 'daemon.1.log'), past, past);
    utimesSync(newestPath, present, present);

    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard/logs', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    const body = res.body;

    expect(body).toContain('request complete');
    expect(body).toContain('DISTILL_JOB_FAILED_MARKER');
    expect(body).toContain(garbageLine);
    expect(body).not.toContain('STALE_SHOULD_NOT_APPEAR');
    expect(body.toUpperCase()).toContain('ERROR');
    expect(body.toUpperCase()).toContain('INFO');
    expect(body).toContain('GET /health');
    expect(body).toContain('distill');
  });

  it('falls back to daemon-stdout.log when no daemon.*.log exists', async () => {
    const logsDir = join(dataDir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, 'daemon-stdout.log'), 'astramem-local daemon booting on port 7777\n');

    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard/logs', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('astramem-local daemon booting on port 7777');
  });
});
