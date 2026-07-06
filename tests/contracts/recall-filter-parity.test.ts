import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  ProjectFilterSchema,
  AgentFilterSchema,
  EntityFilterSchema,
} from '../../src/contracts/recall-filters.js';

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
});
