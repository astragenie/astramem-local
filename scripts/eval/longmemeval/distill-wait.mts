/**
 * Distill-wait gate (plan doc section 3.2). Polls GET /sessions/:id/digest
 * per ingested session_id until every session for a question reports
 * status: 'ready', or a timeout is hit. A question that times out is a HARD
 * failure for that question (not a silent partial answer) — see plan doc
 * risk #1: racing ahead of distillation would deflate the recall step
 * without any visible error.
 *
 * CLI: bun scripts/eval/longmemeval/distill-wait.mts --manifest <ingest-manifest.json>
 *        --daemon-url <url> --token <token> [--timeout-ms 120000] [--out <path>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { sessionDigest, type DaemonClientOpts } from './lib/daemon-client.js';
import type { IngestManifest } from './ingest.mts';

export interface DistillWaitResult {
  ready_question_ids: string[];
  timed_out_question_ids: string[];
  per_question_ms: Record<string, number>;
}

async function isSessionReady(client: DaemonClientOpts, sessionId: string): Promise<boolean> {
  const digest = await sessionDigest(client, sessionId);
  // A session that never shows up (404) has nothing queued for it (e.g. an
  // ingest that failed before creating the session row) — treat as "not
  // ready", the caller's timeout will surface it rather than silently
  // treating a missing session as done.
  return digest?.status === 'ready';
}

export async function waitForQuestionsDistilled(
  client: DaemonClientOpts,
  byQuestion: IngestManifest['by_question'],
  opts: { timeoutMs?: number; intervalMs?: number; onProgress?: (readyCount: number, total: number) => void } = {},
): Promise<DistillWaitResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const questionIds = Object.keys(byQuestion);
  const perQuestionMs: Record<string, number> = {};
  const ready = new Set<string>();
  const start = Date.now();
  const deadline = start + timeoutMs;

  let pending = new Set(questionIds.filter(qid => byQuestion[qid]!.session_ids.length > 0));

  while (pending.size > 0 && Date.now() < deadline) {
    for (const qid of [...pending]) {
      const sessionIds = byQuestion[qid]!.session_ids;
      const results = await Promise.all(sessionIds.map(sid => isSessionReady(client, sid)));
      if (results.every(Boolean)) {
        ready.add(qid);
        perQuestionMs[qid] = Date.now() - start;
        pending.delete(qid);
      }
    }
    opts.onProgress?.(ready.size, questionIds.length);
    if (pending.size > 0) await sleep(intervalMs);
  }

  return {
    ready_question_ids: [...ready],
    timed_out_question_ids: [...pending],
    per_question_ms: perQuestionMs,
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
  console.log(`Waiting for distill to drain across ${Object.keys(manifest.by_question).length} questions (timeout ${timeoutMs}ms)...`);

  const result = await waitForQuestionsDistilled(
    { baseUrl: daemonUrl, token },
    manifest.by_question,
    { timeoutMs, onProgress: (r, t) => process.stdout.write(`\r  ${r}/${t} questions distilled`) },
  );
  process.stdout.write('\n');
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`Distill-wait done: ${result.ready_question_ids.length} ready, ${result.timed_out_question_ids.length} timed out. Result -> ${outPath}`);
  if (result.timed_out_question_ids.length > 0) {
    console.error(`Timed out questions (hard failures, no answer will be generated): ${result.timed_out_question_ids.join(', ')}`);
    process.exitCode = 1;
  }
}
