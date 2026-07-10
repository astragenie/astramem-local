import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestQuestions } from './ingest.mts';
import { sessionIdFor } from './lib/envelope.js';
import { ledgerCompletedMap, type LedgerEntry } from '../shared/resume-ledger.js';
import type { LongMemEvalQuestion } from './lib/types.js';

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

describe('ingestQuestions resume support (FEAT-462 AC-1, AC-4, AC-7)', () => {
  let dir: string;
  let ledgerPath: string;
  let postedSessionIds: string[];
  const client = { baseUrl: 'http://127.0.0.1:1', token: 'tok' };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lme-ingest-resume-'));
    ledgerPath = join(dir, 'ingest-ledger.jsonl');
    postedSessionIds = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { session_id: string };
      postedSessionIds.push(body.session_id);
      return new Response(JSON.stringify({ ok: true, session_id: body.session_id, idempotent: false }), { status: 200 });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('AC-7: with no ledgerPath/resumeCompleted, every session is POSTed exactly once and no ledger file is created', async () => {
    const questions = [makeQuestion('q1', 2), makeQuestion('q2', 3)];
    const manifest = await ingestQuestions(client, questions, { concurrency: 2 });

    expect(manifest.total_sessions).toBe(5);
    expect(manifest.ok_count).toBe(5);
    expect(postedSessionIds).toHaveLength(5);
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it('AC-1/AC-4: appends one ledger line per session as it completes (not batched to end-of-phase)', async () => {
    const questions = [makeQuestion('q1', 3)];
    await ingestQuestions(client, questions, { concurrency: 1, ledgerPath });

    const entries = ledgerCompletedMap(ledgerPath);
    expect(entries.size).toBe(3);
    for (const hsid of questions[0]!.haystack_session_ids) {
      expect(entries.get(sessionIdFor('q1', hsid))?.ok).toBe(true);
    }
  });

  it('AC-1/AC-4: resumeCompleted sessions are replayed (never re-POSTed) and the merged manifest counts every session exactly once', async () => {
    const question = makeQuestion('q1', 4);
    const sessionIds = question.haystack_session_ids.map(hsid => sessionIdFor('q1', hsid));

    // Simulates a resume after a kill that left 2 of 4 sessions durably
    // recorded ok in the ledger from a prior invocation.
    const resumeCompleted = new Map<string, LedgerEntry>([
      [sessionIds[0]!, { session_id: sessionIds[0]!, owner_id: 'q1', ok: true, idempotent: false, ts: 't0' }],
      [sessionIds[1]!, { session_id: sessionIds[1]!, owner_id: 'q1', ok: true, idempotent: false, ts: 't0' }],
    ]);

    const manifest = await ingestQuestions(client, [question], { concurrency: 2, ledgerPath, resumeCompleted });

    expect(manifest.total_sessions).toBe(4);
    expect(manifest.ok_count).toBe(4);
    expect(manifest.failed_count).toBe(0);
    const recorded = manifest.by_question['q1']!.session_ids;
    expect([...recorded].sort()).toEqual([...sessionIds].sort());
    expect(new Set(recorded).size).toBe(4); // exactly-once: no duplicates

    // Only the 2 sessions NOT already in resumeCompleted were actually POSTed.
    expect(postedSessionIds.sort()).toEqual([sessionIds[2]!, sessionIds[3]!].sort());

    // The ledger only gained entries for the freshly-run 2 -- the replayed
    // ones were already durable and are not re-appended.
    expect(ledgerCompletedMap(ledgerPath).size).toBe(2);
  });

  it('review fix (finding 2): a ledger write failure does not fail the job -- the outcome still succeeds and a warning is logged', async () => {
    // Forces mkdirSync(dirname(ledgerPath)) inside appendLedgerEntry to
    // throw ENOTDIR by making an intermediate path segment a plain file.
    const blockerPath = join(dir, 'blocker');
    writeFileSync(blockerPath, 'not a directory', 'utf8');
    const badLedgerPath = join(blockerPath, 'ingest-ledger.jsonl');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const question = makeQuestion('q1', 2);
    const manifest = await ingestQuestions(client, [question], { concurrency: 2, ledgerPath: badLedgerPath });

    expect(manifest.ok_count).toBe(2);
    expect(manifest.failed_count).toBe(0);
    expect(postedSessionIds).toHaveLength(2);
    expect(errorSpy.mock.calls.some(args => String(args[0]).includes('WARNING: failed to append to resume ledger'))).toBe(true);
    errorSpy.mockRestore();
  });

  it('a session whose LATEST ledger entry is ok:false is retried, not skipped', async () => {
    const question = makeQuestion('q1', 1);
    const sid = sessionIdFor('q1', question.haystack_session_ids[0]!);
    const resumeCompleted = new Map<string, LedgerEntry>([
      [sid, { session_id: sid, owner_id: 'q1', ok: false, idempotent: false, error: 'boom', ts: 't0' }],
    ]);

    const manifest = await ingestQuestions({ baseUrl: client.baseUrl, token: client.token }, [question], { concurrency: 1, resumeCompleted });

    expect(postedSessionIds).toEqual([sid]);
    expect(manifest.ok_count).toBe(1);
  });
});
