# AstraMemory — Ecosystem Research, Competitive Analysis & Release Plan
*2026-07-08 · Deliverables 0–6 per `2026-07-08-deep-research-prompt-astramem-ecosystem.md` · Sources: 25 web sources (118 extracted claims, 22 surviving 3-vote adversarial verification) + 7 code-grounded repo audits (astramemory-local × 5 slices, astramem-plugin, memory SaaS)*

---

# Deliverable 0 — Executive Product Verdict (one page)

**Would Karpathy / the Mem0 founders / the Supermemory founders use astramemory-local today, as-is? No — but not for the reason you'd fear.** They would never get past the first five minutes: the README's binary name (`astra-memory`, 33 occurrences) doesn't exist, the quickstart routes them into a stale npm package that crashes with `SQLITE_NOTADB`, there is **no LICENSE file** (MIT is claimed but never granted), and the first run silently pulls ~5.4 GB of models with no warning. They would close the tab before ever seeing the product.

**Would they use it after one week of fixes? Plausibly yes — and here is the uncomfortable part for competitors:** the engine behind the broken front door is, feature-for-feature, the strongest local-first memory daemon in the field. Verified against the landscape:

- **Nobody else has provenance or an event-sourced lifecycle.** A verified survey claim: *"None of Mem0, Letta, Zep, or Cognee natively provide memory provenance or an immutable event log."* astramemory-local has `why_memory` (evidence excerpt + source session + transcript ref), `memory_history`, and a full event log behind 7 lifecycle verbs. This is the moat.
- **Nobody else ships encrypted-at-rest local storage.** OpenMemory lists it as a roadmap item; the big four don't mention it. astramemory-local has SQLCipher on by default with OS-keyring key storage — independently security-audited this week with zero blockers.
- **Nobody else CI-gates retrieval quality.** The field is in a benchmark credibility crisis (Mem0 self-reports 91.6% LoCoMo; independent reproductions get 58–66%; Supermemory's #1 claims were refuted 0-3 by adversarial verification as unverifiable marketing). astramemory-local runs recall@10 ≥ 0.9 / NDCG@10 ≥ 0.7 floors on every push.
- **The failure mode users actually hate is memory rot.** The most damning practitioner evidence found: a 32-day production Mem0 audit where **97.8% of 10,134 memories were junk**, with one hallucinated fact snowballing into 808 duplicates. astramemory-local's typed distillation + consolidation + usefulness-feedback loop is a direct architectural answer.

**Would they star it? Yes, if the announcement leads with provenance and honest eval numbers.** Would they contribute? Only after CONTRIBUTING.md exists and CI covers more than Linux. Would they replace their current solution? The Claude Code segment would — Supermemory's Claude Code integration (2.7k stars) proves demand, and its MCP path is cloud-hosted on Cloudflare, which is exactly the trust gap a genuinely local, encrypted, provenance-receipted daemon exploits.

**The three changes that most alter the verdict within one week:** (1) LICENSE + README/binary-name/docs truth pass, (2) npm publish of the real 0.8.x so the install path works, (3) publish the eval-harness numbers and demo `why_memory` as the money shot.

**Verdict: the product is ~8/10; the packaging is ~3/10. The week's work is packaging.**

---

# Deliverable 1 — Scored Competitive Landscape

## Score table (1–10; AstraMemory scored twice: today vs after week-1 plan)

| System | DX | Install | Docs | Mem Quality | Retrieval | Dev Workflows | Arch | Prod Ready | **Avg** |
|---|---|---|---|---|---|---|---|---|---|
| Supermemory | 9 | 8 | 8 | 7 | 8 | 9 | 7 | 7 | **7.9** |
| Zep / Graphiti | 7 | 6 | 8 | 8 | 9 | 5 | 8 | 8 | **7.4** |
| Mem0 | 8 | 8 | 8 | 4 | 6 | 7 | 6 | 6 | **6.6** |
| Letta (MemGPT) | 6 | 6 | 7 | 7 | 6 | 4 | 8 | 7 | **6.4** |
| Cognee | 6 | 7 | 7 | 6 | 7 | 4 | 7 | 5 | **6.1** |
| OpenMemory | 6 | 7 | 6 | 6 | 7 | 7 | 6 | 3 | **6.0** |
| **AstraMemory today** | 5 | **3** | **4** | 8 | 8 | 8 | 8 | 6 | **6.3** |
| **AstraMemory after week 1** | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 7 | **7.9 → 8.4 with published LongMemEval run** |

Score justifications (condensed, from verified claims):

- **Supermemory** (28.3k★, MIT, TypeScript): best-in-class DX/workflows — one-line MCP installs, dedicated Claude Code (2.7k★), Codex (43★), Cursor (20★) repos, OAuth auto-discovery, project scoping via `x-sm-project` header. Weaknesses: MCP is **cloud-hosted** (Cloudflare Workers + Durable Objects at mcp.supermemory.ai, `mcp-remote` proxy even for Claude Desktop); two independent sources call the core engine closed-source with self-host behind an enterprise agreement; benchmark #1 claims (LongMemEval 81.6%, LoCoMo, ConvoMem) are self-reported — refuted 0-3 in adversarial verification as unverifiable; proxy architecture adds latency to every LLM request; standalone MCP repo deprecated/stale (repo churn). Absent from every major awesome-index checked.
- **Zep/Graphiti**: strongest published temporal story — facts as edges with `valid_at/invalid_at`, point-in-time retrieval, 63.8% LongMemEval (best independent big-four number), hybrid semantic+BM25+graph. Weaknesses: full platform SaaS-only (~$25/mo+), no first-party MCP (community wrappers only), 600K+ token footprint per conversation reported, retrieval delayed until graph processing completes.
- **Mem0** (~47-48k★, Apache 2.0, $24M): biggest community, first-party MCP for Claude Code/Cursor, Python+JS SDKs. Weaknesses are memory-quality-shaped: 49.0% LongMemEval independent; 91.6% self-report vs 58–66% independent reproduction; the 97.8%-junk production audit; reproducible hallucinated-memory bug (empty messages + run_id); `get_all()` KeyError on documented graph config; graph memory paywalled at $249/mo Pro.
- **Letta**: OS-style three-tier (core/recall/archival), agent-managed memory, ~83% LoCoMo independent, fully self-hostable. Weaknesses: full agent runtime (heavy lock-in — migrating away means rewriting agent infra), Python-only SDK, no first-party MCP, memory ops consume inference tokens.
- **Cognee**: genuinely local-first (SQLite/LanceDB/Kuzu, Ollama, 6-line init), ECL typed-graph pipeline. Weaknesses: no first-party MCP, no compliance posture, weakest coding-agent story.
- **OpenMemory** (4.3k★, Apache 2.0): closest architectural cousin — local-first SQLite, native MCP (Claude/Cursor/Windsurf), 5-sector memory + temporal graph, ships migration importers **from Mem0/Zep/Supermemory**. Weaknesses: mid-rewrite with explicit breaking-changes warning; encryption-at-rest is roadmap-only.
- **Others**: Hindsight — vendor-published 91.4–94.6% LongMemEval via 4-strategy retrieval + reranking (treat as vendor claim; their blog scores competitors). MemVid — marked *debunked* by a curated index; no concurrent writes/ACID/deletions. LangMem — 58.1% LoCoMo with ~60s p95 search latency (impractical interactive). Kernel Memory / MemOS / A-MEM — no significant verified coding-agent presence surfaced. Cloudflare Agent Memory — private beta, typed memory model, managed-only; watch as a platform-tier entrant.

## Ecosystem map (condensed)

- 🟢 **Direct (coding-agent memory)**: Supermemory (+claude-supermemory/codex-supermemory/cursor-supermemory), Mem0 (first-party MCP), OpenMemory, Hindsight.
- 🟢 **Direct (local-first)**: Cognee, OpenMemory, Letta self-host.
- 🟡 **Indirect**: Zep/Graphiti (temporal graph, SaaS), LangMem (LangChain-native), MemOS, Kernel Memory (MS ecosystem), Cloudflare Agent Memory (beta).
- 🔵 **Infrastructure**: Graphiti (OSS engine under Zep), sqlite-vec-class embedded stores, Qdrant et al.
- 🟣 **Research**: IAAR-Shanghai index (540 papers/108 projects), Awesome-GraphMemory (survey, 4-stage taxonomy, 40–50+ benchmark datasets), A-MEM.
- ⚪ **Experimental/discredited**: MemVid (flagged debunked), supermemory-mcp v1 (deprecated).
- **Benchmark currency of the field**: LongMemEval, LoCoMo(-Plus), BEAM, ConvoMem, MemoryAgentBench, LifelongAgentBench, PersonaMem. Index coverage is patchy — awesome-ai-memory doesn't even list Supermemory — so index absence signals nothing; presence on benchmarks signals everything.

## Feature matrix highlights (AstraMemory column code-verified this week)

| Capability | AstraMem | Supermemory | Mem0 | Letta | Zep | Cognee | OpenMemory |
|---|---|---|---|---|---|---|---|
| Local-first daemon | ✅ encrypted SQLite | 🟡 local mode, cloud-first | 🟡 self-host | ✅ | 🔴 SaaS | ✅ | ✅ |
| Encrypted at rest | ✅ default | 🔴 undocumented | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 roadmap |
| Provenance ("why") | ✅ `why_memory` | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 |
| Event-sourced lifecycle | ✅ 7 verbs + log | 🔴 | 🔴 | 🟡 agent-managed | 🟡 validity windows | 🔴 | 🔴 |
| Consolidation w/ human gate | ✅ propose/accept | 🟡 auto-forget | 🟡 auto-update | 🟡 | 🟡 auto-retract | 🔴 | 🟡 reinforce |
| Usage-feedback ranking | ✅ ε-component | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🟡 reinforce |
| CI-gated retrieval eval | ✅ every push | 🔴 self-reported | 🔴 disputed | 🔴 | 🟡 published | 🔴 | 🔴 |
| MCP (local, not proxied) | ✅ 15 tools | 🔴 cloud-hosted | ✅ | 🔴 community | 🔴 community | 🔴 | ✅ |
| Claude Code integration | ✅ plugin+hooks | ✅ 2.7k★ repo | ✅ | 🔴 | 🔴 | 🔴 | 🟡 |
| Hybrid BM25+vector fusion | ✅ 5-component | ✅ | 🟡 | 🟡 | ✅ +graph | ✅ graph | ✅ |
| Temporal/as-of queries | ✅ `--as-of` | 🟡 fact tracking | 🔴 weak | 🟡 | ✅ best | 🟡 | ✅ |
| Public benchmark number | 🔴 **gap** | 🟡 self-reported | 🟡 disputed | ✅ independent | ✅ independent | 🔴 | 🔴 |
| Working install docs | 🔴 **broken today** | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 rewrite |

---

# Deliverable 2 — Verified Audit + Parity Matrix

Seven audit passes, all code-grounded. Full artifacts in `.claude/artifacts/crew/handoffs/20260708T*`.

## Release blockers (Ship This Week — each moves a named score)

| # | Finding | Evidence | Effort | Score moved |
|---|---|---|---|---|
| B1 | **LICENSE file missing**; package.json claims MIT + lists LICENSE in files[] — publish silently omits it | repo root; package.json:13,56 | S | Install 3→ |
| B2 | **Wrong binary `astra-memory` in 33 README places + 5 docs files** (real bin: `astramem-local`); README header/status fossilized at v0.1–v0.2; provider matrix names the abandoned 768-dim `nomic-embed-text-v2-moe` as a 1024-dim default; docs/providers.md tells users to pull the wrong model | README.md:2-6,59-63,152,422-431; docs/{configuration,providers,troubleshooting,backup-recovery,migration-from-saas}.md | S–M (mostly one find/replace pass) | Docs 4→8, Install |
| B3 | **npm shadow**: README `bun add -g` lands users on registry v0.4.0 (no cipher → `SQLITE_NOTADB`). Publish current 0.8.x + rewrite quickstart | CLAUDE.md warning; registry state | M (publish + verify) | Install 3→8 |
| B4 | **Plugin README Quick Start non-functional**: `astramem connect ABCD-1234` takes zero args (claim-code flow lives in a different binary `astramem-connect`); env-var table documents a dead pre-daemon architecture (ports 5201/5202, `MEMORY_MCP_URL` never read anywhere — MCP silently fails if followed); "(pending FEAT 4a)" labels on shipped methods | plugin README.md:25,179-196,219-221,238; .mcp.json:5; src/cli/connect.ts | S–M | DX, Install |
| B5 | **`wire_version` regex divergence (new bug)**: daemon minor `[0-9]+` accepts `v1.01`; SaaS `^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$` rejects it. Tighten daemon to match | astramemory-local src/server/routes/ingest.ts:90 vs memory IngestTranscriptRequest.cs:65 | S | Arch |
| B6 | SECURITY.md + CONTRIBUTING.md missing (README has a good security section; no disclosure path) | repo root | S | Prod Ready |
| B7 | First-run: init auto-pulls ~5.4 GB models with no size warning; missing Ollama = buried console.warn, discovered only at serve time. 10–30 min to first memory, undocumented | src/cli/init.ts:195-251 | S | Install, DX |

## High-embarrassment (week if cheap, else Month 1)

- **CI is Linux-only, self-hosted** — no Windows/macOS job despite both documented first-class; all three service adapters unit-tested with mocked `child_process` only; init wizard has no end-to-end test (prompts mocked). (`.github/workflows/test.yml:22-23`) — Effort M.
- **Shim/pointer + rollback architecture is Windows-only**: Linux/macOS `reinstall` bakes absolute release paths into unit/plist (re-touches scheduler every upgrade) and `restorePriorPointer` explicitly no-ops off-Windows — failed reinstall has no automated rollback there. systemd `Restart=on-failure` / launchd `KeepAlive` restart on crash but nothing catches a **hang** (no PT5M-equivalent watchdog). (src/service/install-flow.ts:74-84, reinstall.ts:59-66) — Effort M–L; for the week, *document* the asymmetry honestly.
- **MCP tool count is 15, not 16** as internal docs claim (manifest + server 1:1 verified); marketplace description lists only 4 of 15 — cosmetic.
- Naming drift is real in code, not just docs: Windows dirs renamed to `Astramem`, Linux/macOS still `~/.config/astra-memory`; troubleshooting.md invents a third name `astra-memoryd`. Unify vocabulary; keep on-disk paths (migration churn not worth it), fix prose.
- docs/contracts.md claims "schema frozen at migration 001" — repo is at 017.
- Plugin stale versions: `bin/astramem --version` reports 0.5.2 (pkg is 0.6.1); dead `/register` probe path (daemon never had that route); tracked `.env.local`/`.env.azuredev` expose an internal azurecontainerapps hostname.
- Security audit: **no blockers**. Two minor: dashboard bootstrap token transits URL once (mitigated, one-time, HttpOnly exchange — pre-empt in README); no rate-limit on Bearer 401s (local threat model). Timing-safe compare, loopback-gated public routes, 0600 perms, no tracked secrets, no CORS exposure — all verified clean. This survives HN scrutiny.

## What audit confirmed as genuinely strong (feature inventory)

25 CLI commands; 24 API routes + 5 dashboard pages; 15 MCP tools manifest-paritied; 7-component score fusion (α..η, entity/agent boosts present but default-off); event-sourced lifecycle with centralized error mapping; consolidation with auto-merge/containment/proposal tiers and usefulness-aware winner selection; sync shipper/puller/conflict-resolve/backfill present; ADR-005 eval gate confirmed running in every CI pass; real spawned-daemon smoke + plugin roundtrip e2e; wire-version compat probing plugin↔daemon verified matching; plugin privacy posture excellent (auto mode refuses silent SaaS fallback).

## SaaS repo (roadmap inputs)

44 controllers; hybrid semantic/keyword search with score explanations; pgvector **and** Qdrant live simultaneously (undecided migration — decide target); 22 MCP tools; connectors Atlassian/GitHub/Linear/Notion/Slack/MCP; 48 dashboard pages; teams/orgs with Admin/SuperAdmin policies. Convergence state: `content_hash {32,64}` relax **merged** in schema.sql (prod deploy still gated on the v0.8.4 tag — memory#621); `Sync:Enabled` default-closed gate with per-tenant allowlist confirmed (memory#667); redeem `apiUrl` bug confirmed as hardcoded fallback `https://api.astramemory.com` with no appsettings override (ClaimsController.cs:92-94). SDKs: real code + real publish CI (`sdk-publish.yml` on `sdk-v*` tags) but **no tag ever pushed** — and TS SDK wraps only 4 methods (create/search/get/delete) vs the API. JWT audience validation currently opt-in-off (T8 follow-up) — roadmap-visible hardening item.

---

# Deliverable 3 — Kill List

Things AstraMemory should **NOT** build. Maintenance cost (MC) and opportunity cost (OC) rated S/M/L.

1. **Full graph-memory layer (Neo4j-class knowledge graph).** Zep/Graphiti own this positioning with independent benchmark wins; Mem0's version is paywalled at $249/mo and shipped a KeyError on its own documented config. The existing entity layer + `--as-of` temporal filters cover the coding-agent need. MC: L (graph infra, extraction quality, ops). OC: L — every graph week is a week not spent on the provenance/eval moat. *Revisit only with user evidence of multi-hop queries failing.*
2. **React SPA dashboard for the local daemon.** SaaS already has 48 pages; the daemon's server-rendered HTML dashboards are adequate for inspect/debug. MC: M–L (frontend toolchain in a daemon repo). OC: L.
3. **Local multimodal ingestion (audio/OCR/video).** Supermemory does this cloud-side with cloud economics; SaaS repo already has AudioController for the platform tier. Coding-agent memory is text. MC: L. OC: L.
4. **LanceDB second vector backend.** Init wizard already silently falls back from it — remove the dead option rather than implement it. sqlite-vec is the local answer. MC: M. OC: M. *(Same discipline applies SaaS-side: pick pgvector or Qdrant, not both forever.)*
5. **LLM proxy-interception mode** (auto-memory by proxying model calls). Supermemory's is criticized for adding latency to every request; hooks/MCP capture is architecturally cleaner and already shipped. MC: M. OC: M.
6. **Emotional/reflective memory sectors** (OpenMemory's 5-sector model). No coding-agent value; classifier maintenance forever. MC: M. OC: S.
7. **Universal cross-LLM memory sharing** (ChatGPT↔Claude portability, supermemory-mcp's pitch). Different wedge, auth/privacy swamp; that repo is itself deprecated. MC: M. OC: M.
8. **Compliance theater for the OSS daemon** (SOC 2 etc.). Meaningless for local software; belongs to SaaS when enterprise demands it. MC: L. OC: L.
9. **Chasing #1 on marketing benchmarks.** The field's self-reported numbers are being publicly discredited (Mem0 91.6 vs 58–66 independent; Supermemory's claims unverifiable). Publish honest numbers + methodology instead; do not tune-to-the-test. MC: S. OC: — (this kill is a positioning choice).

---

# Deliverable 4 — Release Plan

## Week 1 — ship 2026-07-15 (P0)

Order matters; items 1–6 are the credibility floor.

1. **LICENSE (MIT) + SECURITY.md + CONTRIBUTING.md** — S, day 1.
2. **Truth pass on README + 5 docs files**: `astra-memory`→`astramem-local` everywhere; kill v0.1/v0.2 fossils; fix embed-model references (`mxbai-embed-large`, 1024-dim); quickstart gets `bun install && bun run build`; document the ~5.4 GB model pull + 10–30 min first run; pre-empt the two minor security notes; fix external `../astramemory-plugin/...` link; remove internal publishing section or add repository/homepage/bugs to package.json. — S–M, day 1–2.
3. **npm publish 0.8.x** under the final name (see naming decision, D6-3) so the documented install actually works; verify `SQLITE_NOTADB` shadow is dead; add repository fields. — M, day 2.
4. **Plugin fix pass**: Quick Start command corrected (or `connect` gains the claim-code arg), env-var table regenerated from env-specs.ts, `MEMORY_MCP_URL`→`MEMORY_API_URL` docs fix, "(pending)" labels removed, `bin/astramem --version` bumped, `.env.local`/`.env.azuredev` replaced with a genericized example, marketplace description lists all 15 tools. — S–M, day 2–3.
5. **Daemon wire fix**: tighten `wire_version` minor regex to match SaaS (`ingest.ts:90`); one-line test. — S.
6. **Init UX**: upfront model-size notice + hard confirm when Ollama missing (block-or-continue prompt, not buried warn). — S, day 3.
7. **Evidence assets**: publish the ADR-005 eval numbers (recall@10 ≥ 0.9, NDCG@10 ≥ 0.7, deterministic methodology) in the README with a "why CI-gated floors, not marketing benchmarks" paragraph; fix "16 tools"→15 in internal docs. — S, day 3–4.
8. **Manual cross-platform smoke** (CI runners are Month 1): fresh-VM `init→reinstall→ingest→recall` on Ubuntu + macOS; document the Windows-vs-unix rollback/watchdog asymmetry honestly in README. — M, day 4–5.
9. **Demo + announcement**: asciinema/gif — Claude Code session → memories form → new session recalls → `why_memory` shows the receipt. Announcement angle: *"Local-first, encrypted, provenance-receipted memory for Claude Code — with CI-gated retrieval floors instead of self-reported benchmarks."* Direct comparisons: Supermemory (cloud MCP vs local), Mem0 (junk-audit story vs typed distillation + consolidation). — M, day 5–6.
10. **Release checklist**: version-tag parity green, secrets/gitignore audit (done — clean), CHANGELOG entry, plugin pairing walkthrough tested, GitHub issues filed for everything deferred below.

**Cut from the week**: CI runners, LongMemEval run, SDK publish, sync completion, any Kill-List temptation.

## Month 1

Windows+macOS CI runners + one real (non-mocked) service lifecycle test + init wizard e2e; **run LongMemEval/LoCoMo and publish honest numbers with methodology** (the single biggest score lever: 7.9→~8.4); finish sync bring-up (memory v0.8.4 tag → #621, tenant gate #667, daemon #81 redeem URL + surface shipper error bodies); coverage tooling; consider `restore`/`consolidate` CLI docs; decide pgvector-vs-Qdrant.

## Month 3 — differentiation

Extend the ADR-010 usefulness loop toward self-tuning fusion weights (learn α..η from used/corrected signals); autonomous consolidation on the existing proposal flow (auto-accept above confidence, human gate below); memory-health score (junk %, duplication, staleness — productize the exact audit that embarrassed Mem0); GitHub/CI intelligence (ingest PR reviews + CI failures as typed lessons); publish the eval harness as a standalone benchmark tool (memorybench-style, positioned as the honest-eval answer).

## Month 6 — convergence

Complete (not redesign) Local↔SaaS sync: entitlement UX, multi-device polish (ADR-011 already specifies conflicts); orgs/enterprise permissions SaaS-side; extract `contracts/` into a shared package generating TS + Zod + C# from one SoT; one SDK targeting daemon and cloud (align daemon REST shapes where cheap); grow the SDKs past 4 methods before any `sdk-v*` tag; self-host hardening (TLS defaults, single vector backend).

## Month 12 — endgame

One product: local daemon (private by default, encrypted, provenance-receipted) + agent plugins (Claude Code first-class, Codex/Cursor next) + team cloud (scoped sync — personal never leaves the machine). Positioning: **the memory platform coding agents can be audited against** — every memory has a receipt, every ranking has a feedback trail, every release has eval numbers. Supermemory wins on polish today; nobody in the field can currently win on *trust*, and trust is the durable axis for developer infrastructure.

---

# Deliverable 5 — Architecture Evolution (incremental only)

1. **Contracts as the convergence spine.** `contracts/` (JSON-schema → TS + Zod, manifest-paritied) is already the SoT; SaaS mirrors by hand. Extract to a shared package; add C# generation; the `wire_version` divergence found this week is exactly the class of bug this kills. Effort M, high leverage.
2. **Do not redesign sync.** ADR-003/009/011 + shipper/puller/conflict-resolve exist and pair successfully. Remaining work is completion: two SaaS-side blockers, redeem URL, error-body surfacing, entitlement UX. Investigate the one flag found: `puller.ts:237` "not a verified cloud implementation" comment.
3. **Retrieval divergence is legitimate.** Local 7-component fusion vs SaaS hybrid+bitemporal serve different constraints. Converge the *contracts* (shared ranking-explanation shape — SaaS already returns ScoreExplanation; daemon has search-debug) and the *eval harness* (run the same eval set against both), not the implementations.
4. **Service layer**: port the pointer-indirection (or an equivalent stable-path symlink scheme) to systemd/launchd so upgrades stop rewriting units and rollback works everywhere; add a hang-watchdog equivalent (systemd `WatchdogSec` fits naturally). M–L, Month 1–3.
5. **SDK strategy**: one SDK, two baseURLs. Daemon already speaks REST; align a small set of route shapes (memories/search) with SaaS so the published SDK targets both. Grow SDK surface before first publish tag.
6. **No rewrites warranted anywhere.** Nothing found this week fundamentally blocks growth.

---

# Deliverable 6 — Surprise Me (CTO's three)

1. **Your best marketing asset is your test suite — weaponize the field's credibility crisis.** Verified this week: Mem0's 91.6% self-report reproduces at 58–66%; Supermemory's #1 claims died 0-3 under adversarial verification; a curated index literally marks a competitor "debunked." Nobody in this market can currently be believed. Publish the eval harness, publish honest LongMemEval numbers *even if mid-pack*, and run the "97.8% junk" audit methodology against a real 30-day astramem store and publish that too. "The memory system that shows its work" is a category-of-one position and it costs a week, not a quarter.
2. **The npm shadow is probably self-inflicted — check before renaming anything.** If `astramem-local`@0.4.0 on the registry is your own stale publish, the "shadowing hazard" dissolves with one `npm publish` of 0.8.x to the same name (+ a doctor check that flags version-mismatch installs, which `reinstall` already half-does). The week-1 naming decision may be a 30-minute fix wearing a rebrand costume. Decide the *brand* (AstraMemory) separately from the *bin* (`astramem-local`) and stop conflating them across docs.
3. **Distribution is the plugin marketplace, not npm.** Every competitor fights for MCP-config mindshare; you already sit inside Claude Code's plugin marketplace with hooks that need zero user prompting. Make the plugin the installer: `astramem` plugin detects no daemon → offers to install/init it (or walks through it). Supermemory's funnel is `npx install-mcp` + a cloud login; yours can be "install plugin, say yes once, memory is local and encrypted." That's a structurally better funnel the week-1 README can't deliver but Month 1 can — and it's the answer to their 2.7k-star Claude Code integration.

---

# Coverage caveats

Web verification ran under heavy API throttling on the first pass; final pass: 25 sources, 118 claims extracted, 25 verified (22 confirmed / 3 refuted — the refuted being Supermemory's benchmark/tool-count marketing claims and one Letta/Mem0 comparison blog claim). Vendor blogs (Hindsight/vectorize, Mem0's own state-of-memory post) are flagged as self-interested where cited. Kernel Memory, MemOS, A-MEM, Reflect, LangMem received thin coverage — none surfaced as a coding-agent threat in any source; revisit at Month-1 depth if evidence changes. SaaS prod *deployment* state (env overrides, tag position) was out of audit scope — repo-only findings.
