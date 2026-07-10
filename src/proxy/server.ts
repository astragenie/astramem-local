/**
 * Core LLM proxy forward path (FEAT-458 S2, ADR-013 "Accepted").
 *
 * Byte-transparent passthrough for an OpenAI-compatible `/v1/chat/completions`
 * client — the forward path never inspects the request path, method, or body
 * content, it only reads the bind target and the configured upstream. Built
 * on raw `node:http`/`node:https` rather than Fastify: Fastify's request
 * lifecycle parses/buffers a request before a handler ever sees it, which is
 * exactly the parse-mutate-reserialize step ADR-013 Decision 1 forbids for
 * this hot path. A single chunk-pipe from the incoming client request to the
 * outgoing upstream request, and from the upstream response back to the
 * client response, is the only way to guarantee no intermediate
 * representation of the body is ever constructed — true for a plain JSON
 * body and an SSE stream alike, since `.pipe()` forwards each chunk as soon
 * as it arrives rather than waiting for the stream to end.
 *
 * ZERO capture code lives in this module or anything it imports. S2 is the
 * capture-free proxy slice (FEAT-458 S2-AC-5) — no import from src/capture,
 * src/ingest, or src/distill anywhere in this file's import graph. The
 * capture fork is FEAT-458 S3's own module, added alongside this one, never
 * inside it.
 */
import { createServer as createHttpServer, request as httpRequestFn } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import { request as httpsRequestFn } from 'node:https';
import { isLoopbackHost } from '../server/lib/network.js';

export interface ProxyServeOpts {
  port: number;
  host: string;
  upstream: string;
}

export interface ProxyHandle {
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

/**
 * Hop-by-hop headers (RFC 7230 §6.1) describe THIS transport hop, not the
 * payload — forwarding them verbatim to the other leg would produce a broken
 * second hop (a stale `content-length` after re-chunking, `connection: close`
 * propagated to the wrong side, a `host` that no longer names the upstream).
 * Everything else — including `authorization` and any other credential-shaped
 * header — passes through unfiltered: ADR-013 Decision 4 requires provider
 * keys to reach the upstream unchanged, never inspected or logged here.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

function filterHopByHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/** ADR-013 review decision 2: loopback-only bind in v1, no shared-secret
 *  escape hatch. Shared with the CLI layer (src/cli/proxy.ts) so both the
 *  library entry point and the CLI enforce the identical predicate — the
 *  same `isLoopbackHost` the main daemon's own bind/auth boundary uses
 *  (src/server/lib/network.ts), not a second, possibly-drifting copy. */
export function assertLoopbackBind(host: string): void {
  if (!isLoopbackHost(host)) {
    throw new Error(`proxy: refusing non-loopback bind (${host}) — v1 is loopback-only per ADR-013`);
  }
}

function forwardOneRequest(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  upstreamUrl: URL,
): void {
  const isHttps = upstreamUrl.protocol === 'https:';
  const requestFn = isHttps ? httpsRequestFn : httpRequestFn;
  const forwardHeaders = filterHopByHop(clientReq.headers);

  const upstreamReq = requestFn({
    protocol: upstreamUrl.protocol,
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || (isHttps ? 443 : 80),
    // TLS to upstream is never downgraded (ADR-013 Decision 4) — https:
    // upstream URLs go through node:https with default certificate
    // validation; there is no insecure-TLS escape hatch here.
    path: clientReq.url ?? '/',
    method: clientReq.method,
    headers: { ...forwardHeaders, host: upstreamUrl.host },
  }, (upstreamRes) => {
    // ADR-013 Decision 2 (fail-open forwarding) / S2-AC-3: relay status,
    // headers, and body exactly as received — no proxy-side rewriting of an
    // upstream error response, same code path as a 2xx.
    clientRes.writeHead(upstreamRes.statusCode ?? 502, filterHopByHop(upstreamRes.headers));
    // Single chunk-pipe, never buffered whole (ADR-013 Decision 3): identical
    // code path for a normal JSON body and an SSE stream — pipe() relays
    // each 'data' chunk to the client as soon as it arrives upstream.
    upstreamRes.pipe(clientRes);
  });

  upstreamReq.on('error', (err) => {
    // Upstream unreachable/timeout is NOT a proxy failure (ADR-013 Decision
    // 2, "Upstream unreachable is not a proxy failure at all") — the proxy
    // must not hang, retry, or apply its own error semantics; it stays up
    // and serves the next request normally. A clean 502 lets the calling
    // agent's HTTP client see an ordinary error response rather than a
    // connection that just dies.
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'text/plain' });
      clientRes.end(`proxy: upstream unreachable (${err.message})`);
    } else {
      clientRes.destroy();
    }
  });

  clientRes.on('close', () => {
    // Client disconnected mid-stream — stop pulling from upstream rather
    // than leaking the in-flight request.
    if (!upstreamReq.destroyed) upstreamReq.destroy();
  });

  clientReq.on('error', () => {
    if (!upstreamReq.destroyed) upstreamReq.destroy();
  });

  // Single chunk-pipe from client to upstream — a request body forwards
  // byte-for-byte with no intermediate buffering, symmetric with the
  // response-side pipe above.
  clientReq.pipe(upstreamReq);
}

/**
 * Start the core proxy: bind `host:port`, forward every request to
 * `upstream` byte-transparently. Callers (the CLI layer) are responsible for
 * calling `assertLoopbackBind` first — this function does not itself
 * validate the host, so it stays usable in tests that intentionally probe
 * non-default bind targets without going through process.exit semantics.
 */
export async function startProxyServer(opts: ProxyServeOpts): Promise<ProxyHandle> {
  const upstreamUrl = new URL(opts.upstream);

  const server: Server = createHttpServer((clientReq, clientRes) => {
    forwardOneRequest(clientReq, clientRes, upstreamUrl);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : opts.port;

  return {
    port: boundPort,
    host: opts.host,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}
