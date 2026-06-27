/**
 * Doctor check registry.
 *
 * Track C owns the registry and the 7 core checks below.
 * Other tracks (A, B, D) add checks via register() in their own modules —
 * they call register() at module load time, before the CLI runs runChecks().
 *
 * Registry API:
 *   register(check: Check): void
 *   getChecks(): Check[]
 *
 * Example (Track A adds its check):
 *   import { register } from '../doctor/checks.js';
 *   register({ name: 'No stuck jobs', run: async () => { ... } });
 */

import { statfsSync, existsSync, accessSync, constants, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Check, CheckResult } from './types.js';

export type { Check, CheckResult };

// ─── Registry ────────────────────────────────────────────────────────────────

const _registry: Check[] = [];

/**
 * Register an additional doctor check. Called by other tracks to extend the
 * doctor command without modifying this file.
 *
 * @param check - A Check object with `name` and `run()`.
 */
export function register(check: Check): void {
  _registry.push(check);
}

/**
 * Returns all currently registered checks (core + any added via register()).
 * The CLI doctor command passes this to runChecks().
 */
export function getChecks(
  opts: DoctorCheckOpts = {}
): Check[] {
  return [...coreChecks(opts), ..._registry];
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface DoctorCheckOpts {
  /** Absolute path to the data directory (default: resolved from config) */
  dataDir?: string;
  /** Daemon port to probe (default: 7777) */
  port?: number;
  /** Path to service unit file to check presence (optional) */
  serviceUnitPath?: string;
}

// ─── Check 1: SQLite writable + WAL ──────────────────────────────────────────

function checkSqliteWritable(dataDir: string): Check {
  return {
    name: 'SQLite writable + WAL',
    async run(): Promise<CheckResult> {
      // Try to write a probe file in the datadir
      const probePath = join(dataDir, `.doctor-probe-${randomUUID()}`);
      try {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(probePath, 'probe', 'utf8');
        unlinkSync(probePath);
      } catch (err) {
        return {
          ok: false,
          message: `datadir not writable: ${dataDir}`,
          fix: `chmod u+w "${dataDir}" or set ASTRA_MEMORY_DATADIR to a writable path`,
        };
      }

      // Check WAL by opening a test DB — we do this without importing better-sqlite3
      // at module load time (doctor may run before DB is ready).
      try {
        const { default: Database } = await import('better-sqlite3');
        const dbPath = join(dataDir, 'memory.sqlite');
        // DB may not exist yet — only check WAL if it does
        if (existsSync(dbPath)) {
          const db = new Database(dbPath, { readonly: true });
          const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
          db.close();
          if (row.journal_mode !== 'wal') {
            return {
              ok: false,
              message: `journal_mode is '${row.journal_mode}', expected 'wal'`,
              fix: 'Run: astra-memory serve (will apply WAL pragma on open)',
            };
          }
        }
        return { ok: true, message: `datadir writable, WAL ok (${dataDir})` };
      } catch (err) {
        return { ok: false, message: `SQLite probe error: ${err}` };
      }
    },
  };
}

// ─── Check 2: sqlite-vec extension loadable ───────────────────────────────────

function checkSqliteVec(): Check {
  return {
    name: 'sqlite-vec extension loadable',
    async run(): Promise<CheckResult> {
      try {
        const { default: Database } = await import('better-sqlite3');
        const { load } = await import('sqlite-vec');
        const db = new Database(':memory:');
        load(db);
        const row = db.prepare("SELECT vec_version() AS v").get() as { v: string } | undefined;
        db.close();
        if (!row) return { ok: false, message: 'sqlite-vec loaded but vec_version() returned nothing' };
        return { ok: true, message: `sqlite-vec ${row.v} loaded` };
      } catch (err) {
        return {
          ok: false,
          message: `sqlite-vec not loadable: ${err}`,
          fix: 'npm install sqlite-vec (or reinstall native deps for this OS/arch)',
        };
      }
    },
  };
}

// ─── Check 3: FTS5 available ──────────────────────────────────────────────────

function checkFts5(): Check {
  return {
    name: 'FTS5 available',
    async run(): Promise<CheckResult> {
      try {
        const { default: Database } = await import('better-sqlite3');
        const db = new Database(':memory:');
        db.exec(`CREATE VIRTUAL TABLE _fts5_probe USING fts5(content)`);
        db.exec(`DROP TABLE _fts5_probe`);
        db.close();
        return { ok: true, message: 'FTS5 available' };
      } catch (err) {
        return {
          ok: false,
          message: `FTS5 not available: ${err}`,
          fix: 'Ensure better-sqlite3 was compiled with FTS5 (default in prebuilt binaries)',
        };
      }
    },
  };
}

// ─── Check 4: Daemon reachable on configured port ────────────────────────────

function checkDaemonReachable(port: number): Check {
  return {
    name: `Daemon reachable on :${port}`,
    async run(): Promise<CheckResult> {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3_000);
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (res.ok) {
            const body = await res.json() as { ok?: boolean };
            return { ok: true, message: `daemon healthy on port ${port}` };
          }
          return {
            ok: false,
            message: `daemon returned HTTP ${res.status} on :${port}`,
            fix: `astra-memory serve --port ${port}`,
          };
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        return {
          ok: false,
          message: `daemon not reachable on port ${port}`,
          fix: `astra-memory serve --port ${port}`,
        };
      }
    },
  };
}

