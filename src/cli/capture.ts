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
import { resolveRuntimeConfig } from '../config/resolve-runtime.js';
import { writeConfig } from '../config/writer.js';
import { openRuntimeDb } from './open-runtime-db.js';
import {
  defaultCodexSessionsDir,
  findNewSessions,
  buildCodexEnvelope,
  codexIdempotencyKey,
  type CaptureState,
} from '../capture/codex.js';
import {
  readAndParseClaudeTranscript,
  buildClaudeEnvelope,
  claudeIdempotencyKey,
  type ClaudeCaptureEvent,
  type ClaudeTurn,
} from '../capture/claude.js';
import { gateRelevance, recordCapturedTurnHash } from '../capture/relevance-gate.js';
import { writeToSpool } from '../ingest/spool.js';

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

/**
 * `astramem-local capture claude <transcript-path> [--event subagent_stop|
 * session_end] [--json]` (FEAT-449). Reads the Claude Code `.jsonl`
 * transcript AT INVOCATION — the hook calls this synchronously at
 * agent/session close, while the file is still guaranteed live — and writes
 * the resulting envelope to the durable ingest spool (never blocks on the
 * network; the daemon's spool-drain worker ingests it asynchronously,
 * including while the daemon was down at capture time — AC-8).
 *
 * AC-3: a missing/unreadable transcript (already cleaned up by the time a
 * DEFERRED reader would have gotten to it — the exact starvation this slice
 * closes) must fail SOFT: exactly one warning, nothing written, non-zero
 * `process.exitCode`, and a clean return — never `process.exit()` mid-flight
 * (Windows UV_HANDLE_CLOSING risk with in-flight stdout) and never an
 * uncaught throw.
 */
async function runCaptureClaudeOnce(args: string[]): Promise<void> {
  const transcriptPath = args.find(a => !a.startsWith('--'));
  const asJson = args.includes('--json');
  const eventArg = parseArg(args, '--event');
  const event: ClaudeCaptureEvent = eventArg === 'session_end' ? 'session_end' : 'subagent_stop';
  // FEAT-455 / ADR-012 decision 1: the (future, plugin-repo, out of scope for
  // this slice) denser-sampling trigger calls this CLI with --auto-capture.
  // The astramem-plugin close-capture hook is the ONLY caller today, and it
  // never passes this flag (2026-07-12 doctor-canary provenance bug — see
  // captureSource below).
  const autoCaptureFlag = args.includes('--auto-capture');

  if (!transcriptPath) {
    console.error('capture claude: missing <transcript-path> argument');
    process.exitCode = 1;
    return;
  }

  let parsed;
  try {
    parsed = readAndParseClaudeTranscript(transcriptPath);
  } catch (err) {
    console.warn(
      `capture claude: transcript not readable, skipping: ${transcriptPath} ` +
      `(${err instanceof Error ? err.message : String(err)})`,
    );
    process.exitCode = 1;
    return;
  }

  // FEAT-455 / ADR-012 decision 4: this CLI is the actual enforcement point
  // for "never enabled implicitly" — even once a future hook fires
  // --auto-capture unconditionally, capture stays a no-op unless config.yaml
  // has the explicit opt-in (set only via the init wizard prompt).
  //
  // 2026-07-12 doctor-canary provenance fix: every invocation now stamps a
  // provenance tag, not just the (still-unused) --auto-capture path.
  // 'hook_close' is the default — the astramem-plugin close-capture hook is
  // the ONLY caller today and never passes --auto-capture — so the doctor
  // "Auto-capture" canary can tell real close-capture traffic apart from a
  // genuinely wired-but-never-firing hook. --auto-capture overrides this to
  // 'auto_capture' once its config opt-in gate (below) passes.
  let captureSource: 'auto_capture' | 'hook_close' = 'hook_close';
  if (autoCaptureFlag) {
    const { cfg } = resolveRuntimeConfig();
    if (!cfg.capture.autoCapture.enabled) {
      if (asJson) {
        console.log(JSON.stringify({ transcript: transcriptPath, status: 'auto-capture-disabled' }, null, 2));
      } else {
        console.log(`capture claude: auto-capture is disabled in config — nothing spooled (${transcriptPath})`);
      }
      return;
    }
    captureSource = 'auto_capture';

    // ADR-012 decision 2 (src/capture/relevance-gate.ts) — source-side gate,
    // distinct from src/distill/durability-gate.ts per that module's AC-6.
    // The dedup ring buffer is process-local and NOT persisted across
    // invocations of this one-shot CLI (see relevance-gate.ts doc comment) —
    // an accepted cold-start cost, not a correctness bug.
    const gateOpts = cfg.capture.autoCapture.relevanceGate;
    const recentHashes = new Set<string>();
    const kept: ClaudeTurn[] = [];
    for (const turn of parsed.turns) {
      if (gateRelevance(turn, recentHashes, gateOpts)) continue;
      recordCapturedTurnHash(recentHashes, turn.text, gateOpts.dedupWindow);
      kept.push(turn);
    }
    parsed = { ...parsed, turns: kept };
  }

  if (parsed.turns.length === 0) {
    // Not an error — a transcript that never got a real exchange (e.g. a
    // subagent that was killed before responding), or one whose every turn
    // the relevance gate filtered out, distills to noise.
    if (asJson) {
      console.log(JSON.stringify({ transcript: transcriptPath, status: 'no-turns' }, null, 2));
    } else {
      console.log(`capture claude: no usable turns in ${transcriptPath} — nothing spooled`);
    }
    return;
  }

  const dataDir = process.env.ASTRA_MEMORY_DATADIR ?? defaultDataDir();
  const envelope = buildClaudeEnvelope(parsed, event, PKG_VERSION, undefined, captureSource);
  const key = claudeIdempotencyKey(envelope);
  const spooledPath = writeToSpool(dataDir, key, envelope);

  if (asJson) {
    console.log(JSON.stringify({
      transcript: transcriptPath,
      session_id: envelope.session_id,
      turns: envelope.turns.length,
      spooled: spooledPath,
      idempotency_key: key,
    }, null, 2));
  } else {
    console.log(`spooled  ${envelope.session_id}  (${envelope.turns.length} turns)  -> ${spooledPath}`);
  }
}

