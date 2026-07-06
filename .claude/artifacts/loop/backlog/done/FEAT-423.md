---
id: FEAT-423
status: done
priority: null
category: platform
target_release: null
created: 2026-07-05
depends_on: []
slices: []
derived_from: null
tags: [concern:recall, concern:provenance, surface:api, surface:cli]
autonomous_safe: null
triage_notes: "Cross-repo feature request from the runner-plugin consumer (astragenie/runner-plugin FEAT-219 + DEC-066). Recall cannot be scoped by project today: --project is accepted by the astramem client CLI but has no effect, because (a) the /recall filter set does not include project and (b) the write path does not reliably populate provenance.project. Needs project-scoped recall end-to-end."
---

# FEAT-423: project-scoped recall — persist + filter memories by project

## Requester

astragenie/runner-plugin (the loop/runner plugin) — see its `FEAT-219`
(role-scoped pre-work memory injection) and `DEC-065`/`DEC-066`. The loop wants
to recall only the memories belonging to a given repo/product (its cortex
`project`) before dispatching an agent, and later to further scope by agent
role. Neither is possible today.

## Problem — project filtering is inert end-to-end

`project` is a first-class provenance field and is carried through the whole
distill pipeline (`src/contracts/memory.ts:16`, `src/contracts/atom-wire.ts:30,71`,
`src/distill/pipeline.ts:38,136`, `src/distill/stages/08-embed-index.ts:29,83`) —
so the storage side already models it. But **recall cannot filter on it**:

- The recall/search filter set exposes only `type`, `repo`, `as_of`, `entity`
  (`src/cli/search.ts:91-100` — `filters.repo`, `filters.as_of`, `filters.entity`;
  no `filters.project`). FEAT-401 (`as_of`) and FEAT-402 (`entity`) are the
  precedent for how a new filter is threaded into `POST /recall`.
- The MCP surface DOES advertise a project filter
  (`src/mcp/server.ts:85` `project: z.string().optional() "Filter by project name"`,
  `:96 filters.project = args.project`) — so the two surfaces are already
  inconsistent.
- The astramem client CLI (`@astragenie/astramem-plugin` `recall.ts`) parses
  `--project` and puts it in its `RecallRequest`, but the daemon's `/recall`
  filter ignores it.

Empirical proof (astramem v0.5.2, local daemon @ 127.0.0.1:7777), identical
query, k=20:

```
no --project             -> 20 hits
--project runner         -> 20 hits
--project runner-plugin  -> 20 hits
--project loop           -> 20 hits   # a nonsense value returns everything
```

Any `--project` value returns the full result set → the filter is a no-op.

Compounding write-side gap: the `remember` client CLI has **no `--project`**
(only `--content/--type/--metadata`), and the ingest envelope's
`provenance.project` is not reliably populated from the caller — the daemon only
derives a *workspace* (`--workspace` > `basename(cwd)`) at `memory-connect`
time. So even a working recall filter would match against mostly-null project
values.

## Requested capability

1. **`/recall` accepts and applies a `project` filter** — thread `project` into
   the recall filter set exactly like `repo`/`as_of`/`entity`
   (`src/cli/search.ts:91-100` + the `POST /recall` handler + the vector/SQL
   query), so `filters.project` narrows results to atoms whose
   `provenance.project` matches. Reconcile the CLI and MCP surfaces so both
   honor it.
2. **Expose `--project` on the `search`/recall CLI** (currently absent) and make
   the client CLI's existing `--project` actually reach the filter.
3. **Reliably persist `provenance.project` on write** — either accept a
   `project` on the ingest/remember path, or deterministically derive it (e.g.
   from the connected workspace) and persist it on every atom, so recall has a
   non-null value to filter on. Provide a backfill (extend the existing
   `retag`/`rebuild` FEAT-403 tooling) for already-stored null-project atoms.

## Nice-to-have (enables the requester's later scope)

- An `agent` / `agent_type` filter on `/recall` mirroring `project` — the
  provenance already carries `agent` (`atom-wire.ts:5` "repo/project/agent/
  session_id"). runner-plugin FEAT-219 wants role-scoped recall (reviewer sees
  prior review failures, builder sees prior build lessons) as a **soft boost**,
  so a filter or a score-boost hook on `agent` would let the consumer blend
  role relevance without a hard filter.

## Acceptance criteria (proposed — re-triage as you see fit)

- Given atoms stored with distinct `provenance.project` values, When `POST /recall`
  is called with `filters.project = "X"`, Then only atoms whose project is `"X"`
  are returned (verified by the same-query/different-project hit-count test that
  currently returns identical counts for every value).
- Given the `search` CLI, When `--project X` is passed, Then it forwards
  `filters.project` and the client `astramem recall --project X` is honored
  identically (CLI/MCP parity test).
- Given a `remember`/ingest call from a caller that supplies a project (or a
  connected workspace), When the atom is persisted, Then `provenance.project` is
  non-null and equals that value.
- Given historical atoms with null project, When the backfill runs, Then their
  project is populated from the best available signal (workspace/repo), and a
  dry-run reports the proposed changes first.

## Refs

- Consumer: astragenie/runner-plugin `FEAT-219`, `DEC-065`, `DEC-066`,
  `src/scripts/lib/memory-recall.mts` (spawns `astramem recall --project`).
- Precedent: FEAT-401 (`as_of` filter), FEAT-402 (`entity` filter),
  FEAT-403 (repo/project tag-hygiene backfill — `src/cli/retag.ts`,
  `src/cli/rebuild.ts:41`).
