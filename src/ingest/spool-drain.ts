/**
 * Durable ingest-spool drain worker (FEAT-449).
 *
 * Runs on the daemon's own timer cadence (wired into serve.ts alongside the
 * existing consolidate/cleanup interval timers — see that file) rather than
 * as a queued `jobs` row, because draining is filesystem-driven (list
 * ingest-spool/*.json) rather than event-driven.
 *
 * Each spooled envelope is parsed and handed to `ingestCanonicalTranscript`
 * (src/server/routes/ingest.ts) — the EXACT SAME redact -> session upsert ->
 * transcript insert -> distill-job-enqueue path `/ingest/transcript` uses,
 * called in-process. No self-HTTP hop, no network dependency at drain time
 * (AC-4, AC-8 — a spool file written while the daemon was down drains on the
 * next tick after it starts, with no loss).
 *
 * Idempotency: `capture claude` keys the spool filename by a content hash
 * (src/capture/claude.ts `claudeIdempotencyKey`), and that same key is
 * passed through here as the Idempotency-Key — so a spool file that was
 * already ingested (e.g. the delete lost a race with a previous tick) safely
 * no-ops as a replay instead of double-ingesting.
 *
 * Poison/oversize handling (AC-5): a file bigger than
 * `config.ingest.spoolMaxBytes` is quarantined WITHOUT ever being read into
 * memory (guards the drain tick against OOM on a runaway transcript). A file
 * that fails to parse/validate/ingest is retried up to `MAX_DRAIN_ATTEMPTS`
 * ticks (tracked by an in-memory per-key failure counter) before being
 * quarantined — the counter resets on daemon restart, which is fine: a
 * genuinely poison file re-accumulates failures and re-quarantines within a
 * few ticks either way.
 */
import { readFileSync } from 'node:fs';
import { childLogger } from '../log/logger.js';
import type { DB } from '../storage/db.js';
import type { Config } from '../config/config.js';
import {
  listSpoolFiles,
  deleteSpoolFile,
  quarantineSpoolFile,
  type SpoolFile,
} from './spool.js';
import {
  ingestCanonicalTranscript,
  IdempotentReplayError,
  IdempotencyConflictError,
  CanonicalIngestSchema,
} from '../server/routes/ingest.js';

const MAX_DRAIN_ATTEMPTS = 5;

export interface DrainResult {
  drained: number;
  quarantined: number;
  pending: number;
}

/** Module-scope so the failure count survives across ticks within one
 *  daemon process (see file header re: reset-on-restart being acceptable). */
const failureCounts = new Map<string, number>();

/** Exported for tests — clears the in-memory poison counter between cases. */
export function resetSpoolDrainFailureCounts(): void {
  failureCounts.clear();
}

export function drainIngestSpool(db: DB, config: Config, dataDir: string, maxPerTick = 50): DrainResult {
  const log = childLogger({ request_id: 'spool-drain' });
  const files = listSpoolFiles(dataDir);
  const maxBytes = config.ingest.spoolMaxBytes;

  let drained = 0;
  let quarantined = 0;

  // Bound the files touched per tick so a large backlog (the very scenario
  // this feature recovers from) can never stall the single-threaded event
  // loop in one synchronous sweep — the caller re-arms quickly while
  // `pending > 0` to drain the remainder over bounded ticks.
  for (const file of files.slice(0, maxPerTick)) {
    if (file.size > maxBytes) {
      quarantineSpoolFile(dataDir, file, `oversize: ${file.size} bytes exceeds ingest.spoolMaxBytes=${maxBytes}`);
      failureCounts.delete(file.key);
      quarantined++;
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(file.path, 'utf8');
    } catch (err) {
      // Vanished mid-tick (already drained by a previous/concurrent tick) —
      // not poison, just nothing left to do.
      log.warn({ spool_key: file.key, err: String(err) }, 'spool file unreadable mid-tick, skipping');
      continue;
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch (err) {
      if (recordFailureOrQuarantine(dataDir, file, `unparsable JSON: ${err instanceof Error ? err.message : String(err)}`, log)) quarantined++;
      continue;
    }

    const parsed = CanonicalIngestSchema.safeParse(envelope);
    if (!parsed.success) {
      if (recordFailureOrQuarantine(dataDir, file, `schema validation failed: ${JSON.stringify(parsed.error.flatten())}`, log)) quarantined++;
      continue;
    }

    try {
      ingestCanonicalTranscript(db, config, parsed.data, file.key);
      failureCounts.delete(file.key);
      deleteSpoolFile(file);
      drained++;
    } catch (err) {
      if (err instanceof IdempotentReplayError) {
        // Already ingested by an earlier tick — a successful drain, not a failure.
        failureCounts.delete(file.key);
        deleteSpoolFile(file);
        drained++;
        continue;
      }
      if (err instanceof IdempotencyConflictError) {
        // The spool key IS a content hash — a conflict means a DIFFERENT
        // body was independently ingested under the same key, a condition
        // that cannot self-heal on retry. Quarantine immediately.
        quarantineSpoolFile(dataDir, file, `idempotency conflict: ${err.message}`);
        failureCounts.delete(file.key);
        quarantined++;
        continue;
      }
      if (recordFailureOrQuarantine(dataDir, file, err instanceof Error ? err.message : String(err), log)) quarantined++;
    }
  }

  const pending = listSpoolFiles(dataDir).length;
  log.info({ drained, quarantined, pending }, 'ingest-spool drain tick');
  return { drained, quarantined, pending };
}

/** Bump the per-key failure counter; quarantine once MAX_DRAIN_ATTEMPTS is
 *  reached. Returns true iff this call quarantined the file (so the caller
 *  can fold it into its own `quarantined` tally). */
function recordFailureOrQuarantine(dataDir: string, file: SpoolFile, reason: string, log: ReturnType<typeof childLogger>): boolean {
  const attempts = (failureCounts.get(file.key) ?? 0) + 1;
  if (attempts >= MAX_DRAIN_ATTEMPTS) {
    quarantineSpoolFile(dataDir, file, `poison after ${attempts} attempts: ${reason}`);
    failureCounts.delete(file.key);
    log.warn({ spool_key: file.key, attempts, reason }, 'spool file quarantined — retries exhausted');
    return true;
  }
  failureCounts.set(file.key, attempts);
  log.warn({ spool_key: file.key, attempts, reason }, 'spool file ingest failed, will retry');
  return false;
}
