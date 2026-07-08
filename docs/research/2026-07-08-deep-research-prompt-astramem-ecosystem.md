# Fable Deep Research — AstraMemory Ecosystem, Competitive Analysis & Release Strategy

## Mission

Do **NOT** redesign AstraMemory from scratch. Research the **AI Memory ecosystem**, determine where AstraMemory stands, and produce an execution plan to ship an outstanding **astramemory-local** open-source release in **one week** (target 2026-07-15), plus a realistic 12-month roadmap for AstraMemory SaaS. Prefer incremental improvements; recommend rewrites only if the current implementation fundamentally blocks growth.

## Priorities (work and word-budget allocation)

* **P0 — Ship the best possible OSS release of astramemory-local in one week.** Every other output serves this.
* **P1 — Competitive research**, scored (see rubric below), Supermemory as baseline.
* **P2 — Parity matrix + verified audit** of the actual codebase.
* **P3 — One-week execution plan** (issues, checklist, announcement).
* **P4 — Incremental architecture recommendations** (preserve existing investment).
* **P5 — Long-term roadmap** (1/3/6/12 months) and Local↔SaaS convergence.

If depth must be traded anywhere, trade it from P5 upward — never from P0–P2.

## Success Metric

Score every major competitor **and AstraMemory** 1–10 on: Developer Experience, Installation, Documentation, Memory Quality, Retrieval, Developer Workflows, Architecture, Production Readiness. Show the scores in one table. The one-week release plan must credibly move astramemory-local to **≥ 8.5/10 overall** for the "local-first memory for AI coding agents" use case. Every Ship-This-Week item must state which score it moves and by how much.

---

# Ground Truth (verified 2026-07-08 — confirm in code, don't re-litigate; 11 ADRs exist)

Three repos, one platform:

**1. astramemory-local** — the OSS release candidate. GitHub `astragenie/astramemory-local`, npm `@astragenie/astramemory-local`, **v0.8.1**. TypeScript/Node 20/Fastify; **encrypted-at-rest SQLite** (`better-sqlite3-multiple-ciphers`) + `sqlite-vec`; Ollama `mxbai-embed-large` (1024-dim) default, Azure optional. Hybrid retrieval: BM25 + vector + importance + freshness + usefulness epsilon (ADR-010 feedback loop). **CI-gated retrieval eval**: recall@10 ≥ 0.9, NDCG@10 ≥ 0.7 (ADR-005). Formation pipeline: transcript ingest → typed atoms (decision/fact/lesson/command/todo/note). Event-sourced lifecycle: promote/supersede/invalidate/restore/erase/mark_used. Provenance: `why_memory`, `memory_history`, `session_digest`. Consolidation proposal/resolve flow. **MCP server, 16 tools**, manifest SoT + parity CI. Wire: `POST /ingest/transcript` speaks canonical v1.0 + legacy v0.0; JSON-schema SoT in `contracts/` generates TS types + Zod; idempotency keys. Cloud sync **already built** (ADR-003/009/011): claim-code pairing, device token in OS credential store, shipper/puller; **personal memories never sync — only team/org** (ADR-009). Install: `init` wizard, idempotent `reinstall`, OS service (schtasks XML watchdog / systemd / launchd), atomic-pointer upgrades, degraded-start health, `doctor`.

**2. astramem-plugin** — Claude Code client. GitHub `astragenie/astramem-plugin`, **v0.6.1**, marketplace entry `astramem`. Hook-based transcript capture (pre-compact/session-end); providers: local daemon (`/ingest/transcript`, `/recall`, `/health`, `/remember`) and SaaS (Clerk JWT); exposes MCP tools in sessions.

**3. memory** — SaaS backend. GitHub `astragenie/memory`. .NET 10 ASP.NET Core, PostgreSQL, multi-tenant (teams/orgs), Clerk + ApiKey auth. Hybrid vector + keyword + bitemporal search; connectors (Confluence); REST + own MCP server; TS/Python SDKs **written but unpublished**; `docker-compose.self-host.yml` started. Prod: Azure Container Apps at `app.astramemory.com/api` and `api.astramemory.com`; tag-driven deploy.

