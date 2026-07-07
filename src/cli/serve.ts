import { join } from 'node:path';
import { mkdirSync, statSync, unlinkSync } from 'node:fs';
import { ts } from '../log/logger.js';
import { buildApp } from '../server/app.js';
import { openDb } from '../storage/db.js';
import { migrate, getVecSchemaDim } from '../storage/migrate.js';
import { getOrCreateKey, readSyncToken } from '../storage/keystore.js';
import { resolveBearerToken } from '../storage/bearer-keystore.js';
import { startShipper, getOrCreateDeviceId, type ShipperHandle } from '../sync/shipper.js';
import { encryptIfPlaintext } from '../storage/migrate-encrypt.js';
import { defaultConfigDir } from '../config/datadir.js';
import { resolveRuntimeConfig } from '../config/resolve-runtime.js';
import { acquireInstanceLock, AlreadyRunningError, type InstanceLock } from '../service/instance-lock.js';
import { PKG_VERSION } from '../server/lib/wire-meta.js';
import { createHealthState, type HealthState } from '../server/health-state.js';
import type { EmbedProvider } from '../contracts/embed.js';
import { HandlerRegistry } from '../pipeline/registry.js';
import { startWorker, type WorkerHandle } from '../pipeline/worker.js';
import { JobRepo } from '../pipeline/job-repo.js';
import { distillHandler } from '../pipeline/handlers/distill.js';
import { distillEventsHandler } from '../pipeline/handlers/distill-events.js';
import { cleanupHandler } from '../pipeline/handlers/cleanup.js';
import { consolidateHandler } from '../pipeline/handlers/consolidate.js';
import { reembedHandler } from '../pipeline/handlers/reembed.js';
import { makeMockProviders, type MockProviderSet } from '../pipeline/mock-providers.js';
import type { ProviderSet } from '../providers/index.js';
import type { ExtendedHandlerCtx } from '../pipeline/handler-ctx-ext.js';
import { MemoryRepo } from '../storage/memories.js';
import { SqliteVecStore } from '../vector/sqlite-vec.js';

export interface ServeOpts {
  port?: number;
  dataDir?: string;
  token?: string;
  /** Restore the legacy fail-fast embed preflight (probe once, exit 1 on
   *  failure, before binding the port). Default is degraded-start. */
  strictPreflight?: boolean;
}

