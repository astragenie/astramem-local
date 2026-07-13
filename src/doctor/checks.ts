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
import { join, dirname } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Check, CheckResult } from './types.js';
import type { LLMProvider } from '../contracts/llm.js';
import type { EmbedProvider } from '../contracts/embed.js';
import { llmChatProbe } from './probes/llm-chat-probe.js';
import { embedProbe } from './probes/embed-probe.js';
import { pluginCoexistenceProbe } from './probes/plugin-coexistence.js';
import { openAICompatibleReachabilityProbe } from './probes/openai-compatible-probe.js';
import { codexAuthProbe } from './probes/codex-subscription-probe.js';
import { OpenAICompatibleLLMProvider } from '../providers/llm/openai-compatible.js';
import { CodexSubscriptionLLMProvider } from '../providers/llm/codex-subscription.js';
import { defaultConfigDir, legacyConfigDir } from '../config/datadir.js';
import { shimPaths, exitHistoryPaths, type ShimPointer, type ExitHistoryEntry } from '../service/shim.js';
import { releaseIdFromEntryJs, defaultReleasesRoot } from '../service/release.js';
import { pathToFileURL } from 'node:url';
import { SCHEMA_VERSION } from '../server/lib/wire-meta.js';
import { getOrCreateKey, readBearer, getBearerIdentity, readSyncToken, getSyncTokenIdentity } from '../storage/keystore.js';
import { readBearerFromSecretsFile } from '../storage/bearer-keystore.js';
import { readSyncSettings } from '../config/sync-settings.js';
import { usefulnessRate, usefulnessByType, feedbackLoopSummary } from '../storage/usefulness.js';
import { totalRelationGuardDrops } from '../storage/relation-guard-log.js';
import { buildMemoryHealthFull, buildMemoryHealthCheap } from '../server/queries/memory-health.js';
import type { DB } from '../storage/db.js';
import type { DurabilityGateMode } from '../distill/durability-gate.js';
import type { ExtractProfile } from '../distill/prompts/extract.js';

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
  /**
   * Override for the shim pointer (current.json) path checked by the
   * "Service pointer" check. Defaults to `shimPaths().pointerPath` (the real
   * %LOCALAPPDATA%\Astramem\bin\current.json). Test-only seam — production
   * callers should never need to set this.
   */
  servicePointerPath?: string;
  /**
   * Override for the releases root the "Service pointer" check resolves the
   * pointer's entryJs against (via releaseIdFromEntryJs). Defaults to
   * `defaultReleasesRoot()` (the real %LOCALAPPDATA%\Astramem\releases).
   * Test-only seam — production callers should never need to set this.
   */
  releasesRoot?: string;
  /** FEAT-441 AC-8: current `distill.durabilityGate` mode. Defaults to
   * 'off' (the shipped default) when not supplied. */
  durabilityGateMode?: DurabilityGateMode;
  /** FEAT-479 AC-10 (SLICE-434): current `distill.extractProfile`. Defaults
   * to 'engineering' (the shipped default) when not supplied. Surfaced so
   * an operator running `conversational` sees the redaction-posture
   * disclosure every doctor run, not just buried in a config comment — see
   * `checkExtractProfile` below. */
  extractProfile?: ExtractProfile;
  /** FEAT-455 / ADR-012 decision 4: current `capture.autoCapture.enabled`.
   * Defaults to `false` (the shipped default) when not supplied. */
  autoCaptureEnabled?: boolean;
  /** FEAT-458 S1-AC-2 / ADR-013: current `proxy.enabled`. Defaults to
   * `false` (the shipped default) when not supplied. */
  proxyEnabled?: boolean;
  /** FEAT-458 S1-AC-2 / ADR-013: current `proxy.capture.enabled`. Defaults
   * to `false` (the shipped default) when not supplied. */
  proxyCaptureEnabled?: boolean;
  /** Whether dev no-auth mode is genuinely ACTIVE — i.e. `config.auth.
   * devNoAuth === true` AND the bind is loopback (mirrors buildApp's
   * `devNoAuthActive` in src/server/app.ts). NOT the same as the raw config
   * value: `devNoAuth: true` against a non-loopback bind is refused at boot
   * and stays inactive, so callers should pass the resolved/effective value,
   * not `cfg.auth.devNoAuth` directly. Defaults to `false` when not
   * supplied. */
  devNoAuthActive?: boolean;
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
export async function openProductionDbReadonly(dbPath: string, encryptionEnabled: boolean): Promise<DB> {
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

/**
 * Floor used by both the "Auto-capture" and "Usefulness feedback loop"
 * canaries below to distinguish "brand-new install, nothing has happened
 * yet" (silent) from "this daemon has seen real activity, and the wired
 * mechanism still never fired" (WARN). 20 is deliberately low enough that a
 * few days of normal use crosses it, but high enough that a fresh `init` on
 * day one never trips either check — both bugs this floor exists to catch
 * (2026-07-12: auto-capture hook, usefulness feedback loop) are "built,
 * wired, never invoked" bugs that only a live, non-trivial store can reveal.
 */
const MEANINGFUL_USAGE_THRESHOLD = 20;

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

// ─── Check: Recall usefulness (ADR-010) ───────────────────────────────────────

function checkUsefulness(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Recall usefulness',
    async run(): Promise<CheckResult> {
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        if (!existsSync(dbPath)) {
          return { ok: true, message: 'recall usefulness: no DB yet (0 served, 0 used)' };
        }
        const db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;
        const overall = usefulnessRate(db, { sinceMs: since });
        const byType = usefulnessByType(db, { sinceMs: since });
        db.close();

        const rateStr = overall.rate === null ? 'n/a' : `${(overall.rate * 100).toFixed(1)}%`;
        const breakdown = byType.length > 0
          ? ' — ' + byType.map(t => `${t.type}: ${t.rate === null ? 'n/a' : `${(t.rate * 100).toFixed(1)}%`} (${t.used}/${t.served})`).join(', ')
          : '';
        return {
          ok: true,
          message: `recall usefulness (7d): ${rateStr} (${overall.used}/${overall.served} atoms used/served)${breakdown}`,
        };
      } catch (err) {
        // Informational check — never fail doctor over a metric query error.
        return { ok: true, message: `Recall usefulness check error (non-fatal): ${err}` };
      }
    },
  };
}

