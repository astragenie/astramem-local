import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { waitForVersion } from '../../src/cli/wait-health.js';

/** Start a throwaway HTTP server on an ephemeral port that answers /version
 *  with `versionFor()` (re-evaluated per request so a test can flip it). */
function startServer(versionFor: () => string | null): Promise<{ server: Server; port: number }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      if (req.url === '/version') {
        const v = versionFor();
        if (v === null) { res.statusCode = 500; res.end('boom'); return; }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: v }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
    });
  });
}

describe('waitForVersion', () => {
  let server: Server | undefined;
  afterEach(() => { server?.close(); server = undefined; });

  it('returns ok when /version reports the expected version', async () => {
    const started = await startServer(() => '0.19.0-beta.0');
    server = started.server;
    const r = await waitForVersion(started.port, '0.19.0-beta.0', 3000);
    expect(r).toEqual({ ok: true, served: '0.19.0-beta.0', responded: true });
  });

  it('rides out an initially-busy /version and succeeds once it answers', async () => {
    let answered = 0;
    const started = await startServer(() => {
      // first 2 requests "fail" (500 -> not a version), then serve the match
      answered += 1;
      return answered <= 2 ? null : '0.19.0-beta.0';
    });
    server = started.server;
    const r = await waitForVersion(started.port, '0.19.0-beta.0', 5000);
    expect(r.ok).toBe(true);
    expect(answered).toBeGreaterThan(2);
  });

  it('reports responded=true with the served version on a real mismatch (not a timeout)', async () => {
    const started = await startServer(() => '0.18.0');
    server = started.server;
    const r = await waitForVersion(started.port, '0.19.0-beta.0', 800);
    expect(r.ok).toBe(false);
    expect(r.responded).toBe(true);
    expect(r.served).toBe('0.18.0');
  });

  it('reports responded=false when nothing is listening (never answered)', async () => {
    // port 1 is not listening in this env; short budget keeps the test fast
    const r = await waitForVersion(1, '0.19.0-beta.0', 800);
    expect(r.ok).toBe(false);
    expect(r.responded).toBe(false);
    expect(r.served).toBeUndefined();
  });
});
