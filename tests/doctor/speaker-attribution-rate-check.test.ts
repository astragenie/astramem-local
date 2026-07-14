/**
 * tests/doctor/speaker-attribution-rate-check.test.ts
 *
 * FEAT-505 AC-4: the "Speaker attribution rate" doctor row — atoms-with-
 * speaker / caption atoms, scoped to `capture_source = 'meeting_captions'`.
 * Mirrors tests/doctor/evidence-provenance-check.test.ts's shape exactly
 * (same MEANINGFUL_USAGE_THRESHOLD gate, same SEVEN_DAYS_MS window).
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

function seedMeetingCaptionsMemories(dbPath: string, n: number, withSpeaker: number) {
  const db = openDb(dbPath);
  migrate(db);
  const repo = new MemoryRepo(db);
  const events = new MemoryEventRepo(db);
  for (let i = 0; i < n; i++) {
    repo.insertWithCreateEvent(
      {
        type: 'fact',
        text: `seed meeting-captions memory ${i}`,
        normalized_text: `seed meeting-captions memory ${i}`,
        repo: null, project: null, branch: null, agent: 'claude-code', session_id: null,
        hash: randomUUID(), source_hash: null,
        capture_source: 'meeting_captions',
        speaker_label: i < withSpeaker ? `Speaker ${i}` : null,
      },
      events,
    );
  }
  db.close();
}

describe('doctor "Speaker attribution rate" check (FEAT-505)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-speaker-attribution-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor() {
    return findCheck(getChecks({ dataDir: dir, encryptionEnabled: false }), 'Speaker attribution rate');
  }

  it('no DB yet — ok:true, informational', async () => {
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no DB yet');
  });

  it('below MEANINGFUL_USAGE_THRESHOLD meeting-captions memories — ok:true, not enough activity to judge', async () => {
    seedMeetingCaptionsMemories(join(dir, 'memory.sqlite'), 5, 0);
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not enough activity');
  });

  it('>= threshold, attribution rate below floor — WARN', async () => {
    seedMeetingCaptionsMemories(join(dir, 'memory.sqlite'), 25, 1); // 1/25 = 4% << 15% floor
    const result = await checkFor().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('1/25');
    expect(result.fix).toBeDefined();
  });

  it('>= threshold, attribution rate at/above floor — ok:true', async () => {
    seedMeetingCaptionsMemories(join(dir, 'memory.sqlite'), 25, 10); // 40% >= 15% floor
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('10/25');
  });

  it('non-meeting_captions memories are excluded from the denominator', async () => {
    // 25 meeting_captions memories, none attributed (would WARN on its own),
    // plus 25 auto_capture memories with no speaker_label at all (expected —
    // auto_capture has no third-party speaker identity to recover). The
    // auto_capture rows must not dilute (or otherwise affect) the
    // meeting_captions-scoped rate.
    seedMeetingCaptionsMemories(join(dir, 'memory.sqlite'), 25, 1);
    const db = openDb(join(dir, 'memory.sqlite'));
    const repo = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);
    for (let i = 0; i < 25; i++) {
      repo.insertWithCreateEvent(
        {
          type: 'fact',
          text: `seed auto_capture memory ${i}`,
          normalized_text: `seed auto_capture memory ${i}`,
          repo: null, project: null, branch: null, agent: 'claude-code', session_id: null,
          hash: randomUUID(), source_hash: null,
          capture_source: 'auto_capture',
          speaker_label: null,
        },
        events,
      );
    }
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('1/25');
  });
});
