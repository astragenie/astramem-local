/**
 * FEAT-476 Phase 0 — a durable file-based spool for cost usage telemetry
 * written by the LLM proxy tee (src/capture/proxy.ts `finishCapture`),
 * mirroring `src/ingest/spool.ts`'s architecture for the SAME reason that
 * module exists: the proxy runs as its own long-lived CLI process
 * (`astramem-local proxy serve`) with no live DB connection of its own (by
 * design — ADR-013), so a captured fact has to land durably on disk before
 * the daemon (which DOES hold the DB connection) can drain it into
 * `cost_events` (src/ingest/cost-spool-drain.ts).
 *
 * Deliberately simpler than `src/ingest/spool.ts`:
 *   - No content redaction. A cost-spool entry carries only raw token
 *     counts, a model id, a provider name, and a synthetic session id — no
 *     conversational text ever passes through this module, so there is
 *     nothing here for the secret/PII redaction pass to catch.
 *   - No quarantine subsystem. A malformed cost-spool file is deleted by
 *     the drain worker (logged, counted) rather than moved aside — the
 *     content is a handful of numbers, not a forensic artifact worth
 *     preserving the way a mis-shapen transcript capture is.
 *   - No ACL-hardening dance (`ensureSpoolDirPermissions` in spool.ts). The
 *     ingest spool hardens its directory because a torn/leaked transcript
 *     file can contain real conversation content (secrets, PII). This
 *     directory never holds anything more sensitive than token counts and a
 *     model id, so the extra Windows-ACL code path this slice would
 *     otherwise have to duplicate isn't proportionate to what it protects —
 *     a deliberate Phase-0 scope line, not an oversight.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CostEventInput } from '../storage/cost-events.js';

export function costSpoolDir(dataDir: string): string {
  return join(dataDir, 'cost-spool');
}

/**
 * Write one captured exchange's usage telemetry to the spool, atomically
 * (tmp-file + rename — same pattern `writeToSpool` uses, so a process crash
 * mid-write never leaves a torn file the drain worker could half-parse).
 * Always tagged `source: 'proxy'` — the only ingest path that writes into
 * this particular spool (OTel ingest, src/capture/otel-ingest.ts, writes
 * `cost_events` rows directly since it already runs inside the daemon
 * process with a live DB connection — no spool needed for that path).
 */
export function writeCostSpoolEntry(dataDir: string, entry: Omit<CostEventInput, 'source'>): void {
  const dir = costSpoolDir(dataDir);
  mkdirSync(dir, { recursive: true });

  const filename = `${entry.capturedAtMs}-${randomUUID()}.json`;
  const finalPath = join(dir, filename);
  const tmpPath = join(dir, `.tmp-${filename}`);

  const payload: CostEventInput = { ...entry, source: 'proxy' };
  writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
  renameSync(tmpPath, finalPath);
}

export interface CostSpoolFile {
  path: string;
  name: string;
}

/** Lists pending spool files, oldest-first (filenames are
 *  `<capturedAtMs>-<uuid>.json`, so lexicographic sort on the numeric
 *  prefix is also chronological — same convention `listSpoolFiles` relies
 *  on for its own idempotency-key-prefixed filenames, just sorted on a
 *  different leading field here). */
export function listCostSpoolFiles(dataDir: string): CostSpoolFile[] {
  const dir = costSpoolDir(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter(n => n.endsWith('.json') && !n.startsWith('.tmp-'))
    .sort()
    .map(name => ({ path: join(dir, name), name }));
}

/** Tolerant read — returns `null` on any parse/shape failure rather than
 *  throwing, so a single poison file never aborts a whole drain tick (the
 *  caller counts it as failed and deletes it). */
export function readCostSpoolEntry(path: string): CostEventInput | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CostEventInput>;
    if (parsed.source !== 'proxy' && parsed.source !== 'otel') return null;
    if (typeof parsed.capturedAtMs !== 'number') return null;
    if (typeof parsed.provider !== 'string') return null;
    if (typeof parsed.sessionKey !== 'string') return null;
    return {
      source: parsed.source,
      capturedAtMs: parsed.capturedAtMs,
      provider: parsed.provider,
      model: typeof parsed.model === 'string' ? parsed.model : null,
      inputTokens: typeof parsed.inputTokens === 'number' ? parsed.inputTokens : null,
      outputTokens: typeof parsed.outputTokens === 'number' ? parsed.outputTokens : null,
      cacheReadInputTokens: typeof parsed.cacheReadInputTokens === 'number' ? parsed.cacheReadInputTokens : null,
      cacheCreationInputTokens: typeof parsed.cacheCreationInputTokens === 'number' ? parsed.cacheCreationInputTokens : null,
      stopReason: typeof parsed.stopReason === 'string' ? parsed.stopReason : null,
      truncated: parsed.truncated === true,
      sessionKey: parsed.sessionKey,
      agentRole: typeof parsed.agentRole === 'string' ? parsed.agentRole : null,
    };
  } catch {
    return null;
  }
}

export function deleteCostSpoolFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone — fine, drain is idempotent */
  }
}