// ─── Check: Usefulness feedback loop canary (2026-07-12 "never fired") ──────

/**
 * WARNs when the ADR-010 usefulness feedback loop has demonstrably NEVER
 * fired despite meaningful daemon activity — the bug found live in
 * production 2026-07-12: GET /profile returned 30 entries, every single one
 * pinned at the Laplace prior 0.5 (0 recall_used, 0 memory_corrected events,
 * ever). The mechanism itself is sound (see tests/e2e/usefulness-feedback-
 * loop.e2e.test.ts — submit_feedback/mark_memory_used, invalidate_memory/
 * supersede_memory, and usefulnessScores() all work correctly when actually
 * invoked); this check exists because CI cannot catch "wired but nobody
 * calls it" — only live usage data can, and only doctor sees live usage data.
 *
 * Reads ALL-TIME totals (feedbackLoopSummary — no sinceMs window), because
 * "has this ever happened even once" is a different question than "what's
 * the 7d rate" (that's checkUsefulness above, which stays purely
 * informational). Gated on the same MEANINGFUL_USAGE_THRESHOLD (20) floor
 * checkAutoCapture uses, applied to BOTH active memory count AND distinct
 * atoms actually served from a recall/search surface — a brand-new install,
 * or one whose owner has never recalled anything yet, legitimately has zero
 * feedback and must not warn.
 *
 * Uses buildMemoryHealthCheap() (not ...Full()) — this check only ever reads
 * report.activeCount, and the cheap tier already returns that via an
 * index-backed COUNT(*) (countActiveAndArchived). The full tier's extra
 * byType/byScope group-bys and staleness distribution are O(N) scans this
 * check never uses; checkMemoryHealth right above already pays that cost
 * once per doctor run for its own reporting, so calling ...Full() here would
 * be a second, redundant full-tier computation for one integer.
 */
function checkUsefulnessFeedbackLoop(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Usefulness feedback loop',
    async run(): Promise<CheckResult> {
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        if (!existsSync(dbPath)) {
          return { ok: true, message: 'usefulness feedback loop: no DB yet' };
        }
        const db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const report = buildMemoryHealthCheap(db);
        const summary = feedbackLoopSummary(db);
        db.close();

        const hasSignal = summary.usedDistinct > 0 || summary.correctedDistinct > 0;
        const meaningfulUsage =
          report.activeCount >= MEANINGFUL_USAGE_THRESHOLD &&
          summary.servedDistinct >= MEANINGFUL_USAGE_THRESHOLD;

        if (meaningfulUsage && !hasSignal) {
          return {
            ok: false,
            message:
              `usefulness feedback loop has NEVER fired: ${report.activeCount} active memories, ` +
              `${summary.servedDistinct} distinct atoms served from recall/search, 0 marked used and 0 ` +
              `corrected — every score is still pinned at the neutral 0.5 prior (2026-07-12 "built, wired, ` +
              `never invoked" bug class). Ranking is not adapting to anything.`,
            fix: 'Confirm something in the real usage path actually calls submit_feedback/mark_memory_used for positive signal, and invalidate_memory/supersede_memory for corrections — today nothing does (ADR-010 v1 shipped the mechanism only).',
          };
        }

        if (!meaningfulUsage) {
          return {
            ok: true,
            message:
              `usefulness feedback loop: not enough activity yet to judge (${report.activeCount} active ` +
              `memories, ${summary.servedDistinct} served) — below the ${MEANINGFUL_USAGE_THRESHOLD}/${MEANINGFUL_USAGE_THRESHOLD} floor`,
          };
        }

        return {
          ok: true,
          message: `usefulness feedback loop: active (${summary.usedDistinct} used, ${summary.correctedDistinct} corrected, distinct atoms, all-time)`,
        };
      } catch (err) {
        // Informational failure mode — never fail doctor over a metric query
        // error, consistent with the other read-only DB checks above.
        return { ok: true, message: `usefulness feedback loop check error (non-fatal): ${err}` };
      }
    },
  };
}

// ─── Check: Memory health score (FEAT-444) ────────────────────────────────────

/**
 * FEAT-444 AC-1: memory-health row. Shape is `CheckResult`
 * (src/doctor/types.ts) — the runner (src/doctor/runner.ts's
 * `CheckResultWithName`) adds the `name` field to every check's result, this
 * one included, exactly like every other check here (design-review
 * correction: the FEAT's original AC-1 text cited `CheckResultWithName` as
 * living in types.ts; it actually lives in runner.ts — this check returns
 * plain `CheckResult` like all the others and lets `runChecks()` do the
 * wrapping, same as every check above).
 *
 * Uses buildMemoryHealthFull() (server/queries/memory-health.ts) — the
 * doctor/CLI tier that includes the byType/byScope + staleness breakdown on
 * top of the /health cheap subset. Read-only: no INSERT/UPDATE/DELETE
 * against memories, memory_events, or consolidation_proposals (AC-1/AC-3).
 * Never fails doctor over a metric query error — informational, like the
 * "Recall usefulness" check above.
 */
