/**
 * tests/doctor/probes/gpu-vram-probe.test.ts
 *
 * Direct coverage for `readPersistedEnvVars` — the fix for a real incident
 * (see the function's doc comment in src/doctor/probes/gpu-vram-probe.ts):
 * `doctor` used to read the DOCTOR process's OWN `process.env`, not the
 * persisted Windows User/Machine environment, and confidently reported
 * `OLLAMA_FLASH_ATTENTION=(unset)` for a setting that was demonstrably ON.
 *
 * tests/doctor/gpu-checks.test.ts only proves `checkOllamaTuningEnvVars`
 * prefers an INJECTED stub of this function over `env` — it never exercises
 * this file's actual PowerShell-shelling / JSON-parsing / case-insensitive
 * matching logic. A bug in the PowerShell string, the JSON shape
 * assumption, or the matcher would ship completely undetected by that
 * dispatch-only test. This file closes that gap by mocking the command-exec
 * boundary (`node:child_process`'s `exec`) and `node:os`'s `platform` —
 * never shelling out to a real PowerShell/registry, ever.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type ExecOptions = { timeout?: number; windowsHide?: boolean };
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const execMock = vi.fn((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
  cb(null, '', '');
});
const platformMock = vi.fn(() => 'win32');

vi.mock('node:child_process', () => ({ exec: execMock }));
vi.mock('node:os', () => ({ platform: platformMock }));

const { readPersistedEnvVars } = await import('../../../src/doctor/probes/gpu-vram-probe.js');

/** Make the mocked `exec` succeed with the given stdout JSON string. */
function succeedWith(stdout: string) {
  execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
    cb(null, stdout, '');
  });
}

/** Make the mocked `exec` fail (non-zero exit / command not found). */
function failWith(message: string) {
  execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
    cb(new Error(message), '', message);
  });
}

