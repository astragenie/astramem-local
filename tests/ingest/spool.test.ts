// FEAT-449 — durable ingest spool: writer + reader helpers shared by the
// `capture claude` CLI (writer) and the daemon's spool-drain worker (reader).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import {
  spoolDir,
  spoolQuarantineDir,
  writeToSpool,
  listSpoolFiles,
  quarantineSpoolFile,
  deleteSpoolFile,
  redactSpoolEnvelope,
  readSpoolStats,
  pruneExpiredQuarantine,
  DEFAULT_QUARANTINE_TTL_MS,
} from '../../src/ingest/spool.js';
import { defaultConfig } from '../../src/config/config.js';

// writeToSpool guards the key to a 64-char lowercase hex digest (defense in
// depth — the key becomes a filename segment). Real callers pass a SHA-256
// digest; tests mirror that with repeated-char hex strings so ordering is
// still obvious (K_A sorts before K_B).
const hx = (c: string): string => c.repeat(64);
const K_A = hx('a');
const K_B = hx('b');
const K_C = hx('c');
const K_D = hx('d');
const K_E = hx('e');
const K_F = hx('f');

const dirs: string[] = [];
function tempDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ingest-spool-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('writeToSpool — AC-2 (durable, atomic, idempotent)', () => {
  it('writes via tmp-file + rename — no leftover tmp file, content round-trips', () => {
    const dataDir = tempDataDir();
    const body = { event: 'subagent_stop', session_id: 'x', turns: [{ role: 'user', text: 'hi' }] };
    const path = writeToSpool(dataDir, K_A, body);

    expect(path).toBe(join(spoolDir(dataDir), `${K_A}.json`));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(body);

    // No leftover TMP artifact in the spool dir — `.stats.json` (A3's
    // cumulative spool-count sidecar, bumped by every writeToSpool call) is
    // a legitimate permanent dotfile, not a tmp leak, and listSpoolFiles()
    // already excludes it (dotfile-prefixed) same as any tmp file.
    const entries = readdirSync(spoolDir(dataDir));
    expect(entries.filter(n => n !== '.stats.json')).toEqual([`${K_A}.json`]);
    expect(entries.some(n => n.includes('.tmp'))).toBe(false);
  });

  it('re-writing the same key overwrites in place — does not duplicate', () => {
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_D, { v: 1 });
    writeToSpool(dataDir, K_D, { v: 2 });

    const files = listSpoolFiles(dataDir);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(files[0]!.path, 'utf8'))).toEqual({ v: 2 });
  });

  it('creates the spool dir on demand', () => {
    const dataDir = tempDataDir();
    expect(existsSync(spoolDir(dataDir))).toBe(false);
    writeToSpool(dataDir, K_C, { a: 1 });
    expect(existsSync(spoolDir(dataDir))).toBe(true);
  });

  it('rejects a non-hex key (defense-in-depth path-segment guard)', () => {
    const dataDir = tempDataDir();
    expect(() => writeToSpool(dataDir, '../escape', { a: 1 })).toThrow(/hex digest/);
    expect(() => writeToSpool(dataDir, 'too-short', { a: 1 })).toThrow(/hex digest/);
  });
});

describe('listSpoolFiles', () => {
  it('returns [] when the spool dir does not exist yet — not an error', () => {
    const dataDir = tempDataDir();
    expect(listSpoolFiles(dataDir)).toEqual([]);
  });

  it('lists .json files, sorted by key, excluding quarantine + dotfiles', () => {
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_B, { n: 2 });
    writeToSpool(dataDir, K_A, { n: 1 });

    const files = listSpoolFiles(dataDir);
    expect(files.map(f => f.key)).toEqual([K_A, K_B]);
    for (const f of files) expect(f.size).toBeGreaterThan(0);
  });
});

describe('quarantineSpoolFile — AC-5', () => {
  it('moves the file into .quarantine/ with a reason sidecar', () => {
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_E, { bad: true });
    const [file] = listSpoolFiles(dataDir);

    quarantineSpoolFile(dataDir, file!, 'oversize: 99 bytes exceeds cap');

    expect(listSpoolFiles(dataDir)).toEqual([]); // no longer drainable
    const qDir = join(spoolDir(dataDir), '.quarantine');
    expect(existsSync(join(qDir, `${K_E}.json`))).toBe(true);
    expect(readFileSync(join(qDir, `${K_E}.reason.txt`), 'utf8')).toContain('oversize');
  });

  it('is a no-op (does not throw) if the source file already vanished', () => {
    const dataDir = tempDataDir();
    expect(() => quarantineSpoolFile(dataDir, { path: join(dataDir, 'ingest-spool', 'gone.json'), key: 'gone', size: 0 }, 'race')).not.toThrow();
  });
});

