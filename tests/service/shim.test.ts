import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeShim, shimPaths, writePointer, exitHistoryPaths } from '../../src/service/shim.js';
import { buildTaskXml } from '../../src/service/task-xml.js';

describe('service shim', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-shim-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes cmd + launcher + pointer, and pointer round-trips', () => {
    const paths = shimPaths(dir);
    writeShim({ nodeBin: 'C:\\nodejs\\node.exe', entryJs: 'C:\\repo\\dist\\cli\\index.js', port: 7777 }, paths);
    expect(existsSync(paths.cmdPath)).toBe(true);
    expect(existsSync(paths.launcherPath)).toBe(true);
    const ptr = JSON.parse(readFileSync(paths.pointerPath, 'utf8'));
    expect(ptr).toEqual({ nodeBin: 'C:\\nodejs\\node.exe', entryJs: 'C:\\repo\\dist\\cli\\index.js', port: 7777 });
    // cmd must reference the launcher and the pointer's node binary
    const cmd = readFileSync(paths.cmdPath, 'utf8');
    expect(cmd).toContain(paths.launcherPath);
    expect(cmd).toContain('C:\\nodejs\\node.exe');
  });

  it('is idempotent — second write with a new pointer replaces the old one', () => {
    const paths = shimPaths(dir);
    writeShim({ nodeBin: 'a', entryJs: 'b', port: 1 }, paths);
    writeShim({ nodeBin: 'c', entryJs: 'd', port: 2 }, paths);
    const ptr = JSON.parse(readFileSync(paths.pointerPath, 'utf8'));
    expect(ptr).toEqual({ nodeBin: 'c', entryJs: 'd', port: 2 });
  });

  it('launcher exits 1 with actionable message when pointer is missing', () => {
    const paths = shimPaths(dir);
    writeShim({ nodeBin: 'x', entryJs: 'y', port: 1 }, paths);
    rmSync(paths.pointerPath);
    const res = spawnSync(process.execPath, [paths.launcherPath], { encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('reinstall');
  });

  it('launcher execs the pointed-at entry with serve --port', () => {
    const paths = shimPaths(dir);
    // Fake daemon entry: prints its argv and exits 0.
    const fakeEntry = join(dir, 'fake-entry.cjs');
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(fakeEntry, 'console.log(JSON.stringify(process.argv.slice(2)));');
    writeShim({ nodeBin: process.execPath, entryJs: fakeEntry, port: 4242 }, paths);
    const res = spawnSync(process.execPath, [paths.launcherPath], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual(['serve', '--port', '4242']);
  });

  it('writePointer (FEAT-438 SLICE-417 AC-4) writes current.json via tmp+rename and leaves no stray tmp file', () => {
    const paths = shimPaths(dir);
    writePointer({ nodeBin: 'node', entryJs: 'C:\\releases\\1.0.0+abc\\dist\\cli\\index.js', port: 7777 }, paths.pointerPath);
    const ptr = JSON.parse(readFileSync(paths.pointerPath, 'utf8'));
    expect(ptr).toEqual({ nodeBin: 'node', entryJs: 'C:\\releases\\1.0.0+abc\\dist\\cli\\index.js', port: 7777 });

    const fs = require('node:fs') as typeof import('node:fs');
    const entries: string[] = fs.readdirSync(paths.binDir);
    expect(entries.some(e => e.includes('.tmp'))).toBe(false);
  });

  it('writePointer round-trips devPinned (FEAT-438 SLICE-418 AC-4)', () => {
    const paths = shimPaths(dir);
    writePointer({ nodeBin: 'node', entryJs: 'C:\\repo\\dist\\cli\\index.js', port: 7777, devPinned: true }, paths.pointerPath);
    const ptr = JSON.parse(readFileSync(paths.pointerPath, 'utf8'));
    expect(ptr.devPinned).toBe(true);
  });

  it('writePointer omits devPinned when not set (release-pinned pointers stay unmarked)', () => {
    const paths = shimPaths(dir);
    writePointer({ nodeBin: 'node', entryJs: 'C:\\releases\\1.0.0+abc\\dist\\cli\\index.js', port: 7777 }, paths.pointerPath);
    const ptr = JSON.parse(readFileSync(paths.pointerPath, 'utf8'));
    expect(ptr.devPinned).toBeUndefined();
  });

  it('writePointer overwrites an existing pointer atomically (repoint), and writeShim still round-trips through it', () => {
    const paths = shimPaths(dir);
    writePointer({ nodeBin: 'node', entryJs: 'old-entry.js', port: 1 }, paths.pointerPath);
    writePointer({ nodeBin: 'node', entryJs: 'new-release-entry.js', port: 1 }, paths.pointerPath);
    const ptr = JSON.parse(readFileSync(paths.pointerPath, 'utf8'));
    expect(ptr.entryJs).toBe('new-release-entry.js');

    // writeShim (used by install-flow) delegates its pointer write through
    // the same helper — still produces a valid round-trippable pointer.
    writeShim({ nodeBin: 'node', entryJs: 'shim-written-entry.js', port: 2 }, paths);
    const ptr2 = JSON.parse(readFileSync(paths.pointerPath, 'utf8'));
    expect(ptr2).toEqual({ nodeBin: 'node', entryJs: 'shim-written-entry.js', port: 2 });
  });
});

describe('service shim — cross-platform (FEAT-443 SLICE-1)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-shim-xplat-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('shimPaths defaults to a data-adjacent bin dir (no more LOCALAPPDATA-only base)', () => {
    // Base dir override still works (test seam) — the bin dir is now just
    // "<base>/bin", not "<base>/Astramem/bin": on win32 that segment is
    // already baked into defaultDataDir(), so production paths are
    // byte-identical, but a raw override no longer double-applies it.
    const paths = shimPaths(dir);
    expect(paths.binDir).toBe(join(dir, 'bin'));
  });

  it('win32: cmdPath is astramemd.cmd (unchanged)', () => {
    const paths = shimPaths(dir, 'win32');
    expect(paths.cmdPath.endsWith('astramemd.cmd')).toBe(true);
  });

  it('linux: cmdPath is astramemd.sh, and writeShim emits a POSIX shell wrapper', () => {
    const paths = shimPaths(dir, 'linux');
    expect(paths.cmdPath.endsWith('astramemd.sh')).toBe(true);

    writeShim({ nodeBin: '/usr/bin/node', entryJs: '/opt/astramem/dist/cli/index.js', port: 7777 }, paths);
    expect(existsSync(paths.cmdPath)).toBe(true);
    const cmd = readFileSync(paths.cmdPath, 'utf8');
    expect(cmd.startsWith('#!/bin/sh\n')).toBe(true);
    expect(cmd).toContain('exec "/usr/bin/node"');
    expect(cmd).toContain(paths.launcherPath);
    // Must NOT contain the Windows batch preamble.
    expect(cmd).not.toContain('@echo off');

    const ptr = JSON.parse(readFileSync(paths.pointerPath, 'utf8'));
    expect(ptr).toEqual({ nodeBin: '/usr/bin/node', entryJs: '/opt/astramem/dist/cli/index.js', port: 7777 });
  });

  it('darwin: cmdPath is astramemd.sh, and writeShim emits the same POSIX shell wrapper as linux', () => {
    const paths = shimPaths(dir, 'darwin');
    expect(paths.cmdPath.endsWith('astramemd.sh')).toBe(true);

    writeShim({ nodeBin: '/usr/local/bin/node', entryJs: '/opt/astramem/dist/cli/index.js', port: 8888 }, paths);
    const cmd = readFileSync(paths.cmdPath, 'utf8');
    expect(cmd.startsWith('#!/bin/sh\n')).toBe(true);
    expect(cmd).toContain('exec "/usr/local/bin/node"');
    expect(cmd).not.toContain('@echo off');
  });

  it('posix shim launcher execs the pointed-at entry with serve --port (same launch.cjs as win32)', () => {
    const paths = shimPaths(dir, 'linux');
    const fakeEntry = join(dir, 'fake-entry.cjs');
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(fakeEntry, 'console.log(JSON.stringify(process.argv.slice(2)));');
    writeShim({ nodeBin: process.execPath, entryJs: fakeEntry, port: 5151 }, paths);
    // Exercised via node directly (spawning the .sh wrapper itself requires a
    // POSIX shell not guaranteed present on every CI host) — this still
    // proves launch.cjs, the piece writeShim actually varies per platform
    // around, behaves identically regardless of which wrapper called it.
    const res = spawnSync(process.execPath, [paths.launcherPath], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual(['serve', '--port', '5151']);
  });

  it('writeShim overwriting a win32 pointer with a posix one at the same binDir replaces cmdPath cleanly', () => {
    // Simulates re-running writeShim with paths built for a different
    // platformOverride against the same base dir — not a real-world upgrade
    // path (a host's platform doesn't change), but confirms writeShim's
    // format decision is entirely driven by the paths it's given, not stale
    // state.
    const winPaths = shimPaths(dir, 'win32');
    writeShim({ nodeBin: 'node', entryJs: 'a.js', port: 1 }, winPaths);
    expect(existsSync(winPaths.cmdPath)).toBe(true);

    const posixPaths = shimPaths(dir, 'linux');
    writeShim({ nodeBin: 'node', entryJs: 'b.js', port: 2 }, posixPaths);
    expect(existsSync(posixPaths.cmdPath)).toBe(true);
    const cmd = readFileSync(posixPaths.cmdPath, 'utf8');
    expect(cmd.startsWith('#!/bin/sh\n')).toBe(true);
  });
});

