import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  ProjectFilterSchema,
  AgentFilterSchema,
  EntityFilterSchema,
} from '../../src/contracts/recall-filters.js';
// #112 (U3-local) AC-1/AC-4: MEMORY_TYPES is the single source of truth
// src/server/routes/search.ts now consumes for `filters.type` (previously a
// hand-declared, silently-driftable duplicate). Extend parity coverage to
// this field too, per AC-4's mandate.
import { MEMORY_TYPES } from '../../src/contracts/memory.js';

// ---------------------------------------------------------------------------
// FEAT-424: astramem-local's own tsconfig.json scopes rootDir to `src/`, so
// daemon source cannot `import` the generated `contracts/zod/*.ts` files
// directly (contracts/ lives outside rootDir -> tsc TS6059). The daemon's
// canonical filter Zod pieces (src/contracts/recall-filters.ts) are
// therefore a hand-mirrored copy of contracts/schemas/retrieval-query.v1
// .schema.json's `filters.{project,agent,entity}`. This test is the
// regression gate for that mirror: it compiles the canonical JSON Schema's
// filters sub-object with ajv and asserts the daemon's Zod definitions
// accept/reject the exact same probe values. Drift here means the two
// contract representations disagree — fix the daemon mirror (or, if the
// canonical shape changed, regenerate contracts/zod and update the mirror).
// ---------------------------------------------------------------------------

const SCHEMA_PATH = join(__dirname, '../../contracts/schemas/retrieval-query.v1.schema.json');
const canonicalSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats(ajv);

const filtersSchema = canonicalSchema.properties.filters;
const projectAjv = ajv.compile(filtersSchema.properties.project);
const agentAjv = ajv.compile(filtersSchema.properties.agent);
const entityAjv = ajv.compile(filtersSchema.properties.entity);
const typeAjv = ajv.compile(filtersSchema.properties.type);

// #112 AC-1/AC-3: the daemon's `filters.type` Zod shape, reconstructed here
// from the same MEMORY_TYPES export search.ts consumes — not re-declared
// independently, so this test only passes while both sides read the one
// shared array.
const MemoryTypeArraySchema = z.array(z.enum(MEMORY_TYPES)).optional();

type Probe = { label: string; value: unknown };

const probes: Probe[] = [
  { label: 'single string', value: 'runner-plugin' },
  { label: 'string array', value: ['runner-plugin', 'astramem'] },
  { label: 'empty array', value: [] },
  { label: 'number', value: 123 },
  { label: 'object', value: { project: 'x' } },
  { label: 'array of numbers', value: [1, 2] },
  { label: 'boolean', value: true },
];

describe('recall-filter parity — src/contracts/recall-filters.ts vs contracts/schemas/retrieval-query.v1.schema.json', () => {
  describe('project', () => {
    for (const probe of probes) {
      it(`${probe.label}: canonical ajv and daemon zod agree`, () => {
        const canonicalOk = projectAjv(probe.value);
        const zodResult = ProjectFilterSchema.safeParse(probe.value);
        expect(zodResult.success, `zod: ${JSON.stringify(zodResult)}`).toBe(canonicalOk);
      });
    }
  });

  describe('agent', () => {
    for (const probe of probes) {
      it(`${probe.label}: canonical ajv and daemon zod agree`, () => {
        const canonicalOk = agentAjv(probe.value);
        const zodResult = AgentFilterSchema.safeParse(probe.value);
        expect(zodResult.success, `zod: ${JSON.stringify(zodResult)}`).toBe(canonicalOk);
      });
    }
  });

  describe('entity', () => {
    const entityProbes: Probe[] = [
      { label: 'string', value: 'Priya Nair' },
      { label: 'number', value: 42 },
      { label: 'array', value: ['a'] },
      { label: 'boolean', value: false },
    ];
    for (const probe of entityProbes) {
      it(`${probe.label}: canonical ajv and daemon zod agree`, () => {
        const canonicalOk = entityAjv(probe.value);
        const zodResult = EntityFilterSchema.safeParse(probe.value);
        expect(zodResult.success, `zod: ${JSON.stringify(zodResult)}`).toBe(canonicalOk);
      });
    }
  });

  it('undefined is accepted by all three (optional filters)', () => {
    expect(ProjectFilterSchema.safeParse(undefined).success).toBe(true);
    expect(AgentFilterSchema.safeParse(undefined).success).toBe(true);
    expect(EntityFilterSchema.safeParse(undefined).success).toBe(true);
  });

  // #112 (U3-local) AC-1: src/server/routes/search.ts's `filters.type` /
  // `RememberBodySchema.type` now consume MEMORY_TYPES (src/contracts/memory.ts)
  // instead of a hand-declared duplicate enum. This is the regression gate:
  // it fails if MEMORY_TYPES is ever allowed to diverge from this canonical
  // schema's `filters.type` enum again (e.g. #111 lands a wider union here
  // without updating MEMORY_TYPES, or vice versa).
  describe('type (#112 AC-1/AC-3)', () => {
    it('MEMORY_TYPES is exactly the canonical filters.type enum, order-independent', () => {
      const canonicalValues: string[] = filtersSchema.properties.type.items.enum;
      expect(new Set(MEMORY_TYPES)).toEqual(new Set(canonicalValues));
      expect(MEMORY_TYPES.length).toBe(canonicalValues.length);
    });

    const typeProbes: Probe[] = [
      { label: 'single valid value', value: ['decision'] },
      { label: 'multiple valid values', value: ['decision', 'fact'] },
      { label: 'empty array', value: [] },
      { label: 'out-of-union value', value: ['not-a-real-type'] },
      { label: 'mixed valid/invalid', value: ['decision', 'not-a-real-type'] },
      { label: 'non-string item', value: [123] },
      { label: 'not an array', value: 'decision' },
    ];
    for (const probe of typeProbes) {
      it(`${probe.label}: canonical ajv and daemon zod agree`, () => {
        const canonicalOk = typeAjv(probe.value);
        const zodResult = MemoryTypeArraySchema.safeParse(probe.value);
        expect(zodResult.success, `zod: ${JSON.stringify(zodResult)}`).toBe(canonicalOk);
      });
    }

    it('undefined is accepted (optional filter)', () => {
      expect(MemoryTypeArraySchema.safeParse(undefined).success).toBe(true);
    });
  });
});
