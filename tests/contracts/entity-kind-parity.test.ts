import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENTITY_KINDS, ACTOR_KINDS } from '../../contracts/wire.js';
import { AtomV2Schema } from '../../contracts/zod/atom.v2.js';

// ---------------------------------------------------------------------------
// atom@2: the 12-value entity-kind registry lives in two places that must
// never drift apart:
//   1. contracts/schemas/atom.v2.schema.json  `properties.entities.items
//      .properties.kind.enum`  (SoT)
//   2. contracts/wire.ts                      `ENTITY_KINDS`/`ACTOR_KINDS`
//      (hand-written TS-consumer convenience, mirrors README's `wire.ts`
//      pattern for WIRE_VERSION/WIRE_VERSIONS_SUPPORTED/SYNC_PROTOCOL)
// Mirrors the memory-type-parity.test.ts / recall-filter-parity.test.ts
// pattern: compile/inspect the canonical schema source and assert the
// hand-written mirror agrees with it.
// ---------------------------------------------------------------------------

const SCHEMA_PATH = join(__dirname, '../../contracts/schemas/atom.v2.schema.json');
const canonicalSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
const schemaKindEnum: string[] = canonicalSchema.properties.entities.items.properties.kind.enum;
const schemaSubtypeEnum: string[] = canonicalSchema.properties.entities.items.properties.subtype.enum;

describe('entity-kind parity — atom.v2.schema.json entities[].kind <-> contracts/wire.ts ENTITY_KINDS/ACTOR_KINDS', () => {
  it('atom.v2.schema.json entities[].kind enum has exactly 12 values', () => {
    expect(schemaKindEnum.length).toBe(12);
    expect(new Set(schemaKindEnum).size).toBe(12);
  });

  it('ENTITY_KINDS is exactly the schema kind enum, order-independent', () => {
    expect(new Set(ENTITY_KINDS)).toEqual(new Set(schemaKindEnum));
    expect(ENTITY_KINDS.length).toBe(schemaKindEnum.length);
  });

  it('ACTOR_KINDS is a subset of ENTITY_KINDS', () => {
    for (const kind of ACTOR_KINDS) {
      expect(ENTITY_KINDS as readonly string[]).toContain(kind);
    }
  });

  it("ACTOR_KINDS is exactly ['actor', 'team', 'org']", () => {
    expect(new Set(ACTOR_KINDS)).toEqual(new Set(['actor', 'team', 'org']));
  });

  it('entities[].subtype enum is exactly human|ai', () => {
    expect(new Set(schemaSubtypeEnum)).toEqual(new Set(['human', 'ai']));
  });

  it('generated contracts/zod/atom.v2.ts AtomV2Schema entities[].kind accepts exactly ENTITY_KINDS (no drift from a stale regen)', () => {
    const entitiesSchema = AtomV2Schema.shape.entities.unwrap();
    const kindSchema = entitiesSchema.element.shape.kind;
    expect(new Set(kindSchema.options)).toEqual(new Set(ENTITY_KINDS));
  });

  it('a kind outside the canonical registry is rejected by the generated zod schema', () => {
    const entitiesSchema = AtomV2Schema.shape.entities.unwrap();
    const result = entitiesSchema.element.safeParse({ name: 'x', kind: 'person' });
    expect(result.success).toBe(false);
  });

  it('every ENTITY_KINDS value round-trips through the generated zod entity item schema', () => {
    const entitiesSchema = AtomV2Schema.shape.entities.unwrap();
    for (const kind of ENTITY_KINDS) {
      const result = entitiesSchema.element.safeParse({ name: 'x', kind });
      expect(result.success, `kind "${kind}" should be accepted`).toBe(true);
    }
  });
});
