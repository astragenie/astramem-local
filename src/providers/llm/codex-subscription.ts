import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ChatMsg, ChatOpts, ChatResult, LLMHealth, LLMProvider } from '../../contracts/llm.js';
import { TransientError, DeterministicError } from '../../pipeline/errors.js';
import { childLogger } from '../../log/logger.js';

/**
 * EXPERIMENTAL — reuses a user's existing `codex login` ("Sign in with
 * ChatGPT") session to call the unofficial ChatGPT Codex backend instead of
 * a metered API key. This transits OpenAI's ChatGPT product surface rather
 * than the public API, is not an officially supported integration path, and
 * can break without notice if OpenAI changes the endpoint. Extraction /
 * compaction traffic counts against the user's ChatGPT subscription quota
 * and may carry ToS risk for their OpenAI account — see docs/providers.md.
 *
 * Reference: endpoint shape, headers, auth.json schema, and the OAuth
 * refresh flow were confirmed against github.com/joeychilson/openresponses
 * (Go Codex client) and OpenAI's own developers.openai.com/codex/auth docs
 * — see docs/providers.md for the full citation trail.
 *
 * Live-verified against a real ~/.codex/auth.json (copied to a scratch path,
 * never the live file) on 2026-07-08 — see docs/providers.md "verified live
 * vs mocked" for the full write-up. Three corrections the mocked-only
 * version got wrong, found only by making a real call:
 *   1. `input` must be an array of {role, content} items, not a joined
 *      string — a string gets HTTP 400 "Input must be a list".
 *   2. `stream: true` is REQUIRED — the endpoint refuses a non-streaming
 *      request with HTTP 400 "Stream must be set to true". The response
 *      body is Server-Sent Events, not a single JSON object; see
 *      `parseSseResponse` below.
 *   3. `reasoning.effort: 'minimal'` is rejected for every model in the
 *      catalog (`'minimal' is not supported ... Supported values are:
 *      none, low, medium, high, xhigh'`) — using 'low' instead.
 * `chatgpt_account_id` resolution was also fixed (see resolveAccountId doc
 * comment) after live evidence showed the real claim shape differs from
 * what was assumed.
 */

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
/** Public OAuth client id used by the Codex CLI itself — not a secret. */
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/**
 * Default model for the codex-subscription tier — the cheapest/lightest
 * model in the catalog. Live-verified (2026-07-08) against a real
 * `~/.codex/models_cache.json` (Codex CLI 0.142.2): the full catalog was
 * exactly `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `codex-auto-review` — the
 * `-mini` suffix and lack of speed/service tiers make `gpt-5.4-mini` the
 * clear cheap-tier pick. OpenAI's model naming moves fast; verify against
 * your own `~/.codex/models_cache.json` and override via
 * config.llm.{compaction,extraction}.model if this drifts.
 */
const DEFAULT_MODEL = 'gpt-5.4-mini';

const CHAT_TIMEOUT_MS = 60_000;
const REFRESH_TIMEOUT_MS = 15_000;

export interface CodexSubscriptionLLMConfig {
  model?: string;
  /** Override for ~/.codex/auth.json — test-only seam; production callers
   * should leave this unset and use the real Codex CLI location. */
  authPath?: string;
}

interface CodexAuthTokens {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  /** Live-verified (2026-07-08, real ~/.codex/auth.json, Codex CLI 0.142.2):
   * a plain account-id string is written directly here — simpler and more
   * reliable than decoding it out of a JWT claim. Prefer this field; the JWT
   * claim decode below is the fallback for older auth.json files that predate
   * it. */
  account_id?: string;
}

interface CodexAuthFile {
  auth_mode?: string;
  tokens: CodexAuthTokens;
  last_refresh?: string;
}

