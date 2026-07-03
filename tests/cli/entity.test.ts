// FEAT-402 slice 2: CLI `--entity` on search/recall, and `entities list|show`
// — thin HTTP clients (src/cli/search.ts), same pattern as tests/cli/as-of.test.ts.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cliSearch, cliRecall, cliEntitiesList, cliEntitiesShow } from '../../src/cli/search.js';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('CLI --entity forwards to the same filter key the server routes consume', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cliSearch sends entity as a GET /search query param', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hits: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await cliSearch('postgres decision', { entity: 'postgres' });

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe('/search');
    expect(calledUrl.searchParams.get('entity')).toBe('postgres');
  });

  it('cliSearch omits entity entirely when the flag is not passed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hits: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await cliSearch('postgres decision', {});

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.has('entity')).toBe(false);
  });

  it('cliRecall sends entity inside POST /recall body.filters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hits: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await cliRecall('postgres decision', { entity: 'postgres' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/recall');
    const body = JSON.parse(init.body as string) as { filters?: { entity?: string } };
    expect(body.filters?.entity).toBe('postgres');
  });
});

describe('CLI entities list|show (AC-5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cliEntitiesList calls GET /entities?q=', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ entities: [{ id: 'e1', name: 'postgres', kind: 'tech' }] })
    );
    vi.stubGlobal('fetch', fetchMock);

    await cliEntitiesList('post', {});

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe('/entities');
    expect(calledUrl.searchParams.get('q')).toBe('post');
  });

  it('cliEntitiesList omits q when query is empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ entities: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await cliEntitiesList('', {});

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.has('q')).toBe(false);
  });

  it('cliEntitiesShow calls GET /entities/:id/memories', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ entity: { id: 'e1', name: 'postgres', kind: 'tech' }, memories: [] })
    );
    vi.stubGlobal('fetch', fetchMock);

    await cliEntitiesShow('e1');

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe('/entities/e1/memories');
  });
});