/**
 * `astramem-local capture auto-capture disable [--purge|--keep] [--json]`
 * (FEAT-455 / ADR-012 decision 4). Turning auto-capture off is always
 * immediate (config.yaml write, no daemon required); the purge OFFER is a
 * separate, explicit step — "offered, not forced" — scoped to
 * `capture_source = 'auto_capture'` atoms ONLY. `hook_close` atoms (the
 * ordinary close-capture hook — unrelated to this denser-sampling opt-in)
 * are never queried or purged by this flow (2026-07-12).
 *
 * FEAT-467 retrofit (ADR-013 Decision 4): the purge itself now calls
 * `POST /capture/purge`, a reversible soft-delete batch (bounded restore
 * window, default 30 days — `capture.purge.restoreWindowDays`), NOT the
 * irreversible `erase_memory`/`DELETE /memory/:id` path this used prior to
 * FEAT-467. A batch left unrestored is hard-erased once the window elapses
 * (`POST /capture/purge/:batchId/finalize`, explicit or via a scheduled
 * sweep) — see docs/specs/FEAT-458-S1-design.md §1.
 */
async function runAutoCaptureDisable(args: string[]): Promise<void> {
  const asJson = args.includes('--json');
  const purgeFlag = args.includes('--purge');
  const keepFlag = args.includes('--keep');

  if (purgeFlag && keepFlag) {
    console.error('capture auto-capture disable: pass only one of --purge / --keep');
    process.exitCode = 1;
    return;
  }

  const { cfg, configDir } = resolveRuntimeConfig();
  const wasEnabled = cfg.capture.autoCapture.enabled;
  cfg.capture.autoCapture.enabled = false;
  const configPath = join(configDir, 'config.yaml');
  writeConfig(cfg, configPath);

  if (!asJson) {
    console.log(
      wasEnabled
        ? `auto-capture disabled — capture.autoCapture.enabled=false persisted to ${configPath}`
        : `auto-capture was already disabled — config.yaml re-confirmed at ${configPath}`,
    );
  }

  const { db } = openRuntimeDb();
  // Literal 'auto_capture' only, deliberately NOT widened to include
  // 'hook_close' — the ordinary close-capture hook's atoms are not part of
  // this denser-sampling opt-in and must never be purged by this flow.
  const rows = db
    .prepare(`SELECT id FROM memories WHERE capture_source = 'auto_capture' AND valid_to IS NULL`)
    .all() as { id: string }[];
  db.close();

  if (rows.length === 0) {
    if (asJson) {
      console.log(JSON.stringify({ disabled: true, was_enabled: wasEnabled, auto_captured_count: 0, purge: 'no-op' }, null, 2));
    } else {
      console.log('No auto-captured memories found — nothing to purge.');
    }
    return;
  }

  let purge: boolean;
  if (purgeFlag) {
    purge = true;
  } else if (keepFlag) {
    purge = false;
  } else if (process.stdout.isTTY && process.stdin.isTTY) {
    const { confirm } = await import('@inquirer/prompts');
    purge = await confirm({
      message:
        `${rows.length} auto-captured ${rows.length === 1 ? 'memory' : 'memories'} found. ` +
        'Purge them now? (Reversible for a bounded window, then permanently erased — ' +
        'No = keep them, auto-capture stays off either way)',
      default: false,
    });
  } else {
    console.log(
      `${rows.length} auto-captured ${rows.length === 1 ? 'memory' : 'memories'} found. ` +
      'Re-run with --purge to erase them or --keep to leave them (non-interactive, no action taken).',
    );
    return;
  }

  if (!purge) {
    const msg = `Kept ${rows.length} auto-captured ${rows.length === 1 ? 'memory' : 'memories'} — offered, not forced (ADR-012 decision 4).`;
    if (asJson) console.log(JSON.stringify({ disabled: true, was_enabled: wasEnabled, auto_captured_count: rows.length, purge: 'declined' }, null, 2));
    else console.log(msg);
    return;
  }

  // FEAT-467 retrofit (ADR-013 Decision 4): purge is a reversible soft-delete
  // batch, not an immediate hard erase — POST /capture/purge re-scopes to
  // `capture_source = 'auto_capture' AND valid_to IS NULL` itself (same
  // predicate `rows` above already used), so this is a single call rather
  // than a per-id loop. Requires a running daemon.
  const baseUrl = process.env.ASTRA_MEMORY_URL ?? `http://127.0.0.1:${cfg.port}`;
  const token = process.env.ASTRA_MEMORY_TOKEN ?? 'devtok';
  let batchId: string | null = null;
  let purgedCount = 0;
  let failed = false;
  try {
    const res = await fetch(`${baseUrl}/capture/purge`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ capture_source: 'auto_capture' }),
    });
    if (res.status === 200) {
      const body = (await res.json()) as { batch_id: string; count: number };
      batchId = body.batch_id;
      purgedCount = body.count;
    } else {
      failed = true;
    }
  } catch {
    failed = true;
  }

  if (asJson) {
    console.log(JSON.stringify(
      {
        disabled: true, was_enabled: wasEnabled, auto_captured_count: rows.length,
        purge: failed ? 'failed' : 'completed', purged: purgedCount, batch_id: batchId,
      },
      null, 2,
    ));
  } else if (failed) {
    console.log('Purge failed — is the daemon running? Re-run this command to retry.');
  } else {
    console.log(
      `Purge batch ${batchId}: ${purgedCount} ${purgedCount === 1 ? 'memory' : 'memories'} soft-purged — ` +
      'restorable within the configured window (POST /capture/purge/:batchId/restore) before being ' +
      'permanently erased.',
    );
  }
  if (failed) process.exitCode = 1;
}

export async function captureCommand(args: string[]): Promise<void> {
  const source = args[0];
  if (source === 'claude') {
    await runCaptureClaudeOnce(args.slice(1));
    return;
  }
  if (source === 'auto-capture') {
    const sub = args[1];
    if (sub === 'disable') {
      await runAutoCaptureDisable(args.slice(2));
      return;
    }
    console.error(`capture auto-capture: unknown subcommand '${sub ?? ''}' — supported: disable`);
    process.exit(1);
    return;
  }
  if (source !== 'codex') {
    console.error(`capture: unknown source '${source ?? ''}' — supported: codex, claude, auto-capture`);
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
