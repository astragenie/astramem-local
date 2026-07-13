/**
 * Upgrade-path e2e (FEAT-420 / SLICE-414): a frozen schema-v12 datadir must
 * open clean on the current (v15) build via the SAME openDb+migrate path
 * serve.ts uses, with zero data loss (AC-1), searchable pre-upgrade content
 * (AC-2), and fail-loud behavior for corrupt/half-migrated datadirs (AC-3) —
 * never a silent partial open. AC-5 anti-rot: the committed fixture must
 * stay in lockstep with its generator.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, CorruptDatadirError, EncryptionKeyError } from '../../src/storage/db.js';
import { migrate, getVecSchemaDim } from '../../src/storage/migrate.js';
import { search, makeFakeVec } from '../../src/search/search.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import { generateFixture, type FixtureManifest } from '../../scripts/gen-upgrade-fixture.mts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures', 'datadir-v12');
const FIXTURE_DB = join(FIXTURE_DIR, 'memory.sqlite');
const FIXTURE_MANIFEST: FixtureManifest = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'));

const SEARCH_WEIGHTS = { alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1 };

function copyFixtureToTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'astra-upgrade-'));
  const dest = join(dir, 'memory.sqlite');
  copyFileSync(FIXTURE_DB, dest);
  return dest;
}

function makeEmbed(dim: number): EmbedProvider {
  return {
    name: 'ollama',
    model: 'fixture-mock',
    dim,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t, dim)),
    health: async () => ({ ok: true, model: 'fixture-mock', dim }),
  };
}

describe('upgrade-path e2e — schema-v12 fixture on current build', () => {
  it('AC-1: migrates to the current schema version with zero data loss — counts + spot-checked ids match manifest', () => {
    const dbPath = copyFixtureToTemp();
    const db = openDb(dbPath);
    migrate(db);

    const versionRow = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(versionRow.v).toBe(27);

    const countOf = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect({
      memories: countOf('memories'),
      entities: countOf('entities'),
      memory_entities: countOf('memory_entities'),
      memory_events: countOf('memory_events'),
    }).toEqual(FIXTURE_MANIFEST.counts);

    const ids = (db.prepare('SELECT id FROM memories ORDER BY id').all() as { id: string }[]).map(r => r.id);
    expect(ids).toEqual([...FIXTURE_MANIFEST.memoryIds].sort());

    for (const check of FIXTURE_MANIFEST.spotChecks) {
      const row = db.prepare('SELECT type, text FROM memories WHERE id = ?').get(check.id) as
        | { type: string; text: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row!.type).toBe(check.type);
      expect(row!.text.toLowerCase()).toContain(check.textContains.toLowerCase());
    }

    const entityNames = (db.prepare('SELECT name FROM entities ORDER BY name').all() as { name: string }[]).map(
      r => r.name,
    );
    expect(entityNames).toEqual(FIXTURE_MANIFEST.entityNames);

    db.close();
  });

  it('AC-2: search over pre-upgrade content returns the manifest-expected hits', async () => {
    const dbPath = copyFixtureToTemp();
    const db = openDb(dbPath);
    migrate(db);

    const dim = getVecSchemaDim(db) ?? FIXTURE_MANIFEST.embedDim;
    expect(dim).toBe(FIXTURE_MANIFEST.embedDim);
    const embed = makeEmbed(dim);

    for (const s of FIXTURE_MANIFEST.search) {
      const hits = await search(s.query, {}, 10, { db, embed, weights: SEARCH_WEIGHTS });
      const hitIds = hits.map(h => h.id);
      for (const expectedId of s.expectedHitIds) {
        expect(hitIds).toContain(expectedId);
      }
    }

    db.close();
  });

  describe('AC-3: corrupt / half-migrated datadirs fail loud, never silently open partial', () => {
    it('truncated (0-byte) file throws CorruptDatadirError, not a silent fresh-DB open', () => {
      const dir = mkdtempSync(join(tmpdir(), 'astra-corrupt-'));
      const p = join(dir, 'memory.sqlite');
      writeFileSync(p, '');
      expect(() => openDb(p)).toThrow(CorruptDatadirError);
    });

    it('garbage bytes throws CorruptDatadirError', () => {
      const dir = mkdtempSync(join(tmpdir(), 'astra-corrupt-'));
      const p = join(dir, 'memory.sqlite');
      writeFileSync(p, Buffer.from('this is not a sqlite file, just garbage bytes 12345 padding'));
      expect(() => openDb(p)).toThrow(CorruptDatadirError);
    });

    it('half-migrated datadir (schema_version row for a DDL migration lost) throws an actionable error', () => {
      const dbPath = copyFixtureToTemp();

      // First bring it fully up to date, matching the real upgrade path...
      const db = openDb(dbPath);
      migrate(db);
      db.close();

      // ...then simulate a half-migrated state: migration 014's DDL landed
      // (the sync_ship_state table exists) but the bookkeeping row recording
      // it does not (e.g. crash between DDL and the schema_version INSERT —
      // both run in the same transaction in real migrate(), but this
      // simulates a datadir that reached that state some other way, e.g.
      // manual editing or a restore of a stale schema_version table over a
      // newer file). This must target a migration with real DDL (CREATE/
      // ALTER), not simply MAX(version): migration 015
      // (canonical-content-hash, astramem-local#84) is a data-only UPDATE
      // and is intentionally idempotent — re-running it after its
      // bookkeeping row is lost silently (and correctly) self-heals instead
      // of throwing, so it can't stand in for "the last migration" here.
      // 014 is the newest migration that still has real DDL to conflict on.
      const db2 = openDb(dbPath);
      db2.prepare('DELETE FROM schema_version WHERE version = 14').run();
      db2.close();

      const db3 = openDb(dbPath);
      expect(() => migrate(db3)).toThrow(/half-migrated|corrupted datadir/i);
    });

    it('a wrong/missing encryption key on an otherwise-valid file throws EncryptionKeyError, not CorruptDatadirError — and never suggests deletion', () => {
      // The committed fixture is plaintext. PRAGMA key against a plaintext
      // file makes every subsequent read fail with the exact same
      // "file is not a database" symptom as real corruption (documented in
      // migrate-encrypt.ts) — this is the cheapest reproduction of the
      // wrong/missing-key case the review flagged: openDb must NOT conflate
      // it with corruption just because the driver error looks identical.
      const dbPath = copyFixtureToTemp();
      let caught: unknown;
      try {
        openDb(dbPath, { key: 'totally-wrong-key-does-not-decrypt-this' });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EncryptionKeyError);
      expect(caught).not.toBeInstanceOf(CorruptDatadirError);
      const message = (caught as Error).message.toLowerCase();
      expect(message).toContain('key');
      expect(message).not.toContain('delete');
    });
  });

  it('AC-5 anti-rot: the generator reproduces a fixture whose manifest matches the committed one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astra-regen-'));
    const regenManifest = generateFixture(join(dir, 'memory.sqlite'), FIXTURE_MANIFEST.schemaVersionAtGeneration);
    expect(regenManifest).toEqual(FIXTURE_MANIFEST);
  });
});
