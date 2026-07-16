// #372/#171: consolidate CLI gains pagination flags on `proposals` and a
// filtered bulk mode on `accept`/`reject` (extending the pre-existing
// `--all`). Thin HTTP client (src/cli/consolidate.ts talks to the daemon
// over fetch, same pattern as tests/cli/as-of.test.ts /
// tests/cli/project-filter.test.ts) — these tests prove the CLI forwards
// the right query params / body shapes, not daemon-side behavior (already
// covered by tests/consolidate/consolidate.test.ts and
// tests/mcp/server.test.ts).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { consolidateCommand } from '../../src/cli/consolidate.js';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('consolidateCommand proposals — limit/offset/min-confidence/kind forwarding', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('forwards --kind/--limit/--offset/--min-confidence as GET query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ proposals: [], total: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await consolidateCommand(['proposals', '--kind', 'merge', '--limit', '5', '--offset', '10', '--min-confidence', '0.9']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.pathname).toBe('/consolidation/proposals');
    expect(calledUrl.searchParams.get('status')).toBe('pending');
    expect(calledUrl.searchParams.get('kind')).toBe('merge');
    expect(calledUrl.searchParams.get('limit')).toBe('5');
    expect(calledUrl.searchParams.get('offset')).toBe('10');
    expect(calledUrl.searchParams.get('min_confidence')).toBe('0.9');
    expect(logSpy).toHaveBeenCalledWith('No pending consolidation proposals.');
  });

  it('omits kind/limit/offset/min_confidence entirely when no flags are passed (pre-existing behavior)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ proposals: [], total: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await consolidateCommand(['proposals']);

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.searchParams.has('kind')).toBe(false);
    expect(calledUrl.searchParams.has('limit')).toBe(false);
    expect(calledUrl.searchParams.has('offset')).toBe(false);
    expect(calledUrl.searchParams.has('min_confidence')).toBe(false);
  });
});

describe('consolidateCommand accept — single id vs. bulk (--all / --kind / --min-confidence)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('accept <id> (no filters) posts an empty body — not { bulk: true }', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'p1', status: 'accepted' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await consolidateCommand(['accept', 'p1', '--json']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/consolidation/proposals/p1/accept');
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('accept --all fetches the full pending set and accepts each with { bulk: true }', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === '/consolidation/proposals') {
        return jsonResponse({ proposals: [{ id: 'p1' }, { id: 'p2' }], total: 2 });
      }
      return jsonResponse({ status: 'accepted' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await consolidateCommand(['accept', '--all', '--json']);

    const acceptCalls = fetchMock.mock.calls.filter(([url]) => (url as string).includes('/accept'));
    expect(acceptCalls).toHaveLength(2);
    for (const [, init] of acceptCalls) {
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({ bulk: true });
    }
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ accepted: 2, skipped: [] }));
  });

  it('accept --kind merge --min-confidence 0.9 (no --all) is bulk mode: filters forwarded to the list call, matches bulk-accepted', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === '/consolidation/proposals') {
        expect(u.searchParams.get('kind')).toBe('merge');
        expect(u.searchParams.get('min_confidence')).toBe('0.9');
        return jsonResponse({ proposals: [{ id: 'p1' }], total: 1 });
      }
      return jsonResponse({ status: 'accepted' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await consolidateCommand(['accept', '--kind', 'merge', '--min-confidence', '0.9', '--json']);

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ accepted: 1, skipped: [] }));
  });

  it('accept bulk mode skips (not aborts) on a lifecycle conflict from one proposal', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === '/consolidation/proposals') {
        return jsonResponse({ proposals: [{ id: 'p1' }, { id: 'p2' }], total: 2 });
      }
      if (u.pathname === '/consolidation/proposals/p1/accept') {
        return jsonResponse({ error: 'already resolved' }, false, 409);
      }
      return jsonResponse({ status: 'accepted' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await consolidateCommand(['accept', '--all', '--json']);

    const logged = JSON.parse(logSpy.mock.calls[0]![0] as string) as { accepted: number; skipped: Array<{ id: string }> };
    expect(logged.accepted).toBe(1);
    expect(logged.skipped).toEqual([{ id: 'p1', reason: expect.stringContaining('409') as unknown as string }]);
  });
});

describe('consolidateCommand reject — single id keeps its shape, bulk mode is additive (#372)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reject <id> keeps the pre-existing { rejected: <id> } JSON shape (no regression)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'p1', status: 'rejected' }));
    vi.stubGlobal('fetch', fetchMock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await consolidateCommand(['reject', 'p1', '--json']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(fetchMock.mock.calls[0]![0] as string).pathname).toBe('/consolidation/proposals/p1/reject');
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ rejected: 'p1' }));
  });

  it('reject --kind merge (bulk mode) reports a { rejected: <count>, skipped } shape', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === '/consolidation/proposals') {
        expect(u.searchParams.get('kind')).toBe('merge');
        return jsonResponse({ proposals: [{ id: 'p1' }, { id: 'p2' }], total: 2 });
      }
      return jsonResponse({ status: 'rejected' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await consolidateCommand(['reject', '--kind', 'merge', '--json']);

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ rejected: 2, skipped: [] }));
  });

  it('reject <id> single mode requires an id when no bulk filter is given', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(consolidateCommand(['reject'])).rejects.toThrow('exit');

    expect(errSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
