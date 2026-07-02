import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { toAtomWireV1 } from '../../src/contracts/atom-wire.js';
import { buildApp } from '../../src/server/app.js';

// ---------------------------------------------------------------------------
// This is the CI gate for contracts/. It runs in the normal vitest suite so
// `bun run test` (and .github/workflows/test.yml) gates on it for free —
// mirrors what contracts/validate.mjs does standalone, plus live conformance
// checks that exercise the real local pipeline paths rather than fixtures.
// ---------------------------------------------------------------------------

const CONTRACTS_ROOT = join(__dirname, '../../contracts');
const SCHEMAS_DIR = join(CONTRACTS_ROOT, 'schemas');
const VALID_DIR = join(CONTRACTS_ROOT, 'fixtures', 'valid');
const INVALID_DIR = join(CONTRACTS_ROOT, 'fixtures', 'invalid');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function prefixForSchema(schemaFileName: string): string {
  const m = schemaFileName.match(/^(.+)\.v(\d+)\.schema\.json$/);
  if (!m) throw new Error(`schema file does not match "<name>.v<N>.schema.json": ${schemaFileName}`);
  return `${m[1]}-v${m[2]}-`;
}

const schemaFiles = readdirSync(SCHEMAS_DIR).filter(f => f.endsWith('.schema.json')).sort();
const validFixtureFiles = readdirSync(VALID_DIR).filter(f => f.endsWith('.json'));
const invalidFixtureFiles = readdirSync(INVALID_DIR).filter(f => f.endsWith('.json'));

// Ajv strict: true, strictRequired: false — see contracts/validate.mjs for why
// (if/then conditional-require pattern in capture-envelope.v1.schema.json).
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats(ajv);

const compiled = new Map<string, ValidateFunction>();

describe('contracts/ — schema compilation (ajv strict-ish mode)', () => {
  it('every schema file under contracts/schemas/ compiles', () => {
    expect(schemaFiles.length).toBeGreaterThan(0);
    for (const schemaFile of schemaFiles) {
      const schema = readJson(join(SCHEMAS_DIR, schemaFile));
      const validateFn = ajv.compile(schema as object);
      compiled.set(schemaFile, validateFn);
    }
    expect(compiled.size).toBe(schemaFiles.length);
  });
});

describe('contracts/ — golden fixtures behave as named', () => {
  beforeAll(() => {
    // Ensure compilation ran even if this describe block executes first
    // under a different vitest ordering.
    for (const schemaFile of schemaFiles) {
      if (!compiled.has(schemaFile)) {
        const schema = readJson(join(SCHEMAS_DIR, schemaFile));
        compiled.set(schemaFile, ajv.compile(schema as object));
      }
    }
  });

  for (const schemaFile of schemaFiles) {
    const prefix = prefixForSchema(schemaFile);
    const matchingValid = validFixtureFiles.filter(f => f.startsWith(prefix));
    const matchingInvalid = invalidFixtureFiles.filter(f => f.startsWith(prefix));

    describe(schemaFile, () => {
      it(`has at least 3 valid and 3 invalid fixtures (prefix "${prefix}")`, () => {
        expect(matchingValid.length).toBeGreaterThanOrEqual(3);
        expect(matchingInvalid.length).toBeGreaterThanOrEqual(3);
      });

      for (const fixtureFile of matchingValid) {
        it(`valid/${fixtureFile} passes`, () => {
          const validateFn = compiled.get(schemaFile)!;
          const data = readJson(join(VALID_DIR, fixtureFile));
          const ok = validateFn(data);
          expect(ok, ajv.errorsText(validateFn.errors)).toBe(true);
        });
      }

      for (const fixtureFile of matchingInvalid) {
        it(`invalid/${fixtureFile} fails`, () => {
          const validateFn = compiled.get(schemaFile)!;
          const data = readJson(join(INVALID_DIR, fixtureFile));
          const ok = validateFn(data);
          expect(ok).toBe(false);
        });
      }
    });
  }

  it('every fixture file matched exactly one schema prefix (no silently-skipped fixture)', () => {
    const matchedValid = new Set<string>();
    const matchedInvalid = new Set<string>();
    for (const schemaFile of schemaFiles) {
      const prefix = prefixForSchema(schemaFile);
      for (const f of validFixtureFiles) if (f.startsWith(prefix)) matchedValid.add(f);
      for (const f of invalidFixtureFiles) if (f.startsWith(prefix)) matchedInvalid.add(f);
    }
    expect(matchedValid.size).toBe(validFixtureFiles.length);
    expect(matchedInvalid.size).toBe(invalidFixtureFiles.length);
  });
});

