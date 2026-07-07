# Design: U5-local — MCP tool-name manifest (SoT) + cross-repo manifest-diff gate

## Problem
astragenie/memory#671 (U5-cloud) needs both MCP servers (this daemon + the
cloud .NET server) to expose the identical canonical `verb_noun` tool-name
vocabulary so `astramem-plugin`'s providers can call one contract regardless
of which backend answers. This repo is designated SoT for that manifest.
The user actually needs three things, not one: (1) confirmation of how much
local rename work is really required (my working hypothesis, stated in the
brief, is "none - local already speaks verb_noun"), (2) a concrete, checked-in
place for the canonical tool list to live so cloud/plugin CI can diff against
it, and (3) a sequencing plan that lets local land its slice(s) without
blocking on cloud/plugin, consistent with D2's downgraded blast-radius call
(clean rename, no alias period, but still coordinated because a solo local
rename with no manifest published yet helps nobody).

Note on D2: the brief asserts D2 (ratified) downgraded MCP-rename risk to
LOW because "nobody uses MCP in prod." I could not find a local record of D2
- it is not among .claude/artifacts/loop/decisions/DEC-001..007.md, so it
is presumably an SaaS-repo (astragenie/memory) decision record I have no
read access to from here. Treated as given context, not independently
verified; flagged again under Risks.

## Current shape
- `src/mcp/server.ts:81,161,241,323,342,364,405,438,481,516,548,571,599,629,653` - 15 `server.registerTool(name, {description, inputSchema}, handler)` calls. This is the only place tool names are declared; there is no separate registry/constant.
- `src/mcp/server.ts:4-19` (file header comment) - a hand-written, non-authoritative list of the 15 tools; already one of at least three places this list is duplicated (see next two bullets), none generated from a single source.
- `tests/mcp/server.test.ts:97` - `it('initialize + tools/list returns 15 tools', ...)`, plus scattered individual-name assertions (e.g. `:223` `name: 'search_memory'`) - a second hand-maintained partial copy of the tool list.
- `tests/smoke/mcp-stdio.e2e.test.ts:33-49` - `EXPECTED_TOOL_NAMES` (15 names, sorted), a third hand-maintained full copy, explicitly commented "Same 15-tool pin as tests/mcp/server.test.ts."
- `contracts/` (repo root, sibling of `src/`) - the existing checked-in SoT package `@astragenie/astramem-contracts` (`contracts/package.json:1-4`, v1.1.0): `schemas/*.v1.schema.json` (hand-authored) -> `generate-types.mjs`/`generate-zod.mjs` (generated `types/`, `zod/`, never hand-edited) -> `validate.mjs` (ajv fixture gate). This is the established generator-plus-frozen-fixture pattern (DEC-004) local already uses for atom@1, retrieval-query@1, retrieval-result@1, sync@1, capture@1.
- `src/server/lib/wire-meta.ts:39-49` (`SCHEMA_FILE_TO_DOMAIN`) + `tests/contracts/wire-version-map-parity.test.ts:24-25` - the closest existing precedent for what U5 needs: `tsconfig.json` scopes `rootDir` to `src/`, so `src/` code cannot import anything under `contracts/` (TS6059); the parity test lives in `tests/contracts/` (outside rootDir), readdirSync's `contracts/schemas/*.v1.schema.json` at test time, and asserts a hand-mirrored src/-side map covers every file on disk. Same shape as `tests/contracts/recall-filter-parity.test.ts` and `tests/contracts/memory-type-parity.test.ts`.
- `contracts/README.md:105-136` (U4, ADR D4) - prior art for a cross-repo-ratified vocabulary landing in this repo's `contracts/` package with a "ships from: local / cloud / both" table per entry - directly reusable shape for the tool manifest's local/cloud ownership column.
- `.github/workflows/lint.yml` (referenced `contracts/README.md:259-260`) - runs `node contracts/validate.mjs` after `tsc --noEmit`; `.github/workflows/test.yml` gates on the vitest conformance suite. No existing workflow inspects MCP tool names.
- FEAT-417 (`.claude/artifacts/loop/backlog/done/FEAT-417.md`), FEAT-418 (`.../FEAT-418.md`, delivered SLICE-412), FEAT-423 (`.../FEAT-423.md`) - prior MCP-parity work. None of them renamed a tool or introduced a naming convention decision; FEAT-417/423 fixed cross-surface (REST/CLI/MCP) filter parity, FEAT-418 built the stdio e2e harness that now hardcodes the 15-name list a second time. No prior FEAT touched MCP tool names themselves.

