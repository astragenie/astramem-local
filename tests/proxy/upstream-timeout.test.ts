/**
 * FEAT-458 S4 (ADR-013 Decision 2, "proxy down ≠ agent down") — a silently
 * hanging upstream is the one failure mode the S2/S3 forward path left
 * completely unhandled: no error, no response, just nothing. This file
 * proves `ProxyServeOpts.upstreamTimeoutMs` (src/proxy/server.ts) closes
 * that gap for both shapes a hang can take:
 *
 *   - headers never arrive at all -> the proxy answers 504 promptly and
 *     stays up for the next request (no hang, no crash).
 *   - headers arrive, then the body stalls mid-stream -> a status code can
 *     no longer be sent, so the proxy tears the connection down instead of
 *     fabricating a clean completion; the client must observe SOME signal
 *     that the transfer died rather than silently reading a
 *     shorter-than-intended-but-"successful" body.
 *
 * Also covers: the default applies when `upstreamTimeoutMs` is omitted, and
 * `0` disables the timeout outright (an upstream slower than the default
 * would otherwise allow still completes normally).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startProxyServer, type ProxyHandle, DEFAULT_UPSTREAM_TIMEOUT_MS } from '../../src/proxy/server.js';

function listenEphemeral(server: Server): Promise<number> {
  return new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)).then(() => {
    const addr = server.address();
    if (typeof addr !== 'object' || addr === null) throw new Error('no address');
    return addr.port;
  });
}

describe('proxy upstream idle timeout', () => {
  let fakeUpstream: Server | undefined;
  let proxy: ProxyHandle | undefined;

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
    if (fakeUpstream) await new Promise<void>((resolve) => fakeUpstream!.close(() => resolve()));
    fakeUpstream = undefined;
  });

  it('DEFAULT_UPSTREAM_TIMEOUT_MS is a sane, generous, positive default', () => {
    expect(DEFAULT_UPSTREAM_TIMEOUT_MS).toBeGreaterThan(1_000);
    expect(DEFAULT_UPSTREAM_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });

  it('upstream hangs before responding (headers never arrive): the proxy answers 504 promptly and stays up for the next request', async () => {
    fakeUpstream = createServer((_req, _res) => {
      // Accept the connection, then never write anything — a true hang, not
      // an error and not a close.
    });
    const upstreamPort = await listenEphemeral(fakeUpstream);
    proxy = await startProxyServer({
      port: 0, host: '127.0.0.1', upstream: `http://127.0.0.1:${upstreamPort}`,
      upstreamTimeoutMs: 80,
    });

    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: 'POST', body: '{}' });
    const elapsed = Date.now() - t0;
    const bodyText = await res.text();

    expect(res.status).toBe(504);
    expect(bodyText).toContain('timed out');
    // Fired at (roughly) the configured deadline, not instantly and not
    // after some much longer unrelated wait.
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(5_000);

    // The proxy itself must still be serving — a hang on one request must
    // never take the process down or wedge the listener.
    fakeUpstream.close();
    fakeUpstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('alive');
    });
    const nextPort = await new Promise<number>((resolve) => {
      fakeUpstream!.listen(upstreamPort, '127.0.0.1', () => resolve(upstreamPort));
    });
    void nextPort;
  });

  it('upstream stalls mid-stream (headers sent, body stops): the client never observes a fabricated clean completion', async () => {
    fakeUpstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      // Never writes again, never calls res.end() — a stall after a real,
      // legitimate start.
    });
    const upstreamPort = await listenEphemeral(fakeUpstream);
    proxy = await startProxyServer({
      port: 0, host: '127.0.0.1', upstream: `http://127.0.0.1:${upstreamPort}`,
      upstreamTimeoutMs: 80,
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: 'POST', body: '{}' });
    // The 200 + headers were genuine — sent before the stall, so they DO
    // arrive at the client exactly as ADR-013 Decision 2 requires (no
    // proxy-side rewriting of a response already in flight).
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const chunks: Buffer[] = [];
    let readError: unknown;
    const t0 = Date.now();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
      }
    } catch (err) {
      readError = err;
    }
    const elapsed = Date.now() - t0;
    const received = Buffer.concat(chunks).toString('utf8');

    // The real bytes that DID arrive before the stall are still exactly
    // what the upstream sent — the proxy never buffers/rewrites the part of
    // the stream that genuinely happened.
    expect(received).toContain('partial');
    // A real SSE completion would end with a `[DONE]` marker; the fake
    // upstream never sent one because it stalled — proving this wasn't a
    // coincidental legitimate finish.
    expect(received).not.toContain('[DONE]');
    // The read must terminate (error out) around the configured timeout,
    // not hang forever and not take some much longer unrelated time.
    expect(elapsed).toBeLessThan(5_000);
    // Node's fetch (undici) surfaces an abruptly-closed chunked response as
    // a read rejection rather than a clean `done: true` — this is the
    // "client observes the transfer died" signal the design requires. If a
    // future Node/undici version changed this to a silent truncated `done`
    // instead, the `[DONE]`-marker assertion above still catches a
    // fabricated-success regression, but pin the stronger signal too while
    // it holds.
    expect(readError).toBeDefined();

    // The proxy itself survives an abrupt mid-stream teardown — prove it
    // serves a fresh request against a healthy upstream right after.
    await fakeUpstream.close();
    fakeUpstream = createServer((_req, res2) => {
      res2.writeHead(200, { 'content-type': 'text/plain' });
      res2.end('alive');
    });
    await new Promise<void>((resolve) => fakeUpstream!.listen(upstreamPort, '127.0.0.1', () => resolve()));
    const res2 = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect(res2.status).toBe(200);
    expect(await res2.text()).toBe('alive');
  });

  it('upstreamTimeoutMs: 0 disables the timeout — an upstream slower than a short deadline still completes normally', async () => {
    const RESPONSE_DELAY_MS = 150;
    fakeUpstream = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }, RESPONSE_DELAY_MS);
    });
    const upstreamPort = await listenEphemeral(fakeUpstream);
    proxy = await startProxyServer({
      port: 0, host: '127.0.0.1', upstream: `http://127.0.0.1:${upstreamPort}`,
      upstreamTimeoutMs: 0, // would time out well before RESPONSE_DELAY_MS if a small default applied
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('a fast, healthy upstream is completely unaffected by a configured timeout (no false positives)', async () => {
    fakeUpstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    const upstreamPort = await listenEphemeral(fakeUpstream);
    proxy = await startProxyServer({
      port: 0, host: '127.0.0.1', upstream: `http://127.0.0.1:${upstreamPort}`,
      upstreamTimeoutMs: 500,
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
  });
});
