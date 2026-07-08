# AstraMemory-local vs Supermemory — Feature & Packaging Matrix
*2026-07-08 · Supermemory surface fetched live from github.com/supermemoryai/supermemory + claude-supermemory; AstraMemory column from this week's code audits*

## Core memory engine

| Feature | Supermemory | AstraMemory-local | Verdict |
|---|---|---|---|
| Fact/memory extraction from conversations | ✅ fact extraction | ✅ typed distillation (decision/fact/lesson/command/todo/note) | par — ours typed, theirs untyped |
| Contradiction handling | ✅ contradiction resolution (auto) | ✅ supersede + consolidation proposals (human gate) + containment auto-merge | par — ours auditable, theirs opaque |
| Forgetting | ✅ automatic expiry | ✅ invalidate/erase + consolidation; no auto-expiry | 🟡 ours manual/curated by design |
| Temporal tracking | ✅ time-sensitive facts | ✅ `--as-of` point-in-time queries, event log | par |
| User profile ("static facts + dynamic context", ~50ms) | ✅ | 🟡 `/recall/pack` + `session_digest` — no persistent profile object | **gap (real)** |
| Hybrid search | ✅ RAG+memory hybrid | ✅ BM25+vector+importance+freshness+usefulness fusion | par+ |
| Metadata/filter search | ✅ | ✅ repo/project/agent/type/entity/since filters | par |
| **Provenance ("why remembered")** | 🔴 | ✅ `why_memory` receipt | **our moat** |
| **Event-sourced lifecycle** | 🔴 | ✅ 7 verbs + memory_events log | **our moat** |
| **Usage-feedback ranking** | 🔴 | ✅ ADR-010 ε-component | **our moat** |
| **Encrypted at rest** | 🔴 undocumented | ✅ SQLCipher default + OS keyring | **our moat** |
| Graph memory | ✅ "embedded graph engine" | 🔴 entity layer only (kill-list: full graph) | gap by choice |
| Benchmarks | self-reported #1 ×3 (refuted as unverifiable) + MemoryBench OSS framework | CI-gated recall@10≥0.9/NDCG@10≥0.7; LongMemEval **in progress (started today)** | 🟡 their claims weak, but they HAVE numbers + a published framework |

## Ingestion

| | Supermemory | AstraMemory-local |
|---|---|---|
| Chat/transcripts | ✅ | ✅ canonical + legacy envelopes, idempotent |
| PDFs / images-OCR / video transcription | ✅ | 🔴 (kill-list for local; SaaS has audio/docs) |
| AST-aware code chunking | ✅ | 🔴 — **only ingestion gap that matters for coding agents**; Month-3 candidate |
| Connectors (GDrive, Gmail, Notion, OneDrive, GitHub, crawler) | ✅ cloud | 🔴 local (SaaS track has Atlassian/GitHub/Linear/Notion/Slack) |
| Codex sessions capture | 🟡 codex-supermemory plugin | ✅ `capture codex --watch` |

## Packaging & installers — the honest gap list

What they ship:

| Install path | Supermemory command | AstraMemory-local today | Gap severity |
|---|---|---|---|
| One-line shell install | `curl -fsSL https://supermemory.ai/install \| bash` | ❌ clone + `bun install && bun run build && node dist/cli/index.js init` (README even wrong) | **HIGH** |
| Instant zero-config trial | `npx supermemory local` → "one binary, zero config", localhost:6767, `./.supermemory` dir | ❌ wizard + Ollama + ~5.4 GB models before first memory | **HIGH** |
| Single binary | `supermemory-server` | ❌ node + dist tree + native modules | MED (bun compile spike — native better-sqlite3/keyring risk) |
| Universal MCP installer | `npx install-mcp https://mcp.supermemory.ai/mcp --client claude --oauth=yes` (8 clients) | ❌ hand-edit `.mcp.json` + env var (docs document the wrong var) | **HIGH** |
| Claude Code plugin | `/plugin marketplace add` + `/plugin install` + API key — **cloud-only, requires paid Pro** | ✅ marketplace `astramem` — local, free, hooks auto-capture + SessionStart auto-recall | **we win on substance, lose on README** |
| npm/pip SDK | `npm i supermemory`, `pip install supermemory` | ❌ none for daemon (SaaS SDK unpublished, 4 methods) | MED |
| Framework integrations | Vercel AI SDK, LangChain, LangGraph, OpenAI Agents, Mastra, Agno | ❌ | LOW now (SDK prerequisite) |
| Browser extension | ✅ | ❌ | kill-list |
| Hosted console/dashboard | console + app.supermemory.ai + "Nova" agent | 5 local server-rendered dashboard pages (+ SaaS's 48-page dashboard on the parallel track) | acceptable for local |
| Docker | not primary path | ❌ daemon image (SaaS has self-host compose) | LOW |

**Where their packaging is actually weaker than it looks:** the polished front door leads to cloud. MCP endpoint is hosted (mcp.supermemory.ai on Cloudflare, even Claude Desktop goes through `mcp-remote` proxy); the Claude Code plugin requires a paid cloud subscription; "local mode" exists but the flagship integrations don't use it. Our daemon is the only path in this comparison where the Claude Code memory never leaves the machine — we just make it miserable to install.

## What to build to close the packaging gap (priority order)

1. **`install.ps1` / `install.sh` one-liners** — wrap: node check → `npm i -g` (post-publish) → `astramem-local init`. Host at repo raw or astramemory.com. [M, week 1 if publish lands day 2]
2. **`astramem-local mcp install --client claude|cursor|windsurf|vscode`** — write the client's MCP config with URL+bearer automatically (kills the `.mcp.json` hand-edit and the env-var confusion found in the plugin audit). [S–M, week 1]
3. **30-second demo mode: `astramem-local demo`** — `ASTRA_MEMORY_DATADIR=:memory:` + foreground serve + seeded example + no service, no Ollama requirement (hash-embed fallback or on-demand pull with consent). The pieces already exist (`:memory:` datadir, `serve` foreground, degraded-start); it's a packaging wrapper. Counters `npx supermemory local`. [S–M, week 1]
4. **Persistent profile / context-pack endpoint hardening** — `/recall/pack` exists; benchmark it, document it as the profile-equivalent ("agent context pack, <Xms"). [S docs now, M feature later]
5. **Single-binary spike (bun compile)** — native modules (better-sqlite3-multiple-ciphers, @napi-rs/keyring) are the risk; timebox 1 day, Month 1. [M/spike]
6. **Daemon TS client SDK** (thin: ingest/recall/remember/health — extract from plugin's provider code into plugins-common `astramem-client`) → npm publish. [M, Month 1]
7. **AST-aware code chunking for `remember`/ingest** — the one Supermemory ingestion feature with real coding-agent value. [L, Month 3 differentiator behind eval evidence]

Items 1–3 slot into the existing 7-day plan Lane A (days 2–4) without displacing blockers: they're S/M and mostly wrap existing capabilities.
