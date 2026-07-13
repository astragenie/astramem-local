import { describe, it, expect, afterEach } from 'vitest';
import { startUpstreamStub, type UpstreamStubHandle } from './upstream-stub.js';

describe('startUpstreamStub — synthetic local upstream lifecycle', () => {
  let stub: UpstreamStubHandle | undefined;

  afterEach(async () => {
    if (stub) await stub.close();
    stub = undefined;
  });

  it('binds an ephemeral loopback port and serves the configured body size', async () => {
    stub = await startUpstreamStub({ bodySize: 256 });
    expect(stub.port).toBeGreaterThan(0);
    expect(stub.baseUrl).toBe(`http://127.0.0.1:${stub.port}`);

    const res = await fetch(stub.baseUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('256');
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(256);
  });

  it('defaults to a 1024-byte body when no size is given', async () => {
    stub = await startUpstreamStub();
    const res = await fetch(stub.baseUrl);
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(1024);
  });

  it('fills the body with the configured byte', async () => {
    stub = await startUpstreamStub({ bodySize: 8, fillChar: 'z' });
    const res = await fetch(stub.baseUrl);
    const text = await res.text();
    expect(text).toBe('zzzzzzzz');
  });

  it('respects an artificial delay before responding', async () => {
    stub = await startUpstreamStub({ bodySize: 1, delayMs: 120 });
    const t0 = performance.now();
    await fetch(stub.baseUrl);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(100); // generous slack under load
  });

  it('has zero delay by default (fast path for the canonical bench)', async () => {
    stub = await startUpstreamStub({ bodySize: 1 });
    const t0 = performance.now();
    await fetch(stub.baseUrl);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(100);
  });

  it('tracks the number of requests served', async () => {
    stub = await startUpstreamStub({ bodySize: 1 });
    await fetch(stub.baseUrl);
    await fetch(stub.baseUrl);
    await fetch(stub.baseUrl);
    expect(stub.requestCount()).toBe(3);
  });

  it('close() releases the port — a subsequent connection is refused', async () => {
    stub = await startUpstreamStub();
    const { baseUrl } = stub;
    await stub.close();
    stub = undefined;
    await expect(fetch(baseUrl)).rejects.toThrow();
  });

  it('chatShape: false (default) still serves a raw byte blob, not JSON', async () => {
    stub = await startUpstreamStub({ bodySize: 32 });
    const res = await fetch(stub.baseUrl);
    const text = await res.text();
    expect(() => JSON.parse(text)).toThrow();
  });

  it('chatShape: true serves a real chat-completion JSON envelope with a non-empty assistant turn', async () => {
    stub = await startUpstreamStub({ bodySize: 512, chatShape: true });
    const res = await fetch(stub.baseUrl);
    const text = await res.text();
    const parsed = JSON.parse(text) as { choices: Array<{ message: { role: string; content: string } }> };
    expect(parsed.choices).toHaveLength(1);
    expect(parsed.choices[0]?.message.role).toBe('assistant');
    expect(parsed.choices[0]?.message.content.length).toBeGreaterThan(0);
  });

  it('chatShape: true body length tracks bodySize approximately, never negative/empty', async () => {
    stub = await startUpstreamStub({ bodySize: 10, chatShape: true });
    const res = await fetch(stub.baseUrl);
    const text = await res.text();
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text.length).toBeGreaterThan(0);
  });
});
