# ADR-019: In-Process Worker Starves Request Path (issue #347 — recall/mark_used hang)

**Status:** PROPOSED
**Date:** 2026-07-15
**Driver:** issue #347 — `recall_memory` (`POST /recall`) and `mark_memory_used`
(`POST /memory/:id/used`) hang / time out (observed at the MCP client's 300s cap) while
`agent_profile` (`GET /agents/:agent/profile`) on the same daemon, same session, returns
instantly.

---

## Context

### Symptom (from issue #347, live repro 2026-07-15, daemon 0.19.0-beta)

- `agent_profile` → OK, instant, full data.
- `recall_memory` → **timed out at 300s, twice**, no hits returned.
- `mark_memory_used` → **timed out**, same failure mode.
- Not a dead daemon: `/health` and `agent_profile` both answer on the same session.

### Verified root cause

**The background job worker runs in-process, on the same Node event loop, as the
HTTP/MCP server — and one of its scheduled jobs contains a proven, unbounded, fully
synchronous stretch with zero yield points.**

1. **Worker is in-process, shares the event loop with HTTP/MCP.**
   `startWorker()` runs `resolveWorkerConcurrency(config)` (default 2, `config.ts:959`)
   "independent claim-execute lanes" **in-process** — see the function's own doc comment,
   `src/pipeline/worker.ts:59-99`. `src/cli/serve.ts:246-253` calls `startWorker({ db, ... })`
   in the same `serve` function that builds the Fastify app (`buildApp({ db, ... })`,
   `serve.ts:214`) — **same `db` handle, same process, same thread.**

2. **Request handlers never await the job queue** — they read/write SQLite directly and
   return. `POST /recall` (`src/server/routes/search.ts:211-262`) calls `search()` and
   `recordRecallServed()`, both synchronous-SQLite-backed with one async embed/rerank hop;
   `POST /memory/:id/used` (`src/server/routes/lifecycle.ts:177-183`) is two flat synchronous
   calls: `MemoryRepo.get()` + `recordRecallUsed()`. Neither route has any queue interaction
   to hang on — the hang is not *in* these handlers, it is *upstream* of them (see #3 below).

3. **Confirmed single synchronous stretch, no yield points:** `runConsolidation()`
   (`src/consolidate/consolidate.ts:471-704`) runs a nested `for`/`for` pairwise scan over
   every (repo, type) group of valid atoms, up to `maxGroupSize` (default 500,
   `consolidate.ts:478`) — `consolidate.ts:545-674`. That double loop contains **no
   `await`** except the one conditional `await judgeContradiction(...)` inside the (default
   OFF, `contradictionDetection.mode`) judge branch — grepping the file for
   `setImmediate|process.nextTick|await new Promise.*setTimeout` returns **zero matches**.
   With the judge off (the shipped default per `defaultConfig()`, `config.ts`), the entire
   scan — cosine similarity (`consolidate.ts:227-235`), containment checks
   (`consolidate.ts:212-221`), and every synchronous `db.prepare().run()` merge/propose write
   — executes as **one uninterrupted synchronous JS call stack**, however many pairs that
   is. `C(500,2) = 124,750` pairs per full group; the codebase has multiple groups.
   `serve.ts:424-443` **auto-enqueues this job at daemon boot and every 6 hours**
   (`CONSOLIDATE_INTERVAL_MS = 6h`), with a comment asserting "~60ms at a few hundred
   memories" — a scaling assumption from Wave 4b that has not been re-verified against
   today's corpus size and is exactly the kind of assumption that degrades silently as
   O(n²) growth outpaces it.

4. **Every configured timeout is itself an event-loop timer, so none of them fire during a
   full stall.** `AbortSignal.timeout()` (used by every LLM/embed provider, e.g.
   `src/providers/llm/codex-subscription.ts:417,481`), Fastify's own
   `requestTimeout: 60_000` (`src/server/app.ts:75`), and the FEAT-482
   `maxWallClockMs`/`maxPerRun` judge caps (`consolidate.ts:561-572`) are **all
   `setTimeout`-family timers** — they require the event loop to be free to run their
   callback. **This is not a new observation to verify — it is inherent to how JS timers
   work** — but it is corroborated by the incident itself: Fastify's `requestTimeout` has
   been 60s (`app.ts:75`) the whole time, yet issue #347 observed **300s hangs**, meaning
   the *existing* timer-based defense was already provably defeated before this ADR.

5. **Why the handler is never even entered, not just slow inside:** during a full
   synchronous stall, Node cannot service the incoming-connection/incoming-request libuv
   events at all — the request sits queued until the stall clears. This means an in-process
   timeout wrapper placed *inside* the handler body (Tier 1, below) **never gets a chance to
   start its own clock**, because the handler function is never called until the stall ends.
   This is the mechanism behind "HTTP 000 at the client's cap": the server eventually answers
   after the stall clears, but the client (300s budget) has already given up.

6. **`mark_memory_used` hangs too, and `agent_profile` doesn't, because the stall is a
   scheduled/periodic event, not a permanent state.** No session-serialization mechanism
   was found in `src/server/routes/mcp.ts` — both `/recall` and `/used` are ordinary Fastify
   routes with no shared queue between them. The simplest explanation consistent with the
   evidence: both calls landed inside the same ~6-hour consolidate window (or the boot-time
   pass), while `agent_profile` was called outside it. This is a **testable, not yet
   directly measured** claim — `handler_runs.duration_ms` (`src/storage/handler-run-log.ts`)
   already logs per-handler wall-clock time; `SELECT handler, duration_ms, created_at FROM
   handler_runs WHERE handler='consolidate' ORDER BY created_at DESC LIMIT 20` against the
   production DB is the cheap confirming measurement, recommended as the first step of
   implementation (not blocking this design).

**Not the embedding provider.** No `OnnxEmbedProvider` exists in this codebase yet (FEAT-503
is `pending`, config-opt-in-only in its own v1 scope). Swapping embed providers would not
touch `consolidate.ts`'s pairwise scan, which is pure JS/SQLite with no embedding-provider
involvement beyond a `SELECT embedding FROM memories_vec` read.

**Corroborating infrastructure already in place** (lowers Tier-2 implementation risk, see
below): `db.ts:91` already runs `journal_mode = WAL`, and `db.ts:84`'s `busy_timeout = 5000`
is *already* documented as covering "concurrent writers (backup CLI's second connection,
doctor probes) against the live daemon" — i.e. multi-connection concurrent access to this
same SQLite file is an already-proven pattern in this codebase, not a new risk.

---

## Decision 1 — Tier 1: immediate mitigation

### Options considered

1. **Handler-body `Promise.race` timeout wrapper around `/recall` and `/memory/:id/used`
   (the literally-requested Tier 1 shape).**
   *Why rejected as "the fix":* per root-cause item 5 above, the wrapper's own timer is
   itself an event-loop timer that cannot start running until the handler function is
   entered — and the handler is never entered until the causing stall (consolidate's O(n²)
   scan) clears. **This wrapper provides zero protection against issue #347's confirmed
   mechanism.** It is still worth shipping (see Decision below) as defense-in-depth against
   a *different*, narrower bug class: a hang *inside* the handler's own async chain (e.g. a
   future embed/rerank call whose `AbortSignal` fails to fire due to a provider defect) —
   but it must not be presented to the user as closing #347.

