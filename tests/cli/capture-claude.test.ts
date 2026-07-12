// FEAT-449 — `astramem-local capture claude <transcript-path>` CLI wiring.
//
// AC-3: a missing/unreadable transcript must fail SOFT — exactly one
// warning, nothing spooled, non-zero process.exitCode, no throw and no
// process.exit() mid-flight (Windows UV_HANDLE_CLOSING risk).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureCommand } from '../../src/cli/capture.js';
import { listSpoolFiles } from '../../src/ingest/spool.js';
import { defaultConfig } from '../../src/config/config.js';
import { defaultConfigDir } from '../../src/config/datadir.js';
import { writeConfig } from '../../src/config/writer.js';
import { openRuntimeDb } from '../../src/cli/open-runtime-db.js';
import { MemoryRepo } from '../../src/storage/memories.js';

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

/** Redirects the OS config dir (APPDATA / XDG_CONFIG_HOME) into a temp root
 *  and writes a config.yaml there — so `resolveRuntimeConfig()` (the
 *  --auto-capture gate's config source) reads a hermetic, test-controlled
 *  config rather than the real machine's. */
function withAutoCaptureConfig(
  configRoot: string,
  enabled: boolean,
  relevanceGate?: Partial<{ minChars: number; maxBytes: number; dedupWindow: number }>,
): void {
  const envVar = process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';
  savedEnv[envVar] = process.env[envVar];
  process.env[envVar] = configRoot;
  const cfg = defaultConfig();
  cfg.capture.autoCapture.enabled = enabled;
  if (relevanceGate) Object.assign(cfg.capture.autoCapture.relevanceGate, relevanceGate);
  writeConfig(cfg, join(defaultConfigDir(), 'config.yaml'));
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

// FEAT-455 / ADR-012 decision 4: --auto-capture is gated on
// config.capture.autoCapture.enabled (default false) and filters turns
// through the relevance gate before spooling.
describe('capture claude --auto-capture (FEAT-455 / ADR-012)', () => {
  const SESSION = [
    JSON.stringify({ type: 'user', sessionId: 'sess-auto-1', cwd: '/home/u/proj-auto', message: { role: 'user', content: 'what vector store should we use for v1 storage?' } }),
    JSON.stringify({ type: 'assistant', sessionId: 'sess-auto-1', cwd: '/home/u/proj-auto', message: { role: 'assistant', content: [{ type: 'text', text: 'sqlite-vec is the right call here, no network dependency' }] } }),
  ].join('\n');

  it('disabled (default): --auto-capture is a soft no-op, nothing spooled', async () => {
    const dataDir = tempDir('capture-auto-off-data-');
    const configRoot = tempDir('capture-auto-off-cfg-');
    withDataDir(dataDir);
    withAutoCaptureConfig(configRoot, false);
    const transcriptDir = tempDir('capture-auto-off-src-');
    const transcriptPath = join(transcriptDir, 'agent.jsonl');
    writeFileSync(transcriptPath, SESSION);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;

    await captureCommand(['claude', transcriptPath, '--auto-capture']);

    expect(process.exitCode).toBeUndefined();
    expect(listSpoolFiles(dataDir)).toEqual([]);
    expect(logSpy.mock.calls.some(c => String(c[0]).includes('disabled'))).toBe(true);

    process.exitCode = savedExitCode;
  });

  it('enabled: spools an envelope carrying capture_source="auto_capture"', async () => {
    const dataDir = tempDir('capture-auto-on-data-');
    const configRoot = tempDir('capture-auto-on-cfg-');
    withDataDir(dataDir);
    withAutoCaptureConfig(configRoot, true);
    const transcriptDir = tempDir('capture-auto-on-src-');
    const transcriptPath = join(transcriptDir, 'agent.jsonl');
    writeFileSync(transcriptPath, SESSION);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await captureCommand(['claude', transcriptPath, '--auto-capture']);

    const files = listSpoolFiles(dataDir);
    expect(files).toHaveLength(1);
    const envelope = JSON.parse(readFileSync(files[0]!.path, 'utf8')) as { capture_source?: string; turns: unknown[] };
    expect(envelope.capture_source).toBe('auto_capture');
    expect(envelope.turns).toHaveLength(2);
  });

  // 2026-07-12 doctor-canary provenance fix: the close-capture hook never
  // passes --auto-capture, so a plain "capture claude" invocation now stamps
  // 'hook_close' (previously omitted capture_source entirely, which left
  // every close-capture memory with capture_source=NULL and made the doctor
  // "Auto-capture" canary permanently WARN once auto-capture was enabled).
  it('plain "capture claude" (no --auto-capture flag) sets capture_source="hook_close", regardless of config', async () => {
    const dataDir = tempDir('capture-auto-plain-data-');
    const configRoot = tempDir('capture-auto-plain-cfg-');
    withDataDir(dataDir);
    withAutoCaptureConfig(configRoot, true);
    const transcriptDir = tempDir('capture-auto-plain-src-');
    const transcriptPath = join(transcriptDir, 'agent.jsonl');
    writeFileSync(transcriptPath, SESSION);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await captureCommand(['claude', transcriptPath]);

    const files = listSpoolFiles(dataDir);
    expect(files).toHaveLength(1);
    const envelope = JSON.parse(readFileSync(files[0]!.path, 'utf8')) as { capture_source?: string };
    expect(envelope.capture_source).toBe('hook_close');
  });

  it('enabled: the relevance gate filters out a too-short turn before spooling', async () => {
    const dataDir = tempDir('capture-auto-gate-data-');
    const configRoot = tempDir('capture-auto-gate-cfg-');
    withDataDir(dataDir);
    withAutoCaptureConfig(configRoot, true, { minChars: 50 });
    const transcriptDir = tempDir('capture-auto-gate-src-');
    const transcriptPath = join(transcriptDir, 'agent.jsonl');
    // First turn is short (< 50 chars, gated); second is long enough to pass.
    writeFileSync(transcriptPath, SESSION);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await captureCommand(['claude', transcriptPath, '--auto-capture']);

    const files = listSpoolFiles(dataDir);
    expect(files).toHaveLength(1);
    const envelope = JSON.parse(readFileSync(files[0]!.path, 'utf8')) as { turns: Array<{ role: string; text: string }> };
    // "what vector store should we use for v1 storage?" is 47 chars — gated
    // by minChars:50; the assistant turn (56 chars) survives.
    expect(envelope.turns).toHaveLength(1);
    expect(envelope.turns[0]!.role).toBe('assistant');
  });

  it('enabled: every turn gated out behaves like the existing "no usable turns" no-op', async () => {
    const dataDir = tempDir('capture-auto-allgated-data-');
    const configRoot = tempDir('capture-auto-allgated-cfg-');
    withDataDir(dataDir);
    withAutoCaptureConfig(configRoot, true, { minChars: 1000 });
    const transcriptDir = tempDir('capture-auto-allgated-src-');
    const transcriptPath = join(transcriptDir, 'agent.jsonl');
    writeFileSync(transcriptPath, SESSION);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;

    await expect(captureCommand(['claude', transcriptPath, '--auto-capture'])).resolves.toBeUndefined();

    expect(process.exitCode).toBeUndefined();
    expect(listSpoolFiles(dataDir)).toEqual([]);

    process.exitCode = savedExitCode;
  });
});

// FEAT-455 / ADR-012 decision 4: `capture auto-capture disable` — disable is
// always immediate (config write); purge is offered, not forced.
describe('capture auto-capture disable (FEAT-455 / ADR-012 decision 4)', () => {
  it('persists capture.autoCapture.enabled=false to config.yaml', async () => {
    const dataDir = tempDir('capture-disable-data-');
    const configRoot = tempDir('capture-disable-cfg-');
    withDataDir(dataDir);
    withAutoCaptureConfig(configRoot, true);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await captureCommand(['auto-capture', 'disable', '--keep']);

    const written = readFileSync(join(defaultConfigDir(), 'config.yaml'), 'utf8');
    expect(written).toContain('enabled: false');
  });

  it('no auto-captured memories found — reports nothing to purge, exits cleanly', async () => {
    const dataDir = tempDir('capture-disable-empty-data-');
    const configRoot = tempDir('capture-disable-empty-cfg-');
    withDataDir(dataDir);
    withAutoCaptureConfig(configRoot, true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;

    await captureCommand(['auto-capture', 'disable']);

    expect(process.exitCode).toBeUndefined();
    expect(logSpy.mock.calls.some(c => String(c[0]).includes('nothing to purge'))).toBe(true);

    process.exitCode = savedExitCode;
  });

  it('--keep declines the purge — auto-captured memories remain valid and queryable', async () => {
    const dataDir = tempDir('capture-disable-keep-data-');
    const configRoot = tempDir('capture-disable-keep-cfg-');
    withDataDir(dataDir);
    withAutoCaptureConfig(configRoot, true);
    const { db } = openRuntimeDb();
    const id = new MemoryRepo(db).insert({
      type: 'fact', text: 'auto atom', normalized_text: 'auto atom',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: 'auto-disable-keep-hash', source_hash: null, capture_source: 'auto_capture',
    });
    db.close();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await captureCommand(['auto-capture', 'disable', '--keep']);

    const { db: verifyDb } = openRuntimeDb();
    const row = verifyDb.prepare('SELECT valid_to FROM memories WHERE id = ?').get(id) as { valid_to: number | null };
    verifyDb.close();
    expect(row.valid_to).toBeNull();
  });

  it('--purge with no daemon reachable: reports failures and a non-zero exit code, config stays disabled', async () => {
    const dataDir = tempDir('capture-disable-purge-data-');
    const configRoot = tempDir('capture-disable-purge-cfg-');
    withDataDir(dataDir);
    withAutoCaptureConfig(configRoot, true);
    const { db } = openRuntimeDb();
    new MemoryRepo(db).insert({
      type: 'fact', text: 'auto atom to purge', normalized_text: 'auto atom to purge',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: 'auto-disable-purge-hash', source_hash: null, capture_source: 'auto_capture',
    });
    db.close();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    savedEnv['ASTRA_MEMORY_URL'] = process.env['ASTRA_MEMORY_URL'];
    process.env['ASTRA_MEMORY_URL'] = 'http://127.0.0.1:1'; // unroutable — guaranteed connection failure

    await captureCommand(['auto-capture', 'disable', '--purge']);

    expect(process.exitCode).toBe(1);
    const written = readFileSync(join(defaultConfigDir(), 'config.yaml'), 'utf8');
    expect(written).toContain('enabled: false');

    process.exitCode = savedExitCode;
  });

  it('unknown subcommand exits non-zero', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);

    await captureCommand(['auto-capture', 'bogus']);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
