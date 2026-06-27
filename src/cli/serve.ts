import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { buildApp } from '../server/app.js';
import { openDb } from '../storage/db.js';
import { migrate } from '../storage/migrate.js';
import { defaultConfig } from '../config/config.js';
import { HandlerRegistry } from '../pipeline/registry.js';
import { startWorker, type WorkerHandle } from '../pipeline/worker.js';
import { distillHandler } from '../pipeline/handlers/distill.js';
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
  const cfg = defaultConfig();
  const port = opts.port ?? cfg.port;
  const dataDir = opts.dataDir ?? process.env.ASTRA_MEMORY_DATADIR ?? cfg.dataDir;
  const token = opts.token ?? process.env.ASTRA_MEMORY_TOKEN ?? 'devtok';

  const dbPath = dataDir === ':memory:' ? ':memory:' : join(dataDir, 'memory.sqlite');
  if (dataDir !== ':memory:') mkdirSync(dataDir, { recursive: true });

  const db = openDb(dbPath);
  migrate(db);

  // Resolve providers: mock mode (CI/test) or real providers
  let providers: ProviderSet | MockProviderSet;
  const useMock = process.env.ASTRA_MEMORY_MOCK_PROVIDERS === '1';
  if (useMock) {
    providers = makeMockProviders();
  } else {
    // Real providers from config — only imported when not in mock mode
    const { getProviders } = await import('../providers/index.js');
    providers = getProviders(cfg);
  }

  const app = await buildApp({ db, token, embed: providers.embed });

  // Wire up the worker with extended context so distillation runs
  const registry = new HandlerRegistry();
  registry.register(distillHandler);
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

  await app.listen({ port, host: '127.0.0.1' });
  console.log(`astra-memory serving on 127.0.0.1:${port}`);

  const shutdown = async () => {
    try {
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
