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
import { totalValidityGuardDrops } from '../storage/validity-guard-log.js';
import { spoolQuarantineDir, readSpoolStats, DEFAULT_QUARANTINE_TTL_MS } from '../ingest/spool.js';
import { totalEntityGuardDrops } from '../storage/entity-guard-log.js';
import { classifyJunkEntityName } from '../distill/stages/05-extract.js';
import { latestConsolidationJudgeRun } from '../storage/consolidation-judge-log.js';
import { buildMemoryHealthFull, buildMemoryHealthCheap, distillSessionStats } from '../server/queries/memory-health.js';
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
  /** FEAT-479 AC-15 (SLICE-436): true when either `llm.compaction.provider`
   * or `llm.extraction.provider` is `'codex-subscription'` — a cheap,
   * config-only derivation (`cfg.llm.{compaction,extraction}.provider ===
   * 'codex-subscription'`) that needs no provider instantiation, unlike the
   * `llmProviders` opt above (which today's `doctorCommand` never actually
   * populates, so a check gated on it alone would never run in production —
   * deliberately NOT reusing that seam for this check). Defaults to `false`
   * when not supplied. */
  codexSubscriptionInUse?: boolean;
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
      let db: DB | undefined;
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        // DB may not exist yet — only check WAL if it does
        if (existsSync(dbPath)) {
          db = await openProductionDbReadonly(dbPath, encryptionEnabled);
          const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
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
      } finally {
        // Silent-error audit (2026-07-13): db.close() previously sat inline
        // after the query — unreachable if the query itself threw, leaking
        // the connection (and, on Windows, the underlying file handle) on
        // every error path. A finally block closes it exactly once
        // regardless of which path was taken.
        db?.close();
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
      let db: DB | undefined;
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        if (!existsSync(dbPath)) {
          return { ok: true, message: 'budget check skipped (no DB yet)' };
        }
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const day = new Date().toISOString().slice(0, 10);
        const row = db.prepare('SELECT usd_total, calls FROM budget_spend WHERE day = ?').get(day) as
          | { usd_total: number; calls: number }
          | undefined;

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
      } finally {
        db?.close();
      }
    },
  };
}

// ─── Check: Budget cap blindness under codex-subscription (FEAT-479 AC-15) ──

/**
 * codex-subscription (`src/providers/llm/codex-subscription.ts`) always
 * reports `usage.usd: 0` — a ChatGPT subscription has no per-token price, so
 * there is nothing for `BudgetTracker` to meter (see that provider's own
 * `chat()` comment: "Subscription-quota usage has no per-token USD price —
 * always 0", matching `pricing.ts`'s "unknown model" convention rather than
 * inventing a number). `checkBudget` above reads `budget_spend.usd_total`
 * against `dailyBudgetUsd` and reports "under cap" — which is true but
 * MEANINGLESS the moment either `llm.compaction` or `llm.extraction` is
 * pinned to codex-subscription, because that provider's spend never moves
 * the meter checkBudget is reading. An operator relying on the cap for cost
 * control would see an all-green "$0.00 / $10.00" budget row and reasonably
 * (and wrongly) conclude the cap is protecting them.
 *
 * Deliberately a SEPARATE, unconditional-while-configured check (same
 * posture as `checkProxyCaptureReminder`/`checkDevNoAuth` above) rather than
 * folded into `checkBudget` itself — the two checks answer different
 * questions ("is today's metered spend under cap" vs "does the cap apply to
 * this provider at all") and collapsing them would bury the second, more
 * important one inside a check that stays green.
 */
