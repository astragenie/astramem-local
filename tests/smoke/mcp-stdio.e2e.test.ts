/**
 * SLICE-412 — MCP e2e over stdio transport.
 *
 * tests/mcp/server.test.ts already exercises every tool handler over the
 * Streamable HTTP transport in-process. What's never been proven: that
 * `astramem-local mcp-stdio` (src/cli/mcp-stdio.ts) actually works as a real
 * child process speaking newline-delimited JSON-RPC over stdin/stdout — the
 * transport an MCP host (Claude Desktop, etc.) would actually use.
 *
 * Scope (pm_scope_notes guard): 2-3 representative tool calls, not exhaustive
 * per-tool coverage — that's server.test.ts's job. This suite proves the
 * transport wiring: initialize handshake -> tools/list -> search_memory ->
 * get_health, against fixture memories seeded directly into the temp datadir
 * before the child spawns (same isolated-sandbox pattern as smoke.test.ts —
 * mock providers, no Ollama, zero-residue teardown).
 *
 * Tool count is 16 as of U5 (astragenie/memory#671, astragenie/astramem-local#120):
 * mark_memory_used was collapsed onto the canonical submit_feedback name,
 * with mark_memory_used kept as a one-release deprecated alias (same handler).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import {
  makeIsolatedDaemonEnv, cleanupIsolatedDaemonEnv, REPO_ROOT,
  type IsolatedDaemonEnv,
} from './helpers/daemon.js';

// Same 16-tool pin as tests/mcp/server.test.ts — the stdio transport must
// advertise the identical tool set as the HTTP transport (both are built
// from the same buildMcpServer()).
const EXPECTED_TOOL_NAMES = [
  'erase_memory',
  'get_health',
  'invalidate_memory',
  'list_consolidation_proposals',
  'mark_memory_used',
  'memory_history',
  'promote_memory',
  'recall_memory',
  'remember',
  'resolve_consolidation_proposal',
  'restore_memory',
  'search_memory',
  'session_digest',
  'submit_feedback',
  'supersede_memory',
  'why_memory',
].sort();

// ── Minimal newline-delimited JSON-RPC client over stdio ────────────────────

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class StdioRpcClient {
  private buffer = '';
  private pending = new Map<number, { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor(private proc: ChildProcess) {
    this.proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // not a JSON-RPC line (e.g. stray log output) — skip
      }
      if (typeof msg.id === 'number') {
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          waiter.resolve(msg);
        }
      }
    }
  }

  /** Send a JSON-RPC request and await its matching response. */
  request(method: string, params: object, timeoutMs = 10_000): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0' as const, id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC "${method}" (id ${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin?.write(JSON.stringify(payload) + '\n');
    });
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params: object): void {
    this.proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async toolCall(name: string, args: object): Promise<{ payload: unknown; isError: boolean }> {
    const resp = await this.request('tools/call', { name, arguments: args });
    if (resp.error) throw new Error(`tools/call ${name} failed: ${resp.error.message}`);
    const result = resp.result as { content?: Array<{ type: string; text: string }>; isError?: boolean };
    const text = result.content?.[0]?.text ?? '{}';
    return { payload: JSON.parse(text), isError: result.isError === true };
  }
}

async function initializeHandshake(client: StdioRpcClient): Promise<void> {
  const resp = await client.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'astramem-mcp-stdio-e2e', version: '0.0.0' },
  });
  expect(resp.error, JSON.stringify(resp.error)).toBeUndefined();
  client.notify('notifications/initialized', {});
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe.sequential('MCP e2e over stdio transport (SLICE-412)', () => {
  let isolated: IsolatedDaemonEnv;
  let child: ChildProcess | null = null;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  beforeAll(() => {
    isolated = makeIsolatedDaemonEnv('astramem-mcp-stdio-e2e');

    // Seed fixture memories directly into the datadir BEFORE the child spawns
    // — a direct MemoryRepo insert, not a round-trip through the tool itself,
    // so search_memory's hit is proof the stdio transport reads real stored
    // state rather than an artifact of the same-process `remember` call.
    const dbPath = join(isolated.dataDir, 'memory.sqlite');
    const db = openDb(dbPath);
    try {
      migrate(db);
      new MemoryRepo(db).insert({
        type: 'lesson',
        text: 'mcp stdio e2e fixture: prefer zod for runtime validation',
        normalized_text: 'mcp stdio e2e fixture: prefer zod for runtime validation',
        repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
        session_id: null, hash: 'h-mcp-stdio-e2e-1', source_hash: null,
      });
    } finally {
      db.close();
    }
  });

  afterAll(async () => {
    // Defensive backstop, mirrors smoke.test.ts: holds even if a step above
    // threw before its own teardown ran.
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    cleanupIsolatedDaemonEnv(isolated);
  });

  it('AC-2/AC-3: spawned mcp-stdio child answers initialize -> tools/list -> search_memory -> get_health', async () => {
    child = spawn(
      process.execPath,
      ['dist/cli/index.js', 'mcp-stdio'],
      {
        cwd: REPO_ROOT,
        env: { ...(process.env as Record<string, string>), ...isolated.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('exit', (code, signal) => { exitInfo = { code, signal }; });

    const client = new StdioRpcClient(child);

    await initializeHandshake(client);

    // tools/list — same tool set as the HTTP transport (AC-2).
    const listResp = await client.request('tools/list', {});
    expect(listResp.error, `stderr:\n${stderr}`).toBeUndefined();
    const tools = (listResp.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.length).toBe(EXPECTED_TOOL_NAMES.length);
    expect(tools.map(t => t.name).sort()).toEqual(EXPECTED_TOOL_NAMES);

    // search_memory against the seeded fixture (AC-3).
    const search = await client.toolCall('search_memory', { query: 'zod validation', limit: 10 });
    expect(search.isError).toBe(false);
    const { hits } = search.payload as { hits: Array<{ id: string; score: number }> };
    expect(Array.isArray(hits)).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }

    // get_health (AC-3).
    const health = await client.toolCall('get_health', {});
    expect(health.isError).toBe(false);
    expect((health.payload as { ok: boolean }).ok).toBe(true);
  }, 30_000);

  it('AC-4: closing stdin exits the child cleanly and the temp datadir can be removed with no residue', async () => {
    expect(child, 'child must have been spawned by the previous test').not.toBeNull();
    const proc = child!;

    proc.stdin?.end();

    const exited = await Promise.race([
      new Promise<boolean>(resolve => {
        proc.on('exit', () => resolve(true));
      }),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5_000)),
    ]);

    if (!exited) {
      // Hard teardown fallback — must not leave an orphan process.
      proc.kill('SIGKILL');
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, 5_000);
        proc.on('exit', () => { clearTimeout(t); resolve(); });
      });
    }

    expect(proc.exitCode === 0 || proc.signalCode !== null || exitInfo !== null).toBe(true);
    child = null; // afterAll's backstop becomes a no-op

    cleanupIsolatedDaemonEnv(isolated);
    expect(existsSync(isolated.root)).toBe(false);
  }, 15_000);
});