function checkMemoryHealth(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Memory health',
    async run(): Promise<CheckResult> {
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        if (!existsSync(dbPath)) {
          return { ok: true, message: 'memory health: no DB yet (0 memories — clean slate)' };
        }
        const db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const report = buildMemoryHealthFull(db);
        db.close();

        if (report.activeCount === 0) {
          return { ok: true, message: 'memory health: no data yet (0 active memories)' };
        }

        const coverageStr = report.usefulness.coverageRate === null
          ? 'n/a' : `${(report.usefulness.coverageRate * 100).toFixed(1)}%`;
        const correctionStr = report.corrections.rate === null
          ? 'n/a' : `${(report.corrections.rate * 100).toFixed(1)}%`;
        const staleTop = (report.staleness ?? [])
          .map(b => `${b.label}: ${b.count}`)
          .join(', ');

        return {
          ok: true,
          message:
            `memory health: ${report.activeCount} active / ${report.archivedCount} archived — ` +
            `usefulness coverage ${coverageStr}, correction rate ${correctionStr}, ` +
            `${report.poisonDistillSessions} poison-distill session(s), staleness [${staleTop}]`,
        };
      } catch (err) {
        return { ok: true, message: `Memory health check error (non-fatal): ${err}` };
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
        const { source, identity } = getOrCreateKey(defaultConfigDir());
        const label = source === 'credential-store' ? 'keychain' : 'key-file';
        // AC-5: surface which credential-store identity (scoped vs legacy)
        // this daemon is actually reading its key from.
        const identitySuffix = identity ? `, identity: ${identity}` : '';

        const dbPath = join(dataDir, 'memory.sqlite');
        if (existsSync(dbPath)) {
          const header = readFileSync(dbPath).subarray(0, 16).toString('latin1');
          if (header.startsWith('SQLite format 3')) {
            return {
              ok: false,
              message: `encryption: on (${label}${identitySuffix}) but memory.sqlite header is still PLAINTEXT — auto-migration has not run yet`,
              fix: 'astramem-local serve  (auto-migrates a plaintext DB to encrypted form on next start)',
            };
          }
        }
        return { ok: true, message: `encryption: on (${label}${identitySuffix})` };
      } catch (err) {
        return { ok: false, message: `Encryption check error: ${err}` };
      }
    },
  };
}

// ─── Check: Bearer token location (SEC-10) ────────────────────────────────────

function checkBearerLocation(): Check {
  return {
    name: 'Bearer token location',
    async run(): Promise<CheckResult> {
      try {
        const configDir = defaultConfigDir();
        if (readBearer(configDir)) {
          // AC-5: surface which credential-store identity (scoped vs
          // legacy) this daemon is actually reading its bearer from.
          const identity = getBearerIdentity(configDir);
          return { ok: true, message: `bearer: OS credential store (identity: ${identity})` };
        }
        if (readBearerFromSecretsFile()) {
          return {
            ok: false,
            message: 'bearer: secrets.env (plaintext fallback) — OS credential store unavailable or not yet migrated',
            fix: 'Run "astramem-local token rotate" to migrate the bearer into the OS credential store.',
          };
        }
        return {
          ok: false,
          message: 'bearer: missing — no MEMORY_BEARER in credential store or secrets.env',
          fix: 'Run "astramem-local init" or "astramem-local token rotate" to generate one.',
        };
      } catch (err) {
        return { ok: false, message: `Bearer location check error: ${err}` };
      }
    },
  };
}

// ─── Check: Sync device token location (FEAT-472) ─────────────────────────────

