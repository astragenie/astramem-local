/**
 * tests/server/provider-health-degraded.test.ts (FEAT-538)
 *
 * End-to-end through the REAL wiring: getProviders() -> buildLLMProvider()
 * -> trackProviderHealth() -> the process-wide registry (src/providers/llm/
 * health-tracking.ts) -> GET /health. `globalThis.fetch` is mocked (the same
 * pattern tests/providers/ollama-llm.test.ts already uses) so the OllamaLLM
 * Provider instance getProviders() actually constructs sees real 401/429/200
 * HTTP responses — nothing about the provider layer itself is faked.
 *
 * A persistently failing provider must flip GET /health.status to
 * 'degraded' with an actionable message, WITHOUT the request path ever
 * probing the provider or the DB directly (AC-2) — and a healthy provider /
 * DB must keep reporting 'ok' (AC-5).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { healthRoute, computeHealthDbSnapshot } from '../../src/server/routes/health.js';
import { createHealthState, type HealthState } from '../../src/server/health-state.js';
import { defaultConfig, type Config } from '../../src/config/config.js';
import { getProviders } from '../../src/providers/index.js';
import { __resetProviderHealthRegistryForTest } from '../../src/providers/llm/health-tracking.js';
import { __resetQuotaBreakersForTest } from '../../src/providers/llm/quota-breaker.js';

/** Mocks globalThis.fetch to return `statuses[]` in sequence (repeating the
 *  last entry once exhausted) — Ollama chat-shaped 200 body on success,
 *  a bare error body on any non-200. Mirrors tests/providers/ollama-llm.test.ts's
 *  mockFetch helper. */
