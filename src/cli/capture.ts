/**
 * `astramem-local capture codex` — one-shot Codex CLI session capture
 * (Wave 4c, ADR-008). Scans ~/.codex/sessions for new/grown session files,
 * converts each to an astramem-capture@1 transcript envelope, POSTs to the
 * daemon's /ingest/transcript with a content-stable Idempotency-Key, and
 * records per-file sizes in <dataDir>/codex-capture-state.json so unchanged
 * files are skipped next run. Designed to be cheap enough for a shell hook
 * or scheduled task; re-runs are always safe (server-side idempotency).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { defaultDataDir } from '../config/datadir.js';
import { PKG_VERSION } from '../server/lib/wire-meta.js';
import {
  defaultCodexSessionsDir,
  findNewSessions,
  buildCodexEnvelope,
  codexIdempotencyKey,
  type CaptureState,
} from '../capture/codex.js';

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function statePath(): string {
  return join(process.env.ASTRA_MEMORY_DATADIR ?? defaultDataDir(), 'codex-capture-state.json');
}

function loadState(path: string): CaptureState {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CaptureState;
  } catch {
    return {};
  }
}

export async function captureCommand(args: string[]): Promise<void> {
  const source = args[0];
  if (source !== 'codex') {
    console.error(`capture: unknown source '${source ?? ''}' — supported: codex`);
    process.exit(1);
  }

  // --watch [seconds]: poll for new sessions on an interval (Codex has no
  // session-end hook to latch onto). One-shot semantics per tick; ctrl-c to stop.
  if (args.includes('--watch')) {
    const idx = args.indexOf('--watch');
    const next = args[idx + 1];
    const intervalSec = next && /^\d+$/.test(next) ? Math.max(10, Number(next)) : 60;
    const tickArgs = args.filter((a, i) => a !== '--watch' && !(i === idx + 1 && /^\d+$/.test(a)));
    console.log(`capture codex: watching every ${intervalSec}s (ctrl-c to stop)`);
    for (;;) {
      await runCaptureOnce(tickArgs);
      await new Promise(r => setTimeout(r, intervalSec * 1000));
    }
  }

  await runCaptureOnce(args);
}

async function runCaptureOnce(args: string[]): Promise<void> {
  const sessionsDir = parseArg(args, '--sessions-dir') ?? defaultCodexSessionsDir();
  const dryRun = args.includes('--dry-run');
  const asJson = args.includes('--json');
  const baseUrl = process.env.ASTRA_MEMORY_URL ?? 'http://127.0.0.1:7777';
  const token = process.env.ASTRA_MEMORY_TOKEN ?? 'devtok';

  const stateFile = statePath();
  const state = loadState(stateFile);
  const candidates = findNewSessions(sessionsDir, state);

  const results: Array<{ file: string; session_id: string; turns: number; status: string }> = [];

  for (const c of candidates) {
    const envelope = buildCodexEnvelope(c.parsed, PKG_VERSION);
    if (dryRun) {
      results.push({ file: c.filePath, session_id: envelope.session_id, turns: envelope.turns.length, status: 'dry-run' });
      continue;
    }
    try {
      const res = await fetch(`${baseUrl}/ingest/transcript`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${token}`,
          'idempotency-key': codexIdempotencyKey(c.parsed),
        },
        body: JSON.stringify(envelope),
      });
      if (!res.ok) {
        results.push({ file: c.filePath, session_id: envelope.session_id, turns: envelope.turns.length, status: `HTTP ${res.status}` });
        continue; // don't advance state — retry next run
      }
      const body = await res.json() as { idempotent?: boolean };
      state[c.filePath] = { size: c.size };
      results.push({
        file: c.filePath,
        session_id: envelope.session_id,
        turns: envelope.turns.length,
        status: body.idempotent ? 'replayed' : 'ingested',
      });
    } catch (err) {
      results.push({ file: c.filePath, session_id: envelope.session_id, turns: envelope.turns.length, status: `error: ${String(err)}` });
    }
  }

  if (!dryRun && results.some(r => r.status === 'ingested' || r.status === 'replayed')) {
    if (!existsSync(dirname(stateFile))) mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }

  if (asJson) {
    console.log(JSON.stringify({ sessions_dir: sessionsDir, captured: results }, null, 2));
  } else if (results.length === 0) {
    console.log(`No new Codex sessions found under ${sessionsDir}.`);
  } else {
    for (const r of results) console.log(`${r.status}  ${r.session_id}  (${r.turns} turns)  ${r.file}`);
  }

  if (results.some(r => r.status.startsWith('HTTP') || r.status.startsWith('error'))) {
    process.exitCode = 1;
  }
}
