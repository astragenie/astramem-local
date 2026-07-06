import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AtomV1Schema } from '../../contracts/zod/atom.v1.js';
import { MEMORY_TYPES } from '../../src/contracts/memory.js';

// ---------------------------------------------------------------------------
// U4-local (#111, ADR D4): the canonical ~10-value memory-type union now
// lives in exactly three places that must never drift apart:
//   1. contracts/schemas/atom.v1.schema.json  `properties.type.enum`  (SoT)
//   2. contracts/zod/atom.v1.ts               `AtomV1Schema` (GENERATED from 1)
//   3. src/contracts/memory.ts                `MEMORY_TYPES` (hand-reconciled)
// This mirrors the recall-filter-parity.test.ts pattern (FEAT-424): compile/
// inspect the canonical source and assert every mirror agrees with it. A
// failure here means either the schema changed without regenerating zod/
// types (run `node contracts/generate-zod.mjs` + `generate-types.mjs`), or
// src/contracts/memory.ts's MEMORY_TYPES needs a matching update.
// ---------------------------------------------------------------------------

const SCHEMA_PATH = join(__dirname, '../../contracts/schemas/atom.v1.schema.json');
const TYPES_D_TS_PATH = join(__dirname, '../../contracts/types/atom.v1.d.ts');

const canonicalSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
const schemaTypeEnum: string[] = canonicalSchema.properties.type.enum;

const CANONICAL_10 = [
  'decision',
  'fact',
  'lesson',
  'command',
  'todo',
  'note',
  'event',
  'preference',
  'task_result',
  'summary',
];

describe('memory-type parity — schema <-> generated zod/types <-> src/contracts/memory.ts MEMORY_TYPES', () => {
  it('contracts/schemas/atom.v1.schema.json type enum is exactly the canonical 10 (ADR D4)', () => {
    expect(new Set(schemaTypeEnum)).toEqual(new Set(CANONICAL_10));
    expect(schemaTypeEnum.length).toBe(10);
  });

  it('generated contracts/zod/atom.v1.ts AtomV1Schema.type accepts exactly the schema enum (no drift from a stale regen)', () => {
    const zodTypeOptions = AtomV1Schema.shape.type.options;
    expect(new Set(zodTypeOptions)).toEqual(new Set(schemaTypeEnum));
  });

  it('generated contracts/types/atom.v1.d.ts union literal lists every schema enum value (no drift from a stale regen)', () => {
    const dts = readFileSync(TYPES_D_TS_PATH, 'utf-8');
    for (const value of schemaTypeEnum) {
      expect(dts.includes(`'${value}'`)).toBe(true);
    }
  });

  it("src/contracts/memory.ts MEMORY_TYPES is a strict subset of the schema enum — zero local-only stragglers", () => {
    const stragglers = MEMORY_TYPES.filter((t) => !schemaTypeEnum.includes(t));
    expect(stragglers).toEqual([]);
  });

  it('src/contracts/memory.ts MEMORY_TYPES has been reconciled to the full canonical 10 (additive, ADR D4)', () => {
    expect(new Set(MEMORY_TYPES)).toEqual(new Set(CANONICAL_10));
  });

  it('every AtomV1Schema-accepted type value round-trips through MEMORY_TYPES (both sides agree on membership)', () => {
    for (const value of schemaTypeEnum) {
      const zodOk = AtomV1Schema.shape.type.safeParse(value).success;
      const localOk = (MEMORY_TYPES as readonly string[]).includes(value);
      expect(localOk, `MEMORY_TYPES missing canonical value "${value}"`).toBe(zodOk);
    }
  });

  it('a value outside the canonical registry is rejected by both the generated zod schema and MEMORY_TYPES', () => {
    const bogus = 'not-a-real-type';
    expect(AtomV1Schema.shape.type.safeParse(bogus).success).toBe(false);
    expect((MEMORY_TYPES as readonly string[]).includes(bogus)).toBe(false);
  });
});