function checkBudgetCapCodexBlind(dailyBudgetUsd: number, codexSubscriptionInUse: boolean): Check {
  return {
    name: 'Budget cap vs codex-subscription',
    async run(): Promise<CheckResult> {
      if (!codexSubscriptionInUse || dailyBudgetUsd <= 0) {
        return { ok: true, message: 'budget cap applies normally (codex-subscription not in use)' };
      }
      return {
        ok: false,
        message:
          `daily budget cap ($${dailyBudgetUsd.toFixed(2)}) does NOT meter codex-subscription — ` +
          `it always reports usage.usd: 0 (ChatGPT subscription quota has no per-token price), so ` +
          `extraction/compaction spend under this provider is invisible to the cap and will never ` +
          `pause distillation.`,
        fix:
          'Cost control for codex-subscription is your ChatGPT plan quota, not config.budget.daily_usd — ' +
          'monitor usage at chatgpt.com, not `astramem-local budget`.',
      };
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

/**
 * Floor for the "Atom validity extraction" canary. Deliberately LOW (not ~95%):
 * `validity_extracted` is set unconditionally by the distill write path, but
 * `/remember`, the MCP `remember` tool, and the eval harness all bypass that
 * path and legitimately leave it 0. So a healthy mixed corpus is nowhere near
 * 100%, and a high floor would just be a permanently-red canary nobody reads.
 *
 * The point of a floor at all is to catch a REGRESSION — the distill path
 * silently stopping — which shows up as the rate collapsing toward zero. The
 * previous gate was `extracted === 0`, which only fires when literally nothing
 * works; a drop from 100% to 3% read as healthy. That is the exact "green while
 * ~87% broken" shape issue #200 exists to kill.
 */
const VALIDITY_EXTRACTION_WARN_FLOOR = 0.05;

/**
 * Poison-rate alarm floor for checkMemoryHealth's ok:false branch (ADR-015
 * rule 6/2, A2-lite). A handful of permanently-failed distill sessions out
 * of a meaningful sample is normal noise (one genuinely garbled transcript,
 * a one-off OOM); a QUARTER of every terminal session poisoning is not — it
 * is the same shape as the #200 entity-extraction incident (broken
 * model/config, not broken input). Gated behind MEANINGFUL_USAGE_THRESHOLD
 * terminal sessions (see distillSessionStats, src/server/queries/
 * memory-health.ts) so a fresh install's first one or two poison jobs never
 * trips this before there is enough volume for a rate to mean anything.
 */
const POISON_RATE_ALARM = 0.25;

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

      let db: DB | undefined;
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        if (!existsSync(dbPath)) {
          return { ok: true, message: 'redaction: on (no DB yet — 0 secrets redacted)' };
        }
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;
        const rows = db
          .prepare('SELECT type, SUM(count) AS n FROM redaction_log WHERE created_at >= ? GROUP BY type ORDER BY n DESC')
          .all(since) as { type: string; n: number }[];

        const total = rows.reduce((sum, r) => sum + r.n, 0);
        if (total === 0) {
          return { ok: true, message: 'redaction: on — 0 secrets redacted in last 7d' };
        }
        const breakdown = rows.map(r => `${r.n} ${r.type}`).join(', ');
        return { ok: true, message: `redaction: on — ${total} secrets redacted (${breakdown}) in last 7d` };
      } catch (err) {
        return { ok: false, message: `Redaction check error: ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}

// ─── Check: Recall usefulness (ADR-010) ───────────────────────────────────────

function checkUsefulness(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Recall usefulness',
    async run(): Promise<CheckResult> {
      let db: DB | undefined;
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        if (!existsSync(dbPath)) {
          return { ok: true, message: 'recall usefulness: no DB yet (0 served, 0 used)' };
        }
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;
        const overall = usefulnessRate(db, { sinceMs: since });
        const byType = usefulnessByType(db, { sinceMs: since });

        const rateStr = overall.rate === null ? 'n/a' : `${(overall.rate * 100).toFixed(1)}%`;
        const breakdown = byType.length > 0
          ? ' — ' + byType.map(t => `${t.type}: ${t.rate === null ? 'n/a' : `${(t.rate * 100).toFixed(1)}%`} (${t.used}/${t.served})`).join(', ')
          : '';
        return {
          ok: true,
          message: `recall usefulness (7d): ${rateStr} (${overall.used}/${overall.served} atoms used/served)${breakdown}`,
        };
      } catch (err) {
        // The query itself failed — this did NOT verify recall usefulness is
        // healthy, so it must not render/count the same as a check that did.
        return { ok: true, inconclusive: true, message: `Recall usefulness check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}

// ─── Check: Usefulness feedback loop canary (2026-07-12 "never fired") ──────

/**
 * WARNs when the ADR-010 usefulness feedback loop has demonstrably NEVER
 * received a POSITIVE signal despite meaningful daemon activity — the bug
 * found live in production 2026-07-12: GET /profile returned 30 entries,
 * every single one pinned at the Laplace prior 0.5 (0 recall_used events,
 * ever). The mechanism itself is sound (see tests/e2e/usefulness-feedback-
 * loop.e2e.test.ts — submit_feedback/mark_memory_used, invalidate_memory/
 * supersede_memory, and usefulnessScores() all work correctly when actually
 * invoked); this check exists because CI cannot catch "wired but nobody
 * calls it" — only live usage data can, and only doctor sees live usage data.
 *
 * issue #190 (2026-07-13): the ORIGINAL version of this check treated
 * `usedDistinct > 0 || correctedDistinct > 0` as "the loop is alive" — which
 * a live daemon satisfied with `(0 used, 854 corrected)` and reported GREEN.
 * Every one of those 854 corrections turned out to be consolidate.ts's own
 * auto-merge superseding its own near-duplicates (`correctionSource:
 * 'consolidation_auto'`, see memory-events.ts) — the system deduplicating
 * itself, not a human or agent saying "this was wrong". A loop that can only
 * ever demote (corrected keeps incrementing) and never promote (used stays
 * frozen at 0) is a one-way punishment term wearing a learning label, and the
 * canary that exists specifically to catch "built, wired, never invoked" was
 * itself fooled by exactly that pattern. Fix: `hasPositiveSignal` below is
 * `usedDistinct > 0` ALONE — corrections, of any source, never count as
 * evidence the loop is alive. correctedDistinct is still surfaced (split by
 * source) for visibility, but no longer gates ok/warn.
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
      let db: DB | undefined;
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        if (!existsSync(dbPath)) {
          return { ok: true, message: 'usefulness feedback loop: no DB yet' };
        }
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const report = buildMemoryHealthCheap(db);
        const summary = feedbackLoopSummary(db);

        // issue #190 AC-1: corrections — of ANY source — are not positive
        // signal. Only usedDistinct means the loop is actually learning.
        const hasPositiveSignal = summary.usedDistinct > 0;
        const meaningfulUsage =
          report.activeCount >= MEANINGFUL_USAGE_THRESHOLD &&
          summary.servedDistinct >= MEANINGFUL_USAGE_THRESHOLD;
        const correctedBreakdown =
          `${summary.correctedDistinct} corrected (${summary.correctedConsolidationDistinct} consolidation-auto, ` +
          `${summary.correctedExternalDistinct} external` +
          (summary.correctedUnknownDistinct > 0 ? `, ${summary.correctedUnknownDistinct} pre-fix/unclassified` : '') +
          ')';

        if (meaningfulUsage && !hasPositiveSignal) {
          return {
            ok: false,
            message:
              `usefulness feedback loop has NEVER received a POSITIVE signal: ${report.activeCount} active ` +
              `memories, ${summary.servedDistinct} distinct atoms served from recall/search, 0 marked used, ` +
              `${correctedBreakdown} — corrections alone are not evidence the loop is alive (a loop that can ` +
              `only ever demote and never promote silently biases ranking one-way; see issue #190). Every ` +
              `score is still pinned at or below the neutral 0.5 prior.`,
            fix: 'Wire something in the real usage/recall path to call submit_feedback/mark_memory_used for positive signal — today nothing does (ADR-010 v1 shipped the mechanism only; see issue #190 for the missing-caller analysis). Corrections from consolidation auto-merge do not substitute for this.',
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
          message: `usefulness feedback loop: active (${summary.usedDistinct} used, ${correctedBreakdown}, distinct atoms, all-time)`,
        };
      } catch (err) {
        // The query itself failed — this did NOT verify the feedback loop is
        // healthy, so it must not render/count the same as a check that did
        // (this is exactly the shape of bug issue #190 was about: a canary
        // reporting green without having actually confirmed anything).
        return { ok: true, inconclusive: true, message: `usefulness feedback loop check error (non-fatal): ${err}` };
      } finally {
        db?.close();
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
      let db: DB | undefined;
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        if (!existsSync(dbPath)) {
          return { ok: true, message: 'memory health: no DB yet (0 memories — clean slate)' };
        }
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const report = buildMemoryHealthFull(db);
        const distill = distillSessionStats(db);

        // ADR-015 rule 6/2: check the FAILURE RATE before the "0 active =
        // quiet week" short-circuit below. A pipeline that poisons every
        // session never produces an active memory — gating this behind
        // activeCount > 0 would make the exact failure this branch exists
        // to catch report as "no data yet" instead of red. This is the
        // fix for the counterexample ADR-015 names by name: checkMemoryHealth
        // previously had exactly one return path, {ok: true}.
        if (
          distill.terminal >= MEANINGFUL_USAGE_THRESHOLD &&
          distill.poisonRate !== null &&
          distill.poisonRate >= POISON_RATE_ALARM
        ) {
          return {
            ok: false,
            message:
              `memory health: ${distill.poison} of ${distill.terminal} terminal distill sessions ` +
              `(${(distill.poisonRate * 100).toFixed(1)}%) permanently poisoned — at/above the ` +
              `${(POISON_RATE_ALARM * 100).toFixed(0)}% alarm floor. A well-formed but broken ` +
              `extraction pipeline looks identical to a run of genuinely bad transcripts without ` +
              `this counter.`,
            fix:
              'Run `astramem-local doctor` for the LLM chat probe result and `astramem-local queue` to ' +
              'inspect poisoned sessions — a broken model/config produces this shape, not bad transcripts alone.',
          };
        }

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
            `${report.poisonDistillSessions} poison-distill session(s) (${distill.poison}/${distill.terminal} ` +
            `terminal), staleness [${staleTop}]`,
        };
      } catch (err) {
        // The query itself failed — did not verify memory health.
        return { ok: true, inconclusive: true, message: `Memory health check error (non-fatal): ${err}` };
      } finally {
        db?.close();
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

// ─── Check: Ingest spool quarantine (Wave A slice A3) ────────────────────────

/**
 * ADR-015 rule 6 ("state the denominator"): reports K (currently
 * quarantined) of N (cumulative envelopes ever spooled, `SpoolStats.
 * totalSpooled` — src/ingest/spool.ts), not a bare count. A canary that can
 * only ever go green is decoration (same doc, same rule) — this one goes RED
 * when a quarantined file has outlived `DEFAULT_QUARANTINE_TTL_MS`, which
 * means the TTL sweep (`pruneExpiredQuarantine`, run once per spool-drain
 * tick) failed to remove it — a real, actionable signal, not a restated
 * config value. Content in `.quarantine/` is already redacted at spool-write
 * time (src/ingest/spool.ts `redactSpoolEnvelope`) regardless of what this
 * check finds; this check is about retention hygiene, not secret exposure.
 */
function checkSpoolQuarantine(dataDir: string): Check {
  return {
    name: 'Ingest spool quarantine',
    async run(): Promise<CheckResult> {
      const qDir = spoolQuarantineDir(dataDir);
      let quarantined: string[];
      try {
        quarantined = existsSync(qDir) ? readdirSync(qDir).filter(n => n.endsWith('.json')) : [];
      } catch {
        quarantined = [];
      }
      const { totalSpooled } = readSpoolStats(dataDir);
      const k = quarantined.length;

      if (k === 0) {
        return { ok: true, message: `ingest spool quarantine: 0 of ${totalSpooled} spooled envelopes quarantined` };
      }

      let oldestAgeMs = 0;
      for (const name of quarantined) {
        try {
          const age = Date.now() - statSync(join(qDir, name)).mtimeMs;
          if (age > oldestAgeMs) oldestAgeMs = age;
        } catch { /* vanished mid-check — skip */ }
      }
      const oldestDays = (oldestAgeMs / TWENTY_FOUR_HOURS_MS).toFixed(1);
      const ttlDays = (DEFAULT_QUARANTINE_TTL_MS / TWENTY_FOUR_HOURS_MS).toFixed(0);

      if (oldestAgeMs > DEFAULT_QUARANTINE_TTL_MS) {
        return {
          ok: false,
          message: `ingest spool quarantine: ${k} of ${totalSpooled} spooled envelopes quarantined, oldest is ${oldestDays}d old — exceeds the ${ttlDays}d TTL (the spool-drain prune sweep should have removed it)`,
          fix: 'Check the daemon logs for spool-drain errors — pruneExpiredQuarantine (src/ingest/spool.ts) runs every drain tick and should never let a file exceed the TTL.',
        };
      }

      return {
        ok: true,
        message: `ingest spool quarantine: ${k} of ${totalSpooled} spooled envelopes quarantined, oldest is ${oldestDays}d old (within ${ttlDays}d TTL)`,
      };
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
        // Could not read/parse the crash history file — this did NOT verify
        // there's no crash loop, so it must not render/count as if it had.
        return { ok: true, inconclusive: true, message: `crash loop check error (non-fatal): ${err}` };
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

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
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
          const ageStr = newestAgeH !== null ? `, newest ${newestAgeH}h old` : '';
          return {
            ok: true,
            message: `entity relations: ${total} row(s) total (${recent7d} in last 7d${ageStr})`,
          };
        }

        // total === 0 from here down.
        if (extractProfile === 'conversational') {
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
          return {
            ok: true,
            message:
              `entity relations: 0 rows — not enough distill activity yet to judge (${recentMemories} ` +
              `memories in last 7d, below the ${MEANINGFUL_USAGE_THRESHOLD} floor)`,
          };
        }

        const guardDrops7d = totalRelationGuardDrops(db, since);

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
        // The query itself failed — did NOT verify entity relations are
        // healthy (this is the same failure shape issue #200 was about: a
        // canary that can report green without having actually checked).
        return { ok: true, inconclusive: true, message: `entity relations check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}

// ─── Check: Entity name quality (issue #207) ─────────────────────────────────

/**
 * Measures the junk rate already sitting in the `entities` table — a bare
 * issue/PR reference ("#110"), a bare number ("123"), or a name below the
 * length floor (classifyJunkEntityName, src/distill/stages/05-extract.ts,
 * the same rule filterAtomEntities enforces on NEW writes going forward).
 *
 * This is deliberately a snapshot of EXISTING rows, not just an activity
 * counter: issue #207 was filed against a live corpus (4,221 entities, an
 * unknown but non-trivial junk fraction) that the forward-only guard added
 * alongside this check does NOT retroactively clean — `EntityRepo.upsert` is
 * first-writer-wins on `kind` and never revisits a name once it exists. A
 * canary that only reported "0 drops this week" would silently miss that the
 * pre-existing junk is still sitting there and still polluting any future ζ
 * (zeta) ranking sweep — the exact "canary measures the wrong thing" failure
 * #200 documents.
 *
 * Gated on a minimum total-entity floor (mirrors the MEANINGFUL_USAGE_
 * THRESHOLD spirit other checks use) so a fresh/near-empty install's small
 * sample size doesn't produce a noisy WARN on 1-2 entities.
 */
const MIN_ENTITIES_FOR_JUNK_RATE = 20;

function checkEntityNameQuality(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Entity name quality',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'entity name quality: no DB yet' };
      }

      // `let db` OUTSIDE the try + close in `finally` — the canonical shape from
      // PR #208. Declaring it INSIDE try means a thrown query never reaches
      // db.close() and leaks the readonly handle (#208 fixed exactly this at 11
      // sites; this check, written the same day, reintroduced it).
      let db: Awaited<ReturnType<typeof openProductionDbReadonly>> | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;

        // Select `kind` too: classifyJunkEntityName is kind-aware (a
        // one-character `tech` like "C"/"R" is legitimate; a one-character
        // repo/actor/org is not). Selecting only `name` would apply a DIFFERENT
        // rule here than the write-path guard uses — the canary and the guard
        // must agree, or the measured junk rate is measuring nothing.
        const rows = db
          .prepare('SELECT name, kind FROM entities')
          .all() as Array<{ name: string; kind: string | null }>;
        const total = rows.length;
        const drops7d = totalEntityGuardDrops(db, since);

        if (total === 0) {
          return { ok: true, message: 'entity name quality: no entities yet' };
        }

        const junkCount = rows.filter(
          (r) => classifyJunkEntityName(r.name, r.kind ?? undefined) !== null,
        ).length;

        if (total < MIN_ENTITIES_FOR_JUNK_RATE) {
          return {
            ok: true,
            message:
              `entity name quality: ${junkCount}/${total} junk — too few entities to judge a rate yet ` +
              `(${drops7d} guard-drop(s) recorded in last 7d)`,
          };
        }

        if (junkCount === 0) {
          return {
            ok: true,
            message: `entity name quality: 0/${total} existing entities are junk (${drops7d} guard-drop(s) in last 7d)`,
          };
        }

        const ratePct = ((junkCount / total) * 100).toFixed(1);
        return {
          ok: false,
          message:
            `entity name quality: ${junkCount}/${total} (${ratePct}%) existing entities are junk ` +
            `(bare issue/PR ref, bare number, or below the length floor) — the forward guard ` +
            `(filterAtomEntities, issue #207) blocks NEW junk from being written (${drops7d} dropped ` +
            `in last 7d) but does not retroactively clean rows written before it existed.`,
          fix:
            'Existing junk entities do not self-correct — a one-off cleanup pass over the `entities` table ' +
            '(purging rows matching classifyJunkEntityName in src/distill/stages/05-extract.ts) is a separate, ' +
            'not-yet-built follow-up if this rate matters before running a ζ (zeta) ranking sweep.',
        };
      } catch (err) {
        // INCONCLUSIVE, not ok:true. A check whose own query threw has NOT
        // observed a healthy system — it has observed nothing. Returning
        // `ok: true` here is indistinguishable from "genuinely clean", which is
        // the precise bug ADR-015 forbids and PR #208 fixed at 9 other checks.
        // This check — written the same day, to enforce that very ADR —
        // reintroduced it. The failing shape is the DEFAULT shape.
        return {
          ok: true,
          inconclusive: true,
          message: `entity name quality: CHECK FAILED TO RUN (not a clean bill of health): ${err}`,
        };
      } finally {
        db?.close();
      }
    },
  };
}

// ─── Check: Atom validity extraction (issue #205) ────────────────────────────

/**
 * The ADR-015-compliant canary shape for issue #205: a RATE, not an
 * existence check. `entity_relations` taught the lesson this check applies —
 * a canary that only asks "does at least one row exist?" reports green while
 * 99% of the pipeline is silently producing nothing (issue #200's exact
 * mistake). Here the equivalent trap would be "does at least one memory have
 * validity_extracted = 1?" — instead this reports the actual percentage of
 * recent memories where extraction considered validity at all, so a
 * regression that makes 05-extract.ts/08-embed-index.ts stop setting the
 * flag shows up as the rate dropping toward 0%, not as a check flipping from
 * green to red at some arbitrary threshold.
 *
 * Denominator caveat, stated plainly rather than hidden: "recent memories"
 * counts EVERY write path (`/remember`, MCP `remember`, the eval harness),
 * not just the distill extraction pipeline — those non-extraction paths
 * never set `validity_extracted` and correctly stay at 0 forever (see
 * InsertInput.validity_extracted's doc comment). A repo that leans heavily
 * on direct `/remember` calls will show a rate well below 100% even with a
 * perfectly healthy extraction pipeline; this canary cannot (and does not
 * try to) separate the two populations without a discriminator column that
 * doesn't exist. What it DOES reliably catch, mirroring `checkAutoCapture`'s
 * "wired but zero" precedent: real recent distill activity (>=
 * MEANINGFUL_USAGE_THRESHOLD memories) producing a flat 0% — that specific
 * combination is only possible if the extraction write path itself broke.
 */
function checkAtomValidityExtraction(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Atom validity extraction',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'atom validity extraction: no DB yet' };
      }

      // `let db` OUTSIDE the try + close in `finally` — the canonical shape
      // from PR #208. Declared INSIDE the try (as this check originally was),
      // a thrown query never reaches db.close() and leaks the readonly handle.
      let db: Awaited<ReturnType<typeof openProductionDbReadonly>> | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;

        const recentRow = db
          .prepare('SELECT COUNT(*) AS n FROM memories WHERE created_at >= ?')
          .get(since) as { n: number };
        const recentTotal = recentRow.n;

        if (recentTotal < MEANINGFUL_USAGE_THRESHOLD) {
          return {
            ok: true,
            message:
              `atom validity extraction: not enough recent activity to judge (${recentTotal} ` +
              `memories in last 7d, below the ${MEANINGFUL_USAGE_THRESHOLD} floor)`,
          };
        }

        const extractedRow = db
          .prepare('SELECT COUNT(*) AS n FROM memories WHERE created_at >= ? AND validity_extracted = 1')
          .get(since) as { n: number };
        const extracted = extractedRow.n;

        const rate = extracted / recentTotal;
        const ratePct = (rate * 100).toFixed(1);
        const guardDrops = totalValidityGuardDrops(db, since);

        // RATE, not existence. The original gate here was `extracted === 0` —
        // i.e. it only went red when NOTHING worked. A pipeline regression that
        // dropped coverage from 100% to 3% would have reported ok:true forever,
        // which is precisely the "green while ~87% broken" failure that issue
        // #200 exists to kill. Rebuilding it inside the fix for #205 would have
        // been the third time this repo shipped this exact shape.
        //
        // ADR-015, strengthened: a canary MUST measure the RATE of the failure,
        // not the EXISTENCE of a success.
        if (rate < VALIDITY_EXTRACTION_WARN_FLOOR) {
          // A true zero and a collapse are BOTH red, but they are different
          // diagnoses and the message says which: zero means the write path
          // never ran at all ("built, wired, never invoked" — this repo's
          // signature failure); a low-but-nonzero rate means it ran and mostly
          // stopped, which the old `=== 0` gate reported as perfectly healthy.
          const neverInvoked = extracted === 0;
          return {
            ok: false,
            message:
              `atom validity extraction: only ${extracted}/${recentTotal} recent memories (${ratePct}%) ` +
              `have validity_extracted = 1 — below the ${(VALIDITY_EXTRACTION_WARN_FLOOR * 100).toFixed(0)}% floor. ` +
              (neverInvoked
                ? `NOT ONE recent memory carries it: the distill write path is built, wired, never invoked ` +
                  `(issue #205's own bug class).`
                : `The distill write path sets this unconditionally, so a rate this low means it ran and ` +
                  `then largely STOPPED — a regression, not a mixed corpus.`),
            fix:
              'Confirm src/distill/stages/08-embed-index.ts passes validity_extracted: true on ' +
              'insertWithCreateEvent, and that the running daemon is on a build including the ' +
              'issue #205 fix (astramem-local reinstall).',
          };
        }

        // A high extraction rate with a high guard-drop rate is NOT health: it
        // means the pipeline is looking, the model IS stating end-dates, and
        // every one of them is being refused as implausible. Without this, that
        // state is indistinguishable from "the model states no end dates."
        if (guardDrops > 0) {
          return {
            ok: true,
            message:
              `atom validity extraction: ${extracted}/${recentTotal} recent memories (${ratePct}%) have ` +
              `validity_extracted = 1, but the validity guard REFUSED ${guardDrops} implausible bound(s) ` +
              `in the same window — the model is emitting end-dates that fail the plausibility check ` +
              `(see guardValidTo in src/distill/stages/08-embed-index.ts). Atoms were kept; only the ` +
              `bounds were dropped, so this is quality loss, not data loss.`,
          };
        }

        return {
          ok: true,
          message:
            `atom validity extraction: ${extracted}/${recentTotal} recent memories (${ratePct}%) have ` +
            `validity_extracted = 1, 0 guard drops — see this check's doc comment for why 100% is not ` +
            `expected in a mixed /remember + distill corpus.`,
        };
      } catch (err) {
        // INCONCLUSIVE, not ok:true. A check whose own query threw has NOT
        // observed a healthy system — it has observed nothing.
        return {
          ok: true,
          inconclusive: true,
          message: `atom validity extraction: CHECK FAILED TO RUN (not a clean bill of health): ${err}`,
        };
      } finally {
        db?.close();
      }
    },
  };
}

