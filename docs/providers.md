# Provider setup

AstraMemory Local's LLM stages (compaction, extraction) support four providers: Ollama (local,
free), Azure OpenAI (cloud), a generic `openai-compatible` client (OpenAI API, Groq, vLLM, LM
Studio, ...), and an experimental `codex-subscription` provider that reuses a Codex CLI ChatGPT
login instead of a metered key. Embedding only supports Ollama and Azure OpenAI. You configure
LLM providers independently for the compaction stage and the extraction stage.

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
  LLM (ollama / qwen2.5:7b)    ok   latency=1234ms
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

### Extraction/compaction model tiers

When the LLM provider is Ollama, `init` offers a tier picker for the extraction/compaction model
instead of hard-coding `qwen2.5:7b`. F1/latency figures are from the internal extraction
benchmark (2026-07-08) so the choice is informed rather than a guess:

| Tier                          | Model                | Download | RAM recommended | Benchmark                                    |
|--------------------------------|-----------------------|----------|------------------|-----------------------------------------------|
| RECOMMENDED (default)          | `qwen2.5:7b`          | ~4.7 GB  | 16 GB            | F1 67%, precision 99%, ~21.6s/session          |
| Fastest                        | `qwen2.5-coder:7b`    | ~5 GB    | 16 GB            | F1 59%, ~8.7s/session                         |
| BYO cloud                      | azure-openai (pivots the wizard to the existing cloud provider option) | n/a — no local download | n/a | best type-accuracy of any option |
| Custom                          | (free-text model tag) | varies — check `ollama show <model>` | varies | not benchmarked |

`qwen2.5-coder:14b` ("quality" tier in earlier wizard versions) was **dropped from the curated
list entirely** after the same benchmark showed a 20% permanent-failure (poison) rate and
72.7s/session — strictly worse than both remaining local tiers on every axis. You can still reach
it (or any other model) via the "custom" tier if you have a specific reason to.

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

## Codex subscription (EXPERIMENTAL — uses your ChatGPT quota, not billed API usage)

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

## Mixed configuration

You can mix providers. For example, use Azure for extraction (better JSON mode) and Ollama for
embedding (free):

```yaml
llm:
  compaction:
    provider: ollama
    model: qwen2.5:7b    # free
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

Switching the **LLM** provider (compaction or extraction) is instant — just update `config.yaml`
and restart the daemon. Pending jobs pick up the new provider.

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