function checkSyncTokenLocation(): Check {
  return {
    name: 'Sync device token location',
    async run(): Promise<CheckResult> {
      try {
        const configDir = defaultConfigDir();
        // sync.json (config/sync-settings.ts) is authoritative for whether
        // sync is paired at all — a never-paired install has no device
        // token to report on, and that is not a doctor warning.
        const settings = readSyncSettings(configDir);
        if (!settings?.enabled) {
          return { ok: true, message: 'sync device token: sync not paired (run "astramem-local pair <code>" to enable cloud sync)' };
        }
        if (process.env.ASTRA_SYNC_TOKEN) {
          return { ok: true, message: 'sync device token: ASTRA_SYNC_TOKEN env override active' };
        }
        if (readSyncToken(configDir)) {
          // Surfaces which credential-store identity (scoped vs legacy) this
          // daemon is actually reading its sync device token from — same
          // AC-5-shaped row FEAT-466 added for the bearer.
          const identity = getSyncTokenIdentity(configDir);
          return { ok: true, message: `sync device token: OS credential store (identity: ${identity})` };
        }
        return {
          ok: false,
          message: 'sync device token: missing — sync.json is paired but no device token is stored',
          fix: 'Run "astramem-local pair <code>" again to re-store the device token, or set ASTRA_SYNC_TOKEN.',
        };
      } catch (err) {
        return { ok: false, message: `Sync device token check error: ${err}` };
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
    name: `Embed probe (${provider.dim}-dim)`,
    async run(): Promise<CheckResult> {
      return embedProbe(provider);
    },
  };
}

// ─── Check: openai-compatible reachability / codex-subscription auth ────────

function checkOpenAICompatibleReachable(provider: OpenAICompatibleLLMProvider, label: string): Check {
  return {
    name: `OpenAI-compatible reachability (${label})`,
    async run(): Promise<CheckResult> {
      return openAICompatibleReachabilityProbe(provider.baseUrl);
    },
  };
}

function checkCodexAuth(provider: CodexSubscriptionLLMProvider, label: string): Check {
  return {
    name: `Codex auth (${label})`,
    async run(): Promise<CheckResult> {
      return codexAuthProbe(provider.authPath);
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

// ─── Check: Service pointer — release-pinned vs dev-pinned (FEAT-438 SLICE-418 AC-4) ──

/**
 * Warns loudly when the service pointer (current.json) is `--dev`-pinned
 * (src/cli/reinstall.ts's `reinstallDev`) — i.e. serving the mutable
 * checkout's `dist/` rather than an immutable release dir. That is exactly
 * the footgun FEAT-438 exists to close (the 2026-07-07 stale-dist outage),
 * so a doctor run should never let it go unnoticed. Cross-platform since
 * FEAT-443 SLICE-1 — current.json indirection now exists on linux/darwin too
 * (see shim.ts / install-flow.ts, which write the stable shim unconditionally
 * on every platform), so this check no longer gates on `platform() === 'win32'`.
 */
function checkServicePointer(pointerPathOverride?: string, releasesRootOverride?: string): Check {
  return {
    name: 'Service pointer',
    async run(): Promise<CheckResult> {
      const pointerPath = pointerPathOverride ?? shimPaths().pointerPath;
      if (!existsSync(pointerPath)) {
        return { ok: true, message: 'Service pointer: not installed yet (no current.json)' };
      }

      let pointer: ShimPointer;
      try {
        pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as ShimPointer;
      } catch (err) {
        return {
          ok: false,
          message: `Service pointer: current.json unreadable: ${err}`,
          fix: 'astramem-local reinstall',
        };
      }

      if (pointer.devPinned) {
        return {
          ok: false,
          message: "service is DEV-PINNED to the checkout dist/ (not a release) — run 'reinstall' to re-pin",
          fix: 'astramem-local reinstall',
        };
      }

      // devPinned is NOT set — but that alone does not mean release-pinned.
      // A fresh `init` / `service install` (install-flow.ts with no
      // entryJsOverride) points current.json straight at the checkout's
      // dist/ WITHOUT ever setting devPinned (only reinstallDev does that).
      // Only trust "release-pinned" when entryJs actually resolves to a
      // real release id under releasesRoot.
      const id = releaseIdFromEntryJs(pointer.entryJs, releasesRootOverride);
      if (id) {
        return { ok: true, message: `service is release-pinned: ${id}` };
      }
      return {
        ok: false,
        message: `service pointer is not release-pinned (entry: ${pointer.entryJs}) — run 'reinstall' to pin a release`,
        fix: 'astramem-local reinstall',
      };
    },
  };
}

// ─── Check: Crash loop (FEAT-440 AC-3/AC-5) ──────────────────────────────────

/**
 * Reads the shim's exit-history.jsonl (see service/shim.ts's
 * exitHistoryPaths()/appendExitHistory in LAUNCHER_SOURCE) and RED-flags a
 * crash loop: >= `threshold` consecutive non-zero exits in the tail of the
 * history. Counting walks backward from the newest entry and stops at the
 * first exitCode === 0 — a clean run (including the instance lock's healthy
 * <100ms fast-exit, AC-5) always resets the streak, distinguished from a
 * real crash purely by exitCode, not durationMs (both exit 0; durationMs is
 * carried in the record for a human/dashboard to eyeball, not used here as
 * a gate).
 */
function checkCrashLoop(dataDir: string, threshold = 3): Check {
  return {
    name: 'Crash loop',
    async run(): Promise<CheckResult> {
      const { historyPath, crashLogPath } = exitHistoryPaths(dataDir);
      if (!existsSync(historyPath)) {
        return { ok: true, message: 'crash loop: no exit history yet' };
      }

      let entries: ExitHistoryEntry[];
      try {
        entries = readFileSync(historyPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line): ExitHistoryEntry | null => {
            try {
              return JSON.parse(line) as ExitHistoryEntry;
            } catch {
              return null;
            }
          })
          .filter((e): e is ExitHistoryEntry => e !== null);
      } catch (err) {
        // Informational check — never fail doctor over a corrupt/unreadable
        // history file; that's its own (non-fatal) signal, not a crash loop.
        return { ok: true, message: `crash loop check error (non-fatal): ${err}` };
      }

      if (entries.length === 0) {
        return { ok: true, message: 'crash loop: no exit history yet' };
      }

      const streak: ExitHistoryEntry[] = [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        if (entry.exitCode === 0) break;
        streak.unshift(entry);
      }

      if (streak.length < threshold) {
        return {
          ok: true,
          message: `crash loop: ${streak.length} consecutive non-zero exit(s) (below threshold of ${threshold})`,
        };
      }

      const codes = streak.map(e => e.exitCode).join(', ');
      const first = streak[0]!.ts;
      const last = streak[streak.length - 1]!.ts;

      let crashTail = '(crash.log not found)';
      try {
        if (existsSync(crashLogPath)) {
          const raw = readFileSync(crashLogPath, 'utf8');
          crashTail = raw.length > 2000 ? raw.slice(raw.length - 2000) : raw;
        }
      } catch { /* non-fatal — still report the crash-loop finding without the tail */ }

      return {
        ok: false,
        message:
          `crash loop detected: ${streak.length} consecutive non-zero exits [${codes}] ` +
          `between ${first} and ${last}\n--- crash.log tail ---\n${crashTail}`,
        fix: 'Fix the underlying error (see crash.log tail above) and restart the service — ' +
          'a single zero-exit run resets the streak; the next doctor run goes GREEN.',
      };
    },
  };
}

// ─── Check: Durability gate mode (FEAT-441 AC-8) ─────────────────────────────

/**
 * Informational row reporting the current `distill.durabilityGate` mode —
 * never a WARN in any mode ('off'/'lenient'/'strict' all report ok: true).
 * 'strict' is opt-in (not the shipped default), so surfacing it here is
 * about operational visibility, not flagging a misconfiguration.
 */
function checkDurabilityGateMode(mode: DurabilityGateMode): Check {
  return {
    name: 'Distill durability gate',
    async run(): Promise<CheckResult> {
      if (mode === 'off') {
        return { ok: true, message: 'durability gate: off (default — no atoms are gated at persist time)' };
      }
      return { ok: true, message: `durability gate: ${mode} (see FEAT-441 / src/distill/durability-gate.ts)` };
    },
  };
}

// ─── Check: Extraction profile (FEAT-479 AC-10 / SLICE-434) ──────────────────

/**
 * Informational-only row (`ok: true` always — mirrors `checkDurabilityGateMode`'s
 * precedent: a deliberate, disclosed config choice is never itself a WARN).
 * Its whole job is the redaction-posture disclosure: `conversational` extracts
 * MUCH more personal detail (names, relationships, life events) than
 * `engineering` does, and `src/redact/index.ts` is unchanged either way — it
 * only strips SECRETS (tokens/keys/passwords/high-entropy strings), never
 * non-secret personal content. Every operator running `conversational`
 * should see this on every `doctor` run, not only in a config.yaml comment.
 */
function checkExtractProfile(profile: ExtractProfile): Check {
  return {
    name: 'Extraction profile',
    async run(): Promise<CheckResult> {
      if (profile === 'conversational') {
        return {
          ok: true,
          message:
            'extraction profile: conversational — extracts personal facts/relationships/events liberally. ' +
            'Redaction is UNCHANGED (secrets only — tokens/keys/passwords); non-secret personal content is ' +
            'NOT redacted and stays on-device in the local SQLite store, same as the engineering profile ' +
            '(see FEAT-479 / src/distill/prompts/extract.ts).',
        };
      }
      return { ok: true, message: 'extraction profile: engineering (default)' };
    },
  };
}

// ─── Check: Entity relations extraction (FEAT-481 SLICE-430) ────────────────

/**
 * "Built, wired, never invoked" canary for the entity-to-entity relation
 * pipeline (FEAT-481/SLICE-435: AtomRelationSchema in the extraction prompt
 * -> filterAtomRelations (05-extract.ts) -> stage 8's write into
 * `entity_relations`). Doctor is the only place that can catch "the code
 * compiles and unit tests pass, but distilling a real transcript never
 * actually produces a row" — see the design doc's own framing of this exact
 * failure mode for this repo.
 *
 * `relations[]` guidance was added to the ENGINEERING prompt only
 * (src/distill/prompts/extract.ts's SLICE-435 update comment — the
 * conversational profile, SLICE-434, was deliberately not extended to
 * cover it). So a zero row count under `extractProfile: 'conversational'`
 * is not evidence of anything broken — this check stays informational in
 * that case regardless of activity, rather than false-alarming on a profile
 * that was never asked to produce relations in the first place.
 *
 * Under the engineering profile (the default), gated on the same
 * MEANINGFUL_USAGE_THRESHOLD floor `checkAutoCapture`/
 * `checkUsefulnessFeedbackLoop` use — a brand-new or low-activity install
 * legitimately has zero relations and must not warn. Once that floor is
 * crossed with zero `entity_relations` rows, `relation_guard_drops` (029,
 * see src/storage/relation-guard-log.ts) is the tie-breaker: drops > 0 means
 * the model IS emitting relations and the guard is dropping every one
 * (predicate/hallucination/shape issue, or a model-capability gap);
 * drops == 0 too means the model itself never emits a `relations[]` entry
 * at all — both are folded into one WARN message (the fix guidance covers
 * both causes) since the operator-facing remedy — check the extraction
 * model / look at debug logs — is the same either way.
 */
function checkEntityRelations(
  dataDir: string,
  extractProfile: ExtractProfile,
  encryptionEnabled: boolean,
): Check {
  return {
    name: 'Entity relations extraction',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'entity relations: no DB yet' };
      }

      try {
        const db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;

        const totalRow = db.prepare('SELECT COUNT(*) AS n FROM entity_relations').get() as { n: number };
        const total = totalRow.n;
        const recent7dRow = db
          .prepare('SELECT COUNT(*) AS n FROM entity_relations WHERE created_at >= ?')
          .get(since) as { n: number };
        const recent7d = recent7dRow.n;
        const newestRow = db.prepare('SELECT MAX(created_at) AS ts FROM entity_relations').get() as
          | { ts: number | null }
          | undefined;
        const newestAgeH = newestRow?.ts ? ((Date.now() - newestRow.ts) / 3_600_000).toFixed(1) : null;

        if (total > 0) {
          db.close();
          const ageStr = newestAgeH !== null ? `, newest ${newestAgeH}h old` : '';
          return {
            ok: true,
            message: `entity relations: ${total} row(s) total (${recent7d} in last 7d${ageStr})`,
          };
        }

        // total === 0 from here down.
        if (extractProfile === 'conversational') {
          db.close();
          return {
            ok: true,
            message:
              'entity relations: 0 rows — expected under the conversational extraction profile ' +
              '(relations[] guidance is engineering-profile only, see FEAT-481 SLICE-435).',
          };
        }

        const recentMemoriesRow = db
          .prepare('SELECT COUNT(*) AS n FROM memories WHERE created_at >= ?')
          .get(since) as { n: number };
        const recentMemories = recentMemoriesRow.n;

        if (recentMemories < MEANINGFUL_USAGE_THRESHOLD) {
          db.close();
          return {
            ok: true,
            message:
              `entity relations: 0 rows — not enough distill activity yet to judge (${recentMemories} ` +
              `memories in last 7d, below the ${MEANINGFUL_USAGE_THRESHOLD} floor)`,
          };
        }

        const guardDrops7d = totalRelationGuardDrops(db, since);
        db.close();

        return {
          ok: false,
          message:
            `relations extraction is wired but has never produced a row — check model capability or guard ` +
            `drops (${recentMemories} memories distilled in last 7d, 0 entity_relations rows, ` +
            `${guardDrops7d} guard-drop event(s) recorded in the same window — ` +
            (guardDrops7d > 0
              ? 'the model IS emitting relations and the guard is dropping every one.'
              : 'the model itself is not emitting any relations[] entries.') +
            ')',
          fix:
            'Check debug logs for "relations[]: dropped" lines (src/distill/stages/05-extract.ts) to see which ' +
            'guard is firing, or confirm the extraction model actually supports the relations[] JSON shape in ' +
            'the engineering prompt.',
        };
      } catch (err) {
        // Informational failure mode — never fail doctor over a metric query
        // error, consistent with the other read-only DB checks above.
        return { ok: true, message: `entity relations check error (non-fatal): ${err}` };
      }
    },
  };
}

// ─── Check: Auto-capture (FEAT-455 / ADR-012 decision 4) ─────────────────────

/**
 * Visibility row for the hook-tap auto-capture trigger. `ok: true` covers
 * both "off" (default) and "on, working" — unlike `checkServicePointer`'s
 * dev-pinned row (an always-unintended misconfiguration, hence `ok: false`),
 * auto-capture being ON is a deliberate, disclosed, opt-in user choice
 * (ADR-012 decision 4's whole point), so merely being ON is never itself a
 * warning. Mirrors `checkDurabilityGateMode`'s informational-row precedent
 * for that half.
 *
 * `ok: false` (WARN) is reserved for one specific, previously-silent failure
 * mode found live in production 2026-07-12: the hook is turned ON, the
 * daemon has real content in it (>= MEANINGFUL_USAGE_THRESHOLD active
 * memories from ANY source), and yet 0 of them ever came through capture —
 * the trigger is wired but never actually fires. A brand-new install below
 * that floor stays silent (`ok: true`) so day-one users never see a false
 * alarm before they've had a chance to accumulate any activity.
 *
 * 2026-07-12 provenance-mismatch fix: the count below now includes BOTH
 * `capture_source = 'auto_capture'` (the denser-sampling trigger this row is
 * nominally about) AND `'hook_close'` (the ordinary astramem-plugin
 * close-capture hook — the only capture path that actually fires today; see
 * src/cli/capture.ts). Before this fix, a user who enabled auto-capture but
 * never got the (still-unbuilt) denser-sampling trigger would see a
 * permanent false-positive WARN here even though ordinary close-capture was
 * working perfectly — the canary was checking the wrong provenance value,
 * not detecting a real wiring failure.
 */
function checkAutoCapture(dataDir: string, autoCaptureEnabled: boolean, encryptionEnabled: boolean): Check {
  return {
    name: 'Auto-capture',
    async run(): Promise<CheckResult> {
      if (!autoCaptureEnabled) {
        return { ok: true, message: 'auto-capture: off (default)' };
      }

      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'auto-capture is ON — no DB yet, 0 auto-captured memories' };
      }

      try {
        const db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const row = db
          .prepare(`SELECT COUNT(*) AS count FROM memories WHERE capture_source IN ('auto_capture', 'hook_close') AND valid_to IS NULL`)
          .get() as { count: number } | undefined;
        const totalRow = db
          .prepare(`SELECT COUNT(*) AS count FROM memories WHERE valid_to IS NULL AND archived = 0`)
          .get() as { count: number } | undefined;
        db.close();
        const count = row?.count ?? 0;
        const totalActive = totalRow?.count ?? 0;

        if (count === 0 && totalActive >= MEANINGFUL_USAGE_THRESHOLD) {
          return {
            ok: false,
            message:
              `auto-capture is ON but 0 memories have ever come through auto-capture or the close-capture hook, ` +
              `despite ${totalActive} active memories already in the store (>= ${MEANINGFUL_USAGE_THRESHOLD} ` +
              `threshold — this daemon has seen real activity). The hook is likely wired but never firing ` +
              `(2026-07-12 "built, wired, never invoked" bug class).`,
            fix: 'Verify the capture hook is actually installed and dispatching to this daemon (check the runner-plugin hook config, and daemon logs for incoming /ingest calls tagged capture_source=auto_capture or hook_close). Also check `astramem-local --version` on PATH — a stale global install predating the `capture` subcommand (e.g. 0.3.4) will silently no-op inside the hook.',
          };
        }

        return {
          ok: true,
          message: `auto-capture is ON — ${count} auto-captured ${count === 1 ? 'memory' : 'memories'} currently stored`,
        };
      } catch (err) {
        // Informational failure mode — never fail doctor over a count-query
        // error, consistent with the other read-only DB checks above.
        return { ok: true, message: `auto-capture is ON — count check error (non-fatal): ${err}` };
      }
    },
  };
}

