/**
 * FEAT-4a Phase 2 Stage 5 — Integration E2E tests for the daemon.
 *
 * Spawns the built CLI (`dist/cli/index.js serve --port <port>`) once for the
 * entire suite, hits it over real HTTP, and tears it down via SIGTERM.
 *
 * Prerequisites: `npm run build` must have been run before `npm test`.
 * The test suite will fail immediately with a clear message if the dist is
 * missing or the daemon does not come up within 5 s.
 *
 * Port: devops#69 — OS-assigned ephemeral (`--port 0`), resolved from the
 * daemon's boot log after spawn via waitForBoundPort(). A fixed port (this
 * file previously pinned 19100) collides with the shared self-hosted runner
 * VM's persistent TEI container on :8080 and with neighbor CI jobs' own
 * spawned daemons — the fingerprint being a whole-daemon 401 from a token
 * this test never set, while public /health still passes.
 *
 * Auth: ASTRA_MEMORY_TOKEN=<unique per run> (see TOKEN below)
 * DB:   :memory: (via ASTRA_MEMORY_DATADIR=:memory:)
 * Providers: mock (ASTRA_MEMORY_MOCK_PROVIDERS=1)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { waitForBoundPort } from '../smoke/helpers/daemon.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// devops#69: placeholders, overwritten with the REAL bound port once
// beforeAll spawns the daemon with `--port 0` and resolves it below.
let PORT = 0;
let BASE_URL = '';
// Unique per test run so an accidental cross-connect across concurrent jobs
// on the shared runner fails closed (401) instead of silently succeeding
// against a neighbor's daemon that happens to share a hardcoded literal token.
const TOKEN = `e2etok-${randomUUID()}`;

/** Path to the built CLI entry point, relative to the worktree root. */
const CLI_PATH = join(
  new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  '..', '..', 'dist', 'cli', 'index.js'
);

// ---------------------------------------------------------------------------
// Daemon lifecycle (shared across all cases)
// ---------------------------------------------------------------------------

let daemon: ChildProcess | null = null;
let daemonStdout = '';
let daemonStderr = '';
let daemonExitCode: number | null = null;
let daemonExitSignal: NodeJS.Signals | null = null;

/**
 * Poll /health with exponential-ish back-off.
 * Throws a diagnostic error if the daemon doesn't respond within maxMs.
 *
 * Default budget: 18_000ms (call site below passes 20_000ms explicitly,
 * inside a beforeAll hook whose own vitest hookTimeout is 25_000ms — 5s of
 * margin for spawn/setup overhead ahead of the poll). The previous default
 * of 5_000ms (called with no override) silently wasted 15s of already-
 * declared headroom and caused an
 * intermittent CI flake: `bunx vitest run` (no file filter) schedules every
 * spawned-daemon suite (e2e/plugin-flow, smoke/*, integration/embed-dim-e2e,
 * this file) across the worker pool, and concurrent `spawn()` + port-bind
 * under that CPU/process contention occasionally exceeds 5s even though the
 * daemon itself boots fine — reproduced locally: full-suite run failed here
 * with "did not respond to /health within 5000ms" while every other
 * spawned-daemon test (tests/cli/serve.test.ts: 25_000ms poll / 30_000ms
 * hook; tests/smoke/helpers/daemon.ts pollUntil: 8_000-30_000ms) already
 * budgets far more headroom for exactly this contention. This is a harness
 * budget mismatch, not a product race — port 19100 is not shared with any
 * other suite (verified) and the daemon's boot sequence itself is
 * synchronous with no distill-timing dependency at this stage.
 */
async function waitForHealth(maxMs = 18_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise<void>(r => setTimeout(r, 200));
  }
  throw new Error(
    `Daemon at ${BASE_URL} did not respond to /health within ${maxMs}ms.\n` +
    `Last error: ${last}\n` +
    `stdout:\n${daemonStdout}\n` +
    `stderr:\n${daemonStderr}`
  );
}

