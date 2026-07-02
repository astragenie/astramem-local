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

import { statfsSync, existsSync, accessSync, constants, mkdirSync, writeFileSync, unlinkSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Check, CheckResult } from './types.js';
import type { LLMProvider } from '../contracts/llm.js';
import type { EmbedProvider } from '../contracts/embed.js';
import { llmChatProbe } from './probes/llm-chat-probe.js';
import { embedProbe } from './probes/embed-probe.js';
import { pluginCoexistenceProbe } from './probes/plugin-coexistence.js';
import { defaultConfigDir, legacyConfigDir } from '../config/datadir.js';
import { getOrCreateKey } from '../storage/keystore.js';
import type { DB } from '../storage/db.js';

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
  /** Daily budget cap in USD (default: 10) */
  dailyBudgetUsd?: number;
  /** Whether secret redaction is enabled (default: true) — SEC-6/8. */
  redactionEnabled?: boolean;
  /** Whether encryption at rest is enabled (default: true) — SEC-1/2/8. */
  encryptionEnabled?: boolean;
  /**
   * LLM providers to real-chat-probe. If compaction + extraction are the same
   * provider instance (same name+model), only one probe fires.
   */
  llmProviders?: {
    compaction: LLMProvider;
    /** Only probed when name+model differs from compaction */
    extraction: LLMProvider;
  };
  /** Embed provider to real-embed-probe. */
  embedProvider?: EmbedProvider;
  /**
   * Path to the backups directory. When provided, doctor warns if the newest
   * backup is older than 24h (or if no backups exist at all).
   * Pass undefined (the default) to skip the backup-recency check.
   */
  backupsDir?: string;
}

// ─── Shared: open the real memory.sqlite read-only, key-aware ───────────────

/**
 * Opens `dbPath` read-only using the production cipher driver
 * (better-sqlite3-multiple-ciphers). When `encryptionEnabled` is true,
 * fetches the key from the keystore (credential store, or key-file fallback)
 * and applies `PRAGMA key` before returning — otherwise a plain
 * better-sqlite3 probe against an encrypted file would fail with
 * "file is not a database", turning every doctor read-check into a false
 * failure on encrypted installs (SEC-8/AC-5).
 *
 * getOrCreateKey() is idempotent — if the DB is genuinely encrypted the key
 * already exists (created at first `serve`), so this call reads it back
 * rather than minting a new one.
 */
async function openProductionDbReadonly(dbPath: string, encryptionEnabled: boolean): Promise<DB> {
  const { default: Database } = await import('better-sqlite3-multiple-ciphers');
  const db = new Database(dbPath, { readonly: true }) as DB;
  if (encryptionEnabled) {
    const { key } = getOrCreateKey(defaultConfigDir());
    db.pragma(`key='${key.replace(/'/g, "''")}'`);
  }
  return db;
}

// ─── Check 1: SQLite writable + WAL ──────────────────────────────────────────

