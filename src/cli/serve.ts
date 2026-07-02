import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { buildApp } from '../server/app.js';
import { openDb } from '../storage/db.js';
import { migrate } from '../storage/migrate.js';
import { getOrCreateKey, readSyncToken } from '../storage/keystore.js';
import { resolveBearerToken } from '../storage/bearer-keystore.js';
import { startShipper, getOrCreateDeviceId, type ShipperHandle } from '../sync/shipper.js';
import { encryptIfPlaintext } from '../storage/migrate-encrypt.js';
import { defaultConfig } from '../config/config.js';
import { defaultConfigDir } from '../config/datadir.js';
import { migrateLegacyDirsIfPresent } from '../config/migrate-dirs.js';
import { HandlerRegistry } from '../pipeline/registry.js';
import { startWorker, type WorkerHandle } from '../pipeline/worker.js';
import { distillHandler } from '../pipeline/handlers/distill.js';
import { distillEventsHandler } from '../pipeline/handlers/distill-events.js';
import { cleanupHandler } from '../pipeline/handlers/cleanup.js';
import { makeMockProviders, type MockProviderSet } from '../pipeline/mock-providers.js';
import type { ProviderSet } from '../providers/index.js';
import type { ExtendedHandlerCtx } from '../pipeline/handler-ctx-ext.js';
import { MemoryRepo } from '../storage/memories.js';
import { SqliteVecStore } from '../vector/sqlite-vec.js';

export interface ServeOpts {
  port?: number;
  dataDir?: string;
  token?: string;
}

export async function serve(opts: ServeOpts): Promise<void> {
  // Migrate legacy Windows config/data dirs (AstraMemory → Astramem) before
  // any config load. Idempotent: no-op on non-Windows and after first run.
  migrateLegacyDirsIfPresent();

  const cfg = defaultConfig();
  const port = opts.port ?? cfg.port;
  const dataDir = opts.dataDir ?? process.env.ASTRA_MEMORY_DATADIR ?? cfg.dataDir;
  // SEC-10: CLI flag > env var > OS credential store > secrets.env
  // (canonical dir, then legacy dir) > 'devtok' default. A secrets.env-only
  // bearer is opportunistically promoted into the credential store.
  const { token } = resolveBearerToken({
    cliToken: opts.token,
    envToken: process.env.ASTRA_MEMORY_TOKEN,
  });

  const dbPath = dataDir === ':memory:' ? ':memory:' : join(dataDir, 'memory.sqlite');
  if (dataDir !== ':memory:') mkdirSync(dataDir, { recursive: true });

  // SEC-1/2/7/9: in-memory databases can never be encrypted (SQLCipher
  // rejects PRAGMA key on :memory:, confirmed by the 1a spike) — the
  // ASTRA_MEMORY_DATADIR=':memory:' test/dev path always stays plaintext
  // and never touches the keystore.
  let db: ReturnType<typeof openDb>;
  if (dataDir === ':memory:') {
    db = openDb(dbPath);
  } else if (cfg.security.encryption.enabled) {
    const key = getOrCreateKey(defaultConfigDir()).key;
    encryptIfPlaintext(dbPath, key);
    db = openDb(dbPath, { key });
  } else {
    // SEC-9: disabling encryption is a deliberate trust trade-off — make it loud.
    console.warn(
      '[astramem-local] WARNING: encryption at rest is DISABLED (security.encryption.enabled=false). ' +
      `memory.sqlite at ${dbPath} will be stored in PLAINTEXT.`,
    );
    db = openDb(dbPath);
  }
  migrate(db);

  // SEC-9: disabling redaction is a deliberate trust trade-off — make it loud.
  if (!cfg.security.redaction.enabled) {
    console.warn(
      '[astramem-local] WARNING: secret redaction is DISABLED (security.redaction.enabled=false). ' +
      'Transcripts and memories will be persisted WITHOUT stage-0 secret scrubbing.',
    );
  }

  // Resolve providers: mock mode (CI/test) or real providers
  let providers: ProviderSet | MockProviderSet;
  const useMock = process.env.ASTRA_MEMORY_MOCK_PROVIDERS === '1';
  if (useMock) {
    providers = makeMockProviders();
  } else {
    // Real providers from config — only imported when not in mock mode
    const { getProviders } = await import('../providers/index.js');
    providers = getProviders(cfg);

    // Boot-time embed preflight — fail fast before accepting traffic.
    // Calls the same embedProbe used by `astramem-local doctor` to avoid
    // duplicating the dim-assertion logic (doctor/checks.ts checkEmbed).
    const { embedProbe } = await import('../doctor/probes/embed-probe.js');
    const preflightResult = await embedProbe(providers.embed);
    if (!preflightResult.ok) {
      const model = providers.embed.model;
      console.error(`[astramem-local] embed preflight FAILED: ${preflightResult.message}`);
      console.error(`  Model    : ${model}`);
      console.error(`  Fix      : ${preflightResult.fix ?? 'Check embed provider config'}`);
      console.error(`  Install  : ollama pull ${model}`);
      console.error(`  Docs     : https://ollama.com/library/mxbai-embed-large`);
      process.exit(1);
    }
  }

  const app = await buildApp({ db, token, embed: providers.embed, config: cfg });

  // Wire up the worker with extended context so distillation runs
  const registry = new HandlerRegistry();
  registry.register(distillHandler);
  registry.register(distillEventsHandler);
  registry.register(cleanupHandler);

  const extCtx: ExtendedHandlerCtx = {
    db,
    config: cfg,
    providers,
    memoryRepo: new MemoryRepo(db),
    vecStore: new SqliteVecStore(db),
  };

  // startWorker takes HandlerCtx but we pass ExtendedHandlerCtx (structural subtype)
  const worker: WorkerHandle = startWorker({
    pollMs: 500,
    registry,
    db,
    config: cfg,
    ctx: extCtx,
  });

  // Sync shipper (ADR-003): one-way log shipping to the cloud ledger.
  // Requires explicit opt-in + url + workspace + device token; personal
  // atoms never ship regardless (scope filter inside the shipper).
  let shipper: ShipperHandle | null = null;
  if (cfg.sync.enabled && dataDir !== ':memory:') {
    const syncToken = process.env.ASTRA_SYNC_TOKEN ?? readSyncToken();
    if (!cfg.sync.url || !cfg.sync.workspaceId || !syncToken) {
      console.warn(
        '[astramem-local] sync.enabled=true but url/workspaceId/device-token incomplete — shipper NOT started.',
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
      console.log(`astramem-local sync shipper active -> ${cfg.sync.url}`);
    }
  }

  await app.listen({ port, host: '127.0.0.1' });
  console.log(`astramem-local serving on 127.0.0.1:${port}`);

  const shutdown = async () => {
    try {
      if (shipper) await shipper.stop();
      await worker.stop();         // drain in-flight tick before closing DB
      await app.close();
    } finally {
      db.close();
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
