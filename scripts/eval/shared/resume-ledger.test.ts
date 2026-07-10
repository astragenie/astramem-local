import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLedgerEntry, readLedger, ledgerCompletedMap, type LedgerEntry } from './resume-ledger.js';

describe('resume-ledger', () => {
  let dir: string;
  let ledgerPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'resume-ledger-test-'));
    // nested path so appendLedgerEntry's mkdirSync(dirname(...)) is exercised
    ledgerPath = join(dir, 'shard-0', 'ingest-ledger.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty array when the ledger file does not exist yet', () => {
    expect(readLedger(ledgerPath)).toEqual([]);
    expect(ledgerCompletedMap(ledgerPath).size).toBe(0);
  });

  it('creates the parent directory and appends one JSON line per entry', () => {
    const e1: LedgerEntry = { session_id: 's1', owner_id: 'q1', ok: true, idempotent: false, ts: '2026-07-10T00:00:00.000Z' };
    const e2: LedgerEntry = { session_id: 's2', owner_id: 'q1', ok: false, idempotent: false, error: 'boom', ts: '2026-07-10T00:00:01.000Z' };

    appendLedgerEntry(ledgerPath, e1);
    appendLedgerEntry(ledgerPath, e2);

    expect(existsSync(ledgerPath)).toBe(true);
    const rawLines = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
    expect(rawLines).toHaveLength(2);
    expect(readLedger(ledgerPath)).toEqual([e1, e2]);
  });

  it('drops a torn trailing line without losing earlier well-formed entries', () => {
    const e1: LedgerEntry = { session_id: 's1', owner_id: 'q1', ok: true, idempotent: false, ts: '2026-07-10T00:00:00.000Z' };
    appendLedgerEntry(ledgerPath, e1);
    // Simulate a kill mid-write: append a partial, unterminated JSON fragment
    // with no trailing newline, mirroring what a SIGKILL mid-appendFileSync
    // could leave behind.
    appendFileSync(ledgerPath, '{"session_id":"s2","owner_i', 'utf8');

    expect(readLedger(ledgerPath)).toEqual([e1]);
  });

  it('ledgerCompletedMap keeps the LAST entry per session_id (a retry overwrites an earlier failure)', () => {
    appendLedgerEntry(ledgerPath, { session_id: 's1', owner_id: 'q1', ok: false, idempotent: false, error: 'first try failed', ts: 't0' });
    appendLedgerEntry(ledgerPath, { session_id: 's1', owner_id: 'q1', ok: true, idempotent: false, ts: 't1' });
    appendLedgerEntry(ledgerPath, { session_id: 's2', owner_id: 'q1', ok: true, idempotent: true, ts: 't1' });

    const map = ledgerCompletedMap(ledgerPath);
    expect(map.size).toBe(2);
    expect(map.get('s1')).toEqual({ session_id: 's1', owner_id: 'q1', ok: true, idempotent: false, ts: 't1' });
    expect(map.get('s2')?.ok).toBe(true);
  });
});
