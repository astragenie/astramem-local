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
 * ZERO capture code lives in this module or anything it imports — no import
 * from src/capture, src/ingest, or src/distill anywhere in this file's
 * import graph (tests/proxy/zero-capture-imports.test.ts). FEAT-458 S3 adds
 * exactly one thing to this file: an optional `createTee` hook (see
 * `ProxyTeeSink` below) that hands the capture-fork module (src/capture/
 * proxy.ts, added alongside this file, never merged into it) a copy of body
 * chunks as they pass — the dependency arrow points from the capture module
 * to this file (it imports `ProxyTeeSink`'s type), never the reverse. This
 * file still never references anything under src/capture/src/ingest/
 * src/distill at runtime.
 */
import { createServer as createHttpServer, request as httpRequestFn } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import { request as httpsRequestFn } from 'node:https';

/**
 * FEAT-458 S3 (ADR-013 Decision 4): the tee sink's only inputs are BODY
 * events — a raw `Buffer` chunk, or an end-of-stream marker for one
 * direction. There is no field here a future edit could widen to carry
 * headers without changing this type's shape at the call site below; the
 * exclusion is structural, not a filtered allow-list. `dir` says which leg
 * of the exchange the bytes belong to, nothing about the request/response
 * objects themselves is ever exposed.
 */
export type ProxyTeeEvent = { chunk: Buffer } | { end: true };
export type ProxyTeeSink = (dir: 'req' | 'res', event: ProxyTeeEvent) => void;

export interface ProxyServeOpts {
  port: number;
  host: string;
  upstream: string;
  /**
   * Optional factory, called once per incoming request (never per server
   * start) so each exchange's tee state (buffered chunks, end-of-stream
   * flags) is isolated from every other concurrent request — a single
   * shared sink would corrupt interleaved captures under concurrent load.
   * Any cross-request state (e.g. a relevance-gate dedup window) belongs in
   * the closure that produces this factory, one level up, in the capture
   * module itself. Undefined (the default) means capture is off: zero
   * listeners are attached and the forward path is identical to S2.
   */
  createTee?: () => ProxyTeeSink;
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

/** Every tee invocation is wrapped here so a bug in the (separately owned)
 *  capture module can never propagate into the forward path (ADR-013
 *  Decision 2 / FEAT-458 S3 requirement 7: fail-silent capture, fail-open
 *  forwarding). A thrown tee call is swallowed — not logged by this file,
 *  capture-side error visibility is the capture module's own concern — the
 *  forwarded request/response is completely unaffected either way. */
function safeTee(tee: ProxyTeeSink, dir: 'req' | 'res', event: ProxyTeeEvent): void {
  try {
    tee(dir, event);
  } catch {
    /* fail-silent capture — never break forwarding */
  }
}

function forwardOneRequest(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  upstreamUrl: URL,
  createTee?: () => ProxyTeeSink,
): void {
  const isHttps = upstreamUrl.protocol === 'https:';
  const requestFn = isHttps ? httpsRequestFn : httpRequestFn;
  const forwardHeaders = filterHopByHop(clientReq.headers);

  // FEAT-458 S3: exactly one tee instance per request/response exchange —
  // never shared across concurrent requests (ProxyServeOpts.createTee doc).
  // A second 'data'/'end' listener alongside an active .pipe() does not
  // change what the piped side receives — Node delivers the same chunks to
  // every flowing-mode listener — so this is a read-only observer, never a
  // second consumer competing with the forward path for bytes. Guarded so
  // even a throwing factory can't affect forwarding.
  let tee: ProxyTeeSink | undefined;
  try {
    tee = createTee?.();
  } catch {
    tee = undefined;
  }

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
    // Tee the response body — chunks only, never headers (already written
    // above from upstreamRes.headers, a value this callback never hands to
    // tee). Attached before the pipe below so both start observing the
    // stream in the same synchronous tick.
    if (tee) {
      const t = tee;
      upstreamRes.on('data', (chunk: Buffer) => safeTee(t, 'res', { chunk }));
      upstreamRes.on('end', () => safeTee(t, 'res', { end: true }));
    }
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

  // Tee the request body the same way, before the pipe below.
  if (tee) {
    const t = tee;
    clientReq.on('data', (chunk: Buffer) => safeTee(t, 'req', { chunk }));
    clientReq.on('end', () => safeTee(t, 'req', { end: true }));
  }
  // Single chunk-pipe from client to upstream — a request body forwards
  // byte-for-byte with no intermediate buffering, symmetric with the
  // response-side pipe above.
  clientReq.pipe(upstreamReq);
}

/**
 * Start the core proxy: bind `host:port`, forward every request to
 * `upstream` byte-transparently. Callers (the CLI layer) are responsible for
 * refusing a non-loopback `host` before calling this — this function does
 * not itself validate the host, so it stays usable in tests that
 * intentionally probe non-default bind targets without going through
 * process.exit semantics. `opts.createTee` (FEAT-458 S3) is fully optional
 * and additive: omitting it reproduces S2's exact capture-free behavior.
 */
export async function startProxyServer(opts: ProxyServeOpts): Promise<ProxyHandle> {
  const upstreamUrl = new URL(opts.upstream);

  const server: Server = createHttpServer((clientReq, clientRes) => {
    forwardOneRequest(clientReq, clientRes, upstreamUrl, opts.createTee);
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
