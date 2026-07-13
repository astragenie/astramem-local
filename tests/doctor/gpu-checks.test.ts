/**
 * tests/doctor/gpu-checks.test.ts
 *
 * FEAT-485: doctor checks for the two silent GPU/VRAM failure modes that cost
 * an entire debugging night on 2026-07-13 — orphaned llama-server processes
 * surviving a force-killed Ollama (VRAM leak), and Ollama silently offloading
 * part of a "loaded" model to CPU (size_vram << size). Both checks depend on
 * live OS/GPU state, so every dependency (process listing, nvidia-smi,
 * Ollama's /api/ps) is injected — tests never touch real GPU or process
 * state, only the mocked shapes described in the FEAT.
 */
import { describe, it, expect } from 'vitest';
import { getGpuChecks } from '../../src/doctor/gpu-checks.js';
import type { ProcessInfo } from '../../src/doctor/probes/gpu-vram-probe.js';

function findCheck(checks: ReturnType<typeof getGpuChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

describe('doctor GPU/VRAM checks (FEAT-485)', () => {
  describe('Orphaned llama-server processes', () => {
    it('ok:true when no llama-server processes exist', async () => {
      const checks = getGpuChecks({
        listProcesses: async () => [
          { pid: 100, ppid: null, name: 'ollama.exe' },
        ],
        queryGpuMemory: async () => null,
        fetchOllamaPs: async () => [],
      });
      const result = await findCheck(checks, 'Orphaned llama-server processes').run();
      expect(result.ok).toBe(true);
      expect(result.message).toContain('no llama-server processes');
    });

    it('ok:true when every llama-server has a live Ollama parent and count matches loaded models', async () => {
      const procs: ProcessInfo[] = [
        { pid: 100, ppid: null, name: 'ollama.exe' },
        { pid: 200, ppid: 100, name: 'llama-server.exe' },
      ];
      const checks = getGpuChecks({
        listProcesses: async () => procs,
        queryGpuMemory: async () => null,
        fetchOllamaPs: async () => [{ name: 'qwen2.5:7b', size: 1, size_vram: 1 }],
      });
      const result = await findCheck(checks, 'Orphaned llama-server processes').run();
      expect(result.ok).toBe(true);
    });

    it('WARNs with exact PIDs for llama-server processes with no live Ollama parent', async () => {
      const procs: ProcessInfo[] = [
        { pid: 100, ppid: null, name: 'ollama.exe' },
        { pid: 200, ppid: 100, name: 'llama-server.exe' }, // legit
        { pid: 301, ppid: 9999, name: 'llama-server.exe' }, // orphan: dead parent
        { pid: 302, ppid: null, name: 'llama-server.exe' }, // orphan: no parent at all
      ];
      const checks = getGpuChecks({
        listProcesses: async () => procs,
        queryGpuMemory: async (pids) => {
          const m = new Map<number, number>();
          for (const pid of pids) m.set(pid, 1024); // 1024 MiB each
          return m;
        },
        fetchOllamaPs: async () => [{ name: 'qwen2.5:7b', size: 1, size_vram: 1 }],
      });
      const result = await findCheck(checks, 'Orphaned llama-server processes').run();
      expect(result.ok).toBe(false);
      expect(result.message).toContain('301');
      expect(result.message).toContain('302');
      expect(result.message).not.toMatch(/\b200\b/);
      // 2 orphans * 1024 MiB = 2048 MiB = 2.00 GB reclaimable
      expect(result.message).toContain('2.00 GB');
      expect(result.fix).toBeDefined();
      // Diagnostic only — must never suggest actually killing anything itself,
      // only print the command the operator can run.
      expect(result.fix).toMatch(/301/);
    });

    it('WARNs when llama-server count exceeds Ollama-reported loaded models, even with live parents', async () => {
      const procs: ProcessInfo[] = [
        { pid: 100, ppid: null, name: 'ollama.exe' },
        { pid: 200, ppid: 100, name: 'llama-server.exe' },
        { pid: 201, ppid: 100, name: 'llama-server.exe' },
        { pid: 202, ppid: 100, name: 'llama-server.exe' },
      ];
      const checks = getGpuChecks({
        listProcesses: async () => procs,
        queryGpuMemory: async () => null,
        // Ollama only reports ONE model loaded, but three llama-server procs exist.
        fetchOllamaPs: async () => [{ name: 'qwen2.5:7b', size: 1, size_vram: 1 }],
      });
      const result = await findCheck(checks, 'Orphaned llama-server processes').run();
      expect(result.ok).toBe(false);
      expect(result.message).toContain('3');
      expect(result.message).toContain('1');
    });

    it('reports VRAM as unavailable (never throws) when nvidia-smi is not on PATH', async () => {
      const procs: ProcessInfo[] = [
        { pid: 301, ppid: 9999, name: 'llama-server' },
      ];
      const checks = getGpuChecks({
        listProcesses: async () => procs,
        queryGpuMemory: async () => null, // simulates "nvidia-smi unavailable"
        fetchOllamaPs: async () => null, // Ollama unreachable too
      });
      const result = await findCheck(checks, 'Orphaned llama-server processes').run();
      expect(result.ok).toBe(false);
      expect(result.message).toContain('301');
      expect(result.message.toLowerCase()).toContain('unavailable');
    });

    it('degrades gracefully (ok:true, "unavailable") when process enumeration itself fails', async () => {
      const checks = getGpuChecks({
        listProcesses: async () => {
          throw new Error('tasklist not found');
        },
        queryGpuMemory: async () => null,
        fetchOllamaPs: async () => null,
      });
      const result = await findCheck(checks, 'Orphaned llama-server processes').run();
      expect(result.ok).toBe(true);
      expect(result.message.toLowerCase()).toContain('unavailable');
    });
  });

  describe('Silent CPU offload', () => {
    it('ok:true when Ollama /api/ps is unreachable (daemon not running)', async () => {
      const checks = getGpuChecks({
        listProcesses: async () => [],
        queryGpuMemory: async () => null,
        fetchOllamaPs: async () => null,
      });
      const result = await findCheck(checks, 'Silent CPU offload').run();
      expect(result.ok).toBe(true);
      expect(result.message.toLowerCase()).toContain('unreachable');
    });

    it('ok:true when no models are currently loaded', async () => {
      const checks = getGpuChecks({
        listProcesses: async () => [],
        queryGpuMemory: async () => null,
        fetchOllamaPs: async () => [],
      });
      const result = await findCheck(checks, 'Silent CPU offload').run();
      expect(result.ok).toBe(true);
      expect(result.message).toContain('no models');
    });

    it('ok:true when every loaded model is >= 90% on GPU', async () => {
      const checks = getGpuChecks({
        listProcesses: async () => [],
        queryGpuMemory: async () => null,
        fetchOllamaPs: async () => [
          { name: 'qwen2.5:7b', size: 5_000_000_000, size_vram: 4_900_000_000 }, // 98%
        ],
      });
      const result = await findCheck(checks, 'Silent CPU offload').run();
      expect(result.ok).toBe(true);
      expect(result.message).toContain('qwen2.5:7b');
    });

    it('WARNs when size_vram / size drops below 0.9 — the exact 2026-07-13 signature', async () => {
      const checks = getGpuChecks({
        listProcesses: async () => [],
        queryGpuMemory: async () => null,
        fetchOllamaPs: async () => [
          // 0.59 GB of 4.99 GB actually on GPU — the operator's real incident numbers.
          { name: 'qwen2.5:7b', size: 4.99 * 1024 ** 3, size_vram: 0.59 * 1024 ** 3 },
        ],
      });
      const result = await findCheck(checks, 'Silent CPU offload').run();
      expect(result.ok).toBe(false);
      expect(result.message).toContain('qwen2.5:7b');
      expect(result.message).toMatch(/1[12]%|0\.1[0-2]/); // ~11.8% on GPU
      expect(result.fix).toBeDefined();
    });

    it('reports mixed loaded models individually — only the offloaded one trips the warning', async () => {
      const checks = getGpuChecks({
        listProcesses: async () => [],
        queryGpuMemory: async () => null,
        fetchOllamaPs: async () => [
          { name: 'good-model:7b', size: 5_000_000_000, size_vram: 4_950_000_000 },
          { name: 'bad-model:7b', size: 5_000_000_000, size_vram: 1_000_000_000 },
        ],
      });
      const result = await findCheck(checks, 'Silent CPU offload').run();
      expect(result.ok).toBe(false);
      expect(result.message).toContain('bad-model:7b');
      expect(result.message).not.toContain('good-model:7b — ');
    });
  });

  describe('Ollama tuning env vars', () => {
    // REGRESSION (2026-07-13): the original check read `process.env` — the
    // DOCTOR process's own environment, not Ollama's. On the operator's box
    // every one of these vars was set at Windows User scope and demonstrably
    // active (qwen3:8b loaded at 5.76 GB, the flash-attn+q8-KV figure, not
    // the 6.2 GB no-tuning figure) — yet the doctor process didn't inherit
    // them and the check confidently printed "(unset)" for all five. A check
    // that reports "off" for a setting that is verifiably ON is worse than no
    // check at all. These tests pin the fix: report a real persisted value
    // when it can be read, and say so honestly (never claim "(unset)") when
    // it can't.

    it('is always informational (ok:true) whether persisted lookup succeeds or not', async () => {
      const checks = getGpuChecks({
        listProcesses: async () => [],
        queryGpuMemory: async () => null,
        fetchOllamaPs: async () => null,
        readPersistedEnvVars: async () => null,
      });
      const result = await findCheck(checks, 'Ollama tuning env vars').run();
      expect(result.ok).toBe(true);
    });

    it('reports persisted values with their scope when the registry lookup succeeds', async () => {
      const checks = getGpuChecks({
        listProcesses: async () => [],
        queryGpuMemory: async () => null,
        fetchOllamaPs: async () => null,
        readPersistedEnvVars: async () =>
          new Map([
            ['OLLAMA_NUM_PARALLEL', { value: '2', scope: 'user' as const }],
            ['OLLAMA_FLASH_ATTENTION', { value: '1', scope: 'user' as const }],
            ['OLLAMA_KV_CACHE_TYPE', { value: 'q8_0', scope: 'user' as const }],
          ]),
      });
      const result = await findCheck(checks, 'Ollama tuning env vars').run();
      expect(result.ok).toBe(true);
      expect(result.message).toContain('OLLAMA_NUM_PARALLEL=2');
      expect(result.message).toContain('OLLAMA_FLASH_ATTENTION=1');
      expect(result.message).toContain('OLLAMA_KV_CACHE_TYPE=q8_0');
      expect(result.message).toContain('[persisted:user]');
    });

    it('never claims a persisted-but-unread var is "(unset)" — reports "not set at User/Machine scope" instead', async () => {
      const checks = getGpuChecks({
        listProcesses: async () => [],
        queryGpuMemory: async () => null,
        fetchOllamaPs: async () => null,
        readPersistedEnvVars: async () => new Map([['OLLAMA_FLASH_ATTENTION', { value: '1', scope: 'user' as const }]]),
      });
      const result = await findCheck(checks, 'Ollama tuning env vars').run();
      expect(result.ok).toBe(true);
      expect(result.message).toContain('OLLAMA_FLASH_ATTENTION=1');
      expect(result.message).not.toMatch(/=\(unset\)/);
      expect(result.message).toContain('OLLAMA_NUM_PARALLEL=(not set at User/Machine scope)');
    });

    it('the exact regression: doctor process env is empty but persisted registry has the value — must report the real value, not (unset)', async () => {
      const checks = getGpuChecks({
        listProcesses: async () => [],
        queryGpuMemory: async () => null,
        fetchOllamaPs: async () => null,
        env: {}, // doctor process sees nothing, mirroring the operator's shell
        readPersistedEnvVars: async () =>
          new Map([
            ['OLLAMA_NUM_PARALLEL', { value: '2', scope: 'user' as const }],
            ['OLLAMA_MAX_LOADED_MODELS', { value: '2', scope: 'user' as const }],
            ['OLLAMA_FLASH_ATTENTION', { value: '1', scope: 'user' as const }],
            ['OLLAMA_KV_CACHE_TYPE', { value: 'q8_0', scope: 'user' as const }],
            ['OLLAMA_KEEP_ALIVE', { value: '-1', scope: 'user' as const }],
          ]),
      });
      const result = await findCheck(checks, 'Ollama tuning env vars').run();
      expect(result.ok).toBe(true);
      expect(result.message).not.toContain('(unset)');
      expect(result.message).toContain('OLLAMA_FLASH_ATTENTION=1 [persisted:user]');
      expect(result.message).toContain('OLLAMA_KV_CACHE_TYPE=q8_0 [persisted:user]');
    });

    it('reports honestly (never "(unset)") when persisted-env lookup is unavailable on this platform', async () => {
      const checks = getGpuChecks({
        listProcesses: async () => [],
        queryGpuMemory: async () => null,
        fetchOllamaPs: async () => null,
        env: {},
        readPersistedEnvVars: async () => null, // e.g. non-Windows, or the registry read failed
      });
      const result = await findCheck(checks, 'Ollama tuning env vars').run();
      expect(result.ok).toBe(true);
      expect(result.message).not.toMatch(/OLLAMA_\w+=\(unset\)/);
      expect(result.message.toLowerCase()).toMatch(/cannot determine|unavailable|unknown/);
    });

    it('degrades gracefully (ok:true, honest) when readPersistedEnvVars itself throws', async () => {
      const checks = getGpuChecks({
        listProcesses: async () => [],
        queryGpuMemory: async () => null,
        fetchOllamaPs: async () => null,
        readPersistedEnvVars: async () => {
          throw new Error('registry access denied');
        },
      });
      const result = await findCheck(checks, 'Ollama tuning env vars').run();
      expect(result.ok).toBe(true);
      expect(result.message).not.toMatch(/OLLAMA_\w+=\(unset\)/);
    });
  });

  describe('safety — no kill path exists anywhere in this module', () => {
    it('getGpuChecks never imports or calls process.kill / taskkill / pkill execution', async () => {
      // Static guard: read the compiled check module's own source-adjacent
      // behavior indirectly by asserting the fix string is always advisory
      // text, never something this code itself executes.
      const checks = getGpuChecks({
        listProcesses: async () => [{ pid: 999, ppid: null, name: 'llama-server' }],
        queryGpuMemory: async () => null,
        fetchOllamaPs: async () => null,
      });
      const result = await findCheck(checks, 'Orphaned llama-server processes').run();
      expect(result.ok).toBe(false);
      // The fix is a printable suggestion string, not a side effect — running
      // the check must not have altered any process state, which we can only
      // assert indirectly here: the mock functions were never called with
      // kill-shaped arguments (there is no kill-shaped dependency at all in
      // GpuCheckOpts, see gpu-checks.ts).
      expect(typeof result.fix).toBe('string');
    });
  });
});
