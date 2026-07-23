/**
 * `astramem-local reembed-dim --dim <N> [--yes] [--batch-size N] [--json]`
 *
 * FEAT-409 AC-4 — resumable procedure for changing the embedding dimension
 * on an EXISTING database with live data. See docs/embed-dim-migration.md
 * for the full runbook (backup-first, stop-daemon, run, restart sequence).
 *
 * WHY this can't be a plain schema migration: sqlite-vec's `memories_vec`
 * vec0 virtual table bakes its dim into `CREATE VIRTUAL TABLE ... FLOAT[N]`
 * DDL — there is no ALTER for it. Changing dim therefore means:
 *   1. Recreating `memories_vec` at the new dim (DESTRUCTIVE — drops every
 *      existing vector). This is why a pre-change backup is the rollback
 *      (AC-4): there is no in-place undo once this step runs.
 *   2. Re-embedding every memory's text with the newly-configured provider
 *      and upserting into the recreated table.
 *
 * RESUMABILITY: migration 011 added `dim_migration_progress`, a checkpoint
 * table keyed by (memory_id, target_dim). Step 2 commits a checkpoint row
 * right after each memory's vec upsert, so an interrupted run (Ctrl+C,
 * crash, a transient Ollama/Azure failure) resumes on the next invocation
 * by skipping memory ids already checkpointed for this target dim — no
 * re-work, no memory permanently stuck without a vector. Step 1 (the
 * destructive recreate) only runs once per target dim: it is skipped
 * whenever a checkpoint row for that target dim already exists, which is
 * exactly the signal that step 1 already ran for this target.
 *
 * `runReembedDim` is the testable core (no process.exit, no config.yaml
 * I/O, injectable embed provider). `reembedDimCommand` is the CLI wrapper:
 * arg parsing, confirmation prompt, config.yaml persistence, exit codes.
 */
import { join } from 'node:path';
import { resolveRuntimeConfig } from '../config/resolve-runtime.js';
import { defaultConfigDir } from '../config/datadir.js';
import { writeConfig } from '../config/writer.js';
import { getOrCreateKey } from '../storage/keystore.js';
import { openDb, type DB } from '../storage/db.js';
import { getProviders } from '../providers/index.js';
import { makeMockProviders } from '../pipeline/mock-providers.js';
import { SqliteVecStore } from '../vector/sqlite-vec.js';
import type { Config } from '../config/config.js';
import type { EmbedProvider } from '../contracts/embed.js';
import { parseArg } from './arg-parse.js';

export interface ReembedDimResult {
  targetDim: number;
  totalCandidates: number;
  alreadyDone: number;
  reembedded: number;
  failed: Array<{ memoryId: string; error: string }>;
  schemaRecreated: boolean;
}

/** Recreate memories_vec at the new dim — destructive, resumability guard
 * is: only do this when NO checkpoint rows exist yet for target_dim (i.e.
 * this is the first invocation for this target, not a resume). */
function maybeRecreateVecSchema(db: DB, targetDim: number): boolean {
  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM dim_migration_progress WHERE target_dim = ?')
    .get(targetDim) as { n: number };
  if (existing.n > 0) return false; // resume — schema already recreated

  db.exec('DROP TABLE IF EXISTS memories_vec');
  db.exec(`CREATE VIRTUAL TABLE memories_vec USING vec0(embedding FLOAT[${targetDim}])`);
  return true;
}

/**
 * Testable core: no process.exit, no config.yaml writes, no provider
 * resolution — the caller supplies `embed` (already verified to produce
 * `targetDim`-shaped vectors). Safe to call repeatedly against the same DB
 * for the same targetDim (resumable — see module doc).
 */
