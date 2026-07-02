# Target Architecture — astramem-local + AstraMem Cloud

**Date:** 2026-07-02 · **Status:** accepted (derived from ADR-001..010)
**Framing:** this is the architecture both products *converge toward* through the migration map
(`migration-map.md`) — not a rewrite target. Every component traces to an ADR ruling; anything
that doesn't is deliberately absent.

---

## 1. System overview

```
┌─ TOOL SURFACES ──────────────────────────────────────────────────────────┐
│  Claude Code        runner-plugin       Codex CLI / Cursor   Claude API  │
│  (plugin/hooks)     (events adapter)    (future adapters)    agents      │
│       │transcript        │events              │transcript        │       │
│       └───────┬──────────┴───────────┬────────┘                  │       │
│               ▼  astramem-capture@1 (ADR-008)                    ▼       │
│                                                     memory-tool adapter  │
│                                                     (ADR-007 #2)         │
└───────────────┬──────────────────────────────────────────┬───────────────┘
                ▼                                          ▼
┌─ ASTRAMEM-LOCAL DAEMON (127.0.0.1:7777) ─────────────────────────────────┐
│  ┌ Capture ────────────┐   ┌ Surfaces ──────────────────────────────┐   │
│  │ ingest API           │   │ MCP tools · CLI · minimal REST         │   │
│  │ STAGE 0: redaction   │   │ injection policy (when-to-recall)      │   │
│  └────────┬─────────────┘   └────────────▲───────────────────────────┘   │
│           ▼                              │                               │
│  ┌ Formation pipeline (ADR-004) ─┐  ┌ Retrieval (ADR-005) ───────────┐  │
│  │ 1 clean … 8 embed+index       │  │ fusion + ScoreExplanation       │  │
│  │ 9 consolidation (offline job) │  │ FTS fallback · latency <150ms   │  │
│  └────────┬──────────────────────┘  └────────────▲────────────────────┘  │
│           ▼                                      │                       │
│  ┌ Store (ADR-002) ────────────────────────────────────────────────────┐ │
│  │ ONE encrypted SQLite file: atoms(v3 bitemporal+scope) · FTS5 ·      │ │
│  │ sqlite-vec · transcripts(redacted) · memory_events (append-only     │ │
│  │ log: create/invalidate/supersede/promote/erase/usefulness)          │ │
│  │ keystore: OS credential store (SEC-2)                               │ │
│  └────────┬────────────────────────────────────────────────────────────┘ │
│           ▼ team/org-scoped events only (ADR-009)                        │
│  ┌ Sync shipper (ADR-003) ─ cursor, batch, gzip, retry, idempotent ──┐   │
└──┴────────┬──────────────────────────────────────────────────────────┴───┘
            ▼  astramem-sync@1 (one-way)
┌─ ASTRAMEM CLOUD (Azure ACA · .NET · Postgres/pgvector) ──────────────────┐
│  DATA PLANE (ADR-006):  sync-ingest → dedup → bitemporal ledger (RLS)    │
│                         workspace recall API · rerank sidecar (ON)       │
│  CONTROL PLANE:         workspaces/orgs · device tokens · retention &    │
│                         erasure jobs · audit log · usage metering        │
│  (deliberately absent: generic memory API, marketplace, SSO-v1,          │
│   write-back sync)                                                       │
└──────────────────────────────────────────────────────────────────────────┘

CONTRACTS PACKAGE (the technical constitution, ADR-001/005):
  astramem/atom@1 JSON Schema · retrieval envelope + ScoreExplanation ·
  capture@1 + sync@1 envelopes · golden eval fixtures — CI-gated in BOTH repos
```

## 2. Trust & failure boundaries

**Trust boundaries (ADR-009):**
- T1 — machine boundary: personal-scoped atoms never cross it. Enforced in the sync shipper
  (scope filter), not by policy documents.
- T2 — daemon loopback: bearer/device tokens in OS credential store; loopback-only bind.
- T3 — cloud tenancy: Postgres RLS primary; workspace tokens; field-level encryption of `text`.
- T4 — LLM egress: stage-0 redaction runs before *any* provider call; Ollama path = zero egress.

