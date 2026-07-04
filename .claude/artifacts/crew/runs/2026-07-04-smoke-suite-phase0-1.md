# Smoke suite — Phase 0 + Phase 1 inventory (2026-07-04)

Read-only analysis by two parallel investigators (surface inventory + coverage mapping).
No code changed. Feeds the `tests/smoke/` plan awaiting approval.

## Phase 0 — Coverage-gap table

| Component | Lifecycle stage | Surface(s) | Current tests | Coverage level | Risk if regressed | Smoke needed? |
|---|---|---|---|---|---|---|
| Ingest (dual envelope + idempotency) | ingest | HTTP | server/ingest.test.ts (583L, in-process), integration/ingest-e2e.test.ts (spawned daemon) | HIGH — wire_version matrix, idempotency replay/409, canonical+legacy | high | NO — covered |
| Distill pipeline (8 stages) | distill | internal | distill/01-08 + pipeline.test.ts; pipeline/worker, job-recovery | HIGH unit+integration | high | NO |
| Full loop ingest→distill→search | all | HTTP, spawned daemon | e2e/plugin-flow.test.ts (mock providers, port 18950, `:memory:`) | MEDIUM — one hybrid query, one memory type | high | EXTEND (richer fixture optional; not this pass) |
| Search modes (fts/vec/hybrid/as_of/entity/type/since) | search | HTTP in-process | server/search.test.ts (465L); search/as-of, entity-filter, usefulness-rank (DB-level) | HIGH in-process | high | PARTIAL — never through a real spawned daemon w/ file DB; folded into restart smoke |
| Ranking quality | search | internal | eval/retrieval-eval.test.ts (recall@10≥0.9, NDCG@10≥0.7, zeta snapshot) | HIGH — regression floors | high | NO — eval gate owns this |
| Recall pack / injection policy | recall | HTTP + internal | recall/pack.test.ts (mixed), policy.test.ts | GOOD | med | NO |
| MCP (14 tools, JSON-RPC over real listen()) | search/recall/lifecycle | MCP | mcp/server.test.ts (723L) | HIGH | med | NO |
| Lifecycle ops (invalidate/supersede/promote/history/why/digest) | lifecycle | HTTP | server/lifecycle, why, digest, memory tests | GOOD | med | NO |
| Erasure | lifecycle | HTTP | storage/erasure.test.ts | GOOD | med | NO |
| **Restart persistence (real daemon, file datadir)** | restart | daemon lifecycle | **NONE** — only sync/puller.test.ts watermark (db.close/reopen, sync cursor only) | **GAP** | **HIGH — flagship promise of a local-first memory daemon** | **YES — SMOKE-1** |
| **CLI compiled entrypoint (argv parsing)** | search/recall | CLI | cli/* are function-level w/ mocked fetch; only `serve` spawned (serve.test.ts) | **GAP** — argv wiring for search/recall/entities/as-of/entity untested | med-high — wiring bug invisible until user runs command | **YES — SMOKE-2** |
| memory-tool adapter route | retrieval | HTTP | memory-tool/adapter.test.ts (unit only; POST /memory-tool route not exercised) | LOW gap | low | YES — 1 assertion in spine (cheap) |
| Backup/restore snapshot | persist | internal | backup/snapshot, verify-restore | GOOD (offline verify) | med | NO |
| Archival TTL pass | lifecycle | internal (config-gated) | none found dedicated | LOW | low (flag default off?) | NO — gaps report only |
| OS service (schtasks/systemd/launchd/shim/lock) | ops | OS | service/* (mocked OS calls) | GOOD for scripts | med | NO — not data lifecycle |
| Shared helpers/fixtures | — | — | **NONE** — no tests/helpers/, no vitest.config, boilerplate repeated per file | duplication | — | Extract during SMOKE work |

## Phase 1 — Retrieval surface inventory

| Retrieval type | Entry point (file:symbol) | Surface(s) | Ranking | Filters | Existing test | Smoke needed? |
|---|---|---|---|---|---|---|
| Hybrid FTS+vec search | src/search/search.ts:search() | GET /search, POST /recall, MCP search_memory/recall_memory, CLI search/recall | fuseHits: α·bm25+β·cos+γ·imp+δ·fresh+ε·useful+ζ·entity | type[], repo, project, since(ms), as_of, entity; limit 1–100 | server/search.test.ts (in-process), eval gate, plugin-flow (1 query e2e) | via SMOKE-1 query set |
| FTS5 BM25 component | search.ts inline (memories_fts) | component of above | bm25 normalized | — | fuse.test.ts + eval | NO |
| Vector cosine component | src/vector/sqlite-vec.ts:SqliteVecStore.search() | component | cosine | none pre-filter (post-fusion only) | vector/sqlite-vec.test.ts, embed-dim-e2e | NO |
| Bitemporal as_of | search.ts:validityFilterClause()+parseAsOf() | GET /search, POST /recall, CLI --as-of. NOT in MCP schemas | — | as_of | search/as-of.test.ts (DB), server/search.test.ts (HTTP) | via SMOKE-1 + SMOKE-2 CLI |
| Entity filter (pre-fusion) | search.ts + storage/entities.ts:memoryIdsForEntities | GET /search, POST /recall, CLI --entity. NOT in MCP schemas | intersected pre-fusion | entity name (exact→LIKE) | search/entity-filter.test.ts, server/search.test.ts | via SMOKE-1 + SMOKE-2 |
| Recall pack (heuristic injection) | src/recall/pack.ts:selectPack() | POST /recall/pack (no prompt) | typeWeight·recency·importance | repo, budgetTokens | recall/pack.test.ts | NO |
| Injection policy v1 | src/recall/policy.ts:decideInjection() | POST /recall/pack (with prompt) | wraps pack + gating, minScore 0.15 | flag recallPack.policy.enabled (default on) | recall/policy.test.ts | NO |
| Entity autocomplete | storage/entities.ts:EntityRepo.search() | GET /entities, CLI entities list | alphabetical/LIKE | q, limit≤100 | cli/entity.test.ts (mocked fetch) | SMOKE-2 real argv |
| Entity→memories | EntityRepo.memoryIdsForEntities + MemoryRepo.get | GET /entities/:id/memories, CLI entities show | insertion order | valid-only | cli/entity.test.ts (mocked) | SMOKE-2 |
| Memory by id | storage/memories.ts:MemoryRepo.get() | GET /memory/:id | — | id | server/memory.test.ts | NO |
| Why (provenance) | server/routes/why.ts (+ dup in mcp/server.ts) | GET /memory/:id/why, MCP why_memory | — | id | server/why.test.ts, mcp/server.test.ts | NO |
| Session digest | server/routes/digest.ts (+ dup in MCP) | GET /sessions/:id/digest, MCP session_digest | — | session id | server/digest.test.ts, mcp | NO |
| Memory history | storage/memory-events.ts:listForAtom() | GET /memory/:id/history, MCP memory_history | — | id | server/lifecycle.test.ts | NO |
| Consolidation proposals | consolidate/proposals.ts:ProposalRepo.list() | GET /consolidation/proposals, MCP, CLI | — | status | consolidate.test.ts, mcp | NO |
| Dashboard | server/queries/dashboard.ts | GET /dashboard (custom auth) | — | — | server/dashboard.test.ts | NO |
| memory-tool `view` | src/memory-tool/adapter.ts:handleMemoryToolCommand() | POST /memory-tool | — | virtual path per type | adapter.test.ts (unit only — route untested) | 1 spine assertion |
| Health/version | server/routes/health.ts, version.ts | GET /health, /version (public on loopback), MCP get_health (ok+version only) | — | — | health-hardening, ingest-e2e | used as readiness probe |
| Query token parser `type:x repo:y since:7d` | src/search/query.ts:parseQuery() | **NONE — dead code, never imported** | — | — | search/query.test.ts (tests dead code) | NO — flag for deletion |
| Archive/restore | storage/memory-events.ts:archive()/restore() | archive: internal TTL pass only; **restore: unreachable from any surface** | — | — | none dedicated | NO — implementation gap |

## Implementation gaps (documented, NOT tested)

1. `src/search/query.ts parseQuery()` dead code (its unit test exercises unreachable code). Smallest fix: delete both, or wire into CLI `q` parsing — product call.
2. `MemoryEventRepo.restore()` unreachable — no route/CLI/MCP calls it. Operators cannot un-archive. Smallest fix: `POST /memory/:id/restore` + CLI flag.
3. MCP `search_memory`/`recall_memory` schemas missing `as_of` + `entity` (REST/CLI have both). Smallest fix: add two optional params to tool schemas.
4. why/digest logic duplicated route-vs-MCP (in sync today, drift risk). Smallest fix: extract shared query fn.
5. GET /health rich vs MCP get_health minimal (ok+version). Document as intended or extend tool.
6. No pagination anywhere (limit-only, cap 100) — document as design.
7. REST /consolidation/proposals lacks winner/loser text enrichment that MCP has; CLI compensates with N follow-up GETs.
8. Encryption/keystore handling for file-based datadir under test — existing spawned tests all use `:memory:`; SMOKE-1 must resolve key sourcing (risk item, resolve at implementation).

## Reusable infrastructure found

- Mock providers: `ASTRA_MEMORY_MOCK_PROVIDERS=1` env (plugin-flow); `makeMockProviders(dim)`; `makeFakeVec` deterministic embedder.
- Live mode convention: `INTEGRATION_LIVE=ollama|azure`.
- Spawn pattern: `spawn(process.execPath, ['dist/cli/index.js','serve','--port',...])` + `/health` poll ≤8s + pollSearch ≤30s (plugin-flow.test.ts).
- Ports claimed: 17777 (cli/serve), 17778 (ingest-e2e), 18950 (plugin-flow), 0 (mcp). Smoke claims **19000+**.
- Fixtures: tests/e2e/_fixtures/short-session.txt; contracts/fixtures/eval/*.json.
- No shared helper module exists — extraction opportunity.

---

## Gate results (2026-07-04, pre-build)

### Architect review: APPROVE-WITH-CHANGES

**F1 (BLOCKING, resolved by plan amendment)** — file-datadir spawn hits REAL OS credential store: `serve.ts:86-104` skips keystore only for `:memory:`; `resolve-runtime.ts:44` has no config-dir env override (only `ASTRA_MEMORY_DATADIR` for data); default `security.encryption.enabled: true` → `getOrCreateKey()` → @napi-rs/keyring → real Windows Credential Manager. No mock/bypass env exists in src/.
**Fix (test-only)**: spawn child with `APPDATA`/`HOME`/`XDG_CONFIG_HOME` pointed at temp config dir + pre-write `config.yaml` with `security.encryption.enabled: false`. **Accepted limitation**: smoke proves plaintext file-DB persistence only; encrypted reopen path (multiple-ciphers) untested at smoke tier — follow-up FEAT candidate.

Other findings folded in:
- F2: SIGKILL only (exercises stale-lock steal, instance-lock.ts:121-136 + WAL recovery); assert `daemon.lock` PID changed post-respawn.
- F3: extract helpers by parameterizing PORT/TOKEN; verify plugin-flow green before+after.
- F4: `fs.mkdtempSync` per run; cleanup in TEST-process try/finally (SIGKILL means daemon never self-cleans).
- F5: plugin repo `tests/contracts/transcript-wire.test.ts` ALREADY covers wire_version regex + client_scrub_* + turn shaping via Zod — SLICE-2 unit tests must target capture-hook envelope ASSEMBLY, not re-test schema. No process-spawn precedent in plugin repo: introduce `ASTRAMEM_LOCAL_DIST_PATH` env + skip-if-missing (mirrors INTEGRATION_LIVE gating); pin daemon to fixed commit/build, never sibling worktree mid-edit state.
- F6: one describe.sequential, step-numbered it() blocks (not one giant it()).
- F7: CLI battery thin — exit code + right ids only; CLI child needs `ASTRA_MEMORY_URL`/`ASTRA_MEMORY_TOKEN` env (defaults 127.0.0.1:7777/devtok otherwise).
- F8/F9: no other duplication; nothing high-risk missing.

### PM acceptance criteria

SLICE-SMOKE-1 (daemon, astramemory-local): AC-1 spawn+health ok; AC-2 canonical ingest 200 + distill drain poll; AC-3 HTTP battery all 200 + fixture-derived asserts (hybrid/type/entity/as_of/since/repo//recall//entities//memory-tool); AC-4 CLI argv battery exit 0 + expected stdout; AC-5 SIGKILL→respawn same datadir→identical ids/counts + daemon.lock PID changed; AC-6 zero residue (temp dirs deleted, port 19000 free) incl. failure path; AC-7 helper extraction behavior-preserving, plugin-flow green; AC-8 test:smoke < 2 min, zero network; AC-9 (amended per F1) temp APPDATA + encryption:false config, restart has no key/decrypt error, real credential store never touched.

SLICE-SMOKE-2 (plugin, astramemory-plugin, parallel): AC-1 (retargeted per F5) capture-hook envelope ASSEMBLY output matches wire shape; AC-2 client scrub → client_scrub_* fields correct + redacted content absent; AC-3 turn shaping preserves role/order/content; AC-4 pinned daemon build verified via /version before roundtrip, fail-fast if missing; AC-5 capture→ingest 200 + distill poll; AC-6 recall roundtrip returns expected memory; AC-7 missing-build path → explicit actionable error/skip (ASTRAMEM_LOCAL_DIST_PATH unset → skip); AC-8 unit tests hermetic (zero network/daemon), only roundtrip needs spawn.

Slice-2 port: claim 19100+ (distinct from slice-1's 19000).

### Status: plan approved-with-changes, ACs locked. Awaiting operator go for parallel build.

---

## Fuse-score wire-contract fix (2026-07-04, post-build)

Bug found by SLICE-SMOKE-2's roundtrip test on first live run: fuseScores() raw weighted
sum with default weights summing 1.1 emitted scores up to ~1.04; plugin wire contract
(memory-plugin#8) caps score at 1 → plugin Zod rejected responses → recall broken for
best-matching memories.

Fix (built in isolated worktree by sonnet builder, inspector verdict PASS):
- fuseScores() normalizes by sum of active weights (order-preserving), zero-sum guard.
- tests/search/fuse.test.ts updated + perfect-storm regression (score ≤ 1).

Review MEDIUM finding, fixed inline at merge:
- freshness = exp(-ageDays/decay) exceeds 1 when created_at is in the future (real path:
  SaaS sync puller stores remote-minted timestamps; clock skew → negative age). Clamped
  freshness to ≤1 at source + defense-in-depth Math.min(1, ·) on fuseScores return.
- Two regression tests added: future-created_at via fuseHits ≤ 1; out-of-contract
  freshness input hard-capped.

Evidence: eval gate floors + zeta=0 snapshot hold; full suite 114 files / 1130 pass;
smoke 7/7; plugin roundtrip (SLICE-SMOKE-2 AC-6) re-run PASS against fixed build.
SLICE-SMOKE-2 now 8/8 ACs.

Also this run: vitest.config.ts added — excludes **/.claude/** because nested agent
worktrees (.claude/worktrees/<name>/) carry full repo copies and vitest double-discovered
their tests (duplicate suites + spawned-daemon port collisions). Full-suite discovery
verified at 114 files post-exclusion.

Incident note: concurrent FEAT-410 wave committed this session's in-progress WIP onto its
branches (6703586, bceb0d7) and its branch ops reverted mock-providers.ts + package.json
in the shared main tree; both recovered from stash commit dbb2899, diff-verified, restored.
Operator guidance: don't run interactive slice builds and the wave loop on the same
checkout.

---

## Final gate results + synthesis (2026-07-04)

- SLICE-SMOKE-1 review (inspector, sonnet replacement after first reviewer stalled): **PASS**.
  AC-1..AC-9 all PASS with evidence (smoke 7/7 twice back-to-back ~9-10s, plugin-flow 2/2,
  full suite 114 files green, build clean). AC-9 verified by code-path trace: env token
  short-circuits keystore; encryption:false leaf-override confirmed via loader deep-merge;
  LOCALAPPDATA override load-bearing (migrateLegacyDirsIfPresent). mock-providers additive
  guardrails confirmed byte-identical original branch. Non-blocking note: HOME override
  inert on Windows (harmless; load-bearing on macOS/Linux).
- Fuse fix review (inspector): **PASS** + MEDIUM freshness clock-skew finding — fixed at
  merge (see section above).
- SLICE-SMOKE-2: 8/8 ACs PASS (envelope-assembly units + gated roundtrip).

### Recommended commit structure (pending operator approval — no commits made)
1. astramemory-local: `test(smoke): SLICE-SMOKE-1 daemon E2E smoke suite` — tests/smoke/**,
   plugin-flow refactor, mock-providers additive table, package.json, vitest.config.ts
2. astramemory-local: `fix(search): normalize fused score into [0,1] wire contract` —
   fuse.ts + fuse.test.ts (own review trail: inspector PASS + MEDIUM fixed)
3. astramemory-plugin: `test(smoke): SLICE-SMOKE-2 envelope-assembly units + gated daemon roundtrip`

### Open follow-ups
- FEAT candidates: encrypted-DB restart path untested at smoke tier (F1 tradeoff);
  8 implementation gaps from Phase 1 (parseQuery dead code, restore() unreachable,
  MCP as_of/entity params, why/digest dedup, etc.)
- Ops: wave dispatcher vs interactive-build shared-tree hazard (incident above)
- dev-team: crew plugin 0.48.0 staged (test-automator v2.0.0 promotion) — release blocked
  behind gepa-core 0.6.0 note in [Unreleased]
- Cleanup: fusefix agent worktree (.claude/worktrees/agent-*) can be removed — content merged

---

## Post-delivery architecture review (2026-07-04, sonnet replacement after first stalled)

VERDICT: sound-with-recommendations. Findings:

1. [MEDIUM] Mock keyword table <-> fixture lockstep is a drift trap — nothing but manual
   review enforces it. Recommend shared constants module imported by both mock provider
   and fixture so drift becomes a type error.
2. [MEDIUM] No response-side score validation at the daemon's HTTP serialization boundary —
   [0,1] invariant lives only inside fuseScores' math + plugin's client-side Zod. Add cheap
   clamp/assert where search hits serialize (recommend before next search-path change).
3. [HIGH] Cross-repo roundtrip test not wired into CI — the bug it caught was found by a
   manual run; next regression passes hermetic CI silently. Wire a checkout-both-repos CI
   job, or publish a golden contract-fixture per daemon release into the plugin repo.
   Complementary to (not replaced by) contracts/ schema conformance, which cannot catch
   numeric-range bugs.
4. [MEDIUM-HIGH] .claude/worktrees/ nested inside the tracked tree is the wrong layout —
   vitest exclusion is a correct patch for the symptom. Migrate agent/wave worktrees to
   sibling dirs (git worktree add ../name); removes exclusion-list whack-a-mole and makes
   concurrent-branch ops physically isolated. Root cause of this session's shared-tree
   incident.

Debt ranking (FEAT-now first): (1) wave-vs-interactive shared-tree hazard [fired once
already]; (2) encrypted-restart-path untested [silent data-inaccessibility class];
(3) restore() unreachable [half-implemented feature, one route closes it]; (4) why/digest
route-vs-MCP duplication [trust-critical, no test forces agreement]; (5) MCP as_of/entity
parity; (6) parseQuery dead code + its dead test; (7) HOME-override Windows note [no action].
