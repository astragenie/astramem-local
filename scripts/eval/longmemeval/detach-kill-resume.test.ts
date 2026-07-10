/**
 * Manifest-scoped-kill -> --resume handshake (FEAT-462 slice B, AC-3). Same
 * shape as ./resume-integration.test.ts's kill-resilience test, but the
 * kill is performed via ../shared/daemon-manifest.ts's killManifestDaemons
 * against a PID recorded in a written daemon-manifest.json, instead of the
 * test calling killDaemon() directly on its own in-process handle — this is
 * the exact "cleanup script kills only its own PIDs, then --resume works"
 * path AC-3 exists to support (CLAUDE.md Do-NOT: never a machine-wide
 * image-name sweep). Slice A's resume machinery (ledger, ingestQuestions
 * resumeCompleted) is proven elsewhere; this test proves the NEW manifest
 * handshake specifically.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnEvalDaemon, waitForHealthStatus, killDaemon, type DaemonHandle } from '../shared/spawn-daemon.js';
import { writeDaemonManifest, readDaemonManifest, killManifestDaemons } from '../shared/daemon-manifest.js';
import { ingestQuestions } from './ingest.mts';
import { ledgerCompletedMap } from '../shared/resume-ledger.js';
import { sessionIdFor } from './lib/envelope.js';
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

async function spawnFake(opts: { dataDir: string; token: string; stateFile: string; ingestDelayMs?: number }): Promise<DaemonHandle> {
  const command = [FIXTURE, '--port', '0', '--state-file', opts.stateFile, '--ingest-delay-ms', String(opts.ingestDelayMs ?? 0)];
  const daemon = await spawnEvalDaemon({ dataDir: opts.dataDir, token: opts.token, command });
  await waitForHealthStatus(daemon.baseUrl, ['ok'], 10_000);
  return daemon;
}

describe('manifest-scoped kill -> --resume handshake (FEAT-462 AC-3)', () => {
  let dir: string;
  const spawned: DaemonHandle[] = [];

  afterEach(async () => {
    for (const d of spawned.splice(0)) await killDaemon(d, 'SIGKILL', 3_000);
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    'daemon killed via the daemon-manifest PID (not a direct handle) still leaves a resumable ledger',
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'lme-manifest-kill-'));
      const dataDir = join(dir, 'datadir');
      const stateFile = join(dataDir, 'fake-daemon-state.json');
      const ledgerPath = join(dir, 'ingest-ledger.jsonl');
      const token = randomBytes(16).toString('hex');

      const question = makeQuestion('q1', 6);
      const allSessionIds = question.haystack_session_ids.map(hsid => sessionIdFor('q1', hsid));

      // -- Spawn + write the AC-3 manifest, exactly as run-smoke.mts will --
      const daemon1 = await spawnFake({ dataDir, token, stateFile, ingestDelayMs: 80 });
      spawned.push(daemon1);
      writeDaemonManifest(dir, [{ shard: 0, label: 'shard-0', pid: daemon1.pid, port: daemon1.port, datadir: dataDir }]);

      const ingestPromise = ingestQuestions(
        { baseUrl: daemon1.baseUrl, token },
        [question],
        { concurrency: 1, ledgerPath },
      );
      await new Promise(resolve => setTimeout(resolve, 200)); // let a few sessions land before the kill

      // -- Scoped kill via the manifest, not a direct handle/killDaemon() --
      const manifest = readDaemonManifest(dir)!;
      expect(manifest.daemons).toHaveLength(1);
      expect(manifest.daemons[0]!.pid).toBe(daemon1.pid);
      const killResult = killManifestDaemons(manifest, 'SIGKILL');
      expect(killResult.killed).toEqual([daemon1.pid]);

      const firstManifest = await ingestPromise;
      expect(firstManifest.ok_count).toBeGreaterThan(0);
      expect(firstManifest.ok_count).toBeLessThan(6); // proves the manifest kill actually interrupted it

      // -- Resume: respawn against the SAME persisted state file, same as
      // run-smoke.mts's --resume path -----------------------------------
      const daemon2 = await spawnFake({ dataDir, token: randomBytes(16).toString('hex'), stateFile });
      spawned.push(daemon2);
      writeDaemonManifest(dir, [{ shard: 0, label: 'shard-0', pid: daemon2.pid, port: daemon2.port, datadir: dataDir }]);

      const resumeCompleted = ledgerCompletedMap(ledgerPath);
      const secondManifest = await ingestQuestions(
        { baseUrl: daemon2.baseUrl, token: daemon2.token },
        [question],
        { concurrency: 2, ledgerPath, resumeCompleted },
      );

      expect(secondManifest.ok_count).toBe(6);
      expect(secondManifest.failed_count).toBe(0);
      const finalIds = secondManifest.by_question['q1']!.session_ids;
      expect([...finalIds].sort()).toEqual([...allSessionIds].sort());

      // The post-kill manifest reflects the NEW daemon's pid/port, proving
      // resume re-establishes a fresh, accurate scoped-kill target rather
      // than pointing cleanup at the now-dead original pid.
      const finalManifestOnDisk = readDaemonManifest(dir)!;
      expect(finalManifestOnDisk.daemons[0]!.pid).toBe(daemon2.pid);
      expect(finalManifestOnDisk.daemons[0]!.pid).not.toBe(daemon1.pid);
    },
    20_000,
  );
});
