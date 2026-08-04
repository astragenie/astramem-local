# Provider setup

AstraMemory Local's LLM stages (compaction, extraction) support five provider implementations:
Ollama (local, free), Azure OpenAI (cloud), a generic `openai-compatible` client (OpenAI API,
Groq, vLLM, LM Studio, ...), `codex-subscription` (reuses a Codex CLI ChatGPT login instead of a
metered key — **this is the shipped default as of v0.18.0**, not an obscure option), and
`anthropic` (Claude, via the native Messages API). On top of `openai-compatible`, four curated
**presets** — Groq, Gemini, Kimi (Moonshot), DeepSeek — were added in Wave 1 BYO (PR #414) so the
`init` wizard can offer them as one-click choices instead of asking you to hand-type a base URL;
each preset is not a new provider, just a named `{baseUrl, defaultModel}` pair. Embedding supports
Ollama, Azure OpenAI, and ONNX — an in-process, no-server-required provider that is the **shipped
default** as of ADR-018 (S4, 2026-07-15), even when the LLM provider is Ollama or something else.
You configure LLM providers independently for the compaction stage and the extraction stage.

**Quick picker:**

| You want                                             | Use                                    |
|-------------------------------------------------------|-----------------------------------------|
| Zero setup, already have `codex login` done            | `codex-subscription` (the default)     |
| Fully local, free, no cloud account                    | `ollama`                               |
| Best JSON-mode reliability, willing to pay per token    | Azure OpenAI or Anthropic              |
| Already have a Claude subscription/API key              | `anthropic`                            |
| Fastest cloud inference, open-weight models             | `openai-compatible` + Groq preset      |
| Already have a Gemini API key                           | `openai-compatible` + Gemini preset (partial JSON-mode — see caveat below) |
| Already have a Kimi/Moonshot or DeepSeek key             | `openai-compatible` + that preset      |

---

## Ollama (recommended for local use)

Ollama runs LLMs and embedding models on your machine. It is free and requires no API key.

### 1. Install Ollama

Download from [ollama.com](https://ollama.com) or install via package manager:

```bash
# macOS
brew install ollama

# Linux (x86_64 or arm64)
curl -fsSL https://ollama.com/install.sh | sh

# Windows
# Download OllamaSetup.exe from https://ollama.com/download/windows
```

### 2. Start the Ollama server

```bash
ollama serve
```

The server listens on `http://127.0.0.1:11434` by default. Add it to your startup if you want
it always available:

```bash
# macOS — Ollama app auto-starts; or:
brew services start ollama

# Linux systemd
systemctl --user enable --now ollama

# Windows — the installer registers a system tray app that starts on login
```

### 3. Pull required models

For LLM (compaction + extraction):

```bash
ollama pull qwen2.5:7b
```

For embedding:

```bash
ollama pull mxbai-embed-large
```

Verify both are available:

```bash
ollama list
```

Expected output includes:

```
NAME                            ID              SIZE
qwen2.5:7b                     ...             4.7 GB
mxbai-embed-large               ...             670 MB
```

### 4. Configure AstraMemory Local

In `config.yaml`:

```yaml
llm:
  compaction:
    provider: ollama
    model: qwen2.5:7b
  extraction:
    provider: ollama
    model: qwen2.5:7b

embedding:
  provider: ollama
  model: mxbai-embed-large
  dim: 1024

ollama:
  baseUrl: http://127.0.0.1:11434
```

### 5. Verify

```bash
astramem-local providers test ollama
```

Expected:

```
  LLM (ollama / qwen2.5:7b)  ok   latency=1234ms
  Embed (ollama / mxbai-embed-large)  ok   dim=1024
```

### On-demand setup in the `init` wizard

Ollama is **on-demand, not required** — the wizard never hard-requires a local Ollama install.
Whenever your provider selections imply Ollama (embedding provider, LLM provider, or both), `init`
asks how you want to get it ready:

1. **Install/pull the required model(s) now** — the wizard shows the exact download size and RAM
   guidance for each model *before* pulling anything, plus a "first run may take 10-30 min"
   notice (large models over a slow connection can take a while). You confirm before any network
   activity starts.
2. **Point at an existing Ollama server** — already running Ollama elsewhere (another machine, a
   container, WSL)? Enter its base URL and the wizard skips local install/pull checks entirely,
   writing your URL to `ollama.baseUrl` in `config.yaml`.
3. **Skip for now** — the daemon starts in its normal degraded-boot mode (`/health` reports
   `degraded` until the provider becomes reachable — see the main README's boot section). Run
   `astramem-local doctor` after installing Ollama, or pull the printed model names manually,
   whenever you're ready.

If the `ollama` binary itself isn't found on your system when the "install now" path runs, the
wizard prompts with per-OS install guidance (brew/curl/installer link) rather than a warning you
might scroll past — you explicitly choose whether to continue with a degraded start or stop and
install first.

Non-interactive/scripted installs (`ASTRA_MEMORY_INIT_NONINTERACTIVE=1`) keep the original
env-driven behavior: Ollama is checked and missing models are auto-pulled unconditionally, no
prompts. Two extra env vars are available for scripted installs:

| Env var                                | Effect                                                    |
|-----------------------------------------|------------------------------------------------------------|
| `ASTRA_MEMORY_INIT_OLLAMA_MODEL_TAG`    | Overrides the extraction/compaction model tag (see tiers below) |
| `ASTRA_MEMORY_INIT_OLLAMA_BASE_URL`     | Overrides `ollama.baseUrl` written to `config.yaml`        |

### Extraction/compaction model tier

When the LLM provider is Ollama, `init` offers a tier picker for the extraction/compaction model
instead of hard-coding a tag. As of 2026-07-14 there is a single curated tier — `qwen2.5:7b`,
**restored** as RECOMMENDED/default after a same-day detour through `qwen3:8b` (tried 2026-07-13,
retired the same day it shipped: it returned empty extraction output under thinking mode and blew
this hardware class's VRAM ceiling once the embedder was resident alongside it) and, briefly,
`qwen3.5:4b` (fast and VRAM-safe, but under-extracted atoms from real conversational transcripts).
`qwen2.5:7b` scores F1 67%/precision 99% in the 2026-07-08 extraction-bench A/B — the strongest
local model measured on actual atom extraction, not just the safest one left standing.

| Tier                          | Model                | Download | RAM recommended | Benchmark                                    |
|--------------------------------|-----------------------|----------|------------------|-----------------------------------------------|
| RECOMMENDED (default)          | `qwen2.5:7b`          | ~4.7 GB  | 8 GB             | F1 67%, precision 99% (extraction-bench, 2026-07-08 A/B) |
| BYO cloud                      | azure-openai / openai-compatible / codex-subscription (pivots the wizard to the existing cloud provider option) | n/a — no local download | n/a | varies by provider |
| Custom                          | (free-text model tag) | varies — check `ollama show <model>` | varies | not benchmarked |

`qwen2.5:7b` fits an 8 GB VRAM card with real headroom alongside the `mxbai-embed-large` embedder
(~0.67 GB) — unlike `qwen3:8b` (5.76 GB resident with flash-attention + a q8 KV cache, ~6.2 GB
without), which exceeded the ceiling, spilled layers to CPU, and poisoned distill jobs via
timeout. See the main README's system-requirements callout for the current total.

`qwen2.5-coder:14b` ("quality" tier in earlier wizard versions) remains **dropped from the curated
list entirely** — the 2026-07-08 benchmark showed a 20% permanent-failure (poison) rate and
72.7s/session, strictly worse than the local tiers on every axis. `qwen2.5-coder:7b` (F1 59%, the
former "fastest" tier) is also not a curated tier — it's outperformed by `qwen2.5:7b` on
extraction quality. Any of these, or another model, is still reachable via the "custom" tier if
you have a specific reason to.

Note that since v0.18.0 the wizard's actual default LLM provider is `codex-subscription`, not
Ollama at all — the tier picker above only appears when you explicitly choose (or fall back to)
Ollama for the LLM stage. See the Quick picker table at the top of this document.

The chosen tag is written to both `llm.compaction.model` and `llm.extraction.model` in
`config.yaml` (this wizard configures both stages with the same provider/model — mix providers
per-stage by hand-editing `config.yaml` afterward if you need Azure for one stage and Ollama for
the other). Choosing "BYO cloud" from this picker is equivalent to having picked `azure-openai` as
the LLM provider up front — the wizard immediately asks for the Azure endpoint/deployment/key
prompts it would have asked anyway.

### Alternative Ollama models

You can substitute any Ollama model that supports JSON mode for extraction:

| Use case   | Alternative model          | Notes                               |
|------------|----------------------------|-------------------------------------|
| LLM        | `qwen2.5-coder:7b`        | Fastest extraction, ~5GB            |
| LLM        | `mistral:7b`               | Fast, good JSON mode                |
| LLM        | `phi4:14b`                 | Best quality, ~9GB, needs 16GB RAM  |
| Embedding  | `all-minilm`               | 384-dim — needs a dim migration first |

`mxbai-embed-large` (1024-dim) is the default embedding model and matches the schema's default
dimension out of the box. The embedding model must produce exactly `embedding.dim`-dimensional
vectors. Switching to `all-minilm` or another model with a different native dimension requires
updating `embedding.dim` to match AND running the resumable `astramem-local reembed-dim` procedure
against an existing database — see docs/embed-dim-migration.md. A fresh install can just set
`embedding.dim` before the first run.

> **Do not use `nomic-embed-text-v2-moe`** as the embedding model — it is a 768-dim model and does
> not match this project's 1024-dim default schema.

---

## Azure OpenAI

Azure OpenAI provides GPT-4.1 and text-embedding-3 via a dedicated Azure resource. API calls
incur cost; the daily budget cap in `config.yaml` applies.

### 1. Create an Azure OpenAI resource

In the Azure portal:
1. Search for "Azure OpenAI".
2. Create a resource (select a region that supports GPT-4.1 and text-embedding-3).
3. After deployment, open the resource and click **Keys and Endpoint** — copy the endpoint and
   either key.

### 2. Deploy models

In **Azure OpenAI Studio** (studio.azureopenai.azure.com) or via Azure CLI:

```bash
# LLM deployment
az cognitiveservices account deployment create \
  --resource-group <rg> --name <resource-name> \
  --deployment-name gpt-4-1 \
  --model-name gpt-4.1 --model-version "2025-04-14" \
  --sku-name Standard --sku-capacity 10

# Embedding deployment
az cognitiveservices account deployment create \
  --resource-group <rg> --name <resource-name> \
  --deployment-name text-embedding-3-small \
  --model-name text-embedding-3-small --model-version "1" \
  --sku-name Standard --sku-capacity 10
```

Note: the embedding deployment must be configured with `dimensions=1024` at query time
(AstraMemory Local passes this parameter automatically for `text-embedding-3-small`).

### 3. Write secrets

Add to `~/.config/astra-memory/secrets.env` (mode 0600):

```bash
AZURE_OPENAI_ENDPOINT=https://<resource-name>.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=gpt-4-1
AZURE_OPENAI_EMBED_DEPLOYMENT=text-embedding-3-small
AZURE_OPENAI_API_KEY=<key1-or-key2>
```

On Windows use `%APPDATA%\Astramem\secrets.env`.

### 4. Configure AstraMemory Local

In `config.yaml`:

```yaml
llm:
  compaction:
    provider: azure-openai
    model: gpt-4-1                    # must match deployment name above
  extraction:
    provider: azure-openai
    model: gpt-4-1

embedding:
  provider: azure-openai
  model: text-embedding-3-small       # must match embed deployment name
  dim: 1024

azure:
  apiVersion: "2024-10-21"
  # endpoint and deployment are read from secrets.env
```

### 5. Verify

```bash
astramem-local providers test azure-openai
```

Expected:

```
  LLM   (azure-openai / gpt-4-1)                ok   latency=820ms
  Embed (azure-openai / text-embedding-3-small)  ok   dim=1024
```

### Cost reference

At typical usage (50 turns per session, 2 sessions per day):

| Operation          | Tokens/day (est.) | Cost/day (est.)  |
|--------------------|-------------------|------------------|
| LLM compaction     | ~10K input tokens | ~$0.04           |
| LLM extraction     | ~15K tokens total | ~$0.06           |
| Embedding (~15 atoms) | ~3K tokens    | ~$0.001          |
| **Total**          |                   | **~$0.10/day**   |

With the default $10/day cap you have ~100 sessions of headroom before the budget is reached.

---

## OpenAI-compatible (OpenAI API, Groq, vLLM, LM Studio, ...)

A generic `/v1/chat/completions`-style client for the LLM stages (compaction/extraction) only —
not usable for embedding. Works against the real OpenAI API, Groq, a local vLLM/LM Studio server,
or anything else that speaks the same wire shape.

### 1. Configure

```yaml
llm:
  compaction:
    provider: openai-compatible
    model: gpt-4o-mini          # or llama-3.1-70b-versatile (Groq), etc.
  extraction:
    provider: openai-compatible
    model: gpt-4o-mini

openaiCompatible:
  baseUrl: https://api.openai.com/v1   # or http://localhost:8000/v1 for local vLLM
  apiKeyEnv: OPENAI_COMPAT_API_KEY     # env var name to read the key from (default shown)
```

### 2. Write the key

```bash
echo "OPENAI_COMPAT_API_KEY=sk-..." >> ~/.config/astra-memory/secrets.env
```

Leave the key unset entirely for endpoints that require no auth (e.g. a local vLLM server with
no `--api-key` flag) — the provider omits the `Authorization` header rather than failing.

### 3. Verify

```bash
node dist/cli/index.js doctor
```

Doctor runs a real 1-token chat call (same generic LLM chat probe every provider gets) plus an
`openai-compatible`-specific `GET <baseUrl>/models` reachability check.

Pricing: only a handful of well-known model ids have cost data (`src/providers/llm/pricing.ts`);
anything else (Groq model names, local vLLM model paths) reports `usd: 0` rather than a guess.

---

## Codex subscription (default — uses your ChatGPT quota, not billed API usage)

> As of v0.18.0 this is the **shipped default** for both `llm.compaction.provider` and
> `llm.extraction.provider` (`defaultConfig()`, `src/config/config.ts`) — the `init` wizard also
> defaults here whenever it detects `~/.codex/auth.json` already exists. It remains EXPERIMENTAL
> in the sense described below: an unofficial endpoint, ToS-gray-zone, and no per-call USD cost
> visibility (usage is metered by your ChatGPT plan's Codex quota, not `budget.daily_usd`).

> **Read this before enabling.** `codex-subscription` reuses the OAuth session created by
> `codex login` ("Sign in with ChatGPT") to call the **unofficial** ChatGPT Codex backend
> (`https://chatgpt.com/backend-api/codex/responses`) instead of the metered OpenAI API. This is
> not an officially supported integration path:
> - Extraction/compaction traffic transits your ChatGPT account and counts against your ChatGPT
>   subscription's Codex quota, not API billing.
>   Whether this falls inside or outside OpenAI's Terms of Service for your account is a
>   **you-own-that-risk** decision — AstraMemory Local does not represent it as sanctioned.
> - The endpoint, headers, and token-refresh flow are the same ones the Codex CLI itself uses,
>   reverse-engineered by third parties (see "Reference implementation" below) — OpenAI can change
>   or block this at any time without notice, and this provider would then start failing.
> - A construction-time WARN log line and a doctor probe both surface the experimental status;
>   there is no way to silence it short of not selecting this provider.

### 1. Prerequisite: `codex login`

Install the [Codex CLI](https://developers.openai.com/codex) and run `codex login` once. This
writes `~/.codex/auth.json` (Windows: `%USERPROFILE%\.codex\auth.json`) containing OAuth tokens.
AstraMemory Local never runs the login flow itself — it only reads the resulting file.

### 2. Configure

```yaml
llm:
  compaction:
    provider: codex-subscription
    model: gpt-5.4-mini    # cheapest tier — live-verified against ~/.codex/models_cache.json (2026-07-08)
  extraction:
    provider: codex-subscription
    model: gpt-5.4-mini

codexSubscription: {}            # authPath override only needed for non-default CODEX_HOME
```

The model catalog moves fast — check your own `~/.codex/models_cache.json` (`models[].slug`) rather
than trusting this default indefinitely.

`init` only offers this choice interactively when it detects `~/.codex/auth.json` already exists.

### 3. Verify

```bash
node dist/cli/index.js doctor
```

Doctor runs a `Codex auth` check (auth.json presence + access-token expiry, no network call) plus
the generic LLM chat probe (a real 1-token call).

### Quota exhaustion: the 2026-07-17 incident, and how to recover

**What happened:** the `codex-subscription` provider started returning `401` when the account's
ChatGPT Codex quota was exhausted. The provider's own retry (see "Failure behavior" below)
refreshes the OAuth token and retries once, but a *quota* 401 isn't fixed by a token refresh — the
retry also 401s, and the distill job goes to `poison` (the normal bounded-retry exhaustion path).
196 distill jobs poisoned this way before the underlying quota recovered (ChatGPT quotas reset on
a rolling window — see your OpenAI account's usage page for your own reset schedule).

**How to recover once the underlying cause is fixed** (quota reset, or a fresh `codex login` if
the real problem was an expired/revoked session): poisoned jobs are not automatically retried —
requeue them explicitly with the `queue requeue --poison` CLI:

```bash
# Re-login first if `codex login status` shows you're logged out:
codex login

# Move poisoned distill jobs back to pending, in a bounded batch:
node dist/cli/index.js queue requeue --poison --kind distill --limit 50

# Watch progress, then requeue the next batch if it drains clean:
node dist/cli/index.js queue
node dist/cli/index.js queue requeue --poison --kind distill --limit 50
```

`--limit N` is deliberately bounded (default: all) so you can drain in monitored batches and stop
if the underlying cause hasn't actually cleared (jobs immediately re-poison — a clear signal to
stop and re-diagnose rather than keep draining). Requeued jobs retain their original
`payload_json`, so a retry re-runs the exact same extraction/compaction work — nothing is lost,
only delayed. `--kind` filters to one job kind (e.g. `distill`); omit it to requeue every poisoned
kind. See `src/cli/queue-requeue.ts` for the full flag reference.

### Failure behavior

- Missing/invalid `auth.json` → a clear `DeterministicError` telling you to run `codex login`;
  the daemon does not crash at boot (auth.json is read lazily, on first chat/health call, not at
  provider construction) — a distill job just fails into the normal retry/poison path.
- Expired access token → the provider transparently refreshes via
  `https://auth.openai.com/oauth/token` and retries once; a failed refresh again surfaces a clear
  re-login message rather than a raw stack trace.
- Rotated tokens are written back to `auth.json` (atomically, tmp+rename) on successful refresh,
  best-effort — an unwritable `auth.json` doesn't fail the request, it just means the refreshed
  token isn't persisted for the next process start.

### Reference implementation used

Endpoint URL, required headers (`Authorization`, `chatgpt-account-id`, `originator`,
`OpenAI-Beta: responses=experimental`), the Responses-API request shape (`instructions`/`input`,
`store: false`, `include: ["reasoning.encrypted_content"]`), and the OAuth refresh flow (token
endpoint, public `client_id`, `grant_type=refresh_token`) were cross-checked against:

- [`github.com/joeychilson/openresponses`](https://pkg.go.dev/github.com/joeychilson/openresponses/codex)
  (Go Codex client) — primary source for the request/response shapes and OAuth constants.
- [`developers.openai.com/codex/auth/ci-cd-auth`](https://developers.openai.com/codex/auth/ci-cd-auth) —
  official confirmation of the `auth.json` schema (`{auth_mode, tokens: {access_token,
  refresh_token, id_token}, last_refresh}`) and the `~/.codex/auth.json` / `CODEX_HOME` location.
- Web search corroboration against public issues in `openclaw/openclaw` (a Codex-backend-consuming
  client) confirming the header set and endpoint in real production use.

### What's verified live vs. what's mocked

**Live-verified 2026-07-08** against a real ChatGPT Plus account's `~/.codex/auth.json` (Codex CLI
0.142.2) — the file was copied to a scratch path and every call in this section ran against the
COPY, never the live file, to avoid any risk to the user's real Codex CLI session. This live pass
found and fixed four real-shape mismatches that the mocked-only version got wrong:

1. **`input` must be an array**, not the joined string this provider originally sent — a string
   gets `HTTP 400 "Input must be a list"`. Fixed to `[{role, content}, ...]`.
2. **`stream: true` is mandatory**, not an optional performance knob — a non-streaming request gets
   `HTTP 400 "Stream must be set to true"`. The response body is Server-Sent Events
   (`event: <type>\ndata: <json>\n\n` blocks), not a single JSON object. The assistant's text lives
   on the `response.output_item.done` event whose `item.type === "message"` — there is also a
   `reasoning`-type item (encrypted chain-of-thought) that must be skipped. The terminal
   `response.completed` event's own `response.output` was observed **empty** in every live call;
   only `response.usage` (`input_tokens`/`output_tokens`) is read from it.
3. **`reasoning.effort: "minimal"` is rejected** for every model in the catalog
   (`"Supported values are: none, low, medium, high, xhigh"`) — using `"low"` instead, the cheapest
   accepted value.
4. **`chatgpt_account_id` is not a top-level JWT claim** — it's nested under the
   `https://api.openai.com/auth` claim, and a prior version of this code looked at the top level
   and would have silently never found an account id from either token. The real auth.json also
   carries a direct `tokens.account_id` field (simpler and now preferred over JWT decoding, with
   the JWT-claim decode kept only as a fallback for older auth.json shapes).

Also live-verified: `text.format.json_object` (JSON mode) **is** honored by the real backend — a
JSON-only prompt with this set returned valid, parseable JSON. `opts.maxTokens` and
`opts.temperature`, however, are **not** forwarded — the endpoint rejects `max_output_tokens`,
`max_tokens`, and `temperature` outright (`HTTP 400 "Unsupported parameter: ..."` for each), so
there is currently no working way to cap output length or set temperature on this backend; a
caller-requested value is silently unenforceable rather than erroring the whole call.

The default model was corrected from a guessed `gpt-5.1-codex-mini` (which doesn't exist in the
catalog at all) to **`gpt-5.4-mini`**, read directly from the real `~/.codex/models_cache.json`
(client_version 0.142.2) — the full catalog was exactly `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`,
`codex-auto-review`; the `-mini` suffix and lack of speed/service tiers make it the clear cheap-tier
pick. This catalog moves fast — re-check your own `~/.codex/models_cache.json` periodically.

The 401 → refresh → retry path was also exercised live: the copy's `access_token` was deliberately
corrupted to force a genuine 401 from the real server, the code's refresh flow ran against the
COPY's refresh_token (hitting the real `https://auth.openai.com/oauth/token`), and the retried
request succeeded. The rotated tokens were correctly written back to the copy (`account_id`
preserved across the rewrite). The original `~/.codex/auth.json` was confirmed byte-identical
(SHA-256 + mtime) before and after this entire exercise — it was never opened for writing.

**One caveat worth flagging plainly**: OAuth refresh tokens are commonly single-use/rotating, and
the copy's refresh exchange used the *same token value* that was also sitting in the original file
at copy time. It's likely (though not confirmed by an intrusive server-side check, which would
itself be a mutating action) that the original file's `refresh_token` is now stale server-side,
even though the file's bytes are untouched. This has no near-term effect — the original
`access_token` remains valid for about 9 more days per its own `exp` claim, and `codex login
status` reported "Logged in using ChatGPT" immediately after the test — but the *next* time the
real Codex CLI's access token expires and it tries to refresh, that refresh could fail, requiring
an ordinary `codex login` re-run. There is no urgency; this is a one-time, already-priced-in
consequence of the verification exercise, not an ongoing risk from normal use of this provider.

Not yet live-verified: multi-turn conversations beyond a single system+user pair, and behavior at
higher `reasoning.effort` values (`medium`/`high`/`xhigh`) or non-mini models (`gpt-5.4`, `gpt-5.5`).

---

## Anthropic (Claude)

`anthropic` speaks the native Anthropic Messages API (`POST /v1/messages`), not the OpenAI-style
`/v1/chat/completions` shape — it is the one genuinely new provider *implementation* in Wave 1 BYO
(the four presets below all reuse `openai-compatible`). LLM stages only — not usable for embedding.

### JSON-mode caveat: forced tool-use, not a text JSON mode

Anthropic has no `response_format:{type:'json_object'}` equivalent. This provider gets structured
JSON back via **forced tool-use**: it defines a tool named `emit_json` and sets
`tool_choice:{type:'tool', name:'emit_json'}`, so the model must call it; the tool's `input` field
comes back as an already-parsed JSON object, which the provider re-serializes to a string so every
existing `JSON.parse(result.text)` call site keeps working unchanged. Practical effect for you:
`anthropic` is the one provider whose structured-output capability is `'tool-use'` rather than
`'json_object'` (`src/providers/llm/capabilities.ts`) — it honors a real `jsonSchema` constraint
(`supportsJsonSchema('anthropic')` is `true`), unlike the `openai-compatible`/`azure-openai`/
`codex-subscription` bucket, which only guarantees *some* valid JSON with no shape guarantee.

### 1. Get an API key

Create a key at [console.anthropic.com](https://console.anthropic.com) (Settings → API Keys).

### 2. Configure

```yaml
llm:
  compaction:
    provider: anthropic
    model: claude-sonnet-4-5-20250929   # init wizard's default; no benchmark yet in this repo
  extraction:
    provider: anthropic
    model: claude-sonnet-4-5-20250929

anthropic:
  apiKeyEnv: ANTHROPIC_API_KEY    # default shown; override only if you want a differently-named var
```

There is no `baseUrl` field for this provider (unlike `openaiCompatible`) — it always targets
`api.anthropic.com`; the model always comes from `llm.compaction.model` / `llm.extraction.model`.

### 3. Write the key

```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." >> ~/.config/astra-memory/secrets.env
```

On Windows use `%APPDATA%\Astramem\secrets.env`. Like every other provider key in this file, this
is a **plaintext line in secrets.env (mode 0600)** — it is not written to the OS credential store
(that store is reserved for the daemon's own `MEMORY_BEARER` token; see the Ollama/Azure sections
above for the same pattern).

### 4. Wizard flow

`init` offers `anthropic (Claude)` in the cloud-LLM picker (alongside the four presets below,
`azure-openai`, and `codex-subscription`) whenever you reach a cloud-provider choice — either
directly, or via the Ollama tier picker's "BYO cloud" pivot. It prompts for the API key
(`Anthropic API key:`) and nothing else. For non-interactive/scripted installs, set:

```bash
ASTRA_MEMORY_INIT_LLM_PROVIDER=anthropic
ASTRA_MEMORY_INIT_ANTHROPIC_API_KEY=sk-ant-...
```

### 5. Verify

```bash
node dist/cli/index.js doctor
```

Doctor runs the generic LLM chat probe (a real 1-token call). The provider never logs the API key
by value — even in error bodies reflected back from a hostile/buggy upstream, the key is redacted
before it reaches structured logs.

---

## BYO cloud presets: Groq, Gemini, Kimi (Moonshot), DeepSeek

These four are **not separate provider implementations** — each is a named `{baseUrl,
defaultModel}` pair (`src/providers/llm/byo-presets.ts`) that resolves through the existing
`openai-compatible` adapter. Picking one in the wizard is equivalent to hand-typing that vendor's
base URL into the plain "OpenAI-compatible" flow above, plus a curated default model. LLM stages
only — not usable for embedding.

| Preset       | `baseUrl`                                              | Default model             | Key env var         | JSON mode        |
|--------------|----------------------------------------------------------|----------------------------|-----------------------|--------------------|
| Groq         | `https://api.groq.com/openai/v1`                         | `llama-3.3-70b-versatile`  | `GROQ_API_KEY`        | confirmed          |
| Gemini       | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-2.0-flash`       | `GEMINI_API_KEY`      | **partial — see caveat** |
| Kimi (Moonshot) | `https://api.moonshot.cn/v1`                           | `moonshot-v1-8k`           | `MOONSHOT_API_KEY`    | confirmed          |
| DeepSeek     | `https://api.deepseek.com`                                | `deepseek-chat`            | `DEEPSEEK_API_KEY`    | confirmed          |

All four take standard `Authorization: Bearer <key>` auth (same as `openai-compatible` already
sends) — none need a query-param scheme. None of these presets were live-fire tested against a
real API key at merge time (Wave 1, PR #414, 2026-07-17 — no operator credential was available in
that environment); each was verified against the vendor's own published docs instead. Run
`doctor`'s `llmChatProbe` (a real `json:true` call) against your own key before trusting a preset
for production extraction — that probe is what actually proves a preset works end-to-end.

### Gemini's JSON-mode caveat

Gemini is the one preset marked `'partial'` rather than `'confirmed'` for `jsonObjectMode`.
`openai-compatible.ts` sends the bare `response_format:{type:'json_object'}` hint; Gemini's own
docs document that shape for **batch** mode, but recommend `response_format:{type:'json_schema',
...}` for real-time (sync) calls — the exact shape this codebase sends is not the vendor's
documented happy path for sync calls. In practice this likely still returns valid JSON (Gemini's
structured-output models generally honor the looser `json_object` hint too), but it is the one
preset here that was not confirmed working on the exact wire shape AstraMemory Local sends.
Verify with `doctor` before relying on it for extraction; if it silently underperforms, it needs
the same per-model dispatch `openai-compatible.ts` already has for the OpenAI o-series/gpt-5*
reasoning-model case — that would be a provider-level fix, not a preset-level one.

### `max_tokens` vs `max_completion_tokens`

Groq and Kimi have deprecated `max_tokens` in favor of `max_completion_tokens` on their own APIs,
but both still document the old field as "deprecated," not "removed." `openai-compatible.ts`
always sends `max_tokens` for a non-reasoning-prefixed model name (none of these four vendors' model
names match the `o1`/`o3`/`o4`/`gpt-5` prefixes it checks for the newer field), so this is expected
to keep working — it is the one piece of drift the preset registry could not verify against a live
call. If a doctor probe or bug report ever shows `max_tokens` silently ignored or rejected by Groq
or Kimi, that is a provider-level fix (the same per-model dispatch pattern as the reasoning-model
case), not something you can work around from `config.yaml`.

### 1. Configure

```yaml
llm:
  compaction:
    provider: openai-compatible
    model: llama-3.3-70b-versatile   # Groq's default; see table above for the other three
  extraction:
    provider: openai-compatible
    model: llama-3.3-70b-versatile

openaiCompatible:
  baseUrl: https://api.groq.com/openai/v1   # see table above for Gemini/Kimi/DeepSeek base URLs
  apiKeyEnv: GROQ_API_KEY                     # see table above for the other three
```

### 2. Write the key

```bash
echo "GROQ_API_KEY=gsk_..." >> ~/.config/astra-memory/secrets.env
```

Plaintext, mode 0600 — same pattern as every other provider key in this file, never the OS
credential store. Swap the env var name for the preset you picked (`GEMINI_API_KEY`,
`MOONSHOT_API_KEY`, `DEEPSEEK_API_KEY`) — each preset uses a distinct env var name specifically so
switching presets never silently reuses a stale key written under a different vendor's name.

### 3. Wizard flow

`init`'s cloud-LLM picker lists each preset as `<vendor label> (<default model>)` alongside
`anthropic (Claude)`, `azure-openai`, and `codex-subscription`. Choosing one only prompts for the
API key (`<vendor> API key:`) — the base URL and default model are pre-filled from the preset. For
non-interactive/scripted installs:

```bash
ASTRA_MEMORY_INIT_LLM_PROVIDER=openai-compatible
ASTRA_MEMORY_INIT_LLM_PRESET=groq            # groq | gemini | kimi | deepseek
ASTRA_MEMORY_INIT_OPENAI_COMPAT_API_KEY=gsk_...
```

`ASTRA_MEMORY_INIT_LLM_PRESET` is only consulted when `ASTRA_MEMORY_INIT_LLM_PROVIDER=openai-compatible`.

### 4. Verify

```bash
node dist/cli/index.js doctor
```

Same generic LLM chat probe plus the `openai-compatible`-specific `GET <baseUrl>/models`
reachability check. Pricing: none of these four vendors have entries in
`src/providers/llm/pricing.ts` today, so cost reports `usd: 0` rather than a guess — the same
convention as any other unrecognized model id on this provider.

---

## Checking provider health

`GET /health` already reports overall daemon status (`starting`/`ok`/`degraded`) at boot. As of
this writing, whether a **runtime** LLM provider failure (auth error, exhausted quota, repeated
5xx) also flips `/health.status` to `degraded` depends on FEAT-538 (PR #417, **not yet merged** —
tracked separately from the Wave 1 BYO work this document otherwise describes). Once it lands,
`/health.status` will degrade on real provider auth/quota/5xx failures and on a rising poison
rate, giving you a single endpoint to watch instead of grepping logs for provider errors. Until
then, watch `node dist/cli/index.js queue` (poison/failed counts) and the daemon's structured logs
for provider warnings — see the 2026-07-17 codex-401 incident above for what that looks like in
practice.

---

## Mixed configuration

You can mix providers. For example, use Azure for extraction (better JSON mode) and Ollama for
embedding (free):

```yaml
llm:
  compaction:
    provider: ollama
    model: qwen2.5:7b  # free
  extraction:
    provider: azure-openai
    model: gpt-4-1              # more reliable JSON mode

embedding:
  provider: ollama
  model: mxbai-embed-large   # free
  dim: 1024
```

---

## Switching providers after initial setup

### Switching the LLM provider (any of the six above)

1. Edit `config.yaml` — set `llm.extraction.provider` (and `llm.compaction.provider`, if you want
   both stages to switch) to the new provider name, and `model` to that provider's model tag (see
   each provider's section above for its config shape — `anthropic` and `codexSubscription` need
   no `baseUrl`; `openaiCompatible` needs one for a BYO preset or custom endpoint).
2. If the new provider needs an API key, add it to `secrets.env` under the env var name that
   provider's config block expects (`anthropic.apiKeyEnv`, `openaiCompatible.apiKeyEnv`) — see the
   per-provider "Write the key" steps above.
3. **Restart the daemon.** `config.yaml` is read exactly once at process boot
   (`resolveRuntimeConfig`) — there is no live reload today, so a provider/key edit made while the
   daemon is running has no effect on the running process until it restarts. (A `FEAT-540`
   auto-reload has been discussed to close this gap; until it ships, restart is required — don't
   assume a hand-edited `config.yaml` took effect without one.)

```bash
astramem-local service stop
# edit config.yaml + secrets.env here
astramem-local service start
node dist/cli/index.js doctor   # confirm the new provider is reachable
```

Switching the LLM provider does **not** require reindexing — only vector embeddings are
geometry-sensitive (see below). Pending jobs pick up the new provider on restart; nothing already
completed is reprocessed.

Switching the **embedding** provider or model requires reindexing because all stored vector
embeddings are in the old model's geometric space. Mixed embeddings produce meaningless cosine
distances.

```bash
# 1. Update embedding.provider and embedding.model in config.yaml
# 2. Restart the daemon
astramem-local service stop

# 3. Trigger reindex (runs as a background job, can take minutes)
astramem-local rebuild --reembed

# 4. Watch progress
astramem-local queue

# 5. Start daemon again
astramem-local service start
```

The doctor will warn about a provider mismatch and block distillation until `--reembed` completes.
Existing memories remain searchable via FTS5 (keyword) during reindex; vector search is disabled
until reindex finishes.
