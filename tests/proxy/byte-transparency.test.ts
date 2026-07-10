/**
 * FEAT-458 S2-AC-1/AC-3: byte-transparent forwarding — request+response
 * bytes identical through the proxy (including SSE chunk boundaries
 * preserved as received, i.e. never buffered whole), headers forwarded
 * minus hop-by-hop, and upstream error responses relayed unchanged.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startProxyServer, type ProxyHandle } from '../../src/proxy/server.js';

async function listenEphemeral(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  return addr.port;
}

describe('proxy byte-transparency', () => {
  let fakeUpstream: Server | undefined;
  let proxy: ProxyHandle | undefined;

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
    if (fakeUpstream) await new Promise<void>((resolve) => fakeUpstream!.close(() => resolve()));
    fakeUpstream = undefined;
  });

  it('non-streaming POST: request body, response body, and non-hop-by-hop headers pass through byte-identical', async () => {
    const requestBody = JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi ☃ — unicode + "quotes"' }] });
    const responseBody = JSON.stringify({ id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'hello' } }] });
    let receivedByUpstream = '';
    let receivedCanaryHeader: string | undefined;

    fakeUpstream = createServer((req, res) => {
      receivedCanaryHeader = req.headers['x-canary-test'] as string | undefined;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedByUpstream = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json', 'x-upstream-marker': 'present' });
        res.end(responseBody);
      });
    });
    const upstreamPort = await listenEphemeral(fakeUpstream);

    proxy = await startProxyServer({ port: 0, host: '127.0.0.1', upstream: `http://127.0.0.1:${upstreamPort}` });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-canary-test': 'canary-value-123' },
      body: requestBody,
    });
    const bodyText = await res.text();

    expect(receivedByUpstream).toBe(requestBody);
    expect(receivedCanaryHeader).toBe('canary-value-123');
    expect(bodyText).toBe(responseBody);
    expect(res.headers.get('x-upstream-marker')).toBe('present');
  });

  it('upstream error response (4xx/5xx) relays status, body, and headers unchanged', async () => {
    const errorBody = JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } });
    fakeUpstream = createServer((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
      res.end(errorBody);
    });
    const upstreamPort = await listenEphemeral(fakeUpstream);
    proxy = await startProxyServer({ port: 0, host: '127.0.0.1', upstream: `http://127.0.0.1:${upstreamPort}` });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: 'POST', body: '{}' });
    const bodyText = await res.text();

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(bodyText).toBe(errorBody);
  });

  it('SSE stream: chunks forward as they arrive (never buffered whole) and concatenate byte-identical', async () => {
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo, "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world!"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const CHUNK_DELAY_MS = 60;

    fakeUpstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const sendNext = () => {
        if (i >= sseChunks.length) { res.end(); return; }
        res.write(sseChunks[i]);
        i++;
        setTimeout(sendNext, CHUNK_DELAY_MS);
      };
      sendNext();
    });
    const upstreamPort = await listenEphemeral(fakeUpstream);
    proxy = await startProxyServer({ port: 0, host: '127.0.0.1', upstream: `http://127.0.0.1:${upstreamPort}` });

    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { accept: 'text/event-stream' },
      body: JSON.stringify({ stream: true }),
    });
    expect(res.body).toBeTruthy();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    let firstChunkAt: number | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (firstChunkAt === null) firstChunkAt = Date.now();
      received += decoder.decode(value, { stream: true });
    }
    const totalMs = Date.now() - t0;

    // Byte content is identical once fully concatenated...
    expect(received).toBe(sseChunks.join(''));
    // ...and the first chunk arrived well before the full response was
    // produced upstream (~3 * CHUNK_DELAY_MS), proving the proxy relayed
    // chunks as they streamed rather than buffering the whole SSE response
    // before forwarding it.
    expect(firstChunkAt).not.toBeNull();
    expect((firstChunkAt as number) - t0).toBeLessThan(CHUNK_DELAY_MS * 2);
    expect(totalMs).toBeGreaterThan(CHUNK_DELAY_MS * 2);
  });

  it('upstream-down: connection refused relays a clean error and the proxy stays up for the next request', async () => {
    // Bind and immediately close a server to get a port number that is very
    // likely unoccupied (connection refused), without a live upstream.
    const probe = createServer();
    const deadPort = await listenEphemeral(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    proxy = await startProxyServer({ port: 0, host: '127.0.0.1', upstream: `http://127.0.0.1:${deadPort}` });

    const res1 = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect(res1.status).toBe(502);
    await res1.text();

    // The proxy process/server must still be serving after a connection-
    // refused upstream error (ADR-013 Decision 2: "upstream unreachable is
    // not a proxy failure") — a second request against the same still-dead
    // upstream gets the same clean error rather than the proxy hanging,
    // crashing, or refusing further connections.
    const res2 = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect(res2.status).toBe(502);
    await res2.text();
  });
});
