/**
 * Shared types, options, and helpers for the doctor check registry.
 *
 * This is the ONE file every check module may need to import from — kept
 * deliberately small (options + a DB-open helper + a handful of shared time
 * constants) so it stays an unlikely collision point. Check-specific
 * constants (e.g. `MIN_ENTITIES_FOR_JUNK_RATE`) stay colocated in their own
 * check's file instead of migrating here — see `src/doctor/checks/index.ts`'s
 * doc comment for the split rationale.
 */
import type { LLMProvider } from '../../contracts/llm.js';
import type { EmbedProvider } from '../../contracts/embed.js';
import { defaultConfigDir } from '../../config/datadir.js';
import { getOrCreateKey } from '../../storage/keystore.js';
import type { DB } from '../../storage/db.js';
import type { DurabilityGateMode } from '../../distill/durability-gate.js';
import type { ExtractProfile } from '../../distill/prompts/extract.js';
import type { DistillCostCapConfig } from '../../distill/cost-cap.js';
import type { Config } from '../../config/config.js';

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
  /** Current `distill.costCap` — the opt-in compact()+extract() call-count/
   *  wall-clock cap (disabled by default for beta). Defaults to
   *  `{ enabled: false }` when not supplied — see `checkDistillCostCap`. */
  distillCostCap?: DistillCostCapConfig;
  /** FEAT-455 / ADR-012 decision 4: current `capture.autoCapture.enabled`.
   * Defaults to `false` (the shipped default) when not supplied. */
  autoCaptureEnabled?: boolean;
  /** FEAT-458 S1-AC-2 / ADR-013: current `proxy.enabled`. Defaults to
   * `false` (the shipped default) when not supplied. */
  proxyEnabled?: boolean;
  /** Release no-go hard gate: current `proxy.experimental`. Defaults to
   * `false` (the shipped default) when not supplied — the state where
   * `astramem-local proxy serve` refuses to start regardless of
   * `proxy.enabled` (see src/cli/proxy.ts). */
  proxyExperimental?: boolean;
  /** FEAT-458 S1-AC-2 / ADR-013: current `proxy.capture.enabled`. Defaults
   * to `false` (the shipped default) when not supplied. */
  proxyCaptureEnabled?: boolean;
  /** FEAT-491 / ADR-017 decision 3: current
   * `captureSource.meetingCaptions.enabled`. Defaults to `false` (the
   * shipped default) when not supplied. */
  meetingCaptionsEnabled?: boolean;
  /** sync-experimental-gate slice: current `sync.enabled` (merged with
   * sync.json pairing state by resolve-runtime.ts — pairing-owned, set by
   * `astramem-local pair` on a successful redeem). Defaults to `false`
   * (the shipped default) when not supplied. */
  syncEnabled?: boolean;
  /** sync-experimental-gate slice: current `sync.experimental` — the
   * config.yaml-only hand-edit hard gate `astramem-local pair` never
   * touches; both this AND `syncEnabled` must be true for the shipper to
   * start (see `shouldStartShipper` in sync/shipper.ts). Defaults to
   * `false` (the shipped default) when not supplied. */
  syncExperimental?: boolean;
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
  /** FEAT-493 (scaffolding): current `retention` config block. Defaults to
   * `defaultConfig().retention` (mode 'off') when not supplied — see
   * `checkRetention`. */
  retentionConfig?: Config['retention'];
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

// ─── Shared time constants and activity-floor thresholds ────────────────────

export const ONE_GB = 1024 * 1024 * 1024;
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

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
export const MEANINGFUL_USAGE_THRESHOLD = 20;

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
export const POISON_RATE_ALARM = 0.25;
