// FEAT-449 — durable ingest spool: writer + reader helpers shared by the
// `capture claude` CLI (writer) and the daemon's spool-drain worker (reader).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  spoolDir,
  writeToSpool,
  listSpoolFiles,
  quarantineSpoolFile,
  deleteSpoolFile,
} from '../../src/ingest/spool.js';

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

    // No dotfile/tmp artifact left behind in the spool dir.
    const entries = readdirSync(spoolDir(dataDir));
    expect(entries).toEqual([`${K_A}.json`]);
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
