# Project- & agent-scoped recall (FEAT-423, canonical contract FEAT-424)

Recall and search can be narrowed to a **project** and/or an **agent**, and both
accept a **list** (OR-semantics). Filters are optional — omit one and that
dimension is unscoped (returns across all values). This is the end-to-end
integration contract for consumers (runner-plugin, dev-team plugin) and the
`astramemory-plugin` client.

> Live API reference ("swagger-lite"): **`GET /dashboard/api`** on the running
> daemon (e.g. <http://127.0.0.1:7777/dashboard/api>). Clickable GET rows +
> copy-paste curl for every route. This doc is the narrative; that page is the
> authoritative route table.

## Canonical contract (FEAT-424)

`project`, `agent`, and `entity` are defined **once**, as the single source of
truth for every surface (daemon, `astramem-plugin`, memory SaaS):

- **Schema**: `contracts/schemas/retrieval-query.v1.schema.json`
  (`filters.project` / `filters.agent` / `filters.entity`) — part of the
  `@astragenie/astramem-contracts` package (ADR-005 shared retrieval
  contract). `project`/`agent` are `anyOf [string, string[]]` (single value or
  OR-list); `entity` is a plain `string`.
- **Generated artifacts**: `contracts/types/retrieval-query.v1.d.ts`
  (TypeScript types) and `contracts/zod/retrieval-query.v1.ts`
  (`RetrievalQueryV1Schema`, runtime Zod) — regenerate both with
  `node contracts/generate-types.mjs && node contracts/generate-zod.mjs` (or
  `bun run contracts:build`) whenever the schema changes. These are what
  `astramem-plugin` and the memory SaaS backend should import once they adopt
  the package (see "Cross-repo follow-up" below) — never hand-roll a second
  copy of the filter shape.
- **Daemon wiring**: this repo's `tsconfig.json` scopes `rootDir` to `src/`,
  so daemon source cannot `import` the generated `contracts/zod/*.ts` files
  directly (they live outside `rootDir`; see `src/contracts/recall-filters.ts`
  for the full explanation). `src/contracts/recall-filters.ts` exports
  `ProjectFilterSchema` / `AgentFilterSchema` / `EntityFilterSchema` — a
  hand-mirrored, byte-for-byte reflection of the canonical schema's filter
  shape, consumed by `POST /recall` + `GET /search`
  (`src/server/routes/search.ts`) and the `search_memory` / `recall_memory`
  MCP tools (`src/mcp/server.ts`). `tests/contracts/recall-filter-parity.test.ts`
  is the regression gate: it ajv-compiles the canonical JSON Schema at test
  time and asserts the daemon's Zod mirror accepts/rejects the same values.
  Any filter-shape change MUST land in the JSON Schema first, then be mirrored
  in `recall-filters.ts` — the parity test fails otherwise.
- **Fields intentionally NOT in the canonical contract**: `agentMode`
  (FEAT-426 `'filter'|'boost'` ranking mode) and `since` (epoch-ms number on
  the daemon's wire, vs. ISO-8601 `date-time` in the schema's own `since`)
  are daemon-local/ranking concerns, not part of the cross-repo project/agent
  filter unification — they are validated separately in each route/tool and
  are unaffected by this contract.

### Cross-repo follow-up (out of scope here)

- **`astramem-plugin` `SaaSProvider`** (`src/providers/saas.ts`): adopt
  `@astragenie/astramem-contracts` (`./zod` export) to validate/build the
  outbound SaaS search request instead of hand-rolling the filter shape;
  forward `agent` (already partially done per FEAT-424 triage notes) using
  the canonical `anyOf [string, string[]]` shape rather than a bespoke field.
- **memory SaaS backend** (`IngestTranscriptRequest.cs` + Search DTO): add a
  canonical `agent` filter (currently absent) and align `project`/`project_id`
  naming with the schema; consume `contracts/schemas/retrieval-query.v1.schema.json`
  directly (a conformant .NET JSON Schema validator, e.g. `JsonSchema.Net`, can
  load it with no transpilation — see `contracts/README.md` "Cloud
  consumption") instead of maintaining a parallel hand-written DTO shape.

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
the cloud `POST /memories/search`, and (as of FEAT-424) also forwards `agent`
verbatim. The SaaS API itself has no canonical `agent` filter yet, though — it
silently drops the unknown key server-side, so `agent` against the SaaS
provider is still an effective no-op **end-to-end** (unfiltered results, no
error) until `astragenie/memory` grows one. See the plugin's
`docs/recall-filter-contract.md` for the full caveat and per-surface mapping
table.

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
- Canonical contract: `contracts/validate.mjs` / `tests/contracts/conformance.test.ts`
  (schema + fixtures gate) and `tests/contracts/recall-filter-parity.test.ts`
  (FEAT-424 — asserts the daemon's `src/contracts/recall-filters.ts` Zod
  mirror agrees with `contracts/schemas/retrieval-query.v1.schema.json`).
- Plugin: `tests/providers/local.test.ts` (nested-filters body shape),
  `tests/cli/recall.test.ts`, `tests/cli/remember.test.ts`.

## Related

- Issue: astragenie/astramem-local#56.
- Precedent filters: FEAT-401 (`as_of`), FEAT-402 (`entity`), FEAT-403
  (repo/project tag-hygiene backfill — retag/rebuild).
- FEAT-424: canonical project/agent/entity filter contract (this section,
  "Canonical contract" above) — daemon side done; plugin `SaaSProvider` and
  memory SaaS backend adoption of `@astragenie/astramem-contracts` is the
  cross-repo follow-up (see "Cross-repo follow-up" above).
- Deferred: write-side project auto-derive + null-project backfill; agent
  soft-boost (FEAT-219 role-scoped recall).
