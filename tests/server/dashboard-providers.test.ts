/**
 * tests/server/dashboard-providers.test.ts (FEAT-539)
 *
 * GET /dashboard/providers renders all six pipeline roles (embedding,
 * compaction, extraction, judge, extractionPassB, atomTriage) with their
 * configured provider/model and a live status derived from FEAT-538's
 * shared provider-health registry (getProviderHealthEntry) — never a
 * separate probe. Mutating the registry entry directly (rather than
 * mocking fetch through a real chat() call) mirrors how
 * provider-health-degraded.test.ts exercises the same registry, just at the
 * unit-under-test's own read boundary instead of end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import type { DB } from '../../src/storage/db.js';
import { defaultConfig, type Config } from '../../src/config/config.js';
import { createHealthState, type HealthState } from '../../src/server/health-state.js';
import {
  getProviderHealthEntry,
  __resetProviderHealthRegistryForTest,
} from '../../src/providers/llm/health-tracking.js';

const TOKEN = 'testtoken';
const AUTH = { authorization: `Bearer ${TOKEN}` };

describe('GET /dashboard/providers', () => {
  let db: DB;
  let config: Config;
  let healthState: HealthState;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    config = defaultConfig();
    healthState = createHealthState();
    healthState.ready = true;
    healthState.embed.ok = true;
    __resetProviderHealthRegistryForTest();
  });

  afterEach(() => {
    db.close();
    __resetProviderHealthRegistryForTest();
  });

  it('401 with no Authorization header and no cookie', async () => {
    const app = await buildApp({ db, token: TOKEN, config, healthState });
    const res = await app.inject({ method: 'GET', url: '/dashboard/providers' });
    expect(res.statusCode).toBe(401);
  });

  it('200 with a valid Authorization bearer, HTML content-type', async () => {
    const app = await buildApp({ db, token: TOKEN, config, healthState });
    const res = await app.inject({ method: 'GET', url: '/dashboard/providers', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('renders all 6 roles with their configured provider + model', async () => {
    config.llm.extraction.provider = 'ollama';
    config.llm.extraction.model = 'qwen2.5:7b';
    config.llm.compaction.provider = 'ollama';
    config.llm.compaction.model = 'qwen2.5:7b';
    config.embedding.provider = 'onnx';
    config.embedding.model = 'mxbai-embed-large';

    const app = await buildApp({ db, token: TOKEN, config, healthState });
    const res = await app.inject({ method: 'GET', url: '/dashboard/providers', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.body;

    expect(body).toContain('embedding');
    expect(body).toContain('compaction');
    expect(body).toContain('extraction');
    expect(body).toContain('judge');
    expect(body).toContain('extractionPassB');
    expect(body).toContain('atomTriage');
    expect(body).toContain('onnx/mxbai-embed-large');
    expect(body).toContain('ollama/qwen2.5:7b');
  });

  it('a provider-down state (FEAT-538 registry) shows red status + the actionable remedy for that role', async () => {
    config.llm.extraction.provider = 'ollama';
    const entry = getProviderHealthEntry('ollama');
    entry.status = 'down';
    entry.reason = 'auth';
    entry.message = 'ollama: auth failure (401/403) — check your API key/credentials, or switch provider (config.llm.extraction.provider / config.llm.compaction.provider).';

    const app = await buildApp({ db, token: TOKEN, config, healthState });
    const res = await app.inject({ method: 'GET', url: '/dashboard/providers', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.body;

    expect(body).toContain('dot-down');
    expect(body).toContain('check your API key/credentials');
  });

  it('a healthy provider (registry status up) shows green, not grey or red', async () => {
    config.llm.extraction.provider = 'ollama';
    getProviderHealthEntry('ollama'); // fresh entry defaults to 'up'

    const app = await buildApp({ db, token: TOKEN, config, healthState });
    const res = await app.inject({ method: 'GET', url: '/dashboard/providers', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('dot-up');
  });

  it('judge/extractionPassB/atomTriage with no explicit override render grey "rides extraction", never a false-green independent dot', async () => {
    config.llm.extraction.provider = 'ollama';
    // Extraction itself is healthy — if the riding roles leaked their own
    // green dot, this would be indistinguishable from a real independent
    // status. The regression this guards: the ridden entry is 'up', but the
    // riding rows must still say grey/rides, not green.
    getProviderHealthEntry('ollama');
    config.consolidation.contradictionDetection.provider = undefined;
    config.consolidation.contradictionDetection.mode = 'enabled';
    config.distill.extractionPasses = 1; // extractionPassB inactive
    config.distill.atomTriage.mode = 'off'; // atomTriage disabled
    config.distill.atomTriage.provider = undefined;

    const app = await buildApp({ db, token: TOKEN, config, healthState });
    const res = await app.inject({ method: 'GET', url: '/dashboard/providers', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.body;

    expect(body).toContain('rides extraction');
    expect(body).toMatch(/dot-grey/);
  });

  it('an explicitly overridden judge provider renders its own independent status', async () => {
    config.llm.extraction.provider = 'codex-subscription';
    config.consolidation.contradictionDetection.mode = 'enabled';
    config.consolidation.contradictionDetection.provider = 'ollama';
    config.consolidation.contradictionDetection.model = 'qwen2.5:7b';
    const entry = getProviderHealthEntry('ollama');
    entry.status = 'up';

    const app = await buildApp({ db, token: TOKEN, config, healthState });
    const res = await app.inject({ method: 'GET', url: '/dashboard/providers', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.body;

    // The judge row shows the overridden provider/model, not extraction's.
    expect(body).toContain('ollama/qwen2.5:7b');
  });

  it('the nav includes a Providers link and highlights it as active on this page', async () => {
    const app = await buildApp({ db, token: TOKEN, config, healthState });
    const res = await app.inject({ method: 'GET', url: '/dashboard/providers', headers: AUTH });
    expect(res.body).toContain('Providers');
    expect(res.body).toContain('<span class="active">Providers</span>');
  });

  it('other dashboard pages link to /dashboard/providers via the shared nav', async () => {
    const app = await buildApp({ db, token: TOKEN, config, healthState });
    const res = await app.inject({ method: 'GET', url: '/dashboard/jobs', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="/dashboard/providers"');
  });
});