function mockFetchSequence(statuses: number[]): ReturnType<typeof vi.fn> {
  let i = 0;
  const fn = vi.fn(async (): Promise<Response> => {
    const status = statuses[Math.min(i, statuses.length - 1)]!;
    i++;
    if (status === 200) {
      return new Response(
        JSON.stringify({ message: { role: 'assistant', content: '{"atoms":[]}' }, prompt_eval_count: 5, eval_count: 5 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ error: `mock ${status}` }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function ollamaConfig(): Config {
  const cfg = defaultConfig();
  cfg.llm.extraction.provider = 'ollama';
  cfg.llm.extraction.model = 'test-extract-model';
  cfg.llm.compaction.provider = 'ollama';
  cfg.llm.compaction.model = 'test-extract-model'; // same name -> shares the registry entry with extraction
  return cfg;
}

describe('GET /health — provider regression -> degraded (FEAT-538)', () => {
  let db: DB;
  let app: FastifyInstance;
  let healthState: HealthState;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    healthState = createHealthState();
    healthState.ready = true;
    healthState.embed.ok = true; // isolate the provider/poison-rate gates from the embed gate
    originalFetch = globalThis.fetch;
    __resetProviderHealthRegistryForTest();
    // P0-1: buildLLMProvider (src/providers/index.ts) now also wraps every
    // provider in the quota circuit breaker (src/providers/llm/quota-breaker.ts),
    // which this file's real getProviders() wiring exercises too — reset its
    // module-level per-provider-name state the same way the health registry
    // above is reset, or a 3x-429 test earlier in this file trips the
    // breaker for 'ollama' and leaks a permanent ProviderQuotaBreakerOpenError
    // into every later test that reuses that provider name.
    __resetQuotaBreakersForTest();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function buildApp(config: Config): Promise<void> {
    app = Fastify({ logger: false });
    await app.register(healthRoute(config, db, healthState));
    await app.ready();
  }

  it('AC-1: 401 on every call flips status to degraded within N consecutive failures', async () => {
    const cfg = ollamaConfig();
    mockFetchSequence([401, 401, 401, 401, 401]);
    const providers = getProviders(cfg);
    await buildApp(cfg);

    for (let i = 0; i < 2; i++) {
      await expect(providers.llm.extraction.chat([{ role: 'user', content: 'hi' }], { json: true })).rejects.toThrow();
      const body = (await app.inject({ method: 'GET', url: '/health' })).json();
      expect(body.status).toBe('ok'); // not yet at threshold
    }

    await expect(providers.llm.extraction.chat([{ role: 'user', content: 'hi' }], { json: true })).rejects.toThrow(); // 3rd consecutive failure
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.status).toBe('degraded');
    expect(body.provider_health.extraction.status).toBe('down');
    expect(body.provider_health.extraction.reason).toBe('auth');
    expect(body.provider_health.extraction.provider).toBe('ollama');
  });

  it('AC-4: the degraded payload names the failing provider + an actionable remedy, distinguishing 401 from 429', async () => {
    const cfg = ollamaConfig();
    mockFetchSequence([401, 401, 401]);
    const providers = getProviders(cfg);
    await buildApp(cfg);
    for (let i = 0; i < 3; i++) {
      await expect(providers.llm.extraction.chat([{ role: 'user', content: 'hi' }], { json: true })).rejects.toThrow();
    }
    const authBody = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(authBody.provider_health.extraction.message).toContain('ollama');
    expect(authBody.provider_health.extraction.message).toMatch(/credentials|api key/i);

    // Fresh state for the 429 case — quota-flavored wording, distinct from auth.
    __resetProviderHealthRegistryForTest();
    __resetQuotaBreakersForTest();
    healthState = createHealthState();
    healthState.ready = true;
    healthState.embed.ok = true;
    await app.close();
    mockFetchSequence([429, 429, 429]);
    const providers2 = getProviders(cfg);
    await buildApp(cfg);
    for (let i = 0; i < 3; i++) {
      await expect(providers2.llm.extraction.chat([{ role: 'user', content: 'hi' }], { json: true })).rejects.toThrow();
    }
    const quotaBody = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(quotaBody.provider_health.extraction.reason).toBe('quota');
    expect(quotaBody.provider_health.extraction.message).toMatch(/quota|rate limit/i);
    expect(quotaBody.provider_health.extraction.message).not.toEqual(authBody.provider_health.extraction.message);
  });

  it('AC-5: a healthy provider (all successes) still reports ok — no false-degraded', async () => {
    const cfg = ollamaConfig();
    mockFetchSequence([200, 200, 200]);
    const providers = getProviders(cfg);
    await buildApp(cfg);
    await providers.llm.extraction.chat([{ role: 'user', content: 'hi' }], { json: true });
    await providers.llm.extraction.chat([{ role: 'user', content: 'hi' }], { json: true });
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.status).toBe('ok');
    expect(body.provider_health.extraction.status).toBe('up');
  });

  it('AC-5: one transient blip does not flip status (below the consecutive threshold)', async () => {
    const cfg = ollamaConfig();
    // Ollama's own fetchWithRetry retries once on 5xx internally (see
    // ollama.ts), so a single chat()-level failure needs BOTH attempts to
    // come back 503 — one throw, one increment of consecutiveFailures.
    mockFetchSequence([503, 503]);
    const providers = getProviders(cfg);
    await buildApp(cfg);
    await expect(providers.llm.extraction.chat([{ role: 'user', content: 'hi' }], { json: true })).rejects.toThrow();
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.status).toBe('ok');
    expect(body.provider_health.extraction.status).toBe('up');
  });

  it('recovers to ok on the very next success after being down', async () => {
    const cfg = ollamaConfig();
    mockFetchSequence([401, 401, 401, 200]);
    const providers = getProviders(cfg);
    await buildApp(cfg);
    for (let i = 0; i < 3; i++) {
      await expect(providers.llm.extraction.chat([{ role: 'user', content: 'hi' }], { json: true })).rejects.toThrow();
    }
    let body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.status).toBe('degraded');

    await providers.llm.extraction.chat([{ role: 'user', content: 'hi' }], { json: true });
    body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.status).toBe('ok');
    expect(body.provider_health.extraction.status).toBe('up');
  });

  it('AC-3: a rising poison rate (via the cached dbSnapshot) flips status to degraded with count + rate', async () => {
    // Insert enough terminal distill jobs to cross MEANINGFUL_USAGE_THRESHOLD
    // with a poison rate >= POISON_RATE_ALARM (0.25): 25 poison / 25 terminal.
    const insert = db.prepare(`
      INSERT INTO jobs (id, kind, state, payload_json, attempts, created_at, updated_at)
      VALUES (?, 'distill', ?, ?, 3, ?, ?)
    `);
    const now = Date.now();
    for (let i = 0; i < 25; i++) {
      insert.run(`poison-${i}`, 'poison', JSON.stringify({ session_id: `s${i}` }), now, now);
    }
    const cfg = ollamaConfig();
    await buildApp(cfg);

    // Precompute the 30s-cadence snapshot the way serve.ts does.
    healthState.dbSnapshot = computeHealthDbSnapshot(db);
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.status).toBe('degraded');
    expect(body.distill_poison_rate.poison).toBe(25);
    expect(body.distill_poison_rate.terminal).toBe(25);
    expect(body.distill_poison_rate.rate).toBe(1);
    expect(body.distill_poison_rate.alarmed).toBe(true);
  });

  it('AC-2: /health never calls the provider — status reflects only the cached registry entry', async () => {
    const cfg = ollamaConfig();
    const fetchMock = mockFetchSequence([401, 401, 401]);
    const providers = getProviders(cfg);
    await buildApp(cfg);
    for (let i = 0; i < 3; i++) {
      await expect(providers.llm.extraction.chat([{ role: 'user', content: 'hi' }], { json: true })).rejects.toThrow();
    }
    const callsBefore = fetchMock.mock.calls.length;

    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/health' });

    expect(fetchMock.mock.calls.length).toBe(callsBefore); // no additional network calls from /health itself
  });
});