describe('service shim — crash-loop visibility (FEAT-440)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-shim-crashloop-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a zero-exit run in exit-history.jsonl and writes no crash.log (AC-1)', () => {
    const paths = shimPaths(dir);
    const { historyPath, crashLogPath } = exitHistoryPaths(dir);
    const fakeEntry = join(dir, 'healthy-entry.cjs');
    writeFileSync(fakeEntry, 'process.exit(0);');
    writeShim({ nodeBin: process.execPath, entryJs: fakeEntry, port: 1 }, paths);

    const res = spawnSync(process.execPath, [paths.launcherPath], { encoding: 'utf8' });
    expect(res.status).toBe(0);

    const lines = readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.exitCode).toBe(0);
    expect(typeof entry.durationMs).toBe('number');
    expect(typeof entry.ts).toBe('string');
    expect(existsSync(crashLogPath)).toBe(false);
  });

  it('captures crash stderr verbatim to crash.log and records the non-zero exit (AC-2)', () => {
    const paths = shimPaths(dir);
    const { historyPath, crashLogPath } = exitHistoryPaths(dir);
    const fakeEntry = join(dir, 'crash-entry.cjs');
    writeFileSync(fakeEntry, "console.error('BOOM: schema-version drift'); process.exit(7);");
    writeShim({ nodeBin: process.execPath, entryJs: fakeEntry, port: 1 }, paths);

    const res = spawnSync(process.execPath, [paths.launcherPath], { encoding: 'utf8' });
    expect(res.status).toBe(7);

    const lines = readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]!);
    expect(last.exitCode).toBe(7);

    const crashLog = readFileSync(crashLogPath, 'utf8');
    expect(crashLog).toContain('BOOM: schema-version drift');
    expect(crashLog).toContain('exit=7');
  });

  it('ring-buffers exit-history.jsonl to the last 50 entries', () => {
    const paths = shimPaths(dir);
    const { historyPath, logsDir } = exitHistoryPaths(dir);
    mkdirSync(logsDir, { recursive: true });
    const seedLines = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ ts: `seed-${i}`, exitCode: 0, durationMs: 1 }),
    );
    writeFileSync(historyPath, seedLines.join('\n') + '\n', 'utf8');

    const fakeEntry = join(dir, 'fake-entry.cjs');
    writeFileSync(fakeEntry, 'process.exit(0);');
    writeShim({ nodeBin: process.execPath, entryJs: fakeEntry, port: 1 }, paths);
    spawnSync(process.execPath, [paths.launcherPath], { encoding: 'utf8' });

    const lines = readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBe(50);
    // Oldest seed entry ('seed-0') must have been dropped to make room.
    expect(lines.some(l => l.includes('"seed-0"'))).toBe(false);
    const newest = JSON.parse(lines[lines.length - 1]!);
    expect(newest.exitCode).toBe(0);
  });

  it('never throws when the logs dir cannot be created — daemon spawn proceeds unaffected (AC-4)', () => {
    const paths = shimPaths(dir);
    const { logsDir } = exitHistoryPaths(dir);
    // Force mkdirSync(logsDir) inside launch.cjs to fail: pre-create the
    // logs path as a plain FILE instead of a directory, simulating a
    // locked/unwritable logs dir without relying on OS ACL behavior that
    // differs across platforms.
    writeFileSync(logsDir, 'not a directory', 'utf8');

    const fakeEntry = join(dir, 'fake-entry.cjs');
    writeFileSync(fakeEntry, "console.log('ran ok'); process.exit(0);");
    writeShim({ nodeBin: process.execPath, entryJs: fakeEntry, port: 1 }, paths);

    const res = spawnSync(process.execPath, [paths.launcherPath], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('ran ok');
  });
});

describe('task XML', () => {
  it('encodes the settings that make the task survive (PT0S, PT5M, IgnoreNew, StartWhenAvailable)', () => {
    const xml = buildTaskXml({ command: 'C:\\bin\\astramemd.cmd', userId: 'HOST\\serge' });
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<Interval>PT5M</Interval>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<Command>C:\\bin\\astramemd.cmd</Command>');
    expect(xml).toContain('<UserId>HOST\\serge</UserId>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });

  it('escapes XML-hostile characters in command/args', () => {
    const xml = buildTaskXml({ command: 'C:\\a & b\\x.cmd', args: '--flag "<v>"', userId: 'u' });
    expect(xml).toContain('C:\\a &amp; b\\x.cmd');
    expect(xml).toContain('--flag &quot;&lt;v&gt;&quot;');
    expect(xml).not.toContain('& b');
  });
});
