import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pluginCoexistenceProbe } from '../../../src/doctor/probes/plugin-coexistence.js';

// We mock node:fs to avoid touching the real filesystem in unit tests.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
  };
});

import { existsSync, readFileSync } from 'node:fs';

const PORT = 7777;

describe('pluginCoexistenceProbe', () => {
  beforeEach(() => {
    // Reset env and fs mocks before each test
    delete process.env.MEMORY_API_URL;
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue('{}');
  });

  afterEach(() => {
    delete process.env.MEMORY_API_URL;
  });

  it('ok:true when no env and no .mcp.json files exist', async () => {
    const result = await pluginCoexistenceProbe(PORT);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('aligned');
  });

  it('ok:true when MEMORY_API_URL points at 127.0.0.1:port', async () => {
    process.env.MEMORY_API_URL = `http://127.0.0.1:${PORT}`;
    const result = await pluginCoexistenceProbe(PORT);
    expect(result.ok).toBe(true);
  });

  it('ok:true when MEMORY_API_URL points at localhost:port', async () => {
    process.env.MEMORY_API_URL = `http://localhost:${PORT}`;
    const result = await pluginCoexistenceProbe(PORT);
    expect(result.ok).toBe(true);
  });

  it('ok:false when MEMORY_API_URL points at saas endpoint', async () => {
    process.env.MEMORY_API_URL = 'http://saas.example.com';
    const result = await pluginCoexistenceProbe(PORT);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('saas.example.com');
    expect(result.fix).toContain(`127.0.0.1:${PORT}`);
  });

  it('ok:false when MEMORY_API_URL uses wrong port', async () => {
    process.env.MEMORY_API_URL = `http://127.0.0.1:9999`;
    const result = await pluginCoexistenceProbe(PORT);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('9999');
  });

  it('ok:false when .mcp.json memory server url points elsewhere', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        mcpServers: { memory: { url: 'http://saas.example.com/v1' } },
      }),
    );
    const result = await pluginCoexistenceProbe(PORT);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('saas.example.com');
    expect(result.fix).toContain(`127.0.0.1:${PORT}`);
  });

  it('ok:true when .mcp.json memory server url matches daemon port', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        mcpServers: { memory: { url: `http://127.0.0.1:${PORT}` } },
      }),
    );
    const result = await pluginCoexistenceProbe(PORT);
    expect(result.ok).toBe(true);
  });

  it('ok:true when .mcp.json has no memory server entry', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ mcpServers: { other: { url: 'http://example.com' } } }),
    );
    const result = await pluginCoexistenceProbe(PORT);
    expect(result.ok).toBe(true);
  });

  it('ok:true when .mcp.json has memory server with no url field', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ mcpServers: { memory: { command: 'npx', args: [] } } }),
    );
    const result = await pluginCoexistenceProbe(PORT);
    expect(result.ok).toBe(true);
  });

  it('ignores .mcp.json parse errors (non-fatal)', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('not valid json {{{');
    // Should not throw; should treat as if no conflict found
    const result = await pluginCoexistenceProbe(PORT);
    expect(result.ok).toBe(true);
  });

  it('reports both env and .mcp.json mismatches in same result', async () => {
    process.env.MEMORY_API_URL = 'http://saas.example.com';
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        mcpServers: { memory: { url: 'http://other-host.com' } },
      }),
    );
    const result = await pluginCoexistenceProbe(PORT);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('saas.example.com');
    expect(result.message).toContain('other-host.com');
  });
});
