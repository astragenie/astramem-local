---
id: FEAT-449
status: done
priority: P1
category: platform
target_release: null
created: 2026-07-09
depends_on: []
blocks: []
slices: [SLICE-419]
derived_from: 2026-07-09 distill-starvation dig (ingest.log 0 successful ingests / 786 transcript-not-found)
autonomous_safe: false
tags: ["concern:ingest", "concern:reliability", "surface:capture", "surface:ingest", "stack:typescript", prod-bug]
triage_notes: "Root-caused 2026-07-09: the whole ingest pipeline is starved — `%APPDATA%\Astramem\ingest.log` shows 0 successful ingests and 786 `transcript file not found`, 455 of them `\subagents\agent-*.jsonl` across every repo in the mega folder. The ingest hook reads Claude transcript files LATER (a deferred sweep), racing worktree/subagent cleanup; by read time the .jsonl is gone → nothing ingested → nothing distilled → no new memories → nothing to sync. The daemon's /ingest/transcript accepts CONTENT (never a path), so the failure is client-side. Fix = capture the CONTENT at close to a durable local spool; daemon drains async. Sizes measured: subagent transcripts median 219KB / p95 811KB / max 5.7MB; main sessions to 28.9MB — so at-close read is ~20-150ms typical, ~1-2s worst; distill stays async. Store's core function (accumulating memory) is broken in prod until this lands. See memory: distill-broken-is-ingest-starvation."
started_at: 2026-07-09
updated: 2026-07-09
slices_complete: [SLICE-419]
completed_at: 2026-07-09
---

# FEAT-449: durable ingest spool — capture transcript content at close, daemon drains async

## Problem

The ingest pipeline is fully starved. `ingest.log`: 0 successful ingests, 786
`transcript file not found` (455 worktree-subagent `.jsonl` across memory,
runner, astramemory-local, devops, dating, common). The client-side hook reads
each Claude transcript file on a **deferred sweep**, after worktree/subagent
cleanup has deleted it. `/ingest/transcript` accepts CONTENT only (never a
path — `src/server/routes/ingest.ts`), so the file read races cleanup entirely
on the client. Net: no new memories are created, so nothing distills and
nothing syncs. This is a prod outage of the store's core function.

## Root design flaw

The pipeline persists a **reference** (transcript file path) to ephemeral
state and reads it later. Worktree/subagent transcripts are cleaned between the
event and the read. The fix is to capture the **value** (content) at the moment
it is guaranteed live (agent/session close), decoupled from a later read.

## Requested capability

A durable content-spool ingest path, in two build slices (both in this repo;
the plugin change is a thin companion hook-wire):

**Slice A — `astramem-local capture claude <transcript-path>` CLI** (mirrors the
existing `capture codex` in `src/cli/capture.ts`):
- Reads the Claude `.jsonl` **at invocation** (the hook calls it at close, file
  present), converts to the canonical `{event, session_id, project_id, turns[],
  wire_version}` envelope.
- Writes it to a durable spool dir via atomic tmp+rename, keyed by the existing
  SHA-256 stable-stringify Idempotency-Key. Never blocks on the network.

**Slice B — daemon spool-drain worker:**
- On the worker loop, drains `%APPDATA%\Astramem\ingest-spool\*.json` through the
  existing ingest→distill pipeline (idempotency honored), deletes each on ack,
  quarantines poison/oversize files instead of infinite-retry.

**Companion (astramem-plugin, separate/tiny):** SubagentStop / session_end hook
invokes `astramem-local capture claude "$agent_transcript_path"` synchronously
at close. Out of scope for the build slices here; tracked as a cross-repo note.

## Acceptance criteria

- AC-1 (capture reads at invocation, not deferred): Given an existing Claude
  transcript `.jsonl` and `astramem-local capture claude <path>`, When run, Then
  it parses the file into a canonical transcript envelope (`event: subagent_stop
  | session_end`, `session_id`, `project_id`, `turns[]`, `wire_version`
  matching the `^v(?:0|[1-9][0-9]*)\.[0-9]+$` contract) reading the file at
  invocation time.
- AC-2 (durable, idempotent spool write): Given capture runs, Then the envelope
  is written to `<dataDir>/ingest-spool/<idempotency-key>.json` via tmp-file +
  rename (never a torn file), keyed by the SHA-256 stable-stringify body hash;
  re-running on the same content produces the same key and does not duplicate.
- AC-3 (missing file fails soft, no crash): Given the transcript path does not
  exist (already cleaned), When capture runs, Then it logs exactly one warning,
  writes nothing to the spool, and exits non-zero via `process.exitCode`
  WITHOUT a native `UV_HANDLE_CLOSING` assertion or unhandled rejection.
- AC-4 (daemon drains the spool): Given one or more spool files exist, When the
  daemon worker ticks, Then each is run through the existing ingest→distill
  pipeline (same idempotency as `/ingest/transcript`), and deleted on ack; a
  create-event / memory row results (proven, not asserted).
- AC-5 (poison/oversize quarantine): Given a spool file that repeatedly fails or
  exceeds a configured max bytes (default 32MB), When the drainer processes it,
  Then it is moved to `ingest-spool/.quarantine/` with a logged reason rather
  than retried forever or OOM-ing the daemon.
- AC-6 (drain observability): Given a drain tick processes N files, Then a
  structured log line carries `drained`, `quarantined`, and `pending` counts so
  spool health is auditable.
- AC-7 (end-to-end de-starvation): Given a transcript captured via the CLI while
  the daemon is running, When the drainer runs, Then a new `memory_events` row
  exists for that session — demonstrating the starvation is closed (contrast:
  today 0 ingests).
- AC-8 (survives daemon-down): Given the daemon is stopped when capture runs,
  When the daemon later starts, Then the spooled envelope is drained on the next
  tick (no loss, no dependence on daemon availability at capture time).

## Proposed slices

- SLICE A: `capture claude` CLI + envelope builder (`src/capture/claude.ts`) +
  durable spool writer. Reuses `capture codex` structure + idempotency-key.
- SLICE B: daemon spool-drain worker + quarantine + counts (worker loop +
  `src/ingest/spool-drain.ts`).

## Refs

- Dig / root cause: memory `distill-broken-is-ingest-starvation`; `ingest.log`.
- Daemon contract: `src/server/routes/ingest.ts` (content-only, legacy/canonical/events).
- Pattern to mirror: `src/cli/capture.ts` (`capture codex`), `src/capture/codex.ts`.
- Companion hook (separate repo): astramem-plugin SubagentStop/session_end.