function checkSqliteWritable(dataDir: string, encryptionEnabled: boolean): Check {
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

      // Check WAL by opening a test DB — key-aware so this doesn't false-fail
      // on an encrypted production DB (SEC-8).
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        // DB may not exist yet — only check WAL if it does
        if (existsSync(dbPath)) {
          const db = await openProductionDbReadonly(dbPath, encryptionEnabled);
          const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
          db.close();
          if (row.journal_mode !== 'wal') {
            return {
              ok: false,
              message: `journal_mode is '${row.journal_mode}', expected 'wal'`,
              fix: 'Run: astramem-local serve (will apply WAL pragma on open)',
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
        const { default: Database } = await import('better-sqlite3-multiple-ciphers');
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
        const { default: Database } = await import('better-sqlite3-multiple-ciphers');
        const db = new Database(':memory:');
        db.exec(`CREATE VIRTUAL TABLE _fts5_probe USING fts5(content)`);
        db.exec(`DROP TABLE _fts5_probe`);
        db.close();
        return { ok: true, message: 'FTS5 available' };
      } catch (err) {
        return {
          ok: false,
          message: `FTS5 not available: ${err}`,
          fix: 'Ensure better-sqlite3-multiple-ciphers was compiled with FTS5 (default in prebuilt binaries)',
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
            fix: `astramem-local serve --port ${port}`,
          };
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        return {
          ok: false,
          message: `daemon not reachable on port ${port}`,
          fix: `astramem-local serve --port ${port}`,
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
        fix: 'astramem-local service install',
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

// ─── Check 8: Today's budget vs cap ──────────────────────────────────────────

function checkBudget(dataDir: string, dailyBudgetUsd: number, encryptionEnabled: boolean): Check {
  return {
    name: 'Daily budget vs cap',
    async run(): Promise<CheckResult> {
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        if (!existsSync(dbPath)) {
          return { ok: true, message: 'budget check skipped (no DB yet)' };
        }
        const db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const day = new Date().toISOString().slice(0, 10);
        const row = db.prepare('SELECT usd_total, calls FROM budget_spend WHERE day = ?').get(day) as
          | { usd_total: number; calls: number }
          | undefined;
        db.close();

        const usd = row?.usd_total ?? 0;
        const calls = row?.calls ?? 0;
        const pct = dailyBudgetUsd > 0 ? ((usd / dailyBudgetUsd) * 100).toFixed(1) : '0.0';

        if (usd >= dailyBudgetUsd && dailyBudgetUsd > 0) {
          return {
            ok: false,
            message: `Budget cap reached: $${usd.toFixed(4)} / $${dailyBudgetUsd.toFixed(2)} (${calls} calls) — distillation paused`,
            fix: 'astramem-local budget --reset  to override for today',
          };
        }

        return {
          ok: true,
          message: `Budget: $${usd.toFixed(4)} / $${dailyBudgetUsd.toFixed(2)} (${pct}%, ${calls} calls today)`,
        };
      } catch (err) {
        return { ok: false, message: `Budget check error: ${err}` };
      }
    },
  };
}

// ─── Check: Secret redaction (SEC-6/8) ────────────────────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function checkRedaction(dataDir: string, enabled: boolean, encryptionEnabled: boolean): Check {
  return {
    name: 'Secret redaction',
    async run(): Promise<CheckResult> {
      if (!enabled) {
        return {
          ok: false,
          message: 'redaction: OFF — secrets are NOT scrubbed before persistence (security.redaction.enabled=false)',
          fix: 'Set security.redaction.enabled=true (default) unless you have a deliberate reason to disable it.',
        };
      }

      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        if (!existsSync(dbPath)) {
          return { ok: true, message: 'redaction: on (no DB yet — 0 secrets redacted)' };
        }
        const db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;
        const rows = db
          .prepare('SELECT type, SUM(count) AS n FROM redaction_log WHERE created_at >= ? GROUP BY type ORDER BY n DESC')
          .all(since) as { type: string; n: number }[];
        db.close();

        const total = rows.reduce((sum, r) => sum + r.n, 0);
        if (total === 0) {
          return { ok: true, message: 'redaction: on — 0 secrets redacted in last 7d' };
        }
        const breakdown = rows.map(r => `${r.n} ${r.type}`).join(', ');
        return { ok: true, message: `redaction: on — ${total} secrets redacted (${breakdown}) in last 7d` };
      } catch (err) {
        return { ok: false, message: `Redaction check error: ${err}` };
      }
    },
  };
}

// ─── Check: Encryption at rest (SEC-1/2/8) ────────────────────────────────────

function checkEncryption(dataDir: string, enabled: boolean): Check {
  return {
    name: 'Encryption at rest',
    async run(): Promise<CheckResult> {
      if (!enabled) {
        return {
          ok: false,
          message: 'encryption: OFF — memory.sqlite is stored in PLAINTEXT (security.encryption.enabled=false)',
          fix: 'Set security.encryption.enabled=true (default) unless you have a deliberate reason to disable it.',
        };
      }

      try {
        const { source } = getOrCreateKey(defaultConfigDir());
        const label = source === 'credential-store' ? 'keychain' : 'key-file';

        const dbPath = join(dataDir, 'memory.sqlite');
        if (existsSync(dbPath)) {
          const header = readFileSync(dbPath).subarray(0, 16).toString('latin1');
          if (header.startsWith('SQLite format 3')) {
            return {
              ok: false,
              message: `encryption: on (${label}) but memory.sqlite header is still PLAINTEXT — auto-migration has not run yet`,
              fix: 'astramem-local serve  (auto-migrates a plaintext DB to encrypted form on next start)',
            };
          }
        }
        return { ok: true, message: `encryption: on (${label})` };
      } catch (err) {
        return { ok: false, message: `Encryption check error: ${err}` };
      }
    },
  };
}

// ─── Core check list builder ──────────────────────────────────────────────────

// ─── Check 9: LLM chat probe (real 1-token call) ─────────────────────────────

function checkLLMChat(provider: LLMProvider, label: string): Check {
  return {
    name: `LLM chat probe (${label})`,
    async run(): Promise<CheckResult> {
      return llmChatProbe(provider);
    },
  };
}

// ─── Check 10: Embed probe (real embed call + dim assert) ─────────────────────

function checkEmbed(provider: EmbedProvider): Check {
  return {
    name: 'Embed probe (1024-dim)',
    async run(): Promise<CheckResult> {
      return embedProbe(provider);
    },
  };
}

// ─── Check 11: Plugin coexistence ────────────────────────────────────────────

function checkPluginCoexistence(port: number): Check {
  return {
    name: 'Plugin config coexistence',
    async run(): Promise<CheckResult> {
      return pluginCoexistenceProbe(port);
    },
  };
}

// ─── Check 12: Backup recency ─────────────────────────────────────────────────

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function checkBackupRecency(backupsDir: string): Check {
  return {
    name: 'Backup recency',
    async run(): Promise<CheckResult> {
      if (!existsSync(backupsDir)) {
        return {
          ok: false,
          message: `No backups directory found at ${backupsDir}`,
          fix: 'astramem-local backup  to create the first snapshot',
        };
      }

      let entries: string[];
      try {
        entries = readdirSync(backupsDir).filter(n => /^memory-.*\.sqlite$/.test(n));
      } catch {
        return { ok: false, message: `Cannot read backups directory: ${backupsDir}` };
      }

      if (entries.length === 0) {
        return {
          ok: false,
          message: 'No backup snapshots found',
          fix: 'astramem-local backup  to create the first snapshot',
        };
      }

      // Find the most-recently modified backup
      let newestMtime = 0;
      for (const name of entries) {
        try {
          const mtime = statSync(join(backupsDir, name)).mtimeMs;
          if (mtime > newestMtime) newestMtime = mtime;
        } catch { /* skip files that disappeared */ }
      }

      const ageMs = Date.now() - newestMtime;
      const ageH = (ageMs / 3_600_000).toFixed(1);

      if (ageMs > TWENTY_FOUR_HOURS_MS) {
        return {
          ok: false,
          message: `Newest backup is ${ageH}h old (> 24h)`,
          fix: 'astramem-local backup  or enable nightly timer: astramem-local service install --with-backup-timer',
        };
      }

      return { ok: true, message: `Newest backup is ${ageH}h old (within 24h)` };
    },
  };
}

// ─── Check 13: Config dir divergence (Windows) ───────────────────────────────

/**
 * Warns when both the legacy (%APPDATA%\AstraMemory) and canonical
 * (%APPDATA%\Astramem) config dirs are present simultaneously. This indicates
 * a partially-migrated install and can cause bearer mismatches with the plugin.
 *
 * Also warns when the canonical dir's bearer differs from the plugin dir's
 * bearer (legacy dir = proxy for plugin if migration hasn't run yet), which is
 * the exact root cause of the v0.2.2 401 bug.
 */
function checkConfigDirDivergence(): Check {
  return {
    name: 'Config dir divergence (Windows)',
    async run(): Promise<CheckResult> {
      // Only meaningful on Windows; canonical and legacy are identical elsewhere.
      if (platform() !== 'win32') {
        return { ok: true, message: 'Config dir divergence check: N/A (non-Windows)' };
      }

      const canonical = defaultConfigDir();
      const legacy = legacyConfigDir();

      const canonicalExists = existsSync(canonical);
      const legacyExists = existsSync(legacy);

      // Both dirs present → migration hasn't cleaned up yet.
      if (canonicalExists && legacyExists) {
        // Additionally check whether the bearers differ.
        let bearerMismatch = false;
        let bearerDetail = '';
        try {
          const readBearer = (dir: string): string | null => {
            const p = join(dir, 'secrets.env');
            if (!existsSync(p)) return null;
            const line = readFileSync(p, 'utf8')
              .split('\n')
              .find(l => l.startsWith('MEMORY_BEARER='));
            if (!line) return null;
            return line.slice('MEMORY_BEARER='.length).trim() || null;
          };
          const canonicalBearer = readBearer(canonical);
          const legacyBearer = readBearer(legacy);
          if (
            canonicalBearer !== null &&
            legacyBearer !== null &&
            canonicalBearer !== legacyBearer
          ) {
            bearerMismatch = true;
            bearerDetail =
              ' Bearer mismatch detected — plugin will send the legacy bearer and get 401.';
          }
        } catch { /* non-fatal */ }

        return {
          ok: false,
          message:
            `Two config dirs present: "${legacy}" (legacy <=0.2.2) and "${canonical}" (canonical).` +
            bearerDetail,
          fix:
            bearerMismatch
              ? `Run "astramem-local init" in the canonical dir to unify bearers, ` +
                `then delete "${legacy}" manually.`
              : `Delete "${legacy}" after verifying all data has migrated to "${canonical}".`,
        };
      }

      // Only canonical → healthy.
      if (canonicalExists && !legacyExists) {
        return { ok: true, message: `Config dir canonical (${canonical})` };
      }

      // Only legacy → migration hasn't run yet (daemon not booted since upgrade).
      if (!canonicalExists && legacyExists) {
        return {
          ok: false,
          message:
            `Legacy config dir found at "${legacy}" but canonical "${canonical}" is absent. ` +
            `Migration will run on next "astramem-local serve".`,
          fix: 'Run "astramem-local serve" once to auto-migrate.',
        };
      }

      // Neither exists → fresh install.
      return { ok: true, message: 'Config dir: fresh install (no dirs yet)' };
    },
  };
}

function coreChecks(opts: DoctorCheckOpts): Check[] {
  const port = opts.port ?? 7777;
  const dataDir = opts.dataDir ?? join(tmpdir(), 'astramem');
  const dailyBudgetUsd = opts.dailyBudgetUsd ?? 10;

  const encryptionEnabled = opts.encryptionEnabled ?? true;

  const checks: Check[] = [
    checkDatadirWritable(dataDir),
    checkSqliteWritable(dataDir, encryptionEnabled),
    checkSqliteVec(),
    checkFts5(),
    checkDaemonReachable(port),
    checkDiskFree(dataDir),
    checkServiceUnit(opts.serviceUnitPath),
    checkBudget(dataDir, dailyBudgetUsd, encryptionEnabled),
    checkConfigDirDivergence(),
    checkRedaction(dataDir, opts.redactionEnabled ?? true, encryptionEnabled),
    checkEncryption(dataDir, encryptionEnabled),
  ];

  // LLM chat probes — real 1-token call, replaces surface-only /api/tags checks.
  // Run extraction separately only when it uses a different provider/model.
  if (opts.llmProviders) {
    const { compaction, extraction } = opts.llmProviders;
    checks.push(checkLLMChat(compaction, 'compaction'));
    const sameProvider =
      compaction.name === extraction.name && compaction.model === extraction.model;
    if (!sameProvider) {
      checks.push(checkLLMChat(extraction, 'extraction'));
    }
  }

  // Embed probe — real embed call + 1024-dim assertion.
  if (opts.embedProvider) {
    checks.push(checkEmbed(opts.embedProvider));
  }

  // Plugin coexistence — warn if MEMORY_API_URL or .mcp.json points elsewhere.
  checks.push(checkPluginCoexistence(port));

  // Backup recency — optional; only added when caller supplies a backupsDir.
  if (opts.backupsDir) {
    checks.push(checkBackupRecency(opts.backupsDir));
  }

  return checks;
}
