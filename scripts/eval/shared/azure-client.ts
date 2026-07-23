/**
 * Minimal Azure OpenAI chat-completions client — plain fetch, no `openai`
 * npm dependency (keeps package.json untouched, per the "new files only"
 * scope for this adapter).
 *
 * gpt-5-mini is a reasoning model: it takes `max_completion_tokens` (not
 * `max_tokens`) and `reasoning_effort`, and does not accept a `temperature`
 * override (verified live 2026-07-08 — omit it entirely, default is fine).
 */
import type { AzureConfig } from './config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AzureChatOptions {
  messages: ChatMessage[];
  maxCompletionTokens: number;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  deployment: string;
}

/**
 * Azure rate-limit (429) retry policy.
 *
 * There was NO retry here at all — not even for the strictly-serial caller. The
 * full-suite LoCoMo run (n=1986) only ever completed because serial requests
 * happened to stay under the deployment's limit BY ACCIDENT.
 *
 * PR #253 then made the answering phase concurrent (default 8) and handed it
 * nothing to survive a 429 with. The very next real run died:
 *
 *   Azure chat completion failed (HTTP 429) on deployment gpt-5-mini:
 *     Your requests to gpt-5-mini in centralus have exceeded rate limit.
 *
 * #253's tests proved the ORDERING and DETERMINISM of the concurrency were
 * correct. They said nothing about whether it survives a rate limit — so it
 * shipped green and broken. A passing test and a working feature are not the
 * same thing.
 *
 * 429 is not an error here. It is FLOW CONTROL, and the server is telling us the
 * rate it will accept. Respect `Retry-After` when present; otherwise back off
 * exponentially with jitter (jitter matters: N concurrent workers that all sleep
 * the SAME duration will retry in lockstep and re-trip the limit together).
 *
 * 5xx is also retried — a transient upstream blip should not kill a 90-minute
 * benchmark run. So is a NETWORK-level throw (ECONNRESET / socket closed /
 * timeout), where `fetch` rejects before any HTTP response arrives: same
 * transient class, same backoff, so one dropped socket can't discard a run.
 */
const MAX_RETRIES = 6;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Test seam. Real backoff runs 1s -> 2s -> 4s -> ... -> 60s, so a test that
 * exercises the give-up path honestly would sit there for a minute. Overriding
 * the policy is the only way to test EXHAUSTION without either faking timers
 * (fragile around async/await) or making the test suite slow enough that people
 * start skipping it.
 *
 * Also genuinely useful operationally: a caller who would rather fail fast than
 * back off for a minute can say so.
 */
export interface RetryPolicy {
  maxRetries?: number;
  baseBackoffMs?: number;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Honour `Retry-After` (seconds, or an HTTP-date) when the server sends one. */
function retryAfterMs(res: Response): number | null {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

export async function azureChatComplete(
  cfg: AzureConfig,
  opts: AzureChatOptions,
  retry: RetryPolicy = {},
): Promise<string> {
  const maxRetries = retry.maxRetries ?? MAX_RETRIES;
  const baseBackoffMs = retry.baseBackoffMs ?? BASE_BACKOFF_MS;
  const url = `${cfg.endpoint.replace(/\/$/, '')}/openai/deployments/${opts.deployment}/chat/completions?api-version=${cfg.apiVersion}`;
  const body: Record<string, unknown> = {
    messages: opts.messages,
    max_completion_tokens: opts.maxCompletionTokens,
  };
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;

  let lastStatus = 0;
  let lastMessage = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'api-key': cfg.key, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // NETWORK-level failure (ECONNRESET, socket closed unexpectedly,
      // ETIMEDOUT, DNS): the request never received an HTTP response, so
      // `fetch` itself throws instead of returning a status. This is the SAME
      // transient class as a 5xx and MUST be retried the same way — before
      // this catch existed, a single dropped socket on request #300 of a
      // 600-call run rejected the whole Promise.all and discarded the run
      // (observed 2026-07-20 on the oracle-factorial Tier-A gate: one
      // ECONNRESET mid-cell killed an otherwise-complete run).
      lastStatus = 0;
      lastMessage = err instanceof Error ? err.message : String(err);
      if (attempt === maxRetries) break;
      const exp = Math.min(baseBackoffMs * 2 ** attempt, MAX_BACKOFF_MS);
      await sleep(Math.random() * exp);
      continue;
    }

    if (res.ok) {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      };
      const choice = json.choices?.[0];
      const content = choice?.message?.content;
      if (content === undefined) {
        throw new Error(
          `Azure chat completion returned no content (finish_reason=${choice?.finish_reason ?? 'unknown'}) — raw: ${JSON.stringify(json)}`,
        );
      }
      return content;
    }

    // Retryable: 429 (rate limit — flow control, not an error) and 5xx (transient).
    const retryable = res.status === 429 || res.status >= 500;
    const parsed = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    lastStatus = res.status;
    lastMessage = parsed.error?.message ?? '';

    if (!retryable || attempt === maxRetries) break;

    // Exponential backoff with FULL JITTER. The jitter is load-bearing: without
    // it, every concurrent worker sleeps the identical duration and they all
    // retry in lockstep, re-tripping the same limit.
    const exp = Math.min(baseBackoffMs * 2 ** attempt, MAX_BACKOFF_MS);
    const waitMs = retryAfterMs(res) ?? Math.random() * exp;
    await sleep(waitMs);
  }

  throw new Error(
    (lastStatus === 0
      ? `Azure chat completion failed (network error, no HTTP response) on deployment ${opts.deployment} after ${maxRetries + 1} attempts: ${lastMessage}`
      : `Azure chat completion failed (HTTP ${lastStatus}) on deployment ${opts.deployment} after ${maxRetries + 1} attempts: ${lastMessage}`) +
      `\n\n` +
      (lastStatus === 429
        ? `This is a RATE LIMIT, not a bug in the request. Either lower --answer-concurrency ` +
          `(default 8, see DEFAULT_ANSWER_CONCURRENCY in scripts/eval/locomo/answer.mts) or raise the ` +
          `deployment's quota. The retry policy already backed off ${maxRetries} times and still could not get through.`
        : ''),
  );
}
