/**
 * `astramem-local ingest-audio <file>` (FEAT-489 Slice A acceptance hint).
 * One-shot CLI: validates the file, upserts a session row (same shape
 * ingest.ts's canonical route uses), enqueues a `transcribe` job, and exits
 * — the daemon's worker (or the next `serve` boot, since jobs persist)
 * drains it. Does NOT run ASR itself; all of that lives in
 * transcribeHandler so the daemon and this CLI share exactly one code path.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openRuntimeDb } from './open-runtime-db.js';
import { JobRepo } from '../pipeline/job-repo.js';
import { deriveProject } from '../pipeline/derive-project.js';
import { THIRD_PARTY_SPEAKER_CONSENT_DISCLOSURE } from '../config/config.js';
import { parseArg } from './arg-parse.js';

export async function ingestAudioCommand(args: string[]): Promise<void> {
  const audioPath = args.find(a => !a.startsWith('-'));
  if (!audioPath) {
    console.error('ingest-audio: <file> argument is required (astramem-local ingest-audio <file> [--session-id ID])');
    process.exitCode = 1;
    return;
  }

  const absolutePath = resolve(audioPath);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    console.error(`ingest-audio: no such file: ${absolutePath}`);
    process.exitCode = 1;
    return;
  }

  const { db, cfg } = openRuntimeDb();

  if (cfg.audio.mode === 'off') {
    console.error(
      'ingest-audio: audio.mode is \'off\' (the default) — audio capture is disabled. Set audio.mode to ' +
      '\'dry-run\' or \'enabled\' in config.yaml before running this command. See ADR-017: enabling this ' +
      'captures OTHER people\'s voices too, not just your own — you are responsible for informing/obtaining ' +
      'consent from other participants where required.',
    );
    process.exitCode = 1;
    db.close();
    return;
  }

  // ADR-017 decision 3 enforcement gate — same check transcribeHandler
  // makes at dequeue time; failing fast HERE too means an operator who
  // hasn't acknowledged the disclosure gets the message immediately, not
  // after a job round-trips through the queue.
  if (!cfg.audio.disclosureAcknowledged) {
    console.error(
      `ingest-audio: audio.mode is '${cfg.audio.mode}' but audio.disclosureAcknowledged is not true. ` +
      `${THIRD_PARTY_SPEAKER_CONSENT_DISCLOSURE} Set audio.disclosureAcknowledged: true in config.yaml ` +
      'after reading and understanding this, then re-run.',
    );
    process.exitCode = 1;
    db.close();
    return;
  }

  const sessionId = parseArg(args, '--session-id') ?? randomUUID();
  const cwd = process.cwd();
  const project = deriveProject(cwd, null);
  const now = Date.now();

  db.prepare(`
    INSERT INTO sessions (id, repo, project, branch, agent, cwd, started_at)
    VALUES (?, NULL, ?, NULL, 'audio-cli', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project = COALESCE(excluded.project, project),
      cwd     = COALESCE(excluded.cwd, cwd)
  `).run(sessionId, project, cwd, now);

  const jobId = new JobRepo(db).enqueue('transcribe', { kind: 'transcribe', audio_path: absolutePath, session_id: sessionId });
  console.log(`ingest-audio: queued transcribe job ${jobId} for ${absolutePath} (session ${sessionId})`);
  if (cfg.audio.mode === 'dry-run') {
    console.log('ingest-audio: audio.mode is \'dry-run\' — segments will be transcribed and filtered but NOT persisted.');
  }

  db.close();
}
