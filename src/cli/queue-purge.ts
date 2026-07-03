/**
 * `astramem-local queue purge --poison [--json] [--dump-dir PATH]`
 *
 * Manual poison-job purge (FEAT-405) ahead of the 30-day auto-purge
 * (src/pipeline/handlers/cleanup.ts). Writes a forensics dump (job payload +
 * failure reason per job) BEFORE deleting anything, so an operator who
 * cleared stuck poison jobs on demand can still inspect what was removed.
 *
 * Exit codes:
 *   0 = success (including the zero-poison-jobs no-op)
 *   1 = failure (dump dir could not be created/written)
 */
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openRuntimeDb } from './open-runtime-db.js';
import { JobRepo } from '../pipeline/job-repo.js';

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export interface PurgeResult {
  purged: number;
  dumpPath: string | null;
}

function safeParsePayload(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson);
  } catch {
    return payloadJson;
  }
}

export async function queuePurgeCommand(args: string[]): Promise<void> {
  const jsonMode = args.includes('--json');

  if (!args.includes('--poison')) {
    console.error('queue purge: only --poison is supported (usage: `queue purge --poison`)');
    process.exit(1);
    return;
  }

  const { db, dataDir } = openRuntimeDb();
  const repo = new JobRepo(db);

  // Read poison jobs BEFORE any deletion — the forensics dump must reflect
  // exactly what gets purged.
  const poisonJobs = repo.listPoison();

  if (poisonJobs.length === 0) {
    db.close();
    const result: PurgeResult = { purged: 0, dumpPath: null };
    if (jsonMode) {
      console.log(JSON.stringify(result));
    } else {
      console.log('queue purge: no poison jobs found — nothing to do.');
    }
    return;
  }

  const dumpDir = parseArg(args, '--dump-dir') ?? join(dataDir, 'forensics');
  let dumpPath: string;
  try {
    // Create the dump dir if missing rather than silently dropping the
    // forensics dump (AC-5). mkdirSync throws loud on a real failure (e.g.
    // a file occupying the path, or a permissions error).
    mkdirSync(dumpDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    dumpPath = join(dumpDir, `poison-purge-${stamp}.json`);
    const dump = poisonJobs.map(j => ({
      id: j.id,
      kind: j.kind,
      payload: safeParsePayload(j.payload_json),
      failure_reason: j.last_error,
      attempts: j.attempts,
      created_at: j.created_at,
      updated_at: j.updated_at,
    }));
    writeFileSync(
      dumpPath,
      JSON.stringify({ purged_at: Date.now(), count: dump.length, jobs: dump }, null, 2),
      'utf-8',
    );
  } catch (err) {
    db.close();
    console.error(`queue purge: failed to write forensics dump to ${dumpDir}: ${String(err)}`);
    process.exit(1);
    return;
  }

  // Delete exactly the ids captured above (not a blanket state='poison'
  // delete) so a job that gets poisoned concurrently, after the dump was
  // written, is never swept up without ever appearing in a forensics dump.
  const purged = repo.purgePoisonByIds(poisonJobs.map(j => j.id));

  db.close();

  const result: PurgeResult = { purged, dumpPath };
  if (jsonMode) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`queue purge: removed ${purged} poison job(s).`);
    console.log(`  Forensics dump: ${dumpPath}`);
  }
}
