---
id: SLICE-419
title: "durable ingest spool — capture transcript content at close, daemon drains async"
status: pending
feature: FEAT-449
phase: null
priority: P1
target_release: null
requires_validation: true
risk: medium
created: 2026-07-09
updated: 2026-07-09
---
# SLICE-419: durable ingest spool — capture transcript content at close, daemon drains async

Implements FEAT-449. See [feature file](../../../backlog/in-progress/FEAT-449.md) for product context.

## Objective

Close the ingest starvation: capture Claude transcript CONTENT at close to a
durable local spool (not a path read later), and have the daemon drain the
spool through the existing ingest→distill pipeline. Reference→value: read the
`.jsonl` while it is guaranteed live, decoupled from a later sweep that races
worktree/subagent cleanup.

## In scope

- `src/capture/claude.ts` (new) — parse a Claude Code `.jsonl` transcript into
  the canonical `{event, session_id, project_id, turns[], wire_version}`
  envelope (`wire_version` matching `^v(?:0|[1-9][0-9]*)\.[0-9]+$`; event ∈
  `subagent_stop | session_end`). Mirror `src/capture/codex.ts`.
- `astramem-local capture claude <transcript-path> [--event ...]` in
  `src/cli/capture.ts` — reads the file AT INVOCATION, builds the envelope,
  writes it to the spool. Missing/unreadable file → one warning + `exitCode=1`,
  no throw, no `UV_HANDLE_CLOSING` (AC-3).
- Durable spool writer: `<dataDir>/ingest-spool/<idempotency-key>.json` via
  tmp-file + rename; key = SHA-256 stable-stringify of the body (same scheme as
  `/ingest/transcript`). Idempotent re-writes (AC-2).
- `src/ingest/spool-drain.ts` (new) — daemon worker step: drain each spool file
  through the SAME ingest→distill path `/ingest/transcript` uses (idempotency
  honored), delete on ack; quarantine poison (repeated failure) or oversize
  (>`ingest.spoolMaxBytes`, default 32MB) files to `ingest-spool/.quarantine/`
  with a logged reason; emit `drained`/`quarantined`/`pending` counts (AC-4,5,6).
- Wire the drain step into the daemon worker loop.
- Tests for AC-1..AC-8 (unit + an end-to-end: capture a fixture transcript →
  drain → assert a `memory_events` row, AC-7; daemon-down→up drain, AC-8).

## Out of scope

- **astramem-plugin hook wiring** (separate repo): the SubagentStop/session_end
  hook invoking `astramem-local capture claude "$agent_transcript_path"`. This
  slice delivers the CLI + drainer the hook will call; the hook change is a
  companion cross-repo follow-up.
- Changing the `/ingest/transcript` wire contract (content-only, unchanged).
- Codex capture (`capture codex`) — untouched.
- Retroactively recovering the 786 already-lost transcripts — they are gone.
- Chunking/streaming very large (28MB) transcripts — cap+quarantine this slice;
  richer large-transcript handling is a fast-follow if needed.

## Acceptance criteria

- [ ] AC-1 (capture reads at invocation, not deferred): Given an existing Claude
- [ ] AC-2 (durable, idempotent spool write): Given capture runs, Then the envelope
- [ ] AC-3 (missing file fails soft, no crash): Given the transcript path does not
- [ ] AC-4 (daemon drains the spool): Given one or more spool files exist, When the
- [ ] AC-5 (poison/oversize quarantine): Given a spool file that repeatedly fails or
- [ ] AC-6 (drain observability): Given a drain tick processes N files, Then a
- [ ] AC-7 (end-to-end de-starvation): Given a transcript captured via the CLI while
- [ ] AC-8 (survives daemon-down): Given the daemon is stopped when capture runs,

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-449 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written
- (pure refactors / mechanical changes: set `requires_validation: false` in frontmatter
   above to waive the validation gate — no badge needed at close time)

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...