2. **Tighten Fastify's global `requestTimeout` (`app.ts:75`, currently 60s) to something
   smaller.**
   *Why rejected:* same timer-family limitation as option 1 — and the incident already
   proves the *existing* 60s setting doesn't fire during a full stall (observed hang was
   300s, five times the configured timeout). Shrinking a mechanism that is already provably
   defeated in the failure mode we're fixing adds no protection for #347; it only tightens
   the *unrelated* partial-stall case.

3. **A watchdog running on a separate `worker_thread`, using `Atomics.wait`/`postMessage` to
   force a response from outside the blocked main thread.**
   *Why rejected for Tier 1 specifically:* this is the only mechanism that can survive a
   genuinely full main-thread stall (it runs on a different OS-schedulable thread), but
   building it well is materially the same engineering investment as Tier 2's worker
   isolation — it does not fit "small, shippable now." Folded into the Tier-2 recommendation
   instead rather than built twice.

4. **Rely on the MCP client's own 300s cap and do nothing server-side.**
   *Why rejected:* this is the status quo that produced issue #347 — the job keeps running
   server-side even after the client gives up (wasted CPU/DB work, and the client sees a
   generic transport-level failure with no diagnostic signal instead of a clean, named
   error).

5. **RECOMMENDED — scoped cooperative-yield fix in `runConsolidation`'s pairwise scan
   (the proven offender) + the handler-body timeout wrapper (option 1) shipped honestly as
   defense-in-depth, not as the fix + a `/health`/doctor-surfaced worker-staleness signal.**
   Detailed below.

