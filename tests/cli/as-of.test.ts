// FEAT-401 AC-4: `--as-of` on the CLI resolves to the same SQL filter as the
// API `as_of` param — the CLI is a thin HTTP client (src/cli/search.ts) with
// no local filtering logic of its own, so proving the flag forwards to the
// exact `as_of` key/shape the server routes (src/server/routes/search.ts)
// parse via search/search.ts's parseAsOf + validityFilterClause IS the proof
// of one shared code path (there is no second implementation to diverge).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cliSearch, cliRecall } from '../../src/cli/search.js';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('FEAT-401 AC-4: CLI --as-of forwards the same as_of value the API consumes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cliSearch sends as_of as a GET /search query param, matching the API filter name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hits: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await cliSearch('postgres decision', { asOf: '2026-06-10T00:00:00.000Z' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.pathname).toBe('/search');
    // Same key + same value the GET /search route reads via `params.as_of`
    // and hands to parseAsOf — one shared parser, one shared search() call.
    expect(calledUrl.searchParams.get('as_of')).toBe('2026-06-10T00:00:00.000Z');
  });

  it('cliSearch omits as_of entirely when the flag is not passed (AC-2 parity on the CLI side)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hits: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await cliSearch('postgres decision', {});

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.searchParams.has('as_of')).toBe(false);
  });

  it('cliRecall sends as_of inside POST /recall body.filters, matching the API filter name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hits: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await cliRecall('postgres decision', { asOf: '2026-06-10T00:00:00.000Z' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/recall');
    const body = JSON.parse(init.body as string) as { filters?: { as_of?: string } };
    // Same key the POST /recall RecallBodySchema.filters.as_of accepts.
    expect(body.filters?.as_of).toBe('2026-06-10T00:00:00.000Z');
  });
});