**Known warts (factor in, don't rediscover):**

* **npm shadowing**: published `astramem-local` stuck at **0.4.0** (plain sqlite, no cipher → `SQLITE_NOTADB` on encrypted DBs). Fresh publish + README rewrite = likely release blocker.
* **Naming drift**: AstraMem / AstraMemory / `astramem-local` / `astra-memory` (stale README binary + quickstart). Unify before release.
* Sync paired and working locally; two SaaS-side blockers (memory#621 tag, #667 tenant gate) + daemon #81 (redeem returns wrong apiUrl); shipper swallows HTTP error bodies.
* systemd/launchd far less battle-tested than Windows path — cross-platform QA is a release risk.
* SDKs unpublished; SaaS README references packages not on npm/PyPI.

---

# Research Entry Points (mandatory — use as discovery indexes, follow references outward)

1. https://github.com/topoteretes/awesome-ai-memory (PRIMARY — all categories)
2. https://github.com/IAAR-Shanghai/Awesome-AI-Memory (surveys, benchmarks, papers)
3. https://github.com/TeleAI-UAGI/Awesome-Agent-Memory
4. https://github.com/TsinghuaC3I/Awesome-Memory-for-Agents
5. https://github.com/DEEP-PolyU/Awesome-GraphMemory (graph/temporal/graph-RAG)

## Primary competitor — Supermemory

https://github.com/supermemoryai/supermemory — baseline for everything. Study product vision, DX, installation, architecture, API/SDK, MCP, search/ingestion/retrieval, docs, onboarding, UI, release quality. Determine: what it does exceptionally well; what AstraMemory already does better (candidates: encrypted-at-rest local store, event-sourced lifecycle + provenance receipts, CI-gated retrieval eval, privacy-scoped sync, usefulness loop — **verify, don't assume**); where parity is missing; where to intentionally diverge.

## Secondary competitors

Mem0, Letta (MemGPT), Zep, Graphiti, Cognee, LangMem, MemOS, OpenMemory, A-MEM, Hindsight, MemVid, Reflect Memory, Kernel Memory, plus significant discoveries from the indexes. Capture per project: architecture, memory model, storage, retrieval, extraction, APIs, MCP, SDKs, docs, strengths, weaknesses, unique innovations. Weight **coding-agent memory** (Claude Code / Codex / Cursor) heaviest — that is AstraMemory's wedge.

---

# Deliverable 0 — Executive Product Verdict (one page, write it LAST, place it FIRST)

Imagine Andrej Karpathy, the Mem0 founders, and the Supermemory founders reviewed astramemory-local today. Would they use it? Contribute? Recommend it? Star it? Replace their current solution? Why or why not? Be brutally honest. Then state the three changes that most alter that verdict within one week.

# Deliverable 1 — Scored Competitive Landscape

* Ecosystem map: categorize every discovered project (Production Platforms, Coding Agent Memory, Local-First, Team Memory, Infrastructure, Graph Memory, Storage Engines, MCP Servers, Research, Experimental) with GitHub URL, stars, activity, license, architecture, storage, retrieval, MCP, local/cloud, OSS/commercial, maturity, notable innovations. Tag each: 🟢 direct / 🟡 indirect / 🔵 infrastructure / 🟣 research / ⚪ experimental.
* **Score table** per the Success Metric rubric for every 🟢 competitor + AstraMemory.
* Feature matrix, AstraMemory column filled from code verification (not READMEs). Minimum rows: local-first/self-hosted/SaaS; CLI/REST/SDKs/MCP/dashboard; semantic/BM25/hybrid/temporal/entity/graph search; typed atoms/episodic/procedural memory; lifecycle (promote/supersede/invalidate, event log, provenance, consolidation, forgetting, dedup); feedback-driven ranking; published eval evidence; encryption at rest, scrubbing, privacy scopes; sync/multi-device/conflicts; team/org multi-tenant; Claude Code/Codex/Cursor/GitHub/CI integrations; install wizard, service management, health/doctor, idempotency; docs/examples/testing/release cadence.

# Deliverable 2 — Verified Audit + Parity Matrix

Audit all three repos — code, not docs. Priority order for the release: (1) first-run experience on a clean machine, all three OSes — npm publish state, wizard, Ollama friction, service install, plugin pairing; (2) README/docs accuracy vs actual CLI surface; (3) cross-platform confidence; (4) security posture under OSS scrutiny (token handling, secrets.env, scrubbing — what would a security-minded HN commenter flag day one?); (5) test/eval gaps vs release needs. Flag debt, don't redesign; the deferred-items list in CLAUDE.md records what is already resolved — do not re-open it.

Parity matrix: every feature ✅ / 🟡 / 🔴 / ⚪, and every gap bucketed **Ship This Week / Next Month / Three Months / Future** with effort, user value, competitive value, and which rubric score it moves.

# Deliverable 3 — Kill List

Explicitly identify what AstraMemory should **NOT** build: features that waste engineering time, features competitors built but users rarely use, features that should never enter the product. For each: why competitors built it, why it fails cost/benefit here, estimated maintenance cost, opportunity cost. Be aggressive — a solo-maintainer-scale team ships this. This list is as valuable as the roadmap.

# Deliverable 4 — Release Plan

**Week 1 (P0, target 2026-07-15):** release astramemory-local so developers immediately compare it favorably with Supermemory, Mem0, Zep, Graphiti, Cognee, Letta — as *the* local-first memory for AI coding agents. Produce: prioritized GitHub issues with implementation order; release checklist explicitly covering npm publish under a correct unshadowed name, README rewrite (correct binary, honest quickstart ≤5 min), naming unification, LICENSE + secrets/gitignore audit, cross-platform smoke matrix, plugin pairing walkthrough; benchmark plan leveraging the existing ADR-005 eval harness (publishing recall@10/NDCG@10 is a differentiator most competitors lack); demo plan (Claude Code session → memories formed → recall next session; `why_memory` provenance as the money shot); announcement outline (local-first, encrypted, provenance-receipted memory for Claude Code). Cut anything that isn't first-run experience, docs truthfulness, or credibility evidence.

**Month 1:** remaining parity gaps, publish SDKs, finish sync bring-up (memory#621, #667, daemon #81), integrations beyond current capture docs, eval publication, dashboard/local-UI decision.

**Month 3:** differentiation — candidates to evaluate, not assume: extend ADR-010 self-improving loop, autonomous consolidation on the existing proposal flow, CI/CD + GitHub intelligence, memory health scoring, project knowledge graphs, graph layer (assess vs Graphiti/Zep rather than copy).

**Month 6:** complete Local↔SaaS convergence — finish and harden the **existing** sync, orgs/enterprise permissions, shared API/SDK surface, self-host (build on existing compose file).

**Month 12:** how AstraMemory becomes the best memory platform for AI coding agents — one product spanning local daemon, agent plugins, and team cloud, with personal-never-leaves-the-machine as the trust foundation.

# Deliverable 5 — Architecture Evolution (incremental only)

Corrections to your priors: Local↔SaaS convergence is **already partially shipped** — shared wire contract (v1.0 envelope, JSON-schema SoT, generated TS/Zod, regex parity across repos), live pairing + shipper/puller, privacy scopes (ADR-009), conflict policy (ADR-011). Do not propose greenfield sync; propose hardening/completion. The `contracts/` directory is the existing shared-schema mechanism — evaluate extending it (generate the C# side, or extract a shared package for all three repos). Retrieval pipelines differ by design (local: BM25+vec+importance+freshness+usefulness; SaaS: hybrid+bitemporal) — recommend where to converge (shared ranking contract? shared eval harness?) and where divergence is legitimate. Address: shared API surface, SDK strategy (should the daemon speak the same REST shape so one SDK targets both?), shared memory-model vocabulary.

# Deliverable 6 — Surprise Me

After completing all research, set the roadmap aside and answer: **"If you joined as CTO today, what are the three recommendations you would make that we are least likely to think of ourselves?"** No hedging, no restating the roadmap.

---

# Success Criteria

1. Executive Product Verdict (one page, brutally honest).
2. Scored ecosystem map + feature matrix with the 1–10 rubric table; Supermemory as baseline.
3. Verified code-grounded audit of all three repos, including the known blockers.
4. Parity matrix with Ship-This-Week vs later, each item tied to a rubric score.
5. Kill List with maintenance and opportunity costs.
6. One-week execution plan that credibly reaches ≥ 8.5/10.
7. Incremental architecture recommendations preserving the 11 ADRs, contracts SoT, and existing sync.
8. Three surprise CTO recommendations.

The final recommendation must answer:

> **If an experienced AI infrastructure engineer compared AstraMemory to Supermemory and every major memory framework today, what would they expect to see before recommending astramemory-local as the best local-first memory platform for AI coding agents?**
