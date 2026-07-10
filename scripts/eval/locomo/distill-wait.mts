/**
 * Distill-wait gate -- polls GET /sessions/:id/digest per ingested
 * session_id until every session for a conversation reports status:
 * 'ready', or a timeout is hit. A conversation that times out is a HARD
 * failure for every one of its QA pairs (not a silent partial answer) --
 * same reasoning as ../longmemeval/distill-wait.mts: racing ahead of
 * distillation would deflate the answer step without any visible error.
 *
 * CLI: bun scripts/eval/locomo/distill-wait.mts --manifest <ingest-manifest.json>
 *        --daemon-url <url> --token <token> [--timeout-ms 120000] [--out <path>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { sessionDigest, type DaemonClientOpts } from '../shared/daemon-client.js';
import type { IngestManifest } from './ingest.mts';

export interface DistillWaitResult {
  ready_sample_ids: string[];
  timed_out_sample_ids: string[];
  per_sample_ms: Record<string, number>;
}

async function isSessionReady(client: DaemonClientOpts, sessionId: string): Promise<boolean> {
  const digest = await sessionDigest(client, sessionId);
  // A session that never shows up (404) has nothing queued for it (e.g. an
  // ingest that failed before creating the session row) -- treat as "not
  // ready", the caller's timeout will surface it rather than silently
  // treating a missing session as done.
  return digest?.status === 'ready';
}

export async function waitForSamplesDistilled(
  client: DaemonClientOpts,
  bySample: IngestManifest['by_sample'],
  opts: { timeoutMs?: number; intervalMs?: number; onProgress?: (readyCount: number, total: number) => void } = {},
): Promise<DistillWaitResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  // 5s default, sequential polling per sample -- NOT Promise.all across
  // sessions. Mirrors ../longmemeval/distill-wait.mts's fix for the
  // 2026-07-10 Windows ephemeral-port-exhaustion incident (blasting every
  // session concurrently every poll round exhausted TIME_WAIT sockets); the
  // same failure mode applies here since LoCoMo conversations can span
  // dozens of sessions each.
  const intervalMs = opts.intervalMs ?? 5_000;
  const sampleIds = Object.keys(bySample);
  const perSampleMs: Record<string, number> = {};
  const ready = new Set<string>();
  const start = Date.now();
  const deadline = start + timeoutMs;

  let pending = new Set(sampleIds.filter(sid => bySample[sid]!.session_ids.length > 0));

  while (pending.size > 0 && Date.now() < deadline) {
    for (const sid of [...pending]) {
      const sessionIds = bySample[sid]!.session_ids;
      // Sequential with short-circuit, same rationale as LongMemEval's
      // adapter: during distill almost every conversation has an unready
      // session early in its list, so short-circuiting also cuts calls per
      // round substantially.
      let allReady = true;
      for (const sessionId of sessionIds) {
        if (!(await isSessionReady(client, sessionId))) { allReady = false; break; }
      }
      if (allReady) {
        ready.add(sid);
        perSampleMs[sid] = Date.now() - start;
        pending.delete(sid);
      }
    }
    opts.onProgress?.(ready.size, sampleIds.length);
    if (pending.size > 0) await sleep(intervalMs);
  }

  return {
    ready_sample_ids: [...ready],
    timed_out_sample_ids: [...pending],
    per_sample_ms: perSampleMs,
  };
}

// ── CLI entry ────────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const manifestPath = get('--manifest');
  const daemonUrl = get('--daemon-url');
  const token = get('--token');
  const timeoutMs = Number(get('--timeout-ms') ?? '120000');
  const outPath = get('--out') ?? 'distill-wait-result.json';

  if (!manifestPath || !daemonUrl || !token) {
    console.error('Usage: bun distill-wait.mts --manifest <path> --daemon-url <url> --token <token> [--timeout-ms 120000] [--out <path>]');
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as IngestManifest;
  console.log(`Waiting for distill to drain across ${Object.keys(manifest.by_sample).length} conversations (timeout ${timeoutMs}ms)...`);

  const result = await waitForSamplesDistilled(
    { baseUrl: daemonUrl, token },
    manifest.by_sample,
    { timeoutMs, onProgress: (r, t) => process.stdout.write(`\r  ${r}/${t} conversations distilled`) },
  );
  process.stdout.write('\n');
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`Distill-wait done: ${result.ready_sample_ids.length} ready, ${result.timed_out_sample_ids.length} timed out. Result -> ${outPath}`);
  if (result.timed_out_sample_ids.length > 0) {
    console.error(`Timed out conversations (hard failures, no answers will be generated for their QA pairs): ${result.timed_out_sample_ids.join(', ')}`);
    process.exitCode = 1;
  }
}
