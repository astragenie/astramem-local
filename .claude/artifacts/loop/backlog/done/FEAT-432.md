---
id: FEAT-432
status: done
priority: null
category: platform
target_release: null
created: 2026-07-05
depends_on: []
slices: []
derived_from: null
tags: [concern:storage, concern:retention]
autonomous_safe: null
triage_notes: "Hardening finding from feat/HARD-idempotency-retention: ingest_idempotency has zero retention — no DELETE/prune/TTL exists anywhere on that table today (verified: only ingest.ts INSERT/SELECT/single-key DELETE-on-invalidation, plus storage/ingest-idempotency.ts's summary_memory_id backfill UPDATE — no bulk age-based prune). Every Idempotency-Key-bearing ingest adds a permanent row. Also surfaces a second, adjacent gap: the 'cleanup' job kind (src/pipeline/handlers/cleanup.ts) that would be the natural home for this prune is itself never enqueued anywhere in the codebase — registered on the worker and covered by unit tests, but nothing calls repo.enqueue('cleanup', ...) at boot or on an interval (contrast src/cli/serve.ts:261-274, which self-enqueues 'consolidate' at boot + every 6h after the same gap was found for that handler)."
---

# FEAT-432: retention/TTL for `ingest_idempotency` (+ the dormant `cleanup` job cadence)

## Problem — the idempotency table only ever grows

`ingest_idempotency` (`migrations/002-wire-v1.sql`: `key TEXT PRIMARY KEY,
tenant_id TEXT, body_hash TEXT NOT NULL, summary_memory_id TEXT, created_at
INTEGER NOT NULL`) gets one row per `POST /ingest/transcript` request that
carries an `Idempotency-Key` header (`src/server/routes/ingest.ts`,
`stmtInsertIdempotency` — `INSERT ... ON CONFLICT(key) DO NOTHING`). The only
other writes to the table are:

- a single-key `UPDATE ... SET summary_memory_id` backfill
  (`src/storage/ingest-idempotency.ts`, D-DEF2) once distillation produces a
  real memory id, and
- a single-key `DELETE FROM ingest_idempotency WHERE key = ?`
  (`src/server/routes/ingest.ts`, `stmtDeleteIdempotency`) used only for the
  D-B3 dangling-row invalidation case (the row's `summary_memory_id` no longer
  resolves to a live transcript or memory).

There is **no bulk, age-based prune** anywhere — confirmed by reading
`src/storage/ingest-idempotency.ts` in full and grepping the repo for any
`DELETE FROM ingest_idempotency` beyond the single-key cases above. On a
long-running daemon that ingests continuously (the intended deployment model
per `CLAUDE.md` — service-installed, always-on), this table accumulates one
row per idempotent request forever. It is small per-row, but unbounded growth
on an always-on daemon is exactly the kind of slow-burn storage leak this
hardening pass exists to catch.

### Adjacent finding: the obvious "wire it into periodic cleanup" home is itself dormant

The natural place to prune `ingest_idempotency` is alongside the existing
`cleanup` job kind (`src/pipeline/handlers/cleanup.ts`), which already does
time-based pruning of the `jobs` table (`state = 'completed'` /
`state = 'poison'` rows older than `older_than_days`) and runs the archival
pass (FEAT-404) on the same cadence. **But nothing in the codebase ever
enqueues a `'cleanup'`-kind job** — `registry.register(cleanupHandler)` wires
it into the worker (`src/cli/serve.ts:195`) and `tests/pipeline/handlers/
cleanup.test.ts` exercises it directly, but there is no
`repo.enqueue('cleanup', ...)` anywhere outside those tests (confirmed via
`grep -rn "enqueue(" src`). This mirrors a bug class the codebase has already
hit once and fixed: `src/cli/serve.ts:255-274` documents that the
`consolidate` handler "existed since Wave 4b but nothing ever enqueued it...
until someone called `POST /consolidation/run` by hand," and fixes it with a
boot-pass + `setInterval(enqueueConsolidate, 6h)`, unref'd. `cleanup` is in
the same state today: implemented, tested, registered, but **never
scheduled** — so today, "wire the prune into whatever periodic cleanup path
already runs" has no periodic path to attach to; one must be added (or the
existing dormant `cleanup` job cadence must be turned on) as part of this
FEAT.

## Requested capability

1. **Add an `ingestIdempotency` (or similar) config section** to `Config`
   (`src/config/config.ts`), following the `archival` precedent (FEAT-404,
   same file, lines ~91-107/136): a `retentionDays` value, defaulted (e.g.
   `7`), added to `defaultConfig()`. Because `loadConfigFromDisk`
   (`src/config/loader.ts`, `deepMerge`) recursively merges parsed
   `config.yaml` over `defaultConfig()`, an old on-disk `config.yaml` missing
   this key transparently inherits the default — no migration/back-compat
   shim needed, matching how `archival`/`tagHygiene` were introduced.
