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

  it('renders the shared dashboard nav, linking to the other 5 pages', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard/logs', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="/dashboard"');
    expect(res.body).toContain('href="/dashboard/jobs"');
    expect(res.body).toContain('href="/dashboard/consolidation"');
    expect(res.body).toContain('href="/dashboard/search"');
    expect(res.body).toContain('href="/dashboard/api"');
    // The Logs tab itself is the active (non-link) entry.
    expect(res.body).not.toContain('href="/dashboard/logs"');
  });

  // ?level= threshold filter (SEVERITY THRESHOLD, not exact match): warn
  // shows warn+error, error shows error only, the default (no param, or an
  // invalid value) shows info and above.
  describe('?level= threshold filter', () => {
    function seedLevels(dataDirLocal: string): void {
      const logsDir = join(dataDirLocal, 'logs');
      mkdirSync(logsDir, { recursive: true });
      const now = Date.now();
      const info = JSON.stringify({ level: 30, time: now, msg: 'INFO_MARKER' });
      const warn = JSON.stringify({ level: 40, time: now, msg: 'WARN_MARKER' });
      const error = JSON.stringify({ level: 50, time: now, msg: 'ERROR_MARKER' });
      const unparseable = 'UNPARSEABLE_MARKER not json';
      writeFileSync(
        join(logsDir, 'daemon.1.log'),
        [info, warn, error, unparseable].join('\n') + '\n',
      );
    }

    it('default (no ?level) shows info and above — hides nothing here, including the unparseable line (INFO-equivalent rule)', async () => {
      seedLevels(dataDir);
      const app = await buildTestApp();
      const res = await app.inject({ method: 'GET', url: '/dashboard/logs', headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('INFO_MARKER');
      expect(res.body).toContain('WARN_MARKER');
      expect(res.body).toContain('ERROR_MARKER');
      expect(res.body).toContain('UNPARSEABLE_MARKER');
    });

    it('?level=warn hides info (and the unparseable INFO-equivalent line) but shows warn+error', async () => {
      seedLevels(dataDir);
      const app = await buildTestApp();
      const res = await app.inject({ method: 'GET', url: '/dashboard/logs?level=warn', headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('INFO_MARKER');
      expect(res.body).not.toContain('UNPARSEABLE_MARKER');
      expect(res.body).toContain('WARN_MARKER');
      expect(res.body).toContain('ERROR_MARKER');
    });

    it('?level=error shows error only', async () => {
      seedLevels(dataDir);
      const app = await buildTestApp();
      const res = await app.inject({ method: 'GET', url: '/dashboard/logs?level=error', headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('INFO_MARKER');
      expect(res.body).not.toContain('WARN_MARKER');
      expect(res.body).not.toContain('UNPARSEABLE_MARKER');
      expect(res.body).toContain('ERROR_MARKER');
    });

    it('?level=all (and the ?level=debug alias) shows everything', async () => {
      seedLevels(dataDir);
      const app = await buildTestApp();
      const all = await app.inject({ method: 'GET', url: '/dashboard/logs?level=all', headers: AUTH });
      expect(all.body).toContain('INFO_MARKER');
      expect(all.body).toContain('WARN_MARKER');
      expect(all.body).toContain('ERROR_MARKER');
      expect(all.body).toContain('UNPARSEABLE_MARKER');

      const debug = await app.inject({ method: 'GET', url: '/dashboard/logs?level=debug', headers: AUTH });
      expect(debug.body).toContain('INFO_MARKER');
      expect(debug.body).toContain('UNPARSEABLE_MARKER');
    });

    it('an invalid ?level= value falls back to the info default rather than erroring', async () => {
      seedLevels(dataDir);
      const app = await buildTestApp();
      const res = await app.inject({ method: 'GET', url: '/dashboard/logs?level=nonsense', headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('INFO_MARKER');
      expect(res.body).toContain('ERROR_MARKER');
    });

    it('the threshold filters BEFORE the 200-line tail trim: a low-volume error is not buried by a wall of info lines', async () => {
      const logsDir = join(dataDir, 'logs');
      mkdirSync(logsDir, { recursive: true });
      const now = Date.now();
      const infoFlood = Array.from({ length: 210 }, (_, i) =>
        JSON.stringify({ level: 30, time: now, msg: `flood-${i}` }));
      const error = JSON.stringify({ level: 50, time: now, msg: 'BURIED_ERROR_MARKER' });
      // Error line first, then 210 info lines after it — a naive
      // "tail 200 raw lines, then filter" implementation would drop it.
      writeFileSync(join(logsDir, 'daemon.1.log'), [error, ...infoFlood].join('\n') + '\n');

      const app = await buildTestApp();
      const res = await app.inject({ method: 'GET', url: '/dashboard/logs?level=error', headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('BURIED_ERROR_MARKER');
    });

    it('renders clickable filter links, highlighting the active one, and the <meta refresh> keeps the current ?level=', async () => {
      seedLevels(dataDir);
      const app = await buildTestApp();
      const res = await app.inject({ method: 'GET', url: '/dashboard/logs?level=warn', headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('href="/dashboard/logs?level=error"');
      expect(res.body).toContain('href="/dashboard/logs?level=info"');
      expect(res.body).toContain('href="/dashboard/logs?level=all"');
      expect(res.body).toContain('<span class="active">warn+</span>');
      expect(res.body).toContain('content="5;url=/dashboard/logs?level=warn"');
    });
  });
});
