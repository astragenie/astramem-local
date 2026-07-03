# ADR-011: Multi-Device Conflict Policy — event-log merge, not field-level LWW

**Status:** accepted · **Date:** 2026-07-03 · **Confidence:** High on the merge rule; Medium on
wall-clock tie-break robustness under severe clock skew (flagged as accepted risk below)
**Context:** ADR-003 shipped sync as one-way, append-only log shipping (local → cloud) and
explicitly deferred "bidirectional sync, cross-device pull, CRDT merge" to a later ADR. FEAT-407
(sync bidirectional pull) now needs that later ADR: once a device can *pull* events it did not
originate, the same atom can be edited on two devices before either has seen the other's change.
This ADR is the design-first prerequisite FEAT-407 is hard-blocked on (`depends_on: [FEAT-408]`).

Ground truth this ADR builds on (not invented for this document):

- `memory_events` (ADR-002, `src/storage/memory-events.ts`) is already an append-only,
  per-`atom_id` event log — `create | invalidate | supersede | promote_scope | erase_request |
  usefulness` — and the materialized `memories` row is a **projection** of that log, updated in
  the same transaction as the event append. The log is already the source of truth; the row is
  already derived state.
- ADR-003's conflict paragraph already sketches the answer for the *cloud ledger* side of push:
  "conflicts are impossible by construction in v1 — events are immutable facts about local
  history; the cloud ledger merges by hash-dedup + supersession semantics (two devices
  superseding the same atom → both supersessions recorded; ledger view resolves by latest
  `valid_to` with full audit trail — nothing is lost, nothing is merged destructively)." This ADR
  generalizes that same posture to the *local* side of pull, and makes the deterministic rule
  precise enough for FEAT-407 to implement.
- `erase()` already documents a non-negotiable precedent: "Erasure always wins over
  retention/replay — the text is unrecoverable locally after this call" (ADR-006: "erasure
  always wins over retention/replay").
- Atoms are not field-editable in place. The only way to "change" an atom today is `supersede`
  (replace with a new atom) or `invalidate` (mark invalid, no replacement). There is no existing
  code path that mutates `text`/`importance`/`entities` on a live row. This matters: it rules out
  needing a general per-field CRDT (OR-Map / LWW-register-per-field) — the conflict surface is
  narrow and enumerable (6 event types), not open-ended.

## Decision

**Chosen policy: event-log merge — pull unions the remote event set into the local append-only
log (deduped by a new globally-unique `event_id`), and the materialized `memories` projection for
any touched `atom_id` is recomputed by a deterministic, order-independent reduce function over
the full (local ∪ remote) event set for that atom. Nothing is ever discarded from the log; only
the single-row *projection* picks a deterministic winner when two devices produced conflicting
terminal states for the same atom.**

This is CRDT-*shaped* in the narrow, textbook sense that matters here — the event log is a
grow-only set (G-Set) that forms a join-semilattice under set union (union is commutative,
associative, idempotent), and the projection is a pure function of that set — but it is not a
general-purpose CRDT framework (no vector clocks, no per-field registers, no tombstone-GC engine).
It is scoped to the 6 event types this repo already has.

## Options considered

1. **Last-writer-wins (LWW) on the atom's mutable projection (rejected).** Compare a timestamp
   (or hybrid logical clock) on the two competing events; the later one overwrites the
   `memories` row outright; the loser is not applied.
   **Why rejected:** it silently discards the loser's semantic effect rather than just its
   projection-priority — it means the *event itself* (not just the "current view") is treated as
   if it never happened, which directly contradicts ADR-002's "nothing is lost" framing and
   ADR-006's audit-log product promise ("the product that *is* an audit record must itself be
   exemplary here"). Pure LWW also has a known failure mode this repo cannot tolerate quietly:
   under clock skew, a device with a fast clock can permanently bury a real edit from a device
   with a correct clock, with no record that a conflict ever happened.