2. **Add a bulk, age-based prune** — `DELETE FROM ingest_idempotency WHERE
   created_at < ?` using a cutoff derived from `retentionDays`, mirroring the
   exact shape of the `jobs` prune in `src/pipeline/handlers/cleanup.ts`
   (`cutoffMs = Date.now() - N * 24 * 60 * 60 * 1000`). Natural home: extend
   `cleanupHandler.handle()` to also run this prune on the same pass as the
   `jobs`/archival cleanup (one query, same transaction scope), OR give it its
   own thin prune function in `src/storage/ingest-idempotency.ts` called from
   the cleanup handler — either is fine as long as it rides the existing
   cleanup pass rather than introducing a second timer.
3. **Fix the dormant `cleanup` cadence as a prerequisite** — since nothing
   currently enqueues `'cleanup'`-kind jobs (see Problem above), this FEAT
   cannot ship as "just wire into the existing periodic path" without also
   adding the missing scheduler. Mirror `src/cli/serve.ts:261-274`'s
   `consolidate` fix exactly: a boot-pass `bootRepo.enqueue('cleanup', {
   kind: 'cleanup' })` plus an unref'd `setInterval`, guarded by `dataDir !==
   ':memory:'` like the existing timers. Cadence choice is open to
   triage/architect judgement (daily is likely sufficient given a
   multi-day TTL; does not need to match the 6h `consolidate` interval).

## Correctness tradeoff — replay safety vs. TTL (must document, not just implement)

`ingest_idempotency` exists so a client's retried `POST /ingest/transcript`
(same `Idempotency-Key` + same body) gets a `200` idempotent replay instead of
a duplicate transcript/distill job. **Pruning a row a client later retries
against turns that replay into a fresh double-write** — the whole point of
the table is defeated for any request whose key gets pruned before the
client's last retry. The TTL must sit comfortably above any realistic client
retry window:

- The only known consumer's retry behavior should be checked against the
  chosen default before this ships (astramem-plugin / memory SaaS backend
  ingest client — check its retry/backoff ceiling, e.g. exponential backoff
  bounded to minutes, not days).
- A **7-day default** is proposed as a conservative floor: multiple orders of
  magnitude above any plausible network-retry window (seconds to low minutes)
  and generous enough to also cover "client was offline/crashed and replays
  on next launch" scenarios, which is the realistic long-tail case idempotency
  keys are meant to protect against, not just in-flight HTTP retries.
- This should remain configurable (see #1) precisely because "safe TTL" is a
  judgement call that may need raising for slower/offline-tolerant clients
  without a code change.

## Acceptance criteria (proposed — re-triage as you see fit)

- Given rows in `ingest_idempotency` older than the configured
  `retentionDays` and rows newer than it, When the prune runs, Then only the
  older rows are deleted and the newer rows remain untouched.
- Given a row within the retention window, When the same
  `Idempotency-Key` + body is replayed, Then the request still returns `200`
  with `idempotent: true` and the original `summary_memory_id` (replay
  behavior unchanged within the TTL).
- Given a `config.yaml` written before this FEAT (no `ingestIdempotency` key),
  When the daemon loads config via `loadConfigFromDisk`, Then it runs with the
  default `retentionDays` with no error and no manual migration step.
- Given the daemon is running with a non-`:memory:` data dir, When enough
  time passes for the `cleanup`/prune interval to fire at least once, Then a
  `'cleanup'`-kind job is observably enqueued and processed (queue/worker
  forensics show it), closing the dormant-scheduler gap noted above.

## Refs

- `src/storage/ingest-idempotency.ts` (D-DEF2 backfill — only existing bulk-ish
  write besides plain INSERT).
- `src/server/routes/ingest.ts` (`stmtInsertIdempotency`,
  `stmtDeleteIdempotency`, `stmtSelectIdempotency` — full read/write surface
  of the table today).
- `migrations/002-wire-v1.sql` (table DDL, `created_at INTEGER NOT NULL`).
- `src/pipeline/handlers/cleanup.ts` + `tests/pipeline/handlers/cleanup.test.ts`
  (mirror pattern for age-based prune shape).
- `src/backup/retention.ts` (sibling retention concept — count-based, CLI-
  triggered, not periodic; shows the "keep N / prune rest" idiom used
  elsewhere in the codebase).
- `src/cli/serve.ts:255-274` (the `consolidate` "handler existed but nothing
  enqueued it" precedent — same bug class as the `cleanup` gap found here,
  fixed there with boot-pass + unref'd `setInterval`).
- `src/config/config.ts` (`archival` section, FEAT-404 — precedent for a new,
  defaulted, opt-in-by-default-value config section).
- `src/config/loader.ts` (`deepMerge`, `loadConfigFromDisk` — back-compat
  merge behavior for old `config.yaml` files missing new keys).
