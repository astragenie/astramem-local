/**
 * Synthetic local upstream for the proxy bench (FEAT-458 W1a, S1-AC-3).
 * A trivial `node:http` server returning canned bytes — never a real LLM
 * provider, never network egress (binds 127.0.0.1 only, ephemeral port).
 * This is the ONLY thing either bench distribution (direct or proxied)
 * talks to; the "direct" distribution hits this server directly, the
 * "proxied" distribution hits it through the proxy under test, so the
 * upstream's own behavior must be identical (and cheap/instant by default)
 * across both legs for the delta to isolate proxy overhead specifically.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface UpstreamStubOpts {
  /** Bytes in the canned response body. Default 1024 (a small, realistic
   *  chat-completion-ish JSON response size). */
  bodySize?: number;
  /** Artificial handler delay before responding, simulating upstream
   *  processing time. Default 0 (respond as fast as possible). */
  delayMs?: number;
  /** Fill byte for the canned body. Default 'x'. */
  fillChar?: string;
}

export interface UpstreamStubHandle {
  port: number;
  baseUrl: string;
  /** Count of requests served since start — lets tests/bench assert the
   *  proxy actually forwarded traffic rather than short-circuiting. */
  requestCount(): number;
  close(): Promise<void>;
}

export async function startUpstreamStub(opts: UpstreamStubOpts = {}): Promise<UpstreamStubHandle> {
  const bodySize = opts.bodySize ?? 1024;
  const delayMs = opts.delayMs ?? 0;
  const fillChar = opts.fillChar ?? 'x';
  const body = Buffer.alloc(bodySize, fillChar);
  let count = 0;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    count++;
    // Drain the request body so keep-alive client connections never hang
    // waiting on a request the handler doesn't read.
    req.resume();
    const respond = (): void => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
      });
      res.end(body);
    };
    if (delayMs > 0) setTimeout(respond, delayMs);
    else respond();
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    requestCount: () => count,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}
