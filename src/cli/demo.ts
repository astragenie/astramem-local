/**
 * `astramem-local demo` — a 30-second, zero-dependency trial run.
 *
 * Spins up an isolated, in-memory daemon (no Ollama, no OS config dir, no
 * persisted data — reusing the two isolation flags `resolveRuntimeConfig`
 * already exposes for eval/test isolation: `ASTRA_MEMORY_ISOLATED=1` +
 * `ASTRA_MEMORY_DATADIR=':memory:'`, see src/config/resolve-runtime.ts),
 * seeds a handful of example memories through the same deterministic
 * mock embed/LLM path the test suite uses (`ASTRA_MEMORY_MOCK_PROVIDERS=1`
 * — see src/pipeline/mock-providers.ts), runs one sample recall against
 * them, and then keeps serving in the foreground until Ctrl+C — so a
 * brand-new user can see the product actually work before installing
 * Ollama or running `init`.
 */
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { serve } from './serve.js';
import { resolveBearerToken } from '../storage/bearer-keystore.js';

/** A handful of illustrative memories — deliberately varied types/content so
 *  the sample recall below has something to actually discriminate between. */
export const DEMO_SEED_MEMORIES: ReadonlyArray<{ text: string; type: string }> = [
  { text: 'The user prefers dark mode across all UI themes.', type: 'preference' },
  { text: 'This project targets Node 20 with TypeScript strict mode enabled.', type: 'fact' },
  { text: 'Decision: ship the daemon as a local-first service, no cloud dependency required.', type: 'decision' },
  { text: 'Lesson: always run the embed dimension preflight before accepting traffic.', type: 'lesson' },
  { text: 'TODO: write the onboarding wizard so init is a single command.', type: 'todo' },
];

export const DEMO_SAMPLE_QUESTION = 'What does the user prefer for UI theme?';

/**
 * Ask the OS for a free loopback port and immediately release it. There is
 * an unavoidable TOCTOU race (something else could grab the port between
 * close() and serve()'s own listen()) — acceptable for a throwaway demo
 * daemon that only needs to know its own port up front in order to seed
 * itself over HTTP right after boot.
 */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll /health until it responds (mock providers make this near-instant —
 *  there's no real Ollama probe to wait on) or give up after `timeoutMs`. */
export async function waitForHealth(baseUrl: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(150);
  }
  throw new Error(`demo: daemon did not become healthy within ${timeoutMs}ms${lastErr ? ` (last error: ${String(lastErr)})` : ''}`);
}

export interface DemoHit {
  text: string;
  score: number;
  type?: string;
}

/** POST /remember for every seed memory, logging progress. Non-fatal on a
 *  single failed insert — the demo continues so a user still sees the rest. */
export async function seedDemoMemories(baseUrl: string, headers: Record<string, string>): Promise<void> {
  console.log(`\nseeding ${DEMO_SEED_MEMORIES.length} example memories...`);
  for (const mem of DEMO_SEED_MEMORIES) {
    const res = await fetch(`${baseUrl}/remember`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: mem.text, type: mem.type, metadata: { repo: 'demo', project: 'astramem-demo' } }),
    });
    if (res.ok) {
      console.log(`  + [${mem.type}] ${mem.text}`);
    } else {
      console.warn(`  ! failed to seed (HTTP ${res.status}): ${mem.text}`);
    }
  }
}

/** POST /recall for the sample question and print the hits. Returns the
 *  hits so tests can assert on them without scraping stdout. */
export async function runSampleRecall(baseUrl: string, headers: Record<string, string>): Promise<DemoHit[]> {
  console.log(`\nsample recall: "${DEMO_SAMPLE_QUESTION}"`);
  const res = await fetch(`${baseUrl}/recall`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: DEMO_SAMPLE_QUESTION, limit: 3 }),
  });
  if (!res.ok) {
    console.warn(`  ! recall failed (HTTP ${res.status})`);
    return [];
  }
  const body = (await res.json()) as { hits?: DemoHit[] };
  const hits = body.hits ?? [];
  if (hits.length === 0) {
    console.log('  (no results)');
  } else {
    hits.forEach((h, i) => console.log(`  ${i + 1}. [${h.score.toFixed(3)}] ${h.text}`));
  }
  return hits;
}

export async function demoCommand(_args: string[]): Promise<void> {
  // Both flags already exist for eval/test isolation (resolveRuntimeConfig,
  // ASTRA_MEMORY_MOCK_PROVIDERS) — reused here rather than inventing a third
  // isolation mechanism just for this command.
  process.env.ASTRA_MEMORY_ISOLATED = '1';
  process.env.ASTRA_MEMORY_DATADIR = ':memory:';
  process.env.ASTRA_MEMORY_MOCK_PROVIDERS = '1';

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { token } = resolveBearerToken({ envToken: process.env.ASTRA_MEMORY_TOKEN });
  // Isolated mode issues a FRESH ephemeral token on every resolution
  // (bearer-keystore.ts) — pin ours into env so serve()'s own resolution
  // yields the same token, else every demo client call 401s.
  process.env.ASTRA_MEMORY_TOKEN = token;

  console.log('astramem-local demo — starting an in-memory daemon (no Ollama required)...');
  await serve({ port });
  await waitForHealth(baseUrl);
  console.log(`daemon up at ${baseUrl} (in-memory — nothing persisted to disk)`);

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

  await seedDemoMemories(baseUrl, headers);
  await runSampleRecall(baseUrl, headers);

  console.log(`\nastramem-local demo is running at ${baseUrl} — in-memory only, nothing was written to disk.`);
  console.log('Press Ctrl+C to stop.');
  console.log('\nnext: astramem-local init   (install a real daemon with persistent storage)');
}