// ─── Check: LLM proxy (FEAT-458 S1-AC-2, ADR-013) ─────────────────────────────

/**
 * Visibility row for the LLM proxy relay (`astramem-local proxy serve`,
 * src/proxy/server.ts). Same `ok: true`-in-every-state posture as
 * `checkAutoCapture` above — proxy-enabled-and-running (with or without
 * capture) is a deliberate opt-in per ADR-013 §5, never itself a
 * misconfiguration, so this never reports `ok: false` on its own.
 *
 * S2 ships zero capture code (docs/specs/FEAT-458-S1-design.md §2.3): the
 * `capture_source = 'proxy'` count is always 0 until FEAT-458 S3 lands the
 * capture fork, but the row is still worth shipping now — it gives
 * visibility into "the proxy is configured on" even before any capture
 * write path exists, matching the S2/S3 split. There is deliberately no
 * live reachability probe here (unlike `checkDaemonReachable`): S2's proxy
 * has no HTTP control-plane route (src/cli/proxy.ts's own doc comment — no
 * `/status`, no `/config`) and its one route transparently forwards
 * whatever it's sent to `upstream`, so a doctor-side fetch would either hit
 * a real (possibly billed) upstream or hang on an unreachable one. This
 * check is config-state-only by design.
 */
function checkProxyCapture(
  dataDir: string,
  proxyEnabled: boolean,
  captureEnabled: boolean,
  encryptionEnabled: boolean,
): Check {
  return {
    name: 'LLM proxy',
    async run(): Promise<CheckResult> {
      if (!proxyEnabled) {
        return { ok: true, message: 'proxy: off (default)' };
      }
      if (!captureEnabled) {
        return { ok: true, message: 'proxy is ON — capture is off (transparent forward only)' };
      }

      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'proxy capture is ON — no DB yet, 0 proxy-captured memories' };
      }

      try {
        const db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const row = db
          .prepare(`SELECT COUNT(*) AS count FROM memories WHERE capture_source = 'proxy' AND valid_to IS NULL`)
          .get() as { count: number } | undefined;
        db.close();
        const count = row?.count ?? 0;

        return {
          ok: true,
          message: `proxy capture is ON — ${count} proxy-captured ${count === 1 ? 'memory' : 'memories'} currently stored`,
        };
      } catch (err) {
        // Informational failure mode — never fail doctor over a count-query
        // error, consistent with the other read-only DB checks above.
        return { ok: true, message: `proxy capture is ON — count check error (non-fatal): ${err}` };
      }
    },
  };
}

