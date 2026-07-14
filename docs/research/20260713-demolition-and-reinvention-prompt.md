# PROMPT: Total Demolition & Reinvention of astramem

> Paste this whole file as the opening prompt of a fresh Claude Code session in
> `C:\work\mega\astramemory-local`. Budget: this is a marathon research + audit session,
> not a quick fix. Use workflows / parallel subagents aggressively.

---

## ROLE

You are three people at once, and they hate each other:

1. **The Assassin** — a principal engineer hired by a competitor to find every bug,
   race, glitch, security hole, and silent failure in astramem before launch, and to
   write the internal memo that kills the project.
2. **The Heretic Architect** — a systems designer who believes the current architecture
   is a local maximum built by accretion, and whose job is to attack every foundational
   assumption until only the load-bearing ones survive.
3. **The Visionary** — an unreasonable product mind (temperature cranked to 1.5) whose
   job is to answer: *"if we started today, knowing everything the competitors know,
   what would make this tool so good people evangelize it unprompted?"*

Run all three. Let them fight. The deliverable is the synthesis of the fight.

## TARGET

- Repo: `C:\work\mega\astramemory-local` — local-first memory daemon.
  TypeScript + Node 20 + Fastify + better-sqlite3 + sqlite-vec. Ollama for embeddings
  (`mxbai-embed-large`, 1024-dim) and distillation (`qwen2.5-coder:7b`).
- Sibling wire-compatible repos: `astramemory-plugin` (Claude Code plugin client) and
  `memory` (SaaS backend) — see `.claude` memory `sibling-repos` for paths.
- Read `CLAUDE.md` fully first. It is dense with known landmines — treat every
  "RESOLVED, do not re-fix" claim as a **claim to be re-verified**, not a fact.

## AMMUNITION (already downloaded — use it)

Competitor source code, full repos, at `C:\work\mega\astramem-local-competitors-code\`:

| Repo | Why it matters — what to steal / compare |
|---|---|
| `mem0` | Market leader. Extraction prompts, memory update/conflict resolution (ADD/UPDATE/DELETE ops), graph memory, scoring. |
| `letta` | MemGPT lineage. Self-editing memory, core/archival memory split, agent-controlled memory tools, sleep-time compute. |
| `graphiti` | Temporal knowledge graphs done right. Bi-temporal edges, episode model, point-in-time queries — directly attacks our weakest benchmark area. |
| `cognee` | ECL pipelines (extract-cognify-load), ontology-driven graphs, modular datasets. |
| `supermemory` | Install UX, connector breadth, chunking/reranking pipeline, product polish. |
| `txtai` | Embeddings-database ergonomics, SQL+vector hybrid, tiny-footprint deployment, graph traversal search. |

Prior internal research (read before re-deriving anything):
- `docs/research/2026-07-09-competitor-gap-analysis.md`
- `docs/research/2026-07-08-supermemory-matrix.md`
- `docs/research/2026-07-08-astramem-ecosystem-report.md`
- LoCoMo benchmark state: overall F1 45.4 (beats paper RAG baseline 41.4), but
  **temporal reasoning F1 = 12.4** — the open wound. Adversarial 83.0.

## PHASE 1 — THE ASSASSINATION (find what's broken)

Hunt bugs with the assumption that the codebase is guilty until proven innocent.
Fan out parallel review agents across at minimum these dimensions:

1. **Concurrency & lifecycle** — daemon boot/shutdown races, `daemon.lock` semantics,
   watchdog kill-cycle (`watchdog-probe.ts`) vs. in-flight writes, schtasks PT5M
   keepalive racing restarts, spool/ingest async races, idempotency-key TOCTOU.
2. **Data integrity** — SQLite WAL + sqlite-vec consistency, migration ordering (we
   already shipped one migration-030 collision — assume there are more latent ones),
   embed-dim mismatches, partial-write windows in `writeConfig` consumers, backfill
   correctness of `summary_memory_id`.
3. **Security** — bearer token handling, localhost-bind assumptions, secrets.env perms,
   MCP tool input validation, prompt injection through ingested transcripts into the
   distill LLM and back out through recall (poisoned memories), SQL injection via FTS
   query strings, path