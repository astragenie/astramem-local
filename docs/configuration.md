# Configuration reference

AstraMemory Local is configured via `config.yaml` written by `astra-memory init`. The file lives
at:

| OS      | Default path                                          |
|---------|-------------------------------------------------------|
| Linux   | `~/.config/astra-memory/config.yaml`                 |
| macOS   | `~/Library/Application Support/astra-memory/config.yaml` |
| Windows | `%APPDATA%\AstraMemory\config.yaml`                  |

Edit the file directly and restart the daemon (`astra-memory service stop && astra-memory service start`).
Use `astra-memory doctor` after changes to validate the new configuration.

---

## Full schema with defaults

```yaml
# config.yaml — AstraMemory Local

# Port the HTTP daemon binds on loopback.
# Plugin hooks must set MEMORY_API_URL=http://127.0.0.1:<port>
port: 7777

# Directory where memory.sqlite is stored.
# The daemon creates this directory on first start if it does not exist.
dataDir: ~/.local/share/astra-memory    # Linux default
# dataDir: ~/Library/Application Support/astra-memory   # macOS default
# dataDir: C:\Users\<name>\AppData\Local\AstraMemory     # Windows default

# LLM providers used by the distillation pipeline.
# compaction and extraction may use different providers/models.
llm:
  compaction:
    provider: ollama            # ollama | azure-openai
    model: qwen2.5-coder:7b    # any model available in Ollama or Azure deployment name

  extraction:
    provider: ollama
    model: qwen2.5-coder:7b

# Embedding provider — system-wide.
# Changing provider or model at the SAME dim requires: astra-memory rebuild
# Changing dim against an EXISTING database requires the resumable
# `reembed-dim` procedure — see docs/embed-dim-migration.md. A fresh
# install can just set `dim` before the first `init`/`serve` run.
embedding:
  provider: ollama              # ollama | azure-openai
  model: nomic-embed-text-v2-moe  # must produce `dim`-dimensional vectors
  dim: 1024                    # default; see docs/embed-dim-migration.md to change

# Vector store backend.
vector:
  store: sqlite-vec             # sqlite-vec | lancedb

# Ollama connection settings (only used when any provider is set to ollama).
ollama:
  baseUrl: http://127.0.0.1:11434

# Azure OpenAI settings (only used when any provider is set to azure-openai).
# API key and endpoint are written to secrets.env (0600), not here.
azure:
  apiVersion: "2024-10-21"
  # endpoint and deployment are set by the wizard in secrets.env.
  # Alternatively, set AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_DEPLOYMENT env vars.

# Daily LLM spend cap in USD.
# Applies to Azure only (Ollama always reports $0).
# When reached, distillation jobs move to "paused" — ingest continues.
budget:
  daily_usd: 10

# Hybrid search score weights.
# score = alpha * norm(bm25) + beta * norm(cosine) + gamma * importance + delta * freshness
# Must sum to 1.0.
search:
  alpha: 0.4     # BM25 keyword weight
  beta: 0.4      # cosine vector similarity weight
  gamma: 0.1     # importance field weight (0.0-1.0 per memory)
  delta: 0.1     # freshness decay weight (exponential, half-life ~7 days)
```

---

## Secrets file

Sensitive values are stored separately in `secrets.env` (file mode 0600):

| OS      | Default path                                              |
|---------|-----------------------------------------------------------|
| Linux   | `~/.config/astra-memory/secrets.env`                     |
| macOS   | `~/Library/Application Support/astra-memory/secrets.env` |
| Windows | `%APPDATA%\AstraMemory\secrets.env`                      |

Example content:

```bash
MEMORY_BEARER=e3b0c44298fc1c149afb...   # 32-byte hex bearer token
AZURE_OPENAI_ENDPOINT=https://my-resource.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=gpt-4-1
AZURE_OPENAI_API_KEY=sk-...
AZURE_OPENAI_EMBED_DEPLOYMENT=text-embedding-3-small
```

The daemon reads this file at boot. Do not commit it to version control.

---

## Environment variable overrides

All config.yaml fields can be overridden at launch via environment variables using the `ASTRA_MEMORY_*` prefix:

| Environment variable          | Overrides config field     |
|-------------------------------|----------------------------|
| `ASTRA_MEMORY_PORT`           | `port`                     |
| `ASTRA_MEMORY_DATADIR`        | `dataDir`                  |
| `ASTRA_MEMORY_TOKEN`          | bearer token (dev only)    |
| `ASTRA_MEMORY_DAILY_USD`      | `budget.daily_usd`         |
| `ASTRA_MEMORY_OLLAMA_URL`     | `ollama.baseUrl`           |

The `MEMORY_API_URL` and `MEMORY_BEARER` variables are consumed by the **plugin hooks**, not the
daemon itself. The daemon reads `ASTRA_MEMORY_*` for its own settings.

---

## Config fields reference

### `port`

Type: integer. Default: `7777`.

TCP port the Fastify server listens on, bound to `127.0.0.1` (loopback only). To use a different
port, update both this field and the plugin's `MEMORY_API_URL` env var.

### `dataDir`

Type: string path. Default: OS-specific (see table above).

Directory where `memory.sqlite` is stored. The daemon creates this path on first start if absent.
Must be on a writable local filesystem — network shares and Docker volumes may cause WAL locking
issues with SQLite.

### `llm.compaction` and `llm.extraction`

Type: `{ provider: 'ollama' | 'azure-openai', model: string }`.

These two stages may use different providers and models. Compaction reduces redundancy in raw
transcript chunks; extraction emits typed memory atoms in JSON mode.

Recommended models:
- Ollama: `qwen2.5-coder:7b` (fast), `llama3.1:8b` (more reasoning)
- Azure: any GPT-4.1 deployment

### `embedding`

Type: `{ provider, model, dim: number }`.

System-wide embedding configuration. `dim` defaults to 1024 (matching `mxbai-embed-large` /
Azure `text-embedding-3-*`) but is a plain config value, not a fixed literal (FEAT-409) — the
sqlite-vec index is created as `FLOAT[dim]` from whatever value was configured at DB-creation
time. Changing `provider` or `model` at the same dim without running `astra-memory rebuild`
will cause a mismatch between stored embeddings and new embeddings; the doctor will detect this
mismatch and block the distillation worker until reindex completes. Changing `dim` against an
EXISTING database (not a fresh install) requires the resumable `astra-memory reembed-dim`
procedure — see docs/embed-dim-migration.md.

### `budget.daily_usd`

Type: number. Default: `10`.

Maximum USD to spend on LLM calls in a UTC calendar day. Set to a large number to effectively
disable (e.g. `999999`). Ollama calls always contribute `$0`. Azure costs are computed from the
provider's token usage and a built-in pricing table.

### `search`

Type: `{ alpha, beta, gamma, delta }`.

Score fusion weights. Must sum to approximately 1.0 (the engine normalizes each component to
[0, 1] before weighting). Increase `alpha` for more keyword precision. Increase `beta` for more
semantic relevance. Increase `gamma` to prefer high-importance memories. Increase `delta` to
prefer recent memories.
