/**
 * `astramem-local mcp-stdio` — MCP server over the stdio transport.
 *
 * Everything HTTP/POST-/mcp gets from buildMcpServer() (src/mcp/server.ts),
 * this subcommand gets too — same tool set, same db/embed wiring — just
 * connected to a StdioServerTransport instead of a Fastify route. No daemon
 * lifecycle (no instance lock, no worker, no shipper, no timers): this
 * process is meant to be spawned per-client-session by an MCP host and to
 * exit when that host closes stdin, not to run as a long-lived service.
 *
 * Reuses the same config/datadir resolution and mock-provider opt-in
 * (ASTRA_MEMORY_MOCK_PROVIDERS=1) as `serve` so tests can drive it without
 * Ollama — see tests/smoke/mcp-stdio.e2e.test.ts.
 */

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from '../mcp/server.js';
import { openDb } from '../storage/db.js';
import { migrate } from '../storage/migrate.js';
import { getOrCreateKey } from '../storage/keystore.js';
import { encryptIfPlaintext } from '../storage/migrate-encrypt.js';
import { defaultConfigDir } from '../config/datadir.js';
import { resolveRuntimeConfig } from '../config/resolve-runtime.js';
import { makeMockProviders } from '../pipeline/mock-providers.js';
import type { EmbedProvider } from '../contracts/index.js';

export interface McpStdioOpts {
  dataDir?: string;
}

export async function mcpStdio(opts: McpStdioOpts = {}): Promise<void> {
  const { cfg, dataDir } = resolveRuntimeConfig({ dataDir: opts.dataDir });

  const dbPath = dataDir === ':memory:' ? ':memory:' : join(dataDir, 'memory.sqlite');
  if (dataDir !== ':memory:') mkdirSync(dataDir, { recursive: true });

  // Same encryption-at-rest handling as serve.ts: in-memory never encrypts,
  // otherwise fetch/create the key and transparently migrate a plaintext DB.
  let db: ReturnType<typeof openDb>;
  if (dataDir === ':memory:') {
    db = openDb(dbPath);
  } else if (cfg.security.encryption.enabled) {
    const key = getOrCreateKey(defaultConfigDir()).key;
    encryptIfPlaintext(dbPath, key);
    db = openDb(dbPath, { key });
  } else {
    db = openDb(dbPath);
  }

  migrate(db, cfg.embedding.dim);

  let embed: EmbedProvider;
  if (process.env.ASTRA_MEMORY_MOCK_PROVIDERS === '1') {
    embed = makeMockProviders(cfg.embedding.dim).embed;
  } else {
    const { getProviders } = await import('../providers/index.js');
    embed = getProviders(cfg).embed;
  }

  const server = buildMcpServer({ db, embed, config: cfg });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Exit cleanly when the client closes stdin (EOF) — StdioServerTransport
  // only calls onclose from its own close(), it does not watch stdin 'end'
  // itself, so we drive the shutdown from here.
  process.stdin.on('end', () => {
    void server.close().finally(() => {
      db.close();
      process.exit(0);
    });
  });
}
