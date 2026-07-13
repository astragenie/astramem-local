// FEAT-423: CLI `--project` on search/recall/remember — thin HTTP clients
// (src/cli/search.ts), same pattern as tests/cli/entity.test.ts. Proves the
// flag reaches the same filter key the daemon routes already consume; the
// reporter's "returns everything" no-op was a missing client wire, not a
// server gap (POST /recall has honored filters.project since the original
// search commit f0abbbe).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cliSearch, cliRecall, cliRemember } from '../../src/cli/search.js';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('CLI --project forwards to the filter key the server routes consume', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cliSearch sends project as a GET /search query param', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hits: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await cliSearch('ingest concurrency', { project: 'runner-plugin' });

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.pathname).toBe('/search');
    expect(calledUrl.searchParams.get('project')).toBe('runner-plugin');
  });

  it('cliSearch omits project entirely when the flag is not passed (unscoped = all)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hits: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await cliSearch('ingest concurrency', {});

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.searchParams.has('project')).toBe(false);
  });

  it('cliRecall sends project inside POST /recall body.filters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hits: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await cliRecall('what did we decide', { project: 'runner-plugin' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/recall');
    const body = JSON.parse(init.body as string) as { filters?: { project?: string } };
    expect(body.filters?.project).toBe('runner-plugin');
  });

  it('cliRecall omits filters entirely when no project (or other) flag is passed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hits: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await cliRecall('what did we decide', {});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { filters?: unknown };
    expect(body.filters).toBeUndefined();
  });

  it('cliSearch sends agent as a GET /search query param', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hits: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await cliSearch('prior review lessons', { agent: 'crew:reviewer' });

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.searchParams.get('agent')).toBe('crew:reviewer');
  });

  it('cliRecall sends agent inside POST /recall body.filters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hits: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await cliRecall('prior review lessons', { agent: 'crew:reviewer' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { filters?: { agent?: string } };
    expect(body.filters?.agent).toBe('crew:reviewer');
  });

  it('cliRecall carries project + agent together in one filters object', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hits: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await cliRecall('what did we decide', { project: 'runner-plugin', agent: 'crew:reviewer' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { filters?: { project?: string; agent?: string } };
    expect(body.filters).toEqual({ project: 'runner-plugin', agent: 'crew:reviewer' });
  });

  it('cliRemember persists project via POST /remember body.metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'm1', ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await cliRemember('the loop dispatches builders', { type: 'fact', project: 'runner-plugin' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/remember');
    const body = JSON.parse(init.body as string) as { metadata?: { project?: string } };
    expect(body.metadata?.project).toBe('runner-plugin');
  });

  it('cliRemember persists project + agent together via POST /remember body.metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'm2', ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await cliRemember('reviewer flagged a null deref', {
      type: 'lesson', project: 'runner-plugin', agent: 'crew:reviewer',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { metadata?: { project?: string; agent?: string } };
    expect(body.metadata).toEqual({ project: 'runner-plugin', agent: 'crew:reviewer' });
  });

  it('cliRemember omits metadata entirely when neither project nor agent nor repo is passed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'm3', ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await cliRemember('a plain fact', { type: 'fact' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { metadata?: unknown };
    expect(body.metadata).toBeUndefined();
  });
});
