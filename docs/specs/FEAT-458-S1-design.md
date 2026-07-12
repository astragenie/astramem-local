# FEAT-458 Slice 1 — Design Gate

**Status:** design drafted, pending reviewer/builder pickup · **Date:** 2026-07-10
**Gate:** ADR-013 (`docs/adr/ADR-013-llm-proxy-auto-capture.md`, Accepted) + FEAT-458's own
S1 acceptance criteria (`.claude/artifacts/loop/backlog/triaged/FEAT-458.md`, `### S1` section).
This document is the design-gate deliverable for all three S1 items (FEAT-467 design,
`proxy.*` config surface, `proxy-bench` skeleton spec) plus the S1-completion checklist
(S1-AC-4). It does not implement any code — S1's own scope is design only, matching how
ADR-013 itself was gated before any slice opened.

---

## 1. FEAT-467 design — invalidate() reversal/audit primitive (S1-AC-1)

### 1.1 What exists today (read directly from the code, not assumed)

- `MemoryEventRepo.invalidate()` (`src/storage/memory-events.ts:162-184`) sets
  `valid_to = now` and appends an `invalidate` event. **No reversal exists.** Unlike
  `archive()`/`restore()` (`memory-events.ts:282-327`) and `supersede()`/`unsupersede()`
  (`memory-events.ts:216-262`, `329-384`, the FEAT-442 reversal primitive), there is no
  `un-invalidate`. Calling `restore()` on an invalidated-but-not-archived row throws
  `MemoryConflictError` — confirmed by the FEAT-455 spike (`docs/specs/FEAT-455-spike-results.md`
  checklist #5, "Finding: invalidate() has no reversal primitive"), not assumed here.
- `MemoryEventRepo.erase()` (`memory-events.ts:428-448`) is a **hard delete** — the
  `memories` row and its `memories_vec` row are physically removed; only the
  `erase_request` event (with `content_hash`) survives as a tombstone. This is
  intentionally, permanently irreversible (ADR-006 W5: "erasure always wins ... the text
  is unrecoverable locally after this call").
- **Today's disable→purge flow for hook-tap already uses the irreversible path.**
  `runAutoCaptureDisable` (`src/cli/capture.ts:168-270`) scopes
  `SELECT id FROM memories WHERE capture_source = 'auto_capture' AND valid_to IS NULL`,
  then calls `DELETE /memory/:id` (→ `MemoryEventRepo.erase()`) per matching id when the
  user confirms `--purge`. This is exactly the "weak disable→purge promise" ADR-013's
  operator review rejected re-accepting for the proxy tier (Decision 4): the current
  mechanism cannot be undone at all, and the only audit trail is a per-atom
  `erase_request` event — there is no batch-level record answering "what exactly did
  turning it off remove" (ids, scope, count, time range) in one place.

### 1.2 Design decision: tombstone/soft-delete generation with a bounded restore window

**Chosen: a new reversible "purge batch" primitive, built on the same `valid_to`
bookkeeping + event-log pattern `archive()`/`restore()` and `supersede()`/`unsupersede()`
already use — not a pre-purge snapshot export.**

Rationale for soft-delete-generation over snapshot-export:
- The codebase already has two working examples of "soft transition + reversal on the
  same `valid_to` column" (`archive`/`restore`, `supersede`/`unsupersede`). A purge-batch
  primitive is the same shape a third time — least-invasive addition, no new storage
  format, reuses `valid_to IS NULL` as the one "is this atom currently live" predicate
  every search/recall query already filters on.
- A snapshot-export (dump matching rows to a file before hard-erasing) would need its own
  restore-side re-ingest path (parse the export, re-insert as new atoms with new ids) and
  loses the original ids/timestamps/lineage — a restored atom would not be "the same
  atom," breaking any external reference (MCP `why_memory`, entity links, sync tombstone
  matching) that pointed at the original id. Soft-delete keeps the same id alive
  throughout the restore window, so a restore is a true undo, not a re-creation.
- The bounded window still lets the org keep ADR-006's "erasure always wins, eventually"
  guarantee: once the window elapses without a restore, the batch is **finalized** by
  calling the existing `erase()` primitive for real — the same hard-delete semantics
  disable→purge already relies on today, just deferred behind a grace period instead of
  applied immediately.

### 1.3 Mechanism

**New event types** (widen `memory_events.event_type` CHECK via the same create-copy-swap
table-rewrite migration 021 used to add `unsupersede` — SQLite CHECK constraints are
immutable):

- `'purge'` — the compensating action for a purge batch's soft-invalidation of one atom.
  Payload: `{ batch_id, capture_source }`. Deliberately **not** the existing `'invalidate'`
  type: a purge-caused hide must be distinguishable from a human-initiated `invalidate()`
  call, both for the `unpurge` precondition (below) and so a manual invalidate is never
  accidentally reactivated by a purge-batch restore.
- `'unpurge'` — the reversal. Payload: `{ batch_id }`.

**New table `purge_batches`** (the batch-level audit record FEAT-467's scope requires —
"ids, capture_source, time range, count"):

```sql
CREATE TABLE purge_batches (
  batch_id TEXT PRIMARY KEY,
  capture_source TEXT NOT NULL,      -- 'auto_capture' | 'proxy'
  requested_at INTEGER NOT NULL,
  restore_deadline_at INTEGER NOT NULL,
  atom_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open', 'restored', 'finalized')),
  finalized_at INTEGER
);
```

The affected atom ids are not duplicated into this table — they are reconstructable from
`memory_events WHERE event_type = 'purge' AND json_extract(payload_json, '$.batch_id') = ?`
(mirrors how `erase()`'s tombstone is the sole record of an erased atom's identity today).
`time range` = `[requested_at, restore_deadline_at]` on the batch row; per-atom
`created_at` on each `purge` event gives finer granularity if ever needed. This satisfies
FEAT-467's audit-completeness requirement without inventing a second ids-array column
that could drift from the event log.

**New `MemoryEventRepo` methods** (`src/storage/memory-events.ts`), same
one-transaction-per-op discipline every existing lifecycle method uses:

- `purgeBatch(atomIds: string[], captureSource: string, restoreWindowDays: number): { batchId: string; count: number }`
  — for each id: precondition `valid_to IS NULL` (skip/report ids that are already
  invalid, mirroring the existing per-id try/catch discipline `runAutoCaptureDisable`
  already uses for already-erased ids); sets `valid_to = now`; appends a `purge` event
  with the batch id. Inserts one `purge_batches` row (`status: 'open'`,
  `restore_deadline_at = now + restoreWindowDays * 86400000`).
- `restorePurgeBatch(batchId: string): { restored: number }` — throws if the batch is
  unknown, already `finalized`, or the window has elapsed (call `finalizePurgeBatch`
  guidance instead — a stale restore attempt is a conflict, not a silent no-op). For each
  atom still showing an open `purge` event for this batch and `valid_to` set from that
  purge (an atom independently re-invalidated after the purge is left alone — same
  "don't clobber an unrelated state change" discipline `unsupersede()`'s doc comment
  already documents for its own scope): clears `valid_to`, appends `unpurge`. Marks the
  batch `restored`.
- `finalizePurgeBatch(batchId: string): { erased: number }` — for each atom still
  purged-and-unrestored in the batch, calls the existing `erase()` unmodified (hard
  delete + `erase_request` tombstone, exactly today's behavior). Marks the batch
  `finalized`. Callable manually (a CLI subcommand, for an operator who wants to finalize
  early) or by a scheduled sweep once `restore_deadline_at` has passed — the sweep
  mechanism itself (cron-like background tick vs. lazy check-on-next-doctor-run) is an S2
  build-slice decision, not fixed here; either is compatible with this data model.

**Route/CLI surface** (additive, same shape as existing lifecycle routes):
`POST /capture/purge { capture_source, restore_window_days? }` → `{ batch_id, count }`;
`POST /capture/purge/:batchId/restore` → `{ restored }`; `POST /capture/purge/:batchId/finalize`
→ `{ erased }` (mirrors `invalidate`/`restore`/`unsupersede`'s existing 200/404/409 mapping
via `mapLifecycleError`, `src/server/routes/lifecycle.ts:70-78` — no new error-status
convention needed). `runAutoCaptureDisable` (`src/cli/capture.ts`) is rewired to call
`POST /capture/purge` instead of looping `DELETE /memory/:id` directly — same UX
(`--purge`/`--keep`/interactive confirm), different backing call.

**Default restore window: 30 days**, configurable (see §2) — long enough to cover "I
noticed captured content I didn't expect a week after disabling," short enough that an
operator isn't carrying an indefinite soft-deleted shadow copy of everything they thought
they removed.

### 1.4 Applies to both capture sources

`capture_source IN ('auto_capture', 'proxy')` — the mechanism takes `capture_source` as a
plain parameter with no branching logic; hook-tap's existing disable flow is retrofitted
onto the same primitive (closing FEAT-455's re-accepted gap, per FEAT-467's own scope:
"retrofits the 455 acceptance") and the future proxy disable flow (FEAT-458 S4-AC-4) reuses
it unmodified for `'proxy'`.

### 1.5 FEAT-467 Acceptance criteria (authored below, also copied into the FEAT-467 backlog file)

- **AC-1:** Given a disable flow requests a purge for a `capture_source`, When the purge executes, Then it creates a purge batch that soft-invalidates every matching atom via a new `purge` event type (never reusing `invalidate`) and persists a batch-level audit record — batch id, `capture_source`, atom count, and a restore-deadline time range — rather than hard-deleting any row.
- **AC-2:** Given an open purge batch within its restore window, When the batch's restore operation is invoked, Then every atom in the batch still in the purged state has `valid_to` cleared and an `unpurge` event appended, atoms independently changed by an unrelated lifecycle call since the purge are left untouched, and the batch's audit record is marked `restored`.
- **AC-3:** Given a purge batch whose restore window has elapsed with no restore call, When the finalize operation runs (explicit call or scheduled sweep), Then every still-purged atom in the batch is hard-erased via the existing unmodified `erase()` primitive (row, vector index, and FTS entry gone; `erase_request` tombstone appended) and the batch's audit record is marked `finalized`.
- **AC-4:** Given the purge/restore/finalize primitives, When a regression test exercises both outcomes, Then a purge followed by a same-window restore leaves the content fully searchable again, and a purge followed by finalize (or by simulated window expiry) leaves it permanently gone — both paths verified end to end, not asserted.
- **AC-5:** Given `capture_source` may be `'auto_capture'` (today) or `'proxy'` (FEAT-458), When either disable flow calls the purge primitive, Then the same reversible batch mechanism handles both values with the `capture_source` value itself as the only scoping difference — no `capture_source`-specific branching exists in the purge/restore/finalize code path.
- **AC-6:** Given an atom was hidden by a purge batch, When its lifecycle history is inspected (`GET /memory/:id/history` or the MCP `memory_history`/`why_memory` tools), Then the batch id and restore-deadline are visible on the `purge` event's payload, not just a bare state change indistinguishable from a manual `invalidate()`.

---

## 2. `proxy.*` config surface (S1-AC-2)

### 2.1 Config type addition (`src/config/config.ts`)

```ts
/** LLM proxy / auto-capture Tier 3 (FEAT-458, ADR-013). `enabled: false`
 *  (default, and the field's ABSENCE on an existing config.yaml) means no
 *  proxy process is ever started implicitly — the daemon's own boot path
 *  never reads this block. Unlike `capture.autoCapture`, there is no `init`
 *  wizard prompt (ADR-013 §5): the proxy is invoked only via its own
 *  explicit subcommand, `astramem-local proxy serve --port <N> --upstream
 *  <url>`, which can override `port`/`upstream` at the CLI without ever
 *  touching config.yaml. The config block exists so a user who DOES want a
 *  persistent config-driven default doesn't have to pass flags every time,
 *  and so `doctor` has something to read. */
proxy: {
  enabled: boolean;          // default false
  port: number;              // default 7778 (one above the daemon's default 7777)
  upstream: string;          // default '' — CLI --upstream is required if this is unset
  capture: {
    /** Default false EVEN WHEN proxy.enabled is true — capture is a second,
     *  independent opt-in on top of running the proxy at all (ADR-013 §5:
     *  "proxy-enabled-and-running is a deliberate opt-in ... reported for
     *  visibility"). A user can run the transparent-forward-only proxy
     *  (FEAT-458 S2) with zero capture surface. */
    enabled: boolean;         // default false
  };
};
```

`defaultConfig()` (`config.ts:324+`) gains:

```ts
proxy: {
  enabled: false,
  port: 7778,
  upstream: '',
  capture: { enabled: false },
},
```

— byte-identical to today for every existing config.yaml (the block is additive; an
existing file with no `proxy:` section loads exactly as before via whatever
missing-key-default behavior the loader already applies to `capture.autoCapture` today,
same precedent).

### 2.2 FEAT-461 lesson — config wiring checklist (do not skip)

CLAUDE.md's "Bump discipline"/config-reload sections and the FEAT-461 line item this task
was briefed with both point at the same two functions in `src/config/writer.ts`:

- **`configToYaml` (`writer.ts:136`)** must gain an explicit `proxy:` block emission —
  the FEAT-461 lesson (DEC-008) is that a field only defined in the `Config` type but not
  hand-emitted in this function silently never reaches `config.yaml` on write, which is
  exactly the class of bug DEC-008 closed for array-typed fields (`customPatterns`).
  `proxy.upstream` being an empty-string default (not an empty array) means DEC-008's
  specific "omit-when-empty" carve-out does not automatically apply here — decide
  explicitly whether an empty `upstream: ''` should still be emitted (recommended: yes,
  emit `upstream: ""` explicitly, since an omitted key vs. an empty string both currently
  read as "no upstream configured," so the ambiguity is harmless either way, but *silent*
  omission of a whole new field the way `customPatterns` was is the actual footgun to
  avoid).
- **`findMissingConfigKeys` (`writer.ts:102`)** must be able to see `proxy.*` as
  known keys — the FEAT-461 lesson here (also DEC-008) is that this function needs to
  know an empty/default-shaped value is not "missing," or a fresh default config gets
  flagged as incomplete on every doctor/rollback check.
- **DEC-010** (value-start-only quote grammar) is relevant if `upstream` (a URL,
  potentially containing `://`, `?`, `&`) is ever hand-quoted in `config.yaml` — the
  hand-rolled loader's comment-stripping is quote-aware only at legal value-start
  positions (`DEC-010`), so a URL value should be emitted quoted (`upstream: "https://..."`)
  consistently, never bare, to avoid the class of parse ambiguity DEC-010 closed for
  mid-value special characters.
- **Downgrade check vs. the previous release's loader:** because `proxy` is a wholly new
  nested object (not a new scalar under an existing key), a `reinstall --rollback` to a
  pre-FEAT-458 build must not crash when it encounters a `proxy:` block in an
  otherwise-untouched `config.yaml`. Per DEC-008/DEC-010's own precedent (both were
  triggered by exactly this kind of forward-compat gap), the S2 build slice must verify
  the OLD loader's behavior on a config.yaml containing an unrecognized top-level `proxy:`
  key — expected: silently ignored (extra unknown key), not a parse failure. This is a
  concrete test to add in S2 (`tests/config/` likely already has a downgrade-compat
  suite to extend), not merely a note.

### 2.3 `doctor` WARN-visibility row

New check function `checkProxyCapture`, same shape and the same `ok: true`-in-both-states
posture as `checkAutoCapture` (`src/doctor/checks.ts:970-999`) — proxy running (with or
without capture) is a deliberate opt-in, not a misconfiguration:

```ts
function checkProxyCapture(dataDir: string, proxyEnabled: boolean, captureEnabled: boolean, encryptionEnabled: boolean): Check {
  return {
    name: 'LLM proxy',
    async run(): Promise<CheckResult> {
      if (!proxyEnabled) {
        return { ok: true, message: 'proxy: off (default)' };
      }
      if (!captureEnabled) {
        return { ok: true, message: 'proxy is ON — capture is off (transparent forward only)' };
      }
      // same open-db / COUNT(*) WHERE capture_source = 'proxy' AND valid_to IS NULL pattern
      // as checkAutoCapture, once FEAT-458 S3 lands the capture fork.
      return { ok: true, message: `proxy capture is ON — <count> proxy-captured ${...} currently stored` };
    },
  };
}
```

Before S3 (capture fork) lands, `capture_source = 'proxy'` will simply always count zero
— the row is still worth shipping in S2 (proxy-enabled, capture-disabled state) since it
gives visibility into "the proxy process is running" even before any capture code exists,
matching the FEAT's own S2/S3 split.

### 2.4 Disable → purge parity

Turning the proxy off (`proxy.enabled: false`, or stopping the `proxy serve` process) and
turning proxy capture off (`proxy.capture.enabled: false` while leaving the proxy running)
both offer the identical purge flow FEAT-467 defines above, scoped to
`capture_source = 'proxy'` instead of `'auto_capture'` — same `POST /capture/purge`
route, same batch/restore/finalize semantics, same CLI UX shape as
`capture auto-capture disable [--purge|--keep]`, e.g. a new `proxy disable [--purge|--keep]`
subcommand under `src/cli/`. No new deletion or reversal mechanism — FEAT-467's primitive
is capture-source-agnostic by construction (§1.4).

---

## 3. `proxy-bench` skeleton spec (S1-AC-3)

**This document specifies the skeleton; it does not create the files.** Per this task's
write scope (design doc + FEAT-467 backlog file only), actual creation of
`scripts/eval/proxy-bench/` is an S1 *build* action for whoever picks up the slice next,
executed against this spec — the same "spec now, code later" split the S1 ACs themselves
draw (S1-AC-3 says "a bench harness skeleton is created," which is implementation, not
design-authoring).

### 3.1 Layout (modeled on `scripts/eval/extraction-bench/`'s shape)

```
scripts/eval/proxy-bench/
  README.md              methodology (this section, expanded) — request mix, warm-up,
                          percentile calc, fake-upstream rationale
  lib/
    fake-upstream.ts       minimal HTTP server standing in for a real OpenAI-compatible
                            provider — fixed-latency or latency-distribution-configurable
                            /v1/chat/completions responder, both non-streaming and SSE
    daemon-runner.ts        spawns the proxy process (reusing
                            scripts/eval/shared/spawn-daemon.ts's isolation conventions —
                            sandboxed APPDATA/HOME, not the real daemon's data dir) pointed
                            at fake-upstream.ts, and a direct-to-upstream baseline path
                            with no proxy in between
    stats.ts                p50/p95 computation — reuse extraction-bench's
                            lib/stats.ts shape (mean/stdev already exists there;
                            percentile calc is the one addition proxy-bench needs that
                            extraction-bench didn't) rather than re-deriving it
    report.ts                markdown + JSON output, same two-artifact convention
                            (results.json + report.md) as extraction-bench
  run-bench.mts            CLI entry point
  results/                  output dir, gitignored contents (committed dir marker only)
```

### 3.2 Methodology (pinned ahead of any real proxy implementation, ADR-013 Decision 3)

- **Request mix:** both non-streaming `POST /v1/chat/completions` and SSE-streamed
  (`stream: true`) requests, run as separate suites (not interleaved) since their timing
  characteristics differ (SSE measures time-to-first-chunk, not total request time).
- **Warm-up period:** first N requests (default 10, configurable via `--warmup`)
  discarded from percentile calculation — covers process/connection-pool warm-up, not a
  measurement of steady-state latency.
- **Measured requests:** default 200 per suite (configurable via `--requests`), sufficient
  sample size for a stable p95 without the run taking long enough to matter for CI.
- **Percentile calculation:** p50 and p95 of (proxy-mediated request latency − direct
  fake-upstream request latency) computed **per-request-pair**, not as a difference of two
  independently-computed aggregate percentiles — this avoids a common percentile-math
  error (subtracting two p50s is not the same as the p50 of the per-request deltas when
  the two distributions aren't perfectly correlated).
- **Fake upstream, not a live LLM** (ADR-013 §3's own instruction, and the FEAT-458 S1-AC-3
  wording): the bench's fake-upstream.ts responds with a fixed, configurable canned
  payload at a fixed, configurable artificial latency — isolating "latency added by the
  proxy hop" from "latency of whatever real model is behind it," which is the only thing
  this bench is trying to measure. A live-provider mode is explicitly out of scope for the
  regression suite (cost/flakiness), matching ADR-013 §3's own text ("a local mock
  upstream for CI, to avoid live-provider cost/flakiness").
- **Target:** <10ms added p50, matching ADR-013 Decision 3 / FEAT-458 S2-AC-4. The
  skeleton's `report.ts` should flag (not fail the run — this is a bench, not a gate) any
  result exceeding that threshold in its markdown output, the same way extraction-bench's
  report flags a significance/noise-floor finding without hard-failing the process.

### 3.3 What this bench explicitly does NOT do in S1/S2

No capture-path measurement — S2 (core proxy, `FEAT-458.md` `### S2` AC-4) benches the
capture-free forward path only; S4-AC-2 re-benches with capture enabled end-to-end once
S3 lands the capture fork. The skeleton's `daemon-runner.ts` should accept a
capture-enabled/disabled toggle now (even though S2 always passes disabled) so S4 does not
need to redesign the harness, only flip the flag and re-run.

---

## 4. S1-completion artifact checklist (S1-AC-4)

To be recorded as the design-gate completion artifact once this document and the FEAT-467
backlog update are both reviewed/accepted:

- [ ] FEAT-467's design is settled (this document, §1) — reversal mechanism chosen
      (purge-batch soft-delete-generation), audit record shape specified, ACs authored
      and copied into `.claude/artifacts/loop/backlog/triaged/FEAT-467.md`.
- [ ] `proxy.*` config surface is specified (this document, §2) — `Config` type addition,
      defaults, `doctor` WARN row spec, disable→purge parity statement, and the
      FEAT-461-lesson config-wiring checklist (`configToYaml`/`findMissingConfigKeys`/
      DEC-008/DEC-010 downgrade-compat check) flagged for the S2 builder.
- [ ] `proxy-bench` skeleton is specified (this document, §3) — layout, methodology
      (request mix, warm-up, percentile calc, fake-upstream rationale) pinned; actual
      directory/file creation is an S1 or early-S2 build action against this spec, not
      done by this design-gate pass.
- [ ] All three items above have been through the standard reviewer gate (this is a
      design artifact — code-bearing review is not yet applicable, but the design itself
      should get a reviewer pass before S2 is allowed to open, per this repo's "review is
      a gate, not a courtesy" constitution rule).

**S2 (core proxy, no capture) may build in parallel with this checklist's reviewer pass**
per the dispatching brief — S2's own scope (transparent forward + SSE passthrough,
loopback-only bind, zero capture code) does not depend on FEAT-467 landing; only **S3**
(capture fork) is hard-gated on FEAT-467 being done, per ADR-013 Decision 4 and
FEAT-458's own S3-AC-1.

---

## 5. S2 worktree/branch plan + AC refinement flags (not a rewrite of S2's ACs)

### 5.1 Proposed worktree/branch plan

- Branch: `feat/feat-458-s2-proxy-core`, sibling git worktree (per this repo's "worktree
  parallelism" convention, CLAUDE.md autonomous-loop section) — isolated from whatever
  branch the main checkout currently sits on (noted as shared with another session in this
  task's brief) and from a potential parallel FEAT-467 branch, since S2 and FEAT-467 touch
  disjoint files (S2: new `src/proxy/*` + `src/cli/proxy.ts` + config/doctor additions;
  FEAT-467: `src/storage/memory-events.ts`, a new migration, `src/server/routes/lifecycle.ts`
  or a new `src/server/routes/capture-purge.ts`, `src/cli/capture.ts`) — no file-ownership
  overlap expected, safe to run concurrently per this repo's scope-discipline rule.
- FEAT-467 should land on its own branch first or in parallel (`feat/feat-467-purge-reversal`)
  — S2 does not need to wait for it (§4 above), but S3 cannot open until it merges, so
  sequencing FEAT-467 immediately alongside or just before S2 (as FEAT-467's own triage
  notes already recommend) keeps S3 from stalling later.

### 5.2 S2 AC gaps (flagging only, not rewriting the existing 5 ACs)

- **S2-AC-2** (non-loopback bind refusal) doesn't specify the exact error message/exit
  code contract — worth pinning before the builder writes the CLI arg-parsing, so the
  regression test in S2-AC-2 has a stable string/code to assert against (recommend
  matching whatever convention `src/cli/serve.ts` already uses for its own bind-failure
  path, for consistency).
- **S2-AC-4** (latency bench) references "the slice 1 bench harness" — since this design
  gate only specifies the skeleton (§3) rather than building it, S2's own scope implicitly
  includes finishing `scripts/eval/proxy-bench/`'s actual implementation if it isn't done
  by a separate S1-follow-up build step first. Worth an explicit line in S2's slice file
  clarifying who builds the harness's *code* (S1 build-follow-up vs. folded into S2) so
  it isn't silently dropped between the two slices.
- **No AC currently pins the control-plane Bearer requirement** from ADR-013 Decision 4
  ("any proxy control-plane route ... reuses the existing MEMORY_BEARER/safeBearerEqual
  pattern"). S2's scope sketch only covers the passthrough + bind-refusal + error-relay +
  latency + capture-free-diff ACs — if S2 ships a `/status` or `/config`-equivalent
  control-plane route at all, it needs its own AC for the Bearer gate; if no control-plane
  route ships until S4 (doctor wiring), that's fine, but it should be an explicit decision
  in S2's slice file rather than a silent gap.
