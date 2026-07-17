/**
 * tests/doctor/ollama-orphans-check.test.ts (issue #399)
 *
 * checkOllamaOrphans is the unattended-schedule sibling of
 * gpu-checks.ts's CLI-only "Orphaned llama-server processes" check — see
 * src/doctor/checks/ollama-orphans.ts's module doc comment for why both
 * exist. This suite mirrors gpu-checks.test.ts's injection style: process
 * enumeration is always injected, never real OS state.
 */
import { describe, it, expect } from 'vitest';
import { checkOllamaOrphans } from '../../src/doctor/checks/ollama-orphans.js';
import type { ProcessInfo } from '../../src/doctor/probes/gpu-vram-probe.js';
import { getChecks } from '../../src/doctor/checks.js';

describe('checkOllamaOrphans (issue #399)', () => {
  it('ok:true when no llama-server processes exist', async () => {
    const check = checkOllamaOrphans(async () => [
      { pid: 100, ppid: null, name: 'ollama.exe' },
    ]);
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no llama-server processes');
  });

  it('ok:true when a llama-server process has a live Ollama parent', async () => {
    const procs: ProcessInfo[] = [
      { pid: 6384, ppid: null, name: 'ollama.exe' },
      { pid: 31436, ppid: 6384, name: 'llama-server.exe' },
    ];
    const check = checkOllamaOrphans(async () => procs);
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('all parented to a live Ollama process');
  });

  it('WARNs with the exact PID when a llama-server process has a dead/absent parent — the #399 incident signature', async () => {
    // Mirrors the live incident this canary was written for: pid 31436 with
    // dead parent 6384 (ollama itself no longer in the process table).
    const procs: ProcessInfo[] = [
      { pid: 31436, ppid: 6384, name: 'llama-server.exe' },
    ];
    const check = checkOllamaOrphans(async () => procs);
    const result = await check.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('31436');
    expect(result.message).toContain('holding VRAM indefinitely');
    expect(result.fix).toBeTruthy();
    expect(result.fix).toContain('31436');
  });

  it('WARNs when the llama-server process has no parent at all (ppid null)', async () => {
    const procs: ProcessInfo[] = [
      { pid: 555, ppid: null, name: 'llama-server' },
    ];
    const check = checkOllamaOrphans(async () => procs);
    const result = await check.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('555');
  });

  it('does not flag a llama-server whose parent is alive but is not ollama itself (reparented to a shell, e.g.)', async () => {
    const procs: ProcessInfo[] = [
      { pid: 1, ppid: null, name: 'init' },
      { pid: 999, ppid: 1, name: 'llama-server' },
    ];
    const check = checkOllamaOrphans(async () => procs);
    const result = await check.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('999');
  });

  it('reports only the orphan among a mix of legit and orphaned llama-server processes', async () => {
    const procs: ProcessInfo[] = [
      { pid: 100, ppid: null, name: 'ollama.exe' },
      { pid: 200, ppid: 100, name: 'llama-server.exe' }, // legit
      { pid: 301, ppid: 9999, name: 'llama-server.exe' }, // orphan: dead parent
    ];
    const check = checkOllamaOrphans(async () => procs);
    const result = await check.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('301');
    expect(result.message).toContain('1 of 2');
    expect(result.message).not.toMatch(/\b200\b/);
  });

  it('is inconclusive (never a silent pass) when process enumeration returns null', async () => {
    const check = checkOllamaOrphans(async () => null);
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
  });

  it('is inconclusive (never a silent pass) when process enumeration throws', async () => {
    const check = checkOllamaOrphans(async () => {
      throw new Error('enumeration boom');
    });
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.message).toContain('enumeration boom');
  });

  it('is registered in getChecks() so it participates in both the CLI doctor run and the unattended schedule', async () => {
    const checks = getChecks({ dataDir: 'unused', encryptionEnabled: false });
    const found = checks.find((c) => c.name === 'Orphaned llama-server processes (unattended canary)');
    expect(found).toBeDefined();
    expect(found!.tier).toBe('full');
  });
});