/** One `event: <type>\ndata: <json>` block from the SSE response body. */
interface CodexSseEvent {
  type?: string;
  item?: {
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  response?: {
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}

interface CodexChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Parses the Server-Sent Events body the ChatGPT Codex backend returns
 * (live-verified 2026-07-08 — `stream: true` is mandatory; the endpoint
 * rejects a non-streaming request outright, so there is no plain-JSON
 * response shape to fall back to).
 *
 * Text comes from the `response.output_item.done` event whose
 * `item.type === 'message'` (there is also a `reasoning`-type item, which
 * must be skipped — it holds encrypted chain-of-thought, not the answer).
 * Usage comes from the terminal `response.completed` event's
 * `response.usage` — note `response.completed`'s own `response.output` is
 * observed EMPTY in practice; the message text is only ever found on the
 * intermediate `output_item.done` event, not reconstructed from the
 * completed envelope.
 */
function parseSseResponse(raw: string): CodexChatResult {
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for (const block of raw.split('\n\n')) {
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
    if (!dataLine) continue;
    let evt: CodexSseEvent;
    try {
      evt = JSON.parse(dataLine.slice('data: '.length)) as CodexSseEvent;
    } catch {
      continue;
    }

    if (evt.type === 'response.output_item.done' && evt.item?.type === 'message') {
      for (const part of evt.item.content ?? []) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          text = part.text;
        }
      }
    }

    if (evt.type === 'response.completed') {
      inputTokens = evt.response?.usage?.input_tokens ?? 0;
      outputTokens = evt.response?.usage?.output_tokens ?? 0;
      // Defensive fallback only — not observed to carry content live (see
      // doc comment above), but cheap to check in case a future backend
      // revision does populate it.
      if (!text) {
        for (const item of evt.response?.output ?? []) {
          if (item.type !== 'message') continue;
          for (const part of item.content ?? []) {
            if (typeof part.text === 'string' && part.text.length > 0) text = part.text;
          }
        }
      }
    }
  }

  return { text, inputTokens, outputTokens };
}

function defaultAuthPath(): string {
  return join(homedir(), '.codex', 'auth.json');
}

/** Decode a JWT's payload (middle segment) without verifying the signature —
 * we trust the token because it came from our own local auth.json / a
 * same-process refresh response, not from an untrusted third party. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return undefined;
    const b64 = (parts[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Live-verified (2026-07-08): `chatgpt_account_id` is NOT a top-level JWT
 * claim — it's nested under the `https://api.openai.com/auth` claim, e.g.
 * `{ "https://api.openai.com/auth": { "chatgpt_account_id": "...", ... } }`.
 * A prior version of this file looked for a top-level claim and would
 * silently never find an account id from either token. */
function decodeNestedChatgptAccountId(jwt: string): string | undefined {
  const payload = decodeJwtPayload(jwt);
  const auth = payload?.['https://api.openai.com/auth'];
  if (auth && typeof auth === 'object') {
    const v = (auth as Record<string, unknown>)['chatgpt_account_id'];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/** Resolves the chatgpt-account-id header value: prefer the direct
 * `tokens.account_id` field (live-verified as present on real auth.json —
 * simplest and least brittle), falling back to decoding it out of the
 * id_token / access_token JWT for older auth.json shapes that lack it. */
function resolveAccountId(tokens: CodexAuthTokens): string | null {
  if (tokens.account_id) return tokens.account_id;
  const fromIdToken = tokens.id_token && decodeNestedChatgptAccountId(tokens.id_token);
  if (fromIdToken) return fromIdToken;
  const fromAccessToken = decodeNestedChatgptAccountId(tokens.access_token);
  if (fromAccessToken) return fromAccessToken;
  return null;
}

/** Loads and minimally validates auth.json. Throws a DeterministicError with
 * an actionable message on any failure — missing file, unreadable, or
 * missing the tokens this provider needs — so a misconfigured
 * codex-subscription selection fails the same clear way Azure does when its
 * endpoint/key are missing (providers/index.ts), rather than a confusing
 * downstream stack trace. */
function loadAuthFile(path: string): CodexAuthFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new DeterministicError(
      `codex-subscription: no Codex CLI login found at ${path}. Run \`codex login\` first ` +
        '(requires the Codex CLI — https://developers.openai.com/codex).',
    );
  }
  let parsed: CodexAuthFile;
  try {
    parsed = JSON.parse(raw) as CodexAuthFile;
  } catch (err) {
    throw new DeterministicError(
      `codex-subscription: ${path} is not valid JSON (${err instanceof Error ? err.message : err}). ` +
        'Run `codex login` again.',
    );
  }
  if (!parsed.tokens?.access_token || !parsed.tokens?.refresh_token) {
    throw new DeterministicError(
      `codex-subscription: ${path} is missing tokens.access_token/refresh_token. Run \`codex login\` again.`,
    );
  }
  return parsed;
}

/** Best-effort atomic write-back of rotated tokens, mirroring the tmp+rename
 * pattern the rest of this codebase uses for config.yaml (config/writer.ts)
 * so a concurrent reader never observes a torn auth.json. Failure to persist
 * is non-fatal: the refreshed token is still used for the rest of this
 * process even if the write-back fails (e.g. read-only auth.json). */
