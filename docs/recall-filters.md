# Project- & agent-scoped recall (FEAT-423)

Recall and search can be narrowed to a **project** and/or an **agent**, and both
accept a **list** (OR-semantics). Filters are optional — omit one and that
dimension is unscoped (returns across all values). This is the end-to-end
integration contract for consumers (runner-plugin, dev-team plugin) and the
`astramemory-plugin` client.

> Live API reference ("swagger-lite"): **`GET /dashboard/api`** on the running
> daemon (e.g. <http://127.0.0.1:7777/dashboard/api>). Clickable GET rows +
> copy-paste curl for every route. This doc is the narrative; that page is the
> authoritative route table.

## What is a "project" / "agent"?

The daemon does **not** invent these — it stores whatever the writer supplies:

| Write path | project source | agent source |
|---|---|---|
| Canonical ingest (`POST /ingest/transcript`) | envelope `project_id` → `sessions.project` → atom | envelope `agent_type` → `sessions.agent` → atom |
| Legacy ingest | envelope `project` | envelope `agent` |
| `POST /remember` | `metadata.project` | `metadata.agent` |

If the writer omits them, the atom's `project`/`agent` is **NULL** and will not
match any explicit filter (a NULL atom is only returned by an *unscoped* recall).
There is currently **no server-side auto-derive or backfill** — populate them at
write time.

## Wire contract

### `POST /recall` (and `POST` via MCP `recall_memory`)

```jsonc
{
  "query": "prior review lessons",
  "k": 5,
  "filters": {                       // entire object optional
    "project": "runner-plugin",      // string OR ["runner-plugin","astramem"] (OR / IN)
    "agent":   "crew:reviewer",      // string OR ["crew:reviewer","crew:builder"]
    "type":    ["lesson","decision"],
    "repo":    "astramemory-local",
    "since":   1719800000000,        // epoch ms lower bound on created_at
    "as_of":   "2026-07-01T00:00:00Z",// ISO-8601 bitemporal point-in-time
    "entity":  "Priya Nair"
  }
}
```

- `project`/`agent` are **exact match**. `= ?` for a single value, `IN (...)`
  for a list. An empty list `[]` is treated as *no constraint* (never
  match-nothing).
- `project` + `agent` **AND-compose** (both must match).
- Omit `filters` entirely → unscoped recall (byte-identical to legacy body).

### `GET /search`

```
GET /search?query=sqlite&project=runner-plugin&agent=crew:reviewer
GET /search?query=sqlite&project=runner-plugin,astramem     # comma list = OR
```

### `POST /remember`

```jsonc
{ "text": "reviewer flagged a null deref",
  "type": "lesson",
  "metadata": { "project": "runner-plugin", "agent": "crew:reviewer" } }
```

Both `metadata.project` and `metadata.agent` are optional; stored on the atom
when present, so the memory is later recallable under those filters.

## CLI (`astramem-local`, this repo)

```bash
astramem-local remember "..." --type lesson --project runner-plugin --agent crew:reviewer
astramem-local recall   "..." --project runner-plugin --agent crew:reviewer
astramem-local recall   "..." --project runner-plugin,astramem      # comma = OR
astramem-local search   "..." --project runner-plugin --agent crew:reviewer
```

`--project`/`--agent` accept comma-separated lists on `recall`/`search`.

## Client CLI (`astramemory-plugin`, `astramem`)

```bash
astramem recall   --query "..." --project runner-plugin --agent crew:reviewer
astramem recall   --query "..." --project runner-plugin,astramem     # comma = OR
astramem remember --content "..." --type lesson --project runner-plugin --agent crew:reviewer
```

The `LocalProvider` maps these into the nested `filters` object the daemon
expects. (Prior to FEAT-423 the client sent `repo`/`project` **flat**, which the
daemon silently ignored — the "any --project returns everything" no-op in
issue #56. Fixed.)

**SaaS provider** maps `project` → `project_id` and `repo` → `source` against
the cloud `POST /memories/search`; it does **not** yet forward `agent`. Track
contract parity in the unify-contracts feature.

## Precedence / gotchas

- On `astramem remember`, explicit `--metadata '{"project":...}'` JSON keys win
  over the `--project`/`--agent` convenience flags.
- A wrong/nonexistent project or agent yields **zero** results — this is the
  correct signal that the filter is live (contrast issue #56 where every value
  returned the full set).
- Plugin `dist` must be rebuilt (`bun run build`) for these to take effect in an
  installed plugin.

## Tests / evidence

- Daemon unit: `tests/search/project-filter.test.ts`, `tests/cli/project-filter.test.ts`.
- Daemon e2e smoke (real daemon boot → ingest → distill → filter battery over
  GET/POST/CLI): `tests/smoke/smoke.test.ts` (step 3 + step 4).
- Plugin: `tests/providers/local.test.ts` (nested-filters body shape),
  `tests/cli/recall.test.ts`, `tests/cli/remember.test.ts`.

## Related

- Issue: astragenie/astramem-local#56.
- Precedent filters: FEAT-401 (`as_of`), FEAT-402 (`entity`), FEAT-403
  (repo/project tag-hygiene backfill — retag/rebuild).
- Deferred: write-side project auto-derive + null-project backfill; agent
  soft-boost (FEAT-219 role-scoped recall); `agent` on the SaaS/`memory-plugin`
  contract (unify-contracts feature).
