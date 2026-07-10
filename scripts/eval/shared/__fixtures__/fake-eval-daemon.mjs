#!/usr/bin/env node
/**
 * Fake/stub eval daemon (FEAT-462 AC-5) — plain Node, no build step, no
 * live Ollama/LLM. Implements just enough of the real astramemory-local
 * daemon's wire surface for scripts/eval/shared + the per-harness
 * ingest.mts modules to exercise against:
 *
 *   GET  /health                    -> { ok: true, status: 'ok' }
 *   POST /ingest/transcript         -> { ok: true, session_id, idempotent }
 *   GET  /sessions/:id/digest       -> { status: 'pending' | 'ready', ... }
 *
 * Prints the exact boot log line spawn-daemon.ts's SERVING_LINE_RE expects
 * (`astramem-local serving on <host>:<port>`), so tests can spawn this via
 * the real spawnEvalDaemon/waitForHealthStatus/killDaemon helpers exactly
 * like a real daemon — the goal is exercising the actual harness code
 * paths (ingestQuestions/ingestConversations, waitForQuestionsDistilled)
 * against something process-killable, not re-implementing them.
 *
 * State (which session_ids have been ingested, and when) persists to
 * --state-file as JSON. A fresh process pointed at the same --state-file
 * after a SIGKILL resumes exactly where the killed instance left off —
 * standing in for the real daemon's durable SQLite datadir (FEAT-462's
 * premise: "shard datadirs (SQLite) already hold all distill progress").
 *
 * Args: --port <n> --state-file <path> [--distill-delay-ms <n>]
 * Env:  ASTRA_MEMORY_TOKEN — if set, requests must carry a matching
 *       `Authorization: Bearer <token>` header (mirrors the real daemon).
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
function get(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
}

const port = Number(get('--port', '0'));
const stateFile = get('--state-file');
const distillDelayMs = Number(get('--distill-delay-ms', '0'));
// Artificial per-request delay on POST /ingest/transcript only, so a
// kill-resilience test can deterministically land a SIGKILL while a
// request is in flight instead of racing real (near-instant) I/O.
const ingestDelayMs = Number(get('--ingest-delay-ms', '0'));
const token = process.env.ASTRA_MEMORY_TOKEN;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!stateFile) {
  console.error('fake-eval-daemon: --state-file is required');
  process.exit(1);
}

function loadState() {
  if (existsSync(stateFile)) {
    try {
      return JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch {
      // torn write from a prior kill — start fresh rather than crash-loop.
    }
  }
  return { sessions: {}, ingestCallCount: 0 };
}

function saveState(state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state), 'utf8');
}

let state = loadState();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  // /health is public, same as the real daemon (CLAUDE.md: "GET /health and
  // GET /version are public (no Bearer)") -- waitForHealthStatus sends no
  // Authorization header, so the auth check below must not apply to it.
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true, status: 'ok' });
    return;
  }

  if (token) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${token}`) { sendJson(res, 401, { ok: false, error: 'unauthorized' }); return; }
  }

  if (req.method === 'POST' && req.url === '/ingest/transcript') {
    const raw = await readBody(req);
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    if (ingestDelayMs > 0) await sleep(ingestDelayMs);
    const sessionId = envelope.session_id;
    const already = Boolean(state.sessions[sessionId]);
    state.ingestCallCount = (state.ingestCallCount ?? 0) + 1;
    if (!already) {
      state.sessions[sessionId] = { ingestedAtMs: Date.now() };
    }
    saveState(state);
    sendJson(res, 200, { ok: true, session_id: sessionId, idempotent: already });
    return;
  }

  const digestMatch = /^\/sessions\/([^/]+)\/digest$/.exec(req.url ?? '');
  if (req.method === 'GET' && digestMatch) {
    const sessionId = decodeURIComponent(digestMatch[1]);
    const entry = state.sessions[sessionId];
    if (!entry) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
    const ready = Date.now() - entry.ingestedAtMs >= distillDelayMs;
    sendJson(res, 200, { session_id: sessionId, status: ready ? 'ready' : 'pending', counts: {}, memories: [] });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  const actualPort = server.address().port;
  // Must match spawn-daemon.ts's SERVING_LINE_RE exactly.
  console.log(`astramem-local serving on 127.0.0.1:${actualPort}`);
});
