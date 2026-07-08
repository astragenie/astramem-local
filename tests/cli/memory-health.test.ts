// FEAT-444 AC-3: `astramem-local memory health [--json] [--deep]` — direct
// DB read (openRuntimeDb), same pattern as tests/cli/queue.test.ts.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { memoryHealthCommand } from '../../src/cli/memory-health.js';

function tmpDataDir(): string {
  const dir = join(tmpdir(), `astra-memhealth-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedMemories(dataDir: string, count = 2): void {
  const db = openDb(join(dataDir, 'memory.sqlite'));
  migrate(db);
  const repo = new MemoryRepo(db);
  for (let i = 0; i < count; i++) {
    repo.insert({
      type: i % 2 === 0 ? 'fact' : 'lesson',
      text: `memory number ${i} with enough text to not be ultra-short`,
      normalized_text: `memory number ${i}`,
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: randomUUID(), source_hash: null,
    });
  }
  db.close();
}

const origDataDir = process.env.ASTRA_MEMORY_DATADIR;

afterEach(() => {
  if (origDataDir === undefined) delete process.env.ASTRA_MEMORY_DATADIR;
  else process.env.ASTRA_MEMORY_DATADIR = origDataDir;
  vi.restoreAllMocks();
});

describe('memoryHealthCommand', () => {
  it('empty store — all-zero report, no throw, exits cleanly (AC-4)', async () => {
    const dir = tmpDataDir();
    process.env.ASTRA_MEMORY_DATADIR = dir;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(memoryHealthCommand(['--json'])).resolves.not.toThrow();

    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(output.report.activeCount).toBe(0);
    expect(output.report.usefulness).toEqual({ served: 0, used: 0, coverageRate: null });
    expect(output.deep).toBeUndefined();
  });

  it('populated store — reports counts, byType/byScope, staleness (AC-1 shape via AC-3)', async () => {
    const dir = tmpDataDir();
    process.env.ASTRA_MEMORY_DATADIR = dir;
    seedMemories(dir, 3);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await memoryHealthCommand(['--json']);

    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(output.report.activeCount).toBe(3);
    expect(output.report.counts.byType.fact).toBe(2);
    expect(output.report.counts.byType.lesson).toBe(1);
    expect(Array.isArray(output.report.staleness)).toBe(true);
  });

  it('non-JSON mode prints a human-readable report without throwing', async () => {
    const dir = tmpDataDir();
    process.env.ASTRA_MEMORY_DATADIR = dir;
    seedMemories(dir, 1);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await memoryHealthCommand([]);

    const printed = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(printed).toContain('AstraMemory Memory Health');
    expect(printed).toContain('Usefulness coverage');
  });

  it('--deep runs near-duplicate + junk heuristic; LLM-judged sample stays disabled by default (AC-5)', async () => {
    const dir = tmpDataDir();
    process.env.ASTRA_MEMORY_DATADIR = dir;
    seedMemories(dir, 2);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await memoryHealthCommand(['--json', '--deep']);

    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(output.deep).toBeDefined();
    expect(output.deep.nearDuplicate).toBeDefined();
    expect(output.deep.junk).toBeDefined();
    // Default config has memoryHealth.llmJudgedJunkSample.enabled: false —
    // no config.yaml opt-in was written for this tmp dir, so this MUST stay
    // disabled and make no LLM call.
    expect(output.deep.llmJudged).toEqual({ enabled: false, sampledCount: 0, judgedJunkCount: 0, rate: null });
  });

  it('never mutates memories/memory_events/consolidation_proposals (read-only, AC-3)', async () => {
    const dir = tmpDataDir();
    process.env.ASTRA_MEMORY_DATADIR = dir;
    seedMemories(dir, 2);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const dbPath = join(dir, 'memory.sqlite');
    const before = (() => {
      const db = openDb(dbPath);
      const snap = {
        memories: (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n,
        events: (db.prepare('SELECT COUNT(*) AS n FROM memory_events').get() as { n: number }).n,
        proposals: (db.prepare('SELECT COUNT(*) AS n FROM consolidation_proposals').get() as { n: number }).n,
      };
      db.close();
      return snap;
    })();

    await memoryHealthCommand(['--json', '--deep']);

    const after = (() => {
      const db = openDb(dbPath);
      const snap = {
        memories: (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n,
        events: (db.prepare('SELECT COUNT(*) AS n FROM memory_events').get() as { n: number }).n,
        proposals: (db.prepare('SELECT COUNT(*) AS n FROM consolidation_proposals').get() as { n: number }).n,
      };
      db.close();
      return snap;
    })();

    expect(after).toEqual(before);
  });
});
