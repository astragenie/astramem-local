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
 * Port: 19100 — distinct from:
 *   - 17777 (cli/serve.test.ts)
 *   - 17778 (the old stub in this file before Stage 5)
 *   - 18950 (e2e/plugin-flow.test.ts)
 *
 * Auth: ASTRA_MEMORY_TOKEN=e2etok
 * DB:   :memory: (via ASTRA_MEMORY_DATADIR=:memory:)
 * Providers: mock (ASTRA_MEMORY_MOCK_PROVIDERS=1)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORT = 19100;
const TOKEN = 'e2etok';
const BASE_URL = `http://127.0.0.1:${PORT}`;

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
 */
async function waitForHealth(maxMs = 5_000): Promise<void> {
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
    ['dist/cli/index.js', 'serve', '--port', String(PORT)],
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

  await waitForHealth(5_000);
}, 20_000);

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
  it('returns 200 with ok=true and wire_versions_supported', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      wire_versions_supported: string[];
      schema_version: number;
    };
    expect(body.ok).toBe(true);
    expect(body.wire_versions_supported).toContain('v0.0');
    expect(body.wire_versions_supported).toContain('v1.0');
    expect(body.schema_version).toBe(7);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// GET /version over HTTP
// ---------------------------------------------------------------------------

describe('GET /version over real HTTP', () => {
  it('returns 200 with the documented shape and wire_versions_supported', async () => {
    const res = await fetch(`${BASE_URL}/version`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      name: string;
      version: string;
      wire_versions_supported: string[];
      schema_version: number;
      ts: number;
    };
    expect(body.name).toBe('astramemory-local');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.wire_versions_supported).toContain('v0.0');
    expect(body.wire_versions_supported).toContain('v1.0');
    expect(body.schema_version).toBe(7);
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
