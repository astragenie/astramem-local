// FEAT-449 — ingest-spool drain worker: AC-4 (drains + deletes on ack),
// AC-5 (poison/oversize quarantine), AC-6 (drained/quarantined/pending
// counts), AC-7 (end-to-end de-starvation: a memory_events 'create' row
// results), AC-8 (a spool file written before the "daemon" is up still
// drains once it starts — the writer never touches the daemon/db at all).

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { drainIngestSpool, resetSpoolDrainFailureCounts } from '../../src/ingest/spool-drain.js';
import { spoolDir, writeToSpool, listSpoolFiles } from '../../src/ingest/spool.js';
import { buildClaudeEnvelope, claudeIdempotencyKey, parseClaudeTranscript } from '../../src/capture/claude.js';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { defaultConfig } from '../../src/config/config.js';
import { HandlerRegistry } from '../../src/pipeline/registry.js';
import { startWorker, type WorkerHandle } from '../../src/pipeline/worker.js';
import { distillHandler } from '../../src/pipeline/handlers/distill.js';
import { makeMockProviders } from '../../src/pipeline/mock-providers.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import type { ExtendedHandlerCtx } from '../../src/pipeline/handler-ctx-ext.js';

const dirs: string[] = [];
function tempDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'spool-drain-'));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  resetSpoolDrainFailureCounts();
});

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function makeDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function spoolAClaudeEnvelope(dataDir: string, sessionSuffix: string, text: string): string {
  const jsonl = [
    JSON.stringify({ type: 'user', sessionId: `sess-${sessionSuffix}`, cwd: '/home/u/proj-drain', message: { role: 'user', content: text } }),
    JSON.stringify({ type: 'assistant', sessionId: `sess-${sessionSuffix}`, cwd: '/home/u/proj-drain', message: { role: 'assistant', content: [{ type: 'text', text: 'ok, done' }] } }),
  ].join('\n');
  const parsed = parseClaudeTranscript(jsonl, `/x/agent-${sessionSuffix}.jsonl`);
  const envelope = buildClaudeEnvelope(parsed, 'subagent_stop', '0.9.0', '2026-07-09T12:00:00.000Z');
  const key = claudeIdempotencyKey(envelope);
  writeToSpool(dataDir, key, envelope);
  return key;
}