2. **General-purpose multi-writer CRDT (per-field LWW-registers / OR-Map with vector clocks,
   rejected).** Model every atom as a CRDT document with independently-mergeable fields, add
   vector clocks for causal ordering, add tombstone garbage collection.
   **Why rejected:** there is no field-level concurrent-edit path in this codebase to justify it
   — atoms are immutable-and-superseded, not live co-edited documents. Building general CRDT
   machinery (vector clocks per device, per-field merge functions, GC) is multi-week effort
   against the solo/small-team maintainability constraint (ADR-002's C1) for a conflict shape
   (field-level concurrent edit) that does not exist in the product today. If it's ever needed,
   it is a new ADR built on top of this one (see "Non-goals," below) — not a reason to over-build
   now.
3. **Event-log merge: append-only union + deterministic reduce over immutable events (chosen).**
   Reuses infrastructure that already exists (the event log IS the merge substrate — ADR-002),
   requires no new conflict machinery beyond a global `event_id` and a canonical sort key, keeps
   every event ever observed by any device (full audit trail, consistent with ADR-006), and
   yields one deterministic current-state winner per atom without needing vector clocks — because
   the six event types have narrow, enumerable, closed-form merge rules (below), not open-ended
   field arithmetic.

## Conflict classes and deterministic outcomes

Terminology mapping (this repo has no `edit` event type — "edit" below means "a lifecycle
mutation," i.e. `invalidate` or `supersede`, the only two ways an atom's live state changes):

- **Concurrent-edit** — the *same* mutation type is applied twice, concurrently, to the same
  `atom_id` (supersede-vs-supersede, or invalidate-vs-invalidate) by two devices that had not yet
  seen each other's event.
- **Edit-vs-supersede** — *different* mutation types conflict: `invalidate` on one device,
  `supersede` on the other, concurrently, on the same `atom_id`.
- **Edit-vs-erase** — an `invalidate` or `supersede` on one device races an `erase_request` on
  the other, concurrently, on the same `atom_id`.

All three rules below are **set-wise** (computed over the full deduped event set for the
`atom_id`, independent of arrival order) — this is what makes convergence hold (see next
section). The canonical tie-break key is `(created_at, event_id)` — `created_at` first
(wall-clock, best-effort causal signal), `event_id` (a new globally-unique UUID assigned once at
append time, immutable) as the deterministic tie-breaker when timestamps collide or clocks skew.
`event_id` is chosen over `device_id` as the tie-breaker specifically so no device is structurally
favored.

**A. Concurrent-edit**

- *supersede vs supersede* (a fork: two different new atoms, `Y1` and `Y2`, both claim to replace
  the same `X`): both `supersede` events, and both new atoms `Y1`/`Y2`, are kept — nothing is
  deleted. The projection picks exactly one canonical successor by `max(created_at, event_id)`
  across the two supersede events — say `Y2` wins. `X.superseded_by` is set to the winner (`Y2`).
  The loser (`Y1`) is not left as a second, competing "current" atom (that would break the
  single-live-successor invariant `memories.superseded_by` already assumes, and would surface two
  answers to recall for what should read as one edit history) — instead a **synthetic `supersede`
  event** is appended locally: `{event_type: 'supersede', atom_id: Y1, payload: {superseded_by:
  Y2, reason: 'conflict_merge'}}`, chaining `Y1 -> Y2` using the exact same event type and
  materialization path `memory-events.ts` already has for ordinary supersession. Every device that
  observes the same two original supersede events derives the same winner and appends the same
  synthetic event (same payload, same deterministic ordering), so the log converges even though
  it now has one more event than either device shipped individually.
- *invalidate vs invalidate* (two devices independently invalidate `X`, e.g. for different
  reasons): idempotent by construction — outcome is `valid_to = min(created_at)` across the two
  events (first-invalidated-wins, order-independent), both `reason` payloads are retained in the
  log for audit, only the numeric `valid_to` on the projection is a single deterministic value.

**B. Edit-vs-supersede** (`invalidate` vs `supersede`, same `atom_id`, concurrent)

- **`supersede` always wins the projection**, regardless of which event has the earlier
  `created_at`. Rationale: `supersede` is strictly more informative than `invalidate` — it is
  "invalidate, and here is the replacement" — so preferring it never discards information a
  device intentionally captured; a device that had a replacement in hand clearly intended
  replacement, not a wall-clock race. This is a deliberate departure from timestamp-LWW: it is a
  **type-priority** rule, not a time-priority rule, and it is exactly as deterministic (every
  device sees the same two event types and applies the same priority). The `invalidate` event
  remains in the log for audit; it does not alter `superseded_by`/`valid_to` on the projection.
  This rule composes with class A: if a fork (two supersedes) *and* a concurrent invalidate all
  land on the same atom, resolve the fork first (A), then apply supersede-beats-invalidate (B) —
  the two rules operate on disjoint event-type pairs, so the composition order does not matter.

**C. Edit-vs-erase** (`invalidate` or `supersede` vs `erase_request`, same `atom_id`, concurrent)

- **`erase_request` always wins, unconditionally**, regardless of `created_at` ordering. This is
  not a new rule invented for multi-device sync — it is the existing, already-shipped single-device
  rule (`memory-events.ts` `erase()` docstring: "Erasure always wins over retention/replay — the
  text is unrecoverable locally after this call"; ADR-006's erasure ruling) extended unchanged to
  the concurrent case. Outcome: the `memories` row for `X` is hard-deleted (if not already), its
  FTS/vector index rows are removed, the `erase_request` tombstone (content-hash-keyed) is
  retained. The concurrent `invalidate`/`supersede` event is retained in the log for audit but its
  side effect is not applied to a row that no longer exists. If the concurrent event was a
  `supersede` naming a replacement `Y`, `Y` is not deleted (erasure only ever targets the erased
  `atom_id`, never atoms it happens to reference) — `Y` simply stands alone with no predecessor
  pointer, which mirrors `erase()`'s existing single-atom-scoped semantics exactly.

## Convergence property

**Claim (AC-3):** given the same event set, applied on any device, in any receive order, the
final materialized state for every touched atom is identical.

**Justification:**

1. **Idempotent union.** Pull ingest dedups by `event_id` (a new globally-unique field — see
   "Implications for FEAT-407" below). Re-receiving the same event any number of times, in any
   order, leaves the deduped set unchanged. This is the G-Set half of the CRDT argument: set union
   is commutative, associative, and idempotent, so the *set* of events for an `atom_id` converges
   regardless of transport order.
2. **Deterministic total order.** The tie-break key `(created_at, event_id)` is computed
   identically on every device from immutable, verbatim-shipped fields — no device recomputes or
   reinterprets it, so every device sorts the same set into the same order.
3. **Set-wise (not fold-order-dependent) rules.** Each conflict rule above is defined as a
   function of the *whole* deduped set (`max` by key for class A's fork tie-break, `min` for
   invalidate-vs-invalidate, type-membership check for class B, existence check for class C) —
   never as "apply events one at a time in receive order and let the last write physically
   overwrite." A set-wise reduction over an idempotently-unioned set is, by construction,
   invariant to the permutation (receive order) of that set. This is the standard CRDT
   convergence proof shape (merge = join over a semilattice; commutative + associative + idempotent
   ⇒ convergence to the same value regardless of merge order) applied narrowly to this repo's 6
   known event types instead of a generic per-field register.
4. **Accepted risk, stated not hidden:** `created_at` is wall-clock, not a vector/logical clock,
   so under severe clock skew the tie-break in class A can pick a "wrong" (non-causally-latest)
   winner. The outcome is still **deterministic and identical across devices** (every device makes
   the same wrong-but-consistent choice, and nothing is lost — the loser is still in the log,
   still retrievable, just not the head of the chain) — it is a quality-of-tie-break risk, not a
   convergence risk. This mirrors the posture ADR-002 already took on its own open risk (cipher
   driver spike): named explicitly, not silently assumed away. Revisit with a Lamport/HLC clock
   if skew-driven mis-ordering shows up in practice; not required for v1 correctness.

## Implications for FEAT-407 (merge slice shape)

This ADR is written so the FEAT-407 merge slice is mechanically derivable from it:

1. **Schema delta (must land with or before the 407 merge slice):** add `event_id TEXT` (a
   globally-unique UUID, generated at append time) to `memory_events`, backfilled on existing rows
   with synthetic UUIDs (same backfill pattern ADR-002's migration 007 already used for synthetic
   `create` events). `event_id` becomes the per-event identity on the wire — today's
   `WireSyncEvent` (`src/sync/shipper.ts`) has no such field; add it as an additive field (legal
   under ADR-001's "additive fields minor-version" evolution rule — no `astramem-sync@1` version
   bump needed).
2. **Pull ingest = dedup-insert by `event_id`.** This is a direct, mechanical implementation of
   FEAT-407 AC-2 ("same event batch replayed... no memory is duplicated, idempotent, keyed by
   event id") — the "event id" AC-2 already names is exactly the `event_id` this ADR requires.
   `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM memory_events WHERE event_id = ?)` per pulled row.
3. **Projection recompute is scoped, not global.** Only `atom_id`s that received a *new* remote
   event during a pull round need their projection recomputed by the class A/B/C reduce function
   over their full local event set. Atoms with no incoming remote event keep the existing
   single-device fast path (`memory-events.ts`'s current `invalidate`/`supersede`/`erase` methods,
   unchanged) — a fork is structurally impossible with events from only one device, so the reduce
   function only needs to run where pull actually introduced new information.
4. **Synthetic conflict-resolution events are real, shippable events.** When class A's fork
   tie-break produces a synthetic `supersede` (the `Y1 -> Y2` chaining event), it is appended to
   the local log like any other event, tagged `reason: 'conflict_merge'` for auditability, and is
   picked up by the existing `listUnsynced`/`shipOnce` push path (`src/sync/shipper.ts`) on the
   next round — so the cloud ledger and every other device converge on the same resolution without
   any new push-side code.
5. **Non-goal, explicitly carried forward:** this ADR does not design field-level concurrent
   editing (two devices independently changing `importance`/`entities` on a *live* atom). No such
   mutation path exists in the codebase today (Option 2, rejected). If one is added later, it
   needs its own ADR built on top of this one — FEAT-407 should not invent field-merge semantics
   as a side effect of implementing pull.

**Net effect on FEAT-407's `depends_on: [FEAT-408]`:** clears. The merge slice is: (a) one
migration (`event_id` column + backfill), (b) one additive wire field, (c) a dedup-by-`event_id`
ingest path, (d) a scoped projection-recompute function implementing rules A/B/C above, (e) no
new push-side code (synthetic events ride the existing shipper). FEAT-407's own ACs (idempotent
replay, watermark persistence, conflict resolution "follows FEAT-408's chosen policy
deterministically") are all satisfied by this shape.

## Consequences & migration

- New migration: `memory_events.event_id` (UUID, unique index), backfilled for existing rows.
  Existing single-device code paths in `memory-events.ts` are unaffected — `event_id` is additive
  and does not change today's local-only write paths' behavior or performance.
- `WireSyncEvent`/`SyncEnvelope` (`src/sync/shipper.ts`) gain `event_id`; cloud sync-ingest
  (ADR-003) should also persist and dedup on it going forward, keeping the cloud ledger and every
  local device on the same merge substrate.
- FEAT-407 implements: pull transport + watermark (its own scope, out of this ADR), dedup-by-
  `event_id` ingest, scoped projection recompute (class A/B/C), and reuses the existing shipper
  unchanged for re-propagating synthetic conflict-resolution events.
- Rejected-alternative debt: if a future product surface needs true field-level concurrent
  editing of a live atom, it requires a new ADR extending this one (Option 2's rejected CRDT
  machinery becomes relevant then, not now).
