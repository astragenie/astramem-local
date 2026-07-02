# ADR-003: Sync Protocol — one-way append-only log shipping (`astramem-sync@1`)

**Status:** accepted · **Date:** 2026-07-02 · **Confidence:** High for v1 scope; Medium on v2 direction
**Context:** Strategy Pass 1 seam (a): local and cloud have NO sync today; "local-first + cloud"
is currently an either/or. Bidirectional CRDT sync is a known tarpit. The bitemporal model is
already an append-only record of assertions and retractions — the sync design is hiding in the
data model.

## Decision

**v1 sync is one-way, append-only, idempotent log shipping — local → cloud. Cloud never writes
back to local.**

Protocol `astramem-sync@1`:
- **Unit:** batches of `memory_events` (ADR-002) in `seq` order, wrapped in an envelope
  `{ protocol: "astramem-sync@1", device_id, workspace_id, cursor, events[] }`, gzip-compressed,
  over HTTPS to cloud `POST /sync/events`.
- **Cursor:** per-device monotonic `seq`; cloud returns `{ acked_seq }`; local marks
  `synced_at`. Resume = send from last ack. Crash-safe by construction.
- **Idempotency:** `content_hash` per event; cloud dedups on `(workspace_id, content_hash)`.
  Replaying a batch is always safe.
- **Conflict model:** conflicts are impossible by construction in v1 — events are immutable facts
  about local history; the cloud ledger merges by hash-dedup + supersession semantics (two devices
  superseding the same atom → both supersessions recorded; ledger view resolves by latest
  `valid_to` with full audit trail — nothing is lost, nothing is merged destructively).
- **Scope filter:** only `team`/`org`-scoped atoms ship by default (ADR-009). `personal` atoms
  never leave the machine unless the user enables encrypted personal backup (v1.1 option).
- **Offline:** the log *is* the queue. No separate queue infrastructure. Retry with exponential
  backoff; unlimited offline duration.
- **Version negotiation:** capabilities handshake at session start
  (`GET /sync/capabilities` → supported atom/protocol versions); local refuses to ship atoms the
  server can't parse; additive evolution per ADR-001.
- **Auth:** device token (OS credential store) bound to workspace; rotation via CLI.

**Explicitly NOT in v1:** bidirectional sync, cross-device pull, CRDT merge, partial-history
checkout. **v2 direction (not sync):** team recall — local queries the cloud ledger read-only at
search time (a *retrieval* federation concern, ADR-005), which delivers "see the team's memory"
without ever writing cloud state into the local store.

## Options considered

1. **One-way log shipping (chosen).** Weeks not quarters; impossible-by-construction conflict
   story; gives cloud data gravity and the team ledger; preserves local-first purity.
2. **Bidirectional CRDT sync.** Rejected: multi-quarter effort against C1/C3, unclear demand,
   and the read-only team-recall path (v2) delivers most of the user value without merge
   semantics.
3. **Cloud-primary with local cache.** Rejected: inverts the strategy (local-first is
   load-bearing, C4) and re-creates the products we chose not to be.

## Consequences & migration

- Cloud needs one new surface: `POST /sync/events` + dedup + event→ledger materialization
  (maps cleanly onto the existing bitemporal FEAT-214 write paths) + `GET /sync/capabilities`.
- Local needs: shipper worker (reads unsynced events, batches, retries) — small.
- Sequencing (migration map): after SEC-1..10 and atom v3; it is the first *paid-surface*
  milestone (team workspace).
