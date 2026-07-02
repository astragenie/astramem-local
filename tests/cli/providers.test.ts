import { describe, it, expect, afterEach, vi } from 'vitest';
import { providersCommand } from '../../src/cli/providers.js';

const origMock = process.env.ASTRA_MEMORY_MOCK_PROVIDERS;

afterEach(() => {
  if (origMock === undefined) delete process.env.ASTRA_MEMORY_MOCK_PROVIDERS;
  else process.env.ASTRA_MEMORY_MOCK_PROVIDERS = origMock;
  vi.restoreAllMocks();
});

describe('providersCommand', () => {
  it('shows configured providers and passes live probes in mock mode', async () => {
    process.env.ASTRA_MEMORY_MOCK_PROVIDERS = '1';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);

    await providersCommand(['--json']);

    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(output.configured.mode).toBe('mock');
    expect(typeof output.configured.llm_compaction).toBe('string');
    expect(typeof output.configured.embedding).toBe('string');
    expect(output.checks.length).toBeGreaterThan(0);
    expect(output.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(output.summary.fail).toBe(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('non-JSON mode prints a human-readable summary without throwing', async () => {
    process.env.ASTRA_MEMORY_MOCK_PROVIDERS = '1';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);

    await providersCommand([]);

    const printed = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(printed).toContain('AstraMemory Providers');
    expect(printed).toContain('Mode');
  });
});
