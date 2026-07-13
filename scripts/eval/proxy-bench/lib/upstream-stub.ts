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
  /** Fill byte for the canned body. Default 'x'. Ignored when `chatShape`
   *  is true. */
  fillChar?: string;
  /**
   * FEAT-458 S4b: when true, respond with a REAL OpenAI chat-completion JSON
   * envelope (`{choices:[{message:{role:'assistant',content:'<padding>'}}]}`,
   * padded to approximately `bodySize`) instead of a raw byte blob. Needed
   * so `src/capture/proxy.ts`'s `extractResponseTurn` recognizes the body as
   * an assistant turn and the capture fork's synchronous spool write
   * (`writeToSpool`) actually fires. A raw byte blob (the default) parses as
   * neither JSON nor SSE, produces zero turns, and `finishCapture` returns
   * before ever touching disk — which would make a capture-ON bench run
   * that never exercises the real write path a false PASS. Default false —
   * every other caller of this stub (forward-path-only S2 bench, the raw
   * synthetic byte tests below) keeps today's behavior unchanged.
   */
  chatShape?: boolean;
}

export interface UpstreamStubHandle {
  port: number;
  baseUrl: string;
  /** Count of requests served since start — lets tests/bench assert the
   *  proxy actually forwarded traffic rather than short-circuiting. */
  requestCount(): number;
  close(): Promise<void>;
}

/** Real OpenAI chat-completion JSON shape, `content` padded so the total
 *  body is approximately `targetSize` bytes — exact match isn't needed
 *  (unlike the raw-fill mode, nothing asserts an exact byte count for
 *  `chatShape`), just something `extractResponseTurn` recognizes as a
 *  non-empty assistant turn. */
function buildChatShapeBody(targetSize: number): Buffer {
  const envelopeOverheadEstimate = 140; // JSON scaffolding around `content`
  const padLength = Math.max(1, targetSize - envelopeOverheadEstimate);
  return Buffer.from(JSON.stringify({
    id: 'proxy-bench-stub-completion',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'x'.repeat(padLength) }, finish_reason: 'stop' }],
  }), 'utf8');
}

export async function startUpstreamStub(opts: UpstreamStubOpts = {}): Promise<UpstreamStubHandle> {
  const bodySize = opts.bodySize ?? 1024;
  const delayMs = opts.delayMs ?? 0;
  const fillChar = opts.fillChar ?? 'x';
  const body = opts.chatShape ? buildChatShapeBody(bodySize) : Buffer.alloc(bodySize, fillChar);
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
