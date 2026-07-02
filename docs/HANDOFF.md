# Handoff — 2026-07-02 (end of day)

**State: v0.6.0 released and tagged. All engineering work in the migration map is done.**
Suite: 859 tests / 3-OS Bun CI green. SCHEMA_VERSION 8. MCP: 14 tools.
Cloud (astragenie/memory): PR #578 merged — sync ledger + erase materialization live.

## What shipped today (chronologically)

| PR | What | Notes |
|----|------|-------|
| #14–#17 | Waves 1–3 local (trust floor, contract+flywheel, cloud bridge) | released as v0.5.0 mid-day |
| cloud #578 | `POST /sync/events` dedup + ledger materialization + erase | Wave 3 cloud side |
| #18 | 4a memory-tool adapter + 4d injection policy | |
| #19 | ADR-005 eval harness — **CI gate: recall@10 ≥ 0.90 / NDCG@10 ≥ 0.70** (baseline 0.929/0.748, fake embedder = deterministic) | unblocked 4b/4e |
| #20 | 4e usefulness → ranking (ε=0.1 fusion term, Laplace-smoothed, neutral 0.5) | |
| #21 | 4b consolidation stage 9 (migration 008): ≥0.95 cosine auto merge-as-supersede; 0.85–0.95 → propose-only queue | never destructive (W4) |
| #22 | 4c Codex CLI capture connector (`capture codex`) | **decision: Codex now, Cursor postponed** |
| #23 | 3e device pairing (`pair <claim-code> --url <cloud>`) | token → OS keystore, sync.json → serve boot |
| #24 | release v0.6.0 (tag pushed, parity gate green) | |
| #27 | quick wins: config.yaml now LOADS at boot; reembed un-stubbed **and registered** (was never in the worker registry); MCP proposal tools; `capture codex --watch` | |

## Decisions made today (user-confirmed)

- **4c tool adapter = Codex CLI; Cursor postponed** — Codex sessions are open JSONL; Cursor's chat store is a proprietary SQLite blob. Cursor users get MCP recall only (documented in `docs/codex-capture.md`).
- **3h TEI: already done, struck** — cloud defaults to `Embedding:Provider=huggingface-tei` (BGE-large 1024-d) on the user's AWS CI box via `Embedding__Tei__Endpoint` from Terraform platform state. SaaS embeds = TEI; local = Ollama mxbai (both 1024-d, hence local FLOAT[1024] ↔ cloud vector(1024)).
- **All implementation is done INLINE in the main thread** — no subagent dispatch unless the user explicitly asks in the moment.

## Open items (nothing else remains)

1. **3g cloud rerank rollout — DECISION PENDING, expected 2026-07-03.**
   Ticket with full runbook: **astramem-local#26**. Code is 100% built in the cloud repo,
   `Search:CrossEncoder:Enabled=false`. Needs: go/no-go, sidecar placement (⚠️ 300 ms hard
   cap DEC-011/012 — the shared CI box's latency spikes are a real risk here), reranker
   model choice (proposal: BAAI/bge-reranker-v2-m3). When approved: second TEI container →
   dev flip → A/B NDCG delta → prod → **publish the delta** (ADR-005 gate for future fusion signals).
2. **2f launch** — marketplace publish + announcement post. Operator/user task.
3. Deferred (not quick, revisit on pull): `as_of` time-travel in local `search()` (unlocks
   eval q6, bitemporal columns already exist); consolidation v1.x LLM passes (lesson
   abstractions + contradiction detector — proposal queue already reserves `kind='contradiction'`);
   Cursor adapter; sourceHash hashes raw content not flattened text (informational).

## Gotchas for the next session

- **gh CLI**: use the Bash tool (~/.bashrc PATH append); the PowerShell tool runs -NoProfile and misses it.
- **Cloud repo (astragenie/memory)**: `NUGET_AUTH_TOKEN=$(gh auth token)` for restore; any
  schema change needs `bash scripts/db/regen-schema-sql.sh` (drift gate); `MemoryContext`
  is NoTracking-by-default (`.AsTracking()` for read-modify-write); branch must be updated
  before merge (`gh pr update-branch`), auto-merge disabled; **"DI graph smoke test" is
  flaky** (inconclusive-timeout) — `gh run rerun <id> --failed`.
- **Local repo**: bun.lock is the only lockfile (CI `bun install --frozen-lockfile`); native
  deps need `trustedDependencies`; daemon-spawning tests run from `dist/` — **run
  `npm run build` after changing anything serve touches** or integration tests fail with
  stale-code errors (bit us today on the schema-version bump).
- **Eval gate re-baselining**: any deliberate ranking change must re-measure
  `tests/eval/retrieval-eval.test.ts` floors and explain the new baseline in the commit.
- 70 cloud local test failures = Testcontainers without Docker — pre-existing, pass on CI.

## Where things live

- Eval harness: `src/eval/` + `tests/eval/retrieval-eval.test.ts`; corpus `contracts/fixtures/eval/`.
- Consolidation: `src/consolidate/` (+ REST `src/server/routes/consolidation.ts`, MCP tools, `consolidate` job kind).
- Codex capture: `src/capture/codex.ts`, `src/cli/capture.ts`, doc `docs/codex-capture.md`.
- Pairing: `src/cli/pair.ts` + `src/config/sync-settings.ts` (sync.json merged in `serve.ts`).
- Config loading: `src/config/loader.ts` (reads what `writer.ts` emits — keep them in parity, roundtrip test enforces).
- Cloud sync ingest: `src/AstraMemory.Modules.Ingest/Application/SyncIngestService.cs` + `SyncController.cs`.
