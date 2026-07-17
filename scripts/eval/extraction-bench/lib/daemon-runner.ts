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
 * llm.compaction is deliberately held constant (DEFAULT_COMPACTION_MODEL,
 * overridable via runOllamaCandidate's `compactionModel` opt / run-bench.mts's
 * --compaction-model flag) across every candidate — only llm.extraction.model
 * varies. This isolates "which model extracts atoms best" as the one variable
 * under test; letting compaction vary too would confound the comparison (a
 * worse compaction pass can starve an otherwise-strong extraction model of
 * signal).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { platform, homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  spawnEvalDaemon, waitForHealthStatus, killDaemon, makeIsolatedEvalEnv, cleanupIsolatedEvalEnv,
  type DaemonHandle,
} from '../../shared/spawn-daemon.js';
import type { GoldFixture } from './fixtures.js';

/** Default compaction model held constant across every extraction candidate
 * (see the module comment above). Named + exported so callers (run-bench.mts's
 * --compaction-model flag) can override it in one place instead of hunting
 * string literals. Tracks `defaultConfig().llm.compaction.model`
 * (src/config/config.ts) — was a bare 'qwen2.5-coder:7b' literal here until
 * the 2026-07-13 qwen3:8b operator standardization swept it to the
 * known-broken model (issue #264): qwen3:8b spills VRAM on 8GB-class
 * hardware and silently poisoned the compaction stage of every bench run
 * that didn't pass --compaction-model explicitly, including the
 * qwen3-live-2026-07-13 result that was (wrongly) cited as evidence
 * qwen3:8b is broken as an *extractor*. Keep this in sync with the config
 * default by hand — there is no shared import between scripts/ and src/
 * config for this constant. */
export const DEFAULT_COMPACTION_MODEL = 'qwen3.5:4b';
const BENCH_PROJECT_ID = 'extraction-bench';

/**
 * Resolve the machine's existing ONNX embed-model cache so the isolated bench
 * daemon can load it OFFLINE — exactly like prod.
 *
 * Since ADR-018 S4 (2026-07-15) `defaultConfig().embedding.provider` is `'onnx'`
 * (in-process ONNX Runtime, not Ollama). This sandbox spawns a daemon with a
 * FRESH dataDir, so its own ONNX cache (`<dataDir>/models/onnx/`) is empty — and
 * transformers.js still HEADs the HF hub on every load (the offline-load bug, see
 * CLAUDE.md / onnx-offline-load-transformers-phones-home), which is blocked on this
 * box, so the embed probe fails and `/health` reports `degraded`. Pointing
 * `onnxEmbed.cacheDir` at the machine's real (prod) cache makes the model load from
 * disk offline, and the daemon boots clean `ok` — the bench now uses ONNX embed
 * going forward, matching production instead of an ad-hoc Ollama embedder.
 *
 * Override the location with `ASTRA_BENCH_ONNX_CACHE`. Returns null when no cache
 * is present, in which case the caller falls back to the degraded-tolerant boot
 * gate (the bench only needs distill stages 1-7, so embed being down is harmless —
 * see runOllamaCandidate). Seed a fresh box with `node dist/cli/index.js model fetch`.
 */
export function resolveOnnxCacheDir(): string | null {
  const override = process.env['ASTRA_BENCH_ONNX_CACHE'];
  if (override) return existsSync(override) ? override : null;
  const dir = platform() === 'win32'
    ? join(process.env['LOCALAPPDATA'] ?? '', 'Astramem', 'models', 'onnx')
    : join(homedir(), '.local', 'share', 'astra-memory', 'models', 'onnx');
  return existsSync(dir) ? dir : null;
}

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
  opts: { perSessionTimeoutMs?: number; runTag?: string; compactionModel?: string } = {},
): Promise<DaemonRunResult> {
  const perSessionTimeoutMs = opts.perSessionTimeoutMs ?? 3 * 60_000;
  const compactionModel = opts.compactionModel ?? DEFAULT_COMPACTION_MODEL;
  const tag = opts.runTag ?? extractionModel.replace(/[^a-z0-9.-]/gi, '_');
  const isolated = makeIsolatedEvalEnv(`extraction-bench-${tag}`);

  // Overwrite the isolated env's config.yaml (which so far only carries
  // security.encryption.enabled: false) to also pin the extraction model.
  // parseConfigYaml (src/config/loader.ts) deep-merges this subset over
  // defaultConfig() — no need to emit every key, only the ones we override.
  // ONNX embed (ADR-018): match prod's in-process ONNX embedder rather than the
  // library-default Ollama path. Points at the machine's real ONNX cache so the
  // model loads offline and the daemon boots clean 'ok'; omitted (embed left at the
  // default provider) only when no cache is present — see resolveOnnxCacheDir.
  const onnxCacheDir = resolveOnnxCacheDir();
  const configYaml = [
    'security:',
    '  encryption:',
    '    enabled: false',
    'llm:',
    '  compaction:',
    '    provider: ollama',
    `    model: '${compactionModel}'`,
    '  extraction:',
    '    provider: ollama',
    `    model: '${extractionModel}'`,
    ...(onnxCacheDir ? [
      'embedding:',
      '  provider: onnx',
      'onnxEmbed:',
      `  cacheDir: '${onnxCacheDir.replace(/\\/g, '/')}'`,
    ] : []),
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
    // Accept 'degraded' as a FALLBACK: with an ONNX cache resolved above the
    // daemon boots clean 'ok', but on a box with no seeded cache the embed probe
    // still fails. This bench exercises distill stages 1-7 only (atom quality is
    // fully decided before stage 8 embed+index — see README), so a daemon degraded
    // solely by that embed-probe (embed unused here) can still extract correctly.
    // Guarded by asserting both LLM providers are up below, so a genuine
    // extraction/compaction outage still fails loudly.
    const status = await waitForHealthStatus(daemon.baseUrl, ['ok', 'degraded'], 90_000);
    if (status === 'degraded') {
      const h = await (await fetch(`${daemon.baseUrl}/health`)).json();
      const ex = h?.provider_health?.extraction?.status;
      const co = h?.provider_health?.compaction?.status;
      if (ex !== 'up' || co !== 'up') {
        throw new Error(`daemon degraded with LLM provider(s) down (extraction=${ex}, compaction=${co}) — extraction would be unreliable, refusing to bench`);
      }
    }
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
