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

/**
 * FEAT-458 S4 (ADR-013 Decision 2, "proxy down ≠ agent down"): a silently
 * hanging upstream — no connection error, just nothing ever happens — is the
 * one failure mode the S2 forward path left completely unhandled. Every
 * other upstream failure (refused, DNS, TLS, 4xx/5xx) surfaces an 'error' or
 * a real response on its own; a hang produces neither, so it needs an
 * explicit timer. 30s is generous enough for a real provider's
 * time-to-first-byte under normal load while still bounding how long one
 * stuck request can occupy a socket.
 */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Tags an error raised by the idle-timeout below so the `upstreamReq`
 * 'error' handler can tell "the upstream went silent" apart from "the
 * upstream connection genuinely failed" and answer with 504 (Gateway
 * Timeout) instead of 502 (Bad Gateway) — same delivery mechanism (Node
 * routes a `.destroy(err)` through the request's own 'error' event), just a
 * more accurate status for the caller.
 */
class UpstreamTimeoutError extends Error {
  constructor(ms: number) {
    super(`proxy: upstream idle timeout after ${ms}ms`);
    this.name = 'UpstreamTimeoutError';
  }
}

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
  /**
   * FEAT-458 S4 — per-request idle timeout applied to the upstream leg only
   * (never the client leg). `undefined` uses `DEFAULT_UPSTREAM_TIMEOUT_MS`;
   * `0` or a negative value disables the timeout entirely (matches the
   * escape-hatch shape other `timeoutMs` config surfaces in this repo use,
   * e.g. `crossEncoder.timeoutMs`).
   */
  upstreamTimeoutMs?: number;
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

interface UpstreamTimeoutHandle {
  /** Restart the deadline — call on every unit of genuine upstream activity. */
  reset(): void;
  /** Permanently disarm — call on every terminal path (success or failure) so
   *  no stray timer can fire, and so it can never keep the process alive. */
  clear(): void;
}

const NOOP_TIMEOUT_HANDLE: UpstreamTimeoutHandle = { reset() {}, clear() {} };

/**
 * Arms a self-resetting idle-deadline covering the upstream leg's ENTIRE
 * lifecycle — DNS lookup, TCP connect, waiting on response headers, and
 * streaming the response body — as one mechanism, via a manual `setTimeout`
 * armed immediately at call time and restarted by the caller on each byte of
 * genuine activity (see the `reset()` call sites in `forwardOneRequest`).
 *
 * This is deliberately NOT `upstreamReq.setTimeout()` (Node's built-in
 * request timeout): that API only starts counting once a socket is assigned
 * AND connected, so it silently does not cover a hung DNS lookup or a stuck
 * TCP handshake — confirmed empirically while building this (a `.invalid`
 * hostname hung past both a 3s backstop and a 10s test timeout with the
 * built-in API, because no socket-level timer was ever armed). A plain timer
 * that starts at request-creation time has no such blind spot.
 *
 * One mechanism, two outcomes depending on how far the exchange got before
 * going silent (`clientRes.headersSent` can only ever be true or false once):
 *   - Not sent yet (dead during DNS/connect/wait-for-headers) -> destroy with
 *     a tagged error, which routes through the existing `upstreamReq.on(
 *     'error', ...)` handler and answers 504.
 *   - Already sent (actively streaming to the client) -> a fresh status can
 *     never be sent retroactively. The only honest option is to tear down
 *     BOTH legs immediately via `.destroy()` (never `.end()`): destroying
 *     drops the connection mid-chunk, which the client's HTTP stack reports
 *     as a truncated/aborted read. Calling `.end()` instead would write the
 *     terminating chunk and tell the client the transfer finished
 *     successfully — fabricating a clean completion for a transfer that
 *     actually died, exactly what ADR-013 Decision 2 forbids.
 */
function armUpstreamTimeout(
  upstreamReq: ReturnType<typeof httpRequestFn>,
  clientRes: ServerResponse,
  timeoutMs: number,
): UpstreamTimeoutHandle {
  if (timeoutMs <= 0) return NOOP_TIMEOUT_HANDLE; // 0 or negative disables the timeout

  let timer: NodeJS.Timeout | undefined;

  const fire = () => {
    const err = new UpstreamTimeoutError(timeoutMs);
    if (!clientRes.headersSent) {
      upstreamReq.destroy(err);
    } else {
      upstreamReq.destroy();
      clientRes.destroy(err);
    }
  };

  const reset = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, timeoutMs);
    // A leftover timer must never be the reason the process (or a test's
    // event loop) fails to exit — every real termination path below calls
    // clear() explicitly, this is defense-in-depth only.
    timer.unref?.();
  };

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  reset(); // armed immediately — covers DNS lookup + TCP connect from t=0
  return { reset, clear };
}

