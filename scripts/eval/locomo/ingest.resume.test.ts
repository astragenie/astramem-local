import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestConversations } from './ingest.mts';
import { sessionIdFor } from './lib/envelope.js';
import { ledgerCompletedMap, type LedgerEntry } from '../shared/resume-ledger.js';
import type { LoCoMoSample } from './lib/types.js';

function makeSample(id: string, sessionCount: number): LoCoMoSample {
  const conversation: Record<string, unknown> = { speaker_a: 'Alice', speaker_b: 'Bob' };
  for (let n = 1; n <= sessionCount; n++) {
    conversation[`session_${n}`] = [{ speaker: 'Alice', dia_id: `D${n}:1`, text: 'hi there' }];
    conversation[`session_${n}_date_time`] = '1:00 pm on 20 May, 2023';
  }
  return {
    sample_id: id,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conversation: conversation as any,
    qa: [],
  };
}

describe('ingestConversations resume support (FEAT-462 AC-1, AC-4, AC-6, AC-7)', () => {
  let dir: string;
  let ledgerPath: string;
  let postedSessionIds: string[];
  const client = { baseUrl: 'http://127.0.0.1:1', token: 'tok' };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'locomo-ingest-resume-'));
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
    const samples = [makeSample('s1', 2), makeSample('s2', 3)];
    const manifest = await ingestConversations(client, samples, { concurrency: 2 });

    expect(manifest.total_sessions).toBe(5);
    expect(manifest.ok_count).toBe(5);
    expect(postedSessionIds).toHaveLength(5);
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it('AC-1/AC-4/AC-6: mirrors LongMemEval ingestQuestions exactly -- resumeCompleted sessions are replayed, never re-POSTed, merged manifest counts every session exactly once', async () => {
    const sample = makeSample('s1', 4);
    const sessionIds = [1, 2, 3, 4].map(n => sessionIdFor('s1', n));

    const resumeCompleted = new Map<string, LedgerEntry>([
      [sessionIds[0]!, { session_id: sessionIds[0]!, owner_id: 's1', ok: true, idempotent: false, ts: 't0' }],
      [sessionIds[1]!, { session_id: sessionIds[1]!, owner_id: 's1', ok: true, idempotent: false, ts: 't0' }],
    ]);

    const manifest = await ingestConversations(client, [sample], { concurrency: 2, ledgerPath, resumeCompleted });

    expect(manifest.total_sessions).toBe(4);
    expect(manifest.ok_count).toBe(4);
    const recorded = manifest.by_sample['s1']!.session_ids;
    expect([...recorded].sort()).toEqual([...sessionIds].sort());
    expect(new Set(recorded).size).toBe(4);

    expect(postedSessionIds.sort()).toEqual([sessionIds[2]!, sessionIds[3]!].sort());
    expect(ledgerCompletedMap(ledgerPath).size).toBe(2);
  });

  it('review fix (finding 2): a ledger write failure does not fail the job -- the outcome still succeeds and a warning is logged', async () => {
    const blockerPath = join(dir, 'blocker');
    writeFileSync(blockerPath, 'not a directory', 'utf8');
    const badLedgerPath = join(blockerPath, 'ingest-ledger.jsonl');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sample = makeSample('s1', 2);
    const manifest = await ingestConversations(client, [sample], { concurrency: 2, ledgerPath: badLedgerPath });

    expect(manifest.ok_count).toBe(2);
    expect(manifest.failed_count).toBe(0);
    expect(postedSessionIds).toHaveLength(2);
    expect(errorSpy.mock.calls.some(args => String(args[0]).includes('WARNING: failed to append to resume ledger'))).toBe(true);
    errorSpy.mockRestore();
  });
});
