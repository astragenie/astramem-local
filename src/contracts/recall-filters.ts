/**
 * Canonical project/agent/entity recall-filter contract (FEAT-424).
 *
 * Source of truth: `contracts/schemas/retrieval-query.v1.schema.json`
 * `filters.project` / `filters.agent` / `filters.entity` — the ADR-005
 * shared retrieval contract shipped as `@astragenie/astramem-contracts`.
 * That JSON Schema (and its generated `contracts/types/retrieval-query.v1.d.ts`
 * / `contracts/zod/retrieval-query.v1.ts` companions) is what `astramem-plugin`
 * and the memory SaaS backend should adopt to close FEAT-424's cross-repo
 * drift — see docs/recall-filters.md "Canonical contract" section.
 *
 * Why this file exists instead of importing `contracts/zod/retrieval-query.v1.ts`
 * directly: this repo's `tsconfig.json` scopes `compilerOptions.rootDir` to
 * `src/` (so `dist/` mirrors `src/`'s structure 1:1 for the published CLI —
 * see CLAUDE.md's `dist/cli/index.js` paths). `contracts/` lives outside
 * `src/`, so `tsc -p .` fails with TS6059 ("File is not under 'rootDir'") on
 * any direct import of the generated contracts package from daemon source.
 * Widening `rootDir` is out of scope for a contract-unification slice — it
 * would move every `dist/*` path the CLI, service installer, and CLAUDE.md
 * document.
 *
 * These three exports are therefore a **hand-mirrored, byte-for-byte**
 * reflection of the canonical schema's `filters.{project,agent,entity}`
 * shape (verified identical to `z.union([z.string(), z.array(z.string())])`
 * emitted by `contracts/generate-zod.mjs` for `project`/`agent`, and
 * `z.string()` for `entity`). `tests/contracts/recall-filter-parity.test.ts`
 * is the regression gate: it loads the canonical JSON Schema at runtime and
 * asserts these definitions accept/reject the same values. Any change to the
 * project/agent/entity filter shape MUST land in
 * `contracts/schemas/retrieval-query.v1.schema.json` first, then be mirrored
 * here — the parity test fails the build otherwise.
 */
import { z } from 'zod';

/**
 * `filters.project` — exact match on `memories.project`. A single string is
 * `project = ?`; a string[] is `project IN (...)` (OR-semantics). An empty
 * array is "no constraint", never match-nothing. Absent -> all projects.
 */
export const ProjectFilterSchema = z.union([z.string(), z.array(z.string())]).optional();

/**
 * `filters.agent` — exact match on provenance `agent`/`agent_type`. A single
 * string is `agent = ?`; a string[] is `agent IN (...)` (OR-semantics).
 * AND-composes with `project` when both are present. Absent -> all agents.
 */
export const AgentFilterSchema = z.union([z.string(), z.array(z.string())]).optional();

/**
 * `filters.entity` — entity name filter (FEAT-402), resolved via the
 * normalize seam (case/whitespace-insensitive, exact match then substring
 * fallback). An unresolvable name yields zero results, not an unfiltered set.
 */
export const EntityFilterSchema = z.string().optional();

/** Convenience bundle for surfaces that accept all three filters as a group. */
export const RecallFilterFieldsSchema = z.object({
  project: ProjectFilterSchema,
  agent: AgentFilterSchema,
  entity: EntityFilterSchema,
});
export type RecallFilterFields = z.infer<typeof RecallFilterFieldsSchema>;
