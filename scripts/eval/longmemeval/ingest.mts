/**
 * Ingest driver — POSTs every haystack session for a set of sampled
 * questions to /ingest/transcript, one canonical envelope per session
 * (plan doc section 3.1). Resume-safe: the Idempotency-Key is the
 * (namespaced) session_id itself, so re-running against the same daemon
 * state replays rather than double-ingesting.
 *
 * CLI: bun scripts/eval/longmemeval/ingest.mts --sample <sample.json>
 *        --daemon-url http://127.0.0.1:PORT --token TOKEN
 *        [--concurrency 4] [--out ingest-manifest.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { LongMemEvalQuestion } from './lib/types.js';
import { buildIngestEnvelope, sessionIdFor } from './lib/envelope.js';
import { ingestTranscript, type DaemonClientOpts } from './lib/daemon-client.js';
import { mapWithConcurrency } from './lib/concurrency.js';

export interface IngestJob {
  question_id: string;
  haystack_index: number;
  session_id: string;
}

export interface IngestOutcome {
  question_id: string;
  session_id: string;
  ok: boolean;
  idempotent: boolean;
  error?: string;
}

export interface IngestManifest {
  total_sessions: number;
  ok_count: number;
  failed_count: number;
  ms: number;
  by_question: Record<string, { session_ids: string[]; failed_session_ids: string[] }>;
  outcomes: IngestOutcome[];
}

export async function ingestQuestions(
  client: DaemonClientOpts,
  questions: LongMemEvalQuestion[],
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<IngestManifest> {
  const jobs: IngestJob[] = [];
  for (const q of questions) {
    q.haystack_session_ids.forEach((hsid, idx) => {
      jobs.push({ question_id: q.question_id, haystack_index: idx, session_id: sessionIdFor(q.question_id, hsid) });
    });
  }

  const byQid = new Map(questions.map(q => [q.question_id, q]));
  const start = Date.now();
  let done = 0;

  const outcomes = await mapWithConcurrency(jobs, opts.concurrency ?? 4, async job => {
    const question = byQid.get(job.question_id)!;
    let outcome: IngestOutcome;
    try {
      const envelope = buildIngestEnvelope(question, job.haystack_index);
      const { status, body } = await ingestTranscript(client, envelope, job.session_id);
      if (status !== 200 || !body.ok) {
        outcome = { question_id: job.question_id, session_id: job.session_id, ok: false, idempotent: false, error: `HTTP ${status}: ${body.error ?? JSON.stringify(body)}` };
      } else {
        outcome = { question_id: job.question_id, session_id: job.session_id, ok: true, idempotent: body.idempotent };
      }
    } catch (err) {
      outcome = { question_id: job.question_id, session_id: job.session_id, ok: false, idempotent: false, error: err instanceof Error ? err.message : String(err) };
    }
    done++;
    opts.onProgress?.(done, jobs.length);
    return outcome;
  });

  const byQuestion: IngestManifest['by_question'] = {};
  for (const q of questions) byQuestion[q.question_id] = { session_ids: [], failed_session_ids: [] };
  for (const o of outcomes) {
    const entry = byQuestion[o.question_id]!;
    if (o.ok) entry.session_ids.push(o.session_id);
    else entry.failed_session_ids.push(o.session_id);
  }

  return {
    total_sessions: jobs.length,
    ok_count: outcomes.filter(o => o.ok).length,
    failed_count: outcomes.filter(o => !o.ok).length,
    ms: Date.now() - start,
    by_question: byQuestion,
    outcomes,
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
  const samplePath = get('--sample');
  const daemonUrl = get('--daemon-url');
  const token = get('--token');
  const concurrency = Number(get('--concurrency') ?? '4');
  const outPath = get('--out') ?? 'ingest-manifest.json';

  if (!samplePath || !daemonUrl || !token) {
    console.error('Usage: bun ingest.mts --sample <path> --daemon-url <url> --token <token> [--concurrency 4] [--out <path>]');
    process.exit(1);
  }

  const questions = JSON.parse(readFileSync(samplePath, 'utf8')) as LongMemEvalQuestion[];
  console.log(`Ingesting ${questions.length} questions (${questions.reduce((n, q) => n + q.haystack_session_ids.length, 0)} haystack sessions) at concurrency=${concurrency}...`);

  const manifest = await ingestQuestions(
    { baseUrl: daemonUrl, token },
    questions,
    { concurrency, onProgress: (d, t) => { if (d % 25 === 0 || d === t) process.stdout.write(`\r  ${d}/${t} sessions ingested`); } },
  );
  process.stdout.write('\n');
  writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`Ingest done in ${manifest.ms}ms: ${manifest.ok_count} ok, ${manifest.failed_count} failed. Manifest -> ${outPath}`);
  if (manifest.failed_count > 0) process.exitCode = 1;
}