function forwardOneRequest(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  upstreamUrl: URL,
  createTee?: () => ProxyTeeSink,
  upstreamTimeoutMs: number = DEFAULT_UPSTREAM_TIMEOUT_MS,
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
    // Response headers arrived — genuine activity, restart the deadline
    // before the body streaming phase begins.
    upstreamTimeout.reset();
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
    // Every response chunk restarts the deadline — this is what makes it an
    // IDLE timeout rather than a fixed total-duration cap: a long-running
    // but actively-streaming completion never trips it, only genuine
    // silence does.
    upstreamRes.on('data', () => upstreamTimeout.reset());
    // A normal, complete response disarms the deadline for good.
    upstreamRes.on('end', () => upstreamTimeout.clear());
    // Single chunk-pipe, never buffered whole (ADR-013 Decision 3): identical
    // code path for a normal JSON body and an SSE stream — pipe() relays
    // each 'data' chunk to the client as soon as it arrives upstream.
    upstreamRes.pipe(clientRes);
  });

  const upstreamTimeout = armUpstreamTimeout(upstreamReq, clientRes, upstreamTimeoutMs);

  upstreamReq.on('error', (err) => {
    upstreamTimeout.clear();
    // Upstream unreachable/timeout is NOT a proxy failure (ADR-013 Decision
    // 2, "Upstream unreachable is not a proxy failure at all") — the proxy
    // must not hang, retry, or apply its own error semantics; it stays up
    // and serves the next request normally. A clean status lets the calling
    // agent's HTTP client see an ordinary error response rather than a
    // connection that just dies. 504 (not 502) specifically for the
    // idle-timeout case (armUpstreamTimeout above) — the upstream never
    // refused or errored, it just went silent past the deadline.
    if (!clientRes.headersSent) {
      const status = err instanceof UpstreamTimeoutError ? 504 : 502;
      clientRes.writeHead(status, { 'content-type': 'text/plain' });
      clientRes.end(`proxy: upstream ${status === 504 ? 'timed out' : 'unreachable'} (${err.message})`);
    } else {
      clientRes.destroy();
    }
  });

  clientRes.on('close', () => {
    upstreamTimeout.clear();
    // Client disconnected mid-stream — stop pulling from upstream rather
    // than leaking the in-flight request.
    if (!upstreamReq.destroyed) upstreamReq.destroy();
  });

  clientReq.on('error', () => {
    upstreamTimeout.clear();
    if (!upstreamReq.destroyed) upstreamReq.destroy();
  });

  // Tee the request body the same way, before the pipe below.
  if (tee) {
    const t = tee;
    clientReq.on('data', (chunk: Buffer) => safeTee(t, 'req', { chunk }));
    clientReq.on('end', () => safeTee(t, 'req', { end: true }));
  }
  // Bytes flowing FROM the client TO the upstream are activity too — a slow
  // but genuinely-progressing upload must not trip the upstream deadline
  // before the upstream has even seen the full request.
  clientReq.on('data', () => upstreamTimeout.reset());
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
  const upstreamTimeoutMs = opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;

  const server: Server = createHttpServer((clientReq, clientRes) => {
    forwardOneRequest(clientReq, clientRes, upstreamUrl, opts.createTee, upstreamTimeoutMs);
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