// ─── Check: Proxy capture reminder (FEAT-458 S4, ADR-013) ────────────────────

/**
 * Genuine, every-run WARN while proxy capture is actively ON — deliberately
 * a SEPARATE check from `checkProxyCapture` above (S1's "LLM proxy" row),
 * not an extension of it. `checkProxyCapture` stays `ok: true` in every
 * state by design: being ON is a disclosed, opt-in choice (ADR-013 §5), so
 * merely being ON is never itself a misconfiguration — that posture is
 * correct and this check doesn't change it (config.ts:344's comment: "so
 * `doctor` has something to read (FEAT-458 S4)" describes THIS row, not a
 * retrofit of that one).
 *
 * The reason a distinct row is warranted: unlike `checkAutoCapture`'s
 * "wired, never fired" canary (a one-shot misconfiguration to detect and
 * clear), proxy capture recording upstream LLM PROMPTS while active is an
 * ongoing fact the operator should be reminded of on every single `doctor`
 * run for as long as it stays on — not just disclosed once at opt-in time.
 * So `ok: false` here is unconditional on "capture is enabled" (no DB
 * content check, no count, no threshold) — it fires immediately and clears
 * immediately the moment `astramem-local capture proxy disable` flips
 * `proxy.capture.enabled` back to false (S3, src/cli/capture.ts).
 */
