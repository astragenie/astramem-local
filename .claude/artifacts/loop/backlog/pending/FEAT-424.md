---
id: FEAT-424
status: pending
priority: null
category: platform
target_release: null
created: 2026-07-05
depends_on: [FEAT-423]
slices: []
derived_from: null
tags: [concern:recall, concern:provenance, concern:contracts, surface:api, surface:cli]
autonomous_safe: null
triage_notes: "Follow-up to FEAT-423. project/agent scoping now works end-to-end for the LOCAL daemon + astramem-plugin LocalProvider, but the three surfaces (astramem-local daemon, astramem-plugin SaaS provider, memory SaaS backend) have drifted contracts: the SaaS provider maps project->project_id and does NOT forward agent, and the SaaS backend recall/search DTO has no agent filter. Unify so all three speak one filter contract."
---

# FEAT-424: unify project/agent recall contract across daemon, astramem-plugin, and memory SaaS

## Requester

Internal follow-up to **FEAT-423** (project/agent scoped recall). FEAT-423
landed the local path; the cloud path and the plugin's SaaS provider are not yet
consistent.

## Problem — three surfaces, drifted filter contracts

FEAT-423 made the LOCAL daemon (`astramem-local`) and the `astramem-plugin`
`LocalProvider` speak one shape:

```jsonc
POST /recall { query, k, filters: { project, agent, type[], repo, since, as_of, entity } }
POST /remember { text, type, metadata: { project, agent, ... } }
```

But the other two surfaces diverge:

1. **astramem-plugin `SaaSProvider`** (`src/providers/saas.ts`) maps
   `RecallRequest.project → SaaS project_id` and `repo → source`, and **does not
   forward `agent` at all**. A caller doing `astramem recall --agent X` against
   the SaaS provider silently drops the agent filter.
2. **memory SaaS backend** (`C:\work\mega\memory`,
   `IngestTranscriptRequest.cs` + Search DTO): the search/recall request has no
   `agent` filter, and project is `project_id` (naming drift vs the local
   `project`). Agent provenance may be stored but is not queryable.

Net: the same `astramem recall --project P --agent A` command means different
things (or silently loses `agent`) depending on which provider resolves.

## Requested capability

Define ONE canonical recall/remember filter contract and make all three honor
it:

1. **Canonical filter block** — agree the field set + types:
   `{ type: string[], repo: string, project: string|string[], agent:
   string|string[], since: number, as_of: string, entity: string }`. Decide
   the wire name reconciliation (`project` vs `project_id`) — likely accept both
   on the SaaS side, emit the canonical one.
2. **astramem-plugin SaaSProvider**: forward `agent` (and array project/agent)
   to the SaaS search DTO; keep the `project→project_id`, `repo→source` mapping
   but add agent → whatever the SaaS field is named (define it in step 3).
3. **memory SaaS backend**: add an `agent` (and multi-value project/agent)
   filter to the recall/search endpoint + persist agent provenance queryably;
   align the request DTO field names with the canonical block.
4. **Shared contract source**: if practical, extract the filter shape into a
   shared schema (or a documented contract doc referenced by all three) so the
   next filter addition is a one-place change, not a three-repo drift.

## Acceptance criteria (proposed — re-triage as you see fit)

- Given the same `astramem recall --project P --agent A`, When it resolves to
  EITHER the local OR the SaaS provider, Then both apply project AND agent
  (no silent drop) — verified by a provider-parity test.
- Given the memory SaaS search endpoint, When called with an `agent` filter,
  Then only atoms with that provenance agent are returned.
- Given multi-value `project=[a,b]` / `agent=[x,y]`, When sent to any of the
  three surfaces, Then OR-semantics apply consistently.
- Given the canonical contract doc/schema, When a new filter is added, Then the
  change touches one shared definition (or the doc enumerates every surface that
  must be updated).

## Refs

- Depends on: FEAT-423 (local path — `docs/recall-filters.md`).
- Surfaces: `astramem-local` (this repo), `astramem-plugin`
  (`src/providers/saas.ts`, `src/contracts/wire.ts`), memory SaaS
  (`C:\work\mega\memory` `IngestTranscriptRequest.cs` + Search DTO).
- Consumers waiting on parity: runner-plugin (FEAT-219 role-scoped recall),
  dev-team plugin.
