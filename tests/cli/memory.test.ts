// FEAT-416: `astramem-local memory restore <id>` — thin HTTP client
// (src/cli/memory.ts), same pattern as tests/cli/entity.test.ts.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cliMemoryRestore } from '../../src/cli/memory.js';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('CLI memory restore (FEAT-416)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('calls POST /memory/:id/restore and prints success on 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cliMemoryRestore('mem-1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/memory/mem-1/restore');
    expect(init.method).toBe('POST');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('mem-1'));
  });

  it('exits 1 with a clear message on 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'not found', id: 'nope' }, 404));
    vi.stubGlobal('fetch', fetchMock);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); }) as never;

    await expect(cliMemoryRestore('nope')).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('no such memory'));
  });

  it('exits 1 with a clear message on 409 (never-archived)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'memory mem-2 is not archived', id: 'mem-2' }, 409));
    vi.stubGlobal('fetch', fetchMock);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); }) as never;

    await expect(cliMemoryRestore('mem-2')).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('not archived'));
  });

  it('requires an id argument', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); }) as never;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(cliMemoryRestore('')).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('id argument is required'));
  });
});
