/**
 * Hand-mirrored copy of `contracts/wire.ts`'s `ENTITY_KINDS`/`ACTOR_KINDS`
 * (atom@2, contracts/schemas/atom.v2.schema.json `entities[].kind`).
 *
 * astramem-local's tsconfig.json scopes `rootDir` to `src/`, so daemon
 * source cannot `import` the root-level `contracts/` package directly
 * (`contracts/` lives outside rootDir -> tsc TS6059) — the same constraint
 * documented in src/contracts/recall-filters.ts and
 * src/server/lib/wire-meta.ts. This file is that daemon-side mirror for the
 * entity-kind registry; `tests/contracts/daemon-entity-kind-parity.test.ts`
 * is the regression gate that loads the real `contracts/wire.ts` at test
 * time and asserts byte-identical values.
 */
export const ENTITY_KINDS = [
  'actor',
  'team',
  'org',
  'project',
  'product',
  'workitem',
  'decision',
  'tech',
  'tool',
  'concept',
  'event',
  'other',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** The subset of ENTITY_KINDS for which `subtype` ('human' | 'ai') is a
 *  meaningful refinement. */
export const ACTOR_KINDS = ['actor', 'team', 'org'] as const;
