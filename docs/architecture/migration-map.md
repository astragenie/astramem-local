# Migration Map — v0.3.3 → Target Architecture

**Date:** 2026-07-02 · **Rule:** every step is independently shippable; no step blocks the
90-day launch plan (constraint C3). Items marked **[90d]** are the committed 90-day plan;
architecture work is interleaved, never instead.

---

## Wave 1 — Trust floor (weeks 1–4) → release v0.4.0

| # | Item | ADR/Spec | Notes |
|---|---|---|---|
| 1a | **SPIKE: cipher driver × sqlite-vec** (3 OSes) | ADR-002, R1 | FIRST. Outcome decides 1b path |
| 1b | Encryption at rest + keystore **[90d #1]** | SEC-1/2/7/8 | Auto-migration of plaintext DBs |
| 1c | Stage-0 secret redaction **[90d #1]** | SEC-3..6, ADR-004 | Ingest choke point; fixtures in CI |
| 1d | Token → OS credential store | SEC-10 | Rides 1b keystore work |
| 1e | Fix D-DEF1 / D-DEF2; un-stub `queue/rebuild/providers` **[90d #2]** | ADR-004 | Quality floor |

## Wave 2 — Contract + flywheel (weeks 3–8, overlaps) → v0.5.0 + LAUNCH

| # | Item | ADR | Notes |
|---|---|---|---|
| 2a | Atom v3 migration: bitemporal + scope + derived_from | ADR-001 | `scope=personal` default |
| 2b | `memory_events` log + backfill; invalidate/supersede/promote ops | ADR-002 | Audit + sync substrate |
| 2c | MCP tools: `invalidate_memory`, `promote_memory`, `memory_history` | ADR-007 | Exposes 2a/2b |
| 2d | runner-plugin `events` adapter (slices/grades/lessons in) **[90d #3]** | ADR-008 | Starts the graded-exhaust flywheel |
| 2e | Usefulness events + `recall-usefulness` metric **[90d #4]** | ADR-010 | Explicit signal first (W2) |
| 2f | **PUBLIC LAUNCH** (marketplace + post; open-core split: capture/redact source-visible) **[90d #5]** | strategy P6-A1 | Security README gated on 1a outcome |

## Wave 3 — The ledger (weeks 8–16) → first paid surface

| # | Item | ADR | Notes |
|---|---|---|---|
| 3a | Contracts package: atom@1 + retrieval envelope + eval fixtures; CI gates in BOTH repos | ADR-001/005 | The technical constitution |
| 3b | Cloud: RLS migration (primary isolation) | ADR-006 | Before any external workspace |
| 3c | Cloud: `POST /sync/events` + dedup + ledger materialization | ADR-003 | Maps onto FEAT-214 writes |
| 3d | Local: sync shipper (cursor/batch/retry, scope filter) | ADR-003/009 | The log is the queue |
| 3e | Team workspace (device tokens, simple membership, workspace recall) | ADR-006 | Startup-tier: NO SSO |
| 3f | Erasure v1: erase-request → hard-delete + tombstone both sides; replay filter | ADR-006, W5 | Design-complete before team data accumulates |
| 3g | Cloud rerank ON (staged) + publish NDCG delta | ADR-005 | Stop shipping the seam stub-off |
| 3h | TEI embedder off the shared CI box | ADR-006, R6 | Before first pilot |

## Wave 4 — Moat mechanics (months 4–6, traction-gated)

| # | Item | ADR | Gate |
|---|---|---|---|
| 4a | Anthropic memory-tool backend adapter (small pkg) | ADR-007 | Post-launch; high leverage |
| 4b | Consolidation stage 9 (merge-as-supersede + propose-only contradictions) | ADR-004, W4 | After eval harness exists |
| 4c | Second tool adapter (Codex CLI or Cursor) | ADR-008 | Neutrality demo for seed |
| 4d | Injection-policy v1 (heuristic when-to-recall) | ADR-005 | Instrument via 2e |
| 4e | Usefulness → ranking signal | ADR-010 | Only after 3a harness gates regressions |

## Deferred with explicit triggers

| Item | Trigger |
|---|---|
| Crypto-shredding (per-subject keys) | First regulated-vertical deal (ADR-006) |
| Team recall (read-only cloud federation from local) | Paying team workspaces ask for it (ADR-003 v2) |
| Local reranker / matryoshka dims | Eval harness shows local quality gap that matters (ADR-005) |
| SSO/SAML + SCIM, audit UX, retention admin | Enterprise wave (strategy Pass 4 T0/T1), post-traction |
| Procedural atom type + mining | ≥3 months of graded exhaust accumulated (ADR-010) |
| Qdrant backend, marketplace, human-memory, air-gapped | REFUSED — strategy refuse-to-build list stands |

## Open questions (carried forward)

1. Cipher spike outcome (1a) — decides encryption depth claims.
2. Which second tool adapter: Codex CLI vs Cursor — decide at 4c by session-export surface quality.
3. Linux headless keystore: file-fallback acceptable long-term? (SEC spec OQ-1)
4. Redaction on `/remember` manual writes — proposed yes (SEC spec OQ-2); confirm in 1c.
5. Multi-device divergent supersession UX (W3/R5) — design with team-recall v2.