beforeAll(async () => {
  // Guard: tell the developer what went wrong if the build is missing.
  if (!existsSync(CLI_PATH)) {
    throw new Error(
      `dist/cli/index.js not found at ${CLI_PATH}.\n` +
      `Run \`npm run build\` before running integration tests.`
    );
  }

  daemon = spawn(
    process.execPath,
    ['dist/cli/index.js', 'serve', '--port', '0'],
    {
      env: {
        ...process.env as Record<string, string>,
        ASTRA_MEMORY_DATADIR: ':memory:',
        ASTRA_MEMORY_TOKEN: TOKEN,
        ASTRA_MEMORY_MOCK_PROVIDERS: '1',
      },
      // cwd must be the worktree root so that relative dist/ path resolves
      cwd: join(CLI_PATH, '..', '..', '..'),
      stdio: 'pipe',
    }
  );

  daemon.stdout?.on('data', (chunk: Buffer) => { daemonStdout += chunk.toString(); });
  daemon.stderr?.on('data', (chunk: Buffer) => { daemonStderr += chunk.toString(); });
  daemon.on('exit', (code, signal) => {
    daemonExitCode = code;
    daemonExitSignal = signal as NodeJS.Signals | null;
  });
  daemon.on('error', err => {
    daemonStderr += `\n[spawn error] ${(err as Error).message}`;
  });

  // devops#69: resolve the REAL OS-assigned port from the boot log before
  // polling /health — `--port 0` means BASE_URL isn't known until now.
  PORT = await waitForBoundPort(
    () => daemonStdout,
    () => daemonStderr,
    () => ({ code: daemonExitCode, signal: daemonExitSignal }),
  );
  BASE_URL = `http://127.0.0.1:${PORT}`;

  await waitForHealth(20_000);
}, 25_000);

afterAll(async () => {
  if (daemon && !daemon.killed && daemonExitCode === null && daemonExitSignal === null) {
    daemon.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const guard = setTimeout(resolve, 4_000);
      daemon!.on('exit', () => { clearTimeout(guard); resolve(); });
    });
  }
  // On Windows, Node processes killed with SIGTERM show code=null / signal='SIGTERM'
  // because the OS handles the signal before process.exit(0) runs. Accept both.
  const cleanExit =
    daemonExitCode === 0 ||
    daemonExitSignal === 'SIGTERM';
  expect(cleanExit, `daemon should exit cleanly (code=${daemonExitCode} signal=${daemonExitSignal})`).toBe(true);
}, 10_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH = {
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
} as const;

