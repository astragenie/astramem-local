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
import { search, makeFakeVec, type SearchHit } from '../../src/search/search.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { MockCrossEncoderProvider, type RerankOpts } from '../../src/search/rerank.js';
import { defaultConfig } from '../../src/config/config.js';
import type { EmbedProvider } from '../../src/contracts/index.js';

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

  // Upper bound raised 10 -> 15 for FEAT-402 slice 2 (AC-8): q9-q11 add
  // dedicated entity `filters.entity` coverage alongside the original as_of
  // temporal case — both are load-bearing regression gates, not bloat.
  it('queries.json has 6-15 queries including a temporal as_of case and an entity filter case', () => {
    const queries = readJson(join(CONTRACTS_ROOT, 'fixtures', 'eval', 'queries.json')) as {
      queries: Array<{ filters?: { as_of?: string; entity?: string } }>;
    };
    expect(queries.queries.length).toBeGreaterThanOrEqual(6);
    expect(queries.queries.length).toBeLessThanOrEqual(15);
    expect(queries.queries.some(q => q.filters?.as_of !== undefined)).toBe(true);
    expect(queries.queries.some(q => q.filters?.entity !== undefined)).toBe(true);
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

  it('astramem-local#84: a real POST /remember-produced content_hash validates against sync-envelope.v1 (^[a-f0-9]{64}$)', async () => {
    // Exercises the actual daemon hash site (src/server/routes/search.ts
    // POST /remember, backed by src/storage/content-hash.ts contentHash())
    // rather than a manually-supplied fixture hash — the schema's
    // content_hash pattern is 64-char-only, and this call site used to
    // truncate to 32 chars (astragenie/memory#619, #620). This test fails
    // if that regresses.
    const db = openDb(':memory:');
    migrate(db);
    const app = await buildApp({ db, token: 't' });

    const res = await app.inject({
      method: 'POST',
      url: '/remember',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      payload: { text: 'live conformance: POST /remember content_hash must be 64 chars', type: 'fact' },
    });
    expect(res.statusCode).toBe(200);
    const { id } = res.json();

    const row = db
      .prepare(`SELECT seq, event_type, atom_id, payload_json, content_hash, created_at FROM memory_events WHERE atom_id = ? AND event_type = 'create'`)
      .get(id) as { seq: number; event_type: string; atom_id: string; payload_json: string | null; content_hash: string; created_at: number };

    const envelope = {
      protocol: 'astramem-sync@1',
      device_id: 'device-conformance-84',
      workspace_id: 'ws-conformance-84',
      cursor: 0,
      events: [
        {
          seq: row.seq,
          event_type: row.event_type,
          atom_id: row.atom_id,
          payload_json: row.payload_json !== null ? JSON.parse(row.payload_json) : null,
          content_hash: row.content_hash,
          created_at: row.created_at,
        },
      ],
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

  // ---------------------------------------------------------------------
  // retrieval-result.v1 (CONTRACT-FREEZE, astragenie/memory#759, 2026-07-13)
  //
  // search() (src/search/search.ts) now populates scope/importance/
  // confidence/created_at/capture_source and a full ScoreExplanation on
  // every hit — this is a REAL local search() call (real FTS5 + real
  // sqlite-vec), not a fixture. Only wire-mapping is applied inline below:
  // dropping the internal fusion-leg `source` (fts/vec/both — not part of
  // the canonical contract, predates it, still consumed by the CLI/
  // dashboard) and renaming `capture_source` -> the canonical `source`
  // (CONTRACT-FREEZE §1: "source maps to local's provenance"). That rename
  // is the one piece of wire-adapter logic the route layer will eventually
  // own (out of this change's contracts/ + src/search/ scope) — done here
  // only so this test proves something real, per the "a schema you cannot
  // validate against a real response is worthless" mandate.
  // ---------------------------------------------------------------------
  function toWireHit(hit: SearchHit): unknown {
    // Drop fields with no place in the canonical (additionalProperties:
    // false) hit shape: the internal fusion-leg `source`, and `reranked`/
    // `rerank_score` — both fully recoverable from
    // `explanation.signals.cross_encoder` presence/`.final` once merged, so
    // nothing is lost by omitting them from the wire.
    const { source: _fusionLeg, capture_source, reranked: _reranked, rerank_score: _rerankScore, ...rest } = hit;
    return { ...rest, ...(capture_source !== undefined ? { source: capture_source } : {}) };
  }

  const conformanceEmbed: EmbedProvider = {
    name: 'ollama' as const,
    model: 'conformance-fake',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'conformance-fake', dim: 1024 as const }),
  };

  it('a real search() response (FTS + vector hit, no rerank) validates against retrieval-result.v1', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const memories = new MemoryRepo(db);
    const id = memories.insert({
      type: 'decision',
      text: 'live-conformance: retrieval-result@1 must validate a real search() hit',
      normalized_text: 'live-conformance: retrieval-result@1 must validate a real search() hit',
      repo: 'astramem-local',
      project: 'astramem',
      branch: null,
      agent: 'claude-code',
      session_id: null,
      hash: 'd'.repeat(64),
      source_hash: null,
      importance: 0.7,
      confidence: 0.6,
      capture_source: 'hook_close',
    });
    const vecStore = new SqliteVecStore(db, conformanceEmbed.dim);
    const [vec] = await conformanceEmbed.embed([
      'live-conformance: retrieval-result@1 must validate a real search() hit',
    ]);
    await vecStore.upsert(id, vec as Float32Array);

    const hits = await search(
      'retrieval-result validate search hit',
      {},
      10,
      { db, embed: conformanceEmbed, weights: defaultConfig().search }
    );
    expect(hits.length).toBeGreaterThan(0);

    const envelope = {
      schema: 'astramem-retrieval-result@1',
      query: { text: 'retrieval-result validate search hit', mode: 'hybrid' },
      hits: hits.map(toWireHit),
      total: hits.length,
    };

    const validateFn = compiled.get('retrieval-result.v1.schema.json')!;
    const ok = validateFn(envelope);
    expect(ok, ajv.errorsText(validateFn.errors)).toBe(true);

    // Sanity: the fields this slice added are actually populated, not just
    // schema-shaped coincidentally.
    const hit = hits[0]!;
    expect(hit.scope).toBe('private');
    expect(hit.importance).toBeCloseTo(0.7, 5);
    expect(hit.confidence).toBeCloseTo(0.6, 5);
    expect(hit.capture_source).toBe('hook_close');
    expect(() => new Date(hit.created_at).toISOString()).not.toThrow();
    expect(hit.explanation.final).toBe(hit.score);
    expect(hit.explanation.signals.importance).toBeDefined();
  });

  it('a real search() response WITH the cross-encoder rerank stage validates against retrieval-result.v1 (cross_encoder merged into the base signals, not replacing them)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const memories = new MemoryRepo(db);
    const idA = memories.insert({
      type: 'fact',
      text: 'live-conformance rerank: sqlite-vec hybrid bm25 fusion search',
      normalized_text: 'live-conformance rerank: sqlite-vec hybrid bm25 fusion search',
      repo: 'astramem-local',
      project: null,
      branch: null,
      agent: null,
      session_id: null,
      hash: 'e'.repeat(64),
      source_hash: null,
    });
    const idB = memories.insert({
      type: 'fact',
      text: 'live-conformance rerank: completely unrelated banana bread recipe',
      normalized_text: 'live-conformance rerank: completely unrelated banana bread recipe',
      repo: 'astramem-local',
      project: null,
      branch: null,
      agent: null,
      session_id: null,
      hash: 'f'.repeat(64),
      source_hash: null,
    });
    const vecStore = new SqliteVecStore(db, conformanceEmbed.dim);
    for (const [id, text] of [
      [idA, 'live-conformance rerank: sqlite-vec hybrid bm25 fusion search'],
      [idB, 'live-conformance rerank: completely unrelated banana bread recipe'],
    ] as const) {
      const [vec] = await conformanceEmbed.embed([text]);
      await vecStore.upsert(id, vec as Float32Array);
    }

    const rerank: RerankOpts = { topK: 50, timeoutMs: 300, provider: new MockCrossEncoderProvider() };
    const hits = await search(
      'live-conformance rerank sqlite-vec hybrid search',
      {},
      10,
      { db, embed: conformanceEmbed, weights: defaultConfig().search, rerank }
    );
    expect(hits.some(h => h.reranked)).toBe(true);

    const envelope = {
      schema: 'astramem-retrieval-result@1',
      query: { text: 'live-conformance rerank sqlite-vec hybrid search', mode: 'hybrid' },
      hits: hits.map(toWireHit),
      total: hits.length,
    };

    const validateFn = compiled.get('retrieval-result.v1.schema.json')!;
    const ok = validateFn(envelope);
    expect(ok, ajv.errorsText(validateFn.errors)).toBe(true);

    const rerankedHit = hits.find(h => h.reranked)!;
    expect(rerankedHit.explanation.signals.cross_encoder).toBeDefined();
    expect(rerankedHit.explanation.signals.importance).toBeDefined(); // base signals survived the merge
    expect(rerankedHit.explanation.final).toBe(rerankedHit.score);
  });
});
