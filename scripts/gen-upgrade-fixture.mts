/**
 * gen-upgrade-fixture.mts — builds the tests/storage/fixtures/datadir-vNN
 * fixture used by tests/storage/upgrade-path.test.ts (FEAT-420 SLICE-414).
 *
 * WHY a standalone stepwise applier instead of calling src/storage/migrate.ts
 * directly: migrate() always applies every migration file present in the
 * repo and then asserts DB max version == SCHEMA_VERSION (the boot drift
 * guard) — there is no "stop at version N" parameter, and there shouldn't
 * be one added just for fixture generation (that would be a migration-
 * semantics change, out of scope per the SLICE-414 stop-point). Instead this
 * script re-implements migrate()'s core loop (read migrations/, sort, apply
 * unapplied files up to a cap, record schema_version) WITHOUT the drift
 * guard, so it can freeze a DB at an arbitrary historical version. The real
 * upgrade path is still exercised by the test, which opens the frozen
 * fixture with the REAL migrate() to bring it to the current version — this
 * script only needs to faithfully reproduce migrate()'s pre-N schema, not
 * its post-boot invariants.
 *
 * Regeneration procedure (fixture README duplicates this): on every schema
 * bump N -> N+1, decide whether the frozen fixture should move to the new
 * N-1 (usually NOT — the fixture's value is testing the OLDEST realistically
 * supported upgrade path, so it normally stays put). To regenerate the
 * existing fixture after a deliberate content change to this script:
 *
 *   bun scripts/gen-upgrade-fixture.mts --at 12 --out tests/storage/fixtures/datadir-v12
 *
 * then commit the rewritten memory.sqlite + manifest.json together. The
 * upgrade-path test re-runs this generator in-memory and asserts its
 * manifest matches the committed one (anti-rot, AC-5) — a content edit here
 * that isn't matched by regenerating+recommitting the fixture fails CI.
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb, type DB } from '../src/storage/db.js';
import { makeFakeVec } from '../src/search/search.js';
import { normalizeEntityName } from '../src/entity/normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const EMBED_DIM_PLACEHOLDER = '__EMBED_DIM__';

/** Fixed epoch base (2026-01-01T00:00:00Z) — NOT Date.now(). Determinism is
 *  the entire point of this fixture; every generated run must byte-for-byte
 *  match the committed one (AC-5 anti-rot). */
const BASE_TS = 1767225600000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Apply migrations[0..maxVersion] only (inclusive), skipping the boot
 * drift guard real migrate() runs — see file header. Mirrors migrate()'s
 * loop faithfully (same file discovery, same dim placeholder substitution,
 * same per-file transaction + schema_version bookkeeping).
 */
function applyMigrationsUpTo(db: DB, maxVersion: number, dim: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const versionStr = f.split('-')[0];
    const version = parseInt(versionStr ?? '', 10);
    if (Number.isNaN(version)) throw new Error(`bad migration name: ${f}`);
    if (version > maxVersion) break;
    const rawSql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    const sql = rawSql.split(EMBED_DIM_PLACEHOLDER).join(String(dim));
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, BASE_TS);
    });
    tx();
  }
}

interface FixtureMemory {
  id: string;
  type: string;
  text: string;
  importance: number;
  confidence: number;
  entity?: { name: string; kind: string };
}

/** The deterministic seed corpus — order matters (drives created_at spacing
 *  and rowid, which drives the fixed memories_vec rowid mapping). */
const MEMORIES: FixtureMemory[] = [
  { id: 'fixture-mem-01', type: 'fact', text: 'The upgrade-path fixture uses sqlite-vec for vector storage', importance: 0.8, confidence: 0.9, entity: { name: 'sqlite-vec', kind: 'tech' } },
  { id: 'fixture-mem-02', type: 'decision', text: 'Team decided to standardize on mxbai-embed-large for embeddings', importance: 0.7, confidence: 0.85 },
  { id: 'fixture-mem-03', type: 'fact', text: 'Priya Nair is the on-call reviewer for the upgrade-path fixture', importance: 0.5, confidence: 0.8, entity: { name: 'Priya Nair', kind: 'person' } },
  { id: 'fixture-mem-04', type: 'lesson', text: 'Schema migrations must never silently partial-open a truncated datadir', importance: 0.9, confidence: 0.9 },
  { id: 'fixture-mem-05', type: 'todo', text: 'TODO: document the fixture regeneration procedure in the README', importance: 0.4, confidence: 0.7 },
  { id: 'fixture-mem-06', type: 'command', text: 'Run scripts/gen-upgrade-fixture.mts --at 12 to regenerate the v12 fixture', importance: 0.5, confidence: 0.8 },
  { id: 'fixture-mem-07', type: 'fact', text: 'This fixture belongs to astramemory-local, a local-first memory daemon', importance: 0.6, confidence: 0.8, entity: { name: 'astramemory-local', kind: 'repo' } },
  { id: 'fixture-mem-08', type: 'fact', text: 'The fixture is written in TypeScript and targets Node 20', importance: 0.5, confidence: 0.8, entity: { name: 'TypeScript', kind: 'tech' } },
  { id: 'fixture-mem-09', type: 'note', text: 'The v12 fixture prefers deterministic markdown-free plain text summaries', importance: 0.4, confidence: 0.7 },
  { id: 'fixture-mem-10', type: 'decision', text: 'Half-migrated or truncated datadirs must fail loud, never silently open partial', importance: 0.9, confidence: 0.9 },
];

