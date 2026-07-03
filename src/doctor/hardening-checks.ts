/**
 * hardening-checks.ts — doctor checks matching `reinstall`'s assertions (W1.3).
 *
 * Doctor must be able to see everything reinstall warns about, so a user who
 * only runs doctor still learns about: stranded legacy databases, lingering
 * plaintext encryption backups, a service serving a different build than the
 * repo, zombie instance locks, and accumulating poison jobs.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from './types.js';
import type { DB } from '../storage/db.js';
import { legacyDataDir } from '../config/datadir.js';
import { readLockInfo } from '../service/instance-lock.js';
import { PKG_VERSION } from '../server/lib/wire-meta.js';

export interface HardeningCheckOpts {
  dataDir: string;
  port: number;
  /** Same key-aware read-only opener the core checks use. */
  openDbReadonly: () => Promise<DB>;
}

export function getHardeningChecks(opts: HardeningCheckOpts): Check[] {
  return [
    checkStrandedLegacyDb(opts.dataDir),
    checkPreEncryptionBak(opts.dataDir),
    checkServedVersion(opts.port),
    checkZombieLock(opts.dataDir),
    checkPoisonJobs(opts.openDbReadonly),
    checkPendingProposals(opts.openDbReadonly),
  ];
}

/** Consolidation proposals waiting for review — silent pile-up is the failure
 *  mode of a scheduled consolidation cadence with no reviewer. */
function checkPendingProposals(openDbReadonly: () => Promise<DB>): Check {
  return {
    name: 'Consolidation proposals reviewed',
    async run(): Promise<CheckResult> {
      let db: DB | null = null;
      try {
        db = await openDbReadonly();
        const row = db.prepare(
          `SELECT COUNT(*) AS n FROM consolidation_proposals WHERE status = 'pending'`,
        ).get() as { n: number };
        if (row.n === 0) return { ok: true, message: 'no pending consolidation proposals' };
        return {
          ok: false,
          message: `${row.n} consolidation proposal(s) awaiting review (borderline near-duplicates, 0.94-0.97 similarity)`,
          fix: "Review with 'astramem-local consolidate proposals' then accept/reject",
        };
      } catch (err) {
        return { ok: true, message: `proposal check skipped: ${err instanceof Error ? err.message : String(err)}` };
      } finally {
        try { db?.close(); } catch { /* ignore */ }
      }
    },
  };
}

/** Legacy data dir still holds a database that is NOT the one being served. */
function checkStrandedLegacyDb(dataDir: string): Check {
  return {
    name: 'No stranded legacy database',
    async run(): Promise<CheckResult> {
      const legacy = legacyDataDir();
      const legacyDb = join(legacy, 'memory.sqlite');
      if (legacy === dataDir || !existsSync(legacyDb)) {
        return { ok: true, message: 'no legacy database present' };
      }
      const st = statSync(legacyDb);
      const kb = Math.round(st.size / 1024);
      return {
        ok: false,
        message: `legacy dir still holds a ${kb}KB database: ${legacyDb} (mtime ${st.mtime.toISOString()})`,
        fix: `Verify the served DB at ${join(dataDir, 'memory.sqlite')} contains your real data, then delete the legacy dir`,
      };
    },
  };
}

/** Plaintext pre-encryption backup lingering next to the encrypted DB. */
function checkPreEncryptionBak(dataDir: string): Check {
  return {
    name: 'No plaintext pre-encryption backup',
    async run(): Promise<CheckResult> {
      const bak = join(dataDir, 'memory.sqlite.pre-encryption.bak');
      if (!existsSync(bak)) return { ok: true, message: 'no pre-encryption backup present' };
      const ageDays = (Date.now() - statSync(bak).mtimeMs) / (24 * 60 * 60 * 1000);
      return {
        ok: false,
        message: `PLAINTEXT copy of the database still on disk (${ageDays.toFixed(1)}d old): ${bak}`,
        fix: 'serve auto-deletes it after 7 days; delete manually once the encrypted DB is verified',
      };
    },
  };
}

/** Daemon serves a different build than the one running doctor. */
function checkServedVersion(port: number): Check {
  return {
    name: 'Served version matches this build',
    async run(): Promise<CheckResult> {
      let body: { version?: string };
      try {
        const res = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(2000) });
        body = (await res.json()) as { version?: string };
      } catch {
        return { ok: true, message: 'daemon not reachable — version check skipped' };
      }
      if (body.version === PKG_VERSION) {
        return { ok: true, message: `daemon serving v${body.version} (matches build)` };
      }
      return {
        ok: false,
        message: `daemon serves v${body.version} but this build is v${PKG_VERSION} — a different install is running`,
        fix: "Run 'astramem-local reinstall' from the build you want (stale global installs shadow the repo build)",
      };
    },
  };
}

/** daemon.lock held by a dead or unresponsive process. */
function checkZombieLock(dataDir: string): Check {
  return {
    name: 'Instance lock healthy',
    async run(): Promise<CheckResult> {
      const holder = readLockInfo(dataDir);
      if (!holder) return { ok: true, message: 'no daemon.lock (daemon not running)' };
      let alive = true;
      try {
        process.kill(holder.pid, 0);
      } catch {
        alive = false;
      }
      if (!alive) {
        return {
          ok: false,
          message: `daemon.lock held by dead pid ${holder.pid} — stale (self-heals on next serve)`,
          fix: "Start the daemon ('astramem-local service start' or 'reinstall'); the stale lock is stolen automatically",
        };
      }
      try {
        const res = await fetch(`http://127.0.0.1:${holder.port}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return { ok: true, message: `lock held by pid ${holder.pid}, daemon healthy on :${holder.port}` };
      } catch {
        /* fall through */
      }
      return {
        ok: false,
        message: `daemon.lock pid ${holder.pid} is alive but /health on :${holder.port} is unresponsive (zombie)`,
        fix: `Kill pid ${holder.pid} and restart the service`,
      };
    },
  };
}

/** Poisoned jobs accumulating in the queue. */
function checkPoisonJobs(openDbReadonly: () => Promise<DB>): Check {
  return {
    name: 'No poisoned jobs',
    async run(): Promise<CheckResult> {
      let db: DB | null = null;
      try {
        db = await openDbReadonly();
        const row = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE state = 'poison'`).get() as { n: number };
        if (row.n === 0) return { ok: true, message: 'no poisoned jobs' };
        return {
          ok: false,
          message: `${row.n} poisoned job(s) in the queue (retries exhausted or deterministic failure)`,
          fix: "Inspect with 'astramem-local queue'; purged automatically after 30 days",
        };
      } catch (err) {
        return { ok: true, message: `poison check skipped: ${err instanceof Error ? err.message : String(err)}` };
      } finally {
        try { db?.close(); } catch { /* ignore */ }
      }
    },
  };
}
