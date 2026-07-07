import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import { makeFakeVec } from '../../src/search/search.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../src/storage/db.js';

// ---------------------------------------------------------------------------
// U5 MCP tool-name manifest parity (astramemory-local SLICE-A, astragenie/memory#671).
//
// contracts/manifests/mcp-tools.v1.json is the cross-repo SoT for the MCP
// verb_noun tool-name vocabulary. astramem-local's tsconfig.json scopes
// rootDir to src/, so src/ code cannot import contracts/ (TS6059) — same
// constraint documented in tests/contracts/wire-version-map-parity.test.ts
// and tests/contracts/recall-filter-parity.test.ts. This test reads the
// manifest as plain JSON (readFileSync + JSON.parse, no TS import) and
// cross-checks it against the MCP server's *actually registered* tool names,
// obtained via a real tools/list JSON-RPC call over the Streamable HTTP
// transport (same live-server pattern as tests/mcp/server.test.ts) rather
// than reaching into the McpServer SDK's private internals.
//
// Scope (matches the manifest's own documented scope): name + owner parity
// only. Fails on drift in either direction — a tool registered in
// src/mcp/server.ts with no manifest entry, or a manifest "local"/"both"
// entry with no matching registered tool.
// ---------------------------------------------------------------------------

const MANIFEST_PATH = join(__dirname, '../../contracts/manifests/mcp-tools.v1.json');

interface McpToolManifestEntry {
  name: string;
  owner: 'local' | 'cloud' | 'both';
  description: string;
  status: 'stable' | 'planned' | 'deprecated';
}

interface McpToolManifest {
  version: string;
  tools: McpToolManifestEntry[];
}

function readManifest(): McpToolManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as McpToolManifest;
}

const TOKEN = 'test-mcp-manifest-parity-token';

function buildMockEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'mock',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'mock', dim: 1024 as const }),
  };
}

/** POST a JSON-RPC message to POST /mcp and return the parsed response body. */
async function mcpPost(baseUrl: string, body: object): Promise<unknown> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error(`Empty MCP response (status ${res.status})`);
  for (const line of lines) {
    const src = line.startsWith('data: ') ? line.slice(6) : line;
    try {
      return JSON.parse(src);
    } catch {
      // skip non-JSON lines (SSE framing, stray log output)
    }
  }
  throw new Error(`No parseable JSON in MCP response:\n${text}`);
}

describe('MCP tool-name manifest parity — contracts/manifests/mcp-tools.v1.json vs src/mcp/server.ts', () => {
  let db: DB;
  let app: FastifyInstance;
  let baseUrl: string;
  let registeredToolNames: string[];

  beforeAll(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: TOKEN, embed: buildMockEmbed() });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected server address');
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const resp = (await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
      id: 1,
    })) as { result?: { tools?: Array<{ name: string }> }; error?: unknown };
    expect(resp.error, JSON.stringify(resp.error)).toBeUndefined();
    registeredToolNames = (resp.result?.tools ?? []).map(t => t.name).sort();
  });

  afterAll(async () => {
    await app.close();
  });

  it('manifest is valid JSON with at least one tool entry (sanity)', () => {
    const manifest = readManifest();
    expect(manifest.version).toBe('1');
    expect(manifest.tools.length).toBeGreaterThan(0);
  });

  it('server actually registers at least one tool (sanity — something to cross-check)', () => {
    expect(registeredToolNames.length).toBeGreaterThan(0);
  });

  it('every manifest entry with owner "local" or "both" has a matching registered tool', () => {
    const manifest = readManifest();
    const localOrBoth = manifest.tools
      .filter(t => t.owner === 'local' || t.owner === 'both')
      .map(t => t.name)
      .sort();
    for (const name of localOrBoth) {
      expect(registeredToolNames, `manifest lists "${name}" as local/both but the server does not register it`).toContain(name);
    }
  });

  it('every registered tool has a matching manifest entry', () => {
    const manifest = readManifest();
    const manifestNames = new Set(manifest.tools.map(t => t.name));
    for (const name of registeredToolNames) {
      expect(manifestNames, `server registers "${name}" but contracts/manifests/mcp-tools.v1.json has no entry for it`).toContain(name);
    }
  });

  it('local/both manifest names equal the registered tool set exactly (no drift either direction)', () => {
    const manifest = readManifest();
    const localOrBoth = manifest.tools
      .filter(t => t.owner === 'local' || t.owner === 'both')
      .map(t => t.name)
      .sort();
    expect(localOrBoth).toEqual(registeredToolNames);
  });

  it('every manifest entry has a valid owner and status enum value', () => {
    const manifest = readManifest();
    for (const tool of manifest.tools) {
      expect(['local', 'cloud', 'both'], `invalid owner for "${tool.name}"`).toContain(tool.owner);
      expect(['stable', 'planned', 'deprecated'], `invalid status for "${tool.name}"`).toContain(tool.status);
    }
  });

  it('manifest has no duplicate tool names', () => {
    const manifest = readManifest();
    const names = manifest.tools.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