export interface FixtureManifest {
  schemaVersionAtGeneration: number;
  embedDim: number;
  counts: { memories: number; entities: number; memory_entities: number; memory_events: number };
  memoryIds: string[];
  entityNames: string[];
  spotChecks: Array<{ id: string; type: string; textContains: string }>;
  search: Array<{ query: string; expectedHitIds: string[] }>;
}

/**
 * Deliberately tiny — NOT DEFAULT_EMBED_DIM (1024). sqlite-vec's vec0
 * virtual table preallocates storage per chunk sized by
 * `dim * 4 bytes * chunk_rows`; at dim=1024 even 10 rows produced a >4MB
 * committed binary. The dim is fully parameterized already (FEAT-409) and
 * frozen into the fixture at generation time (migrate() never re-bakes an
 * already-applied migration's dim), so a small fixture-only dim is safe —
 * the upgrade-path test reads it back via getVecSchemaDim(), it never
 * assumes 1024.
 */
const FIXTURE_EMBED_DIM = 8;

/**
 * Build the frozen datadir at `dbPath` (overwritten if present) and return
 * its manifest. `atVersion` is the migration prefix to stop at (12 for the
 * committed fixture); `dim` defaults to FIXTURE_EMBED_DIM to keep the
 * committed binary small (see above) — pass DEFAULT_EMBED_DIM explicitly if
 * a production-realistic dim fixture is ever needed.
 */
export function generateFixture(dbPath: string, atVersion = 12, dim: number = FIXTURE_EMBED_DIM): FixtureManifest {
  if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(sidecar)) rmSync(sidecar, { force: true });
  }

  const db = openDb(dbPath);
  applyMigrationsUpTo(db, atVersion, dim);

  const entityIdByName = new Map<string, string>();
  let entitySeq = 0;
  const memoryEntityLinks: Array<{ memoryId: string; entityId: string }> = [];

  MEMORIES.forEach((m, i) => {
    const createdAt = BASE_TS + i * DAY_MS;
    const hash = `fixture-hash-${m.id}`;
    db.prepare(`
      INSERT INTO memories
        (id, type, text, normalized_text, importance, confidence, hash,
         embedding_provider, embedding_model, embedding_dim,
         created_at, updated_at, valid_from, scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ollama', 'mock-embed', ?, ?, ?, ?, 'personal')
    `).run(m.id, m.type, m.text, m.text.toLowerCase(), m.importance, m.confidence, hash, dim, createdAt, createdAt, createdAt);

    db.prepare(`INSERT INTO memory_events (event_type, atom_id, content_hash, created_at, event_id) VALUES ('create', ?, ?, ?, ?)`)
      .run(m.id, hash, createdAt, `fixture-evt-${m.id}`);

    const vec = makeFakeVec(m.text, dim);
    const rowid = (db.prepare('SELECT rowid FROM memories WHERE id = ?').get(m.id) as { rowid: number }).rowid;
    db.prepare('INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)').run(BigInt(rowid), Buffer.from(vec.buffer));

    if (m.entity) {
      const normalized = normalizeEntityName(m.entity.name);
      let entityId = entityIdByName.get(normalized);
      if (!entityId) {
        entityId = `fixture-ent-${String(++entitySeq).padStart(2, '0')}`;
        db.prepare('INSERT INTO entities (id, name, kind) VALUES (?, ?, ?)').run(entityId, normalized, m.entity.kind);
        entityIdByName.set(normalized, entityId);
      }
      db.prepare('INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?, ?)').run(m.id, entityId);
      memoryEntityLinks.push({ memoryId: m.id, entityId });
    }
  });

  // Fold WAL back into the single main file so the committed fixture is one
  // self-contained .sqlite with no -wal/-shm siblings to track.
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.pragma('journal_mode = DELETE');
  db.close();

  const manifest: FixtureManifest = {
    schemaVersionAtGeneration: atVersion,
    embedDim: dim,
    counts: {
      memories: MEMORIES.length,
      entities: entityIdByName.size,
      memory_entities: memoryEntityLinks.length,
      memory_events: MEMORIES.length,
    },
    memoryIds: MEMORIES.map(m => m.id),
    entityNames: Array.from(entityIdByName.keys()).sort(),
    spotChecks: [
      { id: 'fixture-mem-01', type: 'fact', textContains: 'sqlite-vec' },
      { id: 'fixture-mem-10', type: 'decision', textContains: 'fail loud' },
    ],
    search: [
      { query: 'sqlite-vec', expectedHitIds: ['fixture-mem-01'] },
      { query: 'Priya Nair', expectedHitIds: ['fixture-mem-03'] },
    ],
  };
  return manifest;
}

// ── CLI entry: `bun scripts/gen-upgrade-fixture.mts --at 12 --out <dir>` ────
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const atIdx = args.indexOf('--at');
  const outIdx = args.indexOf('--out');
  const atVersion = atIdx >= 0 ? parseInt(args[atIdx + 1] ?? '', 10) : 12;
  const outDir = outIdx >= 0 ? args[outIdx + 1] : join(__dirname, '..', 'tests', 'storage', 'fixtures', `datadir-v${atVersion}`);
  if (!outDir || Number.isNaN(atVersion)) {
    console.error('Usage: gen-upgrade-fixture.mts --at <migrationVersion> [--out <dir>]');
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const dbPath = join(outDir, 'memory.sqlite');
  const manifest = generateFixture(dbPath, atVersion);
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote fixture to ${outDir} (schema v${atVersion}, ${manifest.counts.memories} memories)`);
}
