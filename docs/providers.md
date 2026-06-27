# Provider setup

AstraMemory Local supports two LLM and embedding providers: Ollama (local, free) and Azure
OpenAI (cloud). You configure them independently for the compaction stage, the extraction stage,
and the embedding stage.

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
ollama pull qwen2.5-coder:7b
```

For embedding:

```bash
ollama pull nomic-embed-text-v2-moe
```

Verify both are available:

```bash
ollama list
```

Expected output includes:

```
NAME                            ID              SIZE
qwen2.5-coder:7b                ...             4.7 GB
nomic-embed-text-v2-moe         ...             274 MB
```

### 4. Configure AstraMemory Local

In `config.yaml`:

```yaml
llm:
  compaction:
    provider: ollama
    model: qwen2.5-coder:7b
  extraction:
    provider: ollama
    model: qwen2.5-coder:7b

embedding:
  provider: ollama
  model: nomic-embed-text-v2-moe
  dim: 1024

ollama:
  baseUrl: http://127.0.0.1:11434
```

### 5. Verify

```bash
astra-memory providers test ollama
```

Expected:

```
  LLM (ollama / qwen2.5-coder:7b)    ok   latency=1234ms
  Embed (ollama / nomic-embed-text)   ok   dim=1024
```

### Alternative Ollama models

You can substitute any Ollama model that supports JSON mode for extraction:

| Use case   | Alternative model          | Notes                               |
|------------|----------------------------|-------------------------------------|
| LLM        | `llama3.1:8b`              | Stronger reasoning, ~5GB            |
| LLM        | `mistral:7b`               | Fast, good JSON mode                |
| LLM        | `phi4:14b`                 | Best quality, ~9GB, needs 16GB RAM  |
| Embedding  | `mxbai-embed-large`        | 1024-dim, good retrieval quality    |
| Embedding  | `all-minilm`               | 384-dim — NOT compatible (dim mismatch) |

The embedding model must produce exactly 1024-dimensional vectors. Do not use `all-minilm` or
other models with different dimensions without changing `embedding.dim` AND running a full
`astra-memory rebuild --reembed`.

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

On Windows use `%APPDATA%\AstraMemory\secrets.env`.

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
astra-memory providers test azure-openai
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

## Mixed configuration

You can mix providers. For example, use Azure for extraction (better JSON mode) and Ollama for
embedding (free):

```yaml
llm:
  compaction:
    provider: ollama
    model: qwen2.5-coder:7b    # free
  extraction:
    provider: azure-openai
    model: gpt-4-1              # more reliable JSON mode

embedding:
  provider: ollama
  model: nomic-embed-text-v2-moe   # free
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
astra-memory service stop

# 3. Trigger reindex (runs as a background job, can take minutes)
astra-memory rebuild --reembed

# 4. Watch progress
astra-memory queue

# 5. Start daemon again
astra-memory service start
```

The doctor will warn about a provider mismatch and block distillation until `--reembed` completes.
Existing memories remain searchable via FTS5 (keyword) during reindex; vector search is disabled
until reindex finishes.
