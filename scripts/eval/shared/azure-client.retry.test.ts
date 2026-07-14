/**
 * A 429 must not kill a 90-minute benchmark run.
 *
 * There was NO retry in azure-client.ts — not even for the serial caller. The
 * full-suite LoCoMo run (n=1986) only completed because serial requests happened
 * to stay under the deployment's limit BY ACCIDENT.
 *
 * Then PR #253 made the answering phase concurrent (default 8) and gave it
 * nothing to survive a 429 with. The very next real run died on the first burst:
 *
 *   Azure chat completion failed (HTTP 429) on deployment gpt-5-mini:
 *     Your requests to gpt-5-mini in centralus have exceeded rate limit.
 *
 * #253 shipped with tests. They proved the concurrency preserved ORDER and was
 * DETERMINISTIC — and they were right about both. They said nothing about
 * whether the thing survives contact with a rate limit, so it merged green and
 * broken.
 *
 * **A passing test and a working feature are not the same thing.** This file
 * tests the part that actually breaks.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { azureChatComplete } from './azure-client.js';

const cfg = {
  endpoint: 'https://fake.openai.azure.com',
  key: 'k',
  apiVersion: '2024-12-01-preview',
  answererDeployment: 'gpt-5-mini',
  judgeDeployment: 'gpt-5-mini',
} as Parameters<typeof azureChatComplete>[0];

const opts = {
  deployment: 'gpt-5-mini',
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxCompletionTokens: 150,
};

function reply(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

const ok = () => reply({ choices: [{ message: { content: 'ANSWER' } }] });
const rateLimited = (headers?: Record<string, string>) =>
  reply({ error: { message: 'exceeded rate limit' } }, { status: 429, headers });

afterEach(() => vi.restoreAllMocks());

describe('azureChatComplete — a 429 is flow control, not a fatal error', () => {
  it('retries a 429 and returns the eventual answer', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(ok());

    const out = await azureChatComplete(cfg, opts);

    expect(out).toBe('ANSWER');
    expect(fetchMock).toHaveBeenCalledTimes(3); // two rejections, then through
  });

  it('honours Retry-After when the server sends one', async () => {
    const sleepSpy = vi.spyOn(globalThis, 'setTimeout');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rateLimited({ 'retry-after': '2' }))
      .mockResolvedValueOnce(ok());

    await azureChatComplete(cfg, opts);

    // The server said 2 seconds. We must wait ~2s, not our own guessed backoff.
    const waited = sleepSpy.mock.calls.map(c => c[1]);
    expect(waited).toContain(2000);
  });

  it('retries 5xx too — a transient blip must not kill a 90-minute run', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ error: { message: 'upstream' } }, { status: 503 }))
      .mockResolvedValueOnce(ok());

    await expect(azureChatComplete(cfg, opts)).resolves.toBe('ANSWER');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 400 — a bad request will never succeed, and retrying hides the bug', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(reply({ error: { message: 'bad model' } }, { status: 400 }));

    await expect(azureChatComplete(cfg, opts)).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // exactly once. no pointless backoff.
  });

  it('gives up eventually, and says the rate limit is the cause rather than blaming the request', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(rateLimited());

    // An operator reading this failure must be pointed at --answer-concurrency /
    // deployment quota, not sent hunting for a bug in the prompt.
    // Fast policy: exercising EXHAUSTION with the real 1s->2s->4s->...->60s
    // backoff would make this test sit for a minute, which is how tests get
    // skipped. The policy is a seam precisely so this stays honest AND fast.
    const fast = { maxRetries: 2, baseBackoffMs: 1 };
    await expect(azureChatComplete(cfg, opts, fast)).rejects.toThrow(/RATE LIMIT/);
    await expect(azureChatComplete(cfg, opts, fast)).rejects.toThrow(/answer-concurrency/);
  });
});
