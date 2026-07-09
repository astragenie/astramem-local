// FEAT-449 — `astramem-local capture claude <transcript-path>` CLI wiring.
//
// AC-3: a missing/unreadable transcript must fail SOFT — exactly one
// warning, nothing spooled, non-zero process.exitCode, no throw and no
// process.exit() mid-flight (Windows UV_HANDLE_CLOSING risk).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureCommand } from '../../src/cli/capture.js';
import { listSpoolFiles } from '../../src/ingest/spool.js';

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
    delete savedEnv[k];
  }
  vi.restoreAllMocks();
});

function withDataDir(dataDir: string): void {
  savedEnv['ASTRA_MEMORY_DATADIR'] = process.env['ASTRA_MEMORY_DATADIR'];
  process.env['ASTRA_MEMORY_DATADIR'] = dataDir;
}

describe('capture claude — AC-3 (missing file fails soft)', () => {
  it('missing transcript path: exactly one warning, nothing spooled, exitCode=1, no throw', async () => {
    const dataDir = tempDir('capture-claude-missing-');
    withDataDir(dataDir);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;

    await expect(captureCommand(['claude', join(dataDir, 'does-not-exist.jsonl')])).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).not.toHaveBeenCalled();
    expect(listSpoolFiles(dataDir)).toEqual([]);

    process.exitCode = savedExitCode;
  });

  it('missing <transcript-path> argument entirely: exitCode=1, no throw', async () => {
    const dataDir = tempDir('capture-claude-noarg-');
    withDataDir(dataDir);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;

    await expect(captureCommand(['claude'])).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    process.exitCode = savedExitCode;
  });
});

describe('capture claude — happy path (AC-1/AC-2 through the CLI)', () => {
  const SESSION = [
    JSON.stringify({ type: 'user', sessionId: 'sess-cli-1', cwd: '/home/u/proj-cli', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', sessionId: 'sess-cli-1', cwd: '/home/u/proj-cli', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }),
  ].join('\n');

  it('spools the envelope and prints a JSON summary with --json', async () => {
    const dataDir = tempDir('capture-claude-happy-');
    withDataDir(dataDir);
    const transcriptDir = tempDir('capture-claude-src-');
    const transcriptPath = join(transcriptDir, 'agent-1.jsonl');
    writeFileSync(transcriptPath, SESSION);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;

    await captureCommand(['claude', transcriptPath, '--json']);

    expect(process.exitCode).toBeUndefined();
    const files = listSpoolFiles(dataDir);
    expect(files).toHaveLength(1);

    const printed = JSON.parse(logSpy.mock.calls[0]![0] as string) as { session_id: string; turns: number; idempotency_key: string };
    expect(printed.session_id).toBe('claude-sess-cli-1');
    expect(printed.turns).toBe(2);
    expect(printed.idempotency_key).toBe(files[0]!.key);

    process.exitCode = savedExitCode;
  });

  it('re-running on the unmodified transcript does not create a second spool file', async () => {
    const dataDir = tempDir('capture-claude-idem-');
    withDataDir(dataDir);
    const transcriptDir = tempDir('capture-claude-src2-');
    const transcriptPath = join(transcriptDir, 'agent-2.jsonl');
    writeFileSync(transcriptPath, SESSION);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await captureCommand(['claude', transcriptPath]);
    await captureCommand(['claude', transcriptPath]);

    expect(listSpoolFiles(dataDir)).toHaveLength(1);
  });

  it('a transcript with no usable turns is not spooled and does not error', async () => {
    const dataDir = tempDir('capture-claude-noturns-');
    withDataDir(dataDir);
    const transcriptDir = tempDir('capture-claude-src3-');
    const transcriptPath = join(transcriptDir, 'agent-3.jsonl');
    writeFileSync(transcriptPath, JSON.stringify({ type: 'user', sessionId: 's', message: { role: 'user', content: '' } }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;

    await expect(captureCommand(['claude', transcriptPath])).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    expect(existsSync(join(dataDir, 'ingest-spool'))).toBe(false);

    process.exitCode = savedExitCode;
  });
});
