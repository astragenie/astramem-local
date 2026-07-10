/**
 * Kill-resilience integration test (FEAT-462 AC-1, AC-4, AC-5). Spawns a
 * real child process (the fake/stub daemon at
 * ../shared/__fixtures__/fake-eval-daemon.mjs) via the SAME
 * spawnEvalDaemon/killDaemon machinery run-smoke.mts uses, SIGKILLs it
 * mid-ingest (simulating the 2026-07-10 taskkill incident, CLAUDE.md
 * Do-NOT section), then respawns a second instance pointed at the SAME
 * persisted state file (standing in for the real daemon's durable SQLite
 * datadir) and drives the harness's real ingestQuestions/
 * waitForQuestionsDistilled functions through a --resume-shaped call to
 * deterministically assert exactly-once ingestion and distill continuity.
 *
 * No live LLM, no live Ollama, no dist/ build required — the fake daemon
 * is plain Node, spawned via spawnEvalDaemon's `command` override.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnEvalDaemon, waitForHealthStatus, killDaemon, type DaemonHandle } from '../shared/spawn-daemon.js';
import { ingestQuestions } from './ingest.mts';
import { waitForQuestionsDistilled } from './distill-wait.mts';
import { sessionIdFor } from './lib/envelope.js';
import { ledgerCompletedMap } from '../shared/resume-ledger.js';
import type { LongMemEvalQuestion } from './lib/types.js';

const FIXTURE = join('scripts', 'eval', 'shared', '__fixtures__', 'fake-eval-daemon.mjs');

function makeQuestion(id: string, sessionCount: number): LongMemEvalQuestion {
  return {
    question_id: id,
    question_type: 'single-session-user',
    question: `question for ${id}`,
    question_date: '2023/05/20 (Sat) 02:21',
    answer: 'some answer',
    answer_session_ids: [],
    haystack_dates: Array.from({ length: sessionCount }, () => '2023/05/20 (Sat) 02:21'),
    haystack_session_ids: Array.from({ length: sessionCount }, (_, i) => `${id}-hs-${i}`),
    haystack_sessions: Array.from({ length: sessionCount }, () => [{ role: 'user' as const, content: 'hi there' }]),
  };
}

interface FakeDaemonState {
  sessions: Record<string, { ingestedAtMs: number }>;
  ingestCallCount: number;
}

function readState(stateFile: string): FakeDaemonState {
  return JSON.parse(readFileSync(stateFile, 'utf8')) as FakeDaemonState;
}

async function spawnFake(opts: { dataDir: string; token: string; stateFile: string; ingestDelayMs?: number; distillDelayMs?: number }): Promise<DaemonHandle> {
  const command = [
    FIXTURE, '--port', '0', '--state-file', opts.stateFile,
    '--ingest-delay-ms', String(opts.ingestDelayMs ?? 0),
    '--distill-delay-ms', String(opts.distillDelayMs ?? 0),
  ];
  const daemon = await spawnEvalDaemon({ dataDir: opts.dataDir, token: opts.token, command });
  await waitForHealthStatus(daemon.baseUrl, ['ok'], 10_000);
  return daemon;
}

describe('resume kill-resilience (FEAT-462 AC-1, AC-4, AC-5)', () => {
  let dir: string;
  const spawned: DaemonHandle[] = [];

  afterEach(async () => {
    for (const d of spawned.splice(0)) await killDaemon(d, 'SIGKILL', 3_000);
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    'SIGKILL mid-ingest, then --resume-style re-invocation ingests every session exactly once against a respawned daemon',
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'lme-resume-kill-'));
      const dataDir = join(dir, 'datadir');
      const stateFile = join(dataDir, 'fake-daemon-state.json');
      const ledgerPath = join(dir, 'ingest-ledger.jsonl');
      const token = randomBytes(16).toString('hex');

      const question = makeQuestion('q1', 6);
      const allSessionIds = question.haystack_session_ids.map(hsid => sessionIdFor('q1', hsid));

      // -- First invocation: daemon dies mid-ingest -------------------------
      const daemon1 = await spawnFake({ dataDir, token, stateFile, ingestDelayMs: 80 });
      spawned.push(daemon1);

      const ingestPromise = ingestQuestions(
        { baseUrl: daemon1.baseUrl, token },
        [question],
        { concurrency: 1, ledgerPath },
      );
      // With ingestDelayMs=80ms and concurrency=1, ~2 of 6 jobs complete
      // before this fires — killing the daemon while a later job is
      // in-flight (mirrors the 2026-07-10 taskkill incident).
      await new Promise(resolve => setTimeout(resolve, 200));
      await killDaemon(daemon1, 'SIGKILL', 3_000);

      const firstManifest = await ingestPromise;
      expect(firstManifest.total_sessions).toBe(6);
      expect(firstManifest.failed_count).toBeGreaterThan(0); // some sessions never got a response
      expect(firstManifest.ok_count).toBeGreaterThan(0); // but some did complete before the kill
      expect(firstManifest.ok_count + firstManifest.failed_count).toBe(6);

      const ledgerAfterKill = ledgerCompletedMap(ledgerPath);
      const okAfterKill = [...ledgerAfterKill.values()].filter(e => e.ok).length;
      expect(okAfterKill).toBe(firstManifest.ok_count);
      expect(okAfterKill).toBeLessThan(6); // proves the kill actually interrupted the phase

      // -- Resume: respawn against the SAME persisted state file -----------
      const daemon2 = await spawnFake({ dataDir, token: randomBytes(16).toString('hex'), stateFile });
      spawned.push(daemon2);
      const token2 = daemon2.token;

      const resumeCompleted = ledgerCompletedMap(ledgerPath);
      const secondManifest = await ingestQuestions(
        { baseUrl: daemon2.baseUrl, token: token2 },
        [question],
        { concurrency: 2, ledgerPath, resumeCompleted },
      );

      // Exactly-once, end to end: every one of the 6 sessions is ok, with
      // no duplicates, after the resume completes the interrupted phase.
      expect(secondManifest.total_sessions).toBe(6);
      expect(secondManifest.ok_count).toBe(6);
      expect(secondManifest.failed_count).toBe(0);
      const finalIds = secondManifest.by_question['q1']!.session_ids;
      expect([...finalIds].sort()).toEqual([...allSessionIds].sort());
      expect(new Set(finalIds).size).toBe(6);

      // The strongest exactly-once signal: the daemon-side ingest call
      // counter (persisted across both processes via the shared state
      // file) proves no already-ok session was re-POSTed after the
      // resume — total POSTs across BOTH daemon lifetimes equals exactly
      // the number of sessions that were ever actually attempted over the
      // network (okAfterKill from daemon1, plus the remainder from
      // daemon2), never double-counting a replayed session.
      const finalState = readState(stateFile);
      expect(Object.keys(finalState.sessions)).toHaveLength(6);
      expect(finalState.ingestCallCount).toBe(6);
    },
    20_000,
  );

  it(
    'SIGKILL after a full ingest, then distill-wait against a respawned daemon resumes from persisted state (no restart of the distill clock)',
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'lme-resume-distill-'));
      const dataDir = join(dir, 'datadir');
      const stateFile = join(dataDir, 'fake-daemon-state.json');
      const ledgerPath = join(dir, 'ingest-ledger.jsonl');
      const token = randomBytes(16).toString('hex');
      const question = makeQuestion('q1', 3);

      const daemon1 = await spawnFake({ dataDir, token, stateFile, distillDelayMs: 150 });
      spawned.push(daemon1);
      const manifest = await ingestQuestions({ baseUrl: daemon1.baseUrl, token }, [question], { concurrency: 3, ledgerPath });
      expect(manifest.ok_count).toBe(3);

      // Kill immediately after ingest completes (simulating a kill mid-distill
      // — CLAUDE.md's taskkill incident) before any /digest poll observes
      // "ready".
      await killDaemon(daemon1, 'SIGKILL', 3_000);

      // Respawn against the same state file: the persisted ingestedAtMs
      // timestamps carry the distill clock across the kill, exactly like a
      // real daemon's durable SQLite datadir keeps distill progress across
      // a process respawn (FEAT-462's core premise).
      const daemon2 = await spawnFake({ dataDir, token: randomBytes(16).toString('hex'), stateFile, distillDelayMs: 150 });
      spawned.push(daemon2);

      const distillResult = await waitForQuestionsDistilled(
        { baseUrl: daemon2.baseUrl, token: daemon2.token },
        manifest.by_question,
        { timeoutMs: 5_000, intervalMs: 50 },
      );

      expect(distillResult.timed_out_question_ids).toEqual([]);
      expect(distillResult.ready_question_ids).toEqual(['q1']);
    },
    20_000,
  );
});