// ─── Check: Consolidation judge telemetry (FEAT-482) ─────────────────────────

/**
 * Informational-only row (`ok: true` always — same "deliberate config choice,
 * never itself a WARN" precedent as `checkDurabilityGateMode`/
 * `checkExtractProfile`). Its whole job is making the contradiction judge's
 * real cost VISIBLE, because it cannot be CAPPED in dollars: both shipped LLM
 * providers (Ollama, codex-subscription) hardcode `usage.usd: 0` (see
 * "Budget cap vs codex-subscription" above for the same blind spot on
 * distill/extraction), so `runConsolidation` bounds the judge sweep by call
 * count (`maxPerRun`) and wall-clock time (`maxWallClockMs`) instead
 * (src/consolidate/consolidate.ts, FEAT-482). This row surfaces what the most
 * recent run actually cost in those terms — call count and elapsed time —
 * reading `consolidation_judge_runs` (migration 030,
 * src/storage/consolidation-judge-log.ts), so an operator who later points
 * extraction at a genuinely metered provider has a real number to look at,
 * not a silent gate that can't see it.
 */
function checkConsolidationJudgeTelemetry(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Consolidation judge',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'consolidation judge: no DB yet' };
      }

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const latest = latestConsolidationJudgeRun(db);

        if (!latest) {
          return {
            ok: true,
            message: 'consolidation judge: never run (contradictionDetection.mode has been off every run so far)',
          };
        }

        const elapsedS = (latest.elapsedMs / 1000).toFixed(1);
        const ageH = ((Date.now() - latest.createdAt) / 3_600_000).toFixed(1);
        const caps = latest.capReached
          ? ' — call-count cap (maxPerRun) reached'
          : latest.wallClockCapReached
            ? ' — wall-clock cap (maxWallClockMs) reached'
            : '';

        // issue #190/#200-shaped check: judgeCalls alone only proves the
        // judge was INVOKED, not that it ever produced a real verdict — a
        // systemically broken provider (wrong model, broken JSON mode,
        // network flakiness) makes every call fall back to 'unrelated' and
        // would otherwise look identical to "genuinely no contradictions
        // found". Flag the all-fallback case explicitly.
        if (latest.judgeCalls > 0 && latest.judgeErrors >= latest.judgeCalls) {
          return {
            ok: false,
            message:
              `consolidation judge: last run ${ageH}h ago (mode: ${latest.mode}) made ${latest.judgeCalls} ` +
              `judge call(s) but ALL of them fell back to 'unrelated' due to errors — the judge is not ` +
              `actually classifying anything; contradiction detection ran blind this pass.`,
            fix: 'Check the configured llm.extraction provider is reachable and returns valid JSON — see contradiction-judge.ts server logs for the specific parse/call failures.',
          };
        }

        const errorNote = latest.judgeErrors > 0 ? `, ${latest.judgeErrors} fell back on error` : '';
        return {
          ok: true,
          message:
            `consolidation judge: last run ${ageH}h ago (mode: ${latest.mode}) — ` +
            `${latest.judgeCalls} judge call(s)${errorNote}, ${elapsedS}s elapsed${caps}`,
        };
      } catch (err) {
        // The query itself failed — did NOT verify judge telemetry is healthy.
        return { ok: true, inconclusive: true, message: `consolidation judge check error (non-fatal): ${err}` };
      } finally {
        db?.close();
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

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const row = db
          .prepare(`SELECT COUNT(*) AS count FROM memories WHERE capture_source IN ('auto_capture', 'hook_close') AND valid_to IS NULL`)
          .get() as { count: number } | undefined;
        const totalRow = db
          .prepare(`SELECT COUNT(*) AS count FROM memories WHERE valid_to IS NULL AND archived = 0`)
          .get() as { count: number } | undefined;
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
        // The count query itself failed — did not verify auto-capture activity.
        return { ok: true, inconclusive: true, message: `auto-capture is ON — count check error (non-fatal): ${err}` };
      } finally {
        db?.close();
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

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const row = db
          .prepare(`SELECT COUNT(*) AS count FROM memories WHERE capture_source = 'proxy' AND valid_to IS NULL`)
          .get() as { count: number } | undefined;
        const count = row?.count ?? 0;

        return {
          ok: true,
          message: `proxy capture is ON — ${count} proxy-captured ${count === 1 ? 'memory' : 'memories'} currently stored`,
        };
      } catch (err) {
        // The count query itself failed — did not verify proxy capture activity.
        return { ok: true, inconclusive: true, message: `proxy capture is ON — count check error (non-fatal): ${err}` };
      } finally {
        db?.close();
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
      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const tableExists = db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`)
          .get();
        if (!tableExists) {
          return { ok: true, message: 'schema drift: DB not migrated yet (no schema_version table)' };
        }
        const row = db.prepare('SELECT MAX(version) AS max_version FROM schema_version').get() as
          | { max_version: number | null }
          | undefined;
        dbSchemaVersion = row?.max_version ?? 0;
      } catch (err) {
        // The probe itself failed — did NOT verify there's no schema drift.
        return { ok: true, inconclusive: true, message: `schema drift check error (non-fatal): ${err}` };
      } finally {
        db?.close();
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
    checkBudgetCapCodexBlind(dailyBudgetUsd, opts.codexSubscriptionInUse ?? false),
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
    checkEntityNameQuality(dataDir, encryptionEnabled),
    checkAtomValidityExtraction(dataDir, encryptionEnabled),
    checkConsolidationJudgeTelemetry(dataDir, encryptionEnabled),
    checkAutoCapture(dataDir, opts.autoCaptureEnabled ?? false, encryptionEnabled),
    checkProxyCapture(dataDir, opts.proxyEnabled ?? false, opts.proxyCaptureEnabled ?? false, encryptionEnabled),
    checkProxyCaptureReminder(opts.proxyEnabled ?? false, opts.proxyCaptureEnabled ?? false),
    checkDevNoAuth(opts.devNoAuthActive ?? false),
    checkSpoolQuarantine(dataDir),
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