export async function serve(opts: ServeOpts): Promise<void> {
  // Shared resolver: migrate-dirs + config.yaml + sync.json merge + the
  // canonical precedence (CLI > ASTRA_MEMORY_DATADIR > config.yaml > default).
  // doctor/backup/reinstall use the same resolver so diagnostics always look
  // at the same files as the daemon.
  const { cfg, port, dataDir } = resolveRuntimeConfig({ port: opts.port, dataDir: opts.dataDir });
  // SEC-10: CLI flag > env var > OS credential store > secrets.env
  // (canonical dir, then legacy dir) > 'devtok' default. A secrets.env-only
  // bearer is opportunistically promoted into the credential store.
  const { token } = resolveBearerToken({
    cliToken: opts.token,
    envToken: process.env.ASTRA_MEMORY_TOKEN,
  });

  const dbPath = dataDir === ':memory:' ? ':memory:' : join(dataDir, 'memory.sqlite');
  if (dataDir !== ':memory:') mkdirSync(dataDir, { recursive: true });

  // Single-instance lock (D2): protects the data dir, not just the port —
  // a second daemon on a different port would still race the job queue.
  // A healthy holder → exit 0 so schtasks keepalive re-runs are cheap no-ops.
  let lock: InstanceLock | null = null;
  if (dataDir !== ':memory:') {
    try {
      lock = await acquireInstanceLock(dataDir, port, PKG_VERSION);
    } catch (err) {
      if (err instanceof AlreadyRunningError) {
        console.log(`${ts()} [astramem-local] ${err.message} — exiting (single-instance).`);
        process.exit(0);
      }
      throw err;
    }
  }

  // Global crash handlers (serve path only): a stray rejection must not kill
  // the process silently — log, release the lock, close the DB, exit 1 so
  // the abnormal exit is visible in task history. Restart comes from the
  // scheduler's repetition trigger, not from exit-code semantics.
  const crashExit = (kind: string) => (err: unknown) => {
    console.error(`${ts()} [astramem-local] FATAL ${kind}:`, err);
    try { lock?.release(); } catch { /* best-effort */ }
    try { dbForCrash?.close(); } catch { /* best-effort */ }
    process.exit(1);
  };
  let dbForCrash: ReturnType<typeof openDb> | null = null;
  process.on('uncaughtException', crashExit('uncaughtException'));
  process.on('unhandledRejection', crashExit('unhandledRejection'));

  // SEC-1/2/7/9: in-memory databases can never be encrypted (SQLCipher
  // rejects PRAGMA key on :memory:, confirmed by the 1a spike) — the
  // ASTRA_MEMORY_DATADIR=':memory:' test/dev path always stays plaintext
  // and never touches the keystore.
  let db: ReturnType<typeof openDb>;
  if (dataDir === ':memory:') {
    db = openDb(dbPath);
  } else if (cfg.security.encryption.enabled) {
    const keyResult = getOrCreateKey(defaultConfigDir());
    encryptIfPlaintext(dbPath, keyResult.key);
    try {
      db = openDb(dbPath, { key: keyResult.key });
    } catch (err) {
      throw rewrapWrongKeyError(err, dbPath, keyResult.source);
    }
  } else {
    // SEC-9: disabling encryption is a deliberate trust trade-off — make it loud.
    console.warn(
      `${ts()} [astramem-local] WARNING: encryption at rest is DISABLED (security.encryption.enabled=false). ` +
      `memory.sqlite at ${dbPath} will be stored in PLAINTEXT.`,
    );
    db = openDb(dbPath);
  }
  dbForCrash = db;
  // FEAT-409: dim only matters for a genuinely fresh DB — migrate() skips
  // already-applied migrations regardless, so this stays correct across
  // upgrades and restarts of an existing (already at some dim) DB.
  migrate(db, cfg.embedding.dim);

  // FEAT-409 AC-3: the dim the embed preflight checks against is the
  // PERSISTED schema dim (what memories_vec was actually created with),
  // not just cfg.embedding.dim — a config/provider dim that drifted from
  // the real schema (edited config.yaml without running `reembed-dim`)
  // must fail loud here, not deep inside the first ingest's sqlite-vec
  // dimension mismatch. Falls back to cfg.embedding.dim on a genuinely
  // fresh DB (memories_vec doesn't exist yet — migrate() just created it
  // at that dim, so they agree by construction).
  const schemaDim = getVecSchemaDim(db) ?? cfg.embedding.dim;

  // Boot job recovery (P1.1): requeue jobs orphaned by a non-graceful death
  // ('running' from a mid-handle kill; 'failed' whose in-memory retry timer
  // died with the process). Purge old completed/poison bookkeeping (P1.2).
  const bootRepo = new JobRepo(db);
  const recovered = bootRepo.recoverOrphans();
  if (recovered.requeuedRunning + recovered.requeuedFailed > 0) {
    console.log(
      `${ts()} [astramem-local] job recovery: requeued ${recovered.requeuedRunning} orphaned running, ` +
      `${recovered.requeuedFailed} interrupted retries`,
    );
  }
  const purged = bootRepo.purgeOld();
  if (purged.completed + purged.poison > 0) {
    console.log(`${ts()} [astramem-local] job retention: purged ${purged.completed} completed, ${purged.poison} poison`);
  }

  // Encryption-migration backup cleanup (P1.5): once the encrypted DB has
  // been opening successfully for 7+ days, the plaintext copy is pure
  // data-at-rest exposure — delete it. Doctor surfaces it during the window.
  if (dataDir !== ':memory:' && cfg.security.encryption.enabled) {
    cleanupPreEncryptionBak(dbPath);
  }

  // SEC-9: disabling redaction is a deliberate trust trade-off — make it loud.
  if (!cfg.security.redaction.enabled) {
    console.warn(
      `${ts()} [astramem-local] WARNING: secret redaction is DISABLED (security.redaction.enabled=false). ` +
      'Transcripts and memories will be persisted WITHOUT stage-0 secret scrubbing.',
    );
  }

  // Resolve providers: mock mode (CI/test) or real providers
  const healthState = createHealthState();
  if (dataDir !== ':memory:') healthState.dataDir = dataDir;
  let providers: ProviderSet | MockProviderSet;
  const useMock = process.env.ASTRA_MEMORY_MOCK_PROVIDERS === '1';
  if (useMock) {
    providers = makeMockProviders(cfg.embedding.dim);
    healthState.embed.ok = true; // mock embed is always available
    healthState.embed.lastOkAt = Date.now();
  } else {
    // Real providers from config — only imported when not in mock mode
    const { getProviders } = await import('../providers/index.js');
    providers = getProviders(cfg);

    if (opts.strictPreflight) {
      // Legacy fail-fast behavior (CI / scripted checks): probe once with the
      // historical 5s timeout and exit 1 before accepting traffic.
      const { embedProbe } = await import('../doctor/probes/embed-probe.js');
      const preflightResult = await embedProbe(providers.embed, 5000, schemaDim);
      if (!preflightResult.ok) {
        const model = providers.embed.model;
        console.error(`${ts()} [astramem-local] embed preflight FAILED: ${preflightResult.message}`);
        console.error(`  Model    : ${model}`);
        console.error(`  Fix      : ${preflightResult.fix ?? 'Check embed provider config'}`);
        console.error(`  Install  : ollama pull ${model}`);
        console.error(`  Docs     : https://ollama.com/library/mxbai-embed-large`);
        process.exit(1);
      }
      healthState.embed.ok = true;
      healthState.embed.lastOkAt = Date.now();
    }
    // Degraded-start (D3): the non-strict preflight runs in the BACKGROUND
    // after app.listen — see startEmbedPreflight below. A daemon that can
    // serve recall-from-cache and queue ingest beats a dead one; cold Ollama
    // model loads at logon no longer kill the boot.
  }

  const app = await buildApp({ db, token, embed: providers.embed, config: cfg, healthState });

  // Wire up the worker with extended context so distillation runs
  const registry = new HandlerRegistry();
  registry.register(distillHandler);
  registry.register(distillEventsHandler);
  registry.register(cleanupHandler);
  registry.register(consolidateHandler);
  registry.register(reembedHandler);

  const extCtx: ExtendedHandlerCtx = {
    db,
    config: cfg,
    providers,
    memoryRepo: new MemoryRepo(db),
    vecStore: new SqliteVecStore(db, cfg.embedding.dim),
  };

  // startWorker takes HandlerCtx but we pass ExtendedHandlerCtx (structural subtype)
  const worker: WorkerHandle = startWorker({
    pollMs: 500,
    registry,
    db,
    config: cfg,
    ctx: extCtx,
    healthState,
  });

  // Sync shipper (ADR-003): one-way log shipping to the cloud ledger.
  // Requires explicit opt-in + url + workspace + device token; private
  // atoms never ship regardless (scope filter inside the shipper).
  let shipper: ShipperHandle | null = null;
  if (cfg.sync.enabled && dataDir !== ':memory:') {
    const syncToken = process.env.ASTRA_SYNC_TOKEN ?? readSyncToken();
    if (!cfg.sync.url || !cfg.sync.workspaceId || !syncToken) {
      console.warn(
        `${ts()} [astramem-local] sync.enabled=true but url/workspaceId/device-token incomplete — shipper NOT started.`,
      );
    } else {
      shipper = startShipper({
        db,
        url: cfg.sync.url,
        workspaceId: cfg.sync.workspaceId,
        deviceId: getOrCreateDeviceId(defaultConfigDir()),
        token: syncToken,
        batchSize: cfg.sync.batchSize,
        intervalMs: cfg.sync.intervalMs,
      });
      console.log(`${ts()} astramem-local sync shipper active -> ${cfg.sync.url}`);
    }
  }

  // FEAT-406: host is config-driven (default '127.0.0.1'). buildApp derives
  // the /health + /version auth boundary from the SAME cfg.network.host, so
  // a non-local bind here always implies Bearer-gated health/version there.
  const host = cfg.network.host;
  // devops#69: `port` may be 0 (caller asked for an OS-assigned ephemeral
  // port — see tests/smoke/helpers/daemon.ts spawnDaemon, which parses the
  // REAL bound port back out of the log line below to avoid fixed-port
  // collisions with the shared runner VM's persistent TEI container on
  // :8080 and with neighbor CI jobs' own daemons). Fastify's listen()
  // resolves with the actual bound address, so read the real port from
  // there rather than echoing back the (possibly 0) request.
  const address = await app.listen({ port, host });
  const actualPort = Number(new URL(address).port);
  console.log(`${ts()} astramem-local serving on ${host}:${actualPort}`);

  // Degraded-start (D3): probe the embed provider in the background with
  // backoff. /health reports status starting -> ok | degraded meanwhile.
  let stopPreflight: (() => void) | null = null;
  if (!useMock && !opts.strictPreflight) {
    stopPreflight = startEmbedPreflight(providers.embed as EmbedProvider, healthState, schemaDim);
  }

  // Consolidation cadence: the `consolidate` handler existed since Wave 4b
  // but nothing ever enqueued it — near-duplicate memories accumulated until
  // someone called POST /consolidation/run by hand. The pass is deterministic
  // and ~60ms at a few hundred memories, so run it at boot and every 6h.
  // Enqueued through the jobs table (not called inline) so it serializes with
  // distills and shows up in `queue` forensics like every other stage.
  let consolidateTimer: NodeJS.Timeout | null = null;
  if (dataDir !== ':memory:') {
    const CONSOLIDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
    const enqueueConsolidate = () => {
      try {
        bootRepo.enqueue('consolidate', {});
      } catch (err) {
        console.warn(`${ts()} [astramem-local] consolidate enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    enqueueConsolidate(); // boot pass — catches anything a downtime window skipped
    consolidateTimer = setInterval(enqueueConsolidate, CONSOLIDATE_INTERVAL_MS);
    consolidateTimer.unref();
  }

  // Cleanup cadence (FEAT-432): the `cleanup` handler (jobs prune + archival
  // pass + ingest_idempotency prune) has existed since Wave 4/FEAT-404 and is
  // registered on the worker + covered by unit tests, but — same bug class as
  // `consolidate` above — nothing ever enqueued it. Daily is comfortably
  // frequent relative to the day-scale retention windows it enforces
  // (older_than_days default 30, ingestIdempotency.retentionDays default 7).
  let cleanupTimer: NodeJS.Timeout | null = null;
  if (dataDir !== ':memory:') {
    const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const enqueueCleanup = () => {
      try {
        bootRepo.enqueue('cleanup', { kind: 'cleanup' });
      } catch (err) {
        console.warn(`${ts()} [astramem-local] cleanup enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    enqueueCleanup(); // boot pass — catches anything a downtime window skipped
    cleanupTimer = setInterval(enqueueCleanup, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
  }

  // WAL discipline (W1.5): with synchronous=NORMAL a hard crash loses the
  // un-checkpointed WAL tail. Truncate hourly so the at-risk window stays
  // small, and once more on graceful shutdown. Timer unref'd — never holds
  // the process open.
  let walTimer: NodeJS.Timeout | null = null;
  if (dataDir !== ':memory:') {
    const WAL_CHECKPOINT_MS = 60 * 60 * 1000;
    walTimer = setInterval(() => {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch (err) {
        console.warn(`${ts()} [astramem-local] periodic WAL checkpoint failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, WAL_CHECKPOINT_MS);
    walTimer.unref();
  }

  const shutdown = async () => {
    try {
      stopPreflight?.();
      if (walTimer) clearInterval(walTimer);
      if (consolidateTimer) clearInterval(consolidateTimer);
      if (cleanupTimer) clearInterval(cleanupTimer);
      if (shipper) await shipper.stop();
      await worker.stop();         // drain in-flight tick before closing DB
      try {
        if (dataDir !== ':memory:') db.pragma('wal_checkpoint(TRUNCATE)');
      } catch { /* close() below still checkpoints on last connection */ }
      await app.close();
    } finally {
      db.close();
      lock?.release();
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * Background embed preflight with backoff (5s → 10s → 30s → 60s cap) and a
 * 30s per-probe timeout (cold Ollama model loads routinely exceed the old 5s
 * limit). Never hard-exits: persistent failure shows up as status=degraded
 * in /health and doctor, and embedding jobs retry through the queue anyway.
 * Returns a canceller; the retry timer is unref'd so it never holds the
 * process open during shutdown.
 */
/**
 * Delete the plaintext `.pre-encryption.bak` left by the one-shot encryption
 * migration once it is older than 7 days — by then the encrypted DB has
 * proven itself across restarts, and a lingering plaintext copy of the whole
 * database is pure data-at-rest exposure. Doctor reports it during the
 * grace window so the user knows it exists.
 */
/**
 * A wrong/stale encryption key surfaces from openDb()'s first real pragma
 * (journal_mode = WAL) as `SqliteError: file is not a database
 * (SQLITE_NOTADB)` — the SAME message a genuinely corrupt file or a
 * cipher-less build produces (see CLAUDE.md's bare-`astramem-local`
 * shadowing note), so it reads as "your database is broken" rather than
 * "your encryption key doesn't match this file" (FEAT-415 AC-3). Rewraps
 * that one specific, unambiguous signal — a key was supplied and the open
 * still failed as NOTADB — into an actionable message; anything else
 * (a real SQLITE_CORRUPT, a permissions error, etc.) passes through
 * unchanged.
 */
function rewrapWrongKeyError(err: unknown, dbPath: string, keySource: string): Error {
  const code = (err as { code?: string } | null)?.code;
  if (code !== 'SQLITE_NOTADB') return err instanceof Error ? err : new Error(String(err));
  return new Error(
    `[astramem-local] FATAL: failed to open the encrypted database at ${dbPath} — ` +
    `the encryption key resolved from the ${keySource === 'credential-store' ? 'OS credential store' : 'key file'} ` +
    `does not match this file (wrong or stale key), or the file is corrupt. ` +
    `This is NOT a plaintext-vs-cipher-build issue (see CLAUDE.md) — a key was supplied and rejected. ` +
    `If you rotated or lost the encryption key, restore memory.sqlite from a backup made with the ` +
    `matching key (see 'astramem-local backup'/'restore'); do not delete db.key or the credential-store ` +
    `entry without one, or the existing data becomes permanently unreadable. Original error: ${(err as Error).message}`,
  );
}

function cleanupPreEncryptionBak(dbPath: string): void {
  const bakPath = `${dbPath}.pre-encryption.bak`;
  try {
    const st = statSync(bakPath);
    const ageDays = (Date.now() - st.mtimeMs) / (24 * 60 * 60 * 1000);
    if (ageDays > 7) {
      unlinkSync(bakPath);
      console.log(`${ts()} [astramem-local] removed plaintext pre-encryption backup (${Math.floor(ageDays)}d old): ${bakPath}`);
    } else {
      console.warn(
        `${ts()} [astramem-local] plaintext pre-encryption backup still present (${ageDays.toFixed(1)}d old, ` +
        `auto-removed after 7d): ${bakPath}`,
      );
    }
  } catch {
    /* absent — nothing to do */
  }
}

function startEmbedPreflight(
  embed: EmbedProvider,
  healthState: HealthState,
  expectedDim: number = embed.dim,
): () => void {
  const BACKOFF_MS = [5_000, 10_000, 30_000, 60_000];
  const PROBE_TIMEOUT_MS = 30_000;
  let cancelled = false;
  let timer: NodeJS.Timeout | null = null;

  const attempt = async (): Promise<void> => {
    if (cancelled) return;
    const { embedProbe } = await import('../doctor/probes/embed-probe.js');
    const result = await embedProbe(embed, PROBE_TIMEOUT_MS, expectedDim);
    if (cancelled) return;
    healthState.embed.attempts++;
    if (result.ok) {
      healthState.embed.ok = true;
      healthState.embed.lastOkAt = Date.now();
      healthState.embed.lastError = null;
      console.log(`${ts()} [astramem-local] embed preflight ok (attempt ${healthState.embed.attempts}): ${result.message}`);
      return;
    }
    healthState.embed.ok = false;
    healthState.embed.lastError = result.message;
    if (healthState.embed.attempts === 1) {
      console.warn(`${ts()} [astramem-local] embed preflight failing — serving DEGRADED while retrying: ${result.message}`);
      console.warn(`  Fix      : ${result.fix ?? 'Check embed provider config'}`);
      console.warn(`  Install  : ollama pull ${embed.model}`);
    }
    const delay = BACKOFF_MS[Math.min(healthState.embed.attempts - 1, BACKOFF_MS.length - 1)];
    timer = setTimeout(() => { void attempt(); }, delay);
    timer.unref();
  };

  void attempt();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