describe('deleteSpoolFile', () => {
  it('removes a drained spool file', () => {
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_F, { ok: true });
    const [file] = listSpoolFiles(dataDir);
    deleteSpoolFile(file!);
    expect(listSpoolFiles(dataDir)).toEqual([]);
  });

  it('is a no-op (does not throw) if already gone', () => {
    const dataDir = tempDataDir();
    expect(() => deleteSpoolFile({ path: join(dataDir, 'ingest-spool', 'gone.json'), key: 'gone', size: 0 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Wave A slice A3 — redact at spool-write
// ---------------------------------------------------------------------------

describe('redactSpoolEnvelope', () => {
  const SECRET = 'AKIAIOSFODNN7EXAMPLE'; // aws_access_key shape

  it('redacts turns[].text', () => {
    const config = defaultConfig();
    const body = { turns: [{ role: 'user', text: `key is ${SECRET}` }, { role: 'assistant', text: 'ok' }] };
    const out = redactSpoolEnvelope(body, config) as { turns: { role: string; text: string }[] };
    expect(out.turns[0]!.text).not.toContain(SECRET);
    expect(out.turns[0]!.text).toMatch(/\[REDACTED:aws_access_key:[0-9a-f]{8}\]/);
    expect(out.turns[1]!.text).toBe('ok'); // untouched — no secret present
  });

  it('redacts events[].text and events[].evidence (ADR-008 events kind)', () => {
    const config = defaultConfig();
    const body = { events: [{ type: 'fact', text: `saw ${SECRET}`, evidence: `log line: ${SECRET}` }] };
    const out = redactSpoolEnvelope(body, config) as { events: { text: string; evidence: string }[] };
    expect(out.events[0]!.text).not.toContain(SECRET);
    expect(out.events[0]!.evidence).not.toContain(SECRET);
  });

  it('redacts a legacy envelope\'s content field', () => {
    const config = defaultConfig();
    const body = { session_id: 'x', source: 'y', content: `token=${SECRET}` };
    const out = redactSpoolEnvelope(body, config) as { content: string };
    expect(out.content).not.toContain(SECRET);
  });

  it('leaves non-text / unrecognized-shape fields and non-object bodies untouched', () => {
    const config = defaultConfig();
    expect(redactSpoolEnvelope({ a: 1, nested: { b: 2 } }, config)).toEqual({ a: 1, nested: { b: 2 } });
    expect(redactSpoolEnvelope('a string body', config)).toBe('a string body');
    expect(redactSpoolEnvelope(null, config)).toBe(null);
    expect(redactSpoolEnvelope([1, 2, 3], config)).toEqual([1, 2, 3]);
  });

  it('is a no-op passthrough when security.redaction.enabled is false (SEC-9 parity with redactIfEnabled)', () => {
    const config = { ...defaultConfig(), security: { ...defaultConfig().security, redaction: { ...defaultConfig().security.redaction, enabled: false } } };
    const body = { turns: [{ role: 'user', text: `key is ${SECRET}` }] };
    const out = redactSpoolEnvelope(body, config) as { turns: { text: string }[] };
    expect(out.turns[0]!.text).toContain(SECRET); // unchanged — redaction explicitly off
  });

  it('does not mutate the input body', () => {
    const config = defaultConfig();
    const body = { turns: [{ role: 'user', text: `key is ${SECRET}` }] };
    const before = JSON.stringify(body);
    redactSpoolEnvelope(body, config);
    expect(JSON.stringify(body)).toBe(before);
  });
});

describe('writeToSpool — A3 redacts before the bytes hit disk', () => {
  const SECRET = 'AKIAIOSFODNN7EXAMPLE';

  it('a secret in turns[].text never reaches the file written to disk', () => {
    const dataDir = tempDataDir();
    const body = { turns: [{ role: 'user', text: `export AWS_ACCESS_KEY_ID=${SECRET}` }] };
    const path = writeToSpool(dataDir, K_A, body, defaultConfig());

    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(SECRET);
    expect(raw).toMatch(/\[REDACTED:aws_access_key:[0-9a-f]{8}\]/);
  });

  it('defaults to defaultConfig() (redaction ON) when no config is passed — fail-safe, not fail-open', () => {
    const dataDir = tempDataDir();
    const body = { turns: [{ role: 'user', text: `export AWS_ACCESS_KEY_ID=${SECRET}` }] };
    const path = writeToSpool(dataDir, K_B, body); // no 4th arg
    expect(readFileSync(path, 'utf8')).not.toContain(SECRET);
  });

  it('bumps SpoolStats.totalSpooled on every write — the doctor canary\'s denominator', () => {
    const dataDir = tempDataDir();
    expect(readSpoolStats(dataDir)).toEqual({ totalSpooled: 0, totalQuarantined: 0 });
    writeToSpool(dataDir, K_A, { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    writeToSpool(dataDir, K_B, { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    expect(readSpoolStats(dataDir).totalSpooled).toBe(2);
  });
});

describe('spool + quarantine directory permissions (keystore-grade)', () => {
  it('the spool dir is created with restrictive permissions', () => {
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_A, { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    const dir = spoolDir(dataDir);
    expect(existsSync(dir)).toBe(true);
    if (platform() !== 'win32') {
      // POSIX: 0700 — non-owners cannot even traverse into the directory,
      // which protects every file inside regardless of each file's own mode.
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    // Windows: best-effort icacls — asserted only by "did not throw and the
    // directory exists" here, same posture as the untested
    // restrictKeyFileAcl in src/storage/keystore.ts (no CI-portable way to
    // assert a real ACL was applied without shelling out to icacls /Q in the
    // test itself, which the source-level warn-on-failure already covers).
  });

  it('the quarantine dir is created with restrictive permissions', () => {
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_A, { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    const [file] = listSpoolFiles(dataDir);
    quarantineSpoolFile(dataDir, file!, 'test');
    const qDir = spoolQuarantineDir(dataDir);
    expect(existsSync(qDir)).toBe(true);
    if (platform() !== 'win32') {
      expect(statSync(qDir).mode & 0o777).toBe(0o700);
    }
  });
});

describe('pruneExpiredQuarantine — quarantine TTL', () => {
  it('removes a quarantine file (and its .reason.txt sidecar) older than maxAgeMs', () => {
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_A, { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    const [file] = listSpoolFiles(dataDir);
    quarantineSpoolFile(dataDir, file!, 'aged out');

    const qDir = spoolQuarantineDir(dataDir);
    const jsonPath = join(qDir, `${K_A}.json`);
    const reasonPath = join(qDir, `${K_A}.reason.txt`);
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(reasonPath)).toBe(true);

    // Backdate the file's mtime past a short TTL rather than sleeping in
    // the test — utimesSync takes seconds-since-epoch for both atime/mtime.
    const oldTime = (Date.now() - 1000) / 1000;
    utimesSync(jsonPath, oldTime, oldTime);

    const result = pruneExpiredQuarantine(dataDir, 500); // 500ms TTL — the file is ~1000ms old
    expect(result).toEqual({ removed: 1, remaining: 0 });
    expect(existsSync(jsonPath)).toBe(false);
    expect(existsSync(reasonPath)).toBe(false);
  });

  it('leaves a quarantine file younger than maxAgeMs untouched', () => {
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_A, { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    const [file] = listSpoolFiles(dataDir);
    quarantineSpoolFile(dataDir, file!, 'fresh');

    const result = pruneExpiredQuarantine(dataDir, DEFAULT_QUARANTINE_TTL_MS);
    expect(result).toEqual({ removed: 0, remaining: 1 });
    expect(existsSync(join(spoolQuarantineDir(dataDir), `${K_A}.json`))).toBe(true);
  });

  it('is a no-op (not an error) when the quarantine dir does not exist yet', () => {
    const dataDir = tempDataDir();
    expect(pruneExpiredQuarantine(dataDir)).toEqual({ removed: 0, remaining: 0 });
  });

  it('uses the 7-day DEFAULT_QUARANTINE_TTL_MS when maxAgeMs is omitted', () => {
    expect(DEFAULT_QUARANTINE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
