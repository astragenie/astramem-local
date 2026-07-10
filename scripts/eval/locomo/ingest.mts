/**
 * Ingest driver -- POSTs every session of every sampled LoCoMo conversation
 * to /ingest/transcript, one canonical envelope per session. Conversation-
 * centric (FEAT-457): unlike LongMemEval's per-question isolated haystack
 * (../longmemeval/ingest.mts), here one conversation's sessions are ingested
 * ONCE and its `by_sample` manifest entry is fanned out against by every one
 * of that conversation's QA pairs later in answer.mts. Resume-safe the same
 * way: the Idempotency-Key is the (namespaced) session_id itself.
 *
 * CLI: bun scripts/eval/locomo/ingest.mts --sample <sample.json>
 *        --daemon-url http://127.0.0.1:PORT --token TOKEN
 *        [--concurrency 4] [--out ingest-manifest.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { LoCoMoSample } from './lib/types.js';
import { sessionNumbers } from './lib/types.js';
import { buildIngestEnvelope, sessionIdFor } from './lib/envelope.js';
import { ingestTranscript, type DaemonClientOpts } from '../shared/daemon-client.js';
import { mapWithConcurrency } from '../shared/concurrency.js';
import { appendLedgerEntry, type LedgerEntry } from '../shared/resume-ledger.js';

export interface IngestJob {
  sample_id: string;
  session_number: number;
  session_id: string;
}

export interface IngestOutcome {
  sample_id: string;
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
  by_sample: Record<string, { session_ids: string[]; failed_session_ids: string[] }>;
  outcomes: IngestOutcome[];
}

export async function ingestConversations(
  client: DaemonClientOpts,
  samples: LoCoMoSample[],
  opts: {
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
    /** See ../longmemeval/ingest.mts's ingestQuestions for the full doc
     *  comment — identical contract (FEAT-462 AC-6): crash-safe ledger
     *  path, appended per-job as it completes. Omitted: behavior is
     *  byte-identical to before this option existed (AC-7). */
    ledgerPath?: string;
    /** session_id -> prior ledger entry; sessions whose latest entry has
     *  `ok: true` are replayed instead of re-POSTed. Only passed by
     *  run.mts when --resume is given. */
    resumeCompleted?: Map<string, LedgerEntry>;
  } = {},
): Promise<IngestManifest> {
  const jobs: IngestJob[] = [];
  for (const sample of samples) {
    for (const sessionNumber of sessionNumbers(sample.conversation)) {
      jobs.push({ sample_id: sample.sample_id, session_number: sessionNumber, session_id: sessionIdFor(sample.sample_id, sessionNumber) });
    }
  }

  const bySampleId = new Map(samples.map(s => [s.sample_id, s]));
  const start = Date.now();
  let done = 0;

  const toRun: IngestJob[] = [];
  const replayedOutcomes: IngestOutcome[] = [];
  for (const job of jobs) {
    const prior = opts.resumeCompleted?.get(job.session_id);
    if (prior?.ok) {
      replayedOutcomes.push({ sample_id: job.sample_id, session_id: job.session_id, ok: true, idempotent: prior.idempotent });
      done++;
    } else {
      toRun.push(job);
    }
  }
  if (replayedOutcomes.length > 0) opts.onProgress?.(done, jobs.length);

  const freshOutcomes = await mapWithConcurrency(toRun, opts.concurrency ?? 4, async job => {
    const sample = bySampleId.get(job.sample_id)!;
    let outcome: IngestOutcome;
    try {
      const envelope = buildIngestEnvelope(sample, job.session_number);
      const { status, body } = await ingestTranscript(client, envelope, job.session_id);
      if (status !== 200 || !body.ok) {
        outcome = { sample_id: job.sample_id, session_id: job.session_id, ok: false, idempotent: false, error: `HTTP ${status}: ${body.error ?? JSON.stringify(body)}` };
      } else {
        outcome = { sample_id: job.sample_id, session_id: job.session_id, ok: true, idempotent: body.idempotent };
      }
    } catch (err) {
      outcome = { sample_id: job.sample_id, session_id: job.session_id, ok: false, idempotent: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (opts.ledgerPath) {
      appendLedgerEntry(opts.ledgerPath, {
        session_id: outcome.session_id,
        owner_id: outcome.sample_id,
        ok: outcome.ok,
        idempotent: outcome.idempotent,
        error: outcome.error,
        ts: new Date().toISOString(),
      });
    }
    done++;
    opts.onProgress?.(done, jobs.length);
    return outcome;
  });

  const outcomes = [...replayedOutcomes, ...freshOutcomes];

  const bySample: IngestManifest['by_sample'] = {};
  for (const s of samples) bySample[s.sample_id] = { session_ids: [], failed_session_ids: [] };
  for (const o of outcomes) {
    const entry = bySample[o.sample_id]!;
    if (o.ok) entry.session_ids.push(o.session_id);
    else entry.failed_session_ids.push(o.session_id);
  }

  return {
    total_sessions: jobs.length,
    ok_count: outcomes.filter(o => o.ok).length,
    failed_count: outcomes.filter(o => !o.ok).length,
    ms: Date.now() - start,
    by_sample: bySample,
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

  const samples = JSON.parse(readFileSync(samplePath, 'utf8')) as LoCoMoSample[];
  const totalSessions = samples.reduce((n, s) => n + sessionNumbers(s.conversation).length, 0);
  console.log(`Ingesting ${samples.length} conversations (${totalSessions} sessions) at concurrency=${concurrency}...`);

  const manifest = await ingestConversations(
    { baseUrl: daemonUrl, token },
    samples,
    { concurrency, onProgress: (d, t) => { if (d % 25 === 0 || d === t) process.stdout.write(`\r  ${d}/${t} sessions ingested`); } },
  );
  process.stdout.write('\n');
  writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`Ingest done in ${manifest.ms}ms: ${manifest.ok_count} ok, ${manifest.failed_count} failed. Manifest -> ${outPath}`);
  if (manifest.failed_count > 0) process.exitCode = 1;
}