describe('readPersistedEnvVars', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformMock.mockReturnValue('win32');
    execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => cb(null, '', ''));
  });

  it('parses a realistic PowerShell JSON payload into the right value AND the right scope', async () => {
    succeedWith(JSON.stringify({
      User: { OLLAMA_FLASH_ATTENTION: '1' },
      Machine: { OLLAMA_NUM_PARALLEL: '4', PATH: 'C:\\Windows\\system32' },
    }));

    const result = await readPersistedEnvVars(['OLLAMA_FLASH_ATTENTION', 'OLLAMA_NUM_PARALLEL', 'OLLAMA_KEEP_ALIVE']);

    expect(result).not.toBeNull();
    expect(result!.get('OLLAMA_FLASH_ATTENTION')).toEqual({ value: '1', scope: 'user' });
    expect(result!.get('OLLAMA_NUM_PARALLEL')).toEqual({ value: '4', scope: 'machine' });
    // Requested but genuinely absent from both scopes: no entry, not a fabricated '(unset)' value.
    expect(result!.has('OLLAMA_KEEP_ALIVE')).toBe(false);
  });

  it('shells out via PowerShell reading [Environment]::GetEnvironmentVariables for User AND Machine scope', async () => {
    succeedWith(JSON.stringify({ User: {}, Machine: {} }));
    await readPersistedEnvVars(['OLLAMA_FLASH_ATTENTION']);

    expect(execMock).toHaveBeenCalledTimes(1);
    const cmd = execMock.mock.calls[0]![0] as string;
    expect(cmd).toContain('powershell');
    expect(cmd).toContain("GetEnvironmentVariables('User')");
    expect(cmd).toContain("GetEnvironmentVariables('Machine')");
  });

  it('User scope wins over Machine scope when the same variable is set at both', async () => {
    succeedWith(JSON.stringify({
      User: { OLLAMA_KEEP_ALIVE: '-1' },
      Machine: { OLLAMA_KEEP_ALIVE: '5m' },
    }));

    const result = await readPersistedEnvVars(['OLLAMA_KEEP_ALIVE']);

    expect(result!.get('OLLAMA_KEEP_ALIVE')).toEqual({ value: '-1', scope: 'user' });
  });

  it('matches keys case-insensitively (registry casing is not guaranteed)', async () => {
    succeedWith(JSON.stringify({
      User: { ollama_flash_attention: '1' },
      Machine: {},
    }));

    const result = await readPersistedEnvVars(['OLLAMA_FLASH_ATTENTION']);

    expect(result!.get('OLLAMA_FLASH_ATTENTION')).toEqual({ value: '1', scope: 'user' });
  });

  it('matches keys case-insensitively at Machine scope too', async () => {
    succeedWith(JSON.stringify({
      User: {},
      Machine: { Ollama_Kv_Cache_Type: 'q8_0' },
    }));

    const result = await readPersistedEnvVars(['OLLAMA_KV_CACHE_TYPE']);

    expect(result!.get('OLLAMA_KV_CACHE_TYPE')).toEqual({ value: 'q8_0', scope: 'machine' });
  });

  it('returns null on malformed (unparseable) JSON — never a fabricated value', async () => {
    succeedWith('{not valid json at all');

    const result = await readPersistedEnvVars(['OLLAMA_FLASH_ATTENTION']);

    expect(result).toBeNull();
  });

  it('returns null when the command succeeds but stdout is empty', async () => {
    succeedWith('   \n  ');

    const result = await readPersistedEnvVars(['OLLAMA_FLASH_ATTENTION']);

    expect(result).toBeNull();
  });

  /**
   * `null` and an EMPTY MAP mean different things, and conflating them
   * reintroduces the very bug this function exists to fix.
   *
   *   empty Map  = "I looked, and they are genuinely not set."   -> caller prints "(not set)"
   *   null       = "I could not look."                            -> caller prints "cannot determine"
   *
   * An earlier version cast the parsed JSON to `{User?, Machine?}` and returned an
   * empty Map for ANY shape lacking those keys. The caller then rendered that as a
   * confident "(not set at User/Machine scope)" — a confident FALSE CLAIM, which is
   * precisely the failure the persisted-env read was written to eliminate (doctor
   * used to print "(unset)" for OLLAMA_* vars that were demonstrably active).
   * Same bug, narrower door. These two tests pin the honest contract.
   */
  it('returns null — NOT an empty map — when the JSON has no User/Machine keys at all', async () => {
    // The real PowerShell script always emits both keys on success
    // (GetEnvironmentVariables returns a hashtable even when empty), so this is a
    // shape we should never see. That is exactly why it must fail LOUDLY-honest
    // rather than quietly-wrong: if it ever happens (a PS error object, a future
    // Windows shape change), we could not look, and must say so.
    succeedWith(JSON.stringify({ notUserOrMachine: true }));

    const result = await readPersistedEnvVars(['OLLAMA_FLASH_ATTENTION']);

    expect(result).toBeNull();
  });

  it('returns null on a totally unexpected top-level shape (JSON array instead of an object)', async () => {
    succeedWith(JSON.stringify(['unexpected', 'array', 'shape']));

    const result = await readPersistedEnvVars(['OLLAMA_FLASH_ATTENTION']);

    expect(result).toBeNull();
  });

  it('still returns an EMPTY MAP (not null) when the scopes are present but genuinely empty', async () => {
    // The distinction that matters: here we DID look, and the vars really are unset.
    // The caller is entitled to say "(not set)" — that claim is true.
    succeedWith(JSON.stringify({ User: {}, Machine: {} }));

    const result = await readPersistedEnvVars(['OLLAMA_FLASH_ATTENTION']);

    expect(result).not.toBeNull();
    expect(result!.size).toBe(0);
  });

  it('returns null on non-Windows platforms and never shells out at all', async () => {
    platformMock.mockReturnValue('linux');

    const result = await readPersistedEnvVars(['OLLAMA_FLASH_ATTENTION']);

    expect(result).toBeNull();
    expect(execMock).not.toHaveBeenCalled();
  });

  it('returns null (never throws) when the exec command itself fails (not found / non-zero exit)', async () => {
    failWith('powershell: command not found');

    const result = await readPersistedEnvVars(['OLLAMA_FLASH_ATTENTION']);

    expect(result).toBeNull();
  });
});
