/**
 * `astramem-local rebuild [--repo REPO] [--project PROJECT] [--limit N] [--dry-run] [--json]`
 *
 * Re-embed/reindex flow: enumerates existing memories and enqueues one
 * `reembed` job per memory via the same JobRepo used by ingest — the
 * daemon's worker (500ms poll, src/pipeline/worker.ts) recomputes each
 * embedding with the configured provider and upserts the vector row
 * (src/pipeline/handlers/reembed.ts). Requires a running daemon.
 */

import { join } from 'node:path';
import { openDb } from '../storage/db.js';
import { migrate } from '../storage/migrate.js';
import { defaultConfig } from '../config/config.js';
import { JobRepo } from '../pipeline/job-repo.js';

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export interface RebuildResult {
  candidateCount: number;
  queuedIds: string[];
  dryRun: boolean;
}

export async function rebuildCommand(args: string[]): Promise<void> {
  const jsonMode = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const repo = parseArg(args, '--repo');
  const project = parseArg(args, '--project');
  const limitArg = parseArg(args, '--limit');
  const limit = limitArg ? Math.max(1, Number(limitArg)) : undefined;

  const cfg = defaultConfig();
  const dataDir = process.env.ASTRA_MEMORY_DATADIR ?? cfg.dataDir;
  const dbPath = dataDir === ':memory:' ? ':memory:' : join(dataDir, 'memory.sqlite');

  const db = openDb(dbPath);
  migrate(db);

  const conditions: string[] = [];
  const params: string[] = [];
  if (repo) { conditions.push('repo = ?'); params.push(repo); }
  if (project) { conditions.push('project = ?'); params.push(project); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitClause = limit !== undefined ? ` LIMIT ${limit}` : '';

  const candidates = db
    .prepare(`SELECT id FROM memories ${where} ORDER BY created_at ASC${limitClause}`)
    .all(...params) as { id: string }[];

  const queuedIds: string[] = [];
  if (!dryRun && candidates.length > 0) {
    const repoDao = new JobRepo(db);
    const tx = db.transaction(() => {
      for (const c of candidates) {
        repoDao.enqueue('reembed', { kind: 'reembed', memory_id: c.id });
        queuedIds.push(c.id);
      }
    });
    tx();
  }

  db.close();

  const result: RebuildResult = { candidateCount: candidates.length, queuedIds, dryRun };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('');
  console.log('  AstraMemory Rebuild');
  console.log('  ──────────────────────────────');
  console.log(`  Candidates matched: ${result.candidateCount}`);
  if (dryRun) {
    console.log('  --dry-run: no jobs were queued.');
  } else {
    console.log(`  Reembed jobs queued: ${queuedIds.length}`);
    console.log('  The running daemon will recompute embeddings with the configured provider.');
  }
  console.log('');
}