### Decision

Ship three small, independent changes together as Tier 1:

**1a. Insert real yield points into `runConsolidation`'s double loop** (the proven root
cause) — e.g. `await` a `setImmediate`-based yield every N pairs (N tunable, start at ~200)
inside `consolidate.ts:545-674`. This is not "Tier 2's cooperative-yielding option done
properly" — it is a targeted patch of the one proven offender, small enough to ship
immediately, and it is what actually stops #347 from recurring in the near term.

**1b. Handler-body timeout wrapper on `/recall` and `/memory/:id/used`**, returning a clean
`504`/named-error instead of hanging to the client's cap — for the narrower "hang inside the
handler's own async chain" bug class described in option 1. **Ship with the limitation
stated in the response/log, not silently**: this wrapper does not protect against a
full-process synchronous stall; see Decision 2 for that.

**1c. Surface worker liveness.** `healthState.worker.lastTickAt` already exists
(`worker.ts:120`, stamped every tick) but nothing reads it today (no doctor check found
under `src/doctor/` matching `lastTickAt`/worker-staleness). Add a doctor check /
`/health` field reporting "worker last ticked Xs ago" so an operator (or a future automated
canary) can see *that* a stall happened, even though nothing can stop it mid-flight for a
still-unyielded future job.

### Consequences

- Fixes the proven mechanism (1a) — the only Tier-1 item that actually closes #347.
- 1b/1c are honest defense-in-depth, not a substitute for 1a or Decision 2.
- Does **not** close the structural risk: any future job handler that introduces its own
  unyielded synchronous stretch reproduces this exact bug class. This repo has already seen
  the "guidance without a structural gate gets reintroduced" failure mode (`DEFAULT_*` const
  trap; `checkMemoryHealth`'s `{ok:true}` bug reintroduced 4× in one day by agents who had
  read the ADR — see `CLAUDE.md`'s memory index). A comment and a fixed instance are not
  enough; Decision 2 is required to close the class, not just this instance.

---

## Decision 2 — Tier 2: the architectural fix (worker isolation)

### Options considered

| # | Option | Complexity | better-sqlite3 / WAL | Interacts with claim-execute lanes | De-risks dual-pass (2× distill) | De-risks in-process ONNX embed |
|---|---|---|---|---|---|---|
| (a) | `worker_thread` for the **entire worker loop** | Medium-high | Needs its own connection per thread (native handles aren't shareable across `worker_threads`) — WAL (`db.ts:91`) + `busy_timeout=5000` (`db.ts:84`, already proven for concurrent writers) make this tractable, not novel | `claimPending()`'s atomicity currently relies on Node's single-threadedness (`worker.ts:70-81`'s own comment) for **in-process** lane races; across a real OS thread the guarantee must come from SQLite's own write-locking instead — implementable under WAL, but needs a cross-connection test, not just today's in-process one | Yes — any job duration is now off-thread by construction | Yes, for the worker-side (document-role) embed calls; does **not** cover a future query-role ONNX call made from inside `/recall` itself (still on the main thread) |
| (b) | Separate **child process** for the worker | High | Same as (a): own connection, same WAL/busy_timeout dependency | Same as (a) | Yes | Yes, worker-side only (same gap as (a) on the query-role path) |
| (c) | **Cooperative yielding**/chunking of long synchronous jobs (generalized version of Decision 1's 1a) | Low | No new connection/threading concerns | Fully compatible — no change to the lane model | Not needed — dual-pass's added cost is more `await llm.chat()` calls (already yields), not new sync CPU work | **No** — ONNX inference has no natural mid-call yield point (the compute happens inside one native `session.run()`); "chunking" only helps *between* batched calls, not within one |
| (d) | **Offload only the heavy synchronous pieces** (ONNX embed inference call, and defense-in-depth for any future oversized sync scan) to a `worker_thread` pool, orchestration stays on the main loop | Medium | Same connection/WAL story as (a), but scoped to specific call sites only | Fully compatible — claim-execute lanes, atomicity, and DB-sharing-on-main-thread are untouched | N/A (not the mechanism dual-pass stresses) | **Yes, including the query-role path** — `/recall`'s own embed call can be routed through the same offload pool, closing the gap (a)/(b) leave open |
| (e) | Do nothing beyond Tier 1 (status-quo baseline) | — | — | — | No | No |

*Why (b) rejected (for now):* the isolation benefit (crash containment — relevant because
FEAT-503 explicitly *accepts* native ORT-crash risk for v1) doesn't currently outweigh the
added IPC/lifecycle complexity. This daemon's install/service model (schtasks/systemd/launchd
+ a single STABLE shim, see `CLAUDE.md`'s Service/upgrade section) already assumes **one**
managed process; a second internally-supervised child process duplicates that lifecycle
machinery inside the app instead of leaning on the OS layer that already exists for the
daemon itself, and this repo's teardown verdict is explicitly salvage-not-rewrite (minimize
blast radius). Revisit if native-crash containment becomes a *measured*, recurring problem
after ONNX ships.

*Why (c) rejected as the complete Tier-2 answer:* correctly scoped as Decision 1's 1a for the
*one proven offender*, but as a general policy it is fragile by the user's own framing — "one
un-yielded stretch reintroduces the hang" — and does not help the ONNX case at all (no
mid-inference yield point exists). Using it as the *sole* Tier-2 answer would leave the ONNX
default-flip hazard (below) completely unaddressed.