describe('contracts/fixtures/eval — seed corpus conforms to atom.v1', () => {
  it('every corpus atom validates against atom.v1.schema.json', () => {
    const validateFn = compiled.get('atom.v1.schema.json')!;
    const corpus = readJson(join(CONTRACTS_ROOT, 'fixtures', 'eval', 'corpus.json')) as { atoms: unknown[] };
    expect(corpus.atoms.length).toBeGreaterThanOrEqual(10);
    expect(corpus.atoms.length).toBeLessThanOrEqual(15);
    for (const atom of corpus.atoms) {
      const ok = validateFn(atom);
      expect(ok, ajv.errorsText(validateFn.errors)).toBe(true);
    }
  });

  it('queries.json has 6-10 queries including a temporal as_of case', () => {
    const queries = readJson(join(CONTRACTS_ROOT, 'fixtures', 'eval', 'queries.json')) as {
      queries: Array<{ filters?: { as_of?: string } }>;
    };
    expect(queries.queries.length).toBeGreaterThanOrEqual(6);
    expect(queries.queries.length).toBeLessThanOrEqual(10);
    expect(queries.queries.some(q => q.filters?.as_of !== undefined)).toBe(true);
  });
});

describe('contracts/ — LIVE conformance (real pipeline paths, not fixtures)', () => {
  it('a memory inserted through MemoryRepo.insertWithCreateEvent serializes to a valid atom@1', () => {
    const db = openDb(':memory:');
    migrate(db);
    const memories = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);

    const { id } = memories.insertWithCreateEvent(
      {
        type: 'decision',
        text: 'live-conformance: adopt the contracts package as the technical constitution',
        normalized_text: 'live-conformance: adopt the contracts package as the technical constitution',
        repo: 'astramem-local',
        project: 'astramem',
        branch: 'feat/wave3-ledger',
        agent: 'claude-code',
        // memories.session_id is a nullable FK -> sessions(id); null keeps
        // this test focused on the mapper without needing session fixtures.
        session_id: null,
        hash: 'f'.repeat(64),
        source_hash: null,
        importance: 0.7,
        confidence: 0.8,
        evidence: 'contracts/README.md',
      },
      events
    );

    const memory = memories.get(id);
    expect(memory).not.toBeNull();

    const wire = toAtomWireV1(memory!);
    const validateFn = compiled.get('atom.v1.schema.json')!;
    const ok = validateFn(wire);
    expect(ok, ajv.errorsText(validateFn.errors)).toBe(true);
  });

  it('a real memory_events row (from the create-event insert above) validates against the sync event shape', () => {
    const db = openDb(':memory:');
    migrate(db);
    const memories = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);

    const { id } = memories.insertWithCreateEvent(
      {
        type: 'fact',
        text: 'live-conformance: memory_events rows must validate against sync-envelope.v1',
        normalized_text: 'live-conformance: memory_events rows must validate against sync-envelope.v1',
        repo: 'astramem-local',
        project: 'astramem',
        branch: null,
        agent: null,
        session_id: null,
        hash: 'e'.repeat(64),
        source_hash: null,
      },
      events
    );

    const eventRows = events.listForAtom(id);
    expect(eventRows.length).toBe(1);
    const row = eventRows[0]!;

    // Wire shape per sync-envelope.v1.schema.json: payload_json is parsed to
    // a plain object (or null), not the raw TEXT column.
    const wireEvent = {
      seq: row.seq,
      event_type: row.event_type,
      atom_id: row.atom_id,
      payload_json: row.payload_json !== null ? JSON.parse(row.payload_json) : null,
      content_hash: row.content_hash,
      created_at: row.created_at,
    };

    // Validate as a full envelope (one-event batch) so the event-item
    // sub-schema requirements are exercised via the real schema entry point.
    const envelope = {
      protocol: 'astramem-sync@1',
      device_id: 'device-conformance',
      workspace_id: 'ws-conformance',
      cursor: 0,
      events: [wireEvent],
    };

    const validateFn = compiled.get('sync-envelope.v1.schema.json')!;
    const ok = validateFn(envelope);
    expect(ok, ajv.errorsText(validateFn.errors)).toBe(true);
  });

  it('a capture events-kind envelope (the shape ingest tests POST) validates against capture-envelope.v1', async () => {
    // Mirrors tests/server/ingest-events.test.ts EVENTS_PAYLOAD — proves the
    // wire shape the server actually accepts on /ingest/transcript is a
    // subset of (and conforms to) capture-envelope.v1.schema.json.
    const db = openDb(':memory:');
    migrate(db);
    const app = await buildApp({ db, token: 't' });

    const payload = {
      event: 'session_end' as const,
      session_id: 'sess-live-conformance-events',
      project_id: 'proj-live-conformance',
      captured_at: '2026-07-02T10:00:00.000Z',
      kind: 'events' as const,
      tool: 'runner-plugin',
      client_scrub_applied: false,
      client_scrub_hits: 0,
      client_version: '0.1.0',
      client_scrub_version: 'n/a',
      wire_version: 'v1.0',
      events: [
        { type: 'lesson' as const, text: 'live conformance: capture-envelope@1 accepts events kind.', importance: 0.6 },
      ],
    };

    const res = await app.inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      payload,
    });
    expect(res.statusCode).toBe(200);

    const validateFn = compiled.get('capture-envelope.v1.schema.json')!;
    const ok = validateFn(payload);
    expect(ok, ajv.errorsText(validateFn.errors)).toBe(true);
  });
});
