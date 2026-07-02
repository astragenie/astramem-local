# ADR-002: Local Storage Engine — SQLite + embedded append-only event log

**Status:** accepted · **Date:** 2026-07-02 · **Confidence:** High (Medium on cipher driver — open spike)
**Context:** v0.3.3 ships a single-file SQLite store (memories, memories_fts FTS5, memories_vec
sqlite-vec, transcripts, jobs). SEC-1..10 (merged spec) mandates encryption at rest. ADR-003 needs
a sync substrate. Constraint C1: maintainable by 1–3 people + agents.

## Decision

**Keep single-file SQLite as the one artifact that is the user's data** (the SQLite design
reference, constraint C5), with two additions:

1. **`memory_events` append-only table** — the source of truth for state *changes*:
   `create | invalidate | supersede | promote_scope | erase_request | usefulness` events, each
   `{seq, event_type, atom_id, payload_json, content_hash, created_at, synced_at|null}`.
   Materialized state (the `memories` table) is updated in the same transaction as the event
   append. This is **log + tables in one file**, not full event sourcing: no view rebuilding, no
   projection framework — the log exists so ADR-003 sync becomes log-shipping and audit becomes
   free.
2. **Encryption per SEC-1/2**: `better-sqlite3-multiple-ciphers` (SQLCipher-compatible), key in OS
   credential store with 0600 key-file fallback. **Open spike (risk register #1):** cipher driver ×
   sqlite-vec extension-load compatibility on all three OSes. **Fallback ruling if spike fails:**
   application-level encryption of `text`/`evidence`/`transcripts` columns + OS file permissions —
   weaker but ships; revisit driver quarterly.

FTS5 + sqlite-vec stay as the index layer inside the same file (encrypted for free when the
driver works). Time-travel is served by the bitemporal columns (ADR-001), **not** log replay.
GC/compaction: a periodic job prunes superseded atoms past retention policy and vacuums;
transcripts retained (redacted, ADR-004) to preserve re-distillation ability.

## Options considered

1. **SQLite + embedded event log (chosen).** One file, one backup story, transactional
   consistency between log and state, zero new infrastructure.
2. **Full event-sourcing with rebuilt projections.** Rejected for v1: projection/replay framework
   is real complexity against C1 with no user-visible benefit today. The embedded log preserves
   the option (events are complete) if replay is ever needed.
3. **Switch store (LanceDB / DuckDB / redb).** Rejected: churn with no user-facing win; sqlite-vec
   + FTS5 already meet scale targets (ADR-005 latency budgets; millions of atoms is comfortable
   SQLite territory with proper indexes); SQLite's reliability record is the point.

## Consequences & migration

- Migration 007: add `memory_events`, backfill `create` events for existing atoms (synthetic,
  hash-stable) so first sync has a complete log. (Was drafted as 004; renumbered — 004 =
  provenance/evidence, 005 = security/redaction_log, 006 = Atom v3 bitemporal/scope/lineage
  (ADR-001). Migration ledger:
  `docs/superpowers/specs/2026-07-02-wave1-2-amendments-killer-features-design.md`.)
- Backup (existing online-safe backup) now captures state + log atomically — recovery story
  unchanged.
- Disk growth bounded by compaction policy + transcript retention setting (default 90d,
  configurable; erase requests always honored regardless of retention — ADR-006/009).
