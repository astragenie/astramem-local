/**
 * Crash-safe append-only ingest ledger (FEAT-462 AC-1/AC-4/AC-6). Each
 * completed ingest job (one line per session) is durably appended to a
 * JSONL file the moment it settles — NOT batched to end-of-phase like
 * ingest-manifest.json, which is only written once ingestQuestions /
 * ingestConversations RETURNS (scripts/eval/longmemeval/run-smoke.mts:135,
 * scripts/eval/locomo/run.mts:115). If the process is killed mid-phase
 * (the 2026-07-10 taskkill incident, CLAUDE.md Do-NOT section), the
 * manifest never gets written but the ledger already has every session
 * that completed before the kill — that's the resume gap this module
 * closes.
 *
 * Shared between LongMemEval and LoCoMo (both wire it into their own
 * ingest.mts identically, AC-6) because neither harness's per-question /
 * per-sample shape matters at this layer: a ledger entry only needs the
 * session_id (the idempotent unit of ingest work, per ../shared/
 * daemon-client.ts's Idempotency-Key contract) plus an opaque owner_id
 * (question_id or sample_id) kept around for diagnostics only — resume
 * correctness never depends on owner_id.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LedgerEntry {
  session_id: string;
  /** question_id (LongMemEval) or sample_id (LoCoMo) — diagnostics only. */
  owner_id: string;
  ok: boolean;
  idempotent: boolean;
  error?: string;
  ts: string;
}

/** Appends one durable line. Creates the parent directory if needed (the
 *  per-shard directory may not exist yet the very first time a shard
 *  records anything). */
export function appendLedgerEntry(ledgerPath: string, entry: LedgerEntry): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

/**
 * Reads every well-formed line. Tolerant of a torn trailing line: a kill
 * mid-write can leave a partial last line (same failure mode
 * CLAUDE.md's "Config reload" section documents for config.yaml writes).
 * Because appendFileSync issues one write call per entry and entries are
 * only ever appended in order, a torn line can only ever be the LAST one
 * in the file — dropping it never loses an earlier well-formed entry, it
 * only makes the one session that was mid-write look "not yet completed",
 * which is the correct, safe interpretation (it gets re-attempted).
 */
export function readLedger(ledgerPath: string): LedgerEntry[] {
  if (!existsSync(ledgerPath)) return [];
  const raw = readFileSync(ledgerPath, 'utf8');
  const entries: LedgerEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // Torn trailing line — see doc comment above. Silently dropped.
    }
  }
  return entries;
}

/**
 * Last-write-wins per session_id. A session can appear more than once
 * across resumes if an earlier attempt failed (ok: false) and a later
 * resume retried and succeeded — the latest entry is the one that
 * reflects current reality.
 */
export function ledgerCompletedMap(ledgerPath: string): Map<string, LedgerEntry> {
  const map = new Map<string, LedgerEntry>();
  for (const entry of readLedger(ledgerPath)) map.set(entry.session_id, entry);
  return map;
}