*Why (a) full worker_thread migration is not the Tier-2 recommendation right now:* it fully
closes the class (any handler, forever) and should be the long-term target, but it is a
larger, riskier unit of work than the problem in front of us actually requires today — the
concrete near-term hazards are two *known* call sites (consolidate's scan, already fixed by
1a; ONNX embed inference, not yet shipped). (d) closes both of those with materially less
churn to the existing, working claim-execute lane design.

### Decision

**Recommend (d): targeted `worker_thread` offload of specifically the heavy-synchronous
call sites** — the ONNX embed inference call (both the worker/document-role batch path and
the `/recall` query-role single-call path) as the concrete, currently-foreseeable case, plus
optionally re-routing consolidate's pairwise scan through the same pool as extra headroom
beyond 1a's yield-insertion.

Defer **(a)** full worker-loop migration as the next escalation if/when the job system grows
enough handler kinds that "remember to offload the heavy part" becomes unreliable in
practice — do not build it speculatively now.

### Consequences

- Keeps the existing claim-execute lane design, `claimPending()` atomicity, and
  single-process daemon architecture intact — lowest regression risk, consistent with the
  H2 salvage verdict (`docs/research/20260713-teardown-and-reinvent.md`).
- Directly closes the specific hazard the ONNX-default flip would otherwise introduce,
  including the query-role path that (a)/(b) alone would miss.
- Does not, by itself, protect against an *unrelated future* handler introducing a fresh
  unyielded stretch outside the offloaded call sites — narrower guarantee than (a). Revisit
  (a) if that recurs.
- Requires: a small `worker_thread` pool (Piscina-style or hand-rolled), a second
  better-sqlite3 connection opened from within the pool worker when DB access is needed
  (WAL + `busy_timeout=5000` already de-risk this per `db.ts:84,91`), and a benchmark of a
  single short-text ONNX inference call's actual wall-clock cost (to confirm the offload is
  worth its message-passing overhead for the query-role path specifically, vs. accepting a
  bounded main-thread cost if inference is provably sub-millisecond).

---

## Sequencing relative to dual-pass extraction and the ONNX-default flip

- **Dual-pass extraction** (`Config['distill']['extractionPasses']`, `pipeline.ts:186-191`)
  is **already shipped, opt-in, default `1`** (byte-identical to pre-dual-pass) — it is not
  itself an active production risk today. **Gate flipping its default to on** behind: (i)
  Tier 1's 1a landing, and (ii) a quick sync-stretch audit of `04-compact.ts`/`05-extract.ts`
  confirming no non-network synchronous stretch scales with a second pass (their per-chunk
  work is `await llm.chat()`-shaped already, so this is expected to be a fast, low-risk
  check, not a blocking redesign).
