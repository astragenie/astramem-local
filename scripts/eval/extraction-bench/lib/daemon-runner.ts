/**
 * Daemon-HTTP runner — the primary path for Ollama extraction-model
 * candidates. Spawns a fully isolated daemon (reusing
 * scripts/eval/shared/spawn-daemon.ts — same sandboxed
 * APPDATA/LOCALAPPDATA/HOME/XDG_* + encryption-disabled config.yaml
 * technique that closes the "real sync.json paired to prod tenant" hazard
 * documented there), points its `llm.extraction` at the candidate model via
 * a config.yaml override written into the sandbox BEFORE boot, ingests every
 * gold fixture as its own session through the real POST /ingest/transcript
 * route, and polls GET /sessions/:id/digest until every session reaches
 * 'ready' (success) or 'partial'/timeout (failure) — exercising the exact
 * same redaction -> job-queue -> pipeline -> poison-retry path production
 * traffic goes through, not just the extraction function in isolation.
 *
 * Deliberately does NOT set ASTRA_MEMORY_ISOLATED=1: that flag makes
 * resolveRuntimeConfig() skip loadConfigFromDisk() entirely (defaults only,
 * see src/config/resolve-runtime.ts) — which would silently discard the
 * config.yaml override this runner depends on to swap the extraction model.
 * The APPDATA/HOME sandbox from makeIsolatedEvalEnv already fully isolates
 * from the real OS config dir and its sync.json pairing (the hazard
 * ASTRA_MEMORY_ISOLATED=1 exists to guard against), so it is not needed here.
 *
 * llm.compaction is deliberately held constant at ollama/qwen3:8b
 * (the current production default as of 2026-07-13) across every candidate — only
 * llm.extraction.model varies. This isolates "which model extracts atoms
 * best" as the one variable under test; letting compaction vary too would
 * confound the comparison (a worse compaction pass can starve an otherwise-
 * strong extraction model of signal).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  spawnEvalDaemon, waitForHealthStatus, killDaemon, makeIsolatedEvalEnv, cleanupIsolatedEvalEnv,
  type DaemonHandle,
} from '../../shared/spawn-daemon.js';
import type { GoldFixture } from './fixtures.js';

const COMPACTION_MODEL = 'qwen3:8b';
const BENCH_PROJECT_ID = 'extraction-bench';

export interface DaemonAtom {
  id: string;
  type: string;
  text: string;
}

export interface DaemonFixtureResult {
  fixtureId: string;
  status: 'ready' | 'partial' | 'timeout';
  atoms: DaemonAtom[];
  wallMs: number;
  poisonJobs: number;
}

export interface DaemonRunResult {
  model: string;
  results: DaemonFixtureResult[];
  daemonBootMs: number;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

interface DigestBody {
  status: 'pending' | 'ready' | 'partial';
  poison_jobs: number;
  memories: Array<{ id: string; type: string; text: string }>;
}

async function fetchDigest(baseUrl: string, token: string, sessionId: string): Promise<DigestBody | null> {
  const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/digest`, { headers: authHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /sessions/${sessionId}/digest failed: HTTP ${res.status}`);
  return (await res.json()) as DigestBody;
}

/**
 * Run every fixture against one Ollama extraction-model candidate. Spawns
 * and tears down its own isolated daemon — callers run candidates
 * sequentially (not in parallel) so each gets Ollama's full local resources
 * and daemon boot/shutdown never races another candidate's.
 */
export async function runOllamaCandidate(
  extractionModel: string,
  fixtures: GoldFixture[],
  opts: { perSessionTimeoutMs?: number; runTag?: string } = {},
): Promise<DaemonRunResult> {
  const perSessionTimeoutMs = opts.perSessionTimeoutMs ?? 3 * 60_000;
  const tag = opts.runTag ?? extractionModel.replace(/[^a-z0-9.-]/gi, '_');
  const isolated = makeIsolatedEvalEnv(`extraction-bench-${tag}`);

  // Overwrite the isolated env's config.yaml (which so far only carries
  // security.encryption.enabled: false) to also pin the extraction model.
  // parseConfigYaml (src/config/loader.ts) deep-merges this subset over
  // defaultConfig() — no need to emit every key, only the ones we override.
  const configYaml = [
    'security:',
    '  encryption:',
    '    enabled: false',
    'llm:',
    '  compaction:',
    '    provider: ollama',
    `    model: '${COMPACTION_MODEL}'`,
    '  extraction:',
    '    provider: ollama',
    `    model: '${extractionModel}'`,
    'budget:',
    '  daily_usd: 50',
    '',
  ].join('\n');
  writeFileSync(join(isolated.configDir, 'config.yaml'), configYaml, 'utf8');

  const dataDir = join(isolated.root, 'datadir');
  mkdirSync(dataDir, { recursive: true });
  const token = randomBytes(32).toString('hex');

  let daemon: DaemonHandle | undefined;
  const results: DaemonFixtureResult[] = [];
  let daemonBootMs = 0;

  try {
    let t = Date.now();
    daemon = await spawnEvalDaemon({ dataDir, token, env: isolated.env });
    await waitForHealthStatus(daemon.baseUrl, ['ok'], 90_000);
    daemonBootMs = Date.now() - t;

    for (const fixture of fixtures) {
      const sessionId = `bench-${tag}-${fixture.id}`;
      const t0 = Date.now();

      const envelope = {
        event: 'session_end' as const,
        session_id: sessionId,
        project_id: BENCH_PROJECT_ID,
        agent_type: 'extraction-bench',
        captured_at: new Date().toISOString(),
        turns: fixture.turns,
        client_scrub_applied: false,
        client_scrub_hits: 0,
        client_version: 'extraction-bench/0.1',
        client_scrub_version: 'none',
        wire_version: 'v1.0',
      };

      const ingestRes = await fetch(`${daemon.baseUrl}/ingest/transcript`, {
        method: 'POST',
        headers: { ...authHeaders(token), 'idempotency-key': randomUUID() },
        body: JSON.stringify(envelope),
      });
      if (!ingestRes.ok) {
        throw new Error(`ingest failed for ${fixture.id}: HTTP ${ingestRes.status} — ${await ingestRes.text()}`);
      }

      // Poll digest until ready/partial or per-session timeout.
      const deadline = Date.now() + perSessionTimeoutMs;
      let final: DigestBody | null = null;
      while (Date.now() < deadline) {
        const digest = await fetchDigest(daemon.baseUrl, token, sessionId);
        if (digest && (digest.status === 'ready' || digest.status === 'partial')) {
          final = digest;
          break;
        }
        await sleep(750);
      }

      if (!final) {
        results.push({ fixtureId: fixture.id, status: 'timeout', atoms: [], wallMs: Date.now() - t0, poisonJobs: 0 });
      } else {
        results.push({
          fixtureId: fixture.id,
          status: final.status === 'ready' ? 'ready' : 'partial',
          atoms: final.memories,
          wallMs: Date.now() - t0,
          poisonJobs: final.poison_jobs,
        });
      }
    }
  } finally {
    if (daemon) await killDaemon(daemon, 'SIGTERM', 5_000);
    cleanupIsolatedEvalEnv(isolated);
  }

  return { model: extractionModel, results, daemonBootMs };
}