function writeAuthFileAtomic(path: string, auth: CodexAuthFile): void {
  const dir = dirname(path);
  const tmp = join(dir, `.auth.json.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(auth, null, 2), 'utf8');
    renameSync(tmp, path);
  } catch {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
  }
}

export class CodexSubscriptionLLMProvider implements LLMProvider {
  readonly name = 'codex-subscription' as const;
  readonly model: string;
  /** Public so doctor probes can check auth.json presence/expiry against the
   * exact path this provider will read — see
   * doctor/probes/codex-subscription-probe.ts. */
  readonly authPath: string;

  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private accountId: string | null = null;
  private authLoaded = false;

  constructor(config: CodexSubscriptionLLMConfig = {}) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.authPath = config.authPath ?? defaultAuthPath();

    childLogger({ provider: this.name, model: this.model }).warn(
      { authPath: this.authPath },
      'codex-subscription is EXPERIMENTAL: extraction/compaction traffic will transit your ChatGPT ' +
        'subscription via an unofficial endpoint, counts against your ChatGPT quota, and may carry ToS ' +
        'risk for your OpenAI account. It can also break without notice if OpenAI changes the endpoint. ' +
        'See docs/providers.md.',
    );
  }

  /** Lazily loads auth.json on first use rather than at construction, so
   * building the provider set at boot (providers/index.ts) never throws for
   * this provider even if login hasn't happened yet — the clear
   * `codex login` error instead surfaces from the first real chat()/health()
   * call (and from the dedicated doctor probe), which is where a distill job
   * can classify it and route to the retry/poison path instead of crashing
   * the daemon. */
  private ensureAuthLoaded(): void {
    if (this.authLoaded) return;
    const auth = loadAuthFile(this.authPath);
    this.accessToken = auth.tokens.access_token;
    this.refreshToken = auth.tokens.refresh_token;
    this.accountId = resolveAccountId(auth.tokens);
    this.authLoaded = true;
  }

  private async refresh(): Promise<void> {
    if (!this.refreshToken) {
      throw new DeterministicError(
        'codex-subscription: token refresh failed — no refresh_token available. Run `codex login` again.',
      );
    }
    let res: Response;
    try {
      res = await fetch(CODEX_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
          client_id: CODEX_OAUTH_CLIENT_ID,
        }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new TransientError(
        `codex-subscription: token refresh request failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new DeterministicError(
        `codex-subscription: token refresh failed — re-login required (HTTP ${res.status}). ` +
          `Run \`codex login\` again. ${body.slice(0, 200)}`,
      );
    }

    const data = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
    if (!data.access_token) {
      throw new DeterministicError(
        'codex-subscription: token refresh response missing access_token — re-login required. Run `codex login` again.',
      );
    }
    this.accessToken = data.access_token;
    if (data.refresh_token) this.refreshToken = data.refresh_token;
    if (data.id_token) {
      const acct = decodeNestedChatgptAccountId(data.id_token);
      if (acct) this.accountId = acct;
    }

    // Persist rotated tokens back to auth.json, mirroring what the Codex CLI
    // itself does — best-effort (see writeAuthFileAtomic doc comment).
    // account_id is preserved from the in-memory value (the refresh response
    // doesn't repeat auth.json's direct tokens.account_id field — see
    // resolveAccountId doc comment).
    writeAuthFileAtomic(this.authPath, {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: this.accessToken,
        refresh_token: this.refreshToken ?? '',
        ...(data.id_token ? { id_token: data.id_token } : {}),
        ...(this.accountId ? { account_id: this.accountId } : {}),
      },
      last_refresh: new Date().toISOString(),
    });
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.accessToken}`,
      originator: 'astramemory-local',
      'openai-beta': 'responses=experimental',
    };
    if (this.accountId) headers['chatgpt-account-id'] = this.accountId;
    return headers;
  }

  private callResponses(body: Record<string, unknown>): Promise<Response> {
    return fetch(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
  }

  async chat(messages: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
    this.ensureAuthLoaded();
    const log = childLogger({ provider: this.name, model: this.model });
    const t0 = Date.now();

    // Map our {role, content}[] chat interface onto the Responses API's
    // instructions/input split: system messages become `instructions` (the
    // pipeline's system prompt), the rest are folded into a single `input`
    // turn-labeled string. Distill call sites (05-extract.ts, 04-compact.ts)
    // send exactly one system + one user message, so this is lossless for
    // the actual traffic this provider will see in practice.
    //
    // Live-verified (2026-07-08): `input` as a joined STRING gets HTTP 400
    // "Input must be a list" from the real backend — it must be an array of
    // {role, content} message items (the standard Responses API `input`
    // item-list shape), not a single string like `instructions` is.
    const systemMsgs = messages.filter((m) => m.role === 'system').map((m) => m.content);
    const rest = messages.filter((m) => m.role !== 'system');
    const instructions = systemMsgs.length > 0 ? systemMsgs.join('\n\n') : 'You are a helpful assistant.';
    const input = rest.map((m) => ({ role: m.role, content: m.content }));

    // The Responses API rejects `text.format.json_object` with HTTP 400
    // ("input messages must contain the word 'json' …") unless the literal
    // word "json" appears in the INPUT items (instructions do NOT count).
    // Append a minimal hint to the last input item when json mode is on and
    // it's otherwise absent, so extraction prompts that don't happen to say
    // "json" still work on this backend.
    if (opts?.json === true && !input.some((m) => /json/i.test(String(m.content)))) {
      if (input.length > 0) {
        const last = input[input.length - 1]!;
        input[input.length - 1] = { role: last.role, content: `${last.content}\n\nRespond with valid JSON only.` };
      } else {
        input.push({ role: 'user', content: 'Respond with valid JSON only.' });
      }
    }

    const body: Record<string, unknown> = {
      model: this.model,
      instructions,
      input,
      store: false,
      include: ['reasoning.encrypted_content'],
      // Live-verified (2026-07-08): 'minimal' is rejected for every model in
      // the catalog ("Supported values are: none, low, medium, high, xhigh")
      // — 'low' is the cheapest value that's actually accepted.
      reasoning: { effort: 'low' },
      // Live-verified (2026-07-08): the endpoint refuses a non-streaming
      // request with HTTP 400 "Stream must be set to true" — this is
      // mandatory, not an optional performance knob. Response body is
      // Server-Sent Events; see parseSseResponse.
      stream: true,
      // opts.maxTokens / opts.temperature are intentionally NOT forwarded.
      // Live-verified (2026-07-08): this endpoint rejects both outright —
      // `max_output_tokens` -> HTTP 400 "Unsupported parameter:
      // max_output_tokens", `max_tokens` -> same for that name, and
      // `temperature` -> HTTP 400 "Unsupported parameter: temperature".
      // There is no working parameter name for either on this backend as
      // of this verification; a caller-requested cap/temperature is
      // silently unenforceable here rather than erroring the whole call.
      // See docs/providers.md remaining risks.
      //
      // Live-verified (2026-07-08): `text.format.json_object` IS honored —
      // a JSON-only prompt with this set returned valid, parseable JSON.
      ...(opts?.json ? { text: { format: { type: 'json_object' } } } : {}),
    };

    let res = await this.callResponses(body);
    if (res.status === 401) {
      log.warn('codex-subscription received 401 — attempting token refresh');
      await this.refresh();
      res = await this.callResponses(body);
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      const snippet = raw.slice(0, 200);
      const latency_ms = Date.now() - t0;
      log.warn({ latency_ms, status: res.status }, 'codex-subscription chat failed');
      if (res.status === 401) {
        throw new DeterministicError(
          `codex-subscription: still unauthorized after token refresh — re-login required. ` +
            `Run \`codex login\`. ${snippet}`,
        );
      }
      if (res.status >= 500 || res.status === 429) {
        throw new TransientError(`codex-subscription chat failed: HTTP ${res.status} — ${snippet}`);
      }
      throw new DeterministicError(`codex-subscription chat failed: HTTP ${res.status} — ${snippet}`);
    }

    const raw = await res.text();
    const { text, inputTokens: inTokens, outputTokens: outTokens } = parseSseResponse(raw);
    const latency_ms = Date.now() - t0;

    // Subscription-quota usage has no per-token USD price — always 0 (see
    // pricing.ts's "unknown model" convention, which this deliberately
    // matches rather than inventing a number).
    log.info({ latency_ms, tokens_in: inTokens, tokens_out: outTokens, usd: 0 }, 'codex-subscription chat ok');

    return {
      text,
      usage: { in: inTokens, out: outTokens, usd: 0 },
    };
  }

  async health(): Promise<LLMHealth> {
    const t0 = Date.now();
    try {
      this.ensureAuthLoaded();
      await this.chat([{ role: 'user', content: 'ping' }], { maxTokens: 1 });
      return {
        ok: true,
        model: this.model,
        latency_ms: Date.now() - t0,
      };
    } catch (err) {
      return {
        ok: false,
        model: this.model,
        latency_ms: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