function checkProxyCaptureReminder(proxyEnabled: boolean, captureEnabled: boolean): Check {
  return {
    name: 'Proxy capture reminder',
    async run(): Promise<CheckResult> {
      if (!proxyEnabled || !captureEnabled) {
        return { ok: true, message: 'proxy capture: off' };
      }
      return {
        ok: false,
        message:
          'proxy capture is ON — every upstream LLM prompt routed through this proxy is being recorded ' +
          'until you turn it off.',
        fix: 'astramem-local capture proxy disable [--purge|--keep]',
      };
    },
  };
}

// ─── Check: Dev no-auth mode reminder (Config['auth'] devNoAuth) ─────────────

/**
 * Genuine, every-run WARN while `auth.devNoAuth` is active — same posture as
 * `checkProxyCaptureReminder` above (an ongoing, disclosed risk the operator
 * should be reminded of on every single `doctor` run for as long as it stays
 * on, not a one-shot wiring canary). `devNoAuthActive` mirrors the exact
 * predicate `buildApp` uses to decide whether the auth hook actually skips
 * enforcement (`config.auth.devNoAuth === true && isLoopbackHost(host)`) —
 * this check WARNs only when auth is genuinely bypassed, not merely
 * configured-but-refused (the non-loopback-bind case already logs its own
 * loud boot-time warning in app.ts and leaves Bearer enforcement in place).
 */
function checkDevNoAuth(devNoAuthActive: boolean): Check {
  return {
    name: 'Dev no-auth mode',
    async run(): Promise<CheckResult> {
      if (!devNoAuthActive) {
        return { ok: true, message: 'dev no-auth mode: off' };
      }
      return {
        ok: false,
        message:
          'auth disabled for local dev — every local process can read/write memories; ' +
          'do not run with sync pairing to prod.',
        fix: 'set auth.devNoAuth: false in config.yaml',
      };
    },
  };
}

// ─── Check: Schema drift (FEAT-439 AC-2/AC-5) ────────────────────────────────

interface ServedSchemaVersion {
  version: number;
  source: string;
}

/**
 * Determine the SCHEMA_VERSION of the release actually being served, per
 * current.json's pointer — NOT this doctor process's own import, which only
 * reflects whichever build happens to be running doctor (the repo working
 * tree, when doctor runs from a checkout). When the pointer resolves to a
 * real release dir (release-pinned, not --dev-pinned — same distinction
 * checkServicePointer above makes), dynamically imports THAT release's own
 * compiled wire-meta.js so the comparison is against what's genuinely
 * served, not a same-machine coincidence. Falls back to the doctor process's
 * own SCHEMA_VERSION (source: "repo working tree") whenever the pointer is
 * absent, dev-pinned, or its release's wire-meta.js can't be read — matching
 * the FEAT body's third candidate source ("SCHEMA_VERSION of the repo
 * working tree, when doctor runs from repo").
 */