## Confirming the "no local rename" hypothesis
All 15 registered names are already verb_noun (or verb where noun is implicit/global, e.g. `remember`, `get_health`): `search_memory`, `recall_memory`, `remember`, `get_health`, `why_memory`, `session_digest`, `invalidate_memory`, `supersede_memory`, `promote_memory`, `restore_memory`, `memory_history`, `mark_memory_used`, `erase_memory`, `list_consolidation_proposals`, `resolve_consolidation_proposal`. Two names are the softest fits and are worth an explicit yes/no from whoever holds D2/#671's final vocabulary before this ships, since a "confirm, don't rename" design still needs someone to actually confirm:
- `remember` - verb with no explicit noun (`remember_memory` would be redundant; `create_memory` would match a stricter verb_noun reading). Recommend: keep `remember` as-is and record the decision explicitly in the manifest rather than silently assuming - it is the daemon's most-used tool and a rename has real client-config blast radius even under D2's "clean rename" allowance.
- `session_digest`, `memory_history` - noun_noun order (reads as "the digest of a session" / "the history of a memory"), not verb_noun. Every other tool leads with the verb. If the canonical vocabulary is strictly verb_noun, these are the two real rename candidates (e.g. `get_session_digest`, `get_memory_history` - mirroring `get_health`'s existing shape).

I cannot resolve which of these two calls is correct without the cloud-side manifest draft (or D2's actual text) - this is exactly the open question the cross-repo design pass should close before any slice touches `src/mcp/server.ts`.

Tools the daemon does NOT own today, so they must be absent from the daemon's row in a shared manifest (informational - cloud-side existence unverified from this repo, taken from the brief): "decision records" and "narrative" have no dedicated MCP tool here (the `decision` memory `type` value exists in `src/contracts/memory.ts`'s `MEMORY_TYPES`, but there is no decision-record CRUD tool distinct from `remember`/`invalidate_memory`/etc.); "entity graph" has only a flat `entity` search filter (`src/contracts/recall-filters.ts`, `EntityFilterSchema`), not a graph-traversal tool. One correction to the brief: bitemporal `as_of` is NOT cloud-only - the daemon already exposes it as a parameter on `search_memory`/`recall_memory` (`src/mcp/server.ts:105-110`, FEAT-401), not as a separate tool. If the canonical manifest models `as_of` as a distinct tool capability rather than a query parameter, that is itself a shape decision this design pass should surface, not something local can quietly reconcile in its own slice.

## Proposed shape
- `contracts/manifests/mcp-tools.v1.json` - new, hand-authored (not schema-generated, since tool descriptors are simpler than the JSON-Schema-per-wire-shape case) canonical list. Lives under `contracts/` because that is the existing, already-publishable (`@astragenie/astramem-contracts`, GitHub Packages, `contracts/package.json:41-50` `files` array) cross-repo SoT directory - reuses the plumbing instead of inventing a second one. Proposed shape per entry:

  ```json
  {
    "version": "1",
    "tools": [
      {
        "name": "search_memory",
        "owner": "local",
        "description": "Hybrid FTS + vector search over stored memories. Returns ranked hits.",
        "status": "stable"
      },
      { "name": "decision_record_get", "owner": "cloud", "description": "...", "status": "planned" }
    ]
  }
  ```

  Fields: `name` (the wire-level MCP tool name, verb_noun), `owner` (`local` | `cloud` | `both` - mirrors the `contracts/README.md:111-122` "ships from" precedent), `description` (short, human-facing, NOT required to byte-match the server's own `description` string - see risk below), `status` (`stable` | `planned` | `deprecated`, for a future dual-name migration window mirroring the wire-version dual-read convention in `contracts/README.md:149-163`). Full JSON-Schema-per-input (zod-equivalent) is explicitly out of scope for v1 of this manifest - each server's own `inputSchema`/zod validators remain authoritative for arguments; the manifest only pins the name + ownership, which is the actual #671 ask ("same tool names," not "identical input schemas").
- `contracts/package.json` - add `"./manifests/*": "./manifests/*"` to `exports` (one-line addition, same pattern as the existing `schemas/*`/`fixtures/*` entries) so cloud/plugin can read it the same way they'd read a schema.
- `contracts/README.md` - new section ("MCP tool-name manifest (U5)") documenting the file, the ownership column, and the no-JSON-Schema-generation rationale - mirrors the existing per-artifact documentation sections already in this file.
- `tests/contracts/mcp-tool-manifest-parity.test.ts` (new) - the manifest-diff gate, local half. Pattern copied directly from `tests/contracts/wire-version-map-parity.test.ts`: import the real tool set from `src/mcp/server.ts` (in-rootDir, importable) by calling `buildMcpServer()` with mock deps and reading its registered tool names (the `McpServer` SDK exposes this - needs a one-line confirmation against the SDK's public surface during build, not assumed here), `readFileSync`+`JSON.parse` `contracts/manifests/mcp-tools.v1.json` (plain JSON read, no TS import, so no TS6059 issue), and assert: (a) every `owner: "local"` or `owner: "both"` manifest entry has a matching registered tool, (b) every registered tool has a matching manifest entry, (c) no name drift. This closes the local half of #671's "cross-repo manifest-diff CI test" - cloud's half (asserting its own registered names against the same file) and the plugin's half (asserting its provider tool-call names against it) are out of this repo's build.
- `src/mcp/server.ts:4-19` (header comment) - update to reference the manifest as the actual SoT rather than re-stating the list by hand a fourth time (comment-only change, not a behavior change).
- `tests/smoke/mcp-stdio.e2e.test.ts:33-49` (`EXPECTED_TOOL_NAMES`) - optionally replace the hardcoded array with a read of the same manifest file, collapsing one of the three duplicate lists identified above. Not required for #671 but directly serves the same "stop hand-duplicating this list" goal and is low-risk (test-only file).

## Trade-offs
| Option | Pro | Con |
|---|---|---|
| A - New `contracts/manifests/mcp-tools.v1.json`, hand-authored, name+owner only (recommended) | Reuses existing publishable `contracts/` package + exports plumbing; matches #671's actual ask (names, not full schemas); smallest surface, fast to land, low risk | Does not give cloud/plugin a machine-checkable input-schema contract per tool - if #671's real scope is broader than tool names, this under-delivers |
| B - Full JSON-Schema-per-tool (name + input schema + output schema), generated via `generate-types.mjs`/`generate-zod.mjs` like the wire-envelope schemas | Single mechanism for both wire envelopes and MCP tools; stronger contract (catches input-shape drift, not just name drift) | Local's own 15 tools reuse the same zod schemas as their REST-route counterparts already (e.g. `ProjectFilterSchema`) - duplicating that into a second generated JSON Schema per tool is real, ongoing maintenance for a program whose stated goal this slice is names only; materially larger slice, higher risk of scope creep flagged in FEAT-418's own pm_scope_notes precedent ("don't let this balloon into exhaustive per-tool coverage") |
| C - No checked-in manifest; cloud/plugin CI calls the live daemon's `tools/list` over MCP at CI time and diffs against their own list | Zero new local artifact; always reflects runtime truth | Requires a live daemon (with mock providers) spun up in cloud/plugin CI just to read a name list - heavier CI dependency for less benefit than a static JSON read; also not "checked-in" as #671 requests, and loses the audit trail (git blame on a manifest file) that a file gives you |

## Recommendation
Option A. #671's literal ask is tool-name parity for a client-facing rename risk, not full schema parity (that concern is already covered per-tool by each server's own existing validators). Reusing `contracts/` avoids standing up a second cross-repo SoT mechanism next to the one that already works (DEC-004's generator+fixture pattern, already publishable, already consumed by two other repos per `contracts/README.md`'s "Cloud + plugin consumption" section). The two ambiguous local names (`session_digest`, `memory_history`) and the one soft one (`remember`) should be resolved as an explicit decision recorded in the manifest itself (or a short DEC entry) before SLICE-1 touches `server.ts`, not silently decided by whichever engineer picks up the slice.

## Slice decomposition
- SLICE-A (independent, no cloud/plugin dependency): author the manifest + local parity test. Add `contracts/manifests/mcp-tools.v1.json` with all 15 current local tool names at `owner: "local"`, `status: "stable"`; add the `exports` entry; add `tests/contracts/mcp-tool-manifest-parity.test.ts`; update `src/mcp/server.ts`'s header comment to point at the manifest. Explicitly does not add any cloud-owned tool rows yet (those require the cloud-side draft to exist first, or the manifest immediately drifts). This can land on main independently - it is pure addition, zero behavior change (proved by: `tests/contracts/mcp-tool-manifest-parity.test.ts` passing plus the existing `tests/mcp/server.test.ts` 15-tool assertion and `tests/smoke/mcp-stdio.e2e.test.ts` `EXPECTED_TOOL_NAMES` both continuing to pass unmodified).
- SLICE-B (coordinated - needs the D2/#671 naming call first): resolve `session_digest`/`memory_history`/`remember` and rename if the cross-repo vocabulary requires it. Only runs if the design pass (this document, plus whatever cloud proposes) concludes one or both noun-noun names must become verb-noun. D2's "clean rename, no alias" allowance means this is a straight rename (tool name string + both test files' expected-name lists + the manifest), not an alias-and-deprecate. Must land in the same window cloud/plugin update their callers - a solo local rename with no coordinated cloud/plugin update breaks the plugin's provider immediately, which is the exact blast radius #671 is managing.
- SLICE-C (optional, low priority, can trail): collapse `tests/smoke/mcp-stdio.e2e.test.ts`'s hardcoded `EXPECTED_TOOL_NAMES` to read from the manifest, finishing the "stop hand-duplicating this list" cleanup identified in Current Shape. Independent of cloud/plugin; pure test-file change.

## Acceptance criteria
- [ ] `contracts/manifests/mcp-tools.v1.json` exists, is valid JSON, and lists exactly the 15 tools currently registered in `src/mcp/server.ts` (or the renamed set, if SLICE-B has landed) with `owner: "local"` and `status: "stable"`.
- [ ] `tests/contracts/mcp-tool-manifest-parity.test.ts` fails if a tool is added to/removed from `src/mcp/server.ts` without a matching manifest update, and fails if the manifest lists a local-owned name that isn't actually registered.
- [ ] `contracts/package.json`'s `exports` map includes `./manifests/*`, and `node contracts/validate.mjs` (or an added equivalent) still exits 0.
- [ ] `contracts/README.md` documents the manifest's fields, ownership semantics, and the explicit decision on `remember`/`session_digest`/`memory_history`.
- [ ] Existing `tests/mcp/server.test.ts` (15-tool count) and `tests/smoke/mcp-stdio.e2e.test.ts` (`EXPECTED_TOOL_NAMES`) both continue to pass with SLICE-A alone - proving SLICE-A is additive, not a rename.
- [ ] If SLICE-B lands: both hardcoded test name lists, the manifest, and `src/mcp/server.ts`'s registered names agree post-rename, and the plugin/cloud PRs referenced in #671 are confirmed landing in the same coordinated window (not verifiable from this repo alone - record the cross-repo PR links in the slice's own artifact).

## Risks
- D2's actual text is unread from this repo. The brief's paraphrase ("nobody uses MCP in prod today, clean rename, no alias period") is taken as given context per the injection-defense rule, not verified against a local decision record - the nearest local artifact (`.claude/artifacts/loop/decisions/DEC-001..007.md`) does not contain it. Mitigation: before SLICE-B, have whoever owns #671 paste D2's ratified text into this repo's own decision log (or link it) so the local rename slice has a citable source instead of a secondhand paraphrase.
- Manifest `description` field can drift from `server.ts`'s own `description` string with no test catching it (the parity test only checks name+owner, per the recommended v1 scope). Mitigation: explicitly scope the parity test to name+owner only in its own doc comment (as `wire-version-map-parity.test.ts` does), so a future reader doesn't assume it's a full-fidelity check it isn't.
- `buildMcpServer()`'s registered-tool-name introspection may not have a public SDK accessor (`@modelcontextprotocol/sdk`'s `McpServer` may store tools privately). Mitigation: SLICE-A's builder should check the SDK surface first; if there's no public listTools()-equivalent outside spinning up a transport, fall back to the same approach `tests/smoke/mcp-stdio.e2e.test.ts` already uses (a real `tools/list` JSON-RPC call against a spawned/in-process server) rather than reaching into SDK internals.
- Renaming `session_digest`/`memory_history` (if SLICE-B proceeds) touches a live client surface even under D2's "nobody uses MCP in prod" premise - any local dev or design-partner already wired to the current names breaks with no deprecation window. Mitigation: this is D2's call to make, not this design's; flagged here only so it isn't rediscovered as a surprise mid-slice.