// ─── Check 5: Disk free > 1GB in datadir ─────────────────────────────────────

const ONE_GB = 1024 * 1024 * 1024;

function checkDiskFree(dataDir: string): Check {
  return {
    name: 'Disk free > 1GB in datadir',
    async run(): Promise<CheckResult> {
      try {
        mkdirSync(dataDir, { recursive: true });
        const stats = statfsSync(dataDir);
        const freeBytes = stats.bfree * stats.bsize;
        const freeGb = (freeBytes / ONE_GB).toFixed(2);
        if (freeBytes < ONE_GB) {
          return {
            ok: false,
            message: `Only ${freeGb}GB free in ${dataDir} (need > 1GB)`,
            fix: `Free disk space in the volume containing ${dataDir}`,
          };
        }
        return { ok: true, message: `${freeGb}GB free in datadir` };
      } catch (err) {
        return { ok: false, message: `Cannot check disk space: ${err}` };
      }
    },
  };
}

// ─── Check 6: Service unit present if installed ───────────────────────────────

function checkServiceUnit(serviceUnitPath: string | undefined): Check {
  return {
    name: 'Service unit present',
    async run(): Promise<CheckResult> {
      if (!serviceUnitPath) {
        return { ok: true, message: 'service install not checked (no unit path configured)' };
      }
      if (existsSync(serviceUnitPath)) {
        return { ok: true, message: `service unit found at ${serviceUnitPath}` };
      }
      return {
        ok: false,
        message: `service unit not found at ${serviceUnitPath}`,
        fix: 'astra-memory service install',
      };
    },
  };
}

// ─── Check 7: Configured datadir exists and is writable ───────────────────────

function checkDatadirWritable(dataDir: string): Check {
  return {
    name: 'Datadir exists and writable',
    async run(): Promise<CheckResult> {
      try {
        mkdirSync(dataDir, { recursive: true });
        accessSync(dataDir, constants.W_OK);
        return { ok: true, message: `datadir writable: ${dataDir}` };
      } catch (err) {
        return {
          ok: false,
          message: `datadir not writable: ${dataDir}`,
          fix: `mkdir -p "${dataDir}" && chmod u+w "${dataDir}"`,
        };
      }
    },
  };
}

// ─── Core check list builder ──────────────────────────────────────────────────

function coreChecks(opts: DoctorCheckOpts): Check[] {
  const port = opts.port ?? 7777;
  const dataDir = opts.dataDir ?? join(tmpdir(), 'astra-memory');

  return [
    checkDatadirWritable(dataDir),
    checkSqliteWritable(dataDir),
    checkSqliteVec(),
    checkFts5(),
    checkDaemonReachable(port),
    checkDiskFree(dataDir),
    checkServiceUnit(opts.serviceUnitPath),
  ];
}
