/**
 * tests/doctor/transcript-session-provenance-check.test.ts
 *
 * FEAT-485: the "Transcript/session provenance" doctor row — isolates the
 * ONE thing that would be a genuine pipeline regression (a distill-sourced
 * row, i.e. source_hash IS NOT NULL, missing session_id) from the EXPECTED
 * gap on direct-insert rows (remember()/memory-tool, source_hash always
 * NULL, no transcript context by design — ADR-009).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getChecks } from '../../src/doctor/checks.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

function seedDistillSourced(dbPath: string, n: number, withSession: number) {
  const db = openDb(dbPath);
  migrate(db);
  const repo = new MemoryRepo(db);
  const events = new MemoryEventRepo(db);
  const insertSession = db.prepare(
    `INSERT INTO sessions (id, repo, project, branch, agent, started_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < n; i++) {
    const sessionId = i < withSession ? `sess-${i}` : null;
    if (sessionId) insertSession.run(sessionId, 'r1', null, null, 'claude-code', Date.now());
    repo.insertWithCreateEvent(
      {
        type: 'fact', text: `seed distill-sourced memory ${i}`, normalized_text: `seed distill-sourced memory ${i}`,
        repo: 'r1', project: null, branch: null, agent: 'claude-code',
        session_id: sessionId,
        hash: randomUUID(), source_hash: `hash-${i}`, // non-null == "went through distill"
      },
      events,
    );
  }
  db.close();
}

function seedDirectInsert(dbPath: string, n: number) {
  const db = openDb(dbPath);
  migrate(db);
  const repo = new MemoryRepo(db);
  const events = new MemoryEventRepo(db);
  for (let i = 0; i < n; i++) {
    repo.insertWithCreateEvent(
      {
        type: 'note', text: `seed direct-insert memory ${i}`, normalized_text: `seed direct-insert memory ${i}`,
        repo: null, project: null, branch: null, agent: null, session_id: null,
        hash: randomUUID(), source_hash: null, // remember()/memory-tool signature
      },
      events,
    );
  }
  db.close();
}

describe('doctor "Transcript/session provenance" check (FEAT-485)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-transcript-session-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor() {
    return findCheck(getChecks({ dataDir: dir, encryptionEnabled: false }), 'Transcript/session provenance');
  }

  it('no DB yet — ok:true, informational', async () => {
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no DB yet');
  });

  it('below threshold distill-sourced rows, even with many direct-insert rows — ok:true, notes the expected asymmetry', async () => {
    seedDistillSourced(join(dir, 'memory.sqlite'), 3, 3);
    seedDirectInsert(join(dir, 'memory.sqlite'), 50);
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('below the 20 floor to judge');
    expect(result.message).toContain('53 total');
    expect(result.message.toLowerCase()).toContain('remember()/memory-tool');
  });

  it('>= threshold distill-sourced rows, all carry session_id — ok:true', async () => {
    seedDistillSourced(join(dir, 'memory.sqlite'), 25, 25);
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('all 25 distill-sourced memories');
  });

  it('>= threshold distill-sourced rows, some missing session_id — WARN: real pipeline regression', async () => {
    seedDistillSourced(join(dir, 'memory.sqlite'), 25, 20); // 5 missing session_id
    const result = await checkFor().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('5/25');
    expect(result.message.toLowerCase()).toContain('this is a pipeline regression');
    expect(result.fix).toBeDefined();
  });

  it('direct-insert (remember()) rows missing session never count against the distill-sourced slice', async () => {
    seedDistillSourced(join(dir, 'memory.sqlite'), 25, 25); // all fine
    seedDirectInsert(join(dir, 'memory.sqlite'), 100); // all session_id NULL, but not distill-sourced
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('all 25 distill-sourced memories');
  });
});