/** Minimal valid canonical envelope. Session IDs are unique per case to avoid cross-test interference. */
function makeCanonical(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'pre_compact',
    session_id: sessionId,
    project_id: 'proj-e2e',
    captured_at: '2025-06-30T10:00:00.000Z',
    turns: [
      { role: 'user', text: 'build a search index' },
      { role: 'assistant', text: 'done, files created' },
    ],
    client_scrub_applied: true,
    client_scrub_hits: 0,
    client_version: '0.6.0',
    client_scrub_version: '1.2.0',
    wire_version: 'v1.0',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// GET /health over HTTP
// ---------------------------------------------------------------------------

describe('GET /health over real HTTP', () => {
  // U6 (#106): wire_versions_supported was REPURPOSED from the legacy flat
  // v0.0/v1.0 envelope-negotiation list to the un-prefixed domain@gen
  // wire-contract vocabulary; contract_schema_version rides alongside it.
  it('returns 200 with ok=true and the domain@gen wire_versions_supported + contract_schema_version', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      wire_versions_supported: string[];
      contract_schema_version: string;
      schema_version: number;
    };
    expect(body.ok).toBe(true);
    expect(new Set(body.wire_versions_supported)).toEqual(
      new Set(['atom@1', 'atom@2', 'retrieval@1', 'sync@1', 'capture@1']),
    );
    expect(body.contract_schema_version).toBe('1');
    expect(body.schema_version).toBe(31);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// GET /version over HTTP
// ---------------------------------------------------------------------------

describe('GET /version over real HTTP', () => {
  it('returns 200 with the documented shape and the domain@gen wire_versions_supported + contract_schema_version', async () => {
    const res = await fetch(`${BASE_URL}/version`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      name: string;
      version: string;
      wire_versions_supported: string[];
      contract_schema_version: string;
      schema_version: number;
      ts: number;
    };
    expect(body.name).toBe('astramemory-local');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(new Set(body.wire_versions_supported)).toEqual(
      new Set(['atom@1', 'atom@2', 'retrieval@1', 'sync@1', 'capture@1']),
    );
    expect(body.contract_schema_version).toBe('1');
    expect(body.schema_version).toBe(31);
    expect(typeof body.ts).toBe('number');
  }, 20_000);

  it('does not require Bearer auth — no Authorization header → 200', async () => {
    const res = await fetch(`${BASE_URL}/version`);
    expect(res.status).toBe(200);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// POST /ingest/transcript — canonical happy path
// ---------------------------------------------------------------------------

describe('POST /ingest/transcript — canonical envelope (happy path)', () => {
  it('returns 200 with summary_memory_id and session_id', async () => {
    const payload = makeCanonical('e2e-canonical-happy-1');
    const res = await fetch(`${BASE_URL}/ingest/transcript`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      summary_memory_id: string;
      session_id: string;
      idempotent: boolean;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.summary_memory_id).toBe('string');
    expect(body.summary_memory_id.length).toBeGreaterThan(0);
    expect(body.session_id).toBe('e2e-canonical-happy-1');
    expect(body.idempotent).toBe(false);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// POST /ingest/transcript — legacy envelope (regression guard)
// ---------------------------------------------------------------------------

describe('POST /ingest/transcript — legacy envelope (regression guard)', () => {
  it('POST {session_id, source, content} → 200', async () => {
    const payload = {
      session_id: 'e2e-legacy-happy-1',
      source: 'PreCompact',
      content: 'user: build sqlite-vec adapter\nassistant: ok, file created',
      repo: 'astramemory-local',
      agent: 'claude-code',
    };
    const res = await fetch(`${BASE_URL}/ingest/transcript`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Validation error cases
// ---------------------------------------------------------------------------

describe('POST /ingest/transcript — validation errors', () => {
  it('canonical payload missing wire_version → 400', async () => {
    const { wire_version: _omit, ...payloadWithout } = makeCanonical('e2e-no-wire-version') as Record<string, unknown>;
    const res = await fetch(`${BASE_URL}/ingest/transcript`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(payloadWithout),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid');
  }, 20_000);

  it('canonical payload with wire_version "1.0" (missing v prefix) → 400', async () => {
    const payload = makeCanonical('e2e-bad-wire-version-1', { wire_version: '1.0' });
    const res = await fetch(`${BASE_URL}/ingest/transcript`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid');
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Idempotency over HTTP
// ---------------------------------------------------------------------------

describe('POST /ingest/transcript — idempotency over HTTP', () => {
  /**
   * Use a session_id distinct from conflict test to avoid row pollution across
   * the two cases (they share the same spawned server and in-memory DB).
   */
  const REPLAY_SESSION = 'e2e-idem-replay-1';
  const REPLAY_KEY = 'e2e-idem-key-replay-1';
  const CONFLICT_SESSION = 'e2e-idem-conflict-1';
  const CONFLICT_KEY = 'e2e-idem-key-conflict-1';

  it('same Idempotency-Key + same body — second response has idempotent: true, same summary_memory_id', async () => {
    const payload = makeCanonical(REPLAY_SESSION);
    const headers = { ...AUTH, 'idempotency-key': REPLAY_KEY };

    // First request
    const res1 = await fetch(`${BASE_URL}/ingest/transcript`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as {
      ok: boolean;
      summary_memory_id: string;
      session_id: string;
      idempotent: boolean;
    };
    expect(body1.idempotent).toBe(false);
    const firstId = body1.summary_memory_id;

    // Second request — same key, same body
    const res2 = await fetch(`${BASE_URL}/ingest/transcript`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as {
      ok: boolean;
      summary_memory_id: string;
      session_id: string;
      idempotent: boolean;
    };
    expect(body2.idempotent).toBe(true);
    expect(body2.summary_memory_id).toBe(firstId);
    expect(body2.session_id).toBe(REPLAY_SESSION);
  }, 20_000);

  it('same Idempotency-Key + different body → 409 idempotency_conflict', async () => {
    const firstPayload = makeCanonical(CONFLICT_SESSION);
    const headers = { ...AUTH, 'idempotency-key': CONFLICT_KEY };

    // First request — establishes the key
    const res1 = await fetch(`${BASE_URL}/ingest/transcript`, {
      method: 'POST',
      headers,
      body: JSON.stringify(firstPayload),
    });
    expect(res1.status).toBe(200);

    // Second request — same key, different turns content
    const conflictPayload = makeCanonical(CONFLICT_SESSION, {
      turns: [{ role: 'user', text: 'completely different content that changes the body hash' }],
    });
    const res2 = await fetch(`${BASE_URL}/ingest/transcript`, {
      method: 'POST',
      headers,
      body: JSON.stringify(conflictPayload),
    });
    expect(res2.status).toBe(409);
    const body2 = await res2.json() as {
      error: string;
      idempotency_key: string;
      detail: string;
    };
    expect(body2.error).toBe('idempotency_conflict');
    expect(body2.idempotency_key).toBe(CONFLICT_KEY);
    expect(typeof body2.detail).toBe('string');
  }, 20_000);
});