async function resolveServedSchemaVersion(
  pointerPathOverride?: string,
  releasesRootOverride?: string,
): Promise<ServedSchemaVersion> {
  const pointerPath = pointerPathOverride ?? shimPaths().pointerPath;
  if (existsSync(pointerPath)) {
    try {
      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as ShimPointer;
      if (!pointer.devPinned) {
        const id = releaseIdFromEntryJs(pointer.entryJs, releasesRootOverride ?? defaultReleasesRoot());
        if (id) {
          const wireMetaPath = join(dirname(pointer.entryJs), '..', 'server', 'lib', 'wire-meta.js');
          if (existsSync(wireMetaPath)) {
            const mod = (await import(pathToFileURL(wireMetaPath).href)) as { SCHEMA_VERSION?: unknown };
            if (typeof mod.SCHEMA_VERSION === 'number') {
              return { version: mod.SCHEMA_VERSION, source: `release ${id}` };
            }
          }
        }
      }
    } catch {
      // Fall through to the repo-working-tree fallback below — a pointer
      // read/parse/import failure here is not itself a schema-drift finding.
    }
  }
  return { version: SCHEMA_VERSION, source: 'repo working tree' };
}

/**
 * FEAT-439 AC-2/AC-5: compares the served release's SCHEMA_VERSION (see
 * resolveServedSchemaVersion above) against the live DB's migration counter
 * (`MAX(version) FROM schema_version`, the same table migrate.ts's own
 * boot-time drift guard reads — src/storage/migrate.ts:100). Read-only: no
 * writes to the DB, so re-running immediately after a GREEN result stays
 * GREEN with no side effects (AC-5).
 */
function checkSchemaDrift(
  dataDir: string,
  encryptionEnabled: boolean,
  pointerPathOverride?: string,
  releasesRootOverride?: string,
): Check {
  return {
    name: 'Schema drift',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'schema drift: no DB yet (nothing to compare)' };
      }

      let dbSchemaVersion: number;
      try {
        const db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const tableExists = db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`)
          .get();
        if (!tableExists) {
          db.close();
          return { ok: true, message: 'schema drift: DB not migrated yet (no schema_version table)' };
        }
        const row = db.prepare('SELECT MAX(version) AS max_version FROM schema_version').get() as
          | { max_version: number | null }
          | undefined;
        db.close();
        dbSchemaVersion = row?.max_version ?? 0;
      } catch (err) {
        // Informational failure mode — never fail doctor over a metric/probe
        // query error, consistent with the other read-only DB checks above.
        return { ok: true, message: `schema drift check error (non-fatal): ${err}` };
      }

      const served = await resolveServedSchemaVersion(pointerPathOverride, releasesRootOverride);

      if (served.version === dbSchemaVersion) {
        return {
          ok: true,
          message: `schema drift: none (served ${served.source} SCHEMA_VERSION=${served.version} == DB migration counter=${dbSchemaVersion})`,
        };
      }

      return {
        ok: false,
        message:
          `schema drift: served ${served.source} SCHEMA_VERSION=${served.version} != ` +
          `live DB migration counter=${dbSchemaVersion} — the served build and the live DB have diverged ` +
          `(2026-07-07 stale-dist incident class).`,
        fix: 'astramem-local reinstall',
      };
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
    checkServicePointer(opts.servicePointerPath, opts.releasesRoot),
    checkCrashLoop(dataDir),
    checkSchemaDrift(dataDir, encryptionEnabled, opts.servicePointerPath, opts.releasesRoot),
    checkBudget(dataDir, dailyBudgetUsd, encryptionEnabled),
    checkConfigDirDivergence(),
    checkRedaction(dataDir, opts.redactionEnabled ?? true, encryptionEnabled),
    checkEncryption(dataDir, encryptionEnabled),
    checkBearerLocation(),
    checkSyncTokenLocation(),
    checkUsefulness(dataDir, encryptionEnabled),
    checkUsefulnessFeedbackLoop(dataDir, encryptionEnabled),
    checkMemoryHealth(dataDir, encryptionEnabled),
    checkDurabilityGateMode(opts.durabilityGateMode ?? 'off'),
    checkExtractProfile(opts.extractProfile ?? 'engineering'),
    checkEntityRelations(dataDir, opts.extractProfile ?? 'engineering', encryptionEnabled),
    checkAutoCapture(dataDir, opts.autoCaptureEnabled ?? false, encryptionEnabled),
    checkProxyCapture(dataDir, opts.proxyEnabled ?? false, opts.proxyCaptureEnabled ?? false, encryptionEnabled),
    checkProxyCaptureReminder(opts.proxyEnabled ?? false, opts.proxyCaptureEnabled ?? false),
    checkDevNoAuth(opts.devNoAuthActive ?? false),
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

    // Provider-specific supplementary checks (openai-compatible reachability,
    // codex-subscription auth.json presence/expiry) — additive to, not a
    // replacement for, the generic chat probe above.
    for (const [provider, label] of (
      sameProvider ? [[compaction, 'compaction'] as const] : [[compaction, 'compaction'] as const, [extraction, 'extraction'] as const]
    )) {
      if (provider instanceof OpenAICompatibleLLMProvider) {
        checks.push(checkOpenAICompatibleReachable(provider, label));
      }
      if (provider instanceof CodexSubscriptionLLMProvider) {
        checks.push(checkCodexAuth(provider, label));
      }
    }
  }

  // Embed probe — real embed call + config-derived dim assertion (FEAT-409).
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
