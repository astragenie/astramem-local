/**
 * FEAT-458 S4 — the full upstream failure-mode matrix (ADR-013 Decision 2:
 * "proxy down ≠ agent down", fail-open forwarding / fail-silent capture).
 * Every row is pinned by a test, here or in a sibling file, so a future
 * regression on any one failure mode fails CI rather than surfacing as a
 * silently-hung agent turn in production:
 *
 * | # | Failure mode                                   | Pinned by                                              |
 * |---|-------------------------------------------------|---------------------------------------------------------|
 * | 1 | upstream connection refused                      | tests/proxy/byte-transparency.test.ts ("upstream-down") |
 * | 2 | upstream DNS failure                             | this file — "DNS failure"                                |
 * | 3 | upstream TLS failure                              | this file — "TLS failure"                                |
 * | 4 | upstream hangs before responding (no headers)    | tests/proxy/upstream-timeout.test.ts                     |
 * | 5 | upstream stalls mid-stream (headers sent, body stops) | tests/proxy/upstream-timeout.test.ts                |
 * | 6 | upstream returns 4xx/5xx (relayed unchanged)     | tests/proxy/byte-transparency.test.ts                    |
 * | 7 | client disconnects mid-request                   | this file — "client disconnects mid-request"             |
 * | 8 | client disconnects mid-response                  | this file — "client disconnects mid-response"            |
 * | 9 | capture tee throws                               | tests/proxy/byte-transparency.test.ts                    |
 * | 10| spool write fails (disk full / unwritable dir)   | this file — "spool write fails"                          |
 * | 11| capture enabled, spool dir unwritable at startup | this file — "spool write fails" (same test, see comment) |
 *
 * Every row asserts the SAME two properties: the client-visible forward path
 * is fail-open (a real status, or an honest teardown, never a hang or a
 * fabricated success), and — where capture is in play — capture is
 * fail-silent (a capture-side failure never reaches the client at all).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startProxyServer, type ProxyHandle } from '../../src/proxy/server.js';
import { createProxyCaptureTee } from '../../src/capture/proxy.js';

function listenEphemeral(server: Server): Promise<number> {
  return new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)).then(() => {
    const addr = server.address();
    if (typeof addr !== 'object' || addr === null) throw new Error('no address');
    return addr.port;
  });
}

describe('proxy failure-mode matrix', () => {
  let fakeUpstream: Server | undefined;
  let proxy: ProxyHandle | undefined;
  let tmpPath: string | undefined;

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
    if (fakeUpstream) await new Promise<void>((resolve) => fakeUpstream!.close(() => resolve()));
    fakeUpstream = undefined;
    if (tmpPath) rmSync(tmpPath, { recursive: true, force: true });
    tmpPath = undefined;
  });

  it('DNS failure: an unresolvable upstream host answers cleanly (never hangs) and the proxy stays up', async () => {
    // .invalid is reserved by RFC 2606 to never resolve — a portable,
    // network-independent way to force a real getaddrinfo failure (ENOTFOUND)
    // rather than a connection-refused (which is failure mode #1, already
    // pinned elsewhere and mechanically different — no connection is ever
    // attempted here because DNS resolution itself fails first). In a
    // sandboxed/offline test runner, getaddrinfo for an unresolvable name can
    // itself take several seconds rather than failing fast (no real
    // resolver to answer NXDOMAIN quickly) — observed in CI: the idle-timer
    // backstop fires first and answers 504 instead of a native 502. Both are
    // correct fail-open outcomes for this row; the property under test is
    // "never hangs, never crashes the proxy", not which exact status code
    // wins the race between native DNS failure and the backstop timer.
    proxy = await startProxyServer({
      port: 0, host: '127.0.0.1', upstream: 'http://this-host-does-not-exist.invalid:1',
      upstreamTimeoutMs: 3_000, // backstop — guarantees this test can't hang even if DNS resolution itself does
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect([502, 504]).toContain(res.status);
    await res.text();

    // Proves the DNS failure didn't wedge the server — a second request
    // (even against the same doomed host) still gets a clean answer.
    const res2 = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect([502, 504]).toContain(res2.status);
    await res2.text();
  }, 10_000);

  it('TLS failure: an https:// upstream that is actually a plain-HTTP server answers 502, not a hang', async () => {
    // The proxy speaks TLS (node:https) to an https:// upstream URL — if the
    // thing on the other end is a bare HTTP server, the handshake itself
    // fails. Distinct from DNS/refused: a real TCP connection succeeds, then
    // the TLS layer on top of it fails.
    fakeUpstream = createServer((_req, res) => {
      res.writeHead(200);
      res.end('plain http, not tls');
    });
    const upstreamPort = await listenEphemeral(fakeUpstream);

    proxy = await startProxyServer({
      port: 0, host: '127.0.0.1', upstream: `https://127.0.0.1:${upstreamPort}`,
      upstreamTimeoutMs: 3_000, // backstop — the idle timer would also catch a wedged handshake
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect([502, 504]).toContain(res.status); // 502 for a native TLS error, 504 if the idle timer caught it first
    await res.text();
  }, 10_000);

  it('client disconnects mid-request: the upstream connection is torn down, not left open', async () => {
    let upstreamSawClose = false;
    let upstreamGotFullBody = false;
    const gotRequest = new Promise<void>((resolveGot) => {
      fakeUpstream = createServer((req, _res) => {
        resolveGot();
        req.on('close', () => { upstreamSawClose = true; });
        req.on('end', () => { upstreamGotFullBody = true; });
        // Never respond — this handler's only job is to observe the socket.
      });
    });
    const upstreamPort = await listenEphemeral(fakeUpstream!);
    proxy = await startProxyServer({ port: 0, host: '127.0.0.1', upstream: `http://127.0.0.1:${upstreamPort}` });

    const controller = new AbortController();
    const fetchPromise = fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      body: 'partial-body-that-never-finishes',
      signal: controller.signal,
    }).catch(() => { /* expected — the client itself aborted */ });

    await gotRequest;
    controller.abort();
    await fetchPromise;

    // Give the proxy's clientRes 'close' handler a tick to destroy the
    // upstream request (src/proxy/server.ts's existing teardown wiring).
    await new Promise((r) => setTimeout(r, 150));

    expect(upstreamSawClose).toBe(true);
    expect(upstreamGotFullBody).toBe(false); // proves the body genuinely never completed, not a race that let it finish first
  });

  it('client disconnects mid-response: the upstream connection is torn down, not left open', async () => {
    let upstreamSawClose = false;
    fakeUpstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
      res.on('close', () => { upstreamSawClose = true; });
      // Keep the response open indefinitely — only a client-side abort
      // should end this, not a timeout (no upstreamTimeoutMs configured
      // short enough to fire in this test's window).
    });
    const upstreamPort = await listenEphemeral(fakeUpstream);
    proxy = await startProxyServer({
      port: 0, host: '127.0.0.1', upstream: `http://127.0.0.1:${upstreamPort}`,
      upstreamTimeoutMs: 60_000, // effectively "off" for this test's timescale
    });

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST', body: '{}', signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read(); // consume the first chunk so we know streaming is live

    controller.abort();
    await reader.cancel().catch(() => {});

    await new Promise((r) => setTimeout(r, 150));
    expect(upstreamSawClose).toBe(true);
  });

  it('spool write fails (unwritable spool dir, incl. at startup): forwarding is completely unaffected and the failure is silent to the client', async () => {
    // Force a REAL fs failure rather than mocking: point dataDir at the path
    // of a plain FILE (not a directory). spoolDir(dataDir) = "<file>/ingest-spool",
    // so mkdirSync(..., {recursive:true}) inside writeToSpool throws ENOTDIR —
    // a genuine disk-level failure, same class as "disk full" or a permissions
    // error, without relying on platform-specific chmod semantics.
    tmpPath = mkdtempSync(join(tmpdir(), 'astramem-unwritable-'));
    const fileWhereDirShouldBe = join(tmpPath, 'not-a-directory');
    writeFileSync(fileWhereDirShouldBe, 'this is a file, not a directory');

    // Constructing the tee against this dataDir must not throw "at startup"
    // (row #11) — createProxyCaptureTee touches no filesystem until the
    // first request's deferred spool write, so this call succeeding proves
    // that half of the row; startProxyServer resolving below proves the
    // server itself boots fine too.
    const createTee = createProxyCaptureTee({
      dataDir: fileWhereDirShouldBe,
      clientVersion: '9.9.9',
      relevanceGate: { minChars: 1, maxBytes: 1_000_000, dedupWindow: 20 },
    });

    fakeUpstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'reply' } }] }));
      });
    });
    const upstreamPort = await listenEphemeral(fakeUpstream);

    proxy = await startProxyServer({
      port: 0, host: '127.0.0.1', upstream: `http://127.0.0.1:${upstreamPort}`, createTee,
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(JSON.parse(bodyText).choices[0].message.content).toBe('reply');

    // The spool write is deferred via setImmediate (ADR-013 Decision 3) —
    // flush past it. If writeToSpool's throw ever escaped its try/catch
    // (src/capture/proxy.ts's finishCapture, called inside maybeFinish's
    // setImmediate), vitest would report an unhandled rejection / uncaught
    // exception for this test — the ABSENCE of that failure is itself part
    // of what this test proves, on top of the response assertions above.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 30));
  });
});
