import { join } from 'node:path';
import { mkdirSync, statSync, unlinkSync } from 'node:fs';
import { ts } from '../log/logger.js';
import { buildApp } from '../server/app.js';
import { openDb, type DB } from '../storage/db.js';
import type { Config } from '../config/config.js';
import { migrate, getVecSchemaDim, SchemaNewerThanDaemonError } from '../storage/migrate.js';
import { getOrCreateKey, readSyncToken } from '../storage/keystore.js';
import { resolveBearerToken } from '../storage/bearer-keystore.js';
import { startShipper, getOrCreateDeviceId, shouldStartShipper, type ShipperHandle } from '../sync/shipper.js';
import { encryptIfPlaintext } from '../storage/migrate-encrypt.js';
import { defaultConfigDir } from '../config/datadir.js';
import { resolveRuntimeConfig } from '../config/resolve-runtime.js';
import { acquireInstanceLock, AlreadyRunningError, StillBootingError, type InstanceLock } from '../service/instance-lock.js';
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
import { transcribeHandler } from '../pipeline/handlers/transcribe.js';
import { scanAndEnqueueOversizeRepairs } from '../pipeline/oversize-scanner.js';
import { makeMockProviders, type MockProviderSet } from '../pipeline/mock-providers.js';
import type { ProviderSet } from '../providers/index.js';
import type { ExtendedHandlerCtx } from '../pipeline/handler-ctx-ext.js';
import { MemoryRepo } from '../storage/memories.js';
import { SqliteVecStore } from '../vector/sqlite-vec.js';
import { drainIngestSpool } from '../ingest/spool-drain.js';
import { sweepQuarantineRedaction } from '../ingest/spool.js';
import type { DoctorCheckOpts } from '../doctor/checks.js';
import { startFrequentDoctorSchedule, runFullDoctorChecks, type DoctorScheduleResult } from '../doctor/schedule.js';
import { isLoopbackHost } from '../server/lib/network.js';

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
  const { cfg, port, dataDir, isolated } = resolveRuntimeConfig({ port: opts.port, dataDir: opts.dataDir });
  // SEC-10: CLI flag > env var > OS credential store > secrets.env
  // (canonical dir, then legacy dir) > 'devtok' default. A secrets.env-only
  // bearer is opportunistically promoted into the credential store.
  const { token } = resolveBearerToken({
    cliToken: opts.token,
    envToken: process.env.ASTRA_MEMORY_TOKEN,
  });

  const dbPath = dataDir === ':memory:' ? ':memory:' : join(dataDir, 'memory.sqlite');
  if (dataDir !== ':memory:') mkdirSync(dataDir, { recursive: true });

  // Degraded-start health state (D3) + boot-readiness gate (Wave 0 Item 3).
  const healthState = createHealthState();
  if (dataDir !== ':memory:') healthState.dataDir = dataDir;
  // See health-state.ts's `ready` doc comment: flips back to true once
  // bootAndBind() below (open/migrate/recover/providers/buildApp/listen —
  // see that function's own doc comment for why these can't move AFTER
  // app.listen() yet) has fully completed. buildApp()'s readiness-gate hook
  // (src/server/app.ts) 503s every route but /health, /health/full,
  // /version while this is false — infrastructure kept live and tested even
  // though today's boot-body window it protects is narrow, ready for a
  // future change that genuinely defers migrate past the bind.
  healthState.ready = false;
  const { createEventLoopLagMonitor } = await import('../server/event-loop-lag.js');
  const eventLoopLag = createEventLoopLagMonitor();
  healthState.eventLoopLag = eventLoopLag;

  // Handles populated inside bootAndBind()/the post-bind setup further down
  // — declared up front so shutdown() (registered before most of them
  // exist, in case a SIGTERM arrives mid-boot) and the crash handlers can
  // null-check every one of them safely regardless of how far boot got.
  let lock: InstanceLock | null = null;
  let dbForCrash: ReturnType<typeof openDb> | null = null;
  let healthSnapshotTimer: NodeJS.Timeout | null = null;
  let stopPreflight: (() => void) | null = null;
  let stopFrequentDoctor: (() => void) | null = null;
  let consolidateTimer: NodeJS.Timeout | null = null;
  let bootConsolidateTimer: NodeJS.Timeout | null = null;
  let cleanupTimer: NodeJS.Timeout | null = null;
  let oversizeScanTimer: NodeJS.Timeout | null = null;
  let spoolDrainTimer: NodeJS.Timeout | null = null;
  let walTimer: NodeJS.Timeout | null = null;
  let vecSearchHost: import('../vector/vec-search-host.js').VecSearchWorkerHost | null = null;
  let shipper: ShipperHandle | null = null;
  let worker: WorkerHandle | null = null;
  let governor: ReturnType<typeof import('../pipeline/backpressure.js').createLoadGovernor> | null = null;

  // Global crash handlers (serve path only): a stray rejection must not kill
  // the process silently — log, release the lock, close the DB, exit 1 so
  // the abnormal exit is visible in task history. Restart comes from the
  // scheduler's repetition trigger, not from exit-code semantics. Registered
  // before the lock/db exist (both still null here) so a crash during the
  // boot sequence itself is caught too — every reference below is
  // optional-chained for exactly that reason.
  const crashExit = (kind: string) => (err: unknown) => {
    console.error(`${ts()} [astramem-local] FATAL ${kind}:`, err);
    try { lock?.release(); } catch { /* best-effort */ }
    try { dbForCrash?.close(); } catch { /* best-effort */ }
    process.exit(1);
  };
  process.on('uncaughtException', crashExit('uncaughtException'));
  process.on('unhandledRejection', crashExit('unhandledRejection'));

  const useMock = process.env.ASTRA_MEMORY_MOCK_PROVIDERS === '1';
  const host = cfg.network.host;

  let app!: Awaited<ReturnType<typeof buildApp>>;
  let address = '';
  let providers!: ProviderSet | MockProviderSet;
  let schemaDim = cfg.embedding.dim;
  let bootRepo!: JobRepo;
  let db!: ReturnType<typeof openDb>;

  /**
   * The real boot body. Runs AS THE `bind` CALLBACK passed to
   * `acquireInstanceLock` (dataDir !== ':memory:') — i.e. entirely WHILE the
   * Item 2 `.acquiring` mutex is held, immediately after daemon.lock has
   * already been written claiming ownership. See instance-lock.ts's header
   * for why the mutex must span this whole sequence and not just the lock
   * write — unchanged by FEAT-537 below, still not touched.
   *
   * FEAT-537: `buildApp()` → `ingestRoute()` used to prepare several
   * statements (e.g. against `ingest_idempotency`) SYNCHRONOUSLY at
   * route-registration time — calling buildApp() against an unmigrated DB
   * threw `SqliteError: no such table: ingest_idempotency` before a single
   * route was reachable, which is why an earlier slice (Wave 0 Item 3) could
   * only ship the `healthState.ready` 503 gate without the literal
   * bind-before-migrate ordering it was meant to protect. `ingestRoute`'s
   * statements are now prepared lazily (prepare-on-first-use, cached — see
   * src/server/routes/ingest.ts), so `buildApp()` + `app.listen()` can run
   * BEFORE `migrate()` in the default (non-strict) path:
   *
   *   lock acquire → bind (buildApp + listen) → migrate/recover/wiring →
   *   healthState.ready = true (set by the caller once this resolves)
   *
   * While `healthState.ready` is false, /health and /version answer
   * normally (health.ts degrades every DB read to a safe default on a
   * missing table) and every OTHER route 503s via buildApp()'s readiness
   * gate — so a slow or hanging migrate() no longer makes the daemon
   * unreachable on the wire, just temporarily 503 on non-health routes.
   *
   * `opts.strictPreflight` (legacy CI/scripted fail-fast mode) keeps the
   * PRE-FEAT-537 ordering — migrate/recover/wiring, THEN a real embed call,
   * THEN buildApp + listen — because that mode's entire point is to
   * validate schema + a live embed call BEFORE ever accepting traffic;
   * binding ahead of that validation would defeat it. `runMigrateAndDbSetup`
   * below is shared by both branches so the DB-dependent boot steps
   * themselves (migrate, schema-dim resolution, job recovery/purge, health
   * snapshot refresher, worker/KNN/shipper wiring) stay defined exactly
   * once — only the ORDER relative to bind differs per branch.
   */
  const bootAndBind = async (): Promise<void> => {
    const bootStartedAt = Date.now();

    // Assigns the outer `db` (declared above bootAndBind) — the WAL/oversize-
    // scan/spool-drain timers registered after boot need the same handle,
    // not a copy scoped to this closure. `dbKey` is retained for the
    // vec-search offload worker (its own read-only connection needs the same
    // SQLCipher key) — undefined on the plaintext and :memory: paths. See
    // `openBootDb`'s doc comment for why this is the ONLY openDb() call
    // reached before app.listen() either way.
    const opened = openBootDb(dataDir, dbPath, cfg);
    db = opened.db;
    const dbKey = opened.dbKey;
    dbForCrash = db;

    // ---------------------------------------------------------------------
    // DB-dependent boot work — everything that needs a MIGRATED schema
    // (migrate itself, schema-dim resolution, job recovery/purge, the
    // health-snapshot refresher, worker/KNN-offload/shipper wiring). Shared
    // by both branches below; only its position relative to bind changes.
    // ---------------------------------------------------------------------
    const runMigrateAndDbSetup = async (): Promise<void> => {
      // FEAT-409: dim only matters for a genuinely fresh DB — migrate() skips
      // already-applied migrations regardless, so this stays correct across
      // upgrades and restarts of an existing (already at some dim) DB.
      try {
        migrate(db, cfg.embedding.dim);
      } catch (err) {
        if (err instanceof SchemaNewerThanDaemonError) {
          // Issue #306: the datadir was migrated by a newer astramem-local than
          // this pinned release. Print ONE actionable line (not a stack trace)
          // — the operator fix is `reinstall`, not a bug report. The caller
          // (acquireInstanceLock's bind-failure handling, or the :memory:
          // catch below) closes the DB / releases whatever lock was written.
          console.error(`${ts()} [astramem-local] ${err.message}`);
        }
        throw err;
      }

      // FEAT-409 AC-3: the dim the embed preflight checks against is the
      // PERSISTED schema dim (what memories_vec was actually created with),
      // not just cfg.embedding.dim — a config/provider dim that drifted from
      // the real schema (edited config.yaml without running `reembed-dim`)
      // must fail loud here, not deep inside the first ingest's sqlite-vec
      // dimension mismatch. Falls back to cfg.embedding.dim on a genuinely
      // fresh DB (memories_vec doesn't exist yet — migrate() just created it
      // at that dim, so they agree by construction).
      schemaDim = getVecSchemaDim(db) ?? cfg.embedding.dim;

      // Boot job recovery (P1.1): requeue jobs orphaned by a non-graceful death
      // ('running' from a mid-handle kill; 'failed' whose in-memory retry timer
      // died with the process). Purge old completed/poison bookkeeping (P1.2).
      bootRepo = new JobRepo(db);
      const recovered = bootRepo.recoverOrphans();
      if (recovered.requeuedRunning + recovered.requeuedFailed > 0) {
        console.log(
          `${ts()} [astramem-local] job recovery: requeued ${recovered.requeuedRunning} orphaned running, ` +
          `${recovered.requeuedFailed} interrupted retries`,
        );
      }
      // issue #387: a 'running' consolidate job is never blind-requeued (see
      // JobRepo.recoverOrphans's doc comment) — surface it loudly (ADR-015) so a
      // restart that just avoided the freeze-reproduction loop is visible in
      // boot logs, not silently swallowed.
      if (recovered.poisonedConsolidate > 0) {
        console.error(
          `${ts()} [astramem-local] job recovery: poisoned ${recovered.poisonedConsolidate} orphaned ` +
          'running consolidate job(s) instead of requeuing (issue #387) — a previous boot likely froze ' +
          'mid-scan; re-enqueue manually (astramem-local queue) once the setup budget/yield fix is confirmed safe.',
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

      // P1.3 refresher: immediate first compute so /health carries the block
      // right from boot, then every 30s. Keep-last-good on failure — a refresh
      // glitch must never blank the block or crash anything.
      {
        const { computeHealthDbSnapshot } = await import('../server/routes/health.js');
        const refreshHealthSnapshot = (): void => {
          try {
            healthState.dbSnapshot = computeHealthDbSnapshot(db, dataDir !== ':memory:' ? dataDir : undefined);
          } catch (err) {
            console.warn(`${ts()} [astramem-local] health snapshot refresh failed (kept last good): ${err instanceof Error ? err.message : String(err)}`);
          }
        };
        refreshHealthSnapshot();
        healthSnapshotTimer = setInterval(refreshHealthSnapshot, 30_000);
        healthSnapshotTimer.unref();
      }

      // Wire up the worker with extended context so distillation runs
      const registry = new HandlerRegistry();
      registry.register(distillHandler);
      registry.register(distillEventsHandler);
      registry.register(cleanupHandler);
      registry.register(consolidateHandler);
      registry.register(reembedHandler);
      registry.register(transcribeHandler);

      // FEAT-492: content-hash embedding cache, DOCUMENT-role only. The worker's
      // extended context gets its OWN `providers` object with `embed` swapped for
      // a caching wrapper — `providers.embed` above (already handed to buildApp
      // for the query-role search routes, and used unchanged for the preflight/
      // doctor probes below) stays raw. See src/providers/embed/cache.ts's doc
      // comment for why the two must not share one wrapped instance.
      const { CachingEmbedProvider } = await import('../providers/embed/cache.js');
      const workerProviders: ProviderSet | MockProviderSet = {
        ...providers,
        embed: new CachingEmbedProvider(providers.embed, db),
      };

      const extCtx: ExtendedHandlerCtx = {
        db,
        config: cfg,
        providers: workerProviders,
        memoryRepo: new MemoryRepo(db),
        vecStore: new SqliteVecStore(db, cfg.embedding.dim),
      };

      // P1.4/P1.5 load governor: lanes ramp 1 → half → full over 60s steps at
      // boot ("serve traffic first, catch up second" — a restart re-enqueues
      // orphans and must not claim them at full concurrency while the daemon is
      // proving liveness to the watchdog), then the embed-latency EWMA throttles
      // the budget whenever distill/reembed handler runs slow past 5s/20s.
      // :memory: (tests, throwaway) skips the ramp — no watchdog, no backlog.
      const { createLoadGovernor } = await import('../pipeline/backpressure.js');
      const { resolveWorkerConcurrency } = await import('../pipeline/worker.js');
      governor = createLoadGovernor({
        maxLanes: resolveWorkerConcurrency(cfg),
        ...(dataDir !== ':memory:' ? { bootRamp: {} } : {}),
      });

      // startWorker takes HandlerCtx but we pass ExtendedHandlerCtx (structural subtype)
      worker = startWorker({
        pollMs: 500,
        registry,
        db,
        config: cfg,
        ctx: extCtx,
        healthState,
        governor,
      });

      // KNN offload (2026-07-15 incident): recall's brute-force vector scan is a
      // synchronous native call that grows with the corpus — run it on a worker
      // thread with its own read-only connection so it never blocks the event
      // loop. Registered for real datadirs only: a :memory: DB is invisible to a
      // second connection, and non-daemon entry points (mcp-stdio, CLI, eval)
      // never register, keeping their inline synchronous path. Any worker
      // failure falls back to the main-thread scan (loud WARN per occurrence).
      if (dataDir !== ':memory:') {
        const { VecSearchWorkerHost } = await import('../vector/vec-search-host.js');
        const { setVecSearchOffload } = await import('../vector/vec-search-offload.js');
        const fallbackStore = new SqliteVecStore(db, cfg.embedding.dim);
        vecSearchHost = new VecSearchWorkerHost({
          dbPath,
          key: dbKey,
          fallback: (vec, k) => fallbackStore.search(vec, k),
        });
        const host = vecSearchHost;
        setVecSearchOffload((vec, k) => host.search(vec, k));
      }

      // Sync shipper (ADR-003): one-way log shipping to the cloud ledger.
      // Requires explicit opt-in + url + workspace + device token; private
      // atoms never ship regardless (scope filter inside the shipper).
      // `!isolated` is a second, independent guard on top of resolveRuntimeConfig
      // already forcing cfg.sync.enabled=false under ASTRA_MEMORY_ISOLATED=1 — a
      // synthetic/eval daemon must never start the shipper even if some future
      // code path re-derives cfg.sync from elsewhere.
      //
      // EXPERIMENTAL HARD GATE (sync-experimental-gate slice). Originally added
      // because sync-to-cloud was broken against astramem-cloud (8868 events
      // failing HTTP 400); that was root-caused to a YARP stale-pooled-connection
      // bug in the shared gateway (`common` repo, commit `edf266a`, bounds
      // `PooledConnectionLifetime`), fixed and deployed to prod 2026-07-14, and
      // re-verified live 2026-07-15 — sync is no longer known-broken. The gate
      // now stands as a deliberate staged-rollout safety net, not a "sync is
      // broken" guard. `sync.enabled` alone (set by `astramem-local pair` on a
      // successful redeem) is NOT sufficient to start the shipper — see
      // shouldStartShipper() in sync/shipper.ts. `cfg.sync.experimental` is a
      // separate, config.yaml-only, hand-edit opt-in that `pair` never touches.
      if (cfg.sync.enabled && dataDir !== ':memory:' && !isolated && !cfg.sync.experimental) {
        console.warn(
          `${ts()} [astramem-local] sync is EXPERIMENTAL — sync.enabled=true but sync.experimental=false; ` +
          `the cloud sync shipper was NOT started. Sync-to-cloud is not yet stable. Set sync.experimental: ` +
          `true in config.yaml to opt in once you understand the risk.`,
        );
      }
      if (shouldStartShipper({ enabled: cfg.sync.enabled, experimental: cfg.sync.experimental, dataDir, isolated })) {
        const syncToken = process.env.ASTRA_SYNC_TOKEN ?? readSyncToken(defaultConfigDir());
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
    };

    // Resolve providers: mock mode (CI/test) or real providers. Provider
    // CONSTRUCTION is config-driven only (no DB dependency, no schema read)
    // — it must run before `buildApp()` either way, because buildApp() bakes
    // `providers.embed` into every search/recall/mcp route's closure at
    // REGISTRATION time; there is no way to swap it in after routes are
    // registered, so the real provider has to exist first regardless of
    // which branch below binds before or after migrate.
    if (dataDir !== ':memory:') healthState.dataDir = dataDir;
    if (useMock) {
      providers = makeMockProviders(cfg.embedding.dim);
      healthState.embed.ok = true; // mock embed is always available
      healthState.embed.lastOkAt = Date.now();
    } else {
      // Real providers from config — only imported when not in mock mode
      const { getProviders } = await import('../providers/index.js');
      providers = getProviders(cfg);
    }

    // FEAT-406: host is config-driven (default '127.0.0.1'). buildApp derives
    // the /health + /version auth boundary from the SAME cfg.network.host, so
    // a non-local bind here always implies Bearer-gated health/version there.
    // devops#69: `port` may be 0 (caller asked for an OS-assigned ephemeral
    // port — see tests/smoke/helpers/daemon.ts spawnDaemon, which parses the
    // REAL bound port back out of the log line below to avoid fixed-port
    // collisions with the shared runner VM's persistent TEI container on
    // :8080 and with neighbor CI jobs' own daemons). Fastify's listen()
    // resolves with the actual bound address, so read the real port from
    // there rather than echoing back the (possibly 0) request.
    if (opts.strictPreflight) {
      // Legacy fail-fast path (CI / scripted checks): validate schema + a
      // real embed call BEFORE binding — structurally incompatible with
      // binding ahead of migrate, so this branch keeps the PRE-FEAT-537
      // ordering: migrate/recover/wiring, then the real embed preflight
      // (needs the persisted schemaDim resolved by runMigrateAndDbSetup),
      // THEN buildApp + listen.
      await runMigrateAndDbSetup();

      if (!useMock) {
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

      app = await buildApp({ db, token, embed: providers.embed, config: cfg, healthState });
      address = await app.listen({ port, host });
    } else {
      // Default degraded-start path (FEAT-537 / Wave 0 Item 3): bind the
      // port FIRST — healthState.ready is still false here, so /health
      // answers `starting` and every other route 503s via buildApp()'s
      // readiness gate — THEN run migrate/recovery/worker-wiring. A daemon
      // that can't reach its own DB in time is now reachable/diagnosable on
      // the wire the whole time instead of unresponsive until boot finishes.
      // Degraded-start (D3): the non-strict EMBED preflight runs in the
      // BACKGROUND after this function returns — see startEmbedPreflight,
      // called by the outer serve() once bootAndBind resolves.
      app = await buildApp({ db, token, embed: providers.embed, config: cfg, healthState });
      address = await app.listen({ port, host });
      await runMigrateAndDbSetup();
    }

    const actualPort = Number(new URL(address).port);
    console.log(`${ts()} astramem-local serving on ${host}:${actualPort}`);

    const bootMs = Date.now() - bootStartedAt;
    if (bootMs > 5_000) {
      console.warn(
        `${ts()} [astramem-local] boot sequence took ${bootMs}ms — slower than the ~5s expected budget. ` +
        (opts.strictPreflight
          ? 'strict-preflight mode: the daemon was not reachable on the wire at all until just now.'
          : '/health has been reachable (starting, then 503-gated on other routes) since bind; ' +
            'only migrate/recovery/worker-wiring took this long.'),
      );
    }
  };

  if (dataDir !== ':memory:') {
    // Single-instance lock (D2 + Wave 0 Item 2): protects the data dir, not
    // just the TCP port — a second daemon on a different port would still
    // race the job queue. The `.acquiring` mutex (instance-lock.ts) now
    // holds through the ENTIRE bootAndBind() call, including the final
    // app.listen() — closing the split-brain race where two
    // near-simultaneous starts (schtasks keepalive PT5M + watchdog PT3M)
    // could both classify a holder as a zombie and both bind. A healthy
    // holder (or a sibling that won the race) → AlreadyRunningError → exit 0
    // so schtasks keepalive re-runs are cheap no-ops.
    try {
      lock = await acquireInstanceLock(dataDir, port, PKG_VERSION, { bind: bootAndBind });
    } catch (err) {
      if (err instanceof AlreadyRunningError) {
        console.log(`${ts()} [astramem-local] ${err.message} — exiting (single-instance).`);
        process.exit(0);
      }
      // issue #396: a second launcher (schtasks keepalive/watchdog) racing a
      // genuinely-alive holder still mid-boot (before app.listen()) must
      // defer, not steal — same cheap-no-op exit AlreadyRunningError already
      // gives a confirmed-healthy holder. See StillBootingError's doc comment.
      if (err instanceof StillBootingError) {
        console.log(`${ts()} [astramem-local] ${err.message} — exiting (single-instance boot race).`);
        process.exit(0);
      }
      if (err instanceof SchemaNewerThanDaemonError) {
        // Already logged (with the actionable one-liner) inside bootAndBind's
        // migrate() catch above. acquireInstanceLock's bind-failure handling
        // already released the daemon.lock it had just written; just make
        // sure the DB handle gets closed before exiting.
        // TS narrows `dbForCrash` to `never` here (a compiler quirk: it
        // never sees the assignment inside bootAndBind's closure once that
        // closure is merely passed elsewhere, let alone awaited through
        // acquireInstanceLock's `bind` option) — the explicit re-annotation
        // recovers the real runtime type without changing behavior.
        const dbHandle = dbForCrash as ReturnType<typeof openDb> | null;
        try { dbHandle?.close(); } catch { /* best-effort */ }
        process.exit(1);
      }
      throw err;
    }
  } else {
    try {
      await bootAndBind();
    } catch (err) {
      if (err instanceof SchemaNewerThanDaemonError) {
        // TS narrows `dbForCrash` to `never` here (a compiler quirk: it
        // never sees the assignment inside bootAndBind's closure once that
        // closure is merely passed elsewhere, let alone awaited through
        // acquireInstanceLock's `bind` option) — the explicit re-annotation
        // recovers the real runtime type without changing behavior.
        const dbHandle = dbForCrash as ReturnType<typeof openDb> | null;
        try { dbHandle?.close(); } catch { /* best-effort */ }
        process.exit(1);
      }
      throw err;
    }
  }

  // Boot sequence complete — the DB is migrated, routes are safe to serve,
  // and every background handle above is populated. Flip the readiness gate
  // (src/server/app.ts) so non-health/version routes stop 503ing.
  healthState.ready = true;

  // Degraded-start (D3): probe the embed provider in the background with
  // backoff. /health reports status starting -> ok | degraded meanwhile.
  if (!useMock && !opts.strictPreflight) {
    stopPreflight = startEmbedPreflight(providers.embed as EmbedProvider, healthState, schemaDim);
  }

  // ADR-018 SLICE-2 — ONNX startup preload. `startEmbedPreflight` above
  // already indirectly warms the ONNX backend for EVERY provider generically
  // (embedProbe calls provider.embed(['ping'], ...), which triggers
  // OnnxEmbedProvider's lazy getBackend() load as a side effect) — but that
  // path is a health probe, gated behind `!opts.strictPreflight`, not a
  // stated warm-up contract. This is an explicit, onnx-scoped preload so the
  // FIRST real search/distill embed() call after boot doesn't pay cold
  // session-load / possible first-run weight-download latency, independent
  // of the preflight's own gating/backoff cadence. ONLY wired for
  // `provider: 'onnx'` — never ollama/azure-openai, so an operator who
  // hasn't opted in never pays for triggering the multi-hundred-MB
  // `@huggingface/transformers` dependency chain at boot. Runs in the
  // BACKGROUND (app.listen already resolved above — this never blocks port
  // bind), same degraded-start philosophy as startEmbedPreflight: a failure
  // WARNs loudly and lets the next real embed() call retry the lazy load
  // inline (OnnxEmbedProvider.getBackend() never memoizes a failed load), it
  // never crashes boot — mirrors CodexSubscriptionLLMProvider's "no
  // construction-time throw" posture (providers/index.ts).
  if (!useMock && cfg.embedding.provider === 'onnx' && dataDir !== ':memory:') {
    const embedProvider = providers.embed as EmbedProvider & { preload?: () => Promise<void> };
    if (typeof embedProvider.preload === 'function') {
      void embedProvider.preload().then(
        () => console.log(`${ts()} [astramem-local] onnx embed preload ok (session warmed at boot)`),
        (err: unknown) => console.warn(
          `${ts()} [astramem-local] WARNING: onnx embed preload failed at boot — the first real embed ` +
          `call will retry the load inline instead: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  // Unattended doctor scheduling (A2-lite, ADR-015): src/doctor/schedule.ts's
  // two-tier split — cheap DB-only checks on a frequent cadence; the LLM
  // chat probe + embed probe piggyback the EXISTING 24h cleanup tick below
  // (see the `enqueueCleanup` closure) rather than a new interval — a tight
  // interval on a real LLM call is a self-DoS on a shared GPU and, on a
  // metered endpoint, the FEAT-482 incident class (see CLAUDE.md). Skipped
  // under the :memory: dev/test datadir, same convention every other
  // background timer below follows.
  const codexSubscriptionInUse =
    cfg.llm.compaction.provider === 'codex-subscription' || cfg.llm.extraction.provider === 'codex-subscription';

  // First-run guard (architect review 20260714T130000Z, answer 6):
  // codex-subscription is the shipped default (CLAUDE.md "v0.18.0: codex is
  // the DEFAULT provider"). A fresh install with no `codex login` throws a
  // loud DeterministicError on every extraction/compaction call
  // (codex-subscription.ts's loadAuthFile), but with too few completed
  // sessions the poison-rate doctor branch (checkMemoryHealth) stays quiet
  // below MEANINGFUL_USAGE_THRESHOLD, and the doctor check that WOULD catch
  // this (checkCodexAuth, doctor/checks/provider-supplementary.ts) only runs
  // on the 24h full-tier piggyback below — an operator who never tails logs
  // or runs `doctor` by hand can go a full day with a healthy-looking daemon
  // and zero memories. Check immediately at boot instead of waiting for that
  // tier. Presence-only (hasCodexLogin) — this does NOT auto-rewrite
  // config.yaml (the init wizard already handles interactive steering); it
  // is a loud, actionable log line only. Skipped under mock providers (no
  // real Codex call will ever happen there).
  if (!useMock && codexSubscriptionInUse) {
    const { hasCodexLogin, defaultAuthPath } = await import('../providers/llm/codex-subscription.js');
    const authPath = cfg.codexSubscription.authPath ?? defaultAuthPath();
    if (!hasCodexLogin(authPath)) {
      console.warn(
        `${ts()} [astramem-local] WARNING: codex-subscription is selected (llm.compaction/extraction.provider) ` +
        `but no Codex CLI login found at ${authPath}. Every extraction/compaction call will fail with a loud ` +
        `error until you run \`codex login\` — and with too few completed sessions, the poison-rate doctor ` +
        `check won't flag it either, so this daemon can look healthy while storing zero memories. ` +
        `Fix: run \`codex login\`, or edit config.yaml to set llm.compaction.provider / llm.extraction.provider ` +
        `to 'ollama' (local sub-default model qwen2.5:7b) and restart.`,
      );
    }
  }

  const actualPortForDoctor = Number(new URL(address).port);
  const baseDoctorOpts: DoctorCheckOpts = {
    port: actualPortForDoctor,
    dataDir,
    redactionEnabled: cfg.security.redaction.enabled,
    encryptionEnabled: cfg.security.encryption.enabled,
    durabilityGateMode: cfg.distill.durabilityGate,
    extractProfile: cfg.distill.extractProfile,
    atomTriageMode: cfg.distill.atomTriage.mode,
    gatekeeperMode: cfg.distill.gatekeeper.mode,
    dailyBudgetUsd: cfg.budget.daily_usd,
    codexSubscriptionInUse,
    autoCaptureEnabled: cfg.capture.autoCapture.enabled,
    proxyEnabled: cfg.proxy.enabled,
    proxyCaptureEnabled: cfg.proxy.capture.enabled,
    syncEnabled: cfg.sync.enabled,
    syncExperimental: cfg.sync.experimental,
    // Mirrors buildApp's devNoAuthActive — a non-loopback bind refuses
    // devNoAuth at boot, so the scheduled run must apply the same gate
    // rather than reporting the raw config value (same reasoning as
    // cli/doctor.ts's on-demand construction of this option).
    devNoAuthActive: cfg.auth.devNoAuth === true && isLoopbackHost(cfg.network.host),
    audioMode: cfg.audio.mode,
    audioDisclosureAcknowledged: cfg.audio.disclosureAcknowledged ?? false,
    // P1.2: scheduled doctor runs read the live histogram in-process.
    eventLoopLag,
  };
  // Full-tier opts add the real providers — used ONLY on the 24h piggyback
  // below, never on the frequent tick. Safe under ASTRA_MEMORY_MOCK_PROVIDERS
  // (the mock LLM/embed providers never touch Ollama).
  const fullDoctorOpts: DoctorCheckOpts = {
    ...baseDoctorOpts,
    // Wave 1 (BYO providers, #414): forward every configurable role, not
    // just compaction/extraction — judge/extractionPassB/atomTriage are
    // optional overrides that `getProviders` ALWAYS sets (see ProviderSet's
    // doc comment in src/providers/index.ts), falling back to the same
    // instance as `extraction` when unconfigured. `getChecks`'s dedup loop
    // (src/doctor/checks/index.ts) already skips a probe that matches an
    // earlier-listed role's provider, so passing all five here is safe for
    // every pre-Wave-1 config too (byte-identical: one dedup'd probe per
    // distinct provider instance, same as before this change).
    llmProviders: {
      compaction: providers.llm.compaction,
      extraction: providers.llm.extraction,
      judge: providers.llm.judge,
      extractionPassB: providers.llm.extractionPassB,
      atomTriage: providers.llm.atomTriage,
      gatekeeper: providers.llm.gatekeeper,
    },
    embedProvider: providers.embed,
  };
  const handleDoctorResult = (result: DoctorScheduleResult): void => {
    healthState.doctor = {
      lastRunAt: result.ranAt,
      lastTier: result.tier,
      lastFailCount: result.failCount,
      lastInconclusiveCount: result.inconclusiveCount,
      lastFailNames: result.results.filter(r => !r.ok).map(r => r.name),
    };
    // ADR-015: a scheduled red that only reaches a log file nobody tails is
    // the same failure this ADR exists to kill — but it must ALSO land in a
    // structured, greppable log line for anyone who IS watching, not only
    // /health (healthState.doctor above). Both, not either.
    if (result.failCount > 0) {
      console.warn(
        `${ts()} [astramem-local] doctor (${result.tier}) FAILED ${result.failCount}/${result.results.length}: ` +
        result.results.filter(r => !r.ok).map(r => r.name).join(', '),
      );
    }
    // #226 follow-up finding 2: a crash-looping daemon skips the metered
    // LLM/embed probes on this boot's full-tier pass (see schedule.ts's
    // runFullDoctorChecks) — surface that explicitly so a green "0 failures"
    // line isn't mistaken for "the LLM/embed probe passed" when it never ran.
    if (result.llmTierSkippedForCrashLoop) {
      console.warn(
        `${ts()} [astramem-local] doctor (${result.tier}) skipped the LLM/embed probes — crash-loop streak ` +
        `at/above threshold (see the "Crash loop" check finding for details).`,
      );
    }
  };
  if (dataDir !== ':memory:') {
    stopFrequentDoctor = startFrequentDoctorSchedule(baseDoctorOpts, handleDoctorResult);
  }

  // Consolidation cadence: the `consolidate` handler existed since Wave 4b
  // but nothing ever enqueued it — near-duplicate memories accumulated until
  // someone called POST /consolidation/run by hand. The pass is deterministic
  // and ~60ms at a few hundred memories, so run it at boot and every 6h.
  // Enqueued through the jobs table (not called inline) so it serializes with
  // distills and shows up in `queue` forensics like every other stage.
  if (dataDir !== ':memory:') {
    const CONSOLIDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
    const enqueueConsolidate = () => {
      try {
        bootRepo.enqueue('consolidate', {});
      } catch (err) {
        console.warn(`${ts()} [astramem-local] consolidate enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    // ASTRA_SKIP_CONSOLIDATE=1 kill-switch: on a large corpus the consolidate
    // pairwise scan's SETUP (load all valid atoms + group + build per-group
    // embedding maps) is synchronous and unbounded — it can freeze the event
    // loop long enough on boot that the daemon looks dead (2026-07-15). The
    // in-loop yield helps the O(n^2) scan itself but not the setup, so this
    // switch lets an operator disable consolidation until the setup is also
    // bounded. Skips both the boot pass and the recurring timer.
    if (process.env['ASTRA_SKIP_CONSOLIDATE'] === '1') {
      console.warn(`${ts()} [astramem-local] consolidation disabled via ASTRA_SKIP_CONSOLIDATE=1`);
    } else {
      // P1.5 boot stagger: the boot pass used to fire synchronously here —
      // a restart re-enqueued consolidate at the exact moment job recovery
      // had just refilled the queue, at full lane concurrency, while the
      // watchdog was probing a daemon still proving liveness (2026-07-15
      // restart-storm input). Delay it past one full watchdog probe cycle
      // (180s) + margin; the recurring 6h interval starts from the delayed
      // pass so cadence is unchanged thereafter. unref'd — never holds the
      // process open; a downtime window's missed pass is only ever delayed
      // by 5 minutes, not skipped.
      const BOOT_CONSOLIDATE_DELAY_MS = 5 * 60 * 1000;
      bootConsolidateTimer = setTimeout(() => {
        enqueueConsolidate(); // delayed boot pass — catches anything a downtime window skipped
        consolidateTimer = setInterval(enqueueConsolidate, CONSOLIDATE_INTERVAL_MS);
        consolidateTimer.unref();
      }, BOOT_CONSOLIDATE_DELAY_MS);
      bootConsolidateTimer.unref();
    }
  }

  // Cleanup cadence (FEAT-432): the `cleanup` handler (jobs prune + archival
  // pass + ingest_idempotency prune) has existed since Wave 4/FEAT-404 and is
  // registered on the worker + covered by unit tests, but — same bug class as
  // `consolidate` above — nothing ever enqueued it. Daily is comfortably
  // frequent relative to the day-scale retention windows it enforces
  // (older_than_days default 30, ingestIdempotency.retentionDays default 7).
  if (dataDir !== ':memory:') {
    const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const enqueueCleanup = () => {
      try {
        bootRepo.enqueue('cleanup', { kind: 'cleanup' });
      } catch (err) {
        console.warn(`${ts()} [astramem-local] cleanup enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Full-tier doctor pass (LLM chat probe + embed probe): piggybacked on
      // THIS SAME 24h timer deliberately — see the doctor-scheduling comment
      // above. Independent of the cleanup-enqueue outcome above, so neither
      // failing blocks the other. Fire-and-forget: runFullDoctorChecks never
      // throws (runChecks() catches per-check errors internally).
      void runFullDoctorChecks(fullDoctorOpts, handleDoctorResult).catch(() => {});
    };
    enqueueCleanup(); // boot pass — catches anything a downtime window skipped
    cleanupTimer = setInterval(enqueueCleanup, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
  }

  // Oversize-atom repair sweep (FEAT-507): a dedicated, shorter-cadence
  // cousin of the vec-index sweep above — same durable needs_vec_index
  // marker, but filtered to memories whose text also exceeds the embed
  // model's context budget (src/pipeline/oversize.ts), which is exactly the
  // set the cleanup sweep's plain reembed re-enqueue could never actually
  // fix before reembedHandler's truncate-before-embed change (this slice).
  // Production was observed accumulating these poisons at ~16/hr, too fast
  // to wait for cleanup's 24h cadence, so this gets its own 1h timer rather
  // than piggybacking on that tick. Cheap on every (usually empty) tick — a
  // single bounded SQL scan — and idempotent (oversize-scanner.ts skips a
  // memory that already has a pending/running reembed job).
  if (dataDir !== ':memory:') {
    const OVERSIZE_SCAN_INTERVAL_MS = 60 * 60 * 1000; // 1h
    const runOversizeScan = () => {
      try {
        // Reopen through bootRepo's shared db handle — bootAndBind closed
        // over `db` locally, so read it back off bootRepo/worker instead of
        // re-declaring a module-scope db reference just for this timer.
        const result = scanAndEnqueueOversizeRepairs(db);
        if (result.enqueued > 0 || result.alreadyQueued > 0) {
          console.log(
            `${ts()} [astramem-local] oversize-atom scan: enqueued ${result.enqueued} reembed job(s) for ` +
            `oversize memories (${result.alreadyQueued} already queued, ${result.candidates} candidate(s) total)`,
          );
        }
      } catch (err) {
        console.warn(`${ts()} [astramem-local] oversize-atom scan failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    runOversizeScan(); // boot pass — catches anything a downtime window skipped
    oversizeScanTimer = setInterval(runOversizeScan, OVERSIZE_SCAN_INTERVAL_MS);
    oversizeScanTimer.unref();
  }

  // Quarantine redaction sweep (Finding 2, 2026-07-13 fast-follow to #225):
  // one-time-per-boot pass that rewrites any EXISTING `.quarantine/` content
  // through the same redactor new writes already get — content quarantined
  // BEFORE #225 shipped never got redacted, and only ages out via the 7-day
  // TTL, which itself only fires if a drain tick runs. Deliberately NOT on
  // the 30s drain-tick cadence below (see sweepQuarantineRedaction doc for
  // why once per boot is sufficient — it's idempotent and a no-op once
  // everything in the directory has already been rewritten once).
  if (dataDir !== ':memory:') {
    try {
      const sweep = sweepQuarantineRedaction(dataDir, cfg);
      if (sweep.redacted > 0) {
        console.warn(
          `${ts()} [astramem-local] quarantine redaction sweep: redacted ${sweep.redacted} of ${sweep.scanned} ` +
          `pre-existing quarantine file(s) (${sweep.unparseable} via raw-text fallback, ${sweep.failed} failed and left untouched)`,
        );
      }
    } catch (err) {
      console.warn(`${ts()} [astramem-local] quarantine redaction sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Ingest-spool drain cadence (FEAT-449): called directly on a timer (not
  // enqueued through the jobs table like consolidate/cleanup above) because
  // draining is filesystem-driven — it lists ingest-spool/*.json rather than
  // reacting to an event. Runs at boot (AC-8: drains anything captured while
  // the daemon was down) and every 30s thereafter; each tick is normally a
  // few filesystem stats plus, at most, whatever synchronous DB work
  // `ingestCanonicalTranscript` does for genuinely new spool files, so a
  // short interval costs nothing on the (usual) empty-spool tick.
  if (dataDir !== ':memory:') {
    const SPOOL_DRAIN_INTERVAL_MS = 30_000;
    const runSpoolDrain = () => {
      try {
        const res = drainIngestSpool(db, cfg, dataDir);
        // Backlog remains (hit the per-tick cap) — re-arm in 1s instead of
        // waiting the full 30s interval, so a large spool drains over quick
        // BOUNDED ticks rather than one long synchronous stall at boot.
        if (res.pending > 0) {
          const t = setTimeout(runSpoolDrain, 1_000);
          t.unref();
        }
      } catch (err) {
        console.warn(`${ts()} [astramem-local] ingest-spool drain failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    runSpoolDrain(); // boot pass — see AC-8 above
    spoolDrainTimer = setInterval(runSpoolDrain, SPOOL_DRAIN_INTERVAL_MS);
    spoolDrainTimer.unref();
  }

  // WAL discipline (W1.5): with synchronous=NORMAL a hard crash loses the
  // un-checkpointed WAL tail. Checkpoint hourly so the at-risk window stays
  // small, and once more (TRUNCATE, see below) on graceful shutdown. Timer
  // unref'd — never holds the process open.
  //
  // 2026-07-19 event-loop-stall fix: this periodic pass uses PASSIVE, not
  // TRUNCATE — TRUNCATE blocks until it can acquire the exclusive lock
  // needed to shrink the WAL file, which on a live daemon under load is a
  // genuine synchronous stall on the same event loop `/health` depends on
  // (the same restart-storm class the embedAndIndex cooperative-yield fix
  // above addresses). PASSIVE checkpoints as much of the WAL as it can
  // without blocking or invalidating any in-progress reader, and never
  // fails/throws when it can't fully truncate — it just does less this
  // round and tries again next hour. The one-time TRUNCATE at graceful
  // shutdown (below) is intentionally left as-is: shutdown has no live
  // `/health` traffic to protect, so paying for a full blocking truncate
  // there (to minimize the WAL file left on disk) is the right trade.
  if (dataDir !== ':memory:') {
    const WAL_CHECKPOINT_MS = 60 * 60 * 1000;
    walTimer = setInterval(() => {
      try {
        db.pragma("wal_checkpoint(PASSIVE)");
      } catch (err) {
        console.warn(`${ts()} [astramem-local] periodic WAL checkpoint failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, WAL_CHECKPOINT_MS);
    walTimer.unref();
  }

  const shutdown = async () => {
    try {
      stopPreflight?.();
      stopFrequentDoctor?.();
      eventLoopLag.disable();
      if (healthSnapshotTimer) clearInterval(healthSnapshotTimer);
      if (walTimer) clearInterval(walTimer);
      if (bootConsolidateTimer) clearTimeout(bootConsolidateTimer);
      if (consolidateTimer) clearInterval(consolidateTimer);
      governor?.stop();
      if (cleanupTimer) clearInterval(cleanupTimer);
      if (oversizeScanTimer) clearInterval(oversizeScanTimer);
      if (spoolDrainTimer) clearInterval(spoolDrainTimer);
      if (shipper) await shipper.stop();
      if (vecSearchHost) {
        // Deregister BEFORE stopping: the module slot must never reference a
        // terminated host over a closed db (review MEDIUM on 3c9a81f2) — a
        // search racing shutdown takes the inline sync path instead.
        const { setVecSearchOffload } = await import('../vector/vec-search-offload.js');
        setVecSearchOffload(null);
        await vecSearchHost.stop(); // terminate the KNN worker's read-only connection
      }
      if (worker) await worker.stop(); // drain in-flight tick before closing DB
      // ADR-019 Decision 2(d): OnnxWorkerHostProvider owns a live
      // worker_thread once spawned (preload() above, or a lazy first
      // embed()) — terminate it on shutdown so the process can exit cleanly
      // instead of leaving an orphaned OS thread. Duck-typed (mirrors the
      // preload() check above) since ollama/azure-openai providers have no
      // such handle and must not be touched.
      // ORDER MATTERS (review of ab38d7c, MEDIUM): terminate AFTER
      // worker.stop() — a job handler mid-flight may be awaiting an embed()
      // through this provider, and terminating first would force-reject it,
      // turning a graceful drain into a shutdown-induced job failure.
      const terminableEmbed = providers?.embed as (EmbedProvider & { terminate?: () => Promise<void> }) | undefined;
      if (terminableEmbed && typeof terminableEmbed.terminate === 'function') {
        await terminableEmbed.terminate().catch((err: unknown) => {
          console.warn(`${ts()} [astramem-local] onnx worker terminate failed during shutdown: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      try {
        if (dataDir !== ':memory:' && bootRepo) db.pragma("wal_checkpoint(TRUNCATE)");
      } catch { /* close() below still checkpoints on last connection */ }
      if (app) await app.close();
    } finally {
      dbForCrash?.close();
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

/**
 * Open the single boot-time DB connection. Exactly one of the three branches
 * below runs per boot (dataDir === ':memory:' / encryption enabled /
 * plaintext) — this is the ONLY `openDb()` call reached anywhere on the
 * pre-bind critical path (see `bootAndBind`'s doc comment above: `migrate()`
 * and every post-bind consumer — JobRepo, MemoryRepo, SqliteVecStore, the
 * worker's ExtendedHandlerCtx, the health-snapshot refresher — all reuse this
 * SAME handle, never open a second connection). Extracted out of `bootAndBind`
 * (Wave 7 boot-fix investigation) purely so this invariant is directly unit-
 * testable without driving the full `serve()` function, which registers
 * signal handlers ending in `process.exit(0)` and therefore cannot be safely
 * exercised in-process (see tests/doctor/schedule.test.ts's doc comment).
 * Byte-identical behavior to the inline branch it replaced — same pragma
 * order, same key-rewrap error, same plaintext warning.
 */
export function openBootDb(dataDir: string, dbPath: string, cfg: Config): { db: DB; dbKey?: string } {
  if (dataDir === ':memory:') {
    // SEC-1/2/7/9: in-memory databases can never be encrypted (SQLCipher
    // rejects PRAGMA key on :memory:, confirmed by the 1a spike) — the
    // ASTRA_MEMORY_DATADIR=':memory:' test/dev path always stays plaintext
    // and never touches the keystore.
    return { db: openDb(dbPath) };
  } else if (cfg.security.encryption.enabled) {
    const keyResult = getOrCreateKey(defaultConfigDir());
    encryptIfPlaintext(dbPath, keyResult.key);
    try {
      return { db: openDb(dbPath, { key: keyResult.key }), dbKey: keyResult.key };
    } catch (err) {
      throw rewrapWrongKeyError(err, dbPath, keyResult.source);
    }
  } else {
    // SEC-9: disabling encryption is a deliberate trust trade-off — make it loud.
    console.warn(
      `${ts()} [astramem-local] WARNING: encryption at rest is DISABLED (security.encryption.enabled=false). ` +
      `memory.sqlite at ${dbPath} will be stored in PLAINTEXT.`,
    );
    return { db: openDb(dbPath) };
  }
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