describe('drainIngestSpool — AC-4 (drains + deletes on ack) / AC-6 (counts)', () => {
  it('ingests a spooled envelope through ingestCanonicalTranscript and deletes the file', () => {
    const dataDir = tempDataDir();
    const db = makeDb();
    const config = defaultConfig();
    spoolAClaudeEnvelope(dataDir, 'ac4', 'use sqlite-vec for storage');

    const result = drainIngestSpool(db, config, dataDir);

    expect(result).toEqual({ drained: 1, quarantined: 0, pending: 0 });
    expect(listSpoolFiles(dataDir)).toEqual([]);

    const transcripts = db.prepare('SELECT COUNT(*) AS n FROM transcripts').get() as { n: number };
    const jobs = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'distill'`).get() as { n: number };
    expect(transcripts.n).toBe(1);
    expect(jobs.n).toBe(1);

    db.close();
  });

  it('a second tick with nothing new spooled reports zero drained/quarantined, zero pending', () => {
    const dataDir = tempDataDir();
    const db = makeDb();
    const config = defaultConfig();
    spoolAClaudeEnvelope(dataDir, 'ac6', 'use sqlite-vec for storage');

    drainIngestSpool(db, config, dataDir);
    const second = drainIngestSpool(db, config, dataDir);

    expect(second).toEqual({ drained: 0, quarantined: 0, pending: 0 });
    db.close();
  });

  it('an already-drained spool file (replayed key) is treated as a successful drain, not a failure', () => {
    const dataDir = tempDataDir();
    const db = makeDb();
    const config = defaultConfig();
    const key = spoolAClaudeEnvelope(dataDir, 'ac4-replay', 'use sqlite-vec for storage');

    drainIngestSpool(db, config, dataDir); // first tick: real drain, file deleted

    // Simulate a redundant capture re-spooling the identical content under
    // the same content-hash key (e.g. a retry) before the daemon started.
    const jsonl = [
      JSON.stringify({ type: 'user', sessionId: 'sess-ac4-replay', cwd: '/home/u/proj-drain', message: { role: 'user', content: 'use sqlite-vec for storage' } }),
      JSON.stringify({ type: 'assistant', sessionId: 'sess-ac4-replay', cwd: '/home/u/proj-drain', message: { role: 'assistant', content: [{ type: 'text', text: 'ok, done' }] } }),
    ].join('\n');
    const parsed = parseClaudeTranscript(jsonl, '/x/agent-ac4-replay.jsonl');
    const envelope = buildClaudeEnvelope(parsed, 'subagent_stop', '0.9.0', '2026-07-09T12:00:00.000Z');
    expect(claudeIdempotencyKey(envelope)).toBe(key);
    writeToSpool(dataDir, key, envelope);

    const result = drainIngestSpool(db, config, dataDir);
    expect(result.drained).toBe(1);
    expect(result.quarantined).toBe(0);
    expect(listSpoolFiles(dataDir)).toEqual([]);

    db.close();
  });
});

describe('drainIngestSpool — AC-5 (poison / oversize quarantine)', () => {
  it('quarantines a spool file exceeding config.ingest.spoolMaxBytes without parsing it', () => {
    const dataDir = tempDataDir();
    const db = makeDb();
    const config = { ...defaultConfig(), ingest: { spoolMaxBytes: 10 } }; // tiny cap
    spoolAClaudeEnvelope(dataDir, 'ac5-oversize', 'use sqlite-vec for storage');

    const result = drainIngestSpool(db, config, dataDir);

    expect(result.quarantined).toBe(1);
    expect(result.drained).toBe(0);
    expect(listSpoolFiles(dataDir)).toEqual([]);
    expect(existsSync(join(spoolDir(dataDir), '.quarantine'))).toBe(true);

    const transcripts = db.prepare('SELECT COUNT(*) AS n FROM transcripts').get() as { n: number };
    expect(transcripts.n).toBe(0); // never read into the ingest path

    db.close();
  });

  it('quarantines an unparsable spool file after MAX_DRAIN_ATTEMPTS retries, not on the first failure', () => {
    const dataDir = tempDataDir();
    const db = makeDb();
    const config = defaultConfig();
    mkdirSync(spoolDir(dataDir), { recursive: true });
    writeFileSync(join(spoolDir(dataDir), 'poison-json.json'), 'not valid json {{{');

    const tick1 = drainIngestSpool(db, config, dataDir);
    expect(tick1.quarantined).toBe(0);
    expect(listSpoolFiles(dataDir)).toHaveLength(1); // still pending — retrying

    let last = tick1;
    for (let i = 0; i < 4; i++) {
      last = drainIngestSpool(db, config, dataDir);
    }
    expect(last.quarantined).toBe(1);
    expect(listSpoolFiles(dataDir)).toEqual([]);
    expect(existsSync(join(spoolDir(dataDir), '.quarantine', 'poison-json.json'))).toBe(true);

    db.close();
  });
});

describe('drainIngestSpool — AC-7 (end-to-end de-starvation) / AC-8 (survives daemon-down)', () => {
  it('a transcript captured while the daemon is down is drained on the next tick and produces a memory_events create row', async () => {
    const dataDir = tempDataDir();

    // AC-8: capture happens with NO daemon/db/worker constructed at all —
    // writeToSpool is pure filesystem I/O. This is the "daemon down at
    // capture time" half of the scenario.
    spoolAClaudeEnvelope(dataDir, 'ac7-ac8', 'use sqlite-vec for storage');
    expect(listSpoolFiles(dataDir)).toHaveLength(1);

    // "Daemon starts" — db + worker constructed AFTER the spool file exists.
    const db = makeDb();
    const config = defaultConfig();
    const providers = makeMockProviders(config.embedding.dim);
    const registry = new HandlerRegistry();
    registry.register(distillHandler);
    const extCtx: ExtendedHandlerCtx = {
      db,
      config,
      providers,
      memoryRepo: new MemoryRepo(db),
      vecStore: new SqliteVecStore(db, config.embedding.dim),
    };
    let worker: WorkerHandle | null = null;

    try {
      // Boot-pass drain (mirrors serve.ts's runSpoolDrain() call at startup).
      const bootDrain = drainIngestSpool(db, config, dataDir);
      expect(bootDrain.drained).toBe(1);
      expect(listSpoolFiles(dataDir)).toEqual([]); // contrast: today, 0 ingests ever happen

      worker = startWorker({ pollMs: 20, registry, db, config, ctx: extCtx });

      await waitFor(() => (
        db.prepare(`SELECT COUNT(*) AS n FROM memory_events WHERE event_type = 'create'`).get() as { n: number }
      ).n > 0);

      const createEvents = db.prepare(`SELECT COUNT(*) AS n FROM memory_events WHERE event_type = 'create'`).get() as { n: number };
      expect(createEvents.n).toBeGreaterThan(0);
    } finally {
      if (worker) await worker.stop();
      db.close();
    }
  }, 15_000);
});

/** Bounded condition poll (mirrors tests/server/ingest-concurrency.test.ts). */
async function waitFor(predicate: () => boolean, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const { timeoutMs = 8_000, intervalMs = 20 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
  }
  if (!predicate()) {
    throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
  }
}
