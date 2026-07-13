# astramem-local — Competitor Code-Level Gap Analysis

*2026-07-09 · Method: shallow-cloned 6 competitor repos into `C:\work\mega\astramem-local-competitors-code\` and had independent agents read actual source (not just README/marketing) to verify or refute claims from the prior web-research pass (`docs/research/2026-07-08-astramem-ecosystem-report.md`, `docs/research/2026-07-08-supermemory-matrix.md`). Plus a lighter README-level scan of 7 long-tail players. This report supersedes specific factual claims in the 2026-07-08 report where code contradicts them (flagged inline) — it does not replace that report's scoring/release-plan work, which stands.*

> **Terminology correction (2026-07-12):** this report uses "bitemporal" throughout (comparison
> matrix, moat #5, gap #3) to describe both Graphiti's `valid_at`/`invalid_at`/`expired_at` edge
> fields and astramem-local's own temporal tracking. Neither system has a second, independently
> queryable **transaction-time** axis ("what did we believe before a correction was made") — both
> are **valid-time only**, verified against Graphiti's own cited code (`edges.py:271-282`; see
> `docs/specs/FEAT-453-bitemporal-design.md` §10 Q2). "Bitemporal" formally means both axes
> together, so this report overclaimed Graphiti's capability (and, by extension, implied a parity
> claim for astramem-local's FEAT-453 entity-link tracking that doesn't hold). The corrections
> below are inline; the underlying comparison — Graphiti tracks temporal validity at edge/fact
> grain, astramem-local at memory grain plus (since v0.12.0) entity-link grain — stands, just
> relabeled to "valid-time."

**Relationship to prior research**: yesterday's ecosystem report (2026-07-08) was built from 25 web sources under adversarial verification — strong on breadth and market framing, but every competitor claim was "from-README" or "from-blog" tier at best. This report upgrades the five majors named in the task (mem0, Letta, Zep/Graphiti, Cognee, plus newly-covered txtai and code-verified Supermemory) to **verified-from-code**, and several claims flip as a result (see "Corrections to prior research" below).

---

## Cloned repos (evidence base)

| Repo | Path | HEAD / date | License |
|---|---|---|---|
| mem0ai/mem0 | `C:\work\mega\astramem-local-competitors-code\mem0` | `df9d5cc4`, 2026-07-10 | Apache-2.0 |
| letta-ai/letta | `C:\work\mega\astramem-local-competitors-code\letta` | `b76da909`, 2026-07-03 | Apache-2.0 |
| getzep/graphiti | `C:\work\mega\astramem-local-competitors-code\graphiti` | 2026-07-09 | Apache-2.0 |
| topoteretes/cognee | `C:\work\mega\astramem-local-competitors-code\cognee` | 2026-07-08 | Apache-2.0 |
| neuml/txtai | `C:\work\mega\astramem-local-competitors-code\txtai` | `aa0a8cf`, 2026-07-02 | Apache-2.0 |
| supermemoryai/supermemory | `C:\work\mega\astramem-local-competitors-code\supermemory` | `97888ce`, 2026-07-07 | MIT (root); Apache-2.0 (one sub-package) |

Long-tail scan (README-level only, not cloned — see rationale in that section): memary, LangMem, Redis Agent Memory Server, A-MEM, memobase, RedPlanetHQ/core, ReMe (formerly MemoryScope).

---

## Comparison matrix

Legend: ✅ has it by default · 🟡 has it, opt-in/partial · 🔴 doesn't have it · — not applicable/unknown. All astramem-local cells per `CLAUDE.md` + repo conventions (this repo, not re-derived).

| Dimension | astramem-local | mem0 | Letta | Zep/Graphiti | Cognee | txtai | Supermemory |
|---|---|---|---|---|---|---|---|
| Stack | TS/Node, Fastify | Python (+TS MCP server) | Python (+generated TS SDK) | Python | Python | Python | TS monorepo (client-only) |
| Storage | sqlite + sqlite-vec (SQLCipher) | 25 pluggable vector adapters, default **Qdrant** | Postgres-only (no embedded DB) | Neo4j/FalkorDB/Kuzu(deprecated)/Neptune — no SQLite | LanceDB (vector) + "ladybug" (graph, not Kuzu) + SQLite (relational) | Pluggable ANN (faiss default, incl. sqlite-vec, pgvector) | **None in public repo** — no `apps/api`, backend not published |
| Retrieval | BM25+vector+importance+freshness+usefulness fusion (7-component) | Vector+BM25+entity boost, `score_and_rank` | Agent-directed function-calling (LLM decides when to search) | RRF + cross-encoder reranking, BM25, MMR, community rerankers | 18-mode enum (RAG/graph/cypher/temporal/agentic/…) | Hybrid dense+sparse (3 fusion strategies: log-odds/convex/RRF) + real BM25 | Passthrough to hosted API — no local ranking math |
| Lifecycle / valid-time | ✅ 7 verbs (supersede/invalidate/restore/…) + event log; `--as-of` | 🟡 `history` table on every op (not append-only/immutable); `expiration_date` only, no valid-time windows | 🟡 `BlockHistory` append-only version history w/ sequence_number; no valid-time fields | ✅ **valid-time fields** (not two-axis bitemporal — see correction note above): `valid_at`/`invalid_at`/`expired_at` on edges | 🟡 `forget()` API + event-timestamp extraction for TEMPORAL search mode; **no valid-time record versioning** | 🔴 hard delete only, zero version/valid-time code | 🟡 versioned data *model* visible client-side (parent/isLatest/isForgotten) but decision logic lives in the unpublished backend |
| Provenance / explainability | ✅ `why_memory` (evidence + source + transcript ref) | 🟡 `explain=True` → `score_details` (real score breakdown, not source-chain) | 🔴 no dedicated explain API (raw LLM reasoning traces persisted, different purpose) | 🟡 source-episode-ID pointer only, no score breakdown | 🟡 ownership/lineage graph (who-owns-what), not retrieval-explain | 🟡 token-attribution `Explain` API (leave-one-out masking) — different purpose than source/reasoning | 🔴 raw similarity score only, no structured breakdown |
| Local-first (real default, not just capable) | ✅ Ollama default, no API key required | 🔴 default = OpenAI (`llms/configs.py:7`) | 🟡 Ollama/LM Studio supported, but **requires Postgres** (no embedded DB) | 🔴 default = OpenAI, Ollama is manual opt-in | 🔴 default = OpenAI for LLM+embeddings (storage is local-default only) | ✅ default = local sentence-transformers, no API key | 🔴 thin client to `api.supermemory.ai`, no local backend published |
| Encryption at rest | ✅ SQLCipher default + OS keyring | 🔴 zero encryption code | 🟡 AES-256-GCM **field-level**, opt-in via `LETTA_ENCRYPTION_KEY`, not whole-DB | 🔴 zero encryption code | 🔴 zero encryption code | 🔴 zero encryption code | 🔴 zero encryption code in public repo |
| CI-gated retrieval eval | ✅ recall@10≥0.9/NDCG@10≥0.7 every push (ADR-005) | 🔴 no bench dir/CI job; README LoCoMo number explicitly caveated as platform-only | 🔴 no benchmark numbers found anywhere in repo | 🟡 eval harness exists (LongMemEval data) but **explicitly excluded from CI** (`--ignore=tests/evals/`) | 🟡 benchmark results published in-repo (`evals/benchmark_summary_*.json`) but not CI-wired | ✅ CI runs (3-OS matrix + coverage) but no retrieval-quality numbers, general test coverage only | 🔴 CI runs typecheck+lint only, zero eval |
| MCP server (own tools) | ✅ 20 tools *(2026-07-13: was reported as 15; recount against `src/mcp/server.ts` — 20 `registerTool` calls)* | ✅ (`openmemory/api/.../mcp_server.py`) | 🔴 MCP **client**-only (consumes external MCP servers, doesn't expose one) | ✅ 13 tools, own CI job | ✅ ~20 tools (richest surface found) | ✅ mounts FastAPI as MCP + separate MCP client | ✅ but proxies every call to hosted API (Cloudflare Worker, not a local stdio server) |
| Auth on server component | ✅ Bearer token, timing-safe compare | ✅ JWT/API-key (`server/auth.py`) | ✅ HTTPBearer (admin password/API key) | 🔴 no evident auth on bundled server | ✅ JWT bearer+cookie (fastapi-users) | 🟡 optional shared bearer token — **off by default** | — (remote session introspection against hosted API, not local) |
| License | — (proprietary/TBD per CLAUDE.md) | Apache-2.0 | Apache-2.0 | Apache-2.0 | Apache-2.0 | Apache-2.0 | MIT (root) / Apache-2.0 (one subpkg) — inconsistent |
| Traction | — | large community (per 2026-07-08 report: ~47-48k★) | per 2026-07-08 report: mid-size, self-hostable | active, daily commits | active, daily commits | mature, long-running project | active, daily commits — but core engine unverifiable (closed) |

---

## Long-tail scan (README-level, from-README/from-search-snippet tier — not code-verified)

| Project | Notable claim | Verdict vs our moats |
|---|---|---|
| [memary](https://github.com/kingjulio8238/memary) | Memory stream + knowledge graph, MIT | Stale (last release Oct 2024); no provenance/bitemporal/encryption claims |
| [LangMem](https://github.com/langchain-ai/langmem) | LangGraph-native extraction + prompt optimization | No lifecycle/provenance/encryption claims |
| [Redis Agent Memory Server](https://github.com/redis/agent-memory-server) | Redis-backed semantic+hybrid search, own MCP server | No lifecycle/provenance/encryption claims |
| [A-MEM](https://github.com/agiresearch/A-mem) | Zettelkasten-style notes that "evolve" | "Evolution" ≠ bitemporal; no provenance/encryption claims |
| [memobase](https://github.com/memodb-io/memobase) | Persistent evolving user-profile object + event timeline; claims LoCoMo SOTA (marketing, not CI-gated) | **Closest analog to the "persistent profile" gap already flagged in the 2026-07-08 supermemory-matrix** — reinforces it as real, not hypothetical |
| [RedPlanetHQ/core](https://github.com/RedPlanetHQ/core) | "Temporal knowledge graph," claims AES-256-at-rest + CASA Tier 2, 88.24% LoCoMo (marketing claim) | Only long-tail project claiming encryption — but scope (self-host vs. hosted-only) is unverified from README alone; **released a new version literally the day this report was written (2026-07-09)** — high release velocity, worth a code-verify pass next cycle |
| [ReMe / MemoryScope](https://github.com/modelscope/ReMe) | File-based (Markdown+wikilinks) local-first memory, no DB | Different architecture angle (git-friendly/inspectable), not a lifecycle/provenance play |

None of the seven ship the provenance+bitemporal+encryption combination together; none show CI-gated retrieval eval.

---

## Moats that hold vs. moats that are table-stakes

### Holds cleanly
1. **CI-gated retrieval eval (recall@10/NDCG@10 floors on every push).** Strongest, cleanest moat in this pass. Graphiti has the closest infrastructure (a LongMemEval eval harness) but explicitly excludes it from CI. Cognee publishes benchmark JSON but doesn't wire it into CI. Nobody enforces a regression floor as a merge gate.
2. **Encrypted-at-rest, by default, whole-database.** Genuinely unique among the 6 majors. Letta's AES-256-GCM is the nearest analog but is field-level, opt-in, and requires manually setting `LETTA_ENCRYPTION_KEY` — not "on by default." RedPlanetHQ/core claims AES-256 but scope (self-host vs. hosted-only) is unverified.
3. **Default-local, not just capable-of-local.** mem0, Letta, Graphiti, and Cognee all default their LLM/embedding layer to OpenAI and require an API key to run the quickstart — Ollama/local is opt-in config in every one of them. txtai is the one competitor that defaults local (sentence-transformers, no key), but it's a general embeddings library, not agent memory. astramem-local shipping Ollama as the default is real, though the framing should shift from "local-first" (implies competitors aren't) to "default-local" (accurate — they're *capable* of local, we *ship* local).

### Erodes on closer inspection (table-stakes or partially matched)
4. **Provenance/explainability.** Still the strongest single differentiator by design (a dedicated tool returning source+evidence+reasoning), but it's not a category of one anymore: mem0's `explain=True` returns real `score_details`, graphiti attaches source-episode-ID pointers to every edge, and txtai has token-attribution explainability. None match `why_memory`'s combination of source pointer + evidence excerpt + score breakdown in one API, but "nobody explains anything" is no longer an accurate claim — reframe as "most complete provenance API," not "only one with provenance."
5. **Event-sourced/valid-time lifecycle.** Partially eroded: **Graphiti has real valid-time fields** (`valid_at`/`invalid_at`/`expired_at` on every edge, code-verified valid-time only — no transaction-time axis, see correction note above) — this is arguably a *more* precise valid-time model than astramem-local's memory-level `as_of` alone, just scoped to graph edges/facts rather than whole memories. (Since v0.12.0, astramem-local also has this at entity-link grain via FEAT-453 — same valid-time-only scope, narrower than "bitemporal" as either report originally implied.) mem0 has an audit-log `history` table (not append-only, no valid-time fields). Letta has append-only `BlockHistory`. The specific claim "nobody else tracks valid-time" should be dropped for Graphiti specifically; the broader claim "nobody else has a full verb-based lifecycle (supersede/invalidate/restore) across all memory state with a unified event log" still holds — it's more complete than any single competitor's piece. Neither astramem-local nor Graphiti should be described as "bitemporal" without qualification — that term implies a queryable transaction-time axis neither system has.
6. **MCP integration.** Was implicitly framed as differentiating in the 2026-07-08 report ("no first-party MCP" for Letta/Graphiti/Cognee) — **flatly wrong for Graphiti (13 tools, own CI) and Cognee (~20 tools, the richest surface found in this pass).** Only Letta is genuinely MCP-client-only. MCP presence is table-stakes among actively-maintained competitors; astramem-local's 15 tools are mid-pack on count, need to compete on tool design quality, not existence.

---

## Gaps to close (ranked)

1. **Persistent user-profile object.** Confirmed twice now — once via Supermemory's "static facts + dynamic context" claim (2026-07-08 supermemory-matrix.md) and again via memobase's explicit profile+event-timeline model in this pass. astramem-local has `/recall/pack` + `session_digest` but no standing profile object that updates incrementally. **Effort: M** (aggregation logic over existing typed-distillation output; no new storage primitive needed). *Who does it*: Supermemory (marketing claim, unverified from code), memobase (README claim, unverified from code — worth a follow-up clone if this becomes a priority).
2. **Cross-encoder / reranking pass on top of fusion.** Graphiti runs RRF + cross-encoder reranking (bge/openai/gemini) after its initial retrieval; astramem-local's `fuse.ts` is a weighted-fusion score, not a two-stage retrieve-then-rerank pipeline. **Effort: M** — could slot in as an optional post-fusion rerank step gated behind a local cross-encoder model (avoids a cloud dependency). *Who does it*: graphiti (`search/search.py:24-65`, verified-from-code).
3. **Entity/fact-level valid-time tracking (not just memory-level).** Graphiti tracks `valid_at`/`invalid_at`/`expired_at` on individual graph edges (facts about entities, valid-time only — see correction note above), which is finer-grained than astramem-local's memory-level `as_of`. If/when the entity layer grows, this is the next lifecycle primitive to add rather than a new full graph engine (kill-list #1 already rejects full graph — this is a narrower ask: temporal fields on the existing entity layer). **Effort: M**, contingent on entity-layer investment already being considered. *Who does it*: graphiti (`edges.py:271-282`, verified-from-code).

   **Status update (2026-07-12): closed locally.** FEAT-453 shipped `memory_entities.valid_at`/`invalid_at` (migration 023) in v0.12.0 — same grain and scope as Graphiti's edge fields, valid-time only. The cloud-side EF Core mirror (FEAT-453 SLICE-3) has not started; see `docs/specs/FEAT-453-bitemporal-design.md` §11.
4. **Broader retrieval-mode surface.** Cognee exposes 18 named search modes (RAG completion, graph completion, Cypher, temporal, coding-rules, agentic-completion, feeling-lucky, etc.) vs. astramem-local's single fusion pipeline with filters. Most of Cognee's modes are graph-specific and out of scope per the kill-list, but a couple (temporal-scoped search, code-aware search) map to things this repo already tracks as differentiators (as-of queries, AST-aware chunking on the roadmap). **Effort: S** — mostly a matter of exposing existing capabilities as named modes, not building new retrieval logic. *Who does it*: cognee (`modules/search/types/SearchType.py:5-21`, verified-from-code).
5. **Pluggable vector-store backends for scale-out.** mem0 ships 25 vector-store adapters (Qdrant default, Pinecone/Weaviate/etc. as options). astramem-local is intentionally sqlite-vec-only for the local daemon (kill-list #4 rejects a second local backend) — this is a deliberate non-gap for the local product, but worth flagging for the SaaS convergence track (Month 6 in the 2026-07-08 report already tracks pgvector-vs-Qdrant there). **Effort: N/A locally** — scoped to SaaS roadmap, not this repo. *Who does it*: mem0 (`vector_stores/`, verified-from-code).

Deliberately **not** listed as gaps (already covered by the existing kill-list in the 2026-07-08 report, re-confirmed by this pass): full graph-memory engine (Zep/Graphiti/Cognee's territory — MC:L/OC:L unchanged), multimodal ingestion, LLM proxy-interception.

---

## Corrections to prior research (2026-07-08 report)

These are factual flips, not new opinions — cite them when reusing the 2026-07-08 report's claims:

- "Mem0 natively provides [no] memory provenance" → **too strong**. mem0 has an audit-log `history` table and a real `explain=True` score-breakdown API. Still lacks a unified event-sourced lifecycle across all state and lacks bitemporal fields, so the broader "nobody else has event-sourced lifecycle + provenance together" framing survives — just not the flat "no provenance" line.
- "Letta: no first-party MCP" → **imprecise**. Letta has a substantial first-party MCP *client* subsystem; it genuinely lacks an MCP *server*. Say "MCP client-only," not "no MCP."
- "Zep/Graphiti: no first-party MCP" → **refuted**. 13-tool MCP server in-repo with its own CI workflow.
- "Cognee: no first-party MCP" → **refuted**. ~20-tool MCP server, the richest MCP surface found across all 6 majors.
- "Cognee: genuinely local-first... Ollama" → **overstated**. Storage defaults are local (LanceDB/SQLite), but LLM+embedding defaults are OpenAI; Ollama requires explicit opt-in with a strict env-var validator. Same caveat applies to Graphiti.
- "Zep/Graphiti: 63.8% LongMemEval" → **not reproducible from this repo**. The eval harness and data exist but are excluded from CI, and the number doesn't appear in README or code — treat as external/blog-sourced only, not repo-verified.
- "Mem0 graph memory paywalled at $249/mo" → **stronger than stated**: the OSS repo has zero graph-memory implementation at all (not present-but-gated) — it's architecturally absent from open source, confirmed by absence of any `GraphMemory` class or graph-DB client code.
- Supermemory "core engine closed-source... behind an enterprise agreement" → **partially refuted**. Closed-source core is confirmed (no `apps/api` in the public monorepo — the repo is a thin client of `api.supermemory.ai`). But the docs explicitly frame the self-hosted binary as free for individual developers, not enterprise-gated; Enterprise is an additive tier (SSO/RBAC/scale), not the gate to the core engine.

---

## Strategic recommendations

1. **Reframe "local-first" as "default-local" in all external messaging.** Every serious competitor (mem0, Letta, Graphiti, Cognee) is *capable* of running local/Ollama — none *ship* that as the default, all default to an OpenAI key requirement in their quickstart. That's the real, defensible distinction; the current framing overclaims by implying competitors can't go local at all, which a reader who clones their repo will immediately disprove (as this report did).
2. **Ship the persistent user-profile object next.** It's the most-repeated gap across two independent research passes (Supermemory's marketing claim on 2026-07-08, memobase's actual implementation today) and the effort is moderate — it's an aggregation layer over data astramem-local already collects (typed distillation), not a new storage primitive.
3. **Publish the LongMemEval/eval-harness numbers now, and lead with "the only one whose eval runs in CI, not just in a README."** This pass found the field's eval story is even weaker than believed: Graphiti's harness is *excluded* from CI, Cognee's benchmarks are published but not CI-wired, mem0/Letta/Supermemory have no retrieval-quality bench at all. The 2026-07-08 report already recommended publishing eval numbers — this pass adds the sharper, code-verified hook: not "we have better numbers" but "we're the only one who can't quietly stop passing."
4. **Add a cross-encoder rerank stage to the fusion pipeline as a Month-1/2 item.** Graphiti's RRF+reranker pattern is a proven, moderate-effort upgrade to retrieval precision that doesn't require any architecture change — it's an optional post-processing stage, compatible with the local-only constraint if the reranker model runs locally too (e.g., a small bge-reranker via the existing Ollama/local-model path).
5. **Watch RedPlanetHQ/core.** It's the only long-tail project claiming both a temporal-graph lifecycle *and* encryption at rest, and it shipped a new release on the exact day this report was written — high velocity for a young project. Its claims are README-tier only in this pass (not code-cloned); worth a dedicated code-verification pass in the next research cycle if it keeps that pace, specifically to check whether the AES-256 claim applies to self-hosted/Docker deployments or only the hosted tier.

---

## Credibility tiers used in this report

- **verified-from-code**: an agent read the actual cloned source and cites file:line.
- **from-README**: stated in the project's documentation but the implementing code wasn't inspected.
- **from-search-snippet**: found via web search only, repo never fetched.
- **unverified**: claim exists but no supporting evidence found in the available time/access (e.g., star counts — no web access was available to the code-verification sub-agents in this pass; treat all star counts here as carried over from the 2026-07-08 report or explicitly marked unverified).