**Failure boundaries (C4 graceful degradation — each failure leaves a working product):**
- Embedder down → FTS-only retrieval (exists).
- Cloud unreachable → log accumulates, ships later; zero local feature loss (ADR-003).
- Rerank sidecar down → identity ordering (exists, cloud).
- Pipeline LLM stage down/over-budget → transcripts persist redacted; distillation resumes later
  (jobs table).
- Cipher driver unavailable on a platform → app-level column encryption fallback (ADR-002).

## 3. Module map — astramem-local

| Module | Purpose | Public surface | Key ADR |
|---|---|---|---|
| `capture` | ingest API, stage-0 redaction, transcript persist | `POST /ingest/transcript` (capture@1) | 008, SEC-3..5 |
| `redact` | detectors (pattern+entropy), placeholders, counts log | internal; fixtures in CI | SEC spec |
| `pipeline` | stages 1–9, typed contracts, replay | internal; `jobs` scheduling | 004 |
| `store` | SQLite + event log + migrations + keystore + backup | internal | 002 |
| `search` | fusion, ScoreExplanation, FTS fallback | `/search`, `/recall`, MCP | 005 |
| `policy` | when-to-recall injection layer | MCP/adapter-side | 005, 010 |
| `sync` | shipper: cursor, batching, retry | `sync` CLI, daemon worker | 003 |
| `surfaces` | MCP server, CLI, minimal REST | 4+3 MCP tools, CLI cmds | 007 |
| `feedback` | usefulness event capture + metrics | `doctor`, `/health` | 010 |
| `service` | cross-OS install/run (systemd/launchd/schtasks) | `service` CLI | existing |

## 4. Module map — cloud

| Module | Purpose | Key ADR |
|---|---|---|
| `SyncIngest` | `POST /sync/events`, hash dedup, event→ledger materialization | 003 |
| `Ledger` | bitemporal atoms (FEAT-214 aligned to atom@1), RLS | 001, 006 |
| `Recall` | workspace-scoped search (6-signal + rerank ON) | 005 |
| `ControlPlane` | workspaces, orgs, device tokens, retention policies | 006 |
| `Erasure` | erase-request jobs: hard-delete + tombstone + backup-window SLA | 006 |
| `Audit` | access + admin audit log | 006 |
| Existing dashboard | workspace browsing (reuse; no new investment beyond recall views) | verdict |

## 5. The six journeys (sequence sketches)

1. **Cold install →** `bunx astramem-local init` → keystore key created → encrypted DB created →
   service installed → MCP registered. Zero config; Ollama optional prompt.
2. **Capture →** tool adapter POSTs transcript → stage 0 redacts → persist → stages 1–8 distill →
   atoms indexed. Budget-capped; offline-safe.
3. **Recall →** agent calls MCP search → policy layer decides injection → fusion + explanation →
   `recall_served` logged → adapter detects/reports use → `recall_used` logged.
4. **Sync →** shipper batches unsynced team/org events → `POST /sync/events` → ack cursor →
   ledger materializes → teammates' recall sees it (cloud recall API).
5. **Erase →** user/admin erase request → local hard-delete + tombstone → event ships → cloud
   hard-delete + tombstone → complete at backup rollover (≤30d SLA).
6. **Upgrade →** migrations run on daemon start (004: events backfill; 005: atom v3) →
   re-distillation offered when extractor majors change (replay from redacted transcripts).

## 6. Performance targets

| Surface | Target |
|---|---|
| Local recall p95 (warm) | < 150 ms |
| Local ingest ack (pre-pipeline) | < 50 ms |
| Cloud recall p95 | < 450 ms (existing DEC-012) |
| Sync batch (1k events) | < 5 s end-to-end |
| Scale envelope | 1M+ atoms / 100k+ transcripts per machine without architecture change (SQLite + proper indexes; compaction keeps working set bounded) |
