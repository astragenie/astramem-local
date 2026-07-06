import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  SCHEMA_FILE_TO_DOMAIN,
  WIRE_VERSIONS_SUPPORTED,
  CONTRACT_SCHEMA_VERSION,
} from '../../src/server/lib/wire-meta.js';

// ---------------------------------------------------------------------------
// U6 wire-version unification (astramem-local#106).
//
// src/server/lib/wire-meta.ts hand-mirrors contracts/schemas/*.v1.schema.json
// -> un-prefixed domain@gen id (TS6059 blocks importing contracts/ from src/,
// same constraint as tests/contracts/recall-filter-parity.test.ts). This is
// the regression gate for that mirror: it readdirSync's the real schemas
// directory and asserts SCHEMA_FILE_TO_DOMAIN covers every *.v1.schema.json
// file present — fails the build if a schema is added/removed without a
// matching map update, per the architect's binding decision (explicit map,
// not derived from schema `title` strings, which are internally
// inconsistent: atom uses `astramem/`, the rest use `astramem-`).
// ---------------------------------------------------------------------------

const SCHEMAS_DIR = join(__dirname, '../../contracts/schemas');
const schemaFiles = readdirSync(SCHEMAS_DIR).filter(f => f.endsWith('.v1.schema.json')).sort();

describe('wire-version domain@gen map parity — src/server/lib/wire-meta.ts vs contracts/schemas/*.v1.schema.json', () => {
  it('contracts/schemas/ has at least one .v1.schema.json file (sanity — map has something to cover)', () => {
    expect(schemaFiles.length).toBeGreaterThan(0);
  });

  it('SCHEMA_FILE_TO_DOMAIN covers every schema file present on disk (fails if a new schema is added without a map update)', () => {
    const mapped = Object.keys(SCHEMA_FILE_TO_DOMAIN).sort();
    expect(mapped).toEqual(schemaFiles);
  });

  it('every schema file on disk has a corresponding map entry', () => {
    for (const file of schemaFiles) {
      expect(SCHEMA_FILE_TO_DOMAIN, `missing map entry for ${file}`).toHaveProperty(file);
    }
  });

  it('every map entry corresponds to a schema file still on disk (fails if a schema is removed without a map update)', () => {
    for (const file of Object.keys(SCHEMA_FILE_TO_DOMAIN)) {
      expect(schemaFiles, `stale map entry for ${file} — no such schema file on disk`).toContain(file);
    }
  });

  it('every emitted domain@gen id is un-prefixed (no "astramem/" or "astramem-" prefix, no trailing words)', () => {
    for (const id of Object.values(SCHEMA_FILE_TO_DOMAIN)) {
      expect(id).toMatch(/^[a-z]+@\d+$/);
    }
  });

  it('retrieval-query.v1 and retrieval-result.v1 both map to the same retrieval@1 domain (dedup source)', () => {
    expect(SCHEMA_FILE_TO_DOMAIN['retrieval-query.v1.schema.json']).toBe('retrieval@1');
    expect(SCHEMA_FILE_TO_DOMAIN['retrieval-result.v1.schema.json']).toBe('retrieval@1');
  });

  it('WIRE_VERSIONS_SUPPORTED is the deduped domain@gen list — exactly 4 entries for the 5 current schema files', () => {
    expect(WIRE_VERSIONS_SUPPORTED).toHaveLength(4);
    expect(new Set(WIRE_VERSIONS_SUPPORTED).size).toBe(WIRE_VERSIONS_SUPPORTED.length);
  });

  it('WIRE_VERSIONS_SUPPORTED contains exactly the 4 expected domain@gen ids (order-independent)', () => {
    expect(new Set(WIRE_VERSIONS_SUPPORTED)).toEqual(
      new Set(['atom@1', 'retrieval@1', 'sync@1', 'capture@1']),
    );
  });

  it('WIRE_VERSIONS_SUPPORTED is derived from SCHEMA_FILE_TO_DOMAIN, not a separately hardcoded literal (dedup of map values equals the exported list)', () => {
    const derived = Array.from(new Set(Object.values(SCHEMA_FILE_TO_DOMAIN)));
    expect([...WIRE_VERSIONS_SUPPORTED].sort()).toEqual(derived.sort());
  });

  it('CONTRACT_SCHEMA_VERSION is the additive "1" generation marker, distinct from the SQLite migration-counter schema_version', () => {
    expect(CONTRACT_SCHEMA_VERSION).toBe('1');
    expect(typeof CONTRACT_SCHEMA_VERSION).toBe('string');
  });
});
