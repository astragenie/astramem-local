import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { buildApp } from '../server/app.js';
import { openDb } from '../storage/db.js';
import { migrate } from '../storage/migrate.js';
import { defaultConfig } from '../config/config.js';

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
  const app = await buildApp({ db, token });

  await app.listen({ port, host: '127.0.0.1' });
  console.log(`astra-memory serving on 127.0.0.1:${port}`);

  const shutdown = async () => {
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