export async function runReembedDim(
  db: DB,
  targetDim: number,
  embed: EmbedProvider,
  batchSize = 20,
): Promise<ReembedDimResult> {
  // Same guard migrate() applies (src/storage/migrate.ts) — this is the
  // exported core function, callable directly by anything that imports it
  // (not just the CLI wrapper below, which already validates --dim), so it
  // must be self-guarding rather than trusting the caller to have checked.
  // Fails fast, before maybeRecreateVecSchema ever interpolates targetDim
  // into DROP/CREATE VIRTUAL TABLE DDL.
  if (!Number.isInteger(targetDim) || targetDim <= 0) {
    throw new Error(`invalid embedding dim: ${targetDim} (must be a positive integer)`);
  }

  const schemaRecreated = maybeRecreateVecSchema(db, targetDim);
  const vecStore = new SqliteVecStore(db, targetDim);

  const candidates = db
    .prepare(`
      SELECT id, text FROM memories
      WHERE id NOT IN (SELECT memory_id FROM dim_migration_progress WHERE target_dim = ?)
      ORDER BY created_at ASC
    `)
    .all(targetDim) as Array<{ id: string; text: string }>;

  const alreadyDoneBefore = (
    db.prepare('SELECT COUNT(*) AS n FROM dim_migration_progress WHERE target_dim = ?').get(targetDim) as { n: number }
  ).n;

  const failed: Array<{ memoryId: string; error: string }> = [];
  let reembedded = 0;

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    for (const mem of batch) {
      try {
        const [vec] = await embed.embed([mem.text]);
        if (!vec) throw new Error('embed provider returned no vector');
        if (vec.length !== targetDim) {
          throw new Error(`provider returned dim=${vec.length}, expected ${targetDim}`);
        }
        // upsert(), the memories row update, then the checkpoint INSERT —
        // each is individually atomic (single-statement better-sqlite3
        // writes). If the process dies between them, resume just re-embeds
        // this one memory again on the next run: embed+upsert+update is
        // idempotent, so at-least-once is safe.
        await vecStore.upsert(mem.id, vec);
        // Mirror pipeline/handlers/reembed.ts: memories.embedding_* must
        // track what's actually in memories_vec, or API/MCP callers get a
        // silent lie about which provider/model/dim produced the vector.
        db.prepare(
          'UPDATE memories SET embedding_provider = ?, embedding_model = ?, embedding_dim = ?, updated_at = ? WHERE id = ?',
        ).run(embed.name, embed.model, targetDim, Date.now(), mem.id);
        db.prepare(
          'INSERT INTO dim_migration_progress (memory_id, target_dim, completed_at) VALUES (?, ?, ?)',
        ).run(mem.id, targetDim, Date.now());
        reembedded++;
      } catch (err) {
        failed.push({ memoryId: mem.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return {
    targetDim,
    totalCandidates: candidates.length,
    alreadyDone: alreadyDoneBefore,
    reembedded,
    failed,
    schemaRecreated,
  };
}

export async function reembedDimCommand(args: string[]): Promise<void> {
  const jsonMode = args.includes('--json');
  const yes = args.includes('--yes');
  const dimArg = parseArg(args, '--dim');
  const batchArg = parseArg(args, '--batch-size');
  const batchSize = batchArg ? Math.max(1, Number(batchArg)) : 20;

  const targetDim = dimArg !== undefined ? Number(dimArg) : NaN;
  if (!Number.isInteger(targetDim) || targetDim <= 0) {
    console.error('reembed-dim: --dim <positive integer> is required');
    process.exit(1);
  }

  const { cfg, dataDir } = resolveRuntimeConfig();
  const dbPath = dataDir === ':memory:' ? ':memory:' : join(dataDir, 'memory.sqlite');

  if (!yes && !jsonMode) {
    console.log('');
    console.log('  AstraMemory Reembed-Dim');
    console.log('  ──────────────────────────────');
    console.log(`  Target dim   : ${targetDim} (current config: ${cfg.embedding.dim})`);
    console.log(`  Data dir     : ${dataDir}`);
    console.log('  This DROPS and recreates memories_vec — all existing vectors are');
    console.log('  discarded, then every memory is re-embedded with the configured provider.');
    console.log('  A pre-change backup (`astramem-local backup`) is your rollback — there is');
    console.log('  no undo once the schema recreate step runs.');
    console.log('  Re-run with --yes to proceed (safe to Ctrl+C and resume — see docs/embed-dim-migration.md).');
    console.log('');
    process.exit(1);
  }

  const key = cfg.security.encryption.enabled ? getOrCreateKey(defaultConfigDir()).key : undefined;
  const db = openDb(dbPath, key ? { key } : {});

  // New config with the target dim — used both to persist config.yaml AND
  // to build the embed provider that will actually produce target-dim
  // vectors below (provider.dim flows from config.embedding.dim, FEAT-409).
  const newCfg: Config = { ...cfg, embedding: { ...cfg.embedding, dim: targetDim } };
  const useMock = process.env.ASTRA_MEMORY_MOCK_PROVIDERS === '1';
  const embed = useMock ? makeMockProviders(targetDim).embed : getProviders(newCfg).embed;
  if (embed.dim !== targetDim) {
    console.error(
      `reembed-dim: configured provider (${embed.name}/${embed.model}) produces dim=${embed.dim}, ` +
      `not the requested --dim ${targetDim}. Update config.embedding.model to a model that ` +
      `natively produces ${targetDim} dims (or one that supports it via a dimensions param) before retrying.`,
    );
    db.close();
    process.exit(1);
  }

  const result = await runReembedDim(db, targetDim, embed, batchSize);

  // Persist the new dim (+ provider/model already matched above) so the
  // next daemon boot's preflight (AC-3) sees a config that matches the
  // schema we just recreated. Skipped for :memory: (no real config to
  // update — dev/test throwaway state, same guard the sync shipper uses).
  let configPath: string | undefined;
  if (dataDir !== ':memory:') {
    configPath = join(defaultConfigDir(), 'config.yaml');
    writeConfig(newCfg, configPath);
  }

  db.close();

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('');
    console.log('  AstraMemory Reembed-Dim — complete');
    console.log('  ──────────────────────────────');
    console.log(`  Target dim        : ${targetDim}`);
    console.log(`  Schema recreated  : ${result.schemaRecreated ? 'yes (fresh run)' : 'no (resumed run)'}`);
    console.log(`  Already done      : ${result.alreadyDone}`);
    console.log(`  Reembedded now    : ${result.reembedded}`);
    console.log(`  Failed            : ${result.failed.length}`);
    if (result.failed.length > 0) {
      console.log('  Re-run this command to retry failed memories (resumable).');
    }
    if (configPath) {
      console.log(`  config.yaml updated: embedding.dim=${targetDim} at ${configPath}`);
      console.log('  Restart the daemon (`astramem-local reinstall` or `service restart`) to pick this up.');
    }
    console.log('');
  }

  if (result.failed.length > 0) process.exit(1);
}
