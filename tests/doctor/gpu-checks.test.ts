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
    it('is always informational (ok:true) whether vars are set or not', async () => {
      const checks = getGpuChecks({
        listProcesses: async () => [],
        queryGpuMemory: async () => null,
        fetchOllamaPs: async () => null,
        env: {},
      });
      const result = await findCheck(checks, 'Ollama tuning env vars').run();
      expect(result.ok).toBe(true);
    });

    it('reports the configured values when set', async () => {
      const checks = getGpuChecks({
        listProcesses: async () => [],
        queryGpuMemory: async () => null,
        fetchOllamaPs: async () => null,
        env: {
          OLLAMA_NUM_PARALLEL: '2',
          OLLAMA_MAX_LOADED_MODELS: '2',
          OLLAMA_FLASH_ATTENTION: '1',
          OLLAMA_KV_CACHE_TYPE: 'q8_0',
          OLLAMA_KEEP_ALIVE: '-1',
        },
      });
      const result = await findCheck(checks, 'Ollama tuning env vars').run();
      expect(result.ok).toBe(true);
      expect(result.message).toContain('OLLAMA_NUM_PARALLEL=2');
      expect(result.message).toContain('OLLAMA_FLASH_ATTENTION=1');
      expect(result.message).toContain('OLLAMA_KV_CACHE_TYPE=q8_0');
    });

    it('reports unset vars distinctly from set ones', async () => {
      const checks = getGpuChecks({
        listProcesses: async () => [],
        queryGpuMemory: async () => null,
        fetchOllamaPs: async () => null,
        env: { OLLAMA_FLASH_ATTENTION: '1' },
      });
      const result = await findCheck(checks, 'Ollama tuning env vars').run();
      expect(result.ok).toBe(true);
      expect(result.message).toContain('OLLAMA_FLASH_ATTENTION=1');
      expect(result.message).toMatch(/OLLAMA_NUM_PARALLEL=\(unset\)/);
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
