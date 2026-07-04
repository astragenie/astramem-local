/**
 * Wave 4 Track C — Full plugin-flow E2E test.
 *
 * Proves the complete pipeline:
 *   1. Daemon starts (mock provider mode — no Ollama/Azure required).
 *   2. POST /ingest/transcript with fixture content (mirrors what the plugin hook sends).
 *   3. Worker drains the distill job through all 8 pipeline stages (mocked LLM + embed).
 *   4. GET /search returns at least one distilled memory of type 'decision' mentioning 'sqlite-vec'.
 *
 * Live integration modes (skipped by default in CI):
 *   INTEGRATION_LIVE=ollama  — real local Ollama must be running
 *   INTEGRATION_LIVE=azure   — AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT must be set
 *
 * Port: randomised high port (base 18900) to avoid conflicts with other test servers.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  spawnDaemon, killDaemon, waitForHealthReachable, pollSearchHits,
  type DaemonHandle, type SearchHit,
} from '../smoke/helpers/daemon.js';

// ── Config ────────────────────────────────────────────────────────────────────

const TOKEN = 'e2etok-plugin-flow';
// Use a stable port that doesn't collide with ingest-e2e (17778) or serve.test (17900+)
const PORT = 18950;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const INTEGRATION_LIVE = process.env.INTEGRATION_LIVE as 'ollama' | 'azure' | undefined;
const IS_MOCK = !INTEGRATION_LIVE;

const FIXTURE_PATH = join(
  new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  '_fixtures',
  'short-session.txt'
);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function pollSearch(
  query: string,
  expectedType: string,
  expectedTextFragment: string,
  timeoutMs: number = 30_000,
): Promise<SearchHit[]> {
  return pollSearchHits(
    BASE_URL,
    TOKEN,
    query,
    hits => hits.filter(
      h => h.type === expectedType &&
           h.text.toLowerCase().includes(expectedTextFragment.toLowerCase()),
    ),
    {
      timeoutMs,
      label: `GET ${BASE_URL}/search?q=${query} to return a '${expectedType}' memory containing '${expectedTextFragment}'`,
    },
  );
}

// ── Test lifecycle ─────────────────────────────────────────────────────────────

let daemon: DaemonHandle | null = null;

afterAll(async () => {
  if (daemon) await killDaemon(daemon, 'SIGTERM', 3_000);
});

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Plugin flow E2E — ingest → distill → search', () => {

  it.skipIf(INTEGRATION_LIVE === 'azure' && !process.env.AZURE_OPENAI_API_KEY)(
    'full pipeline: mock mode (default CI) — transcript → distillation → searchable memory',
    async () => {
      // Skip if Azure is requested but credentials absent
      if (INTEGRATION_LIVE === 'ollama') {
        console.log('[e2e] INTEGRATION_LIVE=ollama — using real Ollama providers');
      } else if (INTEGRATION_LIVE === 'azure') {
        console.log('[e2e] INTEGRATION_LIVE=azure — using real Azure OpenAI providers');
      } else {
        console.log('[e2e] Mock mode (ASTRA_MEMORY_MOCK_PROVIDERS=1)');
      }

      // ── 1. Spin daemon ──────────────────────────────────────────────────────

      daemon = spawnDaemon({
        port: PORT,
        token: TOKEN,
        env: {
          ASTRA_MEMORY_DATADIR: ':memory:',
          // Mock providers unless a live integration mode is requested
          ...(IS_MOCK ? { ASTRA_MEMORY_MOCK_PROVIDERS: '1' } : {}),
        },
      });

      // Surface daemon stderr for debugging
      daemon.proc.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(`[daemon] ${chunk.toString()}`);
      });

      await waitForHealthReachable(BASE_URL);
      expect(daemon.exitInfo().code, 'daemon should still be running').toBeNull();

      // ── 2. POST fixture transcript (mirrors plugin hook payload) ────────────

      const transcript = readFileSync(FIXTURE_PATH, 'utf8');
      expect(transcript).toContain('sqlite-vec');

      const ingestRes = await fetch(`${BASE_URL}/ingest/transcript`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          session_id: 'e2e-plugin-flow-1',
          source: 'PreCompact',
          content: transcript,
          repo: 'astramemory-local',
          agent: 'claude-code',
        }),
      });

      expect(ingestRes.status, 'ingest should return 200').toBe(200);
      const ingestBody = await ingestRes.json() as { ok: boolean };
      expect(ingestBody.ok).toBe(true);

      // ── 3. Wait for worker to drain the distill job ─────────────────────────
      // Poll /search for up to 30s — live Ollama may be slower than mock.

      // Search for 'sqlite' (not 'sqlite-vec' — FTS5 interprets the hyphen as negation).
      // The distilled memory text contains 'sqlite-vec' so the FTS hit on 'sqlite' will match.
      const hits = await pollSearch('sqlite', 'decision', 'sqlite-vec', 30_000);

      // ── 4. Assert at least one decision memory mentions sqlite-vec ──────────

      expect(hits.length).toBeGreaterThan(0);
      const hit = hits[0];
      expect(hit.type).toBe('decision');
      expect(hit.text.toLowerCase()).toContain('sqlite-vec');
      expect(hit.score).toBeGreaterThan(0);
      expect(['fts', 'vec', 'both']).toContain(hit.source);
    },
    // Allow up to 60s for slow CI or live Ollama
    60_000,
  );

  it('mock providers module exports a valid ProviderSet', async () => {
    const { makeMockProviders } = await import('../../src/pipeline/mock-providers.js');
    const providers = makeMockProviders();

    // LLM providers satisfy the contract
    const compaction = providers.llm.compaction;
    expect(compaction.name).toBe('ollama');
    expect(typeof compaction.chat).toBe('function');

    const extraction = providers.llm.extraction;
    const result = await extraction.chat([
      { role: 'system', content: 'Extract atoms from the following.' },
      { role: 'user', content: 'OK let\'s go with sqlite-vec for v1.' },
    ], { json: true });
    const parsed = JSON.parse(result.text) as { atoms: Array<{ type: string; text: string }> };
    expect(Array.isArray(parsed.atoms)).toBe(true);
    expect(parsed.atoms.length).toBeGreaterThan(0);
    expect(parsed.atoms[0].type).toBe('decision');
    expect(parsed.atoms[0].text.toLowerCase()).toContain('sqlite-vec');

    // Embed provider satisfies the contract
    const embed = providers.embed;
    expect(embed.dim).toBe(1024);
    const vecs = await embed.embed(['use sqlite-vec for v1']);
    expect(vecs.length).toBe(1);
    expect(vecs[0].length).toBe(1024);
    // Same text → same vector (deterministic)
    const vecs2 = await embed.embed(['use sqlite-vec for v1']);
    expect(vecs2[0]).toEqual(vecs[0]);
  });
});