- **ONNX-default flip** (FEAT-503, currently `pending`, config-opt-in-only in its own v1
  scope) — FEAT-503's own design already anticipates this exact hazard on the batch/write
  path ("Watchdog safety (blocking design condition): chunked embed batches with explicit
  yield points... /health never starves"). This ADR adds the piece FEAT-503's scope note
  doesn't cover: **the query-role embed call made synchronously inside `/recall` itself**
  becomes a *self-inflicted* stall risk once ONNX is the query-side provider too, not just a
  victim of someone else's job. **Hard-gate promoting ONNX beyond config-opt-in on Decision 2
  (d) landing** — do not flip the default before the query-role call is either offloaded or
  benchmarked provably sub-millisecond. Tier 1 alone (1a/1b) is **not sufficient** to ship
  ONNX-by-default safely: 1b's handler-body timeout wrapper cannot protect a request from a
  stall inside that same request's own synchronous inference call (same root-cause-item-5
  limitation, restated for a first-party cause instead of a collateral one).

---

## Build Sequence

| Phase | Files | Change type | Acceptance criteria | Validation command |
|---|---|---|---|---|
| 1 | `.claude/artifacts/crew/handoffs/` (measurement note, not code) | n/a — read-only | `handler_runs` query against a live/production DB confirms `consolidate` duration correlates with the #347 incident window | `sqlite3 <datadir>/memory.sqlite "SELECT handler, duration_ms, created_at FROM handler_runs WHERE handler='consolidate' ORDER BY created_at DESC LIMIT 20;"` |
| 2 | `src/consolidate/consolidate.ts` | modify | Pairwise scan (`consolidate.ts:545-674`) yields to the event loop at least every ~200 pairs; existing consolidate unit tests still pass; a synthetic 2000-atom fixture no longer produces one uninterrupted JS stack >100ms | `bun test tests/consolidate/consolidate.test.ts` |
| 3 | `src/server/routes/search.ts`, `src/server/routes/lifecycle.ts`, new `src/server/lib/deadline.ts` (shared wrapper) | add + modify | `/recall` and `/memory/:id/used` return a clean `504`-class error (not a silent hang) when the wrapper's own timer fires; response/log states the documented limitation | `bun test tests/server/routes/search.test.ts tests/server/routes/lifecycle.test.ts` |
| 4 | `src/pipeline/worker.ts` (read `healthState.worker.lastTickAt`, already stamped), `src/doctor/checks/worker-liveness.ts` (new), `src/doctor/checks/index.ts` (register) | add | Doctor reports worker tick staleness (e.g. WARN past 2× `pollMs` under load); `/health` exposes the same field for external polling | `node dist/cli/index.js doctor` |
| 5 | design-only follow-up (Decision 2) — new `src/pipeline/offload/` module (worker_thread pool), wire into the ONNX embed call sites once FEAT-503 is picked up | add | ONNX inference (batch + single-query) runs off the main thread; a synthetic slow-inference fixture proves `/recall` stays responsive during a concurrent offloaded embed call | integration test TBD at FEAT-503 build time (not in this slice) |

Phases 1-4 are this slice's scope (Tier 1 + measurement). Phase 5 is Decision 2's design
handed to whoever picks up FEAT-503 or a dedicated worker-isolation FEAT — not built here.

---

## Open questions for the user / next handoff

1. Confirm Phase 1's measurement query against the real production DB before Phase 2 lands,
   to close the "testable, not yet directly measured" gap in root-cause item 6.
2. Decide whether Decision 2's Phase 5 becomes its own FEAT now (recommended, so it can gate
   FEAT-503's default promotion explicitly) or stays a note inside FEAT-503 itself.
3. `maxGroupSize` (500, `consolidate.ts:478`) already caps a single group's O(n²) blast
   radius — worth re-checking whether 500² pairs is still an acceptable per-group ceiling
   once 1a's yield-interval is tuned, or whether the ceiling itself should come down.
